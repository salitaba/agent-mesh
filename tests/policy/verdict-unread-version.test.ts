import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor } from "../helpers";
import { createMcpToolset } from "../../apps/mesh-server/src/mcp";
import { mintSeatToken } from "../../packages/core/src/seat-token";
import type { AgentInput, MeshOp } from "../../packages/protocol/src/index";

/**
 * A verdict on a version the seat's turn has not seen.
 *
 * The verdict tools name the artifact, not a version, so a ruling the seat reached on the version it knew lands on the one
 * published since: the reducer drops the old version's verdicts and keeps the artifact. The stale-version check catches a seat
 * that cites a version (`verdict-stale-version.test.ts`); this catches the one that cites none.
 *
 * The eighteenth cronlite run's tech lead began a turn at 03:33:51 to review the implementation. It had rejected the first versions
 * of the developer's CLI and test patches at 03:31 ("descriptions, not code"), and the developer published a second version of each
 * at 03:34:02 and 03:34:05. At 03:34:34 the tech lead rejected both again ("still contains descriptions rather than code", which
 * was true of the versions it remembered) without having read them. The rejections were recorded against the new versions, the patches were REJECTED with the
 * code the tech lead went on to approve, and the mission could not complete until the stall watchdog woke the developer to archive
 * them, 3 min 25 s after every criterion was evidenced.
 *
 * These drive the verdict as a Claude seat does: a real tool call through `McpToolset`, made from inside a live turn, because a
 * turn is what the baseline is taken from.
 */

const USAGE = { input: 1_000, output: 500, total: 1_500 };

const AGENTS = [
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write"], interests: [] },
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "code.review"], authority: ["implementation.approve"], interests: [] },
  { id: "qa", role: "qa", capabilities: ["repository.read", "test.execute"], authority: ["quality.pass"], interests: [] },
];
const COMM = { dev: ["lead", "qa"], lead: ["dev", "qa"], qa: ["dev", "lead"] };

type Mesh = Awaited<ReturnType<typeof makeMesh>>;
type Answer = Record<string, unknown>;
type Call = (name: string, args: Record<string, unknown>) => Promise<Answer>;

