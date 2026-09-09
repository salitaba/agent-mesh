import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * Final-answer contract: a turn that still OWES an answer (inbound ask) must
 * end WAITING, not IDLE. Live evidence: tech-lead read Architecture v1 and
 * ended IDLE with zero decision ops — `architecture-approved` never fired,
 * developer/qa stayed cold, and the stall watchdog burned tokens re-waking
 * everyone. A verdict, conversely, must settle the ask so the reviewer is
 * not pinned forever.
 */

test("final-answer: a silent reviewer ends WAITING, not IDLE", async () => {
  const m = await makeMesh({
    agents: [
      { id: "architect", role: "architect", capabilities: ["review.design"], interests: [] },
      { id: "tech-lead", role: "tech-lead", capabilities: ["review.design"], authority: ["architecture.approve"], interests: [] },
    ],
    mayContact: { architect: ["tech-lead"], "tech-lead": ["architect"] },
    startup: ["architect"],
    waitWakeupMs: 60,
  });
  const s = stub(m);
  s.setScript("architect", async (_i, t) =>
    t === 0
      ? ({
          operations: [
            { op: "publish_artifact", name: "Architecture-v1", type: "ArchitectureDocument", content: "layers" },
            { op: "request_review", artifactId: "Architecture-v1", reviewers: ["tech-lead"] },
            { op: "wait" },
          ] as MeshOp[],
        })
      : { operations: [{ op: "done" } as MeshOp] });
  // The silent reviewer: reads nothing, emits nothing, ends the turn.
  s.setScript("tech-lead", async () => ({ operations: [{ op: "done" } as MeshOp] }));

  await waitFor("tech-lead pinned WAITING", () => {
    const rec = m.kernel.state.agents.get("tech-lead")!;
    return rec.state.lifecycle === "WAITING";
  }, 5000);
  const tl = m.kernel.state.agents.get("tech-lead")!;
  assert.equal(tl.state.lifecycle, "WAITING", "a silent reviewer must stay pinned, not go IDLE");
  assert.equal(
    m.supervisor.commitmentStats().open,
    1,
    "the ask is still open and owed, not discharged",
  );
  await m.cleanup();
});

test("final-answer: a verdict settles the ask and the reviewer returns to IDLE", async () => {
  const m = await makeMesh({
    agents: [
      { id: "architect", role: "architect", capabilities: ["review.design"], interests: [] },
      { id: "tech-lead", role: "tech-lead", capabilities: ["review.design"], authority: ["architecture.approve"], interests: [] },
    ],
    mayContact: { architect: ["tech-lead"], "tech-lead": ["architect"] },
    startup: ["architect"],
    waitWakeupMs: 60,
  });
  const s = stub(m);
  let decidedAt = 0;
  s.setScript("architect", async (_i, t) =>
    t === 0
      ? ({
          operations: [
            { op: "publish_artifact", name: "Architecture-v1", type: "ArchitectureDocument", content: "layers" },
            { op: "request_review", artifactId: "Architecture-v1", reviewers: ["tech-lead"] },
            { op: "wait" },
          ] as MeshOp[],
        })
      : { operations: [{ op: "done" } as MeshOp] });
  s.setScript("tech-lead", async (_i, t) => {
    decidedAt = t;
    return {
      operations: [
        { op: "approve", subject: "architecture", artifactId: "Architecture-v1", comment: "looks right" } as MeshOp,
        { op: "done" } as MeshOp,
      ],
    };
  });

  await waitFor("tech-lead free at IDLE with ask settled", () => {
    const rec = m.kernel.state.agents.get("tech-lead")!;
    return rec.state.lifecycle === "IDLE" && decidedAt >= 0 && m.supervisor.commitmentStats().open === 0;
  }, 5000);
  assert.ok(decidedAt >= 0, "reviewer must have run a verdict turn");
  assert.equal(m.supervisor.commitmentStats().open, 0, "the verdict must settle the ask");
  const tl = m.kernel.state.agents.get("tech-lead")!;
  assert.equal(tl.state.lifecycle, "IDLE", "an answering reviewer is free to go IDLE");
  await m.cleanup();
});