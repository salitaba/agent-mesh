import { esc, fmt, plainArtifact, plainEvent, plainLifecycle, plainReason, friendlyBudgetKey, MESSAGE_PLAIN } from "./format";
import type { TimelineEvent } from "./store";

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
    }[p] || ""
  );
}

export function evSummary(e: TimelineEvent): string {
  const p = e.payload || {};
  if (typeof p.summary === "string" && p.summary) return esc(p.summary);
  switch (e.type) {
    case "message.sent":
      return `<b>${esc(p.message?.from)}</b> → ${(p.message?.to || []).join(", ")} · ${esc(MESSAGE_PLAIN[p.message?.type] || String(p.message?.type || "").toLowerCase())}`;
    case "message.rejected":
      return `Couldn't deliver — ${esc(String(p.reason || "").slice(0, 90))}`;
    case "artifact.created":
      return `<b>${esc(p.artifact?.name)}</b> created by ${esc(p.artifact?.createdBy)}`;
    case "artifact.versioned":
      return `<b>${esc(p.artifact?.name)}</b> updated to v${p.artifact?.version}`;
    case "artifact.transition":
      return `moved to <b>${esc(plainArtifact(p.to))}</b>`;
    case "agent.awakened":
      return `<b>${esc(p.agentId)}</b> started — ${esc(plainReason(p.reason?.kind))}`;
    case "agent.state_changed":
      return `${esc(p.agentId)} is now <b>${esc(plainLifecycle(p.to))}</b>`;
    case "budget.consumed":
      return `spent <b>${fmt(p.amount)}</b>`;
    case "budget.exceeded":
      return `<b>over budget</b> (${esc(friendlyBudgetKey(p.key))})`;
    case "escalation.requested":
      return `<b>needs you:</b> ${esc(p.escalation?.reason)}`;
    case "escalation.responded":
      return `you decided: ${esc(String(p.response || "").slice(0, 80))}`;
    case "goal.completed":
      return "mission complete 🏁";
    case "goal.escalated":
      return `paused — ${esc(p.reason || "")}`;
    case "task.claimed":
      return `started a task`;
    case "task.completed":
      return `finished: ${esc(String(p.summary || "a task").slice(0, 70))}`;
    case "review.approved":
      return `approved <b>${esc(p.subject || "")}</b>`;
    case "review.rejected":
      return `asked for changes on <b>${esc(p.subject || "")}</b>`;
    case "lease.acquired":
      return `editing locked by ${esc(p.lease?.agentId || "")}`;
    case "lease.released":
      return `editing unlocked`;
    case "thread.created":
      return `${esc(String(p.thread?.subject || "new chat").slice(0, 70))}`;
    default:
      return e.actorId ? esc(plainEvent(e.type) || e.actorId) : esc(plainEvent(e.type));
  }
}

export const EV_GROUP = (t: string): string => String(t).split(".")[0];

export const EV_FILTER_GROUPS = [
  { id: "", label: "All" },
  { id: "message", label: "Messages", match: ["message"] },
  { id: "agent", label: "Agents", match: ["agent"] },
  { id: "artifact", label: "Files & tasks", match: ["artifact", "task", "patch", "review", "release", "architecture", "implementation"] },
  { id: "system", label: "System", match: ["goal", "budget", "escalation", "lease", "memory", "human", "decision", "research", "requirements", "requirement", "dependency", "authentication", "authorization", "design", "thread"] },
];

export const evGroupOf = (t: string): string => {
  const g = EV_GROUP(t);
  for (const f of EV_FILTER_GROUPS) if (f.match && (f.match as string[]).includes(g)) return f.id;
  return "system";
};
