/* Formatting + plain-English maps. Reduces jargon everywhere. */

export const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

export const fmt = (n: unknown): string => {
  const v = Number(n ?? 0);
  if (Math.abs(v) >= 1000000) return `${(v / 1000000).toFixed(Math.abs(v) >= 10000000 ? 0 : 1)}M`;
  return Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(Math.abs(v) >= 100000 ? 0 : 1)}k` : String(n ?? 0);
};

export const hhmmss = (iso: unknown): string => String(iso ?? "").slice(11, 19);

export const ago = (iso: unknown): string => {
  const s = (Date.now() - Date.parse(String(iso ?? ""))) / 1000;
  if (!Number.isFinite(s)) return "";
  if (s < 0) return "just now";
  if (s < 60) return `${Math.max(0, Math.round(s))}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};

export const pillCls = (lifecycle: unknown): string => String(lifecycle || "").toLowerCase();

export const RUNNING = new Set(["THINKING", "WORKING", "AWAKENED", "OBSERVING", "REQUESTING", "REVIEWING"]);

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

const EVENT_PLAIN: Record<string, string> = {
  "budget.limit_raised": "budget raised",
  "message.sent": "message", "message.delivered": "inbox", "message.rejected": "blocked message",
  "agent.awakened": "woke up", "agent.state_changed": "status change", "agent.failed": "crashed",
  "artifact.created": "file created", "artifact.versioned": "new version", "artifact.transition": "moved forward",
  "task.created": "task", "task.claimed": "started task", "task.completed": "finished task",
  "budget.consumed": "spent", "budget.exceeded": "over budget", "escalation.requested": "needs you",
  "goal.completed": "done", "goal.escalated": "paused",
};
export const plainEvent = (t: unknown): string => EVENT_PLAIN[String(t || "")] || String(t || "");

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

export type Outcome = "live" | "shipped" | "quiet" | "blocked" | "crashed";

export interface OutcomeInput {
  status: string;
  ops?: { messages: number; artifacts: number; tasks: number; decisions: number };
}

export const OUTCOME_META: Record<Outcome, { label: string; hint: string; cls: string }> = {
  live: { label: "working now", hint: "agent is mid-turn right now", cls: "o-live" },
  shipped: { label: "produced", hint: "turn ended and left messages or files behind", cls: "o-ship" },
  quiet: { label: "no output", hint: "turn ended without writing anything — tokens spent, nothing changed", cls: "o-quiet" },
  blocked: { label: "blocked", hint: "turn ended waiting on something it cannot do alone", cls: "o-block" },
  crashed: { label: "crashed", hint: "the runtime failed mid-turn", cls: "o-crash" },
};

export function outcomeOf(s: OutcomeInput): Outcome {
  if (s.status === "running") return "live";
  if (s.status === "failed") return "crashed";
  if (s.status === "blocked") return "blocked";
  const o = s.ops;
  const produced = o ? o.messages + o.artifacts + o.tasks + o.decisions : 0;
  return produced > 0 ? "shipped" : "quiet";
}

/** "3 messages · 1 file" — what the turn actually left behind. */
export function opsSummary(s: OutcomeInput): string {
  const o = s.ops;
  if (!o) return "nothing recorded";
  const bits: string[] = [];
  if (o.messages) bits.push(`${o.messages} message${o.messages > 1 ? "s" : ""}`);
  if (o.artifacts) bits.push(`${o.artifacts} file${o.artifacts > 1 ? "s" : ""}`);
  if (o.tasks) bits.push(`${o.tasks} task${o.tasks > 1 ? "s" : ""}`);
  if (o.decisions) bits.push(`${o.decisions} decision${o.decisions > 1 ? "s" : ""}`);
  return bits.length ? bits.join(" · ") : "wrote nothing";
}

export const dur = (ms?: number): string => {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
};

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
