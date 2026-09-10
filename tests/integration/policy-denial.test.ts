import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, collectEvents, eventTypes } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * Layer-3 (bus) enforcement, end to end.
 *
 * `tests/policy/` already proves `PolicyEngine.evaluateMessage` returns DENY
 * for a forbidden pair. That is not the same claim as "a running mesh never
 * delivers the message": delivery is four collaborators away from the decision
 * (supervisor -> kernel -> projections -> mailbox), and a denial that still
 * lands in `state.unread` would pass every unit test while voiding the
 * communication matrix at runtime. These tests assert the *mailbox*, not the
 * verdict.
 */

const AGENTS = [
  { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
  { id: "qa", role: "qa", capabilities: ["test.execute"], interests: [] },
  { id: "pm", role: "product-manager", capabilities: [], interests: [] },
];

/** dev may reach qa; nobody may initiate contact with pm. */
const COMM = { dev: ["qa"], qa: ["dev"], pm: [] };

const unreadOf = (m: Awaited<ReturnType<typeof makeMesh>>, id: string): number =>
  m.kernel.state.unread.get(id)?.length ?? 0;

test("policy denial e2e: a forbidden send is refused and never reaches the recipient mailbox", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" });
  try {
    const before = unreadOf(m, "pm");

    const res = await m.supervisor.sendMessage({
      from: "dev",
      to: ["pm"],
      type: "INFORM",
      newThread: { subject: "unsolicited status update" },
      payload: { note: "shipping tomorrow" },
    });

    assert.equal(res.accepted, false, "the send must be refused");
    assert.match(res.reason ?? "", /communication policy forbids/);
    assert.equal(res.messageId, undefined, "a denied send mints no message id");

    // The refusal is VISIBLE: a silently dropped send is indistinguishable
    // from a delivered one on the dashboard.
    const types = eventTypes(await collectEvents(m));
    assert.ok(types.includes("message.rejected"), "the denial must be event-sourced");
    assert.ok(!types.includes("message.sent"), "no send event may accompany a denial");

    // The claim that actually matters.
    assert.equal(unreadOf(m, "pm"), before, "pm's mailbox must be untouched");
    assert.equal(
      [...m.kernel.state.messages.values()].filter((x) => x.to.includes("pm")).length,
      0,
      "no message addressed to pm may exist in the projection",
    );
    // No thread either: a refused send must not leave a conversation behind.
    assert.equal(
      [...m.kernel.state.threads.values()].filter((t) => t.participants.includes("pm")).length,
      0,
      "a denied send must not open a thread with the forbidden recipient",
    );
  } finally {
    await m.cleanup();
  }
});

test("policy denial e2e: an agent turn that addresses a forbidden peer lands zero delivery", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "live" });
  try {
    const s = stub(m);
    let turns = 0;
    s.setScript("dev", async () => {
      turns++;
      return {
        text: "try to reach pm directly",
        operations: [
          { op: "send", type: "INFORM", to: ["pm"], newThread: { subject: "backchannel" }, payload: { note: "hi" } } as MeshOp,
          { op: "done" } as MeshOp,
        ],
      };
    });
    s.setScript("pm", async () => ({ operations: [{ op: "done" } as MeshOp] }));
    s.setScript("qa", async () => ({ operations: [{ op: "done" } as MeshOp] }));

    await m.supervisor.activateAgent("dev", { kind: "manual" });
    await waitFor("dev took its turn", () => turns > 0, 8000);
    await m.supervisor.forceWatchdog();

    // The turn ran and did real work; only the forbidden op was refused.
    assert.ok(turns > 0, "the turn must actually execute");
    assert.equal(unreadOf(m, "pm"), 0, "pm never receives the backchannel message");
    const types = eventTypes(await collectEvents(m));
    assert.ok(types.includes("message.rejected"), "the refused op is recorded");
    // A denial is not an escalation: the runtime absorbs it without spending
    // the operator's attention.
    assert.equal(
      [...m.kernel.state.escalations.values()].filter((e) => e.status === "OPEN").length,
      0,
      "a plain communication denial must not raise a card",
    );
  } finally {
    await m.cleanup();
  }
});

test("policy denial e2e: a multi-recipient send is redirected to the permitted subset only", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" });
  try {
    // qa is allowed, pm is not: REDIRECT, not DENY — the legitimate half of
    // the send must still be delivered rather than the whole thing dropped.
    const res = await m.supervisor.sendMessage({
      from: "dev",
      to: ["qa", "pm"],
      type: "PATCH_READY",
      newThread: { subject: "patch v1" },
      payload: { summary: "ready for test" },
    });

    assert.equal(res.accepted, true, "the permitted recipient still gets the message");
    assert.ok(unreadOf(m, "qa") > 0, "qa received it");
    assert.equal(unreadOf(m, "pm"), 0, "pm was dropped from the recipient list");

    const delivered = [...m.kernel.state.messages.values()].find((x) => x.id === res.messageId);
    assert.ok(delivered, "the message exists");
    assert.deepEqual(delivered.to, ["qa"], "the stored envelope names only the permitted recipient");
  } finally {
    await m.cleanup();
  }
});
