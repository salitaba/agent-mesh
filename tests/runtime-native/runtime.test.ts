import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { BackendUnreachableError, InterruptedTurnError, TurnTimeoutError, classifyProviderOutage, isTimeoutError, type AgentEvent } from "../../packages/protocol/src/index";
import { ProviderError, ProviderTimeoutError } from "../../packages/llm/src/index";
import { NO_MESH_CALL_REMINDER } from "../../packages/agent-runtime/src/index";
import { OUTPUT_VOICE_RULES } from "../../packages/core/src/context";
import { NativeRuntime, elideOldToolResults } from "../../packages/runtime-native/src/index";
import { BUS_TOOLS, agent, collect, context, fakeBus, gate, rig, runtimeFor, ScriptedProvider, turnEnd, turnInput } from "./harness";

/**
 * A seat's turn on the native runtime, against a scripted model and a bus that records what it was asked.
 */

const toolNames = (req: { tools?: Array<{ name: string }> }): string[] => (req.tools ?? []).map((t) => t.name).sort();

test("a turn: the model speaks, calls a bus tool, and ends; the frames, the call and the figures are what the supervisor reads", async () => {
  const bus = await fakeBus();
  const r = rig();
  try {
    const provider = new ScriptedProvider([
      { text: ["Reporting ", "now."], tools: [{ name: "mesh_send", args: { to: ["qa"], note: "ready" }, id: "t1" }], usage: { input: 1000, output: 50 }, model: "m-1-20260101" },
      { text: "Done.", usage: { input: 1100, output: 20, cacheRead: 900, cacheWrite: 30 }, model: "m-1-20260102" },
    ]);
    const rt = runtimeFor(provider);
    const session = await rt.start(agent(), context(r, bus));
    const events = await collect(rt.stream(session, turnInput("Do the work.")));

    assert.deepEqual(
      events.map((e) => e.kind),
      ["agent_message_chunk", "agent_message_chunk", "usage_update", "tool_call", "tool_call_update", "agent_message_chunk", "usage_update", "turn_end"],
    );
    const call = events.find((e) => e.kind === "tool_call") as Extract<AgentEvent, { kind: "tool_call" }>;
    assert.deepEqual([call.toolCallId, call.name, call.args], ["t1", "mesh_send", { to: ["qa"], note: "ready" }]);
    const update = events.find((e) => e.kind === "tool_call_update") as Extract<AgentEvent, { kind: "tool_call_update" }>;
    assert.equal(update.status, "completed");
    assert.match(update.resultDigest ?? "", /^dgx-/);

    const end = turnEnd(events);
    assert.equal(end.stopReason, "end_turn");
    assert.equal(end.text, "Done.");
    assert.equal(end.summary, "Done.");
    assert.equal(end.typedOps, true);
    assert.deepEqual(end.operations, []);
    assert.deepEqual(end.tokensUsed, { input: 2100, output: 70, total: 2100 + 70 + 30, cacheRead: 900 });
    assert.equal(end.model, "m-1", "the model the operator configured, which is what a price list is keyed by");
    assert.equal(end.modelVersion, "m-1-20260102", "and the provider's own name for it, beside it");

    assert.deepEqual(bus.calls, [{ name: "mesh_send", args: { to: ["qa"], note: "ready" }, token: "seat-token", url: "/internal/mcp/dev" }]);
    const second = provider.requests[1]!;
    assert.deepEqual(second.messages, [
      { role: "user", content: "Do the work." },
      { role: "assistant", content: "Reporting now.", toolCalls: [{ id: "t1", name: "mesh_send", args: { to: ["qa"], note: "ready" } }] },
      { role: "tool", toolCallId: "t1", name: "mesh_send", content: '{"ok":true}' },
    ]);
  } finally {
    r.cleanup();
    await bus.close();
  }
});

test("send is the fold of stream: the same output, with the tool calls the turn made", async () => {
  const bus = await fakeBus();
  const r = rig();
  try {
    const provider = new ScriptedProvider([{ tools: [{ name: "mesh_send", args: { note: "x" }, id: "t1" }] }, { text: "ok" }]);
    const rt = runtimeFor(provider);
    const session = await rt.start(agent(), context(r, bus));
    const out = await rt.send(session, turnInput());
    assert.equal(out.text, "ok");
    assert.equal(out.typedOps, true);
    assert.deepEqual(out.operations, []);
    assert.deepEqual(out.toolCalls?.map((c) => [c.name, c.status]), [["mesh_send", "completed"]]);
    assert.equal(out.toolCalls?.[0]?.args && JSON.stringify(out.toolCalls[0].args), '{"note":"x"}');
    assert.equal(out.error, undefined);
  } finally {
    r.cleanup();
    await bus.close();
  }
});

test("the system prompt is the seat's role with the shared voice rules and the reading discipline, and the bus tools are listed with the seat's own", async () => {
  const bus = await fakeBus();
  const r = rig();
  try {
    const provider = new ScriptedProvider([{ tools: [{ name: "mesh_done" }] }, { text: "ok" }]);
    const rt = runtimeFor(provider);
    const session = await rt.start(agent(), context(r, bus));
    await rt.send(session, turnInput());
    const first = provider.requests[0]!;
    assert.ok(first.system?.startsWith("You are the developer."));
    assert.ok(first.system?.includes(OUTPUT_VOICE_RULES));
    assert.ok(first.system?.includes("## Reading"));
    assert.deepEqual(toolNames(first), ["Glob", "Grep", "Read", ...BUS_TOOLS.map((t) => t.name)].sort());
    assert.ok(fs.readFileSync(path.join(r.workspace, ".mesh", "agents", "dev", "ROLE.md"), "utf8").includes("## Reading"), "ROLE.md is written, as the Claude adapter writes it");
  } finally {
    r.cleanup();
    await bus.close();
  }
});

test("a seat is offered the tools its capabilities reach, and the model's request names no others", async () => {
  const bus = await fakeBus();
  const r = rig();
  try {
    const provider = new ScriptedProvider([{ text: "ok" }]);
    const rt = runtimeFor(provider);
    const session = await rt.start(agent({ capabilities: ["repository.write", "test.execute", "network.request"] }), context(r, bus));
    await rt.send(session, turnInput());
    assert.deepEqual(toolNames(provider.requests[0]!), ["Bash", "Edit", "Glob", "Grep", "Read", "WebFetch", "Write", ...BUS_TOOLS.map((t) => t.name)].sort());
  } finally {
    r.cleanup();
    await bus.close();
  }
});

