/* Formatting + plain-English maps. Reduces jargon everywhere. */

export const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

export const fmt = (n: unknown): string => {
  const v = Number(n ?? 0);
  if (Math.abs(v) >= 1000000) return `${(v / 1000000).toFixed(Math.abs(v) >= 10000000 ? 0 : 1)}M`;
  return Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(Math.abs(v) >= 100000 ? 0 : 1)}k` : String(n ?? 0);
};

/** "1 approval", "2 approvals": a count and its noun, which agree when the count is one. */
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * A time of day, in the reader's own time zone: `19:02:07`.
 *
 * This used to be the UTC slice of the ISO string, shown with no label. The Overview's mini-feed printed local time
 * (through toLocaleTimeString) while the Events console, the event pane, the step inspector and the drawers printed UTC, so
 * one event carried two different times on two screens, and neither said which. Everything now goes through here, and a
 * page that prints a run of them says the zone once (`zoneLabel`). `timeZone` exists so a test can pin one.
 */
export const localTime = (iso: unknown, timeZone?: string): string => {
  const d = new Date(String(iso ?? ""));
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone });
};
/** The same call sites kept their name: they show local time now. */
export const hhmmss = localTime;

/** `Oct 4, 19:02:07`: for the one place a timestamp may be from another day. */
export const localDateTime = (iso: unknown, timeZone?: string): string => {
  const d = new Date(String(iso ?? ""));
  if (Number.isNaN(d.getTime())) return "";
  return `${d.toLocaleDateString("en-GB", { month: "short", day: "numeric", timeZone })}, ${localTime(iso, timeZone)}`;
};

/** The zone local times are shown in: `UTC`, or `GMT+3:30`. Printed once above a run of times so no row repeats it. */
export const zoneLabel = (timeZone?: string, at: Date = new Date()): string => {
  const part = new Intl.DateTimeFormat("en-GB", { timeZoneName: "short", timeZone }).formatToParts(at).find((p) => p.type === "timeZoneName");
  const name = part?.value ?? "";
  return name === "GMT" ? "UTC" : name;
};

export const ago = (iso: unknown): string => {
  const s = (Date.now() - Date.parse(String(iso ?? ""))) / 1000;
  if (!Number.isFinite(s)) return "";
  if (s < 0) return "just now";
  if (s < 60) return `${Math.max(0, Math.round(s))}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 48 * 3600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

export const pillCls = (lifecycle: unknown): string => String(lifecycle || "").toLowerCase();

export const RUNNING = new Set(["THINKING", "WORKING", "AWAKENED", "OBSERVING", "REQUESTING", "REVIEWING"]);

/**
 * Progress has to be counted the way the kernel counts it. `CriterionStatus` is
 * UNSATISFIED | ASSERTED | EVIDENCED | WAIVED, and every gate in core —
 * termination, projections-goal, context — counts only EVIDENCED or WAIVED.
 * ASSERTED means an agent claimed the criterion from a turn that verified
 * nothing, and is excluded on purpose.
 *
 * The console counted `!== "UNSATISFIED"`, so an ASSERTED claim moved the
 * progress bar. Overview then showed "6 of 6 checks done" directly above a list
 * labelling one of them "claimed, not verified", on a mission the gate would
 * never let terminate. Same predicate everywhere, or the console lies.
 */
export const criterionDone = (c: { status?: unknown }): boolean => c.status === "EVIDENCED" || c.status === "WAIVED";

/** Only mandatory criteria reach the termination gate, so only they are scored. */
export function mandatoryProgress(criteria: readonly unknown[] | undefined): { done: number; total: number; pct: number } {
  const mandatory = (criteria || []).filter((c: any) => c.mandatory);
  const done = mandatory.filter((c: any) => criterionDone(c)).length;
  return { done, total: mandatory.length, pct: mandatory.length ? Math.round((done / mandatory.length) * 100) : 0 };
}

const LIFECYCLE_PLAIN: Record<string, string> = {
  STARTING: "starting", IDLE: "idle", AWAKENED: "started work", OBSERVING: "reading inbox",
  THINKING: "working", REQUESTING: "asking for help", WORKING: "working", WAITING: "waiting",
  REVIEWING: "reviewing", BLOCKED: "blocked", SUSPENDED: "paused", FAILED: "crashed", COMPLETED: "done",
};
export const plainLifecycle = (s: unknown): string =>
  LIFECYCLE_PLAIN[String(s || "").toUpperCase()] || String(s || "-").toLowerCase();

