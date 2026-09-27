import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { createInitialState } from "../../packages/core/src/state";
import { applyEvent, projectionConfigFor } from "../../packages/core/src/projections";
import type { MeshMessage, MeshOp } from "../../packages/protocol/src/index";

/**
 * §13 of the 2026-09-25 live run: a new version silently voided open review
 * asks, and every publish was a new full version.
 *
 * architect published v2 of four documents 4.5 min after v1: five review asks
 * closed "superseded", only the asker was woken (and not when it made the new
 * version itself), the reviewers were never told, and nothing was re-asked for
 * up to 30 minutes — frontend spent two turns (83k tokens) reviewing ApiSpec
 * v1. And ui-designer's one logical v3 landed as v3–v6 in 2m18s, each version
 * wiping approvals and closing the review ask again.
 */

const AGENTS = [
  { id: "arch", role: "architect", capabilities: ["repository.read", "architecture.write"], authority: ["architecture.approve"], interests: [] },
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "review.design"], authority: ["quality.approve", "quality.reject"], interests: [] },
  { id: "pm", role: "pm", capabilities: ["repository.read"], authority: ["requirements.approve"], interests: [] },
];
const COMM = { arch: ["lead", "pm"], lead: ["arch", "pm"], pm: ["arch", "lead"] };

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

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

async function sent(m: Mesh): Promise<MeshMessage[]> {
  return (await m.store.read()).filter((e) => e.type === "message.sent").map((e) => (e.payload as { message: MeshMessage }).message);
}

/** A v1 design under review by lead, asked for by `asker`. */
async function v1UnderReview(asker: "arch" | "pm" = "arch") {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" });
  const pub = await m.supervisor.executeOp(
    "arch",
    { op: "publish_artifact", name: "system-design", type: "ArchitectureDocument", content: "# Design v1\nthe first cut" } as MeshOp,
    turnFor("arch"),
  );
  assert.equal(pub.ok, true, pub.reason);
  const id = pub.artifactId!;
  const asked = await m.supervisor.executeOp(asker, { op: "request_review", artifactId: id, reviewers: ["lead"] } as MeshOp, turnFor(asker));
  assert.equal(asked.ok, true, asked.reason);
  assert.equal(m.kernel.state.artifacts.get(id)?.status, "UNDER_REVIEW", "precondition: v1 is under review");
  return { m, id, askId: asked.messageId! };
}

test("carry-over: a v2 published READY_FOR_REVIEW re-asks the same reviewer, on behalf of the original asker", async () => {
  const { m, id, askId } = await v1UnderReview("pm");
  try {
    const v2 = await m.supervisor.executeOp(
      "arch",
      { op: "publish_artifact", name: "system-design", type: "ArchitectureDocument", content: "# Design v2\nrevised", asVersionOf: id, status: "READY_FOR_REVIEW" } as MeshOp,
      turnFor("arch"),
    );
    assert.equal(v2.ok, true, v2.reason);
    assert.equal(m.kernel.state.artifacts.get(id)?.version, 2);

    assert.equal(m.kernel.state.pendingRequests.has(askId), false, "the v1 ask is closed");
    const reask = (await sent(m)).find((msg) => msg.type === "REQUEST_REVIEW" && msg.id !== askId);
    assert.ok(reask, "a review of v2 was asked for — before this, nobody was re-asked for up to 30 minutes");
    assert.equal(reask.from, "pm", "on behalf of the seat that asked for the v1 review");
    assert.deepEqual(reask.to, ["lead"]);
    assert.deepEqual(reask.artifactRefs.map((r) => r.uri), ["artifact://ArchitectureDocument/system-design/2"]);
    assert.match(String((reask.payload as { question?: string }).question), /v1.*superseded by v2.*re-review v2/);
    assert.ok(m.kernel.state.pendingRequests.has(reask.id), "and lead owes it");
    assert.equal(m.kernel.state.artifacts.get(id)?.status, "UNDER_REVIEW", "v2 is under review, as v1 was");
    assert.match(v2.reason ?? "", /re-asked lead to review v2/, "the publisher is told what happened to the asks its version superseded");
  } finally {
    await m.cleanup();
  }
});

