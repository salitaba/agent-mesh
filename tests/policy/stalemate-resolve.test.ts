import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";

test("stale-resolve: answerStuckRequest sends a replyTo answer and clears the pending request", async () => {
  const m = await makeMesh({
    agents: [
      { id: "asker", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "ghost", role: "architect", capabilities: ["review.design"], authority: ["architecture.approve"], interests: [] },
    ],
    mayContact: { asker: ["ghost"], ghost: ["asker"] },
  });
  const sent = await m.supervisor.sendMessage({
    from: "asker",
    to: ["ghost"],
    type: "REQUEST",
    newThread: { subject: "need the doc" },
    payload: { question: "where is it?" },
  });
  assert.equal(sent.accepted, true);
  assert.equal(m.kernel.state.pendingRequests.size, 1);
  await m.supervisor.escalateStuckRequest("ghost", sent.messageId!);
  const esc = [...m.kernel.state.escalations.values()].find((e) => e.reason === "stalemate:unanswered_request")!;
  assert.ok(esc, "stuck escalation must exist");

  const ans = await m.supervisor.answerStuckRequest(esc.id, "here it is: doc v3");
  assert.equal(ans.ok, true);
  assert.equal(m.kernel.state.pendingRequests.size, 0, "operator answer must clear the pending request");
  const msg = m.kernel.state.messages.get(ans.messageId!);
  assert.equal(msg?.replyTo, sent.messageId, "answer must carry replyTo so projections clear it deterministically");
  assert.equal(msg?.threadId, m.kernel.state.messages.get(sent.messageId!)?.threadId, "answer stays in the original thread");
  await m.cleanup();
});

test("stale-resolve: dropStuckRequest deletes the pending entry without fabricating an answer", async () => {
  const m = await makeMesh({
    agents: [
      { id: "asker", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "ghost", role: "architect", capabilities: ["review.design"], authority: ["architecture.approve"], interests: [] },
    ],
    mayContact: { asker: ["ghost"], ghost: ["asker"] },
  });
  const sent = await m.supervisor.sendMessage({
    from: "asker",
    to: ["ghost"],
    type: "REQUEST",
    newThread: { subject: "obsolete ask" },
    payload: { question: "still needed?" },
  });
  assert.equal(sent.accepted, true);
  await m.supervisor.escalateStuckRequest("ghost", sent.messageId!);
  const esc = [...m.kernel.state.escalations.values()].find((e) => e.reason === "stalemate:unanswered_request")!;
  const before = m.kernel.state.messages.size;
  const d = await m.supervisor.dropStuckRequest(esc.id, "no longer needed");
  assert.equal(d.ok, true);
  assert.equal(m.kernel.state.pendingRequests.size, 0, "drop must clear the pending request");
  assert.equal(m.kernel.state.messages.size, before, "drop must not fabricate an answer message");
  const inputs = [...m.kernel.state.messages.values()].length; // silence unused-var lint about state shape
  void inputs;
  await m.cleanup();
});

test("stale-resolve: responding to the underlying stuck card retires the derived stalemate card", async () => {
  const m = await makeMesh({
    agents: [
      { id: "asker", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "ghost", role: "architect", capabilities: ["review.design"], authority: ["architecture.approve"], interests: [] },
    ],
    mayContact: { asker: ["ghost"], ghost: ["asker"] },
  });
  const sent = await m.supervisor.sendMessage({
    from: "asker",
    to: ["ghost"],
    type: "REQUEST",
    newThread: { subject: "need the doc" },
    payload: { question: "where is it?" },
  });
  await m.supervisor.escalateStuckRequest("ghost", sent.messageId!);
  const stuck = [...m.kernel.state.escalations.values()].find((e) => e.reason === "stalemate:unanswered_request")!;
  // Simulate the watchdog's derived card the way termination.ts builds it.
  const derived = await m.supervisor.escalate({
    reason: "stalemate",
    raisedBy: "termination-manager",
    detail: { openDeadlockEscalations: [{ id: stuck.id, conflictKey: stuck.conflictKey, reason: stuck.reason }] },
  });
  const r = await m.supervisor.respondEscalation(stuck.id, "answered below");
  assert.equal(r.ok, true);
  // AUTO_RESOLVED, not RESPONDED: the operator answered the underlying
  // request, not this summary. Recording it as RESPONDED would attribute a
  // decision to the human that they never made.
  assert.equal(
    m.kernel.state.escalations.get(derived.id)?.status,
    "AUTO_RESOLVED",
    "derived stalemate card must auto-retire once the underlying request is resolved",
  );
  await m.cleanup();
});

