import { test } from "node:test";
import assert from "node:assert/strict";
import { planCoversHardOp } from "../../packages/core/src/projections-helpers";
import type { AgentDefinition, AgentRuntimeState, MeshOp } from "../../packages/protocol/src/index";

const def = (over: Partial<AgentDefinition> = {}): AgentDefinition => ({
  id: "dev",
  role: "developer",
  runtime: "stub",
  capabilities: ["repository.write", "git.commit"],
  authority: [],
  interests: [],
  hardActions: { mode: "enforce", capabilities: ["repository.write", "git.commit"] },
  ...over,
} as AgentDefinition);

const st = (over: Partial<AgentRuntimeState> = {}): AgentRuntimeState => ({
  lifecycle: "IDLE",
  activeTaskId: "task-1",
  tokensConsumed: 0,
  ...over,
} as AgentRuntimeState);

const step = (over: Record<string, unknown> = {}) => ({
  id: "s1", text: "write it", status: "PENDING", capabilities: ["repository.write"], ...over,
}) as any;

const PUBLISH = { op: "publish_artifact", name: "n", type: "ADR", content: "c" } as MeshOp;

test("plan gate: an op with no capability mapping is never gated", () => {
  assert.equal(planCoversHardOp({ op: "wait" } as MeshOp, def(), st()), null);
  // send/claim_task carry no HARD_OP_CAPABILITY entry — gating them would make
  // ordinary coordination impossible.
  assert.equal(planCoversHardOp({ op: "done" } as MeshOp, def(), st()), null);
});

test("plan gate: an agent that lacks the capability is waved through", () => {
  // Some other layer refuses this op. Demanding a plan step for a capability
  // the agent can never spend is an order with no legal way to comply, and the
  // agent would burn its whole strike budget re-planning.
  const d = def({ capabilities: ["architecture.read"] });
  assert.equal(planCoversHardOp(PUBLISH, d, st()), null);
});

test("plan gate: a capability the operator did not list stays ungated", () => {
  const d = def({ hardActions: { mode: "enforce", capabilities: ["git.merge"] } });
  assert.equal(planCoversHardOp(PUBLISH, d, st()), null, "opting git.merge in must not drag repository.write along");
});

test("plan gate: no plan at all is refused, and says what to emit", () => {
  const miss = planCoversHardOp(PUBLISH, def(), st({ plan: undefined }));
  assert.ok(miss, "a listed hard capability with no plan must be refused");
  assert.match(miss!, /repository\.write/);
  assert.match(miss!, /"op":"plan"/, "the refusal has to carry the recovery instruction — it is all the agent gets");
});

test("plan gate: an empty plan is the same as no plan", () => {
  const plan = { taskId: "task-1", steps: [], revision: 1, updatedAt: "t" };
  assert.ok(planCoversHardOp(PUBLISH, def(), st({ plan } as any)));
});

test("plan gate: a plan for a different task does not cover the current one", () => {
  const plan = { taskId: "task-OTHER", steps: [step()], revision: 1, updatedAt: "t" };
  const miss = planCoversHardOp(PUBLISH, def(), st({ plan } as any));
  assert.ok(miss);
  assert.match(miss!, /task-OTHER/);
  assert.match(miss!, /task-1/);
});

test("plan gate: a step that does not name the capability does not unlock it", () => {
  const plan = { taskId: "task-1", steps: [step({ capabilities: [] })], revision: 1, updatedAt: "t" };
  const miss = planCoversHardOp(PUBLISH, def(), st({ plan } as any));
  assert.ok(miss);
  assert.match(miss!, /repository\.write/);
});

test("plan gate: a matching step passes", () => {
  const plan = { taskId: "task-1", steps: [step()], revision: 1, updatedAt: "t" };
  assert.equal(planCoversHardOp(PUBLISH, def(), st({ plan } as any)), null);
});

test("plan gate: a DONE step still counts", () => {
  // The gate asks 'did you think about this before you started', not 'is this
  // step still open'. Refusing a retry after a transient failure would be a
  // deadlock with no legal way out.
  const plan = { taskId: "task-1", steps: [step({ status: "DONE" })], revision: 1, updatedAt: "t" };
  assert.equal(planCoversHardOp(PUBLISH, def(), st({ plan } as any)), null);
});

test("plan gate: a plan with no taskId covers whatever the agent is on", () => {
  const plan = { steps: [step()], revision: 1, updatedAt: "t" };
  assert.equal(planCoversHardOp(PUBLISH, def(), st({ plan } as any)), null);
});

test("plan gate: commit and merge map to their own capabilities", () => {
  const plan = { taskId: "task-1", steps: [step({ capabilities: ["repository.write"] })], revision: 1, updatedAt: "t" };
  const miss = planCoversHardOp({ op: "commit", artifactId: "a", message: "m" } as MeshOp, def(), st({ plan } as any));
  assert.ok(miss, "a repository.write step must not unlock git.commit");
  assert.match(miss!, /git\.commit/);
});

test("plan gate: an absent hardActions policy means off", () => {
  const d = def({ hardActions: undefined });
  assert.equal(planCoversHardOp(PUBLISH, d, st({ plan: undefined })), null, "omitted policy must behave exactly as mode:off");
});
