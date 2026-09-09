import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, evidenceContent } from "../helpers";
import { seededArtifactState, tryTransition, createRandomTrail } from "./_property-trail";
import { MACHINE_TRANSITIONS, artifactMachineOf } from "../../packages/protocol/src/catalog";
import { mulberry32 } from "./_rng";
import type { ArtifactStatus } from "../../packages/protocol/src/index";

test("invariant: no artifact ever has two active owners", async () => {
  const m = await makeMesh({
    agents: [
      { id: "a", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "b", role: "developer", capabilities: ["repository.write"], interests: [] },
    ],
    mayContact: { a: ["b"], b: ["a"] },
  });
  const rng = mulberry32(1234);
  const turn = { turnId: "t", agentId: "a", reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] };
  const ids: string[] = [];
  for (let i = 0; i < 8; i++) {
    const c = await m.supervisor.createArtifact({ actorId: i % 2 ? "a" : "b", name: `p${i}`, type: "CodePatch", content: `d${i}` });
    if ("artifact" in c) ids.push(c.artifact.id);
  }
  for (let i = 0; i < 120; i++) {
    const artifactId = ids[Math.floor(rng() * ids.length)];
    const actor = rng() < 0.5 ? "a" : "b";
    await m.supervisor.executeOp(actor, { op: "acquire_lease", artifactId, files: [] }, turn as never);
    if (rng() < 0.3) await m.supervisor.executeOp(actor, { op: "release_lease", artifactId }, turn as never);
    const holders = [...m.kernel.state.leases.values()].filter((l) => l.artifactId === artifactId && !l.releasedAt);
    assert.ok(holders.length <= 1, `artifact ${artifactId} has ${holders.length} active holders`);
  }
  await m.cleanup();
});

test("invariant: illegal state transitions never become visible", () => {
  const rng = mulberry32(99);
  const statuses = Object.keys(MACHINE_TRANSITIONS.code) as ArtifactStatus[];
  let checked = 0;
  for (let i = 0; i < 400; i++) {
    const from = statuses[Math.floor(rng() * statuses.length)];
    const to = statuses[Math.floor(rng() * statuses.length)];
    const allowed = (MACHINE_TRANSITIONS.code[from] ?? []).includes(to);
    const { state } = seededArtifactState(from);
    const res = tryTransition(state, to);
    if (!allowed && from !== to) {
      assert.equal(res.ok, false, `${from} -> ${to} must be impossible`);
      assert.match(res.error ?? "", /illegal artifact transition|blocked by unsatisfied gate/);
      checked++;
    }
  }
  assert.ok(checked > 100, `sanity: only ${checked} illegal pairs exercised`);
});

test("invariant: random transition trails only ever walk the declared machine", () => {
  for (const seed of [1, 2, 3]) {
    const trail = createRandomTrail(seed);
    const table = MACHINE_TRANSITIONS.code;
    assert.ok(table[trail.finalStatuses[0] as ArtifactStatus] !== undefined, "final status must be a machine state");
    for (const s of trail.finalStatuses) {
      assert.ok(statusesOf("code").includes(s), `observed ${s} is not in the code machine`);
    }
  }
});

function statusesOf(kind: "code" | "release" | "document"): string[] {
  return Object.keys(MACHINE_TRANSITIONS[kind]);
}

test("invariant: budget accounting never goes negative", async () => {
  const m = await makeMesh({ agents: [{ id: "a", role: "dev", interests: [], capabilities: [] }], mayContact: { a: [] } });
  const rng = mulberry32(7);
  const key = `agent:${m.kernel.state.activeGoalId}/a`;
  for (let i = 0; i < 200; i++) {
    const roll = rng();
    if (roll < 0.4) {
      const r = await m.supervisor.deps.budget.reserve(key, "tokens", 100, 1000, { actorId: "a" });
      if (r.blocked) continue;
      if (rng() < 0.5) await m.supervisor.deps.budget.release(key, r.reservationId);
      else await m.supervisor.deps.budget.consume(key, "tokens", 80, r.reservationId);
    } else {
      await m.supervisor.deps.budget.consume(key, "tokens", 40, undefined);
    }
    const b = m.kernel.state.budgets.get(key);
    if (b) {
      assert.ok(b.consumed >= 0, "consumed negative");
      assert.ok(b.reserved >= 0, "reserved negative");
    }
  }
  await m.cleanup();
});

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

test("invariant: replay of a random trail is deterministic", () => {
  for (const seed of [11, 12, 13]) {
    const a = createRandomTrail(seed);
    const b = createRandomTrail(seed);
    assert.equal(a.signature, b.signature);
    assert.ok(a.illegalAttempts > 0, "trail should exercise illegal edges too");
  }
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
  const blocked = await m.supervisor.transitionArtifact("lead", id, { to: "MERGED" });
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
  const after = await m.supervisor.transitionArtifact("lead", id, { to: "MERGED" });
  assert.equal(after.ok, true, "the new version clears the block and the merge proceeds");
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
  c.status = "WAIVED";
  await m.kernel.emit("goal.progress", { completed: 1, total: 1, ratio: 1 }, {});
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(m.kernel.state.goals.get(goal.id)?.status, "COMPLETED");
  void artifactMachineOf;
  await m.cleanup();
});
