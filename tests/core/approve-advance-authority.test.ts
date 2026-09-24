import { test } from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL_VERSION, type Artifact, type ArtifactStatus, type ArtifactType, type MeshEvent } from "../../packages/protocol/src/index";
import { applyEvent, REVIEW_CAPABILITIES, subjectForArtifactType } from "../../packages/core/src/projections";
import { createInitialState, type Projections } from "../../packages/core/src/state";

/**
 * Recording a verdict and MOVING an artifact are different powers.
 *
 * Live evidence: a PM holding nothing but `repository.read` and
 * `requirements.approve` recorded `{op: "approve", subject: "requirements"}`
 * against an ApiSpec authored by another seat, and the ApiSpec advanced to
 * APPROVED. The subject word decided the authority domain, so the question
 * asked was "does this seat hold requirements.approve?" and never "may it
 * review an ApiSpec?". The identical state change is refused through
 * `transition_artifact`, which asks the artifact first.
 *
 * The subject naming a capacity is not the bug and must keep working — QA
 * signing `subject: "quality"` on a CodePatch is how every `<role>.approve`
 * gate is satisfied. What must not follow from a capacity claim is the power
 * to settle an artifact the claimant could never review.
 */

const GOAL_ID = "goal-advance";

let seq = 0;
function evt(type: string, payload: Record<string, unknown>, over: Partial<MeshEvent> = {}): MeshEvent {
  seq++;
  return {
    id: over.id ?? `evt-advance-${seq}`,
    protocolVersion: PROTOCOL_VERSION,
    type: type as MeshEvent["type"],
    timestamp: over.timestamp ?? `2026-03-01T00:00:${String(seq % 60).padStart(2, "0")}.000Z`,
    goalId: over.goalId ?? GOAL_ID,
    actorId: over.actorId,
    seq,
    payload,
  } as MeshEvent;
}

function agent(id: string, authority: string[], capabilities: string[]): Record<string, unknown> {
  return {
    id,
    role: id,
    mode: "peer",
    runtime: "stub",
    prompt: { text: `${id} seat` },
    capabilities,
    authority,
    communicationPolicy: { mayContact: [], mayBeContactedBy: [] },
    interests: [],
    sessionPolicy: { persistent: false },
  };
}

function seedArtifact(state: Projections, type: ArtifactType, id: string, owner: string): void {
  const a = { id, name: `${id} fixture`, type, goalId: GOAL_ID, owner, version: 1, status: "DRAFT" } as unknown as Artifact;
  applyEvent(state, evt("artifact.created", { artifact: a }, { actorId: owner }));
}

function statusOf(state: Projections, id: string): ArtifactStatus {
  const a = state.artifacts.get(id);
  assert.ok(a, `artifact ${id} missing`);
  return a.status as ArtifactStatus;
}

/** A mesh with a real reviewer in it, so the control-group carve-out is not what is being measured. */
function meshWithPeers(): Projections {
  const state = createInitialState();
  applyEvent(state, evt("agent.created", { agent: agent("pm", ["requirements.approve"], ["repository.read"]) }));
  applyEvent(state, evt("agent.created", { agent: agent("architect", ["architecture.approve"], ["repository.read", "review.design"]) }));
  applyEvent(state, evt("agent.created", { agent: agent("marketing", [], ["repository.read"]) }));
  return state;
}

test("a domain authority does not let a seat settle an artifact it could never review", () => {
  const state = meshWithPeers();
  seedArtifact(state, "ApiSpec", "art-spec", "marketing");
  applyEvent(state, evt("review.requested", { artifactId: "art-spec" }, { actorId: "marketing" }));
  assert.equal(statusOf(state, "art-spec"), "UNDER_REVIEW");

  // Exactly the live-run op: the requirements domain named, an ApiSpec attached.
  applyEvent(state, evt("review.approved", { artifactId: "art-spec", subject: "requirements", kind: "approve" }, { actorId: "pm" }));

  assert.equal(
    statusOf(state, "art-spec"),
    "UNDER_REVIEW",
    "an ApiSpec must not reach APPROVED on requirements authority alone",
  );
});

