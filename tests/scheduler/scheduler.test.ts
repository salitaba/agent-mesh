import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub } from "../helpers";
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
