/**
 * One escalation as a card: what it says, what it holds up, and how it is answered.
 *
 * This was the middle third of Escalations.tsx (a switch of wording arms, the budget block, the stuck-request fold). It
 * carries the claims the card makes to the operator, among them which answers resume the mission, so it lives where a test
 * can reach it. The phrasing of a termination reason comes from the protocol catalog, which this module must not import (a
 * source-level reach into a package); the caller passes the catalog's `verdictText` in as `phrase`.
 *
 * The answer is one pattern for every kind of card: one action that names its consequence, a typed answer where free text is
 * the right answer, a skip with a reason where a request can be skipped, and a line that says what answering does to the
 * mission. The wording of each is true per kind, and true again when the project is parked or the card is only a notice.
 */
import { applyAdvisoryTone, applyParkedTone, PAUSED_CLAUSE, RESUMES, RESUMES_AND_WAKES } from "./escalation-tone";
import { fmt, roundNice } from "./format";

/** The catalog's `verdictText`, structurally. */
export type Phrase = (reason: string, ctx?: { agents?: string[]; waiting?: number; threads?: number }) => { title: string; summary: string };

export interface EscalationLike {
  id?: string;
  goalId?: string;
  reason?: string;
  raisedBy?: string;
  status?: string;
  advisory?: boolean;
  conflictKey?: string;
  createdAt?: string;
  detail?: unknown;
  supports?: string[];
  [k: string]: unknown;
}

export interface BudgetInfo {
  title: string;
  what: string;
  next: string;
  placeholder: string;
  key?: string;
  agent?: string;
  consumed?: number;
  limit?: number;
  unit: string;
  raisable: boolean;
  configCap?: "events" | "time";
}

export interface CardText {
  title: string;
  what: string;
  next: string;
  placeholder: string;
  budget?: BudgetInfo;
}

export interface StuckInfo {
  agentId: string;
  askerId: string;
  requestId: string;
  requestType: string;
  age: string;
  requestLabel: string;
  underlying: Array<{ id: string; conflictKey?: string; reason?: string }>;
}

/** `fmt` with a trailing `.0` dropped, for a button: "Add 500k tokens", not "Add 500.0k tokens". */
export const compact = (n: number): string => fmt(n).replace(/\.0(?=[kM]$)/, "");

const detailOf = (e: EscalationLike): Record<string, any> => (e.detail && typeof e.detail === "object" ? (e.detail as Record<string, any>) : {});

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/* ------------------------------ the request ------------------------------- */

export function msgText(m: any): string {
  const p = m?.payload;
  if (!p || typeof p !== "object") return "";
  for (const k of ["question", "summary", "note", "reason", "text", "answer"]) {
    if (typeof (p as Record<string, unknown>)[k] === "string") return (p as Record<string, unknown>)[k] as string;
  }
  return "";
}

export function plainTaskOf(m: any, fallbackType: string): { title: string; task: string } {
  const q = msgText(m).trim();
  const t = m?.type || fallbackType || "REQUEST";
  if (q.length > 0) {
    const first = q.split(/\n+/)[0]!.slice(0, 140);
    return { title: first, task: q.slice(0, 500) };
  }
  if (t === "REQUEST_REVIEW") return { title: "Review requested", task: "Review the file and approve or reject it." };
  return { title: "Input needed", task: "Answer so the waiting agent can continue." };
}

export function suggestedAnswerOf(m: any, askerId: string, target: string): string {
  const q = msgText(m).trim();
  if (/test_result|ui suite|e2e/i.test(q)) return `Approved. ${target}, run the UI suite and the preset and headless e2e, and post TEST_RESULT.`;
  if (/eta|still in progress|patch/i.test(q)) return "Still in progress. ETA 1h, will post patch.ready when the new version is up.";
  if (q) return `Approved. Proceed${askerId ? ` (${askerId} asked: ${q.slice(0, 100)})` : ""}.`;
  return `Approved. ${target} can continue.`;
}

export function shortArt(uri: string): string {
  const m = /artifact:\/\/([^/]+)\/([^/]+)/.exec(uri);
  return m ? `${decodeURIComponent(m[2]!)}` : uri.slice(0, 40);
}

export function requestLabelOf(m: any, fallbackType: string): string {
  const t = m?.type || fallbackType || "request";
  const q = msgText(m);
  const refs = Array.isArray(m?.artifactRefs) ? m.artifactRefs : [];
  const art = refs.length > 0 ? ` (${refs.map((r: any) => shortArt(String(r?.uri || ""))).join(", ")})` : "";
  const head = t === "REQUEST_REVIEW" ? "a review" : t === "REQUEST" ? "a status update" : `a ${String(t).toLowerCase().replace(/_/g, " ")}`;
  return q ? `${head}${art}: “${q.slice(0, 160)}”` : `${head}${art}`;
}