test("the verdict is still recorded, because a signature is worth keeping even when it cannot settle", () => {
  const state = meshWithPeers();
  seedArtifact(state, "ApiSpec", "art-spec2", "marketing");
  applyEvent(state, evt("review.requested", { artifactId: "art-spec2" }, { actorId: "marketing" }));
  applyEvent(state, evt("review.approved", { artifactId: "art-spec2", subject: "requirements", kind: "approve" }, { actorId: "pm" }));

  const recorded = [...state.approvals.values()].flat().filter((r) => r.artifactId === "art-spec2");
  assert.equal(recorded.length, 1, "the approval is recorded for gate purposes even though it moved nothing");
  assert.equal(recorded[0]?.kind, "approve");
});

test("the seat that CAN review the artifact settles it", () => {
  const state = meshWithPeers();
  seedArtifact(state, "ApiSpec", "art-spec3", "marketing");
  applyEvent(state, evt("review.requested", { artifactId: "art-spec3" }, { actorId: "marketing" }));

  applyEvent(state, evt("review.approved", { artifactId: "art-spec3", subject: "architecture", kind: "approve" }, { actorId: "architect" }));

  assert.equal(statusOf(state, "art-spec3"), "APPROVED", "architecture authority over an ApiSpec is the real thing");
});

test("the review CAPABILITY is enough on its own, without the matching authority", () => {
  const state = createInitialState();
  applyEvent(state, evt("agent.created", { agent: agent("reviewer", [], ["repository.read", "review.design"]) }));
  applyEvent(state, evt("agent.created", { agent: agent("author", ["architecture.approve"], ["repository.read", "review.design"]) }));
  seedArtifact(state, "ADR", "art-adr", "author");
  applyEvent(state, evt("review.requested", { artifactId: "art-adr" }, { actorId: "author" }));

  applyEvent(state, evt("review.approved", { artifactId: "art-adr", subject: "architecture", kind: "approve" }, { actorId: "reviewer" }));

  assert.equal(statusOf(state, "art-adr"), "APPROVED", "review.design is the capability the ADR itself asks for");
});

test("a lone seat still settles its own work — the single-agent control group is not deadlocked", () => {
  const state = createInitialState();
  applyEvent(state, evt("agent.created", { agent: agent("solo", [], ["repository.write"]) }));
  seedArtifact(state, "CodePatch", "art-solo", "solo");
  applyEvent(state, evt("review.requested", { artifactId: "art-solo" }, { actorId: "solo" }));

  applyEvent(state, evt("review.approved", { artifactId: "art-solo", kind: "approve" }, { actorId: "solo" }));

  assert.equal(
    statusOf(state, "art-solo"),
    "APPROVED",
    "with no peer who could have reviewed it, the only seat there is may settle it",
  );
});

test("an actor absent from projections still replays, so hand-built and pre-registration logs are unaffected", () => {
  const state = createInitialState();
  seedArtifact(state, "ArchitectureDocument", "art-ghost", "nobody");
  applyEvent(state, evt("review.requested", { artifactId: "art-ghost" }, { actorId: "nobody" }));

  applyEvent(state, evt("review.approved", { artifactId: "art-ghost", kind: "approve" }, { actorId: "ghost" }));

  assert.equal(
    statusOf(state, "art-ghost"),
    "APPROVED",
    "a reducer must never refuse to replay an event because the seat behind it is not in this projection",
  );
});

test("a capacity claim on another domain's artifact still records the signature a gate needs", () => {
  // The case the screen must NOT break: QA signs `quality` on a CodePatch.
  const state = createInitialState();
  applyEvent(state, evt("agent.created", { agent: agent("qa", ["quality.approve"], ["test.write"]) }));
  applyEvent(state, evt("agent.created", { agent: agent("lead", ["implementation.approve"], ["code.review"]) }));
  seedArtifact(state, "CodePatch", "art-patch", "dev");

  applyEvent(state, evt("review.approved", { artifactId: "art-patch", subject: "quality", kind: "pass" }, { actorId: "qa" }));

  const recorded = [...state.approvals.values()].flat().filter((r) => r.artifactId === "art-patch");
  assert.equal(recorded.length, 1, "QA's pass is recorded — it is what a `qa.pass` transition gate reads");
  assert.equal(recorded[0]?.kind, "pass");
});

