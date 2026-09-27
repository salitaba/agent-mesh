import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, evidenceContent } from "../helpers";
import { seededArtifactState, tryTransition, createRandomTrail } from "./_property-trail";
import { MACHINE_TRANSITIONS, artifactMachineOf } from "../../packages/protocol/src/catalog";
import { forEachSeed } from "../support/seed";
import { FakeWorkspace, installWorkspace } from "../support/fake-workspace";
import { applyEvent as coreApply, ProjectionError } from "../../packages/core/src/projections";
import { createInitialState, type Projections } from "../../packages/core/src/state";
import { ARTIFACT_STATUSES } from "../../packages/protocol/src/catalog";
import type { Artifact, ArtifactStatus, ArtifactType, AgentDefinition, EventType, MeshEvent, Task } from "../../packages/protocol/src/index";

// Every randomized test below runs its historical fixed seed(s) plus one more:
// `MESH_SEED` if set, else a fresh random seed. A failure names its seed and
// the command that replays it (see `tests/support/seed.ts`).

test("invariant: no artifact ever has two active owners", async () => {
  const m = await makeMesh({
    agents: [
      { id: "a", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "b", role: "developer", capabilities: ["repository.write"], interests: [] },
    ],
    mayContact: { a: ["b"], b: ["a"] },
  });
  const turn = { turnId: "t", agentId: "a", reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] };
  const ids: string[] = [];
  for (let i = 0; i < 8; i++) {
    const c = await m.supervisor.createArtifact({ actorId: i % 2 ? "a" : "b", name: `p${i}`, type: "CodePatch", content: `d${i}` });
    if ("artifact" in c) ids.push(c.artifact.id);
  }
  assert.equal(ids.length, 8, "sanity: every artifact was created");
  try {
    await forEachSeed([1234], async (rng) => {
      for (let i = 0; i < 300; i++) {
        const artifactId = ids[Math.floor(rng() * ids.length)];
        const actor = rng() < 0.5 ? "a" : "b";
        await m.supervisor.executeOp(actor, { op: "acquire_lease", artifactId, files: [] }, turn as never);
        if (rng() < 0.3) await m.supervisor.executeOp(actor, { op: "release_lease", artifactId }, turn as never);
        const holders = [...m.kernel.state.leases.values()].filter((l) => l.artifactId === artifactId && !l.releasedAt);
        assert.ok(holders.length <= 1, `step ${i}: artifact ${artifactId} has ${holders.length} active holders`);
        // The index the lease gate reads must agree with the leases themselves.
        const indexed = m.kernel.state.activeLeaseByArtifact.get(artifactId);
        assert.equal(indexed, holders[0]?.id, `step ${i}: activeLeaseByArtifact disagrees with the live lease for ${artifactId}`);
      }
    });
  } finally {
    await m.cleanup();
  }
});

test("invariant: illegal state transitions never become visible", async () => {
  await forEachSeed([99], (rng) => {
    const statuses = Object.keys(MACHINE_TRANSITIONS.code) as ArtifactStatus[];
    let checked = 0;
    for (let i = 0; i < 2000; i++) {
      const from = statuses[Math.floor(rng() * statuses.length)];
      const to = statuses[Math.floor(rng() * statuses.length)];
      const allowed = (MACHINE_TRANSITIONS.code[from] ?? []).includes(to);
      const { state } = seededArtifactState(from);
      const res = tryTransition(state, to);
      if (!allowed && from !== to) {
        assert.equal(res.ok, false, `${from} -> ${to} must be impossible`);
        assert.match(res.error ?? "", /illegal artifact transition|blocked by unsatisfied gate/);
        assert.equal(state.artifacts.get("art-prop")?.status, from, `a refused ${from} -> ${to} must leave the status where it was`);
        checked++;
      }
    }
    assert.ok(checked > 500, `sanity: only ${checked} illegal pairs exercised`);
  });
});

function trailEvent(id: string, type: EventType, payload: unknown, n: number): MeshEvent {
  return { id, type, timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(), goalId: "goal-1", payload };
}

