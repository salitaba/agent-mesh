import type { Artifact, ArtifactStatus, MeshEvent } from "../../protocol/src/index";
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
      recordApproval(state, p, event, "approve");
      if (p.artifactId && event.actorId) clearPendingForArtifactReview(state, p.artifactId, event.actorId);
      const a = p.artifactId ? state.artifacts.get(p.artifactId) : undefined;
      if (a && (a.status === "UNDER_REVIEW" || a.status === "READY_FOR_REVIEW") && (a.type === "ArchitectureDocument" || a.type === "CodePatch" || a.type === "ApiSpec")) {
        doTransition(state, event, a.id, "APPROVED", true, config);
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
