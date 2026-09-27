import { test } from "node:test";
import assert from "node:assert/strict";
import { stub, waitFor, type AgentSpec } from "../helpers";
import { ManualClock, makeClockedMesh } from "../support/manual-clock";
import type { AgentInput, MeshEvent, MeshOp } from "../../packages/protocol/src/index";
import type { MeshInstance } from "../../apps/mesh-server/src/index";

/**
 * The turn deadline is decided when it EXPIRES, not when the turn starts.
 *
 * Measured 2026-09-25 (NOTES live-run §3): backend's turn claimed its task 80 s
 * in, so the work-turn multiple — chosen once, before the runtime call — never
 * applied, and the turn was killed at 1x while it was writing files: 242 tool
 * frames, the last one 5 s before the kill, 21 files left untracked.
 *
 * On a manual clock so each boundary is one line: base 1000 ms, so the work
 * budget and the hard cap are both 3000 ms.
 */

const BASE = 1000;
const CAP = 3 * BASE;

const dev: AgentSpec = { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write"], interests: [] };

type Mesh = MeshInstance & { cleanup(): Promise<void> };

/** Timers far out of the way: the stall watch and the wait sweep are other tests' subjects. */
async function clockedMesh(clock: ManualClock): Promise<Mesh> {
  return makeClockedMesh(
    { agents: [dev], mayContact: { dev: [] }, turnTimeoutMs: BASE, stallIdleMs: 24 * 3_600_000, waitWakeupMs: 24 * 3_600_000 },
    clock,
  );
}

/** Record when the mesh told the runtime to stop, and still deliver the interrupt. */
function spyInterrupts(m: Mesh, clock: ManualClock): number[] {
  const at: number[] = [];
  const s = stub(m);
  const original = s.interrupt.bind(s);
  s.interrupt = async (session) => {
    at.push(clock.nowMs());
    return original(session);
  };
  return at;
}

const discards = async (m: Mesh): Promise<MeshEvent[]> =>
  (await m.store.read()).filter((e) => e.type === "turn.discarded" && (e.payload as { agentId?: string }).agentId === "dev");

/** A tool frame pair, the only sign of life a file-writing turn gives. */
function frame(input: AgentInput, id: string): void {
  input.onToolEvent?.({ kind: "tool_call", toolCallId: id, name: "Write", args: { file_path: `${id}.ts` } });
  input.onToolEvent?.({ kind: "tool_call_update", toolCallId: id, status: "completed" });
}

test("a turn that claims its task mid-turn gets the work-turn budget, not 1x", async () => {
  const clock = new ManualClock(Date.now());
  const m = await clockedMesh(clock);
  try {
    const interrupts = spyInterrupts(m, clock);
    let calls = 0;
    stub(m).setScript("dev", async () => {
      calls++;
      if (calls > 1) return { operations: [{ op: "wait" } as MeshOp] };
      // The claim lands INSIDE the runtime call — after the deadline was armed,
      // which is the whole bug.
      const created = await m.supervisor.executeToolOp("dev", { op: "create_task", title: "build the store", description: "write it", assignedTo: "dev" } as MeshOp);
      assert.equal(created.ok, true, `fixture: the task was created: ${JSON.stringify(created)}`);
      const claimed = await m.supervisor.executeToolOp("dev", { op: "claim_task", taskId: String(created.taskId) } as MeshOp);
      assert.equal(claimed.ok, true, `fixture: the task was claimed: ${JSON.stringify(claimed)}`);
      // Long real delay, answered by the interrupt with usage — so the stop
      // settles as soon as the mesh orders it, with no grace wait.
      return { delayMs: 600_000, interruptUsage: { input: 900, output: 100, total: 1000 } };
    });
    const t0 = clock.nowMs();
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the task claim", () => [...m.kernel.state.tasks.values()].some((t) => t.claimedBy === "dev"));

    await clock.advanceAndSettle(BASE + 500);
    assert.deepEqual(interrupts, [], "the seat claimed a task, so 1x is not its deadline");
    assert.equal((await discards(m)).length, 0);

    await clock.advanceAndSettle(CAP - BASE - 500);
    await waitFor("the discard at the work budget", async () => (await discards(m)).length > 0, 5000);
    assert.deepEqual(interrupts.map((t) => t - t0), [CAP], "stopped at the work-turn budget, once");
    const d = (await discards(m))[0]!.payload as { reason?: string; detail?: string };
    assert.equal(d.reason, "timeout");
    assert.match(String(d.detail), new RegExp(`turn timeout after ${CAP}ms`), "the message names the deadline that actually expired");
  } finally {
    await m.cleanup();
  }
});

test("a turn still producing tool frames is extended, and finishes", async () => {
  const clock = new ManualClock(Date.now());
  const m = await clockedMesh(clock);
  try {
    const interrupts = spyInterrupts(m, clock);
    let input!: AgentInput;
    let answer!: (v: { operations: MeshOp[] }) => void;
    let calls = 0;
    stub(m).setScript("dev", async (i) => {
      calls++;
      if (calls > 1) return { operations: [{ op: "wait" } as MeshOp] };
      input = i;
      return new Promise((r) => {
        answer = r;
      });
    });
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the turn is in the runtime", () => calls === 1 && input !== undefined);

    // Writing files: a frame shortly before each expiry.
    await clock.advanceAndSettle(900);
    frame(input, "w1");
    await clock.advanceAndSettle(900);
    frame(input, "w2");
    await clock.advanceAndSettle(700);
    assert.deepEqual(interrupts, [], "a turn that wrote 100 ms before its deadline is working, not wedged");

    answer({ operations: [{ op: "done", summary: "wrote the store" } as MeshOp] });
    await waitFor("the turn settles", () => m.supervisor.getRecentTurns().some((t) => t.agentId === "dev" && t.status !== "running"), 5000);
    const turn = m.supervisor.getRecentTurns().find((t) => t.agentId === "dev" && t.status !== "running")!;
    assert.notEqual(turn.status, "failed", `the extended turn finished normally: ${turn.error ?? ""}`);
    assert.equal((await discards(m)).length, 0, "and nothing was thrown away");
  } finally {
    await m.cleanup();
  }
});

test("a turn that never stops producing frames still dies at the hard cap", async () => {
  const clock = new ManualClock(Date.now());
  const m = await clockedMesh(clock);
  try {
    const interrupts = spyInterrupts(m, clock);
    let input!: AgentInput;
    let calls = 0;
    stub(m).setScript("dev", async (i) => {
      calls++;
      if (calls > 1) return { operations: [{ op: "wait" } as MeshOp] };
      input = i;
      // Never answers and ignores the interrupt: the grace-window path.
      return new Promise(() => undefined);
    });
    const t0 = clock.nowMs();
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the turn is in the runtime", () => calls === 1 && input !== undefined);

    // Chatty but going nowhere: a frame every 400 ms, well past the cap.
    for (let i = 0; i < 12; i++) {
      await clock.advanceAndSettle(400);
      frame(input, `loop${i}`);
    }
    assert.deepEqual(interrupts.map((t) => t - t0), [CAP], "extensions are bounded: interrupted at the cap, and only there");
    // The interrupt was ignored; the 2 s usage grace ends the call.
    await clock.advanceAndSettle(2000);
    await waitFor("the discard", async () => (await discards(m)).length > 0, 5000);
    const d = (await discards(m))[0]!.payload as { reason?: string };
    assert.equal(d.reason, "timeout");
  } finally {
    await m.cleanup();
  }
});

test("control: a silent turn with no task is still stopped at 1x", async () => {
  const clock = new ManualClock(Date.now());
  const m = await clockedMesh(clock);
  try {
    const interrupts = spyInterrupts(m, clock);
    let calls = 0;
    stub(m).setScript("dev", async () => {
      calls++;
      if (calls > 1) return { operations: [{ op: "wait" } as MeshOp] };
      return { delayMs: 600_000, interruptUsage: { input: 9, output: 1, total: 10 } };
    });
    const t0 = clock.nowMs();
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the turn is in the runtime", () => calls === 1);
    await clock.advanceAndSettle(BASE + 10);
    await waitFor("the discard", async () => (await discards(m)).length > 0, 5000);
    assert.deepEqual(interrupts.map((t) => t - t0), [BASE], "no task and no sign of life: the base deadline stands");
  } finally {
    await m.cleanup();
  }
});
