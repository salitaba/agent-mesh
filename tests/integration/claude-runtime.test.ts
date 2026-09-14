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
      startupProbeMs: 1000,
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
