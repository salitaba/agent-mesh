import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  ClaudeRuntimeAdapter,
  estimateContextFromSum,
  rotateAtFor,
  type ClaudeAdapterOptions,
} from "../../packages/runtime-claude/src/index";
import { InterruptedTurnError, TurnTimeoutError, type AgentDefinition, type AgentInput, type RuntimeContext } from "../../packages/protocol/src/index";

/**
 * What the rotation decision measures, fed the frames a real run produced.
 *
 * The live run of 2026-09-25 (NOTES-live-run-20260925-2040.md §1, §12) ran every
 * seat through an OpenAI->Claude translating proxy. That proxy sends
 * `message_start` with ZERO usage and the real per-call usage only on
 * `message_delta`; the CLI builds its streamed `assistant` frames from the
 * message_start copy, so those read zero too. The adapter read only `assistant`
 * frames, found nothing, and fell back to the turn's SUMMED reads — overstating
 * the context 4.5x-35x and making 23 of 49 turns handovers.
 *
 * The per-call figures below are the seat's own CLI transcript for that run
 * (frontend, `0d8c25e9…jsonl`): what the CLI recorded once each call finished.
 */

const REAL_CALLS = [
  { input_tokens: 10_737, cache_read_input_tokens: 26_624, output_tokens: 1_529 },
  { input_tokens: 7_308, cache_read_input_tokens: 37_248, output_tokens: 1_444 },
  { input_tokens: 4_891, cache_read_input_tokens: 44_544, output_tokens: 4_127 },
];
const promptOf = (c: { input_tokens: number; cache_read_input_tokens: number }) => c.input_tokens + c.cache_read_input_tokens;
const LARGEST = Math.max(...REAL_CALLS.map(promptOf)); // 49,435
const SUMMED = REAL_CALLS.reduce((a, c) => a + promptOf(c), 0); // 131,352

const def = (over: Partial<AgentDefinition> = {}): AgentDefinition => ({
  id: "frontend",
  role: "developer",
  mode: "peer",
  runtime: "claude",
  prompt: { text: "you build things" },
  capabilities: ["repository.write"],
  authority: [],
  communicationPolicy: { mayContact: [], mayBeContactedBy: [] },
  interests: [],
  sessionPolicy: { persistent: true },
  delegationPolicy: { allowDelegation: false, maxDepth: 0, maxWorkers: 0 },
  budget: {},
  ...over,
});

function ctx(dir: string): RuntimeContext {
  return {
    goalId: "goal-1",
    meshId: "test",
    workspacePath: dir,
    busUrl: "http://127.0.0.1:1",
    agentToken: "t",
    rolePromptText: "you build things",
    capabilityGrants: ["repository.write"],
    env: {},
  };
}

const input = (instructions: string): AgentInput => ({
  agentId: "frontend",
  goalId: "goal-1",
  activation: { kind: "manual" },
  context: {
    rolePrompt: "x",
    mission: "m",
    relevantPolicies: [],
    agentState: { agentId: "frontend", lifecycle: "THINKING", mailboxDepth: 0, currentArtifactIds: [], tokensConsumed: 0, activations: 0, lastActivityAt: "" },
    relevantDecisions: [],
    relevantArtifacts: [],
    unreadMail: [],
    recentOwnActivity: [],
    agentMemory: [],
    openThreads: [],
    budgetSnapshot: { agentTokensUsed: 0, agentTokenBudget: 0, missionTokensUsed: 0, missionTokenBudget: 0 },
    outstanding: { awaitingResponse: [], owedByYou: [] },
    goalCriteria: [],
  },
  instructions,
});

type Call = { input_tokens: number; cache_read_input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number };
interface TurnPlan {
  calls: Call[];
  /** Where the per-call usage rides: the proxy's shape, Anthropic's, or nowhere. */
  usageOn: "message_delta" | "message_start" | "none" | "silent";
  /** Emit the frames, then never answer — the timeout shape. */
  hang?: boolean;
  /** Emit the frames, then wait for `interrupt()` and answer it as the CLI does. */
  awaitInterrupt?: boolean;
  /** What the abort's `result` frame reports: the turn's sum (the default), or nothing, as the real CLI sometimes does. */
  abortUsage?: "summed" | "zero" | "reads-only";
}

const zeroUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

/**
 * A fake `query` that speaks the frame sequence the CLI emits with
 * `includePartialMessages`: per model call, `message_start` -> `assistant` ->
 * `message_delta`, then one `result` whose usage is the turn's SUM.
 */
function fakeQuery(plans: (queryIndex: number, turnIndex: number) => TurnPlan, model = "deepseek-v4.1-flash") {
  const opened: Array<{ sdkSessionId: string; resumed: boolean }> = [];
  const queryFn = (({ prompt, options }: { prompt: unknown; options: Record<string, unknown> }) => {
    const index = opened.length;
    const sdkSessionId = String(options.sessionId ?? options.resume ?? "unknown");
    opened.push({ sdkSessionId, resumed: options.resume !== undefined });
    let onInterrupt: (() => void) | undefined;
    const gen = (async function* () {
      yield { type: "system", subtype: "init", session_id: sdkSessionId, model, mcp_servers: [{ name: "mesh", status: "connected" }] };
      let turnIndex = 0;
      for await (const _msg of prompt as AsyncIterable<unknown>) {
        const plan = plans(index, turnIndex);
        for (const [i, c] of plan.calls.entries()) {
          const real = { ...zeroUsage, ...c, cache_creation_input_tokens: c.cache_creation_input_tokens ?? 0 };
          const id = `msg_${index}_${turnIndex}_${i}`;
          yield {
            type: "stream_event",
            parent_tool_use_id: null,
            session_id: sdkSessionId,
            event: { type: "message_start", message: { id, model, role: "assistant", content: [], usage: plan.usageOn === "message_start" ? real : zeroUsage } },
          };
          yield { type: "assistant", session_id: sdkSessionId, parent_tool_use_id: null, message: { id, model, content: [], usage: zeroUsage } };
          yield {
            type: "stream_event",
            parent_tool_use_id: null,
            session_id: sdkSessionId,
            event: {
              type: "message_delta",
              delta: { stop_reason: "tool_use", stop_sequence: null },
              usage: plan.usageOn === "message_delta" ? { ...real, output_tokens_details: { thinking_tokens: 0 }, server_tool_use: { web_search_requests: 0 } } : plan.usageOn === "silent" ? {} : { output_tokens: c.output_tokens },
            },
          };
        }
        if (plan.hang) await new Promise(() => undefined);
        const summed = {
          input_tokens: plan.calls.reduce((a, c) => a + c.input_tokens, 0),
          output_tokens: plan.calls.reduce((a, c) => a + c.output_tokens, 0),
          cache_read_input_tokens: plan.calls.reduce((a, c) => a + c.cache_read_input_tokens, 0),
          cache_creation_input_tokens: plan.calls.reduce((a, c) => a + (c.cache_creation_input_tokens ?? 0), 0),
        };
        if (plan.awaitInterrupt) {
          await new Promise<void>((resolve) => (onInterrupt = resolve));
          yield { type: "result", subtype: "error_during_execution", is_error: true, session_id: sdkSessionId, usage: plan.abortUsage === "zero" ? zeroUsage : plan.abortUsage === "reads-only" ? { ...zeroUsage, cache_read_input_tokens: 5_000 } : summed, errors: ["Request was aborted."] };
        } else {
          yield { type: "result", subtype: "success", is_error: false, result: "ok", session_id: sdkSessionId, num_turns: turnIndex + 1, usage: summed };
        }
        turnIndex++;
      }
    })();
    return Object.assign(gen, {
      interrupt: async () => onInterrupt?.(),
      setPermissionMode: async () => undefined,
      setModel: async () => undefined,
      supportedModels: async () => [],
      supportedCommands: async () => [],
      mcpServerStatus: async () => ({}),
    });
  }) as unknown as ClaudeAdapterOptions["queryFn"];
  return { queryFn, opened };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mesh-rot-usage-"));

test("the proxy's per-call usage arrives only on message_delta, and that is what rotation measures", async () => {
  const { queryFn } = fakeQuery(() => ({ calls: REAL_CALLS, usageOn: "message_delta" }));
  // Between the largest call and the turn's sum: the summed figure trips it,
  // the real context does not.
  const rt = new ClaudeRuntimeAdapter({ queryFn, rotateAtContextTokens: 60_000 });
  const session = await rt.start(def(), ctx(tmp()));
  const out = await rt.send(session, input("one"));
  assert.equal(out.tokensUsed.input + (out.tokensUsed.cacheRead ?? 0), SUMMED, "fixture: the result frame carries the summed reads");
  assert.equal(rt.rotationPending(session), null, `a ${LARGEST}-token context must not rotate at 60k because the turn read ${SUMMED} in total`);
  await rt.stop(session);

  const tight = new ClaudeRuntimeAdapter({ queryFn, rotateAtContextTokens: 45_000 });
  const s2 = await tight.start(def(), ctx(tmp()));
  await tight.send(s2, input("one"));
  assert.equal(tight.rotationPending(s2)?.transcriptTokens, LARGEST, "the largest single call, read off message_delta");
  await tight.stop(s2);
});

test("usage reported on message_start is read as well", async () => {
  const { queryFn } = fakeQuery(() => ({ calls: REAL_CALLS, usageOn: "message_start" }));
  const rt = new ClaudeRuntimeAdapter({ queryFn, rotateAtContextTokens: 45_000 });
  const session = await rt.start(def(), ctx(tmp()));
  await rt.send(session, input("one"));
  assert.equal(rt.rotationPending(session)?.transcriptTokens, LARGEST);
  await rt.stop(session);
});

test("a backend whose frames all read zero is logged once and estimated, not charged its summed reads", async () => {
  const { queryFn } = fakeQuery(() => ({ calls: REAL_CALLS, usageOn: "none" }));
  const notices: Array<{ kind: string; agentId: string }> = [];
  const rt = new ClaudeRuntimeAdapter({ queryFn, rotateAtContextTokens: 1_000, onNotice: (n) => notices.push(n) });
  const session = await rt.start(def(), ctx(tmp()));
  await rt.send(session, input("one"));
  const info = rt.rotationPending(session);
  const estimate = estimateContextFromSum(SUMMED, REAL_CALLS.length);
  assert.equal(info?.transcriptTokens, estimate);
  assert.ok(estimate < SUMMED, "the estimate must not be the raw sum the incident was caused by");
  assert.ok(estimate >= LARGEST, "and must not under-state the real context on a transcript that grew call by call");
  // Twice the per-call mean, bounded by the sum: exact for one or two calls.
  assert.equal(estimateContextFromSum(100_000, 1), 100_000);
  assert.equal(estimateContextFromSum(100_000, 2), 100_000);
  assert.equal(estimateContextFromSum(6_773_313, 57), 237_661, "frontend seq 1019: 6.77M summed over 57 calls, real 191,576");
  assert.equal(estimateContextFromSum(50_000, 0), 50_000, "no call count: the sum is the only safe bound");
  await rt.send(session, input("two"));
  assert.equal(notices.filter((n) => n.kind === "context_unmeasurable").length, 1, "once per session, not once per turn");
  await rt.stop(session);
});

test("a configured context window places a model the table cannot", async () => {
  const big = [{ input_tokens: 5_000, cache_read_input_tokens: 195_000, output_tokens: 10 }];
  const { queryFn } = fakeQuery(() => ({ calls: big, usageOn: "message_delta" }));
  const notices: Array<{ kind: string; message: string }> = [];
  const floor = new ClaudeRuntimeAdapter({ queryFn, onNotice: (n) => notices.push(n) });
  const s0 = await floor.start(def(), ctx(tmp()));
  await floor.send(s0, input("one"));
  assert.equal(floor.rotationPending(s0)?.thresholdTokens, 120_000, "no window configured: the conservative floor, as before");
  await floor.send(s0, input("two"));
  await floor.send(s0, input("three"));
  const unknown = notices.filter((n) => n.kind === "unknown_context_window");
  assert.equal(unknown.length, 1, "the fallback is logged, once");
  assert.match(unknown[0].message, /deepseek-v4\.1-flash/);
  await floor.stop(s0);

  // mesh.runtime.context_window: a 1M window at the existing 60% ratio.
  const mesh = new ClaudeRuntimeAdapter({ queryFn, contextWindow: 1_000_000 });
  const s1 = await mesh.start(def(), ctx(tmp()));
  await mesh.send(s1, input("one"));
  assert.equal(mesh.rotationPending(s1), null, "200k of context on a 1M window is not a rotation");
  await mesh.stop(s1);

  // agents.<id>.context_window beats the mesh-wide default.
  const s2 = await mesh.start(def({ contextWindow: 300_000 }), ctx(tmp()));
  await mesh.send(s2, input("one"));
  assert.equal(mesh.rotationPending(s2)?.thresholdTokens, 180_000);
  await mesh.stop(s2);
});

test("the mesh-wide window never raises a model the table knows is smaller", async () => {
  const big = [{ input_tokens: 5_000, cache_read_input_tokens: 145_000, output_tokens: 10 }];
  const { queryFn } = fakeQuery(() => ({ calls: big, usageOn: "message_delta" }), "claude-haiku-4-5-20251001");
  const rt = new ClaudeRuntimeAdapter({ queryFn, contextWindow: 1_000_000 });
  const s = await rt.start(def(), ctx(tmp()));
  await rt.send(s, input("one"));
  assert.equal(rt.rotationPending(s)?.thresholdTokens, 120_000, "a 200k seat under a 1M mesh default would overflow its window");
  await rt.stop(s);
});

test("a [1m] model id declares a 1M window", () => {
  assert.equal(rotateAtFor("claude-sonnet-4-5[1m]"), 600_000);
  assert.equal(rotateAtFor("anthropic/claude-opus-4-7[1M]"), 600_000);
  assert.equal(rotateAtFor("claude-sonnet-4-5"), 120_000, "without the suffix an unplaced id still takes the floor");
});

test("rotationPending names the SDK session it would discard, and whether its cache is already cold", async () => {
  const big = [{ input_tokens: 5_000, cache_read_input_tokens: 75_000, output_tokens: 10 }];
  const { queryFn, opened } = fakeQuery(() => ({ calls: big, usageOn: "message_delta" }));
  const rt = new ClaudeRuntimeAdapter({ queryFn, rotateAtContextTokens: 50_000, staleAfterMs: 200 });
  const session = await rt.start(def(), ctx(tmp()));
  await rt.send(session, input("one"));
  const warm = rt.rotationPending(session);
  assert.equal(warm?.sessionId, opened[0].sdkSessionId);
  assert.equal(warm?.cacheCold, false, "a session that just answered still has its prompt cache");
  await rt.send(session, input("two")); // rotates on the way in
  assert.equal(opened.length, 2);
  assert.notEqual(opened[1].sdkSessionId, session.sessionId, "fixture: the mesh id and the SDK id have come apart");
  await new Promise((r) => setTimeout(r, 260));
  const cold = rt.rotationPending(session);
  assert.equal(cold?.sessionId, opened[1].sdkSessionId, "the transcript about to be discarded, not the mesh-stable id");
  assert.equal(cold?.cacheCold, true);
  await rt.stop(session);
});

test("a resumed session keeps the context size its transcript was carrying", async () => {
  const big = [{ input_tokens: 4_000, cache_read_input_tokens: 220_000, output_tokens: 10 }];
  const { queryFn, opened } = fakeQuery(() => ({ calls: big, usageOn: "message_delta" }));
  const rt = new ClaudeRuntimeAdapter({ queryFn, rotateAtContextTokens: 150_000 });
  const session = await rt.start(def(), ctx(tmp()));
  await rt.send(session, input("one"));
  await rt.suspend(session);
  const resumed = await rt.restoreSession(def(), session.sessionId, ctx(tmp()));
  assert.ok(resumed);
  assert.equal(opened.at(-1)?.resumed, true, "fixture: this is a --resume of the same transcript");
  assert.equal(rt.rotationPending(resumed)?.transcriptTokens, 224_000, "backend resumed onto a 224k transcript with no rotation pending (§12)");
  await rt.stop(resumed);
});

test("the context size survives a restart through the adapter's state file", async () => {
  const dir = tmp();
  const big = [{ input_tokens: 4_000, cache_read_input_tokens: 220_000, output_tokens: 10 }];
  const { queryFn } = fakeQuery(() => ({ calls: big, usageOn: "message_delta" }));
  const first = new ClaudeRuntimeAdapter({ queryFn, rotateAtContextTokens: 150_000, stateDir: dir });
  const session = await first.start(def(), ctx(tmp()));
  await first.send(session, input("one"));
  await first.stopAll();

  const second = new ClaudeRuntimeAdapter({ queryFn, rotateAtContextTokens: 150_000, stateDir: dir });
  const resumed = await second.restoreSession(def(), session.sessionId, ctx(tmp()));
  assert.ok(resumed);
  assert.equal(second.rotationPending(resumed)?.transcriptTokens, 224_000);
  await second.stopAll();
});

test("a failed turn raises the stored context from the usage its frames carried", async () => {
  const big = [{ input_tokens: 6_000, cache_read_input_tokens: 250_000, output_tokens: 10 }];
  const { queryFn } = fakeQuery((_q, turn) => ({ calls: turn === 0 ? [{ input_tokens: 5_000, cache_read_input_tokens: 5_000, output_tokens: 1 }] : big, usageOn: "message_delta", hang: turn === 1 }));
  const rt = new ClaudeRuntimeAdapter({ queryFn, rotateAtContextTokens: 150_000, turnTimeoutMs: 300 });
  const session = await rt.start(def(), ctx(tmp()));
  await rt.send(session, input("one"));
  await assert.rejects(() => rt.send(session, input("two")), TurnTimeoutError);
  // This fake never answers the abort, so the adapter tears the session down (a
  // late answer would settle the retry). The measurement outlives it, through
  // the resume the retry takes.
  const resumed = await rt.restoreSession(def(), session.sessionId, ctx(tmp()));
  assert.ok(resumed);
  assert.equal(rt.rotationPending(resumed)?.transcriptTokens, 256_000, "the timed-out turn's frames reported 256k per call");
  await rt.stop(resumed);
});

test("endTurn ends a turn as COMPLETE, not as an interrupted failure", async () => {
  const { queryFn } = fakeQuery(() => ({ calls: REAL_CALLS.slice(0, 1), usageOn: "message_delta", awaitInterrupt: true }));
  const rt = new ClaudeRuntimeAdapter({ queryFn });
  const session = await rt.start(def(), ctx(tmp()));
  const pending = rt.send(session, input("handover"));
  await new Promise((r) => setTimeout(r, 30));
  await rt.endTurn(session);
  const out = await pending;
  assert.equal(out.error, undefined, "the mesh asked for the end: it is not the seat's failure");
  assert.equal(out.text, "", "the abort's own prose is not a reply");
  assert.equal(out.tokensUsed.input, REAL_CALLS[0].input_tokens, "and the tokens it spent are still billed");
  assert.equal(await rt.getStatus(session), "IDLE");
  await rt.stop(session);
});

/**
 * A handover is ended by the mesh the moment its continuity record lands, and the CLI answers that abort with a `result` frame. That
 * frame can report nothing at all though the call it cut short was billed in full. In the fifteenth cronlite run the developer's
 * handover (05:06:23) booked 0 tokens for a call whose transcript says 14,826 cache-write and 139,638 cache-read tokens, and so did
 * five other handovers of runs 9 to 15 (six of the eleven recorded): the abort's frame was taken at its word, where the timeout branch
 * has always fallen back to the figure the stream carried. Absent or zero is unmeasured, and unmeasured is not free.
 */
const HANDOVER_CALL = { input_tokens: 10, cache_read_input_tokens: 139_638, output_tokens: 312, cache_creation_input_tokens: 14_826 };

test("endTurn books what the stream reported when the abort's own frame reads zero", async () => {
  const { queryFn } = fakeQuery(() => ({ calls: [HANDOVER_CALL], usageOn: "message_delta", awaitInterrupt: true, abortUsage: "zero" }));
  const rt = new ClaudeRuntimeAdapter({ queryFn });
  const session = await rt.start(def(), ctx(tmp()));
  const pending = rt.send(session, input("handover"));
  await new Promise((r) => setTimeout(r, 30));
  await rt.endTurn(session);
  const out = await pending;
  assert.equal(out.error, undefined);
  assert.equal(out.tokensUsed.input, 10);
  assert.equal(out.tokensUsed.output, 312);
  assert.equal(out.tokensUsed.cacheRead, 139_638, "the reads are real money too, even at weight 0 in the budgets");
  assert.equal(out.tokensUsed.total, 10 + 312 + 14_826, "billed = input + output + cache writes, as for any turn");
  await rt.stop(session);
});

test("an abort frame that reports usage is still the figure, and a turn that nobody measured stays unmeasured", async () => {
  const reported = fakeQuery(() => ({ calls: [HANDOVER_CALL], usageOn: "message_delta", awaitInterrupt: true, abortUsage: "summed" }));
  const rt = new ClaudeRuntimeAdapter({ queryFn: reported.queryFn });
  const session = await rt.start(def(), ctx(tmp()));
  const pending = rt.send(session, input("handover"));
  await new Promise((r) => setTimeout(r, 30));
  await rt.endTurn(session);
  const out = await pending;
  assert.equal(out.tokensUsed.total, 10 + 312 + 14_826, "the frame carried the sum, and it is that");
  await rt.stop(session);

  // No frame of the turn carried usage and the abort's reads zero: nothing is made up.
  const blind = fakeQuery(() => ({ calls: [HANDOVER_CALL], usageOn: "silent", awaitInterrupt: true, abortUsage: "zero" }));
  const rt2 = new ClaudeRuntimeAdapter({ queryFn: blind.queryFn });
  const s2 = await rt2.start(def(), ctx(tmp()));
  const p2 = rt2.send(s2, input("handover"));
  await new Promise((r) => setTimeout(r, 30));
  await rt2.endTurn(s2);
  const o2 = await p2;
  assert.equal(o2.tokensUsed.total, 0);
  assert.equal(o2.tokensUsed.cacheRead ?? 0, 0);
  await rt2.stop(s2);
});

test("a turn the mesh interrupts is billed what the stream reported when the abort's frame reads zero, as a timed-out one always was", async () => {
  const { queryFn } = fakeQuery(() => ({ calls: [HANDOVER_CALL], usageOn: "message_delta", awaitInterrupt: true, abortUsage: "zero" }));
  const rt = new ClaudeRuntimeAdapter({ queryFn });
  const session = await rt.start(def(), ctx(tmp()));
  const settled = rt.send(session, input("work")).then(() => undefined, (e: unknown) => e);
  await new Promise((r) => setTimeout(r, 30));
  await rt.interrupt(session);
  const err = await settled;
  assert.ok(err instanceof InterruptedTurnError, `an interrupt is an interrupt: ${String(err)}`);
  assert.equal(err.tokensUsed?.total, 10 + 312 + 14_826, "its spend rides on the error, not 0");
  assert.equal(err.tokensUsed?.cacheRead, 139_638);
  await rt.stop(session);
});

test("a frame that reports only cache reads is a report: it is not replaced by the stream's figure", async () => {
  const { queryFn } = fakeQuery(() => ({ calls: [HANDOVER_CALL], usageOn: "message_delta", awaitInterrupt: true, abortUsage: "reads-only" }));
  const rt = new ClaudeRuntimeAdapter({ queryFn });
  const session = await rt.start(def(), ctx(tmp()));
  const pending = rt.send(session, input("handover"));
  await new Promise((r) => setTimeout(r, 30));
  await rt.endTurn(session);
  const out = await pending;
  assert.equal(out.tokensUsed.cacheRead, 5_000, "the frame said something, and that is the figure");
  assert.equal(out.tokensUsed.total, 0);
  await rt.stop(session);
});

test("a turn the backstop timed out is billed what the stream reported when the abort's frame reads zero", async () => {
  const { queryFn } = fakeQuery(() => ({ calls: [HANDOVER_CALL], usageOn: "message_delta", awaitInterrupt: true, abortUsage: "zero" }));
  const rt = new ClaudeRuntimeAdapter({ queryFn, turnTimeoutMs: 300 });
  const session = await rt.start(def(), ctx(tmp()));
  const err = await rt.send(session, input("work")).then(() => undefined, (e: unknown) => e);
  assert.ok(err instanceof TurnTimeoutError, String(err));
  assert.equal(err.tokensUsed?.total, 10 + 312 + 14_826);
  await rt.stop(session);
});
