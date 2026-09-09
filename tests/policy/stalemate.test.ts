import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";

test("stalemate: an unanswered request escalates after the nudge limit instead of burning budget forever", async () => {
  const m = await makeMesh({
    agents: [
      { id: "asker", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "ghost", role: "architect", capabilities: ["review.design"], authority: ["architecture.approve"], interests: [] },
    ],
    mayContact: { asker: ["ghost"], ghost: [] },
    waitWakeupMs: 60,
  });
  const s = stub(m);
  // asker sends a REQUEST_REVIEW; ghost has NO script, so it can never answer.
  s.setScript("asker", async (_i, turn) => {
    if (turn === 0) return { operations: [{ op: "send", type: "REQUEST_REVIEW", to: ["ghost"], newThread: { subject: "review plz" }, payload: { q: 1 } }, { op: "wait" }] as MeshOp[] };
    return { operations: [{ op: "done" } as MeshOp] };
  });
  // ghost intentionally has no script → returns done, never resolves the request.

  await m.supervisor.activateAgent("asker", { kind: "manual" });
  // wait for the scheduler to nudge ghost past MAX_NUDGES and escalate
  const deadline = Date.now() + 8000;
  let escalated = false;
  while (Date.now() < deadline && !escalated) {
    await new Promise((r) => setTimeout(r, 100));
    escalated = [...m.kernel.state.escalations.values()].some((e) => e.reason === "stalemate:unanswered_request");
  }
  assert.ok(escalated, "a request that is never answered must escalate as a stalemate");
  const esc = [...m.kernel.state.escalations.values()].find((e) => e.reason === "stalemate:unanswered_request")!;
  assert.ok(esc.disagreementArtifactRef, "stalemate escalation carries a disagreement artifact");
  // ghost activations should be bounded (a few nudges, then silence), not infinite
  const ghostActs = m.kernel.state.agents.get("ghost")!.state.activations;
  assert.ok(ghostActs <= 6, `nudge storm not bounded: ${ghostActs} activations`);

  // an operator can unblock it
  const r = await m.supervisor.respondEscalation(esc.id, "approve it manually");
  assert.equal(r.ok, true);
  await m.cleanup();
});

test("pending: an approve decision resolves the REQUEST_REVIEW (no false stalemate)", async () => {
  const m = await makeMesh({
    agents: [
      { id: "asker", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "ghost", role: "architect", capabilities: ["review.design"], authority: ["architecture.approve"], interests: [] },
    ],
    mayContact: { asker: ["ghost"], ghost: ["asker"] },
    waitWakeupMs: 60,
  });
  const s = stub(m);
  s.setScript("asker", async (_i, turn) => {
    if (turn !== 0) return { operations: [{ op: "done" } as MeshOp] };
    return {
      operations: [
        { op: "publish_artifact", name: "design1", type: "ArchitectureDocument", content: "arch v1" },
        { op: "done" },
      ] as MeshOp[],
    };
  });
  // asker publishes first; the review request is sent explicitly so we can
  // attach the artifact ref of the just-published version.
  await m.supervisor.activateAgent("asker", { kind: "manual" });
  await waitFor("asker published", () => m.kernel.state.artifacts.size === 1, 8000);
  const art = [...m.kernel.state.artifacts.values()][0];
  const { artifactUri } = await import("../../packages/protocol/src/uri");
  s.setScript("ghost", async () => ({
    operations: [{ op: "approve", subject: "architecture", artifactId: art.id, comment: "looks good" }] as MeshOp[],
  }));
  const sent = await m.supervisor.sendMessage({
    from: "asker",
    to: ["ghost"],
    type: "REQUEST_REVIEW",
    newThread: { subject: "review design1", artifactRefs: [{ uri: artifactUri(art.type, art.name, art.version) }] },
    artifactRefs: [{ uri: artifactUri(art.type, art.name, art.version) }],
    payload: { question: "please review" },
  });
  assert.equal(sent.accepted, true);
  await waitFor("ghost approved", () => m.kernel.state.artifacts.get(art.id)?.status === "APPROVED", 8000);
  assert.equal(m.kernel.state.pendingRequests.size, 0, "approve must resolve the review request");
  // Let several nudge intervals pass: no false stalemate may appear.
  await new Promise((r) => setTimeout(r, 600));
  assert.ok(
    ![...m.kernel.state.escalations.values()].some((e) => e.reason === "stalemate:unanswered_request"),
    "a resolved review must not escalate as stuck",
  );
  await m.cleanup();
});

