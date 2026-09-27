import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * §8 of the 2026-09-25 live run: a reply identified by `replyTo` was denied as
 * "initiating contact".
 *
 * seq 217: ux-designer `mesh_send` to marketing with `replyTo:` marketing's own
 * review ask and no `threadId`, refused because the contact matrix forbids
 * ux-designer from initiating contact with marketing — while the refusal itself
 * said "replies inside existing threads are always allowed". `sendMessage` ran
 * the policy check on `input.threadId ?? ""` before resolving any thread, and
 * the reply exemption only looks at the thread.
 */

const AGENTS = [
  { id: "marketing", role: "marketing", capabilities: ["repository.read"], interests: [] },
  { id: "ux", role: "ux-designer", capabilities: ["repository.read"], interests: [] },
];
// marketing may reach ux; ux may reach nobody on its own initiative.
const COMM = { marketing: ["ux"], ux: [] as string[] };

const turnFor = (agentId: string) =>
  ({
    turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`,
    agentId,
    reason: { kind: "manual" as const },
    sentOps: 0,
    publishedOps: 0,
    waitRequested: false,
    escalated: false,
    results: [],
  }) as never;

test("comms: a send that names what it replies to is judged as a reply, and lands in that thread", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" } as never);
  try {
    const ask = await m.supervisor.sendMessage({ from: "marketing", to: ["ux"], type: "REQUEST_INFO", newThread: { subject: "launch copy" }, payload: { question: "does the hero read?" } });
    assert.equal(ask.accepted, true, ask.reason);
    const askThread = m.kernel.state.messages.get(ask.messageId!)!.threadId;

    // No threadId — only replyTo, exactly as the live send.
    const reply = await m.supervisor.executeOp(
      "ux",
      { op: "send", type: "INFORM", to: ["marketing"], replyTo: ask.messageId, payload: { answer: "it reads" } } as MeshOp,
      turnFor("ux"),
    );

    assert.equal(reply.ok, true, `a reply must not be refused as initiating contact: ${reply.reason}`);
    const sent = m.kernel.state.messages.get(reply.messageId!)!;
    assert.equal(sent.threadId, askThread, "a reply belongs to the thread of the message it answers");
    assert.equal(m.kernel.state.pendingRequests.has(ask.messageId!), false, "and it settles the ask it names");
  } finally {
    await m.cleanup();
  }
});

test("comms: the reply exemption is not a way round the matrix — a fresh send is still refused", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" } as never);
  try {
    const cold = await m.supervisor.executeOp(
      "ux",
      { op: "send", type: "INFORM", to: ["marketing"], newThread: { subject: "unprompted" }, payload: { note: "hello" } } as MeshOp,
      turnFor("ux"),
    );
    assert.equal(cold.ok, false, "no conversation to reply in, so this IS initiating contact");
    assert.match(String(cold.reason), /initiating contact/);
  } finally {
    await m.cleanup();
  }
});
