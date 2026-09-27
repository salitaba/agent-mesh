import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * §17 of the 2026-09-25 live run: every REQUEST_REVIEW of an
 * ArchitectureDocument or ApiSpec emitted a `design.question` ("Review X vN")
 * that nothing answered. explorer, interested in `design.question`, was woken by
 * one after the version it named had been superseded — twice — and spent 812k
 * tokens (12% of the mission) on self-directed work.
 */

const AGENTS = [
  { id: "arch", role: "architect", capabilities: ["repository.read", "repository.write"], authority: ["architecture.approve"], interests: [] },
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "review.design"], interests: [] },
  { id: "explorer", role: "explorer", capabilities: ["repository.read"], interests: ["design.question"] },
];
const COMM = { arch: ["lead", "explorer"], lead: ["arch"], explorer: ["arch"] };

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

test("comms: a review request is a review request, not a design question nobody answers", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" } as never);
  try {
    for (const [name, type] of [["core", "ArchitectureDocument"], ["api", "ApiSpec"]] as const) {
      const created = await m.supervisor.createArtifact({ actorId: "arch", name, type, content: `${name}, at length` });
      if (!("artifact" in created)) throw new Error("create failed");
      const res = await m.supervisor.executeOp("arch", { op: "request_review", artifactId: created.artifact.id, reviewers: ["lead"] } as MeshOp, turnFor("arch"));
      assert.equal(res.ok, true, res.reason);
    }
    const events = await m.store.read();
    assert.equal(events.filter((e) => e.type === "review.requested").length, 2, "the asks themselves are unchanged");
    assert.deepEqual(events.filter((e) => e.type === "design.question"), [], "and no restatement of them goes out as a question");
  } finally {
    await m.cleanup();
  }
});
