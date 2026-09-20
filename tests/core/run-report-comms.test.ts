import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRunReport, renderRunReport } from "../../packages/core/src/run-report";
import { createInitialState, type DischargeRecord, type Projections, type RefusedSend } from "../../packages/core/src/state";
import type { Goal, InteractionMode, MeshMessage } from "../../packages/protocol/src/index";

/**
 * The run report's comms section.
 *
 * Every assertion here is about a fact the report could not previously carry:
 * mail that was delivered and never read, mail the box cap destroyed, a send
 * the mesh refused, an ask that left the ledger without an answer. The
 * section's whole design rule is that it costs an operator nothing when there
 * is nothing to act on, so the first test is that a talkative but clean
 * mission renders no section at all.
 */

const AT = "2026-02-01T00:00:00.000Z";
const GOAL_ID = "goal-1";

function seedGoal(state: Projections, id = GOAL_ID): Goal {
  const goal = { id, description: "ship it", status: "ACTIVE", createdAt: AT, acceptanceCriteria: [] } as unknown as Goal;
  state.goals.set(id, goal);
  state.activeGoalId = id;
  return goal;
}

let msgSeq = 0;
function seedMessage(
  state: Projections,
  over: Partial<MeshMessage> & { from: string; to: string[] },
  mode?: InteractionMode,
): MeshMessage {
  msgSeq++;
  const m = {
    id: over.id ?? `msg-${msgSeq}`,
    type: over.type ?? "INFORM",
    timestamp: AT,
    goalId: over.goalId ?? GOAL_ID,
    threadId: over.threadId ?? "thr-1",
    artifactRefs: [],
    payload: {},
    priority: "NORMAL",
    ...over,
    // `mode` lives on the runtime-owned envelope, never in payload -- the
    // report reads it there and nowhere else.
    ...(mode ? { control: { mode } } : {}),
  } as MeshMessage;
  state.messages.set(m.id, m);
  return m;
}

function refusal(over: Partial<RefusedSend> = {}): RefusedSend {
  return { from: "dev", to: ["qa"], type: "REQUEST_REVIEW", reason: "not permitted", at: AT, ...over };
}

let dischargeSeq = 0;
function discharge(over: Partial<DischargeRecord> & Pick<DischargeRecord, "reason">): DischargeRecord {
  dischargeSeq++;
  return {
    messageId: over.messageId ?? `ask-${dischargeSeq}`,
    from: "lead",
    to: ["dev"],
    type: "REQUEST_REVIEW",
    by: "system",
    at: AT,
    ...over,
  };
}

// --- the clean mission -----------------------------------------------------

test("a mission that talked a lot and lost nothing renders no comms section", () => {
  const state = createInitialState();
  seedGoal(state);
  for (let i = 0; i < 12; i++) seedMessage(state, { from: "lead", to: ["dev"] });

  const report = buildRunReport(state);
  const text = renderRunReport(report);

  // Nothing to act on, so nothing printed -- not even a header.
  assert.equal(text.includes("COMMS"), false);
  // ...but the numbers are still in the JSON for anyone measuring across runs.
  assert.equal(report.comms.volume.total, 12);
  assert.deepEqual(report.comms.volume.heaviestPair, { from: "lead", to: "dev", messages: 12 });
});

test("a mission with no traffic at all still produces a well-formed empty section", () => {
  const state = createInitialState();
  seedGoal(state);

  const { comms } = buildRunReport(state);
  assert.deepEqual(comms.volume, { total: 0, service: 0, collab: 0, broadcast: 0 });
  assert.equal("heaviestPair" in comms.volume, false);
  assert.deepEqual(comms.unread, []);
  assert.deepEqual(comms.dropped, []);
  assert.deepEqual(comms.refused, []);
  assert.deepEqual(comms.lostAsks, []);
});

// --- volume ----------------------------------------------------------------

test("traffic is split by interaction mode, and an absent mode reads as service", () => {
  const state = createInitialState();
  seedGoal(state);
  seedMessage(state, { from: "lead", to: ["dev"] }); // no control at all
  seedMessage(state, { from: "lead", to: ["dev"] }, "service");
  seedMessage(state, { from: "dev", to: ["qa"] }, "collab");
  seedMessage(state, { from: "lead", to: ["dev", "qa", "ops"] }, "broadcast");

  const { volume } = buildRunReport(state).comms;
  assert.equal(volume.total, 4);
  assert.equal(volume.service, 2);
  assert.equal(volume.collab, 1);
  assert.equal(volume.broadcast, 1);
});

test("a broadcast never contributes to the heaviest pair", () => {
  const state = createInitialState();
  seedGoal(state);
  // Three announcements to the whole roster would otherwise beat two real asks.
  for (let i = 0; i < 3; i++) seedMessage(state, { from: "lead", to: ["dev", "qa", "ops"] }, "broadcast");
  seedMessage(state, { from: "dev", to: ["qa"] });
  seedMessage(state, { from: "dev", to: ["qa"] });

  const { volume } = buildRunReport(state).comms;
  assert.deepEqual(volume.heaviestPair, { from: "dev", to: "qa", messages: 2 });
});

