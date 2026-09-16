import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { OpenCodeRuntimeAdapter } from "../../packages/runtime-opencode/src/index";
import type {
  AgentDefinition,
  AgentEvent,
  AgentEventTurnEnd,
  AgentInput,
  RuntimeContext,
} from "../../packages/protocol/src/index";

/**
 * The opencode half of the streaming contract. `tests/integration/claude-stream.test.ts`
 * pins the generic fold; this file pins what is specific to this adapter, whose
 * shape is genuinely different: `POST /message` BLOCKS for the whole turn and
 * deltas arrive out-of-band on `GET /event`. So the interesting failure is not
 * a mis-shaped frame — it is the request being awaited inline, which buffers
 * every delta until the turn is already over and makes a working backend look
 * mute to the supervisor's stall detector.
 */

const SESSION_ID = "ses_stream1";

const devDef: AgentDefinition = {
  id: "developer",
  role: "developer",
  mode: "peer",
  runtime: "opencode",
  prompt: { text: "you build things" },
  capabilities: ["repository.write"],
  authority: [],
  communicationPolicy: { mayContact: [], mayBeContactedBy: [] },
  interests: [],
  sessionPolicy: { persistent: true },
  delegationPolicy: { allowDelegation: false, maxDepth: 0, maxWorkers: 0 },
  budget: {},
};

function runtimeCtx(dir: string): RuntimeContext {
  return {
    goalId: "goal-1",
    meshId: "test",
    workspacePath: dir,
    busUrl: "http://127.0.0.1:1",
    agentToken: "test:developer:abcd",
    rolePromptText: "you build things",
    capabilityGrants: devDef.capabilities,
    env: {},
  };
}

const agentInput = (instructions: string, onToken?: (d: string) => void): AgentInput => ({
  agentId: "developer",
  goalId: "goal-1",
  activation: { kind: "manual" },
  context: {
    rolePrompt: "x",
    mission: "m",
    relevantPolicies: [],
    agentState: {
      agentId: "developer",
      lifecycle: "THINKING",
      mailboxDepth: 0,
      currentArtifactIds: [],
      tokensConsumed: 0,
      activations: 0,
      lastActivityAt: "",
    },
    relevantDecisions: [],
    relevantArtifacts: [],
    unreadMail: [],
    recentOwnActivity: [],
    agentMemory: [],
    openThreads: [],
    budgetSnapshot: { agentTokensUsed: 0, agentTokenBudget: 0, missionTokensUsed: 0, missionTokenBudget: 0 },
    outstanding: { awaitingResponse: [], owedByYou: [] },
    goalCriteria: [],
  },
  instructions,
  ...(onToken ? { onToken } : {}),
});

interface MockOpts {
  deltas?: Array<{ atMs: number; sessionId?: string; field?: string; text: string }>;
  parts?: Array<Record<string, unknown>>;
  /** When set, `POST /message` answers only once this settles. */
  respondWhen?: Promise<unknown>;
  failMessage?: boolean;
}

async function startMock(opts: MockOpts = {}): Promise<{ url: string; close: () => void }> {
  const deltas = opts.deltas ?? [];
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    if (req.method === "GET" && url === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`: connected\n\n`);
      const timers = deltas.map((d) =>
        setTimeout(() => {
          try {
            res.write(
              `data: ${JSON.stringify({
                id: "evt_x",
                type: "message.part.delta",
                properties: { sessionID: d.sessionId ?? SESSION_ID, messageID: "msg_1", partID: "prt_1", field: d.field ?? "text", delta: d.text },
              })}\n\n`,
            );
          } catch {
            /* client gone */
          }
        }, d.atMs),
      );
      req.on("close", () => timers.forEach(clearTimeout));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && url === "/session") {
        res.end(JSON.stringify({ id: SESSION_ID }));
        return;
      }
      if (req.method === "POST" && /^\/session\/([^/]+)\/message$/.test(url)) {
        const answer = (): void => {
          if (opts.failMessage) {
            res.writeHead(500).end(`{"error":"backend exploded"}`);
            return;
          }
          res.end(
            JSON.stringify({
              info: { tokens: { input: 10, output: 5 }, modelID: "m" },
              parts: opts.parts ?? [{ type: "text", text: "final answer" }],
            }),
          );
        };
        if (opts.respondWhen) void opts.respondWhen.then(answer, answer);
        else setTimeout(answer, 50);
        return;
      }
      res.writeHead(404).end("{}");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

const workspace = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "mesh-oc-stream-"));
const adapterFor = (url: string): OpenCodeRuntimeAdapter =>
  new OpenCodeRuntimeAdapter({ baseUrl: url, requestTimeoutMs: 10000, controlTimeoutMs: 5000 });

/** Tool parts only ever exist on the settled response — opencode has no live tool frames. */
const TOOL_PARTS = [
  { type: "text", text: "final answer" },
  { type: "tool", tool: "bash", state: { input: { command: "ls" }, output: "a.ts\nb.ts" } },
];

