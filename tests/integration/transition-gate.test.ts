import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, collectEvents, eventTypes, evidenceContent } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * Transition gates, end to end — the refusal path and the way out of it.
 *
 * `policies.transitions.<gate>.requires` is the mesh's only structural answer
 * to "who has to sign off before this artifact moves". `tests/policy/` proves
 * the verdict function; that is not the same claim as "the artifact did not
 * move". The status lives in a projection built from events, so a gate that
 * denies while the transition event still lands would pass every unit test
 * and leave a MERGED patch nobody approved. These tests assert the ARTIFACT
 * STATUS and the event log, then prove the rework round actually reopens the
 * path — a gate that can never be satisfied is a deadlock, not a control.
 */

const AGENTS = [
  { id: "dev", role: "developer", capabilities: ["repository.write", "test.execute", "git.commit"], interests: [] },
  { id: "tech-lead", role: "tech-lead", authority: ["implementation.approve"], capabilities: ["code.review", "git.merge"], interests: [] },
  { id: "qa", role: "qa", authority: ["quality.block", "quality.approve"], capabilities: ["test.write", "test.execute"], interests: [] },
];

const COMM = {
  dev: ["tech-lead", "qa"],
  "tech-lead": ["dev", "qa"],
  qa: ["dev", "tech-lead"],
};

/** CodePatch -> MERGED resolves to the gate name "patch.merge". */
const GATES = { "patch.merge": ["tech-lead.approve"] };

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

/** executeOp needs a turn record; tests drive ops without a live runtime. */
const turnFor = (agentId: string) =>
  ({
    turnId: `t-${agentId}`,
    agentId,
    reason: { kind: "manual" as const },
    sentOps: 0,
    publishedOps: 0,
    waitRequested: false,
    escalated: false,
    results: [],
  }) as never;

async function op(m: Mesh, actorId: string, o: MeshOp) {
  return m.supervisor.executeOp(actorId, o, turnFor(actorId));
}

const statusOf = (m: Mesh, id: string) => m.kernel.state.artifacts.get(id)?.status;

/** Publishes a patch and walks it to MERGEABLE, the last stop before the gate. */
async function patchAtMergeable(m: Mesh): Promise<string> {
  const created = await m.supervisor.createArtifact({
    actorId: "dev",
    name: "checkout-patch",
    type: "CodePatch",
    content: evidenceContent("checkout patch"),
  });
  if (!("artifact" in created)) throw new Error(`artifact failed: ${created.error}`);
  const id = created.artifact.id;

  assert.equal((await op(m, "dev", { op: "transition_artifact", artifactId: id, to: "READY_FOR_REVIEW" })).ok, true);
  assert.equal((await op(m, "tech-lead", { op: "transition_artifact", artifactId: id, to: "UNDER_REVIEW" })).ok, true);
  // APPROVED additionally demands a recorded approve carrying THIS artifact id.
  assert.equal((await op(m, "tech-lead", { op: "approve", subject: "implementation", artifactId: id })).ok, true);
  assert.equal((await op(m, "tech-lead", { op: "transition_artifact", artifactId: id, to: "APPROVED" })).ok, true);
  assert.equal((await op(m, "dev", { op: "transition_artifact", artifactId: id, to: "VERIFIED" })).ok, true);
  assert.equal((await op(m, "dev", { op: "transition_artifact", artifactId: id, to: "MERGEABLE" })).ok, true);
  assert.equal(statusOf(m, id), "MERGEABLE", "the patch is staged at the gate");
  return id;
}

