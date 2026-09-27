import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { makeMesh, stub, waitFor, type AgentSpec } from "../helpers";
import { extractSummary } from "../../packages/agent-runtime/src/index";
import { artifactUri, type MeshEvent, type MeshOp } from "../../packages/protocol/src/index";
import type { OpResult, TurnRecord } from "../../packages/core/src/index";

/**
 * The real agent-output path, end to end: a seat's typed `mesh_*` call ->
 * `executeToolOp` on the live turn -> `executeOp` -> state, events and the
 * turn's accounting.
 *
 * A Claude seat issues every op mid-turn through the MCP bridge and returns
 * none with its result; the reply text is prose and is never read for ops.
 * The stub stands in for the bridge by calling `executeToolOp` from inside its
 * script, which is exactly what the MCP handler does. Every row asserts the
 * three things an operator reading `events.jsonl` after a turn asks: state,
 * the `turn.discarded` record (or its absence), and the token ledger.
 *
 * The differential at the bottom proves the structured `operations` channel
 * (stub, http) and the tool channel leave the same mesh for every op kind.
 */

/** Fixed, distinctive usage so the billed figure can be matched exactly. */
const USAGE = { input: 7_000, output: 3_000, total: 10_000 };

const AGENTS: AgentSpec[] = [
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "architecture.write"], interests: [] },
  { id: "pm", role: "pm", interests: [] },
];

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

const payload = (e: MeshEvent | undefined) => (e?.payload ?? {}) as Record<string, unknown>;

interface TurnOutcome {
  turn: TurnRecord;
  discards: Array<Record<string, unknown>>;
  /** `amount` of every `budget.consumed` on dev's AGENT ledger for this turn. */
  billed: number[];
  /** What each tool call answered the seat, in call order. */
  answers: OpResult[];
}

/**
 * Boot a two-seat mesh and run ONE dev turn that calls `ops` as tools, then
 * ends with `text` as its reply. The summary is derived from the text the way
 * runtime-claude derives it, so a zero-op turn's detail is what it would be live.
 */
async function runTools(ops: MeshOp[], text = "Here is my work for this turn."): Promise<{ m: Mesh } & TurnOutcome> {
  const m = await makeMesh({ agents: AGENTS, mayContact: { dev: ["pm"], pm: ["dev"] } });
  stub(m).setScript("pm", async () => ({ operations: [{ op: "wait" } as MeshOp] }));
  const answers: OpResult[] = [];
  let ran = false;
  stub(m).setScript("dev", async () => {
    if (!ran) {
      ran = true;
      for (const op of ops) answers.push(await m.supervisor.executeToolOp("dev", op));
    }
    return { text, operations: [], typedOps: true, summary: extractSummary(text), tokensUsed: USAGE };
  });
  await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
  return { m, ...(await settledTurn(m)), answers };
}

/** Wait for dev's first turn to close AND for its `finally` (discard, billing) to have run. */
async function settledTurn(m: Mesh): Promise<Omit<TurnOutcome, "answers">> {
  await waitFor("dev's turn to close", () => m.supervisor.getRecentTurns().some((t) => t.agentId === "dev" && t.status !== "running"));
  // The discard is emitted in runTurn's `finally`, after `finishTurn` — and the
  // scheduler only forgets the turn after that, so "nothing running" is the
  // signal that every record for it is on the log.
  await waitFor("the scheduler to drain", () => !m.supervisor.isTurnInFlight("dev") && m.scheduler.running() === 0 && m.scheduler.pending() === 0);
  const turn = m.supervisor.getRecentTurns().filter((t) => t.agentId === "dev" && t.status !== "running").sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))[0]!;
  const events = await m.store.read();
  const goalId = m.kernel.state.activeGoalId;
  const discards = events.filter((e) => e.type === "turn.discarded" && payload(e).agentId === "dev" && payload(e).turnId === turn.turnId).map(payload);
  const billed = events
    .filter((e) => e.type === "budget.consumed" && payload(e).key === `agent:${goalId}/dev` && payload(e).turnId === turn.turnId)
    .map((e) => Number(payload(e).amount));
  return { turn, discards, billed };
}