test("stream yields live frames and exactly one terminal turn_end", async () => {
  const mock = await startMock({
    deltas: [
      { atMs: 20, text: "hello " },
      { atMs: 40, text: "world" },
      { atMs: 60, sessionId: "ses_other", text: "IGNORED " },
    ],
    parts: TOOL_PARTS,
  });
  try {
    const rt = adapterFor(mock.url);
    const session = await rt.start(devDef, runtimeCtx(workspace()));

    const frames: AgentEvent[] = [];
    for await (const ev of rt.stream(session, agentInput("go"))) frames.push(ev);

    const kinds = frames.map((f) => f.kind);
    assert.equal(kinds.filter((k) => k === "turn_end").length, 1, "exactly one terminal frame");
    assert.equal(kinds.at(-1), "turn_end", "turn_end must be last");
    assert.ok(kinds.indexOf("tool_call") > -1, "settled tool parts must surface as frames");
    assert.ok(
      kinds.lastIndexOf("agent_message_chunk") < kinds.indexOf("tool_call"),
      "the tap is stopped before the end frames, so no chunk may land after them",
    );

    const streamed = frames.filter((f): f is Extract<AgentEvent, { kind: "agent_message_chunk" }> => f.kind === "agent_message_chunk");
    assert.equal(streamed.map((f) => f.delta).join(""), "hello world", "another session's deltas are not ours");

    const end = frames.at(-1) as AgentEventTurnEnd;
    assert.equal(end.stopReason, "end_turn");
    assert.equal(end.text, "final answer", "the settled response is authoritative, not the concatenated deltas");
    await rt.stop(session);
  } finally {
    mock.close();
  }
});

test("deltas reach the consumer while the turn is still in flight", async () => {
  // The whole point of the design: `POST /message` is fired as a background
  // task, not awaited inline. Gated causally rather than on timing — the mock
  // answers the POST only once a chunk has actually been yielded. An inline
  // await cannot satisfy that, so it trips the fallback and fails here rather
  // than hanging the suite.
  let sawChunk!: () => void;
  const chunkSeen = new Promise<void>((res) => {
    sawChunk = res;
  });
  const fallback = new Promise<void>((res) => setTimeout(res, 1500).unref?.());
  const mock = await startMock({
    deltas: [{ atMs: 20, text: "live " }, { atMs: 40, text: "tokens" }],
    respondWhen: Promise.race([chunkSeen, fallback]),
  });
  try {
    const rt = adapterFor(mock.url);
    const session = await rt.start(devDef, runtimeCtx(workspace()));

    let chunkBeforeEnd = false;
    let ended = false;
    for await (const ev of rt.stream(session, agentInput("go"))) {
      if (ev.kind === "agent_message_chunk" && !ended) {
        chunkBeforeEnd = true;
        sawChunk();
      }
      if (ev.kind === "turn_end") ended = true;
    }

    assert.ok(chunkBeforeEnd, "a chunk must be observable before the blocking POST settles");
    await rt.stop(session);
  } finally {
    mock.close();
  }
});

test("send folds the same turn into the output the supervisor reads, and still fires onToken", async () => {
  const mock = await startMock({
    deltas: [{ atMs: 20, text: "hello " }, { atMs: 40, text: "world" }],
    parts: TOOL_PARTS,
  });
  try {
    const rt = adapterFor(mock.url);
    const session = await rt.start(devDef, runtimeCtx(workspace()));

    const deltas: string[] = [];
    const out = await rt.send(session, agentInput("go", (d) => deltas.push(d)));

    // Without this the supervisor's silence watchdog never sees firstTokenAt
    // and force-settles every streaming turn.
    assert.equal(deltas.join(""), "hello world", "text deltas must still reach onToken through the fold");
    assert.equal(out.text, "final answer");
    assert.equal(out.toolCalls?.length, 1, "tool parts are rebuilt from frames, not read off the response twice");
    assert.equal(out.toolCalls?.[0]?.name, "bash");
    assert.deepEqual(out.toolCalls?.[0]?.args, { command: "ls" });
    assert.ok(out.toolCalls?.[0]?.resultDigest, "a tool call without a result digest is unauditable");
    assert.equal(out.model, "m");
    assert.equal(out.error, undefined);
    assert.equal(out.tokensUsed.input, 10);
    assert.equal(out.tokensUsed.output, 5);
    assert.equal(out.tokensUsed.total, 15);
    await rt.stop(session);
  } finally {
    mock.close();
  }
});

test("reasoning is streamed as thought, never as transcript", async () => {
  const mock = await startMock({
    deltas: [
      { atMs: 20, field: "reasoning", text: "thinking out loud" },
      { atMs: 40, text: "answer" },
    ],
  });
  try {
    const rt = adapterFor(mock.url);
    const session = await rt.start(devDef, runtimeCtx(workspace()));

    const byKind: Record<string, string> = {};
    for await (const ev of rt.stream(session, agentInput("go"))) {
      if (ev.kind === "agent_message_chunk" || ev.kind === "agent_thought_chunk") {
        byKind[ev.kind] = (byKind[ev.kind] ?? "") + ev.delta;
      }
    }
    assert.equal(byKind.agent_thought_chunk, "thinking out loud", "reasoning must be observable");
    assert.equal(byKind.agent_message_chunk, "answer", "and must never be spliced into the answer");

    // And the fold drops it: a send op quoted while reasoning is not a request to send anything.
    const session2 = await rt.start(devDef, runtimeCtx(workspace()));
    const deltas: string[] = [];
    await rt.send(session2, agentInput("go", (d) => deltas.push(d)));
    assert.equal(deltas.join(""), "answer");
    await rt.stop(session);
    await rt.stop(session2);
  } finally {
    mock.close();
  }
});

test("a backend that fails mid-turn rejects instead of reporting an empty successful turn", async () => {
  const mock = await startMock({ deltas: [{ atMs: 20, text: "partial" }], failMessage: true });
  try {
    const rt = adapterFor(mock.url);
    const session = await rt.start(devDef, runtimeCtx(workspace()));
    await assert.rejects(
      async () => {
        for await (const _ of rt.stream(session, agentInput("go"))) {
          /* drain */
        }
      },
      "frames already emitted must not turn a dead backend into a successful empty turn",
    );
    assert.equal(await rt.getStatus(session), "UNREACHABLE");
  } finally {
    mock.close();
  }
});