test("transition gate e2e: an unsatisfied gate refuses the merge and the artifact does not move", async () => {
  const m = await makeMesh({
    agents: AGENTS,
    mayContact: COMM,
    transitions: { "patch.merge": ["qa.approve"] },
    mode: "parked",
  });
  try {
    const id = await patchAtMergeable(m);
    const transitionsBefore = eventTypes(await collectEvents(m)).filter((t) => t === "artifact.transition").length;

    // qa never ran: the gate token `qa.approve` has no matching approval.
    const res = await op(m, "tech-lead", { op: "transition_artifact", artifactId: id, to: "MERGED" });

    assert.equal(res.ok, false, "an unsatisfied gate must refuse the merge");
    assert.match(res.reason ?? "", /patch\.merge/, "the refusal names the gate that blocked it");
    assert.match(res.reason ?? "", /qa\.approve/, "the refusal names the missing signature so the mesh can act on it");

    // The claim that matters: status is a projection, so a gate that denies
    // while the event still lands would leave a MERGED patch nobody approved.
    assert.equal(statusOf(m, id), "MERGEABLE", "the patch must still be sitting at the gate");
    const transitionsAfter = eventTypes(await collectEvents(m)).filter((t) => t === "artifact.transition").length;
    assert.equal(transitionsAfter, transitionsBefore, "a refused transition emits no artifact.transition");
    const types = eventTypes(await collectEvents(m));
    assert.ok(!types.includes("patch.merged"), "no merge mirror event may fire");
    assert.ok(!types.includes("implementation.completed"), "the mission must not learn implementation is done");
  } finally {
    await m.cleanup();
  }
});

test("transition gate e2e: satisfying the gate lets the same merge through", async () => {
  const m = await makeMesh({
    agents: AGENTS,
    mayContact: COMM,
    transitions: { "patch.merge": ["qa.approve"] },
    mode: "parked",
  });
  try {
    const id = await patchAtMergeable(m);
    assert.equal((await op(m, "tech-lead", { op: "transition_artifact", artifactId: id, to: "MERGED" })).ok, false);

    // The gate is a control, not a deadlock: the named signature opens it.
    const pass = await op(m, "qa", { op: "approve", subject: "quality", artifactId: id });
    assert.equal(pass.ok, true, `qa must be able to record its pass: ${pass.reason ?? ""}`);

    const merged = await op(m, "tech-lead", { op: "transition_artifact", artifactId: id, to: "MERGED" });
    assert.equal(merged.ok, true, `the satisfied gate must permit the merge: ${merged.reason ?? ""}`);
    assert.equal(statusOf(m, id), "MERGED");

    const types = eventTypes(await collectEvents(m));
    assert.ok(types.includes("patch.merged"), "the merge mirrors into the domain event");
    assert.ok(types.includes("implementation.completed"), "and reports implementation done exactly once it is true");
  } finally {
    await m.cleanup();
  }
});

test("transition gate e2e: a `<role>.pass` gate is satisfied by a pass and NOT by a bare approve", async () => {
  // `pass` and `approve` are distinct ApprovalKinds and the distinction is the
  // whole point of writing `qa.pass`: "someone verified this", not "someone was
  // fine with it". Both ride the same `review.approved` event, so the declared
  // kind has to survive emit -> projection or the token is unsatisfiable by any
  // op an agent can issue, and the gate silently means something else.
  const agents = [
    ...AGENTS.filter((a) => a.id !== "qa"),
    { id: "qa", role: "qa", authority: ["quality.block", "quality.approve", "quality.pass"], capabilities: ["test.write", "test.execute"], interests: [] },
  ];
  const m = await makeMesh({
    agents,
    mayContact: COMM,
    transitions: { "patch.merge": ["qa.pass"] },
    mode: "parked",
  });
  try {
    const id = await patchAtMergeable(m);

    // A bare approve is NOT a pass. If this widens, `qa.pass` degrades into
    // `qa.approve` and the verification requirement is gone.
    const approve = await op(m, "qa", { op: "approve", subject: "quality", artifactId: id });
    assert.equal(approve.ok, true, `qa may record a plain approve: ${approve.reason ?? ""}`);
    const notYet = await op(m, "tech-lead", { op: "transition_artifact", artifactId: id, to: "MERGED" });
    assert.equal(notYet.ok, false, "an approve must not satisfy a required pass");
    assert.match(notYet.reason ?? "", /qa\.pass/, "the refusal still names the missing pass");
    assert.equal(statusOf(m, id), "MERGEABLE", "the patch does not move on an approve alone");

    // The declared pass opens it. This is the regression: before the kind was
    // carried through, this op recorded `approve` and the gate never opened.
    const passed = await op(m, "qa", { op: "approve", kind: "pass", subject: "quality", artifactId: id });
    assert.equal(passed.ok, true, `qa must be able to record a pass: ${passed.reason ?? ""}`);
    const records = [...m.kernel.state.approvals.values()].flat().filter((r) => r.artifactId === id && r.actorRole === "qa");
    assert.ok(records.some((r) => r.kind === "pass"), "the projection records the kind the actor declared, not a generic approve");

    const merged = await op(m, "tech-lead", { op: "transition_artifact", artifactId: id, to: "MERGED" });
    assert.equal(merged.ok, true, `the satisfied pass gate must permit the merge: ${merged.reason ?? ""}`);
    assert.equal(statusOf(m, id), "MERGED");
  } finally {
    await m.cleanup();
  }
});