const artifactNamed = (m: Mesh, name: string) => [...m.kernel.state.artifacts.values()].find((a) => a.name === name);
const contentOf = async (m: Mesh, name: string): Promise<string | undefined> => {
  const a = artifactNamed(m, name);
  return a ? m.supervisor.deps.content.read(a.contentRef) : undefined;
};
const devSentTo = (m: Mesh, to: string) => [...m.kernel.state.messages.values()].filter((x) => x.from === "dev" && x.to.includes(to));
const opResults = (t: TurnRecord) => (t.opTimings ?? []).map((o) => ({ op: o.op, ok: o.ok, ...(o.reason !== undefined ? { reason: o.reason } : {}) }));

/** A turn that reached the mesh: no discard, billed exactly once at its measured total. */
function assertKeptAndBilled(o: TurnOutcome): void {
  assert.deepEqual(o.discards, [], "a turn whose work landed is not a discard");
  assert.deepEqual(o.billed, [USAGE.total], "billed once, at the backend's figure, on the agent ledger");
  assert.equal(o.turn.tokens, USAGE.total, "and the turn record carries the same figure");
}

/** A turn thrown away AFTER the model answered: one discard with the known cost, billed once (not twice). */
function assertDiscarded(o: TurnOutcome, reason: string): Record<string, unknown> {
  assert.equal(o.discards.length, 1, `exactly one turn.discarded (got ${JSON.stringify(o.discards)})`);
  const d = o.discards[0]!;
  assert.equal(d.reason, reason);
  assert.equal(d.turnId, o.turn.turnId, "the discard names the turn it discards");
  assert.equal(d.tokens, USAGE.total, "the model answered, so the cost is known and stated");
  // Settled at the normal consume, never again in `finally`: the success path
  // empties `openReservations`, which is the whole anti-double-billing guard.
  assert.deepEqual(o.billed, [USAGE.total], "billed exactly once — a discard is not free, and not charged twice");
  return d;
}

// ---- the rows ---------------------------------------------------------------

const SPEC_BODY = "# Spec\n\nThe service exposes one endpoint and persists to an append-only log.";

test("tool output: every op lands, the seat is answered per call, and the turn is kept and billed", async () => {
  const { m, ...o } = await runTools([
    { op: "publish_artifact", name: "Spec", type: "ArchitectureDocument", content: SPEC_BODY },
    { op: "send", type: "INFORM", to: ["pm"], newThread: { subject: "spec" }, payload: { note: "spec is up" } },
    { op: "done", summary: "published the spec and told pm" },
  ]);
  try {
    assert.equal(await contentOf(m, "Spec"), SPEC_BODY, "the document landed byte for byte");
    assert.equal(devSentTo(m, "pm").length, 1, "the send landed");
    assert.deepEqual(o.answers.map((a) => [a.op, a.ok]), [["publish_artifact", true], ["send", true], ["done", true]], "each call answered mid-turn");
    assert.deepEqual(opResults(o.turn).map((r) => [r.op, r.ok]), [["publish_artifact", true], ["send", true], ["done", true]], "and counted on the live turn");
    assert.equal(o.turn.status, "ok");
    assert.match(String(o.turn.summary), /published the spec and told pm/, "the done call's declared summary is the turn's summary");
    assertKeptAndBilled(o);
  } finally {
    await m.cleanup();
  }
});

