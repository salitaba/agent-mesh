import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfig, warnUnacceptableCriteria, MANUAL_LOAD_WARN_ABOVE } from "../../packages/config/src/index";
import { AUTO_EVIDENCED_CRITERIA, DEFAULT_CRITERIA } from "../../packages/protocol/src/index";
import type { AgentDefinition } from "../../packages/protocol/src/index";

/**
 * A mesh whose acceptance criteria cannot close is a mesh that cannot finish,
 * and nothing said so until the bill arrived.
 *
 * `AUTO_EVIDENCED_CRITERIA` is the complete set of ids the runtime closes on its
 * own. Every other mandatory criterion closes one way only: a seat issuing
 * `approve subject:"criterion:<id>"`, gated on `requirements.accept` /
 * `requirements.approve`. One live mission declared seventeen mandatory criteria,
 * none of them auto-evidenced, and ran for hours with every completion gate shut
 * — the only visible symptom was spend.
 *
 * Two of the shipped examples were in the unsatisfiable state when this check was
 * written (`greenfield` via `spec-understood`, `spring-boot` via the inherited
 * default), which is the argument for checking it at load rather than in review.
 */

function resolveRaw(text: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-criteria-test-"));
  fs.writeFileSync(path.join(dir, "mesh.yaml"), text, "utf8");
  try {
    return resolveConfig(path.join(dir, "mesh.yaml"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const seat = (id: string, authority: string[]): AgentDefinition =>
  ({ id, role: id, capabilities: ["repository.read"], authority, interests: [] }) as unknown as AgentDefinition;

const criteriaWarning = (warnings: string[]): string | undefined =>
  warnings.find((w) => w.includes("mandatory criterion") || w.includes("mandatory criteria"));

const mesh = (body: string): string => `version: 1
mesh:
  id: criteriatest
  goal: |
    Test.
  workspace: { path: ./workspace }
  runtime: { default: stub }
${body}
startup:
  activate: [pm]
`;

test("a mandatory criterion nobody can accept is named as unsatisfiable, with both tokens", () => {
  const out = warnUnacceptableCriteria(
    [seat("dev", []), seat("qa", ["quality.pass"])],
    [{ id: "tests-green", description: "tests pass", mandatory: true }],
  );
  assert.equal(out.length, 1);
  assert.match(out[0], /can never be satisfied \(tests-green\)/);
  assert.match(out[0], /not auto-evidenced/, "the reason, not just the symptom");
  assert.match(out[0], /requirements\.accept/);
  assert.match(out[0], /requirements\.approve/, "both tokens, because either one fixes it");
  assert.match(out[0], /cannot reach completion/);
});

const manyCriteria = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `c${i}`, description: `c${i}`, mandatory: true }));

test("one holder carrying a real manual load is flagged, and the mission's fate is named", () => {
  // Reachable, so not phrased as a deadlock — but this is the measured failure:
  // the sole holder owed seventeen accept ops and issued a verdict zero times
  // out of three.
  const out = warnUnacceptableCriteria([seat("pm", ["requirements.approve"]), seat("dev", [])], manyCriteria(17));
  assert.equal(out.length, 1);
  assert.match(out[0], /close only by explicit op/);
  assert.ok(!/can never be satisfied/.test(out[0]), "it CAN be satisfied — the warning must not overclaim");
  assert.match(out[0], /'pm' is the only seat/);
  assert.match(out[0], /check its role prompt/, "the remedy is a prompt, not a config key");
});

test("one holder owing a handful of ops is silent — that is ordinary design", () => {
  // The first version of this check had no threshold and fired on every two-seat
  // mesh in the suite, including four fixtures whose whole assertion was
  // "validates clean". A warning that fires on correct configs is one nobody
  // reads on the config that is actually broken.
  const out = warnUnacceptableCriteria(
    [seat("pm", ["requirements.approve"]), seat("dev", [])],
    [{ id: "tests-green", description: "tests pass", mandatory: true }],
  );
  assert.deepEqual(out, [], "one criterion and one owner is a correct small mesh");
  assert.deepEqual(
    warnUnacceptableCriteria([seat("pm", ["requirements.approve"])], manyCriteria(MANUAL_LOAD_WARN_ABOVE)),
    [],
    "the threshold is exclusive: exactly at it is still quiet",
  );
  assert.equal(
    warnUnacceptableCriteria([seat("pm", ["requirements.approve"])], manyCriteria(MANUAL_LOAD_WARN_ABOVE + 1)).length,
    1,
    "and one past it speaks",
  );
});

test("no holder is flagged however small the load — that tier has no threshold", () => {
  // The deadlock does not get quieter for being small: one unsatisfiable
  // criterion is still a mission that cannot finish.
  const out = warnUnacceptableCriteria([seat("dev", [])], [{ id: "tests-green", description: "tests pass", mandatory: true }]);
  assert.equal(out.length, 1);
  assert.match(out[0], /can never be satisfied/);
});

test("two holders are silent — redundancy is not a defect", () => {
  const out = warnUnacceptableCriteria(
    [seat("pm", ["requirements.approve"]), seat("lead", ["requirements.accept"])],
    manyCriteria(17),
  );
  assert.deepEqual(out, [], "a second holder is the actual fix, so it must silence the warning");
});

test("the `*` superuser and `requirements.*` both count as holders", () => {
  assert.match(
    warnUnacceptableCriteria([seat("boss", ["*"]), seat("dev", [])], manyCriteria(17))[0] ?? "",
    /'boss' is the only seat/,
    "`*` holds everything, so it is a holder",
  );
  assert.match(
    warnUnacceptableCriteria([seat("boss", ["requirements.*"]), seat("dev", [])], manyCriteria(17))[0] ?? "",
    /'boss' is the only seat/,
  );
  assert.deepEqual(
    warnUnacceptableCriteria([seat("boss", ["*"]), seat("dev", [])], manyCriteria(1)),
    [],
    "and a holder is a holder for the hard tier too — `*` must not read as absent",
  );
});

test("an all-auto-evidenced criteria list is silent", () => {
  const out = warnUnacceptableCriteria(
    [seat("dev", [])],
    AUTO_EVIDENCED_CRITERIA.map((id) => ({ id, description: id, mandatory: true })),
  );
  assert.deepEqual(out, [], "the runtime closes every one of these itself; no seat is needed");
});

test("a non-mandatory criterion is ignored, but an OMITTED `mandatory` is not", () => {
  // `mandatory: c.mandatory ?? true` in the resolver: omitting the key means
  // mandatory. Reading it as falsy made this check miss `examples/greenfield`,
  // whose criteria all omit it — the check was silent on the one shipped mesh it
  // was written to catch.
  assert.deepEqual(
    warnUnacceptableCriteria([seat("dev", [])], [{ id: "nice-to-have", description: "optional", mandatory: false }]),
    [],
    "an explicitly optional criterion blocks nothing",
  );
  const omitted = warnUnacceptableCriteria(
    [seat("dev", [])],
    [{ id: "spec-understood", description: "a spec exists" } as { id: string; description: string }],
  );
  assert.equal(omitted.length, 1, "an omitted `mandatory` must be read the way the resolver reads it");
  assert.match(omitted[0], /spec-understood/);
});

test("a mesh declaring no criteria is checked against the built-in defaults, and says so", () => {
  // The common case, not an edge one: `DEFAULT_CRITERIA` carries
  // `requirements-documented`, which is mandatory and which nothing in the
  // runtime auto-evidences.
  assert.ok(
    DEFAULT_CRITERIA.some((c) => c.id === "requirements-documented" && c.mandatory),
    "fixture check: the default set still carries the mandatory criterion this test is about",
  );
  assert.ok(
    !AUTO_EVIDENCED_CRITERIA.includes("requirements-documented"),
    "fixture check: and the runtime still does not close it — if this fails, delete this warning's second tier",
  );

  const out = warnUnacceptableCriteria([seat("dev", []), seat("qa", ["quality.pass"])], null);
  assert.equal(out.length, 1, "returning [] for a null list would hide the most common form of this bug");
  assert.match(out[0], /requirements-documented/);
  assert.match(out[0], /inherited from the built-in defaults/, "the operator did not write this id and must be told where it came from");
});

test("criteria the mesh has not generated yet are not second-guessed", () => {
  const out = warnUnacceptableCriteria([seat("dev", [])], null, true);
  assert.deepEqual(out, [], "with generation on there is no list at load time, so there is nothing to name");
});

test("a long list is elided rather than dumped, and the count stays exact", () => {
  const out = warnUnacceptableCriteria([seat("dev", [])], manyCriteria(17));
  assert.match(out[0], /^17 mandatory criteria/, "the count is the headline and must not be elided");
  assert.match(out[0], /\+11 more/, "6 shown, 11 elided");
  assert.ok(!out[0].includes("c16"), "a warning nobody reads to the end names nothing");
});

test("the warning reaches resolveConfig's warnings, not just the helper", () => {
  const resolved = resolveRaw(
    mesh(`  acceptance_criteria:
    - { id: ship-it, description: "the thing ships" }
agents:
  pm:
    role: pm
    capabilities: [repository.read]
    authority: []`),
  );
  const w = criteriaWarning(resolved.warnings);
  assert.ok(w, "the helper is only useful if it is wired into config load");
  assert.match(w, /ship-it/);
  assert.match(w, /can never be satisfied/);
});

test("granting the token to the pm silences it at the config level too", () => {
  const resolved = resolveRaw(
    mesh(`  acceptance_criteria:
    - { id: ship-it, description: "the thing ships" }
agents:
  pm:
    role: pm
    capabilities: [repository.read]
    authority: [requirements.accept]
  lead:
    role: tech-lead
    capabilities: [repository.read]
    authority: [requirements.approve]`),
  );
  assert.equal(criteriaWarning(resolved.warnings), undefined, "two holders, nothing to say");
});
