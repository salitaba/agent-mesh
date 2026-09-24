import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { createMcpToolset } from "../../apps/mesh-server/src/mcp";
import { applyEvent } from "../../packages/core/src/projections";
import { shortHash, PROTOCOL_VERSION, type MeshEvent } from "../../packages/protocol/src/index";

/**
 * Where `mesh_failures` and `mesh_run_digest` get their denials from.
 *
 * Both used to fold `message.rejected` out of the raw event window, and that
 * made the failure report quietly wrong at exactly the moment it is opened.
 * The window is the replay TAIL: a mesh restored from a snapshot has the
 * denials in its projections and not in the events it re-read, so the report
 * answered "nothing was denied" for an entire run. It is also the one section
 * `window` had no business bounding -- an operator shortening the scan to see
 * recent runtime failures silently lost every policy denial along with it.
 *
 * `message.rejected` is overloaded, so the fix has two halves and the tests
 * below cover both: `deniedActions` (an op or activation policy stopped) and
 * `refusedSends` (a message that never left the building). Folding them into
 * one bucket -- which is what the old code did -- produced rows whose
 * `action` was null and whose recipients were gone.
 */

function mcpReq(method: string, params: unknown, id = 1) {
  return { jsonrpc: "2.0", id, method, params };
}

let seq = 0;
function rejection(payload: Record<string, unknown>): MeshEvent {
  seq++;
  return {
    id: `evt-digest-${seq}`,
    protocolVersion: PROTOCOL_VERSION,
    type: "message.rejected",
    timestamp: `2026-03-01T00:00:${String(seq % 60).padStart(2, "0")}.000Z`,
    seq,
    payload,
  } as MeshEvent;
}

async function meshWithDenialsOutsideTheWindow() {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "qa", role: "qa", capabilities: ["test.execute"], interests: [] },
    ],
    mayContact: { dev: ["qa"], qa: ["dev"] },
    mode: "parked",
  });

  /**
   * Projected but never appended to this mesh's store -- which is precisely
   * the state a snapshot restore leaves behind, and the only way to tell the
   * two sources apart from outside. If the digest reads the log, it sees
   * none of this; if it reads the rings, it sees all of it.
   */
  applyEvent(m.kernel.state, rejection({
    from: "dev",
    action: "claim task (missing capability code.write)",
    subject: "task-1",
    reason: "capability not granted",
    ruleId: "capability.deny",
    decision: "DENY",
    denied: true,
  }));
  applyEvent(m.kernel.state, rejection({
    from: "dev",
    action: "claim task (missing capability code.write)",
    subject: "task-2",
    reason: "capability not granted",
    ruleId: "capability.deny",
    decision: "DENY",
    denied: true,
  }));
  applyEvent(m.kernel.state, rejection({
    from: "qa",
    to: ["dev"],
    type: "REQUEST_INFO",
    reason: "qa may not open asks during freeze",
    ruleId: "freeze.no-asks",
  }));
  return m;
}

function reader(m: Awaited<ReturnType<typeof makeMesh>>) {
  const mcp = createMcpToolset(m.supervisor, { readOnly: true });
  const tok = `${m.config.meshId}:dev:${shortHash(m.kernel.state.activeGoalId!)}`;
  return async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await mcp.handle("dev", tok, mcpReq("tools/call", { name, arguments: args }))) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    assert.equal(res.result.isError, false, res.result.content[0]?.text);
    return JSON.parse(res.result.content[0].text) as any;
  };
}

test("mesh_failures reads denials from projections, so they survive a log the scan cannot reach", async () => {
  const m = await meshWithDenialsOutsideTheWindow();
  try {
    const call = reader(m);
    // `window: 1` is the restored-mesh case made deterministic: one event of
    // scan, and every denial is outside it. A report that folds the log
    // answers "nothing was denied" here.
    const failures = await call("mesh_failures", { window: 1 });
    assert.equal(failures.scanned.events, 1, "the event scan really was shortened to one");
    assert.equal(failures.scanned.denialsFromProjection, true, "and the report must say the denials did not come from it");

    assert.equal(failures.denials.length, 1, "two denials with the same rule, action and reason fold into one row");
    assert.deepEqual(failures.denials[0], {
      agentId: "dev",
      ruleId: "capability.deny",
      action: "claim task (missing capability code.write)",
      decision: "DENY",
      reason: "capability not granted",
      count: 2,
    });
  } finally {
    await m.cleanup();
  }
});

test("a refused send is reported as one, not as a denial with no action", async () => {
  const m = await meshWithDenialsOutsideTheWindow();
  try {
    const failures = await reader(m)("mesh_failures", { window: 1 });

    // The old fold put both halves of `message.rejected` in `denials`, where
    // a refused send arrived with `action: null` and its recipients dropped
    // on the floor -- a row naming neither what was stopped nor what the mesh
    // had tried to say. They are separate questions and now separate rings,
    // so they are separate sections.
    assert.ok(
      !failures.denials.some((d: { action: string | null }) => !d.action),
      "no actionless row may appear in the denial section",
    );
    assert.deepEqual(failures.refusedSends, [{
      from: "qa",
      to: ["dev"],
      type: "REQUEST_INFO",
      ruleId: "freeze.no-asks",
      reason: "qa may not open asks during freeze",
      count: 1,
    }]);
  } finally {
    await m.cleanup();
  }
});

test("mesh_run_digest answers from the same two rings as mesh_failures", async () => {
  const m = await meshWithDenialsOutsideTheWindow();
  try {
    const call = reader(m);
    // The digest is documented as the cheapest broad answer before drilling
    // into the other tools. If it and `mesh_failures` disagreed about what
    // was denied, the cheap answer would be the one that sends an operator
    // looking in the wrong place.
    const digest = await call("mesh_run_digest", { window: 1 });
    const failures = await call("mesh_failures", { window: 1 });
    assert.deepEqual(digest.denials, failures.denials);
    assert.deepEqual(digest.refusedSends, failures.refusedSends);
  } finally {
    await m.cleanup();
  }
});

test("a denial the mesh actually made is reported without any hand-applied events", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", capabilities: [], interests: [] }],
    mayContact: { dev: [] },
    mode: "parked",
  });
  try {
    // The tests above project events by hand to prove WHERE the digest reads
    // from. This one proves the ring is fed by the live path at all -- a
    // report sourced from a projection nothing writes is worse than one
    // sourced from the log.
    const made = await m.supervisor.createArtifact({ actorId: "dev", name: "digest-patch", type: "CodePatch", content: "diff --git a/x b/x" });
    assert.ok("artifact" in made, JSON.stringify(made));

    const mcp = createMcpToolset(m.supervisor);
    const tok = `${m.config.meshId}:dev:${shortHash(m.kernel.state.activeGoalId!)}`;
    const refused = (await mcp.handle("dev", tok, mcpReq("tools/call", {
      name: "mesh_commit",
      arguments: { artifactId: made.artifact.id, message: "dev holds no git.commit" },
    }))) as { result: { isError: boolean } };
    assert.equal(refused.result.isError, true, "the seat holds no git.commit, so the op must fail");
    assert.ok(m.kernel.state.deniedActions.length > 0, "and the refusal must land in the ring");

    const failures = await reader(m)("mesh_failures", { window: 1 });
    assert.ok(failures.denials.length > 0, "and the report must show it");
    assert.ok(failures.denials.every((d: { action: string }) => typeof d.action === "string" && d.action.length > 0));
  } finally {
    await m.cleanup();
  }
});