test("tool output: an unknown op is refused on its own, and its valid neighbours still land", async () => {
  // `executeOp` refuses an unknown name VISIBLY ("unknown op") — per call, not
  // per turn. The turn is partial, so it is kept, billed, and its summary names
  // the refusal.
  const { m, ...o } = await runTools([
    { op: "publish_artifact", name: "Spec", type: "ArchitectureDocument", content: SPEC_BODY },
    { op: "frobnicate_artifact", target: "Spec" } as unknown as MeshOp,
    { op: "done", summary: "spec up" },
  ]);
  try {
    assert.ok(artifactNamed(m, "Spec"), "the valid op before the unknown one landed");
    assert.equal(o.answers[1]?.reason, "unknown op", "the seat's own call was answered with the refusal");
    assert.deepEqual(opResults(o.turn), [
      { op: "publish_artifact", ok: true },
      { op: "frobnicate_artifact", ok: false, reason: "unknown op" },
      { op: "done", ok: true },
    ]);
    assert.match(String(o.turn.summary), /1 of 3 ops were REJECTED/);
    assert.match(String(o.turn.summary), /frobnicate_artifact: unknown op/, "the seat is told which op and why");
    assertKeptAndBilled(o);
  } finally {
    await m.cleanup();
  }
});

test("tool output: a turn of only unknown ops is discarded as all_rejected, at its known cost", async () => {
  const { m, ...o } = await runTools([{ op: "frobnicate_artifact" } as unknown as MeshOp, { op: "teleport", to: "pm" } as unknown as MeshOp]);
  try {
    const d = assertDiscarded(o, "all_rejected");
    assert.match(String(d.detail), /frobnicate_artifact: unknown op; teleport: unknown op/);
    assert.equal(o.turn.status, "ok", "the turn itself completed; it is the WORK that was discarded");
  } finally {
    await m.cleanup();
  }
});

test("tool output: a prose-only answer is a no_ops discard that names what the model said", async () => {
  const prose = "I reviewed the spec and it looks complete; nothing else is needed from me.\n\nThanks!";
  const { m, ...o } = await runTools([], prose);
  try {
    const d = assertDiscarded(o, "no_ops");
    assert.equal(d.detail, "I reviewed the spec and it looks complete; nothing else is needed from me.");
    assert.equal(devSentTo(m, "pm").length, 0);
    assert.deepEqual(opResults(o.turn), [], "no op ran, so none is recorded");
    assert.match(String(o.turn.summary), /no mesh tool calls this turn/);
  } finally {
    await m.cleanup();
  }
});

test("tool output: a mesh-json block in the reply is prose — nothing in it runs", async () => {
  // The retired channel. A seat that still writes the block instead of calling
  // the tools lands nothing, and the turn says so rather than half-running it.
  const text = [
    "Publishing the spec now.",
    "```mesh-json",
    JSON.stringify([{ op: "publish_artifact", name: "Spec", type: "ArchitectureDocument", content: SPEC_BODY }, { op: "done" }], null, 1),
    "```",
  ].join("\n");
  const { m, ...o } = await runTools([], text);
  try {
    assert.equal(artifactNamed(m, "Spec"), undefined, "nothing was published");
    const d = assertDiscarded(o, "no_ops");
    assert.equal(d.detail, "Publishing the spec now.", "the model's own first line rides along as the detail");
  } finally {
    await m.cleanup();
  }
});

test("tool output: a large document under the publish ceiling lands intact", async () => {
  // ~40k chars, just under ARTIFACT_PUBLISH_MAX_CHARS (48,000).
  const body = `# Large\n\n${"The log is the source of truth; every view is a projection of it. ".repeat(600)}`;
  assert.ok(body.length > 39_000 && body.length < 48_000, `fixture size ${body.length}`);
  const { m, ...o } = await runTools([{ op: "publish_artifact", name: "Large", type: "ArchitectureDocument", content: body }, { op: "done" }]);
  try {
    assert.equal(await contentOf(m, "Large"), body, "not truncated, not re-encoded");
    assertKeptAndBilled(o);
  } finally {
    await m.cleanup();
  }
});

