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
  approvalPath,
  approverMayAdvance,
  assertArtifactTransition,
  clearPendingForArtifactReview,
  gateSatisfiedWithConfig,
  hasPeerReviewerFor,
  pendingTargetsArtifact,
  recordApproval,
} from "./projections-helpers";

/** The `merge` field `opMerge` puts on a MERGED transition (`MergeProof` in supervisor.ts). */
function hasMergeProof(merge: unknown): boolean {
  if (!merge || typeof merge !== "object") return false;
  const m = merge as { via?: unknown; commit?: unknown; files?: unknown };
  if (m.via === "git") return typeof m.commit === "string" && m.commit.length > 0;
  if (m.via === "materialize") return typeof m.files === "string" && m.files.length > 0;
  return false;
}

/**
 * `recordDecision`'s self-approval screen: the owner may not approve (or pass)
 * their own artifact while another seat could have reviewed it. Before this the
 * reducer's only screen was `approverMayAdvance`, which asks whether the signer
 * could review this TYPE -- an owner holding `code.review` passed it, recorded
 * a signature on their own work, and moved it to APPROVED.
 *
 * Live emits only, like every supervisor-parity guard (see `ApplyOptions` in
 * projections.ts): a log that already holds such an approval still replays.
 *
 * `criterion:` subjects are exempt because the supervisor does not screen them:
 * accepting a criterion against an artifact is a requirements decision, taken
 * under `requirements.accept`, and the owner may hold that authority.
 */
function refuseSelfApproval(state: Projections, event: MeshEvent, p: Record<string, any>): void {
  if (!p.artifactId || String(p.subject ?? "").startsWith("criterion:")) return;
  const kind = event.type === "architecture.approved" ? "approve" : p.kind === "pass" ? "pass" : "approve";
  if (kind !== "approve" && kind !== "pass") return;
  const actor: string | undefined = event.actorId ?? p.actorId;
  const a = state.artifacts.get(p.artifactId);
  if (!a || !actor || a.owner !== actor) return;
  if (hasPeerReviewerFor(state, actor, a)) {
    throw new ProjectionError(`artifact owner ${actor} cannot approve their own artifact ${a.id} while a peer reviewer exists`, event.type);
  }
}

/**
 * `Supervisor.amendableDraft`'s preconditions, restated for the log: an amend
 * rewrites the version it names only while that version is an unreviewed DRAFT
 * of the same owner. Anything else would rewrite content somebody may already
 * have signed, so a raw emit of one is refused. Live emits only, like every
 * supervisor-parity guard here.
 */
function refuseAmend(state: Projections, event: MeshEvent, next: Artifact, amends: unknown): void {
  const cur = state.artifacts.get(next.id);
  const actor = event.actorId;
  const why =
    !cur ? `unknown artifact ${next.id}`
    : amends !== cur.version || next.version !== cur.version ? `amend names v${String(amends)} but ${cur.name} is at v${cur.version}`
    : cur.status !== "DRAFT" ? `${cur.name} v${cur.version} is ${cur.status}; only a DRAFT may be amended`
    : actor && actor !== "human" && actor !== cur.owner ? `${actor} does not own ${cur.name}`
    : [...state.approvals.values()].some((list) => list.some((r) => r.artifactId === cur.id)) ? `${cur.name} v${cur.version} already carries a verdict`
    : undefined;
  if (why) throw new ProjectionError(`cannot amend: ${why}`, event.type);
}

