import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { buildAgentContext, renderContextInstructions } from "../../packages/core/src/context";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * A thread has an ending (D13).
 *
 * `Thread.status` declared `OPEN | RESOLVED | ESCALATED` and, for every thread
 * that was not a collab, nothing ever wrote either terminal value: a thread was
 * minted OPEN and stayed OPEN for the life of the mission. Three load-bearing
 * readers ask that field which conversations are live — the prompt's
 * open-threads section, the deadlock depth scan, and the thread-budget stall
 * check — and all three were drawing from a pool that only grew, which the
 * prompt paid for on every turn.
 *
 * The ending is on the discharge path, because that is where the fact is. A
 * thread opened by an ask is a question; when its last question is answered the
 * conversation it was opened for is over. The tests below pin the two narrowings
 * that keep that from being a lie — a thread that never asked anything has no
 * ending to detect, and an ask that DIED rather than settled did not resolve
 * anything — plus the two things that made it safe to say at all: a follow-up
 * ask revives the thread it belongs to, and the mail that settled a thread still
 * carries its subject.
 */

function fakeTurn(agentId: string) {
  return {
    turnId: `t-${agentId}`,
    agentId,
    reason: { kind: "manual" },
    sentOps: 0,
    publishedOps: 0,
    waitRequested: false,
    escalated: false,
    results: [],
  } as never;
}

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

async function pair() {
  return makeMesh({
    agents: [
      { id: "architect", role: "architect", interests: [] },
      { id: "dev", role: "developer", interests: [] },
    ],
    mayContact: { architect: ["dev"], dev: ["architect"] },
    mode: "parked",
  });
}

const bundleFor = (m: Mesh, agentId: string) => buildAgentContext({ config: m.config, kernel: m.kernel }, agentId);
const status = (m: Mesh, threadId: string) => m.kernel.state.threads.get(threadId)!.status;

/** Architect asks dev something in a thread of its own. */
async function ask(m: Mesh, subject: string) {
  const res = await m.supervisor.sendMessage({
    from: "architect",
    to: ["dev"],
    type: "REQUEST_INFO",
    newThread: { subject },
    payload: { question: "does the retry budget survive a restart?" },
  });
  assert.ok(res.accepted, res.reason);
  // Read off the ledger rather than the result: `SendResult` reports what the
  // bus accepted, and the thread a message landed in is the reducer's fact.
  return { id: res.messageId!, threadId: m.kernel.state.messages.get(res.messageId!)!.threadId };
}

/** A mesh whose asks carry a deadline, which is what makes an ask expirable. */
async function pairWithDeadlines() {
  return makeMesh({
    agents: [
      { id: "architect", role: "architect", interests: [] },
      { id: "dev", role: "developer", interests: [] },
    ],
    mayContact: { architect: ["dev"], dev: ["architect"] },
    mode: "parked",
    bus: { commitments: { ttlMs: 50 } },
  });
}

test("D13: an ask ends its thread when the answer lands", async () => {
  const m = await pair();
  try {
    const { id, threadId } = await ask(m, "retry budget");
    assert.equal(status(m, threadId), "OPEN", "an open question is a live conversation");
    assert.equal(bundleFor(m, "architect").openThreads.length, 1);

    const res = await m.supervisor.executeOp(
      "dev",
      { op: "respond", messageId: id, type: "INFORM", payload: { answer: "it survives; the budget is on the goal" } } as MeshOp,
      fakeTurn("dev"),
    );
    assert.equal(res.ok, true, res.reason);

    assert.equal(m.kernel.state.pendingRequests.size, 0, "the ledger's one exit ran");
    assert.equal(status(m, threadId), "RESOLVED", "the conversation it was opened for is over");
    assert.equal(
      bundleFor(m, "architect").openThreads.length,
      0,
      "and the prompt stops carrying a thread that will never move again",
    );
    // The record survives the ending. Only the status moved: the conversation
    // is still the audit trail of what was said in it.
    assert.ok(m.kernel.state.threads.get(threadId)!.messageIds.length >= 2);
  } finally {
    await m.cleanup();
  }
});

