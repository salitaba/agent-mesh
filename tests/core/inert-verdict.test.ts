import { test } from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL_VERSION, type Artifact, type ArtifactStatus, type ArtifactType, type MeshEvent } from "../../packages/protocol/src/index";
import { applyEvent } from "../../packages/core/src/projections";
import { verdictAdvances } from "../../packages/core/src/projections-helpers";
import { createInitialState, type Projections } from "../../packages/core/src/state";

/**
 * A verdict that moves nothing must say so — and the predicate that decides
 * whether it moved must agree with the reducer that does the moving.
 *
 * The op path carries a caveat for a recorded-but-inert verdict, and it asked
 * `approvalPath` — the state MACHINE — rather than the reducer. Those disagree
 * in exactly one place, and it is the place that bit: a document-machine
 * artifact in DRAFT has a non-empty approval path (["FINAL"]), so
 * approve-on-DRAFT read as advanceable and the signer was told nothing, while
 * the reducer refuses to move anything that is not under review. A live run on
 * 2026-09-23 approved a RequirementsDoc that way; it stayed DRAFT, and the
 * mission's only requirements evidence stayed uncitable for the whole run.
 *
 * The caveat also covered `approve`/`pass` only. In the same run a reviewer
 * rejected a CodePatch 35 minutes after it merged: `review.rejected` went on
 * the log reading authoritative, the patch stayed MERGED, and the op returned
 * clean.
 *
 * These tests pin `verdictAdvances` against what `applyEvent` actually does,
 * so the mirror cannot drift away from the reducers it mirrors.
 */

const GOAL_ID = "goal-inert";

