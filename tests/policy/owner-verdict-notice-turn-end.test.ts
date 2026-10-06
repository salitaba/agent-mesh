import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, type TestMesh } from "../helpers";
import { ManualClock, settle } from "../support/manual-clock";
import type { ActivationReason, MeshOp } from "../../packages/protocol/src/index";

/**
 * The owner of an artifact is told what a verdict did to it when the ruling seat's turn is over, and only if the artifact is still
 * where the verdict left it.
 *
 * The nineteenth cronlite run's tech lead approved the developer's patch and, in the same turn, took it to VERIFIED, MERGEABLE and
 * MERGED (it holds the power to rule and the power to move). The developer was woken at the verdict with "it is now APPROVED. It
 * needs VERIFIED next, and you can move it", and read that 11 seconds before the step was taken in one round and half a second
 * before it in the other. Each wake was a turn (9.4k and 15.1k tokens) that asked QA for a verification QA had already been told to begin,
 * and the first was followed by two turns of acknowledgements (11.1k and 9.2k): about 7% of the round, for a step already taken.
 *
 * The ruling seat is held mid-turn by a gate the test controls and gives its verdicts through `executeToolOp`, as a seat does
 * through the bus, so "in the turn" and "after the turn" are exactly the windows the test says they are. The clock is never
 * advanced, so no nudge supplies a turn the verdict did not.
 */

const DONE = { operations: [{ op: "done" } as MeshOp] };
const NOTE = /lead (approved|rejected) your CodePatch "patch" v1/;

const gate = () => {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
};

