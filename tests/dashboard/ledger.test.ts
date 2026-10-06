import test from "node:test";
import assert from "node:assert/strict";

import { createMcpToolset } from "../../apps/mesh-server/src/mcp";
import {
  OP_EFFECTS,
  OP_TOOLS,
  READ_OPS,
  READ_TOOLS,
  CALL_DESUGARS,
  buildLedger,
  canonicalOp,
  clipMap,
  ledgerTally,
  opHead,
  producedFromTimeline,
  recordNotices,
  splitSummary,
  storageClips,
  valueAt,
} from "../../apps/mesh-dashboard/src/ledger";

/**
 * The step view's action ledger. The bugs these pin, all seen on one live
 * architect turn: the ledger was read from the captured tool calls, which the
 * runtime truncates, so a 54-call turn showed 13 of its 23 ops and dropped the
 * rest without saying so; a refused `withdraw` rendered "n/a — produces nothing
 * observable"; half the op tools had no effect entry and rendered as raw
 * `mesh_approve` rows; and the Steps list's zero-filled counts headlined a turn
 * that published eight artifacts "Refused".
 */

/**
 * The bridge's own tool table and `toOp` translation. Private, and reached
 * into on purpose: the advertised list (`tools/list`) is filtered per seat by
 * capability and vocabulary, so no one seat sees every tool, and `toOp` is the
 * only statement of which op a tool becomes. The constructor only builds the
 * definitions, so it needs no live supervisor.
 */
function bridge(): { tools: string[]; toOp: (name: string, args: Record<string, unknown>) => { op: string } } {
  const mcp = createMcpToolset({} as never) as unknown as {
    tools: Map<string, unknown>;
    toOp: (name: string, args: Record<string, unknown>) => { op: string };
  };
  return { tools: [...mcp.tools.keys()], toOp: (n, a) => mcp.toOp(n, a) };
}

test("every op tool maps to the canonical op mcp.ts builds, and every op has an explicit effect entry", () => {
  const { tools, toOp } = bridge();
  assert.ok(tools.length >= 40, `expected the full toolset, got ${tools.length}`);
  for (const name of tools) {
    let op: string | null = null;
    try {
      op = toOp(name, {}).op;
    } catch {
      op = null;
    }
    if (op === null) {
      assert.ok(READ_TOOLS.has(name), `${name} never becomes an op, so it must be a read tool here`);
      continue;
    }
    assert.ok(!READ_TOOLS.has(name), `${name} becomes op ${op} but is listed as a read tool`);
    assert.equal(canonicalOp({ op: name }), op, `${name} → ${op}`);
    assert.equal(canonicalOp({ op: `mcp__mesh__${name}` }), op, `the MCP server prefix is stripped for ${name}`);
    assert.ok(OP_EFFECTS[op] !== undefined, `${op} (from ${name}) needs an effect entry, or an explicit "none"/"read"`);
  }
  // The one tool whose op depends on its arguments.
  assert.equal(toOp("mesh_announce", { to: ["pm"], payload: {} }).op, "send");
  assert.equal(canonicalOp({ op: "mesh_announce", to: ["pm"] }), "send");
  assert.equal(canonicalOp({ op: "mesh_announce", to: [] }), "broadcast");
  // No stale entries: every tool this table names still exists.
  for (const name of Object.keys(OP_TOOLS)) assert.ok(tools.includes(name), `${name} is not a tool mcp.ts builds`);
  for (const name of READ_TOOLS) assert.ok(tools.includes(name), `${name} is not a tool mcp.ts builds`);
  // What a `mesh_call` desugars into is in `turn.ops`, so it needs effects too.
  for (const op of CALL_DESUGARS) assert.ok(typeof OP_EFFECTS[op] === "object", `${op} needs effect types`);
  for (const op of READ_OPS) assert.equal(OP_EFFECTS[op], "read");
});