/**
 * The six artifact types nobody had listed, and the failure mode that made the
 * omission dangerous rather than merely incomplete.
 *
 * `REVIEW_CAPABILITIES` covered 9 of 15 types as a `Partial<Record<…>>`. A missing
 * row did not fail closed: `capabilityForReview` returned null, `hasPeerReviewerFor`
 * short-circuited on that null and reported that NO peer could have reviewed the
 * artifact, and `approverMayAdvance` read that as the single-agent control-group
 * carve-out and returned true. So the self-approval screen switched ITSELF OFF, in
 * a fully staffed mesh, for exactly the types nobody remembered.
 *
 * `domainOfSubject` had the same hole from the other side: for an unmapped type it
 * returned the artifact's own type name as an authority domain, so the authority
 * leg could never match either. Both legs dead meant "no peer reviewer" was
 * unconditional.
 *
 * Fixing it needed a row in each table, which is why they now share one function.
 */
const NEWLY_MAPPED: ArtifactType[] = ["ResearchReport", "Decision", "DisagreementRecord", "Requirement", "TaskSpec", "BenchmarkResult"];

/**
 * A mesh with a peer who can review EVERY domain, so the control-group carve-out
 * is never what these tests measure. `meshWithPeers` has no quality reviewer, and
 * a `BenchmarkResult` there genuinely has no possible peer — the carve-out fires
 * correctly and self-approval is allowed, which is the documented single-agent
 * behaviour rather than the bug under test.
 */
function meshWithEveryReviewer(): Projections {
  const state = meshWithPeers();
  applyEvent(state, evt("agent.created", { agent: agent("qa", ["quality.approve"], ["repository.read", "test.write"]) }));
  return state;
}

for (const type of NEWLY_MAPPED) {
  test(`self-approval is refused on a ${type}, where the carve-out used to fire in a staffed mesh`, () => {
    const state = meshWithEveryReviewer();
    // marketing holds no review capability and no authority at all — it is the
    // seat that must never settle its own work.
    seedArtifact(state, type, "art-own", "marketing");
    applyEvent(state, evt("review.requested", { artifactId: "art-own" }, { actorId: "marketing" }));
    applyEvent(state, evt("review.approved", { artifactId: "art-own", subject: "architecture", kind: "approve" }, { actorId: "marketing" }));

    assert.notEqual(
      statusOf(state, "art-own"),
      "APPROVED",
      `a ${type} must not be settled by its own author just because the type had no capability row`,
    );
  });
}

test("a peer who CAN review a newly-mapped type still settles it", () => {
  // The other half, and the reason the rows are `review.design` rather than
  // something narrower: filling the table must not make these types unreviewable.
  const state = meshWithEveryReviewer();
  seedArtifact(state, "ResearchReport", "art-research", "marketing");
  applyEvent(state, evt("review.requested", { artifactId: "art-research" }, { actorId: "marketing" }));
  applyEvent(state, evt("review.approved", { artifactId: "art-research", subject: "architecture", kind: "approve" }, { actorId: "architect" }));

  assert.equal(statusOf(state, "art-research"), "APPROVED", "architect holds review.design, so it may settle a ResearchReport");
});

test("subjectForArtifactType answers for every artifact type, with no fallthrough", () => {
  // The table is now a total `Record`, so a new artifact type is a compile error
  // rather than a silent hole. This asserts the runtime half: every type resolves
  // to one of the six real authority domains, never to a type name.
  const DOMAINS = new Set(["architecture", "implementation", "quality", "security", "requirements", "release"]);
  for (const type of Object.keys(REVIEW_CAPABILITIES) as ArtifactType[]) {
    const subject = subjectForArtifactType(type);
    assert.ok(DOMAINS.has(subject), `${type} resolved to '${subject}', which is not an authority domain`);
    assert.ok(REVIEW_CAPABILITIES[type], `${type} has no review capability`);
  }
});

