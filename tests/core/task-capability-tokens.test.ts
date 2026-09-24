import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * A task's `requiredCapabilities` was the one capability list nobody
 * normalized and nobody validated.
 *
 * Agent definitions, policy rules and the runtime tool gate all run their
 * tokens through `normalizeCapability` at load, and config load REJECTS an
 * unknown one outright. Task requirements are written by a model mid-mission
 * and did neither, with two consequences seen in a live run: a task asking for
 * an alias was unclaimable by the seat holding the canonical token it aliases
 * to, and a task asking for an invented token was unclaimable by anyone at
 * all — refused on every attempt, with nothing saying the token was not real.
 */

const AGENTS = [
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "task.assign"], authority: ["implementation.approve"], interests: [] },
  // Declares the ALIASES. Config load normalizes these to repository.write and
  // test.execute, which is exactly the vocabulary mismatch under test.
  { id: "dev", role: "developer", capabilities: ["api.write", "test.run"], interests: [] },
];

const COMM = { lead: ["dev"], dev: ["lead"] };

const turnFor = (agentId: string) =>
  ({
    turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`,
    agentId,
    reason: { kind: "manual" as const },
    sentOps: 0,
    publishedOps: 0,
    waitRequested: false,
    escalated: false,
    results: [],
  }) as never;

function mesh() {
  return makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" } as never);
}

test("a task requiring an alias is claimable by the seat holding the canonical token", async () => {
  const m = await mesh();
  try {
    // `test.run` aliases to `test.execute`; dev declared `test.run`, which the
    // roster normalized. Before this, the two lists never met.
    const created = await m.supervisor.executeOp(
      "lead",
      { op: "create_task", title: "run the suite", description: "green it", requiredCapabilities: ["test.run"] } as MeshOp,
      turnFor("lead"),
    );
    assert.equal(created.ok, true, created.reason);
    const taskId = created.taskId!;

    const claim = await m.supervisor.claimTask("dev", taskId);
    assert.equal(claim.ok, true, `dev holds the token this task aliases to: ${claim.reason ?? ""}`);
  } finally {
    await m.cleanup();
  }
});

test("the stored task carries the canonical token, not the alias it was written with", async () => {
  const m = await mesh();
  try {
    const created = await m.supervisor.executeOp(
      "lead",
      { op: "create_task", title: "write the api", description: "...", requiredCapabilities: ["api.write", "code.write"] } as MeshOp,
      turnFor("lead"),
    );
    assert.equal(created.ok, true, created.reason);
    const task = m.kernel.state.tasks.get(created.taskId!);
    assert.deepEqual(
      task?.requiredCapabilities,
      ["repository.write"],
      "two aliases for one token collapse to that token exactly once",
    );
  } finally {
    await m.cleanup();
  }
});

test("a capability the runtime can never match is refused to its author, not left on the board", async () => {
  const m = await mesh();
  try {
    const res = await m.supervisor.executeOp(
      "lead",
      { op: "create_task", title: "ship it", description: "...", requiredCapabilities: ["repository.writ"] } as MeshOp,
      turnFor("lead"),
    );
    assert.equal(res.ok, false, "an unmatched token must refuse at creation");
    assert.match(res.reason ?? "", /repository\.writ/, "the refusal names the token that cannot be matched");
    assert.match(res.reason ?? "", /known:/, "and the set the author could have chosen from");
    assert.equal(m.kernel.state.tasks.size, 0, "a refused create_task leaves nothing claimable behind");
  } finally {
    await m.cleanup();
  }
});

test("delegate refuses the same token, so the unclaimable task is never handed out", async () => {
  const m = await mesh();
  try {
    const res = await m.supervisor.executeOp(
      "lead",
      { op: "delegate", to: "dev", title: "do it", description: "...", requiredCapabilities: ["test.exec"] } as MeshOp,
      turnFor("lead"),
    );
    assert.equal(res.ok, false, "delegate must apply the same screen create_task does");
    assert.match(res.reason ?? "", /test\.exec/);
    assert.equal(m.kernel.state.tasks.size, 0);
  } finally {
    await m.cleanup();
  }
});

test("delegate compares like for like: an alias against the canonical token the target holds", async () => {
  const m = await mesh();
  try {
    // dev's roster reads `repository.write` (normalized from api.write). The op
    // says `code.write`. Both are the same token; the pre-check used to
    // compare the raw strings and report a capability the target had.
    const res = await m.supervisor.executeOp(
      "lead",
      { op: "delegate", to: "dev", title: "write it", description: "...", requiredCapabilities: ["code.write"] } as MeshOp,
      turnFor("lead"),
    );
    assert.equal(res.ok, true, `the target holds this token under its canonical name: ${res.reason ?? ""}`);
  } finally {
    await m.cleanup();
  }
});

test("completing a task with evidence that resolves to nothing is refused, and says so", async () => {
  // `artifacts` on `complete_task` was accepted and never read. The MCP tool
  // schema advertises it as "evidence artifact URIs", and the value went straight
  // into the event payload with no existence check — so a completion could cite an
  // artifact that was never published and the board still recorded the task done.
  //
  // The contrast is `claimTask` in the tests above: the claim is gated on a
  // machine-checkable precondition, and the completion was gated on nothing. In a
  // live run a seat marked a task complete fourteen minutes before its deliverable
  // existed, and nothing anywhere noticed the ordering.
  const m = await mesh();
  try {
    const created = await m.supervisor.executeOp(
      "lead",
      { op: "create_task", title: "build it", description: "...", requiredCapabilities: ["api.write"] } as MeshOp,
      turnFor("lead"),
    );
    assert.equal(created.ok, true, created.reason ?? "");
    assert.equal((await m.supervisor.claimTask("dev", created.taskId!)).ok, true);

    const bogus = await m.supervisor.completeTask("dev", created.taskId!, "done", [
      { uri: "artifact://CodePatch/never-published/1" },
    ]);
    assert.equal(bogus.ok, false, "evidence the mesh cannot resolve is not evidence");
    assert.match(bogus.reason ?? "", /resolves to no artifact/);
    assert.equal(m.kernel.state.tasks.get(created.taskId!)?.status, "CLAIMED", "and the task did not move");

    // The refusal is on the record with its remedy, via the same `denied()` every
    // other policy refusal goes through — so it reaches the operator digest rather
    // than only the op's return value.
    const events = await m.store.read();
    const denial = events.find(
      (e) => e.type === "message.rejected" && (e.payload as { ruleId?: string }).ruleId === "task.evidence-unresolvable",
    );
    assert.ok(denial, "the refusal is an event, not just a return value");
    assert.match(String((denial.payload as { reason?: string }).reason), /artifact:\/\/<Type>/, "and names the shape a resolvable ref takes");

    // Citing nothing is still allowed: this holds a seat to the evidence IT chose
    // to cite, and is deliberately not a `requiredArtifacts` contract.
    const bare = await m.supervisor.completeTask("dev", created.taskId!, "done, no artifact");
    assert.equal(bare.ok, true, `citing no evidence is not the same as citing bad evidence: ${bare.reason ?? ""}`);
  } finally {
    await m.cleanup();
  }
});

test("a token no seat holds is still refused at claim time, naming the token", async () => {
  const m = await mesh();
  try {
    const created = await m.supervisor.executeOp(
      "lead",
      { op: "create_task", title: "merge it", description: "...", requiredCapabilities: ["git.merge"] } as MeshOp,
      turnFor("lead"),
    );
    assert.equal(created.ok, true, "git.merge is a real token — creation is fine");

    const claim = await m.supervisor.claimTask("dev", created.taskId!);
    assert.equal(claim.ok, false, "dev does not hold it");
    assert.match(claim.reason ?? "", /git\.merge/);
  } finally {
    await m.cleanup();
  }
});
