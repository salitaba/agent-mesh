import test from "node:test";
import assert from "node:assert/strict";

import {
  artifactOfUri,
  buildAttention,
  bufferIsBehind,
  bySeq,
  capacityWaits,
  checksSummary,
  checkView,
  evidenceChips,
  filesByStatus,
  goalNeedsItsCard,
  heroNote,
  idleCause,
  missionClock,
  missionRead,
  nameOfUri,
  shortRef,
  sortFiles,
  standingBlocks,
  workspaceOf,
  type AttentionInput,
  type HeroNoteInput,
} from "../../apps/mesh-dashboard/src/overview-model";
import { describeMission, factsFromStatus, type MissionFacts } from "../../apps/mesh-dashboard/src/mission";

/**
 * The Overview stacked up to four banners, each with its own prose, and decided in the middle of a 460-line component which
 * of them to show. These pin what that component used to hold, and the three rules the redesign adds: the attention list
 * never repeats the headline, nothing true is dropped, and a figure that cannot be known is null rather than zero.
 */

/* ------------------------------- the log, in order -------------------------------- */

test("the log is read in the order it was written, whatever order the buffer filled in", () => {
  const filled = [{ seq: 1 }, { seq: 199 }, { seq: 411 }, { seq: 490 }, { seq: 2 }, { seq: 200 }];
  assert.deepEqual(bySeq(filled).map((e) => e.seq), [1, 2, 199, 200, 411, 490]);
  assert.deepEqual(filled.map((e) => e.seq), [1, 199, 411, 490, 2, 200], "the buffer itself is not reordered");
  assert.deepEqual(bySeq([{ seq: 3 }, {}, { seq: 1 }]).map((e) => e.seq ?? 0), [0, 1, 3], "an event with no seq sorts first");
  assert.deepEqual(bySeq([]), []);
});

test("a buffer that stops short of the log is behind it, and one that cannot be compared is not called behind", () => {
  assert.equal(bufferIsBehind(199, 490), true, "a page opened after a long run: the catch-up never reached the end");
  assert.equal(bufferIsBehind(490, 490), false);
  assert.equal(bufferIsBehind(491, 490), false, "an event ahead of the last poll");
  assert.equal(bufferIsBehind(0, 12), true, "nothing arrived yet");
  assert.equal(bufferIsBehind(0, 0), false, "an empty log has nothing to be behind");
  assert.equal(bufferIsBehind(5, undefined), false);
  assert.equal(bufferIsBehind(5, "490"), false, "a count that is not a number is not trusted");
});

/* ----------------------------- standing blocks ----------------------------- */

const ev = (seq: number, type: string, actorId: string, payload: any = {}) => ({ seq, type, actorId, payload });
const denial = (seq: number, actorId: string, reason: string, over: any = {}) =>
  ev(seq, "message.rejected", actorId, { denied: { kind: "x" }, reason, decision: "DENY", ...over });

test("a refusal stands until the agent has done anything since: the newest event naming it decides", () => {
  const blocks = standingBlocks([denial(1, "dev", "max_activations 3 reached"), ev(2, "agent.awakened", "dev"), denial(3, "qa", "thread budget exhausted (12/12)")]);
  assert.deepEqual(blocks.map((b) => b.actorId), ["qa"], "dev ran after its refusal, so it is no longer blocked");
});

test("standing blocks are newest first, carry the policy's own sentence, and say whether the refusal will retry", () => {
  const blocks = standingBlocks([
    denial(4, "pm", "transition 'x' requires a,b; missing: b", { ruleId: "transitions.x", decision: "DEFER" }),
    denial(9, "dev", "max_activations 3 reached"),
  ]);
  assert.deepEqual(blocks.map((b) => [b.actorId, b.reason, b.ruleId, b.deny]), [
    ["dev", "max_activations 3 reached", undefined, true],
    ["pm", "transition 'x' requires a,b; missing: b", "transitions.x", false],
  ]);
});

test("a rejected message that is not an activation denial, and an event with no actor, never count as a block", () => {
  assert.deepEqual(standingBlocks([ev(1, "message.rejected", "dev", { reason: "no such recipient" }), { seq: 2, type: "message.rejected", payload: { denied: {} } }]), []);
  assert.equal(standingBlocks([ev(1, "message.rejected", "dev", { denied: {} })])[0]?.reason, "refused by policy", "a denial with no sentence still says so");
});

/* ------------------------------- capacity ---------------------------------- */

