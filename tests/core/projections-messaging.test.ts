import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEvent } from "../../packages/core/src/projections";
import { applyMessagingEvent } from "../../packages/core/src/projections-messaging";
import { approvalKey, createInitialState, MAX_UNREAD_PER_AGENT, type Projections } from "../../packages/core/src/state";
import { PROTOCOL_VERSION, type AgentDefinition, type ArtifactRef, type MeshEvent, type MeshMessage, type MessageType, type Thread } from "../../packages/protocol/src/index";

/**
 * Messaging projection tests.
 *
 * `applyMessagingEvent` is normally reached only through `applyEvent`'s
 * dispatch chain, so its branches were covered incidentally by end-to-end
 * suites and its contract was never asserted directly. These tests drive it
 * through `applyEvent` (the real entry point, so the dispatch order is
 * exercised too) and hand-call it only where the return-value contract itself
 * is under test.
 */

const GOAL_ID = "goal-msg";
const THREAD_ID = "thr-1";

let seq = 0;
function evt(type: string, payload: Record<string, unknown>, over: Partial<MeshEvent> = {}): MeshEvent {
  seq++;
  return {
    id: over.id ?? `evt-msg-${seq}`,
    protocolVersion: PROTOCOL_VERSION,
    type: type as MeshEvent["type"],
    timestamp: over.timestamp ?? `2026-01-01T00:00:${String(seq % 60).padStart(2, "0")}.000Z`,
    goalId: over.goalId ?? GOAL_ID,
    actorId: over.actorId,
    seq,
    payload,
  } as MeshEvent;
}

let msgSeq = 0;
function message(over: Partial<MeshMessage> & { from: string; to: string[]; type: MessageType }): MeshMessage {
  msgSeq++;
  return {
    id: over.id ?? `msg-${msgSeq}`,
    protocolVersion: PROTOCOL_VERSION,
    type: over.type,
    timestamp: over.timestamp ?? `2026-01-01T00:10:${String(msgSeq % 60).padStart(2, "0")}.000Z`,
    goalId: over.goalId ?? GOAL_ID,
    from: over.from,
    to: over.to,
    threadId: over.threadId ?? THREAD_ID,
    replyTo: over.replyTo,
    artifactRefs: over.artifactRefs ?? [],
    payload: over.payload ?? {},
    priority: over.priority ?? "NORMAL",
    taskId: over.taskId,
    control: over.control,
  } as MeshMessage;
}

function thread(over: Partial<Thread> = {}): Thread {
  return {
    id: over.id ?? THREAD_ID,
    goalId: GOAL_ID,
    subject: over.subject ?? "review round",
    initiator: over.initiator ?? "architect",
    artifactRefs: over.artifactRefs ?? [],
    participants: over.participants ?? [],
    depth: over.depth ?? 1,
    messageIds: over.messageIds ?? [],
    status: "OPEN",
    budget: {},
    createdAt: "2026-01-01T00:00:00.000Z",
  } as Thread;
}

function agentDef(id: string, role: string): AgentDefinition {
  return { id, role, mode: "peer", capabilities: [], authority: [], interests: [] } as unknown as AgentDefinition;
}

/** A state with the given agents registered and one open thread. */
function seed(agents: Array<[string, string]> = [["architect", "architect"], ["dev", "developer"], ["qa", "qa"]]): Projections {
  const state = createInitialState();
  for (const [id, role] of agents) applyEvent(state, evt("agent.created", { agent: agentDef(id, role) }));
  applyEvent(state, evt("thread.created", { thread: thread() }));
  return state;
}

function send(state: Projections, m: MeshMessage, config?: { commitmentSemantic?: "compat" | "strict" }): void {
  applyEvent(state, evt("message.sent", { message: m }, { actorId: m.from }), config);
}

// ------------------------------------------------------------ dispatch

test("messaging projection: returns false for a type it does not own, so dispatch falls through", () => {
  const state = createInitialState();
  assert.equal(applyMessagingEvent(state, evt("goal.created", {}), {}), false, "unowned type must not be claimed");
  assert.equal(applyMessagingEvent(state, evt("message.rejected", {}), {}), true, "message.rejected is owned but inert");
  assert.equal(applyMessagingEvent(state, evt("thread.created", { thread: thread() }), { thread: thread() }), true);
});