/**
 * The two legs of `hasPeerReviewerFor`, pinned separately.
 *
 * Filling the six missing types needed a row in BOTH tables, and the reason is
 * subtler than "two tables, two jobs": for the self-approval screen the legs are
 * REDUNDANT. `hasPeerReviewerFor` returns true if a peer holds `<domain>.approve`
 * OR holds the review capability, so either row alone closes the hole — verified by
 * mutation, where reverting one table left all six tests green and reverting both
 * turned all six red.
 *
 * Redundant is not the same as unnecessary. Each leg is the only one that fires for
 * a differently-shaped peer, and a mesh in the wild has both shapes: skill-panel's
 * tech-lead holds `review.design` with no `architecture.approve`, so its ability to
 * review an ArchitectureDocument rests entirely on the capability leg. These two
 * tests give each leg its own single-legged peer, so a regression on either table
 * is caught rather than masked by the other.
 */
test("peer-reviewer leg 1: a peer holding only the domain authority is enough", () => {
  const state = createInitialState();
  applyEvent(state, evt("agent.created", { agent: agent("architect", ["architecture.approve"], ["repository.read"]) }));
  applyEvent(state, evt("agent.created", { agent: agent("marketing", [], ["repository.read"]) }));
  seedArtifact(state, "ResearchReport", "art-a", "marketing");
  applyEvent(state, evt("review.requested", { artifactId: "art-a" }, { actorId: "marketing" }));
  applyEvent(state, evt("review.approved", { artifactId: "art-a", subject: "architecture", kind: "approve" }, { actorId: "marketing" }));

  assert.notEqual(
    statusOf(state, "art-a"),
    "APPROVED",
    "architect holds architecture.approve and no review.design — the DOMAIN row is what makes it a peer",
  );
});

test("peer-reviewer leg 2: a peer holding only the review capability is enough", () => {
  const state = createInitialState();
  // No authority at all, just the capability — the shape skill-panel's tech-lead
  // has for an ArchitectureDocument.
  applyEvent(state, evt("agent.created", { agent: agent("reviewer", [], ["repository.read", "review.design"]) }));
  applyEvent(state, evt("agent.created", { agent: agent("marketing", [], ["repository.read"]) }));
  seedArtifact(state, "ResearchReport", "art-b", "marketing");
  applyEvent(state, evt("review.requested", { artifactId: "art-b" }, { actorId: "marketing" }));
  applyEvent(state, evt("review.approved", { artifactId: "art-b", subject: "architecture", kind: "approve" }, { actorId: "marketing" }));

  assert.notEqual(
    statusOf(state, "art-b"),
    "APPROVED",
    "reviewer holds review.design and no authority — the CAPABILITY row is what makes it a peer",
  );
});

test("a seat with the capability but not the authority can still settle — the live tech-lead shape", () => {
  // The other direction, in `approverMayAdvance`'s own tail rather than in
  // `hasPeerReviewerFor`: the acting seat needs the domain authority OR the review
  // capability. skill-panel's tech-lead signs as `quality` on an architecture
  // artifact and moves it on `review.design` alone, which is exactly this path.
  const state = createInitialState();
  applyEvent(state, evt("agent.created", { agent: agent("techlead", ["quality.approve"], ["repository.read", "review.design"]) }));
  applyEvent(state, evt("agent.created", { agent: agent("architect", ["architecture.approve"], ["repository.read", "review.design"]) }));
  applyEvent(state, evt("agent.created", { agent: agent("marketing", [], ["repository.read"]) }));
  seedArtifact(state, "ResearchReport", "art-c", "marketing");
  applyEvent(state, evt("review.requested", { artifactId: "art-c" }, { actorId: "marketing" }));
  applyEvent(state, evt("review.approved", { artifactId: "art-c", subject: "quality", kind: "approve" }, { actorId: "techlead" }));

  assert.equal(statusOf(state, "art-c"), "APPROVED", "review.design settles it even though the seat holds no architecture.approve");
});
