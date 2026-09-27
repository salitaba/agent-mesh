import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { createMcpToolset } from "../../apps/mesh-server/src/mcp";
import { mintSeatToken } from "../../packages/core/src/seat-token";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * §4 of the 2026-09-25 live run: the "verdict by message" rule fired AFTER the
 * verdict op had already landed.
 *
 * 10 `verdict.message-only` denials; 7 came after the same seat's op had
 * recorded the verdict — seats `mesh_approve` and then `mesh_respond
 * type:APPROVE` to close the review ask — and each was told "no signature was
 * recorded" (false) and woken to sign again. The remedy also went to seats that
 * could never record a verdict, so their wake ended in a refused op. And the
 * respond op returned ok:true, so none of it reached the tool result.
 */

const AGENTS = [
  { id: "arch", role: "architect", capabilities: ["repository.read", "repository.write"], authority: ["architecture.approve"], interests: [] },
  // Can settle a design artifact (review.design), signing in its quality capacity.
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "review.design"], authority: ["quality.approve", "quality.reject"], interests: [] },
  // Can record no verdict on it at all: no review capability, no authority.
  { id: "fe", role: "frontend", capabilities: ["repository.read", "repository.write"], interests: [] },
];
const COMM = { arch: ["lead", "fe"], lead: ["arch", "fe"], fe: ["arch", "lead"] };

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

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

/** A design under review by lead, and the ask that requested it. */
async function designUnderReview(reviewers: string[] = ["lead"]) {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" } as never);
  const created = await m.supervisor.createArtifact({ actorId: "arch", name: "design-system", type: "ArchitectureDocument", content: "tokens, components, states — at length" });
  if (!("artifact" in created)) throw new Error("create failed");
  const asked = await m.supervisor.executeOp("arch", { op: "request_review", artifactId: created.artifact.id, reviewers } as MeshOp, turnFor("arch"));
  assert.equal(asked.ok, true, asked.reason);
  return { m, id: created.artifact.id, askId: asked.messageId! };
}

/** Every wake `deriveSemantic` asks for, recorded rather than guessed at. */
function recordWakes(m: Mesh): Array<{ agentId: string; kind: string; note?: string }> {
  const wakes: Array<{ agentId: string; kind: string; note?: string }> = [];
  const sup = m.supervisor as unknown as { activateAgent: (id: string, reason: { kind: string; note?: string }, opts?: unknown) => Promise<unknown> };
  const orig = sup.activateAgent.bind(m.supervisor);
  sup.activateAgent = async (id, reason, opts) => {
    wakes.push({ agentId: id, kind: reason.kind, note: reason.note });
    return orig(id, reason, opts);
  };
  return wakes;
}

const messageOnlyDenials = async (m: Mesh) =>
  (await m.store.read()).filter((e) => e.type === "message.rejected" && (e.payload as { ruleId?: string }).ruleId === "verdict.message-only");

test("comms: an APPROVE reply after the seat's own mesh_approve is not refused and wakes nobody", async () => {
  const { m, id, askId } = await designUnderReview();
  try {
    const approved = await m.supervisor.executeOp("lead", { op: "approve", subject: "quality", artifactId: id, comment: "coherent" } as MeshOp, turnFor("lead"));
    assert.equal(approved.ok, true, approved.reason);
    const wakes = recordWakes(m);

    // The live shape: the courtesy reply carries no artifact ref of its own —
    // only `replyTo`, pointing at the review ask that named the artifact.
    const res = await m.supervisor.executeOp("lead", { op: "respond", messageId: askId, type: "APPROVE", payload: { verdict: "approved via mesh_approve" } } as MeshOp, turnFor("lead"));

    assert.equal(res.ok, true);
    assert.equal(res.reason, undefined, "a reply after a recorded verdict is exactly right — no caveat");
    assert.deepEqual(await messageOnlyDenials(m), [], "the verdict WAS recorded, so 'no signature was recorded' would be false");
    assert.deepEqual(wakes.filter((w) => w.agentId === "lead"), [], "and the seat is not woken to sign a second time");
  } finally {
    await m.cleanup();
  }
});

