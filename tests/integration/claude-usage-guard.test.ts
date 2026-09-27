import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  ClaudeRuntimeAdapter,
  previousTurnPrefix,
  reattributedPrefix,
  reattributeTokens,
  usageToTokens,
  type ClaudeAdapterOptions,
  type ClaudeTurnEnd,
} from "../../packages/runtime-claude/src/index";
import {
  InterruptedTurnError,
  type AgentDefinition,
  type AgentEvent,
  type AgentInput,
  type AgentOutput,
  type RuntimeContext,
} from "../../packages/protocol/src/index";

/**
 * The usage guard: a call that reports its whole prompt as uncached input right
 * after the same turn sent that prefix is billed as a cache read. A turn's FIRST
 * call is judged the same way against the PREVIOUS turn's final prompt, while
 * that turn ended inside the operator's `stale_after_ms` window.
 *
 * The figures are the backend seat's own CLI transcript from 2026-09-26
 * (`9db3de5a…jsonl`, deduped by message id). Its first calls carry the
 * upstream's native ids and report their cache; from 15:05:43Z the ids switch
 * to `R…` and every call reports `cache_read_input_tokens: 0` with the whole
 * prompt as `input_tokens`, while the proxy's own log shows the cache hitting on
 * those same calls. The mesh billed them as written — 6.41M phantom tokens over
 * 55 calls on two seats in 13 minutes.
 */

type Call = { id: string; input: number; output: number; cacheRead?: number; cacheWrite?: number };

const CACHED: Call[] = [
  { id: "021790435085465", input: 1_239, output: 204, cacheRead: 55_936 },
  { id: "021790435097649", input: 793, output: 131, cacheRead: 57_088 },
  { id: "021790435110517", input: 1_268, output: 1_054, cacheRead: 57_856 },
  { id: "021790435128335", input: 1_882, output: 162, cacheRead: 59_008 },
];
const SWITCHED: Call[] = [
  { id: "RBUC6xtLaLQt8gezHYfmk8T4", input: 61_622, output: 582 },
  { id: "RHTMrdWOaFRDwunr5hVc3axp", input: 62_257, output: 433 },
  { id: "REUveGjUQW53mks9IgaVhIMI", input: 63_439, output: 286 },
  { id: "RFnYJZfyd01q1qV8Q17LYH8O", input: 64_139, output: 170 },
];
const NEXT_TURN: Call[] = [
  { id: "RXcqtalGTsqIBV4pZBOYqCXd", input: 66_931, output: 198 },
  { id: "RvZ2EqNikLGXdOlHZHteXLcH", input: 67_750, output: 273 },
];

const promptOf = (c: Call) => c.input + (c.cacheRead ?? 0) + (c.cacheWrite ?? 0);
const wire = (c: Call) => ({
  input_tokens: c.input,
  output_tokens: c.output,
  cache_read_input_tokens: c.cacheRead ?? 0,
  cache_creation_input_tokens: c.cacheWrite ?? 0,
});
const summed = (calls: Call[]) => ({
  input_tokens: calls.reduce((a, c) => a + c.input, 0),
  output_tokens: calls.reduce((a, c) => a + c.output, 0),
  cache_read_input_tokens: calls.reduce((a, c) => a + (c.cacheRead ?? 0), 0),
  cache_creation_input_tokens: calls.reduce((a, c) => a + (c.cacheWrite ?? 0), 0),
});
/** The same calls as an honest backend would report them: each prefix the previous call sent, as a cache read. */
const honest = (calls: Call[]): Call[] =>
  calls.map((c, i) => (i === 0 || (c.cacheRead ?? 0) > 0 ? c : { ...c, input: c.input - promptOf(calls[i - 1]), cacheRead: promptOf(calls[i - 1]) }));

/**
 * As `honest`, for a turn whose FIRST call is the one that dropped its cache:
 * that call's prefix is the previous TURN's final prompt, which no per-turn fold
 * can know. Every later call is folded as `honest` folds it.
 */
