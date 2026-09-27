import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, type AgentSpec } from "../helpers";
import { FakeWorkspace, installWorkspace, untrackedState } from "../support/fake-workspace";
import type { WorktreeState } from "../../packages/core/src/ports";
import type { MeshOp } from "../../packages/protocol/src/index";
import type { OpResult, TurnRecord } from "../../packages/core/src/index";
import { DATA_RESULT_OPS } from "../../packages/core/src/turn-tracker";

/**
 * What an operator reads about a turn leads with what the turn DID.
 *
 * Measured 2026-09-25 (NOTES live-run §18): the one turn that committed 4,082
 * lines and 80 tests read "Turn complete. What happened: — ⚠ read_artifact: … ⚠
 * 3 files NOT committed (.mesh/agents/…)". 27 of 49 settled turns carried the
 * uncommitted-files warning; 6 listed only runtime-owned `.mesh/agents/*` files
 * and 12 went to seats that hold no `git.commit` and so could not act on it.
 */

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

const WRITER: AgentSpec = { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "architecture.write", "git.commit"], interests: [] };
const PM: AgentSpec = { id: "pm", role: "pm", interests: [] };

async function oneTurn(steps: Array<(a: OpResult[]) => MeshOp>): Promise<{ m: Mesh; turn: TurnRecord }> {
  const m = await makeMesh({ agents: [WRITER, PM], mayContact: { dev: ["pm"], pm: ["dev"] } });
  stub(m).setScript("pm", async () => ({ operations: [{ op: "wait" } as MeshOp] }));
  const answers: OpResult[] = [];
  let ran = false;
  stub(m).setScript("dev", async () => {
    if (!ran) {
      ran = true;
      for (const step of steps) answers.push(await m.supervisor.executeToolOp("dev", step(answers)));
    }
    return { text: "done", operations: [], typedOps: true, tokensUsed: { input: 10, output: 5, total: 15 } };
  });
  await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
  await waitFor("dev's turn", () => m.supervisor.getRecentTurns().some((t) => t.agentId === "dev" && t.status !== "running"));
  const turn = m.supervisor.getRecentTurns().find((t) => t.agentId === "dev" && t.status !== "running")!;
  return { m, turn };
}

test("the end summary leads with what landed, counted by the runtime", async () => {
  const { m, turn } = await oneTurn([
    () => ({ op: "publish_artifact", name: "Spec", type: "ArchitectureDocument", content: "# Spec\n\nthe store." }),
    () => ({ op: "send", type: "INFORM", to: ["pm"], newThread: { subject: "spec" }, payload: { note: "published" } }),
    () => ({ op: "frobnicate_artifact" } as unknown as MeshOp),
    () => ({ op: "done", summary: "published the spec" }),
  ]);
  try {
    const effects = "landed this turn: 1 artifact published, 1 message sent";
    assert.ok(turn.summary?.startsWith(effects), `the first words are the effects line, got: ${turn.summary}`);
    assert.equal(turn.notices?.[0], effects, "and it is the first notice, in the mesh's voice");
    assert.match(String(turn.summary), /1 of 4 ops were REJECTED/, "the caveats still follow it");
    assert.equal(turn.modelSummary, "published the spec");
  } finally {
    await m.cleanup();
  }
});

test("an op whose reason is data is not a caveat", async () => {
  const { m, turn } = await oneTurn([
    () => ({ op: "propose_decision", topic: "database", decision: { choice: "postgres" } }),
    () => ({ op: "done", summary: "proposed postgres" }),
  ]);
  try {
    assert.doesNotMatch(String(turn.summary), /⚠ propose_decision/, "a decision id is the op's answer, not a warning about it");
    assert.ok(!(turn.notices ?? []).some((n) => n.includes("propose_decision")), "nor is it a notice");
    assert.equal(turn.summary, "landed this turn: 1 decision proposed — proposed postgres");
  } finally {
    await m.cleanup();
  }
  for (const op of ["propose_decision", "acquire_lease", "release_lease", "commit", "merge", "spawn_worker", "discharge", "withdraw", "read_artifact", "contracts"]) {
    assert.ok(DATA_RESULT_OPS.has(op), `${op} answers with data`);
  }
  assert.ok(!DATA_RESULT_OPS.has("transition_artifact"), "an accepted transition's reason IS a caveat");
});

test("a turn that landed nothing gets no effects line", async () => {
  const { m, turn } = await oneTurn([() => ({ op: "done", summary: "nothing to do" })]);
  try {
    assert.doesNotMatch(String(turn.summary), /landed this turn/);
    assert.ok(!(turn.notices ?? []).some((n) => n.startsWith("landed this turn")));
  } finally {
    await m.cleanup();
  }
});

const advisory = (m: Mesh, agentId: string) =>
  (m.supervisor as unknown as { uncommittedWorkAdvisory(a: string, t: { results: OpResult[] }): Promise<string | null> }).uncommittedWorkAdvisory(agentId, {
    results: [],
  });

async function withWorktree(agents: AgentSpec[], state: WorktreeState): Promise<{ m: Mesh; ws: FakeWorkspace }> {
  const m = await makeMesh({ agents, mayContact: { dev: ["pm"], pm: ["dev"] }, mode: "parked" });
  const ws = new FakeWorkspace({ behaviour: { worktreeState: { [state.agentId]: state } } });
  installWorkspace(m, ws);
  return { m, ws };
}

test("runtime-owned .mesh/ files are not the seat's uncommitted work", async () => {
  const { m } = await withWorktree([WRITER, PM], untrackedState("dev", [".mesh/agents/dev/ROLE.md", ".mesh/agents/dev/MESH_CONTEXT.md", ".mesh/agents/dev/x"]));
  try {
    assert.equal(await advisory(m, "dev"), null, "the runtime wrote these; the seat has nothing to commit");
  } finally {
    await m.cleanup();
  }
});

test("mixed with real work, .mesh/ files are neither named nor counted", async () => {
  const { m } = await withWorktree([WRITER, PM], untrackedState("dev", [".mesh/agents/dev/ROLE.md", "src/a.ts", "src/b.ts"]));
  try {
    const note = await advisory(m, "dev");
    assert.ok(note, "real uncommitted work is still reported");
    assert.match(note!, /2 file\(s\)/);
    assert.doesNotMatch(note!, /\.mesh\//);
  } finally {
    await m.cleanup();
  }
});

test("a seat that cannot commit is not told to commit", async () => {
  // Writes (architecture.write earns a worktree) but holds no git.commit — 12 of
  // the 27 warnings of the measured run went to seats like this.
  const architect: AgentSpec = { id: "dev", role: "architect", capabilities: ["repository.read", "architecture.write"], interests: [] };
  const { m, ws } = await withWorktree([architect, PM], untrackedState("dev", ["docs/design.md"]));
  try {
    assert.equal(await advisory(m, "dev"), null, "a warning the seat cannot act on is noise in its next context");
    assert.deepEqual(ws.callsTo("worktreeState"), [], "and the git probe is skipped for it");
  } finally {
    await m.cleanup();
  }
});
