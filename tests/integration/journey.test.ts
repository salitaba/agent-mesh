import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import { bootstrapMesh } from "../../apps/mesh-server/src/index";
import { attachDemoTeam } from "../../apps/mesh-cli/src/bench";

const configPath = path.resolve(process.cwd(), "examples", "demo-stub", "mesh.yaml");

test("product journey: 'mesh run examples/demo-stub' converges the mission end-to-end (no model)", async () => {
  const instance = await bootstrapMesh({ configPath, inMemory: true });
  const unsub = attachDemoTeam(instance);
  const goalId = instance.kernel.state.activeGoalId!;
  const deadline = Date.now() + 20000;
  let goal = instance.kernel.state.goals.get(goalId);
  while (Date.now() < deadline && goal?.status === "ACTIVE") {
    await new Promise((r) => setTimeout(r, 100));
    goal = instance.kernel.state.goals.get(goalId);
  }
  const events: string[] = (await instance.store.read()).map((e) => e.type as string);
  const has = (t: string) => events.filter((x) => x === t).length;
  const artifacts = [...instance.kernel.state.artifacts.values()];

  assert.equal(goal?.status, "COMPLETED", `expected COMPLETED, got ${goal?.status}`);
  assert.equal((goal?.acceptanceCriteria || []).filter((c) => c.mandatory && c.status === "UNSATISFIED").length, 0, "all mandatory criteria evidenced");

  // emergent workflow milestones, in a real partial order
  const idx = (t: string) => events.indexOf(t);
  assert.ok(idx("research.requested") < idx("architecture.approved"), "research informed the design");
  assert.ok(idx("architecture.approved") < idx("task.claimed"), "developer claimed only after approval");
  assert.ok(idx("task.claimed") < idx("patch.ready"), "patch produced after claiming");
  assert.ok(has("patch.ready") >= 2, "at least one QA block + rework round");
  assert.ok(idx("patch.merged") > 0 && idx("release.accepted") > idx("patch.merged"), "release followed the merge");
  assert.ok(idx("goal.completed") > idx("release.accepted"), "completion required accepted release evidence");

  // conflict handling actually exercised: QA blocked patch-1, dev reworked to patch-2
  assert.ok(artifacts.some((a) => a.name === "patch-tx-pipeline-1" && a.status === "READY_FOR_REVIEW"), "blocked patch-1 left in review");
  assert.ok(artifacts.some((a) => a.name === "patch-tx-pipeline-2" && a.status === "MERGED"), "reworked patch-2 merged");
  assert.equal(instance.kernel.state.escalations.size, 0, "happy path escalates nothing");
  assert.ok(has("budget.consumed") > 0, "token accounting ran");

  unsub.cleanup();
  await instance.close();
});
