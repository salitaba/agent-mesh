import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { ManualClock } from "../support/manual-clock";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * A refusal of an id that names no artifact says which artifacts the mission holds.
 *
 * An id is a dozen characters of base-36 a model has to copy exactly, and it does not. In the fourteenth cronlite run the tech lead
 * wrote `art-M3ZN0TAJ003cc847ab44` for `art-M3ZN0BTK00678bdd816b`, and ten of the fifteen ops of one turn were the same refusal,
 * "unknown artifact", for `approve` and `transition_artifact` alike. The only hint, on `approve`, was "mesh_inbox and
 * mesh_query_events show both": a call and a page the seat did not make. Seats cited a wrong id in nine of the twelve runs.
 *
 * The refusal now lists, newest first and five at most, the artifacts there are: id, type, name, version and status.
 */

const AGENTS = [
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "git.commit"], interests: [] },
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "code.review", "git.merge"], authority: ["implementation.approve"], interests: [] },
];
const COMM = { dev: ["lead"], lead: ["dev"] };

const turnFor = (agentId: string) =>
  ({ turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`, agentId, reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] }) as never;

/** A mesh holding `n` artifacts, one second apart, named `Patch 1` .. `Patch n`; returns their ids oldest first. */
async function meshWith(n: number) {
  const clock = new ManualClock();
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked", clock } as never);
  const ids: string[] = [];
  for (let i = 1; i <= n; i++) {
    clock.advance(1000);
    const created = await m.supervisor.createArtifact({ actorId: "dev", name: `Patch ${i}`, type: "CodePatch", content: `body ${i}` });
    if (!("artifact" in created)) throw new Error(`create failed: ${JSON.stringify(created)}`);
    ids.push(created.artifact.id);
  }
  return { m, ids };
}

const GHOST = "art-M3ZN0TAJ003cc847ab44";
const run = (m: Awaited<ReturnType<typeof meshWith>>["m"], as: string, op: Record<string, unknown>) => m.supervisor.executeOp(as, op as unknown as MeshOp, turnFor(as));

/** The seven ops that name an artifact by id, each given the id that is not there. */
const OPS: Array<[string, string, Record<string, unknown>]> = [
  ["lead", "approve", { op: "approve", subject: "implementation", artifactId: GHOST }],
  ["dev", "transition_artifact", { op: "transition_artifact", artifactId: GHOST, to: "READY_FOR_REVIEW" }],
  ["dev", "request_review", { op: "request_review", artifactId: GHOST, reviewers: ["lead"] }],
  ["dev", "read_artifact", { op: "read_artifact", artifactRef: GHOST }],
  ["dev", "acquire_lease", { op: "acquire_lease", artifactId: GHOST, files: ["a.js"] }],
  ["dev", "commit", { op: "commit", artifactId: GHOST, message: "wip" }],
  ["lead", "merge", { op: "merge", artifactId: GHOST }],
  ["dev", "request_commit", { op: "request_commit", artifactId: GHOST }],
];

test("every op that takes an artifact id names the artifacts there are when the id is not one of them", async () => {
  const { m, ids } = await meshWith(3);
  try {
    for (const [as, label, op] of OPS) {
      const res = await run(m, as, op);
      assert.equal(res.ok, false, label);
      const reason = String(res.reason);
      assert.ok(reason.includes(GHOST), `${label}: the refusal still names what was asked for: ${reason}`);
      // `approve`'s refusal is sentences ("... both). Artifacts in this mission ..."); the others carry it after a dash.
      assert.match(reason, label === "approve" ? /\. Artifacts in this mission, newest first: / : / — artifacts in this mission, newest first: /, `${label}: ${reason}`);
      // Newest first: Patch 3, then 2, then 1.
      const at = ids.slice().reverse().map((id) => reason.indexOf(id));
      assert.ok(at.every((i) => i >= 0), `${label}: all three are named: ${reason}`);
      assert.ok(at[0]! < at[1]! && at[1]! < at[2]!, `${label}: newest first: ${reason}`);
      assert.match(reason, /CodePatch "Patch 3" v1 \(DRAFT\)/, label);
    }
  } finally {
    await m.cleanup();
  }
});

test("a merge that names nothing at all is refused with the list too", async () => {
  const { m } = await meshWith(2);
  try {
    const res = await run(m, "lead", { op: "merge" });
    assert.equal(res.ok, false);
    assert.match(String(res.reason), /^unknown artifact \(none given\) — artifacts in this mission, newest first: art-\S+ CodePatch "Patch 2" v1 \(DRAFT\); art-\S+ CodePatch "Patch 1"/);
  } finally {
    await m.cleanup();
  }
});

test("five at most, and the rest are counted", async () => {
  const { m, ids } = await meshWith(8);
  try {
    const res = await run(m, "dev", { op: "transition_artifact", artifactId: GHOST, to: "READY_FOR_REVIEW" });
    const reason = String(res.reason);
    assert.equal(ids.filter((id) => reason.includes(id)).length, 5, reason);
    for (const id of ids.slice(3)) assert.ok(reason.includes(id), `the newest five include ${id}`);
    assert.match(reason, /; and 3 more \(mesh_query_events lists them all\)$/);
  } finally {
    await m.cleanup();
  }
});

test("a mission with no artifact yet says so, and a long name is cut", async () => {
  const empty = await meshWith(0);
  try {
    const res = await run(empty.m, "dev", { op: "commit", artifactId: GHOST, message: "wip" });
    assert.equal(res.reason, `unknown artifact ${GHOST} — no artifact has been published in this mission yet`);
  } finally {
    await empty.m.cleanup();
  }
  const clock = new ManualClock();
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked", clock } as never);
  try {
    const long = `The implementation of ${"a very long name ".repeat(6)}end`;
    const created = await m.supervisor.createArtifact({ actorId: "dev", name: long, type: "CodePatch", content: "x" });
    assert.ok("artifact" in created);
    const res = await run(m, "dev", { op: "commit", artifactId: GHOST, message: "wip" });
    assert.ok(String(res.reason).includes(`CodePatch "${long.slice(0, 59)}…" v1`), `cut to 60 characters, ellipsis included: ${res.reason}`);
    assert.ok(!String(res.reason).includes(long), "and not the whole of it");
  } finally {
    await m.cleanup();
  }
});

test("an id the mission holds is not refused, and the approve that already named the reviews owed keeps naming them", async () => {
  const { m, ids } = await meshWith(2);
  try {
    const ok = await run(m, "dev", { op: "transition_artifact", artifactId: ids[1], to: "READY_FOR_REVIEW" });
    assert.equal(ok.ok, true, ok.reason);
    assert.doesNotMatch(String(ok.reason ?? ""), /rtifacts in this mission/);
    await run(m, "dev", { op: "request_review", artifactId: ids[1], reviewers: ["lead"] });
    const res = await run(m, "lead", { op: "approve", subject: "implementation", artifactId: GHOST });
    assert.equal(res.ok, false);
    assert.match(String(res.reason), /Still waiting for your verdict: CodePatch "Patch 2"/, "the review on its desk is the better answer");
    assert.doesNotMatch(String(res.reason), /rtifacts in this mission, newest first/, "and the list is not stacked on top of it");
  } finally {
    await m.cleanup();
  }
});
