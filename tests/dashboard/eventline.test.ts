import test from "node:test";
import assert from "node:assert/strict";

import { LINE_MAX, eventHaystack, eventLine, eventNames, lineText, verdictDone, verdictSubject, type LineEvent } from "../../apps/mesh-dashboard/src/eventmodel";
import { plainEvent } from "../../apps/mesh-dashboard/src/format";
import { EVENT_TYPES } from "../../packages/protocol/src/catalog";

/**
 * One event, one line: who did what, in the console's words. The Overview's "Just happened", the Events console, its detail pane
 * and both drawers read it from `eventLine`, so these pin it once for all of them. The evidence it replaces: ten rows of "agent
 * created / agent created", "finished / finished", "remembered / remembered", "spent / spent 1.8k", and drawers that printed
 * "developer THINKING → IDLE · turn-3dc…bb5a".
 */

const G = "goal-M48WBJYS00099bf9ac9b";
const ART = "art-M48WD20T003a31be8089";
const PATCH = "art-M48WD4V2005598786625";
const TASK = "task-M48WD21K00e963f17356";
const MSG = "msg-M48WD1XH00145c0a6523";
const LEASE = "lease-M48WD24200cff5247a40";
const THREAD = "thread-M48WD20T0083ee1421ee";
const TURN = "turn-3dc685942b0fbb5a";

/** What an event says when the console has seen the events that name its ids. */
const NAMES = new Map<string, string>([
  [ART, "payment-architecture"], [PATCH, "patch-tx-pipeline-2"], [TASK, "implement payment pipeline"],
  [MSG, "pm's message (new task)"], [LEASE, "src/tx/Pipeline.java"], [THREAD, "review payment-architecture v1"], ["dec-1", "use npm"],
  ["art-M48WD57K009d88c524b3", "release-plan"],
]);
const nameOf = (id: string): string | undefined => NAMES.get(id);

