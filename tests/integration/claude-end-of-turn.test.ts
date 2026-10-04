import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ClaudeRuntimeAdapter, NO_MESH_CALL_REMINDER, type ClaudeAdapterOptions } from "../../packages/runtime-claude/src/index";
import type { AgentDefinition, AgentInput, RuntimeContext } from "../../packages/protocol/src/index";

/**
 * A seat that is about to end a turn having called no mesh tool is reminded once, in the same turn.
 *
 * The seventeenth cronlite run: the host was killed with three seats mid-turn, and the CLI wrote into two of their transcripts (QA's and
 * the developer's) that the `mesh` server failed ("mesh bus unreachable: fetch failed"), which was true for the second the old host
 * lay dying. After the restart QA's resumed session did a full verification with its own tools (41.5k tokens) and ended its turn with
 * "Awaiting mesh recovery ... Let me make one final call to verify mesh status", having called nothing. The developer's resumed session
 * did the same for three turns (151k tokens); in two of them, 39 text blocks announced the mesh calls ("Now I'll call the mesh
 * operations:", then `mesh_artifact_publish:` and its arguments) that it never made. The mesh saw no ops and discarded each turn:
 * QA's findings were never reported, and the developer's first mesh effect came 10 min 52 s after the reopen, from the fresh session
 * a rotation gave it. The tools were never gone (a resumed copy of such a transcript, given a live server, called them when asked).
 *
 * A `Stop` hook keeps it ONE turn: blocking the stop makes the model carry on in the same session with the reminder as its reason,
 * where a message pushed after the turn would be a second user turn and a second `result` frame.
 */

type Frame = Record<string, unknown>;
interface TurnCtl {
  options: Record<string, unknown>;
  sid: string;
  /** Resolves when the adapter asks the CLI to abort (the mesh interrupting or ending this turn). */
  interrupted: Promise<void>;
}
type TurnScript = (ctl: TurnCtl) => AsyncGenerator<Frame, void>;

