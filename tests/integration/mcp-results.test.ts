import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { makeMesh } from "../helpers";
import { createMcpToolset } from "../../apps/mesh-server/src/mcp";
import { mintSeatToken } from "../../packages/core/src/seat-token";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * What a seat is told when a mesh tool call SUCCEEDS.
 *
 * `summarize` passed an op's `reason` only on a refusal and never passed
 * `contracts` at all, so an accepted call answered `{ok: true}` and little else:
 * `mesh_contracts` returned no catalogue, and a seat that proposed a decision
 * never learned the id `mesh_decision_ratify` needs — nor a lease id, a commit
 * sha, a merge, or a spawned worker's id. Its only other route was the next
 * turn's summary, which listed them as "⚠" warnings.
 *
 * Products come back as data under their own names; a caveat on an accepted op
 * comes back as `note`, the voice a refused wake already used. These drive the
 * real `tools/call` path, as a seat's MCP client does.
 */

type Mesh = Awaited<ReturnType<typeof makeMesh>>;
type Answer = Record<string, unknown> & { ok: boolean };

function caller(m: Mesh) {
  const mcp = createMcpToolset(m.supervisor);
  return async (as: string, name: string, args: Record<string, unknown> = {}): Promise<Answer> => {
    const tok = mintSeatToken(m.config.meshId, as, m.kernel.state.activeGoalId);
    const res = (await mcp.handle(as, tok, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    const answer = JSON.parse(res.result.content[0]!.text) as Answer;
    assert.equal(res.result.isError, !answer.ok, "isError mirrors ok");
    return answer;
  };
}

const AGENTS = [
  {
    id: "arch",
    role: "architect",
    capabilities: ["repository.read", "repository.write"],
    authority: ["architecture.approve"],
    interests: [],
    delegation: { allow: true, max_depth: 1, max_workers: 1 },
  },
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "review.design"], authority: ["quality.approve"], interests: [] },
  { id: "ui", role: "ui-designer", capabilities: ["repository.read", "ui.write"], interests: [] },
];
const COMM = { arch: ["lead", "ui"], lead: ["arch", "ui"], ui: ["arch", "lead"] };

function parked(): Promise<Mesh> {
  return makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" });
}

test("mcp results: mesh_contracts returns the catalogue it describes", async () => {
  const m = await parked();
  try {
    const answer = await caller(m)("arch", "mesh_contracts");
    assert.equal(answer.ok, true);
    const contracts = answer.contracts as Array<{ name: string; providers: string[]; request: unknown }>;
    assert.ok(Array.isArray(contracts) && contracts.length > 0, `the catalogue, not a bare ok: ${JSON.stringify(answer)}`);
    const review = contracts.find((c) => c.name === "review.artifact");
    assert.ok(review, "the named asks are listed");
    assert.ok(Array.isArray(review.providers), "with who can answer each");
    assert.ok(review.request, "and the shape each one expects");
  } finally {
    await m.cleanup();
  }
});

test("mcp results: a proposed decision's id comes back, and ratifies", async () => {
  const m = await parked();
  try {
    const call = caller(m);
    const proposed = await call("arch", "mesh_decision_propose", { topic: "storage", decision: { pick: "postgres" } });
    assert.equal(proposed.ok, true, JSON.stringify(proposed));
    assert.match(String(proposed.decisionId), /\S/, `the id the ratify tool needs: ${JSON.stringify(proposed)}`);
    assert.equal(m.kernel.state.decisions.get(String(proposed.decisionId))?.status, "PROPOSED", "and it is the real id");
    assert.equal(proposed.note, undefined, "a product is not a caveat");

    const ratified = await call("arch", "mesh_decision_ratify", { decisionId: proposed.decisionId });
    assert.equal(ratified.ok, true, JSON.stringify(ratified));
    assert.equal(m.kernel.state.decisions.get(String(proposed.decisionId))?.status, "RATIFIED");
  } finally {
    await m.cleanup();
  }
});

test("mcp results: a lease's id comes back on acquire and on release", async () => {
  const m = await parked();
  try {
    const call = caller(m);
    const created = await m.supervisor.createArtifact({ actorId: "arch", name: "patch", type: "CodePatch", content: "a patch described at length" });
    if (!("artifact" in created)) throw new Error("create failed");
    const acquired = await call("arch", "mesh_lease_acquire", { artifactId: created.artifact.id, files: ["src/a.ts"] });
    assert.equal(acquired.ok, true, JSON.stringify(acquired));
    const leaseId = String(acquired.leaseId);
    assert.equal(m.kernel.state.leases.get(leaseId)?.agentId, "arch", `the real lease id: ${JSON.stringify(acquired)}`);
    const released = await call("arch", "mesh_lease_release", { artifactId: created.artifact.id });
    assert.deepEqual(released, { ok: true, leaseId });
  } finally {
    await m.cleanup();
  }
});