/** How long a card has been waiting: `just now`, `12m waiting`, `2h 5m waiting`. Empty when the stamp cannot be read. */
export function ageOf(iso: unknown, nowMs: number = Date.now()): string {
  const ms = nowMs - Date.parse(String(iso ?? ""));
  if (!Number.isFinite(ms) || ms < 0) return "";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m waiting`;
  return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""} waiting`;
}

export function stuckInfoOf(e: EscalationLike, msgs?: Map<string, any>, nowMs: number = Date.now()): StuckInfo {
  const d = detailOf(e);
  const agentId = typeof d.agentId === "string" ? d.agentId : "";
  const requestId = typeof d.requestMessageId === "string" ? d.requestMessageId : "";
  const requestType = typeof d.requestType === "string" ? d.requestType : "";
  const m = requestId && msgs ? msgs.get(requestId) : undefined;
  const askerId = m && typeof m.from === "string" ? m.from : "";
  return {
    agentId,
    askerId,
    requestId,
    requestType,
    age: d.awaitingSince ? ageOf(d.awaitingSince, nowMs) : e.createdAt ? ageOf(e.createdAt, nowMs) : "",
    requestLabel: requestLabelOf(m, requestType),
    underlying: Array.isArray(d.openDeadlockEscalations) ? d.openDeadlockEscalations.filter((o: any) => o && typeof o.id === "string") : [],
  };
}

/* Evidence on an escalation arrives as `artifact://<type>/<name>/<version>`, which is enough to print a filename and nothing
 * more: the drawer is keyed by artifact id, which the uri does not carry. So the view fetches the artifact list once and
 * resolves refs against it, in the order supervisor.findArtifactByUri uses: the exact versioned uri first, then the newest
 * version of that type and name. Anything that does not resolve stays plain text rather than a button that does nothing. */
export function resolveArtifactId(list: readonly any[], uri: string): string | null {
  const m = /^artifact:\/\/([^/]+)\/([^/]+?)(?:\/(\d+))?$/.exec(uri);
  if (!m) return null;
  const type = m[1];
  const name = decodeURIComponent(m[2]!);
  const version = m[3] ? Number(m[3]) : undefined;
  let best: any = null;
  for (const a of list) {
    if (a?.type !== type || a?.name !== name) continue;
    if (version !== undefined && a.version === version) return String(a.id);
    if (!best || Number(a.version) > Number(best.version)) best = a;
  }
  return best ? String(best.id) : null;
}

/**
 * The requests a derived stalemate card summarises, and which of them are still open. Only an open one has a card to jump to:
 * pointing at a card that was filtered out of the list made a button that silently did nothing.
 */
export function openSupports(e: EscalationLike, list: readonly EscalationLike[]): Array<{ id: string; esc: EscalationLike }> {
  const d = detailOf(e);
  const ids: string[] = Array.isArray(e.supports)
    ? e.supports.filter((x) => typeof x === "string")
    : (Array.isArray(d.openDeadlockEscalations) ? d.openDeadlockEscalations : []).map((o: any) => o?.id).filter((x: unknown): x is string => typeof x === "string");
  const byId = new Map(list.map((x) => [String(x.id), x]));
  return ids.flatMap((id) => {
    const u = byId.get(id);
    return u && u.status === "OPEN" ? [{ id, esc: u }] : [];
  });
}

export function escAgents(e: EscalationLike): string[] {
  const d = detailOf(e);
  const out = new Set<string>();
  if (Array.isArray(d.failedAgents)) for (const a of d.failedAgents) out.add(a);
  if (typeof d.agentId === "string") out.add(d.agentId);
  if (typeof d.key === "string") {
    const m = /^agent:[^/]+\/(.+)$/.exec(d.key);
    if (m && m[1]) out.add(m[1]);
  }
  if (typeof e.raisedBy === "string" && !isSystemRaiser(e.raisedBy) && e.raisedBy !== "human") out.add(e.raisedBy);
  if (Array.isArray(d.participants)) for (const a of d.participants) if (typeof a === "string") out.add(a);
  return [...out].filter((a) => a && a !== "human");
}

/* ------------------------------ who raised it ------------------------------- */

/**
 * The components that raise cards, as against the seats and the operator. None of them is an agent: a chip for one would open an
 * agent drawer for something that has no seat, and "raised by stall-watchdog" names a part of the machinery, not a decision-maker.
 */
