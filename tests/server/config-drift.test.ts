/**
 * The sync offer that closes the mesh.yaml ↔ Overview gap.
 *
 * mesh.yaml is a seed and not a mirror, so a Save onto the running config moves
 * the file and the Config view and leaves the Overview on the mission that
 * actually booted. `configDrift` turns that gap into the proposal that would
 * close it, and the Designer offers it in one reviewed click.
 *
 * These use a real booted mesh rather than a hand-built state object: the whole
 * point of the module is to compare the file against what boot actually made of
 * it, and a stub state would let the two shapes drift apart unnoticed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { configDrift } from "../../apps/mesh-server/src/config-drift";
import type { ResolvedMeshConfig } from "../../packages/config/src/index";
import type { StagedMutation } from "../../packages/protocol/src/index";

const AGENTS = [
  { id: "alpha", role: "builder", interests: [] as string[] },
  { id: "beta", role: "reviewer", interests: [] as string[] },
];
const MAY = { alpha: ["beta"], beta: ["alpha"] };
const CRITERIA = [
  { id: "c1", description: "The thing is built.", mandatory: true },
  { id: "c2", description: "The thing is reviewed.", mandatory: false },
];

function kinds(ms: StagedMutation[]): string[] {
  return ms.map((m) => m.kind);
}
function only<K extends StagedMutation["kind"]>(ms: StagedMutation[], kind: K): Extract<StagedMutation, { kind: K }>[] {
  return ms.filter((m): m is Extract<StagedMutation, { kind: K }> => m.kind === kind);
}

async function booted() {
  return makeMesh({ agents: AGENTS, mayContact: MAY, criteria: CRITERIA, goal: "Ship the thing.", mode: "live" });
}

test("a file identical to the running mesh proposes nothing", async () => {
  const mesh = await booted();
  try {
    const p = configDrift(mesh.config, mesh);
    assert.deepEqual(p.mutations, []);
    assert.deepEqual(p.problems, []);
  } finally {
    await mesh.cleanup();
  }
});

test("a reworded goal becomes the goal.description that moves the running mission", async () => {
  const mesh = await booted();
  try {
    const resolved: ResolvedMeshConfig = { ...mesh.config, goalText: "Ship the thing, and document it." };
    const p = configDrift(resolved, mesh);
    assert.deepEqual(kinds(p.mutations), ["goal.description"]);
    assert.equal(only(p.mutations, "goal.description")[0].description, "Ship the thing, and document it.");
    assert.deepEqual(p.problems, []);
  } finally {
    await mesh.cleanup();
  }
});

test("re-wrapped whitespace in the goal is not a change", async () => {
  const mesh = await booted();
  try {
    const p = configDrift({ ...mesh.config, goalText: "  Ship   the\n  thing.  " }, mesh);
    assert.deepEqual(p.mutations, []);
  } finally {
    await mesh.cleanup();
  }
});

test("criteria added, edited and dropped each map onto their own kind", async () => {
  const mesh = await booted();
  try {
    const p = configDrift({
      ...mesh.config,
      goalCriteria: [
        { id: "c1", description: "The thing is built AND signed off.", mandatory: true },
        { id: "c3", description: "The thing is released.", mandatory: false },
      ],
    } as ResolvedMeshConfig, mesh);
    assert.deepEqual(new Set(kinds(p.mutations)), new Set(["criteria.add", "criteria.edit", "criteria.delete"]));
    assert.deepEqual(only(p.mutations, "criteria.add")[0].criteria.map((c) => c.id), ["c3"]);
    const edit = only(p.mutations, "criteria.edit")[0];
    assert.equal(edit.criterionId, "c1");
    assert.equal(edit.description, "The thing is built AND signed off.");
    assert.equal(edit.mandatory, undefined, "mandatory did not move, so it must not be restated");
    assert.equal(only(p.mutations, "criteria.delete")[0].criterionId, "c2");
  } finally {
    await mesh.cleanup();
  }
});

test("a flipped mandatory flag edits only that field", async () => {
  const mesh = await booted();
  try {
    const p = configDrift({
      ...mesh.config,
      goalCriteria: [{ ...CRITERIA[0], mandatory: false }, CRITERIA[1]],
    } as ResolvedMeshConfig, mesh);
    assert.deepEqual(kinds(p.mutations), ["criteria.edit"]);
    const edit = only(p.mutations, "criteria.edit")[0];
    assert.equal(edit.mandatory, false);
    assert.equal(edit.description, undefined);
  } finally {
    await mesh.cleanup();
  }
});

test("a file with no acceptance_criteria is reported, never acted on", async () => {
  const mesh = await booted();
  try {
    const p = configDrift({ ...mesh.config, goalCriteria: null } as ResolvedMeshConfig, mesh);
    assert.deepEqual(p.mutations, [], "an absent section must not delete a live criterion");
    assert.equal(p.problems.length, 1);
    assert.match(p.problems[0], /not a request to clear them/);
  } finally {
    await mesh.cleanup();
  }
});

test("a seat only in the file spawns; a seat only in the mesh retires", async () => {
  const mesh = await booted();
  try {
    const { beta, ...rest } = mesh.config.agents;
    assert.ok(beta, "fixture seat present before the edit");
    const gamma = { ...beta, id: "gamma", role: "scribe" };
    const p = configDrift({
      ...mesh.config,
      agents: { ...rest, gamma },
      agentOrder: ["alpha", "gamma"],
    } as ResolvedMeshConfig, mesh);
    assert.deepEqual(new Set(kinds(p.mutations)), new Set(["seat.spawn", "seat.retire"]));
    assert.equal(only(p.mutations, "seat.spawn")[0].agent.id, "gamma");
    assert.equal(only(p.mutations, "seat.retire")[0].agentId, "beta");
    /* seat.retire is destructive, so the apply route refuses it without one. */
    assert.ok(only(p.mutations, "seat.retire")[0].reason);
  } finally {
    await mesh.cleanup();
  }
});

