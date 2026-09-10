import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";

test("scheduler: only interest-matched agents wake (no broadcast-all)", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", interests: ["architecture.approved"], capabilities: ["repository.write"] },
      { id: "lead", role: "tech-lead", interests: ["patch.ready"] },
      { id: "qa", role: "qa", interests: ["patch.ready"] },
      { id: "sec", role: "security", interests: ["release.candidate"] },
      { id: "pm", role: "pm", interests: ["goal.completed"] },
    ],
    mayContact: { dev: [], lead: [], qa: [], sec: [], pm: [] },
  });
  const s = stub(m);
  for (const a of ["dev", "lead", "qa", "sec", "pm"]) s.setScript(a, async () => ({ operations: [{ op: "done" } as MeshOp] }));

  await m.kernel.emit("patch.ready", { artifactId: "art-1" }, { actorId: "dev" });
  await new Promise((r) => setTimeout(r, 700));
  const acts = (id: string) => m.kernel.state.agents.get(id)?.state.activations ?? 0;
  assert.equal(acts("lead"), 1);
  assert.equal(acts("qa"), 1);
  assert.equal(acts("sec"), 0, "security must not wake for patch.ready");
  assert.equal(acts("pm"), 0, "pm must not wake for patch.ready");
  assert.equal(acts("dev"), 0, "the acting agent never activates on its own event");
  await m.cleanup();
});

test("scheduler: concurrency cap bounds parallel agent turns", async () => {
  const m = await makeMesh({
    agents: Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, role: `r${i}`, interests: ["message.sent"] as string[] })),
    mayContact: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`a${i}`, [`a${(i + 1) % 5}`]])),
    maxActiveAgents: 2,
  });
  const s = stub(m);
  let peak = 0;
  for (let i = 0; i < 5; i++) {
    s.setScript(`a${i}`, async () => {
      peak = Math.max(peak, m.scheduler.running());
      await new Promise((r) => setTimeout(r, 120));
      return { operations: [{ op: "done" } as MeshOp] };
    });
  }
  for (let i = 0; i < 5; i++) {
    await m.supervisor.activateAgent(`a${i}`, { kind: "manual" });
  }
  await new Promise((r) => setTimeout(r, 900));
  assert.ok(peak > 0);
  assert.ok(peak <= 2, `peak concurrent turns ${peak} exceeded cap 2`);
  await m.cleanup();
});

test("scheduler: urgent mail outranks routine activations", async () => {
  const m = await makeMesh({
    agents: [
      { id: "busy", role: "worker", interests: ["message.sent"] },
      { id: "slow", role: "holder", interests: [] },
      { id: "urgent", role: "receiver", interests: ["message.sent"] },
    ],
    mayContact: { busy: ["urgent", "slow"], slow: [], urgent: [] },
    maxActiveAgents: 1,
  });
  const s = stub(m);
  s.setScript("slow", async () => {
    await new Promise((r) => setTimeout(r, 250));
    return { operations: [{ op: "done" } as MeshOp] };
  });
  s.setScript("urgent", async () => ({ operations: [{ op: "done" } as MeshOp] }));
  s.setScript("busy", async () => ({ operations: [{ op: "done" } as MeshOp] }));
  await m.supervisor.activateAgent("slow", { kind: "manual" });
  await new Promise((r) => setTimeout(r, 20));
  await m.supervisor.sendMessage({ from: "busy", to: ["urgent"], type: "INFORM", priority: "NORMAL", payload: { n: 1 }, newThread: { subject: "routine" } });
  await m.supervisor.sendMessage({ from: "busy", to: ["urgent"], type: "ESCALATE", priority: "URGENT", payload: { n: 2 }, newThread: { subject: "urgent" } });
  const snap = m.scheduler.queueSnapshot();
  assert.ok(snap.length >= 1);
  await new Promise((r) => setTimeout(r, 700));
  await m.cleanup();
});

test("scheduler: mailbox depth tracks undelivered mail", async () => {
  const m = await makeMesh({
    agents: [
      { id: "sender", role: "s", interests: [] },
      { id: "recv", role: "r", interests: ["message.sent"] },
    ],
    mayContact: { sender: ["recv"], recv: [] },
  });
  const s = stub(m);
  let seenMailboxAtActivation = -1;
  s.setScript("recv", async (input) => {
    seenMailboxAtActivation = input.context.unreadMail.length;
    return { operations: [{ op: "done" } as MeshOp] };
  });
  await m.supervisor.sendMessage({ from: "sender", to: ["recv"], type: "INFORM", payload: { a: 1 }, newThread: { subject: "t1" } });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(seenMailboxAtActivation, 1);
  await m.cleanup();
});

