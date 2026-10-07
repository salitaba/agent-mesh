/**
 * What the Overview works out from a `/status` payload and the event log, with no DOM.
 *
 * The Overview used to hold this inside a 460-line component: which refusals are still standing, which sentence explains an
 * idle mission, which problems are listed and in what order. Those are the parts that carry a claim, and a claim needs a test,
 * which a .tsx file cannot have. The view lays out what these functions return and decides nothing itself.
 *
 * Three rules shape it:
 *
 * - The hero (mission.ts: one headline, one action) says what state the mission is in. The attention list says what else is
 *   true, so it never repeats the hero: a decision that is already the headline is not listed again, and a fix that is already
 *   the hero's button is not offered twice.
 * - Nothing that is true is dropped, and nothing that is not a problem is allowed to look like one: a queue that clears
 *   itself is information, a refusal that will not retry is a fault, and the tone says which.
 * - A number that cannot be known is `null`, never `0`.
 */
import { RUNNING, criterionDone, plainArtifact } from "./format";
import type { MissionPhase } from "./mission";

/* ------------------------------------------------------------------------- */
/* Whether there is a mission to show                                         */
/* ------------------------------------------------------------------------- */

/**
 * Whether the mission has been read. A mesh must declare a goal, so a `/status` without one is a project that answered before it
 * read its log, or the host's answer for a project that is not running ({"error": "project 'demo' is closed"}). Below the
 * headline nothing is known then, and the Overview used to draw it anyway: "Checks: None. This goal declares no mandatory checks.",
 * "0 events", "This goal declares no checks." and "Could not load recent work", about a mission nobody had read yet.
 */
export function missionRead(status: unknown): boolean {
  const goal = status && typeof status === "object" ? (status as { goal?: unknown }).goal : undefined;
  return !!goal && typeof goal === "object";
}

/* ------------------------------------------------------------------------- */
/* The log, in order                                                          */
/* ------------------------------------------------------------------------- */

/**
 * The log in the order it was written. The console's buffer is in the order events arrived, which is not the same thing: the
 * stream's catch-up for a project with a long log is its first 200 events, and a refill from `/events` puts the newest ones
 * after them. Everything the Overview reads as "the latest" reads the end of a list, so it reads this one.
 */