test("a self-addressed recipient is not a conversation", () => {
  const state = createInitialState();
  seedGoal(state);
  seedMessage(state, { from: "dev", to: ["dev", "qa"] });

  const { volume } = buildRunReport(state).comms;
  assert.equal(volume.total, 1);
  assert.deepEqual(volume.heaviestPair, { from: "dev", to: "qa", messages: 1 });
});

test("traffic is scoped to the goal being reported on", () => {
  const state = createInitialState();
  seedGoal(state);
  seedMessage(state, { from: "lead", to: ["dev"] });
  seedMessage(state, { from: "lead", to: ["dev"], goalId: "goal-other" });

  assert.equal(buildRunReport(state).comms.volume.total, 1);
});

// --- the findings ----------------------------------------------------------

test("a populated mission renders every comms line", () => {
  const state = createInitialState();
  seedGoal(state);
  seedMessage(state, { from: "lead", to: ["dev"] });
  seedMessage(state, { from: "lead", to: ["dev"] });
  seedMessage(state, { from: "lead", to: ["dev", "qa"] }, "broadcast");

  state.unread.set("qa", ["msg-a", "msg-b", "msg-c"]);
  state.unread.set("dev", ["msg-d"]);
  state.unread.set("ops", []); // an empty box is not a finding
  state.mailOverflowDropped.set("dev", 12);
  state.mailOverflowDropped.set("qa", 0); // nor is a zero counter
  state.refusedSends.push(refusal({ ruleId: "no-direct-qa" }));
  state.refusedSends.push(refusal({ reason: "unknown recipient", to: ["ops"], type: "INFORM" }));
  state.discharged.push(discharge({ reason: "evicted_cap" }));

  const text = renderRunReport(buildRunReport(state));

  assert.ok(text.includes("  COMMS"));
  assert.ok(text.includes("3 messages — 2 directed, 0 collab, 1 broadcast"));
  assert.ok(text.includes("heaviest lead → dev (2)"));
  assert.ok(text.includes("delivered and never read: qa 3, dev 1"));
  assert.ok(text.includes("destroyed by the mailbox cap: dev 12"));
  assert.ok(text.includes("policy rule no-direct-qa refused 1 send"));
  assert.ok(text.includes("protocol validation refused 1 send"));
  assert.ok(text.includes("1 ask was settled without an answer, and the asker was never told"));
  assert.ok(text.includes("lead → dev (REQUEST_REVIEW) — evicted_cap"));

  const { comms } = buildRunReport(state);
  // Empty boxes and zero counters never reach the report at all.
  assert.deepEqual(comms.unread.map((u) => u.agent), ["qa", "dev"]);
  assert.deepEqual(comms.dropped, [{ agent: "dev", messages: 12 }]);
});

test("any one finding alone is enough to print the section", () => {
  for (const seed of [
    (s: Projections) => s.unread.set("qa", ["msg-a"]),
    (s: Projections) => s.mailOverflowDropped.set("qa", 1),
    (s: Projections) => s.refusedSends.push(refusal()),
    (s: Projections) => s.discharged.push(discharge({ reason: "expired" })),
  ]) {
    const state = createInitialState();
    seedGoal(state);
    seed(state);
    assert.ok(renderRunReport(buildRunReport(state)).includes("  COMMS"));
  }
});

// --- policy vs protocol ----------------------------------------------------

test("a refusal with a ruleId is policy; without one it is protocol validation", () => {
  const state = createInitialState();
  seedGoal(state);
  state.refusedSends.push(refusal({ reason: "schema: to must be non-empty", to: [] }));
  state.refusedSends.push(refusal({ ruleId: "no-direct-qa" }));

  const { refused } = buildRunReport(state).comms;
  assert.equal(refused.length, 2);
  // Policy leads: it is the half an operator can actually change.
  assert.equal(refused[0].refusedBy, "policy");
  assert.equal(refused[0].rule, "no-direct-qa");
  assert.equal(refused[1].refusedBy, "protocol");
  assert.equal(refused[1].rule, undefined);
});

test("refusals group by rule and reason, and carry a real example pair", () => {
  const state = createInitialState();
  seedGoal(state);
  for (let i = 0; i < 4; i++) state.refusedSends.push(refusal({ ruleId: "no-direct-qa", from: `dev-${i}` }));
  state.refusedSends.push(refusal({ ruleId: "no-direct-qa", reason: "quota exhausted" }));

  const { refused } = buildRunReport(state).comms;
  assert.equal(refused.length, 2);
  assert.equal(refused[0].count, 4);
  assert.equal(refused[0].reason, "not permitted");
  // The example is the first refusal of its group, not an aggregate.
  assert.equal(refused[0].from, "dev-0");
  assert.deepEqual(refused[0].to, ["qa"]);
  assert.equal(refused[1].count, 1);
  assert.equal(refused[1].reason, "quota exhausted");

  const text = renderRunReport(buildRunReport(state));
  assert.ok(text.includes("policy rule no-direct-qa refused 4 sends — e.g. dev-0 → qa (REQUEST_REVIEW): not permitted"));
});