test("transition gate e2e: a pass stands in for a required approve, but never the reverse", async () => {
  // Asymmetry on purpose: a pass is a verified sign-off, so it is strictly
  // stronger than an approve and must satisfy a gate asking for one. Making
  // this symmetric would erase the distinction the previous test protects.
  const agents = [
    ...AGENTS.filter((a) => a.id !== "tech-lead"),
    { id: "tech-lead", role: "tech-lead", authority: ["implementation.approve", "implementation.pass"], capabilities: ["code.review", "git.merge"], interests: [] },
  ];
  const m = await makeMesh({
    agents,
    mayContact: COMM,
    transitions: { "patch.merge": ["tech-lead.approve"] },
    mode: "parked",
  });
  try {
    const created = await m.supervisor.createArtifact({
      actorId: "dev",
      name: "checkout-patch",
      type: "CodePatch",
      content: evidenceContent("checkout patch"),
    });
    if (!("artifact" in created)) throw new Error(`artifact failed: ${created.error}`);
    const id = created.artifact.id;

    assert.equal((await op(m, "dev", { op: "transition_artifact", artifactId: id, to: "READY_FOR_REVIEW" })).ok, true);
    assert.equal((await op(m, "tech-lead", { op: "transition_artifact", artifactId: id, to: "UNDER_REVIEW" })).ok, true);
    // Only a pass is ever recorded for this artifact — no approve at all.
    const passed = await op(m, "tech-lead", { op: "approve", kind: "pass", subject: "implementation", artifactId: id });
    assert.equal(passed.ok, true, `tech-lead must be able to record a pass: ${passed.reason ?? ""}`);

    // APPROVED demands an approve carrying this artifact id; the pass covers it.
    assert.equal((await op(m, "tech-lead", { op: "transition_artifact", artifactId: id, to: "APPROVED" })).ok, true, "a pass satisfies the APPROVED precondition");
    assert.equal((await op(m, "dev", { op: "transition_artifact", artifactId: id, to: "VERIFIED" })).ok, true);
    assert.equal((await op(m, "dev", { op: "transition_artifact", artifactId: id, to: "MERGEABLE" })).ok, true);

    const merged = await op(m, "tech-lead", { op: "transition_artifact", artifactId: id, to: "MERGED" });
    assert.equal(merged.ok, true, `a pass satisfies a required approve: ${merged.reason ?? ""}`);
    assert.equal(statusOf(m, id), "MERGED");
  } finally {
    await m.cleanup();
  }
});

test("transition gate e2e: a TEST_RESULT PASSED signs the gate only if the sender holds the authority", async () => {
  // A gate asks WHO must sign. `payload` is verbatim agent input, so recording
  // a sign-off because a message asserted `result: "PASSED"` would make the
  // cheapest way past a gate "claim it" rather than "be entitled to it" — and
  // `payload.subject` is agent-supplied too, so the claim need not even be
  // about the claimant's own domain. The authority list is the same one the
  // op path is checked against; the channel must not change the answer.
  const agents = [
    ...AGENTS.filter((a) => a.id !== "qa"),
    // Deliberately NO `quality.pass`: qa may object, not certify.
    { id: "qa", role: "qa", authority: ["quality.block"], capabilities: ["test.write", "test.execute"], interests: [] },
  ];
  const m = await makeMesh({
    agents,
    mayContact: COMM,
    transitions: { "patch.merge": ["qa.pass"] },
    mode: "parked",
  });
  try {
    const id = await patchAtMergeable(m);

    const sent = await m.supervisor.sendMessage({
      from: "qa",
      to: ["tech-lead"],
      type: "TEST_RESULT",
      newThread: { subject: "suite" },
      payload: { result: "PASSED", artifactId: id },
    });
    assert.ok(sent, "the message itself is legitimate traffic and must still be sent");

    // The report is on the record; it simply is not a signature.
    const signed = [...m.kernel.state.approvals.values()].flat().filter((r) => r.kind === "pass" && r.actorId === "qa");
    assert.equal(signed.length, 0, "an unentitled PASSED records no sign-off");

    const refused = await op(m, "tech-lead", { op: "transition_artifact", artifactId: id, to: "MERGED" });
    assert.equal(refused.ok, false, "an asserted payload field must not move an artifact");
    assert.match(refused.reason ?? "", /qa\.pass/, "the gate still reports the signature as missing");
    assert.equal(statusOf(m, id), "MERGEABLE", "the patch stays at the gate");
  } finally {
    await m.cleanup();
  }
});

