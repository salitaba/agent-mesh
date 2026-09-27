import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, evidenceContent } from "../helpers";
import { Kernel, KernelRejectedError } from "../../packages/core/src/kernel";
import { projectionConfigFor } from "../../packages/core/src/projections";
import { MemoryEventStore } from "../../packages/event-store/src/index";
import { FixedClock, type MeshEvent } from "../../packages/protocol/src/index";
import { exportState } from "../../packages/core/src/state";
import type { WorkspacePort } from "../../packages/core/src/ports";
import { artifactUri, type EventType, type MeshOp } from "../../packages/protocol/src/index";

/**
 * The event-path conformance table (NOTES-test-gaps.md, Stage 1.3 / 3.1-3.2).
 *
 * Preconditions live in `Supervisor` methods: `completeTask` checks the task is
 * CLAIMED and that the caller claimed it, `respondEscalation` checks the card is
 * OPEN, `markCriterionEvidence` refuses DRAFT evidence and re-cited rejected
 * evidence, the watchdog only emits `goal.completed` on a `complete` verdict. The
 * reducers in `projections-*.ts` are what REPLAY goes through, and what a raw
 * `kernel.emit` goes through -- and most of them have none of those checks.
 * Supervisor tests prove the supervisor refuses; projection tests feed hand-built
 * events into a hand-built state. Nothing proved the two agree.
 *
 * `TABLE` is the deliverable: one row per supervisor-guarded event form. Each row
 * says which guard the supervisor enforces (and where), how the illegal PRE-STATE
 * is reached (only through supervisor calls and events the supervisor itself would
 * emit -- never by writing to a state object), and the illegal event. `EventType`
 * is a bare string union with no payload map, so every payload here is copied from
 * the supervisor's own `kernel.emit` literal for that type.
 *
 * Per row, two tests:
 *
 *  - REFUSED: the illegal event emitted straight at the kernel must throw
 *    `KernelRejectedError` (how a reducer's `ProjectionError` surfaces from
 *    `Kernel.applyAndAppend`), leave the exported projections byte-identical, and
 *    append nothing to the log. Rows where the reducer accepts today carry a
 *    `bug` and run as `todo`: that list is the gap inventory.
 *  - ACCEPTED (positive control): the LEGAL form of the same event, from the
 *    legal pre-state, is accepted and has its effect. Without it a REFUSED row
 *    could pass because the payload was malformed rather than because the
 *    precondition was checked.
 *
 * "Byte-identical" is `exportState`, which includes `eventCount` -- so a reducer
 * that ABSORBS an illegal event as a silent no-op (the kernel still appends it,
 * and every replay re-reads it) fails the row too. An absorbed event is on the
 * log as if it had been legal.
 */

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

const AGENTS = [
  // `code.review` on the owner is deliberate: it is what makes a self-approval
  // able to MOVE the artifact at the reducer (`approverMayAdvance`), which is the
  // self-approval row below. The supervisor still refuses it: `lead` is a peer.
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "code.review"], interests: [] },
  {
    id: "lead",
    role: "tech-lead",
    capabilities: ["repository.read", "code.review", "git.merge"],
    authority: ["implementation.approve", "architecture.approve", "requirements.accept"],
    interests: [],
  },
  { id: "qa", role: "qa", capabilities: ["repository.read", "test.execute"], interests: [] },
];
const COMM = { dev: ["lead", "qa"], lead: ["dev", "qa"], qa: ["dev", "lead"] };
// Two mandatory criteria so "the only one still unproven" is expressible, and one
// optional so a removal the supervisor allows is expressible too.
const CRITERIA = [
  { id: "ship", description: "the patch shipped", mandatory: true },
  { id: "docs", description: "the docs exist", mandatory: true },
  { id: "extra", description: "nice to have", mandatory: false },
];

async function mesh(transitions?: Record<string, string[]>): Promise<Mesh> {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked", criteria: CRITERIA, transitions } as never);
  // The git arm of `merge` is the only one that needs no content on disk, and the
  // in-memory bootstrap never installs a workspace (`useGit = !inMemory && ...`).
  (m.supervisor as unknown as { deps: { workspace?: WorkspacePort } }).deps.workspace = workspaceDouble();
  return m;
}

/** A typed `WorkspacePort` whose merge always lands. Nothing else is reached here. */
function workspaceDouble(): WorkspacePort {
  const unused = (name: string) => async (): Promise<never> => {
    throw new Error(`workspace double: ${name} is not part of this fixture`);
  };
  return {
    mainPath: "/nonexistent/product",
    ensureRepo: unused("ensureRepo"),
    ensureWorktree: unused("ensureWorktree"),
    commitWorktree: unused("commitWorktree"),
    async mergeWorktree() {
      return { commit: "c0ffee0000000000000000000000000000000000" };
    },
    removeWorktree: unused("removeWorktree"),
    async worktreeState() {
      return null;
    },
  };
}