test("a live seat whose definition changed is a problem, not a silent no-op", async () => {
  const mesh = await booted();
  try {
    const alpha = mesh.config.agents.alpha;
    const p = configDrift({
      ...mesh.config,
      agents: { ...mesh.config.agents, alpha: { ...alpha, role: "architect" } },
    } as ResolvedMeshConfig, mesh);
    assert.deepEqual(p.mutations, [], "no staged kind replaces a live seat's definition");
    assert.equal(p.problems.length, 1);
    assert.match(p.problems[0], /alpha/);
  } finally {
    await mesh.cleanup();
  }
});

test("the human seat is never retired by a config that does not list it", async () => {
  const mesh = await booted();
  try {
    assert.ok(mesh.kernel.state.agents.has("human"), "the human seat exists on a booted mesh");
    const p = configDrift(mesh.config, mesh);
    assert.deepEqual(only(p.mutations, "seat.retire"), []);
  } finally {
    await mesh.cleanup();
  }
});

test("raised event and wall-clock caps become one run.budget; tokens are reported", async () => {
  const mesh = await booted();
  try {
    const b = mesh.config.budgets.mission;
    const p = configDrift({
      ...mesh.config,
      budgets: { ...mesh.config.budgets, mission: { ...b, maxEvents: b.maxEvents + 5000, tokens: b.tokens + 1 } },
    } as ResolvedMeshConfig, mesh);
    assert.deepEqual(kinds(p.mutations), ["run.budget"]);
    const budget = only(p.mutations, "run.budget")[0].budget;
    assert.equal(budget.maxEvents, b.maxEvents + 5000);
    assert.equal(budget.wallClockMinutes, undefined, "an unchanged cap must not be restated");
    assert.equal(p.problems.length, 1);
    assert.match(p.problems[0], /token budget/);
  } finally {
    await mesh.cleanup();
  }
});

/* Boot always mints or resumes a goal, parked meshes included, so this state is
 * only reachable by a kernel that has not booted one — cleared here directly.
 * The branch stays because the field is optional in the type: without it every
 * read below would be on `undefined` and the operator would get a stack trace
 * where a sentence belongs. */
test("with no active mission there is nothing to sync, and it says so", async () => {
  const mesh = await booted();
  try {
    delete (mesh.kernel.state as { activeGoalId?: string }).activeGoalId;
    const p = configDrift({ ...mesh.config, goalText: "Something else entirely." }, mesh);
    assert.deepEqual(p.mutations, [], "with no mission there is nothing to move");
    assert.match(p.problems.join(" "), /seed for the next boot/);
  } finally {
    await mesh.cleanup();
  }
});
