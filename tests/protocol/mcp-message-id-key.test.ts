import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { createMcpToolset } from "../../apps/mesh-server/src/mcp";
import { mintSeatToken } from "../../packages/core/src/seat-token";

/**
 * A seat that names the message it is answering under the wrong key.
 *
 * The nineteenth cronlite run's developer called `mesh_reply` twice with `{ replyTo: "msg-…", response }`. The tool's key is
 * `messageId`; `replyTo` is what the message it was answering calls the field and what `mesh_send` and `mesh_request` name
 * theirs. The bridge copied `messageId`, which was absent, and the refusal was "unknown messageId for respond": no key named, no
 * value quoted. The same call was written again, a contract and an announcement were tried next (the second refused: a seat may
 * not start a thread with the pm), 4 of the 8 ops in that turn were refused, and the ask stayed open until a later turn answered
 * it with `mesh_send`.
 *
 * Every test here goes through `mcp.handle`, the only vantage the seat has.
 */

function mcpReq(method: string, params: unknown, id = 1) {
  return { jsonrpc: "2.0", id, method, params };
}

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

function pair() {
  return makeMesh({
    mode: "parked",
    bus: { vocabulary: "contracts" },
    agents: [
      { id: "architect", role: "architect", interests: [] },
      { id: "dev", role: "developer", interests: [] },
    ],
    mayContact: { architect: ["dev"], dev: ["architect"] },
  });
}

function bus(m: Mesh, agentId: string) {
  const mcp = createMcpToolset(m.supervisor);
  const tok = mintSeatToken(m.config.meshId, agentId, m.kernel.state.activeGoalId);
  return {
    async call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, any>> {
      const res = (await mcp.handle(agentId, tok, mcpReq("tools/call", { name, arguments: args }))) as {
        error?: { code: number; message: string };
        result?: { isError: boolean; content: Array<{ text: string }> };
      };
      assert.equal(res.error, undefined, `${name}: ${res.error?.message}`);
      return { ...JSON.parse(res.result!.content[0].text), isError: res.result!.isError };
    },
  };
}

async function ask(m: Mesh): Promise<string> {
  const asked = await bus(m, "architect").call("mesh_call", { contract: "info.question", request: { question: "which index are we sharding on?" }, to: ["dev"] });
  assert.equal(asked.ok, true, asked.error);
  return asked.messageId as string;
}

test("mesh_reply with replyTo answers the message it names, and settles the ask", async () => {
  const m = await pair();
  try {
    const id = await ask(m);
    assert.equal(m.kernel.state.pendingRequests.size, 1);
    // Padded, as a model that quotes an id out of a line of text may leave it.
    const replied = await bus(m, "dev").call("mesh_reply", { replyTo: `  ${id} `, response: { answer: "tenant id" } });
    assert.equal(replied.ok, true, replied.error);
    assert.equal(replied.isError, false);
    assert.equal(m.kernel.state.pendingRequests.size, 0, "the answer discharged the ask it named");
    assert.equal(m.kernel.state.messages.get(replied.messageId)?.replyTo, id);
  } finally {
    await m.cleanup();
  }
});

test("messageId still works, and wins when a call carries both keys", async () => {
  const m = await pair();
  try {
    const id = await ask(m);
    const replied = await bus(m, "dev").call("mesh_reply", { messageId: id, replyTo: "msg-someone-else", response: { answer: "tenant id" } });
    assert.equal(replied.ok, true, replied.error);
    assert.equal(m.kernel.state.messages.get(replied.messageId)?.replyTo, id, "the key the tool declares is the one that is read");
  } finally {
    await m.cleanup();
  }
});

test("a blank messageId does not stand in the way of a replyTo that names the message", async () => {
  const m = await pair();
  try {
    const id = await ask(m);
    const replied = await bus(m, "dev").call("mesh_reply", { messageId: "", replyTo: id, response: { answer: "tenant id" } });
    assert.equal(replied.ok, true, replied.error);
    assert.equal(m.kernel.state.messages.get(replied.messageId)?.replyTo, id);
  } finally {
    await m.cleanup();
  }
});

