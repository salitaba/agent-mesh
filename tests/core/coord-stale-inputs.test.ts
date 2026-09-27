import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { buildAgentContext, renderContextInstructions } from "../../packages/core/src/context";
import { createInitialState } from "../../packages/core/src/state";
import { applyEvent, projectionConfigFor } from "../../packages/core/src/projections";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * §16 of the 2026-09-25 live run: work built on stale inputs was never flagged.
 *
 * Every `mesh_artifact_read` returned a known version, and nothing kept it: the
 * ux flow cited ApiSpec v1 56 s after v2 landed, and pm approved that flow three
 * times as ApiSpec reached v3.
 */

const AGENTS = [
  { id: "arch", role: "architect", capabilities: ["repository.read", "architecture.write"], authority: ["architecture.approve"], interests: [] },
  { id: "ux", role: "ux-designer", capabilities: ["repository.read", "ui.write", "review.design"], interests: [] },
];
const COMM = { arch: ["ux"], ux: ["arch"] };

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

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

function recordWakes(m: Mesh): Array<{ agentId: string; note?: string }> {
  const wakes: Array<{ agentId: string; note?: string }> = [];
  const sup = m.supervisor as unknown as { activateAgent: (id: string, r: { kind: string; note?: string }, o?: unknown) => Promise<unknown> };
  const orig = sup.activateAgent.bind(m.supervisor);
  sup.activateAgent = async (id, r, o) => {
    wakes.push({ agentId: id, note: r.note });
    return orig(id, r, o);
  };
  return wakes;
}

/** arch's ApiSpec v1, and ux's flow published in a turn that read it. */
async function flowOnApiV1() {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" });
  const api = await m.supervisor.executeOp("arch", { op: "publish_artifact", name: "api", type: "ApiSpec", content: "# API v1" } as MeshOp, turnFor("arch"));
  assert.equal(api.ok, true, api.reason);
  const ux = turnFor("ux");
  const read = await m.supervisor.executeOp("ux", { op: "read_artifact", artifactRef: api.artifactUri! } as MeshOp, ux);
  assert.equal(read.ok, true, read.reason);
  const flow = await m.supervisor.executeOp("ux", { op: "publish_artifact", name: "ux-flow", type: "DesignSpec", content: "# Flow, per API v1" } as MeshOp, ux);
  assert.equal(flow.ok, true, flow.reason);
  return { m, apiId: api.artifactId!, flowId: flow.artifactId! };
}

const bumpApi = (m: Mesh, apiId: string, body: string) =>
  m.supervisor.executeOp("arch", { op: "publish_artifact", name: "api", type: "ApiSpec", content: body, asVersionOf: apiId } as MeshOp, turnFor("arch"));

test("inputs: a publish records the artifact versions its turn read, on the record and in the log", async () => {
  const { m, apiId, flowId } = await flowOnApiV1();
  try {
    assert.deepEqual(m.kernel.state.artifacts.get(flowId)?.inputs, [{ artifactId: apiId, version: 1 }]);
    const fresh = createInitialState();
    for (const e of await m.store.read()) applyEvent(fresh, e, projectionConfigFor(m.config));
    assert.deepEqual(fresh.artifacts.get(flowId), m.kernel.state.artifacts.get(flowId), "replayed from the publish event alone");

    // A turn that read nothing records nothing — a new version does not inherit what an older turn read.
    await m.supervisor.executeOp("ux", { op: "publish_artifact", name: "ux-flow", type: "DesignSpec", content: "# Flow v2, from memory", asVersionOf: flowId } as MeshOp, turnFor("ux"));
    assert.equal(m.kernel.state.artifacts.get(flowId)?.inputs, undefined);
  } finally {
    await m.cleanup();
  }
});

test("inputs: a newer version of an input tells the dependent's owner once, and the context keeps saying so", async () => {
  const { m, apiId, flowId } = await flowOnApiV1();
  try {
    const wakes = recordWakes(m);
    await bumpApi(m, apiId, "# API v2");
    await bumpApi(m, apiId, "# API v3");
    const told = wakes.filter((w) => w.agentId === "ux" && /your DesignSpec "ux-flow" v1 was built on ApiSpec "api" v1; it is now v2/.test(w.note ?? ""));
    assert.equal(told.length, 1, "told when ApiSpec moved — before this nothing was ever flagged");
    assert.equal(wakes.filter((w) => w.agentId === "ux").length, 1, "and only once for this version of the flow");

    const ctx = buildAgentContext({ config: m.config, kernel: m.kernel }, "ux");
    const line = ctx.relevantArtifacts.find((a) => a.name === "ux-flow");
    assert.deepEqual(line?.staleInputs, ["ApiSpec/api v1 → v3"]);
    assert.match(renderContextInstructions(ctx), /ux-flow\/1 \(DesignSpec, DRAFT\) — built on ApiSpec\/api v1 → v3/);

    // Rebuilt on the current input, the flag clears.
    const ux = turnFor("ux");
    await m.supervisor.executeOp("ux", { op: "read_artifact", artifactRef: apiId } as MeshOp, ux);
    await m.supervisor.executeOp("ux", { op: "publish_artifact", name: "ux-flow", type: "DesignSpec", content: "# Flow, per API v3", asVersionOf: flowId } as MeshOp, ux);
    const after = buildAgentContext({ config: m.config, kernel: m.kernel }, "ux");
    assert.equal(after.relevantArtifacts.find((a) => a.name === "ux-flow")?.staleInputs, undefined);
  } finally {
    await m.cleanup();
  }
});