const GOAL_PLAIN: Record<string, string> = {
  CREATED: "created", ACTIVE: "running", PAUSED: "paused", BLOCKED: "blocked",
  CONVERGING: "wrapping up", COMPLETED: "done", FAILED: "failed", ESCALATED: "needs you",
};
export const plainGoal = (s: unknown): string =>
  GOAL_PLAIN[String(s || "").toUpperCase()] || String(s || "-").toLowerCase();

/**
 * Goal statuses are not lifecycle values, so lowercasing them the way `pillCls`
 * does produced `.pill.active` / `.pill.paused` / `.pill.escalated` — three
 * classes that do not exist. The pill fell back to its neutral base, which is
 * why a mission that needed a decision looked exactly like a healthy one.
 * Mapped explicitly onto the tones that *are* defined.
 */
const GOAL_TONE: Record<string, string> = {
  CREATED: "starting", ACTIVE: "working", CONVERGING: "reviewing",
  PAUSED: "waiting", BLOCKED: "blocked", ESCALATED: "blocked",
  COMPLETED: "completed", FAILED: "failed",
};
export const goalTone = (s: unknown): string => GOAL_TONE[String(s || "").toUpperCase()] || "idle";

const REASON_PLAIN: Record<string, string> = {
  startup: "mission started", message: "new message", interest_event: "something it cares about happened",
  manual: "you woke it", recovery: "restarted after a problem", timer: "follow-up nudge", unknown: "woken",
};
export const plainReason = (k: unknown): string =>
  REASON_PLAIN[String(k || "unknown")] || String(k || "woken");

const ARTIFACT_PLAIN: Record<string, string> = {
  DRAFT: "draft", READY_FOR_REVIEW: "ready for review", UNDER_REVIEW: "in review", REJECTED: "needs rework",
  APPROVED: "approved", VERIFIED: "verified", MERGEABLE: "ready to merge", MERGED: "merged",
  PROPOSED: "proposed", IMPLEMENTED: "built", QA_VERIFIED: "QA passed", SECURITY_VERIFIED: "security passed",
  ACCEPTED: "accepted", FINAL: "final", ARCHIVED: "archived",
};
export const plainArtifact = (s: unknown): string =>
  ARTIFACT_PLAIN[String(s || "")] || String(s || "-").toLowerCase().replace(/_/g, " ");

/** Pill class for an artifact lifecycle state. Single source for every view. */
const ARTIFACT_DONE = ["APPROVED", "VERIFIED", "MERGEABLE", "MERGED", "FINAL", "ACCEPTED", "QA_VERIFIED", "SECURITY_VERIFIED"];
export function artifactCls(s: string): string {
  return ARTIFACT_DONE.includes(s)
    ? "completed"
    : s === "REJECTED" ? "failed" : s === "UNDER_REVIEW" || s === "READY_FOR_REVIEW" ? "waiting" : "idle";
}

/** Vitals health -> pill class. Single source for Agents view and observability. */
export const HEALTH_CLS: Record<string, string> = {
  warming: "v-warm", streaming: "v-ok", slow: "v-warn", stalled: "v-bad", done: "v-done",
};

/**
 * One short lowercase phrase per catalog event type, in `EVENT_TYPES` order.
 * A type missing here fell through to its raw dotted name, so a step's
 * timeline read "thread.created" beside "woke up" — two vocabularies on one
 * list. tests/dashboard/format.test.ts fails when the catalog grows a type
 * this table does not name.
 *
 * Artifact creation is "published", the word the op ledger uses for the op
 * that causes it; "file created" suggested a file on disk, which it is not.
 */
