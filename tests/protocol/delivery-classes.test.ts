import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  DELIVERY_CLASSES,
  RESERVED_PAYLOAD_KEYS,
  sanitizeAgentMessageInput,
  validateMessage,
  validateMeshConfig,
  type MessageControl,
} from "../../packages/protocol/src/index";
import { parseMeshSource, resolveDeliveryClasses, writeDefaultMeshYaml } from "../../packages/config/src/index";

/**
 * Delivery classes (Move 2). The mesh is asynchronous in its TRANSPORT and
 * synchronous in its ATTENTION: a send costs the sender nothing and costs each
 * recipient a full model turn. The class on the envelope separates delivery
 * (always happens) from the wake (now priced), and this file covers the two
 * halves that have to hold before any of that is safe -- that the regime is
 * opt-in, and that a sender cannot write its own class.
 */

function messageFixture(control?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "msg-1",
    type: "INFORM",
    timestamp: new Date().toISOString(),
    goalId: "goal-1",
    from: "architect",
    to: ["dev"],
    threadId: "thr-1",
    artifactRefs: [],
    payload: { note: "hello" },
    priority: "NORMAL",
    ...(control ? { control } : {}),
  };
}

test("no delivery block is no regime: an upgraded mesh must not acquire one", () => {
  assert.equal(resolveDeliveryClasses(undefined), undefined);
  assert.equal(resolveDeliveryClasses({}), undefined);
  // The numbers are inert without the switch. Writing a window is not a way
  // to turn the regime on by accident -- if this resolved, a mesh that only
  // wanted to tune a value would silently stop waking its agents.
  assert.equal(resolveDeliveryClasses({ coalesce_ms: 500, interrupt_cost_tokens: 10 }), undefined);
  assert.equal(resolveDeliveryClasses({ classes: false, coalesce_ms: 500 }), undefined);
});

test("classes: true takes the shipped tariff; explicit numbers win", () => {
  assert.deepEqual(resolveDeliveryClasses({ classes: true }), { coalesceMs: 60_000, interruptCostTokens: 2000 });
  assert.deepEqual(resolveDeliveryClasses({ classes: true, coalesce_ms: 5000, interrupt_cost_tokens: 250 }), {
    coalesceMs: 5000,
    interruptCostTokens: 250,
  });
  // A zero window would make `deliver` an `interrupt` by another name (gather,
  // then release on the very next tick), so zero falls back to the default.
  assert.equal(resolveDeliveryClasses({ classes: true, coalesce_ms: 0 })!.coalesceMs, 60_000);
  // A zero tariff is a REAL answer, not a missing one: class the mail, charge
  // nothing. An operator who wants the routing without the bill must get it.
  assert.equal(resolveDeliveryClasses({ classes: true, interrupt_cost_tokens: 0 })!.interruptCostTokens, 0);
});

test("mesh init scaffolds the regime, and the scaffold validates", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-delivery-init-"));
  try {
    const written = writeDefaultMeshYaml(dir, "delivery-demo");
    const raw = parseMeshSource(fs.readFileSync(written, "utf8"));
    // The published contract has to know the block, or `mesh init` writes a
    // config its own schema rejects.
    const v = validateMeshConfig(raw);
    assert.equal(v.valid, true, JSON.stringify(v.errors));
    assert.deepEqual(resolveDeliveryClasses(raw.bus?.delivery), { coalesceMs: 60_000, interruptCostTokens: 2000 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the mesh schema closes the delivery block", () => {
  const base = {
    version: 1,
    mesh: { id: "m", goal: "g" },
    agents: { dev: { role: "developer" } },
  };
  assert.equal(validateMeshConfig({ ...base, bus: { delivery: { classes: true } } }).valid, true);
  assert.equal(
    validateMeshConfig({ ...base, bus: { delivery: { classes: true, coalese_ms: 500 } } }).valid,
    false,
    "a typo'd key must fail loudly, not be silently ignored into the default tariff",
  );
  assert.equal(validateMeshConfig({ ...base, bus: { delivery: { interrupt_cost_tokens: -1 } } }).valid, false);
});

test("the class is runtime-owned: agent input cannot carry one", () => {
  const cleaned = sanitizeAgentMessageInput({
    payload: { delivery: "accrue", mode: "broadcast", note: "kept" },
    control: { delivery: "accrue" } as MessageControl,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  assert.equal(cleaned.control, undefined, "control is stripped wholesale");
  // The payload copy matters even though nothing reads it: a seat that could
  // leave `delivery: "accrue"` there has written the one class nobody is
  // charged for, waiting for any reader that ever reaches into payload.
  assert.equal("delivery" in (cleaned.payload as Record<string, unknown>), false);
  assert.equal((cleaned.payload as Record<string, unknown>).note, "kept");
});

test("RESERVED_PAYLOAD_KEYS still mirrors every control field", () => {
  // Typed as Required<MessageControl>, so ADDING a control field without
  // adding it here fails to compile, and adding it here without reserving it
  // fails below. `mode` is the one that had already drifted out of the mirror.
  const everyControlField: Required<MessageControl> = {
    cacheServed: true,
    contract: "c",
    contractVersion: 1,
    mode: "service",
    delivery: "accrue",
  };
  for (const key of Object.keys(everyControlField)) {
    assert.ok(RESERVED_PAYLOAD_KEYS.includes(key), `${key} is runtime-owned but not reserved in payload`);
  }
});

test("the wire schema accepts the three classes and nothing else", () => {
  for (const cls of DELIVERY_CLASSES) {
    const r = validateMessage(messageFixture({ delivery: cls }));
    assert.equal(r.valid, true, `${cls}: ${JSON.stringify(r.errors)}`);
  }
  assert.equal(validateMessage(messageFixture()).valid, true, "no class at all is the default and stays legal");
  // Closed enum and closed property set: a forged control field fails
  // validation instead of riding along ignored.
  assert.equal(validateMessage(messageFixture({ delivery: "urgent" })).valid, false);
  assert.equal(validateMessage(messageFixture({ delivery: true })).valid, false);
  assert.equal(validateMessage(messageFixture({ deliveryClass: "accrue" })).valid, false);
});
