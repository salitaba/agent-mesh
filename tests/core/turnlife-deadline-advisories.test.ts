import { test } from "node:test";
import assert from "node:assert/strict";
import { collectEvents, makeMesh, stub, waitFor, type AgentSpec } from "../helpers";
import { ManualClock, makeClockedMesh } from "../support/manual-clock";
import { FakeWorkspace, installWorkspace, untrackedState } from "../support/fake-workspace";
import { StubRuntime } from "../../packages/agent-runtime/src/index";
import { InterruptedTurnError, type AgentEvent, type AgentInput, type AgentSession, type MeshEvent, type MeshOp } from "../../packages/protocol/src/index";
import type { WorkspacePort } from "../../packages/core/src/ports";
import type { TurnRecord } from "../../packages/core/src/index";

/**
 * A long code-writing turn: warned before it is stopped, visible while it runs,
 * and not thrown away when it is stopped.
 *
 * Measured on a live run: seat backend claimed its task 2.5 minutes into a turn,
 * made ~94 native Write/Edit/Bash calls, wrote 37 files, never committed, was
 * still working 17 s before the end, and was killed by "turn timeout after
 * 1200000ms". It spent 249,918 tokens against a 240k seat budget with no live
 * figure anywhere, the dashboard showed nothing for 17 minutes, and its
 * successor was told to read the log for effects the log does not hold.
 */

const BASE = 1000;
const CAP = 3 * BASE;

const DEV: AgentSpec = { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "git.commit"], interests: [] };
const PM: AgentSpec = { id: "pm", role: "pm", capabilities: ["repository.read"], interests: [] };
const FAR = { stallIdleMs: 24 * 3_600_000, waitWakeupMs: 24 * 3_600_000 } as const;

type Mesh = Awaited<ReturnType<typeof makeMesh>>;
type StreamFn = (session: AgentSession, input: AgentInput) => AsyncIterable<AgentEvent>;

/** A stub whose stream a test can replace, and whose interrupts it can see and answer. */
class ScriptedStream extends StubRuntime {
  interrupts: string[] = [];
  custom?: StreamFn;
  onInterrupt?: () => void;
  constructor() {
    super({ scripts: new Map(), streaming: true });
  }
  override get stream(): StreamFn | undefined {
    const base = super.stream;
    if (!base) return undefined;
    return this.custom ?? base;
  }
  override async interrupt(session: AgentSession): Promise<void> {
    this.interrupts.push(session.agentId);
    this.onInterrupt?.();
    return super.interrupt(session);
  }
}

const payload = (e: MeshEvent | undefined) => (e?.payload ?? {}) as Record<string, unknown>;
const discards = async (m: { store: { read(): Promise<MeshEvent[]> } }, agentId = "dev"): Promise<MeshEvent[]> =>
  (await m.store.read()).filter((e) => e.type === "turn.discarded" && payload(e).agentId === agentId);
const firstTurn = (m: { supervisor: { getRecentTurns(n?: number): TurnRecord[] } }, agentId = "dev"): TurnRecord | undefined =>
  m.supervisor.getRecentTurns(200).filter((t) => t.agentId === agentId).at(-1);

async function tick(clock: ManualClock, ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 250) await clock.advanceAndSettle(Math.min(250, left));
}

// ---------------------------------------------------------------- deadline + advisories

