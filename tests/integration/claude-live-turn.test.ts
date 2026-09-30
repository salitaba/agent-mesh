import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ClaudeRuntimeAdapter, usageToTokens, type ClaudeAdapterOptions } from "../../packages/runtime-claude/src/index";
import {
  InterruptedTurnError,
  TurnTimeoutError,
  isConnectionError,
  isTimeoutError,
  type AgentDefinition,
  type AgentInput,
  type AgentOutput,
  type RuntimeContext,
} from "../../packages/protocol/src/index";

/**
 * What a long, working turn looks like from the Claude adapter: the live usage
 * it reports while it runs, the notes the mesh can put in front of it mid-turn,
 * and how its own backstop timer ends it.
 *
 * The incident these cover: a seat ~94 native Write/Edit/Bash calls into a turn,
 * last frame 17s old, was killed at the base timeout. Its cost was invisible
 * until the end ("— tok" for twenty minutes), it got no warning it could act
 * on, and the adapter's own timer — armed at base + 30s, past which no
 * supervisor extension could reach — settled an untyped Error (the crash
 * ladder) and dropped the abort's usage-bearing `result` frame (unbilled).
 *
 * The fake `query` speaks the frame sequence the CLI emits with
 * `includePartialMessages`, and exposes the options the adapter passed, so the
 * tool-boundary hook can be driven the way the CLI drives it.
 */

type Frame = Record<string, unknown>;
interface TurnCtl {
  options: Record<string, unknown>;
  /** Resolves when the adapter calls `interrupt()` during this turn. */
  interrupted: Promise<void>;
  sid: string;
}
type TurnScript = (ctl: TurnCtl) => AsyncGenerator<Frame, void>;

function scriptedQuery(turns: TurnScript[]) {
  const seen = { options: undefined as Record<string, unknown> | undefined, interrupts: 0, opened: 0 };
  const queryFn = (({ prompt, options }: { prompt: unknown; options: Record<string, unknown> }) => {
    seen.options = options;
    seen.opened++;
    const sid = String(options.sessionId ?? options.resume ?? "fake");
    let release: () => void = () => undefined;
    const gen = (async function* () {
      yield { type: "system", subtype: "init", session_id: sid, model: "claude-test", mcp_servers: [{ name: "mesh", status: "connected" }] };
      let i = 0;
      for await (const _msg of prompt as AsyncIterable<unknown>) {
        const interrupted = new Promise<void>((r) => (release = r));
        const script = turns[Math.min(i++, turns.length - 1)];
        yield* script({ options, interrupted, sid });
      }
    })();
    return Object.assign(gen, {
      interrupt: async () => {
        seen.interrupts++;
        release();
      },
      close: () => undefined,
      setPermissionMode: async () => undefined,
      setModel: async () => undefined,
      supportedModels: async () => [],
      supportedCommands: async () => [],
      mcpServerStatus: async () => ({}),
    });
  }) as unknown as ClaudeAdapterOptions["queryFn"];
  return { queryFn, seen };
}

type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; output_tokens_details?: { thinking_tokens: number } };

const start = (sid: string, id: string, usage: Usage): Frame => ({
  type: "stream_event",
  parent_tool_use_id: null,
  session_id: sid,
  event: { type: "message_start", message: { id, model: "claude-test", role: "assistant", content: [], usage } },
});
const assistant = (sid: string, id: string, usage: Usage, content: unknown[] = []): Frame => ({
  type: "assistant",
  parent_tool_use_id: null,
  session_id: sid,
  message: { id, model: "claude-test", content, usage },
});
const delta = (sid: string, usage: Usage): Frame => ({
  type: "stream_event",
  parent_tool_use_id: null,
  session_id: sid,
  event: { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage },
});
const toolResult = (sid: string, id: string, isError = false): Frame => ({
  type: "user",
  session_id: sid,
  parent_tool_use_id: null,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: isError ? "exit 1" : "ok", is_error: isError }] },
});
const success = (sid: string, usage: Usage = {}): Frame => ({ type: "result", subtype: "success", is_error: false, result: "done", session_id: sid, num_turns: 1, usage });
const aborted = (sid: string, usage: Usage = {}): Frame => ({ type: "result", subtype: "error_during_execution", is_error: true, session_id: sid, usage, errors: ["Request was aborted."] });