/** A realistic payload for every type in the catalog, shaped like the demo run's log (`curule init --example demo-stub`). */
const FIXTURES: Record<string, Omit<LineEvent, "type">> = {
  "goal.created": { actorId: "human", payload: { goal: { id: G, description: "Build and ship a small idempotent payment endpoint.", acceptanceCriteria: [{ id: "a", mandatory: true }, { id: "b", mandatory: true }, { id: "c", mandatory: false }] } } },
  "goal.budget_changed": { actorId: "human", payload: { goalId: G, budget: { wallClockMinutes: 480 }, reason: "operator raise from escalation" } },
  "goal.status_changed": { actorId: "termination-manager", payload: { goalId: G, status: "ACTIVE", reason: "all escalations resolved" } },
  "goal.paused": { actorId: "human", payload: { goalId: G, reason: "user pause" } },
  "goal.resumed": { actorId: "human", payload: { goalId: G, reason: "user resume" } },
  "goal.progress": { payload: { completed: 3, total: 7, ratio: 3 / 7 } },
  "goal.completed": { actorId: "termination-manager", payload: { goalId: G, reason: "all_mandatory_criteria_evidenced", evidence: [] } },
  "goal.reopened": { actorId: "human", payload: { goalId: G, reason: "tests fail on 0-7" } },
  "goal.escalated": { actorId: "termination-manager", payload: { goalId: G, reason: "wall_clock_exceeded" } },
  "goal.failed": { actorId: "termination-manager", payload: { goalId: G, reason: "runtime_failure" } },
  "goal.description_revised": { actorId: "human", payload: { goalId: G, description: "Ship the endpoint with retries.", previous: "Ship it." } },
  "requirements.created": { actorId: "pm", payload: { criteria: [{ id: "req-analysis" }, { id: "req-payments-idempotency" }], artifactId: ART } },
  "requirement.blocked": { actorId: "human", payload: { criterionId: "quality-verified", reason: "withdrawn by the reopen: tests fail on 0-7" } },
  "requirement.satisfied": { actorId: "tech-lead", payload: { criterionId: "architecture-approved", evidence: { kind: "architecture-approved", by: "tech-lead", verified: true }, verified: true } },
  "requirement.revised": { actorId: "human", payload: { criterionId: "quality-verified", mandatory: false } },
  "requirement.removed": { actorId: "human", payload: { criterionId: "security-verified", reason: "no security seat" } },
  "agent.created": { actorId: "human", payload: { agent: { id: "pm", role: "product-manager" } } },
  "agent.started": { actorId: "pm", payload: { agentId: "pm", sessionId: null, runtime: "stub" } },
  "agent.awakened": { actorId: "tech-lead", payload: { agentId: "tech-lead", reason: { kind: "message", messageId: MSG, eventType: "message.sent" }, turnId: TURN } },
  "agent.state_changed": { actorId: "developer", payload: { agentId: "developer", from: "THINKING", to: "IDLE", turnId: TURN } },
  "agent.suspended": { actorId: "human", payload: { agentId: "developer" } },
  "agent.resumed": { actorId: "human", payload: { agentId: "developer" } },
  "agent.completed": { actorId: "termination-manager", payload: { agentId: "developer" } },
  "agent.failed": { actorId: "developer", payload: { agentId: "developer", error: "the provider answered 500", turnId: TURN } },
  "agent.restarted": { actorId: "recovery-manager", payload: { agentId: "developer", attempt: 2 } },
  "agent.replaced": { actorId: "human", payload: { agentId: "developer", agent: { id: "developer" } } },
  "agent.retired": { actorId: "human", payload: { agentId: "explorer", reason: "not needed for this mission" } },
  "agent.mute_suspected": { actorId: "developer", payload: { agentId: "developer", meshBridgeAttached: false, servers: [], sessionId: "s-1" } },
  "session.rotation_pending": { actorId: "developer", payload: { agentId: "developer", transcriptTokens: 210000, thresholdTokens: 200000, reason: "rotation" } },
  "session.rotated": { actorId: "developer", payload: { agentId: "developer", sessionOrdinal: 3, transcriptTokensDiscarded: 210000 } },
  "continuity.recorded": { actorId: "developer", payload: { agentId: "developer", sessionOrdinal: 2, nextIntent: "finish the retry tests", openCommitments: [{}] } },
  "thread.created": { actorId: "architect", payload: { thread: { id: THREAD, subject: "review payment-architecture v1", initiator: "architect", participants: ["architect", "tech-lead"] } } },
  "message.sent": { actorId: "pm", payload: { message: { id: MSG, type: "MISSION", from: "pm", to: ["architect"], payload: { note: "Design the architecture for the mission goal." } } } },
  "message.delivered": { actorId: "architect", payload: { agentId: "architect", messageId: MSG, turnId: TURN } },
  "message.rejected": { actorId: "pm", payload: { from: "pm", action: "activate (interest_event)", reason: "mission is completed", ruleId: "goal-halted" } },
  "artifact.created": { actorId: "pm", payload: { artifact: { id: ART, name: "payment-requirements", type: "RequirementsDoc", version: 1, createdBy: "pm" } } },
  "artifact.versioned": { actorId: "developer", payload: { artifact: { id: PATCH, name: "patch-tx-pipeline-2", type: "CodePatch", version: 2, createdBy: "developer" } } },
  "artifact.transition": { actorId: "system", payload: { artifactId: ART, from: "UNDER_REVIEW", to: "APPROVED", derived: true } },
  "task.created": { actorId: "tech-lead", payload: { task: { id: TASK, title: "implement payment pipeline", createdBy: "tech-lead" } } },
  "task.claimed": { actorId: "developer", payload: { taskId: TASK, agentId: "developer" } },
  "task.completed": { actorId: "developer", payload: { taskId: TASK, agentId: "developer", summary: "pipeline implemented and tested" } },
  "review.requested": { actorId: "architect", payload: { artifactId: ART, artifactRef: "artifact://ArchitectureDocument/payment-architecture/1", reviewers: ["tech-lead"], subject: { question: "Validate idempotency strategy." } } },
  "review.approved": { actorId: "tech-lead", payload: { subject: `artifact:${ART}`, kind: "approve", artifactId: ART, artifactRef: { uri: "artifact://ArchitectureDocument/payment-architecture/1" }, actorId: "tech-lead", comment: "sound design" } },
  "review.rejected": { actorId: "qa", payload: { subject: `artifact:${PATCH}`, kind: "reject", artifactId: PATCH, actorId: "qa", comment: "replay test fails" } },
  "patch.created": { actorId: "developer", payload: { artifactId: PATCH, name: "patch-tx-pipeline-2" } },
  "patch.ready": { actorId: "developer", payload: { artifactId: PATCH, artifactRef: "artifact://CodePatch/patch-tx-pipeline-2/2", messageId: MSG } },
  "patch.merged": { actorId: "tech-lead", payload: { artifactId: PATCH, name: "patch-tx-pipeline-2" } },
  "architecture.approved": { actorId: "tech-lead", payload: { subject: "architecture", artifactId: ART, actorId: "tech-lead", derived: true } },
  "design.question": { actorId: "architect", payload: { question: "Should retries share the idempotency key?", artifactId: ART } },
  "dependency.changed": { actorId: "developer", payload: { artifactId: PATCH, commit: "a18cae973bf698354b763c4f26fc289f6838f349" } },
  "authentication.changed": { actorId: "developer", payload: { artifactId: PATCH } },
  "authorization.changed": { actorId: "developer", payload: { artifactId: PATCH } },
  "release.candidate": { actorId: "architect", payload: { artifactId: "art-M48WD57K009d88c524b3", name: "release-plan" } },
  "release.transition": { payload: { artifactId: "art-M48WD57K009d88c524b3", to: "QA_VERIFIED" } },
  "release.accepted": { payload: { artifactId: "art-M48WD57K009d88c524b3", subject: "artifact:art-M48WD57K009d88c524b3" } },
  "research.requested": { actorId: "architect", payload: { question: "analyze existing payment service boundaries", messageId: MSG } },
  "research.completed": { actorId: "explorer", payload: { artifactId: ART, name: "payment-boundaries", inReplyTo: MSG } },
  "implementation.completed": { actorId: "tech-lead", payload: { artifactId: PATCH, subject: "implementation", actorId: "developer" } },
  "decision.proposed": { actorId: "architect", payload: { decision: { id: "dec-1", topic: "use npm" } } },
  "decision.ratified": { actorId: "tech-lead", payload: { decisionId: "dec-1", approvedBy: ["tech-lead"] } },
  "escalation.requested": { actorId: "termination-manager", payload: { escalation: { id: "esc-1", reason: "wall_clock_exceeded", raisedBy: "termination-manager" } } },
  "escalation.responded": { actorId: "human", payload: { escalationId: "esc-1", response: "raise it to 8 hours", respondedBy: "human" } },
  "escalation.auto_resolved": { actorId: "recovery-manager", payload: { escalationId: "esc-1", reason: "auto-resolved: the mesh restarted, and no provider breaker is holding it now" } },
  "deadlock.auto_resolved": { actorId: "deadlock-detector", payload: { kind: "circular_wait", participants: ["pm", "qa"], voidedRequestId: MSG, voidedBy: "pm", voidedTo: ["qa"] } },
  "commitment.discharged": { actorId: "tech-lead", payload: { messageId: MSG, reason: "reply", by: "tech-lead", from: "architect", to: ["tech-lead"], requestType: "REQUEST_REVIEW" } },
  "collab.opened": { actorId: "pm", payload: { session: { threadId: THREAD, topic: "release scope", participants: ["pm", "qa"], openedBy: "pm" } } },
  "collab.closed": { actorId: "system", payload: { threadId: THREAD, reason: "expired", exchanges: 4, maxExchanges: 6, outcome: "ship v1 without retries" } },
  "human.input": { actorId: "human", payload: { action: "escalation_response", escalationId: "esc-1", response: "go" } },
  "lease.acquired": { actorId: "developer", payload: { lease: { id: LEASE, artifactId: PATCH, agentId: "developer", files: ["src/tx/Pipeline.java"] } } },
  "lease.released": { actorId: "developer", payload: { leaseId: LEASE } },
  "memory.updated": { actorId: "developer", payload: { agentId: "developer", note: { key: `turn:${TURN}`, value: "landed this turn: 1 artifact published, 1 commit, 1 message sent — ⚠ commit: 4f1c… is not on main" } } },
  "context.assembled": { actorId: "developer", payload: { agentId: "developer", usedTokens: 4653, budgetTokens: 9000, tier: "full", slots: [{ slot: "mail", dropped: 2 }] } },
  "turn.discarded": { actorId: "developer", payload: { agentId: "developer", turnId: TURN, reason: "all_rejected", tokens: 3200 } },
  "plan.updated": { actorId: "developer", payload: { agentId: "developer", plan: { revision: 2, steps: [{ id: "s1", status: "DONE" }, { id: "s2", status: "TODO" }] } } },
  "plan.gate_rejected": { actorId: "developer", payload: { agentId: "developer", op: "commit", mode: "enforce", reason: "the plan has no step for this file" } },
  "budget.reserved": { actorId: "pm", payload: { key: `agent:${G}/pm`, limitKind: "tokens", limit: 200000, amount: 32000, requested: 32000 } },
  "budget.consumed": { actorId: "qa", payload: { key: `mission:${G}`, limitKind: "tokens", limit: 2000000, amount: 1800, agentId: "qa", turnId: TURN } },
  "budget.exceeded": { actorId: "qa", payload: { key: `agent:${G}/qa`, limit: 200000, consumed: 205000 } },
  "budget.released": { actorId: "pm", payload: { key: `mission:${G}`, reservationId: "res-1" } },
  "budget.limit_raised": { actorId: "qa", payload: { key: `agent:${G}/qa`, limitKind: "tokens", limit: 400000, previous: 200000, decidedBy: "auto" } },
};

