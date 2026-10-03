import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import { makeMesh } from "../helpers";
import { FakeWorkspace, installWorkspace } from "../support/fake-workspace";
import { main } from "../../apps/mesh-cli/src/index";
import { statusFromLog } from "../../packages/core/src/status";
import type { MeshEvent, MeshOp } from "../../packages/protocol/src/index";

/**
 * `curule status` against a mesh that is not running reads the event log, and says what `GET /status` said when the mesh stopped.
 *
 * It used to summarise the log on its own: the goal as `goal.created` wrote it, no progress, no budgets, and each seat's tokens summed
 * over every `budget.consumed` event that named it. In the fourteenth cronlite run, after both rounds had completed, it printed
 *
 *     Goal:      Build `cronlite`: a dependency-free Node.js (>=20, plain ESM [ACTIVE]
 *     Progress:  ░░░░░░░░░░░░░░░░░░░░ 0%
 *     Tokens:    -   events: 826
 *       ○ pm   COMPLETED   tokens:424771
 *
 * for a mission that was COMPLETED at 100% with 825,740 tokens spent (pm's 174,483): `curule status` is the first command anyone runs
 * to ask whether a run is over. A turn writes its spend twice (the seat's ledger and the mission's), so the sums were about 2.4 times
 * the truth.
 *
 * The fixtures are real missions, persisted by the real kernel: what is pinned is that the offline answer is the live answer.
 */

const AGENTS = [
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "git.commit"], interests: [] },
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "code.review", "git.merge"], authority: ["implementation.approve"], interests: [] },
];
const COMM = { dev: ["lead"], lead: ["dev"] };
const CRITERIA = [{ id: "implementation-merged", description: "the patch landed", mandatory: true }];
const GONE = "http://127.0.0.1:1";

