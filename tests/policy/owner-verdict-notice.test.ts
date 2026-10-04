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

const agents = (devInterests: string[] = [], devCapabilities: string[] = ["repository.read", "repository.write", "git.commit"]) => [
  { id: "dev", role: "developer", capabilities: devCapabilities, interests: devInterests },
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "code.review", "git.merge"], authority: ["implementation.approve"], interests: [] },
];
const COMM = { dev: ["lead"], lead: ["dev"] };

const turnFor = (agentId: string) =>
  ({ turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`, agentId, reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] }) as never;

type Mesh = Awaited<ReturnType<typeof makeMesh>>;
const op = (m: Mesh, actor: string, o: MeshOp) => m.supervisor.executeOp(actor, o, turnFor(actor));

/** A mesh whose seats answer `done` and whose activations are recorded per seat. */
async function liveMesh(devInterests: string[] = [], devCapabilities?: string[], transitions?: Record<string, string[]>) {
  const m = await makeMesh({ agents: agents(devInterests, devCapabilities), mayContact: COMM, mode: "live", ...(transitions ? { transitions } : {}) });
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
    assert.match(
      note,
      /needs VERIFIED next, and you cannot move it yourself: VERIFIED requires a verification role or implementation approval authority\. lead can, with `mesh_artifact_transition`: tell that seat it is ready\. Nothing advances it automatically\./,
      "this owner holds no capability for the rung, and the note says who does instead of 'only you'",
    );
    assert.ok(!/only you/.test(note));
  } finally {
    await m.cleanup();
  }
});

test("an owner that may take the rung is told the call that does, and that nothing else is needed", async () => {
  // The seventeenth cronlite run's developer read "needs VERIFIED next" as a verdict to wait for: it tried two `mesh_approve` passes on its
  // own patch, asked a review of it and waited for a QA nobody had asked, 5 min 50 s, where the same note had been acted on in 30 s.
  const { m, woken } = await liveMesh([], ["repository.read", "repository.write", "git.commit", "test.execute"]);
  try {
    const id = await patchUnderReview(m);
    assert.equal((await op(m, "lead", { op: "approve", subject: "implementation", artifactId: id } as MeshOp)).ok, true);
    await waitFor("the owner is woken by the verdict", () => woken.dev!.some((r) => r.kind === "interest_event" && r.eventType === "review.approved"));
    const note = String(woken.dev!.find((r) => r.kind === "interest_event")!.note);
    assert.ok(
      note.includes(`needs VERIFIED next, and you can move it: \`mesh_artifact_transition\` with artifactId "${id}" and to "VERIFIED". That step takes no verdict from anyone else; nothing advances it automatically.`),
      note,
    );
    assert.ok(!/only you/.test(note));
    // The call it names does what the note says, and no other seat is asked for anything first.
    const moved = await op(m, "dev", { op: "transition_artifact", artifactId: id, to: "VERIFIED" } as MeshOp);
    assert.equal(moved.ok, true, moved.reason ?? "");
    assert.equal(m.kernel.state.artifacts.get(id)!.status, "VERIFIED");
  } finally {
    await m.cleanup();
  }
});

test("a rung a configured gate holds back is not offered: the note says what the gate wants, and names no seat that cannot lift it", async () => {
  const { m, woken } = await liveMesh([], ["repository.read", "repository.write", "git.commit", "test.execute"], { "CodePatch.VERIFIED": ["qa.pass"] });
  try {
    const id = await patchUnderReview(m);
    assert.equal((await op(m, "lead", { op: "approve", subject: "implementation", artifactId: id } as MeshOp)).ok, true);
    await waitFor("the owner is woken by the verdict", () => woken.dev!.some((r) => r.kind === "interest_event" && r.eventType === "review.approved"));
    const note = String(woken.dev!.find((r) => r.kind === "interest_event")!.note);
    assert.ok(note.includes("needs VERIFIED next, and you cannot move it yourself: transition 'CodePatch.VERIFIED' requires qa.pass; missing: qa.pass. Nothing advances it automatically."), note);
    assert.ok(!/can, with/.test(note), "no seat is named: the gate binds them all alike");
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

// ---------------------------------------------------------------- the note itself, rung by rung

const rungNote = (m: Mesh, artifactId: string, rung: string): string =>
  (m.supervisor as unknown as { nextRungNote(a: unknown, rung: string): string }).nextRungNote(m.kernel.state.artifacts.get(artifactId), rung);

test("the note names the rung it is about, and the merge is left to the seat that holds git.merge", async () => {
  const { m } = await liveMesh([], ["repository.read", "repository.write", "git.commit", "test.execute"]);
  try {
    const id = await patchUnderReview(m);
    assert.equal((await op(m, "lead", { op: "approve", subject: "implementation", artifactId: id } as MeshOp)).ok, true);
    assert.equal((await op(m, "dev", { op: "transition_artifact", artifactId: id, to: "VERIFIED" } as MeshOp)).ok, true);
    assert.ok(rungNote(m, id, "MERGEABLE").includes(`and you can move it: \`mesh_artifact_transition\` with artifactId "${id}" and to "MERGEABLE".`), rungNote(m, id, "MERGEABLE"));
    assert.equal(rungNote(m, id, "MERGED"), "It needs MERGED next, which a seat holding git.merge does with the merge op; nothing advances it automatically.");
  } finally {
    await m.cleanup();
  }
});

test("when several seats may take the rung the note names them all, and when none may it says only what the rung asks", async () => {
  const several = await makeMesh({
    agents: [...agents(), { id: "qa", role: "qa", capabilities: ["repository.read", "test.execute"], authority: ["quality.pass"], interests: [] }],
    mayContact: { dev: ["lead", "qa"], lead: ["dev", "qa"], qa: ["dev", "lead"] },
    mode: "parked",
  });
  try {
    const id = await patchUnderReview(several);
    assert.match(rungNote(several, id, "VERIFIED"), /lead or qa can, with `mesh_artifact_transition`: tell one of them it is ready\./);
  } finally {
    await several.cleanup();
  }
  // Nobody holds a verification role, an implementation approval or the security review: the rung is asked of no seat in particular.
  const nobody = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "git.commit"], interests: [] },
      { id: "lead", role: "tech-lead", capabilities: ["repository.read", "code.review", "git.merge"], interests: [] },
    ],
    mayContact: COMM,
    mode: "parked",
  });
  try {
    const id = await patchUnderReview(nobody);
    assert.equal(
      rungNote(nobody, id, "VERIFIED"),
      "It needs VERIFIED next, and you cannot move it yourself: VERIFIED requires a verification role or implementation approval authority. Nothing advances it automatically.",
    );
  } finally {
    await nobody.cleanup();
  }
});