type Hook = (input: unknown, toolUseID: string | undefined, opts: { signal: AbortSignal }) => Promise<Record<string, unknown>>;

/** Fire the adapter's hooks for one tool boundary, as the CLI would. */
async function fireHook(
  options: Record<string, unknown>,
  event: "PostToolUse" | "PostToolUseFailure",
  toolUseId: string,
  over: { toolName?: string; toolResponse?: unknown } = {},
): Promise<Array<Record<string, unknown>>> {
  const matchers = ((options.hooks ?? {}) as Record<string, Array<{ hooks: Hook[] }>>)[event] ?? [];
  const out: Array<Record<string, unknown>> = [];
  const input = {
    hook_event_name: event,
    session_id: "s",
    transcript_path: "",
    cwd: "",
    tool_name: over.toolName ?? "Bash",
    tool_input: { command: "npm test" },
    tool_use_id: toolUseId,
    ...(event === "PostToolUse" ? { tool_response: over.toolResponse ?? "ok" } : { error: "exit 1" }),
  };
  for (const m of matchers) for (const h of m.hooks) out.push(await h(input, toolUseId, { signal: new AbortController().signal }));
  return out;
}
const contextOf = (results: Array<Record<string, unknown>>): string[] =>
  results
    .map((r) => (r.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext)
    .filter((c): c is string => typeof c === "string");

const def: AgentDefinition = {
  id: "backend",
  role: "developer",
  mode: "peer",
  runtime: "claude",
  prompt: { text: "you build things" },
  capabilities: ["repository.write", "shell.execute"],
  authority: [],
  communicationPolicy: { mayContact: [], mayBeContactedBy: [] },
  interests: [],
  sessionPolicy: { persistent: true },
  delegationPolicy: { allowDelegation: false, maxDepth: 0, maxWorkers: 0 },
  budget: {},
};

const ctx = (): RuntimeContext => ({
  goalId: "goal-1",
  meshId: "test",
  workspacePath: fs.mkdtempSync(path.join(os.tmpdir(), "mesh-claude-live-")),
  busUrl: "http://127.0.0.1:1",
  agentToken: "t",
  rolePromptText: "you build things",
  capabilityGrants: def.capabilities,
  env: {},
});

const input = (instructions: string, over: Partial<AgentInput> = {}): AgentInput => ({
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
  ...over,
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

// ------------------------------------------------------------ usage_update

test("usage_update is the turn's cumulative usage, counting each API call once however many frames report it", async () => {
  // Anthropic's shape: input terms on message_start, an assistant frame per
  // content block (same message id, usage "not final"), and a message_delta
  // that may carry output alone.
  const callA = { input_tokens: 100, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 50 };
  const callB = { input_tokens: 10, cache_read_input_tokens: 1_200, cache_creation_input_tokens: 0 };
  const { queryFn } = scriptedQuery([
    async function* ({ sid }) {
      yield start(sid, "msg_A", { ...callA, output_tokens: 1 });
      yield assistant(sid, "msg_A", { ...callA, output_tokens: 5 }, [{ type: "text", text: "running tests" }]);
      yield assistant(sid, "msg_A", { ...callA, output_tokens: 20 }, [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "npm test" } }]);
      yield delta(sid, { output_tokens: 30 });
      yield toolResult(sid, "tu_1");
      yield start(sid, "msg_B", { ...callB, output_tokens: 1 });
      yield assistant(sid, "msg_B", { ...callB, output_tokens: 7 }, [{ type: "text", text: "green" }]);
      yield delta(sid, { ...callB, output_tokens: 40, output_tokens_details: { thinking_tokens: 12 } });
      yield success(sid, { input_tokens: 110, output_tokens: 70, cache_read_input_tokens: 2_200, cache_creation_input_tokens: 50 });
    },
    // The 2026-09-25 proxy's shape: zeros on message_start and every assistant
    // frame, the real figures only on message_delta.
    async function* ({ sid }) {
      const zero = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      yield start(sid, "msg_P", zero);
      yield assistant(sid, "msg_P", zero, [{ type: "text", text: "hi" }]);
      yield assistant(sid, "msg_P", zero, [{ type: "tool_use", id: "tu_2", name: "Read", input: {} }]);
      yield delta(sid, { input_tokens: 7_308, cache_read_input_tokens: 37_248, cache_creation_input_tokens: 0, output_tokens: 1_444 });
      yield success(sid, { input_tokens: 7_308, output_tokens: 1_444, cache_read_input_tokens: 37_248 });
    },
  ]);
  const rt = new ClaudeRuntimeAdapter({ queryFn });
  const session = await rt.start(def, ctx());
  try {
    const updates: Array<AgentOutput["tokensUsed"]> = [];
    const out = await rt.send(session, input("one", { onUsage: (t) => updates.push(t) }));
    const final = { input: 110, output: 70, total: 110 + 70 + 50, cacheRead: 2_200, thinking: 12 };
    assert.deepEqual(updates.at(-1), final, "input + output + cacheWrite in total, cacheRead apart, thinking alongside");
    assert.deepEqual(out.tokensUsed, usageToTokens({ input_tokens: 110, output_tokens: 70, cache_read_input_tokens: 2_200, cache_creation_input_tokens: 50 }), "turn_end still carries the result frame's figure");
    for (let i = 1; i < updates.length; i++) {
      assert.ok(updates[i].total >= updates[i - 1].total, `cumulative, never a per-call delta (update ${i})`);
    }
    assert.ok(updates.every((u) => u.total <= final.total && (u.cacheRead ?? 0) <= final.cacheRead), "no update ever counted a call twice");
    // A frame-summing fold would have billed msg_A's input terms four times.
    assert.ok(updates.length >= 4 && updates.length <= 8, `one update per frame that moved the figure, not per frame (${updates.length})`);

    const proxied: Array<AgentOutput["tokensUsed"]> = [];
    await rt.send(session, input("two", { onUsage: (t) => proxied.push(t) }));
    assert.equal(proxied.length, 1, "all-zero frames move nothing and report nothing");
    assert.deepEqual(proxied[0], { input: 7_308, output: 1_444, total: 7_308 + 1_444, cacheRead: 37_248 });
  } finally {
    await rt.stop(session);
  }
});

// ------------------------------------------------------------ advise

test("advise queues a note only while a turn runs, and the tool-boundary hook delivers it exactly once", async () => {
  const midTurn = deferred();
  const noted = deferred();
  const hookResults: Array<Array<Record<string, unknown>>> = [];
  const { queryFn } = scriptedQuery([
    async function* ({ sid, options }) {
      yield start(sid, "msg_1", { input_tokens: 10, output_tokens: 1 });
      yield assistant(sid, "msg_1", { input_tokens: 10, output_tokens: 3 }, [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "npm test" } }]);
      midTurn.resolve();
      await noted.promise;
      hookResults.push(await fireHook(options, "PostToolUse", "tu_1"));
      hookResults.push(await fireHook(options, "PostToolUse", "tu_2"));
      yield toolResult(sid, "tu_1");
      yield success(sid);
    },
  ]);
  const rt = new ClaudeRuntimeAdapter({ queryFn });
  const session = await rt.start(def, ctx());
  try {
    assert.equal(rt.advise(session, "too early"), false, "no turn in flight: nothing to fold the note into");
    const turn = rt.send(session, input("build it"));
    await midTurn.promise;
    assert.equal(rt.advise(session, "Deadline in 5 minutes: commit what you have."), true);
    assert.equal(rt.advise(session, "Publish before you close."), true);
    noted.resolve();
    await turn;
    assert.deepEqual(contextOf(hookResults[0]), ["Deadline in 5 minutes: commit what you have.\n\nPublish before you close."], "both notes, joined, on the next tool boundary");
    assert.equal((hookResults[0].find((r) => r.hookSpecificOutput) as { hookSpecificOutput: { hookEventName: string } }).hookSpecificOutput.hookEventName, "PostToolUse");
    assert.deepEqual(contextOf(hookResults[1]), [], "delivered once: the next boundary carries nothing");
    assert.ok(hookResults[1].every((r) => r.continue === true), "and the hook lets the tool result through untouched");
    assert.equal(rt.advise(session, "too late"), false, "the turn settled: nothing is running");
  } finally {
    await rt.stop(session);
  }
});