export function bySeq<T extends { seq?: number }>(events: readonly T[]): T[] {
  return [...events].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

/**
 * The buffer stops short of the log: the newest event it holds is older than the log's own length (`eventCount`, which is
 * also the last seq). True on a page opened after a long run, whose catch-up never reached the end.
 */
export function bufferIsBehind(newestSeq: number, eventCount: unknown): boolean {
  return typeof eventCount === "number" && eventCount > 0 && newestSeq < eventCount;
}

/* ------------------------------------------------------------------------- */
/* Policy refusals that are still standing                                    */
/* ------------------------------------------------------------------------- */

/** The three fields the fold reads off a timeline event. `TimelineEvent` satisfies it. */
export interface BlockEvent {
  seq: number;
  type: string;
  actorId?: string;
  payload?: any;
}

export interface StandingBlock {
  actorId: string;
  seq: number;
  /** The policy's own sentence: `max_activations 3 reached`, `thread budget exhausted (12/12)`. */
  reason: string;
  ruleId?: string;
  /** Refused outright (it will not retry) as against deferred (it queues itself again when the limit moves). */
  deny: boolean;
}

/**
 * Policy blocks that are still standing, newest first.
 *
 * `message.rejected` has carried the policy's own sentence all along and nothing rendered it. Two rules keep this honest:
 *
 * - A refusal is reported once and re-reported only when its wording changes, so the newest denial for an agent is its
 *   current reason. Age proves nothing: a block that has stood quietly for ten minutes is still the reason that agent is not
 *   working, which is why this does not time-window.
 * - A block has lifted when the agent has done anything since. If the newest event naming it as actor is still its denial,
 *   it never ran.
 */
export function standingBlocks(events: readonly BlockEvent[]): StandingBlock[] {
  const newestByActor = new Map<string, BlockEvent>();
  for (const e of events) {
    if (!e.actorId) continue;
    const prev = newestByActor.get(e.actorId);
    if (!prev || e.seq >= prev.seq) newestByActor.set(e.actorId, e);
  }
  return [...newestByActor.values()]
    .filter((e) => e.type === "message.rejected" && e.payload?.denied)
    .sort((a, b) => b.seq - a.seq)
    .map((e) => ({
      actorId: e.actorId as string,
      seq: e.seq,
      reason: String(e.payload?.reason || "refused by policy"),
      ruleId: e.payload?.ruleId ? String(e.payload.ruleId) : undefined,
      deny: e.payload?.decision === "DENY",
    }));
}

/* ------------------------------------------------------------------------- */
/* Capacity, triage and the idle cause                                        */
/* ------------------------------------------------------------------------- */

/**
 * The three concurrency ceilings, labelled the way the designer's Mesh panel labels them, so "raise it" names a control the
 * operator can find rather than a raw config key.
 */
export const CEILING_LABEL: Record<string, string> = {
  "scheduling.concurrency.max_active_agents": "peers at once",
  "scheduling.concurrency.max_parallel_service_agents": "services at once",
  "scheduling.concurrency.max_total_agents": "total turns at once",
};

export interface CapacityWait {
  agentId: string;
  running?: number;
  limit?: number;
  configKey?: string;
}

/**
 * Queued agents with no slot. Live scheduler state or nothing: a capacity block is not a refusal, so it emits no event (and
 * must not, because these resolve constantly and one event apiece would bury the log).
 */
export function capacityWaits(waits: unknown): CapacityWait[] {
  if (!Array.isArray(waits)) return [];
  return waits
    .filter((w) => w && typeof w === "object" && (w as { kind?: unknown }).kind === "capacity")
    .map((w) => {
      const x = w as Record<string, unknown>;
      return {
        agentId: String(x.agentId ?? ""),
        running: typeof x.running === "number" ? x.running : undefined,
        limit: typeof x.limit === "number" ? x.limit : undefined,
        configKey: typeof x.configKey === "string" ? x.configKey : undefined,
      };
    });
}

export interface LastBoot {
  at?: string;
  activated: string[];
  refused: Array<{ agentId: string; reason: string }>;
}

/**
 * Why a live mission has nobody working, in the server's own terms. `startupSeats` is how many seats boot was told to start
 * (null when the server predates the field, and then the cause can only be guessed); `lastBoot` is what boot actually did,
 * kept on `/status` because the response that carried it is gone by the time an operator comes looking.
 */
export function idleCause(startupSeats: number | null, lastBoot: LastBoot | null | undefined): string {
  const why = (rs: Array<{ agentId: string; reason: string }>): string => rs.map((r) => `${r.agentId}: ${r.reason}`).join("; ");
  if (startupSeats === 0) return "No startup agents are configured, so boot had nobody to start and the scheduler came up with an empty queue.";
  if (lastBoot && lastBoot.activated.length === 0 && lastBoot.refused.length > 0) {
    return `Every startup agent was refused at the last boot: ${why(lastBoot.refused)}.`;
  }
  if (lastBoot && lastBoot.activated.length > 0) {
    return `The last boot started ${lastBoot.activated.join(", ")}${lastBoot.refused.length ? `, and was refused ${why(lastBoot.refused)}` : ""}. That work has since finished or stopped.`;
  }
  if (startupSeats === null) {
    return "The scheduler is running with nothing queued behind it. Usually the startup agents were never configured, or were refused at boot.";
  }
  return `The scheduler is running with nothing queued behind it. All ${startupSeats} startup agent${startupSeats === 1 ? "" : "s"} were either refused at boot or have since stopped.`;
}

/* ------------------------------------------------------------------------- */
/* Time, checks and files                                                     */
/* ------------------------------------------------------------------------- */

export interface MissionClock {
  ms: number;
  /** The mission's wall-clock limit, when it has one. */
  limitMs: number | null;
  /** The mission is over, so `ms` is how long it ran rather than how long it has been going. */
  ended: boolean;
  /** Past the limit while still unfinished: the next tick raises the time-limit card. */
  over: boolean;
}

/**
 * How long the mission has run. The kernel's wall clock runs from the goal's creation, not from this process's start, and it
 * does not stop while the project is parked (`wall_clock_exceeded` is measured the same way), so this is the figure the time
 * limit is enforced against and not a count of minutes agents were busy.
 *
 * Null when there is nothing honest to say: no creation time, or a failed mission, whose end the goal does not record.
 */
export function missionClock(
  goal: { status?: string; createdAt?: string; completedAt?: string; budget?: { wallClockMinutes?: number } } | null | undefined,
  nowMs: number,
): MissionClock | null {
  const created = Date.parse(String(goal?.createdAt ?? ""));
  if (!Number.isFinite(created)) return null;
  const minutes = goal?.budget?.wallClockMinutes;
  const limitMs = typeof minutes === "number" && minutes > 0 ? minutes * 60_000 : null;
  if (goal?.status === "COMPLETED") {
    const done = Date.parse(String(goal.completedAt ?? ""));
    if (!Number.isFinite(done)) return null;
    return { ms: Math.max(0, done - created), limitMs, ended: true, over: false };
  }
  if (goal?.status === "FAILED") return null;
  const ms = Math.max(0, nowMs - created);
  return { ms, limitMs, ended: false, over: limitMs !== null && ms > limitMs };
}

export interface ChecksSummary {
  done: number;
  total: number;
  pct: number;
  /** Mandatory checks an agent claimed without verifying: not counted as done, and said so. */
  claimed: number;
}

/**
 * Mandatory checks only, counted the way the kernel counts them (EVIDENCED or WAIVED). ASSERTED is excluded from `done` on
 * purpose and reported separately, so a claim standing unproven is visible beside the bar instead of moving it.
 */
export function checksSummary(criteria: readonly unknown[] | undefined): ChecksSummary {
  const mandatory = (criteria || []).filter((c: any) => c?.mandatory);
  const done = mandatory.filter((c: any) => criterionDone(c)).length;
  const claimed = mandatory.filter((c: any) => c?.status === "ASSERTED").length;
  return { done, total: mandatory.length, pct: mandatory.length ? Math.round((done / mandatory.length) * 100) : 0, claimed };
}

export type CheckMark = "done" | "claimed" | "todo" | "skipped";

/** One criterion as a person reads it. ASSERTED must read differently from both "done" and "to do". */
export function checkView(c: { status?: unknown }): { mark: CheckMark; word: string } {
  switch (c.status) {
    case "EVIDENCED": return { mark: "done", word: "done" };
    case "WAIVED": return { mark: "skipped", word: "skipped" };
    case "ASSERTED": return { mark: "claimed", word: "claimed, not verified" };
    default: return { mark: "todo", word: "to do" };
  }
}

/** The artifact row an `artifact://Type/Name/1` uri names, so an evidence chip can open it. */
export function artifactOfUri<T extends { type?: string; name?: string }>(arts: readonly T[], uri: unknown): T | null {
  const m = /^artifact:\/\/([^/]+)\/([^/]+)\//.exec(String(uri || ""));
  if (!m) return null;
  let name = m[2]!;
  try {
    name = decodeURIComponent(name);
  } catch {
    /* an undecodable name is matched as written */
  }
  return arts.find((a) => a.type === m[1] && a.name === name) ?? null;
}

export interface EvidenceChip {
  label: string;
  title: string;
  /** Present when the evidence names a file the console can open. */
  artifact: any | null;
}

/** The file name inside an `artifact://Type/Name/1` uri, as written, or null when the uri is not one. */
export function nameOfUri(uri: unknown): string | null {
  const m = /^artifact:\/\/[^/]+\/([^/]+)/.exec(String(uri || ""));
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return m[1]!;
  }
}