const turnFor = (agentId: string) =>
  ({
    turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`,
    agentId,
    reason: { kind: "manual" as const },
    sentOps: 0,
    publishedOps: 0,
    waitRequested: false,
    escalated: false,
    results: [],
  }) as never;

interface Emit {
  type: EventType;
  payload: Record<string, unknown>;
  actorId?: string;
}

function emit(m: Mesh, e: Emit) {
  return m.kernel.emit(e.type, e.payload, { actorId: e.actorId, goalId: m.kernel.state.activeGoalId ?? undefined });
}

const goal = (m: Mesh) => m.kernel.state.goals.get(m.kernel.state.activeGoalId ?? "")!;
const criterion = (m: Mesh, id: string) => goal(m).acceptanceCriteria.find((c) => c.id === id)!;
const now = (m: Mesh) => m.kernel.clock.iso();

// --- legal pre-state builders: supervisor calls only -------------------------

async function newTask(m: Mesh, title: string, requiredCapabilities?: string[]): Promise<string> {
  const res = await m.supervisor.executeOp("lead", { op: "create_task", title, description: `do ${title}`, requiredCapabilities } as MeshOp, turnFor("lead"));
  assert.equal(res.ok, true, `fixture: create_task (${res.reason ?? ""})`);
  const t = [...m.kernel.state.tasks.values()].find((x) => x.title === title);
  assert.ok(t, "fixture: task exists");
  return t.id;
}

async function claimed(m: Mesh, by = "dev"): Promise<string> {
  const id = await newTask(m, `task-${Math.random().toString(36).slice(2, 8)}`);
  const res = await m.supervisor.claimTask(by, id);
  assert.equal(res.ok, true, `fixture: claim (${res.reason ?? ""})`);
  return id;
}

async function patch(m: Mesh, name: string, content = evidenceContent(name)): Promise<{ id: string; uri: string }> {
  const created = await m.supervisor.createArtifact({ actorId: "dev", name, type: "CodePatch", content });
  if (!("artifact" in created)) throw new Error(`fixture: create ${name} failed`);
  return { id: created.artifact.id, uri: artifactUri("CodePatch", name, created.artifact.version) };
}

async function submitted(m: Mesh, name: string) {
  const p = await patch(m, name);
  const r = await m.supervisor.transitionArtifact("dev", p.id, { to: "READY_FOR_REVIEW" });
  assert.equal(r.ok, true, `fixture: READY_FOR_REVIEW (${r.reason ?? ""})`);
  return p;
}

async function underReview(m: Mesh, name: string) {
  const p = await submitted(m, name);
  const r = await m.supervisor.executeOp("dev", { op: "request_review", artifactId: p.id, reviewers: ["lead"] } as MeshOp, turnFor("dev"));
  assert.equal(r.ok, true, `fixture: request_review (${r.reason ?? ""})`);
  assert.equal(m.kernel.state.artifacts.get(p.id)?.status, "UNDER_REVIEW", "fixture: under review");
  return p;
}

async function mergeable(m: Mesh, name: string) {
  const p = await underReview(m, name);
  const a = await m.supervisor.executeOp("lead", { op: "approve", subject: "implementation", artifactId: p.id } as MeshOp, turnFor("lead"));
  assert.equal(a.ok, true, `fixture: approve (${a.reason ?? ""})`);
  for (const to of ["VERIFIED", "MERGEABLE"] as const) {
    const r = await m.supervisor.transitionArtifact("lead", p.id, { to });
    assert.equal(r.ok, true, `fixture: ${to} (${r.reason ?? ""})`);
  }
  return p;
}

async function merge(m: Mesh, id: string) {
  const r = await m.supervisor.executeOp("lead", { op: "merge", artifactId: id } as MeshOp, turnFor("lead"));
  assert.equal(r.ok, true, `merge op (${r.reason ?? ""})`);
  assert.equal(m.kernel.state.artifacts.get(id)?.status, "MERGED");
}

async function merged(m: Mesh, name: string) {
  const p = await mergeable(m, name);
  await merge(m, p.id);
  return p;
}

/** Runtime-derived evidence: no claimer, so verified by construction. */
async function evidence(m: Mesh, criterionId: string, uri?: string) {
  const landed = await m.supervisor.markCriterionEvidence(criterionId, {
    kind: "fixture",
    ...(uri ? { artifactRef: { uri } } : {}),
    recordedAt: now(m),
  });
  assert.equal(landed, "EVIDENCED", `fixture: ${criterionId} evidenced`);
}

/** A mission the supervisor itself declared COMPLETED, through its own watchdog. */
async function completed(m: Mesh): Promise<{ shipUri: string }> {
  const p = await submitted(m, "shipped");
  await evidence(m, "ship", p.uri);
  await evidence(m, "docs");
  await m.supervisor.forceWatchdog();
  assert.equal(goal(m).status, "COMPLETED", "fixture: the termination verdict completed the mission");
  return { shipUri: p.uri };
}

/** Resolve once the log has stopped growing for a while (turns woken by a fixture have settled). */
async function quiet(m: Mesh, stillMs = 150, maxMs = 10_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  let last = -1;
  while (Date.now() < deadline) {
    const n = (await m.store.read()).length;
    if (n === last) return;
    last = n;
    await new Promise((r) => setTimeout(r, stillMs));
  }
  assert.fail("fixture: the mesh never went quiet");
}

function satisfied(criterionId: string, uri: string): Emit {
  // `markCriterionEvidence`'s own emit, for a verified claim citing `uri`.
  return {
    type: "requirement.satisfied",
    payload: { criterionId, evidence: { kind: "criteria-acceptance", artifactRef: { uri }, recordedAt: "2026-09-25T00:00:00.000Z", verified: true }, verified: true },
    actorId: "human",
  };
}

function approvedBy(actorId: string, role: string, p: { id: string; uri: string }): Emit {
  // `recordDecision`'s payload for an `approve` on an implementation artifact.
  return {
    type: "review.approved",
    payload: { subject: `artifact:${p.id}`, fallbackSubject: "implementation", kind: "approve", artifactId: p.id, artifactRef: { uri: p.uri }, actorId, actorRole: role },
    actorId,
  };
}

// --- the table ---------------------------------------------------------------

type Ctx = Record<string, string>;

interface Row {
  /** Event type as it appears on the log. */
  event: string;
  /** The precondition the supervisor enforces before it emits, and where. */
  guard: string;
  /** Legal steps to the pre-state the illegal event is aimed at. */
  setup(m: Mesh): Promise<Ctx>;
  /** The event the supervisor would never emit from that pre-state. */
  illegal(ctx: Ctx, m: Mesh): Emit;
  /** The legal form: its own (legal) pre-state, the event, and what it must do. */
  legal: {
    setup(m: Mesh): Promise<Ctx>;
    /** Emit at the kernel (the default) or run the supervisor path that emits it. */
    act: ((ctx: Ctx, m: Mesh) => Emit) | { run(ctx: Ctx, m: Mesh): Promise<void> };
    expect(ctx: Ctx, m: Mesh): void;
  };
  /** Set while the reducer accepts the illegal event: `BUG: <defect>, <file:line>`. */
  bug?: string;
  /** `policies.transitions` for this row's mesh, when the row is about a configured gate. */
  transitions?: Record<string, string[]>;
}

const TABLE: Row[] = [
  // ---- tasks ----------------------------------------------------------------
  {
    event: "task.completed",
    guard: "Supervisor.completeTask: task must be CLAIMED or IN_PROGRESS",
    setup: async (m) => ({ taskId: await newTask(m, "never-claimed") }),
    illegal: (c) => ({ type: "task.completed", payload: { taskId: c.taskId, agentId: "dev", summary: "done" }, actorId: "dev" }),
    legal: {
      setup: async (m) => ({ taskId: await claimed(m) }),
      act: (c) => ({ type: "task.completed", payload: { taskId: c.taskId, agentId: "dev", summary: "done" }, actorId: "dev" }),
      expect: (c, m) => assert.equal(m.kernel.state.tasks.get(c.taskId)?.status, "COMPLETED"),
    },
  },
  {
    event: "task.completed",
    guard: "Supervisor.completeTask: only the claimer (or the operator) may complete",
    setup: async (m) => ({ taskId: await claimed(m, "dev") }),
    illegal: (c) => ({ type: "task.completed", payload: { taskId: c.taskId, agentId: "qa", summary: "done" }, actorId: "qa" }),
    legal: {
      setup: async (m) => ({ taskId: await claimed(m, "dev") }),
      act: (c) => ({ type: "task.completed", payload: { taskId: c.taskId, agentId: "dev", summary: "done" }, actorId: "dev" }),
      expect: (c, m) => assert.equal(m.kernel.state.agents.get("dev")?.state.activeTaskId, undefined, "the claimer is freed"),
    },
  },
  {
    event: "task.completed",
    guard: "Supervisor.completeTask: a COMPLETED task is refused (`task is COMPLETED`)",
    setup: async (m) => {
      const taskId = await claimed(m, "dev");
      assert.equal((await m.supervisor.completeTask("dev", taskId, "first")).ok, true, "fixture: first completion");
      return { taskId };
    },
    illegal: (c) => ({ type: "task.completed", payload: { taskId: c.taskId, agentId: "dev", summary: "again" }, actorId: "dev" }),
    legal: {
      setup: async (m) => ({ taskId: await claimed(m, "dev") }),
      act: (c) => ({ type: "task.completed", payload: { taskId: c.taskId, agentId: "dev", summary: "first" }, actorId: "dev" }),
      expect: (c, m) => assert.ok(m.kernel.state.tasks.get(c.taskId)?.completedAt),
    },
  },
  {
    event: "task.claimed",
    guard: "Supervisor.claimTask: a task that is not OPEN is refused unless assigned to the claimant",
    setup: async (m) => ({ taskId: await claimed(m, "dev") }),
    illegal: (c) => ({ type: "task.claimed", payload: { taskId: c.taskId, agentId: "qa" }, actorId: "qa" }),
    legal: {
      setup: async (m) => ({ taskId: await newTask(m, "open-for-qa") }),
      act: (c) => ({ type: "task.claimed", payload: { taskId: c.taskId, agentId: "qa" }, actorId: "qa" }),
      expect: (c, m) => assert.equal(m.kernel.state.tasks.get(c.taskId)?.claimedBy, "qa"),
    },
  },
  {
    event: "task.claimed{reassign}",
    guard: "Supervisor.claimTask: `reassign` is only ever truthy on an OPEN task (a non-OPEN task not assigned to the claimant is refused first)",
    setup: async (m) => ({ taskId: await claimed(m, "dev") }),
    illegal: (c) => ({ type: "task.claimed", payload: { taskId: c.taskId, agentId: "qa", reassign: true }, actorId: "qa" }),
    legal: {
      // The one shape the supervisor emits `reassign: true` in: an OPEN task
      // still earmarked (`assignedTo`) for a seat that released it.
      setup: async (m) => {
        const taskId = await claimed(m, "dev");
        await m.kernel.emit("task.claimed", { taskId, agentId: null }, { actorId: "recovery-manager" });
        return { taskId };
      },
      act: (c) => ({ type: "task.claimed", payload: { taskId: c.taskId, agentId: "qa", reassign: true }, actorId: "qa" }),
      expect: (c, m) => assert.equal(m.kernel.state.tasks.get(c.taskId)?.claimedBy, "qa"),
    },
  },
  {
    event: "task.claimed",
    guard: "Supervisor.claimTask: the claimant must hold every requiredCapability (evaluateCapability, else denied())",
    setup: async (m) => ({ taskId: await newTask(m, "needs-merge", ["git.merge"]) }),
    illegal: (c) => ({ type: "task.claimed", payload: { taskId: c.taskId, agentId: "qa" }, actorId: "qa" }),
    legal: {
      setup: async (m) => ({ taskId: await newTask(m, "needs-merge", ["git.merge"]) }),
      act: (c) => ({ type: "task.claimed", payload: { taskId: c.taskId, agentId: "lead" }, actorId: "lead" }),
      expect: (c, m) => assert.equal(m.kernel.state.tasks.get(c.taskId)?.claimedBy, "lead"),
    },
  },
  {
    event: "task.claimed{agentId:null}",
    guard: "Supervisor (terminal agent failure): releases only the failed seat's activeTaskId, which completion has already cleared",
    setup: async (m) => {
      const taskId = await claimed(m, "dev");
      assert.equal((await m.supervisor.completeTask("dev", taskId, "done")).ok, true, "fixture: completed");
      return { taskId };
    },
    illegal: (c) => ({ type: "task.claimed", payload: { taskId: c.taskId, agentId: null }, actorId: "recovery-manager" }),
    legal: {
      setup: async (m) => ({ taskId: await claimed(m, "dev") }),
      act: (c) => ({ type: "task.claimed", payload: { taskId: c.taskId, agentId: null }, actorId: "recovery-manager" }),
      expect: (c, m) => assert.equal(m.kernel.state.tasks.get(c.taskId)?.status, "OPEN"),
    },
  },

  // ---- escalations ------------------------------------------------------------
  {
    event: "escalation.responded",
    guard: "Supervisor.respondEscalation: an AUTO_RESOLVED card is a no-op, never RESPONDED",
    setup: async (m) => {
      const primary = await m.supervisor.escalate({ reason: "budget_exhausted", raisedBy: "dev", detail: { k: "primary" } });
      const derived = await m.supervisor.escalate({ reason: "stalemate", raisedBy: "termination-manager", kind: "derived", supports: [primary.id] });
      assert.equal((await m.supervisor.respondEscalation(primary.id, "raise it")).ok, true, "fixture: primary answered");
      assert.equal(m.kernel.state.escalations.get(derived.id)?.status, "AUTO_RESOLVED", "fixture: the runtime retired the summary");
      return { escalationId: derived.id };
    },
    illegal: (c) => ({ type: "escalation.responded", payload: { escalationId: c.escalationId, response: "forged", respondedBy: "human" }, actorId: "human" }),
    legal: {
      setup: async (m) => ({ escalationId: (await m.supervisor.escalate({ reason: "budget_exhausted", raisedBy: "dev" })).id }),
      act: (c) => ({ type: "escalation.responded", payload: { escalationId: c.escalationId, response: "raise it", respondedBy: "human" }, actorId: "human" }),
      expect: (c, m) => assert.equal(m.kernel.state.escalations.get(c.escalationId)?.status, "RESPONDED"),
    },
  },
  {
    event: "escalation.responded",
    guard: "Supervisor.respondEscalation: a card that is not OPEN is refused (`escalation is RESPONDED`)",
    setup: async (m) => {
      const esc = await m.supervisor.escalate({ reason: "budget_exhausted", raisedBy: "dev" });
      assert.equal((await m.supervisor.respondEscalation(esc.id, "first answer")).ok, true, "fixture: answered");
      return { escalationId: esc.id };
    },
    illegal: (c) => ({ type: "escalation.responded", payload: { escalationId: c.escalationId, response: "rewritten", respondedBy: "human" }, actorId: "human" }),
    legal: {
      setup: async (m) => ({ escalationId: (await m.supervisor.escalate({ reason: "budget_exhausted", raisedBy: "dev" })).id }),
      act: (c) => ({ type: "escalation.responded", payload: { escalationId: c.escalationId, response: "first answer", respondedBy: "human" }, actorId: "human" }),
      expect: (c, m) => assert.equal(m.kernel.state.escalations.get(c.escalationId)?.response, "first answer"),
    },
  },

  // ---- goal verdicts ----------------------------------------------------------
  {
    event: "goal.completed",
    guard: "Supervisor.watchdog: only on a `complete` termination verdict (every mandatory criterion satisfied)",
    setup: async () => ({}),
    illegal: (_c, m) => ({ type: "goal.completed", payload: { goalId: goal(m).id, reason: "all_mandatory_criteria_satisfied" }, actorId: "human" }),
    legal: {
      setup: async (m) => {
        // A task someone OWNS keeps the watchdog's verdict at `continue`, so
        // the mission is still open when the legal event is emitted. Without
        // it a watchdog tick after the second `evidence` completes the goal
        // first, and the act becomes a second verdict on a COMPLETED goal --
        // which is row [11]/[12]'s illegal shape, not this row's legal one.
        await claimed(m, "dev");
        await evidence(m, "ship", (await submitted(m, "shipped")).uri);
        await evidence(m, "docs");
        assert.notEqual(goal(m).status, "COMPLETED", "fixture: the mission is satisfied but still open");
        return {};
      },
      act: (_c, m) => ({ type: "goal.completed", payload: { goalId: goal(m).id, reason: "all_mandatory_criteria_satisfied" }, actorId: "human" }),
      expect: (_c, m) => assert.equal(goal(m).status, "COMPLETED"),
    },
  },
  {
    event: "goal.failed",
    guard: "Supervisor: a COMPLETED mission leaves only through reopenGoal (completeMission shuts the watchdog down)",
    setup: async (m) => {
      await completed(m);
      return {};
    },
    illegal: (_c, m) => ({ type: "goal.failed", payload: { goalId: goal(m).id, reason: "wall_clock_exceeded" }, actorId: "human" }),
    legal: {
      setup: async () => ({}),
      act: (_c, m) => ({ type: "goal.failed", payload: { goalId: goal(m).id, reason: "wall_clock_exceeded" }, actorId: "human" }),
      expect: (_c, m) => assert.equal(goal(m).status, "FAILED"),
    },
  },
  {
    event: "goal.escalated",
    guard: "Supervisor: a COMPLETED mission leaves only through reopenGoal (completeMission shuts the watchdog down)",
    setup: async (m) => {
      await completed(m);
      return {};
    },
    illegal: (_c, m) => ({ type: "goal.escalated", payload: { goalId: goal(m).id, reason: "stalemate", detail: {} }, actorId: "human" }),
    legal: {
      setup: async () => ({}),
      act: (_c, m) => ({ type: "goal.escalated", payload: { goalId: goal(m).id, reason: "stalemate", detail: {} }, actorId: "human" }),
      expect: (_c, m) => assert.equal(goal(m).status, "ESCALATED"),
    },
  },
  {
    // The side door around row [10]: the verdict guard lives on
    // `goal.completed`, and a bare status change used to set COMPLETED with
    // every mandatory criterion unproven.
    event: "goal.status_changed",
    guard: "Supervisor.resumeIfNothingPending: the only emitter, and it only moves ESCALATED back to ACTIVE — a verdict has its own event",
    setup: async () => ({}),
    illegal: (_c, m) => ({ type: "goal.status_changed", payload: { goalId: goal(m).id, status: "COMPLETED", reason: "forged" }, actorId: "human" }),
    legal: {
      setup: async (m) => {
        // The legal form of row [12]'s event -- the halt this door reverses.
        await m.kernel.emit("goal.escalated", { goalId: goal(m).id, reason: "stalemate", detail: {} }, { actorId: "termination-manager", goalId: goal(m).id });
        assert.equal(goal(m).status, "ESCALATED", "fixture: the mission is halted");
        return {};
      },
      act: (_c, m) => ({ type: "goal.status_changed", payload: { goalId: goal(m).id, status: "ACTIVE", reason: "all escalations resolved" }, actorId: "termination-manager" }),
      expect: (_c, m) => assert.equal(goal(m).status, "ACTIVE"),
    },
  },
  {
    event: "goal.status_changed",
    guard: "Supervisor: a COMPLETED mission leaves only through reopenGoal, not a status change",
    setup: async (m) => {
      await completed(m);
      return {};
    },
    illegal: (_c, m) => ({ type: "goal.status_changed", payload: { goalId: goal(m).id, status: "ACTIVE", reason: "forged" }, actorId: "human" }),
    legal: {
      setup: async (m) => {
        await m.kernel.emit("goal.escalated", { goalId: goal(m).id, reason: "stalemate", detail: {} }, { actorId: "termination-manager", goalId: goal(m).id });
        return {};
      },
      act: (_c, m) => ({ type: "goal.status_changed", payload: { goalId: goal(m).id, status: "ACTIVE", reason: "all escalations resolved" }, actorId: "termination-manager" }),
      expect: (_c, m) => assert.equal(goal(m).status, "ACTIVE"),
    },
  },

  // ---- criteria ---------------------------------------------------------------
  {
    event: "requirement.satisfied",
    guard: "Supervisor.markCriterionEvidence: a verified claim on a MANDATORY criterion may not cite a DRAFT/REJECTED artifact",
    setup: async (m) => ({ uri: (await patch(m, "never-submitted")).uri }),
    illegal: (c) => satisfied("ship", c.uri),
    legal: {
      setup: async (m) => ({ uri: (await submitted(m, "submitted")).uri }),
      act: (c) => satisfied("ship", c.uri),
      expect: (_c, m) => assert.equal(criterion(m, "ship").status, "EVIDENCED"),
    },
  },
  {
    event: "requirement.satisfied",
    guard: "Supervisor.markCriterionEvidence: a reopened criterion refuses evidence the operator rejected (`rejectedEvidence`)",
    setup: async (m) => {
      const { shipUri } = await completed(m);
      const r = await m.supervisor.reopenGoal({ reason: "not good enough" });
      assert.equal(r.ok, true, `fixture: reopen (${r.reason ?? ""})`);
      assert.ok(criterion(m, "ship").rejectedEvidence?.includes(shipUri), "fixture: the rejected artifact is on record");
      // A reopen wakes the seats even in a parked mesh, and their stub turns
      // write to the log while the row is measuring it. Wait them out, or the
      // "byte-identical" check sees their budget events, not the refusal.
      await quiet(m);
      return { uri: shipUri };
    },
    illegal: (c) => satisfied("ship", c.uri),
    legal: {
      setup: async (m) => {
        await completed(m);
        assert.equal((await m.supervisor.reopenGoal({ reason: "not good enough" })).ok, true, "fixture: reopen");
        return { uri: (await submitted(m, "superseding")).uri };
      },
      act: (c) => satisfied("ship", c.uri),
      expect: (_c, m) => assert.equal(criterion(m, "ship").status, "EVIDENCED"),
    },
  },
  {
    event: "requirement.removed",
    guard: "Supervisor.removeCriterion: never remove the only unproven mandatory criterion (the removal would complete the mission)",
    setup: async (m) => {
      await evidence(m, "docs");
      return {};
    },
    illegal: (_c, m) => ({ type: "requirement.removed", payload: { goalId: goal(m).id, criterionId: "ship", reason: "out of scope" }, actorId: "human" }),
    legal: {
      setup: async (m) => {
        await evidence(m, "docs");
        return {};
      },
      act: (_c, m) => ({ type: "requirement.removed", payload: { goalId: goal(m).id, criterionId: "extra", reason: "out of scope" }, actorId: "human" }),
      expect: (_c, m) => assert.equal(goal(m).acceptanceCriteria.some((c) => c.id === "extra"), false),
    },
  },
  {
    event: "requirement.revised{mandatory:false}",
    guard: "Supervisor.reviseCriterion: demoting the only unproven mandatory criterion is refused like removal",
    setup: async (m) => {
      await evidence(m, "docs");
      return {};
    },
    illegal: (_c, m) => ({ type: "requirement.revised", payload: { goalId: goal(m).id, criterionId: "ship", mandatory: false }, actorId: "human" }),
    legal: {
      setup: async (m) => {
        await evidence(m, "docs");
        return {};
      },
      act: (_c, m) => ({ type: "requirement.revised", payload: { goalId: goal(m).id, criterionId: "docs", mandatory: false }, actorId: "human" }),
      expect: (_c, m) => assert.equal(criterion(m, "docs").mandatory, false),
    },
  },

  // ---- artifacts --------------------------------------------------------------
  {
    event: "artifact.transition",
    guard: "machine table (assertArtifactTransition): DRAFT -> MERGED is not an edge",
    setup: async (m) => ({ id: (await patch(m, "draft")).id }),
    illegal: (c) => ({ type: "artifact.transition", payload: { artifactId: c.id, to: "MERGED", actorId: "lead", gateSatisfied: true }, actorId: "lead" }),
    legal: {
      setup: async (m) => ({ id: (await patch(m, "draft")).id }),
      act: (c) => ({ type: "artifact.transition", payload: { artifactId: c.id, to: "READY_FOR_REVIEW", actorId: "dev", gateSatisfied: true }, actorId: "dev" }),
      expect: (c, m) => assert.equal(m.kernel.state.artifacts.get(c.id)?.status, "READY_FOR_REVIEW"),
    },
  },
  {
    event: "artifact.transition",
    guard: "APPROVED requires an `approve` record on the artifact (gateSatisfiedWithConfig, and policy review-authority)",
    setup: async (m) => ({ id: (await underReview(m, "unreviewed")).id }),
    illegal: (c) => ({ type: "artifact.transition", payload: { artifactId: c.id, to: "APPROVED", actorId: "lead", gateSatisfied: true }, actorId: "lead" }),
    legal: {
      setup: async (m) => ({ id: (await underReview(m, "unreviewed")).id }),
      act: (c) => ({ type: "artifact.transition", payload: { artifactId: c.id, to: "READY_FOR_REVIEW", actorId: "dev", gateSatisfied: true }, actorId: "dev" }),
      expect: (c, m) => assert.equal(m.kernel.state.artifacts.get(c.id)?.status, "READY_FOR_REVIEW"),
    },
  },
  {
    event: "artifact.transition (same status)",
    guard: "machine table: MERGED has no out-edge, MERGED -> MERGED included (opMerge's comment names the duplicate this let through)",
    setup: async (m) => ({ id: (await merged(m, "landed")).id }),
    illegal: (c) => ({ type: "artifact.transition", payload: { artifactId: c.id, to: "MERGED", actorId: "lead", gateSatisfied: true }, actorId: "lead" }),
    legal: {
      setup: async (m) => ({ id: (await mergeable(m, "staged")).id }),
      act: { run: (c, m) => merge(m, c.id) },
      expect: (c, m) => assert.equal(m.kernel.state.artifacts.get(c.id)?.status, "MERGED"),
    },
  },
  {
    event: "artifact.transition{to:MERGED}",
    guard: "opMerge: MERGED is recorded only after the git merge (or materialization) landed the change",
    setup: async (m) => ({ id: (await mergeable(m, "staged")).id }),
    illegal: (c) => ({ type: "artifact.transition", payload: { artifactId: c.id, to: "MERGED", actorId: "lead", gateSatisfied: true }, actorId: "lead" }),
    legal: {
      setup: async (m) => ({ id: (await mergeable(m, "staged")).id }),
      act: { run: (c, m) => merge(m, c.id) },
      expect: (c, m) => assert.equal(m.kernel.state.artifacts.get(c.id)?.status, "MERGED"),
    },  },
  {
    event: "patch.ready",
    guard: "Supervisor: an unresolvable artifact ref is refused as patch.ready.unresolved-artifact",
    setup: async () => ({}),
    illegal: () => ({ type: "patch.ready", payload: { artifactId: "art-does-not-exist", artifactRef: "artifact://CodePatch/ghost/1" }, actorId: "dev" }),
    legal: {
      setup: async (m) => ({ id: (await patch(m, "ready")).id }),
      act: (c) => ({ type: "patch.ready", payload: { artifactId: c.id, artifactRef: artifactUri("CodePatch", "ready", 1) }, actorId: "dev" }),
      expect: (c, m) => assert.equal(m.kernel.state.artifacts.get(c.id)?.status, "READY_FOR_REVIEW"),
    },
  },
  {
    event: "review.approved",
    guard: "Supervisor.recordDecision: the owner may not approve their own artifact while a peer reviewer exists (`self-approval`)",
    setup: async (m) => {
      const p = await underReview(m, "mine");
      return { id: p.id, uri: p.uri };
    },
    illegal: (c) => approvedBy("dev", "developer", { id: c.id, uri: c.uri }),
    legal: {
      setup: async (m) => {
        const p = await underReview(m, "mine");
        return { id: p.id, uri: p.uri };
      },
      act: (c) => approvedBy("lead", "tech-lead", { id: c.id, uri: c.uri }),
      expect: (c, m) => assert.equal(m.kernel.state.artifacts.get(c.id)?.status, "APPROVED"),
    },
  },
  {
    event: "implementation.completed",
    guard: "Supervisor.mirrorTransition: emitted only when a CodePatch reaches MERGED",
    setup: async (m) => ({ id: (await mergeable(m, "not-yet")).id }),
    illegal: (c) => ({ type: "implementation.completed", payload: { artifactId: c.id, subject: "implementation" }, actorId: "dev" }),
    legal: {
      setup: async (m) => ({ id: (await mergeable(m, "staged")).id }),
      act: { run: (c, m) => merge(m, c.id) },
      expect: (_c, m) =>
        assert.ok(
          [...m.kernel.state.approvals.values()].flat().some((r) => r.kind === "pass" && r.subject === "implementation"),
          "the merge recorded an implementation|pass",
        ),
    },
  },

  {
    // Not a supervisor pre-check: here the REDUCER is the guard, and it does
    // refuse. The row is about the other half of "refused" -- `recordApproval`
    // writes the signature before `doTransition` throws on the gate, and
    // `Kernel.applyAndAppend` rethrows without restoring anything, so memory
    // keeps an approval the log never received. The next replay drops it.
    event: "review.approved (gate unsatisfied)",
    guard: "reducer: CodePatch -> APPROVED checks the configured patch.approve gate (gateSatisfiedWithConfig)",
    transitions: { "patch.approve": ["tech-lead.approve"] },
    setup: async (m) => {
      const p = await underReview(m, "gated");
      return { id: p.id, uri: p.uri };
    },
    // The operator passes every policy check, so `recordDecision` really does
    // emit this; the reducer is the only thing that says no.
    illegal: (c) => approvedBy("human", "human", { id: c.id, uri: c.uri }),
    legal: {
      setup: async (m) => {
        const p = await underReview(m, "gated");
        return { id: p.id, uri: p.uri };
      },
      act: (c) => approvedBy("lead", "tech-lead", { id: c.id, uri: c.uri }),
      expect: (c, m) => assert.equal(m.kernel.state.artifacts.get(c.id)?.status, "APPROVED"),
    },
  },

  // ---- decisions --------------------------------------------------------------
  {
    event: "decision.ratified",
    guard: "Supervisor.ratifyDecision: the ratifier needs architecture.approve (evaluateAuthority, else denied())",
    setup: async (m) => ({ decisionId: (await m.supervisor.proposeDecision("dev", "datastore", { choice: "sqlite" })).id }),
    illegal: (c) => ({ type: "decision.ratified", payload: { decisionId: c.decisionId, approvedBy: ["qa"] }, actorId: "qa" }),
    legal: {
      setup: async (m) => ({ decisionId: (await m.supervisor.proposeDecision("dev", "datastore", { choice: "sqlite" })).id }),
      act: (c) => ({ type: "decision.ratified", payload: { decisionId: c.decisionId, approvedBy: ["lead"] }, actorId: "lead" }),
      expect: (c, m) => assert.equal(m.kernel.state.decisions.get(c.decisionId)?.status, "RATIFIED"),
    },
  },
];

// --- the tests ---------------------------------------------------------------

/** The exported projections, round-tripped through JSON so a diff names the field that moved. */
function snapshot(m: Mesh): unknown {
  return JSON.parse(JSON.stringify(exportState(m.kernel.state)));
}

TABLE.forEach((row, i) => {
  const label = `[${String(i + 1).padStart(2, "0")}] ${row.event}`;

  test(`${label} REFUSED — ${row.guard}`, row.bug ? { todo: row.bug } : {}, async () => {
    const m = await mesh(row.transitions);
    try {
      const ctx = await row.setup(m);
      const before = snapshot(m);
      const logged = (await m.store.read()).length;
      const e = row.illegal(ctx, m);

      await assert.rejects(emit(m, e), KernelRejectedError, `the kernel must refuse ${e.type} ${JSON.stringify(e.payload)}`);
      assert.deepEqual(snapshot(m), before, "a refused event must leave the projections exactly as they were");
      assert.equal((await m.store.read()).length, logged, "and must not reach the log");
    } finally {
      await m.cleanup();
    }
  });

  test(`${label} ACCEPTED (positive control) — the legal form`, async () => {
    const m = await mesh(row.transitions);
    try {
      const ctx = await row.legal.setup(m);
      const logged = (await m.store.read()).length;
      if (typeof row.legal.act === "function") await emit(m, row.legal.act(ctx, m));
      else await row.legal.act.run(ctx, m);
      assert.ok((await m.store.read()).length > logged, "the legal form is appended");
      row.legal.expect(ctx, m);
    } finally {
      await m.cleanup();
    }
  });
});

/**
 * The guards above are LIVE-only: they stop a new event reaching the log, they
 * do not re-judge the log. A mission written by older code may already hold an
 * event they refuse, and a restart after an upgrade must still boot it -- so the
 * same event that `kernel.emit` refuses must replay.
 */
test("a log that already holds a now-refused event still replays; the same event emitted live is refused", async () => {
  const m = await mesh();
  try {
    const taskId = await claimed(m, "dev");
    assert.equal((await m.supervisor.completeTask("dev", taskId, "first")).ok, true, "fixture: completed");
    const esc = await m.supervisor.escalate({ reason: "budget_exhausted", raisedBy: "dev" });
    assert.equal((await m.supervisor.respondEscalation(esc.id, "first answer")).ok, true, "fixture: answered");
    const logged = await m.store.read();
    const last = logged[logged.length - 1]!;
    // What an older runtime could have written: a non-claimer re-completing a
    // finished task, and a second answer overwriting the operator's first.
    const legacy: MeshEvent[] = [
      { ...last, id: "evt-legacy-1", seq: undefined, type: "task.completed", actorId: "qa", correlationId: undefined, causationId: undefined, payload: { taskId, agentId: "qa", summary: "again" } },
      { ...last, id: "evt-legacy-2", seq: undefined, type: "escalation.responded", actorId: "human", correlationId: undefined, causationId: undefined, payload: { escalationId: esc.id, response: "rewritten", respondedBy: "human" } },
    ];
    const store = new MemoryEventStore();
    for (const e of [...logged, ...legacy]) await store.append({ ...e, seq: undefined });
    const booted = new Kernel(store, new FixedClock(), undefined, projectionConfigFor(m.config));
    await booted.replayFromStore();
    assert.equal(booted.state.eventCount, logged.length + legacy.length, "every logged event replayed, the legacy ones included");
    assert.equal(booted.state.escalations.get(esc.id)?.response, "rewritten", "replay applies what the log holds");

    for (const e of legacy) {
      await assert.rejects(
        booted.emit(e.type, e.payload, { actorId: e.actorId }),
        KernelRejectedError,
        `the same ${e.type} emitted live is refused`,
      );
    }
  } finally {
    await m.cleanup();
  }
});
