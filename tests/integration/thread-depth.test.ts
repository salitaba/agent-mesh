import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, collectEvents, eventTypes } from "../helpers";

/**
 * Thread-depth escalation, end to end.
 *
 * A conversation that keeps spawning sub-threads is how a mesh burns a mission
 * budget without producing anything: every level looks locally reasonable, and
 * nothing in the message path notices the recursion. `policies.escalation.
 * thread.max_depth` is the runtime's only stop. These tests assert the three
 * things that make that stop real — the send is REFUSED, an operator-visible
 * card is raised with `thread_depth_exceeded`, and no `thread.created` event
 * exists for the refused level. A refusal that still creates the thread would
 * pass a naive "returns accepted:false" check while leaving the recursion in
 * the projection.
 */

const AGENTS = [
  { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
  { id: "qa", role: "qa", capabilities: ["test.execute"], interests: [] },
];

const COMM = { dev: ["qa"], qa: ["dev"] };

/** Matches `thread: { max_depth: 5 }` in tests/helpers.ts testConfigYaml. */
const MAX_DEPTH = 5;

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

/** Opens one thread nested under `parent` (or a root thread when absent). */
async function openThread(m: Mesh, parentThreadId: string | undefined, subject: string) {
  return m.supervisor.sendMessage({
    from: "dev",
    to: ["qa"],
    type: "INFORM",
    newThread: { subject, ...(parentThreadId ? { parentThreadId } : {}) },
    payload: { note: subject },
  });
}

/** Builds the legal chain root..MAX_DEPTH and returns the deepest thread id. */
async function buildChainToMaxDepth(m: Mesh): Promise<string> {
  let parent: string | undefined;
  for (let depth = 1; depth <= MAX_DEPTH; depth++) {
    const res = await openThread(m, parent, `level ${depth}`);
    assert.equal(res.accepted, true, `level ${depth} is within max_depth and must be accepted`);
    const msg = [...m.kernel.state.messages.values()].find((x) => x.id === res.messageId);
    assert.ok(msg?.threadId, `level ${depth} must land in a thread`);
    parent = msg.threadId;
  }
  return parent as string;
}

test("thread depth e2e: a thread one level past max_depth is refused and escalated", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" });
  try {
    const deepest = await buildChainToMaxDepth(m);
    assert.equal(m.kernel.state.threads.get(deepest)?.depth, MAX_DEPTH, "the chain reached the ceiling exactly");

    const threadsBefore = m.kernel.state.threads.size;
    const createdBefore = eventTypes(await collectEvents(m)).filter((t) => t === "thread.created").length;

    const res = await openThread(m, deepest, "one level too deep");

    // 1. refused
    assert.equal(res.accepted, false, "a send that would exceed max_depth must be refused");
    assert.match(res.reason ?? "", /thread depth exceeded maximum/);
    assert.equal(res.messageId, undefined, "a refused send mints no message id");

    // 2. an operator-visible card exists, naming the reason and the depth
    assert.ok(res.escalated, "the refusal must hand the operator a card id");
    const esc = m.kernel.state.escalations.get(res.escalated as string);
    assert.ok(esc, "the escalation is in the projection");
    assert.equal(esc.reason, "thread_depth_exceeded");
    assert.equal(esc.raisedBy, "dev");
    assert.equal(esc.status, "OPEN", "the card must await a human, not self-resolve");
    const detail = esc.detail as { parentThreadId?: string; depth?: number; max?: number };
    assert.equal(detail.parentThreadId, deepest, "the card names the thread that tried to recurse");
    assert.equal(detail.depth, MAX_DEPTH + 1);
    assert.equal(detail.max, MAX_DEPTH);
    assert.equal(esc.conflictKey, `depth:${deepest}`, "repeated recursion from the same parent must collapse onto one key");

    // 3. nothing was created
    assert.equal(m.kernel.state.threads.size, threadsBefore, "the refused thread must not exist");
    const createdAfter = eventTypes(await collectEvents(m)).filter((t) => t === "thread.created").length;
    assert.equal(createdAfter, createdBefore, "no thread.created event may accompany the refusal");
    assert.equal(
      [...m.kernel.state.threads.values()].filter((t) => t.depth > MAX_DEPTH).length,
      0,
      "no thread past the ceiling may exist at all",
    );

    const types = eventTypes(await collectEvents(m));
    assert.ok(types.includes("escalation.requested"), "the escalation is event-sourced");
  } finally {
    await m.cleanup();
  }
});

test("thread depth e2e: the ceiling blocks the level, not the conversation", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" });
  try {
    const deepest = await buildChainToMaxDepth(m);
    const refused = await openThread(m, deepest, "too deep");
    assert.equal(refused.accepted, false);

    // The mesh is not wedged: replying INTO the deepest legal thread still
    // works, and so does starting a fresh root thread. A depth guard that
    // killed the whole conversation would be worse than the recursion.
    const reply = await m.supervisor.sendMessage({
      from: "qa",
      to: ["dev"],
      type: "INFORM",
      threadId: deepest,
      payload: { note: "answering in place instead of recursing" },
    });
    assert.equal(reply.accepted, true, "an in-place reply at max depth is still allowed");
    const replyMsg = [...m.kernel.state.messages.values()].find((x) => x.id === reply.messageId);
    assert.equal(replyMsg?.threadId, deepest, "the reply joins the existing thread rather than nesting");

    const fresh = await openThread(m, undefined, "unrelated root topic");
    assert.equal(fresh.accepted, true, "a new root thread is unaffected by another branch's depth");

    // Sibling recursion from the same parent collapses onto one conflict key
    // rather than spamming the operator with a card per attempt.
    const second = await openThread(m, deepest, "too deep again");
    assert.equal(second.accepted, false);
    const cards = [...m.kernel.state.escalations.values()].filter((e) => e.reason === "thread_depth_exceeded");
    assert.ok(cards.length >= 1, "the recursion is reported");
    assert.equal(
      new Set(cards.map((e) => e.conflictKey)).size,
      1,
      "every refusal from the same parent shares one conflict key",
    );
  } finally {
    await m.cleanup();
  }
});
