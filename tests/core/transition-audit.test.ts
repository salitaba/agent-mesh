import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import type { MeshEvent, MeshOp } from "../../packages/protocol/src/index";

/**
 * The transition log says what moved, and from where.
 *
 * A verdict moves an artifact through the reducer, and the supervisor records that
 * move as a derived `artifact.transition` so the log shows every state change. It
 * recorded one after EVERY verdict, whether or not anything had moved: 16 of the 28
 * `artifact.transition` events in the cronlite run were "FINAL (derived)" on an
 * artifact that was already FINAL, and since `gateSatisfied` was asked of a
 * same-status "transition" they read `false` for no reason a reader could use
 * ("TestReport DRAFT (derived, gate=false) x3" looked like a blocked walkback and was
 * nothing at all). And no transition said where it came from, so a status could not be
 * checked against the one before it.
 *
 * A derived transition is now recorded only when the artifact moved, and every one --
 * derived or explicit -- carries `from`.
 */

const AGENTS = [
  { id: "arch", role: "architect", capabilities: ["repository.read", "repository.write"], authority: ["architecture.approve"], interests: [] },
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "review.design"], authority: ["quality.approve"], interests: [] },
];
const COMM = { arch: ["lead"], lead: ["arch"] };

const turnFor = (agentId: string) =>
  ({ turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`, agentId, reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] }) as never;

type Mesh = Awaited<ReturnType<typeof makeMesh>>;
const op = (m: Mesh, actor: string, o: MeshOp) => m.supervisor.executeOp(actor, o, turnFor(actor));

const transitions = async (m: Mesh, artifactId: string): Promise<MeshEvent[]> =>
  (await m.store.read()).filter((e) => e.type === "artifact.transition" && (e.payload as { artifactId?: string }).artifactId === artifactId);
const shape = (e: MeshEvent) => {
  const p = e.payload as { from?: string; to?: string; derived?: boolean };
  return `${p.from ?? "?"}->${p.to}${p.derived ? " (derived)" : ""}`;
};

async function publishedDesign(m: Mesh): Promise<string> {
  const created = await m.supervisor.createArtifact({ actorId: "arch", name: "design", type: "ArchitectureDocument", content: "tokens, components, states — at length" });
  if (!("artifact" in created)) throw new Error("create failed");
  return created.artifact.id;
}

test("a verdict that moves the artifact records one derived transition, from where it was", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" });
  try {
    const id = await publishedDesign(m);
    assert.equal((await op(m, "arch", { op: "request_review", artifactId: id, reviewers: ["lead"] } as MeshOp)).ok, true);
    assert.deepEqual((await transitions(m, id)).map(shape), ["DRAFT->UNDER_REVIEW (derived)"], "asking for review moved it DRAFT -> UNDER_REVIEW, and says so");

    assert.equal((await op(m, "lead", { op: "approve", subject: "quality", artifactId: id } as MeshOp)).ok, true);
    const after = await transitions(m, id);
    assert.equal(after.length, 2, "the approval moved it once, so it is recorded once");
    const settled = m.kernel.state.artifacts.get(id)!.status;
    assert.notEqual(settled, "UNDER_REVIEW");
    assert.equal(shape(after[1]!), `UNDER_REVIEW->${settled} (derived)`);
  } finally {
    await m.cleanup();
  }
});

test("a verdict that moves nothing records no transition at all", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" });
  try {
    const id = await publishedDesign(m);
    await op(m, "arch", { op: "request_review", artifactId: id, reviewers: ["lead"] } as MeshOp);
    await op(m, "lead", { op: "approve", subject: "quality", artifactId: id } as MeshOp);
    const settled = await transitions(m, id);

    // The same seat signs again on an artifact that is already settled: the verdict is
    // recorded (a signature is worth keeping), but nothing moved, so nothing is mirrored.
    await op(m, "lead", { op: "approve", subject: "quality", artifactId: id } as MeshOp);
    assert.equal((await transitions(m, id)).length, settled.length, "no 'FINAL (derived)' on an artifact that was already FINAL");

    // And a second ask for review of the same artifact is not a transition either.
    await op(m, "arch", { op: "request_review", artifactId: id, reviewers: ["lead"] } as MeshOp);
    const derivedNoOps = (await transitions(m, id)).filter((e) => {
      const p = e.payload as { from?: string; to?: string };
      return p.from !== undefined && p.from === p.to;
    });
    assert.deepEqual(derivedNoOps, [], "a transition from X to X is never written");
  } finally {
    await m.cleanup();
  }
});

test("an explicit transition records the status it left", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" });
  try {
    const id = await publishedDesign(m);
    const res = await m.supervisor.transitionArtifact("arch", id, { to: "READY_FOR_REVIEW" });
    assert.equal(res.ok, true, res.reason);
    const moves = await transitions(m, id);
    const p = moves.at(-1)!.payload as { from?: string; to?: string; derived?: boolean };
    assert.deepEqual({ from: p.from, to: p.to, derived: p.derived }, { from: "DRAFT", to: "READY_FOR_REVIEW", derived: undefined });
  } finally {
    await m.cleanup();
  }
});

test("a new version that resets the artifact says where it was reset from", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" });
  try {
    const id = await publishedDesign(m);
    await op(m, "arch", { op: "request_review", artifactId: id, reviewers: ["lead"] } as MeshOp);
    assert.equal(m.kernel.state.artifacts.get(id)!.status, "UNDER_REVIEW");

    const v2 = await m.supervisor.createArtifact({ actorId: "arch", name: "design", type: "ArchitectureDocument", content: "tokens, components, states — revised, at length", asVersionOf: id });
    assert.ok("artifact" in v2);
    const last = (await transitions(m, id)).at(-1)!;
    assert.equal(shape(last), "UNDER_REVIEW->DRAFT (derived)", "the walkback the log used to show only as UNDER_REVIEW three times in a row");
  } finally {
    await m.cleanup();
  }
});
