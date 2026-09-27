import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { createMcpToolset } from "../../apps/mesh-server/src/mcp";
import { mintSeatToken } from "../../packages/core/src/seat-token";
import { ARTIFACT_TYPES, type MeshOp } from "../../packages/protocol/src/index";

/**
 * §15 of the 2026-09-25 live run: seats are not told the vocabulary the mesh
 * enforces.
 *
 * `artifactRefs` must be `artifact://` URIs while every other tool takes an id;
 * all 4 URI rejections in the run passed a bare `art-…` id, and one bad ref
 * refused the whole message around it. And `mesh_artifact_publish.type` was a
 * free string, so the closed type set appeared only in the refusal (qa tried
 * TestPlan, TestFixture).
 */

const AGENTS = [
  { id: "qa", role: "qa", capabilities: ["repository.read", "test.write"], interests: [] },
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write"], interests: [] },
];
const COMM = { qa: ["dev"], dev: ["qa"] };

const turnFor = (agentId: string) =>
  ({
    turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`,
    agentId,
    reason: { kind: "manual" as const },
    sentOps: 0,
    publishedOps: 0,
    waitRequested: false,
    escalated: false,
    results: [],
  }) as never;

test("comms: an artifact id or content ref in artifactRefs is resolved to the artifact's URI", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" } as never);
  try {
    const v1 = await m.supervisor.createArtifact({ actorId: "qa", name: "smoke-plan", type: "TestReport", content: "plan v1" });
    if (!("artifact" in v1)) throw new Error("create failed");
    const v2 = await m.supervisor.createArtifact({ actorId: "qa", name: "smoke-plan", type: "TestReport", content: "plan v2", asVersionOf: v1.artifact.id });
    if (!("artifact" in v2)) throw new Error(`version failed: ${JSON.stringify(v2)}`);
    const current = m.kernel.state.artifacts.get(v1.artifact.id)!;
    assert.equal(current.version, 2);

    const res = await m.supervisor.executeOp(
      "qa",
      {
        op: "send",
        type: "INFORM",
        to: ["dev"],
        newThread: { subject: "plan" },
        // The live shape — a bare id — beside an object ref and a v1 content ref.
        artifactRefs: [v1.artifact.id, { uri: v1.artifact.id }, v1.artifact.contentRef] as never,
        payload: { note: "see plan" },
      } as MeshOp,
      turnFor("qa"),
    );

    assert.equal(res.ok, true, `a bare id must not refuse the message: ${res.reason}`);
    const sent = m.kernel.state.messages.get(res.messageId!)!;
    assert.deepEqual(
      sent.artifactRefs.map((r) => r.uri),
      ["artifact://TestReport/smoke-plan/2", "artifact://TestReport/smoke-plan/2", "artifact://TestReport/smoke-plan/1"],
      "an id names the current version; a content ref names the version it is the content of",
    );
  } finally {
    await m.cleanup();
  }
});

test("comms: a ref that names nothing is still refused by name, not silently dropped", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" } as never);
  try {
    const res = await m.supervisor.executeOp(
      "qa",
      { op: "send", type: "INFORM", to: ["dev"], newThread: { subject: "plan" }, artifactRefs: ["art-NOSUCHTHING0000"] as never, payload: {} } as MeshOp,
      turnFor("qa"),
    );
    assert.equal(res.ok, false);
    assert.match(String(res.reason), /artifactRefs/);
  } finally {
    await m.cleanup();
  }
});

test("comms: mesh_artifact_publish offers the closed artifact type set", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" } as never);
  try {
    const mcp = createMcpToolset(m.supervisor);
    const tok = mintSeatToken(m.config.meshId, "qa", m.kernel.state.activeGoalId);
    const list = (await mcp.handle("qa", tok, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })) as {
      result: { tools: Array<{ name: string; inputSchema: any }> };
    };
    const publish = list.result.tools.find((t) => t.name === "mesh_artifact_publish")!;
    assert.deepEqual(publish.inputSchema.properties.type.enum, ARTIFACT_TYPES, "taken from the protocol list, so a new type is offered the day it exists");
    assert.notStrictEqual(publish.inputSchema.properties.type.enum, ARTIFACT_TYPES, "copied, never aliased");
    assert.ok(!publish.inputSchema.properties.type.enum.includes("TestPlan"), "qa's guess is not in it");
  } finally {
    await m.cleanup();
  }
});