const SYSTEM_RAISERS: readonly string[] = ["termination-manager", "recovery-manager", "deadlock-detector", "collab-watchdog", "stall-watchdog", "host-limiter"];
export const isSystemRaiser = (raisedBy: unknown): boolean => SYSTEM_RAISERS.includes(String(raisedBy ?? ""));

/** Who raised the card, in words: the host, the mesh's watchdogs, or the seat by its name. */
export function raisedByLabel(raisedBy: unknown): string {
  const who = String(raisedBy ?? "");
  return who === "host-limiter" ? "the host" : isSystemRaiser(who) ? "the mesh watchdog" : who;
}

/* ------------------------------- what it holds ------------------------------ */

/**
 * The seat a card parks, when it is a seat's own budget card (`budget:agent:<goal>/<seat>`). Such a card is the operator's to
 * answer but it never halts the goal: the seat is parked by the policy's budget rule and every other seat keeps working. The
 * supervisor keys on exactly this (`seatOfBudgetCard`), so the console must too, or it tells the operator the mission is
 * paused when it is not.
 */
export function seatOfBudgetCard(e: EscalationLike): string | null {
  const m = /^budget:agent:([^/]+)\/(.+)$/.exec(String(e.conflictKey ?? ""));
  if (!m) return null;
  if (typeof e.goalId === "string" && e.goalId && m[1] !== e.goalId) return null;
  return m[2]!;
}

export type Holds = { scope: "mission" } | { scope: "seat"; seat: string } | { scope: "nothing" };

/** What an open card holds up. An advisory card holds nothing; a seat's budget card holds that seat; every other card halts the mission. */
export function holdsOf(e: EscalationLike): Holds {
  if (e.advisory === true) return { scope: "nothing" };
  const seat = seatOfBudgetCard(e);
  return seat ? { scope: "seat", seat } : { scope: "mission" };
}

export function holdsLine(h: Holds): string {
  return h.scope === "mission" ? "Holds up the whole mission." : h.scope === "seat" ? `Holds up ${h.seat} only. The rest of the mesh keeps working.` : "Holds up nothing.";
}

/* ------------------------------- the wording -------------------------------- */

function ledgerOf(status: any, key: unknown): any {
  return typeof key === "string" ? (status?.budgets || []).find((b: any) => b.key === key) : undefined;
}

