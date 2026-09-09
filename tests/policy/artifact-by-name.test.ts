import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";

function fakeTurn(agentId: string) {
  return {
    turnId: `test-${agentId}-${Date.now()}`,
    agentId,
    reason: { kind: "manual" as const },
    sentOps: 0,
    publishedOps: 0,
    waitRequested: false,
    escalated: false,
    results: [],
  } as never;
}

test("transition_artifact resolves by display name, not only id/uri", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] }],
  });
  const pub = await m.supervisor.executeOp(
    "dev",
    { op: "publish_artifact", name: "TrackBench-Requirements-v1", type: "RequirementsDoc", content: "req docs" },
    fakeTurn("dev"),
  );
  assert.equal(pub.ok, true);
  const artId = pub.artifactId!;

  // Bare display name — the model's natural address. This used to fail with
  // "unknown artifact TrackBench-Requirements-v1" while the artifact existed.
  const tr = await m.supervisor.executeOp(
    "dev",
    { op: "transition_artifact", artifactId: "TrackBench-Requirements-v1", to: "FINAL" },
    fakeTurn("dev"),
  );
  assert.equal(tr.ok, true, `transition by name failed: ${tr.reason}`);
  assert.equal(m.kernel.state.artifacts.get(artId)?.status, "FINAL");

  // read_artifact by bare name keeps working (fuzzy URI fallback).
  const rd = await m.supervisor.executeOp("dev", { op: "read_artifact", artifactRef: "TrackBench-Requirements-v1" }, fakeTurn("dev"));
  assert.equal(rd.ok, true, `read by name failed: ${rd.reason}`);

  // Missing names still fail cleanly instead of a wrong match.
  const miss = await m.supervisor.executeOp("dev", { op: "transition_artifact", artifactId: "NoSuchDoc-zz", to: "FINAL" }, fakeTurn("dev"));
  assert.equal(miss.ok, false);
  assert.match(miss.reason ?? "", /unknown artifact/);
});