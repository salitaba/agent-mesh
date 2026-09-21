import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfig } from "../../packages/config/src/index";

/**
 * `wake` is the one per-seat policy block that does NOT inherit from
 * `mesh.defaults`, and it is easy to "fix" that by symmetry with
 * `hard_actions` next door. Doing so would be a silent no-op in the worst
 * direction: the default would look like it turned deferral on mesh-wide while
 * the resolver read only each seat's own copy, so every seat that never
 * declared the block would keep waking. Hence the two claims pinned here —
 * absence stays absent, and the mesh-wide key is refused rather than ignored.
 */

function meshWith(defaults: string, agent = ""): string {
  const yaml = `version: 1
mesh:
  id: waketest
  goal: |
    Test wake policy.
${defaults}agents:
  dev:
    role: developer
    runtime: stub
${agent}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-wake-"));
  const file = path.join(dir, "mesh.yaml");
  fs.writeFileSync(file, yaml);
  return file;
}

const load = (defaults: string, agent = "") => resolveConfig(meshWith(defaults, agent)).agents.dev!;

test("wake: absent everywhere leaves the block undefined rather than materialising a default", () => {
  // Not `{ deferNonObliging: false }`. The distinction is load-bearing: the
  // scheduler's `defersMail` reads `=== true`, and every fixture that
  // deep-equals a resolved definition must not be handed a field the operator
  // never wrote.
  assert.equal(load("").wake, undefined);
});

test("wake: a seat that declares deferral resolves it on", () => {
  assert.deepEqual(load("", "    wake: { defer_non_obliging: true }\n").wake, { deferNonObliging: true });
});

test("wake: an empty block is a declaration, and defaults the one key to off", () => {
  // Unlike the absent case above: the operator wrote the block, so it resolves
  // — and its one setting is off, which is the waking behaviour.
  assert.deepEqual(load("", "    wake: {}\n").wake, { deferNonObliging: false });
});

test("wake: an explicit false is kept as false, not treated as absent", () => {
  assert.deepEqual(load("", "    wake: { defer_non_obliging: false }\n").wake, { deferNonObliging: false });
});

test("wake: mesh.defaults.wake is refused, because nothing would read it", () => {
  // The schema's `additionalProperties: false` is what makes this a load error
  // instead of a silent no-op. If a future change adds the key here by
  // symmetry with hard_actions, this test is the thing that objects.
  assert.throws(
    () => load("  defaults:\n    wake: { defer_non_obliging: true }\n"),
    /mesh\/defaults|defaults.*additional propert/i,
    "a default here looks mesh-wide but only the per-agent copy is ever read",
  );
});

test("wake: a typo inside the block is a load error, not a silent no-op", () => {
  assert.throws(
    () => load("", "    wake: { defer_non_obligingg: true }\n"),
    /additional propert/i,
    "a misspelled key that loaded cleanly would leave the seat waking for everything",
  );
});
