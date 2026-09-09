import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateMessage,
  validateEvent,
  digestOf,
  parseArtifactUri,
  artifactUri,
  canonicalJson,
  EVENT_TYPES,
  MESSAGE_TYPES,
  LIFECYCLE_TRANSITIONS,
  MACHINE_TRANSITIONS,
  newMessageId,
  newEventId,
  FixedClock,
  PROTOCOL_VERSION,
  aliasTextOp,
  type MeshMessage,
} from "../../packages/protocol/src/index";
import { loadMeshFile, resolveConfig, validateInterestExpressions, interestMatches } from "../../packages/config/src/index";

function validMessage(over: Partial<MeshMessage> = {}): MeshMessage {
  return {
    id: newMessageId(),
    protocolVersion: PROTOCOL_VERSION,
    type: "REQUEST_REVIEW",
    timestamp: new Date().toISOString(),
    goalId: "goal-1",
    from: "developer",
    to: ["architect"],
    threadId: "thread-17",
    artifactRefs: [{ uri: "artifact://design/payment-api/2" }],
    payload: { question: "Is this idempotency design acceptable?" },
    priority: "NORMAL",
    ...over,
  };
}

test("protocol: valid message passes envelope schema", () => {
  const r = validateMessage(validMessage());
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

test("protocol: message with non-canonical type is rejected", () => {
  const r = validateMessage(validMessage({ type: "CHAT_FREELY" as MeshMessage["type"] }));
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.path === "/type"));
});

test("protocol: invented REPLY type aliases to INFORM (resolves, not re-asks)", () => {
  // Regression: reply used to alias to REQUEST, minting a NEW pending ask on
  // a NEW thread — an answered question became two open ones and escalated.
  const aliased = aliasTextOp({ op: "send", type: "REPLY", to: ["pm"], threadId: "t-1", payload: { answer: "done" } });
  assert.equal(aliased?.type, "INFORM");
  const lower = aliasTextOp({ op: "send", type: "reply", to: ["pm"], threadId: "t-1", payload: {} });
  assert.equal(lower?.type, "INFORM");
});

test("protocol: message without thread/goal ids is rejected", () => {
  const m = { ...validMessage(), goalId: undefined } as unknown as MeshMessage;
  const r = validateMessage(m);
  assert.equal(r.valid, false);
});

test("protocol: canonical event catalog is unique and lower.dotted", () => {
  assert.equal(new Set(EVENT_TYPES).size, EVENT_TYPES.length);
  for (const t of EVENT_TYPES) {
    assert.match(t, /^[a-z_]+(\.[a-z_]+)+$/);
  }
  for (const required of ["goal.created", "message.sent", "artifact.transition", "budget.reserved", "agent.failed", "goal.completed", "goal.escalated"]) {
    assert.ok(EVENT_TYPES.includes(required as never), `catalog missing ${required}`);
  }
});

test("protocol: event types not in the catalog are rejected", () => {
  const r = validateEvent({ id: newEventId(), type: "agent.teleports", timestamp: new Date().toISOString(), payload: {} });
  assert.equal(r.valid, false);
});

test("protocol: message types stay deliberately small", () => {
  assert.ok(MESSAGE_TYPES.length <= 30);
  assert.ok(MESSAGE_TYPES.includes("MISSION") && MESSAGE_TYPES.includes("DONE"));
});

test("protocol: artifact digests are deterministic and uri round-trips", () => {
  assert.equal(digestOf("hello"), digestOf("hello"));
  assert.notEqual(digestOf("hello"), digestOf("hellp"));
  const uri = artifactUri("CodePatch", "my patch/1", 3);
  const parsed = parseArtifactUri(uri);
  assert.ok(parsed);
  assert.equal(parsed.kind, "CodePatch");
  assert.equal(decodeURIComponent(parsed.name), "my patch/1");
  assert.equal(parsed.version, 3);
});

