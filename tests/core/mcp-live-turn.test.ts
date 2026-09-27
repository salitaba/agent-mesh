import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, collectEvents } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * An MCP tool call is an op of the turn it was made in.
 *
 * The bridge used to run every `mesh_*` call against a throwaway turn record,
 * so the tool channel counted as work (via `turnEffects`) and nothing else:
 * `mesh_wait` and `mesh_escalate` never reached the lifecycle the turn settled
 * into, the handover guard never saw a tool call, and `mesh_done`'s summary was
 * dropped. `executeToolOp` runs the op on the seat's live turn instead, which
 * these tests pin by calling it from inside a stub turn — the same entry point
 * `McpToolset` calls.
 */

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

const AGENTS = [
  { id: "architect", role: "architect", capabilities: ["review.design"], interests: [] },
  { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
];

function liveMesh() {
  return makeMesh({
    agents: AGENTS,
    mayContact: { architect: ["dev"], dev: ["architect"] },
    mode: "live",
    stallIdleMs: 600_000,
    stallCooldownMs: 600_000,
    stallNoopRetryMs: 600_000,
  });
}

async function settledTo(m: Mesh, agentId: string): Promise<string | undefined> {
  const changes = (await collectEvents(m))
    .filter((e) => e.type === "agent.state_changed")
    .map((e) => e.payload as { agentId?: string; from?: string; to?: string })
    .filter((p) => p.agentId === agentId && p.from === "THINKING");
  return changes.at(-1)?.to;
}

async function turnNotes(m: Mesh): Promise<string[]> {
  return (await collectEvents(m))
    .filter((e) => e.type === "memory.updated")
    .map((e) => String(((e.payload as { note?: { value?: unknown } }).note ?? {}).value ?? ""));
}

test("mcp: `mesh_wait` made mid-turn settles the turn into WAITING", async () => {
  const m = await liveMesh();
  try {
    stub(m).setScript("dev", async () => {
      const res = await m.supervisor.executeToolOp("dev", { op: "wait", reason: "holding" } as MeshOp);
      assert.equal(res.ok, true);
      return { operations: [], text: "waiting", tokensUsed: { input: 100, output: 50, total: 150 } };
    });
    stub(m).setScript("architect", async () => ({ operations: [{ op: "wait" } as MeshOp] }));

    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the turn to settle", async () => (await settledTo(m, "dev")) !== undefined, 5000);

    assert.equal(await settledTo(m, "dev"), "WAITING", "the tool call's wait must reach the turn it was made in");
  } finally {
    await m.cleanup();
  }
});

test("mcp: a turn whose only op is a tool-call `wait` is not a no_ops discard", async () => {
  const m = await liveMesh();
  try {
    stub(m).setScript("dev", async () => {
      await m.supervisor.executeToolOp("dev", { op: "wait" } as MeshOp);
      return { operations: [], text: "nothing to do", tokensUsed: { input: 100, output: 50, total: 150 } };
    });
    stub(m).setScript("architect", async () => ({ operations: [{ op: "wait" } as MeshOp] }));

    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the turn to settle", async () => (await settledTo(m, "dev")) !== undefined, 5000);

    const discards = (await collectEvents(m)).filter((e) => e.type === "turn.discarded");
    assert.deepEqual(discards, [], "the op ran, so the turn is not empty");
  } finally {
    await m.cleanup();
  }
});

test("mcp: `mesh_done`'s summary becomes the turn summary", async () => {
  const m = await liveMesh();
  try {
    stub(m).setScript("dev", async () => {
      await m.supervisor.createArtifact({ actorId: "dev", name: "done-slice", type: "CodePatch", content: "## File: a.ts\nexport const a = 1;\n" });
      await m.supervisor.executeToolOp("dev", { op: "done", summary: "shipped the done-slice patch" } as MeshOp);
      return { operations: [], text: "prose the model wrote", tokensUsed: { input: 100, output: 50, total: 150 } };
    });
    stub(m).setScript("architect", async () => ({ operations: [{ op: "wait" } as MeshOp] }));

    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the turn to settle", async () => (await settledTo(m, "dev")) !== undefined, 5000);

    const notes = await turnNotes(m);
    assert.ok(
      notes.some((v) => v.includes("shipped the done-slice patch")),
      `the declared summary must win over scraped prose — notes: ${JSON.stringify(notes)}`,
    );
  } finally {
    await m.cleanup();
  }
});

test("mcp: a tool call during a handover turn is held to the handover rule", async () => {
  const m = await liveMesh();
  try {
    const refused: Array<string | undefined> = [];
    let turns = 0;
    stub(m).setScript("dev", async () => {
      // Only the first turn is the handover; the activation it consumed is
      // re-armed afterwards, and that ordinary turn may publish.
      if (turns++ > 0) return { operations: [{ op: "wait" } as MeshOp] };
      const res = await m.supervisor.executeToolOp("dev", {
        op: "publish_artifact",
        name: "half-done",
        type: "ResearchReport",
        content: "...",
      } as MeshOp);
      if (!res.ok) refused.push(res.reason);
      return {
        operations: [
          { op: "write_continuity", nextIntent: "resume the survey", beliefs: [], rejected: [] } as MeshOp,
          { op: "done" } as MeshOp,
        ],
      };
    });
    stub(m).setScript("architect", async () => ({ operations: [{ op: "wait" } as MeshOp] }));
    stub(m).armRotation("dev");

    await m.supervisor.activateAgent("dev", { kind: "manual", note: "go" });
    await waitFor("the handover turn ran", () => refused.length > 0 || m.kernel.state.continuity.has("dev"), 5000);

    assert.equal(refused.length, 1, "the publish made through the tool must be refused on a handover turn");
    assert.match(refused[0] ?? "", /handover/);
    assert.equal(
      [...m.kernel.state.artifacts.values()].some((a) => a.name === "half-done"),
      false,
      "and nothing was published",
    );
  } finally {
    await m.cleanup();
  }
});

test("mcp: a tool call between turns still runs, against no turn", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: { architect: ["dev"], dev: ["architect"] }, mode: "parked" });
  try {
    const res = await m.supervisor.executeToolOp("dev", { op: "remember", key: "k", value: "v" } as MeshOp);
    assert.equal(res.ok, true);
  } finally {
    await m.cleanup();
  }
});
