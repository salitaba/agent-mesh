import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor } from "../helpers";
import { createInitialState } from "../../packages/core/src/state";
import { buildAgentContext } from "../../packages/core/src/context";
import { applyEvent } from "../../packages/core/src/projections";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * An ask addressed to N agents is N obligations, not one.
 *
 * The ledger keyed a pending request by message id alone, so the FIRST reply
 * closed it for everybody: ask dev + qa + security to review, dev says "looks
 * fine", and the runtime recorded discharge reason `reply` — its most
 * confident, explicitly NON-inferred outcome — while qa and security had said
 * nothing at all. Two review obligations vanished with no record, no nudge,
 * no stalemate, and `inferredRatio` reporting zero doubt.
 *
 * A plural debtor is a diffuse debtor: nobody in particular ever owed
 * anything. With `broadcast` (which addresses every agent in the mesh) one
 * reply could discharge an obligation owed by the entire team.
 */

async function reviewPanel(opts?: { strict?: boolean }) {
  return makeMesh({
    agents: [
      { id: "architect", role: "architect", capabilities: ["review.design"], interests: [] },
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "qa", role: "qa", capabilities: ["test.run"], interests: [] },
      { id: "sec", role: "security", capabilities: ["security.scan"], interests: [] },
    ],
    mayContact: {
      architect: ["dev", "qa", "sec"],
      dev: ["architect"],
      qa: ["architect"],
      sec: ["architect"],
    },
    mode: "parked",
    ...(opts?.strict ? { bus: { commitments: { semantic: "strict" as const } } } : {}),
  });
}

function ctxFor(m: Awaited<ReturnType<typeof reviewPanel>>, agentId: string) {
  return buildAgentContext({ config: m.config, kernel: m.kernel }, agentId);
}

async function askThree(m: Awaited<ReturnType<typeof reviewPanel>>) {
  const ask = await m.supervisor.sendMessage({
    from: "architect",
    to: ["dev", "qa", "sec"],
    type: "REQUEST_REVIEW",
    newThread: { subject: "everyone please review" },
    payload: { q: "review this" },
  });
  const threadId = m.kernel.state.messages.get(ask.messageId!)!.threadId;
  return { id: ask.messageId!, threadId };
}

test("plural debtor: one reply settles one obligation, not everyone's", async () => {
  const m = await reviewPanel();
  const ask = await askThree(m);

  await m.supervisor.sendMessage({
    from: "dev", to: ["architect"], type: "INFORM",
    threadId: ask.threadId, replyTo: ask.id, payload: { answer: "looks fine to me" },
  });

  const pr = m.kernel.state.pendingRequests.get(ask.id);
  assert.ok(pr, "the ask stays open: qa and sec have said nothing and still owe an answer");
  assert.deepEqual(pr.outstanding, ["qa", "sec"], "only the debtor who answered is off the hook");

  const rec = m.kernel.state.discharged.find((d) => d.by === "dev");
  assert.equal(rec?.partial, true, "a settled obligation is recorded as partial, not as a closed ask");
  assert.deepEqual(rec?.remaining, ["qa", "sec"], "and it names who is still silent");

  await m.cleanup();
});

test("plural debtor: the ask closes exactly when the last debtor answers", async () => {
  const m = await reviewPanel();
  const ask = await askThree(m);

  for (const [debtor, expected] of [["dev", ["qa", "sec"]], ["qa", ["sec"]]] as const) {
    await m.supervisor.sendMessage({
      from: debtor, to: ["architect"], type: "INFORM",
      threadId: ask.threadId, replyTo: ask.id, payload: { answer: "ok" },
    });
    assert.deepEqual(m.kernel.state.pendingRequests.get(ask.id)?.outstanding, expected as unknown as string[]);
  }

  await m.supervisor.sendMessage({
    from: "sec", to: ["architect"], type: "INFORM",
    threadId: ask.threadId, replyTo: ask.id, payload: { answer: "ok" },
  });
  assert.equal(m.kernel.state.pendingRequests.has(ask.id), false, "the last answer closes the ask");

  const final = m.kernel.state.discharged.filter((d) => d.messageId === ask.id).at(-1);
  assert.equal(final?.partial, undefined, "the closing discharge is a full one");
  assert.equal(final?.by, "sec");

  await m.cleanup();
});

test("plural debtor: answering twice cannot close a silent debtor's obligation", async () => {
  const m = await reviewPanel();
  const ask = await askThree(m);

  for (let i = 0; i < 3; i++) {
    await m.supervisor.sendMessage({
      from: "dev", to: ["architect"], type: "INFORM",
      threadId: ask.threadId, replyTo: ask.id, payload: { answer: `again ${i}` },
    });
  }

  assert.deepEqual(
    m.kernel.state.pendingRequests.get(ask.id)?.outstanding,
    ["qa", "sec"],
    "a chatty debtor cannot answer on behalf of the silent ones, however many times it replies",
  );
  assert.equal(
    m.kernel.state.discharged.filter((d) => d.messageId === ask.id).length,
    1,
    "and only the first of its replies settles anything",
  );
  await m.cleanup();
});

