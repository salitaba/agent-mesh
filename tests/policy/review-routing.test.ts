import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import type { ArtifactType, MeshOp } from "../../packages/protocol/src/index";

/**
 * Who a `review.artifact` call goes to.
 *
 * The contract advertises `reviewers` ("omit to let the mesh pick qualified reviewers")
 * and the router read neither half of that: a named reviewer was ignored, and with
 * nobody named the ask went to the FIRST seat the caller may contact, in config order
 * (pm to architect, architect to pm), whether or not that seat could settle anything.
 * In the second cronlite run 13 of 24 review requests were refused as
 * `review.reviewer-cannot-settle`: all 7 that named reviewers in `request.reviewers`,
 * 6 of the 8 that named nobody, none of the 7 that used the call-level `to`. The
 * refusals each named the seat that could ("tech-lead can"), and the seat asked the
 * same wrong reviewer again, because the name it had given never reached the op.
 *
 * The fixture is the cronlite roster in its config order, which is the point: the able
 * reviewer is never the first seat the caller may contact, so a router that falls back
 * on order fails here. The contract test that predates this one passed for the wrong
 * reason: its named reviewer was also first in order.
 */

const AGENTS = [
  { id: "pm", role: "product-manager", capabilities: ["repository.read"], authority: ["requirements.accept"], interests: [] },
  { id: "architect", role: "architect", capabilities: ["repository.read", "architecture.write", "review.design"], authority: ["architecture.approve"], interests: [] },
  {
    id: "tech-lead",
    role: "tech-lead",
    capabilities: ["repository.read", "architecture.read", "code.review", "review.design", "task.assign", "git.merge"],
    authority: ["implementation.approve", "architecture.approve"],
    interests: [],
  },
  { id: "developer", role: "developer", capabilities: ["repository.read", "repository.write", "test.execute", "git.commit"], interests: [] },
  { id: "qa", role: "qa", capabilities: ["repository.read", "test.execute", "test.write"], authority: ["quality.block", "quality.pass"], interests: [] },
];
const COMM = {
  architect: ["developer", "tech-lead", "pm"],
  developer: ["architect", "tech-lead", "qa"],
  qa: ["developer", "tech-lead", "architect", "pm"],
  "tech-lead": ["architect", "developer", "qa", "pm"],
  pm: ["architect", "tech-lead", "developer", "qa"],
};

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

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

async function publish(m: Mesh, actorId: string, name: string, type: ArtifactType): Promise<string> {
  const created = await m.supervisor.createArtifact({ actorId, name, type, content: `${name}: a body long enough to be a document` });
  if (!("artifact" in created)) throw new Error(`publish failed: ${JSON.stringify(created)}`);
  return created.artifact.id;
}

const review = (request: Record<string, unknown>, to?: string[]): MeshOp => ({ op: "call", contract: "review.artifact", request, to }) as MeshOp;

/** Who the REQUEST_REVIEW that an accepted call sent was addressed to. */
function addressedTo(m: Mesh, res: { ok: boolean; messageId?: string }): string[] {
  assert.equal(res.ok, true);
  return [...(m.kernel.state.messages.get(res.messageId ?? "")?.to ?? [])];
}

test("a reviewer named in the request is the seat that is asked", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" } as never);
  try {
    const id = await publish(m, "architect", "cronlite-architecture", "ArchitectureDocument");
    // pm's first contactable seat is the architect, which owns this and cannot settle it.
    const res = await m.supervisor.executeOp("pm", review({ artifactId: id, reviewers: ["tech-lead"] }), turnFor("pm"));
    assert.equal(res.ok, true, res.ok ? "" : String(res.reason));
    assert.deepEqual(addressedTo(m, res), ["tech-lead"]);
  } finally {
    await m.cleanup();
  }
});

