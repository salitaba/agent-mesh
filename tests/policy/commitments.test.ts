import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, eventTypes } from "../helpers";
import { createInitialState } from "../../packages/core/src/state";
import { applyEvent } from "../../packages/core/src/projections";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * The commitment ledger. An outstanding ask is a debt with a named debtor,
 * and it leaves the ledger exactly one way: an event. Before this existed,
 * eight scattered `pendingRequests.delete(...)` calls closed asks — four of
 * them outside the reducer, so replay rebuilt asks the live mesh had already
 * closed and the "replay is equivalent" invariant silently did not hold.
 */

async function twoAgentMesh(opts?: { strict?: boolean }) {
  return makeMesh({
    agents: [
      { id: "architect", role: "architect", capabilities: ["review.design"], interests: [] },
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
    ],
    mayContact: { architect: ["dev"], dev: ["architect"] },
    mode: "parked",
    ...(opts?.strict ? { bus: { commitments: { semantic: "strict" as const } } } : {}),
  });
}

function replayed(m: Awaited<ReturnType<typeof twoAgentMesh>>, events: Awaited<ReturnType<typeof m.store.read>>) {
  const fresh = createInitialState();
  for (const e of events) {
    applyEvent(fresh, e, {
      transitionGates: m.config.transitionGates,
      commitmentSemantic: m.config.bus.commitmentSemantic,
    });
  }
  return fresh;
}

test("commitments: replyTo is recorded as an exact discharge, not a guess", async () => {
  const m = await twoAgentMesh();
  const ask = await m.supervisor.sendMessage({
    from: "architect", to: ["dev"], type: "REQUEST",
    newThread: { subject: "which db?" }, payload: { q: "which db?" },
  });
  const threadId = m.kernel.state.messages.get(ask.messageId!)!.threadId;
  await m.supervisor.sendMessage({
    from: "dev", to: ["architect"], type: "INFORM", threadId,
    replyTo: ask.messageId, payload: { answer: "postgres" },
  });

  const rec = m.kernel.state.discharged.find((d) => d.messageId === ask.messageId);
  assert.equal(rec?.reason, "reply", "an explicit replyTo must never be recorded as inference");
  assert.equal(rec?.by, "dev");
  assert.equal(m.supervisor.commitmentStats().inferred, 0, "nothing was guessed");
  await m.cleanup();
});

test("commitments: an inferred discharge is labelled as inferred", async () => {
  const m = await twoAgentMesh();
  const ask = await m.supervisor.sendMessage({
    from: "architect", to: ["dev"], type: "REQUEST",
    newThread: { subject: "which db?" }, payload: { q: "which db?" },
  });
  const threadId = m.kernel.state.messages.get(ask.messageId!)!.threadId;
  // No replyTo: the runtime must guess from thread + addressee.
  await m.supervisor.sendMessage({
    from: "dev", to: ["architect"], type: "INFORM", threadId, payload: { answer: "postgres" },
  });

  const rec = m.kernel.state.discharged.find((d) => d.messageId === ask.messageId);
  assert.equal(rec?.reason, "in_thread");
  const stats = m.supervisor.commitmentStats();
  assert.equal(stats.inferred, 1, "guessed discharges must be counted");
  assert.equal(stats.inferredRatio, 1);
  assert.equal(stats.open, 0);
  await m.cleanup();
});

test("commitments: superseding an artifact is event-sourced, so replay agrees with live", async () => {
  const m = await twoAgentMesh();
  const art = await m.supervisor.createArtifact({ actorId: "dev", name: "patch", type: "CodePatch", content: "v1" });
  if (!("artifact" in art)) throw new Error("artifact failed");
  await m.supervisor.sendMessage({
    from: "architect", to: ["dev"], type: "REQUEST_REVIEW",
    newThread: { subject: "review v1" }, artifactRefs: [{ uri: art.uri }], payload: {},
  });
  assert.equal(m.kernel.state.pendingRequests.size, 1);

  await m.supervisor.createArtifact({
    actorId: "dev", name: "patch", type: "CodePatch", content: "v2", asVersionOf: art.artifact.id,
  });

  assert.equal(m.kernel.state.pendingRequests.size, 0, "the stale review ask is superseded");
  const events = await m.store.read();
  assert.ok(eventTypes(events).includes("commitment.discharged"), "the discharge must be in the log");
  assert.equal(
    replayed(m, events).pendingRequests.size,
    m.kernel.state.pendingRequests.size,
    "replayed state must equal live state — a direct delete here was invisible to replay",
  );
  await m.cleanup();
});

