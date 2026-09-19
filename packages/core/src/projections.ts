import type { MeshEvent } from "../../protocol/src/index";
import type { CommitmentTtlConfig, Projections } from "./state";
import { applyGoalEvent } from "./projections-goal";
import { applyAgentEvent } from "./projections-agent";
import { applyMessagingEvent } from "./projections-messaging";
import { applyArtifactEvent } from "./projections-artifact";
import { applyWorkEvent } from "./projections-work";
import { applySystemEvent } from "./projections-system";

export { ProjectionError, planCoversHardOp } from "./projections-helpers";
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
   * - "compat": exact signals plus inference (same-thread, taskId,
   *   artifact-pointer matches).
   * - "strict": exact signals only — `replyTo`, `discharge`, operator,
   *   review verdicts, supersede, deadlock break, expiry, task completion.
   *   Inference is disabled: a response that only *looks* like an answer
   *   delivers content and wakes the asker, but discharges nothing.
   *
   * The resolved config defaults this to "strict" (`packages/config`). This
   * field stays optional, and an ABSENT config still reduces as "compat", for
   * one reason: every production caller passes a config (the kernel its
   * `gates`, the supervisor its `projectionConfig()`), so the only callers
   * that omit it are tests replaying a handful of events, and changing the
   * fallback would silently re-derive their expectations. Anything replaying
   * a real log must pass the mesh's own config or it rebuilds a different
   * history than the live mesh ran.
   */
  commitmentSemantic?: "compat" | "strict";
  /**
   * Deadline an ask opens with, by debtor role. Absent means no deadline.
   * Part of the projection config rather than a supervisor concern because
   * `dueBy` is written at open time inside the reducer — a deadline applied
   * afterwards would not survive replay.
   */
  commitmentTtl?: CommitmentTtlConfig;
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

  // Monotonic for the same reason as the kernel's writer: this is the
  // watermark a snapshot publishes as throughSeq, so it must never regress.
  state.lastEventSeq = Math.max(state.lastEventSeq, event.seq ?? state.lastEventSeq);
  state.lastEventAt = event.timestamp;
  state.eventCount++;
  if (event.actorId) {
    state.eventsSinceActivation.set(event.actorId, (state.eventsSinceActivation.get(event.actorId) ?? 0) + 1);
  }
}