const EVENT_PLAIN: Record<string, string> = {
  "goal.created": "mission created", "goal.budget_changed": "budget changed", "goal.status_changed": "mission status",
  "goal.paused": "mission paused", "goal.resumed": "mission resumed", "goal.progress": "progress",
  "goal.completed": "mission done", "goal.reopened": "mission reopened", "goal.escalated": "mission escalated",
  "goal.failed": "mission failed", "goal.description_revised": "mission revised",
  "requirements.created": "requirements set", "requirement.blocked": "requirement blocked",
  "requirement.satisfied": "requirement met", "requirement.revised": "requirement revised",
  "requirement.removed": "requirement removed",
  "agent.created": "agent created", "agent.started": "session started", "agent.awakened": "woke up",
  "agent.state_changed": "status change", "agent.suspended": "suspended", "agent.resumed": "resumed",
  "agent.completed": "finished", "agent.failed": "crashed", "agent.restarted": "restarted",
  "agent.replaced": "replaced", "agent.retired": "retired", "agent.mute_suspected": "went quiet",
  "session.rotation_pending": "rotation due", "session.rotated": "session rotated", "continuity.recorded": "handover noted",
  "thread.created": "thread opened",
  "message.sent": "message", "message.delivered": "delivered", "message.rejected": "blocked message",
  "artifact.created": "published", "artifact.versioned": "new version", "artifact.transition": "moved",
  "task.created": "task created", "task.claimed": "started task", "task.completed": "finished task",
  "review.requested": "review requested", "review.approved": "review approved", "review.rejected": "review rejected",
  "patch.created": "patch created", "patch.ready": "patch ready", "patch.merged": "patch merged",
  "architecture.approved": "architecture approved", "design.question": "design question",
  "dependency.changed": "dependency changed", "authentication.changed": "auth changed", "authorization.changed": "access changed",
  "release.candidate": "release candidate", "release.transition": "release moved", "release.accepted": "release accepted",
  "research.requested": "research requested", "research.completed": "research done",
  "implementation.completed": "implemented",
  "decision.proposed": "decision proposed", "decision.ratified": "decision ratified",
  "escalation.requested": "needs you", "escalation.responded": "escalation answered",
  "escalation.auto_resolved": "escalation settled", "deadlock.auto_resolved": "deadlock broken",
  "commitment.discharged": "ask closed",
  "collab.opened": "started talking", "collab.closed": "stopped talking",
  "human.input": "operator input",
  "lease.acquired": "lease taken", "lease.released": "lease released",
  "memory.updated": "remembered", "context.assembled": "context built", "turn.discarded": "turn discarded",
  "plan.updated": "plan updated", "plan.gate_rejected": "plan refused",
  "budget.reserved": "budget reserved", "budget.consumed": "spent", "budget.exceeded": "over budget",
  "budget.released": "budget released", "budget.limit_raised": "budget raised",
};
/**
 * `message.rejected` carries two different things. A refused send has `to` —
 * there was a message and it did not leave. An activation denial (the
 * scheduler's policy refusal, routed through the supervisor's `denied()`) has
 * `action: "activate (<reason kind>)"` and no recipient: the seat was never
 * allowed to run. Labelling both "blocked message" told the operator a seat's
 * mail was stopped when in fact the seat was.
 */
export function activationDeniedKind(p: unknown): string | undefined {
  const r = (p || {}) as { action?: unknown; to?: unknown };
  if (Array.isArray(r.to) || typeof r.action !== "string") return undefined;
  const m = /^activate \((.*)\)$/.exec(r.action);
  return m ? m[1] : undefined;
}

/**
 * The payload is optional: callers that have it get the labels that depend on
 * it — the activation-denial reading of `message.rejected`, and the state an
 * artifact moved to. `artifact.transition` used to read "moved forward" for
 * every transition, including UNDER_REVIEW → DRAFT, which is a walk back; the
 * kernel stamps the destination as `payload.to` on both of its emit sites, so
 * the label says where it went and nothing about direction.
 */
export const plainEvent = (t: unknown, payload?: unknown): string =>
  (t === "message.rejected" && activationDeniedKind(payload) !== undefined ? "couldn't wake" : undefined) ||
  (t === "artifact.transition" ? transitionLabel(payload) : undefined) ||
  EVENT_PLAIN[String(t || "")] || String(t || "");

function transitionLabel(p: unknown): string | undefined {
  const to = ((p || {}) as { to?: unknown }).to;
  return typeof to === "string" && to ? `moved to ${to.toLowerCase().replace(/_/g, " ")}` : undefined;
}

export const shortTurn = (id: unknown): string => {
  const s = String(id || "");
  return s.startsWith("turn-") ? s.slice(5, 11) : s.slice(0, 8);
};

export const friendlyBudgetKey = (k: unknown): string => {
  const s = String(k || "");
  let m = s.match(/^agent:[^/]+\/(.+)$/);
  if (m) return `${m[1]}'s budget`;
  m = s.match(/^thread:[^/]+\/(.+)$/);
  if (m) return "thread budget";
  m = s.match(/^mission:(.+)$/);
  if (m) return "mission budget";
  m = s.match(/^task:[^/]+\/(.+)$/);
  if (m) return "task budget";
  return s;
};

/** Why a collaboration ended. Keys are the kernel's `collab.closed` reasons;
    two of the three are the watchdog's, and they are worded so the operator can
    tell "they finished" from "we stopped them" without opening the event. */
export const COLLAB_CLOSE_PLAIN: Record<string, string> = {
  closed: "wrapped up",
  expired: "ran out of time",
  exchanges_exhausted: "hit its message limit",
};

