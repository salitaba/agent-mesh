import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { parseMeshSource } from "../../packages/config/src/index";
import { validateTransitionGates } from "../../packages/policy-engine/src/index";
import { TEMPLATES } from "../../apps/mesh-dashboard/src/designer/model";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const EXAMPLES = path.join(ROOT, "examples");

// Every shipped config must have gates some agent can actually produce. An
// unsatisfiable gate passes schema validation and then stalls every mission at
// that transition, which is exactly what AJV cannot see.
for (const dir of fs.readdirSync(EXAMPLES).filter((d) => fs.existsSync(path.join(EXAMPLES, d, "mesh.yaml")))) {
  test(`example ${dir}: every transition gate is satisfiable`, () => {
    const raw = parseMeshSource(fs.readFileSync(path.join(EXAMPLES, dir, "mesh.yaml"), "utf8"));
    assert.deepEqual(validateTransitionGates(raw.policies?.transitions, raw.agents), []);
  });
}

// The Designer's starter templates are configs too: the model may echo one
// back or mutate it, so a deadlock here ships straight into a saved mesh.yaml.
for (const tpl of TEMPLATES) {
  test(`template ${tpl.key}: every transition gate is satisfiable`, () => {
    const model = tpl.make();
    assert.deepEqual(validateTransitionGates(model.policies?.transitions, model.agents), []);
  });
}

test("validator flags a gate whose approver lacks review authority", () => {
  const agents = {
    architect: { role: "architect", authority: ["architecture.approve"], capabilities: ["review.design"] },
  };
  const issues = validateTransitionGates({ "patch.merge": { requires: ["architect.approve"] } }, agents);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].token, "architect.approve");
  assert.match(issues[0].reason, /implementation\.approve/);
});

test("validator flags a gate naming an unregistered actor", () => {
  const issues = validateTransitionGates({ "patch.merge": { requires: ["ghost.approve"] } }, {});
  assert.equal(issues.length, 1);
  assert.equal(issues[0].token, "ghost.approve");
});

test("validator accepts a role token when any agent with that role can review", () => {
  const agents = {
    reviewer: { role: "architect", authority: ["implementation.approve"] },
    other: { role: "architect", authority: [] },
  };
  assert.deepEqual(validateTransitionGates({ "patch.merge": { requires: ["architect.approve"] } }, agents), []);
});
