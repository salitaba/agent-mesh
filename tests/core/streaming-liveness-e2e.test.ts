import { test } from "node:test";
import assert from "node:assert/strict";
import { stub, waitFor, type AgentSpec } from "../helpers";
import { ManualClock, makeClockedMesh, settle } from "../support/manual-clock";
import { StubRuntime } from "../../packages/agent-runtime/src/index";
import type { AgentEvent, AgentInput, AgentSession, MeshEvent, MeshOp } from "../../packages/protocol/src/index";
import type { TurnRecord } from "../../packages/core/src/index";

/**
 * Streaming liveness, through the supervisor, on a clock the test owns.
 *
 * The silence watchdog judges a turn by what `onToken` and `onToolEvent`
 * stamped on it, and the forced settle is a timer. Both used to be reachable
 * only with real sleeps and a stub whose `interrupt()` did nothing, so the
 * questions below were answered by reading the code, never by running it:
 *
 *   - are the stamps on the MESH's clock, so "silent for N ms" means N ms?
 *   - is a silent turn interrupted once, and not once per watchdog tick?
 *   - is a turn blocked on a running tool left alone?
 *   - does a stream that dies mid-turn count as a failure, or as a turn that
 *     merely produced fewer ops?
 *   - after a forced settle, is the seat usable again, and is the loss on the
 *     record the way every other lost turn is?
 *
 * Timing: silence floor 1000ms; the stall watch ticks every stallIdleMs/3 =
 * 1000ms; the turn timeout is pushed out of the way. Ticks are clock timers,
 * so nothing here sleeps.
 */

const SILENCE_MS = 1000;
const TIMING = { turnSilenceMs: SILENCE_MS, stallIdleMs: 3000, turnTimeoutMs: 600_000 };
const USAGE = { input: 4_000, output: 1_000, total: 5_000 };

const AGENTS: AgentSpec[] = [{ id: "dev", role: "developer", capabilities: ["repository.read", "architecture.write"], interests: [] }];

type StreamFn = (session: AgentSession, input: AgentInput) => AsyncIterable<AgentEvent>;

/**
 * The shared stub, with two observation points the base class does not offer:
 * every `interrupt()` is counted, and a test can run code between stream
 * frames (to move the clock) or replace the stream outright (to hold a tool
 * call open, which the base stub never does — it closes each call at once).
 */
class ObservedStub extends StubRuntime {
  interrupts: string[] = [];
  /** Runs after the consumer has taken each token frame. */
  afterChunk?: () => void;
  /** Replaces the scripted stream entirely while set. */
  custom?: StreamFn;

  constructor() {
    super({ scripts: new Map(), streaming: true });
  }

  override get stream(): StreamFn | undefined {
    const base = super.stream;
    if (!base) return undefined;
    if (this.custom) return this.custom;
    const after = (): void => this.afterChunk?.();
    return async function* (session, input) {
      for await (const ev of base(session, input)) {
        yield ev;
        if (ev.kind === "agent_message_chunk") after();
      }
    };
  }

  override async interrupt(session: AgentSession): Promise<void> {
    this.interrupts.push(session.agentId);
    return super.interrupt(session);
  }
}

async function boot(clock: ManualClock) {
  const rt = new ObservedStub();
  const m = await makeClockedMesh({ agents: AGENTS, mayContact: { dev: [] }, ...TIMING }, clock, { runtimeOverrides: { stub: rt } });
  assert.equal(m.config.scheduling.turnSilenceMs, SILENCE_MS, "fixture: the silence floor was applied");
  assert.equal(stub(m), rt, "fixture: the observed stub is the one seats run on");
  return {
    m,
    rt,
    async cleanup() {
      // A hung turn is still parked in the stub; let it go before close drains.
      rt.releaseHangs();
      await m.cleanup();
    },
  };
}

type Mesh = Awaited<ReturnType<typeof boot>>["m"];
const payload = (e: MeshEvent | undefined) => (e?.payload ?? {}) as Record<string, unknown>;
const ofType = async (m: Mesh, type: string) => (await m.store.read()).filter((e) => e.type === type && payload(e).agentId === "dev");
const devTurns = (m: Mesh): TurnRecord[] => m.supervisor.getRecentTurns(200).filter((t) => t.agentId === "dev");
const firstTurn = (m: Mesh): TurnRecord | undefined => devTurns(m).at(-1);

/** Drive the clock in watchdog-sized steps, letting each tick's async tail land. */
async function tick(clock: ManualClock, ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 250) await clock.advanceAndSettle(Math.min(250, left));
}

