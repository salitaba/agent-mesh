import { test } from "node:test";
import assert from "node:assert/strict";
import { describeReason } from "../../packages/core/src/supervisor";
import type { ActivationReason } from "../../packages/protocol/src/index";

/**
 * `describeReason` renders the one line under "## Why you were woken" — the
 * whole of what a seat is told about the thing that interrupted it. It is easy
 * to mistake for a log message and simplify back to a bare sentence; when that
 * happens a seat woken by a burst answers the head of the queue and leaves the
 * rest owed a turn each, which is exactly the cost the burst count exists to
 * avoid. So the wording is pinned rather than left to review.
 */

const reason = (r: Partial<ActivationReason> & { kind: ActivationReason["kind"] }): ActivationReason =>
  r as ActivationReason;

test("a mail wake names the thread and the note, because the note is where the depth rides", () => {
  // This is the shape `drainGathered` and the queued-mail path both produce:
  // the count is carried in `note`, so a renderer that drops the note silently
  // drops the only thing telling the seat it is behind.
  const text = describeReason(
    reason({
      kind: "message",
      threadId: "thread-7",
      note: "11 messages arrived together, not one — the others are in your mailbox below.",
    }),
  );

  assert.match(text, /New mail arrived/);
  assert.match(text, /thread-7/);
  assert.match(text, /11 messages arrived together/);
});

test("a mail wake with neither a thread nor a note still reads as a sentence", () => {
  const text = describeReason(reason({ kind: "message" }));
  assert.equal(text, "New mail arrived.");
});

test("a mail wake with only a thread does not render an empty note", () => {
  const text = describeReason(reason({ kind: "message", threadId: "thread-7" }));
  assert.equal(text, "New mail arrived in thread thread-7.");
});

test("every kind that carries a note renders it, and every kind reads as prose", () => {
  const cases: Array<[ActivationReason, RegExp]> = [
    [reason({ kind: "startup", note: "criteria gap" }), /Startup activation.*criteria gap/],
    [reason({ kind: "interest_event", eventType: "artifact.created", eventId: "e-1" }), /artifact\.created.*e-1/],
    [reason({ kind: "manual", note: "operator wake" }), /Manual activation: operator wake/],
    [reason({ kind: "recovery" }), /Recovery activation/],
    [reason({ kind: "timer" }), /Timeout wakeup/],
  ];

  for (const [r, want] of cases) {
    const text = describeReason(r);
    assert.match(text, want, `${r.kind} must describe itself`);
    assert.ok(text.length > 0 && !text.includes("undefined"), `${r.kind} must not leak a missing field: ${text}`);
  }
});

test("an unrecognised kind degrades to a sentence rather than an empty wake line", () => {
  // The switch has a `default` because the reason is deserialised from state;
  // an empty string here would put a seat in front of "## Why you were woken"
  // followed by nothing.
  assert.equal(describeReason(reason({ kind: "nonsense" as ActivationReason["kind"] })), "Activation.");
});