test("pending: an in-thread INFORM from the asked agent resolves the request (no false stalemate)", async () => {
  const m = await makeMesh({
    agents: [
      { id: "asker", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "answerer", role: "architect", capabilities: ["review.design"], authority: ["architecture.approve"], interests: [] },
    ],
    mayContact: { asker: ["answerer"], answerer: ["asker"] },
  });
  const req = await m.supervisor.sendMessage({
    from: "asker",
    to: ["answerer"],
    type: "REQUEST",
    newThread: { subject: "need the doc" },
    payload: { question: "where is it?" },
  });
  assert.equal(req.accepted, true);
  assert.equal(m.kernel.state.pendingRequests.size, 1);
  // Small models (and the `reply` alias) answer with a plain INFORM in the
  // same thread instead of a typed APPROVE/`respond`. That must close the
  // ask — otherwise the nudge loop escalates a stalemate nobody can answer.
  const asked = m.kernel.state.messages.get(req.messageId!);
  const ans = await m.supervisor.sendMessage({
    from: "answerer",
    to: ["asker"],
    type: "INFORM",
    threadId: asked!.threadId,
    payload: { answer: "here it is" },
  });
  assert.equal(ans.accepted, true);
  assert.equal(m.kernel.state.pendingRequests.size, 0, "in-thread INFORM from the asked agent must resolve the request");
  await m.cleanup();
});

test("pending: completing a task resolves a task-scoped request", async () => {
  const m = await makeMesh({
    agents: [
      { id: "asker", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "worker", role: "developer", capabilities: ["repository.write"], interests: [] },
    ],
    mayContact: { asker: ["worker"], worker: ["asker"] },
    waitWakeupMs: 60,
  });
  const created = await m.supervisor.sendMessage({
    from: "asker",
    to: ["worker"],
    type: "REQUEST_EXECUTION",
    newThread: { subject: "do thing" },
    payload: { spec: "thing" },
    taskId: "task-linked-1",
  });
  assert.equal(created.accepted, true);
  assert.equal(m.kernel.state.pendingRequests.size, 1);
  // A task completion for the linked task resolves the request even though no
  // message with replyTo was ever sent.
  await m.kernel.emit(
    "task.completed",
    { taskId: "task-linked-1", agentId: "worker", summary: "done" },
    { actorId: "worker" },
  );
  assert.equal(
    [...m.kernel.state.pendingRequests.values()].filter((p) => p.taskId === "task-linked-1").length,
    0,
    "task completion must clear the linked request",
  );
  await m.cleanup();
});

test("context: shared design docs are visible even as unreferenced DRAFTs", async () => {
  const { buildAgentContext } = await import("../../packages/core/src/context");
  const m = await makeMesh({
    agents: [
      { id: "pm", role: "product-manager", capabilities: ["repository.read"], authority: ["requirements.accept"], interests: [] },
      { id: "arch", role: "architect", capabilities: ["architecture.write"], authority: ["architecture.approve"], interests: [] },
    ],
    mayContact: { pm: ["arch"], arch: ["pm"] },
  });
  // Architect publishes a design doc with no review request and no mail
  // reference — exactly the state that left pm claiming "no ArchitectureDoc".
  const pub = await m.supervisor.createArtifact({ actorId: "arch", name: "design", type: "ArchitectureDocument", content: "modules..." });
  assert.ok("artifact" in pub);
  const ctx = buildAgentContext({ config: m.config, kernel: m.kernel }, "pm");
  assert.ok(
    ctx.relevantArtifacts.some((a) => a.name === "design"),
    `pm must see the design DRAFT without being handed a ref, saw ${JSON.stringify(ctx.relevantArtifacts)}`,
  );
  await m.cleanup();
});

test("stalemate: responding wakes the stuck agent (not just recovery candidates)", async () => {
  const m = await makeMesh({
    agents: [
      { id: "asker", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "ghost", role: "architect", capabilities: ["review.design"], authority: ["architecture.approve"], interests: [] },
    ],
    mayContact: { asker: ["ghost"], ghost: [] },
    waitWakeupMs: 60,
  });
  const s = stub(m);
  s.setScript("asker", async (_i, turn) => {
    if (turn === 0) return { operations: [{ op: "send", type: "REQUEST_REVIEW", to: ["ghost"], newThread: { subject: "review plz" }, payload: { q: 1 } }, { op: "wait" }] as MeshOp[] };
    return { operations: [{ op: "done" } as MeshOp] };
  });
  await m.supervisor.activateAgent("asker", { kind: "manual" });
  await waitFor(
    "stalemate escalates",
    () => [...m.kernel.state.escalations.values()].some((e) => e.reason === "stalemate:unanswered_request"),
    8000,
  );
  const esc = [...m.kernel.state.escalations.values()].find((e) => e.reason === "stalemate:unanswered_request")!;
  // ghost is IDLE with an empty inbox here (mail already delivered) — the old
  // recoveryCandidates() would NOT include it, so this asserts the explicit
  // stuck-agent wake.
  const before = m.kernel.state.agents.get("ghost")!.state.activations;
  const r = await m.supervisor.respondEscalation(esc.id, "retry the review");
  assert.equal(r.ok, true);
  await waitFor("ghost woken after respond", () => m.kernel.state.agents.get("ghost")!.state.activations > before, 8000);
  await m.cleanup();
});

