import {
  MACHINE_TRANSITIONS,
  artifactMachineOf,
  isSettledArtifactStatus,
  type Artifact,
  type ArtifactStatus,
  type ArtifactType,
  type MeshEvent,
} from "../../protocol/src/index";
import type { Projections } from "./state";
import { MAX_ARTIFACT_HISTORY, artifactKey, dischargeCommitment } from "./state";
import {
  ProjectionError,
  assertArtifactTransition,
  clearPendingForArtifactReview,
  gateSatisfiedWithConfig,
  pendingTargetsArtifact,
  recordApproval,
} from "./projections-helpers";

function doTransition(
  state: Projections,
  event: MeshEvent,
  artifactId: string,
  to: ArtifactStatus,
  gateSatisfied: boolean,
  config?: { transitionGates?: Record<string, string[]> },
): void {
  const a = state.artifacts.get(artifactId);
  if (!a) throw new ProjectionError(`unknown artifact ${artifactId}`, event.type);
  if (a.status === to) return;
  const from = a.status as ArtifactStatus;
  assertArtifactTransition(a.type, from, to, gateSatisfiedWithConfig(state, a, to, gateSatisfied, config));
  const next: Artifact = { ...a, status: to };
  state.artifacts.set(a.id, next);
  state.artifactByName.set(artifactKey(next.type, next.name), next);
  const hist = state.artifactHistory.get(a.id) ?? [];
  hist.push(next);
  state.artifactHistory.set(a.id, hist);
  if (to === "UNDER_REVIEW") {
    state.reviewRounds.set(a.id, (state.reviewRounds.get(a.id) ?? 0) + 1);
  }
  if (isSettledArtifactStatus(to)) {
    state.reviewRounds.delete(a.id);
  }
  if (to === "MERGED") {
    const lease = state.activeLeaseByArtifact.get(a.id);
    if (lease) {
      state.activeLeaseByArtifact.delete(a.id);
      const l = state.leases.get(lease);
      if (l) l.releasedAt = event.timestamp;
    }
  }
  if (to === "APPROVED" || to === "REJECTED" || to === "MERGED" || to === "ACCEPTED" || to === "FINAL" || to === "VERIFIED") {
    const decider = event.actorId;
    if (decider) clearPendingForArtifactReview(state, a.id, decider, event.timestamp);
    else {
      for (const [pid, pr] of [...state.pendingRequests]) {
        if (pr.type.startsWith("REQUEST") && pendingTargetsArtifact(state, pr, a.id)) {
          dischargeCommitment(state, pid, "artifact_review", "system", event.timestamp);
        }
      }
    }
  }
}

// An approval must not be inert: a document approved while it sits in
// READY_FOR_REVIEW (no tracked review round) used to record the verdict and
// stay open forever. Take the machine's terminal review edge instead.
//
// That fix originally reached only the READY_FOR_REVIEW branch, and the normal
// flow races straight past it: `request_review` drives DRAFT ->
// READY_FOR_REVIEW -> UNDER_REVIEW before any reviewer answers, so by decision
// time the artifact is always in the other branch. There a hardcoded whitelist
// dropped every type but three on the floor. The verdict was recorded and the
// reviewer's pending cleared, but the artifact never moved -- and it could not
// be reopened either, because nothing had been closed. It just sat in
// UNDER_REVIEW looking busy, which no stall check is built to notice.
//
// The whitelist was never guarding a machine invariant: every machine that has
// an UNDER_REVIEW state already declares UNDER_REVIEW -> APPROVED legal (`code`
// and `document` both; `release` has no such state), so assertArtifactTransition
// would have admitted each of these. Ask the machine, not a type list.
function approvalPath(type: ArtifactType, status: ArtifactStatus): ArtifactStatus[] {
  const allowed = MACHINE_TRANSITIONS[artifactMachineOf(type)][status] ?? [];
  if (allowed.includes("APPROVED")) return ["APPROVED"];
  if (allowed.includes("FINAL")) return ["FINAL"];
  return [];
}