/* The architect turn, reduced: 23 executed ops, 30 captured calls of 54. */
const ARCH_OPS = [
  "contracts", "request_research", "plan", "publish_artifact", "publish_artifact", "publish_artifact", "publish_artifact",
  "request_review", "request_review", "request_review", "request_review", "send", "withdraw", "read_artifact",
  "publish_artifact", "publish_artifact", "publish_artifact", "publish_artifact", "respond", "send", "remember", "remember", "wait",
];
const call = (name: string, args: Record<string, unknown> = {}) => ({ name: `mcp__mesh__${name}`, args, resultDigest: "dgx" });
const ARCH_CALLS = [
  call("mesh_inbox", { limit: 25 }), call("mesh_contracts"), call("mesh_run_status"), call("mesh_agent_activity"),
  { name: "Bash", args: { command: "ls" }, resultDigest: "x" },
  call("mesh_research_request", { to: "explorer", question: "Is the repository greenfield?" }),
  { name: "Read", args: { file_path: "README.md" }, resultDigest: "x" },
  call("mesh_plan", { steps: [{ text: "survey" }, { text: "design" }] }),
  ...["a1", "a2", "a3", "a4"].map((id) => call("mesh_artifact_publish", { name: `Doc ${id}`, type: "ADR", fromPath: `docs/${id}.md` })),
  ...["a1", "a2", "a3", "a4"].map((id) => call("mesh_request_review", { artifactId: `art-${id}xxxxxxxxxx`, reviewers: ["tech-lead"] })),
  call("mesh_send", { type: "REQUEST_INFO", to: ["pm"], payload: { question: "scope?" } }),
  call("mesh_withdraw", { messageId: "msg-M3D4VVXX00e5d7d3883b", reason: "narrower ask" }),
  call("mesh_inbox", { limit: 25 }),
  call("mesh_artifact_read", { artifactRef: "art-req" }),
  { name: "Edit", args: {}, resultDigest: "x" },
];
const ARCH_TIMINGS = ARCH_OPS.map((op) => ({ op, ms: 3, ok: op !== "withdraw", ...(op === "withdraw" ? { reason: "no outstanding request 'msg-M3D4VVXX00e5d7d3883b'" } : {}) }));
const ev = (seq: number, type: string, payload: Record<string, unknown> = {}) => ({ seq, type, at: "2026-09-25T20:42:15.869Z", payload });
const ARCH_TIMELINE = [
  ev(1, "research.requested", { question: "Is the repository greenfield?" }),
  ev(2, "message.sent", { message: { type: "REQUEST_RESEARCH", to: ["explorer"] } }),
  ev(3, "plan.updated", { plan: { steps: [] } }),
  ...["a1", "a2", "a3", "a4"].map((id, i) => ev(10 + i, "artifact.created", { artifact: { id: `art-${id}xxxxxxxxxx`, name: `Doc ${id}`, type: "ADR" } })),
  ...["a1", "a2", "a3", "a4"].map((id, i) => ev(20 + i, "review.requested", { artifactId: `art-${id}xxxxxxxxxx`, reviewers: ["tech-lead"] })),
  ...["a1", "a2", "a3", "a4"].map((id, i) => ev(30 + i, "artifact.transition", { artifactId: `art-${id}xxxxxxxxxx`, to: "UNDER_REVIEW", derived: true })),
  ev(40, "message.sent", { message: { type: "REQUEST_INFO", to: ["pm"] } }),
  // Discharged by the reviews being superseded, not by the refused withdraw.
  ev(41, "commitment.discharged", { messageId: "msg-other", reason: "superseded" }),
  ...["a1", "a2", "a3", "a4"].map((id, i) => ev(50 + i, "artifact.versioned", { artifact: { id: `art-${id}xxxxxxxxxx`, name: `Doc ${id}`, version: 2 } })),
  ev(60, "message.sent", { message: { type: "INFORM", to: ["pm"], replyTo: "msg-q" } }),
  ev(61, "message.sent", { message: { type: "INFORM", to: ["tech-lead"] } }),
  ev(62, "memory.updated", { note: { key: "k1" } }),
  ev(63, "memory.updated", { note: { key: "k2" } }),
  ev(64, "agent.state_changed", { to: "WAITING" }),
];