test("stale-resolve: responding to a derived stalemate card resolves the underlying stuck cards", async () => {
  const m = await makeMesh({
    agents: [
      { id: "asker", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "ghost", role: "architect", capabilities: ["review.design"], authority: ["architecture.approve"], interests: [] },
    ],
    mayContact: { asker: ["ghost"], ghost: ["asker"] },
  });
  const sent = await m.supervisor.sendMessage({
    from: "asker",
    to: ["ghost"],
    type: "REQUEST",
    newThread: { subject: "need the doc" },
    payload: { question: "where is it?" },
  });
  await m.supervisor.escalateStuckRequest("ghost", sent.messageId!);
  const stuck = [...m.kernel.state.escalations.values()].find((e) => e.reason === "stalemate:unanswered_request")!;
  const derived = await m.supervisor.escalate({
    reason: "stalemate",
    raisedBy: "termination-manager",
    detail: { openDeadlockEscalations: [{ id: stuck.id, conflictKey: stuck.conflictKey, reason: stuck.reason }] },
  });
  const r = await m.supervisor.respondEscalation(derived.id, "drop it, moving on");
  assert.equal(r.ok, true);
  assert.equal(
    m.kernel.state.escalations.get(stuck.id)?.status,
    "RESPONDED",
    "underlying stuck card must not stay OPEN after the derived card is answered",
  );
  await m.cleanup();
});

test("stale-resolve: TEST_RESULT with payload.artifact (not artifactId) clears the review request", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "qa", role: "qa", capabilities: ["test.execute"], interests: [] },
    ],
    mayContact: { dev: ["qa"], qa: ["dev"] },
  });
  const pub = await m.supervisor.createArtifact({ actorId: "dev", name: "p1", type: "CodePatch", content: "diff" });
  assert.ok("artifact" in pub);
  const { artifactUri } = await import("../../packages/protocol/src/uri");
  const uri = artifactUri(pub.artifact.type, pub.artifact.name, pub.artifact.version);
  const req = await m.supervisor.sendMessage({
    from: "dev",
    to: ["qa"],
    type: "REQUEST_REVIEW",
    newThread: { subject: "review p1" },
    artifactRefs: [{ uri }],
    payload: { question: "please review" },
  });
  assert.equal(req.accepted, true);
  assert.equal(m.kernel.state.pendingRequests.size, 1);
  // Real qa shape: fresh thread, `artifact` field instead of `artifactId`.
  const ans = await m.supervisor.sendMessage({
    from: "qa",
    to: ["dev"],
    type: "TEST_RESULT",
    newThread: { subject: "qa verdict" },
    artifactRefs: [{ uri }],
    payload: { result: "FAILED", artifact: uri },
  });
  assert.equal(ans.accepted, true);
  assert.equal(m.kernel.state.pendingRequests.size, 0, "artifact-pointer answer must resolve the review request");
  await m.cleanup();
});

test("stale-resolve: publishing a new artifact version retires review requests for older versions", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "qa", role: "qa", capabilities: ["test.execute"], interests: [] },
    ],
    mayContact: { dev: ["qa"], qa: ["dev"] },
  });
  const pub = await m.supervisor.createArtifact({ actorId: "dev", name: "p1", type: "CodePatch", content: "diff v1" });
  assert.ok("artifact" in pub);
  const { artifactUri } = await import("../../packages/protocol/src/uri");
  const uri = artifactUri(pub.artifact.type, pub.artifact.name, pub.artifact.version);
  const req = await m.supervisor.sendMessage({
    from: "dev",
    to: ["qa"],
    type: "REQUEST_REVIEW",
    newThread: { subject: "review p1 v1" },
    artifactRefs: [{ uri }],
    payload: { question: "please review" },
  });
  assert.equal(req.accepted, true);
  assert.equal(m.kernel.state.pendingRequests.size, 1);
  const v2 = await m.supervisor.createArtifact({ actorId: "dev", name: "p1", type: "CodePatch", content: "diff v2", asVersionOf: pub.artifact.id });
  assert.ok("artifact" in v2);
  assert.equal(m.kernel.state.pendingRequests.size, 0, "v2 publish must retire the v1 review ask");
  await m.cleanup();
});

test("stale-resolve: humanSend with replyTo clears the pending request", async () => {
  const m = await makeMesh({
    agents: [
      { id: "asker", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "ghost", role: "architect", capabilities: ["review.design"], authority: ["architecture.approve"], interests: [] },
    ],
    mayContact: { asker: ["ghost"], ghost: ["asker"] },
  });
  const sent = await m.supervisor.sendMessage({
    from: "asker",
    to: ["ghost"],
    type: "REQUEST",
    newThread: { subject: "need the doc" },
    payload: { question: "where is it?" },
  });
  assert.equal(sent.accepted, true);
  const orig = m.kernel.state.messages.get(sent.messageId!)!;
  const r = await m.supervisor.humanSend([orig.from], "INFORM", { answer: "doc v3" }, orig.threadId, { replyTo: orig.id });
  assert.equal(r.accepted, true);
  assert.equal(m.kernel.state.pendingRequests.size, 0, "human replyTo must clear the pending request");
  await m.cleanup();
});