export function applyArtifactEvent(state: Projections, event: MeshEvent, p: Record<string, any>, config?: { transitionGates?: Record<string, string[]> }): boolean {
  switch (event.type) {
    case "artifact.created": {
      const a = p.artifact as Artifact;
      state.artifacts.set(a.id, a);
      state.artifactByName.set(artifactKey(a.type, a.name), a);
      const hist = state.artifactHistory.get(a.id) ?? [];
      hist.push(a);
      state.artifactHistory.set(a.id, hist);
      const owner = state.agents.get(a.owner);
      if (owner && !owner.state.currentArtifactIds.includes(a.id)) {
        owner.state.currentArtifactIds.push(a.id);
      }
      break;
    }
    case "artifact.versioned": {
      const a = p.artifact as Artifact;
      state.artifacts.set(a.id, a);
      state.artifactByName.set(artifactKey(a.type, a.name), a);
      const hist = state.artifactHistory.get(a.id) ?? [];
      hist.push(a);
      state.artifactHistory.set(a.id, hist);
      for (const [key, list] of state.approvals) {
        const kept = list.filter((r) => !(r.kind === "block" && r.artifactId === a.id));
        if (kept.length !== list.length) {
          if (kept.length === 0) state.approvals.delete(key);
          else state.approvals.set(key, kept);
        }
      }
      break;
    }
    case "artifact.transition": {
      doTransition(state, event, p.artifactId, p.to as ArtifactStatus, p.gateSatisfied !== false, config);
      break;
    }
    case "patch.created": {
      break;
    }
    case "patch.ready": {
      // A ready announcement naming an artifact the log does not hold is a
      // divergence, not a no-op. The supervisor resolves the ref BEFORE it
      // emits (an unresolvable one is refused as
      // `patch.ready.unresolved-artifact` and never reaches here), so an
      // unknown id at this point means state and log disagree. Swallowing it
      // left the patch in DRAFT while the sender believed review had been
      // asked for — refuse it the way every other artifact-bearing case does.
      // An announcement carrying no id at all is left alone: older logs
      // predate the resolution fix and must still replay.
      if (p.artifactId && !state.artifacts.get(p.artifactId)) {
        throw new ProjectionError(`unknown artifact ${p.artifactId}`, event.type);
      }
      const a = p.artifactId ? state.artifacts.get(p.artifactId) : undefined;
      if (a && a.status === "DRAFT") {
        doTransition(state, event, a.id, "READY_FOR_REVIEW", true, config);
      }
      break;
    }
    case "patch.merged": {
      break;
    }
    case "review.requested": {
      const a = p.artifactId ? state.artifacts.get(p.artifactId) : undefined;
      if (a && a.status === "DRAFT") {
        doTransition(state, event, a.id, "READY_FOR_REVIEW", true, config);
      }
      const a2 = a ? state.artifacts.get(a.id) : undefined;
      if (a2 && a2.status === "READY_FOR_REVIEW") {
        doTransition(state, event, a2.id, "UNDER_REVIEW", true, config);
      }
      break;
    }
    case "review.approved": {
      // `pass` and `approve` both ride this event type; record what the actor
      // actually declared so a `<role>.pass` gate can be satisfied by a real
      // sign-off. Older logs carry no kind and replay as `approve`.
      recordApproval(state, p, event, p.kind === "pass" ? "pass" : "approve");
      if (p.artifactId && event.actorId) clearPendingForArtifactReview(state, p.artifactId, event.actorId);
      const a = p.artifactId ? state.artifacts.get(p.artifactId) : undefined;
      if (a && (a.status === "UNDER_REVIEW" || a.status === "READY_FOR_REVIEW")) {
        for (const to of approvalPath(a.type, a.status)) {
          doTransition(state, event, a.id, to, true, config);
        }
      }
      break;
    }
    case "review.rejected": {
      recordApproval(state, p, event, "reject");
      if (p.artifactId && event.actorId) clearPendingForArtifactReview(state, p.artifactId, event.actorId);
      const a = p.artifactId ? state.artifacts.get(p.artifactId) : undefined;
      if (a && a.status === "UNDER_REVIEW") {
        doTransition(state, event, a.id, "REJECTED", true, config);
      }
      break;
    }
    case "architecture.approved": {
      recordApproval(state, p, event, "approve");
      if (p.artifactId && event.actorId) clearPendingForArtifactReview(state, p.artifactId, event.actorId);
      const a = p.artifactId ? state.artifacts.get(p.artifactId) : undefined;
      if (a && a.status === "UNDER_REVIEW") {
        doTransition(state, event, a.id, "APPROVED", true, config);
      }
      break;
    }
    case "release.candidate": {
      break;
    }
    case "release.transition": {
      const a = p.artifactId ? state.artifacts.get(p.artifactId) : undefined;
      if (a && p.to && a.status !== p.to) {
        doTransition(state, event, a.id, p.to as ArtifactStatus, p.gateSatisfied !== false, config);
      }
      break;
    }
    case "release.accepted": {
      recordApproval(state, p, event, "accept");
      break;
    }
    case "implementation.completed": {
      recordApproval(state, p, event, "pass");
      break;
    }
    default:
      return false;
  }
  for (const [id, hist] of state.artifactHistory) {
    if (hist.length > MAX_ARTIFACT_HISTORY) state.artifactHistory.set(id, hist.slice(-MAX_ARTIFACT_HISTORY));
  }
  return true;
}