export function budgetInfoOf(e: EscalationLike, status: any, phrase: Phrase): BudgetInfo {
  const d = detailOf(e);
  const word = (reason: string): string => phrase(reason).title;
  if (e.reason === "agent_budget_exhausted") {
    const key = typeof d.key === "string" ? d.key : undefined;
    const agent = (/^agent:[^/]+\/(.+)$/.exec(String(key || "")) || [])[1] || (typeof d.agentId === "string" && d.agentId) || "agent";
    // The live ledger first: the limit may have been raised since the card was written, and the meter must not show the old one.
    const ledger = ledgerOf(status, key);
    const consumed = num(ledger?.consumed) ?? num(d.consumed) ?? 0;
    const limit = num(ledger?.limit) ?? num(d.limit) ?? 0;
    const spent = `${fmt(consumed)} of its ${fmt(limit)} token budget`;
    if (seatOfBudgetCard(e) !== null) {
      const owed = num(d.owedAsks) ?? 0;
      const waits = owed > 0 ? `Its mail and the ${owed} ask${owed === 1 ? "" : "s"} it owes wait for it.` : "Its mail waits for it.";
      return {
        title: `${agent} ran out of tokens`, key, agent, consumed, limit, unit: "tokens", raisable: true,
        what: `${agent} is parked: it has spent ${spent}, and nothing raises it automatically. It takes no turns until you add tokens. ${waits} The rest of the mesh keeps working.`,
        // Nothing to add: the line under the form says the raise takes effect at once, and the card says what is held.
        next: "",
        placeholder: `e.g. raised ${agent} to ${fmt(Math.ceil((limit * 1.5) / 1000) * 1000)}; keep research shallow`,
      };
    }
    const parked: string[] = Array.isArray(d.parkedSeats) ? d.parkedSeats.filter((x: unknown) => typeof x === "string") : [];
    return {
      title: "Every seat is out of tokens", key, agent, consumed, limit, unit: "tokens", raisable: true,
      what: `Every live seat has spent its own token budget${parked.length ? ` (${parked.join(", ")})` : ""}, so nobody can take a turn and the watchdog halted the mission. ${agent} has spent ${spent}.`,
      next: "Responding without adding tokens leaves the budget spent, so the mission halts again.",
      placeholder: `e.g. raised ${agent} to ${fmt(Math.ceil((limit * 1.5) / 1000) * 1000)}; keep research shallow`,
    };
  }
  if (e.reason === "budget_exhausted" || e.reason === "budget_exhausted_tokens") {
    const key = typeof d.key === "string" ? d.key : (status?.budgets || []).find((b: any) => String(b.key).startsWith("mission:") && b.limitKind === "tokens")?.key;
    const ledger = ledgerOf(status, key);
    const consumed = num(ledger?.consumed) ?? num(d.consumed) ?? 0;
    const limit = num(ledger?.limit) ?? num(d.limit) ?? 0;
    return {
      title: word(String(e.reason)), key, consumed, limit, unit: "tokens", raisable: typeof key === "string",
      // The door raises this card when the next turn does not fit in what is left, so the ledger can read under its limit.
      what: `${fmt(consumed)} of ${fmt(limit)} mission tokens are spent${limit > 0 && consumed < limit ? ", and what is left is not enough for the next turn" : ""}. Nobody can run until you raise the limit.`,
      next: "Responding without adding tokens leaves the budget spent, so nobody can run.",
      placeholder: `e.g. raised mission to ${fmt(Math.ceil((limit * 1.5) / 1000) * 1000)}; skip optional criteria`,
    };
  }
  if (e.reason === "thread_budget_exhausted") {
    const key = d.threadId && e.goalId ? `thread:${e.goalId}/${d.threadId}` : undefined;
    const entry = ledgerOf(status, key);
    return {
      title: word("thread_budget_exhausted"), key, consumed: entry?.consumed ?? 0, limit: entry?.limit ?? 0, unit: "tokens", raisable: !!key,
      what: "One conversation thread spent its token budget, so work in it stopped and the mission halted.",
      next: key ? "Add tokens to the thread, or start a fresh thread with a tighter question." : "Start a fresh thread with a tighter question, then respond.",
      placeholder: "e.g. raised thread budget; continue with a yes/no question",
    };
  }
  if (e.reason === "max_events_exceeded") {
    const live = status?.goal?.budget?.maxEvents;
    const limit = (typeof live === "number" ? live : undefined) ?? num(d.limit) ?? 0;
    return {
      title: word("max_events_exceeded"), consumed: num(d.events) ?? 0, limit, unit: "events", raisable: false,
      what: `The mission passed its event cap (${fmt(num(d.events) ?? 0)} of ${fmt(limit)} events).`,
      next: "", placeholder: "", configCap: "events",
    };
  }
  if (e.reason === "wall_clock_exceeded") {
    const mins = (ms: unknown): string => (typeof ms === "number" ? `${Math.round(ms / 60000)}m` : "?");
    return {
      title: word("wall_clock_exceeded"), consumed: d.wallClockMs, limit: d.limitMs, unit: "minutes", raisable: false,
      what: `The mission ran past its wall-clock limit (${mins(d.wallClockMs)} of ${mins(d.limitMs)}).`,
      next: "", placeholder: "", configCap: "time",
    };
  }
  return { title: "Budget exhausted", unit: "tokens", raisable: false, what: "A budget ran out and the mission halted.", next: "See Cost for details, then respond with how to proceed.", placeholder: "e.g. decided: …" };
}

export interface CardContext {
  status: any;
  msgs?: Map<string, any>;
  parked: boolean;
  phrase: Phrase;
  nowMs?: number;
  /** The host's ceiling has been raised past the spend since the card was written (`ceilingTripped` is false again). */
  ceilingRaised?: boolean;
}

