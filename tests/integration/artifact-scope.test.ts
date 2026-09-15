import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, evidenceContent } from "../helpers";
import { artifactScope } from "../../packages/protocol/src/catalog";

/**
 * Scope on the write path.
 *
 * `tests/core/context-selection.test.ts` proves the predicate. That is a claim
 * about a pure function, not about the system: the artifact schema is
 * `additionalProperties: false` and the write path validates the record it is
 * about to emit, so a `scope` the schema does not know about would not degrade
 * gracefully — it would fail the publish outright, and the only thing the unit
 * tests would notice is nothing. These tests assert the field survives the
 * round trip into state, and that the two ways it can be lost — a version that
 * forgets it, and a model that invents a value — are handled.
 */

const AGENTS = [
  { id: "architect", role: "architect", authority: ["architecture.approve"], capabilities: ["architecture.write"], interests: [] },
  { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
];

const COMM = { architect: ["dev"], dev: ["architect"] };

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

async function mesh(): Promise<Mesh> {
  return makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" });
}

function must(res: Awaited<ReturnType<Mesh["supervisor"]["createArtifact"]>>) {
  if (!("artifact" in res)) throw new Error(`publish failed: ${res.error}`);
  return res.artifact;
}

test("an explicit scope survives the publish into stored state", async () => {
  const m = await mesh();
  try {
    const a = must(
      await m.supervisor.createArtifact({
        actorId: "dev",
        name: "the-patch",
        type: "CodePatch",
        scope: "mission",
        content: evidenceContent("the patch this mission is about"),
      }),
    );
    // Not just the returned record — the projection, which is what context is
    // built from.
    const stored = m.kernel.state.artifacts.get(a.id);
    assert.equal(stored?.scope, "mission");
    assert.equal(artifactScope(stored!), "mission", "a CodePatch that every agent must see");
  } finally {
    await m.cleanup();
  }
});

test("a publish with no scope stores no scope field at all", async () => {
  const m = await mesh();
  try {
    const a = must(
      await m.supervisor.createArtifact({
        actorId: "dev",
        name: "routine-patch",
        type: "CodePatch",
        content: evidenceContent("routine work"),
      }),
    );
    const stored = m.kernel.state.artifacts.get(a.id);
    // The record has to keep the shape it had before this field existed, or
    // replaying an old log and replaying a new one stop agreeing.
    assert.equal("scope" in stored!, false);
    assert.equal(artifactScope(stored!), "work", "derived, not stored");
  } finally {
    await m.cleanup();
  }
});

test("a new version inherits the scope it was not asked to restate", async () => {
  const m = await mesh();
  try {
    const v1 = must(
      await m.supervisor.createArtifact({
        actorId: "dev",
        name: "the-patch",
        type: "CodePatch",
        scope: "mission",
        content: evidenceContent("v1"),
      }),
    );
    const v2 = must(
      await m.supervisor.createArtifact({
        actorId: "dev",
        name: "the-patch",
        type: "CodePatch",
        content: evidenceContent("v2, now with tests"),
        asVersionOf: v1.id,
      }),
    );
    assert.equal(v2.version, 2);
    assert.equal(
      m.kernel.state.artifacts.get(v2.id)?.scope,
      "mission",
      "silence on a version means 'unchanged', not 'reset to the type default'",
    );
  } finally {
    await m.cleanup();
  }
});

test("a version may re-scope deliberately", async () => {
  const m = await mesh();
  try {
    const v1 = must(
      await m.supervisor.createArtifact({
        actorId: "architect",
        name: "auth-design",
        type: "ArchitectureDocument",
        content: evidenceContent("v1"),
      }),
    );
    const v2 = must(
      await m.supervisor.createArtifact({
        actorId: "architect",
        name: "auth-design",
        type: "ArchitectureDocument",
        content: evidenceContent("v2, narrowed to a spike"),
        scope: "work",
        asVersionOf: v1.id,
      }),
    );
    assert.equal(m.kernel.state.artifacts.get(v2.id)?.scope, "work");
  } finally {
    await m.cleanup();
  }
});

test("an invented scope is dropped, not fatal — the document still publishes", async () => {
  const m = await mesh();
  try {
    const res = await m.supervisor.createArtifact({
      actorId: "dev",
      name: "guessy-patch",
      type: "CodePatch",
      // What a model actually emits when it half-remembers a field name.
      scope: "global" as never,
      content: evidenceContent("perfectly good content"),
    });
    const a = must(res);
    const stored = m.kernel.state.artifacts.get(a.id);
    assert.equal("scope" in stored!, false, "an unknown value must not reach the log");
    assert.equal(artifactScope(stored!), "work", "falls back to the behaviour that predates the field");
  } finally {
    await m.cleanup();
  }
});