test("mcp results: a spawned worker's id comes back with its task", async () => {
  const m = await parked();
  try {
    const answer = await caller(m)("arch", "mesh_spawn_worker", { title: "count lines", taskSpec: "count the lines in src" });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.ok(m.kernel.state.agents.has(String(answer.workerId)), `the worker's seat id: ${JSON.stringify(answer)}`);
    assert.ok(m.kernel.state.tasks.has(String(answer.taskId)), "and the task it was given");
  } finally {
    await m.cleanup();
  }
});

test("mcp results: a caveat on an accepted op comes back as note, not as data", async () => {
  // The live shape from verdict-reachability.test.ts: one reviewer who can settle
  // the artifact, one who cannot. The ask stands, and the asker must learn which
  // named seat will spend a turn on a verdict that cannot count.
  const m = await parked();
  try {
    const created = await m.supervisor.createArtifact({ actorId: "arch", name: "design-system", type: "ArchitectureDocument", content: "tokens, components, states — at length" });
    if (!("artifact" in created)) throw new Error("create failed");
    const answer = await caller(m)("arch", "mesh_request_review", { artifactId: created.artifact.id, reviewers: ["lead", "ui"] });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.match(String(answer.note), /ui cannot deliver a verdict on this ArchitectureDocument/);
    assert.equal(answer.result, undefined, "a caveat is not the op's product");
    assert.ok(answer.messageId, "and the ask's own id still comes back");
  } finally {
    await m.cleanup();
  }
});

test("mcp results: withdraw and discharge do not echo the caller's own reason back", async () => {
  const m = await parked();
  try {
    const call = caller(m);
    const ask = await m.supervisor.sendMessage({ from: "lead", to: ["arch"], type: "REQUEST", newThread: { subject: "q" }, payload: { q: "which db?" } });
    assert.equal(ask.accepted, true, ask.reason);
    const discharged = await call("arch", "mesh_discharge", { messageId: ask.messageId, reason: "not mine to decide" });
    assert.equal(discharged.ok, true, JSON.stringify(discharged));
    assert.deepEqual(Object.keys(discharged).sort(), ["messageId", "ok"], `no result, no note: ${JSON.stringify(discharged)}`);

    const mine = await m.supervisor.sendMessage({ from: "arch", to: ["lead"], type: "REQUEST", newThread: { subject: "r" }, payload: { q: "review?" } });
    const withdrawn = await call("arch", "mesh_withdraw", { messageId: mine.messageId, reason: "moved on" });
    assert.equal(withdrawn.ok, true, JSON.stringify(withdrawn));
    assert.equal(withdrawn.result, undefined);
    assert.equal(withdrawn.note, undefined);
  } finally {
    await m.cleanup();
  }
});

// ---- git: the commit sha and what the merge landed ----------------------------

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("mcp results: a commit's sha and a merge's landing come back", { skip: !hasGit && "git unavailable" }, async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "git.commit"], interests: [] },
      { id: "lead", role: "tech-lead", capabilities: ["repository.read", "code.review", "git.merge"], authority: ["implementation.approve"], interests: [] },
    ],
    mayContact: { dev: ["lead"], lead: ["dev"] },
    mode: "parked",
    criteria: [{ id: "implementation-merged", description: "the patch landed", mandatory: true }],
    git: true,
    persist: true,
  });
  try {
    const call = caller(m);
    const created = await m.supervisor.createArtifact({ actorId: "dev", name: "hello", type: "CodePatch", content: "hello patch, described at length" });
    if (!("artifact" in created)) throw new Error("create failed");
    const id = created.artifact.id;
    assert.equal((await call("dev", "mesh_lease_acquire", { artifactId: id, files: ["src/hello.txt"] })).ok, true);
    const worktree = await m.supervisor.agentWorkspace("dev");
    fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
    fs.writeFileSync(path.join(worktree, "src", "hello.txt"), "hello from dev\n", "utf8");

    const committed = await call("dev", "mesh_commit", { artifactId: id, message: "feat: hello", files: ["src/hello.txt"] });
    assert.equal(committed.ok, true, JSON.stringify(committed));
    assert.match(String(committed.commit), /^[0-9a-f]{40}$/, `the sha: ${JSON.stringify(committed)}`);

    await m.supervisor.transitionArtifact("dev", id, { to: "READY_FOR_REVIEW" });
    assert.equal((await call("dev", "mesh_request_review", { artifactId: id, reviewers: ["lead"] })).ok, true);
    assert.equal((await call("lead", "mesh_approve", { subject: "implementation", artifactId: id })).ok, true);
    await m.supervisor.transitionArtifact("lead", id, { to: "VERIFIED" });
    await m.supervisor.transitionArtifact("lead", id, { to: "MERGEABLE" });
    const merged = await call("lead", "mesh_merge", { artifactId: id, comment: "land hello" });
    assert.equal(merged.ok, true, JSON.stringify(merged));
    assert.match(String(merged.result), /^merged as [0-9a-f]{12}/, `what landed: ${JSON.stringify(merged)}`);
    assert.equal(merged.note, undefined);
  } finally {
    await m.cleanup();
  }
});
