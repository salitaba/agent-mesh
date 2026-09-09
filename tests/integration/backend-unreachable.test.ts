import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor } from "../helpers";
import { BackendUnreachableError } from "../../packages/protocol/src/index";
import type { MeshOp } from "../../packages/protocol/src/index";

const DEAD_BACKEND = "http://127.0.0.1:4199";

test("unreachable backend escalates backend_unreachable with backend detail after consecutive failures", async () => {
  const m = await makeMesh({
    agents: [{ id: "qa", role: "qa", capabilities: ["test.execute"], interests: [] }],
    mayContact: { qa: [] },
    criteria: [{ id: "x", description: "x", mandatory: true }],
  });
  const s = stub(m);
  // Every turn dies at the transport layer, like a crashed backend process.
  s.setScript("qa", async () => {
    throw new BackendUnreachableError(DEAD_BACKEND, "fetch failed");
  });
  await m.supervisor.activateAgent("qa", { kind: "manual" });
  await waitFor(
    "backend_unreachable escalation",
    () => [...m.kernel.state.escalations.values()].some((e) => e.reason === "backend_unreachable"),
    15000,
  );
  const esc = [...m.kernel.state.escalations.values()].find((e) => e.reason === "backend_unreachable")!;
  const detail = esc.detail as { agentId?: string; backend?: string; consecutiveFailures?: number; hint?: string };
  assert.equal(detail.agentId, "qa");
  assert.equal(detail.backend, DEAD_BACKEND);
  assert.ok((detail.consecutiveFailures ?? 0) >= 3, "escalates after repeated consecutive failures, not the first");
  assert.match(detail.hint ?? "", /alive|OOM|restart/);
  const failed = (await m.store.read({ types: ["agent.failed"] })).filter(
    (e) => (e.payload as { agentId?: string }).agentId === "qa",
  );
  assert.ok(failed.length > 0);
  assert.match(String((failed[0].payload as { error?: string }).error ?? ""), new RegExp(DEAD_BACKEND.replace(/[.:/]/g, (c) => `\\${c}`)));
  await m.cleanup();
});

test("plain failures still escalate runtime_failure without a backend label", async () => {
  const m = await makeMesh({
    agents: [{ id: "qa", role: "qa", capabilities: ["test.execute"], interests: [], persistent: false }],
    mayContact: { qa: [] },
    criteria: [{ id: "x", description: "x", mandatory: true }],
  });
  const s = stub(m);
  s.setScript("qa", async () => {
    throw new Error("boom");
  });
  await m.supervisor.activateAgent("qa", { kind: "manual" });
  await waitFor(
    "runtime_failure escalation",
    () => [...m.kernel.state.escalations.values()].some((e) => e.reason === "runtime_failure"),
    8000,
  );
  const esc = [...m.kernel.state.escalations.values()].find((e) => e.reason === "runtime_failure")!;
  assert.equal((esc.detail as { error?: string }).error, "boom");
  await m.cleanup();
});

test("a success resets failure counters (no stale immediate escalation)", async () => {
  const m = await makeMesh({
    agents: [{ id: "qa", role: "qa", capabilities: ["test.execute"], interests: [] }],
    mayContact: { qa: [] },
    criteria: [{ id: "x", description: "x", mandatory: true }],
  });
  const s = stub(m);
  let n = 0;
  s.setScript("qa", async () => {
    n++;
    // Fail, succeed, fail: the middle success must clear the counters so the
    // second failure counts as a first failure, not an immediate escalation.
    if (n === 1 || n === 3) throw new Error(`boom-${n}`);
    return { operations: [{ op: "done" } as MeshOp] };
  });
  const turnDone = () =>
    m.supervisor.getRecentTurns(5).some((t) => t.agentId === "qa" && (t.status === "ok" || t.status === "waiting")) &&
    m.kernel.state.agents.get("qa")?.state.lifecycle === "IDLE";
  await m.supervisor.activateAgent("qa", { kind: "manual" });
  await waitFor("recovered to idle after first failure", turnDone, 8000);
  assert.equal((m.supervisor as unknown as { restartAttempts: Map<string, number> }).restartAttempts.get("qa"), undefined);
  await m.supervisor.activateAgent("qa", { kind: "manual" });
  await waitFor("recovered to idle after second failure", turnDone, 8000);
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(
    ![...m.kernel.state.escalations.values()].some((e) => e.reason === "runtime_failure" || e.reason === "backend_unreachable"),
    "non-consecutive failures must not escalate",
  );
  await m.cleanup();
});
