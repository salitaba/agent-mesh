/**
 * Mail to the account owner when a run in one of their workspaces is waiting on them.
 *
 * The mesh half of this is in the workspace: a mission that has stopped, or one that closed with a decision nobody
 * answered, is visible on `GET /api/p/<project>/status` as `goal.status` and `needsOperator`. A workspace cannot send
 * mail; the control plane can, and it already runs on a clock. So on each pass this asks every running workspace's host
 * which projects it holds and what each one's status says, with the workspace's own operator credential, and mails the
 * account's owner when a run needs a person.
 *
 * There is no clock of its own: `control.ts` calls {@link RunNotifier.check} from the tick that already checks the
 * workspaces, so there is one clock and one failure mode. A workspace that is down, slow, or answers with something
 * that is not a status is skipped, and nothing here throws out of the tick.
 *
 * What was told is remembered in the control log, one `run.notified` entry per (workspace, project, goal, state), where
 * `state` is the goal's status and the ids of the cards it owes. So a restart does not tell an owner the same thing
 * again, the same state is not told again until the repeat window has passed, and a state that has changed — a new card,
 * a different status — is told about at once.
 */
import * as http from "node:http";
import type { Mailer } from "./mailer";
import { runNotificationKey, type ControlLog, type Workspace } from "./store";
import { accountPageUrl, type Workspaces } from "./workspaces";

/** How long a workspace's host is given to answer, in ms: a check must not wait on a sick workspace. */
export const DEFAULT_NOTIFY_TIMEOUT_MS = 5_000;
/** The same state is not told about again until this long has passed. */
export const DEFAULT_NOTIFY_REPEAT_MS = 12 * 3_600_000;
/** Workspaces are looked at no more often than this. */
export const DEFAULT_NOTIFY_EVERY_MS = 15 * 60_000;

/** The goal states that mean the run has stopped and is waiting. COMPLETED and FAILED have words of their own; the rest read as running. */
const STOPPED: Record<string, string> = {
  ESCALATED: "has stopped and needs you",
  PAUSED: "is paused and needs you",
  BLOCKED: "is blocked and needs you",
};

/** A card the workspace says an operator still owes an answer, as the status payload carries it. */
export interface RunCard {
  id: string;
  reason: string;
  raisedBy?: string;
  openedAt?: string;
  ageMs?: number;
}

/** What a project's status said that a mail is built from. */
interface WaitingRun {
  goalId: string;
  goalStatus: string;
  cards: RunCard[];
}

export interface RunNotifierOptions {
  /** The record of what was told, and of the accounts to tell. */
  log: ControlLog;
  mailer: Mailer;
  /** The workspaces to ask, and the credential they are asked with. */
  workspaces: Workspaces;
  /** The address of the account pages, where a person opens their workspace. */
  appUrl: string;
  clock?: () => Date;
  /** How long a host is given to answer each request, in ms. Default {@link DEFAULT_NOTIFY_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** The same state is not mailed about again until this long has passed, in ms. Default {@link DEFAULT_NOTIFY_REPEAT_MS}. */
  repeatMs?: number;
  /** Workspaces are looked at no more often than this, in ms. Default {@link DEFAULT_NOTIFY_EVERY_MS}. */
  everyMs?: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 160);

function readCards(raw: unknown): RunCard[] {
  if (!Array.isArray(raw)) return [];
  const cards: RunCard[] = [];
  for (const c of raw) {
    if (!isObject(c) || typeof c.id !== "string" || c.id === "" || typeof c.reason !== "string") continue;
    cards.push({
      id: c.id,
      reason: c.reason,
      ...(typeof c.raisedBy === "string" ? { raisedBy: c.raisedBy } : {}),
      ...(typeof c.openedAt === "string" ? { openedAt: c.openedAt } : {}),
      ...(typeof c.ageMs === "number" && Number.isFinite(c.ageMs) ? { ageMs: Math.max(0, c.ageMs) } : {}),
    });
  }
  return cards;
}

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** How long something has waited, in the largest unit that says it: "9 minutes", "38 hours", "3 days". */
function waited(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 48) return plural(hours, "hour");
  return plural(Math.round(hours / 24), "day");
}

