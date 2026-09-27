import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { createMcpToolset } from "../../apps/mesh-server/src/mcp";
import { mintSeatToken } from "../../packages/core/src/seat-token";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * §14 of the 2026-09-25 live run: review routing and visibility.
 *
 * request_review refused only when NO named reviewer could settle, so in a mixed
 * list the non-settlers stayed on `to`, owing a verdict that could never count —
 * frontend was named on 6 design reviews it could never settle — and only the
 * asker was told, in a success `reason` the MCP result dropped. Seats could not
 * see who could settle an artifact before asking. `answerOwed` depended only on
 * the message type, so it stayed true on closed asks (pm discharged one 10
 * minutes after it had closed), and withdraw/discharge said only "already
 * answered, or never existed".
 */

const AGENTS = [
  { id: "arch", role: "architect", capabilities: ["repository.read", "repository.write"], authority: ["architecture.approve"], interests: [] },
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "review.design"], authority: ["quality.approve"], interests: [] },
  { id: "fe", role: "frontend", capabilities: ["repository.read", "repository.write"], interests: [] },
];
const COMM = { arch: ["lead", "fe"], lead: ["arch", "fe"], fe: ["arch", "lead"] };

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

function bus(m: Mesh) {
  const mcp = createMcpToolset(m.supervisor);
  return async (as: string, name: string, args: Record<string, unknown> = {}): Promise<Record<string, any>> => {
    const tok = mintSeatToken(m.config.meshId, as, m.kernel.state.activeGoalId);
    const raw = (await mcp.handle(as, tok, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })) as {
      result: { content: Array<{ text: string }> };
    };
    return JSON.parse(raw.result.content[0]!.text);
  };
}

async function parked(): Promise<Mesh> {
  return makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" } as never);
}

test("comms: a mixed reviewer list asks only the seats that can settle, and the asker's tool result says who was left off", async () => {
  const m = await parked();
  try {
    const call = bus(m);
    const pub = await call("arch", "mesh_artifact_publish", { name: "design-system", type: "ArchitectureDocument", content: "tokens, components, states" });
    assert.equal(pub.ok, true, pub.error);

    const res = await call("arch", "mesh_request_review", { artifactId: pub.artifactId, reviewers: ["lead", "fe"] });
    assert.equal(res.ok, true, res.error);
    assert.match(String(res.note), /fe cannot deliver a verdict on this ArchitectureDocument/, "the caveat reaches the tool result, not only the next turn");
    assert.match(String(res.note), /fe was left off it and owes nothing/);

    const ask = m.kernel.state.messages.get(res.messageId)!;
    assert.deepEqual(ask.to, ["lead"], "fe is not asked for a verdict it could never give");
    const open = m.kernel.state.pendingRequests.get(res.messageId)!;
    assert.deepEqual(open.outstanding ?? open.to, ["lead"], "and owes nothing on the ledger");
  } finally {
    await m.cleanup();
  }
});

test("comms: read and publish results say which seats can settle the artifact", async () => {
  const m = await parked();
  try {
    const call = bus(m);
    const pub = await call("arch", "mesh_artifact_publish", { name: "api", type: "ApiSpec", content: "GET /things" });
    assert.deepEqual(pub.canSettle, ["lead"], "the owner cannot settle its own work while a peer can, and fe holds nothing that settles a design");

    const read = await call("fe", "mesh_artifact_read", { artifactRef: pub.artifactUri });
    assert.equal(read.ok, true);
    assert.deepEqual(read.canSettle, ["lead"], "a reader learns whose review to ask for before it asks");
  } finally {
    await m.cleanup();
  }
});

test("comms: answerOwed follows the ledger, and a closed ask says how it closed", async () => {
  const m = await parked();
  try {
    const call = bus(m);
    const open = await m.supervisor.sendMessage({ from: "arch", to: ["fe"], type: "REQUEST_INFO", newThread: { subject: "open" }, payload: { q: "still need this" } });
    const gone = await m.supervisor.sendMessage({ from: "arch", to: ["fe"], type: "REQUEST_INFO", newThread: { subject: "gone" }, payload: { q: "never mind" } });
    const withdrawn = await call("arch", "mesh_withdraw", { messageId: gone.messageId, reason: "found it" });
    assert.equal(withdrawn.ok, true, withdrawn.error);

    const box = await call("fe", "mesh_inbox");
    const row = (id: string) => box.messages.find((x: { id: string }) => x.id === id);
    assert.equal(row(open.messageId!).answerOwed, true, "an open ask is owed");
    assert.equal(row(gone.messageId!).answerOwed, false, "a withdrawn ask is not, whatever its type says");
    assert.deepEqual({ reason: row(gone.messageId!).closed?.reason, by: row(gone.messageId!).closed?.by }, { reason: "withdrawn_by_sender", by: "arch" });
    assert.equal(row(open.messageId!).closed, undefined);
  } finally {
    await m.cleanup();
  }
});

test("comms: withdrawing or discharging an ask that already closed names how, and by whom", async () => {
  const m = await parked();
  try {
    const call = bus(m);
    const ask = await m.supervisor.sendMessage({ from: "arch", to: ["fe"], type: "REQUEST_INFO", newThread: { subject: "q" }, payload: { q: "which token set?" } });
    const answered = await call("fe", "mesh_respond", { messageId: ask.messageId, type: "INFORM", payload: { a: "v2" } });
    assert.equal(answered.ok, true, answered.error);

    const late = await call("fe", "mesh_discharge", { messageId: ask.messageId, reason: "not mine" });
    assert.equal(late.ok, false);
    assert.match(String(late.error), /no outstanding request/);
    assert.match(String(late.error), /closed 'reply' by fe/, "not 'already answered, or never existed'");

    const retract = await call("arch", "mesh_withdraw", { messageId: ask.messageId });
    assert.match(String(retract.error), /closed 'reply' by fe/);

    const ghost = await call("arch", "mesh_withdraw", { messageId: "msg-does-not-exist" });
    assert.match(String(ghost.error), /no message with that id exists/);
  } finally {
    await m.cleanup();
  }
});
