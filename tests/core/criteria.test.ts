import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CRITERIA_SYSTEM_PROMPT,
  MAX_GENERATED_CRITERIA,
  generateAcceptanceCriteria,
  parseGeneratedCriteria,
} from "../../packages/core/src/criteria";
import { DEFAULT_CRITERIA } from "../../packages/core/src/supervisor";
import { makeMesh, goalOf, stub, waitFor } from "../helpers";

/**
 * Two layers are pinned here. The parser decides what a model's answer is
 * allowed to become, and it is the only thing standing between a prose reply
 * and a mission whose completion gate is computed from garbage. The boot path
 * decides whether that answer is used at all, and must never let generation
 * stop a mission from starting.
 */

const good = (n = 3) =>
  JSON.stringify(
    Array.from({ length: n }, (_, i) => ({
      id: `criterion-${i + 1}`,
      description: `Something checkable number ${i + 1}`,
      mandatory: true,
    })),
  );

test("a bare JSON array parses", () => {
  const out = parseGeneratedCriteria(good());
  assert.equal(out?.length, 3);
  assert.equal(out?.[0].description, "Something checkable number 1");
});

test("a fenced or prose-wrapped array still parses", () => {
  // Models fence JSON and introduce it. Picking one shape and failing on the
  // others would make generation fail for reasons that have nothing to do with
  // the model understanding the goal.
  const fenced = parseGeneratedCriteria("```json\n" + good() + "\n```");
  assert.equal(fenced?.length, 3);

  const wrapped = parseGeneratedCriteria("Here are the criteria:\n\n" + good() + "\n\nThese cover the goal.");
  assert.equal(wrapped?.length, 3);

  const objectWrapped = parseGeneratedCriteria(`{"criteria": ${good()}}`);
  assert.equal(objectWrapped?.length, 3);
});

test("prose with no array is rejected rather than guessed at", () => {
  assert.equal(parseGeneratedCriteria("I cannot help with that."), null);
  assert.equal(parseGeneratedCriteria(""), null);
  assert.equal(parseGeneratedCriteria("[not json"), null);
});

test("a list too short to describe a goal is rejected", () => {
  // One criterion is not a decomposition of a goal, it is a partial answer.
  // Returning it would silently narrow the mission's definition of done.
  assert.equal(parseGeneratedCriteria(good(1)), null);
  assert.equal(parseGeneratedCriteria("[]"), null);
});

test("the list is capped", () => {
  const out = parseGeneratedCriteria(good(MAX_GENERATED_CRITERIA + 5));
  assert.equal(out?.length, MAX_GENERATED_CRITERIA, "criteria render every turn, so the list is bounded");
});

test("malformed entries are dropped without taking the list down", () => {
  const mixed = JSON.stringify([
    { id: "a", description: "Keep me", mandatory: true },
    { id: "b" },
    { description: "" },
    null,
    { id: "c", description: "Keep me too", mandatory: false },
  ]);
  const out = parseGeneratedCriteria(mixed);
  assert.deepEqual(
    out?.map((c) => c.id),
    ["a", "c"],
  );
  assert.equal(out?.[1].mandatory, false, "an explicit false must survive");
});

test("absent `mandatory` means mandatory", () => {
  // Defaulting the other way would quietly drop requirements out of the
  // completion gate, which is the one error here that cannot be seen.
  const out = parseGeneratedCriteria(JSON.stringify([
    { id: "a", description: "one" },
    { id: "b", description: "two" },
  ]));
  assert.equal(out?.[0].mandatory, true);
});

test("ids are slugified and de-duplicated", () => {
  const out = parseGeneratedCriteria(
    JSON.stringify([
      { id: "Ship The Thing!", description: "first" },
      { id: "ship the thing", description: "second" },
      { description: "third has no id" },
    ]),
  );
  assert.deepEqual(
    out?.map((c) => c.id),
    ["ship-the-thing", "third-has-no-id"],
    "a duplicate id would collapse two criteria into one entry in the goal",
  );
});

test("generation passes the goal and the contract to the model", async () => {
  let seen: { text: string; system: string } | undefined;
  const out = await generateAcceptanceCriteria("Build a payment API.", async (text, opts) => {
    seen = { text, system: opts.system };
    return good();
  });

  assert.equal(seen?.text, "Build a payment API.");
  assert.equal(seen?.system, CRITERIA_SYSTEM_PROMPT);
  assert.equal(out?.length, 3);
});

test("an empty goal is not sent to the model", async () => {
  let called = false;
  const out = await generateAcceptanceCriteria("   ", async () => {
    called = true;
    return good();
  });
  assert.equal(called, false, "a misconfigured mesh should not spend a model call learning its goal is blank");
  assert.equal(out, null);
});

/** The boot path: generation is an improvement on the defaults, never a gate. */
const agent = { id: "dev", role: "developer", capabilities: [], interests: [] };

test("a mission that declares no criteria gets them from the generator", async () => {
  const m = await makeMesh({
    agents: [agent],
    mode: "parked",
    criteria: null,
    generateAcceptanceCriteria: true,
    goal: "Build a payment API.",
    criteriaGenerator: async () => parseGeneratedCriteria(good(4)),
  });

  const goal = goalOf(m);
  assert.equal(goal?.acceptanceCriteria.length, 4);
  assert.equal(goal?.acceptanceCriteria[0].id, "criterion-1");
  assert.equal(goal?.status, "PAUSED", "a model's list is a guess, so it is reviewed before it is acted on");
  await m.cleanup();
});