test("a task turn is told when its budget is reached and before the hard stop; its deadline moves on the record", async () => {
  const clock = new ManualClock(Date.now());
  const m = await makeClockedMesh({ agents: [DEV], mayContact: { dev: [] }, turnTimeoutMs: BASE, ...FAR }, clock);
  try {
    let calls = 0;
    stub(m).setScript("dev", async () => {
      calls++;
      if (calls > 1) return { operations: [{ op: "wait" } as MeshOp] };
      // The claim lands inside the call, as it did live (2.5 min in).
      const created = await m.supervisor.executeToolOp("dev", { op: "create_task", title: "build the store", description: "write it", assignedTo: "dev" } as MeshOp);
      await m.supervisor.executeToolOp("dev", { op: "claim_task", taskId: String(created.taskId) } as MeshOp);
      return { delayMs: 600_000, interruptUsage: { input: 900, output: 100, total: 1000 } };
    });
    const t0 = clock.nowMs();
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the task claim", () => [...m.kernel.state.tasks.values()].some((t) => t.claimedBy === "dev"));

    const armed = firstTurn(m)!.phases!;
    assert.equal(armed.deadlineAt, t0 + BASE, "armed at the base budget: the claim came after the call began");
    assert.equal(armed.ceilingAt, t0 + CAP, "and the hard stop is on the record from the start");
    assert.deepEqual(stub(m).advisedFor("dev"), [], "nothing is said before the budget is reached");

    await clock.advanceAndSettle(BASE);
    assert.equal(firstTurn(m)!.phases!.deadlineAt, t0 + CAP, "extended for the task, and the record says so");
    const budget = stub(m).advisedFor("dev");
    assert.equal(budget.length, 1, "the budget advisory is sent once the turn runs past its budget");
    assert.match(budget[0]!, /^⏱ Turn budget reached \(1 s\)/);
    assert.match(budget[0]!, /hard stop in 2 s/);
    assert.match(budget[0]!, /`mesh_commit`/, "a seat that may commit is told to");
    assert.match(budget[0]!, /`mesh_done`/);

    // Final warning at ceiling - min(window, 5 min) = 3000 - 1000.
    await clock.advanceAndSettle(BASE - 1);
    assert.equal(stub(m).advisedFor("dev").length, 1, "not before its time");
    await clock.advanceAndSettle(1);
    const both = stub(m).advisedFor("dev");
    assert.equal(both.length, 2);
    assert.match(both[1]!, /^⚠ Hard stop in 1 s\. Commit what you have now/);

    await clock.advanceAndSettle(BASE);
    await waitFor("the discard at the hard stop", async () => (await discards(m)).length > 0, 5000);
    const rec = firstTurn(m)!;
    assert.equal(rec.status, "failed");
    assert.deepEqual(
      rec.advisories?.map((a) => [a.text, a.delivered, a.at - t0]),
      [
        [both[0], true, BASE],
        [both[1], true, CAP - BASE],
      ],
      "both are on the failed turn's record, delivered, with when",
    );

    await clock.advanceAndSettle(CAP);
    assert.equal(stub(m).advisedFor("dev").length, 2, "a turn that has ended is never advised");
  } finally {
    await m.cleanup();
  }
});

test("an advisory the runtime cannot deliver is still recorded, as undelivered", async () => {
  const clock = new ManualClock(Date.now());
  const m = await makeClockedMesh({ agents: [DEV], mayContact: { dev: [] }, turnTimeoutMs: BASE, ...FAR }, clock);
  try {
    // A runtime with no `advise` at all, like an HTTP agent.
    (stub(m) as { advise?: unknown }).advise = undefined;
    let calls = 0;
    stub(m).setScript("dev", async () => {
      calls++;
      if (calls > 1) return { operations: [{ op: "wait" } as MeshOp] };
      const created = await m.supervisor.executeToolOp("dev", { op: "create_task", title: "t", description: "d", assignedTo: "dev" } as MeshOp);
      await m.supervisor.executeToolOp("dev", { op: "claim_task", taskId: String(created.taskId) } as MeshOp);
      return { delayMs: 600_000, interruptUsage: { input: 9, output: 1, total: 10 } };
    });
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the task claim", () => [...m.kernel.state.tasks.values()].some((t) => t.claimedBy === "dev"));
    await clock.advanceAndSettle(BASE);
    const adv = firstTurn(m)!.advisories ?? [];
    assert.equal(adv.length, 1);
    assert.equal(adv[0]!.delivered, false, "recorded so the operator can see the seat was never warned");
    // Run it to the hard stop: the stub's delay is a REAL timer, so a turn left
    // in flight holds the test process open for its full 600 s after cleanup.
    await clock.advanceAndSettle(CAP);
    await waitFor("the discard at the hard stop", async () => (await discards(m)).length > 0, 5000);
  } finally {
    await m.cleanup();
  }
});