test("rows come from the complete op list, not the captured calls, and say which were captured", () => {
  const l = buildLedger({ ops: ARCH_OPS, opTimings: ARCH_TIMINGS, toolCalls: ARCH_CALLS, timeline: ARCH_TIMELINE });
  assert.ok(l);
  assert.equal(l.source, "ops");
  // 23 ops less the two reads (contracts, read_artifact).
  assert.equal(l.rows.length, 21);
  assert.deepEqual(l.rows.map((r) => r.kind), ARCH_OPS.filter((o) => o !== "contracts" && o !== "read_artifact"));
  // research, plan, 4 publishes, 4 reviews, send, withdraw.
  assert.equal(l.captured, 12);
  const uncaptured = l.rows.filter((r) => r.uncaptured);
  assert.equal(uncaptured.length, 9);
  assert.deepEqual(uncaptured.map((r) => r.kind), ["publish_artifact", "publish_artifact", "publish_artifact", "publish_artifact", "respond", "send", "remember", "remember", "wait"]);
  for (const r of uncaptured) assert.deepEqual(r.op, { op: r.kind }, "an uncaptured row carries its name and nothing invented");
  // Captured rows carry the call they came from.
  assert.equal(l.rows[0]!.op.op, "mesh_research_request");
  assert.equal(l.rows[10]!.op.to[0], "pm");
  // Every op kept its place: the 5th-8th publishes were still counted, and
  // each found its own new version in the log.
  assert.ok(l.rows.slice(12, 16).every((r) => r.fx?.type === "artifact.versioned"));
  assert.equal(l.rows[20]!.fx?.type, "agent.state_changed", "wait pairs with the parked state");
});

test("a refused op carries the kernel's reason, is never paired, and never counts as missing", () => {
  const l = buildLedger({ ops: ARCH_OPS, opTimings: ARCH_TIMINGS, toolCalls: ARCH_CALLS, timeline: ARCH_TIMELINE })!;
  const w = l.rows.find((r) => r.kind === "withdraw")!;
  assert.deepEqual(w.refusal, { reason: "no outstanding request 'msg-M3D4VVXX00e5d7d3883b'" });
  assert.equal(w.fx, null, "a refusal landed nothing — it is not 'n/a'");
  assert.equal(w.head.title, "Withdrew its own ask");
  const tally = ledgerTally(l.rows);
  assert.equal(tally.refused, 1);
  // done-less turn: every non-refused row expects an effect.
  assert.equal(tally.expected, 20);
  assert.equal(tally.landed, 20);
  // The discharge event in the log belongs to someone else's settlement: a
  // non-refused discharge op would take it; the refused withdraw must not.
  assert.ok(!l.rows.some((r) => r.fx?.type === "commitment.discharged"));
});

test("opTimings join by index tolerating call → desugared op, and by occurrence when they do not line up", () => {
  // Index join: `mesh_call` timed as "call", recorded as "send".
  const a = buildLedger({
    ops: ["send", "withdraw"],
    opTimings: [{ op: "call", ok: true }, { op: "withdraw", ok: false, reason: "not yours" }],
    toolCalls: [call("mesh_call", { contract: "info.question", to: ["pm"], request: { question: "why?" } }), call("mesh_withdraw", { messageId: "msg-1" })],
    timeline: [ev(1, "message.sent", { message: { to: ["pm"] } })],
  })!;
  assert.equal(a.rows[0]!.op.op, "mesh_call", "the desugared send kept the arguments of the call that made it");
  assert.equal(a.rows[0]!.kind, "send");
  assert.equal(a.rows[0]!.head.title, "Called info.question → pm");
  assert.equal(a.rows[0]!.fx?.type, "message.sent");
  assert.equal(a.rows[0]!.refusal, undefined);
  assert.deepEqual(a.rows[1]!.refusal, { reason: "not yours" });

  // Two sends, the first desugared from a refused call. By occurrence alone
  // the plain send's verdict would go to the first row and the refusal to the
  // second; in place, the call's refusal stays on the call.
  const d = buildLedger({
    ops: ["send", "send"],
    opTimings: [{ op: "call", ok: false, reason: "unknown contract" }, { op: "send", ok: true }],
    toolCalls: [call("mesh_call", { contract: "nope" }), call("mesh_send", { type: "INFORM", to: ["qa"] })],
    timeline: [],
  })!;
  assert.deepEqual(d.rows.map((r) => [r.op.op, r.refusal?.reason]), [["mesh_call", "unknown contract"], ["mesh_send", undefined]]);

  // Not aligned (two channels merged in another order): per-name occurrence.
  const b = buildLedger({
    ops: ["send", "publish_artifact", "send"],
    opTimings: [{ op: "publish_artifact", ok: true }, { op: "send", ok: true }, { op: "send", ok: false, reason: "blocked" }],
    timeline: [],
  })!;
  assert.deepEqual(b.rows.map((r) => r.refusal?.reason), [undefined, undefined, "blocked"]);

  // Capped timings (the tracker keeps the first 60): the prefix still lines up.
  const ops = Array.from({ length: 70 }, (_, i) => (i === 65 ? "withdraw" : "remember"));
  const c = buildLedger({ ops, opTimings: ops.slice(0, 60).map((op, i) => ({ op, ok: i !== 3 })), timeline: [] })!;
  assert.equal(c.rows.filter((r) => r.refusal).length, 1);
  assert.ok(c.rows[3]!.refusal);
  assert.equal(c.rows[65]!.refusal, undefined, "an op past the cap has no verdict, not a guessed one");
});

