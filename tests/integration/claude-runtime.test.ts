import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  ClaudeRuntimeAdapter,
  buildPermissionGate,
  toClaudeModelId,
  usageToTokens,
} from "../../packages/runtime-claude/src/index";
import type { ClaudeAdapterOptions } from "../../packages/runtime-claude/src/index";
import { BackendUnreachableError } from "../../packages/protocol/src/index";
import type {
  AgentDefinition,
  AgentInput,
  AgentSession,
  RuntimeContext,
} from "../../packages/protocol/src/index";

const devDef: AgentDefinition = {
  id: "developer",
  role: "developer",
  mode: "peer",
  runtime: "claude",
  prompt: { text: "you build things" },
  capabilities: ["repository.write", "git.commit"],
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

/** The SDK hands the gate a context object; only `signal` is load-bearing here. */
const gateCtx = () => ({
  signal: new AbortController().signal,
  toolUseID: "tool-use-1",
  requestId: "req-1",
});

/** Drive the gate the way the SDK does, and reduce to a bare boolean. */
async function allows(caps: string[], tool: string): Promise<boolean> {
  const gate = buildPermissionGate(caps);
  const res = await gate(tool, { any: "input" }, gateCtx());
  return res?.behavior === "allow";
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

test("toClaudeModelId strips a provider prefix but keeps a bare id", () => {
  // opencode writes provider-qualified refs; the SDK wants the model id alone.
  assert.equal(toClaudeModelId("anthropic/claude-sonnet-5"), "claude-sonnet-5");
  assert.equal(toClaudeModelId("claude-opus-5"), "claude-opus-5");
  // Only the FIRST slash splits — nested provider paths keep their tail intact.
  assert.equal(toClaudeModelId("openrouter/anthropic/claude-opus-5"), "anthropic/claude-opus-5");
  // Degenerate forms must not produce an empty model id, which the SDK would
  // reject at spawn time with a far less legible error.
  assert.equal(toClaudeModelId("/leading"), "/leading");
  assert.equal(toClaudeModelId("trailing/"), "trailing/");
  assert.equal(toClaudeModelId(undefined), undefined);
  assert.equal(toClaudeModelId("   "), undefined);
});

test("usageToTokens charges new work and excludes cache reads", () => {
  const t = usageToTokens({
    input_tokens: 100,
    output_tokens: 20,
    cache_creation_input_tokens: 5,
    cache_read_input_tokens: 9000,
  });
  // 9000 cached-prefix reads must NOT reach the budget: billing them per turn
  // is the runaway that exhausted thread budgets under opencode.
  assert.deepEqual(t, { input: 100, output: 20, total: 125, cacheRead: 9000 });
});

test("usageToTokens tolerates a result message with no usage block", () => {
  assert.deepEqual(usageToTokens(undefined), { input: 0, output: 0, total: 0, cacheRead: 0 });
  assert.deepEqual(usageToTokens({}), { input: 0, output: 0, total: 0, cacheRead: 0 });
});

test("permission gate maps capabilities onto tools", async () => {
  const write = ["repository.write"];
  assert.equal(await allows(write, "Edit"), true);
  assert.equal(await allows(write, "Write"), true);
  assert.equal(await allows(write, "NotebookEdit"), true);
  // Write capability alone buys no shell and no network.
  assert.equal(await allows(write, "Bash"), false);
  assert.equal(await allows(write, "WebFetch"), false);

  assert.equal(await allows(["shell.execute"], "Bash"), true);
  assert.equal(await allows(["test.execute"], "Bash"), true);
  assert.equal(await allows(["shell.execute"], "Edit"), false);
  assert.equal(await allows(["network.request"], "WebFetch"), true);
  assert.equal(await allows(["network.request"], "WebSearch"), true);
  assert.equal(await allows(["architecture.write"], "Write"), true);
  assert.equal(await allows(["test.write"], "Write"), true);
});

test("permission gate gives a commit-only seat exec rather than an unanswerable ask", async () => {
  // opencode renders git.commit as bash:"ask"; nothing on a mesh turn can
  // answer that prompt, so the seat would stall to its timeout instead.
  assert.equal(await allows(["git.commit"], "Bash"), true);
  assert.equal(await allows(["git.commit"], "Edit"), false);
});

test("permission gate always allows mesh MCP and read-only tools", async () => {
  // A seat with no capabilities at all still has to reach the bus, or it goes
  // mute and the mesh cannot tell it apart from a hung agent.
  for (const tool of ["mcp__mesh__send_message", "mcp__mesh__anything"]) {
    assert.equal(await allows([], tool), true);
  }
  for (const tool of ["Read", "Glob", "Grep", "TodoWrite"]) {
    assert.equal(await allows([], tool), true);
  }
});

test("permission gate fails closed on tools nobody mapped", async () => {
  const gate = buildPermissionGate(["repository.write", "shell.execute", "network.request"]);
  // Even a fully-capable seat cannot reach a tool the mapping never named.
  const res = await gate("SomeFutureTool", {}, gateCtx());
  assert.ok(res && res.behavior === "deny");
  assert.match(res.message, /not available to mesh agents/);
});

test("permission gate resolves capability aliases", async () => {
  // A mesh.yaml written with an alias must not silently produce a seat that
  // cannot edit: capabilityGrants also arrive off hand-built AgentDefinitions,
  // bypassing whatever normalization config load would have applied.
  assert.equal(await allows(["code.write"], "Edit"), true);
  assert.equal(await allows(["docs.write"], "Write"), true);
  assert.equal(await allows(["test.run"], "Bash"), true);
  // An alias that resolves to a read capability still buys no write.
  assert.equal(await allows(["api.read"], "Edit"), false);
});

test("send without a live session raises BackendUnreachableError", async () => {
  const adapter = new ClaudeRuntimeAdapter();
  const session: AgentSession = {
    sessionId: "never-started",
    agentId: "developer",
    runtime: "claude",
    createdAt: new Date().toISOString(),
    handle: { sdkSessionId: "never-started" },
  };
  await assert.rejects(
    () => adapter.send(session, agentInput("hello")),
    (err: unknown) => {
      // Must be the "backend is gone" class, not a generic throw: the
      // supervisor keys its restart path off exactly this distinction.
      assert.ok(err instanceof BackendUnreachableError, `got ${String(err)}`);
      return true;
    },
  );
});

test("restoreSession returns null when the backend cannot be reopened", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-claude-"));
  try {
    // A nonexistent executable makes the spawn fail deterministically without
    // depending on whether a real Claude CLI is installed on this machine.
    // The short probe keeps the "backend went quiet" grace out of the test's
    // wall clock; the dead path does not depend on it expiring.
    const adapter = new ClaudeRuntimeAdapter({
      executablePath: path.join(dir, "no-such-claude"),
      spawnFailureGraceMs: 1000,
    });
    const restored = await adapter.restoreSession(
      devDef,
      "11111111-2222-3333-4444-555555555555",
      runtimeCtx(dir),
    );
    assert.equal(restored, null);
    await adapter.stopAll();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Captures the SDK options a designer turn opens with.
 *
 * The designer path takes a plain string prompt, not a push queue, so this
 * fake yields a single result and closes rather than draining an inbox the
 * way `session-rotation`'s factory does.
 */
function captureDesignerQuery() {
  const seen: Record<string, unknown>[] = [];
  const queryFn = (({ options }: { prompt: unknown; options: Record<string, unknown> }) => {
    seen.push(options);
    const gen = (async function* () {
      yield { type: "result", subtype: "success", result: "staged", session_id: "designer-fake", num_turns: 1 };
    })();
    return Object.assign(gen, { interrupt: async () => undefined });
  }) as unknown as ClaudeAdapterOptions["queryFn"];
  return { queryFn, seen };
}

test("a designer turn with opts.mcp wires a staging bridge carrying the turn id", async () => {
  const { queryFn, seen } = captureDesignerQuery();
  const adapter = new ClaudeRuntimeAdapter({ queryFn });
  await adapter.prompt("stage a rename", {
    system: "you are a designer",
    mcp: {
      url: "http://127.0.0.1:7421/designer/mcp?staging=1",
      headers: { "x-mesh-designer-turn": "turn-abc", "x-mesh-token": "human-local" },
    },
  });
  assert.equal(seen.length, 1);
  const servers = seen[0].mcpServers as Record<string, { type: string; command: string; args: string[] }>;
  const staging = servers.mesh_staging;
  assert.ok(staging, "opts.mcp must produce a mesh_staging server");
  assert.equal(staging.type, "stdio", "the bridge is stdio: this repo has no remote MCP transport");
  assert.equal(staging.command, process.execPath);
  assert.ok(staging.args.includes("--staging"));
  // The turn id is what lets the bus file staged mutations against the right
  // open turn; without it the bridge would write into nothing.
  assert.equal(staging.args[staging.args.indexOf("--turn") + 1], "turn-abc");
  assert.equal(staging.args[staging.args.indexOf("--token") + 1], "human-local");
  // Origin only — the path and the ?staging=1 query are the bridge's business.
  assert.equal(staging.args[staging.args.indexOf("--bus") + 1], "http://127.0.0.1:7421");
  await adapter.stopAll();
});

test("a designer turn without opts.mcp opens no MCP servers at all", async () => {
  const { queryFn, seen } = captureDesignerQuery();
  const adapter = new ClaudeRuntimeAdapter({ queryFn });
  await adapter.prompt("just talk to me", { system: "you are a designer" });
  assert.equal(seen[0].mcpServers, undefined, "no bus named, no bridge");
  await adapter.stopAll();
});

/**
 * A backend that spawns cleanly and then parks: the query opens, never emits
 * `system`/`init`, and never ends. This is the shape that used to be reported
 * healthy — the pump never throws, so only the startup probe can catch it.
 */
function parkedQuery(): ClaudeAdapterOptions["queryFn"] {
  return (() => {
    const gen = (async function* () {
      // Never settles, and holds no timer or socket, so it cannot keep the
      // event loop alive after the test ends.
      await new Promise<never>(() => {});
    })();
    return Object.assign(gen, { interrupt: async () => undefined });
  }) as unknown as ClaudeAdapterOptions["queryFn"];
}

test("start defers judgement when a spawned backend never emits its init handshake", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-claude-"));
  try {
    const adapter = new ClaudeRuntimeAdapter({ queryFn: parkedQuery(), spawnFailureGraceMs: 25 });
    // Not a deferral by choice: `init` cannot arrive before the first pushed
    // message — verified against the SDK, where an unfed streaming query
    // answers control requests and emits nothing — so start() has no way to
    // tell a parked backend from a healthy one. It hands back a live session
    // and the turn dies later. Catching this belongs on the first turn.
    const started = await adapter.start(devDef, runtimeCtx(dir));
    assert.equal(started.agentId, devDef.id);
    assert.ok(started.sessionId, "a quiet spawn still yields a session id");
    await adapter.stopAll();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("restoreSession still tolerates a resume that stays quiet", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-claude-"));
  try {
    const adapter = new ClaudeRuntimeAdapter({ queryFn: parkedQuery(), spawnFailureGraceMs: 25 });
    const sessionId = "11111111-2222-3333-4444-555555555555";
    const restored = await adapter.restoreSession(devDef, sessionId, runtimeCtx(dir));
    // Asymmetric on purpose: whether the CLI re-emits `init` on resume is not
    // pinned down, and guessing wrong here costs a wasted turn rather than a
    // seat that never opens.
    assert.ok(restored, "a quiet resume must not be failed by the strict probe");
    assert.equal(restored.sessionId, sessionId);
    await adapter.stopAll();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resume rebuilds the query that suspend tore down", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-claude-"));
  try {
    const adapter = new ClaudeRuntimeAdapter({ queryFn: parkedQuery(), spawnFailureGraceMs: 25 });
    const started = await adapter.start(devDef, runtimeCtx(dir));
    await adapter.suspend(started);
    assert.equal(await adapter.getStatus(started), "SUSPENDED");

    const revived = await adapter.resume(started, devDef, runtimeCtx(dir));
    // The session id is the transcript's name, so a rebuild that changed it
    // would silently strand every turn of history the agent had accumulated.
    assert.ok(revived, "resume must hand back a live session, not just a status");
    assert.equal(revived.sessionId, started.sessionId);
    assert.equal(await adapter.getStatus(started), "IDLE");
    await adapter.stopAll();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resume reports null when the backend cannot be rebuilt", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-claude-"));
  try {
    const adapter = new ClaudeRuntimeAdapter({
      executablePath: path.join(dir, "no-such-claude"),
      spawnFailureGraceMs: 1000,
    });
    const orphan: AgentSession = {
      sessionId: "11111111-2222-3333-4444-555555555555",
      agentId: devDef.id,
      runtime: "claude",
      createdAt: new Date().toISOString(),
      handle: null,
    };
    // The old resume flipped this to IDLE and returned, so a seat whose
    // backend had gone away looked ready right up until its next turn died.
    assert.equal(await adapter.resume(orphan, devDef, runtimeCtx(dir)), null);
    await adapter.stopAll();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a turn answered by total silence fails fast instead of riding the turn timeout", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-claude-"));
  try {
    const adapter = new ClaudeRuntimeAdapter({
      queryFn: parkedQuery(),
      spawnFailureGraceMs: 25,
      firstFrameTimeoutMs: 40,
      // Deliberately enormous by comparison. If the first-frame watchdog were
      // not carrying this, the test would hang for ten minutes rather than
      // fail — which is precisely the production symptom: a healthy-looking
      // session that answers a push with nothing at all, held open until the
      // backstop fires.
      turnTimeoutMs: 600000,
    });
    const started = await adapter.start(devDef, runtimeCtx(dir));
    const began = Date.now();
    await assert.rejects(
      () => adapter.send(started, agentInput("design the panel")),
      (err: unknown) => {
        // The "backend is gone" class, so the supervisor retries onto a fresh
        // spawn rather than reporting a step that simply failed.
        assert.ok(err instanceof BackendUnreachableError, `got ${String(err)}`);
        return true;
      },
    );
    assert.ok(Date.now() - began < 5000, "a mute backend must not be ridden to turnTimeoutMs");
    // The session is dropped rather than left open. A session kept alive here
    // is how orphaned `--resume` processes pile up against one transcript,
    // still working and still billing after the mesh stopped listening.
    await assert.rejects(() => adapter.send(started, agentInput("again")), BackendUnreachableError);
    await adapter.stopAll();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
