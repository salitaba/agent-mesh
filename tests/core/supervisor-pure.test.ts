import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import type { Artifact, Escalation, MessageType, Task } from "../../packages/protocol/src/index";

/**
 * The supervisor's small classifiers decide, without any agent in the loop,
 * whether the mesh spends a turn and whether a mandatory criterion counts as
 * evidenced. They are private methods on a 4700-line class, so they are
 * reached the way the rest of the suite reaches supervisor internals — via a
 * structural cast on a real booted mesh — rather than by adding exports that
 * would widen the public surface just for tests.
 *
 * Each one guards a failure the mission actually hit:
 *  - `evidenceIsSubstantive` is what stops "TODO" from closing a mission.
 *  - `wakeValue` is the gate that decides whether the stall watchdog rests;
 *    a false `worth: true` burns a full-context turn on nothing.
 *  - `changeEventsFromDiff` is how a commit notifies the security/dependency
 *    interests — a missed classification means nobody is told.
 *  - `sendMessageCapability` refuses a request the sender has no standing to
 *    make, before the message enters the bus.
 */

type SupervisorInternals = {
  evidenceIsSubstantive(artifact: Artifact): Promise<{ ok: boolean; reason?: string }>;
  changeEventsFromDiff(diff: string): string[];
  sendMessageCapability(actorId: string, type: MessageType): string | null;
  wakeValue(): { worth: boolean; why: string };
};

async function makeSupervisor(opts: { capabilities?: string[] } = {}) {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: opts.capabilities ?? ["repository.write"], interests: [] },
    ],
    mayContact: { dev: [] },
    mode: "parked",
    criteria: [
      { id: "ship", description: "the mission artifact exists", mandatory: true },
      { id: "polish", description: "nice to have", mandatory: false },
    ],
  });
  return {
    m,
    sup: m.supervisor as unknown as SupervisorInternals,
    goal: m.kernel.state.goals.get(m.kernel.state.activeGoalId!)!,
  };
}

function artifact(over: Partial<Artifact> = {}): Artifact {
  return {
    id: over.id ?? "art-1",
    name: over.name ?? "design",
    type: over.type ?? "ArchitectureDocument",
    goalId: over.goalId ?? "goal-1",
    owner: over.owner ?? "dev",
    version: over.version ?? 1,
    status: over.status ?? "DRAFT",
    contentRef: over.contentRef ?? "mem://art-1/v1",
    digest: over.digest ?? "sha256:deadbeef",
    metadata: over.metadata ?? {},
    provenance: over.provenance ?? { source: "agent", trustLevel: 1 },
    createdAt: over.createdAt ?? "2026-03-01T00:00:00.000Z",
    createdBy: over.createdBy ?? "dev",
    ...over,
  } as Artifact;
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: over.id ?? "task-1",
    goalId: over.goalId ?? "goal-1",
    title: over.title ?? "do the thing",
    description: over.description ?? "",
    createdBy: over.createdBy ?? "dev",
    status: over.status ?? "OPEN",
    requiredCapabilities: over.requiredCapabilities ?? [],
    artifactRefs: over.artifactRefs ?? [],
    delegationDepth: over.delegationDepth ?? 0,
    budget: over.budget ?? {},
    createdAt: over.createdAt ?? "2026-03-01T00:00:00.000Z",
    ...over,
  } as Task;
}

function escalation(over: Partial<Escalation> = {}): Escalation {
  return {
    id: over.id ?? "esc-1",
    goalId: over.goalId ?? "goal-1",
    reason: over.reason ?? "needs a human",
    detail: over.detail ?? {},
    raisedBy: over.raisedBy ?? "dev",
    status: over.status ?? "OPEN",
    createdAt: over.createdAt ?? "2026-03-01T00:00:00.000Z",
    ...over,
  } as Escalation;
}

/** A body comfortably over MIN_EVIDENCE_CONTENT_CHARS (400). */
function longBody(lead = "Design"): string {
  return `${lead}: ${"the interfaces, constraints and failure modes are recorded here. ".repeat(12)}`;
}

// --- evidenceIsSubstantive: unreadable, too thin, stub-marked ---

test("evidence whose content cannot be read is not evidence", async () => {
  const { m, sup } = await makeSupervisor();
  try {
    const res = await sup.evidenceIsSubstantive(artifact({ contentRef: "mem://never-written/v1" }));
    assert.equal(res.ok, false);
    assert.match(String(res.reason), /unreadable/, "the refusal must name the read failure, not a length");
  } finally {
    await m.cleanup();
  }
});

