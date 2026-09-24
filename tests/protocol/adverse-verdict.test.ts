import { test } from "node:test";
import assert from "node:assert/strict";
import { MESSAGE_TYPES, isAdverseVerdict, movesWork, movesWorkMessage } from "../../packages/protocol/src/index";

/**
 * The payload half of work movement, unit-level.
 *
 * `tests/protocol/work-moving-types.test.ts` pins the TYPE half and asserts
 * every message type has been deliberately classified. This file pins the two
 * types for which that table cannot be the whole answer, and the rule that
 * decides them.
 */

const VERDICT_TYPES = ["TEST_RESULT", "SECURITY_FINDING"] as const;

test("only the two verdict-bearing types can be adverse", () => {
  for (const type of MESSAGE_TYPES) {
    const adverse = isAdverseVerdict({ type, payload: { result: "FAILED" } });
    assert.equal(
      adverse,
      (VERDICT_TYPES as readonly string[]).includes(type),
      `${type}: a result field must only mean something on a type that reports one`,
    );
  }
});

for (const type of VERDICT_TYPES) {
  test(`${type}: PASSED reports, everything else hands work back`, () => {
    assert.equal(isAdverseVerdict({ type, payload: { result: "PASSED" } }), false);
    assert.equal(isAdverseVerdict({ type, payload: { result: "FAILED" } }), true);
    // Not an enumeration of outcomes: anything stated and not passing is
    // adverse, so a mesh that grows a third outcome is safe by default.
    assert.equal(isAdverseVerdict({ type, payload: { result: "ERROR" } }), true);
    assert.equal(isAdverseVerdict({ type, payload: { result: "TIMEOUT" } }), true);
  });

  test(`${type}: an absent or unusable result states no verdict`, () => {
    assert.equal(isAdverseVerdict({ type }), false);
    assert.equal(isAdverseVerdict({ type, payload: undefined }), false);
    assert.equal(isAdverseVerdict({ type, payload: null }), false);
    assert.equal(isAdverseVerdict({ type, payload: {} }), false);
    assert.equal(isAdverseVerdict({ type, payload: { note: "coverage is up" } }), false);
    // Non-strings are not outcomes. `false` is the tempting one: it reads like
    // a failure and is not one, and treating it as a verdict would let any
    // JSON shape that happens to carry a `result` key move work.
    assert.equal(isAdverseVerdict({ type, payload: { result: false } }), false);
    assert.equal(isAdverseVerdict({ type, payload: { result: 0 } }), false);
    assert.equal(isAdverseVerdict({ type, payload: { result: null } }), false);
    assert.equal(isAdverseVerdict({ type, payload: "FAILED" }), false);
  });
}

test("PASSED is matched exactly: case and whitespace are not verdicts", () => {
  // The one string that must not move work is the one both reducers already
  // treat as a sign-off, and they compare it exactly. Anything that is not
  // that string is adverse here, which is the safe direction on both paths.
  assert.equal(isAdverseVerdict({ type: "TEST_RESULT", payload: { result: "passed" } }), true);
  assert.equal(isAdverseVerdict({ type: "TEST_RESULT", payload: { result: "PASSED " } }), true);
});

test("movesWorkMessage is the type half OR the payload half", () => {
  for (const type of MESSAGE_TYPES) {
    // No payload: exactly the old type-only answer, so no mesh that never
    // reports a result changes behaviour.
    assert.equal(movesWorkMessage({ type }), movesWork(type), `${type} with no payload`);
    assert.equal(
      movesWorkMessage({ type, payload: { result: "FAILED" } }),
      movesWork(type) || (VERDICT_TYPES as readonly string[]).includes(type),
      `${type} with a failing result`,
    );
  }
});

test("a type that moves work is unaffected by what its payload claims", () => {
  for (const payload of [{ result: "PASSED" }, {}, { result: "FAILED" }]) {
    assert.equal(movesWorkMessage({ type: "HANDOFF", payload }), true);
    assert.equal(movesWorkMessage({ type: "BLOCK", payload }), true);
  }
});

test("an unknown type moves nothing, whatever it carries", () => {
  assert.equal(movesWorkMessage({ type: "NOT_A_TYPE", payload: { result: "FAILED" } }), false);
  assert.equal(isAdverseVerdict({ type: "", payload: { result: "FAILED" } }), false);
});