function doTransition(
  state: Projections,
  event: MeshEvent,
  artifactId: string,
  to: ArtifactStatus,
  gateSatisfied: boolean,
  config?: { transitionGates?: Record<string, string[]> },
  live = false,
): void {
  const a = state.artifacts.get(artifactId);
  if (!a) throw new ProjectionError(`unknown artifact ${artifactId}`, event.type);
  // No same-status shortcut on a live emit. `if (a.status === to) return;`
  // used to sit here unconditionally, ahead of the machine and the gate, so a
  // MERGED -> MERGED duplicate (the one `opMerge` names) was absorbed as a
  // no-op and still appended to the log as if it had been legal. Live, the
  // machine -- which has no self-edges -- now refuses it. On replay the
  // shortcut stays: logs written before this hold such duplicates and must
  // still boot. The reducer's own callers already skip a move to where the
  // artifact already is.
  //
  // The one same-status event the supervisor does emit is `auditTransition`'s
  // `derived: true` record: bookkeeping that mirrors a move the reducer ALREADY
  // applied (an approval that advanced the artifact), so it lands on the status
  // it names by construction. That is a log record, not a move, and stays a
  // no-op.
  if (a.status === to && (!live || (event.payload as { derived?: unknown } | undefined)?.derived === true)) return;
  const from = a.status as ArtifactStatus;
  assertArtifactTransition(a.type, from, to, gateSatisfiedWithConfig(state, a, to, gateSatisfied, config));
  // MERGED must carry proof a merge ran. The ladder and the gate say whether a
  // merge is ALLOWED; neither says one HAPPENED, so a raw `artifact.transition`
  // to MERGED (or a public transition that skipped `opMerge`) recorded work
  // landing that never touched the product. `opMerge` attaches `merge` only
  // after git merged (`{ via: "git", commit }`) or the no-git path wrote the
  // files (`{ via: "materialize" }`). The reducer cannot run git, so this is a
  // proof-carrying check, not a verification -- it closes the doors that emit
  // without merging.
  //
  // LIVE emits only. Every log written before the marker existed has
  // proof-less MERGED transitions, and those were accepted when they were
  // written; refusing them on replay would stop a restarted mesh from booting
  // the mission it already has. The kernel sets `live` on `applyAndAppend`
  // alone, so this guards what is appended from now on and nothing older.
  if (live && to === "MERGED" && !hasMergeProof((event.payload as { merge?: unknown } | undefined)?.merge)) {
    throw new ProjectionError(`artifact ${a.name} cannot become MERGED without a merge: the transition carries no merge proof`, event.type);
  }
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


export function applyArtifactEvent(
  state: Projections,
  event: MeshEvent,
  p: Record<string, any>,
  config?: { transitionGates?: Record<string, string[]> },
  opts?: { live?: boolean },
): boolean {
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
      if (p.amends !== undefined) {
        // An AMEND: the same version, rewritten in place, because its author
        // republished it within the turn that created it before anyone could
        // review, cite or read it (see `Supervisor.amendableDraft`). It carries
        // no verdict to drop and no review round to reset, and it must not add
        // a history entry — the version it names is still the current one.
        if (opts?.live) refuseAmend(state, event, a, p.amends);
        state.artifacts.set(a.id, a);
        state.artifactByName.set(artifactKey(a.type, a.name), a);
        const amended = state.artifactHistory.get(a.id) ?? [];
        if (amended.length > 0 && amended[amended.length - 1]!.version === a.version) amended[amended.length - 1] = a;
        else amended.push(a);
        state.artifactHistory.set(a.id, amended);
        break;
      }
      state.artifacts.set(a.id, a);
      state.artifactByName.set(artifactKey(a.type, a.name), a);
      const hist = state.artifactHistory.get(a.id) ?? [];
      hist.push(a);
      state.artifactHistory.set(a.id, hist);
      // A new version restarts the review cycle, so the old round count must not
      // ride along. `doTransition` only clears this on a SETTLED status, and a
      // version bump lands on DRAFT, which is not settled — so rounds accumulated
      // across versions and walked the artifact toward
      // `escalation.artifactReviewRoundsMax` for reviews of content that no longer
      // existed. Reviewers are answering against v(n); the rounds spent on v(n-1)
      // are not rounds spent on this.
      state.reviewRounds.delete(a.id);
      // EVERY verdict on the predecessor is dropped, not just the blocks.
      //
      // `createArtifact`'s own comment states the rule — "a version is new content
      // ... so it must not carry the predecessor's verdict" — and clears
      // `contentRef` and `digest` to enforce it. But this reducer kept `approve`
      // and `pass` records, and `ApprovalRecord` carries no version, so
      // `hasApprovalForArtifact(id, "approve")` still answered true for content
      // nobody had read. A v1 approval therefore pre-satisfied the `to ===
      // "APPROVED"` precondition for v2 and would satisfy a configured
      // `patch.approve` gate as well.
      //
      // Measured 2026-09-23 and 2026-09-24: an artifact that reached APPROVED was
      // re-versioned by its author, silently lost its review state, and the stale
      // signature stayed valid for the new content. Dropping blocks alone was the
      // half of this that had already been noticed — a block is remembered as
      // harmful to lose, an approval as harmless to keep, and only one of those is
      // true.
      for (const [key, list] of state.approvals) {
        const kept = list.filter((r) => r.artifactId !== a.id);
        if (kept.length !== list.length) {
          if (kept.length === 0) state.approvals.delete(key);
          else state.approvals.set(key, kept);
        }
      }
      break;
    }
    case "artifact.transition": {
      doTransition(state, event, p.artifactId, p.to as ArtifactStatus, p.gateSatisfied !== false, config, opts?.live === true);
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
      if (opts?.live) refuseSelfApproval(state, event, p);
      recordApproval(state, p, event, p.kind === "pass" ? "pass" : "approve");
      if (p.artifactId && event.actorId) clearPendingForArtifactReview(state, p.artifactId, event.actorId, event.timestamp);
      const a = p.artifactId ? state.artifacts.get(p.artifactId) : undefined;
      // The verdict is recorded above whatever happens — a gate signature is
      // worth keeping even from a seat that may not settle the artifact. Only
      // the MOVE is screened. See `approverMayAdvance`.
      if (a && approverMayAdvance(state, event.actorId, a) && (a.status === "UNDER_REVIEW" || a.status === "READY_FOR_REVIEW")) {
        for (const to of approvalPath(a.type, a.status)) {
          doTransition(state, event, a.id, to, true, config);
        }
      }
      break;
    }
    case "review.rejected": {
      recordApproval(state, p, event, "reject");
      if (p.artifactId && event.actorId) clearPendingForArtifactReview(state, p.artifactId, event.actorId, event.timestamp);
      const a = p.artifactId ? state.artifacts.get(p.artifactId) : undefined;
      if (a && a.status === "UNDER_REVIEW") {
        doTransition(state, event, a.id, "REJECTED", true, config);
      }
      break;
    }
    case "architecture.approved": {
      // A derived notice (`recordDecision` since 2026-09-26): the approval is the
      // `review.approved` this event names in `viaEvent`, whose reducer already
      // recorded it and moved the artifact. Applying it again would count one
      // approval twice. No older log carries `derived` here, so replay is exact.
      if (p.derived === true) break;
      if (opts?.live) refuseSelfApproval(state, event, p);
      recordApproval(state, p, event, "approve");
      if (p.artifactId && event.actorId) clearPendingForArtifactReview(state, p.artifactId, event.actorId, event.timestamp);
      const a = p.artifactId ? state.artifacts.get(p.artifactId) : undefined;
      // `approvalPath` rather than a hardcoded "APPROVED": ask the machine
      // where an approval lands instead of asserting it, the same way
      // `review.approved` does. For UNDER_REVIEW the two agree on every
      // machine that has the state, so this is a no-op today and stays correct
      // if a machine ever changes.
      //
      // The guard stays UNDER_REVIEW-only, and NOT because the asymmetry with
      // `review.approved` (which also settles from READY_FOR_REVIEW) is
      // intended. Widening it changes how existing logs project: a document
      // approved while merely READY_FOR_REVIEW advances to FINAL, and a real
      // mission log then replays a later READY_FOR_REVIEW transition that used
      // to be absorbed as a no-op and is now illegal — caught by
      // tests/integration/resume-storm. Replay equality is the property the
      // event store rests on, so it outranks the inconsistency.
      //
      // What actually stranded nine artifacts in a live mission was upstream:
      // they were never submitted for review at all, so an approval had
      // nothing to advance. Approving an artifact that is not under review is
      // still silently inert here, and that is the part worth surfacing — at
      // the op path, where a refusal can reach the agent.
      if (a && approverMayAdvance(state, event.actorId, a) && a.status === "UNDER_REVIEW") {
        for (const to of approvalPath(a.type, a.status)) {
          doTransition(state, event, a.id, to, true, config);
        }
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
      // `mirrorTransition` emits this only once a CodePatch has reached MERGED,
      // and the `implementation|pass` it records feeds gates. On anything that
      // has not landed it would be a signature for work that is not in the
      // product.
      const a = p.artifactId ? state.artifacts.get(p.artifactId) : undefined;
      if (opts?.live && (!a || a.status !== "MERGED")) {
        throw new ProjectionError(`implementation.completed on ${a ? `${a.status} artifact ${a.id}` : `unknown artifact ${p.artifactId}`}; only a MERGED patch completes`, event.type);
      }
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