test("transition gate e2e: an entitled TEST_RESULT PASSED does sign the gate", async () => {
  // The other half of the claim: this is a real sign-off channel, not a
  // disabled one. Granting the authority restores exactly the behaviour the
  // role prompts document, and the gate opens.
  const agents = [
    ...AGENTS.filter((a) => a.id !== "qa"),
    { id: "qa", role: "qa", authority: ["quality.block", "quality.pass"], capabilities: ["test.write", "test.execute"], interests: [] },
  ];
  const m = await makeMesh({
    agents,
    mayContact: COMM,
    transitions: { "patch.merge": ["qa.pass"] },
    mode: "parked",
  });
  try {
    const id = await patchAtMergeable(m);
    await m.supervisor.sendMessage({
      from: "qa",
      to: ["tech-lead"],
      type: "TEST_RESULT",
      newThread: { subject: "suite" },
      payload: { result: "PASSED", artifactId: id },
    });

    const signed = [...m.kernel.state.approvals.values()].flat().filter((r) => r.kind === "pass" && r.actorId === "qa");
    assert.equal(signed.length, 1, "an entitled PASSED records the sign-off");

    const merged = await op(m, "tech-lead", { op: "transition_artifact", artifactId: id, to: "MERGED" });
    assert.equal(merged.ok, true, `the signed gate must permit the merge: ${merged.reason ?? ""}`);
    assert.equal(statusOf(m, id), "MERGED");
  } finally {
    await m.cleanup();
  }
});

test("transition gate e2e: an owner holding the authority still cannot sign off their own patch by message", async () => {
  // The last way to satisfy a gate without a reviewer. `dev` owns the patch
  // AND genuinely holds `implementation.pass`, so the authority check passes —
  // only the self-approval screen stands between the author and their own
  // signature. The op path has screened this since supervisor.ts recordDecision;
  // the message path did not, so a TEST_RESULT was the cheap way around it.
  const agents = [
    { id: "dev", role: "developer", authority: ["implementation.pass"], capabilities: ["repository.write", "test.execute", "git.commit"], interests: [] },
    ...AGENTS.filter((a) => a.id !== "dev"),
  ];
  const m = await makeMesh({
    agents,
    mayContact: COMM,
    transitions: { "patch.merge": ["dev.pass"] },
    mode: "parked",
  });
  try {
    const id = await patchAtMergeable(m);

    const sent = await m.supervisor.sendMessage({
      from: "dev",
      to: ["tech-lead"],
      type: "TEST_RESULT",
      newThread: { subject: "my own suite" },
      payload: { result: "PASSED", subject: "implementation", artifactId: id },
    });
    assert.equal(sent.accepted, true, "the result is still delivered — it is a report, not a verdict");

    const signed = [...m.kernel.state.approvals.values()].flat().filter((r) => r.kind === "pass" && r.actorId === "dev");
    assert.equal(signed.length, 0, "an author's sign-off on their own artifact records nothing");

    const merged = await op(m, "tech-lead", { op: "transition_artifact", artifactId: id, to: "MERGED" });
    assert.equal(merged.ok, false, "the gate is not satisfiable by the artifact's own author");
    assert.equal(statusOf(m, id), "MERGEABLE", "the patch stays at the gate");

    // Unlike an unentitled PASSED, this refusal is surfaced: the owner is the
    // one agent that would otherwise sit waiting on a gate it believes it
    // satisfied, and the artifact would stall with nobody seeking a reviewer.
    const denials = (await collectEvents(m)).filter(
      (e) => e.type === "message.rejected" && (e.payload as Record<string, unknown>)?.ruleId === "authority.self-approval",
    );
    assert.equal(denials.length, 1, "the author learns the signature did not land");
    assert.equal((denials[0]!.payload as Record<string, unknown>).from, "dev", "and the denial names the author, not the gate");
  } finally {
    await m.cleanup();
  }
});

