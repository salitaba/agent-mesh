import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { fingerprintOf, bumpConflict } from "../../packages/core/src/projections-helpers";
import { createInitialState } from "../../packages/core/src/state";
import { applyEvent } from "../../packages/core/src/projections";
import { sanitizeAgentMessageInput, validateMessage } from "../../packages/protocol/src/index";
import type { MeshEvent, MeshMessage } from "../../packages/protocol/src/index";

/**
 * Envelope authority: the kernel decides on fields it owns, never on prose.
 *
 * `payload` is verbatim agent output — a language model writing free-form
 * JSON. Two places used to route on it, and both handed a decision the
 * runtime is supposed to make to the agent being governed:
 *
 *  1. Delivery. `payload.cacheServed` suppressed mailbox delivery AND
 *     interest activation, so a sender could attach it to its own REQUEST and
 *     get an ask that opens a pending request (parking itself in WAITING and
 *     recording a debt) while landing in nobody's mailbox and waking nobody.
 *  2. Loop detection. `fingerprintOf` hashed the payload JSON, so the mesh's
 *     only defence against an agent that repeats itself was defeated by
 *     rewording — the one thing an LLM does without being asked.
 *
 * The fix is structural, not a rule: delivery control moved to a
 * runtime-owned envelope field that is stripped from every agent input, and
 * message identity is computed from the typed envelope instead of the prose.
 */

let seq = 0;
function msg(over: Partial<MeshMessage>): MeshMessage {
  seq++;
  return {
    id: `msg-${seq}`,
    type: "REQUEST",
    timestamp: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    goalId: "goal-1",
    from: "architect",
    to: ["dev"],
    threadId: "thread-1",
    artifactRefs: [],
    payload: {},
    priority: "NORMAL",
    ...over,
  } as MeshMessage;
}

test("envelope: an agent cannot forge delivery control through the payload", async () => {
  const m = await makeMesh({
    agents: [
      { id: "architect", role: "architect", capabilities: ["review.design"], interests: [] },
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
    ],
    mayContact: { architect: ["dev"], dev: ["architect"] },
    mode: "parked",
  });

  const ask = await m.supervisor.sendMessage({
    from: "architect",
    to: ["dev"],
    type: "REQUEST",
    newThread: { subject: "forged" },
    // The exploit: this key used to be read by BOTH the delivery reducer and
    // the scheduler, so the sender silenced its own message.
    payload: { cacheServed: true, q: "answer me" },
  });
  assert.equal(ask.accepted, true, "the send itself is legitimate — only the forged control field is not");

  assert.deepEqual(
    m.kernel.state.unread.get("dev"),
    [ask.messageId],
    "the message MUST reach the recipient's mailbox: a forged payload key used to make it vanish " +
      "while still opening a pending request, which is a guaranteed permanent stall",
  );
  assert.equal(m.kernel.state.pendingRequests.size, 1, "and the ask is on the ledger, as it always was");

  const stored = m.kernel.state.messages.get(ask.messageId!)!;
  assert.equal(stored.control?.cacheServed, undefined, "no forged control survives onto the envelope");
  assert.equal(
    (stored.payload as Record<string, unknown>).cacheServed,
    undefined,
    "and the reserved key is stripped from the payload too, so a legacy reader cannot find a forged copy",
  );
  assert.equal((stored.payload as Record<string, unknown>).q, "answer me", "genuine payload content is untouched");

  await m.cleanup();
});

test("envelope: sanitizing leaves non-object payloads alone", () => {
  assert.equal(sanitizeAgentMessageInput({ payload: "just prose" }).payload, "just prose");
  assert.deepEqual(sanitizeAgentMessageInput({ payload: [1, 2] }).payload, [1, 2]);
  assert.equal(sanitizeAgentMessageInput({ payload: undefined }).payload, undefined);
  assert.equal(
    sanitizeAgentMessageInput({ control: { cacheServed: true }, payload: { a: 1 } }).control,
    undefined,
    "a directly supplied control block is dropped",
  );
});

test("envelope: the schema rejects an unknown control field instead of ignoring it", () => {
  const ok = validateMessage(msg({ control: { cacheServed: true } }));
  assert.equal(ok.valid, true, "the runtime's own control field validates");

  const forged = validateMessage(msg({ control: { suppressPolicy: true } as never }));
  assert.equal(
    forged.valid,
    false,
    "control is a closed set: a future runtime-owned flag must fail validation if forged, not pass silently",
  );
});

