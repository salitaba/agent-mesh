/**
 * What the events console decides, as a model: how important an event is, which kind it is, what its one line says, how the
 * filters combine, and how a newest-first list folds into time headings and runs of routine bookkeeping.
 *
 * It lived inside `events.tsx` and `views/Events.tsx`, where nothing could test it. The parts that carry a claim ("Alerts 3"
 * means three alerts within what you are already looking at; a fold never straddles two time headings; a crash is never folded
 * away; a line names who did what) are here, in plain functions. `events.tsx` keeps what needs React.
 */
import { COLLAB_CLOSE_PLAIN, activationDeniedKind, fmt, plainArtifact, plainBlocker, plainEvent, plainGoal, plainLifecycle, plainReason, plural } from "./format";
import { bucketOf } from "./feed";
import { clip, ledgerNames, msgKind, msgSnippet, nameFromUri, shortId } from "./ledger";
import { holdsOf, raisedByLabel } from "./escalation-card";
// Deep import, not the package barrel: `packages/protocol/src/index` star-exports the AJV-backed validators and schemas, and
// none of that belongs in a browser bundle. `catalog.ts` imports only types from `./types`, so this pulls in the const tables and
// the verdict phrasing and nothing else: one source of truth for severity and for what a termination reason means, rather than
// a second table here that would silently drift.
import { EVENT_SEVERITY, MESSAGE_TYPES, verdictText } from "../../../packages/protocol/src/catalog";
import type { EventType, Severity } from "../../../packages/protocol/src/types";

export type { Severity };

/** What this model reads of an event. Structural, so the store's `TimelineEvent` fits without this file importing a .tsx. */
export interface EventLike {
  seq: number;
  id: string;
  type: string;
  timestamp: string;
  actorId?: string;
  correlationId?: string;
  payload?: any;
  /** The server's own one-line summary, when the event came from a server list. Read only for a type this build does not know. */
  summary?: string;
}

/* ---------------------------- kind (the colour class) ---------------------------- */

export function evClass(type: string): string {
  const p = String(type).split(".")[0];
  return (
    {
      goal: "t-goal", agent: "t-agent", message: type === "message.rejected" ? "t-bad" : "t-message",
      artifact: "t-artifact", budget: "t-budget", review: "t-review", task: "t-task", patch: "t-artifact",
      release: "t-artifact", escalation: "t-escalation", lease: "t-lease", requirements: "t-artifact",
      requirement: "t-artifact", architecture: "t-review", design: "t-message", dependency: "t-artifact",
      authentication: "t-artifact", authorization: "t-artifact", research: "t-artifact",
      implementation: "t-review", decision: "t-review", memory: "t-agent", human: "t-message",
      plan: type === "plan.gate_rejected" ? "t-bad" : "t-task",
      // A collaboration is a conversation, so it reads in the same tone as one.
      // `collab.closed` is deliberately not t-bad even when the watchdog is the
      // one closing it: an overrun is worth noticing, and the Overview card is
      // where it gets noticed. A red line for every expiry would cry wolf over
      // a session that merely ran to the end of its box.
      collab: "t-message",
    }[p] || ""
  );
}

/* ---------------------------- severity -------------------------------- */

/** `icon` is what draws the severity when colour is not enough: an alert is a triangle, the rest are a dot and a ring. */
export const SEVERITY_META: Record<Severity, { label: string; hint: string }> = {
  alert: { label: "Alerts", hint: "Went wrong, or needs you." },
  notice: { label: "Activity", hint: "Real progress: messages, files, decisions." },
  routine: { label: "Routine", hint: "Bookkeeping. Folded by default." },
};

export const SEVERITY_ORDER: Severity[] = ["alert", "notice", "routine"];

/** Lifecycle states that mean an agent is stuck or dead rather than working. */
const BAD_LIFECYCLE = new Set(["FAILED", "BLOCKED"]);

/**
 * The type-level floor from `EVENT_SEVERITY`, refined where the payload knows better.
 *
 * Only `agent.state_changed` is refined today, and deliberately so: it is both the highest-volume type in the log and the one
 * whose importance swings most on its payload — a transition into FAILED is the single most useful line in a crashed run, and
 * ranking it `routine` alongside the dozen THINKING/WORKING churns per turn would fold the crash away. Other types are left at
 * their floor rather than guessed at; a refinement is only worth adding for a payload shape that has actually been read.
 *
 * Unknown types fall back to `notice`, not `routine`: a dashboard older than the server it is pointed at should show new events
 * too loudly rather than hide them.
 */
export function evSeverity(e: Pick<EventLike, "type" | "payload">): Severity {
  const base: Severity = EVENT_SEVERITY[e.type as EventType] ?? "notice";
  if (e.type === "agent.state_changed" && BAD_LIFECYCLE.has(String(e.payload?.to))) return "alert";
  return base;
}

/* ------------------------------ kind facets --------------------------------- */

export const EV_GROUP = (t: string): string => String(t).split(".")[0]!;

/** Multi-select: an empty selection means "everything", so there is no "All" pseudo-facet to keep in sync with the real ones. */
export const EV_FILTER_GROUPS: { id: string; label: string; match: string[] }[] = [
  { id: "message", label: "Messages", match: ["message", "thread"] },
  { id: "agent", label: "Agents", match: ["agent", "memory"] },
  { id: "work", label: "Files and tasks", match: ["artifact", "task", "plan", "patch", "review", "release", "architecture", "implementation", "design", "dependency", "requirements", "requirement"] },
  { id: "system", label: "System", match: ["goal", "budget", "escalation", "lease", "human", "decision", "research", "authentication", "authorization", "deadlock", "commitment"] },
];

export const evGroupOf = (t: string): string => {
  const g = EV_GROUP(t);
  for (const f of EV_FILTER_GROUPS) if (f.match.includes(g)) return f.id;
  return "system";
};