test("tool output: a document over the publish ceiling is refused per op, never truncated", async () => {
  const body = `# Huge\n\n${"x".repeat(60_000)}`;
  const { m, ...o } = await runTools([{ op: "publish_artifact", name: "Huge", type: "ArchitectureDocument", content: body }, { op: "done" }]);
  try {
    assert.equal(artifactNamed(m, "Huge"), undefined, "refused, not truncated into a corrupt artifact");
    const [pub, done] = opResults(o.turn);
    assert.equal(pub?.ok, false);
    assert.match(String(pub?.reason), /over the 48000 limit/);
    assert.match(String(pub?.reason), /fromPath/, "the refusal names the way out");
    assert.equal(done?.ok, true);
    assertKeptAndBilled(o);
  } finally {
    await m.cleanup();
  }
});

test("tool output: ops naming an artifact that does not exist are refused, and a turn of nothing else is all_rejected", async () => {
  const { m, ...o } = await runTools([
    { op: "transition_artifact", artifactId: "art-DOESNOTEXIST", to: "READY_FOR_REVIEW" },
    { op: "request_review", artifactId: "art-DOESNOTEXIST", reviewers: ["pm"] },
  ]);
  try {
    assert.deepEqual(opResults(o.turn), [
      { op: "transition_artifact", ok: false, reason: "unknown artifact art-DOESNOTEXIST" },
      { op: "request_review", ok: false, reason: "unknown artifact art-DOESNOTEXIST" },
    ]);
    assert.equal(devSentTo(m, "pm").length, 0, "no review ask was opened against nothing");
    const d = assertDiscarded(o, "all_rejected");
    assert.match(String(d.detail), /unknown artifact art-DOESNOTEXIST/);
  } finally {
    await m.cleanup();
  }
});

// ---- differential: pre-built ops vs the same ops as mid-turn tool calls -----

/**
 * Every op kind `executeOp` switches on, read from the COMPILED supervisor so
 * the list cannot drift from the code: an op kind added without a row in
 * `OP_CASES` fails the coverage test below instead of going untested.
 */
function executeOpKinds(): string[] {
  const src = fs.readFileSync(path.join(__dirname, "../../packages/core/src/supervisor.js"), "utf8");
  const start = src.indexOf("async executeOp(");
  assert.ok(start > 0, "executeOp not found in the compiled supervisor");
  const sw = src.indexOf("switch (op.op)", start);
  const end = src.indexOf('reason: "unknown op"', sw);
  assert.ok(sw > start && end > sw, "executeOp's switch not found");
  return [...src.slice(sw, end).matchAll(/case "([a-z_]+)":/g)].map((x) => x[1]!);
}

/** Ids an op may need, resolved from live state in the mesh run, placeholders in the coverage check. */
interface Refs {
  artId: string;
  artUri: string;
  taskId: string;
  threadId: string;
  messageId: string;
  decisionId: string;
}

const PLACEHOLDER_REFS: Refs = {
  artId: "art-0000000000placeholder",
  artUri: "artifact://ArchitectureDocument/Spec/1",
  taskId: "task-0000000000placeholder",
  threadId: "thread-0000000000placeholder",
  messageId: "msg-0000000000placeholder",
  decisionId: "decision-0000000000placeholder",
};

/**
 * One canonical op per kind, in an order where each can find what it needs.
 * Outcomes are NOT the point — `merge` without a workspace and `submit_result`
 * from a non-worker are refused — only that both channels reach the same one.
 * `escalate` is last because it halts the mission and every later wake.
 */