export const MESSAGE_PLAIN: Record<string, string> = {
  INFORM: "update", MISSION: "new task", REQUEST: "ask for help",
  REQUEST_REVIEW: "ask for review", ESCALATE: "escalate", DONE: "mark done",
};

export const STEP_PLAIN: Record<string, string> = {
  running: "working now", ok: "done", waiting: "waiting", blocked: "blocked", failed: "crashed",
};

/* ---------------------------------------------------------------------- *
 * Outcome model.
 *
 * TurnStatus is lifecycle-shaped, not outcome-shaped: a turn that finished
 * cleanly and parked its agent back on the mailbox arrives as "waiting",
 * which reads like "stuck" but means "done, nothing left to do". Showing
 * that raw made the Steps page look like a wall of stalled work.
 *
 * Outcome answers what a human actually asks: is it still running, did it
 * change anything, or did it burn tokens for nothing.
 * ---------------------------------------------------------------------- */

export type Outcome = "live" | "shipped" | "quiet" | "rejected" | "blocked" | "crashed";

export interface OutcomeInput {
  status: string;
  ops?: { messages: number; artifacts: number; tasks: number; decisions: number };
  /** Per-op kernel verdicts. `ok: false` is a refusal, with `reason` saying why. */
  opTimings?: { op: string; ok: boolean; reason?: string }[];
}

export const OUTCOME_META: Record<Outcome, { label: string; hint: string; cls: string }> = {
  live: { label: "working now", hint: "agent is mid-turn right now", cls: "o-live" },
  shipped: { label: "produced", hint: "turn ended and left messages or files behind", cls: "o-ship" },
  quiet: { label: "no output", hint: "turn ended without writing anything — tokens spent, nothing changed", cls: "o-quiet" },
  rejected: { label: "refused", hint: "the agent tried to act and the kernel refused every action — nothing landed", cls: "o-rej" },
  blocked: { label: "blocked", hint: "turn ended waiting on something it cannot do alone", cls: "o-block" },
  crashed: { label: "crashed", hint: "the runtime failed mid-turn", cls: "o-crash" },
};

/**
 * A labelled parameter on a ledger row: a chip, not prose. The value is one
 * clipped line; the untruncated text stays in the row's tooltip.
 */
export interface OpFact { k: string; v: string }

/**
 * One written op as a reader wants it: what it did (title), which parameters
 * identify it (facts), and what it actually said (detail).
 *
 * `detail` is prose only. A payload with no prose key yields "" rather than a
 * JSON dump, so parameters must be carried in `facts`.
 */
export interface OpHead {
  title: string; detail: string; facts: OpFact[];
  /** A quiet qualifier set after the title — the ledger's own remark about
   *  the row ("one of 4 unnamed"), not something the op said. */
  note?: string;
}

/** Ops the kernel refused, in the order they were attempted. */
export function refusedOps(s: OutcomeInput): { op: string; reason?: string }[] {
  return (s.opTimings ?? []).filter((t) => t.ok === false);
}

/**
 * Effects the turn left behind, across every ledger category. A turn can leave
 * these without the dashboard ever seeing the tool call that caused them —
 * messages and decisions are counted from the event log either way — so this
 * is the test for "produced nothing", and an empty op list is not.
 */
export function producedCount(s: OutcomeInput): number {
  const o = s.ops;
  return o ? o.messages + o.artifacts + o.tasks + o.decisions : 0;
}

export function outcomeOf(s: OutcomeInput): Outcome {
  if (s.status === "running") return "live";
  if (s.status === "failed") return "crashed";
  if (s.status === "blocked") return "blocked";
  if (producedCount(s) > 0) return "shipped";
  // A turn that wrote nothing because the kernel refused every op is not the
  // same failure as a turn that had nothing to say: "no output" reads as an
  // idle wake-up, hiding a policy refusal the operator has to act on.
  return refusedOps(s).length ? "rejected" : "quiet";
}

/** "3 messages · 1 file" — what the turn actually left behind. */
export function opsSummary(s: OutcomeInput): string {
  const o = s.ops;
  const refused = refusedOps(s);
  // A refusal count belongs here even on a turn that also produced something:
  // "1 message" alone hides that the same turn tried three more things and was
  // told no.
  const no = refused.length ? `${refused.length} refused` : "";
  if (!o) return no || "nothing recorded";
  const bits: string[] = [];
  if (o.messages) bits.push(`${o.messages} message${o.messages > 1 ? "s" : ""}`);
  if (o.artifacts) bits.push(`${o.artifacts} file${o.artifacts > 1 ? "s" : ""}`);
  if (o.tasks) bits.push(`${o.tasks} task${o.tasks > 1 ? "s" : ""}`);
  if (o.decisions) bits.push(`${o.decisions} decision${o.decisions > 1 ? "s" : ""}`);
  if (no) bits.push(no);
  return bits.length ? bits.join(" · ") : "wrote nothing";
}

