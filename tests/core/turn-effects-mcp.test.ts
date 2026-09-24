import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, collectEvents } from "../helpers";

/**
 * A turn that worked through the mesh TOOLS is not an empty turn.
 *
 * `unproductive` was decided by `output.operations.length` — the `mesh-json`
 * ops block, and only that. Seats holding `mesh_*` MCP tools have largely
 * stopped writing the block: the tools work, answer mid-turn, and need no
 * closing ceremony. Judging those turns by the block alone called the most
 * productive turns of a live run empty.
 *
 * On 2026-09-23: the architect published three artifacts, opened five threads
 * and sent four messages in one turn, and was logged "⚠ turn only wait — no
 * work was produced". tech-lead approved three design artifacts through
 * `mesh_approve`, emitted no block, and got `turn.discarded — nothing was
 * sent, published, or requested`; the approvals were durable the whole time.
 * 12 of 32 turns were scored that way, and the strikes fed a recovery loop
 * that cost ux-designer 537,479 tokens — 3.6x its configured budget — with
 * every one of its eight turns recorded as having produced nothing.
 *
 * The turn effects are counted off the event stream, which `kernel.correlate`
 * stamps with the in-flight turn id, so both channels are visible without any
 * of the ~109 emit sites having to say so.
 */

const AGENTS = [{ id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] }];

async function discards(m: Awaited<ReturnType<typeof makeMesh>>): Promise<Array<Record<string, unknown>>> {
  return (await collectEvents(m)).filter((e) => e.type === "turn.discarded").map((e) => e.payload as Record<string, unknown>);
}

test("a turn that publishes through the tools and emits no ops block is not discarded", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: { dev: [] }, mode: "live" });
  try {
    stub(m).setScript("dev", async () => {
      // Stands in for `mesh_artifact_publish`: the same supervisor entry point
      // the MCP tool calls, made while the turn is in flight, so the emit
      // carries this turn's correlation id.
      await m.supervisor.createArtifact({
        actorId: "dev",
        name: "core-slice",
        type: "CodePatch",
        content: "## File: src/a.ts\nexport const a = 1;\n",
      });
      return { operations: [], text: "published the slice", tokensUsed: { input: 1_000, output: 500, total: 1_500 } };
    });

    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the artifact to land", () => [...m.kernel.state.artifacts.values()].some((a) => a.name === "core-slice"), 5000);
    await waitFor("the turn to settle", () => !m.supervisor.isTurnInFlight("dev"), 5000);

    assert.deepEqual(await discards(m), [], "the work landed through the tools, so the turn was not thrown away");
  } finally {
    await m.cleanup();
  }
});

test("the seat is still told it skipped the ops block, so the contract miss is not silent", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: { dev: [] }, mode: "live" });
  try {
    stub(m).setScript("dev", async () => {
      await m.supervisor.createArtifact({
        actorId: "dev",
        name: "core-slice-2",
        type: "CodePatch",
        content: "## File: src/b.ts\nexport const b = 2;\n",
      });
      return { operations: [], text: "done, I think", tokensUsed: { input: 1_000, output: 500, total: 1_500 } };
    });

    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the turn to settle", () => !m.supervisor.isTurnInFlight("dev"), 5000);

    const notes = (await collectEvents(m))
      .filter((e) => e.type === "memory.updated")
      .map((e) => String(((e.payload as { note?: { value?: unknown } }).note ?? {}).value ?? ""));
    const note = notes.find((v) => v.includes("ops block"));
    assert.ok(note, `expected a note about the missing ops block, got ${JSON.stringify(notes)}`);
    assert.ok(note.includes("the work stands"), "and it must say the work was kept, not lost");
    assert.ok(!note.startsWith("⚠"), "not flagged as a warning — the turn moved the mesh");
  } finally {
    await m.cleanup();
  }
});

test("a turn whose every op was refused is discarded too, and says so", async () => {
  // The one unproductive outcome that used to leave NO `turn.discarded`
  // behind. Such a turn spends full tokens and moves nothing — the same loss
  // `no_ops` records — but from the event stream it looked exactly like a
  // productive turn, so any measure of wasted spend undercounted it silently.
  const m = await makeMesh({ agents: AGENTS, mayContact: { dev: [] }, mode: "live" });
  try {
    stub(m).setScript("dev", async () => ({
      operations: [
        { op: "transition_artifact", artifactId: "art-does-not-exist", to: "APPROVED" },
        { op: "transition_artifact", artifactId: "art-also-missing", to: "APPROVED" },
      ],
      text: "moving the work along",
      tokensUsed: { input: 8_000, output: 2_000, total: 10_000 },
    }));

    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the discard to be recorded", async () => (await discards(m)).length === 1, 5000);

    const [d] = await discards(m);
    assert.equal(d!.reason, "all_rejected", "distinguishable from a turn that emitted nothing");
    assert.equal(d!.tokens, 10_000, "and it states what the refused turn cost");
  } finally {
    await m.cleanup();
  }
});

test("a turn that did nothing at all is still discarded — the control", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: { dev: [] }, mode: "live" });
  try {
    stub(m).setScript("dev", async () => ({
      operations: [],
      text: "I thought about it and have nothing to add.",
      tokensUsed: { input: 20_000, output: 5_000, total: 25_000 },
    }));

    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the discard to be recorded", async () => (await discards(m)).length === 1, 5000);

    const [d] = await discards(m);
    assert.equal(d!.reason, "no_ops", "no ops AND no effects is still an empty turn");
    assert.equal(d!.tokens, 25_000);
  } finally {
    await m.cleanup();
  }
});