/**
 * The old version of this test asserted only that each FINAL status was a key
 * of the machine, which every status the trail can request already is — it
 * could not fail. What the invariant claims is about the WALK: every step an
 * artifact actually took is an edge of its machine. `artifactHistory` records
 * each status the reducer moved an artifact to, so that is read back and every
 * consecutive pair is checked, across all three machines, together with the
 * converse: a refused step leaves neither the status nor the history moved.
 */
test("invariant: random transition trails only ever walk the declared machine", async () => {
  const types: ArtifactType[] = ["CodePatch", "ReleasePlan", "ADR"];
  await forEachSeed([1, 2, 3], (rng) => {
    const state = createInitialState();
    let n = 0;
    let accepted = 0;
    let refused = 0;
    for (let i = 0; i < 150; i++) {
      const type = types[Math.floor(rng() * types.length)]!;
      const kind = artifactMachineOf(type);
      const table = MACHINE_TRANSITIONS[kind];
      const initial = Object.keys(table)[0] as ArtifactStatus;
      const a: Artifact = {
        id: `art-${i}`, name: `p${i}`, type, goalId: "goal-1", owner: "dev", version: 1, status: initial,
        contentRef: "mem://x", digest: "sha256:0", metadata: {}, provenance: { source: "agent", trustLevel: 50 },
        createdAt: new Date(0).toISOString(), createdBy: "dev",
      };
      coreApply(state, trailEvent(`evt-c-${i}`, "artifact.created", { artifact: a }, n++), { transitionGates: {} });
      for (let t = 0; t < 10; t++) {
        const before = state.artifacts.get(a.id)!.status as ArtifactStatus;
        const histLen = state.artifactHistory.get(a.id)!.length;
        const to = ARTIFACT_STATUSES[Math.floor(rng() * ARTIFACT_STATUSES.length)]!;
        if (to === before) continue;
        try {
          coreApply(state, trailEvent(`evt-t-${i}-${t}`, "artifact.transition", { artifactId: a.id, to, gateSatisfied: true }, n++), { transitionGates: {} });
          accepted++;
          assert.ok((table[before] ?? []).includes(to), `${a.id} (${kind}): accepted ${before} -> ${to}, which is not an edge`);
        } catch (err) {
          if (!(err instanceof ProjectionError)) throw err;
          refused++;
          assert.equal(state.artifacts.get(a.id)!.status, before, `${a.id}: refused ${before} -> ${to} moved the status`);
          assert.equal(state.artifactHistory.get(a.id)!.length, histLen, `${a.id}: refused ${before} -> ${to} grew the history`);
        }
      }
      const walk = state.artifactHistory.get(a.id)!.map((x) => x.status as ArtifactStatus);
      assert.equal(walk[0], initial, `${a.id}: the walk starts where the artifact was created`);
      for (let k = 1; k < walk.length; k++) {
        const [from, to] = [walk[k - 1]!, walk[k]!];
        assert.ok((table[from] ?? []).includes(to), `${a.id} (${kind}) walked ${from} -> ${to}, not an edge; walk: ${walk.join(" > ")}`);
      }
    }
    assert.ok(accepted > 100 && refused > 100, `sanity: trail too thin (accepted ${accepted}, refused ${refused})`);
  });
});

