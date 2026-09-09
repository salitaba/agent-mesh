import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, waitFor, stub } from "../helpers";
import { createHttpServer } from "../../apps/mesh-server/src/index";
import { resolveLaunchMode } from "../../apps/mesh-cli/src/index";
import type { MeshOp } from "../../packages/protocol/src/index";

async function withServer(m: Awaited<ReturnType<typeof makeMesh>>) {
  const server = createHttpServer(m as any);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    base: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      await m.cleanup();
    },
  };
}

test("parked: POST /messages with wake:true sends AND steps in one action", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] }],
    mayContact: { dev: [] },
    mode: "parked",
  });
  let runs = 0;
  stub(m).setScript("dev", async () => {
    runs++;
    return { operations: [{ op: "done" } as MeshOp] };
  });
  const srv = await withServer(m);
  try {
    const res = await fetch(`${srv.base}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: ["dev"], type: "INFORM", payload: { note: "hello" }, wake: true }),
    });
    assert.equal(res.status, 202);
    const body = (await res.json()) as any;
    assert.equal(body.wake?.dev?.queued, true, "wake result reported inline");
    await waitFor("wake-after-send ran one turn", () => runs === 1, 5000);
  } finally {
    await srv.close();
  }
});

test("parked: POST /messages without wake still queues only (backward compat)", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] }],
    mayContact: { dev: [] },
    mode: "parked",
  });
  let runs = 0;
  stub(m).setScript("dev", async () => {
    runs++;
    return { operations: [{ op: "done" } as MeshOp] };
  });
  const srv = await withServer(m);
  try {
    const res = await fetch(`${srv.base}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: ["dev"], type: "INFORM", payload: { note: "queued only" } }),
    });
    assert.equal(res.status, 202);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(runs, 0, "no auto-activation while parked without wake:true");
    assert.ok((m.kernel.state.unread.get("dev")?.length ?? 0) >= 1, "mail stays queued");
  } finally {
    await srv.close();
  }
});

test("mission/start is idempotent: second call does not re-boot a new goal", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] }],
    mayContact: { dev: [] },
    startup: ["dev"],
    mode: "parked",
  });
  stub(m).setScript("dev", async () => ({ operations: [{ op: "done" } as MeshOp] }));
  const goalBefore = m.kernel.state.activeGoalId;
  const srv = await withServer(m);
  try {
    const first = await (await fetch(`${srv.base}/mission/start`, { method: "POST" })).json() as any;
    assert.equal(first.started, true);
    assert.equal(first.mode, "live");
    const goalAfterFirst = m.kernel.state.activeGoalId;
    assert.equal(goalAfterFirst, goalBefore, "goLive must not create a second goal");

    const second = await (await fetch(`${srv.base}/mission/start`, { method: "POST" })).json() as any;
    assert.equal(second.started, false, "already live reports started:false");
    assert.equal(m.kernel.state.activeGoalId, goalAfterFirst, "still the same goal after double start");

    const status = (await (await fetch(`${srv.base}/status`)).json()) as any;
    assert.equal(status.mode, "live");
    assert.equal(status.uiOnly, false);
  } finally {
    await srv.close();
  }
});

test("status reports mode + legacy uiOnly consistently", async () => {
  const parked = await makeMesh({
    agents: [{ id: "a", role: "r", interests: [] }],
    mayContact: { a: [] },
    mode: "parked",
  });
  try {
    assert.equal(parked.mode, "parked");
    assert.equal(parked.uiOnly, true);
  } finally {
    await parked.cleanup();
  }
  const live = await makeMesh({
    agents: [{ id: "a", role: "r", interests: [] }],
    mayContact: { a: [] },
    mode: "live",
  });
  try {
    assert.equal(live.mode, "live");
    assert.equal(live.uiOnly, false);
  } finally {
    await live.cleanup();
  }
});

test("cli: resolveLaunchMode maps commands and flags", () => {
  assert.equal(resolveLaunchMode("run", {}).mode, "live");
  assert.equal(resolveLaunchMode("serve", {}).mode, "live");
  assert.equal(resolveLaunchMode("up", {}).mode, "live");
  assert.equal(resolveLaunchMode("ui", {}).mode, "parked");
  assert.equal(resolveLaunchMode("console", {}).mode, "parked");
  // explicit flags win
  assert.equal(resolveLaunchMode("run", { parked: true }).mode, "parked");
  assert.equal(resolveLaunchMode("run", { "ui-only": true }).mode, "parked");
  assert.equal(resolveLaunchMode("ui", { live: true }).mode, "live");
  // conflict: live wins with warning
  const c = resolveLaunchMode("run", { parked: true, live: true });
  assert.equal(c.mode, "live");
  assert.ok(c.warnings.length >= 1);
  // deprecated alias warns
  const d = resolveLaunchMode("run", { "ui-only": true });
  assert.ok(d.warnings.some((w) => w.includes("--ui-only")));
});
