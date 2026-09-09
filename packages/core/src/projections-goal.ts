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
    // Operator rejected the delivered result: the mission goes back to work.
    // Flipping status alone is not enough — the termination manager re-fires
    // `complete` on the very next watchdog tick while every mandatory
    // criterion is still EVIDENCED, so a reopen that does not invalidate
    // evidence closes again within a second. `criteria` (optional) narrows
    // which ones are reopened; omitted means every mandatory one.
    case "goal.reopened": {
      const goal = state.goals.get(p.goalId ?? event.goalId ?? state.activeGoalId ?? "");
      // ESCALATED belongs here too: `resumeGoal` only lifts PAUSED and
      // `respondEscalation` needs a card to answer, so an escalated mission
      // whose cards are stale (or whose escalation the operator wants to
      // overrule outright) had no way back to ACTIVE at all.
      if (goal && (goal.status === "COMPLETED" || goal.status === "FAILED" || goal.status === "ESCALATED")) {
        // Only a mission that reached a VERDICT has evidence worth
        // invalidating. An ESCALATED mission was halted mid-flight by an open
        // card, never judged, so blanket-resetting its mandatory criteria
        // would throw away accepted work the operator never rejected. There,
        // reopening invalidates only what `criteria` names explicitly.
        const hadVerdict = goal.status === "COMPLETED" || goal.status === "FAILED";
        goal.status = "ACTIVE";
        goal.completedAt = undefined;
        goal.reopenedAt = event.timestamp;
        const named = Array.isArray(p.criteria) && p.criteria.length > 0 ? new Set<string>(p.criteria as string[]) : null;
        for (const c of goal.acceptanceCriteria) {
          if (named ? !named.has(c.id) : !hadVerdict || !c.mandatory) continue;
          // Evidence is kept as an audit trail of the rejected attempt; only
          // the verdict is withdrawn, so the next round can cite or supersede
          // what was already produced.
          c.status = "UNSATISFIED";
          // ...but it must not be handed back UNCHANGED. Status-only reset let
          // the next round re-accept the very artifact the operator rejected:
          // one live mission ran 6 completes / 5 reopens re-citing
          // `TrackBench-Requirements-v2/1` and `TrackBench-MVP-CodePatch/1`
          // every time, closing within minutes and shipping nothing new.
          // Snapshot what was rejected so `markCriterionEvidence` can refuse it.
          const rejected = new Set(c.rejectedEvidence ?? []);
          for (const e of c.evidence) {
            if (e.artifactRef?.uri) rejected.add(e.artifactRef.uri);
          }
          if (rejected.size > 0) c.rejectedEvidence = [...rejected];
        }
        if (Array.isArray(p.addCriteria)) {
          for (const c of p.addCriteria as AcceptanceCriterion[]) {
            if (!goal.acceptanceCriteria.find((x) => x.id === c.id)) goal.acceptanceCriteria.push(c);
          }
        }
        state.goalHistory.push({ status: "ACTIVE", at: event.timestamp, reason: p.reason ?? "reopened by operator" });
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