test("without the kernel's op list the rows are the captured calls, and refusals still join", () => {
  const l = buildLedger({
    opTimings: [{ op: "approve", ok: true }, { op: "withdraw", ok: false, reason: "gone" }],
    toolCalls: [call("mesh_inbox"), call("mesh_approve", { subject: "requirements", artifactId: "art-r" }), { name: "Read", args: {} }, call("mesh_withdraw", { messageId: "msg-9" })],
    timeline: [ev(1, "review.approved", { subject: "requirements", artifactId: "art-r", artifactRef: { uri: "artifact://RequirementsDoc/Requirements%20v2/2" } })],
  })!;
  assert.equal(l.source, "calls");
  assert.deepEqual(l.rows.map((r) => r.kind), ["approve", "withdraw"]);
  assert.equal(l.rows[0]!.fx?.type, "review.approved");
  assert.equal(l.rows[0]!.head.title, "Approved requirements");
  assert.deepEqual(l.rows[0]!.head.facts, [{ k: "artifact", v: "Requirements v2" }], "the artifact id resolves to its name from the log");
  assert.deepEqual(l.rows[1]!.refusal, { reason: "gone" });
  assert.equal(buildLedger({ toolCalls: [call("mesh_inbox"), call("mesh_artifact_read", { artifactRef: "x" })], timeline: [] }), null);
});

test("produced counts come from the turn's own events, in the server's step buckets", () => {
  assert.equal(producedFromTimeline([]), undefined, "no timeline is unknown, not zero");
  const counts = producedFromTimeline([
    ev(1, "message.sent"), ev(2, "message.sent"), ev(3, "artifact.created"), ev(4, "artifact.versioned"),
    ev(5, "task.created"), ev(6, "task.claimed"), ev(7, "task.completed"),
    ev(8, "decision.proposed"), ev(9, "review.approved"), ev(10, "review.rejected"), ev(11, "requirement.satisfied"),
    ev(12, "architecture.approved"), ev(13, "artifact.transition", { to: "APPROVED" }),
    // The supervisor mirroring a move a review request already made: not a decision.
    ev(14, "artifact.transition", { to: "UNDER_REVIEW", derived: true }),
    ev(15, "memory.updated"), ev(16, "budget.consumed"), ev(17, "review.requested"),
  ]);
  assert.deepEqual(counts, { messages: 2, artifacts: 2, tasks: 3, decisions: 6 });
  // The architect turn's "8 decisions" were its 8 derived transitions.
  const arch = producedFromTimeline(ARCH_TIMELINE);
  assert.equal(arch?.decisions, 0, "four review requests and their mirrored moves are not decisions");
  assert.deepEqual(producedFromTimeline([ev(1, "agent.state_changed")]), { messages: 0, artifacts: 0, tasks: 0, decisions: 0 });
});

test("op titles are sentence case: never a raw op, tool or message-type name", () => {
  const rawName = /mesh_|\b[a-z]+_[a-z_]+\b|\b[A-Z]+_[A-Z_]+\b/;
  const names = new Set([...Object.keys(OP_TOOLS), ...Object.values(OP_TOOLS), "mesh_message", "unknown_future_op"]);
  for (const n of names) {
    const { title } = opHead({ op: n });
    assert.ok(title.length > 0, `${n} has a title`);
    assert.doesNotMatch(title, rawName, `${n} → "${title}"`);
    assert.match(title, /^[A-Z]/, `${n} → "${title}" starts upper-case`);
  }
  assert.equal(opHead({ op: "mesh_send", type: "REQUEST_INFO", to: ["pm"] }).title, "Request info → pm");
  assert.equal(opHead({ op: "mesh_send", type: "INFORM", to: ["pm", "qa"] }).title, "Update → pm, qa");
  assert.equal(opHead({ op: "mesh_request", to: ["qa"] }).title, "Ask for help → qa");
  assert.equal(opHead({ op: "mesh_announce", payload: {} }).title, "Update → everyone");
  assert.equal(opHead({ op: "mesh_artifact_transition", artifactId: "art-M3D54QXS006eca2e1488", to: "READY_FOR_REVIEW" }).title, "Moved art-…2e1488 → ready for review");
  // create_task reads the declared `description`; send reads `artifactRefs`.
  assert.equal(opHead({ op: "mesh_task_create", title: "Wire the CLI", description: "Add the flag" }).detail, "Add the flag");
  const send = opHead({ op: "mesh_send", type: "INFORM", to: ["pm"], artifactRefs: ["artifact://ADR/ADR%200001/1"] });
  assert.deepEqual(send.facts, [{ k: "artifact", v: "ADR 0001" }]);
});

