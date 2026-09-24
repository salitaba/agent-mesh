import { test } from "node:test";
import assert from "node:assert/strict";
import { TurnTracker } from "../../packages/core/src/turn-tracker";

/**
 * A turn waiting on a tool is working, not frozen.
 *
 * The silence watchdog measures time since the last activity stamp, and
 * `noteToolFrame` is what stamps tool activity. The defect was in the producer:
 * `runtime-claude` pushed a `tool_call` frame when a call was ANNOUNCED and
 * nothing in the repo ever emitted `tool_call_update`, so a call stamped liveness
 * once, at its start, and never again. A single four-minute `Bash` run therefore
 * read as a turn that had gone quiet, and the watchdog killed it — ten times in
 * one live run, about 45 minutes of generation.
 *
 * Emitting the close frame fixes the common case (stamps at both ends), but not
 * the hard one: a tool that runs LONGER than the silence floor is still silent for
 * its whole duration. So the tracker also records which calls are outstanding, and
 * the watchdog skips a turn that is waiting on one. The turn timeout remains the
 * outer bound for a tool that never returns.
 */

function running(): { tracker: TurnTracker; turnId: string } {
  const tracker = new TurnTracker();
  const turnId = "turn-open-tool";
  tracker.push({ turnId, agentId: "dev", reason: { kind: "manual" }, startedAt: new Date().toISOString(), status: "running" } as never);
  return { tracker, turnId };
}

test("open tool calls: an announced call is outstanding until its update arrives", () => {
  const { tracker, turnId } = running();
  assert.equal(tracker.hasOpenToolCall(turnId), false, "nothing announced yet");

  tracker.noteToolFrame(turnId, { id: "call-1" });
  assert.equal(tracker.hasOpenToolCall(turnId), true, "a tool is running — this turn is working, not frozen");

  tracker.noteToolFrame(turnId, { id: "call-1", closed: true });
  assert.equal(tracker.hasOpenToolCall(turnId), false, "and once it returns the turn is answerable for its silence again");
});

test("open tool calls: concurrent calls are tracked by id, not by count", () => {
  // Backends interleave calls, so arrival order says nothing about which one
  // finished. Closing the first must not clear the second.
  const { tracker, turnId } = running();
  tracker.noteToolFrame(turnId, { id: "a" });
  tracker.noteToolFrame(turnId, { id: "b" });
  tracker.noteToolFrame(turnId, { id: "a", closed: true });
  assert.equal(tracker.hasOpenToolCall(turnId), true, "b is still running");
  tracker.noteToolFrame(turnId, { id: "b", closed: true });
  assert.equal(tracker.hasOpenToolCall(turnId), false);
});

test("open tool calls: a frame with no id still stamps activity, and opens nothing", () => {
  // Backwards compatible with any caller that does not know the id: the activity
  // stamp is the pre-existing behaviour and must not regress into a permanent
  // exemption just because an id was missing.
  const { tracker, turnId } = running();
  tracker.noteToolFrame(turnId);
  assert.equal(tracker.hasOpenToolCall(turnId), false, "no id means no claim to be waiting on anything");
  assert.ok((tracker.get(turnId)?.phases?.lastActivityAt ?? 0) > 0, "but the turn is still marked alive");
});

test("open tool calls: finishing a turn forgets what it was waiting on", () => {
  // Otherwise a turn that died mid-tool would leave its id behind forever, and
  // the map would be a slow leak on a long mission.
  const { tracker, turnId } = running();
  tracker.noteToolFrame(turnId, { id: "call-1" });
  assert.equal(tracker.hasOpenToolCall(turnId), true);
  tracker.finish(turnId, "dev", { status: "failed" }, new Date().toISOString());
  assert.equal(tracker.hasOpenToolCall(turnId), false, "a finished turn is waiting on nothing");
});

test("open tool calls: a turn that is not running cannot open one", () => {
  const { tracker, turnId } = running();
  tracker.finish(turnId, "dev", { status: "ok" }, new Date().toISOString());
  tracker.noteToolFrame(turnId, { id: "late" });
  assert.equal(tracker.hasOpenToolCall(turnId), false, "a late frame on a settled turn is ignored, as it always was");
});
