import * as fs from "fs";
import * as path from "path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { createMcpToolset } from "../../apps/mesh-server/src/mcp";
import {
  MESSAGE_TYPES,
  OBLIGING_MESSAGE_TYPES,
  obligesRecipients,
  REQUEST_TYPES,
  shortHash,
} from "../../packages/protocol/src/index";

/**
 * The MCP comms surface: what a seat can say, and what it is told back.
 *
 * `toOp` and `summarize` are the whole translation layer between a model's
 * tool call and the typed op the supervisor executes. They are plain field
 * copies, which is exactly why they rot silently — a field the op carries but
 * the copy forgets produces no type error, no failed assertion and no log
 * line. It produces an agent that cannot finish what it started.
 *
 * Every test here pins one of those copies from OUTSIDE, through
 * `mcp.handle`, because that is the only vantage point the agent has. An op
 * shape asserted directly on `executeOp` proves nothing about whether the
 * seat driving it could ever have named the arguments.
 */

function mcpReq(method: string, params: unknown, id = 1) {
  return { jsonrpc: "2.0", id, method, params };
}

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

async function pair() {
  return makeMesh({
    agents: [
      { id: "architect", role: "architect", interests: [] },
      { id: "dev", role: "developer", interests: [] },
    ],
    mayContact: { architect: ["dev"], dev: ["architect"] },
    mode: "parked",
  });
}

/** One seat's view of the bus: the tools it is shown and the calls it can make. */
function bus(m: Mesh, agentId: string) {
  const mcp = createMcpToolset(m.supervisor);
  const tok = `${m.config.meshId}:${agentId}:${shortHash(m.kernel.state.activeGoalId!)}`;
  return {
    async call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, any>> {
      const res = (await mcp.handle(agentId, tok, mcpReq("tools/call", { name, arguments: args }))) as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      return JSON.parse(res.result.content[0].text);
    },
    async schemaFor(name: string): Promise<any> {
      return (await this.toolFor(name)).inputSchema;
    },
    /** The whole descriptor. The prose lives here, not on the input schema. */
    async toolFor(name: string): Promise<any> {
      const list = (await mcp.handle(agentId, tok, mcpReq("tools/list", {}))) as {
        result: { tools: Array<{ name: string; inputSchema: any }> };
      };
      const tool = list.result.tools.find((t) => t.name === name);
      assert.ok(tool, `${name} is not advertised to ${agentId}`);
      return tool!;
    },
  };
}

test("mcp: opening a collab hands back the thread id, so its opener can close it", async () => {
  const m = await pair();
  try {
    const architect = bus(m, "architect");
    const opened = await architect.call("mesh_collab", {
      with: ["dev"],
      topic: "how should we shard the index?",
      payload: { note: "no idea yet" },
    });
    assert.equal(opened.ok, true, opened.error);

    // The id is minted server-side, so a result that withholds it leaves the
    // seat unable to name the session it just opened. `mesh_collab_close`
    // requires `threadId`, which made the cheap exit uncallable by the one
    // agent guaranteed to be a participant, and every agent-opened collab
    // then ran to its box edge and billed the human a card.
    assert.ok(opened.threadId, "mesh_collab must report the thread it opened");
    const session = m.kernel.state.collabSessions.get(opened.threadId);
    assert.ok(session, "the reported id names a real session");
    assert.equal(session!.openedBy, "architect");
    assert.equal(session!.status, "OPEN");

    const closed = await architect.call("mesh_collab_close", {
      threadId: opened.threadId,
      outcome: "range-shard by tenant id",
    });
    assert.equal(closed.ok, true, closed.error);
    assert.equal(closed.threadId, opened.threadId, "the close reports the same thread back");
    assert.equal(m.kernel.state.collabSessions.get(opened.threadId)!.status, "CLOSED");
    assert.equal([...m.kernel.state.escalations.values()].length, 0, "an on-time close costs the human nothing");
  } finally {
    await m.cleanup();
  }
});