test("D13: a thread that never asked anything has no ending", async () => {
  const m = await pair();
  try {
    // A notice, not a question. `settleThread` cannot reach it, because it is
    // only ever called from the ledger's single exit and this thread never put
    // anything on the ledger.
    const notice = await m.supervisor.sendMessage({
      from: "architect",
      to: ["dev"],
      type: "INFORM",
      newThread: { subject: "index sharding" },
      payload: { note: "two options, both survive a rebuild" },
    });
    assert.ok(notice.accepted, notice.reason);
    const threadId = m.kernel.state.messages.get(notice.messageId!)!.threadId;
    const reply = await m.supervisor.sendMessage({
      from: "dev",
      to: ["architect"],
      type: "INFORM",
      threadId,
      payload: { note: "the second one" },
    });
    assert.ok(reply.accepted, reply.reason);
    assert.equal(m.kernel.state.pendingRequests.size, 0, "nothing was asked, so nothing is owed");
    assert.equal(
      status(m, threadId),
      "OPEN",
      "no debt and no ending: 'live' still means 'every thread this agent is party to' for ordinary traffic",
    );
    assert.equal(bundleFor(m, "dev").openThreads.length, 1, "the prompt still shows a conversation that has no ledger entry to end it");
  } finally {
    await m.cleanup();
  }
});

test("D13: a follow-up ask revives the thread it belongs to", async () => {
  const m = await pair();
  try {
    const first = await ask(m, "retry budget");
    assert.equal(
      (await m.supervisor.executeOp("dev", { op: "respond", messageId: first.id, type: "INFORM", payload: { answer: "yes" } } as MeshOp, fakeTurn("dev"))).ok,
      true,
    );
    assert.equal(status(m, first.threadId), "RESOLVED");

    // The MCP send surface advertises `threadId` precisely so a follow-up lands
    // in the thread that raised it. Without the revive, that ask would open a
    // real commitment inside a conversation no liveness reader can see.
    const second = await m.supervisor.executeOp(
      "architect",
      { op: "send", type: "REQUEST_INFO", to: ["dev"], threadId: first.threadId, payload: { question: "and across a tenant split?" } } as MeshOp,
      fakeTurn("architect"),
    );
    assert.equal(second.ok, true, second.reason);
    const ask2 = m.kernel.state.pendingRequests.get(second.messageId!)!;
    assert.equal(ask2.threadId, first.threadId, "the follow-up is in the first thread");
    assert.equal(status(m, first.threadId), "OPEN", "and the thread is live again, because it has an open question in it");
    assert.equal(bundleFor(m, "architect").openThreads.length, 1);
  } finally {
    await m.cleanup();
  }
});

test("D13: an ask that DIED does not resolve its thread — it escalates it", async () => {
  const m = await pairWithDeadlines();
  try {
    const { id, threadId } = await ask(m, "retry budget");
    // The real sweep, driven directly so the assertion is about the DECISION
    // rather than about a sleep. `expired` is one of
    // `UNANSWERED_DISCHARGE_REASONS`: the ask left the ledger, but nobody
    // answered it, and a thread that claimed to be RESOLVED would put the lie in
    // the same record an operator reads to find out what happened.
    await new Promise((r) => setTimeout(r, 60));
    await (m.supervisor as unknown as { sweepExpiredCommitments(nowMs: number): Promise<void> }).sweepExpiredCommitments(Date.now());
    assert.equal(m.kernel.state.pendingRequests.has(id), false, "the deadline took it off the ledger");
    assert.equal(status(m, threadId), "ESCALATED");
    assert.equal(bundleFor(m, "architect").openThreads.length, 0, "and it is terminal either way");
  } finally {
    await m.cleanup();
  }
});