/** "mission is COMPLETED (discharge, done)" — why the kernel said no. */
export function refusalSummary(s: OutcomeInput): string {
  const refused = refusedOps(s);
  if (!refused.length) return "";
  const reason = refused.find((r) => r.reason)?.reason;
  const ops = [...new Set(refused.map((r) => r.op))].join(", ");
  return reason ? `${reason} (${ops})` : `${ops} refused`;
}

/** One line of a before → after snippet; `gap` stands for unchanged lines left out. */
export interface SnippetLine { op: "eq" | "add" | "del" | "gap"; text: string }

/**
 * Line diff of an in-place edit (an Edit call's old_string → new_string). Not
 * an LCS: an edit is one contiguous replacement, so the shared head and tail
 * are context and everything between is what was cut and what went in. The
 * context is trimmed to `context` lines each side — an old_string that is five
 * lines of anchor and a new_string that appends a section would otherwise
 * repeat the anchor in full before the one change the reader wants.
 */
export function snippetDiff(before: string, after: string, context = 3): SnippetLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const out: SnippetLine[] = [];
  const gap = (n: number): SnippetLine => ({ op: "gap", text: `⋯ ${n} unchanged line${n === 1 ? "" : "s"}` });
  if (head > context) out.push(gap(head - context));
  for (const t of a.slice(Math.max(0, head - context), head)) out.push({ op: "eq", text: t });
  for (const t of a.slice(head, a.length - tail)) out.push({ op: "del", text: t });
  for (const t of b.slice(head, b.length - tail)) out.push({ op: "add", text: t });
  for (const t of a.slice(a.length - tail, a.length - tail + context)) out.push({ op: "eq", text: t });
  if (tail > context) out.push(gap(tail - context));
  return out;
}

/**
 * Past an hour the seconds are noise and the minutes pile up: a twelve-hour
 * timeline labelled its ticks "-704m 41s". Hours and minutes from there on.
 */
export const dur = (ms?: number): string => {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
  // Round once, then split: rounding each part on its own printed "3m 60s".
  if (ms < 3_600_000) {
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  }
  const m = Math.round(ms / 60000);
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};

/**
 * A round span as an axis label: "30s", "5m", "2h", "1h 30m". Zero parts are
 * dropped, so a tick every two hours reads "-2h", not "-2h 0m".
 */
export const spanLabel = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.round(ms / 60_000);
  const h = Math.floor(m / 60);
  if (!h) return `${m}m`;
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
};

/**
 * The budget gate's refusal, `budget mission:goal-… exhausted (13065531/12640000)`,
 * is a ledger key and two raw integers. Said as the budget it names and the two
 * amounts, rounded; any other text comes back unchanged.
 */
export function plainBlocker(text: string): string {
  const m = /^budget (\S+) exhausted \((\d+)\/(\d+)\)(.*)$/s.exec(text.trim());
  if (!m) return text;
  // One decimal for millions: `fmt` rounds past 10M to whole millions, and
  // the overrun it hid ("13M of 13M") is the whole point of the message.
  const amt = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : fmt(n));
  return `${friendlyBudgetKey(m[1])} used up — ${amt(Number(m[2]))} of ${amt(Number(m[3]))}${m[4]}`;
}

export const roundNice = (n: number): number =>
  n >= 1000000 ? Math.ceil(n / 100000) * 100000 : n >= 100000 ? Math.ceil(n / 10000) * 10000 : Math.ceil(n / 1000) * 1000;

export const fmtBudget = (n: unknown, unit: string): string =>
  unit === "minutes" && typeof n === "number" ? `${Math.round(n / 60000)}m` : fmt(n ?? 0);

export const shortUri = (u: unknown): string => {
  const m = /artifact:\/\/([^/]+)\/([^/]+)/.exec(String(u || ""));
  return m ? `${decodeURIComponent(m[2])}·${m[1].slice(0, 4)}` : String(u || "").split("-").pop() || "";
};

export const shortKey = (k: unknown): string =>
  String(k || "").replace(/^(\w+):[^/]+\//, "$1:").replace(/goal-[A-Z0-9]+/i, (g) => g.slice(0, 9));