test("mcp: every message-carrying tool is offered the same vocabulary", async () => {
  const m = await pair();
  try {
    const architect = bus(m, "architect");
    const typeOf = async (tool: string) => (await architect.schemaFor(tool)).properties.type;
    const broadcast = await typeOf("mesh_broadcast");
    const send = await typeOf("mesh_send");
    const respond = await typeOf("mesh_respond");

    // A free-form `type` on one tool and an enum on the other is not a
    // cosmetic difference: it lets a broadcast announce a string that
    // `mesh_send` would have refused, and tells the model nothing about the
    // vocabulary it is supposed to choose from.
    assert.deepEqual(broadcast.enum, MESSAGE_TYPES, "broadcast must offer the catalogue, not a free string");
    assert.deepEqual(send.enum, MESSAGE_TYPES, "and send must not carry a hand-copied list that can drift from it");

    // `mesh_respond` gets the FULL catalogue, not `RESPONSE_TYPES`. The
    // respond op's field is a MessageType, and which replies discharge an ask
    // is a separate question the runtime answers for itself; narrowing the
    // manifest to the response list would refuse legal messages.
    assert.deepEqual(respond.enum, MESSAGE_TYPES, "respond must not be narrowed to the discharge list");

    // Copied, never aliased: the manifest is handed to callers, and the
    // catalogue array is shared by every consumer in the repo.
    for (const schema of [broadcast, send, respond]) assert.notStrictEqual(schema.enum, MESSAGE_TYPES);
    assert.notStrictEqual(broadcast.enum, send.enum);
  } finally {
    await m.cleanup();
  }
});

test("mcp: mesh_request still admits every type the runtime counts as an ask", async () => {
  const m = await pair();
  try {
    const architect = bus(m, "architect");

    // This assertion was INVERTED until D11: the catalogue list omitted
    // CHALLENGE while the ledger opened a commitment for it, so the test
    // pinned the gap to stop a plausible-looking tidy-up from closing it the
    // wrong way round. Both lists are now derived from one predicate, so the
    // gap is what must not come back.
    assert.ok(REQUEST_TYPES.includes("CHALLENGE"), "the catalogue list names every type that opens a debt");
    assert.deepEqual(
      OBLIGING_MESSAGE_TYPES.filter((t) => !obligesRecipients({ type: t })),
      [],
      "the list and the predicate answer the same question",
    );

    // The manifest still advertises no enum. That is now a live choice rather
    // than a forced one: an enum of OBLIGING_MESSAGE_TYPES would no longer
    // make a CHALLENGE unrepresentable. Pinned as-is because narrowing the
    // manifest is a change to `mesh_request`'s contract with the model, and
    // the assertion below is the behaviour that must survive either way.
    assert.equal((await architect.schemaFor("mesh_request")).properties.requestType.enum, undefined,
      "mesh_request accepts any catalogued type; the runtime decides which ones create a debt");

    const challenge = await architect.call("mesh_request", {
      to: ["dev"],
      requestType: "CHALLENGE",
      subject: "the sharding choice",
      payload: { q: "what happens when one tenant outgrows a shard?" },
    });
    assert.equal(challenge.ok, true, challenge.error);
    // The working path the enum would have broken: this really does put dev
    // under an obligation, exactly as a REQUEST_* would.
    assert.equal(m.kernel.state.pendingRequests.has(challenge.messageId), true,
      "a CHALLENGE raised through mesh_request opens a real commitment");
  } finally {
    await m.cleanup();
  }
});