test("a failing tool delivers the note too, and a note that met no tool boundary dies with its turn", async () => {
  const midTurn = deferred();
  const noted = deferred();
  const results: Record<string, Array<Record<string, unknown>>> = {};
  const { queryFn } = scriptedQuery([
    // Turn 1: the only tool call FAILS (a red test run) — PostToolUseFailure.
    async function* ({ sid, options }) {
      yield assistant(sid, "msg_1", { input_tokens: 10, output_tokens: 3 }, [{ type: "tool_use", id: "tu_f", name: "Bash", input: {} }]);
      midTurn.resolve();
      await noted.promise;
      results.failure = await fireHook(options, "PostToolUseFailure", "tu_f");
      yield toolResult(sid, "tu_f", true);
      yield success(sid);
    },
    // Turn 2: the note is queued, but the turn ends without another tool call.
    async function* ({ sid }) {
      yield assistant(sid, "msg_2", { input_tokens: 10, output_tokens: 3 }, [{ type: "text", text: "done" }]);
      await new Promise((r) => setTimeout(r, 20));
      yield success(sid);
    },
    // Turn 3: a tool boundary — which must not surface turn 2's note.
    async function* ({ sid, options }) {
      results.next = await fireHook(options, "PostToolUse", "tu_3");
      yield success(sid);
    },
  ]);
  const rt = new ClaudeRuntimeAdapter({ queryFn });
  const session = await rt.start(def, ctx());
  try {
    const t1 = rt.send(session, input("one"));
    await midTurn.promise;
    assert.equal(rt.advise(session, "wrap up"), true);
    noted.resolve();
    await t1;
    assert.deepEqual(contextOf(results.failure), ["wrap up"]);
    assert.equal((results.failure.find((r) => r.hookSpecificOutput) as { hookSpecificOutput: { hookEventName: string } }).hookSpecificOutput.hookEventName, "PostToolUseFailure");

    const t2 = rt.send(session, input("two"));
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(rt.advise(session, "stale note"), true);
    await t2;
    await rt.send(session, input("three"));
    assert.deepEqual(contextOf(results.next), [], "a note never leaks into the next turn");
  } finally {
    await rt.stop(session);
  }
});

