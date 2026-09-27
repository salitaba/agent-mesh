import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, type AgentSpec } from "../helpers";
import { extractSummary } from "../../packages/agent-runtime/src/index";
import type { MeshOp } from "../../packages/protocol/src/index";
import type { OpResult, TurnRecord } from "../../packages/core/src/index";
import {
  OP_TIMING_NOTE_MAX_CHARS,
  READ_RESULT_OPS,
  TurnTracker,
  boundOpTiming,
} from "../../packages/core/src/turn-tracker";

/**
 * The turn record a reader can take apart without parsing prose.
 *
 * `summary` is one string because it is the seat's next context, and it keeps
 * its exact shape. Beside it the record now carries `notices` — each remark the
 * mesh made about the turn, on its own — and `modelSummary`, the model's own
 * words, so the dashboard need not split `summary` on " — " (which the model is
 * free to write) to tell the mesh's voice from the seat's.
 *
 * Two size fixes ride along, both about reads: a `read_artifact` answers with
 * the document in `reason`, and every consumer that took `reason` as a caveat
 * carried the document with it — into the summary (and so the seat's memory)
 * as "⚠ read_artifact: # <body>", and into the op timings shipped on every
 * /steps response.
 */

const USAGE = { input: 7_000, output: 3_000, total: 10_000 };

const AGENTS: AgentSpec[] = [
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "architecture.write"], interests: [] },
  { id: "pm", role: "pm", interests: [] },
];

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

/**
 * Run ONE dev turn that calls each op as a mid-turn tool call (the Claude
 * channel), each built from the answers so far, then replies with `text`.
 */
async function runTools(
  steps: Array<(answers: OpResult[]) => MeshOp>,
  text: string,
): Promise<{ m: Mesh; turn: TurnRecord; answers: OpResult[] }> {
  const m = await makeMesh({ agents: AGENTS, mayContact: { dev: ["pm"], pm: ["dev"] } });
  stub(m).setScript("pm", async () => ({ operations: [{ op: "wait" } as MeshOp] }));
  const answers: OpResult[] = [];
  let ran = false;
  stub(m).setScript("dev", async () => {
    if (!ran) {
      ran = true;
      for (const step of steps) answers.push(await m.supervisor.executeToolOp("dev", step(answers)));
    }
    return { text, operations: [], typedOps: true, summary: extractSummary(text), tokensUsed: USAGE };
  });
  await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
  await waitFor("dev's turn to close", () => m.supervisor.getRecentTurns().some((t) => t.agentId === "dev" && t.status !== "running"));
  await waitFor("the scheduler to drain", () => !m.supervisor.isTurnInFlight("dev") && m.scheduler.running() === 0 && m.scheduler.pending() === 0);
  const turn = m.supervisor
    .getRecentTurns()
    .filter((t) => t.agentId === "dev" && t.status !== "running")
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))[0]!;
  return { m, turn, answers };
}

/** Distinctive and long enough that any copy of it is unmistakable. */
const BODY = `# Spec\n\n${"BODY-MARKER the service persists to an append-only log. ".repeat(40)}`;

