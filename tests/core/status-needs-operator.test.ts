import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { statusFromLog } from "../../packages/core/src/status";

/**
 * `status.needsOperator`: the OPEN cards a run still owes an answer.
 *
 * Cards do not gate completion (`termination.ts`), so a mission can now finish
 * with one still open — the very state this field exists to keep visible, in
 * place of the old freeze. It lists the same cards as `openEscalations`, dated
 * and trimmed to the fields an operator acts on.
 */

const AGENTS = [{ id: "dev", role: "developer", interests: [] }];

test("status: needsOperator lists an OPEN card with what an operator acts on", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: { dev: [] }, mode: "parked" });
  try {
    const card = await m.supervisor.escalate({ reason: "which licence do you want?", raisedBy: "dev" });
    const status = await m.supervisor.status();

    // The raw card is still on openEscalations; the summary is the new surface.
    assert.ok(status.openEscalations.some((e) => e.id === card.id));
    assert.equal(status.needsOperator.length, 1);
    const row = status.needsOperator[0]!;
    assert.equal(row.id, card.id);
    assert.equal(row.reason, "which licence do you want?");
    assert.equal(row.raisedBy, "dev");
    assert.equal(row.openedAt, card.createdAt);
    assert.ok(row.ageMs >= 0, `a card cannot have a negative age: ${row.ageMs}`);

    // Offline, from the log alone, the same card is listed: `curule status` on
    // a stopped mesh sees what the live one did.
    const replayed = statusFromLog(await m.store.read(), m.supervisor.config).status;
    assert.deepEqual(replayed.needsOperator.map((c) => c.id), [card.id]);
  } finally {
    await m.cleanup();
  }
});

test("status: needsOperator is empty with no cards, and drops one that was answered", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: { dev: [] }, mode: "parked" });
  try {
    assert.deepEqual((await m.supervisor.status()).needsOperator, [], "nothing outstanding, nothing to report");
    const card = await m.supervisor.escalate({ reason: "may I delete the old schema?", raisedBy: "dev" });
    assert.deepEqual(
      (await m.supervisor.status()).needsOperator.map((c) => c.id),
      [card.id],
    );
    assert.equal((await m.supervisor.respondEscalation(card.id, "yes")).ok, true);
    assert.deepEqual((await m.supervisor.status()).needsOperator, [], "an answered card is closed business");
  } finally {
    await m.cleanup();
  }
});