test("envelope: a cache-served message is still suppressed — via the envelope", () => {
  const state = createInitialState();
  const message = msg({ from: "dev", to: ["architect"], type: "INFORM", control: { cacheServed: true } });
  const event = {
    id: "evt-1",
    seq: 1,
    type: "message.sent",
    timestamp: message.timestamp,
    goalId: "goal-1",
    actorId: "dev",
    payload: { message },
  } as MeshEvent;

  applyEvent(state, event);
  assert.deepEqual(
    state.unread.get("architect") ?? [],
    [],
    "the real feature still works: a cached research answer is a log record, not mail",
  );
});

test("loop detection: a paraphrased repeat is still recognised as a repeat", () => {
  // Identical act, identical subject, different words. This is what an LLM
  // actually does when it loops, and it used to slip past the detector.
  const first = msg({ payload: { question: "Is the idempotency design acceptable?" } });
  const reworded = msg({ payload: { question: "Would you say this idempotency approach is OK?" } });

  assert.equal(
    fingerprintOf(first),
    fingerprintOf(reworded),
    "message identity is who-asked-whom-about-what, not which words were used",
  );
});

test("loop detection: genuinely different work is not collapsed into a loop", () => {
  const onPay = msg({ artifactRefs: [{ uri: "artifact://CodePatch/pay/1" }] });
  const onAuth = msg({ artifactRefs: [{ uri: "artifact://CodePatch/auth/1" }] });
  assert.notEqual(fingerprintOf(onPay), fingerprintOf(onAuth), "different subject is different work");

  const toDev = msg({ to: ["dev"] });
  const toQa = msg({ to: ["qa"] });
  assert.notEqual(fingerprintOf(toDev), fingerprintOf(toQa), "different recipient is different work");

  const ask = msg({ type: "REQUEST_REVIEW" });
  const approve = msg({ type: "APPROVE" });
  assert.notEqual(fingerprintOf(ask), fingerprintOf(approve), "different act is different work");

  const passed = msg({ type: "TEST_RESULT", payload: { result: "PASSED", notes: "all green" } });
  const failed = msg({ type: "TEST_RESULT", payload: { result: "FAILED", notes: "one red" } });
  assert.notEqual(
    fingerprintOf(passed),
    fingerprintOf(failed),
    "an outcome the runtime itself branches on stays part of identity — reporting PASSED then FAILED is not a loop",
  );

  const verbose = msg({ type: "TEST_RESULT", payload: { result: "PASSED", notes: "all green, ran 42 cases" } });
  assert.equal(
    fingerprintOf(passed),
    fingerprintOf(verbose),
    "...but re-narrating the SAME outcome is a loop, however it is phrased",
  );
});

test("loop detection: a paraphrasing agent now actually trips the conflict counter", () => {
  const state = createInitialState();
  const wordings = [
    "Is the idempotency design acceptable?",
    "Can you confirm the idempotency design is fine?",
    "Just checking — is that idempotency approach OK with you?",
  ];

  let bumped = 0;
  const seen = new Set<string>();
  for (const question of wordings) {
    const fp = fingerprintOf(msg({ payload: { question } }));
    if (seen.has(fp)) {
      bumpConflict(state, "loop:architect:thread-1", "architect", new Date().toISOString(), "thread-1");
      bumped++;
    }
    seen.add(fp);
  }

  assert.equal(bumped, 2, "the second and third rewording are repeats; only the first is new");
  assert.equal(
    state.conflicts.get("loop:architect:thread-1")?.count,
    2,
    "the counter that feeds `fingerprint_loop` escalation now sees the loop it was written to catch",
  );
});

test("loop detection: answering a different request is not a repeat", () => {
  const ready = msg({ type: "INFORM", replyTo: "msg-request-A", payload: { status: "READY" } });
  const done = msg({ type: "INFORM", replyTo: "msg-request-B", payload: { status: "DONE", artifact_state: "MERGEABLE -> MERGED" } });
  assert.notEqual(
    fingerprintOf(ready),
    fingerprintOf(done),
    "a reply to a new request is new work even when the status narration rhymes",
  );

  const rephrased = msg({ type: "INFORM", replyTo: "msg-request-A", payload: { status: "READY, still waiting" } });
  assert.equal(
    fingerprintOf(ready),
    fingerprintOf(rephrased),
    "re-answering the same request is still a repeat, however it is reworded",
  );
});