test("the seat's own file tools run in its workspace and what they return reaches the model", async () => {
  const bus = await fakeBus();
  const r = rig();
  try {
    fs.writeFileSync(path.join(r.workspace, "notes.txt"), "alpha\nbeta\n");
    const provider = new ScriptedProvider([
      { tools: [{ name: "Read", args: { file_path: "notes.txt" }, id: "r1" }, { name: "Grep", args: { pattern: "beta", output_mode: "content" }, id: "g1" }] },
      { tools: [{ name: "mesh_done" }] },
      { text: "ok" },
    ]);
    const rt = runtimeFor(provider);
    const session = await rt.start(agent(), context(r, bus));
    const events = await collect(rt.stream(session, turnInput()));
    const tools = provider.requests[1]!.messages.filter((m) => m.role === "tool") as Array<{ toolCallId: string; content: string }>;
    assert.deepEqual(tools.map((t) => [t.toolCallId, t.content]), [["r1", "     1\talpha\n     2\tbeta"], ["g1", "notes.txt:2:beta"]]);
    const updates = events.filter((e) => e.kind === "tool_call_update") as Array<Extract<AgentEvent, { kind: "tool_call_update" }>>;
    assert.deepEqual(updates.map((u) => u.status), ["completed", "completed", "completed"]);
  } finally {
    r.cleanup();
    await bus.close();
  }
});

test("a tool the seat has no capability for is refused by the gate, in the gate's words, and the call is a failed one", async () => {
  const bus = await fakeBus();
  const r = rig();
  try {
    const provider = new ScriptedProvider([
      { tools: [{ name: "Write", args: { file_path: "x.txt", content: "x" }, id: "w1" }] },
      { tools: [{ name: "mesh_done" }] },
      { text: "ok" },
    ]);
    const rt = runtimeFor(provider);
    const session = await rt.start(agent(), context(r, bus));
    const events = await collect(rt.stream(session, turnInput()));
    const update = events.find((e) => e.kind === "tool_call_update") as Extract<AgentEvent, { kind: "tool_call_update" }>;
    assert.equal(update.status, "failed");
    assert.match(update.error ?? "", /^Write denied: this seat holds no write capability/);
    assert.equal(fs.existsSync(path.join(r.workspace, "x.txt")), false);
    assert.equal(turnEnd(events).heldTools, undefined, "a plain refusal is not a request for an operator's approval");
  } finally {
    r.cleanup();
    await bus.close();
  }
});

test("a tool behind an operator's approval is held and reported, and runs once the grant arrives with the next turn", async () => {
  const bus = await fakeBus();
  const r = rig();
  try {
    const provider = new ScriptedProvider([
      { tools: [{ name: "Bash", args: { command: "echo hi" }, id: "b1" }] },
      { tools: [{ name: "mesh_done" }] },
      { text: "waiting" },
      { tools: [{ name: "Bash", args: { command: "echo hi" }, id: "b2" }] },
      { tools: [{ name: "mesh_done" }] },
      { text: "ran" },
      { tools: [{ name: "Bash", args: { command: "echo hi" }, id: "b3" }] },
      { tools: [{ name: "mesh_done" }] },
      { text: "held again" },
    ]);
    const rt = runtimeFor(provider);
    const session = await rt.start(agent({ capabilities: ["shell.execute"], requiresApproval: ["shell.execute"] }), context(r, bus));
    const first = await collect(rt.stream(session, turnInput()));
    const held = first.find((e) => e.kind === "tool_call_update") as Extract<AgentEvent, { kind: "tool_call_update" }>;
    assert.equal(held.status, "failed");
    assert.match(held.error ?? "", /^Bash needs operator approval/);
    assert.deepEqual(turnEnd(first).heldTools, ["Bash"]);

    const second = await collect(rt.stream(session, turnInput("again", { approvalGranted: ["Bash"] })));
    const ran = second.find((e) => e.kind === "tool_call_update") as Extract<AgentEvent, { kind: "tool_call_update" }>;
    assert.equal(ran.status, "completed");
    assert.equal(turnEnd(second).heldTools, undefined);
    const result = provider.requests[4]!.messages.find((m) => m.role === "tool" && m.toolCallId === "b2") as { content: string };
    assert.equal(result.content, "hi\n");

    // The grant is what the operator holds NOW: when it is taken back, the next turn is held again.
    const third = await collect(rt.stream(session, turnInput("once more", { approvalGranted: [] })));
    assert.deepEqual(turnEnd(third).heldTools, ["Bash"]);
  } finally {
    r.cleanup();
    await bus.close();
  }
});

test("a seat that ends its turn without calling a mesh tool is told once, in the same turn, and given one more round", async () => {
  const bus = await fakeBus();
  const r = rig();
  try {
    const provider = new ScriptedProvider([{ text: "I did it all in my head." }, { text: "Still nothing to report." }, { text: "never reached" }]);
    const rt = runtimeFor(provider);
    const session = await rt.start(agent(), context(r, bus));
    const events = await collect(rt.stream(session, turnInput()));
    assert.equal(provider.requests.length, 2, "reminded once, not twice");
    const last = provider.requests[1]!.messages.at(-1);
    assert.deepEqual(last, { role: "user", content: NO_MESH_CALL_REMINDER });
    assert.equal(turnEnd(events).text, "Still nothing to report.");
  } finally {
    r.cleanup();
    await bus.close();
  }
});

test("a seat that did call a mesh tool is not reminded", async () => {
  const bus = await fakeBus();
  const r = rig();
  try {
    const provider = new ScriptedProvider([{ tools: [{ name: "mesh_send", args: {} }] }, { text: "reported" }, { text: "never reached" }]);
    const rt = runtimeFor(provider);
    const session = await rt.start(agent(), context(r, bus));
    await rt.send(session, turnInput());
    assert.equal(provider.requests.length, 2);
    assert.ok(!provider.requests[1]!.messages.some((m) => m.role === "user" && m.content === NO_MESH_CALL_REMINDER));
  } finally {
    r.cleanup();
    await bus.close();
  }
});

test("a note from the mesh reaches the model at the next tool boundary, on the last result of the batch", async () => {
  let rt!: NativeRuntime;
  let session!: Awaited<ReturnType<NativeRuntime["start"]>>;
  let advised = false;
  const bus = await fakeBus((name) => {
    if (name === "mesh_send" && !advised) {
      advised = true;
      assert.equal(rt.advise(session, "Commit what you have and close the turn."), true);
    }
    return { text: '{"ok":true}' };
  });
  const r = rig();
  try {
    const provider = new ScriptedProvider([{ tools: [{ name: "mesh_send", id: "t1" }, { name: "mesh_send", id: "t2" }] }, { text: "ok" }]);
    rt = runtimeFor(provider);
    session = await rt.start(agent(), context(r, bus));
    await rt.send(session, turnInput());
    const tools = provider.requests[1]!.messages.filter((m) => m.role === "tool") as Array<{ content: string }>;
    assert.equal(tools[0]!.content, '{"ok":true}');
    assert.equal(tools[1]!.content, '{"ok":true}\n\n[notice from the mesh]\nCommit what you have and close the turn.');
    assert.equal(rt.advise(session, "late"), false, "nothing is running, so there is nothing to tell");
  } finally {
    r.cleanup();
    await bus.close();
  }
});

