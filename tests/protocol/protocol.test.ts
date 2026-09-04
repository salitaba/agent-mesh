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
  const fs = require("fs");
  if (!fs.existsSync("schemas/event.schema.json")) return;
  const { SCHEMAS } = require("../../packages/protocol/src/index");
  const onDisk = JSON.parse(fs.readFileSync("schemas/event.schema.json", "utf8"));
  assert.deepEqual(onDisk.properties.type.enum, SCHEMAS.event.properties.type.enum);
});