const honestFirst = (calls: Call[], prevTurnPrompt: number): Call[] => {
  const intra = honest(calls);
  return calls.map((c, i) => (i === 0 ? { ...c, input: c.input - prevTurnPrompt, cacheRead: prevTurnPrompt } : intra[i]));
};

const def = (): AgentDefinition => ({
  id: "backend",
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
});

const ctx = (): RuntimeContext => ({
  goalId: "goal-1",
  meshId: "test",
  workspacePath: fs.mkdtempSync(path.join(os.tmpdir(), "mesh-usage-guard-")),
  busUrl: "http://127.0.0.1:1",
  agentToken: "t",
  rolePromptText: "you build things",
  capabilityGrants: ["repository.write"],
  env: {},
});

const input = (instructions: string, onUsage?: AgentInput["onUsage"]): AgentInput => ({
  agentId: "backend",
  goalId: "goal-1",
  activation: { kind: "manual" },
  context: {
    rolePrompt: "x",
    mission: "m",
    relevantPolicies: [],
    agentState: { agentId: "backend", lifecycle: "THINKING", mailboxDepth: 0, currentArtifactIds: [], tokensConsumed: 0, activations: 0, lastActivityAt: "" },
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
  ...(onUsage ? { onUsage } : {}),
});

interface TurnPlan {
  calls: Call[];
  /** Emit the frames, then wait for `interrupt()` and answer it as the CLI does. */
  awaitInterrupt?: boolean;
}

/**
 * A fake `query` in the proxy's shape: per call a `message_start` with zero
 * usage, two `assistant` frames (one per content block, the same usage on
 * each, as the transcript repeats it), then `message_delta` with the real
 * figures; one `result` per turn whose usage is the SUM of the calls. Plans are
 * indexed by turn across rotations, so a rotated session carries on the script.
 */
function fakeQuery(plans: (turn: number) => TurnPlan, model = "deepseek-v4.1-flash") {
  let turns = 0;
  const queryFn = (({ prompt, options }: { prompt: unknown; options: Record<string, unknown> }) => {
    const sdkSessionId = String(options.sessionId ?? options.resume ?? "unknown");
    let onInterrupt: (() => void) | undefined;
    const gen = (async function* () {
      yield { type: "system", subtype: "init", session_id: sdkSessionId, model, mcp_servers: [{ name: "mesh", status: "connected" }] };
      for await (const _msg of prompt as AsyncIterable<unknown>) {
        const plan = plans(turns);
        for (const c of plan.calls) {
          const real = wire(c);
          const zero = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
          yield { type: "stream_event", parent_tool_use_id: null, session_id: sdkSessionId, event: { type: "message_start", message: { id: c.id, model, role: "assistant", content: [], usage: zero } } };
          for (const text of ["thinking it over", "calling a tool"]) {
            yield { type: "assistant", session_id: sdkSessionId, parent_tool_use_id: null, message: { id: c.id, model, content: [{ type: "text", text }], usage: real } };
          }
          yield { type: "stream_event", parent_tool_use_id: null, session_id: sdkSessionId, event: { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: real } };
        }
        turns++;
        if (plan.awaitInterrupt) {
          await new Promise<void>((resolve) => (onInterrupt = resolve));
          yield { type: "result", subtype: "error_during_execution", is_error: true, session_id: sdkSessionId, usage: summed(plan.calls), errors: ["Request was aborted."] };
        } else {
          yield { type: "result", subtype: "success", is_error: false, result: "ok", session_id: sdkSessionId, num_turns: turns, usage: summed(plan.calls) };
        }
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
  return { queryFn };
}

type Notice = { agentId: string; kind: string; message: string };

function adapter(plans: (turn: number) => TurnPlan, over: Partial<ClaudeAdapterOptions> = {}) {
  const notices: Notice[] = [];
  const rotations: string[] = [];
  const rt = new ClaudeRuntimeAdapter({
    queryFn: fakeQuery(plans).queryFn,
    onNotice: (n) => notices.push(n),
    onRotate: (r) => rotations.push(r.reason),
    ...over,
  });
  return { rt, notices, rotations, reattributed: () => notices.filter((n) => n.kind === "usage_reattributed") };
}

/** One turn through `stream`, keeping every frame the adapter let out. */
async function streamTurn(rt: ClaudeRuntimeAdapter, session: Awaited<ReturnType<ClaudeRuntimeAdapter["start"]>>, text: string) {
  const frames: AgentEvent[] = [];
  for await (const ev of rt.stream(session, input(text))) frames.push(ev);
  const live = frames.flatMap((f) => (f.kind === "usage_update" ? [f.tokensUsed] : []));
  const end = frames.find((f): f is ClaudeTurnEnd => f.kind === "turn_end");
  assert.ok(end, "fixture: the turn ended");
  return { live, end };
}

test("reattributedPrefix moves the previous call's prompt, and only on a grown, zero-cache report", () => {
  const zero = (input: number) => ({ input, cacheRead: 0, cacheWrite: 0 });
  assert.equal(reattributedPrefix(zero(61_622), 60_890), 60_890, "15:05:43Z: the first R… call, right after a 60,890-token prompt");
  assert.equal(reattributedPrefix(zero(61_622), undefined), 0, "with no evidence at all the call is billed as reported");
  assert.equal(reattributedPrefix(zero(40_000), 100_000), 0, "a shrunk prompt (compaction, rotation) is not a re-send");
  assert.equal(reattributedPrefix(zero(9_000), 7_999), 0, "below the floor a missed cache is cheap and plausible");
  assert.equal(reattributedPrefix({ input: 61_622, cacheRead: 1, cacheWrite: 0 }, 60_890), 0, "a reported cache read is believed");
  assert.equal(reattributedPrefix({ input: 1_000, cacheRead: 0, cacheWrite: 60_000 }, 60_890), 0, "so is a reported cache write");
  const t = reattributeTokens({ input: 100, output: 5, total: 110, cacheRead: 0 }, 1_000);
  assert.deepEqual(t, { input: 0, output: 5, total: 10, cacheRead: 100 }, "never moves more input than there is");
});

test("previousTurnPrefix offers the previous turn's final prompt only inside the operator's cache window", () => {
  const now = 1_000_000;
  const record = (promptTokens: number | undefined, endedAt: number | undefined) => ({ promptTokens, endedAt });
  assert.equal(previousTurnPrefix(record(60_890, now - 1), 600_000, now), 60_890, "just-ended turn: the evidence stands");
  assert.equal(previousTurnPrefix(record(60_890, now - 600_000), 600_000, now), 60_890, "the window's edge is still inside it");
  assert.equal(previousTurnPrefix(record(60_890, now - 600_001), 600_000, now), undefined, "one ms past it, nothing is assumed");
  assert.equal(previousTurnPrefix(record(undefined, now - 1), 600_000, now), undefined, "no size recorded: the session's first turn");
  assert.equal(previousTurnPrefix(record(60_890, undefined), 600_000, now), undefined, "a size with no end time is not evidence either");
  assert.equal(previousTurnPrefix(undefined, 600_000, now), undefined, "and a session with no record at all offers none");
  // The 8,000-token floor is reattributedPrefix's, applied to both kinds alike.
  assert.equal(reattributedPrefix({ input: 9_000, cacheRead: 0, cacheWrite: 0 }, previousTurnPrefix(record(7_999, now - 1), 600_000, now)), 0);
});

test("(a) calls that report their cache are billed exactly as reported", async () => {
  const { rt, reattributed } = adapter(() => ({ calls: CACHED }));
  const session = await rt.start(def(), ctx());
  const { live, end } = await streamTurn(rt, session, "one");
  assert.deepEqual(end.tokensUsed, usageToTokens(summed(CACHED)));
  assert.equal(end.usageGuard, undefined, "nothing moved, nothing reported");
  assert.deepEqual(live.at(-1), end.tokensUsed, "live and settled agree");
  assert.equal(live.length, CACHED.length, "one update per call: the frames that repeat its usage add nothing");
  assert.equal(reattributed().length, 0);
  await rt.stop(session);
});

test("(b) a turn whose calls switch to zero-cache full-prompt reports is billed as cache reads, raw kept alongside", async () => {
  const turn = [...CACHED, ...SWITCHED];
  const { rt, rotations, reattributed } = adapter((i) => ({ calls: i === 0 ? turn : NEXT_TURN }), { rotateAtContextTokens: 1_000 });
  const session = await rt.start(def(), ctx());
  const liveViaSend: AgentOutput["tokensUsed"][] = [];
  const out = await rt.send(session, input("one", (t) => liveViaSend.push(t)));

  const raw = usageToTokens(summed(turn));
  const moved = [CACHED.at(-1)!, ...SWITCHED.slice(0, -1)].reduce((a, c) => a + promptOf(c), 0);
  assert.equal(moved, 60_890 + 61_622 + 62_257 + 63_439);
  assert.deepEqual(out.usageGuard, { adjustedCalls: SWITCHED.length, reattributedTokens: moved, raw, adjusted: out.tokensUsed });
  assert.equal(out.tokensUsed.input, raw.input - moved);
  assert.equal(out.tokensUsed.cacheRead, (raw.cacheRead ?? 0) + moved);
  assert.equal(out.tokensUsed.total, raw.total - moved, "the budget ledger bills input + output + cache writes");
  assert.equal(out.tokensUsed.output, raw.output, "output is never adjusted");
  assert.equal(raw.input, 256_639, "fixture: the backend reported 256,639 input tokens…");
  assert.equal(out.tokensUsed.input, 8_431, "…of which 248,208 were prefixes the same turn had sent seconds earlier");
  assert.deepEqual(out.tokensUsed, usageToTokens(summed(honest(turn))), "billed as an honest cache report would have been");

  // (e) The live figure (what `liveTokens` and the over-budget interrupt read)
  // never carried the phantom input, and ends on the settled figure.
  assert.deepEqual(liveViaSend.at(-1), out.tokensUsed, "settled equals the final live figure");
  assert.ok(liveViaSend.every((t) => t.input <= out.tokensUsed.input), "no update ever reported the phantom input");

  // (f) Rotation sizes on the raw prompt, which the move does not change.
  assert.equal(rt.rotationPending(session)?.transcriptTokens, promptOf(SWITCHED.at(-1)!), "the largest call's prompt, 64,139");

  const notes = reattributed();
  assert.equal(notes.length, 1, "warned the first time it fired");
  assert.equal(notes[0].agentId, "backend");
  assert.match(notes[0].message, /61622-token call with zero cache/);
  assert.match(notes[0].message, /60890 tokens/);

  // The next turn rotates first (threshold 1,000), so it runs on a session with
  // no record: its first call is billed as reported (c) and the second is
  // re-attributed against the first. The same seat session is not warned again.
  const next = await rt.send(session, input("two"));
  const nextRaw = usageToTokens(summed(NEXT_TURN));
  assert.equal(rotations.length, 1, "fixture: the second turn rotated onto a fresh session");
  assert.equal(next.usageGuard?.adjustedCalls, 1);
  assert.equal(next.usageGuard?.firstCallAdjustments, undefined, "a fresh session has no previous turn to judge the first call against");
  assert.equal(next.tokensUsed.input, nextRaw.input - promptOf(NEXT_TURN[0]));
  assert.equal(next.tokensUsed.input, 66_931 + (67_750 - 66_931), "the turn's first call keeps its whole prompt as input");
  assert.equal(reattributed().length, 1, "once per seat session, across rotations");
  await rt.stop(session);
});

test("(e) through stream: every usage_update is already adjusted, and the last one is the turn_end figure", async () => {
  const turn = [...CACHED, ...SWITCHED];
  const { rt } = adapter(() => ({ calls: turn }));
  const session = await rt.start(def(), ctx());
  const { live, end } = await streamTurn(rt, session, "one");
  assert.ok(end.usageGuard, "the report rides on turn_end");
  assert.deepEqual(live.at(-1), end.tokensUsed);
  assert.deepEqual(end.usageGuard.adjusted, end.tokensUsed);
  for (let i = 1; i < live.length; i++) {
    assert.ok(live[i].total >= live[i - 1].total, "cumulative, never stepping back");
  }
  await rt.stop(session);
});

// REWRITTEN: this test used to assert that a turn's first call is NEVER
// adjusted, "even with zero cache" — the behaviour the turn-boundary rule
// replaces. It now asserts the same outcome for the reason that still holds: the
// session ROTATED first, so the replacement has no record to judge against.
test("(c) a first call after a rotation is billed as reported: a fresh session has no record", async () => {
  const { rt, rotations, reattributed } = adapter((i) => ({ calls: i === 0 ? CACHED : SWITCHED.slice(0, 1) }), {
    rotateAtContextTokens: 1_000,
  });
  const session = await rt.start(def(), ctx());
  await rt.send(session, input("one"));
  const out = await rt.send(session, input("two"));
  assert.equal(rotations.length, 1, "fixture: the second turn rotated onto a fresh session");
  assert.deepEqual(out.tokensUsed, usageToTokens(summed(SWITCHED.slice(0, 1))), "the prefix may really have gone cold between turns");
  assert.equal(out.usageGuard, undefined);
  assert.equal(reattributed().length, 0);
  await rt.stop(session);
});

test("(g) a turn's first call that drops its cache is re-attributed against the previous turn's final prompt", async () => {
  const { rt, rotations, reattributed } = adapter((i) => ({ calls: i === 0 ? CACHED : i === 1 ? NEXT_TURN : CACHED }));
  const session = await rt.start(def(), ctx());
  const first = await rt.send(session, input("one"));
  assert.equal(first.usageGuard, undefined, "the session's first turn has no previous turn to record");
  assert.equal(rotations.length, 0);

  const raw = usageToTokens(summed(NEXT_TURN));
  const moved = promptOf(CACHED.at(-1)!); // 60,890: the previous turn's FINAL call
  const live: AgentOutput["tokensUsed"][] = [];
  const out = await rt.send(session, input("two", (t) => live.push(t)));
  assert.deepEqual(out.tokensUsed, usageToTokens(summed(honestFirst(NEXT_TURN, moved))), "billed as an honest cache report would have been");
  assert.equal(out.tokensUsed.input, raw.input - moved - promptOf(NEXT_TURN[0]), "the first call against the previous turn, the second against the first");
  assert.equal(out.tokensUsed.cacheRead, (raw.cacheRead ?? 0) + moved + promptOf(NEXT_TURN[0]));
  assert.equal(out.tokensUsed.output, raw.output, "output is never adjusted");
  assert.deepEqual(
    out.usageGuard,
    { adjustedCalls: 2, reattributedTokens: moved + promptOf(NEXT_TURN[0]), firstCallAdjustments: 1, raw, adjusted: out.tokensUsed },
    "the turn-first call is named on the same report, and counted in adjustedCalls",
  );
  // (e) The live figure ends on the settled one, and never carried the phantom
  // input.
  assert.deepEqual(live.at(-1), out.tokensUsed, "settled equals the final live figure");
  assert.ok(live.every((t) => t.input <= out.tokensUsed.input), "no update ever reported the phantom input");
  // (f) Rotation sizing is unchanged. Same script, same evidence, but a session
  // pinned below its threshold with the rotation suppressed for one turn — the
  // handover shape — so the measurement the threshold reads is observable: it is
  // the raw 67,750, not the 6,860 the turn was billed for.
  const pinned = adapter((i) => ({ calls: i === 0 ? CACHED : NEXT_TURN }), { rotateAtContextTokens: 60_000 });
  const s2 = await pinned.rt.start(def(), ctx());
  await pinned.rt.send(s2, input("one"));
  const handover = await pinned.rt.send(s2, { ...input("two"), suppressRotation: true });
  assert.deepEqual(handover.tokensUsed, out.tokensUsed, "the handover turn is billed exactly as the ordinary one was");
  assert.equal(pinned.rt.rotationPending(s2)?.transcriptTokens, promptOf(NEXT_TURN[1]), "and rotation still measures the raw prompt");
  await pinned.rt.stop(s2);

  // Nothing about the intra-turn rule changed: a turn whose calls all report
  // their cache is still billed exactly as reported.
  const third = await rt.send(session, input("three"));
  assert.equal(third.usageGuard, undefined, "honest calls are billed as reported");
  const notes = reattributed();
  assert.equal(notes.length, 1, "still one notice per seat session, whichever kind of call fired it");
  assert.match(notes[0].message, /66931-token call with zero cache when the previous turn of this session had sent 60890 tokens of it/);
  await rt.stop(session);
});

test("(h) the record is the previous turn's FINAL prompt: a turn that shrank at its end is not evidence", async () => {
  // A turn whose last call shrank — a compaction mid-turn — reset its context, so
  // the next turn's first call is not re-attributed against the prefix that the
  // turn's LARGEST call once carried.
  const compacted: Call[] = [
    { id: "k1", input: 5_000, output: 10, cacheRead: 195_000 },
    { id: "k2", input: 400, output: 10, cacheRead: 0 },
  ];
  const { rt } = adapter((i) => ({ calls: i === 0 ? compacted : SWITCHED.slice(0, 1) }), { rotateAtContextTokens: 1_000_000 });
  const session = await rt.start(def(), ctx());
  const one = await rt.send(session, input("one"));
  assert.equal(one.usageGuard, undefined, "fixture: the turn itself reported its cache");
  const out = await rt.send(session, input("two"));
  assert.deepEqual(out.tokensUsed, usageToTokens(summed(SWITCHED.slice(0, 1))), "the recorded prompt was 400 tokens, below the floor");
  assert.equal(out.usageGuard, undefined);
  await rt.stop(session);
});

test("(i) a first call after the recorded turn ended past the cache window is billed as reported", async () => {
  // `staleAfterMs` is the operator's statement of how long a session may idle
  // before its cache is assumed cold — the same window the staleness rotation
  // reads. The floor is raised out of the way so the turn does NOT rotate: this
  // asserts the guard's own window, not a rotation.
  const { rt, rotations } = adapter((i) => ({ calls: i === 0 ? CACHED : SWITCHED.slice(0, 1) }), {
    staleAfterMs: 50,
    staleFloorTokens: 1_000_000_000,
  });
  const session = await rt.start(def(), ctx());
  await rt.send(session, input("one"));
  await new Promise((r) => setTimeout(r, 150));
  const out = await rt.send(session, input("two"));
  assert.equal(rotations.length, 0, "fixture: the session was not rotated, only idled past the window");
  assert.deepEqual(out.tokensUsed, usageToTokens(summed(SWITCHED.slice(0, 1))), "and its cold first call is billed as reported");
  assert.equal(out.usageGuard, undefined);
  await rt.stop(session);
});

test("(j) a first call whose prompt is smaller than the previous turn's is billed as reported", async () => {
  const shrunk: Call[] = [
    { id: "s1", input: 40_000, output: 10 },
    { id: "s2", input: 41_000, output: 10, cacheRead: 40_000 },
  ];
  const { rt } = adapter((i) => ({ calls: i === 0 ? CACHED : shrunk }));
  const session = await rt.start(def(), ctx());
  await rt.send(session, input("one"));
  const out = await rt.send(session, input("two"));
  assert.deepEqual(out.tokensUsed, usageToTokens(summed(shrunk)), "40,000 < the previous turn's 60,890, and the second call reports its cache");
  assert.equal(out.usageGuard, undefined);
  await rt.stop(session);
});

test("(k) a session's first turn has no record, so its first call is billed as reported", async () => {
  const { rt } = adapter(() => ({ calls: SWITCHED }));
  const session = await rt.start(def(), ctx());
  const out = await rt.send(session, input("one"));
  assert.equal(out.usageGuard?.adjustedCalls, SWITCHED.length - 1, "only the first call goes unadjusted");
  assert.equal(out.usageGuard?.firstCallAdjustments, undefined, "there was no previous turn to judge it against");
  assert.deepEqual(out.tokensUsed, usageToTokens(summed(honest(SWITCHED))), "and the calls after it are billed exactly as they always were");
  await rt.stop(session);
});

test("(d) a shrunk prompt, a small prefix and a reported cache write are all billed as reported", async () => {
  const cases: Call[][] = [
    // Shrink: compaction or a rotation handed the call a smaller prompt.
    [{ id: "a1", input: 2_000, output: 10, cacheRead: 98_000 }, { id: "a2", input: 40_000, output: 10 }],
    // Below the floor.
    [{ id: "b1", input: 3_000, output: 10, cacheRead: 4_000 }, { id: "b2", input: 9_000, output: 10 }],
    // A cache WRITE is a cache report.
    [{ id: "c1", input: 1_000, output: 10, cacheRead: 50_000 }, { id: "c2", input: 1_500, output: 10, cacheWrite: 51_000 }],
  ];
  const { rt, reattributed } = adapter((i) => ({ calls: cases[i] }));
  const session = await rt.start(def(), ctx());
  for (const [i, calls] of cases.entries()) {
    const out = await rt.send(session, input(`case ${i}`));
    assert.deepEqual(out.tokensUsed, usageToTokens(summed(calls)), `case ${i}`);
    assert.equal(out.usageGuard, undefined, `case ${i}`);
  }
  assert.equal(reattributed().length, 0);
  await rt.stop(session);
});

test("(f) rotation measures the same context whether the backend reported the cache or dropped it", async () => {
  const turn = [...CACHED, ...SWITCHED];
  const dropped = adapter(() => ({ calls: turn }), { rotateAtContextTokens: 60_000 });
  const reported = adapter(() => ({ calls: honest(turn) }), { rotateAtContextTokens: 60_000 });
  const s1 = await dropped.rt.start(def(), ctx());
  const s2 = await reported.rt.start(def(), ctx());
  const a = await dropped.rt.send(s1, input("one"));
  const b = await reported.rt.send(s2, input("one"));
  assert.deepEqual(a.tokensUsed, b.tokensUsed);
  assert.equal(dropped.rt.rotationPending(s1)?.transcriptTokens, 64_139);
  assert.equal(reported.rt.rotationPending(s2)?.transcriptTokens, 64_139);
  await dropped.rt.stop(s1);
  await reported.rt.stop(s2);
});

test("an interrupted turn carries the adjusted figure on its error, as the live counter saw it", async () => {
  const turn = [...CACHED, ...SWITCHED];
  const { rt } = adapter(() => ({ calls: turn, awaitInterrupt: true }));
  const session = await rt.start(def(), ctx());
  const live: AgentOutput["tokensUsed"][] = [];
  const pending = rt.send(session, input("one", (t) => live.push(t)));
  await new Promise((r) => setTimeout(r, 30));
  await rt.interrupt(session);
  const err = await pending.then(
    () => assert.fail("an interrupted turn does not settle as a success"),
    (e: unknown) => e,
  );
  assert.ok(err instanceof InterruptedTurnError);
  assert.deepEqual(err.tokensUsed, usageToTokens(summed(honest(turn))));
  assert.deepEqual(err.tokensUsed, live.at(-1));
  await rt.stop(session);
});