test("commitments: an operator answer and a drop both survive replay", async () => {
  for (const action of ["answer", "drop"] as const) {
    const m = await twoAgentMesh();
    const ask = await m.supervisor.sendMessage({
      from: "architect", to: ["dev"], type: "REQUEST",
      newThread: { subject: "stuck ask" }, payload: { q: "?" },
    });
    await m.supervisor.escalateStuckRequest("dev", ask.messageId!);
    const esc = [...m.kernel.state.escalations.values()].find((e) => e.reason === "stalemate:unanswered_request")!;
    assert.ok(esc, "the stuck request must have escalated");

    const res = action === "answer"
      ? await m.supervisor.answerStuckRequest(esc.id, "use postgres")
      : await m.supervisor.dropStuckRequest(esc.id, "no longer relevant");
    assert.equal(res.ok, true, res.reason);

    assert.equal(m.kernel.state.pendingRequests.has(ask.messageId!), false, `${action} must close the ask`);
    const events = await m.store.read();
    assert.equal(
      replayed(m, events).pendingRequests.has(ask.messageId!),
      false,
      `operator ${action} must survive replay (it used to mutate state directly)`,
    );
    await m.cleanup();
  }
});

test("commitments: an agent can decline a request instead of stalling silently", async () => {
  const m = await twoAgentMesh();
  const ask = await m.supervisor.sendMessage({
    from: "architect", to: ["dev"], type: "REQUEST",
    newThread: { subject: "please do security review" }, payload: { q: "review?" },
  });
  const turn = {
    turnId: "t1", agentId: "dev", reason: { kind: "manual" as const },
    sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [],
  } as never;

  // Only the debtor may close its own debt.
  const wrong = await m.supervisor.executeOp("architect", { op: "discharge", messageId: ask.messageId!, reason: "nope" }, turn);
  assert.equal(wrong.ok, false, "an agent must not silence a question asked of someone else");

  const res = await m.supervisor.executeOp("dev", { op: "discharge", messageId: ask.messageId!, reason: "security review is not mine — ask security" }, turn);
  assert.equal(res.ok, true, res.reason);
  assert.equal(m.kernel.state.pendingRequests.has(ask.messageId!), false, "declining closes the ask");

  // The asker must be told, or it waits on an answer that will never come.
  const notice = [...m.kernel.state.messages.values()].find((x) => x.from === "dev" && (x.payload as Record<string, unknown>)?.declined === true);
  assert.ok(notice, "the asker must receive a decline notice");
  assert.ok(notice!.to.includes("architect"));
  assert.match(String((notice!.payload as Record<string, unknown>).reason), /not mine/);

  // Declining is exact, not inference.
  assert.equal(m.kernel.state.discharged.find((d) => d.messageId === ask.messageId)?.reason, "reply");
  assert.equal(
    replayed(m, await m.store.read()).pendingRequests.has(ask.messageId!),
    false,
    "the decline must survive replay",
  );
  await m.cleanup();
});

test("commitments: discharging an unknown or already-closed ask fails cleanly", async () => {
  const m = await twoAgentMesh();
  const turn = {
    turnId: "t1", agentId: "dev", reason: { kind: "manual" as const },
    sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [],
  } as never;
  const res = await m.supervisor.executeOp("dev", { op: "discharge", messageId: "msg-does-not-exist", reason: "x" }, turn);
  assert.equal(res.ok, false);
  assert.match(res.reason ?? "", /no outstanding request/);
  await m.cleanup();
});

