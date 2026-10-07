import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub } from "../helpers";
import { ManualClock } from "../support/manual-clock";
import { floorWakeReason } from "../../packages/scheduler/src/index";
import type { MeshMessage, MeshOp } from "../../packages/protocol/src/index";

/**
 * The wake the floor under the wake gates raises says what is waiting and whether any of it asks anything.
 *
 * `STALE_MAIL_MS` buys a turn for mail that nothing else woke a seat for. Its note used to be one sentence about mail having waited,
 * and the seat it woke in the twentieth cronlite run (a QA with two announcements it had not subscribed to, nothing owed) read them,
 * wrote a status into its reply text, and ended the turn with `mesh_done`: the ending that closes a task the seat holds, and the one
 * the mesh then called "no work was produced … the watchdog will rotate to another driver" in the seat's memory. The scheduler knew
 * what the mail was when it raised the wake; the pure half below pins what it now says, the behavioural half pins that it is said on
 * the wake a real floor raises and that the turn is then described for what it was (`tests/core/floor-wake-readonly-turn.test.ts`
 * pins the other side of that).
 *
 * Runs on a ManualClock: the four minutes are advanced, not slept.
 */

const mail = (over: Partial<MeshMessage> & { id: string }): MeshMessage => ({
  type: "INFORM",
  timestamp: "2026-10-07T03:00:00.000Z",
  goalId: "goal-1",
  from: "pm",
  to: ["qa"],
  threadId: "thread-1",
  artifactRefs: [],
  payload: {},
  priority: "NORMAL",
  ...over,
});

const announcement = (id: string, from: string, type: MeshMessage["type"] = "INFORM") => mail({ id, from, type, control: { mode: "broadcast" } });

test("announcements only: the note names them by kind and sender, says none asks anything, and names the ending that fits", () => {
  const reason = floorWakeReason([announcement("m1", "pm"), announcement("m2", "tech-lead"), announcement("m3", "pm")]);
  assert.equal(reason.kind, "timer");
  assert.equal(reason.asksNothing, true, "the reason carries the verdict so the end of the turn can be described for what it was");
  const note = reason.note ?? "";
  assert.match(note, /^mail has been waiting unread and nothing you subscribe to woke you for it: /, "keeps the sentence the floor has always opened with");
  assert.match(note, /3 announcements \(INFORM\) from pm, tech-lead\./, "counts them, by kind, and names each sender once");
  assert.match(note, /None of it asks anything of you/);
  assert.match(note, /mesh_wait/, "names the ending");
  assert.match(note, /mesh_done closes a task you hold/, "and why the other one is the wrong one");
});

test("one message of its own kind is singular, and kinds are listed apart", () => {
  const reason = floorWakeReason([announcement("m1", "pm"), mail({ id: "m2", from: "architect", type: "DONE" })]);
  assert.equal(reason.asksNothing, true, "a DONE report asks nothing");
  assert.match(reason.note ?? "", /1 announcement \(INFORM\) from pm; 1 DONE from architect\./);
});

test("an ask in the box: the note says how many of the messages ask something, and the reason does not claim they ask nothing", () => {
  const reason = floorWakeReason([announcement("m1", "pm"), mail({ id: "m2", from: "developer", type: "REQUEST_REVIEW" })]);
  assert.equal(reason.asksNothing, undefined, "an ask is owed an answer; the turn is not a read-only one");
  const note = reason.note ?? "";
  assert.match(note, /1 announcement \(INFORM\) from pm; 1 REQUEST_REVIEW from developer\./);
  assert.match(note, /1 of 2 ask something of you: answer those first\./);
  assert.doesNotMatch(note, /None of it asks anything of you/);
  assert.doesNotMatch(note, /mesh_wait/, "no advice to end empty-handed over a request");
});

test("work handed over, the operator's mail and interrupt-class mail all count as asking", () => {
  for (const [what, m] of [
    ["a HANDOFF", mail({ id: "m1", from: "architect", type: "HANDOFF" })],
    ["a failed test result", mail({ id: "m2", from: "qa", type: "TEST_RESULT", payload: { result: "FAILED" } })],
    ["the operator's INFORM", mail({ id: "m3", from: "human" })],
    ["an INFORM the sender classed interrupt", mail({ id: "m4", control: { delivery: "interrupt" } })],
  ] as const) {
    const reason = floorWakeReason([announcement("m0", "pm"), m]);
    assert.equal(reason.asksNothing, undefined, `${what} asks something`);
    assert.match(reason.note ?? "", /1 of 2 ask something of you/, what);
  }
});

test("a passed test result is a report and asks nothing", () => {
  const reason = floorWakeReason([mail({ id: "m1", from: "qa", type: "TEST_RESULT", payload: { result: "PASSED" } })]);
  assert.equal(reason.asksNothing, true);
});

test("senders are named up to a bound and the rest are counted", () => {
  const senders = ["a", "b", "c", "d", "e", "f"];
  const reason = floorWakeReason(senders.map((s, i) => announcement(`m${i}`, s)));
  assert.match(reason.note ?? "", /6 announcements \(INFORM\) from a, b, c, d and 2 more\./);
});

test("the floor's own wake: a seat that holds nothing but announcements is woken with a note that says so, and its turn is described as a read", async () => {
  const STALE_MAIL_MS = 240_000; // packages/scheduler/src/index.ts, not exported
  const WAIT_WAKEUP_MS = 10_000;
  const clock = new ManualClock(Date.now());
  const m = await makeMesh({
    agents: [
      { id: "architect", role: "architect", interests: ["goal.escalated"] },
      { id: "qa", role: "qa", interests: [] },
    ],
    mayContact: { architect: ["qa"] },
    startup: [],
    clock,
    waitWakeupMs: WAIT_WAKEUP_MS,
    // Out of reach, as in `broadcast-reach.test.ts`: the supervisor's own stall watchdog would otherwise wake the seat first.
    stallIdleMs: 3_600_000,
  });
  try {
    stub(m).setScript("qa", async () => ({ operations: [{ op: "wait", reason: "nothing for me yet" } as MeshOp] }));
    const sentAt = clock.nowMs();
    const sent = await m.supervisor.executeOp(
      "architect",
      { op: "broadcast", type: "INFORM", payload: { note: "the API contract is frozen" } } as MeshOp,
      { turnId: "t-architect", agentId: "architect", reason: { kind: "manual" }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] } as never,
    );
    assert.equal(sent.ok, true, sent.reason);

    await clock.advanceAndSettle(STALE_MAIL_MS + WAIT_WAKEUP_MS);

    const turn = m.supervisor.getRecentTurns(1000).find((t) => t.agentId === "qa" && Date.parse(t.startedAt) >= sentAt);
    assert.ok(turn, "the floor bought the seat a turn");
    assert.equal(turn.reason.kind, "timer");
    assert.equal(turn.reason.asksNothing, true);
    assert.match(String(turn.reason.note), /1 announcement \(INFORM\) from architect\. None of it asks anything of you/);
    assert.match(String(turn.summary), /^read the mail that had been waiting — none of it asked anything of you/, "the turn that read and waited is not called idle work");
    assert.doesNotMatch(String(turn.summary), /no work was produced/);
  } finally {
    await m.cleanup();
  }
});