test("capacity waits are the scheduler's queue entries of kind capacity, and nothing else", () => {
  const waits = capacityWaits([
    { agentId: "a", kind: "capacity", running: 4, limit: 4, configKey: "scheduling.concurrency.max_active_agents" },
    { agentId: "b", kind: "budget" },
    null,
  ]);
  assert.deepEqual(waits, [{ agentId: "a", running: 4, limit: 4, configKey: "scheduling.concurrency.max_active_agents" }]);
  assert.deepEqual(capacityWaits(undefined), []);
  assert.deepEqual(capacityWaits({ not: "an array" }), []);
});

/* ------------------------------- idle cause -------------------------------- */

test("an idle mission names its cause from what boot was asked to do and what it did", () => {
  assert.match(idleCause(0, null), /^No startup agents are configured/);
  assert.equal(
    idleCause(2, { activated: [], refused: [{ agentId: "pm", reason: "max_activations 3 reached" }] }),
    "Every startup agent was refused at the last boot: pm: max_activations 3 reached.",
  );
  assert.equal(
    idleCause(2, { activated: ["pm"], refused: [{ agentId: "qa", reason: "no budget" }] }),
    "The last boot started pm, and was refused qa: no budget. That work has since finished or stopped.",
  );
  assert.match(idleCause(null, null), /^The scheduler is running with nothing queued behind it\. Usually/, "a server that predates the field can only guess");
  assert.match(idleCause(1, null), /All 1 startup agent were either refused at boot or have since stopped\.$/);
  assert.match(idleCause(3, null), /All 3 startup agents were/);
});

test("zero startup seats outranks whatever the last boot says: nobody was asked to start", () => {
  assert.match(idleCause(0, { activated: ["pm"], refused: [] }), /^No startup agents are configured/);
});

/* --------------------------------- clock ----------------------------------- */

const T0 = Date.parse("2026-10-04T10:00:00Z");

test("the clock of a live mission runs from the goal's creation and is measured against its limit", () => {
  const c = missionClock({ status: "ACTIVE", createdAt: "2026-10-04T10:00:00Z", budget: { wallClockMinutes: 60 } }, T0 + 12 * 60_000);
  assert.deepEqual(c, { ms: 12 * 60_000, limitMs: 60 * 60_000, ended: false, over: false });
  assert.equal(missionClock({ status: "ACTIVE", createdAt: "2026-10-04T10:00:00Z", budget: { wallClockMinutes: 60 } }, T0 + 61 * 60_000)?.over, true);
});

test("a finished mission reports how long it ran and is never over", () => {
  const c = missionClock({ status: "COMPLETED", createdAt: "2026-10-04T10:00:00Z", completedAt: "2026-10-04T10:07:33Z", budget: { wallClockMinutes: 5 } }, T0 + 999 * 60_000);
  assert.deepEqual(c, { ms: 453_000, limitMs: 5 * 60_000, ended: true, over: false });
});

test("no honest figure is a null, not a zero: no creation time, a failed mission, a completion with no end", () => {
  assert.equal(missionClock({ status: "ACTIVE" }, T0), null);
  assert.equal(missionClock({ status: "ACTIVE", createdAt: "not a date" }, T0), null);
  assert.equal(missionClock({ status: "FAILED", createdAt: "2026-10-04T10:00:00Z" }, T0 + 60_000), null, "a failed goal records no end, so a growing timer would be invented");
  assert.equal(missionClock({ status: "COMPLETED", createdAt: "2026-10-04T10:00:00Z" }, T0 + 60_000), null);
  assert.equal(missionClock(null, T0), null);
  assert.equal(missionClock({ status: "ACTIVE", createdAt: "2026-10-04T10:00:00Z" }, T0 + 60_000)?.limitMs, null, "no limit configured");
});

/* -------------------------------- checks ----------------------------------- */

test("progress counts mandatory checks the way the kernel does, and reports a claim separately instead of moving the bar", () => {
  const s = checksSummary([
    { mandatory: true, status: "EVIDENCED" },
    { mandatory: true, status: "WAIVED" },
    { mandatory: true, status: "ASSERTED" },
    { mandatory: true, status: "UNSATISFIED" },
    { mandatory: false, status: "EVIDENCED" },
  ]);
  assert.deepEqual(s, { done: 2, total: 4, pct: 50, claimed: 1 });
  assert.deepEqual(checksSummary(undefined), { done: 0, total: 0, pct: 0, claimed: 0 });
});

test("a claimed check reads differently from both done and to do", () => {
  assert.deepEqual(checkView({ status: "EVIDENCED" }), { mark: "done", word: "done" });
  assert.deepEqual(checkView({ status: "ASSERTED" }), { mark: "claimed", word: "claimed, not verified" });
  assert.deepEqual(checkView({ status: "WAIVED" }), { mark: "skipped", word: "skipped" });
  assert.deepEqual(checkView({ status: "UNSATISFIED" }), { mark: "todo", word: "to do" });
  assert.deepEqual(checkView({}), { mark: "todo", word: "to do" });
});

