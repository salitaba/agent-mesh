import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ClaudeRuntimeAdapter, rotateAtFor, type ClaudeAdapterOptions } from "../../packages/runtime-claude/src/index";
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
        // Echoed rather than fixed, because the real CLI reports the model it
        // actually seated and the adapter derives the rotation threshold from
        // that. A test that pins no model still gets the old placeholder —
        // which no window table recognises, so it rotates conservatively.
        model: String(options.model ?? "claude-test"),
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

test("the rotation threshold is derived from the seated model's context window", () => {
  // 60% of the window, which is the ratio this bound has always carried — it
  // was simply written down as the single number 120k, and 120k IS 60% of
  // Haiku 4.5's 200k. Nothing about the policy moved; its denominator just
  // stopped being the same for every model.
  assert.equal(rotateAtFor("claude-haiku-4-5"), 120_000);
  assert.equal(rotateAtFor("claude-opus-5"), 600_000);
  assert.equal(rotateAtFor("claude-sonnet-5"), 600_000);
  // mesh.yaml may carry a provider-qualified ref for the sake of one `model:`
  // key across runtimes; the threshold resolves off the reduced id.
  assert.equal(rotateAtFor("anthropic/claude-opus-5"), 600_000);
});

test("a model id nobody recognises rotates at the conservative floor", () => {
  // toClaudeModelId validates nothing — every string below survives it intact
  // — so this table lookup is the only thing between a typo and a seat that
  // rotates hundreds of thousands of tokens after its window has overflowed.
  assert.equal(rotateAtFor("totally-not-a-model"), 120_000);
  assert.equal(
    rotateAtFor("claude-opus-5-20260401"),
    120_000,
    "dated ids are not this repo's convention; a near-miss is not read as Opus",
  );
  assert.equal(
    rotateAtFor("openrouter/anthropic/claude-opus-5"),
    120_000,
    "only the first slash is stripped, so what is left is not a bare id",
  );
  assert.equal(rotateAtFor(undefined), 120_000, "no model named means the CLI's default, which we cannot place");
  assert.equal(rotateAtFor(""), 120_000);
  // The direction of the failure is the point: whatever the string, an
  // unplaceable id may round the threshold DOWN and never up.
  for (const junk of ["   ", "claude", "claude-opus-6", "gpt-5", "/leading", "trailing/", "claude-haiku-4-5-turbo"]) {
    assert.ok(rotateAtFor(junk) <= 120_000, `"${junk}" must not buy a larger threshold than the floor`);
  }
});

test("a large-window seat keeps a transcript that would retire a small-window one", async () => {
  const dir = workspace();
  // 200k read per turn: well past the 120k this was hardcoded at, and nowhere
  // near Opus 5's derived 600k. No rotateAtContextTokens here on purpose —
  // the model is what decides.
  const { queryFn, opened } = fakeQueryFactory({ cacheReadFor: () => 200_000 });
  const rotations: unknown[] = [];
  const rt = new ClaudeRuntimeAdapter({ queryFn, onRotate: (info) => rotations.push(info) });

  const session = await rt.start({ ...devDef, model: "claude-opus-5" }, runtimeCtx(dir));
  await rt.send(session, agentInput("turn one"));
  await rt.send(session, agentInput("turn two"));

  assert.equal(opened.length, 1, "600k of usable window must not be shed at 120k");
  assert.equal(rotations.length, 0);

  await rt.stop(session);
});

test("an unrecognised model id rotates at the floor rather than gamble on the window", async () => {
  const dir = workspace();
  const { queryFn, opened } = fakeQueryFactory({
    cacheReadFor: (queryIndex) => (queryIndex === 0 ? 200_000 : 900),
  });
  const rt = new ClaudeRuntimeAdapter({ queryFn });

  // Identical traffic to the test above; only the id changed, by one typo.
  // Reading it as Opus-shaped and granting it 600k is how a seat that is
  // really a 200k model gets run off the end of its context window.
  const session = await rt.start({ ...devDef, model: "claude-opus-5-typo" }, runtimeCtx(dir));
  await rt.send(session, agentInput("turn one"));
  await rt.send(session, agentInput("turn two"));

  assert.equal(opened.length, 2, "an id we cannot place falls back to 120k, not to the largest window we know");

  await rt.stop(session);
});

test("an explicitly injected threshold still overrides the derived one", async () => {
  const dir = workspace();
  const { queryFn, opened } = fakeQueryFactory({
    cacheReadFor: (queryIndex) => (queryIndex === 0 ? 80_000 : 900),
  });
  const rt = new ClaudeRuntimeAdapter({ queryFn, rotateAtContextTokens: 50_000 });

  // Opus 5 derives 600k, which 80k does not approach. The operator's number is
  // the one that has to win, or every test above is measuring the wrong thing.
  const session = await rt.start({ ...devDef, model: "claude-opus-5" }, runtimeCtx(dir));
  await rt.send(session, agentInput("turn one"));
  await rt.send(session, agentInput("turn two"));

  assert.equal(opened.length, 2, "an explicit rotateAtContextTokens must beat the per-model derivation");

  await rt.stop(session);
});
