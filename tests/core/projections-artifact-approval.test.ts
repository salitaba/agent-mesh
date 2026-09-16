import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEvent } from "../../packages/core/src/projections";
import { createInitialState, type Projections } from "../../packages/core/src/state";
import {
  PROTOCOL_VERSION,
  isSettledArtifactStatus,
  type Artifact,
  type ArtifactStatus,
  type ArtifactType,
  type MeshEvent,
} from "../../packages/protocol/src/index";

/**
 * Approval must move the artifact, for every type that can be reviewed.
 *
 * `approvalPath` used to branch on a hardcoded whitelist of three types when
 * the artifact sat in UNDER_REVIEW, and UNDER_REVIEW is exactly where the
 * normal flow puts it: `review.requested` drives DRAFT -> READY_FOR_REVIEW ->
 * UNDER_REVIEW in one handler, before any reviewer can answer. So an approval
 * on an ADR, a RequirementsDoc, a Requirement or a DisagreementRecord recorded
 * its verdict, cleared the reviewer's pending commitment, and left the artifact
 * open forever.
 *
 * It was invisible from every angle an operator has. The artifact was not
 * blocked and not idle, so the scheduler's unanswered-request nudge, the
 * reviewRounds cap and the mission-quiet stall check were all satisfied. The
 * only symptom was a mission that would not converge, with a pile of artifacts
 * sitting in review that nobody was actually waiting on.
 *
 * Two things made it read as flaky rather than deterministic, and both are
 * pinned below: `review.rejected` transitions unconditionally, so the same
 * reviewer on the same artifact could reject but not approve; and an approval
 * that happened to land while the artifact was still READY_FOR_REVIEW took the
 * other branch and settled correctly. Same type, opposite outcome, decided by
 * message ordering.
 */

const GOAL_ID = "goal-approval";

let seq = 0;
function evt(type: string, payload: Record<string, unknown>, over: Partial<MeshEvent> = {}): MeshEvent {
  seq++;
  return {
    id: over.id ?? `evt-approval-${seq}`,
    protocolVersion: PROTOCOL_VERSION,
    type: type as MeshEvent["type"],
    timestamp: over.timestamp ?? `2026-03-01T00:00:${String(seq % 60).padStart(2, "0")}.000Z`,
    goalId: over.goalId ?? GOAL_ID,
    actorId: over.actorId ?? "reviewer",
    seq,
    payload,
  } as MeshEvent;
}

function seedArtifact(state: Projections, type: ArtifactType, id: string): void {
  const a = {
    id,
    name: `${id} fixture`,
    type,
    goalId: GOAL_ID,
    owner: "author",
    version: 1,
    status: "DRAFT",
  } as unknown as Artifact;
  applyEvent(state, evt("artifact.created", { artifact: a }, { actorId: "author" }));
}

function statusOf(state: Projections, id: string): ArtifactStatus {
  const a = state.artifacts.get(id);
  assert.ok(a, `artifact ${id} missing from projections`);
  return a.status as ArtifactStatus;
}

/** Every `document`-machine type the old whitelist dropped on the floor. */
const PREVIOUSLY_STRANDED: ArtifactType[] = [
  "ADR",
  "Requirement",
  "RequirementsDoc",
  "DisagreementRecord",
  "DatabaseSchema",
  "TestReport",
  "SecurityReport",
  "ResearchReport",
  "Decision",
  "TaskSpec",
  "BenchmarkResult",
];

/** The three the old whitelist happened to name. These must not change. */
const ALWAYS_WORKED: ArtifactType[] = ["ArchitectureDocument", "ApiSpec", "CodePatch"];