test("protocol: ids are prefix-scoped and unique", () => {
  const ids = Array.from({ length: 500 }, () => newEventId());
  assert.equal(new Set(ids).size, 500);
  for (const id of ids) assert.match(id, /^evt-[0-9A-Z]{10}[0-9a-f]{10}$/);
  assert.match(newMessageId(), /^msg-/);
});

test("protocol: canonical json is key-order independent", () => {
  assert.equal(canonicalJson({ a: 1, b: { c: 2, d: 3 } }), canonicalJson({ b: { d: 3, c: 2 }, a: 1 }));
});

test("protocol: lifecycle machine has no orphan states", () => {
  const states = Object.keys(LIFECYCLE_TRANSITIONS);
  for (const [, targets] of Object.entries(LIFECYCLE_TRANSITIONS)) {
    for (const t of targets) {
      assert.ok(states.includes(t), `transition target ${t} is not a declared state`);
    }
  }
  for (const s of states) {
    if (s === "COMPLETED" || s === "FAILED") continue;
    assert.ok(s === "STARTING" || LIFECYCLE_TRANSITIONS[s as keyof typeof LIFECYCLE_TRANSITIONS].includes("FAILED" as never), `${s} must be able to fail`);
  }
});

test("protocol: artifact state machines terminate", () => {
  for (const kind of ["code", "release", "document"] as const) {
    const table = MACHINE_TRANSITIONS[kind];
    const terminal = Object.keys(table).filter((s) => (table[s as keyof typeof table] ?? []).length === 0);
    assert.ok(terminal.length > 0, `${kind} machine has no terminal state`);
  }
});

test("config: valid mesh.yaml resolves with agents, gates, budgets", () => {
  const doc = loadMeshFile("examples/payment-api/mesh.yaml");
  const resolved = resolveConfig("examples/payment-api/mesh.yaml");
  assert.equal(doc.version, 1);
  assert.equal(resolved.meshId, "payment-api-team");
  assert.equal(resolved.agentOrder.length, 7);
  assert.deepEqual(resolved.transitionGates["release.accepted"], ["qa.pass", "security.pass"]);
  assert.equal(resolved.budgets.mission.tokens, 2000000);
  assert.equal(resolved.agents.explorer.mode, "service");
  assert.equal(resolved.agents.architect.sessionPolicy.persistent, true);
});

test("config: unknown agent references in startup/may_contact are errors", () => {
  const yaml = `version: 1
mesh: { id: x, goal: g }
startup: { activate: [ghost] }
agents:
  dev:
    role: developer
policies:
  communication:
    dev: { may_contact: [ghost] }
`;
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-cfg-"));
  const file = path.join(dir, "mesh.yaml");
  fs.writeFileSync(file, yaml);
  assert.throws(() => resolveConfig(file), /ghost/);
});

test("config: invalid interest expressions are flagged against the catalog", () => {
  const errors = validateInterestExpressions([
    {
      id: "a",
      role: "r",
      mode: "peer",
      runtime: "stub",
      prompt: {},
      capabilities: [],
      authority: [],
      communicationPolicy: { mayContact: [], mayBeContactedBy: [] },
      interests: ["NotCanonical.Foo", "goal.*"],
      sessionPolicy: { persistent: true },
      delegationPolicy: { allowDelegation: false, maxDepth: 0, maxWorkers: 0 },
      budget: {},
    },
  ]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /NotCanonical/);
});

test("interest matching: wildcard prefixes and exact names", () => {
  assert.equal(interestMatches("architecture.*", "architecture.approved"), true);
  assert.equal(interestMatches("architecture.*", "architecture" as never), false);
  assert.equal(interestMatches("patch.ready", "patch.ready"), true);
  assert.equal(interestMatches("patch.ready", "patch.merged"), false);
  assert.equal(interestMatches("goal.*", "goal.escalated"), true);
});

test("clock: FixedClock is deterministic", () => {
  const c = new FixedClock("2026-08-28T12:30:00.000Z");
  assert.equal(c.iso(), "2026-08-28T12:30:00.000Z");
  c.advance(1500);
  assert.equal(c.iso(), "2026-08-28T12:30:01.500Z");
});