test("a review request names its artifact from the turn's own events, else by a short id", () => {
  const l = buildLedger({
    ops: ["publish_artifact", "request_review", "request_review"],
    toolCalls: [
      call("mesh_artifact_publish", { name: "System Architecture", type: "ArchitectureDocument", content: "x" }),
      call("mesh_request_review", { artifactId: "art-M3D54QXS006eca2e1488", reviewers: ["tech-lead"] }),
      call("mesh_request_review", { artifactId: "art-ZZZZZZZZZZ99999999", reviewers: ["pm"] }),
    ],
    timeline: [
      ev(1, "artifact.created", { artifact: { id: "art-M3D54QXS006eca2e1488", name: "System Architecture" } }),
      ev(2, "review.requested", { artifactId: "art-M3D54QXS006eca2e1488", reviewers: ["tech-lead"] }),
    ],
  })!;
  assert.equal(l.rows[1]!.head.title, "Review requested: System Architecture");
  assert.equal(l.rows[1]!.fx?.seq, 2);
  assert.equal(l.rows[1]!.guess, false, "the event names this row's artifact");
  assert.equal(l.rows[2]!.head.title, "Review requested: art-…999999");
  assert.equal(l.rows[2]!.fx, null, "the second review left no event");
});

test("a plan and the ticks that follow it each take their own plan update, none of them a guess", () => {
  const plan = { steps: [{ id: "s1", text: "survey the repo", status: "PENDING" }, { id: "s2", text: "write the design", status: "PENDING" }] };
  const tick = (done: string[]) => ({ steps: plan.steps.map((s) => ({ ...s, status: done.includes(s.id) ? "DONE" : "PENDING" })) });
  const l = buildLedger({
    ops: ["plan", "plan_step", "plan_step"],
    toolCalls: [call("mesh_plan", { steps: [{ text: "survey the repo" }, { text: "write the design" }] }), call("mesh_plan_step", { stepId: "s1" }), call("mesh_plan_step", { stepId: "s2" })],
    timeline: [ev(1, "plan.updated", { plan }), ev(2, "plan.updated", { plan: tick(["s1"]) }), ev(3, "plan.updated", { plan: tick(["s1", "s2"]) })],
  })!;
  assert.deepEqual(l.rows.map((r) => r.fx?.seq), [1, 2, 3]);
  assert.deepEqual(l.rows.map((r) => r.guess), [false, false, false]);
  assert.equal(l.rows[0]!.head.title, "Planned 2 steps");
  assert.equal(l.rows[1]!.head.title, "Finished a plan step");
  assert.equal(l.rows[1]!.head.detail, "survey the repo", "a step id resolves to the step's own words");
});

test("a turn summary splits into kernel notices and the model's own words", () => {
  const s = splitSummary(
    "⚠ 1 of 23 ops were REJECTED and had no effect — fix these (withdraw: no outstanding request) — model said: " +
      "Turn complete — ended in `wait`. Here's what happened: — ⚠ request_review: pm cannot deliver a verdict — ⚠ 6 file(s) in your worktree are NOT committed",
  );
  assert.deepEqual(s.notices, [
    "1 of 23 ops were REJECTED and had no effect — fix these (withdraw: no outstanding request)",
    "request_review: pm cannot deliver a verdict",
    "6 file(s) in your worktree are NOT committed",
  ]);
  assert.equal(s.model, "Turn complete — ended in `wait`. Here's what happened:", "a bare ' — ' in the model's text is not a boundary");
  assert.deepEqual(splitSummary("Shipped v2 — the schema and the API spec."), { notices: [], model: "Shipped v2 — the schema and the API spec." });
  assert.deepEqual(splitSummary("⚠ turn only wait — no work was produced while the mission has unmet criteria"), {
    notices: ["turn only wait — no work was produced while the mission has unmet criteria"],
    model: "",
  });
  assert.deepEqual(splitSummary("⚠ no mesh tool calls this turn — nothing was sent (model said: I read the spec.)"), {
    notices: ["no mesh tool calls this turn — nothing was sent"],
    model: "I read the spec.",
  });
  assert.deepEqual(splitSummary("continuity written for the session handover — this turn is not scored as work"), {
    notices: ["continuity written for the session handover — this turn is not scored as work"],
    model: "",
  });
});