let seq = 0;
function evt(type: string, payload: Record<string, unknown>, over: Partial<MeshEvent> = {}): MeshEvent {
  seq++;
  return {
    id: `evt-inert-${seq}`,
    protocolVersion: PROTOCOL_VERSION,
    type: type as MeshEvent["type"],
    timestamp: `2026-03-02T00:00:${String(seq % 60).padStart(2, "0")}.000Z`,
    goalId: GOAL_ID,
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

/** Peers exist, so the one-seat carve-out in `approverMayAdvance` is not what is measured. */
function mesh(): Projections {
  const state = createInitialState();
  applyEvent(state, evt("agent.created", { agent: agent("dev", [], ["repository.write", "git.commit"]) }));
  applyEvent(state, evt("agent.created", { agent: agent("lead", ["implementation.approve", "quality.approve"], ["code.review"]) }));
  applyEvent(state, evt("agent.created", { agent: agent("pm", ["requirements.approve"], ["repository.read"]) }));
  return state;
}

function seed(state: Projections, type: ArtifactType, id: string, owner: string): void {
  const a = { id, name: `${id} fixture`, type, goalId: GOAL_ID, owner, version: 1, status: "DRAFT" } as unknown as Artifact;
  applyEvent(state, evt("artifact.created", { artifact: a }, { actorId: owner }));
}

/**
 * Walk the ladder the way the runtime does. APPROVED is reached by a real
 * verdict, not a raw transition: `UNDER_REVIEW -> APPROVED` sits behind a gate,
 * and a hand-written transition is refused as `blocked by unsatisfied gate`.
 */
function moveTo(state: Projections, id: string, ladder: ArtifactStatus[], actorId: string): void {
  for (const to of ladder) {
    if (to === "APPROVED") {
      applyEvent(state, evt("review.approved", { artifactId: id, subject: `artifact:${id}`, kind: "approve" }, { actorId }));
      continue;
    }
    applyEvent(state, evt("artifact.transition", { artifactId: id, to, gateSatisfied: true }, { actorId }));
  }
}

function statusOf(state: Projections, id: string): ArtifactStatus {
  return state.artifacts.get(id)?.status as ArtifactStatus;
}

/** Fire the verdict and report whether the artifact actually moved. */
function moved(state: Projections, id: string, kind: "approve" | "reject", actorId: string): boolean {
  const before = statusOf(state, id);
  const type = kind === "approve" ? "review.approved" : "review.rejected";
  applyEvent(state, evt(type, { artifactId: id, subject: `artifact:${id}`, kind }, { actorId }));
  return statusOf(state, id) !== before;
}

test("approve on a DRAFT document: the machine says advanceable, the reducer refuses — and the predicate sides with the reducer", () => {
  // `pm` is the reviewer here, NOT the owner, and holds `requirements.approve`.
  // Both matter: an actor that could not review this type at all would make the
  // predicate return false for the wrong reason and the test would pass with
  // the bug still in place. DRAFT must be the only thing stopping it.
  const state = mesh();
  seed(state, "RequirementsDoc", "art-doc", "dev");
  const a = state.artifacts.get("art-doc") as Artifact;

  assert.equal(statusOf(state, "art-doc"), "DRAFT");
  assert.equal(verdictAdvances(state, "pm", a, "approve"), false, "approve-on-DRAFT moves nothing, so the op must caveat it");
  assert.equal(moved(state, "art-doc", "approve", "pm"), false, "and the reducer agrees: still DRAFT");
});

test("approve on an artifact under review advances it, and the predicate says so", () => {
  const state = mesh();
  seed(state, "RequirementsDoc", "art-doc", "dev");
  moveTo(state, "art-doc", ["READY_FOR_REVIEW", "UNDER_REVIEW"], "pm");
  const a = state.artifacts.get("art-doc") as Artifact;

  assert.equal(verdictAdvances(state, "pm", a, "approve"), true, "the same seat, the same artifact, one rung further along");
  assert.equal(moved(state, "art-doc", "approve", "pm"), true, "the reducer moves it");
});

test("reject on a MERGED patch cannot unland it, and no longer returns clean", () => {
  const state = mesh();
  seed(state, "CodePatch", "art-patch", "dev");
  moveTo(state, "art-patch", ["READY_FOR_REVIEW", "UNDER_REVIEW", "APPROVED", "VERIFIED", "MERGEABLE", "MERGED"], "lead");
  const a = state.artifacts.get("art-patch") as Artifact;

  assert.equal(statusOf(state, "art-patch"), "MERGED");
  assert.equal(verdictAdvances(state, "lead", a, "reject"), false, "a rejection of shipped code moves nothing");
  assert.equal(moved(state, "art-patch", "reject", "lead"), false, "and the reducer agrees: still MERGED");
});

test("reject on an artifact under review does move it", () => {
  const state = mesh();
  seed(state, "CodePatch", "art-patch", "dev");
  moveTo(state, "art-patch", ["READY_FOR_REVIEW", "UNDER_REVIEW"], "lead");
  const a = state.artifacts.get("art-patch") as Artifact;

  assert.equal(verdictAdvances(state, "lead", a, "reject"), true);
  assert.equal(moved(state, "art-patch", "reject", "lead"), true);
});

test("the predicate agrees with the reducer at every status it can reach", () => {
  // The anti-drift guard. `verdictAdvances` is a hand-written mirror of three
  // reducer guards; if either side is edited alone this fails.
  // Each type gets a reviewer that can actually settle it, so the only thing
  // varying across the sweep is the STATUS.
  const ladders: { type: ArtifactType; owner: string; reviewer: string; steps: ArtifactStatus[] }[] = [
    { type: "CodePatch", owner: "dev", reviewer: "lead", steps: ["READY_FOR_REVIEW", "UNDER_REVIEW", "APPROVED", "VERIFIED", "MERGEABLE", "MERGED"] },
    { type: "RequirementsDoc", owner: "dev", reviewer: "pm", steps: ["READY_FOR_REVIEW", "UNDER_REVIEW"] },
  ];
  for (const { type, owner, reviewer, steps } of ladders) {
    for (const kind of ["approve", "reject"] as const) {
      for (let depth = 0; depth <= steps.length; depth++) {
        const state = mesh();
        const id = `art-${type}-${kind}-${depth}`;
        seed(state, type, id, owner);
        moveTo(state, id, steps.slice(0, depth), reviewer);
        const a = state.artifacts.get(id) as Artifact;
        const status = statusOf(state, id);
        const predicted = verdictAdvances(state, reviewer, a, kind);
        const actual = moved(state, id, kind, reviewer);
        assert.equal(predicted, actual, `${type} ${kind} at ${status}: predicate said ${predicted}, reducer did ${actual}`);
      }
    }
  }
});