function textBody(e: EscalationLike, ctx: CardContext): CardText {
  const { status, msgs, phrase } = ctx;
  const d = detailOf(e);
  const failed: string[] = d.failedAgents || (d.agentId ? [d.agentId] : []);
  const err = d.error ? String(d.error).slice(0, 220) : "";
  const who = isSystemRaiser(e.raisedBy) ? "Mesh watchdog" : String(e.raisedBy);
  switch (e.reason) {
    case "runtime_failure":
      return {
        title: phrase("runtime_failure", { agents: failed }).title,
        what: `${who} detected a runtime failure${failed.length ? ` in ${failed.join(", ")}` : ""}${err ? `: ${err}` : ""}. ${PAUSED_CLAUSE}`,
        next: `Check the agent's last step for the error, then tell the mesh how to proceed (retry, skip, or reassign). ${RESUMES_AND_WAKES}`,
        placeholder: failed.length ? `e.g. retry ${failed[0]} once, else skip and continue` : "e.g. retry once, else skip and continue",
      };
    case "backend_unreachable": {
      const agent = typeof d.agentId === "string" && d.agentId ? d.agentId : failed[0] || "agent";
      const backend = typeof d.backend === "string" ? d.backend : "";
      const backendLine = backend && backend !== "unknown — check the agent's runtime (opencode server port, http baseUrl)" ? ` Its backend at ${backend} stopped answering.` : " Its model backend stopped answering.";
      return {
        title: `${agent}'s backend is down`,
        what: `${agent} failed ${typeof d.consecutiveFailures === "number" ? d.consecutiveFailures : "several"} turns in a row because the model backend is unreachable.${backendLine}`,
        next: "Check the backend process is alive, look for OOM, or restart it, then respond and wake the agent for a fresh turn. Retrying without fixing the backend only spends more turns.",
        placeholder: `e.g. restarted backend; wake ${agent} to retry`,
      };
    }
    case "thread_budgets_exhausted": {
      const n = typeof d.exhaustedThreads === "number" ? d.exhaustedThreads : Array.isArray(d.threads) ? d.threads.length : 0;
      return {
        title: phrase("thread_budgets_exhausted", { threads: n }).title,
        what: `${n} conversation thread${n === 1 ? " has" : "s have"} spent their token budget, and no thread is left that agents can talk in. Work stopped silently: nobody is running.`,
        next: "Raise the per-thread budget in mesh.yaml (budgets.thread_tokens), or respond to have the agents start a fresh thread with a tighter question.",
        placeholder: "e.g. start a fresh thread and keep it short",
      };
    }
    case "budget_exhausted":
    case "agent_budget_exhausted":
    case "thread_budget_exhausted":
    case "budget_exhausted_tokens":
    case "max_events_exceeded":
    case "wall_clock_exceeded": {
      const b = budgetInfoOf(e, status, phrase);
      return { title: b.title, what: b.what, next: b.next, placeholder: b.placeholder, budget: b };
    }
    case "host_spend_ceiling": {
      const usd = num(d.usd);
      const cap = num(d.ceilingUsd);
      const figures = usd !== undefined && cap !== undefined ? ` Total spend across open projects reached $${usd.toFixed(2)} against a ceiling of $${cap.toFixed(2)}.` : "";
      // The host does not clear this card when the ceiling goes up, and an open card holds the mission's completion, so once the
      // ceiling is past the spend the card's only job is to be cleared. Saying so ends a card that otherwise reads as unresolved.
      if (ctx.ceilingRaised) {
        return {
          title: phrase("host_spend_ceiling").title,
          what: `The host parked every open project.${figures} The ceiling has since been raised past the spend, so this card only needs clearing.`,
          next: ctx.parked
            ? "The host does not restart a project it parked when the ceiling goes up, so start the mission when you are ready. An open card also holds a finished mission back from delivery."
            : "An open card holds a finished mission back from delivery, so clear it.",
          placeholder: "e.g. ceiling raised",
        };
      }
      return {
        title: phrase("host_spend_ceiling").title,
        // Not PAUSED_CLAUSE: the goal is not paused, the host parked the project from outside, and answering this card starts nothing.
        what: `The host parked every open project.${figures}`,
        next: "Continuing will not hold: while the total is over the ceiling, the host parks every open project again on its next heartbeat. The ceiling is host-wide, so raise it in host settings.",
        placeholder: "e.g. raised the ceiling to $25",
      };
    }
    case "stalemate":
    case "stalemate:unanswered_request": {
      const stuck = stuckInfoOf(e, msgs, ctx.nowMs);
      if (e.reason === "stalemate") {
        const n = stuck.underlying.length;
        return {
          title: phrase("stalemate", { waiting: n }).title,
          what: n > 0
            ? `The mission is paused: ${n} answer${n === 1 ? " is" : "s are"} still missing. Answer ${n === 1 ? "it" : "each one"}, or answer all at once.`
            : "The mission is paused on a stalemate whose underlying requests are already resolved. The mesh retires this automatically; answering clears it now.",
          next: "Answer each request, or send one decision that covers all of them.",
          placeholder: "e.g. approved it myself; continue",
        };
      }
      const target = stuck.agentId || escAgents(e)[0] || "agent";
      const task = plainTaskOf(msgs?.get(stuck.requestId), stuck.requestType);
      return {
        title: task.title || `${target} is waiting`,
        what: task.task,
        next: "",
        placeholder: suggestedAnswerOf(msgs?.get(stuck.requestId), stuck.askerId, target),
      };
    }
    case "stalemate:stall_nudge_cap": {
      const v = phrase("stalemate:stall_nudge_cap");
      return {
        title: v.title,
        what: `${v.summary} ${PAUSED_CLAUSE}`,
        next: `Read the context below, then respond with the decision. ${RESUMES}`,
        placeholder: "e.g. decided: …",
      };
    }
    default:
      if (String(e.reason || "").startsWith("collab_overrun:")) {
        const why = String(e.reason).slice("collab_overrun:".length);
        const topic = typeof d.topic === "string" && d.topic ? d.topic : "";
        const parts = Array.isArray(d.participants) ? d.participants.filter((x: any) => typeof x === "string" && x) : [];
        const n = Number(d.exchanges);
        const cap = Number(d.maxExchanges);
        const meter = Number.isFinite(n) ? ` after ${n}${cap > 0 ? `/${cap}` : ""} exchange${n === 1 ? "" : "s"}` : "";
        return {
          title: topic ? `A conversation ran long: ${topic}` : "A conversation ran long",
          what: `${parts.length ? parts.join(" and ") : "Two agents"} were still talking when ${why === "expired" ? "their time box ran out" : "they hit their message limit"}${meter}, so the mesh closed the conversation.`,
          next: "If the topic still needs settling, tell them the answer, or say which one of them has the call.",
          placeholder: "e.g. go with v2; stop debating it",
        };
      }
      if (String(e.reason || "").startsWith("deadlock:")) {
        const desc = typeof d.description === "string" ? d.description.trim() : "";
        return {
          title: "Deadlock detected",
          what: desc ? `${who}: ${desc}. Work is paused to avoid spending the budget.` : `${who} found agents blocking each other (${e.reason}). Work is paused to avoid spending the budget.`,
          next: "Break the cycle: approve or reject the contested artifact, or respond with who should yield.",
          placeholder: "e.g. approve v2; the other side yields",
        };
      }
      return {
        title: e.reason || "Needs a human decision",
        what: `${who} needs you to decide. ${PAUSED_CLAUSE}`,
        next: `Read the context below, then respond with the decision. ${RESUMES}`,
        placeholder: "e.g. decided: …",
      };
  }
}

