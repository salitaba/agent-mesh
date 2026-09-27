import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, collectEvents } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * F5 — a turn that closed with `wait` after working through the mesh tools is
 * not an empty turn, and a turn that really did nothing still is.
 *
 * `isTurnEffect` was taught to count MCP-channel work so a no-ops turn is not
 * thrown away (see `turn-effects-mcp.test.ts`). The `wait/done/remember` arm was
 * not: it fires on the ops block alone, so a seat that published artifacts and
 * then closed with `wait` — the shape every seat used in the skill-panel run of
 * 2026-09-25 — was told "no work was produced" with its effects already durable
 * on the log, and `turnProducedWork = false` then skipped the stall watchdog's
 * nudge-streak reset while arming the no-op fast retry.
 *
 * Measured on that run: 5 of 5 turns closing with `wait` were misreported
 * (architect published 8 artifacts with 8 review requests and 12 messages,
 * frontend a CodePatch v1→v2 with `patch.ready`, ux-designer 3 flow specs),
 * and 14 of 36 turns carried a false "no work" sentence. The control that
 * identifies the trigger: the same amount of work closed as `send+wait` escaped
 * the verdict, because `send` falls outside the op set — the flag turned on how
 * a seat phrased its last op, not on what it did.
 *
 * The two tests below are deliberately a pair. The second is the negative
 * control: without it, deleting the arm outright would satisfy the first.
 */

const AGENTS = [{ id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] }];

async function turnNotes(m: Awaited<ReturnType<typeof makeMesh>>): Promise<string[]> {
  return (await collectEvents(m))
    .filter((e) => e.type === "memory.updated")
    .map((e) => String(((e.payload as { note?: { value?: unknown } }).note ?? {}).value ?? ""));
}

test("a turn that publishes through the tools and closes with `wait` is not scored as workless", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: { dev: [] }, mode: "live" });
  try {
    stub(m).setScript("dev", async () => {
      // Stands in for `mesh_artifact_publish`: the same supervisor entry point the
      // MCP tool calls, made while the turn is in flight, so the emit carries
      // this turn's correlation id and counts as an effect.
      await m.supervisor.createArtifact({
        actorId: "dev",
        name: "wait-arm-slice",
        type: "CodePatch",
        content: "## File: src/wait-arm.ts\nexport const w = 1;\n",
      });
      return {
        operations: [{ op: "wait", reason: "holding for review" }] as MeshOp[],
        text: "published the slice, waiting on review",
        tokensUsed: { input: 1_000, output: 500, total: 1_500 },
      };
    });

    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor(
      "the artifact to land",
      () => [...m.kernel.state.artifacts.values()].some((a) => a.name === "wait-arm-slice"),
      5000,
    );
    await waitFor("the turn to settle", () => !m.supervisor.isTurnInFlight("dev"), 5000);

    const notes = await turnNotes(m);
    const workless = notes.find((v) => v.includes("no work was produced"));
    assert.equal(
      workless,
      undefined,
      `the effects were durable on the log, so this turn must not be told it produced nothing — notes: ${JSON.stringify(notes)}`,
    );
  } finally {
    await m.cleanup();
  }
});

test("a turn that closes with `wait` and really did nothing is still called out", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: { dev: [] }, mode: "live" });
  try {
    stub(m).setScript("dev", async () => ({
      operations: [{ op: "wait", reason: "nothing to do" }] as MeshOp[],
      text: "nothing to do",
      tokensUsed: { input: 1_000, output: 200, total: 1_200 },
    }));

    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the turn to settle", () => !m.supervisor.isTurnInFlight("dev"), 5000);

    const notes = await turnNotes(m);
    const workless = notes.find((v) => v.includes("no work was produced"));
    assert.ok(
      workless,
      `a turn with no effects at all must still be reported, or the arm has simply been disabled — notes: ${JSON.stringify(notes)}`,
    );
  } finally {
    await m.cleanup();
  }
});
