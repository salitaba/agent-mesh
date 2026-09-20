import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * Mail must outlive the turn that was supposed to read it.
 *
 * `message.delivered` is the only exit from `state.unread` — the reducer
 * splices the id out and nothing ever puts it back — so WHEN the supervisor
 * emits it decides whether a failed turn loses its mail. It used to be emitted
 * on the way in, before `callRuntimeWithTimeout`, which meant a timeout, a dead
 * backend or a crashed process consumed messages no model had been shown. The
 * loss was silent twice over: a drained mailbox looks exactly like a read one,
 * and the scheduler only re-queues while `unread > 0`, so the drain also
 * removed the wake that would have retried.
 *
 * These tests pin the ordering from the outside — through a real mesh, a real
 * kernel and the real reducer — rather than asserting on the emit site, because
 * the property that matters is "the agent eventually sees it", not "the emit is
 * on line N".
 */

/** The set of message ids each turn was actually handed, oldest turn first. */
function recordMail(m: Awaited<ReturnType<typeof makeMesh>>, agentId: string, script: (turn: number) => { crash?: boolean; fail?: string; operations?: MeshOp[] }) {
  const seen: string[][] = [];
  stub(m).setScript(agentId, async (input, turn) => {
    seen.push(input.context.unreadMail.map((msg) => msg.id));
    return script(turn) as never;
  });
  return seen;
}

test("a turn that crashes before the model answers leaves its mail queued", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", interests: ["message.sent"], capabilities: [], persistent: true }],
    mayContact: { dev: [] },
  });
  try {
    const seen = recordMail(m, "dev", (turn) =>
      turn === 0 ? { crash: true, operations: [] } : { operations: [{ op: "done" } as MeshOp] },
    );
    const sent = await m.supervisor.humanSend(["dev"], "INFORM", { note: "the message that must not vanish" });
    const messageId = sent.messageId!;

    await waitFor("dev ran a second turn after the crash", () => seen.length >= 2, 10000);
    assert.ok(seen[0]!.includes(messageId), "precondition: the crashing turn was given the mail");
    assert.ok(
      seen.slice(1).some((ids) => ids.includes(messageId)),
      "the mail survived the crash and was delivered again",
    );
    await waitFor("the successful turn drained the mailbox", () => (m.kernel.state.unread.get("dev")?.length ?? 0) === 0, 8000);
  } finally {
    await m.cleanup();
  }
});

test("a runtime that answers with an error leaves its mail queued", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", interests: ["message.sent"], capabilities: [], persistent: true }],
    mayContact: { dev: [] },
  });
  try {
    // `fail` is the other shape of a lost turn: the transport worked, so no
    // exception is thrown from the adapter, but `output.error` means the model
    // produced nothing. The mail is no more read than it was in the crash.
    const seen = recordMail(m, "dev", (turn) =>
      turn === 0 ? { fail: "context window exceeded", operations: [] } : { operations: [{ op: "done" } as MeshOp] },
    );
    const sent = await m.supervisor.humanSend(["dev"], "INFORM", { note: "an errored turn is not a read turn" });
    const messageId = sent.messageId!;

    await waitFor("dev ran a second turn after the errored one", () => seen.length >= 2, 10000);
    assert.ok(
      seen.slice(1).some((ids) => ids.includes(messageId)),
      "the mail survived the errored turn and was delivered again",
    );
  } finally {
    await m.cleanup();
  }
});

test("a successful turn still drains its mailbox exactly once", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", interests: ["message.sent"], capabilities: [], persistent: true }],
    mayContact: { dev: [] },
  });
  try {
    const seen = recordMail(m, "dev", () => ({ operations: [{ op: "done" } as MeshOp] }));
    const sent = await m.supervisor.humanSend(["dev"], "INFORM", { note: "read me once" });
    const messageId = sent.messageId!;

    await waitFor("dev read its mail", () => seen.some((ids) => ids.includes(messageId)), 8000);
    await waitFor("the mailbox is empty", () => (m.kernel.state.unread.get("dev")?.length ?? 0) === 0, 8000);
    const delivered = (await m.store.read()).filter(
      (e) => e.type === "message.delivered" && (e.payload as { messageId?: string }).messageId === messageId,
    );
    assert.equal(delivered.length, 1, "deferring the emit must not duplicate it on the happy path");
  } finally {
    await m.cleanup();
  }
});