/** Reason-specific wording, then the advisory correction, then the parked one: no arm has to remember which kind of card it is being asked for. */
export function escalationText(e: EscalationLike, ctx: CardContext): CardText {
  return applyParkedTone(applyAdvisoryTone(textBody(e, ctx), e.advisory === true), ctx.parked);
}

/* ------------------------------- the answer --------------------------------- */

export type CardKind = "stuck" | "derived" | "budget" | "cap" | "ceiling" | "notice" | "decision";

/** Which answer a card takes. A notice is a notice whatever raised it; the rest follow from the reason. */
export function cardKind(e: EscalationLike, budget?: BudgetInfo): CardKind {
  if (e.advisory === true) return "notice";
  if (e.reason === "stalemate:unanswered_request") return "stuck";
  if (e.reason === "stalemate") return "derived";
  if (e.reason === "host_spend_ceiling") return "ceiling";
  if (budget?.configCap) return "cap";
  if (budget?.raisable && budget.key) return "budget";
  return "decision";
}

/** The target an event or time cap is raised to in one click: double what it is now. */
export function capTarget(kind: "events" | "time", budget: BudgetInfo | undefined, status: any): number {
  if (kind === "events") {
    const live = status?.goal?.budget?.maxEvents;
    const current = (typeof live === "number" ? live : undefined) ?? budget?.limit ?? 8000;
    return roundNice(current * 2);
  }
  const live = status?.goal?.budget?.wallClockMinutes;
  return ((typeof live === "number" ? live : undefined) ?? 240) * 2;
}

export type PrimaryId = "send-answer" | "respond" | "acknowledge" | "answer-all" | "raise" | "raise-cap" | "open-settings";

export interface AnswerPlan {
  holds: Holds;
  /** The one action, named by what it does. */
  primary: { id: PrimaryId; label: string };
  /** The label once the notice has a typed reply: an empty one is only an acknowledgement. */
  primaryWithText?: string;
  /** A second action that answers the card itself, when the primary leaves the page (the ceiling is raised in host settings, then the card is cleared here). */
  secondary?: { id: "respond"; label: string };
  /** What is sent when the box is left empty and an empty answer is allowed. */
  emptyText?: string;
  /** Present when a typed answer belongs to the card. */
  text?: { label: string; placeholder: string; required: boolean };
  /** A budget card's alternatives to the one-click raise. */
  raise?: { limit: number; doubleLimit: number; doubleLabel: string };
  /** Only a request an agent is waiting on can be skipped. */
  skip?: { label: string; reasonLabel: string; reasonPlaceholder: string };
  /** What answering does to the mission, true for this kind, for a parked project and for a notice. */
  consequence: string;
  /** How an answer given while parked ends: stuck requests and skips ask whether to start the mission; the rest leave it to the operator. */
  parkedFollowUp: "ask-to-start" | "leave";
}