test("invariant: budget accounting never goes negative", async () => {
  await forEachSeed([7], async (rng) => {
    const m = await makeMesh({ agents: [{ id: "a", role: "dev", interests: [], capabilities: [] }], mayContact: { a: [] } });
    try {
      const key = `agent:${m.kernel.state.activeGoalId}/a`;
      let ops = 0;
      for (let i = 0; i < 1000; i++) {
        const roll = rng();
        if (roll < 0.4) {
          const r = await m.supervisor.deps.budget.reserve(key, "tokens", 100, 1000, { actorId: "a" });
          if (r.blocked) continue;
          if (rng() < 0.5) await m.supervisor.deps.budget.release(key, r.reservationId);
          else await m.supervisor.deps.budget.consume(key, "tokens", 80, r.reservationId);
        } else {
          await m.supervisor.deps.budget.consume(key, "tokens", 40, undefined);
        }
        ops++;
        const b = m.kernel.state.budgets.get(key);
        assert.ok(b, "the ledger exists once it has been used");
        assert.ok(b.consumed >= 0, `step ${i}: consumed negative (${b.consumed})`);
        assert.ok(b.reserved >= 0, `step ${i}: reserved negative (${b.reserved})`);
        // `reserved` is a running total kept beside the reservation map; the
        // two are one fact recorded twice and must never drift apart.
        const held = [...b.reservations.values()].reduce((x, y) => x + y, 0);
        assert.equal(b.reserved, held, `step ${i}: reserved ${b.reserved} but live reservations hold ${held}`);
        if (b.limit !== null && b.consumed > b.limit) assert.equal(b.exceeded, true, `step ${i}: over the limit (${b.consumed}/${b.limit}) without the exceeded latch`);
      }
      assert.ok(ops > 500, `sanity: only ${ops} ledger operations ran`);
    } finally {
      await m.cleanup();
    }
  });
});

/**
 * The cap, for a caller that keeps to the contract: reserve, then spend no
 * more than was GRANTED. Partial grants are what make this hold at the edge —
 * a 100-token ask against 30 tokens of headroom is granted 30.
 */
test("invariant: spend kept within its grants never exceeds the limit", async () => {
  await forEachSeed([7], async (rng) => {
    // A declared 1000-token seat, so auto-raise has a finite ceiling to reach.
    const m = await makeMesh({ agents: [{ id: "a", role: "dev", interests: [], capabilities: [], tokens: 1000 }], mayContact: { a: [] } });
    try {
      const key = `agent:${m.kernel.state.activeGoalId}/a`;
      const limit = 1000;
      let blocked = 0;
      for (let i = 0; i < 1500; i++) {
        const r = await m.supervisor.deps.budget.reserve(key, "tokens", 1 + Math.floor(rng() * 150), limit, { actorId: "a" });
        if (r.blocked) {
          blocked++;
          continue;
        }
        assert.ok(r.granted <= r.requested, `step ${i}: granted ${r.granted} of ${r.requested} requested`);
        if (rng() < 0.3) await m.supervisor.deps.budget.release(key, r.reservationId);
        else await m.supervisor.deps.budget.consume(key, "tokens", Math.floor(rng() * (r.granted + 1)), r.reservationId);
        // Against the ledger's CURRENT limit: the mesh auto-raises an agent
        // ledger once it is exhausted, and that is a legal move of the cap.
        const b = m.kernel.state.budgets.get(key)!;
        assert.ok(b.limit !== null && b.limit >= limit, `step ${i}: the limit went missing or down (${b.limit})`);
        assert.ok(b.consumed + b.reserved <= b.limit, `step ${i}: ${b.consumed} consumed + ${b.reserved} reserved exceeds ${b.limit}`);
      }
      assert.ok(blocked > 0, "sanity: the run reached the ceiling");
    } finally {
      await m.cleanup();
    }
  });
});

/**
 * The same cap for the caller the mesh actually has. A turn reserves, is told
 * `granted`, and then settles its REAL spend against the reservation whatever
 * the grant was: `supervisor.ts` logs "the turn is not capped to it" on a short
 * hold and then consumes the full token count against it. Mirrored here at
 * the ledger: reserve 100, spend what the turn spent, whatever was granted.
 */