/* -------------------------------- evidence --------------------------------- */

const arts = [
  { id: "a1", type: "CodePatch", name: "patch-tx-pipeline-2", status: "MERGED" },
  { id: "a2", type: "ArchitectureDocument", name: "payment architecture", status: "APPROVED" },
];

test("an evidence uri resolves to the artifact it names, so its chip can open it", () => {
  assert.equal(artifactOfUri(arts, "artifact://CodePatch/patch-tx-pipeline-2/2")?.id, "a1");
  assert.equal(artifactOfUri(arts, "artifact://ArchitectureDocument/payment%20architecture/1")?.id, "a2", "an encoded name is decoded");
  assert.equal(artifactOfUri(arts, "artifact://CodePatch/other/1"), null);
  assert.equal(artifactOfUri(arts, "https://example.com/x"), null);
  assert.equal(artifactOfUri(arts, undefined), null);
});

test("evidence chips name the file and open it when the evidence names one, and only describe it when it does not", () => {
  const chips = evidenceChips(
    { evidence: [{ kind: "merge", by: "tech-lead", artifactRef: { uri: "artifact://CodePatch/patch-tx-pipeline-2/2" } }, { kind: "security-pass" }] },
    arts,
  );
  assert.equal(chips.length, 2);
  assert.equal(chips[0]!.artifact?.id, "a1");
  assert.equal(chips[0]!.label, "patch-tx-pipeline-2", "the file is the label: a reader wants to know what, not a truncated type code");
  assert.match(chips[0]!.title, /CodePatch patch-tx-pipeline-2\. Evidence recorded by tech-lead, kind merge\. Opens the file\./);
  assert.equal(chips[1]!.artifact, null);
  assert.equal(chips[1]!.label, "security-pass");
  assert.doesNotMatch(chips[1]!.title, /Opens the file/, "a chip that opens nothing must not say it does");
  assert.deepEqual(evidenceChips({}, arts), []);
});

test("a kind that is only the check's own id said twice is left out, and who recorded it is said instead", () => {
  const [c] = evidenceChips({ id: "qa-passed", evidence: [{ kind: "qa-passed", by: "qa" }] }, arts);
  assert.equal(c!.label, "Recorded by qa");
  assert.equal(c!.title, "Evidence recorded by qa.");
  assert.equal(evidenceChips({ id: "qa-passed", evidence: [{ kind: "qa-passed" }] }, arts)[0]!.label, "Evidence recorded", "no actor and nothing else to say");
});

test("evidence says whether anything was checked, in the words the kernel's own gate uses", () => {
  const e = (verified: unknown) => evidenceChips({ id: "x", evidence: [{ kind: "x", by: "pm", verified }] }, arts)[0]!.title;
  assert.match(e(true), /, verified\.$/);
  assert.match(e(false), /not verified, because that turn ran no verification tool/);
  assert.doesNotMatch(e(undefined), /verified/, "evidence recorded before the field existed is not called either");
});

test("the file name of an artifact uri is read as written, decoded, and an unreadable one stays as it is", () => {
  assert.equal(nameOfUri("artifact://CodePatch/patch-tx-pipeline-2/2"), "patch-tx-pipeline-2");
  assert.equal(nameOfUri("artifact://ArchitectureDocument/payment%20architecture/1"), "payment architecture");
  assert.equal(nameOfUri("artifact://Doc/100%/1"), "100%");
  assert.equal(nameOfUri("https://example.com/x"), null);
  assert.equal(nameOfUri(undefined), null);
});

test("a goal the hero shows whole is not said again on the goal card, and one it folds or flattens is", () => {
  assert.equal(goalNeedsItsCard("Build and ship a small idempotent payment endpoint."), false);
  assert.equal(goalNeedsItsCard("  Short.  "), false);
  assert.equal(goalNeedsItsCard("x".repeat(70)), false);
  assert.equal(goalNeedsItsCard("x".repeat(71)), true);
  assert.equal(goalNeedsItsCard("Line one.\nLine two."), true, "the hero flattens line breaks, so the card is where they survive");
  assert.equal(goalNeedsItsCard(""), false);
});

/* --------------------------------- files ----------------------------------- */