test("a record's notices lose the kernel's own warning mark, since the list draws one: one mark, not two", () => {
  // The step drawer's Reasoning read "▲ ⚠ turn only done — …" for notices that came as a list, and "▲ turn only done" for the same
  // notice split out of an older record's summary.
  assert.deepEqual(
    recordNotices(["⚠ turn only done — no work was produced while the mission has unmet criteria", "landed this turn: 2 messages sent", "⚠  ", "  ", 3, null]),
    ["turn only done — no work was produced while the mission has unmet criteria", "landed this turn: 2 messages sent"],
  );
  assert.deepEqual(recordNotices(undefined), []);
  assert.deepEqual(recordNotices(["⚠ request_review: pm cannot deliver a verdict"]), splitSummary("⚠ request_review: pm cannot deliver a verdict").notices, "the same notice reads the same however the record carries it");
});

test("an uncaptured row is named from the event it landed, but only where that pairing is no guess", () => {
  // Nothing captured at all: every row is uncaptured, and each kind has one
  // op, so each pairing is decided by type alone and is not a guess.
  const l = buildLedger({
    ops: ["publish_artifact", "send", "respond", "remember", "claim_task", "withdraw"],
    opTimings: ["publish_artifact", "send", "respond", "remember", "claim_task", "withdraw"].map((op) => ({ op, ok: op !== "withdraw", ...(op === "withdraw" ? { reason: "not yours" } : {}) })),
    toolCalls: [],
    timeline: [
      ev(1, "artifact.versioned", { artifact: { id: "art-A1xxxxxxxxxx", name: "System Architecture", type: "ArchitectureDocument", version: 2 } }),
      ev(2, "task.claimed", { taskId: "task-T1xxxxxxxxxx", agentId: "architect" }),
      ev(3, "memory.updated", { note: { key: "greenfield", value: "yes" } }),
      ev(4, "commitment.discharged", { messageId: "msg-other", reason: "superseded" }),
    ],
  })!;
  assert.ok(l.rows.every((r) => r.uncaptured));
  const [pub, , , mem, claim, wd] = l.rows;
  assert.equal(pub!.guess, false);
  assert.equal(pub!.head.title, "Published System Architecture");
  assert.deepEqual(pub!.head.facts, [{ k: "kind", v: "ArchitectureDocument" }, { k: "version", v: "v2" }]);
  assert.equal(pub!.namedFromEffect, true);
  assert.deepEqual(pub!.op, { op: "publish_artifact" }, "naming the row invents no arguments");
  assert.equal(mem!.head.title, "Remembered greenfield");
  assert.equal(claim!.head.title, "Claimed task-…xxxxxx", "a task the turn's events never title is named by a short id");
  // A refusal landed nothing, so there is nothing to name it from — the
  // discharge event in the log is someone else's.
  assert.equal(wd!.head.title, "Withdrew its own ask");
  assert.equal(wd!.namedFromEffect, undefined);
});

test("messages name their recipient from the message they sent", () => {
  const l = buildLedger({
    ops: ["respond", "remember"],
    toolCalls: [],
    timeline: [
      ev(1, "message.sent", { message: { type: "DONE", to: ["pm"], replyTo: "msg-q", payload: { summary: "four artifacts at v2" } } }),
      ev(2, "memory.updated", { note: { key: "k" } }),
    ],
  })!;
  assert.equal(l.rows[0]!.head.title, "Replied: mark done → pm");
  assert.equal(l.rows[0]!.head.detail, "four artifacts at v2");
  const send = buildLedger({ ops: ["send"], toolCalls: [], timeline: [ev(1, "message.sent", { message: { type: "REQUEST_INFO", to: ["pm", "qa"] } })] })!;
  assert.equal(send.rows[0]!.head.title, "Request info → pm, qa");
  // A research cache hit answers the asker by message: that recipient is the
  // seat itself, not who it asked, so the row keeps its own words.
  const research = buildLedger({ ops: ["request_research"], toolCalls: [], timeline: [ev(1, "message.sent", { message: { type: "INFORM", to: ["architect"] } })] })!;
  assert.equal(research.rows[0]!.fx?.type, "message.sent");
  assert.equal(research.rows[0]!.head.title, "Research requested");
  assert.equal(research.rows[0]!.namedFromEffect, undefined);
});