const OP_CASES: Array<[kind: string, build: (r: Refs) => MeshOp]> = [
  ["publish_artifact", () => ({ op: "publish_artifact", name: "Spec", type: "ArchitectureDocument", content: SPEC_BODY, scope: "mission", metadata: { area: "storage" } })],
  ["read_artifact", (r) => ({ op: "read_artifact", artifactRef: r.artUri, offset: 2 })],
  ["transition_artifact", (r) => ({ op: "transition_artifact", artifactId: r.artId, to: "READY_FOR_REVIEW", evidence: "self-reviewed" })],
  ["request_review", (r) => ({ op: "request_review", artifactId: r.artId, reviewers: ["rev"] })],
  ["send", () => ({ op: "send", type: "INFORM", to: ["pm"], newThread: { subject: "status" }, payload: { note: "on track" }, priority: "NORMAL" })],
  ["broadcast", () => ({ op: "broadcast", type: "INFORM", payload: { note: "heads up" }, note: "fyi" })],
  ["collab", () => ({ op: "collab", with: ["pm"], topic: "api shape", payload: { q: "rest or rpc?" } })],
  ["close_collab", (r) => ({ op: "close_collab", threadId: r.threadId, outcome: "rest it is" })],
  ["request_research", () => ({ op: "request_research", to: "pm", question: "what does the market use?" })],
  ["respond", (r) => ({ op: "respond", messageId: r.messageId, type: "INFORM", payload: { answer: 42 } })],
  ["withdraw", (r) => ({ op: "withdraw", messageId: r.messageId, reason: "found it myself" })],
  ["discharge", (r) => ({ op: "discharge", messageId: r.messageId, reason: "not mine to answer" })],
  ["approve", (r) => ({ op: "approve", subject: "architecture", artifactId: r.artId, comment: "lgtm" })],
  ["reject", (r) => ({ op: "reject", subject: "architecture", artifactId: r.artId, comment: "no" })],
  ["veto", (r) => ({ op: "veto", subject: "architecture", artifactId: r.artId, comment: "unsafe" })],
  ["block", (r) => ({ op: "block", subject: "architecture", artifactId: r.artId, reason: "missing section" })],
  ["create_task", () => ({ op: "create_task", title: "T1 build index", description: "build the index", assignedTo: "dev" })],
  ["claim_task", (r) => ({ op: "claim_task", taskId: r.taskId })],
  // Statuses spelled out, so neither channel leans on the reducer's default.
  ["plan", (r) => ({ op: "plan", taskId: r.taskId, steps: [{ id: "s1", text: "write it", status: "PENDING" }, { id: "s2", text: "test it", status: "DONE" }] })],
  ["plan_step", () => ({ op: "plan_step", stepId: "s1", status: "DONE" })],
  ["complete_task", (r) => ({ op: "complete_task", taskId: r.taskId, summary: "index built" })],
  ["delegate", () => ({ op: "delegate", to: "pm", title: "D1 market scan", description: "scan the market" })],
  ["propose_decision", () => ({ op: "propose_decision", topic: "database", decision: { choice: "postgres" } })],
  ["ratify_decision", (r) => ({ op: "ratify_decision", decisionId: r.decisionId })],
  ["remember", () => ({ op: "remember", key: "db", value: "postgres" })],
  ["write_continuity", () => ({ op: "write_continuity", nextIntent: "finish the index" })],
  ["contracts", () => ({ op: "contracts" })],
  ["call", () => ({ op: "call", contract: "review", request: { what: "spec" }, to: ["rev"] })],
  ["acquire_lease", (r) => ({ op: "acquire_lease", artifactId: r.artId, files: ["src/index.ts"] })],
  ["release_lease", (r) => ({ op: "release_lease", artifactId: r.artId })],
  ["commit", (r) => ({ op: "commit", message: "feat: index", artifactId: r.artId, files: ["src/index.ts"] })],
  ["request_commit", (r) => ({ op: "request_commit", artifactId: r.artId, comment: "please land" })],
  ["merge", (r) => ({ op: "merge", artifactId: r.artId, comment: "ship" })],
  ["submit_result", (r) => ({ op: "submit_result", taskId: r.taskId, result: { status: "COMPLETED", summary: "done", artifacts: [], findings: [], risks: [], recommendation: "ship" } })],
  ["spawn_worker", () => ({ op: "spawn_worker", taskSpec: "count the lines", title: "W1 count" })],
  ["wait", () => ({ op: "wait", reason: "for review" })],
  ["done", () => ({ op: "done", summary: "turn complete" })],
  ["escalate", () => ({ op: "escalate", reason: "blocked on a decision", detail: { need: "operator" }, conflictKey: "diff-test" })],
];

