import { test } from "node:test";
import assert from "node:assert/strict";
import { locateIssue, whereLabel } from "../../apps/mesh-dashboard/src/designer/locate";

/* Every string below is one the server really sends (probed against /config/validate and the config checks). */
const SEATS = ["pm", "architect", "tech-lead", "qa"];

test("a schema path names the seat and the section that holds the field", () => {
  assert.deepEqual(locateIssue("/agents/pm/role: must NOT have fewer than 1 characters", SEATS), { tab: "crew", seat: "pm", section: "general", field: "role", editable: true });
  assert.deepEqual(locateIssue("/agents/qa/capabilities: must be array", SEATS), { tab: "crew", seat: "qa", section: "tools", field: "capabilities", editable: true });
  assert.equal(locateIssue("/agents/qa/budget/tokens: must be integer", SEATS).section, "budget");
  assert.equal(locateIssue("/agents/qa/delegation/max_depth: must be integer", SEATS).section, "advanced");
});

test("a schema path to a seat that is not in the draft still points at the seat tab, with no seat to open", () => {
  const w = locateIssue("/agents/ghost/role: must NOT have fewer than 1 characters", SEATS);
  assert.equal(w.tab, "crew");
  assert.equal(w.seat, undefined);
});

test("no seats at all points at the seat tab", () => {
  assert.equal(locateIssue("/agents: must NOT have fewer than 1 properties", []).tab, "crew");
});

test("a mesh-level schema path goes to the mesh tab and the part of it that holds the field", () => {
  assert.deepEqual(locateIssue("/mesh/goal: must NOT have fewer than 1 characters", SEATS), { tab: "mesh", section: "goal", field: "goal", editable: true });
  assert.equal(locateIssue("/mesh: must have required property 'id'", SEATS).section, "identity");
  assert.equal(locateIssue("/mesh/acceptance_criteria/0/description: must NOT have fewer than 1 characters", SEATS).section, "criteria");
});

test("a wire to a seat that does not exist opens the seat whose list names it, at its communication section", () => {
  const w = locateIssue("policies.communication.pm.may_contact references unknown agent 'ghost'", SEATS);
  assert.deepEqual(w, { tab: "crew", seat: "pm", section: "communication", field: "may_contact", editable: true });
  assert.equal(locateIssue("policies.communication.qa.may_be_contacted_by references unknown agent 'ghost'", SEATS).field, "may_be_contacted_by");
});

test("a start list that names a seat that does not exist points at the start control", () => {
  const w = locateIssue("startup.activate references unknown agent 'ghost'", SEATS);
  assert.deepEqual([w.tab, w.section, w.field], ["crew", "behavior", "start"]);
  assert.equal(locateIssue("startup.activate is empty — going live registers every agent and activates none", SEATS).field, "start");
});

test("an interest that is not a pattern opens the seat's wake events", () => {
  const w = locateIssue("agent 'pm' has invalid interest expression 'not-an-event' (expected lower.dot.patterns like architecture.*)", SEATS);
  assert.deepEqual([w.tab, w.seat, w.section], ["crew", "pm", "behavior"]);
});

test("a warning about a seat opens that seat in the section it is about", () => {
  const holds = locateIssue("agent 'tech-lead' holds 'git.merge' but not 'repository.write' or 'test.execute' — it can land a patch it cannot repair or verify", SEATS);
  assert.deepEqual([holds.seat, holds.section], ["tech-lead", "tools"]);
  const loner = locateIssue("agent 'qa' is wired to nobody — no agent may contact it and it may contact no one", SEATS);
  assert.deepEqual([loner.seat, loner.section], ["qa", "communication"]);
  const prompt = locateIssue("agent 'qa' prompt file not found (relative to /x): ./roles/qa.md", SEATS);
  assert.deepEqual([prompt.seat, prompt.section], ["qa", "behavior"]);
});

test("a key the file lacks is named in the sentence, not the path, and the jump goes to its control", () => {
  // what the server really says when a seat's role is emptied (the Designer drops the empty key)
  const role = locateIssue("/agents/qa: must have required property 'role'", SEATS);
  assert.deepEqual(role, { tab: "crew", seat: "qa", section: "general", field: "role", editable: true });
  assert.equal(whereLabel(role), "Open qa: General");
  const goal = locateIssue("/mesh: must have required property 'goal'", SEATS);
  assert.deepEqual([goal.tab, goal.section, goal.field], ["mesh", "goal", "goal"]);
});

test("the Designer's own note about a goal nobody has written opens the goal", () => {
  const w = locateIssue("The goal is still the placeholder. Write what the team should deliver: every seat reads it on every turn.", SEATS);
  assert.deepEqual(w, { tab: "mesh", section: "goal", field: "goal", editable: true });
  assert.equal(whereLabel(w), "Open Mesh: Goal");
});

test("the Designer's own note about a seat that still has its placeholder role opens that seat at the role", () => {
  const w = locateIssue("Seat 'qa' still has the placeholder role 'role-4'. Say what it is for: a gate or a policy rule can name a role.", SEATS);
  assert.deepEqual(w, { tab: "crew", seat: "qa", section: "general", field: "role", editable: true });
  assert.equal(whereLabel(w), "Open qa: General");
});

test("a gate problem opens the policy tab at that gate", () => {
  const bad = locateIssue("transition gate 'patch.merge' requirement 'tech-lead.approve|' is malformed: each '|'-separated alternative must be '<agent-or-role>.<kind>'", SEATS);
  assert.deepEqual([bad.tab, bad.section, bad.field], ["policy", "gates", "patch.merge"]);
  const nobody = locateIssue("gate 'patch.merge' token 'ghost.approve': no agent has id or role 'ghost'", SEATS);
  assert.deepEqual([nobody.tab, nobody.section, nobody.field], ["policy", "gates", "patch.merge"]);
});

test("a policy rule problem opens the rules", () => {
  const w = locateIssue("policy rule 'r1' references unknown actor 'ghost'", SEATS);
  assert.deepEqual([w.tab, w.section, w.field], ["policy", "rules", "r1"]);
});

test("a message about a file-level key the Designer has no control for says so instead of offering a jump", () => {
  const w = locateIssue("mesh.yaml declares no project.id — using 'demo-stub' derived from the folder name. Add 'project: { id: demo-stub }' to pin it", SEATS);
  assert.equal(w.editable, false);
});

test("the button that goes there says where: the seat and the part of it, or the tab", () => {
  assert.equal(whereLabel(locateIssue("/agents/pm/capabilities: must be array", SEATS)), "Open pm: Tools");
  assert.equal(whereLabel(locateIssue("gate 'patch.merge' token 'ghost.approve': no agent has id or role 'ghost'", SEATS)), "Open Policy: Gates");
  assert.equal(whereLabel(locateIssue("/mesh/goal: must NOT have fewer than 1 characters", SEATS)), "Open Mesh: Goal");
  assert.equal(whereLabel(locateIssue("startup.activate references unknown agent 'ghost'", SEATS)), "Open Seat: Behavior", "no seat to open, so the tab is named");
  assert.equal(whereLabel({ tab: "mesh", editable: true }), "Open Mesh");
});

test("an unknown shape falls back to the mesh tab and is still offered", () => {
  assert.deepEqual(locateIssue("something nobody has seen before", SEATS), { tab: "mesh", editable: true });
});
