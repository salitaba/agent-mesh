import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";
import type { MeshInstance } from "../../apps/mesh-server/src/index";

/**
 * Work movement under the delivery regime, and the bug that used to be here.
 *
 * `classifyDelivery` derived its class from `isObligingType` alone, which is
 * true of `REQUEST*`, `ESCALATE` and `CHALLENGE` and of nothing else. Sixteen
 * of the twenty-four message types therefore fell through to `accrue` --
 * including every type that MOVES WORK (`HANDOFF`, `DELEGATE`, `PATCH_READY`)
 * and every type that SETTLES A REVIEW (`APPROVE`, `REJECT`, `VETO`, `BLOCK`).
 *
 * `accrue` means never woken for AND never nudged back: the sweep chases only
 * `interrupt`. So work moved to a seat that was never told, nothing resurfaced
 * it, and because the sender's own ask had already been discharged no
 * stalemate detector fired either -- the mesh went quiet holding live work.
 *
 * `movesWork` is the missing half of the question. These tests hold both
 * sides of the line it draws: the eight types that move work are delivered,
 * and the types that merely report are still accrued, because a fix that woke
 * everybody would have bought back the wake-on-everything mesh that delivery
 * classes exist to replace.
 */

const acts = (m: MeshInstance, id: string) => m.kernel.state.agents.get(id)?.state.activations ?? 0;
const classOf = (m: MeshInstance, id: string) => m.kernel.state.messages.get(id)?.control?.delivery;

function quiet(m: MeshInstance, ids: string[]): void {
  const s = stub(m);
  for (const id of ids) s.setScript(id, async () => ({ operations: [{ op: "done" } as MeshOp] }));
}

/**
 * The shipped `mesh init` regime, with a coalesce window short enough that a
 * `deliver` can be observed draining inside a test rather than in a minute.
 */
const REGIME = { delivery: { classes: true, coalesceMs: 120 } };

const PAIR = [
  { id: "dev", role: "developer", interests: [] },
  { id: "tech-lead", role: "tech-lead", interests: [] },
];

for (const type of ["HANDOFF", "DELEGATE", "PATCH_READY", "APPROVE", "REJECT", "VETO", "BLOCK"] as const) {
  test(`${type} moves work: delivered, and the recipient is woken for it`, async () => {
    const m = await makeMesh({
      agents: PAIR,
      mayContact: { dev: ["tech-lead"] },
      waitWakeupMs: 200,
      bus: REGIME,
    });
    try {
      quiet(m, ["dev", "tech-lead"]);
      const before = acts(m, "tech-lead");
      const sent = await m.supervisor.sendMessage({
        from: "dev",
        to: ["tech-lead"],
        type,
        newThread: { subject: `${type} to the lead` },
        payload: { what: "the work is ready for you" },
      });
      assert.equal(sent.accepted, true, sent.reason);
      // `deliver`, not `interrupt`: nobody owes an answer, so there is nothing
      // to chase and no reason to charge the sender a wake it did not need.
      assert.equal(classOf(m, sent.messageId!), "deliver", `${type} classes as deliver`);
      await waitFor(`lead woken for ${type}`, () => acts(m, "tech-lead") > before);
    } finally {
      await m.cleanup();
    }
  });
}

for (const type of ["INFORM", "TEST_RESULT", "COMMIT"] as const) {
  test(`${type} reports rather than moves work: still accrued, still never woken for`, async () => {
    const m = await makeMesh({
      agents: PAIR,
      mayContact: { dev: ["tech-lead"] },
      waitWakeupMs: 200,
      bus: REGIME,
    });
    try {
      quiet(m, ["dev", "tech-lead"]);
      const before = acts(m, "tech-lead");
      const sent = await m.supervisor.sendMessage({
        from: "dev",
        to: ["tech-lead"],
        type,
        newThread: { subject: `${type} to the lead` },
        payload: { note: "for the record" },
      });
      assert.equal(sent.accepted, true, sent.reason);
      assert.equal(classOf(m, sent.messageId!), "accrue", `${type} classes as accrue`);
      // Well past the coalesce window and several sweeps: if anything were
      // going to resurface it, it would have.
      await new Promise((r) => setTimeout(r, 1000));
      assert.equal(acts(m, "tech-lead") - before, 0, `${type} must not buy a turn`);
    } finally {
      await m.cleanup();
    }
  });
}

/**
 * The recipient's own rationing keys off the same line.
 *
 * `wake.defer_non_obliging` reads as "hold my chatter", and it used to hold a
 * handoff too -- the second, independent route to the same silent stall. Run
 * without a `bus.delivery` block on purpose: with classes on, `accrue` is
 * dropped before `defersMail` is ever reached, so this is the only regime in
 * which that gate is the one under test.
 */
test("a seat deferring non-obliging mail is still woken for work handed to it", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", interests: [] },
      { id: "tech-lead", role: "tech-lead", interests: [], wake: { deferNonObliging: true } },
    ],
    mayContact: { dev: ["tech-lead"] },
    waitWakeupMs: 200,
  });
  try {
    quiet(m, ["dev", "tech-lead"]);

    const before = acts(m, "tech-lead");
    const fyi = await m.supervisor.sendMessage({
      from: "dev",
      to: ["tech-lead"],
      type: "INFORM",
      newThread: { subject: "fyi" },
      payload: { note: "for the record" },
    });
    assert.equal(fyi.accepted, true, fyi.reason);
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(acts(m, "tech-lead") - before, 0, "the deferral still holds chatter");

    const handoff = await m.supervisor.sendMessage({
      from: "dev",
      to: ["tech-lead"],
      type: "HANDOFF",
      newThread: { subject: "handoff to the lead" },
      payload: { what: "the work is ready for you" },
    });
    assert.equal(handoff.accepted, true, handoff.reason);
    await waitFor("lead woken for the handoff despite deferring", () => acts(m, "tech-lead") > before);
  } finally {
    await m.cleanup();
  }
});

test("the same HANDOFF wakes the lead when the mesh never opted into the regime", async () => {
  const m = await makeMesh({
    agents: PAIR,
    mayContact: { dev: ["tech-lead"] },
    waitWakeupMs: 200,
  });
  try {
    quiet(m, ["dev", "tech-lead"]);
    const before = acts(m, "tech-lead");
    const sent = await m.supervisor.sendMessage({
      from: "dev",
      to: ["tech-lead"],
      type: "HANDOFF",
      newThread: { subject: "handoff to the lead" },
      payload: { what: "the work is ready for you" },
    });
    assert.equal(sent.accepted, true, sent.reason);
    assert.equal(classOf(m, sent.messageId!), undefined);
    await waitFor("lead woken by unclassed handoff", () => acts(m, "tech-lead") > before);
  } finally {
    await m.cleanup();
  }
});
