import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";

test("stalemate: an unanswered request escalates after the nudge limit instead of burning budget forever", async () => {
  const m = await makeMesh({
    agents: [
      { id: "asker", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "ghost", role: "architect", capabilities: ["review.design"], authority: ["architecture.approve"], interests: [] },
    ],
    mayContact: { asker: ["ghost"], ghost: [] },
    waitWakeupMs: 60,
  });
  const s = stub(m);
  // asker sends a REQUEST_REVIEW; ghost has NO script, so it can never answer.
  s.setScript("asker", async (_i, turn) => {
    if (turn === 0) return { operations: [{ op: "send", type: "REQUEST_REVIEW", to: ["ghost"], newThread: { subject: "review plz" }, payload: { q: 1 } }, { op: "wait" }] as MeshOp[] };
    return { operations: [{ op: "done" } as MeshOp] };
  });
  // ghost intentionally has no script → returns done, never resolves the request.

  await m.supervisor.activateAgent("asker", { kind: "manual" });
  // wait for the scheduler to nudge ghost past MAX_NUDGES and escalate
  const deadline = Date.now() + 8000;
  let escalated = false;
  while (Date.now() < deadline && !escalated) {
    await new Promise((r) => setTimeout(r, 100));
    escalated = [...m.kernel.state.escalations.values()].some((e) => e.reason === "stalemate:unanswered_request");
  }
  assert.ok(escalated, "a request that is never answered must escalate as a stalemate");
  const esc = [...m.kernel.state.escalations.values()].find((e) => e.reason === "stalemate:unanswered_request")!;
  assert.ok(esc.disagreementArtifactRef, "stalemate escalation carries a disagreement artifact");
  // ghost activations should be bounded (a few nudges, then silence), not infinite
  const ghostActs = m.kernel.state.agents.get("ghost")!.state.activations;
  assert.ok(ghostActs <= 6, `nudge storm not bounded: ${ghostActs} activations`);

  // an operator can unblock it
  const r = await m.supervisor.respondEscalation(esc.id, "approve it manually");
  assert.equal(r.ok, true);
  await m.cleanup();
});