export interface AnswerInput {
  kind: CardKind;
  parked: boolean;
  holds: Holds;
  budget?: BudgetInfo;
  /** The budget's limit as the ledger holds it now. */
  limit?: number;
  capTarget?: number;
  /** For a derived card: how many requests it answers. */
  supports?: number;
  asker?: string;
  placeholder: string;
  /** The ceiling was raised past the spend: the card no longer asks for it to be raised, only to be cleared. */
  ceilingRaised?: boolean;
}

const PARKED_TAIL = "The project is parked, so nothing runs until you start the mission.";

export function answerPlan(i: AnswerInput): AnswerPlan {
  const base = { holds: i.holds, parkedFollowUp: "leave" as const };
  switch (i.kind) {
    case "stuck": {
      const to = i.asker || "the agent";
      return {
        ...base,
        parkedFollowUp: "ask-to-start",
        primary: { id: "send-answer", label: i.parked ? "Send answer" : "Send answer and resume" },
        text: { label: `Your answer to ${to}`, placeholder: i.placeholder || "Your answer", required: true },
        skip: { label: "Skip this request", reasonLabel: "Why is it not needed?", reasonPlaceholder: "e.g. already covered in the design" },
        consequence: i.parked
          ? `Sends your answer to ${to}. ${PARKED_TAIL} You are asked whether to start it next.`
          : `Sends your answer to ${to} and resumes the mission.`,
      };
    }
    case "derived": {
      const n = i.supports ?? 0;
      const all = n > 1 ? `Answer all ${n}` : n === 1 ? "Answer it" : "Clear this card";
      return {
        ...base,
        primary: { id: "answer-all", label: i.parked ? all : `${all} and resume` },
        text: { label: "Your decision for all of them", placeholder: i.placeholder || "Your decision", required: true },
        consequence: n > 0
          ? `Sends this decision to ${n === 1 ? "the request" : `all ${n} requests`} listed above${i.parked ? `. ${PARKED_TAIL}` : " and resumes the mission."}`
          : i.parked ? `Clears the card. ${PARKED_TAIL}` : "Clears the card and resumes the mission.",
      };
    }
    case "budget": {
      const limit = i.limit ?? i.budget?.limit ?? 0;
      const seat = i.holds.scope === "seat" ? i.holds.seat : null;
      const up = limit > 0 ? roundNice(limit * 1.5) : 0;
      const dbl = limit > 0 ? roundNice(limit * 2) : 0;
      const add = up > 0 ? `Add ${compact(up - limit)} tokens` : "Raise the limit";
      const effect = seat
        ? `Takes effect at once, with no restart. ${seat} takes turns again${i.parked ? "" : ", and the rest of the mesh was never held"}.`
        : "Takes effect at once, with no restart.";
      return {
        ...base,
        primary: { id: "raise", label: i.parked ? add : `${add} and resume` },
        raise: up > 0 ? { limit: up, doubleLimit: dbl, doubleLabel: `Double it (${compact(dbl)})` } : undefined,
        text: { label: "Note for the agents (optional)", placeholder: i.placeholder || "e.g. raised the budget; keep it short", required: false },
        consequence: i.parked ? `${effect} ${PARKED_TAIL}` : seat ? effect : `${effect} Resumes the mission.`,
      };
    }
    case "cap": {
      const events = i.budget?.configCap === "events";
      const target = i.capTarget ?? 0;
      const what = events ? `Raise the event cap to ${compact(target)}` : `Raise the time limit to ${target} minutes`;
      return {
        ...base,
        primary: { id: "raise-cap", label: i.parked ? what : `${what} and resume` },
        consequence: i.parked
          ? `Takes effect at once and is written to mesh.yaml. ${PARKED_TAIL}`
          : "Takes effect at once, is written to mesh.yaml, and resumes the mission.",
      };
    }
    case "ceiling":
      if (i.ceilingRaised) {
        return {
          ...base,
          primary: { id: "respond", label: i.parked ? "Clear this card" : "Clear this card and resume" },
          text: { label: "Note (optional)", placeholder: i.placeholder || "e.g. ceiling raised", required: false },
          emptyText: "ceiling raised",
          consequence: i.parked ? `Clears the card. ${PARKED_TAIL}` : "Clears the card and resumes the mission.",
        };
      }
      return {
        ...base,
        primary: { id: "open-settings", label: "Raise the ceiling" },
        secondary: { id: "respond", label: "Clear this card" },
        text: { label: "Note (optional)", placeholder: i.placeholder || "e.g. raised the ceiling", required: false },
        consequence: "Raising the ceiling takes effect on the next heartbeat, with no restart. Clear this card afterwards, then start the mission: the host leaves the project parked, and an open card holds a finished mission back from delivery.",
      };
    case "notice":
      return {
        ...base,
        primary: { id: "acknowledge", label: "Acknowledge" },
        primaryWithText: "Send reply",
        emptyText: "acknowledged",
        text: { label: "Reply (optional)", placeholder: i.placeholder || "e.g. noted; carry on", required: false },
        consequence: "Nothing is held. The mission carries on whether or not you answer. Acknowledging clears the notice from this list.",
      };
    default:
      return {
        ...base,
        primary: { id: "respond", label: i.parked ? "Respond" : "Respond and resume" },
        text: { label: "Your decision", placeholder: i.placeholder || "e.g. decided: …", required: true },
        consequence: i.parked ? `Records your decision. ${PARKED_TAIL}` : "Records your decision, resumes the mission and wakes the affected agents.",
      };
  }
}