test("a turn that ends inside its budget is never advised", async () => {
  const clock = new ManualClock(Date.now());
  const m = await makeClockedMesh({ agents: [DEV], mayContact: { dev: [] }, turnTimeoutMs: BASE, ...FAR }, clock);
  try {
    stub(m).setScript("dev", async () => ({ operations: [{ op: "wait" } as MeshOp] }));
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the turn settles", () => firstTurn(m)?.status !== undefined && firstTurn(m)?.status !== "running");
    await clock.advanceAndSettle(CAP * 2);
    assert.deepEqual(stub(m).advisedFor("dev"), [], "the advisory timers died with the call");
    assert.equal(firstTurn(m)!.advisories, undefined);
  } finally {
    await m.cleanup();
  }
});

// ---------------------------------------------------------------- live usage

test("usage_update frames reach the record as liveTokens and stop an over-budget turn on the last rung", async () => {
  const clock = new ManualClock(Date.now());
  const rt = new ScriptedStream();
  const m = await makeClockedMesh(
    { agents: [{ ...DEV, tokens: 100_000 }], mayContact: { dev: [] }, autoRaise: { enabled: false }, turnTimeoutMs: 600_000, ...FAR },
    clock,
    { runtimeOverrides: { stub: rt } },
  );
  try {
    const key = `agent:${m.kernel.state.activeGoalId}/dev`;
    await m.supervisor.deps.budget.consume(key, "tokens", 50_000);
    const SPENT = { input: 50_000, output: 10_000, total: 60_000 };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    rt.custom = async function* () {
      yield { kind: "usage_update", tokensUsed: { input: 15_000, output: 5_000, total: 20_000 } };
      await gate;
      // Armed BEFORE the frame: the interrupt is ordered while the frame is
      // being consumed, before this generator resumes.
      const aborted = new Promise<never>((_, reject) => {
        rt.onInterrupt = () => reject(new InterruptedTurnError("aborted by the mesh", SPENT));
      });
      aborted.catch(() => undefined);
      yield { kind: "usage_update", tokensUsed: SPENT };
      await aborted;
    };
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the first live figure", () => firstTurn(m)?.liveTokens === 20_000);
    assert.deepEqual(rt.interrupts, [], "20k of 50k left is a turn that can still pay for itself");

    release();
    await waitFor("the discard", async () => (await discards(m)).length > 0, 5000);
    assert.deepEqual(rt.interrupts, ["dev"], "stopped on arrival of the figure, not at settle and not on a watchdog tick");
    const d = payload((await discards(m))[0]);
    assert.match(String(d.detail), /turn budget exceeded: 60000 live against 50000 left/, "the discard says what stopped it");
    assert.equal(d.reason, "budget", "and is classified as what it was — a budget stop, not a stream that went quiet");
    assert.equal(d.tokens, 60_000, "and bills what the abort reported");
    const rec = firstTurn(m)!;
    assert.equal(rec.status, "failed");
    assert.equal(rec.liveTokens, 60_000, "the live figure survives the failure");
    assert.match(rec.summary ?? "", /live spend passed what your budget had left/, "the seat is told why, not that it went silent");
    // The label changed, nothing about what happens to the seat did: the abort
    // is still the runtime's (a slow one, not a crash), so the failure ladder is
    // the one it always walked.
    const events = await collectEvents(m);
    const failed = events.filter((e) => e.type === "agent.failed");
    assert.equal(failed.length, 1, "still recorded as a failure");
    const restarted = events.filter((e) => e.type === "agent.restarted");
    assert.equal(restarted.length, 1, "and still walks the slow-turn restart path, unchanged");
    assert.equal(payload(restarted[0]).attempt, 1, "first restart, the same rung as before");
  } finally {
    await m.cleanup();
  }
});

// ---------------------------------------------------------------- checkpoint on abnormal stop

const CHECKPOINT_AGENTS: AgentSpec[] = [{ ...DEV, tokens: 500_000 }, PM];

function checkpointingWorkspace(answer: (agentId: string, ref: string, message: string) => Promise<{ commit: string; files: string[] } | null>) {
  const ws = new FakeWorkspace({ behaviour: { worktreeState: { dev: untrackedState("dev", ["src/store.ts", "src/index.ts", ".mesh/agents/dev/ROLE.md"]) } } });
  const calls: Array<{ agentId: string; ref: string; message: string }> = [];
  (ws as WorkspacePort).checkpointWorktree = async (agentId, ref, message) => {
    calls.push({ agentId, ref, message });
    return answer(agentId, ref, message);
  };
  return { ws, calls };
}