test("guessed uncaptured rows stay generic and say they are one of several unnamed", () => {
  const l = buildLedger({ ops: ARCH_OPS, opTimings: ARCH_TIMINGS, toolCalls: ARCH_CALLS, timeline: ARCH_TIMELINE })!;
  const late = l.rows.slice(12, 16);
  // Four uncaptured publishes took the four new versions by order alone:
  // naming them from those events would name another row's artifact as
  // often as its own.
  for (const r of late) {
    assert.equal(r.guess, true);
    assert.equal(r.head.title, "Published an artifact");
    assert.equal(r.head.note, "one of 4 unnamed");
    assert.equal(r.namedFromEffect, undefined);
  }
  const remembers = l.rows.filter((r) => r.kind === "remember");
  assert.deepEqual(remembers.map((r) => r.head.note), ["one of 2 unnamed", "one of 2 unnamed"]);
  // Alone of its kind, a guessed row has no group to be one of.
  const reply = l.rows.find((r) => r.kind === "respond")!;
  assert.equal(reply.guess, true);
  assert.equal(reply.head.title, "Replied");
  assert.equal(reply.head.note, undefined);
  // Captured rows are untouched.
  assert.equal(l.rows[2]!.head.title, "Published Doc a1");
  assert.equal(l.rows[2]!.head.note, undefined);
});

test("a publish's size is the length the seat wrote, not the length the server stored", () => {
  const stored = "x".repeat(4000);
  const l = buildLedger({
    ops: ["publish_artifact", "publish_artifact"],
    toolCalls: [
      { ...call("mesh_artifact_publish", { name: "Big", type: "ADR", content: stored }), argsClipped: { content: 42947 } },
      call("mesh_artifact_publish", { name: "Small", type: "ADR", content: "short" }),
    ],
    timeline: [],
  })!;
  assert.deepEqual(l.rows[0]!.clipped, { content: 42947 });
  assert.ok(l.rows[0]!.head.facts.some((f) => f.k === "size" && f.v === "42947 chars"), JSON.stringify(l.rows[0]!.head.facts));
  assert.equal(l.rows[1]!.clipped, undefined, "a record from before the cap has no map, and nothing was cut");
  assert.ok(l.rows[1]!.head.facts.some((f) => f.k === "size" && f.v === "5 chars"));
  // The records the calls-only path reads carry the map too.
  const calls = buildLedger({ toolCalls: [{ ...call("mesh_artifact_publish", { name: "Big", content: stored }), argsClipped: { content: 9000 } }], timeline: [] })!;
  assert.deepEqual(calls.rows[0]!.clipped, { content: 9000 });
});

test("storage clips resolve dotted paths to what was kept, and ignore a malformed map", () => {
  const args = { file_path: "a.ts", edits: [{ old_string: "o".repeat(4000), new_string: "short" }, { old_string: "p", new_string: "n".repeat(4000) }] };
  const clipped = { "edits.1.new_string": 12000, "edits.0.old_string": 5000 };
  assert.equal(valueAt(args, "edits.1.new_string"), "n".repeat(4000));
  assert.equal(valueAt(args, "edits.9.new_string"), undefined);
  assert.deepEqual(storageClips(args, clipped), [
    { path: "edits.0.old_string", original: 5000, stored: 4000 },
    { path: "edits.1.new_string", original: 12000, stored: 4000 },
  ]);
  assert.deepEqual(storageClips(args, clipped, "edits.1").map((c) => c.path), ["edits.1.new_string"]);
  assert.deepEqual(storageClips(args, clipped, "edits.10"), [], "a prefix matches whole segments only");
  assert.deepEqual(storageClips(args, { content: 9000 }), [{ path: "content", original: 9000, stored: undefined }]);
  assert.equal(clipMap(undefined), undefined);
  assert.equal(clipMap(["content"]), undefined);
  assert.equal(clipMap({ content: "long" }), undefined);
  assert.deepEqual(clipMap({ content: 9000, bogus: -1, nan: Number.NaN }), { content: 9000 });
});
