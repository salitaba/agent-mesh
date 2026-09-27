import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { workerBudgetFor, DEFAULT_WORKER_BUDGET_TOKENS } from "../../packages/core/src/turn-tracker";

/**
 * What a delegated worker costs, and what it is allowed to decide.
 *
 * Both were measured on the skill-panel run of 2026-09-24. Two `#worker` seats
 * spent 196,027 tokens against ledgers that appear in no config surface — the
 * number came from an inline `?? 50000`, the ledger was created lazily on first
 * reservation because the boot declare loop covers `config.agentOrder` only, and
 * the spend was charged to neither the parent nor any declared seat. Meanwhile
 * `spawn_worker`'s own `budgetTokens` argument was advertised to the model and
 * silently discarded.
 *
 * Separately, a worker inherits its parent's role but is minted with
 * `authority: []`, which produced the self-contradicting denial "agent
 * tech-lead#worker-2 (role tech-lead) lacks authority 'quality.approve' — held
 * by: tech-lead". The worker retried it twice before giving up.
 */

test("a worker's budget is what the spawning seat asked for, not a hidden constant", () => {
  // Requested beats configured beats fallback.
  assert.equal(workerBudgetFor(5_000, 60_000, 1_000_000), 5_000, "an explicit ask is honoured");
  assert.equal(workerBudgetFor(undefined, 60_000, 1_000_000), 60_000, "else the mesh's declared default");
  assert.equal(
    workerBudgetFor(undefined, undefined, 1_000_000),
    DEFAULT_WORKER_BUDGET_TOKENS,
    "and only then the fallback, which is now a named export rather than an inline literal",
  );
});

test("a worker cannot be used to mint budget its parent does not have", () => {
  // Without the clamp, delegating would be strictly cheaper than doing the work:
  // a worker's ledger is separate from its parent's and climbs its own 8x ladder,
  // so `budgetTokens` would be free money.
  assert.equal(workerBudgetFor(900_000, undefined, 120_000), 120_000, "the ask is clamped to the parent's ceiling");
  assert.equal(workerBudgetFor(50, undefined, 120_000), 50, "an ask under the ceiling is untouched");
  assert.equal(workerBudgetFor(900_000, undefined, undefined), 900_000, "an unmetered parent clamps nothing");
  // Garbage must not become an unmetered worker.
  for (const junk of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      workerBudgetFor(junk, undefined, 1_000_000),
      DEFAULT_WORKER_BUDGET_TOKENS,
      `${junk} must fall back rather than disable the ceiling`,
    );
  }
});

test("a delegated worker is told that no worker holds authority, and who to hand the verdict to", async () => {
  const m = await makeMesh({
    agents: [
      {
        id: "tech-lead",
        role: "tech-lead",
        authority: ["quality.approve", "quality.reject"],
        capabilities: ["code.review"],
        interests: [],
        delegation: { allow: true, max_workers: 2, max_depth: 1 },
      },
    ],
    mayContact: { "tech-lead": [] },
    mode: "parked",
  });
  try {
    // Stand in for the spawned worker: same role as its parent, no authority —
    // exactly the definition `opSpawnWorker` mints.
    await m.kernel.emit(
      "agent.created",
      {
        agent: {
          ...m.kernel.state.agents.get("tech-lead")!.definition,
          id: "tech-lead#worker-1",
          mode: "service",
          authority: [],
          interests: [],
        },
      },
      { actorId: "system" },
    );
    const ctx = { config: m.config, projections: m.kernel.state };
    const res = m.supervisor.deps.policy.evaluateAuthority("tech-lead#worker-1", "quality", "approve", ctx);

    assert.equal(res.decision, "DENY", "a worker still holds no authority — that part is deliberate");
    // The bug was never the refusal; it was a refusal that read as a mistake.
    assert.match(res.reason, /delegated worker/, "the worker must be told WHY its role did not carry the authority");
    assert.match(res.reason, /hold NO authority of their own/, "so it does not read 'held by: tech-lead' as a bug");
    assert.match(res.reason, /Hand your finding back to tech-lead/, "and is given the move that does work");
  } finally {
    await m.cleanup();
  }
});

test("an ordinary seat's authority denial is unchanged — the delegation note is only for workers", async () => {
  const m = await makeMesh({
    agents: [
      { id: "tech-lead", role: "tech-lead", authority: ["quality.approve"], capabilities: ["code.review"], interests: [] },
      { id: "dev", role: "developer", capabilities: ["repository.read"], interests: [] },
    ],
    mayContact: { "tech-lead": [], dev: [] },
    mode: "parked",
  });
  try {
    const ctx = { config: m.config, projections: m.kernel.state };
    const res = m.supervisor.deps.policy.evaluateAuthority("dev", "quality", "approve", ctx);
    assert.equal(res.decision, "DENY");
    assert.match(res.reason, /held by: tech-lead/, "naming the holder is the existing remedy and must survive");
    assert.doesNotMatch(res.reason, /delegated worker/, "a plain seat is not a worker and must not be told it is");
  } finally {
    await m.cleanup();
  }
});