function scriptedQuery(turns: TurnScript[]) {
  const seen = { options: undefined as Record<string, unknown> | undefined };
  const queryFn = (({ prompt, options }: { prompt: unknown; options: Record<string, unknown> }) => {
    seen.options = options;
    const sid = String(options.sessionId ?? options.resume ?? "fake");
    let release: () => void = () => undefined;
    const gen = (async function* () {
      yield { type: "system", subtype: "init", session_id: sid, model: "claude-test", mcp_servers: [{ name: "mesh", status: "connected" }] };
      let i = 0;
      for await (const _msg of prompt as AsyncIterable<unknown>) {
        const interrupted = new Promise<void>((r) => (release = r));
        const script = turns[Math.min(i++, turns.length - 1)];
        yield* script({ options, sid, interrupted });
      }
    })();
    return Object.assign(gen, {
      interrupt: async () => release(),
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

const usage = { input_tokens: 10, output_tokens: 3 };
const assistant = (sid: string, id: string, content: unknown[]): Frame => ({
  type: "assistant",
  parent_tool_use_id: null,
  session_id: sid,
  message: { id, model: "claude-test", content, usage },
});
const toolUse = (id: string, name: string): unknown => ({ type: "tool_use", id, name, input: {} });
const toolResult = (sid: string, id: string): Frame => ({
  type: "user",
  session_id: sid,
  parent_tool_use_id: null,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok", is_error: false }] },
});
const aborted = (sid: string): Frame => ({ type: "result", subtype: "error_during_execution", is_error: true, session_id: sid, usage, errors: ["Request was aborted."] });
const success = (sid: string): Frame => ({ type: "result", subtype: "success", is_error: false, result: "done", session_id: sid, num_turns: 1, usage });

type Hook = (input: unknown, toolUseID: string | undefined, opts: { signal: AbortSignal }) => Promise<Record<string, unknown>>;

/** What the adapter's `Stop` hooks answer when the CLI is about to stop, as the CLI would ask. */
async function stopping(options: Record<string, unknown>, stopHookActive = false): Promise<Array<Record<string, unknown>>> {
  const matchers = ((options.hooks ?? {}) as Record<string, Array<{ hooks: Hook[] }>>).Stop ?? [];
  const input = { hook_event_name: "Stop", session_id: "s", transcript_path: "", cwd: "", stop_hook_active: stopHookActive };
  const out: Array<Record<string, unknown>> = [];
  for (const m of matchers) for (const h of m.hooks) out.push(await h(input, undefined, { signal: new AbortController().signal }));
  return out;
}

const def: AgentDefinition = {
  id: "developer",
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
  workspacePath: fs.mkdtempSync(path.join(os.tmpdir(), "mesh-claude-end-")),
  busUrl: "http://127.0.0.1:1",
  agentToken: "t",
  rolePromptText: "you build things",
  capabilityGrants: def.capabilities,
  env: {},
});

const input = (instructions: string): AgentInput => ({
  agentId: "developer",
  goalId: "goal-1",
  activation: { kind: "manual" },
  context: {
    rolePrompt: "x",
    mission: "m",
    relevantPolicies: [],
    agentState: { agentId: "developer", lifecycle: "THINKING", mailboxDepth: 0, currentArtifactIds: [], tokensConsumed: 0, activations: 0, lastActivityAt: "" },
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

test("a turn that stops with work done and no mesh call is told to report, once", async () => {
  const answers: Array<Record<string, unknown>> = [];
  const { queryFn } = scriptedQuery([
    async function* ({ sid, options }) {
      yield assistant(sid, "msg_1", [toolUse("tu_1", "Bash")]);
      yield toolResult(sid, "tu_1");
      yield assistant(sid, "msg_2", [{ type: "text", text: "Now I'll call the mesh operations:" }]);
      answers.push((await stopping(options))[0]); // the model stops with prose
      answers.push((await stopping(options, true))[0]); // it stopped again after the block, and the CLI says so
      answers.push((await stopping(options))[0]); // even a CLI that did not say so is not asked twice
      yield success(sid);
    },
  ]);
  const rt = new ClaudeRuntimeAdapter({ queryFn });
  const session = await rt.start(def, ctx());
  try {
    await rt.send(session, input("fix the five defects"));
    assert.equal(answers[0].decision, "block", "the stop is blocked: the turn carries on, in the same session");
    assert.equal(answers[0].reason, NO_MESH_CALL_REMINDER);
    assert.deepEqual(answers[1], {}, "a second stop is allowed");
    assert.deepEqual(answers[2], {}, "and so is any later one in the same turn");
  } finally {
    await rt.stop(session);
  }
});

test("the reminder says the mesh works, that prose reaches no one, and which tool reports what", () => {
  assert.match(NO_MESH_CALL_REMINDER, /without having called a single mesh tool/);
  assert.match(NO_MESH_CALL_REMINDER, /text outside a mesh call goes nowhere/);
  assert.match(NO_MESH_CALL_REMINDER, /The mesh is running and your mesh tools work/);
  assert.match(NO_MESH_CALL_REMINDER, /"fetch failed"/);
  for (const tool of ["mesh_artifact_publish", "mesh_commit", "mesh_send", "mesh_reply", "mesh_approve", "mesh_block", "mesh_task_complete", "mesh_done"]) {
    assert.ok(NO_MESH_CALL_REMINDER.includes(tool), `names ${tool}`);
  }
});

test("a turn that called a mesh tool is not reminded, whatever it ends with", async () => {
  const answers: Array<Record<string, unknown>> = [];
  const { queryFn } = scriptedQuery([
    async function* ({ sid, options }) {
      yield assistant(sid, "msg_1", [toolUse("tu_1", "Bash")]);
      yield toolResult(sid, "tu_1");
      yield assistant(sid, "msg_2", [toolUse("tu_2", "mcp__mesh__mesh_done")]);
      yield toolResult(sid, "tu_2");
      yield assistant(sid, "msg_3", [{ type: "text", text: "Reported." }]);
      answers.push((await stopping(options))[0]);
      yield success(sid);
    },
  ]);
  const rt = new ClaudeRuntimeAdapter({ queryFn });
  const session = await rt.start(def, ctx());
  try {
    await rt.send(session, input("report"));
    assert.deepEqual(answers[0], {});
  } finally {
    await rt.stop(session);
  }
});

test("only a tool of the mesh server counts as a mesh call", async () => {
  const answers: Array<Record<string, unknown>> = [];
  const { queryFn } = scriptedQuery([
    async function* ({ sid, options }) {
      // A tool of another server, and a seat's own tool with a mesh-sounding name: neither reported anything to the mesh.
      yield assistant(sid, "msg_1", [toolUse("tu_1", "mcp__github__create_issue"), toolUse("tu_2", "Bash"), toolUse("tu_3", "mesh_done")]);
      yield toolResult(sid, "tu_1");
      answers.push((await stopping(options))[0]);
      yield success(sid);
    },
  ]);
  const rt = new ClaudeRuntimeAdapter({ queryFn });
  const session = await rt.start(def, ctx());
  try {
    await rt.send(session, input("report"));
    assert.equal(answers[0].decision, "block");
  } finally {
    await rt.stop(session);
  }
});

test("a reminded turn that then reports is not asked again, and the count starts again with each turn", async () => {
  const answers: Record<string, Record<string, unknown>> = {};
  const { queryFn } = scriptedQuery([
    // Turn 1: stops silent, is reminded, calls the mesh, stops again.
    async function* ({ sid, options }) {
      yield assistant(sid, "msg_1", [toolUse("tu_1", "Bash")]);
      answers.first = (await stopping(options))[0];
      yield assistant(sid, "msg_2", [toolUse("tu_2", "mcp__mesh__mesh_artifact_publish")]);
      answers.afterReport = (await stopping(options))[0];
      yield success(sid);
    },
    // Turn 2 of the same session: its own count, which is zero.
    async function* ({ sid, options }) {
      yield assistant(sid, "msg_3", [toolUse("tu_3", "Bash")]);
      answers.nextTurn = (await stopping(options))[0];
      yield success(sid);
    },
  ]);
  const rt = new ClaudeRuntimeAdapter({ queryFn });
  const session = await rt.start(def, ctx());
  try {
    await rt.send(session, input("one"));
    await rt.send(session, input("two"));
    assert.equal(answers.first.decision, "block");
    assert.deepEqual(answers.afterReport, {}, "it reported, so there is nothing to remind it of");
    assert.equal(answers.nextTurn.decision, "block", "a new turn starts at zero calls, and is reminded once of its own");
  } finally {
    await rt.stop(session);
  }
});

test("outside a turn there is nothing to remind, and an operator's own Stop hooks run beside ours", async () => {
  const { queryFn, seen } = scriptedQuery([async function* ({ sid }) { yield success(sid); }]);
  const mine = async () => ({});
  const rt = new ClaudeRuntimeAdapter({ queryFn, extraOptions: { hooks: { Stop: [{ hooks: [mine] }] } } });
  const session = await rt.start(def, ctx());
  try {
    const hooks = seen.options?.hooks as Record<string, Array<{ hooks: unknown[] }>>;
    assert.equal(hooks.Stop.length, 2, "the operator's matcher and ours");
    assert.equal(hooks.Stop[0].hooks[0], mine);
    const answers = await stopping(seen.options!);
    assert.deepEqual(answers, [{}, {}], "no turn in flight: neither blocks");
  } finally {
    await rt.stop(session);
  }
});

test("a stop the CLI already marks as continuing from a stop hook is never blocked again by ours", async () => {
  const answers: Array<Record<string, unknown>> = [];
  const { queryFn } = scriptedQuery([
    async function* ({ sid, options }) {
      yield assistant(sid, "msg_1", [toolUse("tu_1", "Bash")]);
      // An operator's own Stop hook blocked first; the CLI says so. Ours has not reminded this turn, and still must not pile on.
      answers.push((await stopping(options, true))[0]);
      yield success(sid);
    },
  ]);
  const rt = new ClaudeRuntimeAdapter({ queryFn });
  const session = await rt.start(def, ctx());
  try {
    await rt.send(session, input("work"));
    assert.deepEqual(answers[0], {});
  } finally {
    await rt.stop(session);
  }
});

test("a turn the mesh is interrupting, or closing itself, is not reminded", async () => {
  const answers: Record<string, Record<string, unknown>> = {};
  const { queryFn } = scriptedQuery([
    // Interrupted: the stop watchdog or an operator. The CLI answers the abort with an error result.
    async function* ({ sid, options, interrupted }) {
      yield assistant(sid, "msg_1", [toolUse("tu_1", "Bash")]);
      await interrupted;
      answers.interrupted = (await stopping(options))[0];
      yield aborted(sid);
    },
    // Ended: the mesh closes a turn whose work already landed (a handover whose continuity record arrived).
    async function* ({ sid, options, interrupted }) {
      yield assistant(sid, "msg_2", [toolUse("tu_2", "Bash")]);
      await interrupted;
      answers.ended = (await stopping(options))[0];
      yield aborted(sid);
    },
  ]);
  const rt = new ClaudeRuntimeAdapter({ queryFn, turnTimeoutMs: 600_000 });
  const session = await rt.start(def, ctx());
  try {
    const first = rt.send(session, input("one")).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 30));
    await rt.interrupt(session);
    await first;
    assert.deepEqual(answers.interrupted, {}, "a turn being interrupted");

    const second = await rt.restoreSession(def, session.sessionId, ctx());
    assert.ok(second, "fixture: the seat can be reopened");
    const ended = rt.send(second!, input("two")).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 30));
    await rt.endTurn(second!);
    await ended;
    assert.deepEqual(answers.ended, {}, "a turn the mesh is ending");
    await rt.stop(second!);
  } finally {
    await rt.stop(session).catch(() => undefined);
  }
});

test("a turn the mesh times out is not reminded", async () => {
  const answers: Array<Record<string, unknown>> = [];
  const { queryFn } = scriptedQuery([
    async function* ({ sid, options, interrupted }) {
      yield assistant(sid, "msg_1", [toolUse("tu_1", "Bash")]);
      await interrupted; // the backstop fires and asks the CLI to abort
      answers.push((await stopping(options))[0]);
      yield aborted(sid);
    },
  ]);
  const rt = new ClaudeRuntimeAdapter({ queryFn, turnTimeoutMs: 150 });
  const session = await rt.start(def, ctx());
  try {
    const err = await rt.send(session, input("long build")).then(
      () => assert.fail("the turn must not complete"),
      (e: unknown) => e,
    );
    assert.match(String((err as Error).message), /backstop/, "fixture: the deadline is what ended it");
    assert.deepEqual(answers[0], {}, "a deadline is not a stop the model chose, and blocking it would run a turn the mesh already gave up on");
  } finally {
    await rt.stop(session);
  }
});
