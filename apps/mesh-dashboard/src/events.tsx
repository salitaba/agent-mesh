import { fmt, friendlyBudgetKey, MESSAGE_PLAIN, plainArtifact, plainEvent, plainLifecycle, plainReason } from "./format";
import type { TimelineEvent } from "./store";
// Deep import, not the package barrel: `packages/protocol/src/index` star-exports
// the AJV-backed validators and schemas, and none of that belongs in a browser
// bundle. `catalog.ts` imports only types from `./types`, so this pulls in the
// const table and nothing else. It is the dashboard's one dependency on
// packages/ — worth it to keep a single source of truth for severity rather
// than a second 68-entry table here that would silently drift.
import { EVENT_SEVERITY } from "../../../packages/protocol/src/catalog";
import type { EventType, Severity } from "../../../packages/protocol/src/types";

export type { Severity };

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
    }[p] || ""
  );
}

/* ---------------------------- severity -------------------------------- */

export const SEVERITY_META: Record<Severity, { label: string; glyph: string; hint: string }> = {
  alert: { label: "Alerts", glyph: "▲", hint: "went wrong, or needs you" },
  notice: { label: "Activity", glyph: "●", hint: "real progress" },
  routine: { label: "Routine", glyph: "·", hint: "bookkeeping — folded by default" },
};

export const SEVERITY_ORDER: Severity[] = ["alert", "notice", "routine"];

/** Lifecycle states that mean an agent is stuck or dead rather than working. */
const BAD_LIFECYCLE = new Set(["FAILED", "BLOCKED"]);

/**
 * The type-level floor from `EVENT_SEVERITY`, refined where the payload knows
 * better.
 *
 * Only `agent.state_changed` is refined today, and deliberately so: it is both
 * the highest-volume type in the log and the one whose importance swings most
 * on its payload — a transition into FAILED is the single most useful line in a
 * crashed run, and ranking it `routine` alongside the dozen THINKING/WORKING
 * churns per turn would fold the crash away. Other types are left at their
 * floor rather than guessed at; a refinement is only worth adding for a payload
 * shape that has actually been read.
 *
 * Unknown types fall back to `notice`, not `routine`: a dashboard older than the
 * server it is pointed at should show new events too loudly rather than hide them.
 */
export function evSeverity(e: TimelineEvent): Severity {
  const base: Severity = EVENT_SEVERITY[e.type as EventType] ?? "notice";
  if (e.type === "agent.state_changed" && BAD_LIFECYCLE.has(String(e.payload?.to))) return "alert";
  return base;
}

/* ------------------------------ facets --------------------------------- */

export const EV_GROUP = (t: string): string => String(t).split(".")[0];

/** Multi-select now: an empty selection means "everything", so there is no
    "All" pseudo-facet to keep in sync with the real ones. */
export const EV_FILTER_GROUPS: { id: string; label: string; match: string[] }[] = [
  { id: "message", label: "Messages", match: ["message", "thread"] },
  { id: "agent", label: "Agents", match: ["agent", "memory"] },
  { id: "work", label: "Files & tasks", match: ["artifact", "task", "plan", "patch", "review", "release", "architecture", "implementation", "design", "dependency", "requirements", "requirement"] },
  { id: "system", label: "System", match: ["goal", "budget", "escalation", "lease", "human", "decision", "research", "authentication", "authorization", "deadlock", "commitment"] },
];

export const evGroupOf = (t: string): string => {
  const g = EV_GROUP(t);
  for (const f of EV_FILTER_GROUPS) if (f.match.includes(g)) return f.id;
  return "system";
};

/* ----------------------------- summary --------------------------------- */

/**
 * The one-line "what happened" for an event.
 *
 * This used to build an HTML string rendered through `dangerouslySetInnerHTML`
 * in five places, with every interpolation hand-wrapped in `esc()`. That was
 * correct as written, but only as long as nobody ever added a case arm and
 * forgot the wrapper — the kind of invariant that holds until the day it does
 * not, and whose failure is an injection. Returning nodes makes it structurally
 * safe: React escapes, and there is nothing left to remember.
 */
export function EventSummary({ e }: { e: TimelineEvent }): React.JSX.Element {
  const p = e.payload || {};
  if (typeof p.summary === "string" && p.summary) return <>{p.summary}</>;
  switch (e.type) {
    case "message.sent":
      return <><b>{p.message?.from}</b>{" → "}{(p.message?.to || []).join(", ")}{" · "}{MESSAGE_PLAIN[p.message?.type] || String(p.message?.type || "").toLowerCase()}</>;
    case "message.rejected":
      return <>Couldn't deliver — {String(p.reason || "").slice(0, 90)}</>;
    case "plan.updated": {
      const steps = p.plan?.steps || [];
      const done = steps.filter((s: any) => s.status === "DONE").length;
      return <><b>{p.agentId}</b> planned {steps.length} step{steps.length === 1 ? "" : "s"}{steps.length ? ` (${done} done)` : ""}</>;
    }
    case "plan.gate_rejected":
      return <><b>{p.agentId}</b> — the plan gate {p.mode === "enforce" ? "blocked" : "flagged"} {p.op}: {String(p.reason || "").slice(0, 80)}</>;
    case "artifact.created":
      return <><b>{p.artifact?.name}</b> created by {p.artifact?.createdBy}</>;
    case "artifact.versioned":
      return <><b>{p.artifact?.name}</b> updated to v{p.artifact?.version}</>;
    case "artifact.transition":
      return <>moved to <b>{plainArtifact(p.to)}</b></>;
    case "agent.awakened":
      return <><b>{p.agentId}</b> started — {plainReason(p.reason?.kind)}</>;
    case "agent.state_changed":
      return <>{p.agentId} is now <b>{plainLifecycle(p.to)}</b></>;
    case "budget.consumed":
      return <>spent <b>{fmt(p.amount)}</b></>;
    case "budget.exceeded":
      return <><b>over budget</b> ({friendlyBudgetKey(p.key)})</>;
    case "escalation.requested":
      return <><b>needs you:</b> {p.escalation?.reason}</>;
    case "escalation.responded":
      return <>you decided: {String(p.response || "").slice(0, 80)}</>;
    case "goal.completed":
      return <>mission complete 🏁</>;
    case "goal.escalated":
      return <>paused — {p.reason || ""}</>;
    case "task.claimed":
      return <>started a task</>;
    case "task.completed":
      return <>finished: {String(p.summary || "a task").slice(0, 70)}</>;
    case "review.approved":
      return <>approved <b>{p.subject || ""}</b></>;
    case "review.rejected":
      return <>asked for changes on <b>{p.subject || ""}</b></>;
    case "lease.acquired":
      return <>editing locked by {p.lease?.agentId || ""}</>;
    case "lease.released":
      return <>editing unlocked</>;
    case "thread.created":
      return <>{String(p.thread?.subject || "new chat").slice(0, 70)}</>;
    default:
      return <>{e.actorId ? plainEvent(e.type) || e.actorId : plainEvent(e.type)}</>;
  }
}

/** Plain-text fallback of the same thing, for search haystacks and tooltips
    where nodes are not usable. Kept deliberately crude — it exists to be
    matched against, not read. */
export function evSearchText(e: TimelineEvent): string {
  const p = e.payload || {};
  if (typeof p.summary === "string" && p.summary) return p.summary;
  return `${plainEvent(e.type)} ${e.actorId || ""}`;
}