for (const type of [...PREVIOUSLY_STRANDED, ...ALWAYS_WORKED]) {
  test(`an approval on an UNDER_REVIEW ${type} settles it rather than recording an inert verdict`, () => {
    const state = createInitialState();
    const id = `art-${type}`;
    seedArtifact(state, type, id);

    applyEvent(state, evt("review.requested", { artifactId: id }, { actorId: "author" }));
    assert.equal(statusOf(state, id), "UNDER_REVIEW", "request_review should land in UNDER_REVIEW");

    applyEvent(state, evt("review.approved", { artifactId: id }, { actorId: "reviewer" }));

    assert.equal(statusOf(state, id), "APPROVED", `${type} stayed open after an approval`);
    assert.ok(isSettledArtifactStatus(statusOf(state, id)), `${type} did not reach a settled status`);
    assert.equal(state.reviewRounds.get(id), undefined, "a settled artifact keeps no open review round");
  });
}

test("approve and reject reach the same terminal edge for a document (a reviewer could previously only reject)", () => {
  const state = createInitialState();
  seedArtifact(state, "RequirementsDoc", "art-yes");
  seedArtifact(state, "RequirementsDoc", "art-no");

  for (const id of ["art-yes", "art-no"]) {
    applyEvent(state, evt("review.requested", { artifactId: id }, { actorId: "author" }));
  }
  applyEvent(state, evt("review.approved", { artifactId: "art-yes" }, { actorId: "reviewer" }));
  applyEvent(state, evt("review.rejected", { artifactId: "art-no" }, { actorId: "reviewer" }));

  assert.equal(statusOf(state, "art-yes"), "APPROVED");
  assert.equal(statusOf(state, "art-no"), "REJECTED");
});

test("a document approved while still READY_FOR_REVIEW takes the machine's FINAL edge, as before", () => {
  const state = createInitialState();
  seedArtifact(state, "RequirementsDoc", "art-early");

  applyEvent(state, evt("artifact.transition", { artifactId: "art-early", to: "READY_FOR_REVIEW" }, { actorId: "author" }));
  assert.equal(statusOf(state, "art-early"), "READY_FOR_REVIEW");

  applyEvent(state, evt("review.approved", { artifactId: "art-early" }, { actorId: "reviewer" }));
  assert.equal(statusOf(state, "art-early"), "FINAL");
});

test("neither review path leaves a document open, whichever status the approval races into", () => {
  const outcomes = ["READY_FOR_REVIEW", "UNDER_REVIEW"].map((at) => {
    const state = createInitialState();
    const id = `art-${at}`;
    seedArtifact(state, "Requirement", id);
    applyEvent(state, evt("artifact.transition", { artifactId: id, to: "READY_FOR_REVIEW" }, { actorId: "author" }));
    if (at === "UNDER_REVIEW") {
      applyEvent(state, evt("artifact.transition", { artifactId: id, to: "UNDER_REVIEW" }, { actorId: "author" }));
    }
    applyEvent(state, evt("review.approved", { artifactId: id }, { actorId: "reviewer" }));
    return statusOf(state, id);
  });

  for (const status of outcomes) {
    assert.ok(isSettledArtifactStatus(status), `approval left the artifact at ${status}`);
  }
});

test("an ADR still settles when it arrives on the architecture.approved path", () => {
  const state = createInitialState();
  seedArtifact(state, "ADR", "art-adr");
  applyEvent(state, evt("review.requested", { artifactId: "art-adr" }, { actorId: "author" }));
  applyEvent(state, evt("architecture.approved", { artifactId: "art-adr" }, { actorId: "architect" }));
  assert.equal(statusOf(state, "art-adr"), "APPROVED");
});

test("a ReleasePlan has no UNDER_REVIEW state, so an approval on it moves nothing", () => {
  const state = createInitialState();
  const a = {
    id: "art-release",
    name: "release plan fixture",
    type: "ReleasePlan",
    goalId: GOAL_ID,
    owner: "author",
    version: 1,
    status: "PROPOSED",
  } as unknown as Artifact;
  applyEvent(state, evt("artifact.created", { artifact: a }, { actorId: "author" }));

  applyEvent(state, evt("review.approved", { artifactId: "art-release" }, { actorId: "reviewer" }));
  assert.equal(statusOf(state, "art-release"), "PROPOSED");
});