const turnFor = (agentId: string) =>
  ({ turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`, agentId, reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] }) as never;

function callAs(m: Mesh, seat: string): Call {
  const mcp = createMcpToolset(m.supervisor);
  return async (name, args) => {
    const tok = mintSeatToken(m.config.meshId, seat, m.kernel.state.activeGoalId);
    const res = (await mcp.handle(seat, tok, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    return JSON.parse(res.result.content[0]!.text) as Answer;
  };
}

/** A CodePatch at the given version, under review by the lead. */
async function patch(versions: 1 | 2) {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" } as never);
  const created = await m.supervisor.createArtifact({ actorId: "dev", name: "cli-patch", type: "CodePatch", content: "a description of the CLI, not the code" });
  if (!("artifact" in created)) throw new Error("create failed");
  const id = created.artifact.id;
  if (versions === 2) await newVersion(m, id);
  await m.supervisor.transitionArtifact("dev", id, { to: "READY_FOR_REVIEW" });
  await m.supervisor.executeOp("dev", { op: "request_review", artifactId: id, reviewers: ["lead"] } as MeshOp, turnFor("dev"));
  return { m, id };
}

async function newVersion(m: Mesh, id: string): Promise<void> {
  const v = await m.supervisor.createArtifact({ actorId: "dev", name: "cli-patch", type: "CodePatch", content: "the CLI itself, as code", asVersionOf: id });
  if (!("artifact" in v)) throw new Error("versioning failed");
}

/** One turn of `seat`: the script runs inside it, and the turn is awaited to its close. */
async function turnOf(m: Mesh, seat: string, script: (call: Call) => Promise<void>): Promise<void> {
  const call = callAs(m, seat);
  let ran = false;
  stub(m).setScript(seat, async (_input: AgentInput) => {
    if (ran) return { operations: [{ op: "wait" } as MeshOp], tokensUsed: USAGE };
    ran = true;
    await script(call);
    return { operations: [], text: "done", typedOps: true, toolCalls: [], tokensUsed: USAGE };
  });
  await m.supervisor.activateAgent(seat, { kind: "manual" }, { explicit: true });
  await waitFor(`${seat}'s turn to close`, () => m.supervisor.getRecentTurns().some((t) => t.agentId === seat && t.status !== "running"));
}

const events = async (m: Mesh, type: string) => (await m.store.read()).filter((e) => e.type === type);
const denial = async (m: Mesh) =>
  (await events(m, "message.rejected")).find((e) => (e.payload as { ruleId?: string }).ruleId === "verdict.unread-version")?.payload as { reason?: string } | undefined;

test("a rejection of a version published after the turn began, which the turn did not read, is refused and records nothing", async () => {
  const { m, id } = await patch(1);
  try {
    let answer: Answer = {};
    await turnOf(m, "lead", async (call) => {
      await newVersion(m, id); // the developer reworks it while the lead is deciding
      answer = await call("mesh_reject", { subject: "implementation", artifactId: id, comment: "still a description, not code" });
    });
    assert.equal(answer.ok, false, JSON.stringify(answer));
    assert.match(String(answer.error), /CodePatch "cli-patch" is v2 now: it was v1 when your turn began and has been published since, and you have not read it in this turn/);
    assert.match(String(answer.error), /mesh_artifact_read artifact:\/\/CodePatch\/cli-patch\/2/, "and it says what to read");
    assert.deepEqual(await events(m, "review.rejected"), [], "no phantom rejection of content the seat never saw");
    assert.notEqual(m.kernel.state.artifacts.get(id)?.status, "REJECTED", "so the patch is not left REJECTED for the owner to untangle");
    assert.ok(await denial(m), "the refusal is on the record with its rule id");
  } finally {
    await m.cleanup();
  }
});

test("an approval of such a version is refused the same way", async () => {
  const { m, id } = await patch(1);
  try {
    let answer: Answer = {};
    await turnOf(m, "lead", async (call) => {
      await newVersion(m, id);
      answer = await call("mesh_approve", { subject: "implementation", artifactId: id, comment: "looks fine" });
    });
    assert.equal(answer.ok, false, JSON.stringify(answer));
    assert.deepEqual(await events(m, "review.approved"), []);
  } finally {
    await m.cleanup();
  }
});

test("after reading the new version in the same turn the verdict stands, and lands on it", async () => {
  const { m, id } = await patch(1);
  try {
    let refused: Answer = {};
    let recorded: Answer = {};
    await turnOf(m, "lead", async (call) => {
      await newVersion(m, id);
      refused = await call("mesh_reject", { subject: "implementation", artifactId: id, comment: "still a description" });
      const read = await call("mesh_artifact_read", { artifactRef: "artifact://CodePatch/cli-patch/2" });
      assert.equal(read.ok, true, JSON.stringify(read));
      recorded = await call("mesh_approve", { subject: "implementation", artifactId: id, comment: "v2 is the code" });
    });
    assert.equal(refused.ok, false);
    assert.equal(recorded.ok, true, JSON.stringify(recorded));
    const approved = await events(m, "review.approved");
    assert.equal(approved.length, 1);
    assert.match(JSON.stringify(approved[0]!.payload), /cli-patch\/2/, "recorded against the version it read");
  } finally {
    await m.cleanup();
  }
});

test("a version that existed when the turn began needs no read in this turn: the seat may have read it in an earlier one", async () => {
  const { m, id } = await patch(2);
  try {
    let answer: Answer = {};
    await turnOf(m, "lead", async (call) => {
      answer = await call("mesh_approve", { subject: "implementation", artifactId: id, comment: "read last turn" });
    });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.equal((await events(m, "review.approved")).length, 1);
    assert.equal(await denial(m), undefined);
  } finally {
    await m.cleanup();
  }
});

test("a seat that gives the pass is not held to a read: it runs what it tests", async () => {
  const { m, id } = await patch(1);
  try {
    let answer: Answer = {};
    await turnOf(m, "qa", async (call) => {
      await newVersion(m, id);
      answer = await call("mesh_approve", { subject: "quality", kind: "pass", artifactId: id, comment: "ran the suite in my worktree" });
    });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.equal(await denial(m), undefined, `a pass is not an unread verdict: ${JSON.stringify(answer)}`);
  } finally {
    await m.cleanup();
  }
});

test("a verdict outside any turn has no baseline and is not refused", async () => {
  const { m, id } = await patch(1);
  try {
    await newVersion(m, id);
    const res = await m.supervisor.executeOp("lead", { op: "approve", subject: "implementation", artifactId: id, comment: "operator-driven" } as MeshOp, turnFor("lead"));
    assert.equal(res.ok, true, String(res.reason));
  } finally {
    await m.cleanup();
  }
});

test("an approve from a seat that holds only the pass is that seat's pass, and is not held to a read either", async () => {
  const { m, id } = await patch(1);
  try {
    let answer: Answer = {};
    await turnOf(m, "qa", async (call) => {
      await newVersion(m, id);
      answer = await call("mesh_approve", { subject: "quality", artifactId: id, comment: "ran the suite in my worktree" });
    });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.match(String(answer.note), /recorded as your quality\.pass/, "the word it used is approve; the verdict it gives is a pass");
    assert.equal(await denial(m), undefined, JSON.stringify(answer));
  } finally {
    await m.cleanup();
  }
});

test("a seat that publishes a version in its own turn has seen it: a mesh with no peer to review lets it settle its own work", async () => {
  const m = await makeMesh({
    agents: [{ id: "solo", role: "tech-lead", capabilities: ["repository.read", "repository.write", "code.review"], authority: ["implementation.approve"], interests: [] }],
    mayContact: { solo: [] },
    mode: "parked",
  } as never);
  try {
    let published: Answer = {};
    let answer: Answer = {};
    await turnOf(m, "solo", async (call) => {
      published = await call("mesh_artifact_publish", { name: "solo-patch", type: "CodePatch", content: "the patch itself, at length" });
      answer = await call("mesh_approve", { subject: "implementation", artifactId: String(published.artifactId), comment: "mine, and nobody else can review it" });
    });
    assert.ok(published.artifactId, JSON.stringify(published));
    assert.equal(await denial(m), undefined, `it wrote that version, so it has seen it: ${JSON.stringify(answer)}`);
  } finally {
    await m.cleanup();
  }
});

test("a verdict on a criterion is not a verdict on an artifact version, and is left to the criterion's own checks", async () => {
  const { m, id } = await patch(1);
  try {
    await turnOf(m, "lead", async (call) => {
      await newVersion(m, id);
      await call("mesh_reject", { subject: "criterion:whatever", artifactId: id, comment: "not the evidence" });
    });
    assert.equal(await denial(m), undefined);
  } finally {
    await m.cleanup();
  }
});

test("an artifact that did not exist when the turn began is as unread as a new version of one that did", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" } as never);
  try {
    let answer: Answer = {};
    await turnOf(m, "lead", async (call) => {
      const created = await m.supervisor.createArtifact({ actorId: "dev", name: "late-patch", type: "CodePatch", content: "published while the lead was deciding" });
      if (!("artifact" in created)) throw new Error("create failed");
      answer = await call("mesh_approve", { subject: "implementation", artifactId: created.artifact.id, comment: "looks fine" });
    });
    assert.equal(answer.ok, false, JSON.stringify(answer));
    assert.match(String(answer.error), /CodePatch "late-patch" is v1 now: it did not exist when your turn began, and you have not read it in this turn/);
  } finally {
    await m.cleanup();
  }
});