test("streaming: token frames stamp firstTokenAt/lastTokenAt on the mesh clock", async () => {
  const clock = new ManualClock();
  const { m, rt, cleanup } = await boot(clock);
  try {
    const t0 = clock.nowMs();
    // 500ms of mesh time between frames: well inside the silence floor, and
    // far enough apart that the two stamps cannot coincide by accident.
    rt.afterChunk = () => clock.advance(500);
    rt.setScript("dev", [{ tokens: ["reading ", "the ", "spec"], text: "reading the spec", operations: [{ op: "wait" } as MeshOp], tokensUsed: USAGE }]);
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the turn to close", () => firstTurn(m)?.status !== undefined && firstTurn(m)?.status !== "running");

    const ph = firstTurn(m)!.phases!;
    assert.equal(ph.firstTokenAt, t0, "the first frame is stamped at the mesh's now, not the wall clock's");
    assert.equal(ph.lastTokenAt, t0 + 1000, "and the last one 2 x 500ms later");
    assert.equal(firstTurn(m)!.streamFrames, 3, "every frame reached onToken");
    assert.deepEqual(rt.interrupts, [], "a turn that kept talking is never interrupted");
  } finally {
    await cleanup();
  }
});

test("streaming: a seat that streams then goes silent is interrupted once, discarded as silence, and runs again", async () => {
  const clock = new ManualClock();
  const { m, rt, cleanup } = await boot(clock);
  try {
    rt.setScript("dev", [
      // One frame, then silence until interrupted; the interrupt is honoured
      // and answered with the backend's usage, as the real CLI does.
      { tokens: ["thinking ", "about ", "it"], silentAfterTokens: 1, interruptUsage: USAGE },
      { operations: [{ op: "wait" } as MeshOp], tokensUsed: USAGE },
    ]);
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the first token", () => firstTurn(m)?.phases?.firstTokenAt !== undefined);
    const silent = firstTurn(m)!;

    // Tick at +1000 is AT the floor (not past it): no interrupt yet.
    await tick(clock, 1000);
    assert.deepEqual(rt.interrupts, [], "silence equal to the floor is not a stall");
    // Tick at +2000 is past it.
    await tick(clock, 1000);
    await waitFor("the silence discard", async () => (await ofType(m, "turn.discarded")).length === 1);
    assert.deepEqual(rt.interrupts, ["dev"], "interrupted on the first tick past the floor");

    const [d] = (await ofType(m, "turn.discarded")).map(payload);
    assert.equal(d!.turnId, silent.turnId);
    assert.equal(d!.reason, "silence", "a turn the mesh stopped is not a turn that broke");
    assert.equal(d!.tokens, USAGE.total, "the interrupt's measured usage is what the discard states");
    const billed = (await m.store.read()).filter((e) => e.type === "budget.consumed" && payload(e).turnId === silent.turnId && String(payload(e).key).startsWith("agent:"));
    assert.deepEqual(billed.map((e) => payload(e).amount), [USAGE.total], "and it is billed once on the agent ledger");

    // Slow-turn retry: 1000ms backoff, on the mesh clock.
    await tick(clock, 3000);
    await waitFor("the retry turn", () => devTurns(m).some((t) => t.turnId !== silent.turnId && t.status !== "running"));
    const retry = devTurns(m).find((t) => t.turnId !== silent.turnId)!;
    assert.equal(retry.status, "waiting", "the seat answered its next activation normally");
    assert.equal(retry.reason.kind, "recovery");
    await tick(clock, 5000);
    assert.deepEqual(rt.interrupts, ["dev"], "one silent turn, one interrupt — the retry is not touched");
  } finally {
    await cleanup();
  }
});