test("messaging projection: message.rejected records nothing — a refused send leaves no trace in the views", () => {
  const state = seed();
  applyEvent(state, evt("message.rejected", { from: "dev", to: ["qa"], type: "REQUEST_REVIEW", reason: "schema invalid" }));

  assert.equal(state.messages.size, 0);
  assert.equal(state.pendingRequests.size, 0);
  assert.deepEqual(state.unread.get("qa") ?? [], [], "a rejected message must never reach a mailbox");
});

// -------------------------------------------------------------- threads

test("thread.created: stores the thread; message.sent appends the id and accumulates participants", () => {
  const state = seed();
  send(state, message({ id: "msg-a", from: "architect", to: ["dev"], type: "INFORM" }));
  send(state, message({ id: "msg-b", from: "dev", to: ["qa"], type: "INFORM" }));

  const t = state.threads.get(THREAD_ID)!;
  assert.deepEqual(t.messageIds, ["msg-a", "msg-b"], "messages are appended in order");
  assert.deepEqual(t.participants, ["architect", "dev", "qa"], "participants accumulate from both from and to, deduped");
});

test("message.sent: a message on an unknown thread is still stored and delivered", () => {
  const state = seed();
  send(state, message({ id: "msg-orphan", from: "dev", to: ["qa"], type: "INFORM", threadId: "thr-does-not-exist" }));

  assert.ok(state.messages.has("msg-orphan"), "the message is recorded even with no thread to attach it to");
  assert.deepEqual(state.unread.get("qa"), ["msg-orphan"], "delivery does not depend on the thread existing");
});

test("message.sent: a re-sent message id does not duplicate the thread entry", () => {
  const state = seed();
  const m = message({ id: "msg-same", from: "dev", to: ["qa"], type: "INFORM" });
  send(state, m);
  send(state, m);

  assert.deepEqual(state.threads.get(THREAD_ID)!.messageIds, ["msg-same"], "messageIds is deduped");
});

// ------------------------------------------------------------- delivery

test("message.sent: delivers to every recipient, skips the sender, and syncs mailboxDepth", () => {
  const state = seed();
  send(state, message({ id: "msg-fan", from: "architect", to: ["dev", "qa", "architect"], type: "INFORM" }));

  assert.deepEqual(state.unread.get("dev"), ["msg-fan"]);
  assert.deepEqual(state.unread.get("qa"), ["msg-fan"]);
  assert.equal(state.unread.get("architect")?.length ?? 0, 0, "a sender never mails itself");
  assert.equal(state.agents.get("dev")!.state.mailboxDepth, 1, "mailboxDepth mirrors the box");
  assert.equal(state.agents.get("architect")!.state.mailboxDepth, 0);
});

test("message.sent: control.cacheServed suppresses delivery but still opens the ask", () => {
  const state = seed();
  send(state, message({ id: "msg-cached", from: "architect", to: ["dev"], type: "REQUEST_REVIEW", control: { cacheServed: true } as MeshMessage["control"] }));

  assert.deepEqual(state.unread.get("dev") ?? [], [], "a cache-served message is not delivered");
  assert.ok(state.pendingRequests.has("msg-cached"), "the obligation is still tracked");
});

test("message.sent: cacheServed in the PAYLOAD is ignored — an agent cannot suppress its own delivery", () => {
  const state = seed();
  send(state, message({ id: "msg-forged", from: "architect", to: ["dev"], type: "REQUEST_REVIEW", payload: { cacheServed: true } }));

  assert.deepEqual(state.unread.get("dev"), ["msg-forged"], "delivery control lives in the envelope, never in agent payload");
});

test("message.delivered: removes exactly that message and re-syncs mailboxDepth", () => {
  const state = seed();
  send(state, message({ id: "msg-1", from: "architect", to: ["dev"], type: "INFORM" }));
  send(state, message({ id: "msg-2", from: "architect", to: ["dev"], type: "INFORM" }));
  assert.equal(state.agents.get("dev")!.state.mailboxDepth, 2);

  applyEvent(state, evt("message.delivered", { agentId: "dev", messageId: "msg-1" }));

  assert.deepEqual(state.unread.get("dev"), ["msg-2"], "only the delivered id is removed");
  assert.equal(state.agents.get("dev")!.state.mailboxDepth, 1);
});

