import { test } from "node:test";
import assert from "node:assert/strict";
import { canonical, diffMesh, sameMesh, savePayload, summarizeDiff } from "../../apps/mesh-dashboard/src/designer/diff";
import { densure } from "../../apps/mesh-dashboard/src/designer/model";

/** The file as the server returns it: no padding, only what its author wrote. */
function file(): any {
  return {
    version: 1,
    mesh: { id: "demo", name: "Demo", goal: "Ship a payment endpoint.", runtime: { default: "claude" }, workspace: { path: "./workspace" } },
    startup: { activate: ["pm"] },
    agents: {
      pm: { role: "product-manager", capabilities: ["repository.read"], authority: ["requirements.accept"], interests: ["goal.progress"] },
      qa: { role: "qa", capabilities: ["test.execute"], budget: { tokens: 200000 } },
      dev: { role: "developer", capabilities: ["repository.write"] },
    },
    policies: {
      communication: { pm: { may_contact: ["qa", "dev"] }, qa: { may_contact: ["pm"] } },
      transitions: { "patch.merge": { requires: ["qa.pass"] } },
    },
    budgets: { mission: { tokens: 2000000, wall_clock_minutes: 240, max_events: 10000 } },
  };
}

/** What the Designer holds after loading it: the same file, padded so every panel can read and write blindly. */
function draftOf(raw: any): any {
  const d = JSON.parse(JSON.stringify(raw));
  densure(d);
  return d;
}

/* ------------------------------------------------ the draft nobody touched */

test("a draft nobody has touched differs from its file by nothing", () => {
  const f = file();
  assert.deepEqual(diffMesh(draftOf(f), f), []);
  assert.equal(sameMesh(draftOf(f), f), true);
});

test("the padding densure adds to seats is not a difference: the bug reported seven changes on a mesh with seven seats", () => {
  const f = file();
  const d = draftOf(f);
  assert.deepEqual(d.agents.pm.budget, {}, "the draft really is padded");
  assert.equal(diffMesh(d, f).length, 0);
});

test("a scaffold that declares almost nothing is still unchanged when opened, however many defaults are padded in", () => {
  const f = { version: 1, mesh: { id: "x", goal: "g" }, agents: { architect: { role: "architect" } } };
  const d = draftOf(f);
  assert.ok(d.server && d.scheduling && d.budgets.thread, "defaults were padded");
  assert.deepEqual(diffMesh(d, f), []);
});

test("with no file there is nothing to differ from", () => {
  assert.deepEqual(diffMesh(file(), null), []);
});

test("list order and key order are not differences", () => {
  const f = file();
  const d = draftOf(f);
  d.agents.pm.capabilities = [...d.agents.pm.capabilities].reverse();
  d.agents = Object.fromEntries(Object.entries(d.agents).reverse());
  assert.deepEqual(diffMesh(d, f), []);
});

test("an edit that was put back is not a change", () => {
  const f = file();
  const d = draftOf(f);
  d.agents.pm.role = "owner";
  assert.equal(diffMesh(d, f).length, 1);
  d.agents.pm.role = "product-manager";
  assert.equal(diffMesh(d, f).length, 0);
});

/* ------------------------------------------------ what a person did, in sentences */

test("a reworded goal and a new mesh id are named, with both values", () => {
  const f = file();
  const d = draftOf(f);
  d.mesh.id = "beta";
  d.mesh.goal = "Ship a refund endpoint.";
  const lines = summarizeDiff(d, f);
  assert.ok(lines.some((l) => l.includes("demo") && l.includes("beta")), lines.join(" | "));
  assert.ok(lines.some((l) => l.startsWith("Goal changed") && l.includes("payment") && l.includes("refund")), lines.join(" | "));
});