test("what shipped is read settled first, then in review, then drafts, and what needs rework last but never hidden", () => {
  const files = [
    { name: "d", status: "REJECTED" }, { name: "c", status: "DRAFT" }, { name: "b", status: "UNDER_REVIEW" },
    { name: "a", status: "MERGED" }, { name: "e", status: "APPROVED" },
  ];
  assert.deepEqual(sortFiles(files).map((f) => f.name), ["a", "e", "b", "c", "d"]);
  const g = filesByStatus(files);
  assert.equal(g.total, 5);
  assert.deepEqual(g.groups.map((x) => x.status), ["APPROVED", "MERGED", "UNDER_REVIEW", "DRAFT", "REJECTED"]);
  assert.equal(g.groups.find((x) => x.status === "REJECTED")?.label, "needs rework");
});

test("files of one status are counted together, the larger group first within a rank", () => {
  const g = filesByStatus([{ status: "APPROVED" }, { status: "MERGED" }, { status: "MERGED" }, { status: "MERGED" }]);
  assert.deepEqual(g.groups.map((x) => [x.status, x.count]), [["MERGED", 3], ["APPROVED", 1]]);
  assert.deepEqual(filesByStatus([]), { total: 0, groups: [] });
});

test("the workspace is read from the first artifact that names one, and each path is shown without it", () => {
  const ref = "file:///home/u/proj/workspace/.mesh-state/artifacts/art-1/v1.txt";
  assert.equal(workspaceOf([{ contentRef: "elsewhere" }, { contentRef: ref }]), "/home/u/proj/workspace");
  assert.equal(workspaceOf([]), "");
  assert.equal(shortRef(ref), ".mesh-state/artifacts/art-1/v1.txt");
  assert.equal(shortRef("file:///no/state/here.txt"), "/no/state/here.txt");
  assert.equal(shortRef(undefined), "");
});

/* ---------------------------------- hero ----------------------------------- */

const note = (over: Partial<HeroNoteInput> = {}): HeroNoteInput => ({
  phase: "running", hasHistory: true, parked: false, parkedNotice: null, verdict: null, blockingDecisions: 0, decisionTitles: [], startupSeats: 2, lastBoot: null, spend: null,
  ...over,
});

test("a running mission has nothing to explain: the headline is the whole story", () => {
  assert.equal(heroNote(note()), null);
  assert.equal(heroNote(note({ phase: "offline" })), null);
  assert.equal(heroNote(note({ phase: "loading" })), null);
});

test("a parked mission says whether progress is loaded, and keeps the server's own sentence behind it, quoted", () => {
  const notice = "the mission is not running: the scheduler is parked — POST /mission/start (the dashboard's Start control) makes it live";
  const resumed = heroNote(note({ phase: "parked", hasHistory: true, parkedNotice: notice }))!;
  assert.match(resumed.summary, /^Previous progress is loaded\./);
  assert.equal(resumed.server, notice, "verbatim: the wording that ends this confusion has to be identical wherever it appears");
  assert.match(heroNote(note({ phase: "parked", hasHistory: false }))!.summary, /^Nothing has been done yet\. To run one step without going live, wake a single agent/);
  assert.equal(heroNote(note({ phase: "parked", hasHistory: false }))!.server, undefined);
});

/** What each phase's facts look like, for the rule below: the line under the headline adds to it and never repeats it. */
const FACTS: MissionFacts = {
  hasStatus: true, serverDown: false, projectDown: null, goalStatus: "ACTIVE", parked: false, blockingDecisions: 0, seatHeldDecisions: [], advisoryDecisions: 0,
  hostCeilingTripped: false, working: 0, waiting: 0, runningSteps: 0, hasHistory: true, startupSeats: 2,
};
const SENTENCES = (s: string): string[] => s.split(/(?<=\.)\s+/).map((x) => x.trim()).filter(Boolean);

test("the line under the headline never repeats a sentence of it, in any phase", () => {
  const verdict = { title: "Goal met", summary: "Every mandatory acceptance criterion was evidenced, with no open escalations and no work still claimed." };
  const cases: Array<[string, Partial<MissionFacts>, Partial<HeroNoteInput>]> = [
    ["parked, nothing done", { parked: true, hasHistory: false }, { parked: true, hasHistory: false }],
    ["parked, progress loaded", { parked: true, hasHistory: true }, { parked: true, hasHistory: true }],
    ["paused", { goalStatus: "PAUSED" }, {}],
    ["paused with a verdict", { goalStatus: "PAUSED" }, { verdict: { title: "Paused by the operator", summary: "Nothing is lost." } }],
    ["a decision with no verdict", { blockingDecisions: 1 }, { blockingDecisions: 1, decisionTitles: ["Choose v2 or v3"] }],
    ["a decision with a verdict", { blockingDecisions: 1 }, { blockingDecisions: 1, verdict: { title: "The mission ran out of tokens", summary: "It will not run until the limit is raised." } }],
    ["delivered", { goalStatus: "COMPLETED" }, { verdict }],
    ["delivered, no verdict", { goalStatus: "COMPLETED" }, {}],
    ["failed with a verdict", { goalStatus: "FAILED" }, { verdict: { title: "The wall clock ran out", summary: "The goal was marked failed." } }],
    ["failed, no verdict", { goalStatus: "FAILED" }, {}],
    ["idle", { startupSeats: 0 }, { startupSeats: 0 }],
    ["quiet", { waiting: 3 }, {}],
    ["ceiling", { parked: true, hostCeilingTripped: true }, { parked: true, spend: { usd: 12.5, ceilingUsd: 10, parked: ["a"] } }],
  ];
  for (const [name, facts, over] of cases) {
    const st = describeMission({ ...FACTS, ...facts });
    const n = heroNote(note({ phase: st.phase, ...over }));
    if (!n) continue;
    for (const s of SENTENCES(st.headline)) assert.ok(!n.summary.includes(s), `${name}: the note repeats "${s}"`);
  }
});