test("a permanently crashing agent stops re-reading its mailbox instead of spinning", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", interests: ["message.sent"], capabilities: [], persistent: true }],
    mayContact: { dev: [] },
    criteria: [{ id: "x", description: "x", mandatory: true }],
  });
  try {
    // Mail that is never consumed keeps `notifyTurnFinished` re-queueing the
    // seat, so the bound on the retry loop is the supervisor's restart budget,
    // not an empty mailbox. Three restarts, then the seat is SUSPENDED and
    // `requestActivation` refuses it — the mail stays queued for an operator
    // rather than being burned by a loop.
    const seen = recordMail(m, "dev", () => ({ crash: true, operations: [] }));
    await m.supervisor.humanSend(["dev"], "INFORM", { note: "nobody will ever read this" });

    await waitFor("the seat was parked after its restart budget ran out", () => m.kernel.state.agents.get("dev")?.state.lifecycle === "SUSPENDED", 20000);
    const attempts = seen.length;
    assert.ok(attempts <= 8, `the retry loop is bounded, got ${attempts} attempts`);
    assert.ok((m.kernel.state.unread.get("dev")?.length ?? 0) > 0, "the unread mail is preserved, not consumed by the failed attempts");

    // The bound has to hold, not merely have been reached once: a SUSPENDED
    // seat that kept being re-queued would still burn the mission.
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(seen.length, attempts, "no further turns were started after the seat was suspended");
  } finally {
    await m.cleanup();
  }
});

test("a turn drains only the mail it actually rendered, and the rest stays owed", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", interests: ["message.sent"], capabilities: [], persistent: true }],
    mayContact: { dev: [] },
  });
  try {
    const seen: string[][] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let turns = 0;
    stub(m).setScript("dev", async (input) => {
      seen.push(input.context.unreadMail.map((msg) => msg.id));
      // Hold the first turn open so the rest of the mail piles up behind it.
      // The turn AFTER this one is the case under test: a mailbox deeper than
      // the render cap, which is the only way to tell "delivered what it was
      // handed" apart from "delivered what was queued".
      if (turns++ === 0) await gate;
      return { operations: [{ op: "done" } as MeshOp] } as never;
    });

    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const sent = await m.supervisor.humanSend(["dev"], "INFORM", { note: `mail ${i}` });
      ids.push(sent.messageId!);
    }
    await waitFor("a backlog deeper than the render cap built up", () => (m.kernel.state.unread.get("dev")?.length ?? 0) > 12, 10000);
    release();
    await waitFor("the mailbox drained", () => (m.kernel.state.unread.get("dev")?.length ?? 0) === 0, 20000);

    const rendered = new Set(seen.flat());
    const deliveredIds = (await m.store.read())
      .filter((e) => e.type === "message.delivered")
      .map((e) => (e.payload as { messageId: string }).messageId);

    // The defect this pins: delivery used to be marked against the QUEUED set
    // (up to 100) while only `maxUnread` of it was ever rendered, so everything
    // in between was marked read without being put in front of anyone.
    for (const id of deliveredIds) {
      assert.ok(rendered.has(id), `message ${id} was marked delivered but never rendered into a prompt`);
    }
    // ...and the mail is not dropped instead. A deeper backlog costs more
    // turns, never messages.
    for (const id of ids) {
      assert.ok(rendered.has(id), `message ${id} was never shown to the agent`);
    }
    assert.ok(seen.length >= 2, "a backlog past the cap takes more than one turn to drain");
  } finally {
    await m.cleanup();
  }
});