test("message.delivered: an unknown message id or agent is a harmless no-op", () => {
  const state = seed();
  send(state, message({ id: "msg-1", from: "architect", to: ["dev"], type: "INFORM" }));

  applyEvent(state, evt("message.delivered", { agentId: "dev", messageId: "msg-never-sent" }));
  applyEvent(state, evt("message.delivered", { agentId: "ghost", messageId: "msg-1" }));

  assert.deepEqual(state.unread.get("dev"), ["msg-1"], "nothing was dropped");
  assert.deepEqual(state.unread.get("ghost"), [], "an unknown agent gets an empty box, not a crash");
});

test("bounded state: an overflowing mailbox is capped and mailboxDepth follows the cap", () => {
  const state = seed();
  const overflow = MAX_UNREAD_PER_AGENT + 5;
  for (let i = 0; i < overflow; i++) {
    send(state, message({ id: `msg-flood-${i}`, from: "architect", to: ["dev"], type: "INFORM", payload: { n: i } }));
  }

  const box = state.unread.get("dev")!;
  assert.equal(box.length, MAX_UNREAD_PER_AGENT, "the box is capped");
  assert.equal(box[0], "msg-flood-5", "the OLDEST are dropped, newest kept");
  assert.equal(box.at(-1), `msg-flood-${overflow - 1}`);
  assert.equal(state.agents.get("dev")!.state.mailboxDepth, MAX_UNREAD_PER_AGENT, "depth is re-synced after capping, not left stale");
});

// ------------------------------------------------------- pending requests

test("message.sent: REQUEST/ESCALATE/CHALLENGE open an ask; plain types do not", () => {
  const state = seed();
  send(state, message({ id: "m-req", from: "architect", to: ["dev"], type: "REQUEST_REVIEW" }));
  send(state, message({ id: "m-esc", from: "architect", to: ["dev"], type: "ESCALATE" }));
  send(state, message({ id: "m-cha", from: "architect", to: ["dev"], type: "CHALLENGE" }));
  send(state, message({ id: "m-inf", from: "architect", to: ["dev"], type: "INFORM" }));

  assert.deepEqual([...state.pendingRequests.keys()].sort(), ["m-cha", "m-esc", "m-req"]);
  assert.equal(state.pendingRequests.has("m-inf"), false, "an INFORM is not an obligation");
});

test("message.sent: an ask to N agents records N outstanding debtors, with its refs and task id", () => {
  const state = seed();
  const refs: ArtifactRef[] = [{ uri: "artifact://ADR/design/1" }];
  send(state, message({ id: "m-fan", from: "architect", to: ["dev", "qa"], type: "REQUEST_REVIEW", artifactRefs: refs, taskId: "task-7" }));

  const pr = state.pendingRequests.get("m-fan")!;
  assert.deepEqual(pr.outstanding, ["dev", "qa"], "an ask to two agents is two obligations");
  assert.deepEqual(pr.to, ["dev", "qa"]);
  assert.equal(pr.from, "architect");
  assert.equal(pr.taskId, "task-7");
  assert.equal(pr.goalId, GOAL_ID);
  assert.deepEqual(pr.artifactUris, ["artifact://ADR/design/1"]);
});

// --------------------------------------------------- discharge: exact reply

test("discharge by replyTo: exact, and partial when other debtors are still silent", () => {
  const state = seed();
  send(state, message({ id: "m-ask", from: "architect", to: ["dev", "qa"], type: "REQUEST_REVIEW" }));

  send(state, message({ id: "m-dev", from: "dev", to: ["architect"], type: "APPROVE", replyTo: "m-ask" }));

  assert.ok(state.pendingRequests.has("m-ask"), "one reply does not close a two-debtor ask");
  assert.deepEqual(state.pendingRequests.get("m-ask")!.outstanding, ["qa"], "only the answering debtor is settled");
  const partial = state.discharged.at(-1)!;
  assert.equal(partial.partial, true);
  assert.equal(partial.reason, "reply");
  assert.equal(partial.by, "dev");
  assert.deepEqual(partial.remaining, ["qa"]);

  send(state, message({ id: "m-qa", from: "qa", to: ["architect"], type: "APPROVE", replyTo: "m-ask" }));

  assert.equal(state.pendingRequests.has("m-ask"), false, "the last debtor closes the ask");
  assert.equal(state.discharged.at(-1)!.partial, undefined);
});