test("schemas directory files match the compiled protocol schemas", () => {
  // The protocol is published twice: `schemas/*.json` is the documented,
  // vendor-independent contract, and `packages/protocol/src/schemas.ts` is
  // what actually validates at runtime. They must be the same document.
  //
  // This used to compare exactly one enum on exactly one of the four schemas,
  // so every other field could drift silently — and did: a message field
  // added to the on-disk contract was rejected by the runtime validator,
  // because the runtime never saw it. A partial guard on a duplicated
  // source of truth is a guard that reports success while the two copies
  // disagree.
  const fs = require("fs");
  const { SCHEMAS } = require("../../packages/protocol/src/index");
  const names = Object.keys(SCHEMAS as Record<string, unknown>);
  assert.deepEqual(names.sort(), ["artifact", "event", "mesh", "message"], "every published schema is covered");
  for (const [name, compiled] of Object.entries(SCHEMAS as Record<string, unknown>)) {
    const file = `schemas/${name}.schema.json`;
    assert.ok(fs.existsSync(file), `${file} must exist: it is the documented contract for the ${name} schema`);
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(
      onDisk,
      JSON.parse(JSON.stringify(compiled)),
      `${file} has drifted from the compiled schema — the documented contract and the enforced one must be identical`,
    );
  }
});

test("config: an authority the runtime can never satisfy is rejected at load", () => {
  // `architecture.aprove` used to load, validate and boot cleanly, then DENY
  // on every check — the agent silently never held the power its config
  // granted, and the mission just failed to converge with no error anywhere.
  const yaml = `version: 1
mesh: { id: x, goal: g }
startup: { activate: [architect] }
agents:
  architect:
    role: architect
    authority: [architecture.aprove]
policies:
  communication:
    architect: { may_contact: [] }
`;
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-cfg-auth-"));
  const file = path.join(dir, "mesh.yaml");
  fs.writeFileSync(file, yaml);
  assert.throws(() => resolveConfig(file), /unknown authority 'architecture\.aprove'/);
});

test("config: a transition gate no agent can satisfy is reported as a warning", () => {
  // A gate naming an absent actor is unsatisfiable: every artifact needing it
  // deadlocks forever, and nothing reported why. Warned rather than fatal —
  // a larger mesh may add the role later, and gates are legitimately used to
  // express "not yet satisfiable" states.
  const yaml = `version: 1
mesh: { id: x, goal: g }
startup: { activate: [dev] }
agents:
  dev:
    role: developer
policies:
  communication:
    dev: { may_contact: [] }
  transitions:
    patch.merge: { requires: [tech-lead.approve] }
`;
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-cfg-gate-"));
  const file = path.join(dir, "mesh.yaml");
  fs.writeFileSync(file, yaml);
  const cfg = resolveConfig(file);
  assert.ok(
    cfg.warnings.some((w: string) => /no agent or role 'tech-lead' exists/.test(w)),
    `unsatisfiable gate must be surfaced, got ${JSON.stringify(cfg.warnings)}`,
  );
});

test("config: valid authority tokens and satisfiable gates load cleanly", () => {
  const yaml = `version: 1
mesh: { id: x, goal: g }
startup: { activate: [lead] }
agents:
  lead:
    role: tech-lead
    authority: [implementation.approve, architecture.*]
    capabilities: [git.merge]
  qa:
    role: qa
    authority: [quality.block]
policies:
  communication:
    lead: { may_contact: [qa] }
    qa: { may_contact: [lead] }
  transitions:
    patch.merge: { requires: [tech-lead.approve, qa.pass] }
`;
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-cfg-ok-"));
  const file = path.join(dir, "mesh.yaml");
  fs.writeFileSync(file, yaml);
  const cfg = resolveConfig(file);
  assert.deepEqual(cfg.transitionGates["patch.merge"], ["tech-lead.approve", "qa.pass"]);
});
