import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addSeat,
  duplicateSeat,
  freeSeatId,
  gateHolders,
  hasWire,
  isPlaceholderRole,
  removeSeat,
  renameSeat,
  seatIdProblem,
  setWire,
  startsWithMission,
  toggleContact,
  toggleGrant,
  toggleStart,
  wiresOf,
} from "../../apps/mesh-dashboard/src/designer/edits";

/** A small mesh that names the seat `qa` in every place a seat can be named. */
function mesh(): any {
  return {
    mesh: { id: "m", goal: "g" },
    startup: { activate: ["pm", "qa"] },
    agents: {
      pm: { role: "product-manager" },
      qa: { role: "qa" },
      dev: { role: "developer" },
    },
    policies: {
      communication: {
        pm: { may_contact: ["qa", "dev"] },
        qa: { may_contact: ["pm"], may_be_contacted_by: ["dev"] },
        dev: { may_contact: [] },
      },
      transitions: { "patch.merge": { requires: ["qa.pass"] } },
      rules: [
        { id: "r1", when: { actor: "qa" }, deny: { capabilities: ["repository.write"] } },
        { id: "r2", when: { actor: "pm", to: "qa" }, deny: { message_types: ["INFORM"] } },
      ],
    },
    budgets: { mission: { tokens: 1 }, agent: { qa: 5000, pm: 9000 } },
    scheduling: { triage: { mode: "heuristic", rules: [{ agent: "qa" }, { agent: "dev" }] } },
  };
}

/* -------------------------------------------------------------- wires */

test("a wire exists when either side names the other: the sender's list or the recipient's grant", () => {
  const m = mesh();
  const wires = wiresOf(m);
  const has = (s: string, t: string) => wires.find((w) => w.src === s && w.tgt === t);
  assert.ok(has("pm", "qa")?.declared, "pm lists qa in may_contact");
  assert.equal(has("pm", "qa")?.granted, false);
  assert.ok(has("dev", "qa")?.granted, "qa lists dev in may_be_contacted_by, so dev may message qa");
  assert.equal(has("dev", "qa")?.declared, false);
  assert.equal(hasWire(m, "dev", "qa"), true);
  assert.equal(hasWire(m, "qa", "dev"), false, "a grant is one way");
});

test("a wire named by both routes is one wire, not two", () => {
  const m = mesh();
  m.policies.communication.dev.may_contact = ["qa"];
  const w = wiresOf(m).filter((x) => x.src === "dev" && x.tgt === "qa");
  assert.equal(w.length, 1);
  assert.deepEqual([w[0]!.declared, w[0]!.granted], [true, true]);
});

test("a wire to a seat that does not exist is not drawn", () => {
  const m = mesh();
  m.policies.communication.pm.may_contact.push("ghost");
  assert.equal(wiresOf(m).some((w) => w.tgt === "ghost"), false);
});

test("cutting a wire removes both routes, so a grant cannot keep a cut wire alive", () => {
  const m = mesh();
  m.policies.communication.dev.may_contact = ["qa"];
  assert.equal(setWire(m, "dev", "qa", false), true);
  assert.equal(hasWire(m, "dev", "qa"), false);
  assert.equal(m.policies.communication.qa.may_be_contacted_by, undefined, "an emptied grant list is removed, not left as []");
});

test("adding a wire writes the sender's list and is a no-op when the wire already exists by a grant", () => {
  const m = mesh();
  assert.equal(setWire(m, "qa", "dev", true), true);
  assert.deepEqual(m.policies.communication.qa.may_contact, ["pm", "dev"]);
  assert.equal(setWire(m, "dev", "qa", true), false, "already reachable through the grant");
  assert.deepEqual(m.policies.communication.dev.may_contact, []);
});

test("a seat cannot be wired to itself, and an unknown seat cannot be wired at all", () => {
  const m = mesh();
  assert.equal(setWire(m, "pm", "pm", true), false);
  assert.equal(setWire(m, "pm", "ghost", true), false);
  assert.equal(setWire(m, "ghost", "pm", true), false);
});

