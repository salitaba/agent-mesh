import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { BUILTIN_CONTRACTS, findContract, type MeshOp } from "../../packages/protocol/src/index";

/**
 * `Contract.refusals`, made to bind (Gap 5).
 *
 * The set has been declared on every contract since contracts shipped and read
 * by nothing: `refusals` appeared in the catalogue and in the `contracts`
 * listing, and nowhere else. So the one field whose entire purpose is to make
 * "no" BRANCHABLE was:
 *
 *   1. invisible to the party that gives the "no" — a debtor answering an ask
 *      never saw the set, because the only renderer was the listing a seat
 *      consults when deciding what to ASK; and
 *   2. unchecked at the moment of refusing — any string settled the ask, so
 *      `contracts.ts`'s promise ("so the asker can tell 'I am the wrong seat'
 *      from 'your ask is incomplete' from 'I disagree'") was delivered to
 *      nobody.
 *
 * Both halves are closed below. The design constraint throughout is that this
 * must not become a new way to trap a debtor: the check applies to a NAME the
 * debtor chose to state, and a refusal in prose alone behaves exactly as it did
 * before. Blocking prose refusals would hold asks open on vocabulary and feed
 * the nudge ladder, which is the failure the `response` schema deliberately
 * avoids by marking instead of blocking.
 */

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

function seats() {
  return [
    { id: "architect", role: "architect", capabilities: ["review.design", "architecture.write"], interests: [] },
    { id: "dev", role: "developer", capabilities: ["repository.write", "repository.read"], interests: [] },
  ];
}

function mesh() {
  return makeMesh({
    agents: seats(),
    mayContact: { architect: ["dev"], dev: ["architect"] },
    mode: "parked",
  } as never);
}

function turn(agentId: string) {
  return {
    turnId: `t-${Math.random().toString(36).slice(2)}`,
    agentId,
    reason: { kind: "manual" as const },
    sentOps: 0,
    publishedOps: 0,
    waitRequested: false,
    escalated: false,
    results: [],
  } as never;
}

/** An ask opened through a real contract, so the ledger carries the stamp. */
async function contractAsk(m: Mesh, contract: string, request: unknown) {
  const res = await m.supervisor.executeOp("architect", { op: "call", contract, request } as MeshOp, turn("architect"));
  assert.equal(res.ok, true, res.reason);
  const id = res.messageId!;
  assert.equal(m.kernel.state.pendingRequests.get(id)?.contract, contract, "the stamp is what the check reads");
  return id;
}

const discharge = (id: string, reason: string, refusal?: string): MeshOp =>
  ({ op: "discharge", messageId: id, reason, ...(refusal ? { refusal } : {}) }) as MeshOp;

/* ------------------------------------------------------------------ *
 * The check, at the edge                                              *
 * ------------------------------------------------------------------ */

test("a refusal name outside the contract's set is refused at the edge, and the refusal lists the real ones", async () => {
  const m = await mesh();
  const id = await contractAsk(m, "info.question", { question: "what port does the bus use?" });

  const res = await m.supervisor.executeOp("dev", discharge(id, "can't help", "not-interested"), turn("dev"));
  assert.equal(res.ok, false, "a name the contract does not admit must not settle the ask");
  // The mitigation, not just the block: getting it wrong has to teach the right
  // one in the same breath, or this is an alias table waiting to be written.
  for (const name of findContract("info.question")!.refusals) {
    assert.match(res.reason ?? "", new RegExp(name), `the refusal must name '${name}'`);
  }
  assert.match(res.reason ?? "", /not-my-capability/, "and the legitimate set leads the sentence");
  assert.ok(m.kernel.state.pendingRequests.has(id), "nothing was closed by the failed attempt");
  await m.cleanup();
});