test("discharge by replyTo: a second reply from an agent who already answered settles nothing", () => {
  const state = seed();
  send(state, message({ id: "m-ask", from: "architect", to: ["dev", "qa"], type: "REQUEST_REVIEW" }));
  send(state, message({ id: "m-dev-1", from: "dev", to: ["architect"], type: "APPROVE", replyTo: "m-ask" }));
  const afterFirst = state.discharged.length;

  send(state, message({ id: "m-dev-2", from: "dev", to: ["architect"], type: "APPROVE", replyTo: "m-ask" }));

  assert.equal(state.discharged.length, afterFirst, "a duplicate reply produces no discharge record");
  assert.deepEqual(state.pendingRequests.get("m-ask")!.outstanding, ["qa"], "and never closes the silent debtor's obligation");
});

test("discharge by replyTo: pointing at an unknown ask is a no-op", () => {
  const state = seed();
  send(state, message({ id: "m-reply", from: "dev", to: ["architect"], type: "APPROVE", replyTo: "m-never-existed" }));

  assert.equal(state.discharged.length, 0);
});

// ----------------------------------------------- discharge: compat inference

test("compat inference: a same-thread response addressed to the asker discharges the ask", () => {
  const state = seed();
  send(state, message({ id: "m-ask", from: "architect", to: ["dev"], type: "REQUEST_REVIEW" }));

  // No replyTo: this is inference, allowed in compat mode.
  send(state, message({ id: "m-ans", from: "dev", to: ["architect"], type: "APPROVE" }));

  assert.equal(state.pendingRequests.has("m-ask"), false);
  assert.equal(state.discharged.at(-1)!.reason, "in_thread");
});

test("compat inference: an answer that does not reach the asker discharges nothing", () => {
  const state = seed([["architect", "architect"], ["pm", "pm"], ["dev", "developer"]]);
  send(state, message({ id: "m-ask-architect", from: "architect", to: ["dev"], type: "REQUEST_REVIEW" }));
  send(state, message({ id: "m-ask-pm", from: "pm", to: ["dev"], type: "REQUEST_REVIEW" }));

  // dev answers ONLY architect, in the same thread both asks live in.
  send(state, message({ id: "m-ans", from: "dev", to: ["architect"], type: "APPROVE" }));

  assert.equal(state.pendingRequests.has("m-ask-architect"), false, "the addressed asker's ask is discharged");
  assert.ok(
    state.pendingRequests.has("m-ask-pm"),
    "pm was never addressed, so one reply must not silently close pm's ask and strand it in WAITING",
  );
});

test("compat inference: an INFORM counts as a response, an unrelated REQUEST does not", () => {
  const state = seed();
  send(state, message({ id: "m-ask", from: "architect", to: ["dev"], type: "REQUEST_INFO" }));
  send(state, message({ id: "m-noise", from: "dev", to: ["architect"], type: "REQUEST_INFO" }));
  assert.ok(state.pendingRequests.has("m-ask"), "dev asking its own question is not an answer");

  send(state, message({ id: "m-ans", from: "dev", to: ["architect"], type: "INFORM" }));
  assert.equal(state.pendingRequests.has("m-ask"), false, "small models answer REQUESTs with plain INFORMs");
});

test("compat inference: a cross-thread response matches by artifactId payload pointer", () => {
  const state = seed();
  state.artifacts.set("art-1", { id: "art-1", type: "ADR", name: "design", goalId: GOAL_ID, contentRef: "artifact://ADR/design/1" } as never);
  send(state, message({ id: "m-ask", from: "architect", to: ["dev"], type: "REQUEST_REVIEW", artifactRefs: [{ uri: "artifact://ADR/design/1" }] }));

  // recordDecision's BLOCK path: fresh thread, artifact pointer in the payload.
  send(state, message({ id: "m-block", from: "dev", to: ["architect"], type: "BLOCK", threadId: "thr-fresh", payload: { artifactId: "art-1" } }));

  assert.equal(state.pendingRequests.has("m-ask"), false);
  assert.equal(state.discharged.at(-1)!.reason, "artifact_review");
});