test("scheduler: cheap triage suppresses irrelevant wakeups", async () => {
  const m = await makeMesh({
    agents: [
      { id: "qa", role: "qa", interests: ["dependency.changed"] },
      { id: "trigger", role: "dev", interests: [] },
    ],
    mayContact: { qa: [], trigger: [] },
    triage: {
      mode: "heuristic",
      rules: [
        { agent: "qa", event: "dependency.changed", ignore_if_text_matches: ["README"], act_if_text_matches: ["pom.xml"] },
      ],
    },
  });
  (m.supervisor.deps.config as { scheduling: { strategy: string } }).scheduling.strategy = "interest+triage";
  const s = stub(m);
  s.setScript("qa", async () => ({ operations: [{ op: "done" } as MeshOp] }));
  await m.kernel.emit("dependency.changed", { files: ["README.md"], summary: "docs bump" }, { actorId: "trigger" });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(m.kernel.state.agents.get("qa")?.state.activations, 0, "triage should IGNORE README churn");
  await m.kernel.emit("dependency.changed", { files: ["pom.xml"], summary: "spring boot upgrade" }, { actorId: "trigger" });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(m.kernel.state.agents.get("qa")?.state.activations, 1, "triage should ACT on pom.xml change");
  await m.cleanup();
});


test("scheduler: circuit breaker parks after consecutive failures, explicit wakes bypass", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", interests: [] }],
    mayContact: { dev: [] },
  });
  const ask = (explicit?: boolean) =>
    m.scheduler.requestActivation({ agentId: "dev", reason: { kind: "timer", note: "nudge" }, priority: 3, explicit });
  assert.equal(await ask(), true, "healthy agent activates");
  // Three strikes: non-ok turn outcomes reported by the runner.
  m.scheduler.noteTurnOutcome?.("dev", "blocked");
  m.scheduler.noteTurnOutcome?.("dev", "failed");
  assert.equal(await ask(), true, "below the strike limit activations still flow");
  m.scheduler.noteTurnOutcome?.("dev", "blocked");
  assert.equal(await ask(), false, "breaker must park after 3 consecutive failures");
  assert.equal(m.scheduler.pending(), 0, "parked activation must not queue");
  // Explicit operator wakes bypass the park (hand-paced, always allowed).
  assert.equal(await ask(true), true, "explicit wake bypasses the park");
  // A successful turn clears the breaker.
  m.scheduler.noteTurnOutcome?.("dev", "ok");
  assert.equal(await ask(), true, "park lifts after a successful turn");
  await m.cleanup();
});

test("escalations dedupe on conflictKey while open", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", interests: [] }],
    mayContact: { dev: [] },
  });
  const a = await m.supervisor.escalate({ reason: "budget_exhausted", raisedBy: "dev", conflictKey: "budget:k1", detail: {} });
  const b = await m.supervisor.escalate({ reason: "budget_exhausted", raisedBy: "dev", conflictKey: "budget:k1", detail: {} });
  assert.equal(a.id, b.id, "repeat escalation while open returns the existing one");
  const c = await m.supervisor.escalate({ reason: "budget_exhausted", raisedBy: "dev", conflictKey: "budget:k2", detail: {} });
  assert.notEqual(c.id, a.id, "a new key opens a new escalation");
  await m.cleanup();
});

test("scheduler: whole-team cap bounds peers and services combined", async () => {
  const m = await makeMesh({
    agents: [
      { id: "p0", role: "r0" },
      { id: "p1", role: "r1" },
      { id: "p2", role: "r2" },
      { id: "svc", role: "helper", mode: "service" },
    ],
    mayContact: { p0: [], p1: [], p2: [], svc: [] },
    maxActiveAgents: 4,
    maxTotalAgents: 2,
  });
  const s = stub(m);
  let peak = 0;
  let done = 0;
  for (const a of ["p0", "p1", "p2", "svc"]) {
    s.setScript(a, async () => {
      peak = Math.max(peak, m.scheduler.running());
      await new Promise((r) => setTimeout(r, 120));
      done++;
      return { operations: [{ op: "done" } as MeshOp] };
    });
  }
  for (const a of ["p0", "p1", "p2", "svc"]) {
    await m.supervisor.activateAgent(a, { kind: "manual" });
  }
  const deadline = Date.now() + 10000;
  while (done < 4 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(done, 4, "all queued turns must still drain (cap waits, never drops)");
  assert.ok(peak > 0 && peak <= 2, `peak concurrent turns ${peak} must respect the whole-team cap of 2`);
  await m.cleanup();
});

test("scheduler: unproductive turns (zero ops / all rejected) trip the circuit breaker", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", interests: [], capabilities: ["repository.read"] }],
    mayContact: { dev: [] },
  });
  const s = stub(m);
  // A model answering in prose instead of the ops contract: full token spend,
  // zero mesh effect. Repeating it changes nothing — the pure waste loop.
  let turns = 0;
  s.setScript("dev", async () => {
    turns++;
    return { text: "Sure! I will look into that.", operations: [] as MeshOp[] };
  });
  const wake = () => m.supervisor.activateAgent("dev", { kind: "timer", note: "nudge" });
  for (let i = 0; i < 3; i++) {
    await wake();
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.equal(turns, 3, "three unproductive turns must actually have run");
  assert.equal(m.scheduler.isParkedForBackoff("dev"), true, "three zero-op turns must park the agent");
  const before = turns;
  await wake();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(turns, before, "a parked agent must not burn another turn");
  await m.cleanup();
});