/** What a search matches against: the label, the line and who acted, so a row is found by the words it shows. */
export function evSearchText(e: LineEvent, nameOf?: NameOf): string {
  return `${plainEvent(e.type, e.payload)} ${lineText(eventLine(e, nameOf))} ${e.actorId || ""}`;
}

/* -------------------------------- the line ---------------------------------- */

/**
 * One event as one line a person reads: who did what, to what, in the console's own words.
 *
 * Every place that shows an event in one line reads it from here: the Overview's "Just happened", the Events console and its
 * detail pane, the agent drawer and the step drawer. About sixty types used to fall through to their own label, so the line beside
 * "agent created" said "agent created" again, and a turn's spend said "spent 1.8k"; the drawers printed the server's summary, in
 * the kernel's dialect ("developer THINKING → IDLE · turn-3dc…bb5a"). A line names the seat, calls a file by its name and a state
 * by its word, and stands on its own where no label is beside it (the detail pane's thread, a phone's step drawer). It is the
 * label alone only when the payload is too thin to say more.
 *
 * `lead` opens the line and is set apart (the seat, file or budget it is about); `rest` follows it directly.
 */
export interface EventLine {
  lead?: string;
  rest: string;
}

/** What a line reads of an event. A server row (`actor`, `at`) is mapped onto this by its caller. */
export interface LineEvent {
  type: string;
  actorId?: string;
  payload?: any;
  summary?: string;
}

/** A file, task, message, lease, decision or conversation by its id, as a person calls it. */
export type NameOf = (id: string) => string | undefined;

/** Long enough for who, what and a little of what was said; short enough to stay one row of the narrowest list. */
export const LINE_MAX = 90;

export const lineText = (l: EventLine): string => `${l.lead ?? ""}${l.rest}`;

const HUMAN = "human";
/** Components that write to the log are not people: a line never says "by system". */
const MACHINES = new Set(["system", "termination-manager", "deadlock-detector", "recovery-manager", "host-limiter", "scheduler"]);
const NO_NAMES: NameOf = () => undefined;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : typeof v === "string" && v ? [v] : []);
/** The human seat is the person reading. */
const who = (id: string): string => (id === HUMAN ? "you" : id === "all" ? "everyone" : id);
const people = (list: readonly string[]): string => list.map(who).join(", ");
/** A code said as words: `in_thread` → "in thread", `IN_PROGRESS` → "in progress". For the codes no table names. */
export const plainCode = (s: unknown): string => str(s).replace(/[_:]+/g, " ").trim().toLowerCase();
const lcFirst = (s: string): string => (s ? s[0]!.toLowerCase() + s.slice(1) : s);
const line = (lead: string | undefined, rest: string): EventLine => (lead ? { lead, rest } : { rest });
/** Someone's thing, as the line's lead: "pm" + "'s budget", or "your" + " budget". */
const owned = (id: string, rest: string): EventLine => (id === HUMAN ? { lead: "your", rest: ` ${rest}` } : { lead: id, rest: `'s ${rest}` });
const byWhom = (actor: string): string => (actor && !MACHINES.has(actor) ? `, by ${who(actor)}` : "");

function fileName(id: unknown, ref: unknown, nameOf: NameOf): string {
  const uri = typeof ref === "string" ? ref : str((ref as { uri?: unknown } | null)?.uri);
  const named = uri ? nameFromUri(uri) : null;
  if (named) return named;
  const s = str(id);
  return s ? nameOf(s) ?? shortId(s) : "";
}

function amount(n: unknown, kind: unknown): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return "";
  if (kind === "wallclock_minutes") return `${Math.round(v)} min`;
  if (kind === "events") return plural(v, "event");
  if (kind === "activations") return plural(v, "turn");
  return `${fmt(v)} ${v === 1 ? "token" : "tokens"}`;
}

/**
 * A budget ledger key said as the budget it is. `self` is the seat the sentence is about, whose own budget is "its own": "qa spent
 * 1.8k tokens of its own budget" and "qa spent 1.8k tokens of the mission budget" are the same turn charged to two ledgers, and a
 * line that said only "spent 1.8k" twice read as twice the spend.
 */
function budgetName(key: unknown, self: string, nameOf: NameOf): string {
  const k = str(key);
  const colon = k.indexOf(":");
  const kind = colon > 0 ? k.slice(0, colon) : "";
  const owner = k.slice(colon + 1).split("/").slice(1).join("/");
  if (kind === "mission") return "the mission budget";
  if (kind === "agent" && owner) return owner === self ? "its own budget" : `${owner === HUMAN ? "your" : `${owner}'s`} budget`;
  if (kind === "attention" && owner) return `${owner === self ? "its" : owner === HUMAN ? "your" : `${owner}'s`} budget for waking others`;
  if (kind === "thread" || kind === "task") {
    const named = owner ? nameOf(owner) : undefined;
    return named ? `the budget of “${clip(named, 32)}”` : kind === "thread" ? "a conversation's budget" : "a task's budget";
  }
  return "a budget";
}

/** What a verdict was about: a file by its name, a check by its id, else the domain the gate reads ("release"). */
export function verdictSubject(p: { subject?: unknown; artifactId?: unknown; artifactRef?: unknown }, nameOf: NameOf = NO_NAMES): string {
  const s = str(p.subject);
  if (s.startsWith("criterion:")) return `check ${s.slice("criterion:".length)}`;
  const file = fileName(s.startsWith("artifact:") ? s.slice("artifact:".length) : p.artifactId, p.artifactRef, nameOf);
  return file || plainCode(s);
}

const VERDICT_DONE: Record<string, string> = {
  approve: "approved", reject: "rejected", pass: "passed", block: "blocked", veto: "vetoed", accept: "accepted", merge: "merged",
};
/** A verdict's kind (`ApprovalKind`) as what the seat did: `pass` → "passed". */
export const verdictDone = (kind: unknown): string => VERDICT_DONE[str(kind)] ?? (plainCode(kind) || "ruled on");