test("a replyTo that is not a string is no id: the call is refused by name, and nothing throws", async () => {
  const m = await pair();
  try {
    await ask(m);
    for (const replyTo of [5, { id: "msg-1" }, ["msg-1"], true]) {
      const refused = await bus(m, "dev").call("mesh_reply", { replyTo, response: { answer: "x" } });
      assert.equal(refused.ok, false, JSON.stringify(replyTo));
      assert.match(refused.error, /^mesh_reply needs messageId/, JSON.stringify(replyTo));
    }
  } finally {
    await m.cleanup();
  }
});

test("mesh_discharge and mesh_withdraw read replyTo the same way", async () => {
  const m = await pair();
  try {
    const first = await ask(m);
    const declined = await bus(m, "dev").call("mesh_discharge", { replyTo: first, reason: "not my call", refusal: undefined });
    assert.equal(declined.ok, true, declined.error);
    assert.equal(m.kernel.state.pendingRequests.size, 0, "the ask the seat declined is closed");

    const second = await ask(m);
    const withdrawn = await bus(m, "architect").call("mesh_withdraw", { replyTo: second, reason: "no longer needed" });
    assert.equal(withdrawn.ok, true, withdrawn.error);
    assert.equal(m.kernel.state.pendingRequests.size, 0, "the ask its asker withdrew is closed");
  } finally {
    await m.cleanup();
  }
});

test("a message-id tool given no id under any key is refused by name, with what the call carried", async () => {
  const m = await pair();
  try {
    await ask(m);
    const dev = bus(m, "dev");
    for (const [tool, args, what] of [
      ["mesh_reply", { response: { answer: "tenant id" } }, "the message you are answering"],
      ["mesh_respond", { type: "INFORM", payload: {} }, "the message you are answering"],
      ["mesh_discharge", { reason: "not my call" }, "the request you are closing"],
      ["mesh_withdraw", { reason: "no longer needed" }, "the request you raised and no longer want"],
    ] as const) {
      const refused = await dev.call(tool, { ...args });
      assert.equal(refused.ok, false, tool);
      assert.equal(refused.isError, true, tool);
      assert.match(refused.error, new RegExp(`^${tool} needs messageId: the id of ${what} \\(`), tool);
      assert.match(refused.error, /the msg-… id on its line in your mailbox/, tool);
      assert.match(refused.error, new RegExp(`This call carried ${Object.keys(args).join(", ")}\\.$`), tool);
    }
    const bare = await dev.call("mesh_reply", {});
    assert.match(bare.error, /This call carried no arguments\.$/);
    const blank = await dev.call("mesh_reply", { messageId: "   ", replyTo: "", response: {} });
    assert.match(blank.error, /^mesh_reply needs messageId/, "a blank id is no id");
    assert.equal(m.kernel.state.pendingRequests.size, 1, "nothing was answered");
  } finally {
    await m.cleanup();
  }
});

test("an id that is not a message names the id it was given, not only that something is unknown", async () => {
  const m = await pair();
  try {
    await ask(m);
    const refused = await bus(m, "dev").call("mesh_reply", { messageId: "msg-NOPE", response: { answer: "x" } });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /unknown messageId for respond: "msg-NOPE" is not a message in this mission/);
    assert.match(refused.error, /msg-…/, "and says where the real id is");
  } finally {
    await m.cleanup();
  }
});

test("a respond op that reaches the supervisor with no id (the prose channel has no bridge in front of it) says so", async () => {
  const m = await pair();
  try {
    await ask(m);
    const refused = await m.supervisor.executeToolOp("dev", { op: "respond", type: "INFORM", payload: { answer: "x" } } as never);
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, "respond needs a messageId: the id of the message you are answering");
  } finally {
    await m.cleanup();
  }
});