const text = (type: string, extra: Omit<LineEvent, "type"> = FIXTURES[type]!, names = nameOf): string => lineText(eventLine({ type, ...extra }, names));

/** What a line must never show: a code, an internal id, or a value that was not there. */
function smells(t: string): string[] {
  const out: string[] = [];
  if (/undefined|null|NaN|\[object/.test(t)) out.push("a missing value");
  if (/\b[A-Z]{2,}_[A-Z_]+\b|\b(?:STARTING|IDLE|THINKING|WORKING|WAITING|OBSERVING|APPROVED|MERGED|ACTIVE|MISSION|INFORM)\b/.test(t)) out.push("an UPPER_CASE enum");
  if (/\b[a-z]+_[a-z_]+\b/.test(t)) out.push("a snake_case code");
  if (/\b(?:art|turn|msg|task|lease|thread|res|evt|goal)-[A-Za-z0-9]{8,}/.test(t)) out.push("an opaque id");
  if (/\b[a-z]+\.[a-z_]+\b/.test(t)) out.push("a dotted event type");
  return out;
}

test("every type in the catalog has a line, so a new type fails here until it is given one", () => {
  assert.deepEqual(Object.keys(FIXTURES).sort(), [...EVENT_TYPES].sort());
});

test("every type's line says more than its label, in words, inside the line length", () => {
  for (const type of EVENT_TYPES) {
    const t = text(type);
    assert.notEqual(t, plainEvent(type, FIXTURES[type]!.payload), `${type}: the line is only its label`);
    assert.deepEqual(smells(t), [], `${type}: "${t}"`);
    assert.ok(t.length <= LINE_MAX, `${type} is ${t.length} characters: "${t}"`);
  }
});

test("a payload too thin to say more falls back to the label, never to 'undefined', and a malformed one does not throw", () => {
  for (const type of EVENT_TYPES) {
    for (const payload of [{}, undefined, null, "a string", { message: { to: "pm" }, agent: 3, steps: "x" }]) {
      const t = lineText(eventLine({ type, payload }));
      assert.ok(t.length > 0, `${type} with ${JSON.stringify(payload)} says nothing`);
      assert.doesNotMatch(t, /undefined|null|NaN|\[object/, `${type} with ${JSON.stringify(payload)}: "${t}"`);
    }
  }
  assert.equal(text("agent.created", { payload: {} }), "agent created");
  assert.equal(text("budget.consumed", { payload: { key: `mission:${G}` } }), "spent", "no amount: nothing to say but the label");
});

test("the lines the audit found saying nothing now say who and what", () => {
  assert.equal(text("agent.created"), "pm joined the team as product-manager");
  assert.equal(text("agent.created", { payload: { agent: { id: "architect", role: "architect" } } }), "architect joined the team", "a role that is the seat's name is not said twice");
  assert.equal(text("agent.created", { payload: { agent: { id: "human", role: "human" } } }), "you joined the team as its operator");
  assert.equal(text("agent.completed"), "developer is done with the mission");
  assert.equal(text("agent.completed", { actorId: "human", payload: { agentId: "worker-1" } }), "worker-1 finished its work");
  assert.equal(text("memory.updated"), "developer noted what its turn did: 1 artifact published, 1 commit, 1 message sent");
  assert.equal(text("memory.updated", { actorId: "pm", payload: { agentId: "pm", note: { key: "decision:retries", value: "x" } } }), "pm saved a note: decision:retries");
  assert.equal(text("budget.consumed"), "qa spent 1.8k tokens of the mission budget");
  assert.equal(text("requirement.satisfied"), "check architecture-approved met, on evidence from tech-lead");
  assert.equal(text("goal.created"), "mission: Build and ship a small idempotent payment endpoint. · 2 checks", "only mandatory checks are counted, as on the Overview");
  assert.equal(text("goal.completed"), "mission complete: every mandatory check is evidenced");
  assert.equal(text("goal.progress"), "3 of 7 checks done");
});

test("the drawers' kernel dialect is gone: no raw state, no turn id, no event type", () => {
  assert.equal(text("agent.state_changed"), "developer is now idle");
  assert.equal(text("agent.state_changed", { actorId: "qa", payload: { agentId: "qa", to: "FAILED" } }), "qa crashed");
  assert.equal(text("agent.awakened"), "tech-lead woke up — a new message");
  assert.equal(text("agent.awakened", { actorId: "qa", payload: { agentId: "qa", reason: { kind: "interest_event", eventType: "patch.ready" } } }), "qa woke up after “patch ready”");
  assert.equal(text("agent.awakened", { actorId: "dev", payload: { agentId: "dev", reason: { kind: "timer", note: "your patch merged; close out the task" } } }), "dev woke up — follow-up nudge: your patch merged; close out the task");
  assert.equal(text("agent.awakened", { actorId: "pm", payload: { agentId: "pm" } }), "pm woke up", "no reason recorded: none is invented");
  assert.equal(text("agent.state_changed", { actorId: "pm", payload: { agentId: "pm", to: "OBSERVING" } }), "pm is now reading its inbox");
  for (const type of ["agent.state_changed", "agent.awakened", "budget.consumed", "memory.updated", "message.delivered", "turn.discarded"]) {
    assert.doesNotMatch(text(type), /turn-|msg-|→|\bTHINKING\b|\bIDLE\b/, type);
  }
});

test("a turn charged to several budgets says which budget each line is, so one spend does not read as two", () => {
  const charge = (key: string): string => text("budget.consumed", { actorId: "qa", payload: { key, amount: 1800, agentId: "qa", limitKind: "tokens" } });
  assert.equal(charge(`agent:${G}/qa`), "qa spent 1.8k tokens of its own budget");
  assert.equal(charge(`mission:${G}`), "qa spent 1.8k tokens of the mission budget");
  assert.equal(charge(`attention:${G}/qa`), "qa spent 1.8k tokens of its budget for waking others");
  assert.equal(charge(`thread:${G}/${THREAD}`), "qa spent 1.8k tokens of the budget of “review payment-architecture v1”");
  assert.equal(text("budget.consumed", { actorId: "qa", payload: { key: `thread:${G}/thread-unknown00000001`, amount: 1800, agentId: "qa" } }), "qa spent 1.8k tokens of a conversation's budget");
  assert.equal(text("budget.reserved"), "pm put 32.0k tokens of its own budget on hold");
  assert.equal(text("budget.exceeded"), "qa's budget is spent: 205k of 200k");
  assert.equal(text("budget.limit_raised"), "qa's budget raised to 400k tokens (was 200k), automatically");
});

test("a file is called by its name, from its own reference or from the events that named it, and by a short id only when nothing did", () => {
  assert.equal(text("artifact.transition"), "payment-architecture: approved", "a derived move has no mover worth naming");
  assert.equal(text("artifact.transition", { actorId: "pm", payload: { artifactId: ART, to: "READY_FOR_REVIEW", actorId: "pm" } }), "payment-architecture: ready for review, by pm");
  assert.equal(text("artifact.transition", undefined, () => undefined), "art-…be8089: approved");
  assert.equal(text("review.approved", undefined, () => undefined), "tech-lead approved payment-architecture — sound design", "the reference carries the name");
  assert.equal(text("lease.acquired"), "developer locked src/tx/Pipeline.java for editing", "a lock is on the product's own file");
  assert.equal(text("lease.released"), "developer unlocked src/tx/Pipeline.java");
  assert.equal(text("message.delivered"), "architect received pm's message (new task)");
  assert.equal(text("task.claimed"), "developer took the task “implement payment pipeline”");
  assert.equal(text("release.transition"), "release-plan: QA passed", "a state is said in the Files list's words");
});

test("the names come from the events in the list: files, tasks, messages, locks, conversations and decisions", () => {
  const names = eventNames([
    { type: "artifact.created", payload: { artifact: { id: ART, name: "payment-architecture" } } },
    { type: "task.created", payload: { task: { id: TASK, title: "implement payment pipeline" } } },
    { type: "message.sent", payload: { message: { id: MSG, from: "pm", type: "MISSION" } } },
    { type: "message.sent", payload: { message: { id: "msg-2", from: "human", type: "INFORM" } } },
    { type: "thread.created", payload: { thread: { id: THREAD, subject: "review payment-architecture v1" } } },
    { type: "lease.acquired", payload: { lease: { id: LEASE, artifactId: ART, files: [] } } },
    { type: "decision.proposed", payload: { decision: { id: "dec-1", topic: "use npm" } } },
  ]);
  assert.equal(names.get(ART), "payment-architecture");
  assert.equal(names.get(TASK), "implement payment pipeline");
  assert.equal(names.get(MSG), "pm's message (new task)");
  assert.equal(names.get("msg-2"), "your message (update)");
  assert.equal(names.get(THREAD), "review payment-architecture v1");
  assert.equal(names.get(LEASE), "payment-architecture", "a lock with no files is on its artifact");
  assert.equal(names.get("dec-1"), "use npm");
});

test("the mission's root thread is the mission's, not a thread the person opened", () => {
  assert.equal(text("thread.created", { actorId: "human", payload: { thread: { id: "thread-1", subject: "mission-root", initiator: "human", participants: ["human"] } } }), "the mission's main thread is open");
  assert.equal(text("thread.created", { actorId: "tech-lead", payload: { thread: { subject: `task ${TASK}: implement payment pipeline`, initiator: "tech-lead", participants: ["tech-lead", "developer"] } } }), "tech-lead opened “task: implement payment pipeline” with developer", "the delegation thread is titled by its task, not the task's id");
});

test("the person reading is 'you', and the mesh's own holds are not said as something they did", () => {
  assert.equal(text("goal.paused"), "you paused the mission");
  assert.equal(text("goal.resumed"), "you resumed the mission");
  const hold = { actorId: "human", payload: { reason: "acceptance criteria were generated from the goal — review them, then resume the mission to start work" } };
  assert.match(text("goal.paused", hold), /^the mission paused: acceptance criteria were generated/);
  assert.equal(text("agent.suspended"), "you paused developer");
  assert.equal(text("escalation.responded"), "you answered: “raise it to 8 hours”");
  assert.equal(text("message.sent", { actorId: "human", payload: { message: { from: "human", to: ["all"], type: "INFORM", payload: { note: "ship friday" } } } }), "you wrote to everyone (update): ship friday");
});

test("a verdict is said as what the seat did, about a file by its name or a check by its id (the agent drawer's signal line)", () => {
  // It read "1 approvals — latest pass implementation" and "latest approve artifact:art-M48WD20T003a31be8089".
  assert.equal(verdictDone("pass"), "passed");
  assert.equal(verdictDone("approve"), "approved");
  assert.equal(verdictDone("block"), "blocked");
  assert.equal(verdictDone("veto"), "vetoed");
  assert.equal(verdictDone("sign_off"), "sign off", "a kind this build does not know is said as words");
  assert.equal(verdictSubject({ subject: `artifact:${ART}` }, nameOf), "payment-architecture");
  assert.equal(verdictSubject({ subject: `artifact:${ART}`, artifactRef: { uri: "artifact://ArchitectureDocument/payment-architecture/1" } }), "payment-architecture", "the reference names it with no lookup");
  assert.equal(verdictSubject({ subject: "criterion:requirements-documented" }), "check requirements-documented");
  assert.equal(verdictSubject({ subject: "implementation", artifactId: PATCH }, nameOf), "patch-tx-pipeline-2", "a domain verdict on a file names the file");
  assert.equal(verdictSubject({ subject: "release" }), "release");
});

test("a refusal and a wake that was denied say who and why, in words", () => {
  assert.equal(text("message.rejected"), "pm could not be woken: mission is completed");
  const refused = text("message.rejected", { actorId: "tech-lead", payload: { from: "tech-lead", action: "approve by message", reason: "a APPROVE message records no verdict" } });
  assert.equal(refused, "tech-lead's approve by message was refused: an approve message records no verdict", "a message type in the kernel's sentence is said the console's way");
  assert.match(text("message.rejected", { payload: { from: "qa", to: ["pm"], reason: "budget agent:goal-1/qa exhausted (61200/50000)" } }), /^qa's message was refused: qa's budget used up — 61\.2k of 50\.0k$/);
  assert.equal(text("escalation.requested"), "the mesh watchdog needs you: Mission ran out of time");
  assert.equal(text("escalation.requested", { payload: { escalation: { reason: "Need sign-off on the schema", raisedBy: "architect", advisory: true } } }), "architect sent you a notice: Need sign-off on the schema", "a seat's own words are kept as written");
});

test("lines are cut with an ellipsis at the line length, never mid-way through who", () => {
  const seats = ["architect", "tech-lead", "developer", "qa", "security", "explorer", "designer", "ops", "data", "legal"];
  const long = text("message.sent", { payload: { message: { from: "pm", to: seats, type: "INFORM", payload: { note: "word ".repeat(80) } } } });
  assert.equal(long.length, LINE_MAX);
  assert.match(long, /^pm wrote to architect, tech-lead, /);
  assert.match(long, /…$/);
  const l = eventLine({ type: "agent.created", ...FIXTURES["agent.created"]! });
  assert.deepEqual(l, { lead: "pm", rest: " joined the team as product-manager" }, "the seat is the lead, set apart where the line is drawn");
});

test("a type this build does not know shows what its payload or the server said, then its own name", () => {
  assert.equal(text("brand.new_type", { payload: { summary: "a new thing happened" } }), "a new thing happened");
  assert.equal(text("brand.new_type", { payload: {}, summary: "server says so" }), "server says so");
  assert.equal(text("brand.new_type", { payload: {} }), "brand.new_type");
  assert.equal(text("agent.created", { payload: {}, summary: "pm (product-manager)" }), "agent created", "a known type never shows the server's dialect");
});

test("a search finds a row by the words it shows, including a file's name on a move that only carries its id", () => {
  const ev = { seq: 1, id: "e1", type: "artifact.transition", timestamp: "2026-10-04T19:20:00.000Z", payload: FIXTURES["artifact.transition"]!.payload };
  assert.ok(eventHaystack(ev, nameOf).includes("payment-architecture"));
  assert.ok(!eventHaystack(ev).includes("payment-architecture"), "without the names the id is all there is");
  assert.ok(eventHaystack({ ...ev, type: "agent.created", payload: FIXTURES["agent.created"]!.payload }).includes("joined the team as product-manager"));
});