test("plural debtor: a debtor who already answered may not discharge the ask", async () => {
  const m = await reviewPanel();
  const ask = await askThree(m);
  await m.supervisor.sendMessage({
    from: "dev", to: ["architect"], type: "INFORM",
    threadId: ask.threadId, replyTo: ask.id, payload: { answer: "ok" },
  });

  const s = stub(m);
  s.setScript("dev", async () => ({
    operations: [{ op: "discharge", messageId: ask.id, reason: "not mine to answer" } as unknown as MeshOp],
  }));
  await m.supervisor.activateAgent("dev", { kind: "manual" });
  await waitFor("dev turn ran", () => m.supervisor.isIdle(), 8000);

  assert.ok(
    m.kernel.state.pendingRequests.has(ask.id),
    "an agent that has already answered must not be able to close what qa and sec still owe",
  );
  await m.cleanup();
});

test("plural debtor: an outside resolution still settles the whole ask", async () => {
  // The deliberate asymmetry: a discharger who was never a debtor (the human
  // operator answering for an unresponsive agent, or the runtime superseding
  // a review) is resolving the ASK, not paying one debt.
  const m = await reviewPanel();
  const ask = await askThree(m);

  const orig = m.kernel.state.messages.get(ask.id)!;
  const r = await m.supervisor.humanSend([orig.from], "INFORM", { answer: "operator says ship it" }, orig.threadId, {
    replyTo: orig.id,
  });
  assert.equal(r.accepted, true);
  assert.equal(
    m.kernel.state.pendingRequests.has(ask.id),
    false,
    "an operator answer closes the question for every debtor at once",
  );
  await m.cleanup();
});

test("plural debtor: nudges and the wait-for graph follow the remaining debtors", async () => {
  const m = await reviewPanel();
  const ask = await askThree(m);
  await m.supervisor.sendMessage({
    from: "dev", to: ["architect"], type: "INFORM",
    threadId: ask.threadId, replyTo: ask.id, payload: { answer: "ok" },
  });

  // `owedByYou` drives what an agent is told it must do, and the stall watch
  // decides who to nudge from the same data. Both used to read `pr.to`, which
  // never shrinks — so dev kept being chased for an answer it had given.
  const devCtx = ctxFor(m, "dev");
  assert.equal(
    devCtx.outstanding.owedByYou.some((o: { messageId: string }) => o.messageId === ask.id),
    false,
    "a debtor that answered is no longer told it owes anything",
  );
  for (const still of ["qa", "sec"]) {
    const ctx = ctxFor(m, still);
    assert.equal(
      ctx.outstanding.owedByYou.some((o: { messageId: string }) => o.messageId === ask.id),
      true,
      `${still} has said nothing and must still be told it owes an answer`,
    );
  }

  const askerCtx = ctxFor(m, "architect");
  const waiting = askerCtx.outstanding.awaitingResponse.find((o: { messageId: string }) => o.messageId === ask.id);
  assert.deepEqual(waiting?.to, ["qa", "sec"], "the asker is told who is actually still silent");

  await m.cleanup();
});

test("plural debtor: partial discharges survive replay", async () => {
  const m = await reviewPanel();
  const ask = await askThree(m);
  await m.supervisor.sendMessage({
    from: "dev", to: ["architect"], type: "INFORM",
    threadId: ask.threadId, replyTo: ask.id, payload: { answer: "ok" },
  });

  const events = await m.store.read();
  const fresh = createInitialState();
  for (const e of events) {
    applyEvent(fresh, e, {
      transitionGates: m.config.transitionGates,
      commitmentSemantic: m.config.bus.commitmentSemantic,
    });
  }

  assert.deepEqual(
    fresh.pendingRequests.get(ask.id)?.outstanding,
    m.kernel.state.pendingRequests.get(ask.id)?.outstanding,
    "replayed state must equal live state — per-debtor settlement is event-sourced, not in-memory bookkeeping",
  );
  await m.cleanup();
});

test("plural debtor: a single-recipient ask behaves exactly as before", async () => {
  const m = await reviewPanel();
  const ask = await m.supervisor.sendMessage({
    from: "architect", to: ["dev"], type: "REQUEST",
    newThread: { subject: "one reviewer" }, payload: { q: "?" },
  });
  const threadId = m.kernel.state.messages.get(ask.messageId!)!.threadId;
  await m.supervisor.sendMessage({
    from: "dev", to: ["architect"], type: "INFORM",
    threadId, replyTo: ask.messageId, payload: { answer: "yes" },
  });

  assert.equal(m.kernel.state.pendingRequests.size, 0, "the common case is unchanged: one debtor, one answer, closed");
  const rec = m.kernel.state.discharged.find((d) => d.messageId === ask.messageId);
  assert.equal(rec?.reason, "reply");
  assert.equal(rec?.partial, undefined, "and it is not reported as partial");
  await m.cleanup();
});