/* ------------------------------ after answering ----------------------------- */

export interface OutcomeInput {
  phase: string;
  /** Decisions that still hold the mission after this one. */
  blockingDecisions: number;
  primaryLabel: string | null;
  /**
   * What the answered card held. A seat's card and a notice never stopped the mission, so "running again" would say something
   * that did not happen. Absent reads as a card that held the mission.
   */
  holds?: Holds;
}

export interface Outcome {
  tone: "ok" | "warn" | "bad" | "neutral";
  text: string;
  /** The mission's one action, when what is left to do is that action. */
  action: boolean;
}

/**
 * What the operator learns the moment they answer: whether the mission moved. Read from the same mission state as the top
 * bar, so the card and the bar chip cannot disagree, and it keeps following that state after the answer: a project that was
 * parked says so until the operator starts it.
 */
export function answerOutcome(i: OutcomeInput): Outcome {
  const plural = (n: number): string => `${n} more decision${n === 1 ? " still holds" : "s still hold"} the mission.`;
  const held = i.holds ?? { scope: "mission" as const };
  // A notice is acknowledged, not answered: it asked for nothing.
  const lead = held.scope === "nothing" ? "Acknowledged." : "Answered.";
  // Only a live mission has anything to say about "again", and only a card that stopped something can have started it again.
  const moving = (idle: boolean): string => {
    if (held.scope === "nothing") return idle ? "The mission is running; no agent is working right now." : "The mission carried on.";
    if (held.scope === "seat") return idle ? `${held.seat} takes turns again; no agent is working right now.` : `${held.seat} takes turns again. The mission never stopped.`;
    return idle ? "The mission is running; no agent is working right now." : "The mission is running again.";
  };
  switch (i.phase) {
    case "running": return { tone: "ok", text: `${lead} ${moving(false)}`, action: false };
    case "quiet": return { tone: "ok", text: `${lead} ${moving(true)}`, action: false };
    case "stalled": return { tone: "warn", text: `${lead} The mission is live, but no agent is working yet.`, action: i.primaryLabel !== null };
    case "needs-you": return { tone: "warn", text: `${lead} ${plural(Math.max(1, i.blockingDecisions))}`, action: false };
    case "parked": return { tone: "warn", text: `${lead} The project is parked, so nothing is running yet.`, action: i.primaryLabel !== null };
    case "paused": return { tone: "warn", text: `${lead} The mission is paused.`, action: i.primaryLabel !== null };
    case "ceiling": return { tone: "bad", text: `${lead} The host's spend ceiling still has this project parked.`, action: i.primaryLabel !== null };
    case "done": return { tone: "ok", text: `${lead} The mission is delivered.`, action: false };
    case "failed": return { tone: "bad", text: `${lead} The mission is marked failed.`, action: i.primaryLabel !== null };
    case "offline": return { tone: "bad", text: `${lead.replace(/\.$/, "")}, but the server stopped answering, so the mission's state is not known.`, action: false };
    default: return { tone: "neutral", text: `${lead} Waiting for the server to report the mission's state.`, action: false };
  }
}

/**
 * The toast after an answer was accepted. It states what the answer did, which depends on the project: a parked one has a
 * stopped scheduler, so the answer is recorded and nothing resumes. The old toasts said "work resumed" in every case, then
 * (for a parked project) asked a question about starting it.
 */
export function answerToast(i: { parked: boolean; holds: Holds; what?: string }): { title: string; msg: string } {
  const what = i.what ?? "Response";
  if (i.holds.scope === "nothing") return { title: `${what} sent`, msg: "Nothing was held, so the mission carried on." };
  if (i.parked) return { title: `${what} recorded`, msg: "The project is parked, so nothing runs until you start the mission." };
  if (i.holds.scope === "seat") return { title: `${what} sent`, msg: `${i.holds.seat} takes turns again. The rest of the mesh was never held.` };
  return { title: `${what} sent`, msg: "The mission resumes." };
}