const indent = (text: string): string => text.split("\n").map((line) => `  ${line}`).join("\n");

/** A card's own words, bounded: a card that goes on for pages must not become the mail. */
const quoted = (reason: string): string => {
  const text = reason.trim();
  return indent(text.length > 900 ? `${text.slice(0, 900)}…` : text);
};

/**
 * The mail for one run. Everything in it a customer can already see in the workspace: the run's state, the project, how
 * long it has waited, the first card's own words, and where to open it. No ids, no tokens.
 */
function ownerMail(i: { workspace: string; project: string; goalStatus: string; cards: RunCard[]; repeatMs: number; appUrl: string }): { subject: string; text: string } {
  const n = i.cards.length;
  const first = i.cards[0];
  const stopped = STOPPED[i.goalStatus] !== undefined;
  const lead = stopped
    ? `The run in your workspace "${i.workspace}" ${STOPPED[i.goalStatus]}.`
    : i.goalStatus === "COMPLETED"
      ? `The run in your workspace "${i.workspace}" has finished, with ${plural(n, "decision")} it raised never answered.`
      : i.goalStatus === "FAILED"
        ? `The run in your workspace "${i.workspace}" has failed, with ${plural(n, "decision")} still open.`
        : `The run in your workspace "${i.workspace}" is still running, with ${plural(n, "decision")} waiting on you.`;
  const lines = [lead, "", `Project: ${i.project}`];
  if (first?.ageMs !== undefined) lines.push(stopped ? `Waiting for an answer for ${waited(first.ageMs)}.` : `The first has been open for ${waited(first.ageMs)}.`);
  if (first) {
    lines.push("", stopped ? `It is waiting on this, from ${first.raisedBy ?? "a seat"}:` : `The first one, from ${first.raisedBy ?? "a seat"}:`, "", quoted(first.reason));
    if (n > 1) lines.push("", `${n - 1} more ${n - 1 === 1 ? "decision is" : "decisions are"} waiting after it.`);
  }
  lines.push("", n > 0 ? "Open the workspace from your account page and answer it:" : "Open the workspace from your account page:", "", accountPageUrl(i.appUrl), "", `You will not be told about this again for ${plural(Math.max(1, Math.round(i.repeatMs / 3_600_000)), "hour")} while nothing changes.`);
  return {
    subject: stopped ? `A Curule run needs you: ${i.workspace}` : `A Curule run has decisions waiting: ${i.workspace}`,
    text: lines.join("\n"),
  };
}

export class RunNotifier {
  private readonly clock: () => Date;
  private readonly timeoutMs: number;
  private readonly repeatMs: number;
  private readonly everyMs: number;
  /** When workspaces were last looked at, in ms. Not persisted: a restart looks at once, and the log stops a repeat. */
  private lookedAt: number | undefined;

  constructor(private readonly o: RunNotifierOptions) {
    this.clock = o.clock ?? (() => new Date());
    this.timeoutMs = o.timeoutMs ?? DEFAULT_NOTIFY_TIMEOUT_MS;
    this.repeatMs = o.repeatMs ?? DEFAULT_NOTIFY_REPEAT_MS;
    this.everyMs = o.everyMs ?? DEFAULT_NOTIFY_EVERY_MS;
  }