test("a failed mission with no phrased verdict has no second line: it would only say the headline again", () => {
  assert.equal(heroNote(note({ phase: "failed" })), null);
  assert.match(heroNote(note({ phase: "failed", verdict: { title: "The wall clock ran out", summary: "Nothing more will run." } }))!.summary, /^The wall clock ran out\. Nothing more will run\./);
});

test("a delivered mission shows the sentence that makes a green headline trustworthy, and a parked process is a footnote", () => {
  const verdict = { title: "Goal met", summary: "Every mandatory acceptance criterion was evidenced, with no open escalations and no work still claimed." };
  const n = heroNote(note({ phase: "done", parked: true, verdict }))!;
  assert.equal(n.summary, verdict.summary);
  assert.deepEqual(n.detail, ["The project is parked. A finished mission does not need it running."]);
  assert.deepEqual(heroNote(note({ phase: "done", parked: false, verdict }))!.detail, []);
  assert.equal(heroNote(note({ phase: "done" }))!.summary, "All mandatory checks passed.", "no phrased verdict: the plain fallback");
});

test("a mission halted by its own stopping condition leads with the verdict and says it will not clear on its own", () => {
  const verdict = { title: "Mission ran out of time", summary: "The run exceeded its configured wall-clock limit." };
  const n = heroNote(note({ phase: "needs-you", verdict, blockingDecisions: 3 }))!;
  assert.equal(n.summary, "Mission ran out of time.");
  assert.equal(n.detail[0], verdict.summary);
  assert.match(n.detail[1]!, /will not clear on its own/);
  assert.equal(n.detail[2], "3 decisions are waiting in total.");
  assert.equal(heroNote(note({ phase: "needs-you", verdict: null, blockingDecisions: 1 })), null, "nothing to say when not even a title has arrived");
  assert.equal(heroNote(note({ phase: "needs-you", verdict, blockingDecisions: 1 }))!.detail.length, 2, "no total for a single decision");
});

test("a halt with no phrased verdict still says what is waiting, so the operator does not have to open another page to find out", () => {
  const one = heroNote(note({ phase: "needs-you", blockingDecisions: 1, decisionTitles: ["Mission ran out of tokens"] }))!;
  assert.deepEqual(one, { summary: "Waiting: Mission ran out of tokens.", detail: [] });
  assert.equal(heroNote(note({ phase: "needs-you", blockingDecisions: 2, decisionTitles: ["A", "B"] }))!.summary, "Waiting: A and B.");
  assert.equal(heroNote(note({ phase: "needs-you", blockingDecisions: 4, decisionTitles: ["A", "B", "C", "D"] }))!.summary, "Waiting: A and B, and 2 more.");
  const verdict = { title: "Mission ran out of time", summary: "x" };
  assert.equal(heroNote(note({ phase: "needs-you", verdict, decisionTitles: ["A"] }))!.summary, "Mission ran out of time.", "a phrased verdict outranks the titles");
});

test("the spend ceiling explains why Continue cannot fix it and keeps every fact the old banner carried", () => {
  const n = heroNote(note({ phase: "ceiling", spend: { usd: 12.5, ceilingUsd: 10, parked: ["demo-stub", "api"] } }))!;
  assert.match(n.summary, /^Starting the mission will not hold while total spend is over the ceiling/);
  assert.equal(n.detail[0], "Total spend across open projects is $12.50 against a ceiling of $10.00. Parked: demo-stub, api.");
  assert.match(n.detail.join(" "), /host-wide/);
  assert.match(n.detail.join(" "), /host\.yaml by hand still needs a restart/);
  assert.match(n.detail.join(" "), /stay parked until you continue them/);
  const bare = heroNote(note({ phase: "ceiling", spend: { usd: 3, ceilingUsd: null, parked: [] } }))!;
  assert.equal(bare.detail[0], "Total spend across open projects is $3.00.", "no ceiling figure and nothing parked: neither is invented");
  assert.ok(heroNote(note({ phase: "ceiling" }))!.detail.every((p) => p.length > 0), "no empty paragraph when the spend has not arrived");
});

