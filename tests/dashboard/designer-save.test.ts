import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDrift, draftStatus, isScriptedDemo, readApply, shortPath } from "../../apps/mesh-dashboard/src/designer/save";

/* The three problems the server really returns (apps/mesh-server/src/config-drift.ts). */
const SEAT_DIFFERS = "seat 'pm' differs from the running definition. No staged kind replaces a live seat's definition \u2014 boot does that, so restart the mesh to pick it up.";
const RETIRED = "seat 'qa' is in mesh.yaml but was retired, and retirement is terminal \u2014 it cannot be brought back without a restart.";
const TOKENS = "the mission token budget differs (file 1000, running 2000000), and the live budget call accepts only the event and wall-clock caps \u2014 raise tokens from the mission controls instead.";
const NO_MISSION = "no active mission is running, so there is nothing to bring in line \u2014 this file is the seed for the next boot.";
const NO_CRITERIA = "mesh.yaml declares no acceptance_criteria, so the mission's 3 live criteria are left alone \u2014 an absent section is not a request to clear them.";

test("a save with live changes and changed seats offers both: apply now, and restart", () => {
  const r = classifyDrift({ mutations: [{ kind: "goal.description", description: "x" }, { kind: "run.pause" }] as never, problems: [SEAT_DIFFERS, RETIRED] });
  assert.equal(r.apply.length, 2);
  assert.deepEqual(r.restart, [SEAT_DIFFERS, RETIRED]);
  assert.deepEqual(r.notes, []);
  assert.equal(r.inLine, false);
});

test("the token cap is a note, never a restart: nothing a restart does moves a mission's token budget from here", () => {
  const r = classifyDrift({ mutations: [], problems: [TOKENS, NO_CRITERIA] });
  assert.deepEqual(r.restart, []);
  assert.deepEqual(r.notes, [TOKENS, NO_CRITERIA]);
});

test("with no mission running the file is simply the seed for the next boot, and nothing is offered", () => {
  const r = classifyDrift({ mutations: [], problems: [NO_MISSION] });
  assert.equal(r.noMission, true);
  assert.deepEqual([r.apply.length, r.restart.length, r.notes.length], [0, 0, 0]);
  assert.equal(r.inLine, false, "a missing mission is not 'in line'");
});

test("a mission that already matches the file is in line, and a missing proposal is treated the same way", () => {
  assert.equal(classifyDrift({ mutations: [], problems: [] }).inLine, true);
  assert.equal(classifyDrift(null).inLine, true);
  assert.equal(classifyDrift(undefined).inLine, true);
});

/* ------------------------------------------------ what the apply route said */

test("a complete apply says how many changes it made", () => {
  const o = readApply(200, { ok: true, applied: 3, results: [{ kind: "goal.description", ok: true, detail: "mission statement replaced" }, { kind: "seat.spawn", ok: true, detail: "seat 'scribe' registered" }, { kind: "run.budget", ok: true, detail: "ok" }] }, 3);
  assert.equal(o.ok, true);
  assert.equal(o.summary, "Applied 3 changes to the running mission.");
  assert.equal(readApply(200, { ok: true, applied: 1, results: [] }, 1).summary, "Applied 1 change to the running mission.");
});

test("a partial apply is reported as partial, with the refusal in the mission's own words", () => {
  const o = readApply(409, { ok: false, applied: 2, results: [{ kind: "goal.description", ok: true, detail: "replaced" }, { kind: "seat.spawn", ok: true, detail: "registered" }, { kind: "run.budget", ok: false, detail: "maxEvents must exceed the current cap (10000)" }] }, 3);
  assert.equal(o.ok, false);
  assert.equal(o.applied, 2);
  assert.equal(o.summary, "Applied 2 of 3. The mission refused one: maxEvents must exceed the current cap (10000).");
  assert.deepEqual(o.lines.map((l) => l.ok), [true, true, false]);
});