test("carry-over: a v2 still in DRAFT is not put under review — the reviewer is told to stop, and asked once it is submitted", async () => {
  const { m, id, askId } = await v1UnderReview("arch");
  try {
    const before = (await sent(m)).length;
    const v2 = await m.supervisor.executeOp(
      "arch",
      { op: "publish_artifact", name: "system-design", type: "ArchitectureDocument", content: "# Design v2\nhalf-written", asVersionOf: id } as MeshOp,
      turnFor("arch"),
    );
    assert.equal(v2.ok, true, v2.reason);
    assert.equal(m.kernel.state.artifacts.get(id)?.status, "DRAFT", "the owner's draft stays a draft");
    assert.equal(m.kernel.state.pendingRequests.has(askId), false);

    const after = (await sent(m)).slice(before);
    assert.equal(after.filter((msg) => msg.type === "REQUEST_REVIEW").length, 0, "no review is asked of a DRAFT nobody submitted");
    const stop = after.find((msg) => msg.type === "INFORM" && (msg.payload as { superseded?: boolean }).superseded === true);
    assert.ok(stop, "the reviewer is TOLD — before this, reviewers were never told and kept reviewing v1");
    assert.deepEqual(stop.to, ["lead"]);
    assert.equal(stop.threadId, m.kernel.state.messages.get(askId)?.threadId, "in the thread of the ask it closes");
    assert.match(String((stop.payload as { summary?: string }).summary), /stop reviewing v1.*asked again when v2 is submitted/);
    assert.equal(stop.control?.delivery ?? "accrue", "accrue", "a de-escalation buys no wake");
    assert.match(v2.reason ?? "", /lead were told to stop/);

    // The promise is kept: submitting v2 re-asks lead, on the original asker's behalf.
    const tr = await m.supervisor.executeOp("arch", { op: "transition_artifact", artifactId: id, to: "READY_FOR_REVIEW" } as MeshOp, turnFor("arch"));
    assert.equal(tr.ok, true, tr.reason);
    const reask = (await sent(m)).slice(before).find((msg) => msg.type === "REQUEST_REVIEW");
    assert.ok(reask, "submitting the version re-issues the held review ask");
    assert.equal(reask.from, "arch");
    assert.deepEqual(reask.to, ["lead"]);
    assert.deepEqual(reask.artifactRefs.map((r) => r.uri), ["artifact://ArchitectureDocument/system-design/2"]);
    assert.ok(m.kernel.state.pendingRequests.has(reask.id));
  } finally {
    await m.cleanup();
  }
});

test("carry-over: once the owner asks for the new version's review itself, the held ask is spent — a later resubmission re-adds nobody", async () => {
  const { m, id } = await v1UnderReview("arch");
  try {
    const turn = turnFor("arch");
    await m.supervisor.executeOp("arch", { op: "publish_artifact", name: "system-design", type: "ArchitectureDocument", content: "# v2", asVersionOf: id } as MeshOp, turn);
    const own = await m.supervisor.executeOp("arch", { op: "request_review", artifactId: id, reviewers: ["lead"] } as MeshOp, turn);
    assert.equal(own.ok, true, own.reason);
    // lead rejects v2; the owner reworks it in place and resubmits the same version.
    const rej = await m.supervisor.executeOp("lead", { op: "reject", subject: "quality", artifactId: id, comment: "not yet" } as MeshOp, turnFor("lead"));
    assert.equal(rej.ok, true, rej.reason);
    assert.equal(m.kernel.state.artifacts.get(id)?.status, "REJECTED");
    for (const to of ["DRAFT", "READY_FOR_REVIEW"] as const) {
      const tr = await m.supervisor.executeOp("arch", { op: "transition_artifact", artifactId: id, to } as MeshOp, turnFor("arch"));
      assert.equal(tr.ok, true, tr.reason);
    }
    const asks = (await sent(m)).filter((msg) => msg.type === "REQUEST_REVIEW" && msg.artifactRefs.some((r) => r.uri.endsWith("/2")));
    assert.equal(asks.length, 1, "exactly the owner's own ask: the carry-over held for v2 was answered by it");
  } finally {
    await m.cleanup();
  }
});