test("mcp: a request can continue the thread it follows up on", async () => {
  const m = await pair();
  try {
    const dev = bus(m, "dev");
    const architect = bus(m, "architect");

    // `additionalProperties: false` means an argument the schema omits is an
    // argument the model is told not to send, so the wiring is only half a
    // fix unless the manifest advertises it too.
    const schema = await architect.schemaFor("mesh_request");
    assert.ok(schema.properties.threadId, "mesh_request must advertise threadId");
    assert.ok(schema.properties.replyTo, "mesh_request must advertise replyTo");

    const seed = await dev.call("mesh_send", {
      type: "INFORM",
      to: ["architect"],
      newThread: { subject: "index sharding" },
      payload: { note: "two options, both survive a rebuild" },
    });
    assert.equal(seed.ok, true, seed.error);
    const seeded = m.kernel.state.messages.get(seed.messageId)!;

    const followUp = await architect.call("mesh_request", {
      to: ["dev"],
      requestType: "REQUEST_INFO",
      threadId: seeded.threadId,
      replyTo: seed.messageId,
      payload: { q: "which option survives a tenant split?" },
    });
    assert.equal(followUp.ok, true, followUp.error);
    const asked = m.kernel.state.messages.get(followUp.messageId)!;
    assert.equal(asked.threadId, seeded.threadId, "the ask belongs in the thread that raised it");
    assert.equal(asked.replyTo, seed.messageId, "and names the message it answers");

    // Dropping both fields split one exchange across a thread per question,
    // so the recipient saw unrelated asks and the answer had nothing to
    // reply to. Opening a fresh thread stays the default when neither is
    // given -- the fix adds a choice, it does not take the old one away.
    const fresh = await architect.call("mesh_request", {
      to: ["dev"],
      requestType: "REQUEST_INFO",
      subject: "unrelated ask",
      payload: { q: "where does the tenant id come from?" },
    });
    assert.equal(fresh.ok, true, fresh.error);
    const separate = m.kernel.state.messages.get(fresh.messageId)!;
    assert.notEqual(separate.threadId, seeded.threadId, "no thread id means a new thread, as before");
    assert.equal(m.kernel.state.threads.get(separate.threadId)!.subject, "unrelated ask");
  } finally {
    await m.cleanup();
  }
});

test("mcp: a seat can publish from a path it wrote, and the tool says so before it tries", async () => {
  const m = await pair();
  try {
    const dev = bus(m, "dev");

    // The schema is the only place a model learns the field exists. `content`
    // must not be required any more — requiring it is what made the expensive
    // body the only advertised one.
    const tool = await dev.toolFor("mesh_artifact_publish");
    assert.deepEqual(tool.inputSchema.required, ["name", "type"]);
    for (const field of ["content", "fromPath", "edits"]) {
      assert.ok(tool.inputSchema.properties[field], `${field} is not advertised, so no seat will ever use it`);
    }
    // The prose is where the cheap path gets chosen or missed: a seat picks a
    // body by reading this sentence, not by reading the supervisor.
    assert.match(tool.description, /fromPath/);

    const ws = await m.supervisor.agentWorkspace("dev");
    fs.mkdirSync(ws, { recursive: true });
    const written = "# Notes\n\nwritten with Write, published by reference\n";
    fs.writeFileSync(path.join(ws, "notes.md"), written, "utf8");

    const res = await dev.call("mesh_artifact_publish", { name: "Notes", type: "ResearchReport", fromPath: "notes.md" });
    assert.equal(res.ok, true, res.error);
    assert.ok(res.artifactUri, "an artifact the seat cannot name is one it cannot cite in a message");

    // And the round trip proves `toOp` copied `fromPath` at all. That copy is
    // the rot this file watches for: delete it and the op arrives bodiless,
    // with no type error and no log line -- just a seat refused for omitting
    // the very field it sent.
    const stored = await dev.call("mesh_artifact_read", { artifactRef: res.artifactUri });
    assert.equal(stored.content, written, "the file's bytes are the artifact body, unaltered");
  } finally {
    await m.cleanup();
  }
});

test("mcp: an oversized inline body comes back as an error the seat can act on", async () => {
  const m = await pair();
  try {
    const dev = bus(m, "dev");
    const res = await dev.call("mesh_artifact_publish", {
      name: "Huge", type: "RequirementsDoc", content: "x".repeat(60_000),
    });
    assert.equal(res.ok, false);
    // Reached through `out.error`, which is the only field of the result a
    // model reliably reads. A refusal it cannot see is a turn it repeats.
    assert.match(String(res.error), /fromPath/);
    assert.match(String(res.error), /edits/);
  } finally {
    await m.cleanup();
  }
});