test(
  "invariant: reservation-backed spend never takes a ledger past its limit",
  async () => {
    await forEachSeed([7], async (rng) => {
      const m = await makeMesh({ agents: [{ id: "a", role: "dev", interests: [], capabilities: [], tokens: 1000 }], mayContact: { a: [] } });
      try {
        const key = `agent:${m.kernel.state.activeGoalId}/a`;
        const limit = 1000;
        // Long enough to climb every auto-raise and meet the ceiling, where the
        // grant finally comes back short and the spend is not.
        for (let i = 0; i < 1000; i++) {
          const r = await m.supervisor.deps.budget.reserve(key, "tokens", 100, limit, { actorId: "a" });
          if (r.blocked) continue;
          // Every turn spends LESS than it asked for (50-99 of 100), so a full
          // grant always covers it; only a short grant near the ceiling can be
          // overrun, and it is.
          if (rng() < 0.2) await m.supervisor.deps.budget.release(key, r.reservationId);
          else await m.supervisor.deps.budget.consume(key, "tokens", 50 + Math.floor(rng() * 50), r.reservationId);
          const b = m.kernel.state.budgets.get(key)!;
          assert.ok(b.consumed <= (b.limit ?? limit), `step ${i}: consumed ${b.consumed} exceeds limit ${b.limit}`);
        }
      } finally {
        await m.cleanup();
      }
    });
  },
);

/**
 * Task ownership, driven through the reducer with the three task events the
 * supervisor emits: `task.claimed` by an agent (only on an OPEN task, as
 * `claimTask` enforces), `task.claimed` with `agentId: null` (the recovery
 * path's release of a terminally failed agent's task), and `task.completed`.
 */
function taskTrail(rng: () => number, steps: number, opts: { unclaims: boolean }): { state: Projections; violations: string[] } {
  const state = createInitialState();
  let n = 0;
  const ev = (type: EventType, payload: unknown): void => coreApply(state, trailEvent(`evt-${n}`, type, payload, n++));
  const agents = ["a0", "a1", "a2", "a3"];
  for (const id of agents) {
    ev("agent.created", { agent: { id, role: "dev", capabilities: [], authority: [], interests: [], budget: { tokens: 1000 } } as unknown as AgentDefinition });
  }
  const violations: string[] = [];
  const tasks: string[] = [];
  for (let i = 0; i < steps; i++) {
    const roll = rng();
    if (roll < 0.25 || tasks.length === 0) {
      const id = `task-${tasks.length}`;
      const task = { id, goalId: "goal-1", title: id, description: "", createdBy: "a0", status: "OPEN", requiredCapabilities: [], artifactRefs: [], delegationDepth: 0, budget: {}, createdAt: new Date(0).toISOString() } as unknown as Task;
      ev("task.created", { task });
      tasks.push(id);
    } else {
      const taskId = tasks[Math.floor(rng() * tasks.length)]!;
      const t = state.tasks.get(taskId)!;
      const agentId = agents[Math.floor(rng() * agents.length)]!;
      if (roll < 0.6) {
        if (t.status === "OPEN") ev("task.claimed", { taskId, agentId });
        else {
          // A claim on a task that is not OPEN must be refused and change nothing.
          const snapshot = JSON.stringify(t);
          assert.throws(() => ev("task.claimed", { taskId, agentId }), ProjectionError, `claim of ${t.status} ${taskId} was accepted`);
          assert.equal(JSON.stringify(state.tasks.get(taskId)), snapshot, `refused claim of ${taskId} mutated it`);
        }
      } else if (roll < 0.75) {
        if (opts.unclaims && t.status === "CLAIMED") ev("task.claimed", { taskId, agentId: null });
      } else if (t.status === "CLAIMED") {
        ev("task.completed", { taskId, agentId: t.claimedBy });
      }
    }
    // Checked after every step: each is true by the task model's own words.
    for (const task of state.tasks.values()) {
      if (task.status === "CLAIMED" && !(task.claimedBy && state.agents.has(task.claimedBy))) violations.push(`step ${i}: ${task.id} CLAIMED by unknown ${task.claimedBy}`);
      if (task.status === "OPEN" && task.claimedBy !== undefined) violations.push(`step ${i}: ${task.id} OPEN but claimedBy ${task.claimedBy}`);
    }
    const holders = new Map<string, string>();
    for (const rec of state.agents.values()) {
      const held = rec.state.activeTaskId;
      if (!held) continue;
      const other = holders.get(held);
      if (other) violations.push(`step ${i}: ${other} and ${rec.state.agentId} both hold ${held} as their active task`);
      holders.set(held, rec.state.agentId);
      const task = state.tasks.get(held);
      if (!task || task.status !== "CLAIMED" || task.claimedBy !== rec.state.agentId) {
        violations.push(`step ${i}: ${rec.state.agentId}'s active task ${held} is ${task ? `${task.status} by ${task.claimedBy ?? "nobody"}` : "missing"}`);
      }
    }
  }
  return { state, violations };
}

