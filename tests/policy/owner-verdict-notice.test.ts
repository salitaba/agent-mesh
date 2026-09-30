import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor } from "../helpers";
import type { ActivationReason, MeshOp } from "../../packages/protocol/src/index";

/**
 * The owner of an artifact hears when somebody else's verdict moves it.
 *
 * The owner is the one seat with a next step on its own artifact (only the owner can
 * transition a CodePatch), and what woke it was configuration: the stock developer
 * listens for `review.rejected` and not for `review.approved`, so an approval reached
 * nobody who could act on it. cronlite, run 2: the tech lead approved the patch, only
 * the PM and the architect were woken, and the PM asked the architect four times to
 * "transition it" while the patch sat approved for 2.5 minutes. The architect declined
 * each time ("only the owner can transition a CodePatch") and the PM asked again.
 */

const agents = (devInterests: string[] = []) => [
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "git.commit"], interests: devInterests },
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "code.review", "git.merge"], authority: ["implementation.approve"], interests: [] },
];
const COMM = { dev: ["lead"], lead: ["dev"] };

const turnFor = (agentId: string) =>
  ({ turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`, agentId, reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] }) as never;

type Mesh = Awaited<ReturnType<typeof makeMesh>>;
const op = (m: Mesh, actor: string, o: MeshOp) => m.supervisor.executeOp(actor, o, turnFor(actor));

/** A mesh whose seats answer `done` and whose activations are recorded per seat. */
async function liveMesh(devInterests: string[] = []) {
  const m = await makeMesh({ agents: agents(devInterests), mayContact: COMM, mode: "live" });
  const woken: Record<string, ActivationReason[]> = { dev: [], lead: [] };
  for (const id of ["dev", "lead"]) {
    stub(m).setScript(id, async (input) => {
      woken[id]!.push(input.activation as ActivationReason);
      return { operations: [{ op: "done" } as MeshOp] };
    });
  }
  return { m, woken };
}

async function patchUnderReview(m: Mesh): Promise<string> {
  const created = await m.supervisor.createArtifact({ actorId: "dev", name: "patch", type: "CodePatch", content: "## File: src/x.js\nexport const x = 1;\n" });
  if (!("artifact" in created)) throw new Error("create failed");
  const asked = await op(m, "dev", { op: "request_review", artifactId: created.artifact.id, reviewers: ["lead"] } as MeshOp);
  assert.equal(asked.ok, true, asked.reason ?? "");
  return created.artifact.id;
}

/** `activateAgent` calls the verdict notice makes, which a test can count whatever the scheduler then does with them. */
function noticeCalls(m: Mesh): Array<{ agentId: string; reason: ActivationReason }> {
  const calls: Array<{ agentId: string; reason: ActivationReason }> = [];
  const original = m.supervisor.activateAgent.bind(m.supervisor);
  m.supervisor.activateAgent = async (agentId, reason, opts) => {
    if (reason.kind === "interest_event" && /^(approved|rejected)/.test(String(reason.note ?? "").split(" ").slice(1, 2).join(" "))) calls.push({ agentId, reason });
    return original(agentId, reason, opts);
  };
  return calls;
}

test("an approval that moves the artifact wakes its owner and says what it is now waiting for", async () => {
  const { m, woken } = await liveMesh();
  try {
    const id = await patchUnderReview(m);
    assert.equal((await op(m, "lead", { op: "approve", subject: "implementation", artifactId: id } as MeshOp)).ok, true);
    assert.equal(m.kernel.state.artifacts.get(id)!.status, "APPROVED", "fixture: the approval moved it");

    await waitFor("the owner is woken by the verdict", () => woken.dev!.some((r) => r.kind === "interest_event" && r.eventType === "review.approved"));
    const note = String(woken.dev!.find((r) => r.kind === "interest_event")!.note);
    assert.match(note, /lead approved your CodePatch "patch" v1: it is now APPROVED/);
    assert.match(note, /needs VERIFIED next, and only you can move it there; nothing advances it automatically/);
  } finally {
    await m.cleanup();
  }
});

test("a rejection wakes its owner too, and says to answer it with a new version", async () => {
  const { m, woken } = await liveMesh();
  try {
    const id = await patchUnderReview(m);
    assert.equal((await op(m, "lead", { op: "reject", subject: "implementation", artifactId: id, comment: "the parser drops the last field" } as MeshOp)).ok, true);
    assert.equal(m.kernel.state.artifacts.get(id)!.status, "REJECTED");

    await waitFor("the owner is woken by the verdict", () => woken.dev!.some((r) => r.eventType === "review.rejected" && r.kind === "interest_event"));
    assert.match(String(woken.dev!.find((r) => r.eventType === "review.rejected")!.note), /lead rejected your CodePatch "patch" v1: read the verdict .* publish a new version of the same artifact/);
  } finally {
    await m.cleanup();
  }
});

test("an owner whose own interests already wake it for the verdict is not told twice", async () => {
  const { m, woken } = await liveMesh(["review.approved"]);
  try {
    const calls = noticeCalls(m);
    const id = await patchUnderReview(m);
    assert.equal((await op(m, "lead", { op: "approve", subject: "implementation", artifactId: id } as MeshOp)).ok, true);
    await waitFor("the interest wakes the owner", () => woken.dev!.some((r) => r.eventType === "review.approved"));
    assert.deepEqual(calls, [], "the verdict notice stands down where the owner's own configuration already covers it");
  } finally {
    await m.cleanup();
  }
});

test("a verdict that moved nothing says nothing to the owner", async () => {
  const { m } = await liveMesh();
  try {
    const calls = noticeCalls(m);
    const id = await patchUnderReview(m);
    assert.equal((await op(m, "lead", { op: "approve", subject: "implementation", artifactId: id } as MeshOp)).ok, true);
    assert.equal(calls.length, 1, "the approval that moved it is told once");
    // The same seat signs again on an artifact that is already APPROVED: recorded, but nothing moved.
    assert.equal((await op(m, "lead", { op: "approve", subject: "implementation", artifactId: id } as MeshOp)).ok, true);
    assert.equal(calls.length, 1, "a repeat that changes nothing does not buy the owner a second turn");
  } finally {
    await m.cleanup();
  }
});