const turnFor = (agentId: string) =>
  ({ turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`, agentId, reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] }) as never;

async function review(): Promise<{ m: TestMesh; id: string; woken: ActivationReason[] }> {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "test.execute"], interests: [] },
      { id: "lead", role: "tech-lead", capabilities: ["repository.read", "code.review", "git.merge"], authority: ["implementation.approve"], interests: [] },
    ],
    mayContact: { dev: ["lead"], lead: ["dev"] },
    startup: [],
    maxActiveAgents: 2,
    clock: new ManualClock(Date.now()),
  });
  const created = await m.supervisor.createArtifact({ actorId: "dev", name: "patch", type: "CodePatch", content: "the patch, at length, with every file in it" });
  if (!("artifact" in created)) throw new Error("create failed");
  const id = created.artifact.id;
  await m.supervisor.transitionArtifact("dev", id, { to: "READY_FOR_REVIEW" });
  await m.supervisor.executeOp("dev", { op: "request_review", artifactId: id, reviewers: ["lead"] } as MeshOp, turnFor("dev"));
  const woken: ActivationReason[] = [];
  stub(m).setScript("dev", async (ctx) => {
    woken.push(ctx.activation as ActivationReason);
    return DONE;
  });
  return { m, id, woken };
}

const noticed = (woken: ActivationReason[]): ActivationReason[] => woken.filter((r) => r.kind === "interest_event" && NOTE.test(String(r.note ?? "")));

/** `lead` takes a turn in which `act` runs, then holds the turn open until the returned gate is opened. */
async function leadTurn(m: TestMesh, act: () => Promise<void>): Promise<{ held: ReturnType<typeof gate>; ended: () => boolean }> {
  const held = gate();
  stub(m).setScript("lead", async () => {
    await act();
    await held.wait;
    return DONE;
  });
  await m.supervisor.activateAgent("lead", { kind: "manual" });
  return { held, ended: () => !m.supervisor.isTurnInFlight("lead") };
}

const rule = (m: TestMesh, id: string, kind: "approve" | "reject") =>
  m.supervisor.executeToolOp("lead", { op: kind, subject: "implementation", artifactId: id, comment: kind === "reject" ? "the parser drops the last field" : "reviewed" } as MeshOp);

test("the owner is not woken while the ruling seat's turn is still open, and is told when it ends", async () => {
  const { m, id, woken } = await review();
  try {
    const { held, ended } = await leadTurn(m, async () => {
      assert.equal((await rule(m, id, "approve")).ok, true);
    });
    await waitFor("the verdict to land", () => m.kernel.state.artifacts.get(id)!.status === "APPROVED");
    await settle(40);
    assert.equal(m.supervisor.isTurnInFlight("lead"), true, "precondition: the ruling seat is still mid-turn");
    assert.equal(noticed(woken).length, 0, `the owner waits for the turn to end: ${JSON.stringify(woken)}`);

    held.open();
    await waitFor("the ruling seat's turn to end", ended, 5000);
    await waitFor("the owner to be told", () => noticed(woken).length > 0, 5000);
    const note = String(noticed(woken)[0]!.note);
    assert.match(note, /lead approved your CodePatch "patch" v1: it is now APPROVED\. It needs VERIFIED next, and you can move it/);
  } finally {
    await m.cleanup();
  }
});

test("a patch the ruling seat took to the next rung in the same turn is not announced to its owner as waiting for it", async () => {
  const { m, id, woken } = await review();
  let release = (): void => undefined;
  try {
    const { held, ended } = await leadTurn(m, async () => {
      assert.equal((await rule(m, id, "approve")).ok, true);
      for (const to of ["VERIFIED", "MERGEABLE"]) {
        const moved = await m.supervisor.executeToolOp("lead", { op: "transition_artifact", artifactId: id, to } as MeshOp);
        assert.equal(moved.ok, true, `${to}: ${moved.reason}`);
      }
    });
    release = held.open;
    await waitFor("the ruling seat to take it to MERGEABLE", () => m.kernel.state.artifacts.get(id)!.status === "MERGEABLE");
    held.open();
    await waitFor("the ruling seat's turn to end", ended, 5000);
    await settle(80);
    assert.deepEqual(noticed(woken), [], `no wake says the patch needs VERIFIED next: ${JSON.stringify(woken)}`);
    assert.equal(woken.length, 0, "and the owner took no turn at all for it");
  } finally {
    release();
    await m.cleanup();
  }
});

test("a rejection is told to the owner at the end of the ruling seat's turn too, and says to answer it with a new version", async () => {
  const { m, id, woken } = await review();
  let release = (): void => undefined;
  try {
    const { held, ended } = await leadTurn(m, async () => {
      assert.equal((await rule(m, id, "reject")).ok, true);
    });
    release = held.open;
    await waitFor("the verdict to land", () => m.kernel.state.artifacts.get(id)!.status === "REJECTED");
    await settle(40);
    assert.equal(noticed(woken).length, 0, "not while the turn is open");
    held.open();
    await waitFor("the ruling seat's turn to end", ended, 5000);
    await waitFor("the owner to be told", () => noticed(woken).length > 0, 5000);
    assert.match(String(noticed(woken)[0]!.note), /lead rejected your CodePatch "patch" v1: .*Publish a new version of the same artifact/);
  } finally {
    release();
    await m.cleanup();
  }
});

test("a verdict given outside any turn (the operator's) still reaches the owner at once", async () => {
  const { m, id, woken } = await review();
  try {
    // The ruling seat is not in a turn: a synthetic turn state, as an operator's op carries.
    const res = await m.supervisor.executeOp("lead", { op: "approve", subject: "implementation", artifactId: id, comment: "reviewed" } as MeshOp, turnFor("lead"));
    assert.equal(res.ok, true, String(res.reason));
    await waitFor("the owner to be told", () => noticed(woken).length > 0, 5000);
  } finally {
    await m.cleanup();
  }
});

test("two verdicts in one turn, one of them taken on, tell the owner of the other only", async () => {
  const { m, id, woken } = await review();
  const second = await m.supervisor.createArtifact({ actorId: "dev", name: "other patch", type: "CodePatch", content: "another patch" });
  if (!("artifact" in second)) throw new Error("create failed");
  const id2 = second.artifact.id;
  await m.supervisor.transitionArtifact("dev", id2, { to: "READY_FOR_REVIEW" });
  await m.supervisor.executeOp("dev", { op: "request_review", artifactId: id2, reviewers: ["lead"] } as MeshOp, turnFor("dev"));
  let release = (): void => undefined;
  try {
    const { held, ended } = await leadTurn(m, async () => {
      assert.equal((await rule(m, id, "approve")).ok, true);
      assert.equal((await m.supervisor.executeToolOp("lead", { op: "approve", subject: "implementation", artifactId: id2 } as MeshOp)).ok, true);
      assert.equal((await m.supervisor.executeToolOp("lead", { op: "transition_artifact", artifactId: id, to: "VERIFIED" } as MeshOp)).ok, true);
    });
    release = held.open;
    await waitFor("both verdicts to land", () => m.kernel.state.artifacts.get(id2)!.status === "APPROVED" && m.kernel.state.artifacts.get(id)!.status === "VERIFIED");
    held.open();
    await waitFor("the ruling seat's turn to end", ended, 5000);
    await waitFor("the owner to be told", () => woken.some((r) => /other patch/.test(String(r.note ?? ""))), 5000);
    assert.ok(!woken.some((r) => /your CodePatch "patch" v1/.test(String(r.note ?? ""))), `nothing about the patch that was taken on: ${JSON.stringify(woken.map((r) => r.note))}`);
  } finally {
    release();
    await m.cleanup();
  }
});

test("a notice is told once: the ruling seat's next turn does not tell it again", async () => {
  const { m, id, woken } = await review();
  let release = (): void => undefined;
  try {
    const { held, ended } = await leadTurn(m, async () => {
      assert.equal((await rule(m, id, "approve")).ok, true);
    });
    release = held.open;
    await waitFor("the verdict to land", () => m.kernel.state.artifacts.get(id)!.status === "APPROVED");
    held.open();
    await waitFor("the ruling seat's turn to end", ended, 5000);
    await waitFor("the owner to be told", () => noticed(woken).length > 0, 5000);
    await settle(60);
    assert.equal(noticed(woken).length, 1);

    // A second turn of the ruling seat, which rules on nothing.
    stub(m).setScript("lead", async () => DONE);
    await m.supervisor.activateAgent("lead", { kind: "manual" });
    await waitFor("the second turn to end", () => ended(), 5000);
    await settle(80);
    assert.equal(noticed(woken).length, 1, `the owner is not told again: ${JSON.stringify(noticed(woken).map((r) => r.note))}`);
  } finally {
    release();
    await m.cleanup();
  }
});
