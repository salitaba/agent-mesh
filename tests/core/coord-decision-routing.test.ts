import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { buildAgentContext, buildContextManifest, renderContextInstructions } from "../../packages/core/src/context";
import { createInitialState } from "../../packages/core/src/state";
import { applyEvent, projectionConfigFor } from "../../packages/core/src/projections";
import type { MeshMessage, MeshOp } from "../../packages/protocol/src/index";

/**
 * §16 of the 2026-09-25 live run: PROPOSED decisions went nowhere.
 *
 * `proposeDecision` routed to no ratifier and every context rendered only
 * RATIFIED decisions — the decisions slot read 0/0 in all 52 contexts — so
 * backend's pnpm proposal, which contradicted the ratified ADR-0013 (npm), sat
 * PROPOSED with nobody ever shown it.
 */

const AGENTS = [
  { id: "backend", role: "developer", capabilities: ["repository.read", "repository.write"], interests: [] },
  { id: "arch", role: "architect", capabilities: ["repository.read", "architecture.write"], authority: ["architecture.approve"], interests: [] },
  { id: "pm", role: "pm", capabilities: ["repository.read"], authority: ["requirements.approve"], interests: [] },
];
const COMM = { backend: ["arch", "pm"], arch: ["backend", "pm"], pm: ["backend", "arch"] };

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

const turnFor = (agentId: string) =>
  ({
    turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`,
    agentId,
    reason: { kind: "manual" as const },
    sentOps: 0,
    publishedOps: 0,
    waitRequested: false,
    escalated: false,
    results: [],
  }) as never;

async function propose(m: Mesh) {
  const res = await m.supervisor.executeOp("backend", { op: "propose_decision", topic: "package manager", decision: { choice: "pnpm" } } as MeshOp, turnFor("backend"));
  assert.equal(res.ok, true, res.reason);
  return res;
}

test("decisions: a proposal is routed, as an obliging ask, to the seats that can ratify it", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" });
  try {
    const res = await propose(m);
    const decisionId = res.reason!;
    assert.equal(m.kernel.state.decisions.get(decisionId)?.status, "PROPOSED", "the op still returns the decision id");
    assert.ok(res.messageId, "and the ratification ask it opened");
    const ask = m.kernel.state.messages.get(res.messageId!) as MeshMessage;
    assert.equal(ask.from, "backend");
    assert.deepEqual(ask.to, ["arch"], "architecture.approve holders only — ratifyDecision checks that authority, whatever the topic");
    assert.equal((ask.payload as { ratifyDecision?: string }).ratifyDecision, decisionId);
    assert.ok(m.kernel.state.pendingRequests.has(ask.id), "arch owes an answer: before this nothing asked anyone");
  } finally {
    await m.cleanup();
  }
});

test("decisions: the ratifier's context renders the proposal; nobody else's does", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" });
  try {
    const decisionId = (await propose(m)).reason!;
    const arch = buildAgentContext({ config: m.config, kernel: m.kernel }, "arch");
    assert.deepEqual(arch.proposedDecisions?.map((d) => d.id), [decisionId]);
    const text = renderContextInstructions(arch);
    assert.match(text, /## Proposed decisions you can ratify/);
    assert.match(text, new RegExp(`\\[${decisionId}\\] package manager — proposed by backend: \\{"choice":"pnpm"\\}`));
    const manifest = buildContextManifest(arch, { agentId: "arch", budgetTokens: 1000, usedTokens: 10, tier: "full", overSoftCap: false });
    assert.equal(manifest.slots.find((s) => s.slot === "decisions")?.admitted, 1, "the decisions slot is no longer 0/0 for the seat that must decide");

    const pm = buildAgentContext({ config: m.config, kernel: m.kernel }, "pm");
    assert.equal(pm.proposedDecisions, undefined, "a seat that cannot ratify is not shown a proposal it can only read about");
  } finally {
    await m.cleanup();
  }
});

test("decisions: ratifying answers the ask — on the live ledger and on replay", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" });
  try {
    const res = await propose(m);
    assert.ok(res.messageId && m.kernel.state.pendingRequests.has(res.messageId), "precondition: arch owes the ratification ask");
    const ok = await m.supervisor.executeOp("arch", { op: "ratify_decision", decisionId: res.reason } as MeshOp, turnFor("arch"));
    assert.equal(ok.ok, true, ok.reason);
    assert.equal(m.kernel.state.decisions.get(res.reason!)?.status, "RATIFIED");
    assert.equal(m.kernel.state.pendingRequests.has(res.messageId!), false, "no follow-up message is needed to close it");
    const arch = buildAgentContext({ config: m.config, kernel: m.kernel }, "arch");
    assert.equal(arch.outstanding.owedByYou.length, 0);
    assert.equal(arch.proposedDecisions, undefined);

    const fresh = createInitialState();
    for (const e of await m.store.read()) applyEvent(fresh, e, projectionConfigFor(m.config));
    assert.equal(fresh.pendingRequests.has(res.messageId!), false, "replay closes it too");
    assert.equal(fresh.decisions.get(res.reason!)?.status, "RATIFIED");
  } finally {
    await m.cleanup();
  }
});

test("decisions: with nobody else able to ratify, nothing is sent", async () => {
  const m = await makeMesh({
    agents: [AGENTS[1]!, AGENTS[2]!],
    mayContact: { arch: ["pm"], pm: ["arch"] },
    mode: "parked",
  });
  try {
    const before = (await m.store.read()).filter((e) => e.type === "message.sent").length;
    const res = await m.supervisor.executeOp("arch", { op: "propose_decision", topic: "db", decision: { choice: "sqlite" } } as MeshOp, turnFor("arch"));
    assert.equal(res.ok, true);
    assert.equal(res.messageId, undefined);
    assert.equal((await m.store.read()).filter((e) => e.type === "message.sent").length, before, "an ask to nobody is not an ask");
    const arch = buildAgentContext({ config: m.config, kernel: m.kernel }, "arch");
    assert.deepEqual(arch.proposedDecisions?.map((d) => d.id), [res.reason], "the proposer who alone can ratify still sees it pending");
  } finally {
    await m.cleanup();
  }
});