/** How an outstanding ask stopped being outstanding (`DischargeReason` in core's state.ts). */
function settled(reason: string, by: string): string {
  const named = by ? ` by ${who(by)}` : "";
  switch (reason) {
    case "reply": case "in_thread": case "task": return `was answered${named}`;
    case "artifact_review": return `was settled by ${by ? `${by === HUMAN ? "your" : `${by}'s`} review` : "a review"}`;
    case "task_completed": return "was settled: its task is done";
    case "superseded": return "was settled by a newer version";
    case "operator": return "was settled by you";
    case "deadlock_break": return "was voided to break a deadlock";
    case "refused": return `was declined${named}`;
    case "refused_cap": return "was never opened: too many asks were open";
    case "evicted_cap": return "was dropped: too many asks were open";
    default: return reason ? `was closed (${plainCode(reason)})` : "was closed";
  }
}

/** A lifecycle as the end of "<seat> is now …". */
const NOW_WORD: Record<string, string> = { AWAKENED: "awake", OBSERVING: "reading its inbox" };

/** A free-text reason that is really a code (`stalemate:unanswered_request`) is phrased; anything else is the seat's own words. */
const isCode = (s: string): boolean => /^[a-z][a-z0-9_]*(?::[a-z0-9_]+)*$/.test(s);

/** What an escalation is about, as its card titles it: a termination code is phrased (`verdictText`), a seat's words are kept. */
export function escalationWhat(reason: unknown): string {
  const r = str(reason);
  return isCode(r) ? verdictText(r).title : clip(r, 60);
}

/** A message type inside a kernel sentence, said the way the console says it: "a APPROVE message" → "an approve message". */
function deshout(text: string): string {
  return text.replace(/\b(?:(a|an) )?([A-Z][A-Z_]{2,})\b/g, (all: string, article: string | undefined, t: string) => {
    if (!(MESSAGE_TYPES as readonly string[]).includes(t)) return all;
    const word = msgKind(t);
    return article ? `${/^[aeiou]/.test(word) ? "an" : "a"} ${word}` : word;
  });
}