test("a read is not a caveat: the summary, notices and timings carry no document body", async () => {
  const { m, turn, answers } = await runTools(
    [
      () => ({ op: "publish_artifact", name: "Spec", type: "ArchitectureDocument", content: BODY }),
      (a) => ({ op: "read_artifact", artifactRef: String(a[0]?.artifactUri) }),
      () => ({ op: "frobnicate_artifact" } as unknown as MeshOp),
      () => ({ op: "done", summary: "published and read the spec" }),
    ],
    "Here is my work.",
  );
  try {
    assert.deepEqual(answers.map((a) => [a.op, a.ok]), [["publish_artifact", true], ["read_artifact", true], ["frobnicate_artifact", false], ["done", true]]);
    assert.equal(answers[1]?.reason, BODY, "the SEAT still gets the document — only the records stop copying it");

    const rejection = "⚠ 1 of 4 ops were REJECTED and had no effect — fix these before repeating them (frobnicate_artifact: unknown op)";
    // The runtime's account of what landed leads (NOTES live-run §18); after it,
    // byte-for-byte the string the partial-rejection arm has always written,
    // minus the read caveat it used to append.
    const effects = "landed this turn: 1 artifact published";
    assert.equal(turn.summary, `${effects} — ${rejection} — model said: published and read the spec`);
    assert.deepEqual(turn.notices, [effects, rejection], "the mesh's remarks, without the model's words mixed in");
    assert.equal(turn.modelSummary, "published and read the spec", "the model's words, without the mesh's");

    const timings = turn.opTimings ?? [];
    const read = timings.find((t) => t.op === "read_artifact");
    assert.ok(read?.ok, "the read is still recorded as having run");
    assert.equal("reason" in (read ?? {}), false, "a read's reason is its payload, so the timing drops it");
    assert.equal(timings.find((t) => t.op === "frobnicate_artifact")?.reason, "unknown op", "a refusal keeps its reason");

    assert.ok(!JSON.stringify(turn).includes("BODY-MARKER"), "no field of the turn record carries the document");
    // The seat's own memory of the turn is the summary, so it is clean too.
    const note = m.kernel.state.memory.get("dev")?.get(`turn:${turn.turnId}`) as { value?: unknown } | undefined;
    assert.equal(note?.value ?? note, turn.summary);
  } finally {
    await m.cleanup();
  }
});

test("an accepted op's caveat is its own notice, and the summary keeps its old shape", async () => {
  // A transition to the status the artifact already has is the cheapest op
  // that succeeds WITH a caveat; the claim under test is the split, not that
  // op's wording. (This used `propose_decision`, whose reason is the decision
  // id — data, not a caveat, and no longer reported as one: DATA_RESULT_OPS.)
  const { m, turn, answers } = await runTools(
    [
      () => ({ op: "publish_artifact", name: "Notes", type: "ArchitectureDocument", content: "# Notes\n\nfine." }),
      (a) => ({ op: "transition_artifact", artifactId: String(a[0]?.artifactId), to: "DRAFT", evidence: "still drafting" }),
      () => ({ op: "done", summary: "kept it a draft" }),
    ],
    "Kept it a draft.",
  );
  try {
    const kept = answers[1];
    assert.equal(kept?.ok, true, `the transition must succeed for this test to mean anything: ${JSON.stringify(kept)}`);
    assert.ok(kept?.reason, "and carry a reason, or there is no caveat to split");
    const effects = "landed this turn: 1 artifact published";
    const caveat = `⚠ transition_artifact: ${kept.reason}`;
    assert.equal(turn.summary, `${effects} — kept it a draft — ${caveat}`);
    assert.deepEqual(turn.notices, [effects, caveat]);
    assert.equal(turn.modelSummary, "kept it a draft");
  } finally {
    await m.cleanup();
  }
});

test("a zero-op turn: the verdict is a notice, and the model's words are kept apart", async () => {
  const { m, turn } = await runTools([], "I thought about it and decided nothing.");
  try {
    const verdict = "⚠ no mesh tool calls this turn — nothing was sent, published, or requested";
    assert.equal(turn.summary, `${verdict} (model said: I thought about it and decided nothing.)`);
    assert.deepEqual(turn.notices, [verdict]);
    assert.equal(turn.modelSummary, "I thought about it and decided nothing.");
  } finally {
    await m.cleanup();
  }
});

test("a clean turn draws no warning: its one remark is what it landed", async () => {
  // A real effect first: `done` alone is itself a remark ("turn only done").
  // The effects line is the mesh's account of the turn (NOTES live-run §18), so
  // it is a notice like any other; what a clean turn lacks is a ⚠.
  const { m, turn } = await runTools(
    [
      () => ({ op: "publish_artifact", name: "Notes", type: "ArchitectureDocument", content: "# Notes\n\nfine." }),
      () => ({ op: "done", summary: "all good" }),
    ],
    "All good.",
  );
  try {
    assert.equal(turn.summary, "landed this turn: 1 artifact published — all good");
    assert.deepEqual(turn.notices, ["landed this turn: 1 artifact published"]);
    assert.ok(!(turn.notices ?? []).some((n) => n.includes("⚠")), "nothing to warn about");
    assert.equal(turn.modelSummary, "all good");
  } finally {
    await m.cleanup();
  }
});

