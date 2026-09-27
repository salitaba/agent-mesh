import type { MeshEvent } from "../../protocol/src/index";
import type { Projections } from "./state";
import type { AcceptanceCriterion, Goal } from "../../protocol/src/index";
import { ProjectionError, artifactForRef, isTerminalGoal } from "./projections-helpers";
import { criteriaWouldComplete } from "./termination";

/**
 * Progress is a FUNCTION of the acceptance criteria, not an independent
 * counter. It used to be written only by the `goal.progress` event, which is
 * emitted from exactly one place (`markCriterionEvidence`) — so any other path
 * that moves criteria (reopen, `requirement.blocked`, `requirements.created`)
 * left the number frozen at whatever the last satisfaction wrote. A live
 * mission reopened with all 16 mandatory criteria flipped back to UNSATISFIED
 * still reported `{completed:16,total:16,ratio:1}` on /status and 100% on the
 * dashboard, which is how a mission that had just reset to zero looked "done"
 * to the operator.
 *
 * Recomputing from the criteria makes the two views incapable of disagreeing.
 */
export function recomputeGoalProgress(state: Projections, goal: Goal, at: string): void {
  const mandatory = goal.acceptanceCriteria.filter((c) => c.mandatory);
  const completed = mandatory.filter((c) => c.status === "EVIDENCED" || c.status === "WAIVED").length;
  const total = mandatory.length;
  state.progress.set(goal.id, {
    completed,
    total,
    ratio: total ? completed / total : 0,
    updatedAt: at,
  });
}

/**
 * The criterion and verdict guards below restate the supervisor's own checks
 * (`markCriterionEvidence`, `removeCriterion`, `reviseCriterion`, the watchdog's
 * `complete` verdict) and run on a LIVE emit only -- see `ApplyOptions` in
 * projections.ts. Replay applies what the log holds, so a mission written by
 * older code still boots.
 */