test("an added seat, a removed seat and a changed field each get one sentence that names the seat", () => {
  const f = file();
  const d = draftOf(f);
  d.agents.scribe = { role: "writer", capabilities: [] };
  densure(d);
  delete d.agents.dev;
  d.agents.qa.role = "quality";
  const lines = diffMesh(d, f);
  assert.ok(lines.some((c) => c.area === "seat" && c.op === "add" && c.text.includes("scribe") && c.text.includes("writer")));
  assert.ok(lines.some((c) => c.area === "seat" && c.op === "remove" && c.text.includes("dev")));
  const role = lines.find((c) => c.text.startsWith("qa: role"));
  assert.ok(role && role.seat === "qa" && role.text.includes("qa") && role.text.includes("quality"), JSON.stringify(role));
});

test("tools, authority and wake events say what was added and what was removed", () => {
  const f = file();
  const d = draftOf(f);
  d.agents.pm.capabilities = ["repository.read", "git.commit"];
  d.agents.pm.authority = [];
  const lines = summarizeDiff(d, f);
  assert.ok(lines.includes("pm: tools added git.commit."), lines.join(" | "));
  assert.ok(lines.includes("pm: authority removed requirements.accept."), lines.join(" | "));
});

test("a seat's budget change is named in the words the inspector uses", () => {
  const f = file();
  const d = draftOf(f);
  d.agents.qa.budget.tokens = 300000;
  assert.ok(summarizeDiff(d, f).includes("qa: token budget changed from 200,000 to 300,000."));
});

test("wires are described per sender, by name, and not as 'wiring changed'", () => {
  const f = file();
  const d = draftOf(f);
  d.policies.communication.pm.may_contact = ["qa"];
  d.policies.communication.qa.may_contact = ["pm", "dev"];
  const lines = summarizeDiff(d, f);
  assert.ok(lines.includes("pm may no longer message dev."), lines.join(" | "));
  assert.ok(lines.includes("qa may now message dev."), lines.join(" | "));
  assert.ok(!lines.some((l) => /wiring changed/i.test(l)));
});

test("a wire granted by the recipient counts as a wire, so adding or removing a grant shows up", () => {
  const f = file();
  const d = draftOf(f);
  d.policies.communication.dev = { may_be_contacted_by: ["qa"] };
  assert.ok(summarizeDiff(d, f).includes("qa may now message dev."));
});

test("a removed seat takes its wires with it without a second sentence about each", () => {
  const f = file();
  const d = draftOf(f);
  delete d.agents.qa;
  delete d.policies.communication.qa;
  d.policies.communication.pm.may_contact = ["dev"];
  d.startup.activate = ["pm"];
  const lines = summarizeDiff(d, f);
  assert.deepEqual(lines, ["Removed seat qa."]);
});

test("what starts with the mission, and the gates, and the mission budget, are each named", () => {
  const f = file();
  const d = draftOf(f);
  d.startup.activate = ["pm", "qa"];
  d.policies.transitions["patch.merge"].requires = ["qa.pass", "pm.approve"];
  d.policies.transitions["release.accepted"] = { requires: ["qa.pass"] };
  d.budgets.mission.tokens = 1000000;
  const lines = summarizeDiff(d, f);
  assert.ok(lines.includes("qa now starts with the mission."), lines.join(" | "));
  assert.ok(lines.some((l) => l.startsWith("The gate patch.merge now requires") && l.includes("pm.approve")), lines.join(" | "));
  assert.ok(lines.some((l) => l.startsWith("Added the gate release.accepted")), lines.join(" | "));
  assert.ok(lines.includes("Mission budget: tokens changed from 2,000,000 to 1,000,000."), lines.join(" | "));
});

test("a setting no section knows about is still reported, by its path, so no change goes unmentioned", () => {
  const f = file();
  const d = draftOf(f);
  d.scheduling.concurrency.max_active_agents = 6;
  d.server.port = 7421;
  const lines = summarizeDiff(d, f);
  assert.ok(lines.some((l) => l.startsWith("scheduling.concurrency.max_active_agents changed from 4 to 6")), lines.join(" | "));
  assert.ok(lines.some((l) => l.startsWith("server.port")), lines.join(" | "));
});

test("a seat setting nobody special-cases is reported under the seat's name", () => {
  const f = file();
  const d = draftOf(f);
  d.agents.pm.session = { persistent: false };
  const c = diffMesh(d, f).find((x) => x.text.startsWith("pm: session.persistent"));
  assert.ok(c && c.seat === "pm", JSON.stringify(c));
});

