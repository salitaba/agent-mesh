/**
 * The parked notice: the one sentence an operator sees when the mission is
 * parked while its goal is ACTIVE.
 *
 * A parked mission with an ACTIVE goal is the state that hides itself. The goal
 * says ACTIVE, the scheduler is stopped, and the console's status word reads
 * "running" — so a run sat idle for 14.8 hours while its operator believed it
 * was working. `/status` carries the sentence for the console's banner and
 * `POST /goals/:id/resume` carries it for the caller that just resumed a goal
 * into the same dead state; both are asserted to be the same string, because
 * two accounts of one state is how it stayed hidden.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { createHttpServer, PARKED_MISSION_NOTICE } from "../../apps/mesh-server/src/index";

const AGENTS = { agents: [{ id: "a", role: "r", interests: [] }], mayContact: { a: [] } };

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

test("a parked mission with an ACTIVE goal reports the notice on /status", async () => {
  const m = await makeMesh({ ...AGENTS, mode: "parked" });
  const srv = await withServer(m);
  try {
    const status = (await (await fetch(`${srv.base}/status`)).json()) as any;
    assert.equal(status.mode, "parked");
    assert.equal(status.goal.status, "ACTIVE", "the fixture has to be the hidden state, not a paused one");
    assert.equal(status.parkedNotice, PARKED_MISSION_NOTICE);
    assert.match(status.parkedNotice, /POST \/mission\/start/, "the operator has to be told the way out");
    assert.match(status.parkedNotice, /not running/, "and that nothing is running");
  } finally {
    await srv.close();
  }
});

test("a live mission, and a parked one without an ACTIVE goal, report no notice", async () => {
  const live = await makeMesh({ ...AGENTS, mode: "live" });
  const liveSrv = await withServer(live);
  try {
    const status = (await (await fetch(`${liveSrv.base}/status`)).json()) as any;
    assert.equal(status.mode, "live");
    assert.equal(status.parkedNotice, null, "a running mission has nothing to announce");
  } finally {
    await liveSrv.close();
  }

  const parked = await makeMesh({ ...AGENTS, mode: "parked" });
  const parkedSrv = await withServer(parked);
  try {
    const goalId = parked.kernel.state.activeGoalId!;
    assert.equal((await fetch(`${parkedSrv.base}/goals/${goalId}/pause`, { method: "POST" })).status, 200);
    const status = (await (await fetch(`${parkedSrv.base}/status`)).json()) as any;
    assert.equal(status.goal.status, "PAUSED");
    assert.equal(status.parkedNotice, null, "a parked console with no ACTIVE goal is legitimate and stays quiet");
  } finally {
    await parkedSrv.close();
  }
});

test("resuming on a parked mission returns 200 with the same notice", async () => {
  const m = await makeMesh({ ...AGENTS, mode: "parked" });
  const srv = await withServer(m);
  try {
    const goalId = m.kernel.state.activeGoalId!;
    assert.equal((await fetch(`${srv.base}/goals/${goalId}/pause`, { method: "POST" })).status, 200);

    const resumed = await fetch(`${srv.base}/goals/${goalId}/resume`, { method: "POST" });
    // 200, not an error: the goal really does resume. It just will not run.
    assert.equal(resumed.status, 200);
    const body = (await resumed.json()) as any;
    assert.equal(body.ok, true);
    assert.equal(body.mode, "parked");
    assert.equal(body.notice, PARKED_MISSION_NOTICE, "the same string the console's banner renders");

    const status = (await (await fetch(`${srv.base}/status`)).json()) as any;
    assert.equal(status.goal.status, "ACTIVE");
    assert.equal(status.parkedNotice, body.notice, "resume and /status cannot drift");
  } finally {
    await srv.close();
  }
});