test("an idle live mission explains itself with the cause, and a quiet one says how agents wake and what to do if nothing is coming", () => {
  assert.equal(heroNote(note({ phase: "stalled", startupSeats: 0 }))!.summary, idleCause(0, null));
  const quiet = heroNote(note({ phase: "quiet" }))!.summary;
  assert.match(quiet, /^Agents wake when something they care about happens\./);
  assert.match(quiet, /If nothing is coming, wake one or send a message\.$/);
  assert.doesNotMatch(quiet, /get going/, "a mission between two turns has already started");
});

test("paused and failed say what the log says when it phrased a verdict, and paused says a plain line when it did not", () => {
  assert.match(heroNote(note({ phase: "paused" }))!.summary, /nothing is lost/);
  assert.equal(heroNote(note({ phase: "failed", verdict: { title: "Mission failed", summary: "Check the escalations." } }))!.summary, "Mission failed. Check the escalations.");
});

/* ------------------------------- attention --------------------------------- */

const attn = (over: Partial<AttentionInput> = {}): AttentionInput => ({
  phase: "running", parked: false, blockingDecisions: 0, notices: [], toolRequests: [], spend: null, blocks: [], capacity: [], triagedAway: 0, ...over,
});
const block = (actorId: string, deny: boolean, reason = "max_activations 3 reached", ruleId?: string) => ({ actorId, seq: 1, reason, ruleId, deny });

test("a healthy mission has an empty attention list", () => {
  assert.deepEqual(buildAttention(attn()), []);
});

test("the list never repeats the hero: decisions are listed only when they are not already the headline", () => {
  assert.deepEqual(buildAttention(attn({ phase: "needs-you", blockingDecisions: 2 })), []);
  const other = buildAttention(attn({ phase: "ceiling", parked: true, blockingDecisions: 2 }));
  assert.deepEqual(other.map((i) => [i.kind, i.title, i.fix?.target]), [["decisions", "2 decisions waiting on you.", "inbox"]]);
});

test("a refusal that only restates the headline is not listed: the policy denying every wake because the mission is halted", () => {
  const halted = block("pm", true, "mission is completed", "goal-halted");
  assert.deepEqual(buildAttention(attn({ phase: "needs-you", blocks: [halted] })), []);
  const two = buildAttention(attn({ blocks: [halted, block("qa", true, "max_activations 3 reached", "scheduling.max_activations")] }));
  assert.equal(two.length, 1);
  assert.equal(two[0]!.title, "qa is not being woken.", "the other refusal is a separate fact and stays");
});

test("a finished mission lists no scheduler conditions: nothing is expected to run, so nothing is stuck", () => {
  const live = { blocks: [block("qa", true)], capacity: [{ agentId: "dev", running: 4, limit: 4 }], triagedAway: 9, toolRequests: [{ agentId: "dev", tools: ["Edit"] }] };
  for (const phase of ["done", "failed"] as const) assert.deepEqual(buildAttention(attn({ phase, ...live })), [], phase);
  assert.equal(buildAttention(attn({ phase: "stalled", ...live })).length, 4, "the same facts on an idle live mission are all listed");
  const kept = buildAttention(attn({ phase: "done", notices: [{ title: "A conversation ran long" }], ...live }));
  assert.deepEqual(kept.map((x) => x.kind), ["notices"], "a notice that is still open is still the operator's");
});

test("in the ceiling phase the hero is the host's card, so only the other decisions are listed", () => {
  assert.deepEqual(buildAttention(attn({ phase: "ceiling", parked: true, blockingDecisions: 1, ceilingCards: 1 })), [], "the one decision is the headline");
  const two = buildAttention(attn({ phase: "ceiling", parked: true, blockingDecisions: 3, ceilingCards: 1 }));
  assert.equal(two[0]!.title, "2 decisions waiting on you.");
  assert.equal(buildAttention(attn({ phase: "parked", parked: true, blockingDecisions: 1, ceilingCards: 1 }))[0]!.title, "1 decision waiting on you.", "outside the ceiling phase the card is not the headline");
});