function describe(type: string, p: Record<string, any>, actorId: string, nameOf: NameOf): EventLine | null {
  const seat = str(p.agentId);
  const file = (id: unknown, ref?: unknown): string => fileName(id, ref, nameOf);
  switch (type) {
    /* ---- the mission ---- */
    case "goal.created": {
      const d = str(str(p.goal?.description).split("\n")[0]);
      if (!d) return null;
      const n = Array.isArray(p.goal?.acceptanceCriteria) ? p.goal.acceptanceCriteria.filter((c: any) => c?.mandatory).length : 0;
      return line(undefined, `mission: ${clip(d, 64)}${n ? ` · ${plural(n, "check")}` : ""}`);
    }
    case "goal.budget_changed": {
      const b = p.budget ?? {};
      const raised = [
        typeof b.wallClockMinutes === "number" ? `the time limit to ${b.wallClockMinutes} min` : "",
        typeof b.maxEvents === "number" ? `the event cap to ${b.maxEvents.toLocaleString("en-US")}` : "",
        typeof b.tokens === "number" ? `the token budget to ${fmt(b.tokens)}` : "",
      ].filter(Boolean).join(" and ");
      if (!raised) return null;
      return actorId ? line(who(actorId), ` raised ${raised}`) : line(undefined, `raised ${raised}`);
    }
    case "goal.status_changed": {
      const st = str(p.status);
      if (!st) return null;
      const why = str(p.reason);
      return line(undefined, `the mission is now ${plainGoal(st)}${why ? ` (${clip(why, 50)})` : ""}`);
    }
    case "goal.paused":
    case "goal.resumed": {
      const verb = type === "goal.paused" ? "paused" : "resumed";
      const why = str(p.reason);
      // "user pause" is the operator's own button. The mesh files its own holds under the human seat too (criteria waiting for
      // review), so any other reason is the mesh's, said as its reason, never as something the person did.
      if (actorId === HUMAN && (!why || why === `user ${verb === "paused" ? "pause" : "resume"}`)) return line("you", ` ${verb} the mission`);
      return line(undefined, `the mission ${verb}${why ? `: ${clip(why, 64)}` : ""}`);
    }
    case "goal.progress": {
      const done = Number(p.completed);
      const total = Number(p.total);
      if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return null;
      return line(undefined, `${done} of ${plural(total, "check")} done`);
    }
    case "goal.completed": {
      const r = str(p.reason);
      if (!r) return null;
      return line(undefined, r === "all_mandatory_criteria_evidenced" ? "mission complete: every mandatory check is evidenced" : `mission complete: ${lcFirst(verdictText(r).title)}`);
    }
    case "goal.reopened": {
      const why = str(p.reason);
      const tail = why ? `: ${clip(why, 60)}` : "";
      return actorId ? line(who(actorId), ` reopened the mission${tail}`) : line(undefined, `the mission was reopened${tail}`);
    }
    case "goal.escalated":
    case "goal.failed": {
      const r = str(p.reason);
      if (!r) return null;
      return line(undefined, `${type === "goal.failed" ? "the mission failed" : "the mission needs you"}: ${lcFirst(verdictText(r).title)}`);
    }
    case "goal.description_revised": {
      const d = str(p.description);
      if (!d) return null;
      return actorId ? line(who(actorId), ` rewrote the mission: “${clip(d, 56)}”`) : line(undefined, `the mission now reads “${clip(d, 60)}”`);
    }

    /* ---- its checks ---- */
    case "requirements.created": {
      const n = Array.isArray(p.criteria) ? p.criteria.length : 0;
      if (!n) return null;
      const from = file(p.artifactId);
      const what = `${plural(n, "check")}${from ? ` from ${from}` : ""}`;
      return actorId ? line(who(actorId), ` added ${what}`) : line(undefined, `${what} added`);
    }
    case "requirement.blocked":
    case "requirement.removed": {
      const id = str(p.criterionId);
      if (!id) return null;
      const why = str(p.reason);
      return line(undefined, `check ${id} ${type === "requirement.blocked" ? "is blocked" : "was removed"}${why ? `: ${clip(why, 60)}` : ""}`);
    }
    case "requirement.satisfied": {
      const id = str(p.criterionId);
      if (!id) return null;
      const ev = p.evidence ?? {};
      const from = str(ev.by);
      if (p.verified === false || ev.verified === false) return line(undefined, `check ${id} claimed${from ? ` by ${who(from)}` : ""}, not verified`);
      return line(undefined, `check ${id} met${from ? `, on evidence from ${who(from)}` : str(ev.kind) ? ` (${plainCode(ev.kind)})` : ""}`);
    }
    case "requirement.revised": {
      const id = str(p.criterionId);
      if (!id) return null;
      const changes = [
        p.description !== undefined ? `now reads “${clip(str(p.description), 40)}”` : "",
        p.mandatory !== undefined ? (p.mandatory ? "is now mandatory" : "is now optional") : "",
      ].filter(Boolean).join(" and ");
      return line(undefined, `check ${id} ${changes || "was revised"}`);
    }

    /* ---- the seats ---- */
    case "agent.created": {
      const id = str(p.agent?.id);
      if (!id) return null;
      if (id === HUMAN) return line("you", " joined the team as its operator");
      const role = str(p.agent?.role);
      return line(id, role && role !== id ? ` joined the team as ${role}` : " joined the team");
    }
    case "agent.started": {
      const id = seat || actorId;
      if (!id) return null;
      const runtime = str(p.runtime);
      return owned(id, `session started${runtime ? ` on the ${runtime} runtime` : ""}`);
    }
    case "agent.awakened": {
      const id = seat || actorId;
      if (!id) return null;
      const r = p.reason ?? {};
      const kind = str(r.kind);
      if (!kind) return line(id, " woke up");
      const note = str(r.note);
      // An interest wake says which event it was; a timer says what it is for. The others' notes are the scheduler's own
      // bookkeeping ("1 message waiting in your mailbox.") or a paragraph meant for the seat, and stay in the detail.
      // The event an interest wake names is quoted: "woke up after “implemented”" cannot be misread as the seat implementing.
      if (kind === "interest_event" && str(r.eventType)) return line(id, ` woke up after “${plainEvent(r.eventType)}”`);
      const why = kind === "startup" ? "the mission started"
        : kind === "message" ? "a new message"
        : kind === "timer" && note ? `follow-up nudge: ${clip(note, 56)}`
        : plainReason(kind);
      return line(id, ` woke up — ${why}`);
    }
    case "agent.state_changed": {
      const id = seat || actorId;
      const to = str(p.to).toUpperCase();
      if (!id || !to) return null;
      return line(id, to === "FAILED" ? " crashed" : ` is now ${NOW_WORD[to] ?? plainLifecycle(to)}`);
    }
    case "agent.suspended": {
      if (!seat) return null;
      const mid = str(p.turnId) ? " mid-turn" : "";
      return actorId ? line(who(actorId), ` paused ${seat}${mid}`) : line(seat, ` was paused${mid}`);
    }
    case "agent.resumed":
      return seat ? line(seat, " can run again") : null;
    case "agent.completed":
      // The completion sweep retires every seat with the mission; a worker that hands its result back finishes on its own.
      return seat ? line(seat, actorId === "termination-manager" ? " is done with the mission" : " finished its work") : null;
    case "agent.failed": {
      if (!seat) return null;
      const err = str(p.error);
      return line(seat, ` crashed${err ? `: ${clip(err, 64)}` : ""}`);
    }
    case "agent.restarted": {
      if (!seat) return null;
      if (p.restored === true) return line(seat, " picked up its saved session");
      const n = Number(p.attempt);
      return line(seat, ` restarted${Number.isFinite(n) && n > 0 ? ` (attempt ${n})` : ""}`);
    }
    case "agent.replaced":
      return seat ? line(seat, " has new settings") : null;
    case "agent.retired": {
      if (!seat) return null;
      const why = str(p.reason);
      return line(seat, ` retired${why ? `: ${clip(why, 64)}` : ""}`);
    }
    case "agent.mute_suspected":
      // The bridge is the diagnosis: a seat that never got it cannot speak; one that got it and said nothing chose not to.
      return seat ? line(seat, p.meshBridgeAttached === true ? " has the mesh tools but said nothing" : " never got the mesh tools: its bridge did not attach") : null;
    case "session.rotation_pending": {
      const id = seat || actorId;
      const held = Number(p.transcriptTokens);
      const limit = Number(p.thresholdTokens);
      if (!id || !Number.isFinite(held)) return null;
      return line(id, ` holds ${fmt(held)} tokens of context${Number.isFinite(limit) && limit > 0 ? `; its limit is ${fmt(limit)}` : ""}`);
    }
    case "session.rotated": {
      const id = seat || actorId;
      if (!id) return null;
      const n = Number(p.sessionOrdinal);
      const dropped = Number(p.transcriptTokensDiscarded);
      return line(id, ` started ${Number.isFinite(n) && n > 0 ? `session ${n}` : "a fresh session"}${Number.isFinite(dropped) && dropped > 0 ? `, dropping ${fmt(dropped)} tokens of context` : ""}`);
    }
    case "continuity.recorded": {
      const id = seat || actorId;
      if (!id) return null;
      const next = str(p.nextIntent);
      const open = Array.isArray(p.openCommitments) ? p.openCommitments.length : 0;
      return line(id, ` wrote a handover${next ? `: next, ${clip(next, 44)}` : ""}${open ? ` · ${plural(open, "open ask")}` : ""}`);
    }
    case "context.assembled": {
      const id = seat || actorId;
      const used = Number(p.usedTokens);
      if (!id || !Number.isFinite(used)) return null;
      const budget = Number(p.budgetTokens);
      const slots: any[] = Array.isArray(p.slots) ? p.slots : [];
      const left = slots.reduce((n: number, s: any) => n + (Number(s?.dropped) > 0 ? Number(s.dropped) : 0), 0);
      return owned(id, `prompt took ${fmt(used)}${Number.isFinite(budget) && budget > 0 ? ` of ${fmt(budget)}` : ""} tokens${p.overSoftCap === true ? ", over its soft cap" : ""}${left ? `; ${plural(left, "item")} left out` : ""}`);
    }
    case "turn.discarded": {
      const id = seat || actorId;
      if (!id) return null;
      const reason = str(p.reason);
      const why = reason === "all_rejected" ? "every action was refused" : reason === "budget_blocked" ? "no budget left for it" : reason === "paused" ? "the mission was paused" : plainCode(reason);
      // An absent figure is not zero: a turn killed mid-generation spent tokens nobody counted.
      const cost = typeof p.tokens === "number" ? `${p.partial === true ? "at least " : ""}${fmt(p.tokens)} tokens lost` : "cost not measured";
      return owned(id, `turn was thrown away${why ? `: ${why}` : ""} · ${cost}`);
    }

    /* ---- talk ---- */
    case "thread.created": {
      const t = p.thread ?? {};
      // The delegation thread is titled "task <task id>: <title>"; the title is the name.
      const subject = str(t.subject).replace(/^task task-[A-Za-z0-9]+: /, "task: ");
      if (!subject) return null;
      // Opened with the goal, on the human seat's behalf: nobody opened it by hand.
      if (subject === "mission-root") return line(undefined, "the mission's main thread is open");
      const from = str(t.initiator) || actorId;
      const others = ids(t.participants).filter((x) => x !== from);
      const rest = ` “${clip(subject, 48)}”${others.length ? ` with ${people(others)}` : ""}`;
      return from ? line(who(from), ` opened${rest}`) : line(undefined, `conversation${rest}`);
    }
    case "message.sent": {
      const m = p.message ?? {};
      const from = str(m.from);
      if (!from) return null;
      const to = ids(m.to);
      const kind = str(m.type) ? msgKind(str(m.type)) : "";
      const said = msgSnippet(m.payload, 60);
      return line(who(from), ` wrote to ${to.length ? people(to) : "everyone"}${kind ? ` (${kind})` : ""}${said ? `: ${said}` : ""}`);
    }
    case "message.delivered": {
      if (!seat) return null;
      const id = str(p.messageId);
      return line(seat, ` received ${(id && nameOf(id)) || "a message"}`);
    }
    case "message.rejected": {
      const from = str(p.from) || actorId;
      const why = clip(deshout(plainBlocker(str(p.reason))), 56);
      const tail = why ? `: ${why}` : "";
      if (activationDeniedKind(p) !== undefined) return from ? line(who(from), ` could not be woken${tail}`) : null;
      const what = str(p.action) || "message";
      return from ? owned(from, `${what} was refused${tail}`) : line(undefined, `a ${what} was refused${tail}`);
    }
    case "commitment.discharged": {
      const from = str(p.from);
      const how = settled(str(p.reason), str(p.by));
      const kind = str(p.requestType) ? msgKind(str(p.requestType)) : "ask";
      const left = p.partial === true && Array.isArray(p.remaining) && p.remaining.length ? ` · ${plural(p.remaining.length, "answer")} still owed` : "";
      return from ? owned(from, `${kind} ${how}${left}`) : line(undefined, `an ask ${how}${left}`);
    }
    case "collab.opened": {
      const s = p.session ?? {};
      const opener = str(s.openedBy) || actorId;
      if (!opener) return null;
      // The opener is in its own participant list: naming it on both sides would read as a seat talking to itself.
      const others = ids(s.participants).filter((x) => x !== opener);
      const topic = str(s.topic);
      return line(who(opener), `${others.length ? ` started talking to ${people(others)}` : " opened a conversation"}${topic ? ` — ${clip(topic, 50)}` : ""}`);
    }
    case "collab.closed": {
      const n = Number(p.exchanges);
      const cap = Number(p.maxExchanges);
      const count = Number.isFinite(n) && n >= 0 ? ` after ${cap > 0 ? `${n} of ${plural(cap, "exchange")}` : plural(n, "exchange")}` : "";
      const outcome = str(p.outcome);
      return line(undefined, `the conversation ${COLLAB_CLOSE_PLAIN[str(p.reason)] ?? "ended"}${count}${outcome ? ` — ${clip(outcome, 50)}` : ""}`);
    }

    /* ---- files and work ---- */
    case "artifact.created":
    case "artifact.versioned": {
      const a = p.artifact ?? {};
      const name = str(a.name);
      if (!name) return null;
      const author = str(a.createdBy) || actorId;
      const v = Number(a.version);
      const what = type === "artifact.created" ? `${name}${str(a.type) ? ` (${str(a.type)})` : ""}` : `${Number.isFinite(v) ? `v${v}` : "a new version"} of ${name}`;
      return author ? line(who(author), ` published ${what}`) : line(undefined, `${what} was published`);
    }
    case "artifact.transition":
    case "release.transition": {
      const name = file(p.artifactId);
      const to = str(p.to);
      if (!name || !to) return null;
      // A derived move is the mesh mirroring one the reducer already made, so it has no mover worth naming.
      return line(name, `: ${plainArtifact(to)}${p.derived === true ? "" : byWhom(str(p.actorId) || actorId)}`);
    }
    case "task.created": {
      const t = p.task ?? {};
      const title = str(t.title);
      if (!title) return null;
      const author = str(t.createdBy) || actorId;
      return author ? line(who(author), ` created the task “${clip(title, 56)}”`) : line(undefined, `new task: “${clip(title, 60)}”`);
    }
    case "task.claimed": {
      const id = seat || actorId;
      if (!id) return null;
      const title = str(p.taskId) ? nameOf(str(p.taskId)) : undefined;
      return line(id, title ? ` took the task “${clip(title, 56)}”` : " took a task");
    }
    case "task.completed": {
      const id = seat || actorId;
      if (!id) return null;
      const title = str(p.taskId) ? nameOf(str(p.taskId)) : undefined;
      const said = str(p.summary);
      return line(who(id), ` finished ${title ? `“${clip(title, 36)}”` : "a task"}${said ? `: ${clip(said, 48)}` : ""}`);
    }
    case "plan.updated": {
      const id = seat || actorId;
      if (!id) return null;
      const steps: any[] = Array.isArray(p.plan?.steps) ? p.plan.steps : [];
      // An empty step list is how a seat withdraws its plan, not an empty plan.
      if (!steps.length) return line(id, " withdrew its plan");
      const done = steps.filter((s) => s?.status === "DONE").length;
      return line(id, ` planned ${plural(steps.length, "step")}${done ? ` (${done} done)` : ""}`);
    }
    case "plan.gate_rejected": {
      const id = seat || actorId;
      if (!id) return null;
      const why = str(p.reason);
      return line(id, `: the plan gate ${p.mode === "enforce" ? "blocked" : "flagged"} ${plainCode(p.op) || "an action"}${why ? ` — ${clip(why, 50)}` : ""}`);
    }
    case "review.requested": {
      const name = file(p.artifactId, p.artifactRef);
      if (!name) return null;
      const reviewers = ids(p.reviewers);
      const q = str(p.subject?.question) || (typeof p.subject === "string" ? str(p.subject) : "");
      const ask = `${reviewers.length ? ` asked ${people(reviewers)} to review ${name}` : ` asked for a review of ${name}`}${q ? `: “${clip(q, 36)}”` : ""}`;
      return actorId ? line(who(actorId), ask) : line(undefined, `review of ${name} requested`);
    }
    case "review.approved":
    case "review.rejected": {
      const subject = verdictSubject(p, nameOf);
      const reviewer = str(p.actorId) || actorId;
      if (!subject || !reviewer) return null;
      const verb = type === "review.rejected" ? "asked for changes to" : p.kind === "pass" ? "passed" : p.kind === "accept" ? "accepted" : "approved";
      const note = str(p.comment);
      return line(who(reviewer), ` ${verb} ${subject}${note ? ` — ${clip(note, 44)}` : ""}`);
    }
    case "architecture.approved": {
      const approver = str(p.actorId) || actorId;
      if (!approver) return null;
      const name = file(p.artifactId, p.artifactRef);
      return line(who(approver), ` approved the architecture${name ? ` in ${name}` : ""}`);
    }
    case "implementation.completed": {
      const name = file(p.artifactId);
      if (!name) return null;
      const dev = str(p.actorId) || actorId;
      return dev ? line(who(dev), ` implemented ${name}`) : line(name, " is implemented");
    }
    case "patch.created":
    case "patch.ready":
    case "patch.merged": {
      const name = str(p.name) || file(p.artifactId, p.artifactRef);
      if (!name) return null;
      const verb = type === "patch.created" ? "created" : type === "patch.ready" ? "marked ready" : "merged";
      if (!actorId) return line(name, ` was ${verb}`);
      return line(who(actorId), type === "patch.ready" ? ` marked ${name} ready` : ` ${verb} ${name}`);
    }
    case "design.question":
    case "research.requested": {
      const q = str(p.question);
      if (!q) return null;
      const ask = type === "design.question" ? "asked" : "asked for research";
      return actorId ? line(who(actorId), ` ${ask}: “${clip(q, 56)}”`) : line(undefined, `“${clip(q, 70)}”`);
    }
    case "research.completed": {
      const name = str(p.name) || file(p.artifactId);
      if (!name) return null;
      const cached = p.cached === true ? " (an earlier answer)" : "";
      return actorId ? line(who(actorId), ` delivered ${name}${cached}`) : line(name, ` was delivered${cached}`);
    }
    case "dependency.changed":
    case "authentication.changed":
    case "authorization.changed": {
      const name = file(p.artifactId);
      if (!name) return null;
      const what = type === "dependency.changed" ? "dependencies" : type === "authentication.changed" ? "authentication" : "access rules";
      const commit = type === "dependency.changed" ? str(p.commit).slice(0, 7) : "";
      return owned(name, `${what} changed${commit ? ` (${commit})` : ""}`);
    }
    case "release.candidate": {
      const name = str(p.name) || file(p.artifactId);
      if (!name) return null;
      return actorId ? line(who(actorId), ` proposed ${name} for release`) : line(name, " is the release candidate");
    }
    case "release.accepted": {
      const name = file(p.artifactId);
      return name ? line(name, ` was accepted${byWhom(actorId)}`) : null;
    }
    case "decision.proposed": {
      const topic = str(p.decision?.topic);
      if (!topic) return null;
      return actorId ? line(who(actorId), ` proposed a decision: “${clip(topic, 50)}”`) : line(undefined, `decision proposed: “${clip(topic, 60)}”`);
    }
    case "decision.ratified": {
      const id = str(p.decisionId);
      const topic = id ? nameOf(id) : undefined;
      const ratifier = ids(p.approvedBy)[0] || actorId;
      const what = topic ? `“${clip(topic, 50)}”` : "a decision";
      return ratifier ? line(who(ratifier), ` ratified ${what}`) : line(undefined, `${what} was ratified`);
    }

    /* ---- the person ---- */
    case "escalation.requested": {
      const esc = p.escalation ?? {};
      const reason = str(esc.reason);
      if (!reason) return null;
      const what = escalationWhat(reason);
      const raiser = raisedByLabel(esc.raisedBy ?? actorId) || undefined;
      const rest = holdsOf(esc).scope === "nothing" ? ` sent you a notice: ${what}` : ` needs you: ${what}`;
      return raiser ? line(raiser, rest) : line(undefined, rest.trimStart());
    }
    case "escalation.responded": {
      const answer = str(p.response);
      if (!answer) return null;
      const from = str(p.respondedBy) || actorId;
      return line(from ? who(from) : undefined, `${from ? " " : ""}answered: “${clip(answer, 60)}”`);
    }
    case "escalation.auto_resolved": {
      const why = str(p.reason).replace(/^auto-resolved:\s*/, "");
      return line(undefined, `a decision settled itself${why ? `: ${clip(why, 60)}` : ""}`);
    }
    case "deadlock.auto_resolved": {
      const asker = str(p.voidedBy);
      const to = ids(p.voidedTo);
      const parts = ids(p.participants);
      if (asker) return owned(asker, `ask${to.length ? ` to ${people(to)}` : ""} was voided to break a deadlock`);
      return line(undefined, `a deadlock was broken${parts.length ? ` between ${people(parts)}` : ""}`);
    }
    case "human.input": {
      const action = str(p.action);
      const did = action === "escalation_response" ? "answered a decision"
        : action === "stuck_request_answered" ? "answered a stuck request"
        : action === "stuck_request_dropped" ? "dropped a stuck request"
        : "";
      return did ? line("you", ` ${did}`) : action ? line(undefined, `your input: ${plainCode(action)}`) : null;
    }

    /* ---- locks and memory ---- */
    case "lease.acquired": {
      const l = p.lease ?? {};
      const holder = str(l.agentId) || actorId;
      const files = ids(l.files);
      const what = files.length > 2 ? `${files.slice(0, 2).join(", ")} and ${files.length - 2} more` : files.join(", ") || file(l.artifactId);
      return holder && what ? line(holder, ` locked ${clip(what, 60)} for editing`) : null;
    }
    case "lease.released": {
      const what = str(p.leaseId) ? nameOf(str(p.leaseId)) : undefined;
      return actorId ? line(who(actorId), ` unlocked ${what ? clip(what, 60) : "a file"}`) : null;
    }
    case "memory.updated": {
      const id = seat || actorId;
      const key = str(p.note?.key);
      if (!id || !key) return null;
      // After every turn the mesh files what the turn did under `turn:<id>`; the key is an id, the value is the news. The kernel's
      // warnings appended to it (" — ⚠ …") are the step's to show, where there is room for them.
      if (key.startsWith("turn:")) {
        const value = str(p.note?.value).replace(/^landed this turn:\s*/, "").replace(/^⚠\s*/, "").split(/ — (?:⚠|model said:)/)[0]!.trim();
        return line(id, ` noted what its turn did${value ? `: ${clip(value, 56)}` : ""}`);
      }
      return line(id, ` saved a note: ${clip(key, 60)}`);
    }

    /* ---- budgets ---- */
    case "budget.reserved":
    case "budget.consumed":
    case "budget.released": {
      const spender = (type === "budget.consumed" ? seat : "") || actorId || seat;
      const name = budgetName(p.key, spender, nameOf);
      if (type === "budget.released") return spender ? line(spender, ` released its hold on ${name}`) : line(undefined, `a hold on ${name} was released`);
      const much = amount(p.amount, p.limitKind);
      if (!much) return null;
      if (type === "budget.reserved") return spender ? line(spender, ` put ${much} of ${name} on hold`) : line(undefined, `${much} of ${name} put on hold`);
      return spender ? line(spender, ` spent ${much} of ${name}`) : line(undefined, `${much} of ${name} spent`);
    }
    case "budget.exceeded": {
      const name = budgetName(p.key, "", nameOf);
      const used = Number(p.consumed);
      const limit = Number(p.limit);
      const figures = Number.isFinite(used) && Number.isFinite(limit) ? `: ${fmt(used)} of ${fmt(limit)}` : "";
      return line(undefined, `${name} ${p.short === true ? "has too little left for the next turn" : "is spent"}${figures}`);
    }
    case "budget.limit_raised": {
      const limit = Number(p.limit);
      if (!Number.isFinite(limit)) return null;
      const previous = Number(p.previous);
      const was = p.previous !== null && p.previous !== undefined && Number.isFinite(previous) ? ` (was ${fmt(previous)})` : "";
      const how = p.decidedBy === "auto" ? ", automatically" : p.decidedBy === "operator" ? ", by you" : "";
      return line(undefined, `${budgetName(p.key, "", nameOf)} raised to ${amount(limit, p.limitKind)}${was}${how}`);
    }
    default:
      return null;
  }
}