test("commitments: a declined request stops nudging instead of escalating a false stalemate", async () => {
  const m = await makeMesh({
    agents: [
      { id: "asker", role: "architect", capabilities: ["review.design"], interests: [] },
      { id: "decliner", role: "developer", capabilities: ["repository.write"], interests: [] },
    ],
    mayContact: { asker: ["decliner"], decliner: ["asker"] },
    waitWakeupMs: 60,
  });
  const s = stub(m);
  s.setScript("asker", async (_i, t) =>
    t === 0
      ? { operations: [{ op: "send", type: "REQUEST_REVIEW", to: ["decliner"], newThread: { subject: "review" }, payload: {} }, { op: "wait" }] as MeshOp[] }
      : { operations: [{ op: "done" } as MeshOp] });
  // The decliner closes the ask on its first wake rather than going silent.
  s.setScript("decliner", async () => {
    const open = [...m.kernel.state.pendingRequests.values()].find((pr) => pr.to.includes("decliner"));
    return {
      operations: open
        ? ([{ op: "discharge", messageId: open.messageId, reason: "out of scope for me" }] as MeshOp[])
        : ([{ op: "done" }] as MeshOp[]),
    };
  });

  await m.supervisor.activateAgent("asker", { kind: "manual" });
  await waitFor("ask discharged", () => m.kernel.state.pendingRequests.size === 0, 8000);
  // Give the nudge timer several windows to (wrongly) fire.
  await new Promise((r) => setTimeout(r, 600));
  const stalemates = [...m.kernel.state.escalations.values()].filter((e) => e.reason === "stalemate:unanswered_request");
  assert.equal(stalemates.length, 0, "a declined request is answered business, not a stalemate for a human");
  await m.cleanup();
});

test("commitments/strict: inference is off — a reply-looking message discharges nothing", async () => {
  const m = await twoAgentMesh({ strict: true });
  assert.equal(m.config.bus.commitmentSemantic, "strict", "fixture must run strict");
  const ask = await m.supervisor.sendMessage({
    from: "architect", to: ["dev"], type: "REQUEST",
    newThread: { subject: "which db?" }, payload: { q: "which db?" },
  });
  const threadId = m.kernel.state.messages.get(ask.messageId!)!.threadId;
  // Same shape that compat would infer as an answer: in-thread INFORM to the asker.
  await m.supervisor.sendMessage({ from: "dev", to: ["architect"], type: "INFORM", threadId, payload: { answer: "postgres" } });
  assert.equal(m.kernel.state.pendingRequests.has(ask.messageId!), true, "strict: no replyTo, no discharge");
  // The exact signal still works.
  await m.supervisor.sendMessage({
    from: "dev", to: ["architect"], type: "INFORM", threadId,
    replyTo: ask.messageId, payload: { answer: "postgres" },
  });
  assert.equal(m.kernel.state.pendingRequests.has(ask.messageId!), false, "strict honors replyTo");
  assert.equal(m.supervisor.commitmentStats().inferred, 0, "strict must never record an inferred discharge");
  await m.cleanup();
});

test("commitments/strict: worker-result contract survives strict mode", async () => {
  const m = await makeMesh({
    agents: [
      { id: "lead", role: "tech-lead", capabilities: ["task.assign"], interests: [] },
      { id: "worker", role: "developer", capabilities: ["repository.write"], interests: [] },
    ],
    mayContact: { lead: ["worker"], worker: ["lead"] },
    mode: "parked",
    bus: { commitments: { semantic: "strict" } },
  });
  const opened = await m.supervisor.sendMessage({
    from: "lead", to: ["worker"], type: "REQUEST_EXECUTION",
    newThread: { subject: "do the thing" }, payload: {}, taskId: "task-1",
  });
  // Fresh thread, parent never on the recipient list — the defining shape.
  await m.supervisor.sendMessage({
    from: "worker", to: ["lead"], type: "HANDOFF",
    newThread: { subject: "done" }, payload: { result: "ok" }, taskId: "task-1",
  });
  assert.equal(m.kernel.state.pendingRequests.has(opened.messageId!), false, "worker HANDOFF must discharge in strict mode");
  await m.cleanup();
});

test("commitments/strict: review verdict still discharges the review ask", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "lead", role: "tech-lead", capabilities: ["code.review", "review.design"], authority: ["implementation.approve", "architecture.approve"], interests: [] },
    ],
    mayContact: { dev: ["lead"], lead: ["dev"] },
    mode: "parked",
    bus: { commitments: { semantic: "strict" } },
  });
  const art = await m.supervisor.createArtifact({ actorId: "dev", name: "patch", type: "CodePatch", content: "diff" });
  if (!("artifact" in art)) throw new Error("artifact failed");
  const ask = await m.supervisor.sendMessage({
    from: "dev", to: ["lead"], type: "REQUEST_REVIEW",
    newThread: { subject: "review it" }, artifactRefs: [{ uri: art.uri }], payload: {},
  });
  assert.equal(m.kernel.state.pendingRequests.has(ask.messageId!), true);
  const res = await m.supervisor.recordDecision("lead", "approve", "implementation", art.artifact.id, "looks good");
  assert.equal(res.ok, true, res.reason);
  assert.equal(m.kernel.state.pendingRequests.has(ask.messageId!), false, "the review verdict discharges the ask in strict mode");
  await m.cleanup();
});