test("pending: one answer discharges only the ask it reaches, not every ask in the thread", async () => {
  const m = await makeMesh({
    agents: [
      { id: "architect", role: "architect", capabilities: ["review.design"], interests: [] },
      { id: "pm", role: "pm", authority: ["requirements.accept"], interests: [] },
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
    ],
    mayContact: { architect: ["dev", "pm"], pm: ["dev", "architect"], dev: ["architect", "pm"] },
    mode: "parked",
  });
  const state = m.kernel.state;

  // Two agents ask the same reviewer inside one thread — routine in a mesh.
  const fromArchitect = await m.supervisor.sendMessage({
    from: "architect", to: ["dev"], type: "REQUEST",
    newThread: { subject: "shared review thread" }, payload: { q: "architecture question" },
  });
  const threadId = state.messages.get(fromArchitect.messageId!)!.threadId;
  const fromPm = await m.supervisor.sendMessage({
    from: "pm", to: ["dev"], type: "REQUEST", threadId, payload: { q: "requirements question" },
  });
  assert.equal(state.pendingRequests.size, 2, "both asks must be pending");

  // dev answers ONLY the architect.
  await m.supervisor.sendMessage({
    from: "dev", to: ["architect"], type: "INFORM", threadId,
    payload: { answer: "for the architect" },
  });

  assert.equal(state.pendingRequests.has(fromArchitect.messageId!), false, "the answered ask is discharged");
  assert.equal(
    state.pendingRequests.has(fromPm.messageId!),
    true,
    "pm's ask is unanswered and must stay pending — silently clearing it makes pm wait forever with no nudge and no stalemate",
  );
  await m.cleanup();
});

test("pending: an in-thread answer addressed to the asker still discharges without replyTo", async () => {
  // The permissive path must keep working: models routinely answer with a
  // fresh INFORM instead of `respond`, and leaving those pending raises a
  // false stalemate after the nudge limit.
  const m = await makeMesh({
    agents: [
      { id: "architect", role: "architect", capabilities: ["review.design"], interests: [] },
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
    ],
    mayContact: { architect: ["dev"], dev: ["architect"] },
    mode: "parked",
  });
  const state = m.kernel.state;
  const ask = await m.supervisor.sendMessage({
    from: "architect", to: ["dev"], type: "REQUEST",
    newThread: { subject: "which db?" }, payload: { q: "which db?" },
  });
  const threadId = state.messages.get(ask.messageId!)!.threadId;
  assert.equal(state.pendingRequests.has(ask.messageId!), true);
  await m.supervisor.sendMessage({
    from: "dev", to: ["architect"], type: "INFORM", threadId, payload: { answer: "postgres" },
  });
  assert.equal(state.pendingRequests.has(ask.messageId!), false, "a plain in-thread INFORM to the asker discharges the ask");
  await m.cleanup();
});

test("context: an agent sees its open loops in both directions", async () => {
  const { buildAgentContext, renderContextInstructions } = await import("../../packages/core/src/context");
  const m = await makeMesh({
    agents: [
      { id: "architect", role: "architect", capabilities: ["review.design"], interests: [] },
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
    ],
    mayContact: { architect: ["dev"], dev: ["architect"] },
    mode: "parked",
  });
  const deps = { config: m.config, kernel: m.kernel };

  // Nothing outstanding yet: the agent must be told so explicitly, otherwise
  // a timer wake looks identical to a mission with work pending.
  const idle = renderContextInstructions(buildAgentContext(deps, "architect"));
  assert.match(idle, /Nothing is pending in either direction/);

  const ask = await m.supervisor.sendMessage({
    from: "architect", to: ["dev"], type: "REQUEST",
    newThread: { subject: "which db?" }, payload: { q: "which db?" },
  });

  // Asker: knows it already sent this, so it must not re-send it.
  const askerCtx = buildAgentContext(deps, "architect");
  assert.equal(askerCtx.outstanding.awaitingResponse.length, 1);
  assert.equal(askerCtx.outstanding.owedByYou.length, 0);
  const askerText = renderContextInstructions(askerCtx);
  assert.match(askerText, /WAITING on dev/);
  assert.match(askerText, /do NOT send it again/);
  assert.ok(askerText.includes(ask.messageId!), "the pending message id must be visible to the asker");

  // Askee: knows it owes an answer.
  const askeeCtx = buildAgentContext(deps, "dev");
  assert.equal(askeeCtx.outstanding.owedByYou.length, 1);
  assert.equal(askeeCtx.outstanding.awaitingResponse.length, 0);
  assert.match(renderContextInstructions(askeeCtx), /YOU OWE architect an answer/);

  // Once answered, the loop disappears from both sides.
  await m.supervisor.sendMessage({
    from: "dev", to: ["architect"], type: "INFORM",
    threadId: m.kernel.state.messages.get(ask.messageId!)!.threadId,
    replyTo: ask.messageId, payload: { answer: "postgres" },
  });
  assert.equal(buildAgentContext(deps, "architect").outstanding.awaitingResponse.length, 0);
  assert.equal(buildAgentContext(deps, "dev").outstanding.owedByYou.length, 0);
  await m.cleanup();
});