test("comms: a verdict message from a seat that cannot record one stands as a comment, told in the result, not woken", async () => {
  const { m, id } = await designUnderReview(["lead"]);
  try {
    const wakes = recordWakes(m);
    const res = await m.supervisor.executeOp(
      "fe",
      { op: "send", type: "REJECT", to: ["arch"], newThread: { subject: "design" }, payload: { artifactId: id, verdict: "the spacing scale is wrong" } } as MeshOp,
      turnFor("fe"),
    );

    assert.equal(res.ok, true, "the comment is delivered");
    assert.equal(res.caveat, true, "and what it did NOT do is a caveat on the send");
    assert.match(String(res.reason), /cannot record a reject/);
    assert.match(String(res.reason), /stands as a comment/);
    assert.doesNotMatch(String(res.reason), /Re-issue/, "never told to re-issue an op that would be refused");
    assert.deepEqual(await messageOnlyDenials(m), [], "a comment is not a denial");
    assert.deepEqual(wakes.filter((w) => w.agentId === "fe"), [], "frontend's 48k-token recovery turn, not spent");
  } finally {
    await m.cleanup();
  }
});

test("comms: an unbacked verdict message from a seat that CAN record one is still refused — and the refusal reaches the tool result", async () => {
  const { m, askId } = await designUnderReview();
  try {
    const wakes = recordWakes(m);
    const mcp = createMcpToolset(m.supervisor);
    const tok = mintSeatToken(m.config.meshId, "lead", m.kernel.state.activeGoalId);
    const raw = (await mcp.handle("lead", tok, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "mesh_respond", arguments: { messageId: askId, type: "APPROVE", payload: { verdict: "lgtm" } } },
    })) as { result: { isError: boolean; content: Array<{ text: string }> } };
    const answer = JSON.parse(raw.result.content[0]!.text) as { ok: boolean; note?: string };

    assert.equal(answer.ok, true, "the message itself was delivered");
    assert.match(String(answer.note), /records no verdict/, "respond used to come back as a bare ok:true");
    assert.match(String(answer.note), /mesh_approve/, "naming the op that does record it");
    assert.equal((await messageOnlyDenials(m)).length, 1, "the unbacked verdict is still on the record");
    assert.equal(wakes.filter((w) => w.agentId === "lead").length, 1, "and the old remedy wake still happens once");
  } finally {
    await m.cleanup();
  }
});

test("comms: seats are no longer offered APPROVE/REJECT/VETO as message types, and the verdict ops say they answer the ask", async () => {
  const { m } = await designUnderReview();
  try {
    const mcp = createMcpToolset(m.supervisor);
    const tok = mintSeatToken(m.config.meshId, "lead", m.kernel.state.activeGoalId);
    const list = (await mcp.handle("lead", tok, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })) as {
      result: { tools: Array<{ name: string; description: string; inputSchema: any }> };
    };
    const tool = (name: string) => list.result.tools.find((t) => t.name === name)!;
    for (const name of ["mesh_send", "mesh_respond", "mesh_broadcast"]) {
      const offered: string[] = tool(name).inputSchema.properties.type.enum;
      for (const verdict of ["APPROVE", "REJECT", "VETO"]) assert.ok(!offered.includes(verdict), `${name} must not offer ${verdict}`);
      assert.ok(offered.includes("INFORM") && offered.includes("BLOCK"), `${name} keeps the rest of the catalogue`);
    }
    for (const name of ["mesh_approve", "mesh_reject"]) {
      assert.match(tool(name).description, /also answers the review request/, `${name} must say it settles the ask`);
    }

    // Removed from what is SHOWN only: the operator/HTTP path still sends them.
    const human = await m.supervisor.sendMessage({ from: "human", to: ["arch"], type: "APPROVE", newThread: { subject: "fine by me" }, payload: {} });
    assert.equal(human.accepted, true, "APPROVE stays valid on the wire");
  } finally {
    await m.cleanup();
  }
});
