import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { findContract, validateContractRequest, validateSchema } from "../../packages/protocol/src/index";
import type { Contract, MeshOp } from "../../packages/protocol/src/index";

/**
 * A validation error names the field it is about.
 *
 * With `allErrors` Ajv reports one `additionalProperties` issue per offending field, every one of
 * them the sentence "must NOT have additional properties"; the field is in `params.additionalProperty`,
 * which the formatter never read. A seat that sent `{ artifactId, artifact_type, artifact_name,
 * review_scope }` to `review.artifact` was told "(root) must NOT have additional properties" three
 * times, and nothing about which three fields the contract did not want. Seven of the ten refused
 * `mesh_call`s of the fifth cronlite run were that sentence, repeated, and the operator whose
 * `mesh.yaml` has a misspelt key reads the same one.
 *
 * One entry per object, listing every unknown field in it: shorter as well as plainer, and
 * `callContract` shows the first four.
 */

const nested = {
  name: "test.nested",
  version: 1,
  request: {
    type: "object",
    properties: { inner: { type: "object", properties: { keep: { type: "string" } }, additionalProperties: false }, ask: { type: "string" } },
    required: ["ask"],
    additionalProperties: false,
  },
} as unknown as Contract;

test("the unknown fields of a contract request are named, once, in one entry", () => {
  const review = findContract("review.artifact")!;
  const check = validateContractRequest(review, { artifactId: "art-1", artifact_type: "ArchitectureDocument", artifact_name: "x", review_scope: "all of it" });
  assert.equal(check.valid, false);
  assert.deepEqual(check.errors, [{ path: "(root)", message: "must NOT have additional properties: 'artifact_type', 'artifact_name', 'review_scope'" }]);
});

test("each object gets its own entry, at its own path, and other errors are left as they were", () => {
  const check = validateContractRequest(nested, { inner: { keep: "a", x: 1, y: 2 }, z: 3 });
  assert.deepEqual(
    check.errors.map((e) => `${e.path} ${e.message}`).sort(),
    [
      "(root) must NOT have additional properties: 'z'",
      "(root) must have required property 'ask'",
      "/inner must NOT have additional properties: 'x', 'y'",
    ],
  );
});

test("a request with no unknown field reports what it does, unchanged", () => {
  const check = validateContractRequest(nested, { ask: 5 });
  assert.deepEqual(check.errors, [{ path: "/ask", message: "must be string" }]);
  assert.equal(validateContractRequest(nested, { ask: "ok", inner: { keep: "a" } }).valid, true);
});

test("the schemas every message, event and config goes through name the field too", () => {
  const res = validateSchema("message", { bogus: 1, alsoBogus: 2 });
  const unknown = res.errors.filter((e) => /additional properties/.test(e.message));
  assert.deepEqual(unknown, [{ path: "(root)", message: "must NOT have additional properties: 'bogus', 'alsoBogus'" }]);
});

test("a refused mesh_call says which fields the contract did not want, and what it is missing", async () => {
  const m = await makeMesh({
    agents: [
      { id: "tl", role: "tech-lead", interests: [] },
      { id: "pm", role: "product-manager", interests: [] },
    ],
    mayContact: { tl: ["pm"], pm: ["tl"] },
    mode: "parked",
  });
  try {
    const turn = { turnId: "t-tl", agentId: "tl", reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] } as never;
    const res = await m.supervisor.executeOp("tl", { op: "call", contract: "work.request", request: { title: "Formally complete the mission", description: "all six are evidenced", to: ["pm"] } } as MeshOp, turn);
    assert.equal(res.ok, false);
    assert.match(res.reason ?? "", /request does not match contract work\.request: \(root\) must have required property 'ask'; \(root\) must NOT have additional properties: 'title', 'description'\. Expected: /);
  } finally {
    await m.cleanup();
  }
});
