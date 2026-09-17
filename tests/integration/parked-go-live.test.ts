/**
 * End-to-end for the parked banner's Continue button.
 *
 * The operator complaint these cover is "I clicked Continue and the mesh did
 * not start". That has two very different causes and the console cannot tell
 * them apart without the server saying which: the mission genuinely went live
 * and a seat is working, or the mission went live and *nobody was configured
 * to work*. `mode`/`uiOnly` are derived from `scheduler.isRunning()`
 * (mesh-server/src/index.ts:330-334), so the second case still flips the banner
 * off — it looks like success and behaves like nothing happened.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, waitFor, stub } from "../helpers";
import { createHttpServer } from "../../apps/mesh-server/src/index";
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

const getJson = async (url: string, init?: RequestInit) => {
  const res = await fetch(url, init);
  return { status: res.status, body: (await res.json()) as any };
};

test("parked → Continue: a configured startup seat goes live and actually runs a turn", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] }],
    mayContact: { dev: [] },
    mode: "parked",
    startup: ["dev"],
  });
  let runs = 0;
  stub(m).setScript("dev", async () => {
    runs++;
    return { operations: [{ op: "done" } as MeshOp] };
  });
  const srv = await withServer(m);
  try {
    const before = await getJson(`${srv.base}/status`);
    assert.equal(before.body.mode, "parked", "starts parked");
    assert.equal(before.body.uiOnly, true);
    assert.equal(before.body.startupActivateCount, 1, "console can see a seat is configured to start");
    assert.equal(before.body.lastBoot, null, "nothing booted yet in this process");

    const start = await getJson(`${srv.base}/mission/start`, { method: "POST" });
    assert.equal(start.status, 200);
    assert.equal(start.body.started, true);
    assert.equal(start.body.mode, "live");
    assert.deepEqual(start.body.activated, ["dev"], "names the seat that actually queued");
    assert.deepEqual(start.body.refused, []);

    // The point of the button. Going live is worth nothing if no turn follows.
    await waitFor("the startup seat ran a turn", () => runs === 1, 5000);

    const after = await getJson(`${srv.base}/status`);
    assert.equal(after.body.mode, "live");
    assert.equal(after.body.uiOnly, false);

    // The boot record outlives the response that carried it. This is the whole
    // point: the console refreshes, the POST body is gone, and the operator
    // still needs to be told what boot did.
    assert.deepEqual(after.body.lastBoot.activated, ["dev"]);
    assert.deepEqual(after.body.lastBoot.refused, []);
    assert.ok(Date.parse(after.body.lastBoot.at) > 0, "records when it booted");
    const refetched = await getJson(`${srv.base}/status`);
    assert.deepEqual(refetched.body.lastBoot, after.body.lastBoot, "survives a refresh");
  } finally {
    await srv.close();
  }
});

test("parked → Continue with no startup seats: live, idle, and the response says so", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] }],
    mayContact: { dev: [] },
    mode: "parked",
    // No `startup` — the default, and the shape of the reported bug.
  });
  let runs = 0;
  stub(m).setScript("dev", async () => {
    runs++;
    return { operations: [{ op: "done" } as MeshOp] };
  });
  const srv = await withServer(m);
  try {
    const before = await getJson(`${srv.base}/status`);
    assert.equal(before.body.startupActivateCount, 0, "zero is a fact the console can state, not a guess");

    const start = await getJson(`${srv.base}/mission/start`, { method: "POST" });
    assert.equal(start.status, 200);
    assert.equal(start.body.started, true);
    assert.equal(start.body.mode, "live", "the banner clears even though nothing will run");
    assert.deepEqual(start.body.activated, [], "nothing was activated");
    assert.deepEqual(start.body.refused, [], "and nothing was refused — there was nothing to refuse");
    assert.match(
      start.body.note,
      /no startup agents configured/,
      "the 200 must carry the reason, or the console reports a successful boot of nothing",
    );

    // Durable too, so the banner can state the empty case after a refresh
    // rather than offering it as one of two guesses.
    const after = await getJson(`${srv.base}/status`);
    assert.deepEqual(after.body.lastBoot.activated, []);
    assert.deepEqual(after.body.lastBoot.refused, []);

    // This is the operator's "it did not start": live, healthy, and idle.
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(runs, 0, "no seat is configured to start, so no turn runs");
  } finally {
    await srv.close();
  }
});

/*
 * NOT COVERED YET — the third way Continue "does nothing": seats *are*
 * configured (so `startupActivateCount` is non-zero and the console cannot fall
 * back on "nobody was configured") but every one is refused. `activateAgent`
 * refuses startup activation when there is no goal, or the goal is PAUSED /
 * FAILED / COMPLETED / ESCALATED (supervisor.ts:1657-1662).
 *
 * A test driving this through an `escalate` op was written and removed: after
 * the op, a second Continue returned `activated: ["dev"]`, so the goal was still
 * live — an `escalate` op records an escalation without moving the goal to
 * ESCALATED. Whether it should is an open design question, and asserting
 * today's behaviour would have frozen an unverified answer. See
 * NOTES-confirm-hang.md.
 */

test("Continue is idempotent: a second click does not re-boot a live mission", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] }],
    mayContact: { dev: [] },
    mode: "parked",
    startup: ["dev"],
  });
  let runs = 0;
  stub(m).setScript("dev", async () => {
    runs++;
    return { operations: [{ op: "done" } as MeshOp] };
  });
  const srv = await withServer(m);
  try {
    const first = await getJson(`${srv.base}/mission/start`, { method: "POST" });
    assert.equal(first.body.started, true);
    await waitFor("first click ran the seat", () => runs === 1, 5000);

    const second = await getJson(`${srv.base}/mission/start`, { method: "POST" });
    assert.equal(second.status, 200);
    assert.equal(second.body.started, false, "already live");
    assert.match(second.body.note, /already live/);

    // A no-op click must not overwrite the record of the boot that did happen.
    const after = await getJson(`${srv.base}/status`);
    assert.deepEqual(after.body.lastBoot.activated, ["dev"], "the real boot's record still stands");

    await new Promise((r) => setTimeout(r, 300));
    assert.equal(runs, 1, "the second click did not activate the seat again");
  } finally {
    await srv.close();
  }
});
