import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor } from "../helpers";
import type { MeshOp, AgentSession } from "../../packages/protocol/src/index";
import type { SchedulerActivationRequest } from "../../packages/core/src/ports";

/**
 * The handover turn, measured on the live run of 2026-09-25
 * (NOTES-live-run-20260925-2040.md §1, §6, §7, §12):
 *
 *  - 44 of 82 `message.delivered` fired inside handover turns, which are
 *    forbidden to answer — the successor then woke for mail no longer in its box;
 *  - a handover `done` auto-completed frontend's task with an unreviewed patch;
 *  - two cold-cache handovers re-read their whole transcript at full price (611k);
 *  - the consumed wake was put back at the same priority (median 429 s wait) and
 *    re-ran on an ask superseded meanwhile (explorer, 587k tokens);
 *  - `session.rotation_pending.sessionId` named the mesh-stable id, never the
 *    SDK session being discarded.
 */

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

function agents() {
  return [
    { id: "architect", role: "architect", capabilities: ["review.design"], interests: [] },
    { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
    { id: "qa", role: "qa", capabilities: ["repository.read"], interests: [] },
  ];
}

function liveMesh() {
  return makeMesh({
    agents: agents(),
    mayContact: { architect: ["dev", "qa"], dev: ["architect", "qa"], qa: ["architect", "dev"] },
    mode: "live",
    stallIdleMs: 600_000,
    stallCooldownMs: 600_000,
    stallNoopRetryMs: 600_000,
  });
}

function parkedMesh() {
  return makeMesh({
    agents: agents(),
    mayContact: { architect: ["dev", "qa"], dev: ["architect", "qa"], qa: ["architect", "dev"] },
    mode: "parked",
  });
}

async function quiet(m: Mesh): Promise<void> {
  await waitFor("the mesh went quiet", () => m.scheduler.pending() === 0 && m.scheduler.running() === 0);
}

const writeOp = (): MeshOp =>
  ({ op: "write_continuity", nextIntent: "finish the migration review", beliefs: [], rejected: [] }) as unknown as MeshOp;

const turnFor = (agentId: string, over: Record<string, unknown> = {}) =>
  ({
    turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`,
    agentId,
    reason: { kind: "manual" as const },
    sentOps: 0,
    publishedOps: 0,
    waitRequested: false,
    escalated: false,
    results: [],
    ...over,
  }) as never;

test("a handover turn is not shown the mailbox and marks none of it delivered; the successor gets it", async () => {
  const m = await liveMesh();
  try {
    const prompts: Array<{ text: string; handover: boolean }> = [];
    stub(m).setScript("dev", async (input) => {
      prompts.push({ text: input.instructions, handover: input.suppressRotation === true });
      stub(m).clearRotation("dev");
      return { operations: input.suppressRotation ? [writeOp(), { op: "done" } as MeshOp] : [{ op: "wait" } as MeshOp] };
    });
    stub(m).setScript("architect", async () => ({ operations: [{ op: "wait" } as MeshOp] }));
    stub(m).setScript("qa", async () => ({ operations: [{ op: "wait" } as MeshOp] }));
    stub(m).armRotation("dev");

    const sent = await m.supervisor.executeOp(
      "architect",
      { op: "send", type: "REQUEST_INFO", to: ["dev"], newThread: { subject: "schema question" }, payload: { question: "which store?" } } as MeshOp,
      turnFor("architect"),
    );
    assert.equal(sent.ok, true, `fixture: send (${sent.reason ?? ""})`);
    const messageId = sent.messageId!;

    await waitFor("dev ran its handover and its successor", () => prompts.length >= 2);
    await quiet(m);

    const [handover, successor] = prompts;
    assert.equal(handover.handover, true, "fixture: the first turn is the handover");
    assert.ok(!handover.text.includes(messageId), "a turn that may not answer must not be handed mail to answer");
    assert.match(handover.text, /1 unread message/, "the seat is told its mail is held, not that it has none");
    assert.ok(successor.text.includes(messageId), "the successor is the one that answers it");

    const delivered = (await m.store.read({ types: ["message.delivered"] })).filter((e) => (e.payload as { messageId?: string }).messageId === messageId);
    const handoverTurnIds = new Set(
      (await m.store.read({ types: ["session.rotation_pending"] })).map((e) => e.correlationId),
    );
    assert.equal(delivered.filter((e) => handoverTurnIds.has(e.correlationId)).length, 0, "no delivery inside the handover turn");
    assert.equal(delivered.length, 1, "delivered exactly once, by the successor");
  } finally {
    await m.cleanup();
  }
});

test("`done` in a handover turn does not complete the seat's task", async () => {
  const m = await parkedMesh();
  try {
    const created = await m.supervisor.executeOp("architect", { op: "create_task", title: "W6-S3 driver ui", description: "build it" } as MeshOp, turnFor("architect"));
    assert.equal(created.ok, true, `fixture: create_task (${created.reason ?? ""})`);
    const task = [...m.kernel.state.tasks.values()].find((t) => t.title === "W6-S3 driver ui")!;
    const claimed = await m.supervisor.claimTask("dev", task.id);
    assert.equal(claimed.ok, true, `fixture: claim (${claimed.reason ?? ""})`);

    const done = await m.supervisor.executeOp("dev", { op: "done", summary: "patch is unmerged; successor to request review" } as MeshOp, turnFor("dev", { handover: true }));
    assert.equal(done.ok, true, "the handover may still end its turn");
    assert.notEqual(m.kernel.state.tasks.get(task.id)?.status, "COMPLETED", "seq 1023: a continuity note is not a completion");

    await m.supervisor.executeOp("dev", { op: "done", summary: "shipped" } as MeshOp, turnFor("dev"));
    assert.equal(m.kernel.state.tasks.get(task.id)?.status, "COMPLETED", "an ordinary `done` still completes it");
  } finally {
    await m.cleanup();
  }
});

test("a recorded continuity ends the handover turn instead of spending another model call", async () => {
  const m = await liveMesh();
  try {
    const ended: string[] = [];
    (stub(m) as unknown as { endTurn: (s: AgentSession) => Promise<void> }).endTurn = async (s) => {
      ended.push(s.agentId);
    };
    stub(m).setScript("dev", async (input) => {
      stub(m).clearRotation("dev");
      return { operations: input.suppressRotation ? [writeOp()] : [{ op: "wait" } as MeshOp] };
    });
    stub(m).setScript("architect", async () => ({ operations: [{ op: "wait" } as MeshOp] }));
    stub(m).setScript("qa", async () => ({ operations: [{ op: "wait" } as MeshOp] }));
    stub(m).armRotation("dev");

    await m.supervisor.activateAgent("dev", { kind: "manual", note: "go" });
    await waitFor("the handover landed", () => m.kernel.state.continuity.has("dev"));
    await quiet(m);
    assert.deepEqual(ended, ["dev"], "the record is the whole turn: the runtime is told to end it");

    // Outside a handover the op is just a record; nothing is cut short.
    await m.supervisor.executeOp("dev", writeOp(), turnFor("dev"));
    assert.deepEqual(ended, ["dev"]);
  } finally {
    await m.cleanup();
  }
});

test("a cold-cache rotation skips the old-session handover call and records which SDK session it drops", async () => {
  const m = await liveMesh();
  try {
    const turns: Array<{ text: string; suppress: boolean }> = [];
    stub(m).setScript("dev", async (input) => {
      turns.push({ text: input.instructions, suppress: input.suppressRotation === true });
      stub(m).clearRotation("dev");
      return { operations: [{ op: "wait" } as MeshOp] };
    });
    stub(m).setScript("architect", async () => ({ operations: [{ op: "wait" } as MeshOp] }));
    stub(m).setScript("qa", async () => ({ operations: [{ op: "wait" } as MeshOp] }));
    stub(m).armRotation("dev", { transcriptTokens: 190_000, thresholdTokens: 120_000, cacheCold: true, sessionId: "sdk-cold-0248ae04" });

    await m.supervisor.activateAgent("dev", { kind: "manual", note: "review the patch" });
    await waitFor("dev ran", () => turns.length >= 1);
    await quiet(m);

    assert.equal(turns.length, 1, "no handover turn: the one turn is the work turn");
    assert.equal(turns[0].suppress, false, "the adapter must rotate on the way in");
    assert.doesNotMatch(turns[0].text, /will be replaced before your next turn/);
    const pending = (await m.store.read({ types: ["session.rotation_pending"] })).map((e) => e.payload as Record<string, unknown>);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].sessionId, "sdk-cold-0248ae04", "the transcript being discarded, as the backend names it");
    assert.equal(typeof pending[0].meshSessionId, "string");
    assert.equal(pending[0].handover, false);
  } finally {
    await m.cleanup();
  }
});

test("the warm handover names the SDK session too", async () => {
  const m = await liveMesh();
  try {
    stub(m).setScript("dev", async (input) => {
      stub(m).clearRotation("dev");
      return { operations: input.suppressRotation ? [writeOp(), { op: "done" } as MeshOp] : [{ op: "wait" } as MeshOp] };
    });
    stub(m).setScript("architect", async () => ({ operations: [{ op: "wait" } as MeshOp] }));
    stub(m).setScript("qa", async () => ({ operations: [{ op: "wait" } as MeshOp] }));
    stub(m).armRotation("dev", { transcriptTokens: 700_000, thresholdTokens: 600_000, sessionId: "sdk-5a67e4b4-next" });
    await m.supervisor.activateAgent("dev", { kind: "manual", note: "go" });
    await waitFor("the handover landed", () => m.kernel.state.continuity.has("dev"));
    await quiet(m);
    const [p] = (await m.store.read({ types: ["session.rotation_pending"] })).map((e) => e.payload as Record<string, unknown>);
    assert.equal(p.sessionId, "sdk-5a67e4b4-next");
    assert.notEqual(p.meshSessionId, p.sessionId);
    assert.equal(p.handover, true);
  } finally {
    await m.cleanup();
  }
});

test("the successor is put back at the head of the queue with the wake the handover consumed", async () => {
  const m = await liveMesh();
  try {
    const reasons: string[] = [];
    stub(m).setScript("dev", async (input) => {
      reasons.push(input.activation.note ?? input.activation.kind);
      stub(m).clearRotation("dev");
      return { operations: input.suppressRotation ? [writeOp(), { op: "done" } as MeshOp] : [{ op: "wait" } as MeshOp] };
    });
    stub(m).setScript("architect", async () => ({ operations: [{ op: "wait" } as MeshOp] }));
    stub(m).setScript("qa", async () => ({ operations: [{ op: "wait" } as MeshOp] }));
    stub(m).armRotation("dev");

    const requests: SchedulerActivationRequest[] = [];
    const sched = m.scheduler as unknown as { requestActivation: (r: SchedulerActivationRequest) => Promise<boolean> };
    const original = sched.requestActivation.bind(m.scheduler);
    sched.requestActivation = (r) => {
      requests.push(r);
      return original(r);
    };

    await m.supervisor.activateAgent("dev", { kind: "manual", note: "review the patch" });
    await waitFor("dev ran twice", () => reasons.length >= 2);
    await quiet(m);

    assert.deepEqual(reasons.slice(0, 2), ["review the patch", "review the patch"]);
    const forPatch = requests.filter((r) => r.agentId === "dev" && r.reason.note === "review the patch");
    assert.ok(forPatch.length >= 2, "fixture: the original wake and its re-queue");
    // Above URGENT (9): the slot was spent on the mesh's own bookkeeping, so the
    // seat resumes where it was rather than re-joining the back of the queue.
    const top = Math.max(...forPatch.slice(1).map((r) => r.priority));
    assert.ok(top >= 10, `re-queued at ${top}, which waits behind every URGENT and HIGH in the mesh`);
  } finally {
    await m.cleanup();
  }
});

test("a wake whose ask closed during the handover is dropped, not re-run", async () => {
  const m = await liveMesh();
  try {
    let devTurns = 0;
    const ask = await m.supervisor.executeOp(
      "architect",
      { op: "send", type: "REQUEST_INFO", to: ["qa"], newThread: { subject: "Review ApiSpec v1" }, payload: { question: "does v1 hold?" } } as MeshOp,
      turnFor("architect"),
    );
    assert.equal(ask.ok, true, `fixture: ask (${ask.reason ?? ""})`);
    const askId = ask.messageId!;
    // The measured shape: explorer was interest-woken by a `design.question` for
    // a review ask that v2 superseded while it was busy handing over.
    const evt = await m.kernel.emit("design.question", { artifactId: "art-x", question: "does v1 hold?", messageId: askId }, { actorId: "architect" });

    stub(m).setScript("dev", async (input) => {
      devTurns++;
      if (input.suppressRotation) {
        stub(m).clearRotation("dev");
        const w = await m.supervisor.executeOp("architect", { op: "withdraw", messageId: askId, reason: "superseded by v2" } as MeshOp, turnFor("architect"));
        assert.equal(w.ok, true, `fixture: withdraw (${w.reason ?? ""})`);
        return { operations: [writeOp(), { op: "done" } as MeshOp] };
      }
      return { operations: [{ op: "wait" } as MeshOp] };
    });
    stub(m).setScript("architect", async () => ({ operations: [{ op: "wait" } as MeshOp] }));
    stub(m).setScript("qa", async () => ({ operations: [{ op: "wait" } as MeshOp] }));
    stub(m).armRotation("dev");

    await m.supervisor.activateAgent("dev", { kind: "interest_event", eventId: evt.id, eventType: "design.question" });
    await waitFor("the handover landed", () => m.kernel.state.continuity.has("dev"));
    await quiet(m);
    await new Promise((r) => setTimeout(r, 100));
    await quiet(m);
    assert.equal(devTurns, 1, "the ask that woke the seat is closed: the successor has nothing to do for it");
  } finally {
    await m.cleanup();
  }
});
