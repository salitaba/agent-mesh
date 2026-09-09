import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { agentKey } from "../../packages/core/src/budgets";
import { createHttpServer } from "../../apps/mesh-server/src/index";

test("budget: operator can raise an exhausted agent budget (event-sourced, unblocks)", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", capabilities: ["repository.write"], interests: [], tokens: 1000 }],
    mayContact: { dev: [] },
  });
  const goalId = m.kernel.state.activeGoalId!;
  const key = agentKey(goalId, "dev");

  // Exhaust it.
  await m.supervisor.deps.budget.consume(key, "tokens", 1500, undefined, {}, { actorId: "dev" });
  assert.equal(m.kernel.state.budgets.get(key)?.exceeded, true);

  // Validation: unknown keys and non-raises are refused.
  assert.equal((await m.supervisor.raiseBudget("agent:nope/nope", { limit: 10 })).ok, false);
  assert.equal((await m.supervisor.raiseBudget(key, { limit: 1000 })).ok, false);
  assert.equal((await m.supervisor.raiseBudget(key, {})).ok, false);

  // Raise above spend: unblocks, recorded in the log.
  const r = await m.supervisor.raiseBudget(key, { limit: 5000 });
  assert.equal(r.ok, true);
  assert.equal(r.previous, 1000);
  assert.equal(r.unblocked, true);
  assert.equal(m.kernel.state.budgets.get(key)?.limit, 5000);
  assert.equal(m.kernel.state.budgets.get(key)?.exceeded, false);
  const events = await m.store.read({ types: ["budget.limit_raised"] });
  assert.equal(events.length, 1);
  assert.equal((events[0].payload as { limit: number }).limit, 5000);

  // `add` increments on top of the current limit.
  const r2 = await m.supervisor.raiseBudget(key, { add: 1000 });
  assert.equal(r2.ok, true);
  assert.equal(r2.limit, 6000);

  // Overrunning again re-exceeds (latch re-armed, not stuck cleared).
  await m.supervisor.deps.budget.consume(key, "tokens", 99999, undefined, {}, { actorId: "dev" });
  assert.equal(m.kernel.state.budgets.get(key)?.exceeded, true);
  await m.cleanup();
});

test("budget: raise below spend stays exceeded (honest unblocked=false)", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", capabilities: ["repository.write"], interests: [], tokens: 1000 }],
    mayContact: { dev: [] },
  });
  const key = agentKey(m.kernel.state.activeGoalId!, "dev");
  await m.supervisor.deps.budget.consume(key, "tokens", 99999999, undefined, {}, { actorId: "dev" });
  // New limit above the old one but still under spend: recorded, but honestly
  // still blocked (raising again past spend is what unblocks).
  const r = await m.supervisor.raiseBudget(key, { limit: 50000 });
  assert.equal(r.ok, true);
  assert.equal(r.unblocked, false);
  assert.equal(m.kernel.state.budgets.get(key)?.exceeded, true);
  const r2 = await m.supervisor.raiseBudget(key, { limit: 200000000 });
  assert.equal(r2.unblocked, true);
  assert.equal(m.kernel.state.budgets.get(key)?.exceeded, false);
  await m.cleanup();
});

test("budget: POST /budgets/raise validates and raises", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] }],
    mayContact: { dev: [] },
  });
  const key = agentKey(m.kernel.state.activeGoalId!, "dev");
  const server = createHttpServer(m, { dashboardDir: undefined });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const raise = async (body: unknown) => {
    const res = await fetch(`${base}/budgets/raise`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as { ok: boolean; reason?: string; limit?: number } };
  };
  try {
    assert.equal((await raise({})).status, 400);
    assert.equal((await raise({ key: "nope", limit: 5 })).status, 400);
    const good = await raise({ key, add: 5000 });
    assert.equal(good.status, 200);
    assert.equal(good.json.ok, true);
    assert.ok((good.json.limit ?? 0) > 0);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await m.cleanup();
  }
});