export function applyGoalEvent(state: Projections, event: MeshEvent, p: Record<string, any>, opts: { live?: boolean } = {}): boolean {
  const live = opts.live === true;
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
      recomputeGoalProgress(state, goal, event.timestamp);
      break;
    }
    case "goal.status_changed": {
      const goal = state.goals.get(p.goalId);
      if (!goal) throw new ProjectionError(`unknown goal ${p.goalId}`, event.type);
      // A side door around the verdict guards on `goal.completed|failed`: the
      // only live emitter moves an ESCALATED goal back to ACTIVE. A verdict has
      // its own event (which checks the criteria), and a finished goal leaves
      // only through `goal.reopened`.
      if (live && (p.status === "COMPLETED" || p.status === "FAILED")) {
        throw new ProjectionError(`goal ${goal.id} cannot become ${p.status} by a status change; emit the verdict`, event.type);
      }
      if (live && isTerminalGoal(goal.status)) {
        throw new ProjectionError(`goal ${goal.id} is already ${goal.status}`, event.type);
      }
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
        // A reopen starts a new run, and everything stamped with the old
        // episode is now history rather than a live constraint. Bumped here,
        // in the reducer, so the ordinal is a function of the log: a replay
        // that counted reopens some other way could disagree with the mesh
        // that ran.
        goal.episodeOrdinal = (goal.episodeOrdinal ?? 1) + 1;
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
        // The whole point of a reopen is that progress went DOWN. Without
        // this the projection kept reporting the completed count from before
        // the reset — 16/16, ratio 1, on a mission that had just restarted.
        recomputeGoalProgress(state, goal, event.timestamp);
      }
      break;
    }
    case "goal.progress": {
      const gid = event.goalId ?? state.activeGoalId;
      if (!gid) break;
      // The goal record is authoritative when we have it: the payload is a
      // snapshot taken by the emitter and can only ever agree or be stale.
      // The payload path stays for events replayed from a log written before
      // the goal existed in this projection.
      const goal = state.goals.get(gid);
      if (goal) recomputeGoalProgress(state, goal, event.timestamp);
      else {
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
        // The watchdog emits a verdict only on a goal that has none yet
        // (`TerminationManager.evaluate` answers `continue` for COMPLETED and
        // FAILED), and a verdict leaves only through `goal.reopened`. A second
        // verdict landing on a finished mission would overwrite it -- a
        // `goal.failed` rewriting a delivered result as a failure.
        if (live && isTerminalGoal(goal.status)) {
          throw new ProjectionError(`goal ${goal.id} is already ${goal.status}`, event.type);
        }
        // And `complete` is only ever the verdict when every mandatory
        // criterion is satisfied -- by the termination manager's own rule, not
        // a copy of it.
        if (live && event.type === "goal.completed" && !criteriaWouldComplete(goal, goal.acceptanceCriteria)) {
          throw new ProjectionError(`goal ${goal.id} has mandatory criteria still unsatisfied`, event.type);
        }
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
        recomputeGoalProgress(state, goal, event.timestamp);
      }
      break;
    }
    case "requirement.blocked": {
      const goal = state.goals.get(event.goalId ?? state.activeGoalId ?? "");
      if (goal && p.criterionId) {
        const c = goal.acceptanceCriteria.find((x) => x.id === p.criterionId);
        if (c) c.status = "UNSATISFIED";
        recomputeGoalProgress(state, goal, event.timestamp);
      }
      break;
    }
    case "requirement.satisfied": {
      const goal = state.goals.get(event.goalId ?? state.activeGoalId ?? "");
      if (goal && p.criterionId) {
        const c = goal.acceptanceCriteria.find((x) => x.id === p.criterionId);
        if (c) {
          // `markCriterionEvidence`'s two identity gates. A reopened criterion
          // refuses the artifact the operator rejected -- otherwise the reopen
          // loop closes on the same URI -- and a VERIFIED claim on a mandatory
          // criterion refuses an artifact nobody ever submitted (DRAFT) or one
          // that was refused (REJECTED). Resolved with the same exact-match
          // `artifactForRef` the supervisor uses, against the state the event
          // lands on, which is the state the supervisor judged.
          const uri: string | undefined = p.evidence?.artifactRef?.uri;
          if (live && uri && c.rejectedEvidence?.includes(uri)) {
            throw new ProjectionError(`criterion ${c.id} refuses rejected evidence ${uri}`, event.type);
          }
          const claimedVerified = p.verified !== false && p.evidence?.verified !== false;
          if (live && claimedVerified && c.mandatory && uri) {
            const cited = artifactForRef(state, undefined, uri);
            if (cited && (cited.status === "DRAFT" || cited.status === "REJECTED")) {
              throw new ProjectionError(`criterion ${c.id} cannot be evidenced by ${cited.status} artifact ${cited.name}`, event.type);
            }
          }
          // An UNVERIFIED claim (the claiming turn invoked no verification
          // tool) is recorded but does NOT satisfy the criterion — see
          // CriterionStatus.ASSERTED. `verified !== false` keeps every event
          // written before this field existed satisfying, so replay of an old
          // log is unchanged.
          const verified = p.verified !== false && p.evidence?.verified !== false;
          // Never downgrade: a criterion already proven stays proven even if
          // some later turn asserts it again without checking.
          if (verified || c.status === "UNSATISFIED" || c.status === "ASSERTED") {
            c.status = verified ? "EVIDENCED" : "ASSERTED";
          }
          if (p.evidence) c.evidence.push(p.evidence);
        }
        recomputeGoalProgress(state, goal, event.timestamp);
      }
      break;
    }
    // The mission statement itself was rewritten mid-run. The event carries
    // `previous` so the log — not the goal record, which only ever holds the
    // latest text — is where "what were we aiming at when round 1 was
    // accepted" can still be answered.
    case "goal.description_revised": {
      const goal = state.goals.get(p.goalId ?? event.goalId ?? state.activeGoalId ?? "");
      if (goal && typeof p.description === "string" && p.description.trim()) {
        goal.description = p.description;
      }
      break;
    }
    case "requirement.revised": {
      const goal = state.goals.get(event.goalId ?? state.activeGoalId ?? "");
      if (goal && p.criterionId) {
        const c = goal.acceptanceCriteria.find((x) => x.id === p.criterionId);
        if (c) {
          // `reviseCriterion`'s demotion guard, which is removal's: dropping an
          // unproven criterion out of the mandatory set moves the denominator
          // exactly as deleting it would. See `requirement.removed`.
          if (live && p.mandatory === false && c.mandatory) {
            const remaining = goal.acceptanceCriteria.map((x) => (x.id === c.id ? { ...x, mandatory: false } : x));
            if (criteriaWouldComplete(goal, remaining) && !criteriaWouldComplete(goal, goal.acceptanceCriteria)) {
              throw new ProjectionError(`demoting ${c.id} would complete goal ${goal.id} without the work being done`, event.type);
            }
          }
          if (typeof p.description === "string" && p.description.trim()) c.description = p.description;
          if (typeof p.mandatory === "boolean") c.mandatory = p.mandatory;
        }
        // Not just cosmetic: flipping `mandatory` moves the denominator
        // progress is measured over even though no criterion changed status.
        recomputeGoalProgress(state, goal, event.timestamp);
      }
      break;
    }
    case "requirement.removed": {
      const goal = state.goals.get(event.goalId ?? state.activeGoalId ?? "");
      if (goal && p.criterionId) {
        const i = goal.acceptanceCriteria.findIndex((x) => x.id === p.criterionId);
        // The most dangerous event in this file: the mission is now judged
        // against fewer criteria than it was a moment ago, so a removal can
        // move a run toward done with no work finished.
        //
        // This reducer used to accept any removal and leave the refusal to
        // `Supervisor.removeCriterion`, on the grounds that a reducer that
        // dropped events would make replay disagree with the log. That is right
        // about REPLAY, and replay still applies whatever removal a log holds.
        // It is wrong about a LIVE emit: a refusal there throws before `append`,
        // so the event never reaches the log and there is nothing for a replay
        // to disagree with. What the old split allowed was a raw emit removing
        // the last unproven criterion. So, live, the supervisor's two refusals
        // are restated by its own `criteriaWouldComplete` rule:
        //
        //   1. never empty the mandatory set;
        //   2. never let the removal itself be what completes the goal.
        if (i >= 0 && live) {
          const removed = goal.acceptanceCriteria[i];
          const remaining = goal.acceptanceCriteria.filter((_, j) => j !== i);
          if (removed.mandatory && remaining.every((x) => !x.mandatory)) {
            throw new ProjectionError(`criterion ${removed.id} is the last mandatory criterion of goal ${goal.id}`, event.type);
          }
          if (criteriaWouldComplete(goal, remaining) && !criteriaWouldComplete(goal, goal.acceptanceCriteria)) {
            throw new ProjectionError(`removing ${removed.id} would complete goal ${goal.id} without the work being done`, event.type);
          }
        }
        if (i >= 0) goal.acceptanceCriteria.splice(i, 1);
        recomputeGoalProgress(state, goal, event.timestamp);
      }
      break;
    }
    default:
      return false;
  }
  return true;
}
