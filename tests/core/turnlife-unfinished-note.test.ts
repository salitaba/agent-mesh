import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, collectEvents, type AgentSpec } from "../helpers";
import { FakeWorkspace, installWorkspace, untrackedState } from "../support/fake-workspace";
import { abnormalTurnNote, newTurnEffectTally, noteTurnEffect } from "../../packages/core/src/turn-tracker";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * The successor of a turn that did not finish gets an account built from FACTS.
 *
 * Measured 2026-09-25 (NOTES live-run §3): backend's timed-out turn had claimed
 * its task and left 21 untracked files in its worktree. The advisory it was
 * handed was a fixed template that mentioned neither, told it to read fewer files
 * (it had been writing them), and to "close with an ops block" — a channel that
 * no longer exists. It never reached the successor anyway: that turn was woken
 * for something else and its one memory slot went to a stale handoff.
 */

const AGENTS: AgentSpec[] = [
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "git.commit"], interests: [], tokens: 500_000 },
  { id: "pm", role: "pm", capabilities: ["repository.read"], interests: [] },
];

const DIRTY = ["src/store.ts", "src/index.ts", ".mesh/agents/dev/ROLE.md", ".mesh/agents/dev/MESH_CONTEXT.md"];

test("the successor is told what survived: the claim, the mail, the uncommitted files", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: { dev: ["pm"], pm: ["dev"] }, autoRaise: { enabled: false }, turnTimeoutMs: 250 });
  const ws = new FakeWorkspace({ behaviour: { worktreeState: { dev: untrackedState("dev", DIRTY) } } });
  installWorkspace(m, ws);
  try {
    stub(m).setScript("pm", async () => ({ operations: [{ op: "wait" } as MeshOp] }));
    let taskId = "";
    const seen: string[] = [];
    stub(m).setScript("dev", async (input, idx) => {
      if (idx === 0) {
        const created = await m.supervisor.executeToolOp("dev", { op: "create_task", title: "build the store", description: "write it", assignedTo: "dev" } as MeshOp);
        taskId = String(created.taskId);
        await m.supervisor.executeToolOp("dev", { op: "claim_task", taskId } as MeshOp);
        const sent = await m.supervisor.executeToolOp("dev", { op: "send", type: "INFORM", to: ["pm"], newThread: { subject: "status" }, payload: { note: "on it" } } as MeshOp);
        assert.equal(sent.ok, true, `fixture: the message was sent: ${JSON.stringify(sent)}`);
        return { delayMs: 60_000, interruptUsage: { input: 900, output: 100, total: 1000 } };
      }
      seen.push(input.instructions);
      return { operations: [{ op: "wait" } as MeshOp] };
    });
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the successor turn", () => seen.length > 0, 15_000);

    const prompt = seen[0]!;
    const note = prompt.slice(prompt.indexOf("your previous turn did not finish"));
    assert.ok(prompt.includes("your previous turn did not finish"), "the note reaches the successor's prompt");
    assert.match(note, new RegExp(`claimed \\(${taskId}\\)`), "the claim it made is named — it is durable");
    assert.match(note, /1 message sent/, "and the mail it sent");
    assert.match(note, /src\/store\.ts/, "the files it wrote are named");
    assert.doesNotMatch(note, /\.mesh\/agents/, "runtime-owned files are not the seat's work");
    assert.match(note, /2 file\(s\)/, "and counted without them");
    assert.match(note, new RegExp(`You still hold task ${taskId}`));
    assert.match(note, /`commit`/, "a seat that can commit is told to");
    assert.doesNotMatch(note, /ops block/, "the ops-block channel does not exist any more");
    assert.doesNotMatch(note, /fewer files/, "it was writing, not reading");
    assert.match(note, /mesh_done/, "the turn ends with the tool that exists");

    // The seat's own durable record says the same thing.
    const memo = (await collectEvents(m))
      .filter((e) => e.type === "memory.updated")
      .map((e) => (e.payload as { note?: { key?: string; value?: string } }).note)
      .find((n) => n?.key?.startsWith("turn:") && n.value?.includes("did not finish"));
    assert.ok(memo?.value?.includes(taskId), "the memory note carries the same facts");
  } finally {
    await m.cleanup();
  }
});

test("the note rides the prompt outside the tiered bundle, and only until a turn has read it", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: { dev: ["pm"], pm: ["dev"] }, autoRaise: { enabled: false }, turnTimeoutMs: 250 });
  try {
    stub(m).setScript("pm", async () => ({ operations: [{ op: "wait" } as MeshOp] }));
    const seen: string[] = [];
    stub(m).setScript("dev", async (input, idx) => {
      if (idx === 0) return { delayMs: 60_000, interruptUsage: { input: 9, output: 1, total: 10 } };
      seen.push(input.instructions);
      return { operations: [{ op: "wait" } as MeshOp] };
    });
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the successor turn", () => seen.length > 0, 15_000);
    // Its own section, not a memory item: the memory slot is capped per tier and
    // an agent-authored note outranks every auto note.
    assert.match(seen[0]!, /## Your previous turn did not finish\n⚠ your previous turn did not finish/);
    assert.match(seen[0]!, /Nothing it did reached the mesh/, "nothing landed, and the note says so rather than implying otherwise");

    await waitFor("dev settles", () => !m.supervisor.isTurnInFlight("dev"));
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("a third turn", () => seen.length > 1, 10_000);
    assert.doesNotMatch(seen[1]!, /## Your previous turn did not finish/, "a turn that read it has consumed it");
  } finally {
    await m.cleanup();
  }
});

test("the note's wording follows the facts", () => {
  const landed = newTurnEffectTally();
  noteTurnEffect(landed, { type: "task.claimed", payload: { taskId: "task-1", agentId: "dev" }, actorId: "dev" });
  noteTurnEffect(landed, { type: "task.claimed", payload: { taskId: "task-1", agentId: null }, actorId: "recovery-manager" });
  const withWork = abnormalTurnNote({ reason: "timeout", tokens: 5 }, 1_200_000, {
    landed,
    uncommitted: { files: ["a.ts"], untracked: 1 },
    canCommit: false,
  });
  assert.match(withWork, /1 task claimed \(task-1\)/, "a release is not a claim");
  assert.match(withWork, /continue from what survived/);
  assert.doesNotMatch(withWork, /`commit`/, "a seat without git.commit is not told to do what it cannot");
  assert.match(withWork, /DO NOT simply retry/);

  const nothing = abnormalTurnNote({ reason: "silence" }, 60_000, { landed: newTurnEffectTally() });
  assert.match(nothing, /Nothing it did reached the mesh\./);
  assert.match(nothing, /make this turn SMALLER/);
  assert.match(nothing, /spend unmeasured/);
});

test("a figure that is only what the stream had reached is said to be a lower bound, and a reported one is not", () => {
  // The turn the twentieth run's shutdown cut: its backend gave no usage, its stream had reached 24,497 tokens.
  const streamed = abnormalTurnNote({ reason: "interrupted", detail: "stopped by the mesh shutting down after the mission ended (x)", tokens: 24_497, partial: true }, 59_000);
  assert.match(streamed, /after 59s having spent at least 24497 tokens\./);
  const reported = abnormalTurnNote({ reason: "timeout", tokens: 24_497 }, 59_000);
  assert.match(reported, /having spent 24497 tokens\./);
  assert.doesNotMatch(reported, /at least/, "a figure the stopped call reported is the figure, not a floor");
  assert.match(abnormalTurnNote({ reason: "failed" }, 59_000), /\(spend unmeasured\)/, "and no figure at all is still not zero");
});
