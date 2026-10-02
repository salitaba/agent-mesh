import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { warnInertInboundContact, resolveConfig } from "../../packages/config/src/index";
import type { AgentDefinition } from "../../packages/protocol/src/index";

/**
 * `may_be_contacted_by` reads like an inbound allow-list and cannot deny anything.
 *
 * The engine decides contact with `communicationAllows`, a chain of `return true`
 * grants: the SENDER's `may_contact` admits just as well, and whichever matches
 * first wins. So a seat that writes `may_be_contacted_by: [pm]` still hears from
 * everyone whose own `may_contact` names it — silently, because the key validates
 * and the mesh boots.
 *
 * The warning fires only where the declaration is actively misleading: someone
 * outside the list gets through anyway. A list nobody bypasses is merely
 * redundant, and an empty list is the ordinary way to write "no extra grants".
 */

function seat(id: string, role = id): AgentDefinition {
  return { id, role, capabilities: [], authority: [] } as unknown as AgentDefinition;
}

type Comm = Record<string, { mayContact: string[]; mayBeContactedBy: string[] }>;

test("warns when a seat outside the inbound list can still open a thread", () => {
  const agents = [seat("pm"), seat("qa"), seat("backend")];
  const comm: Comm = {
    pm: { mayContact: ["qa"], mayBeContactedBy: [] },
    backend: { mayContact: ["qa"], mayBeContactedBy: [] },
    qa: { mayContact: [], mayBeContactedBy: ["pm"] },
  };
  const out = warnInertInboundContact(agents, comm);
  assert.equal(out.length, 1);
  assert.match(out[0]!, /policies\.communication\.qa\.may_be_contacted_by/);
  // Names who gets through, because that is the actionable half.
  assert.match(out[0]!, /backend may still open a thread/);
  // And says what it actually is, so the reader stops expecting a filter.
  assert.match(out[0]!, /additive grant, never a filter/);
});

test("silent when the inbound list is empty — that claims no restriction", () => {
  const agents = [seat("pm"), seat("qa")];
  const comm: Comm = {
    pm: { mayContact: ["qa"], mayBeContactedBy: [] },
    qa: { mayContact: [], mayBeContactedBy: [] },
  };
  assert.deepEqual(warnInertInboundContact(agents, comm), []);
});

test("silent when the list is redundant but nobody bypasses it", () => {
  const agents = [seat("pm"), seat("qa")];
  const comm: Comm = {
    pm: { mayContact: ["qa"], mayBeContactedBy: [] },
    qa: { mayContact: [], mayBeContactedBy: ["pm"] },
  };
  // pm is both granted inbound and already has the outbound edge. Nothing is
  // misleading here: the set of senders is exactly what was declared.
  assert.deepEqual(warnInertInboundContact(agents, comm), []);
});

test("a role token in the inbound list covers the seats holding that role", () => {
  const agents = [seat("dev1", "developer"), seat("qa")];
  const comm: Comm = {
    dev1: { mayContact: ["qa"], mayBeContactedBy: [] },
    qa: { mayContact: [], mayBeContactedBy: ["developer"] },
  };
  assert.deepEqual(warnInertInboundContact(agents, comm), []);
});

test("every shipped example is silent", () => {
  // This warning prints on every `curule run`. An example that trips one would
  // train operators to read past the whole class.
  // process.cwd(), not __dirname: tests run from compiled output under dist/.
  const root = path.resolve(process.cwd(), "examples");
  const examples = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.resolve(root, e.name, "mesh.yaml"))
    .filter((p) => fs.existsSync(p));
  assert.ok(examples.length > 0, "found no examples to check — the glob is wrong, not the meshes");
  for (const file of examples) {
    const resolved = resolveConfig(file);
    assert.equal(
      resolved.warnings.find((w) => w.includes("may_be_contacted_by")),
      undefined,
      `${file} declares an inbound list that restricts nothing`,
    );
  }
});

test("fires through resolveConfig, not only as a pure function", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-inbound-test-"));
  try {
    fs.writeFileSync(
      path.join(dir, "mesh.yaml"),
      `version: 1
mesh:
  id: m
  name: m
  goal: ship it
  acceptance_criteria:
    - id: ship
      description: the artifact exists
      mandatory: true
  workspace: { path: ./workspace }
  runtime: { default: stub }
startup: { activate: [pm] }
agents:
  pm:
    role: pm
    capabilities: [repository.read]
    authority: [requirements.approve]
  qa:
    role: qa
    capabilities: [repository.read]
policies:
  communication:
    pm:
      may_contact: [qa]
      may_be_contacted_by: []
    qa:
      may_contact: []
      may_be_contacted_by: [nobody-real]
`.replace("nobody-real", "pm"),
      "utf8",
    );
    // pm reaches qa via may_contact and is also the whole declared inbound list,
    // so this config is the silent shape; flip it by adding a bypassing seat.
    const resolved = resolveConfig(path.join(dir, "mesh.yaml"));
    assert.equal(resolved.warnings.find((w) => w.includes("may_be_contacted_by")), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
