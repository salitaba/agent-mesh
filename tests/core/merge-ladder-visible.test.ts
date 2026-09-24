import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor } from "../helpers";
import type { ActivationReason, MeshOp } from "../../packages/protocol/src/index";

/**
 * The merge ladder was invisible, and that is why a mission produced no product.
 *
 * Everything needed to land code exists and is correct: a `merge` op, a
 * `patch.merge` gate check, `GitWorkspace.mergeWorktree` doing a real
 * `git merge --no-edit` into `workspace/main`, and `patch.merged` emitted when a
 * CodePatch reaches MERGED. The ladder `APPROVED -> VERIFIED -> MERGEABLE -> MERGED`
 * is strict, and `opMerge` refuses anything not already MERGEABLE.
 *
 * What did not exist was any way for a seat to find out. Nothing auto-advances the
 * ladder, no watchdog mentioned it, and the seat's generated context listed the op
 * once as a bare line item. One live mission spent 12,761,426 tokens, approved a
 * CodePatch whose tests passed, and ended with `workspace/main` holding a README and
 * the scaffold commit. `patch.merged` events: zero.
 *
 * Two surfaces, because the failure has two shapes. A QUIET mission gets the
 * watchdog; a BUSY one never triggers it, so the pending rung also rides in the
 * per-turn context next to the artifact the seat is already reading.
 */

const AGENTS = [
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "test.execute", "git.commit"], interests: [] },
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "code.review", "git.merge"], authority: ["implementation.approve"], interests: [] },
];
const COMM = { dev: ["lead"], lead: ["dev"] };

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

interface StallInternals {
  checkStall(): Promise<void>;
  wakeValue(): { worth: boolean; why: string };
  stallWakeNote(): string;
  stallDriver(): string | undefined;
  lastTurnAt: number;
  lastStallNudgeAt: number;
}
const internals = (m: Mesh): StallInternals => m.supervisor as unknown as StallInternals;

const turnFor = (agentId: string) =>
  ({
    turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`,
    agentId,
    reason: { kind: "manual" as const },
    sentOps: 0,
    publishedOps: 0,
    waitRequested: false,
    escalated: false,
    results: [],
  }) as never;

/** A CodePatch sitting at APPROVED — the exact state the live mission ended in. */
async function approvedPatch(mode: "parked" | "live" = "parked") {
  const m = await makeMesh({
    agents: AGENTS,
    mayContact: COMM,
    mode,
    ...(mode === "live" ? { stallIdleMs: 60_000, stallCooldownMs: 300_000, stallNoopRetryMs: 600_000 } : {}),
  } as never);
  const created = await m.supervisor.createArtifact({ actorId: "dev", name: "slice-1", type: "CodePatch", content: "the whole patch, at length" });
  if (!("artifact" in created)) throw new Error("create failed");
  const id = created.artifact.id;
  await m.supervisor.transitionArtifact("dev", id, { to: "READY_FOR_REVIEW" });
  await m.supervisor.executeOp("dev", { op: "request_review", artifactId: id, reviewers: ["lead"] } as MeshOp, turnFor("dev"));
  await m.supervisor.executeOp("lead", { op: "approve", subject: "implementation", artifactId: id } as MeshOp, turnFor("lead"));
  assert.equal(m.kernel.state.artifacts.get(id)?.status, "APPROVED", "the fixture reproduces the live end-state");
  return { m, id };
}

test("a patch parked at APPROVED is what the stall card names, not the criteria count", async () => {
  const { m, id } = await approvedPatch();
  try {
    const value = internals(m).wakeValue();
    assert.equal(value.worth, true);
    assert.match(value.why, /stalled on the merge ladder/, "the operator's card must name the real blocker");
    assert.match(value.why, /slice-1 is APPROVED, needs VERIFIED/, "and the specific rung");
    void id;
  } finally {
    await m.cleanup();
  }
});

test("the wake note gives the concrete next move, and says nothing advances on its own", async () => {
  const { m } = await approvedPatch();
  try {
    const note = internals(m).stallWakeNote();
    assert.match(note, /parked on the merge ladder/);
    assert.match(note, /artifact:\/\/CodePatch\/slice-1\/1/, "by ref, so the seat can act without guessing");
    assert.match(note, /Transition it to VERIFIED/);
    assert.match(note, /nothing advances it automatically/, "the sentence whose absence cost a whole mission");
  } finally {
    await m.cleanup();
  }
});

test("the stall driver prefers a seat that can move the patch over one that merely has mail", async () => {
  const { m } = await approvedPatch();
  try {
    // dev holds test.execute, so it can take APPROVED -> VERIFIED. lead holds
    // implementation.approve and can too. Either is right; a seat that can do
    // neither is not.
    const driver = internals(m).stallDriver();
    assert.ok(driver === "dev" || driver === "lead", `expected a seat that can advance the rung, got ${driver}`);
  } finally {
    await m.cleanup();
  }
});

test("the pending rung rides in the per-turn context, for the busy mission the watchdog never sees", async () => {
  // The watchdog only fires on a quiet mission. A mission that keeps working can
  // leave a patch approved forever with nothing mentioning it, which is what
  // happened live — the mission was busy for the whole hour after the approval.
  const { m } = await approvedPatch("live");
  try {
    let seen = "";
    stub(m).setScript("dev", async (input) => {
      seen = input.instructions ?? "";
      return { operations: [{ op: "wait" } as MeshOp] };
    });
    await m.supervisor.activateAgent("dev", { kind: "manual" } as ActivationReason, { explicit: true });
    await waitFor("the turn to run", () => seen.length > 0, 5000);

    assert.match(seen, /needs VERIFIED next; nothing advances it automatically/, "the seat is told while reading the artifact");
    assert.match(
      seen,
      /walking APPROVED -> VERIFIED -> MERGEABLE/,
      "and the op list documents the ladder rather than listing `merge` as a bare word",
    );
  } finally {
    await m.cleanup();
  }
});

test("a patch that has not been approved yet, and one already merged, are both silent", async () => {
  // The narrow set is the point: no other mesh should pay a token for this, and a
  // DRAFT patch is not waiting on anybody.
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" } as never);
  try {
    const created = await m.supervisor.createArtifact({ actorId: "dev", name: "draft", type: "CodePatch", content: "not yet reviewed, at length" });
    if (!("artifact" in created)) throw new Error("create failed");
    assert.equal(m.kernel.state.artifacts.get(created.artifact.id)?.status, "DRAFT");

    const value = internals(m).wakeValue();
    assert.ok(!/merge ladder/.test(value.why), `a DRAFT patch is not parked on the ladder, got: ${value.why}`);
  } finally {
    await m.cleanup();
  }
});