test("differential: the op table covers every kind executeOp handles", () => {
  const kinds = executeOpKinds();
  assert.ok(kinds.length >= 30, `found ${kinds.length} op kinds — the source scrape is broken`);
  assert.deepEqual([...new Set(OP_CASES.map(([k]) => k))].sort(), [...new Set(kinds)].sort());
  for (const [kind, build] of OP_CASES) assert.equal(build(PLACEHOLDER_REFS).op, kind, `row ${kind} builds its own kind`);
});

const DIFF_AGENTS: AgentSpec[] = [
  {
    id: "dev",
    role: "developer",
    capabilities: ["repository.read", "repository.write", "architecture.write", "task.assign", "git.commit", "git.merge", "request_review"],
    interests: [],
  },
  { id: "pm", role: "pm", interests: [] },
  { id: "rev", role: "architect", authority: ["architecture.approve"], capabilities: ["review.design", "architecture.read"], interests: [] },
];

/** Replace every generated id with its prefix, so two runs compare by shape. */
const noIds = (s: string): string => s.replace(/\b(msg|evt|goal|thread|art|task|decision|esc|lease|turn)-[0-9A-Za-z]{6,}/g, "$1-*");

function refsFrom(m: Mesh): Refs {
  const st = m.kernel.state;
  const art = [...st.artifacts.values()].find((a) => a.name === "Spec");
  const research = [...st.messages.values()].find((x) => x.from === "dev" && x.type === "REQUEST_RESEARCH");
  return {
    artId: art?.id ?? PLACEHOLDER_REFS.artId,
    artUri: art ? artifactUri(art.type, art.name, art.version) : PLACEHOLDER_REFS.artUri,
    taskId: [...st.tasks.values()].find((t) => t.title === "T1 build index")?.id ?? PLACEHOLDER_REFS.taskId,
    threadId: [...st.collabSessions.values()].find((c) => c.topic === "api shape")?.threadId ?? PLACEHOLDER_REFS.threadId,
    messageId: research?.id ?? PLACEHOLDER_REFS.messageId,
    decisionId: [...st.decisions.values()].find((d) => d.topic === "database")?.id ?? PLACEHOLDER_REFS.decisionId,
  };
}

/** What a mesh ended up as, with ids and timestamps stripped. */
function digest(m: Mesh, perTurn: unknown[]): unknown {
  const st = m.kernel.state;
  const sorted = (xs: string[]) => [...xs].sort();
  const goal = st.goals.get(st.activeGoalId ?? "");
  return {
    perTurn,
    goal: goal?.status,
    artifacts: sorted([...st.artifacts.values()].map((a) => `${a.type}/${a.name}@v${a.version}:${a.status}:${JSON.stringify(a.metadata)}:${a.scope ?? ""}`)),
    messages: sorted([...st.messages.values()].map((x) => `${x.from}->${[...x.to].sort().join(",")}:${x.type}:${noIds(JSON.stringify(x.payload ?? null))}`)),
    tasks: sorted([...st.tasks.values()].map((t) => `${t.title}:${t.status}:${t.assignedTo ?? ""}:${t.claimedBy ?? ""}`)),
    decisions: sorted([...st.decisions.values()].map((d) => `${d.topic}:${d.status}:${JSON.stringify(d.decision)}`)),
    escalations: sorted([...st.escalations.values()].map((e) => `${e.reason}:${e.status}:${e.raisedBy}`)),
    collabs: sorted([...st.collabSessions.values()].map((c) => `${c.topic}:${c.status}`)),
    pending: sorted([...st.pendingRequests.values()].map((p) => `${p.from}->${[...p.to].sort().join(",")}:${p.type}`)),
    leases: st.leases.size,
    // `turn:<id>` notes are the runtime's own per-turn summaries, and `memory:*` is
    // eviction bookkeeping over those same notes; what the SEAT chose to
    // remember is the part that must match.
    memory: sorted([...(st.memory.get("dev")?.entries() ?? [])].filter(([k]) => !k.startsWith("turn:") && !k.startsWith("memory:")).map(([k, v]) => `${k}=${noIds(JSON.stringify((v as { value?: unknown }).value ?? v))}`)),
    continuity: st.continuity.get("dev")?.nextIntent,
    denied: sorted(st.deniedActions.map((d) => noIds(`${d.agentId}:${d.action}:${d.reason}`))),
  };
}

