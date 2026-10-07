import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, collectEvents } from "../helpers";
import type { ActivationReason, MeshOp } from "../../packages/protocol/src/index";

/**
 * A turn the mesh woke only to read mail that asked nothing is not reported as idle work.
 *
 * The `wait/done/remember` arm at the end of a turn calls a turn that changed nothing "no work was produced while the mission has
 * unmet criteria; the watchdog will rotate to another driver", replaces the seat's own summary with that sentence, and the sentence
 * lands in the seat's memory. For the floor under the wake gates (`floorWakeReason`: announcements nobody subscribed to, nothing
 * owed) that is the one turn whose purpose was to read, and in the twentieth cronlite run the line followed a QA seat through its
 * next four turns. `reason.asksNothing` says the turn was for reading; the arm keeps its mechanics (the retry the watchdog arms for
 * a turn that changed nothing, the seat's lifecycle) and changes what it says.
 *
 * The cases are a set, as in `turn-effects-wait-arm.test.ts`: the first alone would pass if the arm were deleted, so the controls
 * pin that the flag excuses nothing it should not: not the same turn without it, and not a turn that did work.
 */

const AGENTS = [{ id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] }];

const FLOOR: ActivationReason = {
  kind: "timer",
  note: "mail has been waiting unread and nothing you subscribe to woke you for it: 1 announcement (INFORM) from pm. None of it asks anything of you: read it, and unless it changes what you do next, end the turn with mesh_wait (mesh_done closes a task you hold).",
  asksNothing: true,
};

async function memoryNotes(m: Awaited<ReturnType<typeof makeMesh>>): Promise<string[]> {
  return (await collectEvents(m))
    .filter((e) => e.type === "memory.updated")
    .map((e) => String(((e.payload as { note?: { value?: unknown } }).note ?? {}).value ?? ""));
}

async function runOnce(reason: ActivationReason, script: () => Promise<{ operations: MeshOp[]; text?: string }>) {
  const m = await makeMesh({ agents: AGENTS, mayContact: { dev: [] }, mode: "live" });
  stub(m).setScript("dev", script as never);
  await m.supervisor.activateAgent("dev", reason, { explicit: true });
  await waitFor("the turn to settle", () => !m.supervisor.isTurnInFlight("dev"), 5000);
  const turn = m.supervisor.getRecentTurns(10).find((t) => t.agentId === "dev");
  assert.ok(turn, "the turn ran");
  return { m, turn, notes: await memoryNotes(m) };
}

test("a floor wake that read the mail and waited is described as a read: no warning, nothing called idle work", async () => {
  const { m, turn, notes } = await runOnce(FLOOR, async () => ({ operations: [{ op: "wait", reason: "nothing for me yet" }] }));
  try {
    assert.match(String(turn.summary), /^read the mail that had been waiting — none of it asked anything of you$/);
    assert.deepEqual(turn.notices ?? [], [], "a turn that did what it was for carries no warning");
    assert.ok(
      notes.some((v) => v.includes("read the mail that had been waiting")),
      `the seat's memory says what the turn was — notes: ${JSON.stringify(notes)}`,
    );
    assert.equal(
      notes.find((v) => v.includes("no work was produced")),
      undefined,
      `the accusation must not reach the seat's memory — notes: ${JSON.stringify(notes)}`,
    );
  } finally {
    await m.cleanup();
  }
});

test("what the seat said it learned rides along, as it does on the other arms", async () => {
  const { m, turn } = await runOnce(FLOOR, async () => ({ operations: [{ op: "done", summary: "the contract is frozen; waiting for the patch" }] }));
  try {
    assert.equal(
      turn.summary,
      "read the mail that had been waiting — none of it asked anything of you (model said: the contract is frozen; waiting for the patch)",
    );
  } finally {
    await m.cleanup();
  }
});

test("control: the same turn woken without the flag is still called out", async () => {
  const { m, turn, notes } = await runOnce({ kind: "timer", note: "queued mail while waiting; follow up or close the loop" }, async () => ({
    operations: [{ op: "wait", reason: "nothing for me yet" }],
  }));
  try {
    assert.match(String(turn.summary), /no work was produced/);
    assert.ok(notes.some((v) => v.includes("no work was produced")), `notes: ${JSON.stringify(notes)}`);
  } finally {
    await m.cleanup();
  }
});

test("control: the flag does not excuse a turn that did work, which is described by its work", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: { dev: [] }, mode: "live" });
  try {
    stub(m).setScript("dev", async () => {
      await m.supervisor.createArtifact({ actorId: "dev", name: "floor-slice", type: "CodePatch", content: "## File: src/floor.ts\nexport const f = 1;\n" });
      return { operations: [{ op: "wait", reason: "holding for review" } as MeshOp] };
    });
    await m.supervisor.activateAgent("dev", FLOOR, { explicit: true });
    await waitFor("the turn to settle", () => !m.supervisor.isTurnInFlight("dev"), 5000);
    const turn = m.supervisor.getRecentTurns(10).find((t) => t.agentId === "dev");
    assert.ok(turn);
    assert.doesNotMatch(String(turn.summary), /read the mail that had been waiting/, "a turn that published an artifact did more than read");
    assert.doesNotMatch(String(turn.summary), /no work was produced/);
  } finally {
    await m.cleanup();
  }
});