const KNOWN = new Set<string>(Object.keys(EVENT_SEVERITY));

/** The longest line is cut with an ellipsis that admits it, never mid-way through the lead. */
function fit(l: EventLine): EventLine {
  const room = LINE_MAX - (l.lead?.length ?? 0);
  const rest = l.rest.replace(/\s+/g, " ");
  return { ...l, rest: rest.length > room ? `${rest.slice(0, Math.max(0, room - 1)).trimEnd()}…` : rest };
}

/**
 * The line for an event. `nameOf` turns the ids a payload carries into names (see `eventNames`); without it, or for an id it
 * does not know, a file is called by a short id, as the step ledger does. A type this build does not know shows the summary its
 * payload or the server gave it, and a payload too thin to say more shows the event's label: never "undefined".
 */
export function eventLine(e: LineEvent, nameOf: NameOf = NO_NAMES): EventLine {
  const p = e.payload && typeof e.payload === "object" ? (e.payload as Record<string, any>) : {};
  let described: EventLine | null = null;
  try {
    described = KNOWN.has(e.type) ? describe(e.type, p, str(e.actorId), nameOf) : null;
  } catch {
    // A payload of a shape nobody has seen degrades to the label rather than taking the list down with it.
    described = null;
  }
  if (!described && !KNOWN.has(e.type)) {
    const said = str(p.summary) || str(e.summary);
    if (said) described = line(undefined, said);
  }
  return fit(described ?? line(undefined, plainEvent(e.type, e.payload)));
}

