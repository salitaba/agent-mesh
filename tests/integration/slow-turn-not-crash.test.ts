import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor } from "../helpers";
import { RequestTimeoutError, BackendUnreachableError } from "../../packages/protocol/src/index";

const SLOW_BACKEND = "http://127.0.0.1:4198";

/**
 * A slow backend and a dead one need different budgets.
 *
 * Incident: an agent whose turns exceeded the (then-unremovable) 300s fetch cap
 * raised `fetch failed`, which the supervisor counted as a crash. Three
 * restarts later the agent was suspended permanently — while its backend was
 * healthy the whole time. The restart budget exists to stop respawning a dead
 * process; spending it on a thinking model is a category error.
 */

test("a slow backend retries beyond the 3-restart crash budget instead of suspending", async () => {
  const m = await makeMesh({
    agents: [{ id: "qa", role: "qa", capabilities: ["test.execute"], interests: [] }],
    mayContact: { qa: [] },
    criteria: [{ id: "x", description: "x", mandatory: true }],
  });
  const s = stub(m);
  let turns = 0;
  s.setScript("qa", async () => {
    turns += 1;
    throw new RequestTimeoutError(SLOW_BACKEND, "POST /session/s/message", 600000);
  });
  await m.supervisor.activateAgent("qa", { kind: "manual" });
  // The crash path caps at 3. Reaching a 4th attempt proves timeouts are on a
  // separate budget rather than sharing the crash counter.
  await waitFor("slow-turn retries exceed the crash budget", () => turns > 3, 30000);
  assert.ok(turns > 3, `expected more than 3 attempts for a reachable-but-slow backend, saw ${turns}`);

  // And it must never be labeled as an unreachable backend.
  const failed = (await m.store.read({ types: ["agent.failed"] })).filter(
    (e) => (e.payload as { agentId?: string }).agentId === "qa",
  );
  assert.ok(failed.length > 0, "the timeout is still recorded, just not as a crash");
  for (const e of failed) {
    const msg = String((e.payload as { error?: string }).error ?? "");
    assert.doesNotMatch(msg, /backend unreachable/, "a reachable-but-slow backend must not be labeled unreachable");
  }
  await m.cleanup();
});

test("a dead backend still exhausts the crash budget and escalates", async () => {
  const m = await makeMesh({
    agents: [{ id: "qa", role: "qa", capabilities: ["test.execute"], interests: [] }],
    mayContact: { qa: [] },
    criteria: [{ id: "x", description: "x", mandatory: true }],
  });
  const s = stub(m);
  s.setScript("qa", async () => {
    throw new BackendUnreachableError(SLOW_BACKEND, "connect ECONNREFUSED");
  });
  await m.supervisor.activateAgent("qa", { kind: "manual" });
  await waitFor(
    "backend_unreachable escalation still fires",
    () => [...m.kernel.state.escalations.values()].some((e) => e.reason === "backend_unreachable"),
    15000,
  );
  await m.cleanup();
});