test("transition gate e2e: the same sign-off from a peer does open the gate", async () => {
  // The other half: the screen is about authorship, not about the channel.
  // tech-lead does not own the patch, so its message-path pass is a real
  // signature and the identical gate opens.
  const agents = [
    ...AGENTS.filter((a) => a.id !== "tech-lead"),
    { id: "tech-lead", role: "tech-lead", authority: ["implementation.approve", "implementation.pass"], capabilities: ["code.review", "git.merge"], interests: [] },
  ];
  const m = await makeMesh({
    agents,
    mayContact: COMM,
    transitions: { "patch.merge": ["tech-lead.pass"] },
    mode: "parked",
  });
  try {
    const id = await patchAtMergeable(m);

    await m.supervisor.sendMessage({
      from: "tech-lead",
      to: ["dev"],
      type: "TEST_RESULT",
      newThread: { subject: "reviewed the suite" },
      payload: { result: "PASSED", subject: "implementation", artifactId: id },
    });

    const signed = [...m.kernel.state.approvals.values()].flat().filter((r) => r.kind === "pass" && r.actorId === "tech-lead");
    assert.equal(signed.length, 1, "a non-owner's sign-off is recorded");

    const merged = await op(m, "tech-lead", { op: "transition_artifact", artifactId: id, to: "MERGED" });
    assert.equal(merged.ok, true, `the signed gate must permit the merge: ${merged.reason ?? ""}`);
    assert.equal(statusOf(m, id), "MERGED");
  } finally {
    await m.cleanup();
  }
});

test("transition gate e2e: a BLOCK holds the artifact until a new version reworks it", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, transitions: GATES, mode: "parked" });
  try {
    const id = await patchAtMergeable(m);

    // qa blocks on quality. The block outranks the tech-lead approval that
    // already satisfies `patch.merge` — otherwise "approved earlier" would
    // beat "broken now".
    const blocked = await op(m, "qa", { op: "block", subject: "quality", artifactId: id, reason: "integration suite fails on checkout" });
    assert.equal(blocked.ok, true, `qa must be able to block: ${blocked.reason ?? ""}`);

    const refused = await op(m, "tech-lead", { op: "transition_artifact", artifactId: id, to: "MERGED" });
    assert.equal(refused.ok, false, "an active block must refuse the merge despite a satisfied approval gate");
    assert.match(refused.reason ?? "", /BLOCK|block/, "the refusal names the block");
    assert.equal(statusOf(m, id), "MERGEABLE", "the blocked patch does not move");

    // REWORK: a new version is the only way out. Sending the patch back to
    // UNDER_REVIEW alone must NOT clear the block — that would let an agent
    // launder a failure by re-requesting review.
    const stillBlocked = await op(m, "tech-lead", { op: "transition_artifact", artifactId: id, to: "UNDER_REVIEW" });
    assert.equal(stillBlocked.ok, false, "re-review is not rework: the block survives a status shuffle");

    const blockedVersion = m.kernel.state.artifacts.get(id)?.version;
    const rework = await m.supervisor.createArtifact({
      actorId: "dev",
      name: "checkout-patch",
      type: "CodePatch",
      content: evidenceContent("checkout patch, integration suite fixed"),
      asVersionOf: id,
    });
    if (!("artifact" in rework)) throw new Error(`rework failed: ${rework.error}`);
    // A version is an identity-preserving bump, not a new record: the id is
    // stable so reviews, leases and gate tokens keep pointing at the same
    // thing. What changes is the version number and the reset status.
    assert.equal(rework.artifact.id, id, "versioning preserves artifact identity");
    assert.equal(rework.artifact.version, (blockedVersion ?? 1) + 1, "the rework bumps the version");
    assert.equal(statusOf(m, id), "DRAFT", "a new version restarts the review walk from DRAFT");
    // The superseded version is still on the record; rework does not erase
    // the history a reviewer needs to see what was blocked and why.
    const history = m.kernel.state.artifactHistory.get(id) ?? [];
    assert.ok(history.some((v) => v.version === blockedVersion), "the blocked version stays in the history");

    // The new version walks the gate again from the top, on its own merits.
    assert.equal((await op(m, "dev", { op: "transition_artifact", artifactId: id, to: "READY_FOR_REVIEW" })).ok, true);
    assert.equal((await op(m, "tech-lead", { op: "transition_artifact", artifactId: id, to: "UNDER_REVIEW" })).ok, true);
    assert.equal((await op(m, "tech-lead", { op: "approve", subject: "implementation", artifactId: id })).ok, true);
    assert.equal((await op(m, "tech-lead", { op: "transition_artifact", artifactId: id, to: "APPROVED" })).ok, true);
    assert.equal((await op(m, "dev", { op: "transition_artifact", artifactId: id, to: "VERIFIED" })).ok, true);
    assert.equal((await op(m, "dev", { op: "transition_artifact", artifactId: id, to: "MERGEABLE" })).ok, true);

    const mergedV2 = await op(m, "tech-lead", { op: "transition_artifact", artifactId: id, to: "MERGED" });
    assert.equal(mergedV2.ok, true, `the reworked version merges: ${mergedV2.reason ?? ""}`);
    assert.equal(statusOf(m, id), "MERGED");
    assert.equal(m.kernel.state.artifacts.get(id)?.version, (blockedVersion ?? 1) + 1, "it is the REWORKED version that merged");
  } finally {
    await m.cleanup();
  }
});