test("streaming: a seat blocked on an open tool call is not silent, however long the tool runs", async () => {
  const clock = new ManualClock();
  const { m, rt, cleanup } = await boot(clock);
  let finishTool!: () => void;
  const toolDone = new Promise<void>((r) => (finishTool = r));
  try {
    rt.custom = async function* () {
      yield { kind: "agent_message_chunk", delta: "running the test suite" };
      // Announced, and NOT closed: the tool is running.
      yield { kind: "tool_call", toolCallId: "tc-1", name: "Bash", args: { command: "npm test" } };
      await toolDone;
      yield { kind: "tool_call_update", toolCallId: "tc-1", status: "completed", resultDigest: "ok" };
      yield { kind: "turn_end", stopReason: "end_turn", text: "tests pass", operations: [{ op: "wait" }], tokensUsed: USAGE };
    };
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the tool call to be open", () => (firstTurn(m)?.toolFrames ?? 0) >= 1);

    // Ten silence floors of quiet while the tool runs.
    await tick(clock, 10 * SILENCE_MS);
    assert.deepEqual(rt.interrupts, [], "waiting on a tool is working, not frozen");
    assert.equal(firstTurn(m)!.status, "running", "and the turn was not force-settled either");

    finishTool();
    await waitFor("the turn to close", () => firstTurn(m)?.status !== "running");
    assert.equal(firstTurn(m)!.status, "waiting", "the turn finished on its own terms");
    assert.deepEqual(await ofType(m, "turn.discarded"), []);
  } finally {
    finishTool();
    await cleanup();
  }
});

test("streaming: control — the same quiet after the tool call CLOSED is silence", async () => {
  // The pair to the row above: identical frames except the call is closed
  // before the quiet starts. If this one is not interrupted either, the row
  // above proves nothing about open tool calls.
  const clock = new ManualClock();
  const { m, rt, cleanup } = await boot(clock);
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  try {
    rt.custom = async function* () {
      yield { kind: "agent_message_chunk", delta: "running the test suite" };
      yield { kind: "tool_call", toolCallId: "tc-1", name: "Bash", args: { command: "npm test" } };
      yield { kind: "tool_call_update", toolCallId: "tc-1", status: "completed", resultDigest: "ok" };
      await held;
    };
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("both tool frames", () => (firstTurn(m)?.toolFrames ?? 0) >= 2);
    await tick(clock, 3 * SILENCE_MS);
    assert.deepEqual(rt.interrupts, ["dev"], "nothing is running, so the quiet is a stall");
  } finally {
    release();
    await cleanup();
  }
});

test("streaming: a stream that ends with no turn_end is a failed turn, and none of its ops land", async () => {
  const clock = new ManualClock();
  const { m, rt, cleanup } = await boot(clock);
  try {
    // The whole reply streams and the transport dies before `turn_end`. The
    // turn's ops ride on that frame, so a publish the stub was going to report
    // must not run.
    const text = "Publishing the spec, then I am done here.";
    const third = Math.ceil(text.length / 3);
    rt.setScript("dev", [
      {
        text,
        operations: [{ op: "publish_artifact", name: "Spec", type: "ArchitectureDocument", content: "# Spec" } as MeshOp, { op: "done" } as MeshOp],
        tokens: [text.slice(0, third), text.slice(third, 2 * third), text.slice(2 * third)],
        dieAfterFrames: 3,
        tokensUsed: USAGE,
      },
      { operations: [{ op: "wait" } as MeshOp], tokensUsed: USAGE },
    ]);
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the failed turn", () => firstTurn(m)?.status === "failed");
    await waitFor("the discard", async () => (await ofType(m, "turn.discarded")).length === 1);
    const cut = firstTurn(m)!;

    assert.equal(cut.phases?.firstTokenAt !== undefined, true, "fixture: the tokens did stream");
    assert.equal([...m.kernel.state.artifacts.values()].some((a) => a.name === "Spec"), false, "no op from a turn that never ended is applied");
    assert.deepEqual(cut.opTimings ?? [], [], "and none was attempted");
    const [d] = (await ofType(m, "turn.discarded")).map(payload);
    assert.equal(d!.reason, "failed", "a transport failure — not no_ops (the model did answer) and not silence (nobody interrupted)");
    assert.match(String(d!.detail), /ended without a turn_end frame/);
    assert.ok(!("tokens" in d!), "no turn_end means no usage report: unmeasured, not free");
    const failed = await ofType(m, "agent.failed");
    assert.equal(failed.length, 1);
    assert.match(String(payload(failed[0]).error), /ended without a turn_end frame/);

    // Generic failure: the restart ladder, 20ms later on the mesh clock.
    await tick(clock, 500);
    await waitFor("the restarted turn", () => devTurns(m).some((t) => t.turnId !== cut.turnId && t.status !== "running"));
    assert.equal(devTurns(m).find((t) => t.turnId !== cut.turnId)!.status, "waiting", "the seat recovers on its next activation");
  } finally {
    await cleanup();
  }
});

/**
 * Hung and silent: one frame, then nothing, and `interrupt()` is ignored — a
 * backend that stopped reading its socket. Only the watchdog's forced settle
 * (2000ms after the interrupt) ends it.
 */