test("arguments that are not a JSON object are answered with what was sent, and the tool does not run", async () => {
  const bus = await fakeBus();
  const r = rig();
  try {
    fs.writeFileSync(path.join(r.workspace, "a.txt"), "x");
    const provider = new ScriptedProvider([{ tools: [{ name: "Read", invalid: '{"file_path": "a.txt"', id: "bad" }] }, { tools: [{ name: "mesh_done" }] }, { text: "ok" }]);
    const rt = runtimeFor(provider);
    const session = await rt.start(agent(), context(r, bus));
    const events = await collect(rt.stream(session, turnInput()));
    const update = events.find((e) => e.kind === "tool_call_update") as Extract<AgentEvent, { kind: "tool_call_update" }>;
    assert.equal(update.status, "failed");
    const result = provider.requests[1]!.messages.find((m) => m.role === "tool") as { content: string };
    assert.match(result.content, /^The arguments of Read were not a valid JSON object, so the call did not run\. You sent: \{"file_path": "a\.txt"\./);
  } finally {
    r.cleanup();
    await bus.close();
  }
});

test("a reply cut off by the output cap is asked to continue, twice at most", async () => {
  const bus = await fakeBus();
  const r = rig();
  try {
    const provider = new ScriptedProvider([
      { tools: [{ name: "mesh_send" }] },
      { text: "part one", stop: "max_tokens" },
      { text: "part two", stop: "max_tokens" },
      { text: "part three", stop: "max_tokens" },
      { text: "never reached" },
    ]);
    const rt = runtimeFor(provider);
    const session = await rt.start(agent(), context(r, bus));
    const end = turnEnd(await collect(rt.stream(session, turnInput())));
    assert.equal(provider.requests.length, 4, "the first call, and two continuations, and then the turn ends");
    const msgs = provider.requests[2]!.messages;
    assert.deepEqual(msgs.slice(-2), [
      { role: "assistant", content: "part one" },
      { role: "user", content: "Your last reply was cut off by the output limit. Continue from where it stopped." },
    ]);
    assert.equal(end.text, "part three");
  } finally {
    r.cleanup();
    await bus.close();
  }
});

test("a turn that never finishes is stopped at the step limit and fails, with what it spent", async () => {
  const bus = await fakeBus();
  const r = rig();
  try {
    const provider = new ScriptedProvider([{ tools: [{ name: "mesh_send" }], usage: { input: 10, output: 5 } }]);
    const rt = runtimeFor(provider, { maxSteps: 3 });
    const session = await rt.start(agent(), context(r, bus));
    const end = turnEnd(await collect(rt.stream(session, turnInput())));
    assert.equal(end.stopReason, "error");
    assert.match(end.error ?? "", /3 model calls without finishing/);
    assert.deepEqual(end.tokensUsed, { input: 30, output: 15, total: 45, cacheRead: 0 });
  } finally {
    r.cleanup();
    await bus.close();
  }
});

test("a provider's refusal ends the turn as a failure that says what was spent, worded so the supervisor reads it as the outage it is", async () => {
  for (const [status, kind, outage] of [[429, "rate_limited", "rate_limited"], [402, "billing", "billing"], [401, "auth", "auth"], [503, "unavailable", "unavailable"]] as const) {
    const bus = await fakeBus();
    const r = rig();
    try {
      const provider = new ScriptedProvider([
        { tools: [{ name: "mesh_send" }], usage: { input: 500, output: 20 } },
        { fail: new ProviderError("scripted", { kind, status, detail: "nope" }) },
      ]);
      const rt = runtimeFor(provider);
      const session = await rt.start(agent(), context(r, bus));
      const end = turnEnd(await collect(rt.stream(session, turnInput())));
      assert.equal(end.stopReason, "error");
      assert.match(end.error ?? "", new RegExp(`^API Error: ${status} nope`));
      const read = classifyProviderOutage(end.error);
      assert.deepEqual([read?.kind, read?.status], [outage, status]);
      assert.equal(end.tokensUsed.total, 520, "the call that did finish is billed");
    } finally {
      r.cleanup();
      await bus.close();
    }
  }
});

test("a provider that goes quiet ends the turn as slow, not dead, carrying what was spent", async () => {
  const bus = await fakeBus();
  const r = rig();
  try {
    const provider = new ScriptedProvider([
      { tools: [{ name: "mesh_send" }], usage: { input: 500, output: 20 } },
      { fail: new ProviderTimeoutError("scripted", "reading the response", 180_000) },
    ]);
    const rt = runtimeFor(provider);
    const session = await rt.start(agent(), context(r, bus));
    const err = await collect(rt.stream(session, turnInput())).catch((e: unknown) => e);
    assert.ok(err instanceof TurnTimeoutError, String(err));
    assert.equal(isTimeoutError(err), true);
    assert.equal(err.tokensUsed?.total, 520);
  } finally {
    r.cleanup();
    await bus.close();
  }
});

test("a bus that stays down is a seat that cannot act: the turn fails as an unreachable backend, before any model call", async () => {
  const bus = await fakeBus();
  const r = rig();
  const ctx = context(r, bus);
  await bus.close();
  try {
    const provider = new ScriptedProvider([{ text: "never" }]);
    const rt = runtimeFor(provider);
    const session = await rt.start(agent(), ctx);
    const err = await collect(rt.stream(session, turnInput())).catch((e: unknown) => e);
    assert.ok(err instanceof BackendUnreachableError, String(err));
    assert.match(err.message, /mesh bus http:\/\/127\.0\.0\.1:\d+/);
    assert.equal(provider.requests.length, 0);
    assert.equal(await rt.getStatus(session), "IDLE", "the seat itself is still there for the next turn");
  } finally {
    r.cleanup();
  }
});

test("interrupting a turn ends it as an interruption that carries what the finished calls spent, and leaves a valid conversation", async () => {
  const bus = await fakeBus();
  const r = rig();
  try {
    const started = gate();
    const provider = new ScriptedProvider([
      { tools: [{ name: "mesh_send", id: "t1" }], usage: { input: 100, output: 10 } },
      { hang: true, before: () => started.open() },
      { text: "ok" },
    ]);
    const rt = runtimeFor(provider);
    const session = await rt.start(agent(), context(r, bus));
    const turn = collect(rt.stream(session, turnInput())).catch((e: unknown) => e);
    await started.wait;
    await rt.interrupt(session);
    const err = await turn;
    assert.ok(err instanceof InterruptedTurnError, String(err));
    assert.deepEqual(err.tokensUsed, { input: 100, output: 10, total: 110, cacheRead: 0 });
    // The next turn goes on from a conversation in which the call was answered.
    await rt.send(session, turnInput("next"));
    const msgs = provider.requests[2]!.messages;
    assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant", "tool", "user"]);
  } finally {
    r.cleanup();
    await bus.close();
  }
});

test("interrupting while a command runs stops the command, and the call is answered in the conversation", async () => {
  const bus = await fakeBus();
  const r = rig();
  try {
    const provider = new ScriptedProvider([{ tools: [{ name: "Bash", args: { command: "echo started; sleep 30" }, id: "b1" }] }, { tools: [{ name: "mesh_done" }] }, { text: "ok" }]);
    const rt = runtimeFor(provider);
    const session = await rt.start(agent({ capabilities: ["test.execute"] }), context(r, bus));
    const seen: AgentEvent[] = [];
    const turn = (async () => {
      try {
        for await (const e of rt.stream(session, turnInput())) {
          seen.push(e);
          if (e.kind === "tool_call") setTimeout(() => void rt.interrupt(session), 150);
        }
      } catch (e) {
        return e;
      }
    })();
    const err = await turn;
    assert.ok(err instanceof InterruptedTurnError, String(err));
    await rt.send(session, turnInput("next"));
    const answer = provider.requests[1]!.messages.find((m) => m.role === "tool") as { content: string; isError?: boolean };
    assert.match(answer.content, /\[stopped: the mesh ended this turn\]/);
    assert.equal(answer.isError, true);
  } finally {
    r.cleanup();
    await bus.close();
  }
});

test("ending a turn as complete while the model is thinking is a success, and costs no further call", async () => {
  const bus = await fakeBus();
  const r = rig();
  try {
    const started = gate();
    const provider = new ScriptedProvider([{ hang: true, before: () => started.open() }, { text: "never" }]);
    const rt = runtimeFor(provider);
    const session = await rt.start(agent(), context(r, bus));
    const turn = collect(rt.stream(session, turnInput()));
    await started.wait;
    await rt.endTurn(session);
    const end = turnEnd(await turn);
    assert.equal(end.stopReason, "end_turn");
    assert.equal(end.error, undefined);
    assert.equal(provider.requests.length, 1);
  } finally {
    r.cleanup();
    await bus.close();
  }
});

test("ending a turn as complete while a tool runs lets the batch finish and then stops, without another call", async () => {
  let rt!: NativeRuntime;
  let session!: Awaited<ReturnType<NativeRuntime["start"]>>;
  const bus = await fakeBus((name) => {
    if (name === "mesh_send") void rt.endTurn(session);
    return { text: '{"ok":true}' };
  });
  const r = rig();
  try {
    const provider = new ScriptedProvider([{ tools: [{ name: "mesh_send", id: "t1" }, { name: "mesh_send", id: "t2" }], text: "writing the record" }, { text: "never" }]);
    rt = runtimeFor(provider);
    session = await rt.start(agent(), context(r, bus));
    const end = turnEnd(await collect(rt.stream(session, turnInput())));
    assert.equal(end.stopReason, "end_turn");
    assert.equal(end.error, undefined);
    assert.equal(provider.requests.length, 1);
    assert.equal(bus.calls.length, 2, "both calls of the batch ran: what was started is finished");
  } finally {
    r.cleanup();
    await bus.close();
  }
});

test("a batch of calls cut short by an interrupt leaves every call answered, those that did not run included", async () => {
  const bus = await fakeBus();
  const r = rig();
  try {
    fs.writeFileSync(path.join(r.workspace, "a.txt"), "x");
    const provider = new ScriptedProvider([
      { tools: [{ name: "Bash", args: { command: "sleep 30" }, id: "b1" }, { name: "Read", args: { file_path: "a.txt" }, id: "r1" }] },
      { tools: [{ name: "mesh_done" }] },
      { text: "ok" },
    ]);
    const rt = runtimeFor(provider);
    const session = await rt.start(agent({ capabilities: ["test.execute"] }), context(r, bus));
    const err = await (async () => {
      try {
        for await (const e of rt.stream(session, turnInput())) if (e.kind === "tool_call") setTimeout(() => void rt.interrupt(session), 100);
      } catch (e) {
        return e;
      }
    })();
    assert.ok(err instanceof InterruptedTurnError, String(err));
    await rt.send(session, turnInput("next"));
    const answers = provider.requests[1]!.messages.filter((m) => m.role === "tool") as Array<{ toolCallId: string; content: string; isError?: boolean }>;
    assert.deepEqual(answers.map((a) => a.toolCallId), ["b1", "r1"]);
    assert.match(answers[1]!.content, /This call did not run: the turn was stopped first\./);
    assert.equal(answers[1]!.isError, true);
  } finally {
    r.cleanup();
    await bus.close();
  }
});

test("a second turn on a seat that is mid-turn is refused, not interleaved", async () => {
  const bus = await fakeBus();
  const r = rig();
  try {
    const started = gate();
    const provider = new ScriptedProvider([{ hang: true, before: () => started.open() }]);
    const rt = runtimeFor(provider);
    const session = await rt.start(agent(), context(r, bus));
    const first = collect(rt.stream(session, turnInput())).catch(() => undefined);
    await started.wait;
    await assert.rejects(collect(rt.stream(session, turnInput())), /already in flight for dev/);
    await rt.interrupt(session);
    await first;
  } finally {
    r.cleanup();
    await bus.close();
  }
});

test("the status follows the seat: idle, running, parked, gone", async () => {
  const bus = await fakeBus();
  const r = rig();
  try {
    const started = gate();
    const provider = new ScriptedProvider([{ hang: true, before: () => started.open() }, { tools: [{ name: "mesh_done" }] }, { text: "ok" }]);
    const rt = runtimeFor(provider);
    const ctx = context(r, bus);
    const session = await rt.start(agent(), ctx);
    assert.equal(await rt.getStatus(session), "IDLE");
    const turn = collect(rt.stream(session, turnInput())).catch(() => undefined);
    await started.wait;
    assert.equal(await rt.getStatus(session), "RUNNING");
    await rt.interrupt(session);
    await turn;
    assert.equal(await rt.getStatus(session), "IDLE");
    await rt.suspend(session);
    assert.equal(await rt.getStatus(session), "SUSPENDED");
    assert.equal(await rt.resume(session, agent(), ctx), null, "a conversation held only in memory is gone once it is parked: the supervisor starts the seat afresh");
    await rt.stop(session);
    assert.equal(await rt.getStatus(session), "STOPPED");
    const unknown = { ...session, sessionId: "never-started", agentId: "other" };
    assert.equal(await rt.getStatus(unknown), "UNREACHABLE");
    await assert.rejects(collect(rt.stream(unknown, turnInput())), BackendUnreachableError);
  } finally {
    r.cleanup();
    await bus.close();
  }
});

test("a result larger than the bound is cut in the conversation, with a note", async () => {
  const bus = await fakeBus(() => ({ text: "z".repeat(200_000) }));
  const r = rig();
  try {
    const provider = new ScriptedProvider([{ tools: [{ name: "mesh_artifact_read", args: { artifactRef: "a" }, id: "t1" }] }, { text: "ok" }]);
    const rt = runtimeFor(provider);
    const session = await rt.start(agent(), context(r, bus));
    await rt.send(session, turnInput());
    const result = provider.requests[1]!.messages.find((m) => m.role === "tool") as { content: string };
    assert.equal(result.content.length, 120_000 + "\n[result cut at 120000 characters]".length);
    assert.match(result.content, /\[result cut at 120000 characters\]$/);
  } finally {
    r.cleanup();
    await bus.close();
  }
});

test("a seat's shell never holds the provider key, the mesh's tokens, or (in minimal mode) anything outside the allowlist", async () => {
  const bus = await fakeBus();
  const r = rig();
  try {
    for (const [mode, expectOther] of [["inherit", true], ["minimal", false]] as const) {
      const provider = new ScriptedProvider([{ tools: [{ name: "Bash", args: { command: "env" }, id: "b" }] }, { tools: [{ name: "mesh_done" }] }, { text: "ok" }]);
      const rt = runtimeFor(provider, {
        providers: { scripted: { kind: "openai-compatible", baseUrl: "http://unused.invalid/v1", keyEnv: "SCRIPTED_API_KEY" } },
        env: { PATH: process.env.PATH, HOME: "/home/x", SCRIPTED_API_KEY: "sk-very-secret", MESH_API_TOKEN: "operator-token", OTHER: "visible" },
        shellEnv: mode,
      });
      const session = await rt.start(agent({ capabilities: ["test.execute"] }), context(r, bus));
      await rt.send(session, turnInput());
      const out = (provider.requests[1]!.messages.find((m) => m.role === "tool") as { content: string }).content;
      assert.ok(!out.includes("sk-very-secret") && !out.includes("operator-token"), `${mode}: no credential in the shell`);
      assert.equal(out.includes("OTHER=visible"), expectOther, mode);
      assert.ok(out.includes("MESH_AGENT_ID=dev"), "the seat's own identity is there");
    }
  } finally {
    r.cleanup();
    await bus.close();
  }
});

test("a model names its provider as provider/model, split on the first slash; a bare name goes to the default or the only provider", async () => {
  const bus = await fakeBus();
  const r = rig();
  try {
    const seen: string[] = [];
    const providers = {
      openrouter: { kind: "openai-compatible" as const, baseUrl: "http://a.invalid/v1" },
      local: { kind: "openai-compatible" as const, baseUrl: "http://b.invalid/v1" },
    };
    const make = (name: string) => new ScriptedProvider([(req) => (seen.push(`${name}:${req.model}`), { tools: [{ name: "mesh_done" }] }), { text: "ok" }]);
    const byName: Record<string, ScriptedProvider> = { "a.invalid": make("openrouter"), "b.invalid": make("local") };
    const rt = new NativeRuntime({
      providers,
      defaultProvider: "local",
      createProvider: (cfg) => byName[new URL(cfg.baseUrl!).host]!,
      bus: { sleep: async () => undefined, startupDelaysMs: [1] },
    });
    for (const model of ["openrouter/openai/gpt-4o", "qwen-2.5", "local/llama-3"]) {
      for (const p of Object.values(byName)) p.reset();
      const s = await rt.start(agent({ model, id: `s-${seen.length}` }), context(r, bus));
      await rt.send(s, turnInput());
    }
    assert.deepEqual(seen, ["openrouter:openai/gpt-4o", "local:qwen-2.5", "local:llama-3"]);
  } finally {
    r.cleanup();
    await bus.close();
  }
});

test("a seat that cannot be given a model is refused at start, with what to do about it", async () => {
  const bus = await fakeBus();
  const r = rig();
  try {
    const none = new NativeRuntime({ providers: {} });
    await assert.rejects(none.start(agent(), context(r, bus)), /no provider is configured \(mesh\.runtime\.providers\)/);
    const two = new NativeRuntime({ providers: { a: { kind: "anthropic" }, b: { kind: "anthropic" } }, createProvider: () => new ScriptedProvider([]) });
    await assert.rejects(two.start(agent({ model: "x" }), context(r, bus)), /names no provider and there is no default; write it as provider\/model \(providers: a, b\)/);
    await assert.rejects(two.start(agent({ model: undefined }), context(r, bus)), /has no model: set its `model:` to provider\/model/);
    const unknown = new NativeRuntime({ providers: { a: { kind: "anthropic" } }, defaultProvider: "zzz", createProvider: () => new ScriptedProvider([]) });
    await assert.rejects(unknown.start(agent({ model: "x" }), context(r, bus)), /no provider named 'zzz'/);
    const defaulted = new NativeRuntime({ providers: { a: { kind: "anthropic" } }, defaultModel: "a/claude-x", createProvider: () => new ScriptedProvider([{ text: "ok" }]), bus: { sleep: async () => undefined } });
    await defaulted.start(agent({ model: undefined }), context(r, bus));
  } finally {
    r.cleanup();
    await bus.close();
  }
});

test("prompt caching is asked for only of a provider that caches on request", async () => {
  const bus = await fakeBus();
  const r = rig();
  try {
    for (const [kind, want] of [["anthropic", true], ["openai-compatible", false]] as const) {
      const provider = new ScriptedProvider([{ tools: [{ name: "mesh_done" }] }, { text: "ok" }], kind);
      const rt = runtimeFor(provider, { providers: { scripted: { kind } } });
      const session = await rt.start(agent(), context(r, bus));
      await rt.send(session, turnInput());
      assert.equal(provider.requests[0]!.cache, want, kind);
    }
  } finally {
    r.cleanup();
    await bus.close();
  }
});

test("model settings reach the call: the output cap, the effort and the temperature", async () => {
  const bus = await fakeBus();
  const r = rig();
  try {
    const provider = new ScriptedProvider([{ tools: [{ name: "mesh_done" }] }, { text: "ok" }]);
    const rt = runtimeFor(provider, { models: { "m-1": { maxOutputTokens: 4096, effort: "low", temperature: 0.2 } } });
    const session = await rt.start(agent(), context(r, bus));
    const end = turnEnd(await collect(rt.stream(session, turnInput())));
    const req = provider.requests[0]!;
    assert.deepEqual([req.maxOutputTokens, req.effort, req.temperature], [4096, "low", 0.2]);
    assert.equal(end.temperature, 0.2);
  } finally {
    r.cleanup();
    await bus.close();
  }
});

// ---- the conversation: size, rotation, overflow, persistence --------------------------------------------------------------

test("a conversation that has grown past its threshold is reported to the supervisor, which may ask for a handover before it is thrown away", async () => {
  const bus = await fakeBus();
  const r = rig();
  try {
    // The weight is the whole prompt: what was read from the cache and what was written to it count as much as fresh input.
    const provider = new ScriptedProvider([{ tools: [{ name: "mesh_send" }], usage: { input: 100, output: 10 } }, { text: "ok", usage: { input: 50, cacheRead: 650, cacheWrite: 50, output: 10 } }]);
    const rt = runtimeFor(provider, { contextWindow: 1000, models: { "m-1": { contextWindow: 1000 } } });
    const session = await rt.start(agent(), context(r, bus));
    assert.equal(rt.rotationPending(session), null, "an empty conversation weighs nothing");
    await rt.send(session, turnInput());
    const info = rt.rotationPending(session);
    assert.deepEqual({ ...info, sessionId: undefined }, { transcriptTokens: 750, thresholdTokens: 600, sessionId: undefined, cacheCold: false });
    assert.equal(info?.sessionId, (session.handle as { transcriptId: string }).transcriptId, "it names the conversation about to be discarded");
    // The window of one seat outranks the model's and the mesh's: the same weight is no cause for rotation under 10,000 tokens.
    const wide = await rt.start(agent({ id: "wide", contextWindow: 10_000 }), context(r, bus));
    provider.reset();
    await rt.send(wide, turnInput());
    assert.equal(rt.rotationPending(wide), null);
    // At exactly the threshold the conversation is due.
    const edge = await rt.start(agent({ id: "edge" }), context(r, bus));
    provider.reset();
    await rt.send(edge, turnInput());
    assert.equal(rt.rotationPending(edge)?.transcriptTokens, 750);
    const exact = new ScriptedProvider([{ tools: [{ name: "mesh_send" }], usage: { input: 600, output: 10 } }, { text: "ok", usage: { input: 600, output: 10 } }]);
    const rt2 = runtimeFor(exact, { contextWindow: 1000 });
    const s2 = await rt2.start(agent(), context(r, bus));
    await rt2.send(s2, turnInput());
    assert.equal(rt2.rotationPending(s2)?.thresholdTokens, 600);
    assert.equal(rt2.rotationPending(s2)?.transcriptTokens, 600, "a conversation exactly at its threshold is due");
  } finally {
    r.cleanup();
    await bus.close();
  }
});

test("the handover turn runs on the old conversation; the turn after it starts a new one and says so", async () => {
  const bus = await fakeBus();
  const r = rig();
  try {
    const rotations: Array<{ previousSdkSessionId: string; sdkSessionId: string; contextTokens: number; reason: string }> = [];
    const provider = new ScriptedProvider([
      { tools: [{ name: "mesh_send" }], usage: { input: 700, output: 10 } },
      { text: "first done", usage: { input: 750, output: 10 } },
      { tools: [{ name: "mesh_done" }], usage: { input: 760, output: 10 } },
      { text: "continuity written", usage: { input: 765, output: 10 } },
      { tools: [{ name: "mesh_done" }], usage: { input: 100, output: 10 } },
      { text: "fresh", usage: { input: 110, output: 10 } },
    ]);
    const rt = runtimeFor(provider, { contextWindow: 1000, onRotate: (i) => rotations.push(i) });
    const session = await rt.start(agent(), context(r, bus));
    await rt.send(session, turnInput("one"));
    const before = (session.handle as { transcriptId: string }).transcriptId;
    await rt.send(session, turnInput("handover please", { suppressRotation: true }));
    assert.equal(rotations.length, 0, "a handover turn is not rotated on the way in");
    assert.ok(provider.requests[2]!.messages.length > 1, "it ran on the conversation it was asked to summarise");
    await rt.send(session, turnInput("two"));
    assert.deepEqual(provider.requests[4]!.messages, [{ role: "user", content: "two" }], "the successor starts from the briefing alone");
    assert.equal(rotations.length, 1);
    assert.equal(rotations[0]!.previousSdkSessionId, before);
    assert.notEqual(rotations[0]!.sdkSessionId, before);
    assert.equal(rotations[0]!.contextTokens, 765);
    assert.equal(rotations[0]!.reason, "rotation");
  } finally {
    r.cleanup();
    await bus.close();
  }
});

test("a conversation idle past its provider's cache lifetime is reported as cold, once it is big enough to matter", async () => {
  const bus = await fakeBus();
  const r = rig();
  try {
    const provider = new ScriptedProvider([{ tools: [{ name: "mesh_send" }], usage: { input: 700, output: 10 } }, { text: "ok", usage: { input: 700, output: 10 } }]);
    const rt = runtimeFor(provider, {
      providers: { scripted: { kind: "anthropic", cacheTtlMs: 30 } },
      contextWindow: 100_000,
      staleFloorTokens: 500,
    });
    const session = await rt.start(agent(), context(r, bus));
    await rt.send(session, turnInput());
    assert.equal(rt.rotationPending(session), null, "just ended: the cache is warm");
    await new Promise((resolve) => setTimeout(resolve, 60));
    const info = rt.rotationPending(session);
    assert.equal(info?.cacheCold, true);
    assert.equal(rt.rotationPending(session)?.cacheCold, true, "and it stays reported until the rotation happens");
  } finally {
    r.cleanup();
    await bus.close();
  }
});

test("a prompt the model refuses for its size is shrunk once, and then the conversation is rotated, without failing the turn", async () => {
  const bus = await fakeBus();
  const r = rig();
  try {
    const notices: string[] = [];
    const big = { name: "Bash", args: { command: "head -c 6000 /dev/zero | tr '\\0' x" } };
    const overflow = () => ({ fail: new ProviderError("scripted", { kind: "context_overflow", status: 400, detail: "prompt is too long" }) });
    const provider = new ScriptedProvider([
      { tools: [{ ...big, id: "b1" }] },
      { tools: [{ ...big, id: "b2" }] },
      { tools: [{ ...big, id: "b3" }] },
      { tools: [{ ...big, id: "b4" }] },
      { tools: [{ ...big, id: "b5" }] },
      overflow(), // shrink
      overflow(), // still too long: rotate
      { tools: [{ name: "mesh_done" }] },
      { text: "recovered" },
    ]);
    const rt = runtimeFor(provider, { onNotice: (n) => void (n.kind === "context_overflow" && notices.push(n.kind)) });
    const session = await rt.start(agent({ capabilities: ["test.execute"] }), context(r, bus));
    const end = turnEnd(await collect(rt.stream(session, turnInput("the briefing"))));
    assert.equal(end.text, "recovered");
    assert.equal(end.error, undefined);
    // After the first refusal: older results elided, the latest eight messages whole.
    const shrunk = provider.requests[6]!.messages.filter((m) => m.role === "tool") as Array<{ content: string }>;
    assert.ok(shrunk.some((m) => m.content.startsWith("[elided to fit the context window: ")));
    assert.ok(shrunk.some((m) => m.content.length > 5000), "the most recent results are kept whole");
    // After the second: only the briefing.
    assert.deepEqual(provider.requests[7]!.messages, [{ role: "user", content: "the briefing" }]);
    assert.deepEqual(notices, ["context_overflow", "context_overflow"]);
  } finally {
    r.cleanup();
    await bus.close();
  }
});

test("a prompt that is refused again after all that fails the turn, as the seat's own failure and not an outage", async () => {
  const bus = await fakeBus();
  const r = rig();
  try {
    const provider = new ScriptedProvider([{ fail: new ProviderError("scripted", { kind: "context_overflow", status: 400, detail: "prompt is too long" }) }]);
    const rt = runtimeFor(provider);
    const session = await rt.start(agent(), context(r, bus));
    const end = turnEnd(await collect(rt.stream(session, turnInput())));
    assert.equal(end.stopReason, "error");
    assert.equal(classifyProviderOutage(end.error), null);
    assert.equal(provider.requests.length, 3, "the first try, one after shrinking, one after rotating");
  } finally {
    r.cleanup();
    await bus.close();
  }
});

test("older tool results are replaced by a note and the most recent messages are left whole", () => {
  const messages = [
    { role: "user", content: "briefing" },
    ...Array.from({ length: 6 }, (_, i) => [
      { role: "assistant" as const, content: "", toolCalls: [{ id: `c${i}`, name: "Read", args: {} }] },
      { role: "tool" as const, toolCallId: `c${i}`, name: "Read", content: `${i}`.repeat(3000) },
    ]).flat(),
  ] as never[];
  const freed = elideOldToolResults(messages);
  assert.equal(freed, 3000 * 2, "the two results older than the last eight messages");
  assert.match((messages[2] as { content: string }).content, /^\[elided to fit the context window: 3000 characters\]$/);
  assert.match((messages[4] as { content: string }).content, /^\[elided/);
  assert.equal((messages[6] as { content: string }).content.length, 3000, "the first of the recent results is whole");
  assert.equal((messages[12] as { content: string }).content.length, 3000);
  assert.equal(elideOldToolResults(messages), 0, "nothing more to free");
});

test("a conversation is kept on disk and resumed by a new process, from the id the supervisor recorded", async () => {
  const bus = await fakeBus();
  const r = rig();
  const state = path.join(r.base, "state");
  try {
    const first = new ScriptedProvider([{ tools: [{ name: "mesh_send", id: "t1" }], usage: { input: 300, output: 10 } }, { text: "ok", usage: { input: 320, output: 10 } }]);
    const rtA = runtimeFor(first, { stateDir: state });
    const session = await rtA.start(agent(), context(r, bus));
    await rtA.send(session, turnInput("first briefing"));

    const second = new ScriptedProvider([{ tools: [{ name: "mesh_done" }] }, { text: "resumed" }]);
    const rtB = runtimeFor(second, { stateDir: state, contextWindow: 500 });
    const restored = await rtB.restoreSession(agent(), session.sessionId, context(r, bus));
    assert.ok(restored);
    assert.equal(restored.sessionId, session.sessionId);
    assert.equal(rtB.rotationPending(restored)?.transcriptTokens, 320, "what the conversation weighed is remembered too");
    await rtB.send(restored, turnInput("second briefing", { suppressRotation: true }));
    assert.deepEqual(
      second.requests[0]!.messages.map((m) => m.role),
      ["user", "assistant", "tool", "assistant", "user"],
    );
    assert.equal((second.requests[0]!.messages[0] as { content: string }).content, "first briefing");
    assert.equal((second.requests[0]!.messages.at(-1) as { content: string }).content, "second briefing");
  } finally {
    r.cleanup();
    await bus.close();
  }
});

test("a conversation a kill cut short resumes cleanly: a torn last line is dropped, a call left unanswered is answered", async () => {
  const bus = await fakeBus();
  const r = rig();
  const state = path.join(r.base, "state");
  try {
    const rtA = runtimeFor(new ScriptedProvider([{ hang: true }]), { stateDir: state });
    const session = await rtA.start(agent(), context(r, bus));
    const file = path.join(state, "native", "dev", `${session.sessionId}.jsonl`);
    fs.appendFileSync(
      file,
      [
        JSON.stringify({ type: "message", role: "user", content: "briefing" }),
        JSON.stringify({ type: "message", role: "assistant", content: "working", toolCalls: [{ id: "x1", name: "Read", args: {} }, { id: "x2", name: "Glob", args: {} }] }),
        JSON.stringify({ type: "message", role: "tool", toolCallId: "x1", name: "Read", content: "answered" }),
        '{"type":"message","role":"tool","toolCallId":"x2","na', // cut mid-write
      ].join("\n"),
    );
    const provider = new ScriptedProvider([{ tools: [{ name: "mesh_done" }] }, { text: "ok" }]);
    const rtB = runtimeFor(provider, { stateDir: state });
    const restored = await rtB.restoreSession(agent(), session.sessionId, context(r, bus));
    assert.ok(restored);
    await rtB.send(restored, turnInput("next"));
    const msgs = provider.requests[0]!.messages;
    assert.deepEqual(
      msgs.map((m) => (m.role === "tool" ? `tool:${m.toolCallId}` : m.role)),
      ["user", "assistant", "tool:x1", "tool:x2", "user"],
    );
    const filled = msgs[3] as { content: string; isError?: boolean };
    assert.match(filled.content, /did not run: the session was interrupted/);
    assert.equal(filled.isError, true);
  } finally {
    r.cleanup();
    await bus.close();
  }
});

test("a line that does not parse ends the conversation there, and the file is cut back so what is appended next is whole", async () => {
  const bus = await fakeBus();
  const r = rig();
  const state = path.join(r.base, "state");
  try {
    const rtA = runtimeFor(new ScriptedProvider([{ hang: true }]), { stateDir: state });
    const session = await rtA.start(agent(), context(r, bus));
    const file = path.join(state, "native", "dev", `${session.sessionId}.jsonl`);
    fs.appendFileSync(
      file,
      [JSON.stringify({ type: "message", role: "user", content: "briefing" }), "{not json", JSON.stringify({ type: "message", role: "assistant", content: "after the damage" })].join("\n"),
    );
    const provider = new ScriptedProvider([{ tools: [{ name: "mesh_done" }] }, { text: "ok" }]);
    const rtB = runtimeFor(provider, { stateDir: state });
    const restored = await rtB.restoreSession(agent(), session.sessionId, context(r, bus));
    assert.ok(restored);
    await rtB.send(restored, turnInput("next"));
    assert.deepEqual(provider.requests[0]!.messages.map((m) => m.role), ["user", "user"], "what followed the damage is not trusted");
    // A third process reads everything the second one appended: nothing was lost to a fragment.
    const again = new ScriptedProvider([{ text: "ok" }]);
    const rtC = runtimeFor(again, { stateDir: state });
    const restoredAgain = await rtC.restoreSession(agent(), session.sessionId, context(r, bus));
    assert.ok(restoredAgain);
    await rtC.send(restoredAgain, turnInput("and again"));
    assert.deepEqual(
      again.requests[0]!.messages.map((m) => m.role),
      ["user", "user", "assistant", "tool", "assistant", "user"],
    );
  } finally {
    r.cleanup();
    await bus.close();
  }
});

test("a session that was never kept is not restored, so the supervisor starts the seat afresh; nor is one from another seat", async () => {
  const bus = await fakeBus();
  const r = rig();
  const state = path.join(r.base, "state");
  try {
    const rt = runtimeFor(new ScriptedProvider([{ text: "ok" }]), { stateDir: state });
    assert.equal(await rt.restoreSession(agent(), "no-such-session", context(r, bus)), null);
    const s = await rt.start(agent({ id: "qa" }), context(r, bus));
    assert.equal(await runtimeFor(new ScriptedProvider([]), { stateDir: state }).restoreSession(agent({ id: "dev" }), s.sessionId, context(r, bus)), null);
    const inMemory = runtimeFor(new ScriptedProvider([{ text: "ok" }]));
    const m = await inMemory.start(agent(), context(r, bus));
    assert.equal(await runtimeFor(new ScriptedProvider([])).restoreSession(agent(), m.sessionId, context(r, bus)), null, "without a state directory there is nothing to resume from");
  } finally {
    r.cleanup();
    await bus.close();
  }
});

test("after a rotation the new conversation is the one on disk, and old ones are not kept beyond the last two", async () => {
  const bus = await fakeBus();
  const r = rig();
  const state = path.join(r.base, "state");
  try {
    const rotated: string[] = [];
    const provider = new ScriptedProvider([{ text: "ok", usage: { input: 700, output: 10 } }]);
    const rt = runtimeFor(provider, { stateDir: state, contextWindow: 1000, onRotate: (i) => rotated.push(i.sdkSessionId) });
    const session = await rt.start(agent(), context(r, bus));
    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await rt.send(session, turnInput(`turn ${i}`));
    }
    assert.equal(rotated.length, 3);
    const files = fs.readdirSync(path.join(state, "native", "dev"));
    assert.equal(files.length, 2);
    assert.ok(files.includes(`${rotated[2]}.jsonl`), "the live conversation is kept");
    // The id the registry recorded at the last rotation is the one a restart restores.
    const restored = await runtimeFor(new ScriptedProvider([]), { stateDir: state }).restoreSession(agent(), rotated[2]!, context(r, bus));
    assert.ok(restored);
  } finally {
    r.cleanup();
    await bus.close();
  }
});

// ---- the designer ---------------------------------------------------------------------------------------------------------

test("the designer's chat streams text and thinking apart, calls the staging tools the bus offers, and answers with the last thing it said", async () => {
  const bus = await fakeBus();
  try {
    const provider = new ScriptedProvider([
      { reasoning: "the user wants a QA seat", text: ["Let me stage that. "], tools: [{ name: "mesh_stage_seat", args: { id: "qa" }, id: "s1" }] },
      { text: ["Staged ", "a QA seat."] },
    ]);
    const rt = runtimeFor(provider, { designerModel: "scripted/m-1" });
    const deltas: Array<[string, string]> = [];
    const result = await rt.promptStream(
      "add a QA seat",
      { system: "You are the designer.", mcp: { url: `${bus.server.url}/internal/mcp/human?staging=1`, headers: { "x-mesh-token": "human-secret", "x-mesh-designer-turn": "turn-7" } } },
      (d) => deltas.push([d.kind, d.delta]),
    );
    assert.equal(result.reply, "Staged a QA seat.");
    assert.equal(result.thinking, "the user wants a QA seat");
    assert.deepEqual(deltas, [["thinking", "the user wants a QA seat"], ["text", "Let me stage that. "], ["text", "Staged "], ["text", "a QA seat."]]);
    assert.deepEqual(bus.calls, [{ name: "mesh_stage_seat", args: { id: "qa" }, token: "human-secret", url: "/internal/mcp/human?staging=1" }]);
    assert.equal(provider.requests[0]!.system, "You are the designer.");
    assert.deepEqual(toolNames(provider.requests[0]!), BUS_TOOLS.map((t) => t.name).sort(), "the designer has the bus's tools and no tool of a seat's own");
  } finally {
    await bus.close();
  }
});

test("a one-shot prompt with no tools is one call, and a throwing delta consumer does not take it down", async () => {
  const provider = new ScriptedProvider([{ text: ["a", "b"] }]);
  const rt = runtimeFor(provider, { designerModel: "scripted/m-1" });
  const reply = await rt.promptStream("hi", {}, () => {
    throw new Error("observer bug");
  });
  assert.equal(reply.reply, "ab");
  assert.equal(provider.requests.length, 1);
  assert.equal(provider.requests[0]!.tools?.length ?? 0, 0);
  assert.equal(await runtimeFor(new ScriptedProvider([{ text: "x" }]), { designerModel: "scripted/m-1" }).prompt("hi"), "x");
  await assert.rejects(runtimeFor(new ScriptedProvider([]), {}).prompt("hi"), /the designer has no model/);
});

test("the model catalogue lists each provider's models under its name, and says which provider could not be asked", async () => {
  const good = new ScriptedProvider([], "openai-compatible", ["x", "y"]);
  const bad = new ScriptedProvider([]);
  bad.listModels = async () => {
    throw new Error("401 bad key");
  };
  const providers = { a: { kind: "openai-compatible" as const, baseUrl: "http://a.invalid/v1" }, b: { kind: "openai-compatible" as const, baseUrl: "http://b.invalid/v1" } };
  const rt = new NativeRuntime({ providers, designerModel: "a/x", createProvider: (cfg) => (cfg.baseUrl!.includes("//a.") ? good : bad) });
  assert.deepEqual(await rt.listModels(), { models: ["a/x", "a/y"], default: "a/x", error: "b: 401 bad key" });
});

test("stopping the runtime interrupts what is running and forgets the sessions", async () => {
  const bus = await fakeBus();
  const r = rig();
  try {
    const started = gate();
    const provider = new ScriptedProvider([{ hang: true, before: () => started.open() }]);
    const rt = runtimeFor(provider);
    const session = await rt.start(agent(), context(r, bus));
    const turn = collect(rt.stream(session, turnInput())).catch((e: unknown) => e);
    await started.wait;
    await rt.stopAll();
    assert.ok((await turn) instanceof InterruptedTurnError);
    assert.equal(await rt.getStatus(session), "UNREACHABLE");
  } finally {
    r.cleanup();
    await bus.close();
  }
});