async function timeoutThenCapture(m: Mesh): Promise<string[]> {
  stub(m).setScript("pm", async () => ({ operations: [{ op: "wait" } as MeshOp] }));
  const seen: string[] = [];
  stub(m).setScript("dev", async (input, idx) => {
    if (idx === 0) return { delayMs: 60_000, interruptUsage: { input: 900, output: 100, total: 1000 } };
    seen.push(input.instructions);
    return { operations: [{ op: "wait" } as MeshOp] };
  });
  await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
  await waitFor("the successor turn", () => seen.length > 0, 15_000);
  return seen;
}

test("a turn stopped with uncommitted files is snapshotted, and its successor is told where", async () => {
  const m = await makeMesh({ agents: CHECKPOINT_AGENTS, mayContact: { dev: ["pm"], pm: ["dev"] }, autoRaise: { enabled: false }, turnTimeoutMs: 250 });
  const { ws, calls } = checkpointingWorkspace(async () => ({ commit: "c0ffee1234567890c0ffee1234567890c0ffee12", files: ["src/store.ts", "src/index.ts"] }));
  installWorkspace(m, ws);
  try {
    const seen = await timeoutThenCapture(m);
    const failed = firstTurn(m)!;
    assert.equal(failed.status, "failed");
    assert.equal(calls.length, 1, "one snapshot for one stopped turn");
    assert.equal(calls[0]!.ref, `refs/mesh/checkpoints/dev/${failed.turnId}`);
    assert.match(calls[0]!.message, new RegExp(failed.turnId));
    assert.match(calls[0]!.message, /timeout/);
    assert.deepEqual(failed.checkpoint, { ref: calls[0]!.ref, commit: "c0ffee1234567890c0ffee1234567890c0ffee12", files: ["src/store.ts", "src/index.ts"] });

    const note = seen[0]!.slice(seen[0]!.indexOf("your previous turn did not finish"));
    assert.ok(note.includes(calls[0]!.ref), "the successor is told where its work is kept");
    assert.match(note, /src\/store\.ts/, "and which files are still in its worktree");
    assert.match(note, /build on them rather than writing them again/);
  } finally {
    await m.cleanup();
  }
});

test("a snapshot that fails costs the snapshot, never the turn's failure handling", async () => {
  const m = await makeMesh({ agents: CHECKPOINT_AGENTS, mayContact: { dev: ["pm"], pm: ["dev"] }, autoRaise: { enabled: false }, turnTimeoutMs: 250 });
  const { ws, calls } = checkpointingWorkspace(async () => {
    throw new Error("fatal: unable to write new index file");
  });
  installWorkspace(m, ws);
  try {
    const seen = await timeoutThenCapture(m);
    assert.equal(calls.length, 1);
    const failed = firstTurn(m)!;
    assert.equal(failed.checkpoint, undefined);
    assert.equal(payload((await discards(m))[0]).reason, "timeout", "the stop is recorded exactly as before");
    const note = seen[0]!.slice(seen[0]!.indexOf("your previous turn did not finish"));
    assert.match(note, /src\/store\.ts/, "the files are still named");
    assert.doesNotMatch(note, /refs\/mesh\/checkpoints/, "and no snapshot is claimed");
  } finally {
    await m.cleanup();
  }
});

// ---------------------------------------------------------------- per-turn guidance

