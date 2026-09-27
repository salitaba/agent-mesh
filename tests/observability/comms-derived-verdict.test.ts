import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTurnSteps } from "../../packages/observability/src/index";
import { producedFromTimeline } from "../../apps/mesh-dashboard/src/ledger";
import type { MeshEvent } from "../../packages/protocol/src/index";

/**
 * One approval, one decision.
 *
 * Since 2026-09-26 every approval is a `review.approved`, and an architecture
 * approval that lands is followed by an `architecture.approved` marked
 * `derived` that restates it (§10 of the 2026-09-25 run: the two were
 * alternatives, which split the verdict ledger). Both per-turn counters used to
 * count every `architecture.approved` as a decision, so the pair would have read
 * as two. An underived one — every log written before the change — is still
 * the approval itself and still counts.
 */

function effect(seq: number, type: string, payload: Record<string, unknown> = {}): MeshEvent {
  const at = new Date(Date.UTC(2026, 8, 26, 0, 0, seq)).toISOString();
  return { id: `e${seq}`, seq, type, at, timestamp: at, actorId: "lead", correlationId: "turn-1", payload } as unknown as MeshEvent;
}

const TURN = [
  effect(1, "agent.awakened", { agentId: "lead", turnId: "turn-1", reason: { kind: "message" } }),
  effect(2, "review.approved", { artifactId: "art-1", subject: "artifact:art-1", kind: "approve" }),
  effect(3, "artifact.transition", { artifactId: "art-1", to: "APPROVED", derived: true }),
  effect(4, "architecture.approved", { artifactId: "art-1", subject: "architecture", derived: true, viaEvent: "e2" }),
  effect(5, "agent.state_changed", { agentId: "lead", to: "IDLE", turnId: "turn-1" }),
];

test("comms: the server's step counts one decision for an approval and its derived architecture notice", () => {
  const steps = buildTurnSteps(TURN);
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.ops?.decisions, 1);
});

test("comms: the dashboard's produced counts agree, and an older underived notice still counts", () => {
  assert.equal(producedFromTimeline(TURN)?.decisions, 1, "the derived notice is an echo, not a second decision");
  const legacy = producedFromTimeline([effect(1, "architecture.approved", { artifactId: "art-1", subject: "architecture" })]);
  assert.equal(legacy?.decisions, 1, "before the change it WAS the approval");
});