test("commitments/strict: replay agrees with live under strict semantics", async () => {
  const m = await twoAgentMesh({ strict: true });
  const ask = await m.supervisor.sendMessage({
    from: "architect", to: ["dev"], type: "REQUEST",
    newThread: { subject: "replay check" }, payload: {},
  });
  const threadId = m.kernel.state.messages.get(ask.messageId!)!.threadId;
  await m.supervisor.sendMessage({ from: "dev", to: ["architect"], type: "INFORM", threadId, payload: { maybe: "an answer" } });
  const events = await m.store.read();
  const live = m.kernel.state.pendingRequests.size;
  assert.equal(live, 1, "strict keeps the ask open");
  // Replay under the SAME semantic must agree; default replay must ALSO agree
  // with default live (covered elsewhere) — the point is semantic parity.
  assert.equal(replayed(m, events).pendingRequests.size, live, "strict replay must agree with strict live");
  await m.cleanup();
});

test("commitments/strict: full strict mission converges end-to-end", async () => {
  const m = await makeMesh({
    agents: [
      { id: "pm", role: "pm", authority: ["requirements.accept"], capabilities: ["repository.read"], interests: [] },
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
    ],
    mayContact: { pm: ["dev"], dev: ["pm"] },
    startup: ["pm"],
    bus: { commitments: { semantic: "strict" } },
    criteria: [{ id: "requirements-documented", description: "reqs exist", mandatory: true }],
  });
  const s = stub(m);
  // pm publishes requirements, asks dev with REQUEST, then accepts on the
  // dev's replyTo-bearing response. Everything exact — strict-compatible.
  s.setScript("pm", async (_i, turn) => {
    if (turn === 0) {
      return {
        operations: [
          { op: "publish_artifact", name: "reqs", type: "RequirementsDoc", content: JSON.stringify([{ id: "r1", text: "ship it", mandatory: true }]) },
          { op: "send", type: "REQUEST", to: ["dev"], newThread: { subject: "confirm" }, payload: { q: "ack?" } },
          { op: "wait" },
        ] as MeshOp[],
      };
    }
    const open = [...m.kernel.state.pendingRequests.values()].find((pr) => pr.from === "pm");
    const art = [...m.kernel.state.artifacts.values()].find((a) => a.type === "RequirementsDoc");
    if (open) {
      // dev answered without replyTo (prose habit) — pm must re-ask by
      // discharging nothing and waiting; dev's proper replyTo lands next turn.
      return { operations: [{ op: "wait" }] as MeshOp[] };
    }
    if (art) {
      // The RequirementsDoc body mints its own criterion (r1) on top of the
      // configured one — accept BOTH or the goal can never complete.
      return {
        operations: [
          { op: "approve", subject: `criterion:requirements-documented`, artifactId: art.id, comment: "acked" },
          { op: "approve", subject: `criterion:r1`, artifactId: art.id, comment: "acked" },
        ] as MeshOp[],
      };
    }
    return { operations: [{ op: "done" }] as MeshOp[] };
  });
  s.setScript("dev", async () => {
    const open = [...m.kernel.state.pendingRequests.values()].find((pr) => pr.to.includes("dev"));
    if (!open) return { operations: [{ op: "done" }] as MeshOp[] };
    return {
      operations: [{
        op: "respond", messageId: open.messageId, type: "INFORM",
        payload: { answer: "acked" },
      }] as MeshOp[],
    };
  });
  await waitFor("strict mission completes", () => m.kernel.state.goals.get(m.kernel.state.activeGoalId!)?.status === "COMPLETED", 15000);
  assert.equal(m.supervisor.commitmentStats().inferred, 0, "a strict mission must close every ask exactly");
  await m.cleanup();
});