async function hungAndSilent() {
  const clock = new ManualClock();
  const booted = await boot(clock);
  const { m, rt } = booted;
  rt.setScript("dev", [
    { tokens: ["thinking ", "hard"], silentAfterTokens: 1, hang: true, tokensUsed: USAGE },
    { operations: [{ op: "wait" } as MeshOp], tokensUsed: USAGE },
  ]);
  await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
  await waitFor("the first token", () => firstTurn(m)?.phases?.firstTokenAt !== undefined);
  const hung = firstTurn(m)!;
  // +2000: interrupt (ignored). +4000: forced settle. Three more ticks in
  // between and after, each of which would re-interrupt without the guard.
  await tick(clock, 4500);
  await settle(20);
  return { ...booted, clock, hung };
}

test("streaming: a hung, silent seat is interrupted exactly once and force-settled as a failure", async () => {
  const { m, rt, hung, cleanup } = await hungAndSilent();
  try {
    assert.deepEqual(rt.interrupts, ["dev"], "ignored interrupt, several ticks: still exactly one interrupt");
    const turn = devTurns(m).find((t) => t.turnId === hung.turnId)!;
    assert.equal(turn.status, "failed");
    assert.match(String(turn.error), new RegExp(`turn silence exceeded ${SILENCE_MS}ms`));
    const failed = await ofType(m, "agent.failed");
    assert.equal(failed.length, 1, "one forced settle, one failure");
    assert.match(String(payload(failed[0]).error), /turn silence exceeded/);
  } finally {
    await cleanup();
  }
});

test(
  "streaming: a force-settled turn is on the record as a discarded turn",
  async () => {
    const { m, hung, cleanup } = await hungAndSilent();
    try {
      const discards = (await ofType(m, "turn.discarded")).map(payload).filter((d) => d.turnId === hung.turnId);
      assert.equal(discards.length, 1, "every way a turn's work fails to reach the mesh writes one turn.discarded");
      assert.equal(discards[0]!.reason, "silence");
      assert.ok(!("tokens" in discards[0]!), "the backend never answered, so the cost is unmeasured — absent, not zero");
    } finally {
      await cleanup();
    }
  },
);

test(
  "streaming: a late answer to a force-settled turn does not run its ops",
  async () => {
    const clock = new ManualClock();
    const { m, rt, cleanup } = await boot(clock);
    try {
      // Silent after one frame, deaf to interrupt, and then — 1.5s of REAL
      // time later, long after the mesh clock has force-settled it — it
      // answers. A custom stream, because the stub's `silentAfterTokens` +
      // `hang` never answers and `hangMs` is ignored alongside `hang`.
      rt.custom = async function* () {
        yield { kind: "agent_message_chunk", delta: "Publishing." };
        await new Promise((r) => setTimeout(r, 1500));
        yield {
          kind: "turn_end",
          stopReason: "end_turn",
          text: "Publishing.",
          operations: [{ op: "publish_artifact", name: "Late", type: "ArchitectureDocument", content: "# Late" }, { op: "done" }],
          tokensUsed: USAGE,
        };
      };
      await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
      await waitFor("the first token", () => firstTurn(m)?.phases?.firstTokenAt !== undefined);
      const hung = firstTurn(m)!;
      await tick(clock, 4500);
      assert.equal(devTurns(m).find((t) => t.turnId === hung.turnId)!.status, "failed", "fixture: force-settled before the answer");

      await new Promise((r) => setTimeout(r, 1800));
      await settle(20);
      assert.equal([...m.kernel.state.artifacts.values()].some((a) => a.name === "Late"), false, "a turn the mesh already failed does not act afterwards");
      assert.equal(devTurns(m).find((t) => t.turnId === hung.turnId)!.status, "failed", "and its record is not rewritten to success");
    } finally {
      await cleanup();
    }
  },
);

test(
  "streaming: after a forced settle the seat runs its next activation",
  async () => {
    const { m, clock, hung, cleanup } = await hungAndSilent();
    try {
      // The slow-turn retry is 1000ms after the failure; give it ten times that.
      await tick(clock, 10_000);
      await waitFor(
        "a turn after the forced settle",
        () => devTurns(m).some((t) => t.turnId !== hung.turnId && t.status !== "running"),
        3000,
      );
      const next = devTurns(m).find((t) => t.turnId !== hung.turnId)!;
      assert.equal(next.status, "waiting", "the seat is usable again without an operator");
    } finally {
      await cleanup();
    }
  },
);