test("a very large change under one key is counted instead of listed", () => {
  const f = file();
  const d = draftOf(f);
  d.bus = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 };
  assert.ok(summarizeDiff(d, f).includes("bus: 6 settings changed."));
});

test("changes come in the order the review reads: mesh, seats, wires, start, gates, budgets", () => {
  const f = file();
  const d = draftOf(f);
  d.budgets.mission.tokens = 5;
  d.agents.pm.role = "x";
  d.mesh.goal = "y";
  d.policies.communication.pm.may_contact = ["qa"];
  const areas = diffMesh(d, f).map((c) => c.area);
  assert.deepEqual(areas, ["goal", "seat", "wire", "budget"]);
});

test("canonical treats an empty block as absent and sorts plain lists, and nothing else", () => {
  assert.deepEqual(canonical({ a: {}, b: [], c: undefined, d: [3, 1, 2], e: [{ z: 1 }, { a: 1 }], f: 0, g: "" }), { d: [1, 2, 3], e: [{ z: 1 }, { a: 1 }], f: 0, g: "" });
});

/* ------------------------------------------------ what a save writes */

test("an untouched draft saves exactly the file: none of the padding leaks into it", () => {
  const f = file();
  assert.deepEqual(savePayload(draftOf(f), f), f);
});

test("a scaffold with no runtime stays without one: the padded stub default is not written", () => {
  const f: any = { version: 1, mesh: { id: "x", goal: "g" }, agents: { architect: { role: "architect" } } };
  const out = savePayload(draftOf(f), f);
  assert.deepEqual(out, f);
  assert.equal(out.mesh.runtime, undefined, "a missing runtime used to be written as 'stub'");
  assert.equal(out.server, undefined);
  assert.equal(out.budgets, undefined);
});

test("an edit survives and nothing else comes with it", () => {
  const f = file();
  const d = draftOf(f);
  d.agents.pm.role = "owner";
  d.scheduling.concurrency.max_active_agents = 6;
  const out = savePayload(d, f);
  assert.equal(out.agents.pm.role, "owner");
  assert.deepEqual(out.scheduling, { concurrency: { max_active_agents: 6 } }, "only the changed default is written, not its siblings");
  assert.equal(out.server, undefined);
  assert.deepEqual(out.agents.qa, f.agents.qa);
});

test("a new seat is written without the empty blocks the draft padded onto it", () => {
  const f = file();
  const d = draftOf(f);
  d.agents.scribe = { role: "writer", capabilities: [] };
  densure(d);
  const out = savePayload(d, f);
  assert.deepEqual(out.agents.scribe, { role: "writer", capabilities: [] });
});

test("a removed key stays removed, and a block the person emptied stays where the file had one", () => {
  const f = file();
  const d = draftOf(f);
  delete d.agents.qa.budget.tokens;
  d.agents.pm.capabilities = [];
  delete d.agents.dev;
  const out = savePayload(d, f);
  assert.equal(out.agents.dev, undefined);
  assert.deepEqual(out.agents.pm.capabilities, [], "the file had a list, so an empty list is what the person chose");
  assert.equal(out.agents.qa.budget?.tokens, undefined);
});

test("a key the person set to what the padding already said is not written", () => {
  const f = { version: 1, mesh: { id: "x", goal: "g" }, agents: { a: { role: "r" } } };
  const d = draftOf(f);
  d.server.port = 7420;
  assert.equal(savePayload(d, f).server, undefined);
});

test("with no file the draft is written as it is", () => {
  const d = draftOf({ version: 1, mesh: { id: "x", goal: "g" }, agents: { a: { role: "r" } } });
  assert.deepEqual(savePayload(d, null), d);
});

test("the payload is the same file as the diff describes: no differences from it means no change to write", () => {
  const f = file();
  const d = draftOf(f);
  d.agents.pm.role = "owner";
  d.policies.communication.qa.may_contact = [];
  const payload = savePayload(d, f);
  assert.equal(diffMesh(payload, f).length, diffMesh(d, f).length);
});