test("amend: republishing an unreviewed DRAFT in the turn that created it rewrites that version instead of adding one", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" });
  try {
    const turn = turnFor("arch");
    const v1 = await m.supervisor.executeOp("arch", { op: "publish_artifact", name: "ui-kit", type: "ArchitectureDocument", content: "# UI kit\nfirst pass" } as MeshOp, turn);
    assert.equal(v1.ok, true, v1.reason);
    const id = v1.artifactId!;
    const again = await m.supervisor.executeOp(
      "arch",
      { op: "publish_artifact", name: "ui-kit", type: "ArchitectureDocument", content: "# UI kit\nfirst pass, fixed", asVersionOf: id } as MeshOp,
      turn,
    );
    assert.equal(again.ok, true, again.reason);
    const a = m.kernel.state.artifacts.get(id)!;
    assert.equal(a.version, 1, "still v1 — before this every republish was a new full version (v3–v6 in 2m18s)");
    assert.equal(a.status, "DRAFT");
    const body = await m.supervisor.executeOp("arch", { op: "read_artifact", artifactRef: id } as MeshOp, turn);
    assert.equal(body.reason, "# UI kit\nfirst pass, fixed", "the body is the corrected one");
    assert.equal(m.kernel.state.artifactHistory.get(id)?.length, 1, "no second history entry for the same version");
    assert.match(again.reason ?? "", /amended v1 in place/);
    const amendEvents = (await m.store.read()).filter((e) => e.type === "artifact.versioned");
    assert.equal(amendEvents.length, 1);
    assert.equal((amendEvents[0]!.payload as { amends?: number }).amends, 1, "the log says it was an amend");

    // Replay reproduces it exactly.
    const fresh = createInitialState();
    for (const e of await m.store.read()) applyEvent(fresh, e, projectionConfigFor(m.config));
    assert.deepEqual(fresh.artifacts.get(id), a);
    assert.deepEqual(fresh.artifactHistory.get(id), m.kernel.state.artifactHistory.get(id));
  } finally {
    await m.cleanup();
  }
});

test("amend: a republish in a LATER turn, after a review ask, or after a peer read it, is a new version as before", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" });
  const publish = (name: string, content: string, turn: never, asVersionOf?: string) =>
    m.supervisor.executeOp("arch", { op: "publish_artifact", name, type: "ArchitectureDocument", content, ...(asVersionOf ? { asVersionOf } : {}) } as MeshOp, turn);
  try {
    // A later turn.
    const a = await publish("later", "# a", turnFor("arch"));
    await publish("later", "# a2", turnFor("arch"), a.artifactId);
    assert.equal(m.kernel.state.artifacts.get(a.artifactId!)?.version, 2, "another turn is another decision");

    // Same turn, but it was already put up for review (and so left DRAFT).
    const t2 = turnFor("arch");
    const b = await publish("asked", "# b", t2);
    await m.supervisor.executeOp("arch", { op: "request_review", artifactId: b.artifactId, reviewers: ["lead"] } as MeshOp, t2);
    await publish("asked", "# b2", t2, b.artifactId);
    assert.equal(m.kernel.state.artifacts.get(b.artifactId!)?.version, 2, "a version somebody was asked to review is never rewritten");

    // Same turn, DRAFT, no ask — but a peer has read it.
    const t3 = turnFor("arch");
    const c = await publish("read", "# c", t3);
    const read = await m.supervisor.executeOp("lead", { op: "read_artifact", artifactRef: c.artifactUri! } as MeshOp, turnFor("lead"));
    assert.equal(read.ok, true, read.reason);
    await publish("read", "# c2", t3, c.artifactId);
    assert.equal(m.kernel.state.artifacts.get(c.artifactId!)?.version, 2, "content a peer has read must not change under the same version");
  } finally {
    await m.cleanup();
  }
});

test("amend: the reducer refuses a raw amend of a version that is no longer an unreviewed DRAFT", async () => {
  const { m, id } = await v1UnderReview("arch");
  try {
    const cur = m.kernel.state.artifacts.get(id)!;
    await assert.rejects(
      () => m.kernel.emit("artifact.versioned", { artifact: { ...cur, digest: "sha256:forged" }, amends: cur.version }, { actorId: "arch", goalId: cur.goalId }),
      /only a DRAFT may be amended/,
    );
    assert.equal(m.kernel.state.artifacts.get(id)?.digest, cur.digest, "nothing was rewritten");
  } finally {
    await m.cleanup();
  }
});