test("invariant: a task has one claimer and an agent's active task is one it holds", async () => {
  await forEachSeed([5, 6], (rng) => {
    const { state, violations } = taskTrail(rng, 400, { unclaims: false });
    assert.deepEqual(violations.slice(0, 5), [], `${violations.length} violations`);
    assert.ok([...state.tasks.values()].some((t) => t.status === "COMPLETED"), "sanity: tasks were completed");
  });
});

test(
  "invariant: releasing a claimed task also releases its holder's active-task pointer",
  async () => {
    await forEachSeed([5, 6], (rng) => {
      const { violations } = taskTrail(rng, 400, { unclaims: true });
      assert.deepEqual(violations.slice(0, 5), [], `${violations.length} violations`);
    });
  },
);

test("invariant: a rejected message never activates its recipient", async () => {
  const m = await makeMesh({
    agents: [
      { id: "spammer", role: "x", interests: [] },
      { id: "target", role: "y", interests: [] },
    ],
    mayContact: { spammer: [], target: [] },
  });
  const s = stub(m);
  s.setScript("target", async () => {
    throw new Error("target must never run when the message is denied");
  });
  for (let i = 0; i < 30; i++) {
    const r = await m.supervisor.sendMessage({ from: "spammer", to: ["target"], type: "REQUEST", payload: { i }, newThread: { subject: "spam" } });
    assert.equal(r.accepted, false);
  }
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(m.kernel.state.agents.get("target")?.state.activations, 0);
  assert.equal(m.kernel.state.agents.get("target")?.state.lifecycle, "STARTING", "target was never awakened");
  assert.equal(m.kernel.state.unread.get("target")?.length ?? 0, 0, "rejected messages never queue");
  await m.cleanup();
});

test("invariant: replay of a random trail is deterministic", async () => {
  await forEachSeed([11, 12, 13], (_rng, seed) => {
    const a = createRandomTrail(seed);
    const b = createRandomTrail(seed);
    assert.equal(a.signature, b.signature);
    assert.ok(a.illegalAttempts > 0, "trail should exercise illegal edges too");
  });
});

test("invariant: a QA block cannot be silently ignored on the merge path", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "lead", role: "tech-lead", capabilities: ["code.review", "git.merge", "test.execute"], authority: ["implementation.approve"], interests: [] },
      { id: "qa", role: "qa", capabilities: ["test.write"], authority: ["quality.block"], interests: [] },
    ],
    mayContact: { dev: ["lead", "qa"], lead: ["dev", "qa"], qa: ["dev", "lead"] },
    transitions: { "patch.merge": ["lead.approve"] },
  });
  const c = await m.supervisor.createArtifact({ actorId: "dev", name: "blocked-patch", type: "CodePatch", content: "d" });
  if (!("artifact" in c)) throw new Error("create failed");
  const id = c.artifact.id;
  await m.supervisor.transitionArtifact("dev", id, { to: "READY_FOR_REVIEW" });
  await m.supervisor.transitionArtifact("dev", id, { to: "UNDER_REVIEW" });
  const approved = await m.supervisor.recordDecision("lead", "approve", "implementation", id, "ok");
  assert.equal(approved.ok, true);
  await m.supervisor.transitionArtifact("lead", id, { to: "APPROVED" });
  await m.supervisor.transitionArtifact("lead", id, { to: "VERIFIED" });
  await m.supervisor.transitionArtifact("lead", id, { to: "MERGEABLE" });
  await m.supervisor.recordDecision("qa", "block", "quality", id, "must not merge");
  // Through the `merge` op: a bare transition to MERGED is refused outright
  // now (nothing may record MERGED without a merge), so it would pass the
  // first assertion for the wrong reason and fail the second. The fake
  // workspace stands in for git (`makeMesh` is in-memory).
  installWorkspace(m, new FakeWorkspace());
  const turn = { turnId: "t-merge", agentId: "lead", reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] };
  const mergeOp = () => m.supervisor.executeOp("lead", { op: "merge", artifactId: id }, turn as never);
  const blocked = await mergeOp();
  assert.equal(blocked.ok, false, "an open block must stop the merge even with all other approvals");
  const versioned = await m.supervisor.createArtifact({ actorId: "dev", name: "blocked-patch", type: "CodePatch", content: "fix", asVersionOf: id });
  assert.ok("artifact" in versioned, "owner can publish a revision");
  assert.equal(m.kernel.state.artifacts.get(id)?.status, "DRAFT", "a re-version restarts the pipeline");
  await m.supervisor.transitionArtifact("dev", id, { to: "READY_FOR_REVIEW" });
  await m.supervisor.transitionArtifact("dev", id, { to: "UNDER_REVIEW" });
  await m.supervisor.recordDecision("lead", "approve", "implementation", id, "ok round 2");
  await m.supervisor.transitionArtifact("lead", id, { to: "APPROVED" });
  await m.supervisor.transitionArtifact("lead", id, { to: "VERIFIED" });
  await m.supervisor.transitionArtifact("lead", id, { to: "MERGEABLE" });
  const after = await mergeOp();
  assert.equal(after.ok, true, `the new version clears the block and the merge proceeds (${after.reason ?? ""})`);
  await m.cleanup();
});