/**
 * What the ids in a list of events are called, read from the events themselves: files and tasks (as the step ledger reads them),
 * and the messages, conversations, locks and decisions a later event names by id alone.
 */
export function eventNames(events: readonly LineEvent[]): Map<string, string> {
  const names = ledgerNames(events);
  for (const e of events) {
    const p = (e.payload ?? {}) as Record<string, any>;
    if (e.type === "message.sent") {
      const m = p.message ?? {};
      const id = str(m.id);
      const from = str(m.from);
      if (id && from) names.set(id, `${from === HUMAN ? "your" : `${from}'s`} message${str(m.type) ? ` (${msgKind(str(m.type))})` : ""}`);
    } else if (e.type === "thread.created") {
      if (str(p.thread?.id) && str(p.thread?.subject)) names.set(str(p.thread.id), str(p.thread.subject));
    } else if (e.type === "lease.acquired") {
      const l = p.lease ?? {};
      const files = ids(l.files);
      const what = files.length ? files.join(", ") : str(l.artifactId) ? names.get(str(l.artifactId)) : undefined;
      if (str(l.id) && what) names.set(str(l.id), what);
    } else if (e.type === "decision.proposed") {
      if (str(p.decision?.id) && str(p.decision?.topic)) names.set(str(p.decision.id), str(p.decision.topic));
    }
  }
  return names;
}

/* ------------------------------ facet string -------------------------------- */

/* One comma-joined, namespaced string holds every facet -- `sev:alert,grp:message,actor:pm`. It lives in the store's `evFilter`,
   which already survives view switches. Keeping it one string means no new store state for four independent filters, and the
   whole filter set is one value to reset. */

export const parseFacets = (s: string): Set<string> => new Set(s.split(",").filter(Boolean));

export const facetValues = (f: ReadonlySet<string>, ns: string): string[] =>
  [...f].filter((x) => x.startsWith(`${ns}:`)).map((x) => x.slice(ns.length + 1));

export const facetOne = (f: ReadonlySet<string>, ns: string): string | null => facetValues(f, ns)[0] ?? null;

/** Adds the token if it is absent, removes it if present. */
export function toggleFacet(s: string, token: string): string {
  const next = parseFacets(s);
  if (next.has(token)) next.delete(token);
  else next.add(token);
  return [...next].join(",");
}

/** A single-valued facet replaces rather than accumulates; null clears it. */
export function setFacet(s: string, ns: string, value: string | null): string {
  const next = [...parseFacets(s)].filter((x) => !x.startsWith(`${ns}:`));
  if (value) next.push(`${ns}:${value}`);
  return next.join(",");
}

/* -------------------------------- filtering --------------------------------- */

export interface EventFilter {
  /** Lower-cased, trimmed. */
  search: string;
  /** Group ids; empty means every group. */
  groups: ReadonlySet<string>;
  actor: string | null;
  /** A correlation id: follow one thread. */
  thread: string | null;
}

/** The haystack for one event. Built once per buffer change, not once per keystroke: it stringifies a payload. */
export function eventHaystack(e: EventLike, nameOf?: NameOf): string {
  return `${e.type} ${e.actorId || ""} ${evSearchText(e, nameOf)} ${JSON.stringify(e.payload || {}).slice(0, 600)}`.toLowerCase();
}

/**
 * Everything except the severity facet, newest first. The severity counts are taken from this list, so "Alerts 3" means three
 * alerts within what you are already looking at: a count against the whole buffer would send you to an empty list.
 *
 * `events` is oldest first (the store's order) and `hay` holds the haystack at the same index.
 */
export function filterBase<T extends EventLike>(events: readonly T[], hay: readonly string[], f: EventFilter): T[] {
  const out: T[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (f.groups.size && !f.groups.has(evGroupOf(e.type))) continue;
    if (f.actor && e.actorId !== f.actor) continue;
    if (f.thread && e.correlationId !== f.thread) continue;
    if (f.search && !hay[i]!.includes(f.search)) continue;
    out.push(e);
  }
  return out;
}

export function severityCounts(list: readonly EventLike[]): Record<Severity, number> {
  const c: Record<Severity, number> = { alert: 0, notice: 0, routine: 0 };
  for (const e of list) c[evSeverity(e)]++;
  return c;
}

/** The severity facet applied to the base list. No severity selected means all of them. */
export const applySeverity = <T extends EventLike>(list: readonly T[], on: ReadonlySet<string>): readonly T[] =>
  on.size ? list.filter((e) => on.has(evSeverity(e))) : list;

/** The busiest agents in the buffer, for the agent filter. */
export function topActors(events: readonly EventLike[], limit = 12): string[] {
  const n = new Map<string, number>();
  for (const e of events) if (e.actorId) n.set(e.actorId, (n.get(e.actorId) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([id]) => id);
}

/* ---------------------------------- rows ------------------------------------ */

/** A run of this many consecutive routine events collapses into one row. */
export const FOLD_AT = 3;

export type EventRowModel<T extends EventLike = EventLike> =
  | { kind: "bucket"; key: string; label: string }
  | { kind: "event"; key: string; e: T }
  | { kind: "fold"; key: string; items: T[] };

/**
 * Bucket headers and folded runs in one pass over a newest-first list.
 *
 * A run is flushed on a non-routine event and on a bucket boundary, so a fold never straddles two time headings and claims
 * events happened closer together than they did. A fold is keyed by its OLDEST event: new routine events join a run at the top,
 * so keying on the newest remounted the fold and snapped shut one the reader had just opened.
 */
export function buildRows<T extends EventLike>(list: readonly T[], now: number, fold: boolean): EventRowModel<T>[] {
  const out: EventRowModel<T>[] = [];
  let run: T[] = [];
  let bucket = "";

  const flush = (): void => {
    if (run.length >= FOLD_AT) out.push({ kind: "fold", key: `f${run[run.length - 1]!.seq}`, items: run });
    else for (const e of run) out.push({ kind: "event", key: String(e.seq || e.id), e });
    run = [];
  };

  for (const e of list) {
    const b = bucketOf(Date.parse(e.timestamp), now);
    if (b.id !== bucket) {
      flush();
      bucket = b.id;
      out.push({ kind: "bucket", key: `b${b.id}`, label: b.label });
    }
    if (fold && evSeverity(e) === "routine") {
      run.push(e);
      continue;
    }
    flush();
    out.push({ kind: "event", key: String(e.seq || e.id), e });
  }
  flush();
  return out;
}