test("a turn that never finished: its note is the whole summary and the only notice", async () => {
  const m = await makeMesh({ agents: [{ id: "dev", role: "developer", interests: [], persistent: false }], mayContact: { dev: [] } });
  try {
    stub(m).setScript("dev", [{ throwKind: "generic", throwMessage: "backend fell over" }, { operations: [{ op: "wait" }] }]);
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the failed turn", () => m.supervisor.getRecentTurns().some((t) => t.agentId === "dev" && t.status === "failed"));
    const turn = m.supervisor.getRecentTurns().find((t) => t.agentId === "dev" && t.status === "failed")!;
    assert.match(String(turn.summary), /your previous turn did not finish/);
    assert.deepEqual(turn.notices, [turn.summary]);
    assert.equal(turn.modelSummary, undefined, "the model never answered, so there are no words of its own to keep");
  } finally {
    await m.cleanup();
  }
});

test("a refused tool call reaches toolCallsDetail as failed, with the refusal", async () => {
  // Streaming, so the record is rebuilt by `collectAgentOutput` from frames —
  // the path the Claude runtime takes — rather than handed over whole.
  const m = await makeMesh({ agents: [{ id: "dev", role: "developer", interests: [] }], mayContact: { dev: [] } });
  try {
    stub(m).setStreaming(true);
    const refusal = "Bash denied: this seat holds no shell.execute or test.execute capability.";
    stub(m).setScript("dev", [
      {
        operations: [{ op: "done", summary: "tried to run the tests" }],
        toolCalls: [
          { name: "Bash", args: { command: "npm test" }, resultDigest: "dgx-1", status: "failed", error: refusal },
          { name: "Read", args: { file_path: "a.ts" }, resultDigest: "dgx-2" },
        ],
      },
    ]);
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the turn", () => m.supervisor.getRecentTurns().some((t) => t.agentId === "dev" && t.status !== "running"));
    const turn = m.supervisor.getRecentTurns().find((t) => t.agentId === "dev" && t.status !== "running")!;
    assert.deepEqual(turn.toolCallsDetail, [
      { name: "Bash", args: { command: "npm test" }, resultDigest: "dgx-1", status: "failed", error: refusal, index: 0 },
      { name: "Read", args: { file_path: "a.ts" }, resultDigest: "dgx-2", status: "completed", index: 1 },
    ]);
  } finally {
    await m.cleanup();
  }
});

// ---- boundOpTiming: the rule on its own ---------------------------------------

test("boundOpTiming: refusals whole, accepted reasons clipped, read payloads dropped", () => {
  const long = "r".repeat(1000);
  assert.deepEqual(boundOpTiming({ op: "send", ms: 1, ok: false, reason: long }), { op: "send", ms: 1, ok: false, reason: long }, "the dashboard shows refusals — never clip one");
  const clipped = boundOpTiming({ op: "send", ms: 1, ok: true, reason: long });
  assert.equal(clipped.reason?.length, OP_TIMING_NOTE_MAX_CHARS);
  assert.ok(clipped.reason?.endsWith("…"), "a clipped note says it was clipped");
  assert.deepEqual(boundOpTiming({ op: "send", ms: 1, ok: true, reason: "short" }), { op: "send", ms: 1, ok: true, reason: "short" });
  for (const op of READ_RESULT_OPS) {
    assert.deepEqual(boundOpTiming({ op, ms: 2, ok: true, reason: long }), { op, ms: 2, ok: true }, `${op}'s reason is what it read`);
    // A refused read is a refusal like any other, and its reason is the why.
    assert.deepEqual(boundOpTiming({ op, ms: 2, ok: false, reason: "unknown artifact ref" }), { op, ms: 2, ok: false, reason: "unknown artifact ref" });
  }
});

test("noteOp applies the bound, so no caller can put a document into the ring", () => {
  const tracker = new TurnTracker();
  tracker.push({ turnId: "t1", agentId: "dev", reason: { kind: "manual" }, startedAt: new Date(0).toISOString(), status: "running" });
  tracker.noteOp("t1", { op: "read_artifact", ms: 3, ok: true, reason: BODY });
  assert.deepEqual(tracker.get("t1")?.opTimings, [{ op: "read_artifact", ms: 3, ok: true }]);
});