test("D13: withdrawing an ask ends its thread too, and it is a settlement", async () => {
  const m = await pair();
  try {
    const { id, threadId } = await ask(m, "retry budget");
    // The asker's own exit. It is deliberately NOT in the "gone, not answered"
    // set: the one party whose answer mattered chose to stop wanting it, so the
    // thread resolves rather than escalating.
    const res = await m.supervisor.executeOp(
      "architect",
      { op: "withdraw", messageId: id, reason: "we are dropping the retry path" } as MeshOp,
      fakeTurn("architect"),
    );
    assert.equal(res.ok, true, res.reason);
    assert.equal(status(m, threadId), "RESOLVED");
  } finally {
    await m.cleanup();
  }
});

test("D13: one of three debtors answering does not end the thread", async () => {
  // "One ask to N agents is N obligations", meeting the thread lifecycle. A
  // partial discharge returns BEFORE the ledger deletes anything, so it must
  // reach no ending: two reviewers have still said nothing, and a thread that
  // called itself RESOLVED would take the last two obligations out of the
  // prompt's open-threads section while they are still owed.
  const m = await makeMesh({
    agents: [
      { id: "architect", role: "architect", interests: [] },
      { id: "dev", role: "developer", interests: [] },
      { id: "qa", role: "qa", interests: [] },
    ],
    mayContact: { architect: ["dev", "qa"], dev: ["architect"], qa: ["architect"] },
    mode: "parked",
  });
  try {
    const res = await m.supervisor.sendMessage({
      from: "architect",
      to: ["dev", "qa"],
      type: "REQUEST_REVIEW",
      newThread: { subject: "the patch" },
      payload: { question: "is this safe to merge?" },
    });
    assert.ok(res.accepted, res.reason);
    const id = res.messageId!;
    const threadId = m.kernel.state.messages.get(id)!.threadId;

    const one = await m.supervisor.executeOp("dev", { op: "respond", messageId: id, type: "INFORM", payload: { verdict: "looks fine" } } as MeshOp, fakeTurn("dev"));
    assert.equal(one.ok, true, one.reason);
    assert.deepEqual(m.kernel.state.pendingRequests.get(id)!.outstanding, ["qa"], "dev's share is settled, qa's is not");
    assert.equal(status(m, threadId), "OPEN", "the conversation is not over while somebody still owes an answer");

    const two = await m.supervisor.executeOp("qa", { op: "respond", messageId: id, type: "INFORM", payload: { verdict: "no objections" } } as MeshOp, fakeTurn("qa"));
    assert.equal(two.ok, true, two.reason);
    assert.equal(m.kernel.state.pendingRequests.has(id), false, "the last debtor settled it");
    assert.equal(status(m, threadId), "RESOLVED", "and only now is the thread over");
  } finally {
    await m.cleanup();
  }
});

test("D13: the answer that ended a thread still carries that thread's subject", async () => {
  const m = await pair();
  try {
    const { id, threadId } = await ask(m, "retry budget");
    await m.supervisor.executeOp("dev", { op: "respond", messageId: id, type: "INFORM", payload: { answer: "it survives" } } as MeshOp, fakeTurn("dev"));

    // The settled thread is out of `openThreads` and its answer is still unread,
    // which is the one turn where the two sets disagree. Deriving the mail
    // section's titles from the live set would drop the heading off exactly the
    // conversation the reader is about to act on.
    const bundle = bundleFor(m, "architect");
    assert.equal(bundle.openThreads.length, 0);
    assert.equal(bundle.unreadMail.length, 1, "the answer is the mail that closed it");
    const text = renderContextInstructions(bundle);
    assert.match(text, /## Unread mail/);
    assert.match(text, new RegExp(`### thread ${threadId} — retry budget`), "the reader is told which conversation the answer belongs to");
  } finally {
    await m.cleanup();
  }
});