/**
 * The evidence recorded against one criterion, as chips. A chip that names a file says which file and opens it; one that
 * names nothing says who recorded it. The evidence's kind is left out of the label when it is only the criterion's own id said
 * twice, which is what the kernel records for a check that is closed by the evidence it is named after.
 */
export function evidenceChips(criterion: { id?: unknown; evidence?: unknown }, arts: readonly any[]): EvidenceChip[] {
  const list = Array.isArray(criterion.evidence) ? (criterion.evidence as any[]) : [];
  return list.map((e) => {
    const art = artifactOfUri(arts, e?.artifactRef?.uri);
    const by = String(e?.by ?? "").trim();
    const kind = String(e?.kind ?? "").trim();
    const own = kind !== "" && kind === String(criterion.id ?? "");
    const proof = e?.verified === true ? "verified" : e?.verified === false ? "not verified, because that turn ran no verification tool" : "";
    const facts = [by ? `recorded by ${by}` : "", kind && !own ? `kind ${kind}` : "", proof].filter(Boolean).join(", ");
    const file = nameOfUri(e?.artifactRef?.uri);
    const label = file ?? (kind && !own ? kind : by ? `Recorded by ${by}` : "Evidence recorded");
    const title = `${art ? `${String(art.type ?? "File")} ${String(art.name ?? file ?? "")}. ` : ""}Evidence${facts ? ` ${facts}` : " recorded"}.${art ? " Opens the file." : ""}`;
    return { label, title, artifact: art };
  });
}

/**
 * How long a goal can be and still be read whole in the hero, which gives it two lines at the narrowest layout. Counted, not
 * measured: no DOM read on render.
 */
const GOAL_FITS_IN_HERO = 70;