test("a seat that edits files is told its turn budget and to work in committed increments; a coordination seat is not", async () => {
  const m = await makeMesh({ agents: [DEV, PM], mayContact: { dev: ["pm"], pm: ["dev"] }, turnTimeoutMs: 1_200_000 });
  try {
    const prompts = new Map<string, string>();
    for (const id of ["dev", "pm"]) {
      stub(m).setScript(id, async (input) => {
        if (!prompts.has(id)) prompts.set(id, input.instructions);
        return { operations: [{ op: "wait" } as MeshOp] };
      });
    }
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await m.supervisor.activateAgent("pm", { kind: "manual" }, { explicit: true });
    await waitFor("both prompts", () => prompts.size === 2);

    const dev = prompts.get("dev")!;
    assert.match(dev, /## Turn budget\nYou have 20 min per turn, extended only while you keep working, to a hard stop at 60 min\./);
    assert.match(dev, /Build in increments: after each coherent chunk \(a module and its tests\) commit it \(`mesh_commit`\) and publish/);
    assert.match(dev, /When a ⏱ note arrives, commit and close with `mesh_done`\./);
    assert.ok(dev.indexOf("## Turn budget") < dev.indexOf("## Why you were woken"), "ahead of the wake reason, outside the tiered bundle");
    const section = dev.slice(dev.indexOf("## Turn budget"), dev.indexOf("## Why you were woken"));
    assert.ok(section.length < 480, `short: ${section.length} chars`);

    assert.doesNotMatch(prompts.get("pm")!, /## Turn budget/, "a seat with nothing to write has nothing to commit");
  } finally {
    await m.cleanup();
  }
});

// ---------------------------------------------------------------- silence, tool-only

const SILENCE_MS = 1000;
const SILENCE_TIMING = { turnSilenceMs: SILENCE_MS, stallIdleMs: 3000, turnTimeoutMs: 600_000 };

test("silence: a turn that only ever used tools and then froze is interrupted, and keeps what it wrote", async () => {
  const clock = new ManualClock();
  const rt = new ScriptedStream();
  const m = await makeClockedMesh({ agents: [DEV], mayContact: { dev: [] }, ...SILENCE_TIMING }, clock, { runtimeOverrides: { stub: rt } });
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  try {
    rt.custom = async function* () {
      // No prose at all: the shape of a seat that designs by building.
      yield { kind: "tool_call", toolCallId: "tc-1", name: "Write", args: { file_path: "src/store.ts", content: "export {}" } };
      yield { kind: "tool_call_update", toolCallId: "tc-1", status: "completed" };
      await held;
    };
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("both tool frames", () => (firstTurn(m)?.toolFrames ?? 0) >= 2);
    assert.equal(firstTurn(m)!.phases?.firstTokenAt, undefined, "fixture: the turn never streamed a token");

    await tick(clock, 3 * SILENCE_MS);
    assert.deepEqual(rt.interrupts, ["dev"], "nothing running and nothing said: the quiet is a stall");
    await tick(clock, 2000);
    await waitFor("the discard", async () => (await discards(m)).length > 0, 5000);
    assert.equal(payload((await discards(m))[0]).reason, "silence");

    const rec = firstTurn(m)!;
    assert.equal(rec.status, "failed");
    assert.equal(rec.toolCallCount, 1);
    assert.deepEqual(rec.filesTouched, ["src/store.ts"], "what it wrote is on the failed record");
    assert.deepEqual(rec.liveTools?.map((t) => [t.name, t.target, t.status]), [["Write", "src/store.ts", "completed"]]);
    // No worktree listing in an in-memory mesh: the note falls back to what the turn wrote.
    assert.match(rec.summary ?? "", /wrote or edited 1 file\(s\): src\/store\.ts/);
  } finally {
    release();
    await m.cleanup();
  }
});

test("silence: control — a tool-only turn waiting on an open call is left alone", async () => {
  const clock = new ManualClock();
  const rt = new ScriptedStream();
  const m = await makeClockedMesh({ agents: [DEV], mayContact: { dev: [] }, ...SILENCE_TIMING }, clock, { runtimeOverrides: { stub: rt } });
  let finish!: () => void;
  const toolDone = new Promise<void>((r) => (finish = r));
  try {
    rt.custom = async function* () {
      yield { kind: "tool_call", toolCallId: "tc-1", name: "Bash", args: { command: "npm test" } };
      await toolDone;
      yield { kind: "tool_call_update", toolCallId: "tc-1", status: "completed" };
      yield { kind: "turn_end", stopReason: "end_turn", text: "", operations: [{ op: "wait" }], tokensUsed: { input: 10, output: 5, total: 15 } };
    };
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the open call", () => (firstTurn(m)?.toolFrames ?? 0) >= 1);
    await tick(clock, 10 * SILENCE_MS);
    assert.deepEqual(rt.interrupts, [], "a running tool is work, however long it runs");
    assert.equal(firstTurn(m)!.liveTools?.[0]?.status, "running", "and the dashboard can say which one");
    finish();
    await waitFor("the turn closes", () => firstTurn(m)?.status !== "running");
    assert.equal(firstTurn(m)!.status, "waiting");
  } finally {
    finish();
    await m.cleanup();
  }
});