test("a refusal that will not retry is a fault and a deferral is a warning, and the two are explained separately when both stand", () => {
  const denied = buildAttention(attn({ blocks: [block("dev", true, "max_activations 3 reached", "policy.max")] }))[0]!;
  assert.equal(denied.tone, "bad");
  assert.equal(denied.title, "dev is not being woken.");
  assert.equal(denied.context, "max_activations 3 reached (policy.max).");
  assert.match(denied.detail.join(" "), /Refused outright/);
  assert.doesNotMatch(denied.detail.join(" "), /Deferred/);
  const deferred = buildAttention(attn({ blocks: [block("qa", false, "thread budget exhausted (12/12)")] }))[0]!;
  assert.equal(deferred.tone, "warn");
  assert.match(deferred.detail.join(" "), /Deferred, not refused/);
  assert.doesNotMatch(deferred.detail.join(" "), /Refused outright/);
  const mixed = buildAttention(attn({ blocks: [block("dev", true), block("qa", false)] }))[0]!;
  assert.equal(mixed.tone, "bad");
  assert.match(mixed.detail.join(" "), /Refused outright/);
  assert.match(mixed.detail.join(" "), /Deferred, not refused/, "the old banner called every block refused when any one was");
  assert.equal(mixed.title, "2 agents are not being woken.");
  assert.ok(mixed.detail.includes("dev: max_activations 3 reached.") && mixed.detail.includes("qa: max_activations 3 reached."), "every agent's reason is behind the disclosure");
});

test("many blocked agents are summarised on one line and listed in full behind the disclosure", () => {
  const item = buildAttention(attn({ blocks: ["a", "b", "c", "d", "e"].map((n) => block(n, true)) }))[0]!;
  assert.equal(item.context, "a, b and c and 2 more.");
  assert.equal(item.detail.filter((p) => /^[a-e]: /.test(p)).length, 5);
});

test("the policy's deferral of a seat that has its own budget card is the card said again, so it is not listed", () => {
  const deferral = (actorId: string, over: any = {}) => ({ actorId, seq: 5, reason: "agent budget exhausted (1800/1500) — parked until its budget is raised", ruleId: "budget", deny: false, ...over });
  const a = (over: Partial<AttentionInput> = {}) => buildAttention(attn({ blocks: [deferral("developer")], ...over }));
  assert.equal(a().length, 1, "no card: the deferral is the only place it is said");
  assert.deepEqual(a({ coveredSeats: ["developer"] }), []);
  assert.equal(a({ coveredSeats: ["qa"] }).length, 1, "another seat's card says nothing about this one");
  assert.equal(a({ blocks: [deferral("developer", { ruleId: "scheduling.max_activations" })], coveredSeats: ["developer"] }).length, 1, "a different rule is a different fact");
  assert.equal(a({ blocks: [deferral("developer", { deny: true })], coveredSeats: ["developer"] }).length, 1, "a refusal is not a deferral the card can lift");
  const two = a({ blocks: [deferral("developer"), deferral("qa", { ruleId: "scheduling.max_activations" })], coveredSeats: ["developer"] });
  assert.equal(two[0]!.title, "qa is not being woken.", "the covered seat is dropped from the count and the title");
});

test("a queue that clears itself is information, with the ceiling that binds named the way the designer names it", () => {
  const item = buildAttention(attn({ capacity: [{ agentId: "dev", running: 4, limit: 4, configKey: "scheduling.concurrency.max_active_agents" }] }))[0]!;
  assert.equal(item.tone, "info");
  assert.equal(item.title, "dev is queued, waiting for a slot.");
  assert.equal(item.context, "The mesh is running 4 of 4; peers at once is the ceiling that binds.");
  assert.match(item.detail[0]!, /normally clears within a turn/);
  assert.match(item.detail[1]!, /"peers at once"/);
  assert.match(item.detail[1]!, /next mesh boot/, "the remedy carries its timing");
  const bare = buildAttention(attn({ capacity: [{ agentId: "a" }, { agentId: "b" }] }))[0]!;
  assert.equal(bare.title, "2 agents are queued, waiting for a slot.");
  assert.equal(bare.context, undefined);
  assert.match(bare.detail[1]!, /the concurrency limits/);
});

test("dropped events are listed only when nobody is working, which is the state they explain", () => {
  for (const phase of ["running", "paused", "needs-you", "parked", "done", "failed", "ceiling"] as const) {
    assert.deepEqual(buildAttention(attn({ phase, parked: phase === "parked" || phase === "ceiling", triagedAway: 12 })).map((i) => i.kind), [], phase);
  }
  for (const phase of ["stalled", "quiet"] as const) assert.deepEqual(buildAttention(attn({ phase, triagedAway: 12 })).map((i) => i.kind), ["triage"], phase);
});

