import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor } from "../helpers";
import type { MeshOp, MessageType } from "../../packages/protocol/src/index";
import type { MeshInstance } from "../../apps/mesh-server/src/index";

/**
 * The verdict half of work movement, and the bug that used to be here.
 *
 * `delivery-work-movement.test.ts` closed the hole where HANDOFF, DELEGATE and
 * PATCH_READY fell to `accrue` -- work moved to a seat nobody woke. The fix
 * asked `movesWork(message.type)`, a function of the TYPE ALONE, and for two
 * types that is not enough to answer with: `TEST_RESULT` and
 * `SECURITY_FINDING` are each `{ result: "PASSED" | "FAILED" }`, the same word
 * for opposite events. So the identical failure survived one layer down.
 *
 * It had a DOCUMENTED path running through it. `roles/developer.md` tells the
 * developer to publish, `send (PATCH_READY) to qa`, then `wait`. PATCH_READY
 * obliges nobody, so no `pendingRequests` entry opens; QA's verdict therefore
 * has no `replyTo` creditor and is not obliging either; and classed on the type
 * name it is not work movement. Every branch of the ladder declines it and it
 * lands on `accrue` -- never woken for, and excluded from the nudge sweep,
 * which chases only `interrupt`. The developer sat in WAITING holding a red
 * build while the mesh went quiet around it.
 *
 * The only thing that used to rescue this was the QA seat ALSO issuing a
 * `block` decision op -- prose-instructed in `roles/qa.md`, gated on the
 * `quality.block` authority, and available only on failure. The last test here
 * is that rescue, kept as a control: it passed before the fix and must keep
 * passing after it.
 *
 * Both sides of the line are held, because a fix that woke the seat for every
 * verdict would have bought back the wake-on-everything mesh that delivery
 * classes exist to replace: FAILED is delivered, PASSED is still accrued.
 */

const acts = (m: MeshInstance, id: string) => m.kernel.state.agents.get(id)?.state.activations ?? 0;
const classOf = (m: MeshInstance, id: string) => m.kernel.state.messages.get(id)?.control?.delivery;

function quiet(m: MeshInstance, ids: string[]): void {
  const s = stub(m);
  for (const id of ids) s.setScript(id, async () => ({ operations: [{ op: "done" } as MeshOp] }));
}

/** The shipped `mesh init` regime, with a window short enough to observe. */
const REGIME = { delivery: { classes: true, coalesceMs: 120 } };

const PAIR = [
  { id: "dev", role: "developer", interests: [] },
  { id: "qa", role: "qa", interests: [] },
];

/**
 * The documented happy path, run verbatim: the patch is ANNOUNCED rather than
 * asked about, which is what leaves the verdict with no creditor to be an
 * answer to.
 */
async function patchThenVerdict(verdict: MessageType, payload: Record<string, unknown>) {
  const m = await makeMesh({
    agents: PAIR,
    mayContact: { dev: ["qa"], qa: ["dev"] },
    waitWakeupMs: 200,
    bus: REGIME,
  });
  quiet(m, ["dev", "qa"]);

  const ready = await m.supervisor.sendMessage({
    from: "dev",
    to: ["qa"],
    type: "PATCH_READY",
    newThread: { subject: "patch ready for test" },
    payload: { what: "auth patch v1" },
  });
  assert.equal(ready.accepted, true, ready.reason);
  await waitFor("qa woken for the patch", () => acts(m, "qa") > 0);

  const before = acts(m, "dev");
  const back = await m.supervisor.sendMessage({
    from: "qa",
    to: ["dev"],
    type: verdict,
    threadId: m.kernel.state.messages.get(ready.messageId!)!.threadId,
    payload,
  });
  assert.equal(back.accepted, true, back.reason);
  return { m, before, back };
}

for (const type of ["TEST_RESULT", "SECURITY_FINDING"] as const) {
  test(`a FAILED ${type} hands work back, and the seat holding it is woken`, async () => {
    const { m, before, back } = await patchThenVerdict(type, { result: "FAILED", reason: "3 cases red" });
    try {
      // `deliver`, not `interrupt`: nobody owes an answer to a verdict, so
      // there is nothing to chase and no wake to bill the sender for.
      assert.equal(classOf(m, back.messageId!), "deliver", `a FAILED ${type} moves work`);
      await waitFor(`dev woken for the FAILED ${type}`, () => acts(m, "dev") > before);
    } finally {
      await m.cleanup();
    }
  });

  test(`a PASSED ${type} reports rather than moves work: still accrued`, async () => {
    const { m, before, back } = await patchThenVerdict(type, { result: "PASSED" });
    try {
      assert.equal(classOf(m, back.messageId!), "accrue", `a PASSED ${type} is a report`);
      await new Promise((r) => setTimeout(r, 1000));
      assert.equal(acts(m, "dev") - before, 0, `a PASSED ${type} must not buy a turn`);
    } finally {
      await m.cleanup();
    }
  });

  test(`a ${type} with no result at all is a report, and stays one`, async () => {
    const { m, before, back } = await patchThenVerdict(type, { note: "coverage is up 4 points" });
    try {
      assert.equal(classOf(m, back.messageId!), "accrue", "an absent result states no verdict");
      await new Promise((r) => setTimeout(r, 1000));
      assert.equal(acts(m, "dev") - before, 0, "prose about a test run must not buy a turn");
    } finally {
      await m.cleanup();
    }
  });
}

/**
 * An outcome nobody wrote a branch for.
 *
 * The predicate reads "present and not PASSED" rather than "equals FAILED"
 * precisely so a mesh that grows a third outcome gets the safe answer without
 * anyone remembering to extend a list.
 */
test("an outcome that is neither PASSED nor FAILED still hands work back", async () => {
  const { m, before, back } = await patchThenVerdict("TEST_RESULT", { result: "ERROR", reason: "runner crashed" });
  try {
    assert.equal(classOf(m, back.messageId!), "deliver");
    await waitFor("dev woken for the errored run", () => acts(m, "dev") > before);
  } finally {
    await m.cleanup();
  }
});

/**
 * The rescue that used to be the only one, kept as a control. If this ever
 * fails, the fixture has stopped being able to observe a wake and the negative
 * assertions above mean nothing.
 */
test("control: the BLOCK the role prompt asks for ON TOP of the verdict still wakes the developer", async () => {
  const { m, before, back } = await patchThenVerdict("BLOCK", { subject: "quality", reason: "3 cases red" });
  try {
    assert.equal(classOf(m, back.messageId!), "deliver", "BLOCK moves work");
    await waitFor("dev woken by the BLOCK", () => acts(m, "dev") > before);
  } finally {
    await m.cleanup();
  }
});