test("compat inference: a cross-thread response matches by shared artifactRefs uri", () => {
  const state = seed();
  const uri = "artifact://CodePatch/api/2";
  send(state, message({ id: "m-ask", from: "architect", to: ["dev"], type: "REQUEST_REVIEW", artifactRefs: [{ uri }] }));

  send(state, message({ id: "m-ans", from: "dev", to: ["architect"], type: "APPROVE", threadId: "thr-fresh", artifactRefs: [{ uri }] }));

  assert.equal(state.pendingRequests.has("m-ask"), false);
  assert.equal(state.discharged.at(-1)!.reason, "artifact_review");
});

test("compat inference: a cross-thread response with no artifact link discharges nothing", () => {
  const state = seed();
  send(state, message({ id: "m-ask", from: "architect", to: ["dev"], type: "REQUEST_REVIEW" }));

  send(state, message({ id: "m-ans", from: "dev", to: ["architect"], type: "APPROVE", threadId: "thr-elsewhere" }));

  assert.ok(state.pendingRequests.has("m-ask"), "a different thread with nothing in common is not an answer");
});

// ----------------------------------------------- discharge: strict semantics

test("strict mode: thread and artifact inference are disabled — only replyTo settles an ask", () => {
  const strict = { commitmentSemantic: "strict" as const };
  const state = seed();
  send(state, message({ id: "m-ask", from: "architect", to: ["dev"], type: "REQUEST_REVIEW" }), strict);

  send(state, message({ id: "m-ans", from: "dev", to: ["architect"], type: "APPROVE" }), strict);
  assert.ok(state.pendingRequests.has("m-ask"), "a re-asked question is cheap; a falsely-closed one strands the asker");

  send(state, message({ id: "m-exact", from: "dev", to: ["architect"], type: "APPROVE", replyTo: "m-ask" }), strict);
  assert.equal(state.pendingRequests.has("m-ask"), false, "an explicit replyTo still works in strict mode");
});

test("strict mode: the worker-result contract survives — a matching taskId discharges across threads", () => {
  const strict = { commitmentSemantic: "strict" as const };
  const state = seed([["lead", "lead"], ["worker", "developer"]]);
  send(state, message({ id: "m-exec", from: "lead", to: ["worker"], type: "REQUEST_EXECUTION", taskId: "task-42" }), strict);

  // HANDOFF on a fresh thread, parent not on the recipient list — by design.
  send(state, message({ id: "m-handoff", from: "worker", to: ["someone-else"], type: "HANDOFF", threadId: "thr-worker", taskId: "task-42" }), strict);

  assert.equal(state.pendingRequests.has("m-exec"), false, "delegated workers keep working under strict commitments");
  assert.equal(state.discharged.at(-1)!.reason, "task");
});

test("strict mode: a non-matching taskId leaves the ask open", () => {
  const strict = { commitmentSemantic: "strict" as const };
  const state = seed([["lead", "lead"], ["worker", "developer"]]);
  send(state, message({ id: "m-exec", from: "lead", to: ["worker"], type: "REQUEST_EXECUTION", taskId: "task-42" }), strict);
  send(state, message({ id: "m-other", from: "worker", to: ["lead"], type: "HANDOFF", taskId: "task-99" }), strict);

  assert.ok(state.pendingRequests.has("m-exec"));
});

// ------------------------------------------------------------- approvals

test("TEST_RESULT PASSED records a pass approval; any other result records none", () => {
  const state = seed();
  send(state, message({ id: "m-pass", from: "qa", to: ["dev"], type: "TEST_RESULT", payload: { result: "PASSED" } }));

  const passes = state.approvals.get(approvalKey("quality", "pass")) ?? [];
  assert.equal(passes.length, 1, "the default subject for TEST_RESULT is quality");
  assert.equal(passes[0]!.actorId, "qa");
  assert.equal(passes[0]!.actorRole, "qa", "the actor role is resolved from the agent registry");

  send(state, message({ id: "m-fail", from: "qa", to: ["dev"], type: "TEST_RESULT", payload: { result: "FAILED" } }));
  assert.equal((state.approvals.get(approvalKey("quality", "pass")) ?? []).length, 1, "a failing run approves nothing");
});

