import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ClaudeRuntimeAdapter, type ClaudeAdapterOptions } from "../../packages/runtime-claude/src/index";
import { BackendUnreachableError } from "../../packages/protocol/src/index";
import type {
  AgentDefinition,
  AgentInput,
  RuntimeContext,
} from "../../packages/protocol/src/index";

/**
 * Session rotation is the only thing bounding transcript growth on a
 * streaming-input session: the mesh rebuilds its own context every turn, but
 * the SDK conversation behind it accumulates for the life of the query. These
 * tests drive the teardown -> open -> pump -> ready sequence against a fake
 * `query`, because the failure mode being guarded against is not "the numbers
 * are wrong" — it is an agent that goes UNREACHABLE mid-mission because the
 * replacement session never came up.
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
});

interface OpenedQuery {
  sdkSessionId: string;
  resumed: boolean;
  prompts: string[];
}

/**
 * Stands in for the SDK's `query`. One instance per `open` call, so the count
 * of these IS the count of CLI sessions the adapter believes it has spawned.
 *
 * `cacheReadPerTurn` is indexed by the query's spawn order rather than by turn,
 * which is what lets a test say "the first session was huge, the replacement
 * starts empty" without reaching into adapter internals.
 */
function fakeQueryFactory(opts: {
  cacheReadFor: (queryIndex: number, turnIndex: number) => number;
  failOnOpen?: (queryIndex: number) => boolean;
}) {
  const opened: OpenedQuery[] = [];

  const queryFn = (({ prompt, options }: { prompt: unknown; options: Record<string, unknown> }) => {
    const index = opened.length;
    const sdkSessionId = String(options.sessionId ?? options.resume ?? "unknown");
    const record: OpenedQuery = { sdkSessionId, resumed: options.resume !== undefined, prompts: [] };
    opened.push(record);

    const gen = (async function* () {
      if (opts.failOnOpen?.(index)) {
        throw new Error(`fake backend refused to start (query #${index})`);
      }
      yield {
        type: "system",
        subtype: "init",
        session_id: sdkSessionId,
        model: "claude-test",
        mcp_servers: [{ name: "mesh", status: "connected" }],
      };
      let turnIndex = 0;
      for await (const msg of prompt as AsyncIterable<{ message: { content: string } }>) {
        record.prompts.push(msg.message.content);
        yield {
          type: "result",
          subtype: "success",
          result: "acknowledged",
          session_id: sdkSessionId,
          num_turns: turnIndex + 1,
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: opts.cacheReadFor(index, turnIndex),
            cache_creation_input_tokens: 0,
          },
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

  return { queryFn, opened };
}

function workspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mesh-rotation-"));
}

test("a session under the rotation threshold is reused, not replaced", async () => {
  const dir = workspace();
  const { queryFn, opened } = fakeQueryFactory({ cacheReadFor: () => 1_000 });
  const rotations: unknown[] = [];
  const rt = new ClaudeRuntimeAdapter({
    queryFn,
    rotateAtContextTokens: 50_000,
    onRotate: (info) => rotations.push(info),
  });

  const session = await rt.start(devDef, runtimeCtx(dir));
  await rt.send(session, agentInput("turn one"));
  await rt.send(session, agentInput("turn two"));

  assert.equal(opened.length, 1, "a small transcript must not cost a new CLI session");
  assert.equal(rotations.length, 0);
  assert.deepEqual(opened[0].prompts, ["turn one", "turn two"]);

  await rt.stop(session);
});

test("crossing the threshold retires the SDK session and keeps serving the mesh one", async () => {
  const dir = workspace();
  // First session reports a transcript well past the threshold; the replacement
  // starts small, which is the whole point of retiring the old one.
  const { queryFn, opened } = fakeQueryFactory({
    cacheReadFor: (queryIndex) => (queryIndex === 0 ? 80_000 : 900),
  });
  const rotations: Array<Record<string, unknown>> = [];
  const rt = new ClaudeRuntimeAdapter({
    queryFn,
    rotateAtContextTokens: 50_000,
    onRotate: (info) => rotations.push(info as unknown as Record<string, unknown>),
  });

  const session = await rt.start(devDef, runtimeCtx(dir));
  const first = await rt.send(session, agentInput("turn one"));
  // The turn that reads the oversized transcript still completes — rotation is
  // a bound on the NEXT turn, not a failure of this one.
  assert.equal(first.tokensUsed.cacheRead, 80_000);
  assert.equal(opened.length, 1);

  const second = await rt.send(session, agentInput("turn two"));

  assert.equal(opened.length, 2, "the second turn must run on a freshly opened session");
  assert.notEqual(opened[1].sdkSessionId, opened[0].sdkSessionId);
  assert.equal(opened[1].resumed, false, "resuming would reload the transcript rotation just shed");
  assert.deepEqual(opened[0].prompts, ["turn one"], "the retired session must not receive the new turn");
  assert.deepEqual(opened[1].prompts, ["turn two"]);
  assert.equal(second.tokensUsed.cacheRead, 900);

  assert.equal(rotations.length, 1);
  assert.equal(rotations[0].agentId, "developer");
  assert.equal(rotations[0].meshSessionId, session.sessionId, "the mesh's id is the stable one");
  assert.equal(rotations[0].previousSdkSessionId, opened[0].sdkSessionId);
  assert.equal(rotations[0].sdkSessionId, opened[1].sdkSessionId);
  assert.equal(rotations[0].contextTokens, 80_010);
  assert.equal(rotations[0].rotations, 1);

  // The supervisor holds this session object for the life of the agent. If the
  // adapter re-keyed its live map on the SDK id, this call is where it breaks.
  assert.equal(await rt.getStatus(session), "IDLE");
  await rt.send(session, agentInput("turn three"));
  assert.equal(opened.length, 2, "a shed transcript must not immediately re-trip the threshold");
  assert.deepEqual(opened[1].prompts, ["turn two", "turn three"]);

  await rt.stop(session);
});

test("a rotation whose replacement never starts fails loudly instead of hanging", async () => {
  const dir = workspace();
  const { queryFn, opened } = fakeQueryFactory({
    cacheReadFor: () => 80_000,
    // The replacement, not the original: start must succeed so that the
    // failure lands exactly where it is hardest to recover from — mid-mission.
    failOnOpen: (queryIndex) => queryIndex === 1,
  });
  const rt = new ClaudeRuntimeAdapter({ queryFn, rotateAtContextTokens: 50_000 });

  const session = await rt.start(devDef, runtimeCtx(dir));
  await rt.send(session, agentInput("turn one"));

  await assert.rejects(
    () => rt.send(session, agentInput("turn two")),
    (err: unknown) => {
      assert.ok(err instanceof BackendUnreachableError, `expected BackendUnreachableError, got ${err}`);
      assert.match(String((err as Error).message), /rotation failed/);
      return true;
    },
  );

  assert.equal(opened.length, 2, "the replacement was attempted");
  // The supervisor decides what to do about an unreachable seat; the adapter's
  // duty is to stop claiming the agent is fine.
  assert.equal(await rt.getStatus(session), "UNREACHABLE");

  await rt.stop(session);
});