test("a failing generator falls back to the default criteria", async () => {
  // The whole point: a model that is unreachable must not stop a mission.
  const m = await makeMesh({
    agents: [agent],
    mode: "parked",
    criteria: null,
    generateAcceptanceCriteria: true,
    goal: "Build a payment API.",
    criteriaGenerator: async () => {
      throw new Error("model unreachable");
    },
  });

  assert.deepEqual(
    goalOf(m)?.acceptanceCriteria.map((c) => c.id),
    DEFAULT_CRITERIA.map((c) => c.id),
  );
  await m.cleanup();
});

test("a generator returning null falls back to the default criteria", async () => {
  const m = await makeMesh({
    agents: [agent],
    mode: "parked",
    criteria: null,
    generateAcceptanceCriteria: true,
    goal: "Build a payment API.",
    criteriaGenerator: async () => null,
  });

  assert.deepEqual(
    goalOf(m)?.acceptanceCriteria.map((c) => c.id),
    DEFAULT_CRITERIA.map((c) => c.id),
  );
  await m.cleanup();
});

test("generation is off unless the mesh asks for it", async () => {
  let called = false;
  const m = await makeMesh({
    agents: [agent],
    mode: "parked",
    criteria: null,
    // generateAcceptanceCriteria deliberately unset.
    criteriaGenerator: async () => {
      called = true;
      return parseGeneratedCriteria(good());
    },
  });

  assert.equal(called, false, "existing meshes must not start calling a model because this feature exists");
  assert.deepEqual(
    goalOf(m)?.acceptanceCriteria.map((c) => c.id),
    DEFAULT_CRITERIA.map((c) => c.id),
  );
  await m.cleanup();
});

test("declared criteria win over generation", async () => {
  let called = false;
  const m = await makeMesh({
    agents: [agent],
    mode: "parked",
    criteria: [{ id: "only-mine", description: "the operator's own criterion", mandatory: true }],
    generateAcceptanceCriteria: true,
    criteriaGenerator: async () => {
      called = true;
      return parseGeneratedCriteria(good());
    },
  });

  assert.equal(called, false, "an operator who wrote criteria has already answered this question");
  assert.deepEqual(
    goalOf(m)?.acceptanceCriteria.map((c) => c.id),
    ["only-mine"],
  );
  await m.cleanup();
});

/**
 * The review hold. A mission whose criteria a model wrote does not run until
 * the operator accepts them: the criteria are the completion gate, so running
 * against an unreviewed list is work aimed at a target nobody agreed to.
 */
const liveOpts = {
  agents: [{ id: "pm", role: "pm", capabilities: [], interests: [] }],
  startup: ["pm"],
  mode: "live" as const,
  criteria: null,
  goal: "Build a payment API.",
};

test("a held mission wakes nobody until the criteria are acknowledged", async () => {
  const m = await makeMesh({
    ...liveOpts,
    generateAcceptanceCriteria: true,
    criteriaGenerator: async () => parseGeneratedCriteria(good(4)),
  });

  // Settled rather than awaited: the assertion is that no session ever opened.
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(goalOf(m)?.status, "PAUSED");
  assert.equal(
    stub(m).lastStartContext("pm"),
    undefined,
    "waking an agent into a paused mission buys a refused turn and a brief that lies about starting work",
  );

  await m.supervisor.resumeGoal();
  await waitFor("pm to be started by the acknowledgement", () => stub(m).lastStartContext("pm") !== undefined);
  await m.cleanup();
});

test("the hold says why, so it does not read as a fault", async () => {
  const m = await makeMesh({
    ...liveOpts,
    generateAcceptanceCriteria: true,
    criteriaGenerator: async () => parseGeneratedCriteria(good(4)),
  });

  const paused = (await m.store.read()).filter((e) => e.type === "goal.paused");
  assert.equal(paused.length, 1);
  assert.match(JSON.stringify(paused[0]), /review them, then resume/);
  await m.cleanup();
});

test("operator-declared criteria run immediately", async () => {
  const m = await makeMesh({
    ...liveOpts,
    criteria: [{ id: "only-mine", description: "the operator's own criterion", mandatory: true }],
    generateAcceptanceCriteria: true,
    criteriaGenerator: async () => parseGeneratedCriteria(good(4)),
  });

  assert.equal(goalOf(m)?.status, "ACTIVE", "an operator who wrote the criteria has already reviewed them");
  await waitFor("pm to be started", () => stub(m).lastStartContext("pm") !== undefined);
  await m.cleanup();
});

test("built-in defaults run immediately", async () => {
  // The hold exists because a model's list is unverified. The default list is
  // fixed and reviewable in the source, so holding on it would be a new delay
  // on every existing mesh for no new information.
  const m = await makeMesh({ ...liveOpts });

  assert.equal(goalOf(m)?.status, "ACTIVE");
  await waitFor("pm to be started", () => stub(m).lastStartContext("pm") !== undefined);
  await m.cleanup();
});
