import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_CONTRACTS, describeRequestShape } from "../../packages/protocol/src/contracts";

/**
 * `describeRequestShape` writes a contract's request as one line a seat can write a call from. It is derived from the schema, so
 * these tests start from schemas and from the catalogue's own, and never from a second list of what each contract takes.
 */

test("a required property is its bare name, an optional one carries ?, an array carries a list marker", () => {
  assert.equal(describeRequestShape({ properties: { a: { type: "string" }, b: { type: "array" }, c: {}, d: { type: "object" } }, required: ["a"] }), "{ a, b?: […], c?, d? }");
  assert.equal(describeRequestShape({ properties: { a: { type: "array" } }, required: ["a"] }), "{ a: […] }", "a required list is both");
  assert.equal(describeRequestShape({}), "{ }", "a schema that takes nothing");
  assert.equal(describeRequestShape({ properties: {} }), "{ }");
});

test("properties of which one of several must be given are written once, where the first stands", () => {
  const schema = { properties: { x: {}, y: {}, z: { type: "array" }, w: {} }, anyOf: [{ required: ["x"] }, { required: ["y"] }] };
  assert.equal(describeRequestShape(schema), "{ x | y, z?: […], w? }");
  // The first of them need not be first in the schema.
  assert.equal(describeRequestShape({ properties: { z: {}, x: {}, y: {} }, anyOf: [{ required: ["x"] }, { required: ["y"] }] }), "{ z?, x | y }");
  // A branch that asks for two things at once is not a choice of one: nothing to group.
  assert.equal(describeRequestShape({ properties: { x: {}, y: {} }, anyOf: [{ required: ["x", "y"] }] }), "{ x?, y? }");
  // A property that is also required is required, whatever anyOf says.
  assert.equal(describeRequestShape({ properties: { x: {}, y: {} }, required: ["x"], anyOf: [{ required: ["x"] }, { required: ["y"] }] }), "{ x, y? }");
  // A name the schema does not declare is not invented, and one name is not a choice.
  assert.doesNotMatch(describeRequestShape({ properties: { x: {} }, anyOf: [{ required: ["x"] }, { required: ["ghost"] }] }), /ghost|\|/);
});

test("every builtin contract: every property is named, every required one bare", () => {
  for (const c of BUILTIN_CONTRACTS) {
    const shape = describeRequestShape(c.request);
    const props = Object.keys((c.request.properties ?? {}) as Record<string, unknown>);
    const required = new Set((c.request.required ?? []) as string[]);
    for (const p of props) {
      assert.match(shape, new RegExp(`\\b${p}\\b`), `${c.name}: ${p} is named`);
      if (required.has(p)) assert.doesNotMatch(shape, new RegExp(`\\b${p}\\?`), `${c.name}: ${p} is required and is not marked optional`);
    }
    assert.match(shape, /^\{ .* \}$/, c.name);
  }
});

test("the shapes the thirteenth run's seats needed", () => {
  const shape = (name: string) => describeRequestShape(BUILTIN_CONTRACTS.find((c) => c.name === name)!.request);
  assert.equal(shape("work.request"), "{ ask, to?: […], subject? }");
  assert.equal(shape("review.artifact"), "{ artifact | artifactId, reviewers?: […], note? }");
  assert.equal(shape("decision.escalate"), "{ reason, detail?, conflictKey? }");
});
