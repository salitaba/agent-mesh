import { test } from "node:test";
import assert from "node:assert/strict";
import { selectUnread } from "../../packages/core/src/context";
import type { MeshMessage } from "../../packages/protocol/src/index";

/**
 * The message that woke a seat must survive the mail window.
 *
 * `selectUnread` ranks band (obliging, then work-moving, then the rest) before
 * priority, so a NORMAL `INFORM` sits in the last band. At the `reduced` tier the
 * window is 6, and a mailbox holding six obliging messages filled it completely —
 * so the scheduler woke a seat FOR a message and then handed it a context that
 * did not contain it, with only a `dropped` count in the log to show for it.
 * Measured 2026-09-24: `mail: admitted=6 dropped=13` on a message-woken turn.
 *
 * Pinning is ahead of the URGENT reservation deliberately: URGENT is a sender's
 * claim about importance, while the trigger is the runtime's own statement about
 * why this turn exists, and a turn that cannot see its own cause is the more
 * basic incoherence.
 */

let seq = 0;
function msg(over: Partial<MeshMessage> = {}): MeshMessage {
  seq += 1;
  return {
    id: `msg-${seq}`,
    protocolVersion: "1.0",
    type: "INFORM",
    from: "pm",
    to: ["dev"],
    timestamp: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    priority: "NORMAL",
    payload: {},
    ...over,
  } as MeshMessage;
}

/** REQUEST obliges the recipient, which is band 0 — the band that crowds out mail. */
const obliging = (): MeshMessage => msg({ type: "REQUEST" });

test("the triggering message is admitted even when obliging mail fills the window", () => {
  const trigger = msg({ type: "INFORM", priority: "NORMAL" });
  const mail = [...Array.from({ length: 8 }, obliging), trigger];

  const withoutPin = selectUnread(mail, 6);
  assert.equal(
    withoutPin.some((m) => m.id === trigger.id),
    false,
    "precondition: unpinned, a NORMAL INFORM loses to a window of REQUESTs",
  );

  const withPin = selectUnread(mail, 6, trigger.id);
  assert.equal(withPin.length, 6, "pinning must not widen the window");
  assert.ok(
    withPin.some((m) => m.id === trigger.id),
    "the seat was woken for this message and must be shown it",
  );
});

test("pinning costs exactly one seat, and the rest of the ranking is unchanged", () => {
  const trigger = msg({ type: "INFORM", priority: "NORMAL" });
  const requests = Array.from({ length: 8 }, obliging);
  const mail = [...requests, trigger];

  const pinned = selectUnread(mail, 6, trigger.id);
  const others = pinned.filter((m) => m.id !== trigger.id);
  assert.equal(others.length, 5);
  // The five survivors are the same five the unpinned ranking would have put
  // first — pinning displaces the tail, not the ordering.
  const unpinnedTop5 = selectUnread(mail, 5).map((m) => m.id);
  assert.deepEqual(new Set(others.map((m) => m.id)), new Set(unpinnedTop5));
});

test("URGENT is still reserved alongside the trigger", () => {
  const trigger = msg({ type: "INFORM", priority: "NORMAL" });
  const urgent = msg({ type: "INFORM", priority: "URGENT" });
  const mail = [...Array.from({ length: 8 }, obliging), urgent, trigger];

  const kept = selectUnread(mail, 6, trigger.id);
  assert.ok(kept.some((m) => m.id === trigger.id), "trigger kept");
  assert.ok(kept.some((m) => m.id === urgent.id), "URGENT reservation still honoured");
});

test("an unknown or absent trigger id changes nothing", () => {
  const mail = Array.from({ length: 9 }, obliging);
  const baseline = selectUnread(mail, 6).map((m) => m.id);
  assert.deepEqual(selectUnread(mail, 6, "msg-does-not-exist").map((m) => m.id), baseline);
  assert.deepEqual(selectUnread(mail, 6, undefined).map((m) => m.id), baseline);
});

test("a mailbox that already fits is returned whole, pinned or not", () => {
  const mail = [obliging(), obliging()];
  assert.equal(selectUnread(mail, 6, mail[1]!.id).length, 2);
});