test("dropped events are information, said once, with the rule to loosen", () => {
  assert.equal(buildAttention(attn({ phase: "stalled", triagedAway: 1 }))[0]!.title, "1 event was triaged away. No agent saw it.");
  const many = buildAttention(attn({ phase: "stalled", triagedAway: 40 }))[0]!;
  assert.equal(many.title, "40 events were triaged away. No agent saw them.");
  assert.match(many.detail[0]!, /will not be retried/);
  assert.equal(many.tone, "info");
});

test("tool requests and advisory notices are listed with the one place that answers them", () => {
  const tools = buildAttention(attn({ toolRequests: [{ agentId: "dev", tools: ["Edit", "Write"] }, { agentId: "qa", tools: ["Bash"] }] }))[0]!;
  assert.equal(tools.title, "3 tool requests waiting.");
  assert.equal(tools.context, "dev asked for Edit and Write, and 1 more seat has asked too.");
  assert.equal(tools.fix?.target, "tools");
  const one = buildAttention(attn({ notices: [{ title: "A conversation ran long: v2 vs v3" }] }))[0]!;
  assert.equal(one.title, "1 notice for you. It holds nothing.");
  assert.equal(one.context, "A conversation ran long: v2 vs v3.");
  assert.equal(one.tone, "info");
  assert.equal(buildAttention(attn({ notices: [{ title: "a" }, { title: "b" }] }))[0]!.title, "2 notices for you. They hold nothing.");
});

test("a parked project lists no live scheduler problems: its queue was drained, and a stale count would mislead", () => {
  const parked = buildAttention(attn({
    parked: true, phase: "parked", blocks: [block("dev", true)], capacity: [{ agentId: "a" }], triagedAway: 9,
    notices: [{ title: "n" }],
  }));
  assert.deepEqual(parked.map((i) => i.kind), ["notices"], "a notice is the operator's to read whether or not anything runs");
});

test("the host's ceiling is listed only when it is true of a live project that is not over: otherwise it is the headline or irrelevant", () => {
  const spend = { usd: 12.5, ceilingUsd: 10, parked: ["other"], tripped: true };
  const live = buildAttention(attn({ spend }));
  assert.deepEqual(live.map((i) => [i.kind, i.tone, i.context, i.fix?.target]), [["ceiling", "warn", "$12.50 of $10.00.", "hostsettings"]]);
  assert.deepEqual(buildAttention(attn({ spend, parked: true, phase: "ceiling" })), [], "the headline already says it");
  assert.deepEqual(buildAttention(attn({ spend, phase: "done" })), [], "a delivered mission does not care");
  assert.deepEqual(buildAttention(attn({ spend: { ...spend, tripped: false } })), []);
});

test("the list is ordered by what it asks of the operator: act, then look, then know", () => {
  const items = buildAttention(attn({
    phase: "stalled", triagedAway: 2, capacity: [{ agentId: "a" }], notices: [{ title: "n" }],
    toolRequests: [{ agentId: "dev", tools: ["Edit"] }], blocks: [block("qa", false)],
    blockingDecisions: 1, spend: { usd: 1, ceilingUsd: 1, parked: [], tripped: true },
  }));
  assert.deepEqual(items.map((i) => [i.kind, i.tone]), [
    ["decisions", "bad"], ["ceiling", "warn"], ["blocks", "warn"], ["tools", "warn"], ["notices", "info"], ["capacity", "info"], ["triage", "info"],
  ]);
});

test("an unreachable server lists nothing: the last known problems are not live ones", () => {
  const input = attn({ blockingDecisions: 3, blocks: [block("dev", true)], triagedAway: 4 });
  assert.deepEqual(buildAttention({ ...input, phase: "offline" }), []);
  assert.deepEqual(buildAttention({ ...input, phase: "loading" }), []);
});

test("the Overview draws a mission only once the status names its goal; before that the headline says why there is none", () => {
  const starting = { agents: [], mode: "parked", eventCount: 0 };
  const closed = { error: "project 'demo' is closed", status: "closed", projectId: "demo" };
  assert.equal(missionRead(null), false, "no answer yet");
  assert.equal(missionRead(starting), false, "a project that answered before it read its log");
  assert.equal(missionRead(closed), false, "the host's answer for a project that is not running");
  assert.equal(missionRead({ goal: { id: "goal-1", status: "ACTIVE", acceptanceCriteria: [] }, agents: [] }), true);
  // What stands in for the page then: the starting project's headline, which is a loading state, never "no checks" or "0 events".
  const s = describeMission(factsFromStatus(starting));
  assert.equal(s.phase, "loading");
  assert.match(s.headline, /starting/);
});
