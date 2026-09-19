import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ClaudeRuntimeAdapter, type ClaudeAdapterOptions } from "../../packages/runtime-claude/src/index";
import type { AgentDefinition, AgentInput, RuntimeContext } from "../../packages/protocol/src/index";

/**
 * A mute seat is an agent whose mesh MCP bridge did not attach.
 *
 * It is the worst shape of failure the runtime can produce, because every
 * liveness signal says it is fine: the CLI started, the session is up, turns
 * complete, tokens are billed. The agent simply cannot call back into the mesh,
 * so nothing it decides ever lands. Before this detector the only evidence was
 * a mission that stopped progressing for no visible reason.
 *
 * The backend reports its servers in the `init` frame, so this is knowable on
 * turn 1 rather than after a stall timeout — which is the whole point of
 * reading it rather than inferring it from silence.
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

const agentInput = (instructions: string): AgentInput => ({
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
    budgetSnapshot: { agentTokensUsed: 0, agentTokenBudget: 0, missionTokensUsed: 0, missionTokenBudget: 0 },
    outstanding: { awaitingResponse: [], owedByYou: [] },
    goalCriteria: [],
  },
  instructions,
});

/** Same shape as the rotation harness's fake, with the server list under test. */
function fakeQuery(servers: Array<{ name: string; status: string }>) {
  return (({ prompt, options }: { prompt: unknown; options: Record<string, unknown> }) => {
    const sdkSessionId = String(options.sessionId ?? options.resume ?? "unknown");
    const gen = (async function* () {
      yield {
        type: "system",
        subtype: "init",
        session_id: sdkSessionId,
        model: "claude-test",
        mcp_servers: servers,
      };
      let turnIndex = 0;
      for await (const _msg of prompt as AsyncIterable<{ message: { content: string } }>) {
        void _msg;
        yield {
          type: "result",
          subtype: "success",
          result: "acknowledged",
          session_id: sdkSessionId,
          num_turns: turnIndex + 1,
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
        };
        turnIndex++;
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

const workspace = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "mesh-mute-"));

test("a seat whose mesh bridge attached raises nothing", async () => {
  const muted: unknown[] = [];
  const rt = new ClaudeRuntimeAdapter({
    queryFn: fakeQuery([{ name: "mesh", status: "connected" }]),
    onMuteSuspected: (i) => muted.push(i),
  });
  const s = await rt.start(devDef, runtimeCtx(workspace()));
  await rt.send(s, agentInput("go"));
  await rt.stop(s);
  assert.equal(muted.length, 0, "a healthy bridge must not raise a mute alarm");
});

test("a seat with no mesh server at all is reported mute", async () => {
  const muted: Array<{ agentId: string; meshBridgeAttached: boolean }> = [];
  const rt = new ClaudeRuntimeAdapter({
    queryFn: fakeQuery([{ name: "some-other-tool", status: "connected" }]),
    onMuteSuspected: (i) => muted.push(i),
  });
  const s = await rt.start(devDef, runtimeCtx(workspace()));
  await rt.send(s, agentInput("go"));
  await rt.stop(s);
  assert.equal(muted.length, 1);
  assert.equal(muted[0]!.agentId, "developer");
  assert.equal(muted[0]!.meshBridgeAttached, false);
});

/**
 * The case that motivates reading `status` rather than just the name: a bridge
 * that is configured and failed to connect is exactly as mute as one that was
 * never configured, but it is present in the list.
 */
test("a mesh server present but not connected still counts as mute", async () => {
  const muted: Array<{ servers: Array<{ name: string; status: string }> }> = [];
  const rt = new ClaudeRuntimeAdapter({
    queryFn: fakeQuery([{ name: "mesh", status: "failed" }]),
    onMuteSuspected: (i) => muted.push(i),
  });
  const s = await rt.start(devDef, runtimeCtx(workspace()));
  await rt.send(s, agentInput("go"));
  await rt.stop(s);
  assert.equal(muted.length, 1);
  assert.deepEqual(muted[0]!.servers, [{ name: "mesh", status: "failed" }]);
});

test("the alarm fires once per session, not once per turn", async () => {
  const muted: unknown[] = [];
  const rt = new ClaudeRuntimeAdapter({
    queryFn: fakeQuery([]),
    onMuteSuspected: (i) => muted.push(i),
  });
  const s = await rt.start(devDef, runtimeCtx(workspace()));
  await rt.send(s, agentInput("one"));
  await rt.send(s, agentInput("two"));
  await rt.send(s, agentInput("three"));
  await rt.stop(s);
  assert.equal(muted.length, 1, "three turns on one mute session is still one seat being broken");
});