test("a body under the minimum length is refused with its actual size", async () => {
  const { m, sup } = await makeSupervisor();
  try {
    const ref = await m.supervisor.deps.content.writeVersion("art-thin", 1, "  short  ");
    const res = await sup.evidenceIsSubstantive(artifact({ id: "art-thin", name: "thin-doc", contentRef: ref }));
    assert.equal(res.ok, false);
    assert.match(String(res.reason), /thin-doc/, "the author needs to know WHICH artifact was rejected");
    assert.match(String(res.reason), /only 5 chars/, "the trimmed length is what is measured, not the raw length");
  } finally {
    await m.cleanup();
  }
});

test("a long body that opens with a placeholder marker is refused as a stub", async () => {
  const { m, sup } = await makeSupervisor();
  try {
    const ref = await m.supervisor.deps.content.writeVersion("art-tbd", 1, `TBD ${longBody()}`);
    const res = await sup.evidenceIsSubstantive(artifact({ id: "art-tbd", name: "stub-doc", contentRef: ref }));
    assert.equal(res.ok, false);
    assert.match(String(res.reason), /placeholder/, "length alone must not buy a pass");
  } finally {
    await m.cleanup();
  }
});

test("a stub marker later in the body does not disqualify a real deliverable", async () => {
  const { m, sup } = await makeSupervisor();
  try {
    const ref = await m.supervisor.deps.content.writeVersion("art-ok", 1, `${longBody()}\nFollow-ups: TODO tighten the retry budget.`);
    const res = await sup.evidenceIsSubstantive(artifact({ id: "art-ok", contentRef: ref }));
    assert.equal(res.ok, true, "the marker regex is anchored at the start for exactly this reason");
    assert.equal(res.reason, undefined);
  } finally {
    await m.cleanup();
  }
});

// --- changeEventsFromDiff: which interests a commit must notify ---

test("a diff touching no sensitive surface notifies nobody", async () => {
  const { m, sup } = await makeSupervisor();
  try {
    assert.deepEqual(sup.changeEventsFromDiff("--- a/README.md\n+++ b/README.md\n+typo fix"), []);
  } finally {
    await m.cleanup();
  }
});

test("a manifest change is classified as a dependency change", async () => {
  const { m, sup } = await makeSupervisor();
  try {
    assert.deepEqual(sup.changeEventsFromDiff("--- a/package.json\n+  \"left-pad\": \"^1.0.0\""), ["dependency.changed"]);
    assert.deepEqual(sup.changeEventsFromDiff("+++ b/Cargo.toml"), ["dependency.changed"]);
    assert.deepEqual(sup.changeEventsFromDiff("+++ b/go.mod"), ["dependency.changed"]);
  } finally {
    await m.cleanup();
  }
});

test("login and permission edits are classified separately, and a diff can be both", async () => {
  const { m, sup } = await makeSupervisor();
  try {
    assert.deepEqual(sup.changeEventsFromDiff("+ verify the JWT before issuing a session"), ["authentication.changed"]);
    assert.deepEqual(sup.changeEventsFromDiff("+ require the admin RBAC role"), ["authorization.changed"]);
    assert.deepEqual(
      sup.changeEventsFromDiff("+ oauth callback now checks the acl"),
      ["authentication.changed", "authorization.changed"],
      "one commit can move both surfaces; neither notification may be dropped",
    );
  } finally {
    await m.cleanup();
  }
});

test("classification is case-insensitive and can fire all three at once", async () => {
  const { m, sup } = await makeSupervisor();
  try {
    assert.deepEqual(
      sup.changeEventsFromDiff("--- a/POM.XML\n+ AUTHENTICATE via OAuth\n+ new PERMISSION check"),
      ["dependency.changed", "authentication.changed", "authorization.changed"],
    );
  } finally {
    await m.cleanup();
  }
});

// --- sendMessageCapability: standing to make a request ---

test("an unregistered sender is refused before the message reaches the bus", async () => {
  const { m, sup } = await makeSupervisor();
  try {
    assert.equal(sup.sendMessageCapability("ghost", "REQUEST_REVIEW"), "unknown sender");
  } finally {
    await m.cleanup();
  }
});

test("message types with no capability requirement pass regardless of the sender's grants", async () => {
  const { m, sup } = await makeSupervisor({ capabilities: [] });
  try {
    assert.equal(sup.sendMessageCapability("dev", "INFORM"), null);
    assert.equal(sup.sendMessageCapability("dev", "DONE"), null);
  } finally {
    await m.cleanup();
  }
});

test("asking for a review or for research requires standing to ask", async () => {
  const { m, sup } = await makeSupervisor({ capabilities: ["repository.write"] });
  try {
    assert.equal(sup.sendMessageCapability("dev", "REQUEST_REVIEW"), "missing capability request_review");
    assert.equal(sup.sendMessageCapability("dev", "REQUEST_RESEARCH"), "missing capability request_review");
  } finally {
    await m.cleanup();
  }
});

