import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { createMcpToolset } from "../../apps/mesh-server/src/mcp";
import { mintSeatToken } from "../../packages/core/src/seat-token";

/**
 * A read of an artifact says where the artifact stands, not only what it says.
 *
 * The eleventh cronlite run (2026-10-02). Both rounds' chases for a report began with a seat that could not tell what state an
 * artifact was in. Round one: the pm, told by QA that the report existed, cited it in two acceptances and was refused both
 * because it was a DRAFT. Round two: QA sent the pm "verification complete" six seconds before it submitted and passed the
 * report, the pm woke on the draft, read it once (three seconds before the submission), and forty-one seconds after the report
 * was FINAL asked QA to move it to review; the ask cost QA a turn and the pm another. `mesh_artifact_read` returned the text and
 * nothing else, so a seat that read a report to cite it (which the acceptor's briefing now asks it to do) learned from a
 * refusal that it could not. A DRAFT is the one status that changes what a reader may do with an artifact, so the read now
 * carries the status, with the version and the owner (the seat to ask to submit it).
 */

const AGENTS = [
  { id: "qa", role: "qa", capabilities: ["repository.read", "test.execute", "test.write"], authority: ["quality.pass"], interests: [] },
  { id: "pm", role: "product-manager", capabilities: ["repository.read"], authority: ["requirements.accept"], interests: [] },
];

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

function bus(m: Mesh) {
  const mcp = createMcpToolset(m.supervisor);
  return async (as: string, name: string, args: Record<string, unknown> = {}): Promise<Record<string, any>> => {
    const tok = mintSeatToken(m.config.meshId, as, m.kernel.state.activeGoalId);
    const raw = (await mcp.handle(as, tok, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })) as {
      result: { content: Array<{ text: string }> };
    };
    return JSON.parse(raw.result.content[0]!.text);
  };
}

const parked = (): Promise<Mesh> => makeMesh({ agents: AGENTS, mayContact: { qa: ["pm"], pm: ["qa"] }, mode: "parked" } as never);

test("a read says the artifact is a DRAFT, then that it was submitted, as the owner moves it", async () => {
  const m = await parked();
  try {
    const call = bus(m);
    const pub = await call("qa", "mesh_artifact_publish", { name: "QA Verification Report", type: "TestReport", content: "44 unit tests, all passing; the CLI cases ran" });
    assert.equal(pub.ok, true, pub.error);

    const draft = await call("pm", "mesh_artifact_read", { artifactRef: pub.artifactUri });
    assert.equal(draft.ok, true);
    assert.equal(draft.status, "DRAFT", "what the pm needs to know before it cites it");
    assert.equal(draft.version, 1);
    assert.equal(draft.owner, "qa", "and whom to ask to submit it");
    assert.match(String(draft.content), /44 unit tests/, "alongside the content, which is unchanged");

    const moved = await m.supervisor.transitionArtifact("qa", pub.artifactId, { to: "READY_FOR_REVIEW" });
    assert.equal(moved.ok, true, String(moved.reason));
    const submitted = await call("pm", "mesh_artifact_read", { artifactRef: pub.artifactUri });
    assert.equal(submitted.status, "READY_FOR_REVIEW", "the same read, a minute later, says the report was submitted");
  } finally {
    await m.cleanup();
  }
});

test("a new version starts over as a draft, and a page of a long artifact carries the status too", async () => {
  const m = await parked();
  try {
    const call = bus(m);
    const long = Array.from({ length: 1500 }, (_, i) => `case ${i}: passed`).join("\n");
    const pub = await call("qa", "mesh_artifact_publish", { name: "Long Report", type: "TestReport", content: long });
    assert.equal(pub.ok, true, pub.error);
    const page = await call("pm", "mesh_artifact_read", { artifactRef: pub.artifactId });
    assert.equal(page.truncated, true, "fixture: more than one page");
    assert.equal(page.status, "DRAFT", "every page says so, not only the last");
    assert.equal(page.version, 1);

    await m.supervisor.transitionArtifact("qa", pub.artifactId, { to: "READY_FOR_REVIEW" });
    const v2 = await call("qa", "mesh_artifact_publish", { name: "Long Report", type: "TestReport", content: "rewritten", asVersionOf: pub.artifactId });
    assert.equal(v2.ok, true, v2.error);
    const read = await call("pm", "mesh_artifact_read", { artifactRef: v2.artifactId });
    assert.equal(read.version, 2);
    assert.equal(read.status, "DRAFT", "the new version has not been submitted: the earlier one's status is not inherited");
  } finally {
    await m.cleanup();
  }
});
