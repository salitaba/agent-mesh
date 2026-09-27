import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { approverMayAdvance, subjectForArtifactType, capabilityForReview } from "../../packages/core/src/projections";
import { ARTIFACT_TYPES, defaultArtifactScope, validateArtifact } from "../../packages/protocol/src/index";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * §10 of the 2026-09-25 live run: there was no design artifact type.
 *
 * The UX flow and the UI design system had to be filed as ArchitectureDocument,
 * so ux-designer approving the design system (seq 525, 925) read in the verdict
 * ledger as an architecture approval, and could evidence `architecture-approved`
 * for the mission.
 */

const AGENTS = [
  { id: "arch", role: "architect", capabilities: ["repository.read", "architecture.write", "review.design"], authority: ["architecture.approve"], interests: [] },
  // Reviews design by capability alone — the only design reviewer skill-panel had besides the architect and tech-lead.
  { id: "ux", role: "ux-designer", capabilities: ["repository.read", "ui.write", "review.design"], interests: [] },
  // Writes UI, reviews nothing.
  { id: "ui", role: "ui-designer", capabilities: ["repository.read", "ui.write"], interests: [] },
];
const COMM = { arch: ["ux", "ui"], ux: ["arch", "ui"], ui: ["arch", "ux"] };

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

test("design type: DesignSpec is a protocol artifact type — listed, schema-valid, reviewed as design, shared like the documents it replaces", () => {
  assert.ok((ARTIFACT_TYPES as string[]).includes("DesignSpec"));
  assert.equal(capabilityForReview("DesignSpec"), "review.design");
  assert.equal(subjectForArtifactType("DesignSpec"), "architecture", "settled by the seats that settled it as an ArchitectureDocument");
  assert.equal(defaultArtifactScope("DesignSpec"), "mission");
  const ok = validateArtifact({
    id: "art-x", name: "design-system", type: "DesignSpec", goalId: "g", owner: "ui", version: 1, status: "DRAFT",
    contentRef: "mem://x", digest: "sha256:abc", metadata: {}, provenance: { source: "agent", trustLevel: 50 },
    createdAt: "2026-09-26T00:00:00.000Z", createdBy: "ui",
  });
  assert.equal(ok.valid, true, JSON.stringify(ok.errors));
});

test("design type: a design reviewer can settle a DesignSpec, and approving it does not evidence architecture-approved", async () => {
  const m = await makeMesh({
    agents: AGENTS,
    mayContact: COMM,
    mode: "parked",
    criteria: [{ id: "architecture-approved", description: "Architecture approved", mandatory: true }],
  });
  try {
    const pub = await m.supervisor.executeOp("ui", { op: "publish_artifact", name: "design-system", type: "DesignSpec", content: "# Design system\ntokens, components, states" } as MeshOp, turnFor("ui"));
    assert.equal(pub.ok, true, pub.reason);
    const a = m.kernel.state.artifacts.get(pub.artifactId!)!;
    assert.equal(approverMayAdvance(m.kernel.state, "ux", a), true, "review.design settles it");
    assert.equal(approverMayAdvance(m.kernel.state, "arch", a), true, "so does architecture.approve");

    const asked = await m.supervisor.executeOp("ui", { op: "request_review", artifactId: a.id, reviewers: ["ux"] } as MeshOp, turnFor("ui"));
    assert.equal(asked.ok, true, asked.reason);
    const approved = await m.supervisor.executeOp("ux", { op: "approve", subject: "quality", artifactId: a.id, comment: "coherent" } as MeshOp, turnFor("ux"));
    assert.equal(approved.ok, true, approved.reason);
    assert.equal(m.kernel.state.artifacts.get(a.id)?.status, "APPROVED");
    const goal = m.kernel.state.goals.get(m.kernel.state.activeGoalId!)!;
    assert.equal(
      goal.acceptanceCriteria.find((c) => c.id === "architecture-approved")?.status,
      "UNSATISFIED",
      "a design system is not the architecture — filed as ArchitectureDocument, this approval closed the criterion",
    );
  } finally {
    await m.cleanup();
  }
});