test("a reply that is HTTP 200 but says it did not succeed is not a success", () => {
  const o = readApply(200, { ok: false, applied: 0, results: [] }, 2);
  assert.equal(o.ok, false);
  assert.doesNotMatch(o.summary, /^Applied 0 changes/);
});

test("a refusal with no detail still never claims a change was made", () => {
  const o = readApply(500, null, 2);
  assert.equal(o.ok, false);
  assert.equal(o.applied, 0);
  assert.match(o.summary, /Nothing was applied/);
});

/* ------------------------------------------------ the draft's state */

test("the draft's state is the count of real differences, not a flag that something was edited", () => {
  assert.equal(draftStatus({ changes: 0, hasFile: true, restored: false }).kind, "clean");
  const u = draftStatus({ changes: 3, hasFile: true, restored: false });
  assert.deepEqual([u.kind, u.label], ["unsaved", "3 unsaved changes"]);
  assert.equal(draftStatus({ changes: 1, hasFile: true, restored: false }).label, "1 unsaved change");
});

test("a restored draft says where it came from, but only while it still differs from the file", () => {
  assert.equal(draftStatus({ changes: 2, hasFile: true, restored: true }).kind, "restored");
  assert.equal(draftStatus({ changes: 0, hasFile: true, restored: true }).kind, "clean", "a restored draft that matches the file is just the file");
});

test("with no file the draft says the mesh is new and that saving writes one", () => {
  const s = draftStatus({ changes: 0, hasFile: false, restored: false });
  assert.equal(s.kind, "new");
  assert.match(s.detail, /Saving writes one/);
});

/* ------------------------------------------------ a path that has to fit */

test("a long path keeps the folder it is in and the file, and says it was cut", () => {
  const p = shortPath("/tmp/claude-0/work/lab-d/projects/demo-stub/mesh.yaml");
  assert.equal(p.file, "mesh.yaml");
  assert.equal(p.text, "\u2026/projects/demo-stub/mesh.yaml");
});

test("a short or relative path is shown whole", () => {
  assert.equal(shortPath("mesh.yaml").text, "mesh.yaml");
  assert.equal(shortPath("examples/my-mesh/mesh.yaml").text, "examples/my-mesh/mesh.yaml");
  assert.equal(shortPath("C:\\work\\demo\\mesh.yaml").file, "mesh.yaml");
});

/* ------------------------------------------------ the one mesh a restart does not resume */

test("the scripted demo is the demo-stub mesh with every seat on the stub runtime, by the seat's own runtime or the mesh default", () => {
  assert.equal(isScriptedDemo({ mesh: { id: "demo-stub", runtime: { default: "stub" } }, agents: { pm: { role: "pm" }, qa: { role: "qa", runtime: "stub" } } }), true);
  assert.equal(isScriptedDemo({ mesh: { id: "demo-stub" }, agents: { pm: { role: "pm", runtime: "stub" } } }), true);
});

test("a mesh that kept the demo's id but moved a seat to a real runtime is a real project, which a restart resumes", () => {
  assert.equal(isScriptedDemo({ mesh: { id: "demo-stub", runtime: { default: "stub" } }, agents: { pm: { role: "pm" }, qa: { role: "qa", runtime: "claude" } } }), false);
  assert.equal(isScriptedDemo({ mesh: { id: "demo-stub" }, agents: { pm: { role: "pm" } } }), false, "no runtime named anywhere is not the stub");
});

test("any other id, no seats, or no file is not the demo", () => {
  assert.equal(isScriptedDemo({ mesh: { id: "payments", runtime: { default: "stub" } }, agents: { pm: { role: "pm" } } }), false);
  assert.equal(isScriptedDemo({ mesh: { id: "demo-stub", runtime: { default: "stub" } }, agents: {} }), false);
  assert.equal(isScriptedDemo(null), false);
  assert.equal(isScriptedDemo(undefined), false);
});
