import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { createHttpServer } from "../../apps/mesh-server/src/index";
import type { StagedMutation } from "../../packages/protocol/src/index";

/**
 * `POST /designer/staged/apply` — the operator's commit button.
 *
 * The dashboard assistant authors mutations and executes none of them; this
 * route is the only thing that runs them, and only a human press reaches it.
 * So the assertions worth making here are about what the route REFUSES, and
 * about whether a refusal is legible: a proposal is a sequence, events do not
 * roll back, and an operator who is told "ok" about a no-op has been lied to.
 */

const DEV = { id: "dev", role: "developer", capabilities: [], interests: [] };
const OPS = { id: "ops", role: "operator", capabilities: [], interests: [] };
const TWO = [
  { id: "c1", description: "the API is documented", mandatory: true },
  { id: "c2", description: "the tests pass", mandatory: true },
];

async function harness(opts: any) {
  const m = await makeMesh(opts);
  const server = createHttpServer(m, { dashboardDir: undefined });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const apply = async (body: unknown) => {
    const res = await fetch(`${base}/designer/staged/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as any };
  };
  const propose = (...mutations: StagedMutation[]) => apply({ id: "sp-1", createdAt: new Date().toISOString(), mutations, problems: [] });
  const close = async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await m.cleanup();
  };
  return { m, apply, propose, close };
}

const goalOf = (m: any) => m.kernel.state.goals.get(m.kernel.state.activeGoalId ?? "");

async function satisfy(m: any, criterionId: string) {
  await m.kernel.emit(
    "requirement.satisfied",
    {
      criterionId,
      verified: true,
      evidence: { kind: "criteria-acceptance", verified: true, by: "dev", recordedAt: new Date().toISOString() },
    },
    { actorId: "dev", goalId: m.kernel.state.activeGoalId },
  );
}

test("staged apply: a proposal runs in order and reports what landed", async () => {
  const h = await harness({ agents: [DEV], mode: "parked", goal: "Build a payment API.", criteria: TWO });
  try {
    const r = await h.propose(
      { kind: "goal.description", description: "Build a payment API with refunds.", reason: "scope grew" },
      { kind: "criteria.edit", criterionId: "c2", description: "the tests pass on CI" },
      { kind: "criteria.add", criteria: [{ id: "c3", description: "refunds are reconciled nightly", mandatory: true }] as any },
    );
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.applied, 3);
    assert.equal(r.json.results.length, 3);

    const goal = goalOf(h.m);
    assert.equal(goal.description, "Build a payment API with refunds.");
    assert.equal(goal.acceptanceCriteria.find((c: any) => c.id === "c2").description, "the tests pass on CI");
    assert.equal(goal.acceptanceCriteria.length, 3);
    // Widening the mandatory set moves the denominator, which is the whole
    // reason adding is the safe direction and removing is not.
    assert.equal(h.m.kernel.state.progress.get(goal.id)!.total, 3);
  } finally {
    await h.close();
  }
});

/**
 * A proposal is a sequence someone reasoned about. Running the tail of one
 * whose head failed applies a plan nobody proposed — so it stops, and says
 * exactly how far it got, because the prefix that landed is not coming back.
 */
test("staged apply: halts on the first failure and reports the prefix that landed", async () => {
  const h = await harness({ agents: [DEV, OPS], mode: "parked", goal: "Build a payment API.", criteria: TWO });
  try {
    const r = await h.propose(
      { kind: "goal.description", description: "Build a payment API, carefully." },
      { kind: "criteria.edit", criterionId: "ghost", description: "this criterion does not exist" },
      { kind: "seat.suspend", agentId: "ops" },
    );
    assert.equal(r.status, 409, "well-formed proposal, refused by the mesh — not a 400 and not a 500");
    assert.equal(r.json.ok, false);
    assert.equal(r.json.applied, 1);
    assert.equal(r.json.results.length, 2, "the third mutation was never attempted");
    assert.match(r.json.results[1].detail, /unknown criterion/);

    assert.equal(goalOf(h.m).description, "Build a payment API, carefully.", "the prefix really did land");
    assert.notEqual(h.m.kernel.state.agents.get("ops")!.state.lifecycle, "SUSPENDED");
  } finally {
    await h.close();
  }
});

test("staged apply: config.replace belongs to the draft, not the running mesh", async () => {
  const h = await harness({ agents: [DEV], mode: "parked", goal: "Build a payment API.", criteria: TWO });
  try {
    const r = await h.propose({ kind: "config.replace", yaml: "meshId: whatever\n", reason: "rewrite" });
    assert.equal(r.status, 409);
    assert.match(r.json.results[0].detail, /local draft/);
  } finally {
    await h.close();
  }
});

/**
 * The guard from the core layer, checked at the edge that actually faces the
 * operator: it is no use having it inside `removeCriterion` if the route can
 * reach completion by another path.
 */
test("staged apply: a removal that would complete the goal is refused over HTTP", async () => {
  const h = await harness({ agents: [DEV], mode: "parked", goal: "Build a payment API.", criteria: TWO });
  try {
    await satisfy(h.m, "c1");
    const r = await h.propose({ kind: "criteria.delete", criterionId: "c2", reason: "we decided not to test" });
    assert.equal(r.status, 409);
    assert.match(r.json.results[0].detail, /without the work being done/);
    assert.equal(goalOf(h.m).acceptanceCriteria.length, 2);
    assert.notEqual(goalOf(h.m).status, "COMPLETED");
  } finally {
    await h.close();
  }
});

/**
 * `reason` is required by the type on destructive kinds, but a proposal
 * arrives as JSON over HTTP, where the compiler has guaranteed nothing.
 */
test("staged apply: destructive kinds are refused without a stated reason", async () => {
  const h = await harness({ agents: [DEV, OPS], mode: "parked", goal: "Build a payment API.", criteria: TWO });
  try {
    for (const m of [
      { kind: "seat.retire", agentId: "ops" },
      { kind: "criteria.delete", criterionId: "c2" },
      { kind: "mission.reset" },
    ] as StagedMutation[]) {
      const r = await h.propose(m);
      assert.equal(r.status, 409, `${m.kind} must not run without a reason`);
      assert.match(r.json.results[0].detail, /requires a stated reason/);
    }
    assert.notEqual(h.m.kernel.state.agents.get("ops")!.state.lifecycle, "RETIRED");
    assert.equal(goalOf(h.m).acceptanceCriteria.length, 2);
  } finally {
    await h.close();
  }
});

/**
 * The reason the protocol requires on a destructive kind is authored by the
 * AGENT, so on the one mutation whose blast radius is the whole mission it
 * cannot also be the guard: an agent that can stage a reset can write a reason
 * for it. The typed mesh id is the half it cannot supply.
 *
 * Checked at APPLY and not at staging, deliberately. A guard at admission
 * binds the agent — which can satisfy any field it is handed — while this one
 * binds whoever presses Apply, and pressing Apply is the only thing that makes
 * the reset happen.
 */
test("staged apply: mission.reset needs a confirmation the agent cannot write", async () => {
  const h = await harness({ agents: [DEV], mode: "parked", goal: "Build a payment API.", criteria: TWO });
  const meshId = h.m.config.meshId;
  const reset = { kind: "mission.reset", reason: "start the run over" } as StagedMutation;
  const withConfirm = (confirmId: string) => h.apply({ id: "sp-reset", createdAt: new Date().toISOString(), mutations: [reset], problems: [], confirmId });
  try {
    // The reason alone — everything the agent is able to supply — is refused,
    // and the refusal names the string that would work.
    const bare = await h.propose(reset);
    assert.equal(bare.status, 409);
    assert.match(bare.json.results[0].detail, new RegExp(meshId));
    assert.ok(goalOf(h.m), "a refused reset must leave the mission standing");

    // The shared confirm word is the OTHER destructive kinds' guard. It must not
    // release this one.
    const shared = await withConfirm("apply");
    assert.equal(shared.status, 409);
    assert.ok(goalOf(h.m));

    // Accepted trimmed and case-folded, the way the console's card accepts it —
    // a string the card arms on cannot come back refused by the route behind it.
    const ok = await withConfirm(`  ${meshId.toUpperCase()}  `);
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.applied, 1);
    assert.match(ok.json.results[0].detail, /reset to zero/, "the reset itself must actually have run");
  } finally {
    await h.close();
  }
});

/**
 * Staging happens a turn or more before applying and the mesh moves in
 * between. `suspendAgent`/`resumeAgent` return void and refuse internally on a
 * retired seat, so a route that called them blind would answer 200 while
 * nothing happened — the "partial silence" the staging layer re-validates
 * against.
 */
test("staged apply: a mutation gone stale fails loudly rather than silently", async () => {
  const h = await harness({ agents: [DEV, OPS], mode: "parked", goal: "Build a payment API.", criteria: TWO });
  try {
    assert.equal((await h.propose({ kind: "seat.retire", agentId: "ops", reason: "duplicate seat" })).status, 200);
    assert.equal(h.m.kernel.state.agents.get("ops")!.state.lifecycle, "RETIRED");

    const stale = await h.propose({ kind: "seat.resume", agentId: "ops" });
    assert.equal(stale.status, 409);
    assert.match(stale.json.results[0].detail, /terminal/);

    const gone = await h.propose({ kind: "seat.wake", agentId: "vanished" });
    assert.equal(gone.status, 409);
    assert.match(gone.json.results[0].detail, /unknown agent/);

    const dup = await h.propose({ kind: "seat.spawn", agent: { id: "dev", role: "developer" } as any });
    assert.equal(dup.status, 409);
    assert.match(dup.json.results[0].detail, /already exists/, "registerAgent has no duplicate check of its own");
  } finally {
    await h.close();
  }
});

test("staged apply: a body that is not a proposal is a 400", async () => {
  const h = await harness({ agents: [DEV], mode: "parked", goal: "Build a payment API.", criteria: TWO });
  try {
    assert.equal((await h.apply({})).status, 400);
    assert.equal((await h.apply({ mutations: [] })).status, 400);
    assert.equal((await h.apply({ mutations: "nope" })).status, 400);
    // A bare array is accepted: the operator's own curl is a reasonable client.
    const bare = await h.apply([{ kind: "run.pause" }]);
    assert.equal(bare.status, 200);
  } finally {
    await h.close();
  }
});