test("a refusal from the contract's set settles the ask and reaches the asker as DATA", async () => {
  const m = await mesh();
  const id = await contractAsk(m, "info.question", { question: "what port does the bus use?" });

  const res = await m.supervisor.executeOp("dev", discharge(id, "that lives in the ops runbook, not here", "not-my-capability"), turn("dev"));
  assert.equal(res.ok, true, res.reason);
  assert.equal(m.kernel.state.pendingRequests.has(id), false, "a legitimate no settles the debt like any settlement");

  const rec = m.kernel.state.discharged.find((d) => d.messageId === id);
  assert.equal(rec?.reason, "refused", "still the debtor's refusal, not a new reason kind");

  // The deliverable: the asker branches on this without parsing prose. It rides
  // the notice payload, which is the asker-facing channel, and the discharge
  // event, which is the durable one.
  const notice = [...m.kernel.state.messages.values()].find((x) => x.replyTo === id);
  assert.ok(notice, "the asker was told");
  assert.equal((notice!.payload as Record<string, unknown>).refusal, "not-my-capability");
  assert.equal((notice!.payload as Record<string, unknown>).declined, true);
  assert.match(String((notice!.payload as Record<string, unknown>).reason), /runbook/, "the words are kept beside the kind");
  await m.cleanup();
});

test("prose alone still settles an ask, because blocking it would feed the nudge ladder", async () => {
  const m = await mesh();
  const id = await contractAsk(m, "info.question", { question: "what port does the bus use?" });

  // The pre-existing behaviour, and deliberately unchanged: a debtor that
  // cannot recall the vocabulary is not trapped by it. `refusal` is a name a
  // seat CHOOSES to state, never one it is forced to produce.
  const res = await m.supervisor.executeOp("dev", discharge(id, "I genuinely don't know, ask the ops lead"), turn("dev"));
  assert.equal(res.ok, true, res.reason);
  assert.equal(m.kernel.state.pendingRequests.has(id), false);

  const notice = [...m.kernel.state.messages.values()].find((x) => x.replyTo === id);
  assert.equal((notice!.payload as Record<string, unknown>).refusal, undefined, "no kind is invented for it");
  assert.equal((notice!.payload as Record<string, unknown>).declined, true);
  await m.cleanup();
});

test("an ask with no contract has nothing to check, so any name is accepted as given", async () => {
  const m = await mesh();
  // A raw REQUEST: no stamp, so there is no closed set to be outside of.
  const ask = await m.supervisor.sendMessage({
    from: "architect", to: ["dev"], type: "REQUEST",
    newThread: { subject: "no contract here" }, payload: { ask: "do the thing" },
  });
  const id = ask.messageId!;
  assert.equal(m.kernel.state.pendingRequests.get(id)?.contract, undefined);

  const res = await m.supervisor.executeOp("dev", discharge(id, "no", "some-name-of-my-own"), turn("dev"));
  assert.equal(res.ok, true, res.reason);
  await m.cleanup();
});

test("every builtin contract that declares refusals can be refused by one of them", async () => {
  // Guards the two halves against drifting: the check reads `findContract`, and
  // the prompt renders `findContract`. A contract whose set is empty is exempt
  // by construction (`decision.escalate`, which no peer answers).
  for (const c of BUILTIN_CONTRACTS) {
    if (c.refusals.length === 0) continue;
    assert.equal(findContract(c.name)?.refusals, c.refusals, `${c.name}: the check and the catalogue must agree`);
    for (const r of c.refusals) assert.match(r, /^[a-z0-9-]+$/, `${c.name}: '${r}' is a name, not a sentence`);
  }
});

/* ------------------------------------------------------------------ *
 * The set is readable by the party that says no                       *
 * ------------------------------------------------------------------ */

test("an obliging message carrying a contract shows the debtor the noes it may give", async () => {
  const m = await mesh();
  await contractAsk(m, "info.question", { question: "what port does the bus use?" });

  const { buildAgentContext, renderContextInstructions } = await import("../../packages/core/src/context");
  const bundle = buildAgentContext({ config: m.config, kernel: m.kernel }, "dev");
  const text = renderContextInstructions(bundle);
  const section = text.slice(text.indexOf("## Unread mail"));

  // Without this line the check above is unfair: it would refuse a name the
  // debtor had no way to look up at the moment it decided to say no.
  assert.match(section, /contract: info\.question/);
  for (const name of findContract("info.question")!.refusals) {
    assert.match(section, new RegExp(name), `the debtor must be able to read '${name}'`);
  }
  await m.cleanup();
});
