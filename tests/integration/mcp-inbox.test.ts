import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { createMcpToolset } from "../../apps/mesh-server/src/mcp";
import { readableMailDepth } from "../../packages/core/src/index";
import { shortHash } from "../../packages/protocol/src/index";

function mcpReq(method: string, params: unknown, id = 1) {
  return { jsonrpc: "2.0", id, method, params };
}

test("mcp bus: mesh_inbox shows the caller's queue and does not drain it", async () => {
  // Parked, so nothing activates. This test is about the read, and a live
  // scheduler would answer the mail — and drain it — while the assertions ran.
  const m = await makeMesh({
    mode: "parked",
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "qa", role: "qa", capabilities: ["test.write"], interests: [] },
    ],
    mayContact: { dev: ["qa"], qa: ["dev"] },
  });
  const tok = (id: string) => `${m.config.meshId}:${id}:${shortHash(m.kernel.state.activeGoalId!)}`;
  const mcp = createMcpToolset(m.supervisor);
  const call = async (as: string, args: Record<string, unknown> = {}) => {
    const res = (await mcp.handle(as, tok(as), mcpReq("tools/call", { name: "mesh_inbox", arguments: args }))) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    assert.equal(res.result.isError, false, res.result.content[0]?.text);
    return JSON.parse(res.result.content[0].text) as any;
  };

  const empty = await call("dev");
  assert.equal(empty.total, 0, "an empty mailbox is a real answer, not an error");
  assert.deepEqual(empty.messages, []);

  // Two FYIs and one ask, so the queue mixes obliging and non-obliging mail —
  // the distinction the prompt already draws and the queue has to agree with.
  for (const subject of ["first", "second"]) {
    const sent = await m.supervisor.sendMessage({
      from: "qa", to: ["dev"], type: "INFORM", newThread: { subject }, payload: { n: subject },
    });
    assert.equal(sent.accepted, true);
  }
  const ask = await m.supervisor.sendMessage({ from: "qa", to: ["dev"], type: "REQUEST", payload: { please: "review" } });
  assert.equal(ask.accepted, true);

  const before = readableMailDepth(m.kernel.state, "dev");
  const box = await call("dev");
  assert.equal(box.agentId, "dev");
  assert.equal(box.total, 3, `expected all three, got ${JSON.stringify(box)}`);
  assert.equal(box.returned, 3);
  assert.equal(box.truncated, false);
  assert.equal(box.nextOffset, null, "nothing to page to when the whole box fits");

  assert.deepEqual(
    box.messages.map((msg: any) => msg.type).sort(),
    ["INFORM", "INFORM", "REQUEST"],
  );
  const owed = box.messages.filter((msg: any) => msg.answerOwed);
  assert.equal(owed.length, 1, "only the ask owes an answer — an FYI is not a debt");
  assert.equal(owed[0].type, "REQUEST");
  assert.equal(owed[0].payload.please, "review", "the body comes with it, which is the point of a reader");
  assert.equal(
    owed[0].dueBy,
    undefined,
    "this mesh sets no TTL, so the ask has no clock — absent, not a deadline that passed",
  );
  assert.ok(box.messages.some((msg: any) => msg.subject), "thread subjects are resolved for the queue");

  // The load-bearing half: a view must not be a receipt. `message.delivered` is
  // only ever emitted for mail the turn rendered AND the model answered, so a
  // tool that drained would mark read what no prompt ever showed.
  assert.equal(readableMailDepth(m.kernel.state, "dev"), before, "reading the queue must not empty it");
  const again = await call("dev");
  assert.equal(again.total, 3, "and it is all still owed on the next call");
  assert.equal(m.kernel.state.unread.get("dev")?.length, 3, "nothing left the projection's unread list");

  // Scoped to the caller: the same tool call as another seat sees that seat's
  // box, and `qa` sent the mail, so its own box is empty.
  const other = await call("qa");
  assert.equal(other.agentId, "qa");
  assert.equal(other.total, 0, "a seat reads its own mailbox and nobody else's");

  // Paging is stable enough to walk the whole box.
  const page = await call("dev", { limit: 2 });
  assert.equal(page.returned, 2);
  assert.equal(page.total, 3);
  assert.equal(page.truncated, true);
  assert.equal(page.nextOffset, 2);
  const rest = await call("dev", { offset: page.nextOffset });
  assert.equal(rest.returned, 1);
  assert.equal(rest.truncated, false);
  assert.equal(
    new Set([...page.messages, ...rest.messages].map((msg: any) => msg.id)).size,
    3,
    "the two pages together are the box, with no message seen twice",
  );

  await m.cleanup();
});

test("mcp bus: an ask's deadline is readable from the queue", async () => {
  const m = await makeMesh({
    mode: "parked",
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "qa", role: "qa", capabilities: ["test.write"], interests: [] },
    ],
    mayContact: { dev: ["qa"], qa: ["dev"] },
    bus: { commitments: { ttlMs: 600_000 } },
  });
  const tok = (id: string) => `${m.config.meshId}:${id}:${shortHash(m.kernel.state.activeGoalId!)}`;
  const mcp = createMcpToolset(m.supervisor);

  const ask = await m.supervisor.sendMessage({ from: "qa", to: ["dev"], type: "REQUEST", payload: { please: "review" } });
  const due = m.kernel.state.pendingRequests.get(ask.messageId!)!.dueBy!;
  assert.ok(due, "a configured TTL stamps a deadline at open");

  const res = (await mcp.handle("dev", tok("dev"), mcpReq("tools/call", { name: "mesh_inbox", arguments: {} }))) as {
    result: { content: Array<{ text: string }> };
  };
  const box = JSON.parse(res.result.content[0].text) as any;
  assert.equal(
    box.messages[0].dueBy,
    due,
    "the queue must name the same deadline the sweep will close the ask on",
  );

  await m.cleanup();
});