  /** One pass: ask every running workspace and mail the owner of each run that needs them. Returns what it did, for the log. */
  async check(): Promise<string[]> {
    const now = this.clock().getTime();
    if (this.lookedAt !== undefined && now - this.lookedAt < this.everyMs) return [];
    this.lookedAt = now;
    const actions: string[] = [];
    for (const w of this.o.workspaces.hosting()) {
      const account = this.o.log.state.accounts.get(w.accountId);
      if (!account || account.disabledAt !== undefined) continue;
      const projects = await this.projectsOf(w);
      if (projects === undefined) {
        actions.push(`${w.workspaceId}: could not be asked what its runs are doing; it is tried again at the next check`);
        continue;
      }
      for (const project of projects) {
        const run = await this.runOf(w, project.id);
        if (run === undefined) continue;
        const state = `${run.goalStatus}|${run.cards.map((c) => c.id).sort().join(",")}`;
        const key = runNotificationKey({ workspaceId: w.workspaceId, projectId: project.id, goalId: run.goalId, state });
        const told = this.o.log.state.runNotified.get(key);
        const toldAt = told !== undefined ? Date.parse(told) : Number.NaN;
        if (Number.isFinite(toldAt) && now - toldAt < this.repeatMs) continue;
        try {
          await this.o.mailer.send({ to: account.email, kind: "run-needs-you", ...ownerMail({ workspace: w.name, project: project.name, goalStatus: run.goalStatus, cards: run.cards, repeatMs: this.repeatMs, appUrl: this.o.appUrl }) });
        } catch (err) {
          actions.push(`${w.workspaceId}/${project.id}: the owner could not be told (${reasonOf(err)}); it is tried again at the next check`);
          continue;
        }
        // Recorded after the message went out: a crash in this window tells the owner twice, where recording first
        // would lose the message this exists to send.
        await this.o.log.append({ type: "run.notified", workspaceId: w.workspaceId, accountId: w.accountId, projectId: project.id, goalId: run.goalId, state });
        actions.push(`${w.workspaceId}/${project.id}: the owner was told the run is waiting on them`);
      }
    }
    return actions;
  }

  /** The projects the workspace's host holds, or undefined when it did not answer with them. */
  private async projectsOf(w: Workspace): Promise<Array<{ id: string; name: string }> | undefined> {
    const answer = await this.get(w, "/api/projects");
    if (!isObject(answer) || !Array.isArray(answer.projects)) return undefined;
    const projects: Array<{ id: string; name: string }> = [];
    for (const p of answer.projects) {
      if (isObject(p) && typeof p.id === "string" && p.id !== "") projects.push({ id: p.id, name: typeof p.name === "string" && p.name !== "" ? p.name : p.id });
    }
    return projects;
  }

  /** What one project's status says, when it is a run that needs its owner. Anything else — a project that is closed, starting or answering oddly — is not a run to mail about. */
  private async runOf(w: Workspace, projectId: string): Promise<WaitingRun | undefined> {
    const answer = await this.get(w, `/api/p/${encodeURIComponent(projectId)}/status`);
    if (!isObject(answer)) return undefined;
    const goal = isObject(answer.goal) ? answer.goal : undefined;
    if (!goal || typeof goal.id !== "string" || goal.id === "" || typeof goal.status !== "string") return undefined;
    const cards = readCards(answer.needsOperator);
    if (STOPPED[goal.status] === undefined && cards.length === 0) return undefined;
    return { goalId: goal.id, goalStatus: goal.status, cards };
  }

  /**
   * One GET on a workspace's host, as JSON, with the workspace's own operator credential and with the name that host
   * answers to. Never throws: a host that is down, slow or answering with something that is not JSON is undefined,
   * which the caller skips.
   *
   * The `Host` header is not decoration. A workspace's host answers only to the names it serves — ask its private
   * address, which is how the control plane reaches it, and it refuses with `421 host not allowed`. That is also why
   * this does not use `fetch`: Node's fetch rewrites `Host` from the URL and silently drops an explicit one (measured),
   * so the request would look correct here and be refused there. `http.request` sends what it is told.
   */
  private get(w: Workspace, path: string): Promise<unknown> {
    const upstream = w.upstream!;
    return new Promise((resolve) => {
      const req = http.request(
        {
          host: upstream.host,
          port: upstream.port,
          path,
          method: "GET",
          headers: {
            authorization: `Bearer ${this.o.workspaces.operatorToken(w.workspaceId)}`,
            accept: "application/json",
            Host: this.o.workspaces.hostOf(w.slug),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const status = res.statusCode ?? 0;
            if (status < 200 || status >= 300) return resolve(undefined);
            const text = Buffer.concat(chunks).toString("utf8");
            if (text === "") return resolve({});
            try {
              resolve(JSON.parse(text));
            } catch {
              resolve(undefined);
            }
          });
        },
      );
      req.setTimeout(this.timeoutMs, () => req.destroy());
      req.on("error", () => resolve(undefined));
      req.end();
    });
  }
}
