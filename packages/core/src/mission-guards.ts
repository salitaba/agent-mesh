import type { MeshOp } from "../../protocol/src/index";
import type { Projections } from "./state";

/** Ops allowed while the mission itself is halted (paused/escalated). */
export const MISSION_HALTED_ALLOW_OPS: ReadonlySet<MeshOp["op"]> = new Set([
  "escalate",
  "wait",
  "done",
  "remember",
  "read_artifact",
]);

/** After the mission is over, only reads (and local memory notes) make sense. */
export const MISSION_OVER_ALLOW_OPS: ReadonlySet<MeshOp["op"]> = new Set([
  "remember",
  "read_artifact",
]);

export function haltedGoalStatus(state: Projections): string | null {
  const goal = state.activeGoalId ? state.goals.get(state.activeGoalId) : undefined;
  if (!goal) return null;
  switch (goal.status) {
    case "ACTIVE":
    case "CONVERGING":
    case "CREATED":
      return null;
    default:
      return goal.status;
  }
}

export function haltReasonText(status: string | null): string {
  if (status === "PAUSED") return "mission is paused — resume it first";
  if (status === "ESCALATED" || status === "BLOCKED") return "mission is escalated — respond to the open escalation first";
  if (!status) return "mission is not active";
  return `mission is ${status}`;
}

export function isBookkeepingEvent(type: string): boolean {
  switch (type) {
    case "message.delivered":
    case "budget.reserved":
    case "budget.released":
    case "budget.consumed":
    case "agent.state_changed":
      return true;
    default:
      return type.startsWith("turn.");
  }
}