// --- lost asks -------------------------------------------------------------

test("only discharges the asker was never told about count as lost", () => {
  const state = createInitialState();
  seedGoal(state);
  for (const reason of ["evicted_cap", "deadlock_break", "expired", "refused_cap"] as const) {
    state.discharged.push(discharge({ reason, messageId: `lost-${reason}` }));
  }
  // A refusal IS an answer: the debtor said no and the asker heard it. So is a
  // reply, and so is an inferred in-thread settlement.
  state.discharged.push(discharge({ reason: "refused", messageId: "answered-refused" }));
  state.discharged.push(discharge({ reason: "reply", messageId: "answered-reply" }));
  state.discharged.push(discharge({ reason: "in_thread", messageId: "answered-in-thread" }));

  const { lostAsks } = buildRunReport(state).comms;
  assert.deepEqual(
    lostAsks.map((a) => a.id),
    ["lost-evicted_cap", "lost-deadlock_break", "lost-expired", "lost-refused_cap"],
  );
});

test("a long run of lost asks is truncated in text but kept whole in the data", () => {
  const state = createInitialState();
  seedGoal(state);
  for (let i = 0; i < 7; i++) state.discharged.push(discharge({ reason: "evicted_cap", messageId: `lost-${i}` }));

  const report = buildRunReport(state);
  assert.equal(report.comms.lostAsks.length, 7);
  const text = renderRunReport(report);
  assert.ok(text.includes("7 asks were settled without an answer"));
  assert.ok(text.includes("(+2 more)"));
});

// --- the report as a whole -------------------------------------------------

test("comms is a top-level key and survives a JSON round trip", () => {
  const state = createInitialState();
  seedGoal(state);
  seedMessage(state, { from: "lead", to: ["dev"] }, "collab");
  state.unread.set("dev", ["msg-a"]);

  const report = buildRunReport(state);
  // A sibling of `unfinished` and `spend`: communication cost is a different
  // question from unfinished work.
  assert.ok("comms" in report);
  assert.equal("comms" in report.unfinished, false);
  assert.deepEqual(JSON.parse(JSON.stringify(report)).comms, report.comms);
});

// --- alias rewrites --------------------------------------------------------

/**
 * The precondition for ever retiring the alias tables is "the counters read
 * zero on a real mesh". Two things follow, and they pull in opposite
 * directions on this surface:
 *
 *   - the JSON has to carry the number even when it is zero, or there is
 *     nothing to measure across runs;
 *   - the TEXT must not open a section for a zero, because a COMMS header over
 *     nothing is how a report trains people to skip it.
 *
 * Hence `aliases` is a finding on the way out and not a reason to print.
 */

test("aliases: a supplied zero is carried in the JSON but prints no section", () => {
  // The gate is `total > 0`, not "the caller supplied stats". Supplying the
  // field is how a caller reports; it is not itself a finding.
  const state = createInitialState();
  seedGoal(state);
  const report = buildRunReport(state, undefined, { aliases: { total: 0, byRewrite: [] } });
  assert.deepEqual(report.comms.aliases, { total: 0, byRewrite: [] }, "the zero is the measurement");
  const text = renderRunReport(report);
  assert.ok(!text.includes("  COMMS"), "a zero rewrite count is not a finding");
  assert.ok(!text.includes("alias"));
});

test("aliases: absent when the caller supplied none", () => {
  const state = createInitialState();
  seedGoal(state);
  assert.equal(buildRunReport(state).comms.aliases, undefined, "no caller, no claim");
});

test("aliases: a non-zero count prints the tables that caught it", () => {
  const state = createInitialState();
  seedGoal(state);
  const report = buildRunReport(state, undefined, {
    aliases: { total: 3, byRewrite: [{ rewrite: "op:mesh_send->send", count: 2 }, { rewrite: "type:REPLY->INFORM", count: 1 }] },
  });
  const text = renderRunReport(report);
  assert.ok(text.includes("  COMMS"), "a seat inventing names is something an operator can act on");
  assert.ok(text.includes("3 prose rewrites"), text);
  assert.ok(text.includes("op:mesh_send->send x2"), "the rewrite names the invented spelling, not just a count");
});

test("aliases: a round trip through JSON keeps the count", () => {
  const state = createInitialState();
  seedGoal(state);
  const report = buildRunReport(state, undefined, { aliases: { total: 1, byRewrite: [{ rewrite: "op:mesh_send->send", count: 1 }] } });
  const back = JSON.parse(JSON.stringify(report)) as typeof report;
  assert.equal(back.comms.aliases?.total, 1);
  assert.equal(back.comms.aliases?.byRewrite[0]?.rewrite, "op:mesh_send->send");
});