/** Run the whole OP_CASES script on a fresh mesh, one op per dev turn, through `channel`. */
async function runScenario(channel: "operations" | "tool"): Promise<unknown> {
  const m = await makeMesh({ agents: DIFF_AGENTS, mayContact: { dev: ["pm", "rev"], pm: ["dev"], rev: ["dev"] } });
  try {
    for (const id of ["pm", "rev"]) stub(m).setScript(id, async () => ({ operations: [{ op: "wait" } as MeshOp] }));
    let next: MeshOp | null = null;
    stub(m).setScript("dev", async () => {
      const op = next ?? ({ op: "wait", reason: "unscripted wake" } as MeshOp);
      next = null;
      // The same text in both channels, so the only difference is how the op
      // reached the supervisor: returned with the turn, or called mid-turn.
      const text = `Doing ${op.op}.`;
      if (channel === "tool") {
        await m.supervisor.executeToolOp("dev", op);
        return { text, operations: [], typedOps: true, tokensUsed: { input: 600, output: 400, total: 1000 } };
      }
      return { text, operations: [op], tokensUsed: { input: 600, output: 400, total: 1000 } };
    });
    const perTurn: unknown[] = [];
    for (const [kind, build] of OP_CASES) {
      await waitFor("the mesh to be quiet", () => !m.supervisor.isTurnInFlight("dev") && m.scheduler.running() === 0 && m.scheduler.pending() === 0);
      const closedBefore = m.supervisor.getRecentTurns(500).filter((t) => t.agentId === "dev" && t.status !== "running").length;
      next = build(refsFrom(m));
      const { queued, blocked } = await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
      if (!queued) {
        perTurn.push({ kind, blocked: noIds(String(blocked)) });
        next = null;
        continue;
      }
      await waitFor(`dev's ${kind} turn`, () => m.supervisor.getRecentTurns(500).filter((t) => t.agentId === "dev" && t.status !== "running").length > closedBefore);
      const t = m.supervisor.getRecentTurns(500).find((x) => x.agentId === "dev" && x.status !== "running")!;
      perTurn.push({ kind, status: t.status, ops: (t.opTimings ?? []).map((o) => [o.op, o.ok, noIds(String(o.reason ?? "")).slice(0, 160)]) });
    }
    await waitFor("the mesh to settle", () => m.scheduler.running() === 0 && m.scheduler.pending() === 0);
    return digest(m, perTurn);
  } finally {
    await m.cleanup();
  }
}

test("differential: every op kind, as pre-built ops and as mid-turn tool calls, leaves the same mesh", async () => {
  const typed = await runScenario("operations");
  const tool = await runScenario("tool");
  assert.deepEqual(tool, typed);
  // Guard against a vacuous pass: the scenario must actually have moved state.
  const d = typed as { artifacts: string[]; tasks: string[]; decisions: string[]; perTurn: Array<{ ops?: unknown[][] }> };
  assert.ok(d.artifacts.length > 0 && d.tasks.length > 0 && d.decisions.length > 0, `the scenario changed nothing: ${JSON.stringify(d)}`);
  const okOps = d.perTurn.flatMap((t) => t.ops ?? []).filter((o) => o[1] === true).length;
  assert.ok(okOps >= 20, `only ${okOps} ops succeeded — the differential would be comparing refusals`);
});