const turnFor = (agentId: string) =>
  ({ turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`, agentId, reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] }) as never;

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

/** A mission that ran to its end: one turn's spend booked as the runtime books it (twice), a patch merged, the goal COMPLETED. */
async function finishedMission(): Promise<Mesh> {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked", criteria: CRITERIA, persist: true } as never);
  installWorkspace(m, new FakeWorkspace());
  const goalId = m.kernel.state.activeGoalId ?? "";
  const budget = m.supervisor.deps.budget;
  const held = await budget.reserve(`mission:${goalId}`, "tokens", 5_000, 3_000_000, { actorId: "dev", goalId });
  await budget.consume(`agent:${goalId}/dev`, "tokens", 1_200, undefined, { turnId: "turn-1" }, { actorId: "dev", goalId });
  await budget.consume(`mission:${goalId}`, "tokens", 1_200, held.reservationId, { turnId: "turn-1" }, { actorId: "dev", goalId });
  // A note the developer has not opened by the time the mission ends.
  const sent = await m.supervisor.sendMessage({ from: "lead", to: ["dev"], type: "INFORM", threadId: m.kernel.state.goals.get(goalId)?.rootThreadId ?? "", payload: { note: "heads up: the CLI is next" } });
  assert.equal(sent.accepted, true, sent.reason);
  const created = await m.supervisor.createArtifact({ actorId: "dev", name: "cli", type: "CodePatch", content: "## File: a.js\nconsole.log(1);\n" });
  if (!("artifact" in created)) throw new Error(`create failed: ${JSON.stringify(created)}`);
  const id = created.artifact.id;
  await m.supervisor.transitionArtifact("dev", id, { to: "READY_FOR_REVIEW" });
  await m.supervisor.executeOp("lead", { op: "approve", subject: "implementation", artifactId: id } as MeshOp, turnFor("lead"));
  await m.supervisor.transitionArtifact("lead", id, { to: "VERIFIED" });
  await m.supervisor.transitionArtifact("lead", id, { to: "MERGEABLE" });
  const merged = await m.supervisor.executeOp("lead", { op: "merge", artifactId: id } as MeshOp, turnFor("lead"));
  assert.equal(merged.ok, true, `fixture: the merge lands: ${merged.reason}`);
  assert.equal(m.kernel.state.goals.get(goalId)?.status, "COMPLETED", "fixture: the mission is over");
  await m.store.flush?.();
  return m;
}

const configOf = (m: Mesh): string => path.join(m.dir, "mesh.yaml");

/** What `curule status` printed (and warned) with nothing listening on the bus. */
async function printedStatus(m: Mesh): Promise<{ out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const warn = console.error;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  try {
    assert.equal(await main(["status", configOf(m), "--bus", GONE]), 0);
  } finally {
    console.log = log;
    console.error = warn;
  }
  return { out, err };
}

test("a mission that finished is COMPLETED at 100% with its tokens, where it used to print ACTIVE at 0% and no tokens", async () => {
  const m = await finishedMission();
  try {
    const { out, err } = await printedStatus(m);
    assert.deepEqual(err, []);
    assert.match(out[0]!, /^Goal: {6}.* \[COMPLETED\]$/);
    assert.equal(out[1], `Progress:  ${"█".repeat(20)} 100%`);
    const events = await m.store.read();
    const cap = m.kernel.state.goals.get(m.kernel.state.activeGoalId ?? "")?.budget.tokens;
    assert.equal(out[2], `Tokens:    1200 / ${cap}   events: ${events.length}`);
    // Spend booked on the seat's ledger and again on the mission's: counted once.
    const dev = out.find((l) => /^\s+\S\s+dev\s/.test(l));
    assert.match(dev ?? "", /mailbox: 1 {2}tokens:1200$/, `dev spent 1,200 tokens, not 2,400, and has the note unread: ${dev}`);
  } finally {
    await m.cleanup();
  }
});

test("the log replayed offline is the status the live mesh gives: goal, progress, budgets, seats, event count", async () => {
  const m = await finishedMission();
  try {
    const live = JSON.parse(JSON.stringify(await m.supervisor.status())) as Awaited<ReturnType<typeof m.supervisor.status>>;
    const { status: replayed, unapplied } = statusFromLog(await m.store.read(), m.supervisor.config);
    const status = JSON.parse(JSON.stringify(replayed)) as typeof live;
    assert.deepEqual(unapplied, []);
    const { budgets: liveBudgets, ...liveRest } = live;
    const { budgets, ...rest } = status;
    assert.deepEqual(rest, liveRest, "goal, progress, seats, escalations and event count are the live mesh's");
    // A ledger declared at boot and never reserved or booked on leaves no event, so the log cannot know it; it holds nothing.
    assert.deepEqual(budgets, liveBudgets.filter((b) => b.consumed > 0 || b.reserved > 0), "every ledger that was spent on, as it stood");
    assert.ok(liveBudgets.length > budgets.length, "fixture: there is a ledger nothing was booked on");
    assert.equal(status.goal?.status, "COMPLETED");
    assert.deepEqual(status.progress, { completed: 1, total: 1, ratio: 1 });
  } finally {
    await m.cleanup();
  }
});

test("a mission reopened after it finished is ACTIVE again with its criteria unmet, offline as live", async () => {
  const m = await finishedMission();
  try {
    const res = await m.supervisor.reopenGoal({ reason: "REJECTED after acceptance testing: three defects", criteria: ["implementation-merged"], activate: [] });
    assert.equal(res.ok, true, JSON.stringify(res));
    await m.store.flush?.();
    const { out } = await printedStatus(m);
    const live = await m.supervisor.status();
    assert.equal(live.goal?.status, "ACTIVE");
    const pct = Math.round((live.progress?.ratio ?? 0) * 100);
    assert.ok(pct < 100, `fixture: the reopened criterion is unmet (${pct}%)`);
    assert.match(out[0]!, /\[ACTIVE\]$/);
    assert.ok(out[1]!.endsWith(` ${pct}%`), `the same percentage as the live mesh (${pct}%): ${out[1]}`);
  } finally {
    await m.cleanup();
  }
});

test("a second mission started after the first finished is the one shown", async () => {
  const m = await finishedMission();
  try {
    await m.supervisor.createGoal({ description: "the next mission: harden the parser", acceptanceCriteria: [{ id: "quality-verified", description: "the tests pass", mandatory: true }] });
    await m.store.flush?.();
    const { out } = await printedStatus(m);
    assert.equal(out[0], "Goal:      the next mission: harden the parser [ACTIVE]");
    assert.equal(out[1], `Progress:  ${"░".repeat(20)} 0%`);
  } finally {
    await m.cleanup();
  }
});

test("open escalations are listed, and one that was answered is not", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked", criteria: CRITERIA, persist: true } as never);
  try {
    const open = await m.supervisor.escalate({ reason: "which licence do you want?", raisedBy: "dev", detail: { n: 1 } });
    const answered = await m.supervisor.escalate({ reason: "may I delete the old schema?", raisedBy: "lead", detail: { n: 2 } });
    assert.equal((await m.supervisor.respondEscalation(answered.id, "yes")).ok, true);
    await m.store.flush?.();
    const { out } = await printedStatus(m);
    const listed = out.filter((l) => /^\s+! esc-/.test(l));
    assert.equal(listed.length, 1, out.join("\n"));
    assert.match(listed[0]!, new RegExp(`^  ! ${open.id} \\[which licence do you want\\?\\] by dev at \\d{4}-`));
    assert.ok(out.some((l) => l.trim() === "Open escalations:"), "under its heading");
    assert.ok(!out.join("\n").includes(answered.id), "the answered card is not listed");
  } finally {
    await m.cleanup();
  }
});

test("an event that cannot be applied is skipped and reported, and the rest of the log still counts", async () => {
  const m = await finishedMission();
  try {
    const events = await m.store.read();
    const bad: MeshEvent = { ...events[events.length - 1]!, id: "evt-bad", seq: events.length + 1, type: "goal.budget_changed", payload: { goalId: "goal-nobody", budget: { tokens: 1 } } };
    const { status, unapplied } = statusFromLog([...events.slice(0, 5), bad, ...events.slice(5)]);
    assert.equal(unapplied.length, 1);
    assert.equal(unapplied[0]!.type, "goal.budget_changed");
    assert.equal(unapplied[0]!.seq, events.length + 1);
    assert.match(unapplied[0]!.message, /unknown goal goal-nobody/);
    assert.equal(status.goal?.status, "COMPLETED", "everything after the bad line was applied");
    assert.equal(status.eventCount, events.length, "and the bad line is not counted as applied");
  } finally {
    await m.cleanup();
  }
});

test("the command says so when it skipped something, and prints no warning when it did not", async () => {
  const m = await finishedMission();
  try {
    const clean = await printedStatus(m);
    assert.deepEqual(clean.err, []);
    // A line the projections refuse, appended to the log the way a newer or damaged writer might leave one.
    const events = await m.store.read();
    const line: MeshEvent = { ...events[0]!, id: "evt-bad", seq: events.length + 1, type: "goal.budget_changed", payload: { goalId: "goal-nobody", budget: { tokens: 1 } } };
    await m.store.append(line);
    await m.store.flush?.();
    const { out, err } = await printedStatus(m);
    assert.equal(err.length, 1);
    assert.match(err[0]!, /^warning: 1 event\(s\) in the log did not replay and were skipped \(the first: goal\.budget_changed at seq \d+: .*unknown goal goal-nobody.*\); these figures may be off by what they carried$/);
    assert.match(out[0]!, /\[COMPLETED\]$/, "and the status still prints");
  } finally {
    await m.cleanup();
  }
});

test("a state directory with no log says there is no goal, and does not throw", () => {
  const { status, unapplied } = statusFromLog([]);
  assert.equal(status.goal, undefined);
  assert.equal(status.progress, null);
  assert.deepEqual(status.agents, []);
  assert.deepEqual(status.budgets, []);
  assert.equal(status.eventCount, 0);
  assert.deepEqual(unapplied, []);
});
