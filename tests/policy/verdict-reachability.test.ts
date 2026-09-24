import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * Two ways a verdict never happens, and neither used to say so.
 *
 * 1. ASKING a seat that cannot settle the artifact. `canReviewArtifactType` runs at
 *    approval time, never at request time, and the comment on the op claimed
 *    `sendMessage` screened the reviewer side — which was false: `evaluateMessage`
 *    checks sender registration and the contact matrix and never looks at the
 *    recipient's capability or the artifact's type. 3 of 5 review requests in one
 *    live run named a reviewer who could not deliver a binding verdict.
 *
 * 2. ASSERTING a verdict in a message instead of an op. `APPROVE`/`REJECT`/`VETO`
 *    are valid message types, `deriveSemantic` had no branch for them, and nothing
 *    reads `payload.verdict`. 6 of 25 verdict assertions had no backing op; two
 *    seats did it every time.
 *
 * The screen deliberately uses `approverMayAdvance`, not `canReviewArtifactType`:
 * the latter is narrower than what `recordDecision` accepts and would refuse the
 * cross-domain `<role>.approve` signatures the gate system depends on.
 */

const AGENTS = [
  { id: "arch", role: "architect", capabilities: ["repository.read", "repository.write"], authority: ["architecture.approve"], interests: [] },
  // Holds review.design — can settle a design artifact even signing as `quality`.
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "review.design"], authority: ["quality.approve"], interests: [] },
  // Holds neither. This is the seat that was being asked for verdicts it could
  // never give — skill-panel's ui-designer and frontend, exactly.
  { id: "ui", role: "ui-designer", capabilities: ["repository.read", "ui.write"], interests: [] },
];
const COMM = { arch: ["lead", "ui"], lead: ["arch", "ui"], ui: ["arch", "lead"] };

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

async function designUnderReview() {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" } as never);
  const created = await m.supervisor.createArtifact({ actorId: "arch", name: "design-system", type: "ArchitectureDocument", content: "tokens, components, states — at length" });
  if (!("artifact" in created)) throw new Error("create failed");
  return { m, id: created.artifact.id };
}

test("a review request naming only seats that cannot settle it is refused, and names who can", async () => {
  const { m, id } = await designUnderReview();
  try {
    const res = await m.supervisor.executeOp("arch", { op: "request_review", artifactId: id, reviewers: ["ui"] } as MeshOp, turnFor("arch"));

    assert.equal(res.ok, false, "a verdict from ui could never count, so the ask is a wasted turn");
    assert.match(String(res.reason), /none of ui can deliver a verdict on this ArchitectureDocument/);
    assert.match(String(res.reason), /lead can/, "the refusal is a route, not a dead end");
    assert.equal(m.kernel.state.artifacts.get(id)?.status, "DRAFT", "and nothing moved — a refused ask leaves no reviewable state behind");

    const denial = (await m.store.read()).find(
      (e) => e.type === "message.rejected" && (e.payload as { ruleId?: string }).ruleId === "review.reviewer-cannot-settle",
    );
    assert.ok(denial, "the refusal is on the record");
  } finally {
    await m.cleanup();
  }
});

test("a mixed reviewer list stands, and the asker is told which seat cannot settle", async () => {
  // The live shape: every one of the three bad requests paired a capable reviewer
  // with an incapable one, which is why the waste was survivable and invisible. The
  // ask must not be refused — a capable reviewer is on it — but the asker should
  // learn it named a seat whose verdict cannot count.
  const { m, id } = await designUnderReview();
  try {
    const res = await m.supervisor.executeOp("arch", { op: "request_review", artifactId: id, reviewers: ["lead", "ui"] } as MeshOp, turnFor("arch"));

    assert.equal(res.ok, true, res.reason ?? "");
    assert.match(String(res.reason), /ui cannot deliver a verdict on this ArchitectureDocument/, "the caveat reaches the asker's next context via endSummary");
    assert.match(String(res.reason), /lead can, so the ask stands/);
    assert.equal(m.kernel.state.artifacts.get(id)?.status, "UNDER_REVIEW", "and the artifact did move — the ask is real");
  } finally {
    await m.cleanup();
  }
});