test("with nobody named the ask goes to a seat that can settle it, not the first seat the caller may contact", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" } as never);
  try {
    // pm -> architect's document: architect is first in pm's order and cannot review its own work.
    const arch = await publish(m, "architect", "cronlite-architecture", "ArchitectureDocument");
    const fromPm = await m.supervisor.executeOp("pm", review({ artifactId: arch }), turnFor("pm"));
    assert.equal(fromPm.ok, true, fromPm.ok ? "" : String(fromPm.reason));
    assert.deepEqual(addressedTo(m, fromPm), ["tech-lead"]);

    // architect -> its own document: pm is first in architect's order and holds no review authority.
    const own = await publish(m, "architect", "second-design", "ArchitectureDocument");
    const fromOwner = await m.supervisor.executeOp("architect", review({ artifactId: own }), turnFor("architect"));
    assert.equal(fromOwner.ok, true, fromOwner.ok ? "" : String(fromOwner.reason));
    assert.deepEqual(addressedTo(m, fromOwner), ["tech-lead"]);

    // developer's patch: only the seat with implementation.approve / code.review can settle it.
    const patch = await publish(m, "developer", "cronlite-impl", "CodePatch");
    const patchAsk = await m.supervisor.executeOp("pm", review({ artifact: patch }), turnFor("pm"));
    assert.equal(patchAsk.ok, true, patchAsk.ok ? "" : String(patchAsk.reason));
    assert.deepEqual(addressedTo(m, patchAsk), ["tech-lead"]);
  } finally {
    await m.cleanup();
  }
});

test("the call-level `to` still overrides, and `to` wins over `reviewers`", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" } as never);
  try {
    const id = await publish(m, "architect", "cronlite-architecture", "ArchitectureDocument");
    const res = await m.supervisor.executeOp("pm", review({ artifactId: id, reviewers: ["architect"] }, ["tech-lead"]), turnFor("pm"));
    assert.equal(res.ok, true, res.ok ? "" : String(res.reason));
    assert.deepEqual(addressedTo(m, res), ["tech-lead"]);
  } finally {
    await m.cleanup();
  }
});

test("a named reviewer who cannot settle it is still refused, with the route, and is not quietly replaced", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" } as never);
  try {
    const id = await publish(m, "architect", "cronlite-architecture", "ArchitectureDocument");
    const res = await m.supervisor.executeOp("pm", review({ artifactId: id, reviewers: ["architect"] }), turnFor("pm"));
    assert.equal(res.ok, false, "the seat named someone, so the mesh teaches rather than guesses");
    assert.match(String(res.reason), /none of architect can deliver a verdict on this ArchitectureDocument/);
    assert.match(String(res.reason), /tech-lead can/);
    assert.equal([...m.kernel.state.messages.values()].filter((x) => x.type === "REQUEST_REVIEW").length, 0, "nothing was sent");
  } finally {
    await m.cleanup();
  }
});

test("when the only seat that can settle it is out of the caller's reach, the refusal says so", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: { ...COMM, developer: ["qa"] }, mode: "parked" } as never);
  try {
    const patch = await publish(m, "developer", "cronlite-impl", "CodePatch");
    const res = await m.supervisor.executeOp("developer", review({ artifactId: patch }), turnFor("developer"));
    assert.equal(res.ok, false);
    assert.match(String(res.reason), /no seat you may contact can deliver a verdict on this CodePatch/);
    assert.match(String(res.reason), /tech-lead can, but you may not contact them/);
    const denial = (await m.store.read()).find(
      (e) => e.type === "message.rejected" && (e.payload as { ruleId?: string }).ruleId === "review.reviewer-cannot-settle",
    );
    assert.ok(denial, "on the record, like every other refusal of a review request");
  } finally {
    await m.cleanup();
  }
});

test("the briefing's list of who can settle an artifact and the router's default are the same list", async () => {
  // One predicate, three readers. If this ever disagrees, a seat is told one name and sent to another.
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" } as never);
  try {
    const { settlersOf } = await import("../../packages/core/src/projections-helpers");
    const id = await publish(m, "architect", "cronlite-architecture", "ArchitectureDocument");
    const artifact = m.kernel.state.artifacts.get(id)!;
    assert.deepEqual(settlersOf(m.kernel.state, artifact), ["tech-lead"], "the owner and seats with no review authority are not on it");
    const res = await m.supervisor.executeOp("pm", review({ artifactId: id }), turnFor("pm"));
    assert.deepEqual(addressedTo(m, res), ["tech-lead"]);
  } finally {
    await m.cleanup();
  }
});