test("the inspector's chips flip one list each and report the new state", () => {
  const m = mesh();
  assert.equal(toggleContact(m, "pm", "qa"), false);
  assert.deepEqual(m.policies.communication.pm.may_contact, ["dev"]);
  assert.equal(toggleContact(m, "pm", "qa"), true);
  assert.equal(toggleGrant(m, "qa", "dev"), false);
  assert.equal(m.policies.communication.qa.may_be_contacted_by, undefined);
  assert.equal(toggleGrant(m, "qa", "pm"), true);
  assert.deepEqual(m.policies.communication.qa.may_be_contacted_by, ["pm"]);
});

/* -------------------------------------------------------------- remove */

test("removing a seat clears every reference to it that would stop the mesh booting", () => {
  const m = mesh();
  removeSeat(m, "qa");
  assert.equal(m.agents.qa, undefined);
  assert.equal(m.policies.communication.qa, undefined, "its own wiring entry");
  assert.deepEqual(m.policies.communication.pm.may_contact, ["dev"], "wires into it");
  assert.deepEqual(m.startup.activate, ["pm"]);
  assert.equal(m.budgets.agent.qa, undefined);
  assert.equal(m.budgets.agent.pm, 9000, "other seats keep their budgets");
});

test("removing a seat blanks the policy and triage rules that name it, and counts them, instead of deleting them", () => {
  const m = mesh();
  const left = removeSeat(m, "qa");
  assert.deepEqual(left, { rules: 1, triage: 1 });
  assert.equal(m.policies.rules[0].when.actor, "");
  assert.equal(m.policies.rules.length, 2, "the rule is still there for the person to fix");
  assert.equal(m.scheduling.triage.rules[0].agent, "");
  assert.equal(m.scheduling.triage.rules[1].agent, "dev");
});

test("removing a seat does not invent an empty may_be_contacted_by on the seats that never had one", () => {
  const m = mesh();
  removeSeat(m, "dev");
  assert.equal("may_be_contacted_by" in m.policies.communication.pm, false);
  assert.equal(m.policies.communication.qa.may_be_contacted_by, undefined, "the grant that named dev is gone with it");
});

test("removing a seat that is not there changes nothing", () => {
  const m = mesh();
  const before = JSON.stringify(m);
  assert.deepEqual(removeSeat(m, "ghost"), { rules: 0, triage: 0 });
  assert.equal(JSON.stringify(m), before);
});

/* -------------------------------------------------------------- rename */

test("renaming a seat rewrites every place it is named, so the saved mesh still boots", () => {
  const m = mesh();
  assert.equal(renameSeat(m, "qa", "quality"), true);
  assert.equal(m.agents.qa, undefined);
  assert.equal(m.agents.quality.role, "qa", "the role is not the id and stays");
  assert.deepEqual(Object.keys(m.agents), ["pm", "quality", "dev"], "it keeps its place in the list");
  assert.deepEqual(m.policies.communication.pm.may_contact, ["quality", "dev"]);
  assert.deepEqual(m.policies.communication.quality.may_contact, ["pm"], "its own entry moved with it");
  assert.equal(m.policies.communication.qa, undefined);
  assert.deepEqual(m.startup.activate, ["pm", "quality"]);
  assert.equal(m.budgets.agent.quality, 5000);
  assert.equal(m.budgets.agent.qa, undefined);
  assert.equal(m.policies.rules[0].when.actor, "quality", "a stale actor is fatal at config load");
  assert.equal(m.policies.rules[1].when.to, "quality");
  assert.equal(m.scheduling.triage.rules[0].agent, "quality");
});

test("renaming also rewrites the grants other seats hold on it", () => {
  const m = mesh();
  renameSeat(m, "dev", "builder");
  assert.deepEqual(m.policies.communication.qa.may_be_contacted_by, ["builder"]);
});

test("a rename to an empty, unchanged or taken id changes nothing and says so", () => {
  const m = mesh();
  const before = JSON.stringify(m);
  assert.equal(renameSeat(m, "qa", ""), false);
  assert.equal(renameSeat(m, "qa", "  "), false);
  assert.equal(renameSeat(m, "qa", "qa"), false);
  assert.equal(renameSeat(m, "qa", "pm"), false, "taken");
  assert.equal(renameSeat(m, "ghost", "x"), false);
  assert.equal(JSON.stringify(m), before);
});

