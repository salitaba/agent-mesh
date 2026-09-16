import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ClaudeRuntimeAdapter, type ClaudeAdapterOptions } from "../../packages/runtime-claude/src/index";
import { collectAgentOutput } from "../../packages/agent-runtime/src/index";
import type {
  AgentDefinition,
  AgentEvent,
  AgentEventTurnEnd,
  AgentInput,
  RuntimeContext,
} from "../../packages/protocol/src/index";

/**
 * `AgentRuntime.stream` is the live half of a turn; `send` is the same turn
 * folded back into the struct the supervisor reads. These tests pin the two
 * together, because the failure mode being guarded against is not "an event is
 * shaped wrong" — it is the two paths drifting until a turn reports one thing
 * live and another at the end.
 */

const devDef: AgentDefinition = {
  id: "developer",
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
};

function runtimeCtx(dir: string): RuntimeContext {
  return {
    goalId: "goal-1",
    meshId: "test",
    workspacePath: dir,
    busUrl: "http://127.0.0.1:1",
    agentToken: "test:developer:abcd",
    rolePromptText: "you build things",
    capabilityGrants: devDef.capabilities,
    env: {},
  };
}

const agentInput = (instructions: string, onToken?: (d: string) => void): AgentInput => ({
  agentId: "developer",
  goalId: "goal-1",
  activation: { kind: "manual" },
  context: {
    rolePrompt: "x",
    mission: "m",
    relevantPolicies: [],
    agentState: {
      agentId: "developer",
      lifecycle: "THINKING",
      mailboxDepth: 0,
      currentArtifactIds: [],
      tokensConsumed: 0,
      activations: 0,
      lastActivityAt: "",
    },
    relevantDecisions: [],
    relevantArtifacts: [],
    unreadMail: [],
    recentOwnActivity: [],
    agentMemory: [],
    openThreads: [],
    budgetSnapshot: {
      agentTokensUsed: 0,
      agentTokenBudget: 0,
      missionTokensUsed: 0,
      missionTokenBudget: 0,
    },
    outstanding: { awaitingResponse: [], owedByYou: [] },
    goalCriteria: [],
  },
  instructions,
  ...(onToken ? { onToken } : {}),
});

/** One tool call, two text deltas, one result — the shape of an ordinary turn. */
function streamingQueryFn(): ClaudeAdapterOptions["queryFn"] {
  return (({ prompt, options }: { prompt: unknown; options: Record<string, unknown> }) => {
    const sdkSessionId = String(options.sessionId ?? options.resume ?? "unknown");
    const gen = (async function* () {
      yield {
        type: "system",
        subtype: "init",
        session_id: sdkSessionId,
        model: "claude-test",
        mcp_servers: [{ name: "mesh", status: "connected" }],
      };
      for await (const _ of prompt as AsyncIterable<{ message: { content: string } }>) {
        yield {
          type: "assistant",
          message: {
            model: "claude-test",
            content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file: "a.ts" } }],
          },
        };
        yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello " } } };
        yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "world" } } };
        yield {
          type: "result",
          subtype: "success",
          result: "hello world",
          session_id: sdkSessionId,
          num_turns: 1,
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
        };
      }
    })();
    return Object.assign(gen, {
      interrupt: async () => undefined,
      setPermissionMode: async () => undefined,
      setModel: async () => undefined,
      supportedModels: async () => [],
      supportedCommands: async () => [],
      mcpServerStatus: async () => ({}),
    });
  }) as unknown as ClaudeAdapterOptions["queryFn"];
}

const workspace = () => fs.mkdtempSync(path.join(os.tmpdir(), "mesh-stream-"));

test("stream yields live frames and exactly one terminal turn_end", async () => {
  const rt = new ClaudeRuntimeAdapter({ queryFn: streamingQueryFn() });
  const session = await rt.start(devDef, runtimeCtx(workspace()));

  const kinds: string[] = [];
  let end: AgentEventTurnEnd | undefined;
  for await (const ev of rt.stream(session, agentInput("go"))) {
    kinds.push(ev.kind);
    if (ev.kind === "turn_end") end = ev;
  }

  assert.deepEqual(kinds, ["tool_call", "agent_message_chunk", "agent_message_chunk", "turn_end"]);
  assert.equal(kinds.at(-1), "turn_end", "turn_end must be the terminal frame");
  assert.equal(end?.stopReason, "end_turn");
  assert.equal(end?.text, "hello world", "the result frame is authoritative, not the concatenated deltas");
});

test("send folds the same turn into the output the supervisor reads, and still fires onToken", async () => {
  const rt = new ClaudeRuntimeAdapter({ queryFn: streamingQueryFn() });
  const session = await rt.start(devDef, runtimeCtx(workspace()));

  const deltas: string[] = [];
  const out = await rt.send(session, agentInput("go", (d) => deltas.push(d)));

  // Without this the supervisor's silence watchdog never sees firstTokenAt and
  // force-settles every streaming turn.
  assert.deepEqual(deltas, ["hello ", "world"], "text deltas must still reach onToken through the fold");
  assert.equal(out.text, "hello world");
  assert.equal(out.toolCalls?.length, 1);
  assert.equal(out.toolCalls?.[0]?.name, "Read");
  assert.equal(out.model, "claude-test");
  assert.equal(out.error, undefined);
  assert.equal(out.tokensUsed.input, 10);
  assert.equal(out.tokensUsed.output, 5);
  assert.equal(out.tokensUsed.total, 16, "cache_creation counts toward the turn, cache_read never does");
  assert.equal(out.tokensUsed.cacheRead, 2);
});

test("a stream that ends without turn_end fails the turn instead of reporting an empty one", async () => {
  async function* truncated(): AsyncGenerator<AgentEvent, void> {
    yield { kind: "agent_message_chunk", delta: "partial" };
  }
  await assert.rejects(
    () => collectAgentOutput(truncated(), {}),
    /turn_end/,
    "a backend that vanishes mid-turn must not look like a successful empty turn",
  );
});

test("the fold correlates tool results by id, not by arrival order", async () => {
  async function* interleaved(): AsyncGenerator<AgentEvent, void> {
    yield { kind: "tool_call", toolCallId: "a", name: "Read", args: {} };
    yield { kind: "tool_call", toolCallId: "b", name: "Bash", args: {} };
    yield { kind: "tool_call_update", toolCallId: "b", status: "completed", resultDigest: "digest-b" };
    yield { kind: "tool_call_update", toolCallId: "a", status: "completed", resultDigest: "digest-a" };
    yield { kind: "turn_end", stopReason: "end_turn", text: "", operations: [], tokensUsed: { input: 0, output: 0, total: 0 } };
  }
  const out = await collectAgentOutput(interleaved(), {});
  assert.deepEqual(
    out.toolCalls?.map((c) => [c.name, c.resultDigest]),
    [["Read", "digest-a"], ["Bash", "digest-b"]],
    "results arriving out of order must land on the call they belong to",
  );
});

test("thinking is never forwarded as transcript", async () => {
  const deltas: string[] = [];
  async function* thinking(): AsyncGenerator<AgentEvent, void> {
    yield { kind: "agent_thought_chunk", delta: "reasoning aloud" };
    yield { kind: "agent_message_chunk", delta: "answer" };
    yield { kind: "turn_end", stopReason: "end_turn", text: "answer", operations: [], tokensUsed: { input: 0, output: 0, total: 0 } };
  }
  await collectAgentOutput(thinking(), { onToken: (d) => deltas.push(d) });
  assert.deepEqual(deltas, ["answer"], "a send op quoted while reasoning is not a request to send anything");
});
