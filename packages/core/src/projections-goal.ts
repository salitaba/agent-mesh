import type { MeshEvent } from "../../protocol/src/index";
import type { Projections } from "./state";
import type { AcceptanceCriterion, Goal } from "../../protocol/src/index";
import { ProjectionError } from "./projections-helpers";

export function applyGoalEvent(state: Projections, event: MeshEvent, p: Record<string, any>): boolean {
  switch (event.type) {
    case "goal.created": {
      const goal = p.goal as Goal;
      state.goals.set(goal.id, goal);
      // Latest goal wins: a restart must resume the newest mission, not the
      // first one ever created. Previously `if (!activeGoalId)` kept the
      // first goal forever, so every restart with a snapshot (which drops
      // activeGoalId) created a spurious new goal and orphaned live work.
      state.activeGoalId = goal.id;
      state.goalHistory.push({ status: goal.status, at: event.timestamp, reason: "created" });
      break;
    }
    case "goal.status_changed": {
      const goal = state.goals.get(p.goalId);
      if (!goal) throw new ProjectionError(`unknown goal ${p.goalId}`, event.type);
      goal.status = p.status;
      state.goalHistory.push({ status: p.status, at: event.timestamp, reason: p.reason });
      if (p.status === "COMPLETED") goal.completedAt = event.timestamp;
      break;
    }
    case "goal.budget_changed": {
      // Operator-raised mission caps (escalation flow). Stored on the goal so
      // replay preserves the override without touching mesh.yaml.
      const goal = state.goals.get(p.goalId ?? event.goalId ?? state.activeGoalId ?? "");
      if (!goal) throw new ProjectionError(`unknown goal ${p.goalId}`, event.type);
      const patch = (p.budget ?? {}) as Partial<Goal["budget"]>;
      for (const k of ["tokens", "wallClockMinutes", "maxEvents"] as const) {
        if (typeof patch[k] === "number" && Number.isFinite(patch[k])) goal.budget[k] = patch[k] as number;
      }
      break;
    }
    case "goal.paused": {
      const goal = state.goals.get(p.goalId ?? state.activeGoalId ?? "");
      if (goal && (goal.status === "ACTIVE" || goal.status === "CONVERGING" || goal.status === "BLOCKED")) {
        goal.status = "PAUSED";
        state.goalHistory.push({ status: "PAUSED", at: event.timestamp, reason: p.reason });
      }
      break;
    }
    case "goal.resumed": {
      const goal = state.goals.get(p.goalId ?? state.activeGoalId ?? "");
      if (goal && goal.status === "PAUSED") {
        goal.status = "ACTIVE";
        state.goalHistory.push({ status: "ACTIVE", at: event.timestamp, reason: p.reason });
      }
      break;
    }
    case "goal.progress": {
      const gid = event.goalId ?? state.activeGoalId;
      if (gid) {
        state.progress.set(gid, {
          completed: p.completed ?? 0,
          total: p.total ?? 0,
          ratio: p.ratio ?? 0,
          updatedAt: event.timestamp,
        });
      }
      break;
    }
    case "goal.completed":
    case "goal.escalated":
    case "goal.failed": {
      const goal = state.goals.get(event.goalId ?? state.activeGoalId ?? "");
      if (goal) {
        const map: Record<string, Goal["status"]> = {
          "goal.completed": "COMPLETED",
          "goal.escalated": "ESCALATED",
          "goal.failed": "FAILED",
        };
        goal.status = map[event.type];
        if (event.type === "goal.completed") goal.completedAt = event.timestamp;
        state.goalHistory.push({ status: goal.status, at: event.timestamp, reason: p.reason });
      }
      break;
    }
    case "requirements.created": {
      const goal = state.goals.get(event.goalId ?? state.activeGoalId ?? "");
      if (goal && Array.isArray(p.criteria)) {
        for (const c of p.criteria as AcceptanceCriterion[]) {
          if (!goal.acceptanceCriteria.find((x) => x.id === c.id)) {
            goal.acceptanceCriteria.push(c);
          }
        }
      }
      break;
    }
    case "requirement.blocked": {
      const goal = state.goals.get(event.goalId ?? state.activeGoalId ?? "");
      if (goal && p.criterionId) {
        const c = goal.acceptanceCriteria.find((x) => x.id === p.criterionId);
        if (c) c.status = "UNSATISFIED";
      }
      break;
    }
    case "requirement.satisfied": {
      const goal = state.goals.get(event.goalId ?? state.activeGoalId ?? "");
      if (goal && p.criterionId) {
        const c = goal.acceptanceCriteria.find((x) => x.id === p.criterionId);
        if (c) {
          c.status = "EVIDENCED";
          if (p.evidence) c.evidence.push(p.evidence);
        }
      }
      break;
    }
    default:
      return false;
  }
  return true;
}
