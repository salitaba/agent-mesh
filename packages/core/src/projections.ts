import type { MeshEvent } from "../../protocol/src/index";
import type { Projections } from "./state";
import { applyGoalEvent } from "./projections-goal";
import { applyAgentEvent } from "./projections-agent";
import { applyMessagingEvent } from "./projections-messaging";
import { applyArtifactEvent } from "./projections-artifact";
import { applyWorkEvent } from "./projections-work";
import { applySystemEvent } from "./projections-system";

export { ProjectionError } from "./projections-helpers";
export {
  transitionLifecycle,
  assertArtifactTransition,
  hasApproval,
  hasApprovalForArtifact,
  gateForTransition,
  parseGateTokens,
  checkApprovals,
  isTerminalGoal,
  recordApproval,
  holdsAuthority,
  hasPeerReviewerFor,
  capabilityForReview,
  domainOfSubject,
  artifactForRef,
  clearPendingForArtifactReview,
  clearPendingForTask,
  bumpConflict,
  fingerprintOf,
  pendingTargetsArtifact,
  gateSatisfiedWithConfig,
  type ApprovalToken,
} from "./projections-helpers";

export interface ProjectionConfig {
  transitionGates?: Record<string, string[]>;
  /**
   * Commitment semantic for ask discharge.
   *
   * - "compat" (default): exact signals plus inference (same-thread, taskId,
   *   artifact-pointer matches).
   * - "strict": exact signals only — `replyTo`, `discharge`, operator,
   *   review verdicts, supersede, deadlock break, task completion. Inference
   *   is disabled: a response that only *looks* like an answer delivers
   *   content and wakes the asker, but discharges nothing.
   */
  commitmentSemantic?: "compat" | "strict";
}

export function isStrictCommitments(config?: ProjectionConfig): boolean {
  return config?.commitmentSemantic === "strict";
}

export function applyEvent(state: Projections, event: MeshEvent, config?: ProjectionConfig): void {
  const p = structuredClone((event.payload ?? {}) as Record<string, any>);
  if (applyGoalEvent(state, event, p)) { /* handled */ }
  else if (applyAgentEvent(state, event, p)) { /* handled */ }
  else if (applyMessagingEvent(state, event, p, config)) { /* handled */ }
  else if (applyArtifactEvent(state, event, p, config)) { /* handled */ }
  else if (applyWorkEvent(state, event, p)) { /* handled */ }
  else if (applySystemEvent(state, event, p)) { /* handled */ }
  else {
    // Unknown / no-op event types (patch.created, release.candidate, etc.)
  }

  state.lastEventSeq = event.seq ?? state.lastEventSeq;
  state.lastEventAt = event.timestamp;
  state.eventCount++;
  if (event.actorId) {
    state.eventsSinceActivation.set(event.actorId, (state.eventsSinceActivation.get(event.actorId) ?? 0) + 1);
  }
}
