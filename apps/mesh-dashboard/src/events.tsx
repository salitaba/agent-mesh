import { activationDeniedKind, COLLAB_CLOSE_PLAIN, fmt, friendlyBudgetKey, MESSAGE_PLAIN, plainArtifact, plainEvent, plainLifecycle, plainReason } from "./format";
import { Icon } from "./icons";
import { SEVERITY_META, type Severity } from "./eventmodel";
import type { TimelineEvent } from "./store";

// The model (severity, kinds, filters, folding) is DOM-free and lives in eventmodel.ts, where node:test covers it. These names
// are re-exported so the components that grew up importing them from here keep working.
export {
  EV_FILTER_GROUPS, EV_GROUP, SEVERITY_META, SEVERITY_ORDER, evClass, evGroupOf, evSearchText, evSeverity,
  type Severity,
} from "./eventmodel";

/**
 * How serious an event is, drawn so that colour is never the only cue: a triangle for an alert, a filled dot for activity and a
 * ring for routine bookkeeping. Rows, filters and the detail pane all use it, so an alert looks like an alert wherever it turns up.
 */
export function SevMark({ s }: { s: Severity }): React.JSX.Element {
  return s === "alert"
    ? <Icon name="alert" size={14} className="sev-mark alert" />
    : <i className={`sev-mark ${s}`} aria-hidden="true" />;
}

/** What a screen reader hears for the mark. Activity is the default and says nothing. */
export const sevWord = (s: Severity): string => (s === "alert" ? "Alert. " : s === "routine" ? "Routine. " : "");

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
    case "message.sent": {
      const to = (p.message?.to || []).join(", ");
      const kind = MESSAGE_PLAIN[p.message?.type] || String(p.message?.type || "").toLowerCase();
      return <><b>{p.message?.from}</b> messaged {to}{kind ? ` · ${kind}` : ""}</>;
    }
    case "message.rejected": {
      // An activation denial names the seat that could not be woken, not a
      // message that could not be delivered — see `activationDeniedKind`.
      const kind = activationDeniedKind(p);
      if (kind !== undefined) return <><b>{p.from}</b> couldn't be woken ({plainReason(kind)}) — {String(p.reason || "").slice(0, 90)}</>;
      return <>Couldn't deliver — {String(p.reason || "").slice(0, 90)}</>;
    }
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
      return <>mission complete</>;
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
    case "collab.opened": {
      const s = p.session || {};
      const by = String(s.openedBy || "");
      // The opener is in its own participant list. Naming it on both sides of
      // "talking to" would read as an agent talking to itself.
      const others = (Array.isArray(s.participants) ? s.participants : []).filter(
        (x: unknown): x is string => typeof x === "string" && !!x && x !== by,
      );
      const topic = String(s.topic || "").slice(0, 60);
      return (
        <>
          <b>{by}</b>
          {others.length ? <> started talking to {others.join(", ")}</> : <> opened a conversation</>}
          {topic ? ` — ${topic}` : ""}
        </>
      );
    }
    case "collab.closed": {
      const n = Number(p.exchanges);
      const cap = Number(p.maxExchanges);
      const count =
        Number.isFinite(n) && n >= 0 ? ` after ${n}${cap > 0 ? `/${cap}` : ""} exchange${n === 1 ? "" : "s"}` : "";
      const outcome = typeof p.outcome === "string" && p.outcome ? ` — ${p.outcome.slice(0, 60)}` : "";
      return <>{COLLAB_CLOSE_PLAIN[String(p.reason || "")] || "ended"}{count}{outcome}</>;
    }
    default:
      return <>{e.actorId ? plainEvent(e.type, p) || e.actorId : plainEvent(e.type, p)}</>;
  }
}

/** The title a severity chip carries: the label and what it means, so a hover or a screen reader gets both. */
export const severityTitle = (s: Severity): string => `${SEVERITY_META[s].label}. ${SEVERITY_META[s].hint}`;