test("an operator's own hooks run beside the advice hook, not instead of it", async () => {
  const { queryFn, seen } = scriptedQuery([async function* ({ sid }) { yield success(sid); }]);
  const mine = async () => ({ continue: true });
  const rt = new ClaudeRuntimeAdapter({ queryFn, extraOptions: { hooks: { PostToolUse: [{ hooks: [mine] }] } } });
  const session = await rt.start(def, ctx());
  try {
    const hooks = seen.options?.hooks as Record<string, Array<{ hooks: unknown[] }>>;
    assert.equal(hooks.PostToolUse.length, 2, "the operator's matcher and the advice hook");
    assert.equal(hooks.PostToolUse[0].hooks[0], mine);
    assert.equal(hooks.PostToolUseFailure.length, 1);
  } finally {
    await rt.stop(session);
  }
});

test("the reading brief rides in the system prompt, beside the shared output-voice rules", async () => {
  const { queryFn, seen } = scriptedQuery([async function* ({ sid }) { yield success(sid); }]);
  const rt = new ClaudeRuntimeAdapter({ queryFn });
  const session = await rt.start(def, ctx());
  try {
    const prompt = ((seen.options?.systemPrompt ?? {}) as { prompt?: string }).prompt ?? "";
    assert.match(prompt, /^you build things/, "the role prose still leads");
    assert.match(prompt, /## Output voice/, "the shared rules are still appended by withOutputVoice");
    assert.match(prompt, /## Reading/);
    assert.match(prompt, /grep -n/);
    assert.match(prompt, /Never read a file you have already read this session/);
    // Billed on every turn: it has to stay small enough to pay for itself.
    assert.ok(prompt.split("## Reading")[1].length < 700, "a handful of lines, not an essay");
  } finally {
    await rt.stop(session);
  }
});

// ------------------------------------------------------------ backstop timer

test("the adapter's backstop ends a turn as a TIMEOUT carrying the abort's usage, and the session survives", async () => {
  const summed = { input_tokens: 4_000, output_tokens: 900, cache_read_input_tokens: 60_000, cache_creation_input_tokens: 200 };
  const { queryFn, seen } = scriptedQuery([
    async function* ({ sid, interrupted }) {
      yield start(sid, "msg_1", { input_tokens: 4_000, cache_read_input_tokens: 60_000, cache_creation_input_tokens: 200, output_tokens: 1 });
      yield assistant(sid, "msg_1", { input_tokens: 4_000, output_tokens: 300 }, [{ type: "tool_use", id: "tu_1", name: "Write", input: {} }]);
      await interrupted; // still working when the deadline fires
      yield aborted(sid, summed);
    },
    async function* ({ sid }) { yield success(sid); },
  ]);
  const rt = new ClaudeRuntimeAdapter({ queryFn, turnTimeoutMs: 150 });
  const session = await rt.start(def, ctx());
  try {
    const err = await rt.send(session, input("long build")).then(
      () => assert.fail("the turn must not complete"),
      (e: unknown) => e,
    );
    assert.ok(err instanceof TurnTimeoutError, `typed as a timeout, not an untyped Error (got ${String(err)})`);
    assert.equal(isTimeoutError(err), true, "`isTimeoutError` routes it to slow, never the crash ladder");
    assert.equal(isConnectionError(err), false);
    assert.equal(err.timeoutMs, 150);
    assert.deepEqual(err.tokensUsed, usageToTokens(summed), "the abort's result frame is billed, not dropped");
    assert.equal(err.model, "claude-test");
    assert.match(err.message, /backstop/, "the audit can tell which deadline fired");
    assert.equal(seen.interrupts, 1);
    assert.equal(await rt.getStatus(session), "IDLE", "the CLI answered the abort: alive and between turns");
    const next = await rt.send(session, input("retry"));
    assert.equal(next.error, undefined, "and the same session serves the retry");
    assert.equal(seen.opened, 1, "no respawn");
  } finally {
    await rt.stop(session);
  }
});

test("an abort the CLI never answers still ends as a timeout, billed from the frames, and the session is torn down", async () => {
  const { queryFn, seen } = scriptedQuery([
    async function* ({ sid }) {
      yield start(sid, "msg_1", { input_tokens: 500, cache_read_input_tokens: 9_000, output_tokens: 1 });
      yield delta(sid, { input_tokens: 500, cache_read_input_tokens: 9_000, output_tokens: 250 });
      await new Promise(() => undefined); // wedged: ignores the abort
    },
  ]);
  const rt = new ClaudeRuntimeAdapter({ queryFn, turnTimeoutMs: 100 });
  const session = await rt.start(def, ctx());
  const began = Date.now();
  const err = await rt.send(session, input("wedge")).then(
    () => assert.fail("the turn must not complete"),
    (e: unknown) => e,
  );
  const took = Date.now() - began;
  assert.ok(err instanceof TurnTimeoutError, String(err));
  assert.equal(isTimeoutError(err), true);
  assert.deepEqual(err.tokensUsed, { input: 500, output: 250, total: 750, cacheRead: 9_000 }, "no result frame: the per-call frames are the only figure, and they are kept");
  assert.ok(took >= 100 + 2_000 - 50 && took < 100 + 2_000 + 1_500, `bounded grace for the answer (${took}ms)`);
  assert.equal(seen.interrupts, 1);
  // A CLI that ignored the abort could still answer it later, into whichever
  // turn was pending by then. Torn down, so the retry resumes a fresh one.
  assert.equal(await rt.getStatus(session), "UNREACHABLE");
});

test("a mesh interrupt the CLI never answers settles the turn instead of leaving it in flight", async () => {
  const entered = deferred();
  const { queryFn } = scriptedQuery([
    async function* ({ sid }) {
      yield assistant(sid, "msg_1", { input_tokens: 10, output_tokens: 3 }, [{ type: "tool_use", id: "tu_1", name: "Bash", input: {} }]);
      entered.resolve();
      await new Promise(() => undefined);
    },
  ]);
  // The backstop is far away: before this, only it could clear the turn, and
  // every retry in between died on "turn already in flight" — an untyped Error.
  const rt = new ClaudeRuntimeAdapter({ queryFn, turnTimeoutMs: 600_000 });
  const session = await rt.start(def, ctx());
  const turn = rt.send(session, input("stall"));
  await entered.promise;
  assert.equal(rt.advise(session, "x"), true, "fixture: the turn is running");
  await rt.interrupt(session);
  assert.equal(rt.advise(session, "x"), false, "a turn being stopped takes no more notes");
  const err = await turn.then(
    () => assert.fail("the turn must not complete"),
    (e: unknown) => e,
  );
  assert.ok(err instanceof InterruptedTurnError, String(err));
  assert.equal(isTimeoutError(err), true, "a deliberate stop, not a crash");
  assert.equal(await rt.getStatus(session), "UNREACHABLE", "torn down, so a late answer cannot settle the retry");
});