test("SECURITY_FINDING PASSED defaults to the security subject and carries the artifact ref", () => {
  const state = seed([["sec", "security"], ["dev", "developer"]]);
  const refs: ArtifactRef[] = [{ uri: "artifact://CodePatch/api/3" }];
  send(state, message({ id: "m-sec", from: "sec", to: ["dev"], type: "SECURITY_FINDING", artifactRefs: refs, payload: { result: "PASSED", artifactId: "art-9" } }));

  const passes = state.approvals.get(approvalKey("security", "pass")) ?? [];
  assert.equal(passes.length, 1);
  assert.equal(passes[0]!.artifactId, "art-9");
  assert.deepEqual(passes[0]!.artifactRef, refs[0]);
});

test("an explicit payload subject overrides the default approval subject", () => {
  const state = seed();
  send(state, message({ id: "m-pass", from: "qa", to: ["dev"], type: "TEST_RESULT", payload: { result: "PASSED", subject: "architecture" } }));

  assert.equal((state.approvals.get(approvalKey("architecture", "pass")) ?? []).length, 1);
  assert.equal((state.approvals.get(approvalKey("quality", "pass")) ?? []).length, 0);
});

test("a BLOCK message records a block approval regardless of payload result", () => {
  const state = seed();
  send(state, message({ id: "m-block", from: "qa", to: ["dev"], type: "BLOCK", payload: { artifactId: "art-4" } }));

  const blocks = state.approvals.get(approvalKey("quality", "block")) ?? [];
  assert.equal(blocks.length, 1, "BLOCK defaults to the quality subject");
  assert.equal(blocks[0]!.artifactId, "art-4");
  assert.equal(blocks[0]!.actorId, "qa");
});

// ------------------------------------------------------- loop detection

test("fingerprints: an identical repeated message bumps a loop conflict, a differing one does not", () => {
  const state = seed();
  const repeat = () =>
    send(state, message({ from: "dev", to: ["qa"], type: "INFORM", payload: { subject: "status", result: "same" } }));

  repeat();
  assert.equal(state.conflicts.size, 0, "the first send is not a loop");

  repeat();
  const key = `loop:dev:${THREAD_ID}`;
  assert.equal(state.conflicts.get(key)?.count, 1, "the repeat is the first conflict");
  repeat();
  assert.equal(state.conflicts.get(key)?.count, 2, "and it keeps counting");
  assert.equal(state.conflicts.get(key)?.lastActor, "dev");

  // A payload key the runtime branches on changes identity, so this is new work.
  send(state, message({ from: "dev", to: ["qa"], type: "INFORM", payload: { subject: "status", result: "different" } }));
  assert.equal(state.conflicts.get(key)?.count, 2, "a materially different message is not a loop");
});

test("fingerprints: identical text from different senders or threads is not a loop", () => {
  const state = seed();
  const payload = { subject: "status" };
  send(state, message({ from: "dev", to: ["qa"], type: "INFORM", payload }));
  send(state, message({ from: "qa", to: ["dev"], type: "INFORM", payload }));
  send(state, message({ from: "dev", to: ["qa"], type: "INFORM", threadId: "thr-2", payload }));

  assert.equal(state.conflicts.size, 0, "fingerprints are scoped per sender and per thread");
});

test("fingerprints: prose differences do not change message identity", () => {
  const state = seed();
  send(state, message({ from: "dev", to: ["qa"], type: "INFORM", payload: { subject: "status", note: "first phrasing" } }));
  send(state, message({ from: "dev", to: ["qa"], type: "INFORM", payload: { subject: "status", note: "totally different prose" } }));

  assert.equal(
    state.conflicts.get(`loop:dev:${THREAD_ID}`)?.count,
    1,
    "only runtime-meaningful payload keys discriminate, so re-phrasing the same act is still a loop",
  );
});
