import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";

function fakeTurn(agentId: string) {
  return {
    turnId: `t-${agentId}-${Math.random().toString(36).slice(2, 8)}`,
    agentId,
    reason: { kind: "manual" },
    sentOps: 0,
    publishedOps: 0,
    waitRequested: false,
    escalated: false,
    results: [],
  } as never;
}

/**
 * Interaction modes (§2.1). A message is not just a type, it is a CONTRACT
 * ABOUT ATTENTION: what it obliges, whether it can be answered, and who has
 * to wake up for it. `service` is the default and the old behaviour.
 * `broadcast` is an announcement — it obliges nobody, cannot be replied to,
 * and wakes only the seats that asked to hear about mail.
 *
 * The mode lives on `control`, which the runtime stamps and
 * `sanitizeAgentMessageInput` strips from agent input, so a sender cannot
 * mark its own ask "broadcast" to dodge the deadline, nor mark an
 * announcement "service" to conscript the roster.
 */

test("broadcast: an announcement opens no commitment, even typed as a request", async () => {
  const m = await makeMesh({
    agents: [
      { id: "architect", role: "architect", interests: [] },
      { id: "dev", role: "developer", interests: [] },
      { id: "qa", role: "qa", interests: [] },
    ],
    mayContact: { architect: ["dev", "qa"] },
    mode: "parked",
  });
  try {
    const bc = await m.supervisor.executeOp(
      "architect",
      { op: "broadcast", type: "REQUEST_REVIEW", payload: { note: "heads up, shipping friday" } } as MeshOp,
      fakeTurn("architect"),
    );
    assert.equal(bc.ok, true, bc.reason);
    assert.equal(m.kernel.state.messages.get(bc.messageId!)!.control?.mode, "broadcast");
    // The defect this closes: a REQUEST-typed broadcast addressed every seat
    // and opened ONE pending entry owed by the whole roster, so the first
    // reply discharged an obligation the other seats still had — and the
    // nudges chased agents nobody had individually asked.
    assert.equal(
      m.kernel.state.pendingRequests.has(bc.messageId!),
      false,
      "a broadcast must not open a commitment",
    );

    // Same type, addressed rather than announced: this one IS an ask.
    const ask = await m.supervisor.sendMessage({
      from: "architect",
      to: ["dev"],
      type: "REQUEST_REVIEW",
      newThread: { subject: "dev, please review" },
      payload: { q: "review this" },
    });
    assert.equal(ask.accepted, true, ask.reason);
    assert.equal(
      m.kernel.state.pendingRequests.has(ask.messageId!),
      true,
      "an addressed request still opens a commitment",
    );
  } finally {
    await m.cleanup();
  }
});

test("broadcast: cannot be replied to, so N seats cannot answer one announcement", async () => {
  const m = await makeMesh({
    agents: [
      { id: "architect", role: "architect", interests: [] },
      { id: "dev", role: "developer", interests: [] },
      { id: "qa", role: "qa", interests: [] },
    ],
    mayContact: { architect: ["dev", "qa"], dev: ["architect"], qa: ["architect"] },
    mode: "parked",
  });
  try {
    const bc = await m.supervisor.executeOp(
      "architect",
      { op: "broadcast", type: "INFORM", payload: { note: "kickoff" } } as MeshOp,
      fakeTurn("architect"),
    );
    assert.equal(bc.ok, true, bc.reason);

    const reply = await m.supervisor.sendMessage({
      from: "dev",
      to: ["architect"],
      type: "INFORM",
      replyTo: bc.messageId!,
      payload: { ack: "got it" },
    });
    assert.equal(reply.accepted, false, "a broadcast is an announcement, not an ask");
    assert.match(reply.reason ?? "", /cannot reply to a broadcast/);

    // Refusing the reply must not refuse the conversation: a seat with
    // something to say opens its own ask, which is tracked and deadlined.
    const own = await m.supervisor.sendMessage({
      from: "dev",
      to: ["architect"],
      type: "REQUEST_INFO",
      newThread: { subject: "about the kickoff" },
      payload: { q: "which repo ships first?" },
    });
    assert.equal(own.accepted, true, own.reason);
    assert.equal(m.kernel.state.pendingRequests.has(own.messageId!), true);
  } finally {
    await m.cleanup();
  }
});

test("broadcast wakes only declared interests; direct mail still wakes its recipient", async () => {
  const m = await makeMesh({
    agents: [
      { id: "architect", role: "architect", interests: [] },
      { id: "watcher", role: "qa", interests: ["message.*"] },
      { id: "quiet", role: "developer", interests: ["release.candidate"] },
    ],
    mayContact: { architect: ["watcher", "quiet"] },
  });
  try {
    const s = stub(m);
    for (const a of ["architect", "watcher", "quiet"]) {
      s.setScript(a, async () => ({ operations: [{ op: "done" } as MeshOp] }));
    }
    const acts = (id: string) => m.kernel.state.agents.get(id)?.state.activations ?? 0;
    // Let the mission's startup activations drain first, then measure DELTAS.
    // Absolute counts would be reading the boot sequence, not the broadcast.
    await new Promise((r) => setTimeout(r, 700));
    const before = { watcher: acts("watcher"), quiet: acts("quiet") };

    const bc = await m.supervisor.executeOp(
      "architect",
      { op: "broadcast", type: "INFORM", payload: { note: "fyi" } } as MeshOp,
      fakeTurn("architect"),
    );
    assert.equal(bc.ok, true, bc.reason);
    await new Promise((r) => setTimeout(r, 700));

    assert.equal(acts("watcher") - before.watcher, 1, "a seat that declared an interest in mail wakes");
    assert.equal(acts("quiet") - before.quiet, 0, "a seat that did not must not pay a turn for an announcement");
    // Suppressed the WAKEUP, not the delivery: it is in the mailbox and gets
    // read on the next natural activation.
    assert.ok(
      m.kernel.state.agents.get("quiet")!.state.mailboxDepth >= 1,
      "the broadcast is still delivered to the seat that was not woken",
    );

    // The suppression is specific to broadcast: addressed mail obliges an
    // answer, so its recipient wakes whatever it declared an interest in.
    const direct = await m.supervisor.sendMessage({
      from: "architect",
      to: ["quiet"],
      type: "REQUEST_INFO",
      newThread: { subject: "quiet, a question" },
      payload: { q: "status?" },
    });
    assert.equal(direct.accepted, true, direct.reason);
    await new Promise((r) => setTimeout(r, 700));
    // At least once: an unanswered ask is also nudged on the wait tick, which
    // is the point — an obligation is chased, an announcement is not.
    assert.ok(acts("quiet") - before.quiet >= 1, "an addressed ask wakes its debtor regardless of interests");
  } finally {
    await m.cleanup();
  }
});