/** The hero flattens a goal to one paragraph and folds it at two lines; past that, the goal card is where it is read as written. */
export const goalNeedsItsCard = (text: string): boolean => {
  const t = text.trim();
  return t.length > GOAL_FITS_IN_HERO || t.includes("\n");
};

/** The icon of a file by what it is: a patch is code, anything else is a document. */
export function fileIcon(type: unknown): "code" | "files" {
  return /patch|code|diff|source/i.test(String(type ?? "")) ? "code" : "files";
}

/** A file's place in the order a reader wants: settled work first, work in review next, drafts, then what needs rework. */
const FILE_RANK: Record<string, number> = {
  MERGED: 0, FINAL: 0, ACCEPTED: 0, APPROVED: 0, VERIFIED: 0, QA_VERIFIED: 0, SECURITY_VERIFIED: 0, MERGEABLE: 0,
  UNDER_REVIEW: 1, READY_FOR_REVIEW: 1,
  REJECTED: 3,
};
const fileRank = (status: unknown): number => FILE_RANK[String(status ?? "")] ?? 2;

export function sortFiles<T extends { status?: string; name?: string }>(arts: readonly T[]): T[] {
  return [...arts].sort((a, b) => fileRank(a.status) - fileRank(b.status) || String(a.name ?? "").localeCompare(String(b.name ?? "")));
}

export interface FileGroup {
  status: string;
  label: string;
  count: number;
}

/** What shipped, by status: `4 approved, 2 merged, 1 needs rework`, in reading order. */
export function filesByStatus(arts: readonly { status?: string }[]): { total: number; groups: FileGroup[] } {
  const counts = new Map<string, number>();
  for (const a of arts) counts.set(String(a.status ?? ""), (counts.get(String(a.status ?? "")) ?? 0) + 1);
  const groups = [...counts.entries()]
    .map(([status, count]) => ({ status, label: plainArtifact(status), count }))
    .sort((a, b) => fileRank(a.status) - fileRank(b.status) || b.count - a.count || a.label.localeCompare(b.label));
  return { total: arts.length, groups };
}

/** Everything the team produced lives under one workspace; the first artifact that names it says where. */
export function workspaceOf(arts: readonly { contentRef?: unknown }[]): string {
  for (const a of arts) {
    const m = /^file:\/\/(.+)\/\.mesh-state\//.exec(String(a.contentRef || ""));
    if (m) return m[1]!;
  }
  return "";
}

