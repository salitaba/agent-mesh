import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { createMcpToolset } from "../../apps/mesh-server/src/mcp";
import { mintSeatToken } from "../../packages/core/src/seat-token";

/**
 * Just-in-time retrieval: the two handles a seat could not get before.
 *
 * The brief names a handful of artifacts and a subset of notes; everything else
 * in the store was reachable only by already knowing its id or URI. That pushed
 * seats to guess URIs and to re-derive facts they had written down. These tools
 * are read-only, own-notes-only, and bounded — the "fetch" half of the four
 * context operations, next to `mesh_query_events` and `mesh_artifact_read`.
 */

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

function caller(m: Mesh) {
  const mcp = createMcpToolset(m.supervisor);
  return async (as: string, name: string, args: Record<string, unknown> = {}): Promise<Record<string, any>> => {
    const tok = mintSeatToken(m.config.meshId, as, m.kernel.state.activeGoalId);
    const res = (await mcp.handle(as, tok, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    return JSON.parse(res.result.content[0]!.text) as Record<string, any>;
  };
}

const turn = { turnId: "t-retrieval", agentId: "dev", reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] } as never;

test("mesh_artifact_list turns a name into the id mesh_artifact_read needs", async () => {
  const m = await makeMesh({ mode: "parked", agents: [{ id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] }] });
  try {
    const pub = await m.supervisor.executeOp("dev", { op: "publish_artifact", name: "DesignSpec", type: "RequirementsDoc", content: "the design" }, turn);
    assert.equal(pub.ok, true, pub.reason);
    await m.supervisor.executeOp("dev", { op: "publish_artifact", name: "ApiSpec", type: "ApiSpec", content: "the api" }, turn);
    const call = caller(m);

    const found = await call("dev", "mesh_artifact_list", { name: "design" });
    assert.equal(found.total, 1);
    assert.equal(found.artifacts[0].id, pub.artifactId);
    assert.equal(found.artifacts[0].name, "DesignSpec");
    assert.equal(found.artifacts[0].type, "RequirementsDoc");
    assert.equal(found.artifacts[0].status, "DRAFT");

    const byType = await call("dev", "mesh_artifact_list", { type: "ApiSpec" });
    assert.deepEqual(byType.artifacts.map((a: { name: string }) => a.name), ["ApiSpec"]);

    const none = await call("dev", "mesh_artifact_list", { name: "does-not-exist" });
    assert.equal(none.total, 0);
    assert.deepEqual(none.artifacts, []);
  } finally {
    await m.cleanup();
  }
});

test("mesh_memory_search reads the seat's own notes, and a procedure is stored as one", async () => {
  const m = await makeMesh({ mode: "parked", agents: [{ id: "dev", role: "developer", capabilities: [], interests: [] }, { id: "qa", role: "qa", capabilities: [], interests: [] }] });
  try {
    const call = caller(m);
    const remembered = await call("dev", "mesh_remember", { key: "house-rule", value: "run the full suite before a merge", kind: "procedure" });
    assert.equal(remembered.ok, true);
    assert.equal(m.kernel.state.memory.get("dev")?.get("house-rule")?.kind, "procedure", "kind reaches the projection");
    await call("dev", "mesh_remember", { key: "api-version", value: "the API is v17" });
    await call("qa", "mesh_remember", { key: "house-rule", value: "qa's own note", kind: "procedure" });

    const procedures = await call("dev", "mesh_memory_search", { kind: "procedure" });
    assert.deepEqual(procedures.notes.map((n: { key: string }) => n.key), ["house-rule"]);
    assert.equal(procedures.notes[0].value, "run the full suite before a merge", "own notes only: qa's clone is not here");
    assert.equal(procedures.notes[0].kind, "procedure");

    const byWords = await call("dev", "mesh_memory_search", { query: "suite" });
    assert.deepEqual(byWords.notes.map((n: { key: string }) => n.key), ["house-rule"]);

    const all = await call("dev", "mesh_memory_search", {});
    assert.equal(all.total, 2);
    assert.deepEqual(all.notes.map((n: { key: string }) => n.key).sort(), ["api-version", "house-rule"]);
  } finally {
    await m.cleanup();
  }
});