test("invariant: completed goals require evidence for every mandatory criterion", async () => {
  const m = await makeMesh({
    agents: [{ id: "pm", role: "pm", authority: ["requirements.accept"], interests: [] }],
    criteria: [
      { id: "m1", description: "one", mandatory: true },
      { id: "m2", description: "two", mandatory: true },
    ],
  });
  const c = await m.supervisor.createArtifact({ actorId: "pm", name: "ev", type: "TestReport", content: evidenceContent("evidence report") });
  if (!("artifact" in c)) throw new Error("create failed");
  await m.supervisor.transitionArtifact("pm", c.artifact.id, { to: "READY_FOR_REVIEW" });
  await m.supervisor.recordDecision("pm", "accept", "criterion:m1", c.artifact.id, "e1");
  await new Promise((r) => setTimeout(r, 300));
  const goal = m.kernel.state.goals.get(m.kernel.state.activeGoalId!);
  assert.notEqual(goal?.status, "COMPLETED");
  const bare = await m.supervisor.recordDecision("pm", "accept", "criterion:m2", undefined, undefined);
  assert.equal(bare.ok, false, "assertion without evidence is rejected");
  await m.supervisor.recordDecision("pm", "accept", "criterion:m2", c.artifact.id, "e2");
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(m.kernel.state.goals.get(m.kernel.state.activeGoalId!)?.status, "COMPLETED");
  await m.cleanup();
});

test("invariant: goal completion only via evidenced criteria even with WAIVED", async () => {
  const m = await makeMesh({
    agents: [{ id: "pm", role: "pm", authority: ["requirements.accept"], interests: [] }],
    criteria: [{ id: "only", description: "x", mandatory: true }],
  });
  const goal = m.kernel.state.goals.get(m.kernel.state.activeGoalId!)!;
  const c = goal.acceptanceCriteria.find((x) => x.id === "only")!;
  // FINDING: there is no legal way to reach this state. `WAIVED` is read by
  // termination, progress, the run report, context and the server, but no
  // event writes it — no reducer case sets a criterion to WAIVED and no
  // `requirement.waived` exists. The projection is mutated by hand, so this
  // proves only that termination reads WAIVED; a replay of the log would not
  // reproduce the state, and a real mesh cannot produce it.
  c.status = "WAIVED";
  await m.kernel.emit("goal.progress", { completed: 1, total: 1, ratio: 1 }, {});
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(m.kernel.state.goals.get(goal.id)?.status, "COMPLETED");
  void artifactMachineOf;
  await m.cleanup();
});