test("either the named capability or repository.read confers standing to ask", async () => {
  const named = await makeSupervisor({ capabilities: ["request_review"] });
  try {
    assert.equal(named.sup.sendMessageCapability("dev", "REQUEST_REVIEW"), null);
  } finally {
    await named.m.cleanup();
  }
  const reader = await makeSupervisor({ capabilities: ["repository.read"] });
  try {
    assert.equal(
      reader.sup.sendMessageCapability("dev", "REQUEST_RESEARCH"),
      null,
      "a reader can ask for research without being granted request_review explicitly",
    );
  } finally {
    await reader.m.cleanup();
  }
});

// --- wakeValue: is another turn worth its context price ---

test("with no active goal there is nothing to wake for", async () => {
  const { m, sup } = await makeSupervisor();
  try {
    m.kernel.state.activeGoalId = null;
    const v = sup.wakeValue();
    assert.equal(v.worth, false);
    assert.equal(v.why, "no active goal");
  } finally {
    await m.cleanup();
  }
});

test("an unmet mandatory criterion is reason enough, and the count is reported", async () => {
  const { m, sup, goal } = await makeSupervisor();
  try {
    const v = sup.wakeValue();
    assert.equal(v.worth, true);
    assert.equal(v.why, "1 mandatory criteria unmet", "the optional criterion must not inflate the count");
    goal.acceptanceCriteria[0].status = "EVIDENCED";
    assert.equal(sup.wakeValue().worth, false, "evidencing the only mandatory criterion clears the reason to wake");
  } finally {
    await m.cleanup();
  }
});

test("a waived criterion counts as settled, not as outstanding work", async () => {
  const { m, sup, goal } = await makeSupervisor();
  try {
    goal.acceptanceCriteria[0].status = "WAIVED";
    assert.equal(sup.wakeValue().worth, false);
  } finally {
    await m.cleanup();
  }
});

test("undelivered mail outranks a finished criteria list", async () => {
  const { m, sup, goal } = await makeSupervisor();
  try {
    goal.acceptanceCriteria[0].status = "EVIDENCED";
    m.kernel.state.unread.set("dev", ["msg-1"]);
    const v = sup.wakeValue();
    assert.equal(v.worth, true);
    assert.equal(v.why, "undelivered mail");
  } finally {
    await m.cleanup();
  }
});

test("an empty unread list is not mail", async () => {
  const { m, sup, goal } = await makeSupervisor();
  try {
    goal.acceptanceCriteria[0].status = "EVIDENCED";
    m.kernel.state.unread.set("dev", []);
    assert.equal(sup.wakeValue().worth, false, "an empty queue is bookkeeping residue, not a loose end");
  } finally {
    await m.cleanup();
  }
});

test("an open escalation keeps the mission awake; a responded one does not", async () => {
  const { m, sup, goal } = await makeSupervisor();
  try {
    goal.acceptanceCriteria[0].status = "EVIDENCED";
    m.kernel.state.escalations.set("esc-1", escalation({ status: "RESPONDED" }));
    assert.equal(sup.wakeValue().worth, false, "a decided escalation is closed business");
    m.kernel.state.escalations.set("esc-2", escalation({ id: "esc-2", status: "OPEN" }));
    const v = sup.wakeValue();
    assert.equal(v.worth, true);
    assert.equal(v.why, "1 open escalations");
  } finally {
    await m.cleanup();
  }
});

test("a claimed task means somebody is still working, so the mission stays awake", async () => {
  const { m, sup, goal } = await makeSupervisor();
  try {
    goal.acceptanceCriteria[0].status = "EVIDENCED";
    m.kernel.state.tasks.set("task-1", task({ status: "CLAIMED", claimedBy: "dev" }));
    const v = sup.wakeValue();
    assert.equal(v.worth, true);
    assert.equal(v.why, "1 claimed tasks in flight");
  } finally {
    await m.cleanup();
  }
});

test("an unowned OPEN task with everything evidenced is residue, not work", async () => {
  const { m, sup, goal } = await makeSupervisor();
  try {
    goal.acceptanceCriteria[0].status = "EVIDENCED";
    m.kernel.state.tasks.set("task-1", task({ status: "OPEN" }));
    assert.equal(sup.wakeValue().worth, false, "treating unclaimed bookkeeping as work is what wedged the mission open");
  } finally {
    await m.cleanup();
  }
});

test("a claimed watchdog task does not count as work in flight", async () => {
  const { m, sup, goal } = await makeSupervisor();
  try {
    goal.acceptanceCriteria[0].status = "EVIDENCED";
    m.kernel.state.tasks.set("watch:stall", task({ id: "watch:stall", status: "CLAIMED", claimedBy: "dev" }));
    const v = sup.wakeValue();
    assert.equal(v.worth, false, "the watchdog's own bookkeeping must never justify waking the watchdog");
    assert.match(v.why, /no claimed tasks/);
  } finally {
    await m.cleanup();
  }
});