test("a new id must be lowercase letters, digits and hyphens, but an existing odd id may be kept", () => {
  const m = mesh();
  m.agents["Odd Id"] = { role: "x" };
  assert.equal(seatIdProblem(m, "qa", "quality-2"), null);
  assert.equal(seatIdProblem(m, "qa", "Quality"), "shape");
  assert.equal(seatIdProblem(m, "qa", "has space"), "shape");
  assert.equal(seatIdProblem(m, "qa", "has.dot"), "shape", "a dot would break a gate token");
  assert.equal(seatIdProblem(m, "qa", "pm"), "taken");
  assert.equal(seatIdProblem(m, "qa", ""), "empty");
  assert.equal(seatIdProblem(m, "Odd Id", "Odd Id"), null, "unchanged is never a problem");
});

/* -------------------------------------------------------------- add / copy */

test("a new seat gets the first free id and a role that satisfies the schema", () => {
  const m = mesh();
  m.agents["seat-1"] = { role: "x" };
  const id = addSeat(m);
  assert.equal(id, "seat-2");
  assert.ok(m.agents[id].role.length > 0, "role is required, minLength 1");
  assert.deepEqual(m.agents[id].capabilities, []);
});

test("a seat added from a preset is a copy, not a shared reference", () => {
  const m = mesh();
  const preset = { role: "writer", capabilities: ["repository.read"] };
  const id = addSeat(m, preset);
  m.agents[id].capabilities.push("test.write");
  assert.deepEqual(preset.capabilities, ["repository.read"]);
});

test("a copy keeps what the seat may message and not who may reach the original", () => {
  const m = mesh();
  const id = duplicateSeat(m, "qa")!;
  assert.equal(id, "qa-1");
  assert.deepEqual(m.policies.communication[id].may_contact, ["pm"]);
  assert.equal("may_be_contacted_by" in m.policies.communication[id], false);
  m.agents[id].role = "changed";
  assert.equal(m.agents.qa.role, "qa", "deep copy");
  assert.equal(duplicateSeat(m, "ghost"), null);
});

test("free ids skip the taken ones", () => {
  const m = mesh();
  m.agents["qa-1"] = { role: "x" };
  m.agents["qa-2"] = { role: "x" };
  assert.equal(freeSeatId(m, "qa"), "qa-3");
});

test("a new seat's role is a placeholder until someone writes one, and only that role is called a placeholder", () => {
  const m = mesh();
  const id = addSeat(m);
  assert.equal(isPlaceholderRole(m.agents[id].role), true, m.agents[id].role);
  assert.equal(isPlaceholderRole("role-12"), true);
  assert.equal(isPlaceholderRole(" role-3 "), true, "the tidied and the untidied are the same role");
  for (const real of ["qa", "role", "role-lead", "senior-role-2", "", undefined, null]) assert.equal(isPlaceholderRole(real), false, String(real));
});

/* -------------------------------------------------------------- gates */

test("a gate requirement is satisfied by the seat whose id or role is the actor, not by one whose authority list spells the token", () => {
  const m = mesh();
  m.agents.dev.authority = ["implementation.approve"];
  const [h] = gateHolders(m, "dev.approve");
  assert.deepEqual([h!.actor, h!.seats], ["dev", ["dev"]], "matched by id");
  const [byRole] = gateHolders(m, "developer.approve");
  assert.deepEqual(byRole!.seats, ["dev"], "matched by role");
  const [literal] = gateHolders(m, "implementation.approve");
  assert.deepEqual(literal!.seats, [], "the authority token is not an actor, so nobody answers to it");
});

test("alternatives are listed one by one, and an actor nobody answers to has no seats", () => {
  const m = mesh();
  const hs = gateHolders(m, "qa.pass | ghost.approve");
  assert.deepEqual(hs.map((h) => [h.alternative, h.seats]), [["qa.pass", ["qa"]], ["ghost.approve", []]]);
  assert.deepEqual(gateHolders(m, ""), []);
});

test("an actor may itself contain a dot: only the last one separates the kind", () => {
  const m = mesh();
  m.agents["a.b"] = { role: "x" };
  assert.deepEqual(gateHolders(m, "a.b.approve")[0]!.seats, ["a.b"]);
});

/* -------------------------------------------------------------- start */

test("starting with the mission flips and reports the new state", () => {
  const m = mesh();
  assert.equal(startsWithMission(m, "qa"), true);
  assert.equal(toggleStart(m, "qa"), false);
  assert.deepEqual(m.startup.activate, ["pm"]);
  assert.equal(toggleStart(m, "dev"), true);
  assert.equal(startsWithMission(m, "dev"), true);
});