test("transition gate e2e: a BLOCK message stalls the merge only if the sender holds the authority", async () => {
  // The mirror of the PASSED hole. `payload` is verbatim agent input, so
  // without an authority check any agent permitted to send a BLOCK could
  // withhold ANY artifact in ANY domain — the cheapest possible denial of
  // service — purely by asserting it. `dev` holds no `quality.block`.
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, transitions: GATES, mode: "parked" });
  try {
    const id = await patchAtMergeable(m);

    const sent = await m.supervisor.sendMessage({
      from: "dev",
      to: ["tech-lead"],
      type: "BLOCK",
      newThread: { subject: "objection" },
      payload: { subject: "quality", artifactId: id, reason: "I would rather it did not merge" },
    });
    assert.equal(sent.accepted, true, "the objection is still delivered — it is a concern, not a verdict");

    const blocks = [...m.kernel.state.approvals.values()].flat().filter((r) => r.kind === "block");
    assert.equal(blocks.length, 0, "asserting BLOCK is not holding quality.block");

    const merged = await op(m, "tech-lead", { op: "transition_artifact", artifactId: id, to: "MERGED" });
    assert.equal(merged.ok, true, `an unentitled block must not stall the gate: ${merged.reason ?? ""}`);
    assert.equal(statusOf(m, id), "MERGED");

    // Silence would be the real bug: the sender has to learn the objection
    // carried no weight, or it goes quiet believing the artifact is held.
    const types = eventTypes(await collectEvents(m));
    assert.ok(types.includes("message.rejected"), "the refusal is on the log where the sender and a human can see it");
    assert.ok(m.kernel.state.conflicts.has("unauthorized-block:dev:quality"), "and it is counted so repetition escalates");
  } finally {
    await m.cleanup();
  }
});

test("transition gate e2e: an entitled BLOCK message does stall the merge", async () => {
  // The other half: gating must not break the legitimate path. qa holds
  // `quality.block`, so its message-path block outranks the satisfied gate
  // exactly as its op-path block does.
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, transitions: GATES, mode: "parked" });
  try {
    const id = await patchAtMergeable(m);

    await m.supervisor.sendMessage({
      from: "qa",
      to: ["tech-lead"],
      type: "BLOCK",
      newThread: { subject: "suite fails" },
      payload: { subject: "quality", artifactId: id, reason: "integration suite fails on checkout" },
    });

    const blocks = [...m.kernel.state.approvals.values()].flat().filter((r) => r.kind === "block" && r.actorId === "qa");
    assert.equal(blocks.length, 1, "an entitled block is recorded");

    const refused = await op(m, "tech-lead", { op: "transition_artifact", artifactId: id, to: "MERGED" });
    assert.equal(refused.ok, false, "the entitled block holds the artifact");
    assert.equal(statusOf(m, id), "MERGEABLE");
  } finally {
    await m.cleanup();
  }
});