test("transport/typed-only: parsed prose ops are refused, typed ops execute", async () => {
  const base = {
    agents: [{ id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] as string[] }],
    mayContact: { dev: [] as string[] },
  };
  // Default (mixed): prose-parsed ops execute as before.
  const m = await makeMesh({ ...base, mode: "parked" });
  const s = stub(m);
  s.setScript("dev", async () => ({
    operations: [{ op: "publish_artifact", name: "x", type: "ADR", content: "prose-parsed" } as MeshOp],
  }));
  await m.supervisor.activateAgent("dev", { kind: "manual" });
  await waitFor("mixed turn ran", () => m.supervisor.isIdle(), 8000);
  assert.equal(m.kernel.state.artifacts.size, 1, "mixed mode executes parsed ops");
  await m.cleanup();

  // Typed-only: the identical turn is refused visibly, nothing lands.
  const t = await makeMesh({ ...base, mode: "parked", bus: { transport: "typed-only" } });
  assert.equal(t.config.bus.transport, "typed-only", "fixture must run typed-only");
  const ts = stub(t);
  ts.setScript("dev", async () => ({
    operations: [{ op: "publish_artifact", name: "x", type: "ADR", content: "prose-parsed" } as MeshOp],
  }));
  await t.supervisor.activateAgent("dev", { kind: "manual" });
  await waitFor("typed-only turn ran", () => t.supervisor.isIdle(), 8000);
  assert.equal(t.kernel.state.artifacts.size, 0, "typed-only refuses prose-parsed ops");
  const trace = t.supervisor.getRecentTurns(5).find((x) => x.agentId === "dev")!;
  assert.match(trace.summary ?? "", /typed-only/, "the refusal must be visible in the turn summary");
  assert.ok(!trace.ops || trace.ops.length === 0, "no refused op may appear executed");
  assert.equal(t.scheduler.isParkedForBackoff("dev"), false, "one refusal parks nothing");
  await t.cleanup();
});

test("transport/typed-only: typed (MCP) ops still execute", async () => {
  const t = await makeMesh({
    agents: [{ id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] }],
    mayContact: { dev: [] },
    mode: "parked",
    bus: { transport: "typed-only" },
  });
  const ts = stub(t);
  ts.setScript("dev", async () => ({
    typedOps: true,
    toolCalls: [{ name: "mesh_artifact_publish", args: {}, resultDigest: "d" }],
    operations: [{ op: "publish_artifact", name: "x", type: "ADR", content: "via typed tool" } as MeshOp],
  }));
  await t.supervisor.activateAgent("dev", { kind: "manual" });
  await waitFor("typed turn ran", () => t.supervisor.isIdle(), 8000);
  assert.equal(t.kernel.state.artifacts.size, 1, "typed ops execute under typed-only");
  await t.cleanup();
});

test("transport/typed-only: three prose turns in a row park the agent", async () => {
  const t = await makeMesh({
    agents: [{ id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] }],
    mayContact: { dev: [] },
    bus: { transport: "typed-only" },
  });
  const ts = stub(t);
  let turns = 0;
  ts.setScript("dev", async () => {
    turns++;
    return { operations: [{ op: "done" } as MeshOp] }; // prose-parsed, no typedOps flag
  });
  for (let i = 0; i < 3; i++) {
    await t.supervisor.activateAgent("dev", { kind: "manual" });
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(turns, 3, "three turns must have run");
  assert.equal(t.scheduler.isParkedForBackoff("dev"), true, "prose under typed-only parks after 3 strikes");
  await t.cleanup();
});

test("commitments: /status exposes ledger health so inference is measurable", async () => {
  const { createHttpServer } = await import("../../apps/mesh-server/src/index");
  const m = await twoAgentMesh();
  const server = createHttpServer(m, { dashboardDir: undefined });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const ask = await m.supervisor.sendMessage({
      from: "architect", to: ["dev"], type: "REQUEST",
      newThread: { subject: "open ask" }, payload: {},
    });
    type StatusShape = { commitments: { open: number; inferredRatio: number; oldestOpenAgeMs: number | null } };
    let res = await (await fetch(`${base}/status`)).json() as StatusShape;
    assert.equal(res.commitments.open, 1, "an outstanding ask is visible");
    assert.ok(res.commitments.oldestOpenAgeMs !== null, "age of the oldest open ask is reported");

    const threadId = m.kernel.state.messages.get(ask.messageId!)!.threadId;
    // Answered by inference (no replyTo): the ratio must show the guess.
    await m.supervisor.sendMessage({ from: "dev", to: ["architect"], type: "INFORM", threadId, payload: {} });
    res = await (await fetch(`${base}/status`)).json() as StatusShape;
    assert.equal(res.commitments.open, 0);
    assert.equal(res.commitments.inferredRatio, 1, "a mesh running entirely on inference must say so");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await m.cleanup();
  }
});