test("a review request to a capable reviewer carries no caveat at all", async () => {
  const { m, id } = await designUnderReview();
  try {
    const res = await m.supervisor.executeOp("arch", { op: "request_review", artifactId: id, reviewers: ["lead"] } as MeshOp, turnFor("arch"));
    assert.equal(res.ok, true, res.reason ?? "");
    assert.equal(res.reason, undefined, "nothing to warn about, so no noise");
  } finally {
    await m.cleanup();
  }
});

test("an APPROVE message is delivered, records a refusal naming the op, and wakes its sender once", async () => {
  const { m, id } = await designUnderReview();
  try {
    await m.supervisor.executeOp("arch", { op: "request_review", artifactId: id, reviewers: ["lead"] } as MeshOp, turnFor("arch"));

    // A full, reasoned approval — as a message. This is what pm and ux-designer did
    // every time they "approved" something in the live run.
    const sent = await m.supervisor.sendMessage({
      from: "lead",
      to: ["arch"],
      type: "APPROVE",
      newThread: { subject: "verdict" },
      payload: { artifactId: id, verdict: "APPROVED — no objection, the design is coherent" },
    });
    assert.equal(sent.accepted, true, "the message is still delivered — it is a statement, and may carry reasoning");

    assert.notEqual(m.kernel.state.artifacts.get(id)?.status, "APPROVED", "but it settles nothing");

    const events = await m.store.read();
    assert.ok(!events.some((e) => e.type === "review.approved"), "and records no verdict");
    const denial = events.find((e) => e.type === "message.rejected" && (e.payload as { ruleId?: string }).ruleId === "verdict.message-only");
    assert.ok(denial, "the refusal is recorded");
    const reason = String((denial.payload as { reason?: string }).reason);
    assert.match(reason, /reads verdicts only from the `approve` op/, "and names the op to use");
    assert.match(reason, new RegExp(`"artifactId":"${id}"`), "with the artifact already filled in, so the remedy is copy-pasteable");
  } finally {
    await m.cleanup();
  }
});

test("a REJECT message gets the same treatment, named for its own op", async () => {
  const { m, id } = await designUnderReview();
  try {
    await m.supervisor.executeOp("arch", { op: "request_review", artifactId: id, reviewers: ["lead"] } as MeshOp, turnFor("arch"));
    await m.supervisor.sendMessage({
      from: "lead",
      to: ["arch"],
      type: "REJECT",
      newThread: { subject: "verdict" },
      payload: { artifactId: id, verdict: "REJECTED — three contract defects" },
    });

    const denial = (await m.store.read()).find(
      (e) => e.type === "message.rejected" && (e.payload as { ruleId?: string }).ruleId === "verdict.message-only",
    );
    assert.ok(denial);
    assert.match(String((denial.payload as { reason?: string }).reason), /`reject` op/, "the remedy names reject, not approve");
    assert.notEqual(m.kernel.state.artifacts.get(id)?.status, "REJECTED", "a rejection by message withholds nothing");
  } finally {
    await m.cleanup();
  }
});

test("a real verdict op is untouched by any of this", async () => {
  // The control. None of the above may make the legitimate path harder, including
  // the cross-domain capacity signature the gate system rests on.
  const { m, id } = await designUnderReview();
  try {
    await m.supervisor.executeOp("arch", { op: "request_review", artifactId: id, reviewers: ["lead"] } as MeshOp, turnFor("arch"));
    const res = await m.supervisor.executeOp("lead", { op: "approve", subject: "quality", artifactId: id } as MeshOp, turnFor("lead"));

    assert.equal(res.ok, true, res.reason ?? "");
    assert.equal(m.kernel.state.artifacts.get(id)?.status, "APPROVED", "signing as `quality` on a design artifact still works");
    const events = await m.store.read();
    assert.ok(
      !events.some((e) => e.type === "message.rejected" && (e.payload as { ruleId?: string }).ruleId === "verdict.message-only"),
      "and records no message-only refusal",
    );
  } finally {
    await m.cleanup();
  }
});