/** The artifact's own path: everything before `.mesh-state` is the workspace, and is said once, not on every card. */
export function shortRef(ref: unknown): string {
  const s = String(ref || "").replace(/^file:\/\//, "");
  const i = s.indexOf("/.mesh-state/");
  return i >= 0 ? s.slice(i + 1) : s;
}

/* ------------------------------------------------------------------------- */
/* The hero's second line                                                     */
/* ------------------------------------------------------------------------- */

export const usd = (n: number): string => `$${n.toFixed(2)}`;

export interface HeroNote {
  /** One quiet line under the figures. */
  summary: string;
  /** What is behind it, shown on request. Paragraphs. */
  detail: string[];
  /** The server's own sentence, quoted exactly, for the states where it has one. */
  server?: string;
}

export interface HeroNoteInput {
  phase: MissionPhase;
  hasHistory: boolean;
  parked: boolean;
  /** `status.parkedNotice`: non-null only for a parked project whose goal is still ACTIVE. */
  parkedNotice: string | null;
  /** The mission's own verdict, phrased: live (from the open card) for a halt, final (from the log) for a finished one. */
  verdict: { title: string; summary: string } | null;
  blockingDecisions: number;
  /** What each open decision that holds the mission is about, phrased, longest-waiting first. */
  decisionTitles: string[];
  startupSeats: number | null;
  lastBoot: LastBoot | null | undefined;
  spend: { usd: number; ceilingUsd: number | null; parked: string[] } | null;
}

/**
 * The sentence that explains the headline, in the place the old Overview put a banner. It is quieter than the headline by
 * design: the headline says what is true and what to do, this says why, and the long part is behind a disclosure.
 */
export function heroNote(i: HeroNoteInput): HeroNote | null {
  switch (i.phase) {
    case "ceiling": {
      const s = i.spend;
      return {
        summary: "Starting the mission will not hold while total spend is over the ceiling: the host parks every open project again.",
        detail: [
          s ? `Total spend across open projects is ${usd(s.usd)}${s.ceilingUsd !== null ? ` against a ceiling of ${usd(s.ceilingUsd)}` : ""}${s.parked.length ? `. Parked: ${s.parked.join(", ")}` : ""}.` : "",
          "The ceiling is host-wide, not this mission's. Raise it in host settings and it takes effect on the next heartbeat, with no restart.",
          "Editing ~/.curule/host.yaml by hand still needs a restart, because that file is read only at startup.",
          "Projects the host already parked stay parked until you continue them.",
        ].filter(Boolean),
      };
    }
    case "needs-you": {
      if (!i.verdict) {
        // An agent-raised card has no phrasing in the catalog, so the stop has no verdict. Say what is waiting anyway: "1 decision"
        // alone sends the operator to another page to find out what it is.
        if (!i.decisionTitles.length) return null;
        const shown = i.decisionTitles.slice(0, 2);
        const more = i.decisionTitles.length - shown.length;
        return { summary: `Waiting: ${list(shown)}${more > 0 ? `, and ${more} more` : ""}.`, detail: [] };
      }
      return {
        summary: `${i.verdict.title}.`,
        detail: [
          i.verdict.summary,
          "This is the mission's own stopping condition, not a quiet patch. It will not clear on its own: the mission stays halted until it is answered.",
          ...(i.blockingDecisions > 1 ? [`${i.blockingDecisions} decisions are waiting in total.`] : []),
        ],
      };
    }
    case "failed":
      // With no phrased verdict there is nothing to add to "The mission failed.", and a second line that only says it again is noise.
      return i.verdict ? { summary: `${i.verdict.title}. ${i.verdict.summary}`, detail: [] } : null;
    case "done":
      return {
        summary: i.verdict ? i.verdict.summary : "All mandatory checks passed.",
        detail: i.parked ? ["The project is parked. A finished mission does not need it running."] : [],
      };
    case "paused":
      return {
        summary: i.verdict ? `${i.verdict.title}. ${i.verdict.summary}` : "Agents are stopped and nothing is lost. Resume to carry on where the mission left off.",
        detail: [],
      };
    case "parked":
      return {
        summary: i.hasHistory
          ? "Previous progress is loaded. Review, answer, add budget, then continue where it left off."
          : "Nothing has been done yet. To run one step without going live, wake a single agent from Agents.",
        detail: [],
        server: i.parkedNotice ?? undefined,
      };
    case "stalled":
      return { summary: idleCause(i.startupSeats, i.lastBoot), detail: [] };
    case "quiet":
      // Between two turns of a mission that is moving looks the same as a mission that is waiting for something that never comes.
      // "Agents wake when something they care about happens" said the same to every mission and nothing about this one: the hero's
      // "Right now" (rightnow.ts) says who is next, what is open and, when nothing is queued, what to do, so it is not said twice.
      return null;
    default:
      return null;
  }
}

/* ------------------------------------------------------------------------- */
/* How the hero looks                                                         */
/* ------------------------------------------------------------------------- */

/**
 * The headline cut after its first sentence: the state in a few words, set large, and what it means, set quieter. The words are
 * mission.ts's, unchanged; a headline that is one sentence has nothing after it. The first sentence is at most 80 characters, so a
 * long one that happens to hold a full stop does not become a title.
 */
export function splitHeadline(text: string): { lead: string; rest: string } {
  const t = text.trim();
  const m = /^(.{1,80}?[.!?])\s+(\S[\s\S]*)$/.exec(t);
  return m ? { lead: m[1]!, rest: m[2]! } : { lead: t, rest: "" };
}

/** The names of the icons the hero draws; every one is in the console's registry (icons.tsx), which the compiler checks where they are drawn. */
export type HeroIcon = "refresh" | "alert" | "cost" | "check" | "pause" | "dot";

/**
 * The mark at the head of the hero: a shape for each state, so the state reads without telling hues apart. Only a mission with agents
 * mid-turn is live, and only it moves.
 */
export function heroLook(phase: MissionPhase): { icon: HeroIcon; live: boolean } {
  switch (phase) {
    case "loading": return { icon: "refresh", live: false };
    case "offline": case "down": case "needs-you": case "failed": case "stalled": return { icon: "alert", live: false };
    case "ceiling": return { icon: "cost", live: false };
    case "done": return { icon: "check", live: false };
    case "paused": case "parked": return { icon: "pause", live: false };
    case "quiet": return { icon: "dot", live: false };
    case "running": return { icon: "dot", live: true };
  }
}

export interface SeatChip {
  id: string;
  role: string;
  /** In a turn right now: drawn lit. */
  working: boolean;
}

/**
 * The seats as a stack of avatars: the roster in its own order (a seat's place in the mesh is stable), the ones in a turn lit. `max` is
 * how many chips fit in the row, the "+N" one included: a roster that fits is drawn whole, and a longer one is drawn with a chip fewer
 * so the count sits beside the seats and does not wrap onto a row of its own. The seats that are working are kept before the rest, so
 * a long roster never hides who is busy; `more` is how many are left out. The human is not a seat.
 */
export function seatStack(agents: ReadonlyArray<{ id: string; role?: string; lifecycle?: string }> | undefined, max = 7): { shown: SeatChip[]; more: number } {
  const seats: SeatChip[] = (agents ?? [])
    .filter((a) => a?.id && a.id !== "human")
    .map((a) => ({ id: String(a.id), role: String(a.role ?? ""), working: RUNNING.has(String(a.lifecycle ?? "").toUpperCase()) }));
  if (seats.length <= max) return { shown: seats, more: 0 };
  const room = Math.max(1, max - 1);
  const keep = new Set<string>();
  for (const s of seats) if (s.working && keep.size < room) keep.add(s.id);
  for (const s of seats) if (keep.size < room) keep.add(s.id);
  return { shown: seats.filter((s) => keep.has(s.id)), more: seats.length - room };
}

/**
 * The turns the list of steps says are running that the status says are over. `/status` is read with every event and carries the ten
 * latest turns; `/steps` is read every few seconds, so for a moment after a turn ends the page holds two readings of it. The list is
 * the older one: these are the turns to read again, and not to count as running meanwhile.
 */
export function staleRunning(
  steps: ReadonlyArray<{ turnId?: string; status?: string }>,
  recent: ReadonlyArray<{ turnId?: string; status?: string }> | undefined,
): string[] {
  const said = new Map<string, string>();
  for (const t of recent ?? []) if (t?.turnId) said.set(t.turnId, String(t.status ?? ""));
  return steps.flatMap((s) => (s.status === "running" && s.turnId && said.has(s.turnId) && said.get(s.turnId) !== "running" ? [s.turnId] : []));
}

/**
 * The turns the status says are running that the list of steps does not have at all: they began after the list was read. Like a turn
 * that ended since, they are a reason to read the list again; unlike it, the list has nothing to un-count.
 */
export function unlistedRunning(
  steps: ReadonlyArray<{ turnId?: string }>,
  recent: ReadonlyArray<{ turnId?: string; status?: string }> | undefined,
): string[] {
  const listed = new Set(steps.map((s) => s.turnId).filter((id): id is string => Boolean(id)));
  return (recent ?? []).flatMap((t) => (t?.turnId && t.status === "running" && !listed.has(t.turnId) ? [t.turnId] : []));
}

/** One mark for each mandatory check, in the goal's order: the segments of the bar under the figure. */
export function checkSegments(criteria: readonly unknown[] | undefined): CheckMark[] {
  return (criteria || []).filter((c: any) => c?.mandatory).map((c: any) => checkView(c).mark);
}

export interface EventLook {
  icon: "message" | "agents" | "files" | "steps" | "approve" | "overview" | "cost" | "inbox" | "lock" | "alert" | "dot";
  /** Only what went wrong and what was completed carry a colour; the rest of the log is quiet. */
  tone: "bad" | "ok" | "neutral";
}

const EVENT_ICON: Record<string, EventLook["icon"]> = {
  message: "message", thread: "message", human: "message",
  agent: "agents", memory: "agents", session: "agents", continuity: "agents",
  artifact: "files", patch: "files", release: "files", requirements: "files", requirement: "files", dependency: "files", research: "files",
  architecture: "files", design: "files", implementation: "files", authentication: "files", authorization: "files",
  task: "steps", plan: "steps", commitment: "steps",
  review: "approve", decision: "approve",
  goal: "overview", budget: "cost", escalation: "inbox", lease: "lock",
};

/**
 * What a row of the log looks like: the icon of the kind of thing that happened, instead of the kind's name in a colour. An alert
 * (the severity the catalog and eventmodel.ts assign) is a triangle in the bad tone whatever its kind, so a crash is never a quiet
 * dot among the rest; a completion is the one good-news tone.
 */
export function eventLook(type: string, severity: "alert" | "notice" | "routine"): EventLook {
  if (severity === "alert") return { icon: "alert", tone: "bad" };
  const group = String(type).split(".")[0] ?? "";
  // A seat finishing is bookkeeping at the end of every mission; the good news is the work and the mission.
  const done = group !== "agent" && /\.(completed|approved|merged|satisfied|accepted)$/.test(type);
  return { icon: EVENT_ICON[group] ?? "dot", tone: done ? "ok" : "neutral" };
}

/* ------------------------------------------------------------------------- */
/* The attention list                                                         */
/* ------------------------------------------------------------------------- */

export type AttentionTone = "bad" | "warn" | "info";
export type AttentionKind = "decisions" | "ceiling" | "blocks" | "tools" | "notices" | "capacity" | "triage";
/** Where a fix lives. The view maps each to a route; this module does not know the routes. */
export type FixTarget = "inbox" | "tools" | "designer" | "hostsettings";

export interface AttentionItem {
  kind: AttentionKind;
  tone: AttentionTone;
  /** What is true, as one sentence. */
  title: string;
  /** One line of context beside it, when there is one. */
  context?: string;
  /** The long wording, behind a disclosure. Empty means there is nothing more to say. */
  detail: string[];
  /** The single fix, when it is not already the hero's button. */
  fix?: { label: string; target: FixTarget };
}

export interface AttentionInput {
  phase: MissionPhase;
  parked: boolean;
  blockingDecisions: number;
  /** How many of those are the host's ceiling card. In the ceiling phase the hero is that card, so it is not counted again. */
  ceilingCards?: number;
  /** Open advisory notices, already phrased. */
  notices: Array<{ title: string }>;
  /** Seats with a tool request waiting, and what each asked for. */
  toolRequests: Array<{ agentId: string; tools: string[] }>;
  /** The host's aggregate spend. Listed only when it is true of a project that is not itself the headline. */
  spend: { usd: number; ceilingUsd: number | null; parked: string[]; tripped: boolean } | null;
  blocks: readonly StandingBlock[];
  /**
   * Seats whose own budget card is open. The policy's deferral for such a seat says the same thing as the card, in worse words
   * and with no way to fix it, so it is not listed again.
   */
  coveredSeats?: readonly string[];
  capacity: readonly CapacityWait[];
  triagedAway: number;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const list = (items: string[]): string => (items.length <= 2 ? items.join(" and ") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);
const TONE_RANK: Record<AttentionTone, number> = { bad: 0, warn: 1, info: 2 };
const KIND_RANK: Record<AttentionKind, number> = { decisions: 0, ceiling: 1, blocks: 2, tools: 3, notices: 4, capacity: 5, triage: 6 };

/**
 * Everything that is true of the mission besides its headline, in the order to read it: what needs the operator, then what is
 * wrong, then what is only worth knowing. Empty when there is nothing to say, which is most of the time.
 */
export function buildAttention(i: AttentionInput): AttentionItem[] {
  // The last known state is not a place to list live problems from, and the hero already says it may be stale.
  if (i.phase === "offline" || i.phase === "loading") return [];
  const out: AttentionItem[] = [];
  const over = i.phase === "done" || i.phase === "failed";

  const others = i.blockingDecisions - (i.phase === "ceiling" ? i.ceilingCards ?? 0 : 0);
  if (others > 0 && i.phase !== "needs-you") {
    out.push({
      kind: "decisions", tone: "bad", detail: [],
      title: `${plural(others, "decision")} waiting on you.`,
      fix: { label: "Review decisions", target: "inbox" },
    });
  }

  if (i.spend?.tripped && !i.parked && !over && i.phase !== "ceiling") {
    out.push({
      kind: "ceiling", tone: "warn",
      title: "The host is at its spend ceiling.",
      context: i.spend.ceilingUsd !== null ? `${usd(i.spend.usd)} of ${usd(i.spend.ceilingUsd)}.` : undefined,
      detail: ["While total spend is over the ceiling, the host parks every open project on its next heartbeat. Raise the ceiling in host settings to keep this one running."],
      fix: { label: "Raise the ceiling", target: "hostsettings" },
    });
  }

  // `goal-halted` is the policy refusing every wake because the mission is escalated, delivered or failed: the headline, in the
  // policy's words, once per agent. A seat's own budget deferral is its budget card, said again.
  const covered = new Set(i.coveredSeats ?? []);
  const blocks = i.blocks.filter((b) => b.ruleId !== "goal-halted" && (b.deny || b.ruleId !== "budget" || !covered.has(b.actorId)));
  if (!i.parked && !over && blocks.length > 0) {
    const denied = blocks.filter((b) => b.deny);
    const deferred = blocks.filter((b) => !b.deny);
    const line = (b: StandingBlock): string => `${b.reason}${b.ruleId ? ` (${b.ruleId})` : ""}`;
    const first = blocks[0]!;
    const explain = [
      ...(denied.length ? ["Refused outright: these do not retry on their own, and waking one by hand is refused the same way. The named rule has to change before anything moves."] : []),
      ...(deferred.length ? ["Deferred, not refused: each queues itself again the moment the budget or goal it is waiting on moves. Waking one by hand will not stick while the limit still binds. Raise the limit instead."] : []),
    ];
    out.push({
      kind: "blocks", tone: denied.length ? "bad" : "warn",
      title: blocks.length === 1 ? `${first.actorId} is not being woken.` : `${blocks.length} agents are not being woken.`,
      context: blocks.length === 1 ? `${line(first)}.` : `${list(blocks.slice(0, 3).map((b) => b.actorId))}${blocks.length > 3 ? ` and ${blocks.length - 3} more` : ""}.`,
      detail: [...(blocks.length === 1 ? [] : blocks.map((b) => `${b.actorId}: ${line(b)}.`)), ...explain],
      fix: { label: "Open the designer", target: "designer" },
    });
  }

  if (!over && i.toolRequests.length > 0) {
    const n = i.toolRequests.reduce((sum, s) => sum + s.tools.length, 0);
    const lead = i.toolRequests[0]!;
    out.push({
      kind: "tools", tone: "warn",
      title: `${plural(n, "tool request")} waiting.`,
      context: `${lead.agentId} asked for ${list(lead.tools)}${i.toolRequests.length > 1 ? `, and ${i.toolRequests.length - 1} more ${i.toolRequests.length === 2 ? "seat has" : "seats have"} asked too` : ""}.`,
      detail: ["A seat that reached for a tool its gate holds back waits until you unlock that tool. Unlocking does not wake the seat, so wake it after you have cleared everything it needs."],
      fix: { label: "Review tool requests", target: "tools" },
    });
  }

  if (i.notices.length > 0) {
    out.push({
      kind: "notices", tone: "info",
      title: i.notices.length === 1 ? "1 notice for you. It holds nothing." : `${i.notices.length} notices for you. They hold nothing.`,
      context: `${i.notices[0]!.title}${i.notices.length > 1 ? `, and ${i.notices.length - 1} more` : ""}.`,
      detail: i.notices.length > 1 ? i.notices.map((n) => `${n.title}.`) : [],
      fix: { label: i.notices.length === 1 ? "Read it" : "Read them", target: "inbox" },
    });
  }

  if (!i.parked && !over && i.capacity.length > 0) {
    const lead = i.capacity[0]!;
    const label = lead.configKey ? CEILING_LABEL[lead.configKey] : undefined;
    out.push({
      kind: "capacity", tone: "info",
      title: i.capacity.length === 1 ? `${lead.agentId} is queued, waiting for a slot.` : `${i.capacity.length} agents are queued, waiting for a slot.`,
      context: typeof lead.running === "number" && typeof lead.limit === "number"
        ? `The mesh is running ${lead.running} of ${lead.limit}${label ? `; ${label} is the ceiling that binds` : ""}.`
        : undefined,
      detail: [
        "Nothing was refused and nothing is lost: each one starts on its own the moment a running turn finishes, so this normally clears within a turn. Waking one by hand will not help, because an explicit wake skips a parked scheduler, not a full one.",
        `Raise ${label ? `"${label}"` : "the concurrency limits"} in the designer's Mesh panel if these should run in parallel instead. scheduling.* edits apply on the next mesh boot, so raising it will not release the agents queued right now.`,
      ],
      fix: { label: "Open the designer", target: "designer" },
    });
  }

  // Only for a live mission with nobody working: that is the state a dropped event explains ("an agent that looks idle may simply
  // never have been told"). While agents are working, a count of events a rule dropped on purpose is not a condition to act on.
  if (!i.parked && (i.phase === "stalled" || i.phase === "quiet") && i.triagedAway > 0) {
    const n = i.triagedAway;
    out.push({
      kind: "triage", tone: "info",
      title: n === 1 ? "1 event was triaged away. No agent saw it." : `${n} events were triaged away. No agent saw them.`,
      detail: [
        `Nothing is blocked and nothing is waiting: a triage rule matched ${n === 1 ? "it" : "them"} and dropped ${n === 1 ? "it" : "them"} before anything was queued. ${n === 1 ? "It" : "They"} will not be retried, so an agent that looks idle may simply never have been told.`,
        "Loosen or remove the rule under Triage in the designer's Mesh panel. scheduling.* edits apply on the next mesh boot, not to this run.",
      ],
      fix: { label: "Open the designer", target: "designer" },
    });
  }

  return out.sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone] || KIND_RANK[a.kind] - KIND_RANK[b.kind]);
}
