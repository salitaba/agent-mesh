import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, type TestMesh } from "../helpers";
import { summarize } from "../../packages/observability/src/index";
import type { MeshEvent, MeshOp } from "../../packages/protocol/src/index";

/**
 * An activation denial must read differently from a refused send
 * (NOTES-test-gaps.md §5.5).
 *
 * Both land as `message.rejected`. A refused send carries `to` and `type` —
 * there was a message, and it did not leave. An activation denial comes from
 * `Supervisor.reportActivationDenied` through `denied()`: `from` is the seat
 * that could not be WOKEN, `action` is `activate (<reason kind>)`, and there is
 * no message, no recipient and no type. `summarize` renders every
 * `message.rejected` as `${from} blocked: ${reason}`, dropping `action`, so the
 * feed says a seat's message was blocked when in fact the seat was never
 * allowed to run. (The dashboard compounds it: `format.ts` labels the type
 * "blocked message" and `events.tsx` prints "Couldn't deliver — …" for both;
 * those are .tsx/DOM-side and outside what node:test compiles here.)
 *
 * Both events are produced by the real paths, not hand-built, so a change to
 * either payload is exercised here too.
 */

const DONE = { operations: [{ op: "done" } as MeshOp] };

async function bothRejections(): Promise<{ m: TestMesh; activation: MeshEvent; send: MeshEvent }> {
  const m = await makeMesh({
    agents: [
      // A service seat activates on requests only; an interest event is
      // refused by policy (`service-mode`), and that refusal is reported.
      { id: "indexer", role: "developer", mode: "service", interests: ["dependency.changed"] },
      { id: "dev", role: "developer", interests: [] },
      { id: "qa", role: "qa", interests: [] },
    ],
    // dev may contact nobody, so dev → qa is a policy-refused send.
    mayContact: { dev: [], qa: [], indexer: [] },
    startup: [],
  });
  for (const id of ["indexer", "dev", "qa"]) stub(m).setScript(id, async () => DONE);

  await m.kernel.emit("dependency.changed", { files: ["package.json"], summary: "lodash 4 → 5" }, { actorId: "dev" });
  const sent = await m.supervisor.sendMessage({ from: "dev", to: ["qa"], type: "INFORM", newThread: { subject: "fyi" }, payload: { note: "hello" } });
  assert.equal(sent.accepted, false, "precondition: the send is refused by the communication policy");

  const rejected = async () => (await m.store.read()).filter((e) => e.type === "message.rejected");
  await waitFor("both rejections to be logged", async () => (await rejected()).length >= 2, 5000);
  const all = await rejected();
  const activation = all.find((e) => String((e.payload as { action?: unknown }).action ?? "").startsWith("activate ("));
  const send = all.find((e) => Array.isArray((e.payload as { to?: unknown }).to));
  assert.ok(activation, `precondition: an activation denial was logged: ${JSON.stringify(all.map((e) => e.payload))}`);
  assert.ok(send, `precondition: a refused send was logged: ${JSON.stringify(all.map((e) => e.payload))}`);
  return { m, activation, send };
}

test("activation denial: the refused send still reads as a blocked message from its sender (control)", async () => {
  const { m, send } = await bothRejections();
  try {
    const line = summarize(send);
    assert.match(line, /^dev\b/, line);
    assert.match(line, /blocked/, line);
  } finally {
    await m.cleanup();
  }
});

test(
  "activation denial: the feed line says the seat could not be activated, not that a message was blocked",
  async () => {
    const { m, activation, send } = await bothRejections();
    try {
      // The policy's own sentence is stripped before matching: this one
      // ("service agents activate on requests only") happens to contain the
      // word, and a line that is only right by accident of the reason text is
      // not a line that distinguishes the two kinds.
      const withoutReason = (e: MeshEvent) =>
        summarize(e).split(String((e.payload as { reason?: unknown }).reason ?? "").slice(0, 80)).join("");
      const a = withoutReason(activation);
      const s = withoutReason(send);
      // Least opinionated: the line must carry what the payload already says
      // happened. `action` is `activate (interest_event)`; any rendering that
      // mentions activation/waking satisfies this, whatever its wording.
      assert.match(a, /activat|wake|woken/i, `activation denial rendered as: ${summarize(activation)}`);
      assert.doesNotMatch(s, /activat|wake|woken/i, `and a refused send must not borrow that wording: ${summarize(send)}`);
    } finally {
      await m.cleanup();
    }
  },
);