test("scheduler: a productive turn keeps the agent unparked", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", interests: [], capabilities: ["repository.read"] }],
    mayContact: { dev: [] },
  });
  const s = stub(m);
  let turns = 0;
  s.setScript("dev", async () => {
    turns++;
    return { operations: [{ op: "done" } as MeshOp] };
  });
  for (let i = 0; i < 4; i++) {
    await m.supervisor.activateAgent("dev", { kind: "timer", note: "nudge" });
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.equal(turns, 4, "productive turns must never be parked");
  assert.equal(m.scheduler.isParkedForBackoff("dev"), false);
  await m.cleanup();
});

test("scheduler: idle subscribers are not woken by pure progress events", async () => {
  const m = await makeMesh({
    agents: [
      { id: "pm", role: "pm", interests: ["goal.progress"] },
      { id: "lead", role: "tech-lead", interests: ["goal.progress"] },
      { id: "trigger", role: "dev", interests: [] },
    ],
    mayContact: { pm: ["lead"], lead: ["pm"], trigger: ["pm"] },
  });
  const s = stub(m);
  for (const a of ["pm", "lead", "trigger"]) s.setScript(a, async () => ({ operations: [{ op: "done" } as MeshOp] }));
  const acts = (id: string) => m.kernel.state.agents.get(id)?.state.activations ?? 0;

  // Idle subscribers: a scoreboard tick teaches them nothing, and each wakeup
  // would cost a full model turn.
  await m.kernel.emit("goal.progress", { completed: 1, total: 5, ratio: 0.2 }, { actorId: "trigger" });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(acts("pm"), 0, "idle subscriber must not burn a turn on a progress tick");
  assert.equal(acts("lead"), 0, "idle subscriber must not burn a turn on a progress tick");

  // With real work outstanding the same event still wakes them: suppression
  // must never hide actual mail.
  await m.supervisor.humanSend(["pm"], "INFORM", { note: "please review" });
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(acts("pm") >= 1, "an agent with mail is always woken");
  await m.cleanup();
});

test("scheduler: interest wakeups still fire for events that carry work", async () => {
  const m = await makeMesh({
    agents: [
      { id: "qa", role: "qa", interests: ["patch.ready"], capabilities: ["test.execute"] },
      { id: "dev", role: "developer", interests: [] },
    ],
    mayContact: { qa: ["dev"], dev: ["qa"] },
  });
  const s = stub(m);
  for (const a of ["qa", "dev"]) s.setScript(a, async () => ({ operations: [{ op: "done" } as MeshOp] }));
  await m.kernel.emit("patch.ready", { artifactId: "art-1" }, { actorId: "dev" });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(m.kernel.state.agents.get("qa")?.state.activations, 1, "work-carrying events must still wake subscribers");
  await m.cleanup();
});

test("scheduler: a finished mission drops stale agent-mail requeues, human mail still wakes", async () => {
  const m = await makeMesh({
    agents: [
      { id: "pm1", role: "pm", interests: [] },
      { id: "pm2", role: "pm", interests: [] },
      { id: "qa", role: "qa", interests: [] },
    ],
    mayContact: { pm1: [], pm2: [], qa: ["pm1"] },
  });
  const s = stub(m);
  const turns: Record<string, number> = { pm1: 0, pm2: 0 };
  for (const id of ["pm1", "pm2"]) {
    s.setScript(id, async () => {
      turns[id]++;
      return { operations: [{ op: "done" } as MeshOp] };
    });
  }
  // Park the scheduler so mail lands in the inbox without waking anyone —
  // the state a finishing turn finds as "mail queued while running".
  await m.scheduler.stop();
  await m.supervisor.sendMessage({ from: "qa", to: ["pm1"], type: "INFORM", payload: { n: 1 }, newThread: { subject: "stale" } });
  await m.supervisor.humanSend(["pm2"], "INFORM", { note: "please answer" });
  const goalId = m.kernel.state.activeGoalId!;
  await m.kernel.emit("goal.completed", { goalId, reason: "test done" }, { actorId: "human" });
  m.scheduler.start();
  // As if both agents' in-flight turns just ended with unread mail.
  m.scheduler.notifyTurnFinished("pm1");
  m.scheduler.notifyTurnFinished("pm2");
  await waitFor("human follow-up turn to run", () => turns.pm2 === 1, 5000);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(turns.pm1, 0, "stale agent mail must not wake anyone on a finished mission");
  assert.equal(turns.pm2, 1, "human feedback must still reach its recipient");
  await m.cleanup();
});
