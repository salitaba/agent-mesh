/**
 * `/steps`, `/turns/:id` and `mesh_steps` over the real server, for a turn the
 * tracker still holds but the tail scan no longer reaches.
 *
 * That is the case that went wrong live: the ring and the scan are sized
 * independently, the merge invented `{0,0,0,0}` for every ring turn the scan
 * missed, and the dashboard called a turn that had published artifacts
 * refused. The unit tests in `steps-view.test.ts` cover the fill itself; this
 * file proves both routes and the seat tool are wired through it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHttpServer, closeHttpServer } from "../../apps/mesh-server/src/index";
import { createMcpToolset } from "../../apps/mesh-server/src/mcp";
import { mintSeatToken } from "../../packages/core/src/seat-token";
import type { TurnRecord } from "../../packages/core/src/index";
import type { TurnStep } from "../../packages/observability/src/index";
import type { MeshEvent } from "../../packages/protocol/src/index";
import { makeMesh, type TestMesh } from "../helpers";

const TURN = "turn-routes-old";

function ev(type: string, payload: Record<string, unknown>, env: Partial<MeshEvent> = {}): MeshEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    type,
    timestamp: new Date().toISOString(),
    payload,
    ...env,
  } as MeshEvent;
}

/**
 * Write the turn straight into the log, then bury it. The kernel is bypassed on
 * purpose: these routes read the log and the tracker and nothing else, and a
 * real `message.sent` or `artifact.created` would need a real message and a
 * real artifact behind it for the reducers to accept.
 *
 * The operator note in the middle carries the turn only in its payload, the
 * way in-turn operator input does, so `/turns/:id` finds it by the tail scan
 * rather than the index. That is the event that used to be appended at the end.
 */
async function seed(m: TestMesh): Promise<{ note: string }> {
  const env = { actorId: "architect", correlationId: TURN };
  await m.store.append(ev("agent.awakened", { agentId: "architect", turnId: TURN, reason: { kind: "message" } }, env));
  await m.store.append(ev("message.sent", { message: { id: "msg-1" } }, env));
  const note = ev("human.input", { turnId: TURN, text: "mind the schema" }, { actorId: "human" });
  await m.store.append(note);
  for (const i of [1, 2, 3, 4]) await m.store.append(ev("artifact.created", { artifact: { id: `art-${i}` } }, env));
  await m.store.append(ev("agent.state_changed", { agentId: "architect", to: "IDLE", turnId: TURN }, env));
  // Past `/steps?limit=10`'s 400-event scan, inside `/turns/:id`'s 2000.
  for (let i = 0; i < 450; i++) await m.store.append(ev("goal.progress", { i }, { actorId: "system" }));

  // The tracker still holds the turn, as it did live. Its ring is private; the
  // supervisor timer tests pose turns the same way.
  const rec: TurnRecord = {
    turnId: TURN,
    agentId: "architect",
    reason: { kind: "message" },
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    status: "ok",
    tokens: 1200,
  } as TurnRecord;
  (m.supervisor as unknown as { turns: { push(r: TurnRecord): void } }).turns.push(rec);
  return { note: note.id };
}

async function withServer(fn: (base: string, m: TestMesh, seeded: { note: string }) => Promise<void>): Promise<void> {
  const m = await makeMesh({
    agents: [{ id: "architect", role: "architect", interests: [] }],
    mayContact: { architect: [] },
    // Parked: no scheduler, so nothing but the seed writes to the log.
    mode: "parked",
  });
  const seeded = await seed(m);
  const server = createHttpServer(m, { dashboardDir: undefined });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await fn(base, m, seeded);
  } finally {
    await closeHttpServer(server);
    await m.cleanup();
  }
}

test("/steps gives a ring turn outside the scan its logged counts", async () => {
  await withServer(async (base) => {
    const steps = (await (await fetch(`${base}/steps?limit=10`)).json()) as TurnStep[];
    const s = steps.find((x) => x.turnId === TURN);
    assert.ok(s, "the ring turn is listed");
    assert.deepEqual(s.ops, { messages: 1, artifacts: 4, tasks: 0, decisions: 0 });
    assert.deepEqual(s.artifactIds, ["art-1", "art-2", "art-3", "art-4"]);
    assert.ok(s.seqStart > 0 && s.eventCount > 0, "seq and event count come from the log, not zeros");
    assert.equal(s.tokens, 1200, "the tracker's own figures still win");

    // And the answer does not move with the window.
    const wide = (await (await fetch(`${base}/steps?limit=200`)).json()) as TurnStep[];
    assert.deepEqual(wide.find((x) => x.turnId === TURN)?.ops, s.ops);
  });
});

test("/turns/:id returns its events in log order and the step they add up to", async () => {
  await withServer(async (base, _m, seeded) => {
    const r = await fetch(`${base}/turns/${TURN}`);
    assert.equal(r.status, 200);
    const body = (await r.json()) as { turn: TurnRecord | null; events: MeshEvent[]; timeline: unknown[]; step: TurnStep | null };
    assert.equal(body.turn?.turnId, TURN);

    const seqs = body.events.map((e) => e.seq ?? 0);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "events are in log order");
    assert.equal(body.events.length, 8, "seven indexed events plus the operator note");
    assert.equal(body.events[2]!.id, seeded.note, "the note sits where it happened, not after the close");
    assert.equal(body.timeline.length, body.events.length);

    assert.ok(body.step, "the response carries the step built from these events");
    assert.equal(body.step.turnId, TURN);
    assert.deepEqual(body.step.ops, { messages: 1, artifacts: 4, tasks: 0, decisions: 0 });
    assert.equal(body.step.status, "ok");
  });
});

test("/turns/:id answers step: null for a turn the log never recorded", async () => {
  await withServer(async (base, m) => {
    // Live only: the tracker knows it, the log does not.
    const turns = (m.supervisor as unknown as { turns: { push(r: TurnRecord): void } }).turns;
    turns.push({ turnId: "turn-unlogged", agentId: "architect", reason: { kind: "message" }, startedAt: new Date().toISOString(), status: "running" } as TurnRecord);
    const body = (await (await fetch(`${base}/turns/turn-unlogged`)).json()) as { turn: TurnRecord | null; events: unknown[]; step: TurnStep | null };
    assert.equal(body.turn?.turnId, "turn-unlogged");
    assert.deepEqual(body.events, []);
    assert.equal(body.step, null);
  });
});

test("mesh_steps reports the same counts a seat would otherwise read as zero", async () => {
  await withServer(async (_base, m) => {
    const goalId = m.kernel.state.activeGoalId!;
    const mcp = createMcpToolset(m.supervisor);
    const tok = mintSeatToken(m.config.meshId, "architect", goalId);
    const res = (await mcp.handle("architect", tok, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "mesh_steps", arguments: { limit: 10, turnId: TURN } },
    })) as { result: { isError: boolean; content: Array<{ text: string }> } };
    assert.equal(res.result.isError, false, res.result.content[0]?.text);
    const out = JSON.parse(res.result.content[0]!.text) as { count: number; steps: TurnStep[] };
    assert.equal(out.count, 1);
    assert.deepEqual(out.steps[0]!.ops, { messages: 1, artifacts: 4, tasks: 0, decisions: 0 });
  });
});
