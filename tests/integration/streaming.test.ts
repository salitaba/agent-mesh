import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { OpenCodeRuntimeAdapter, extractReasoning, extractSessionDelta, extractSessionPart } from "../../packages/runtime-opencode/src/index";
import { TurnTracker, type TurnRecord } from "../../packages/core/src/turn-tracker";
import { makeMesh } from "../helpers";
import { createHttpServer, closeHttpServer } from "../../apps/mesh-server/src/index";
import type { AgentDefinition, AgentInput, RuntimeContext } from "../../packages/protocol/src/index";

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

function baseInput(onToken?: (d: string) => void): AgentInput {
  return {
    agentId: "developer",
    goalId: "goal-1",
    activation: { kind: "manual" },
    context: {
      rolePrompt: "x",
      mission: "m",
      relevantPolicies: [],
      agentState: { agentId: "developer", lifecycle: "THINKING", mailboxDepth: 0, currentArtifactIds: [], tokensConsumed: 0, activations: 0, lastActivityAt: "" },
      relevantDecisions: [],
      relevantArtifacts: [],
      unreadMail: [],
      recentOwnActivity: [],
      agentMemory: [],
      openThreads: [],
      budgetSnapshot: { agentTokensUsed: 0, agentTokenBudget: 0, missionTokensUsed: 0, missionTokenBudget: 0 }, outstanding: { awaitingResponse: [], owedByYou: [] }, goalCriteria: [],
    },
    instructions: "do the thing",
    ...(onToken ? { onToken } : {}),
  };
}

test("extractSessionDelta pulls text deltas for our session only", () => {
  const frame = (props: unknown) => `data: ${JSON.stringify({ id: "evt_1", type: "message.part.delta", properties: props })}\n`;
  assert.equal(
    extractSessionDelta(frame({ sessionID: "ses_abc", messageID: "msg_1", partID: "prt_1", field: "text", delta: "hello " }), "ses_abc"),
    "hello ",
  );
  assert.equal(extractSessionDelta(frame({ sessionID: "ses_other", delta: "x" }), "ses_abc"), null);
  assert.equal(
    extractSessionDelta(`data: ${JSON.stringify({ id: "evt_2", type: "session.created", properties: {} })}\n`, "ses_abc"),
    null,
  );
  assert.equal(extractSessionDelta("not json at all", "ses_abc"), null);
  assert.equal(extractSessionDelta("", "ses_abc"), null);
  // Reasoning deltas are tagged, kept out of the answer buffer, and handed to
  // the designer tap with their field intact.
  const reasoning = frame({ sessionID: "ses_abc", field: "reasoning", delta: "hmm" });
  assert.equal(extractSessionDelta(reasoning, "ses_abc"), null);
  assert.deepEqual(extractSessionPart(reasoning, "ses_abc"), { field: "reasoning", delta: "hmm" });
});

test("extractReasoning joins reasoning parts and ignores text/tool parts", () => {
  assert.equal(
    extractReasoning({ parts: [{ type: "reasoning", text: "step 1" }, { type: "text", text: "answer" }, { type: "reasoning", text: "step 2" }] }),
    "step 1\nstep 2",
  );
  assert.equal(extractReasoning({ parts: [{ type: "text", text: "answer" }] }), "");
  assert.equal(extractReasoning({}), "");
});

/** Mock backend: /event streams deltas, /message answers after a delay. */
function startStreamingMock(deltas: Array<{ atMs: number; sessionId: string; text: string }>, opts: { eventOk?: boolean; messageDelayMs?: number } = {}): Promise<{ url: string; close(): void }> {
  // Resolves once every scripted delta has been written to the SSE stream.
  // The turn response waits on this instead of racing it on a fixed delay:
  // a real backend cannot answer before it has finished emitting its own
  // tokens, and under full-suite load the timers drift enough to invert that
  // order, which made this test fail intermittently for reasons unrelated to
  // the behavior under test.
  let deltasWritten!: () => void;
  const allDeltasSent = new Promise<void>((r) => {
    deltasWritten = r;
  });
  // Nothing will stream if /event is never opened (the negative case).
  if (opts.eventOk === false || deltas.length === 0) deltasWritten();

  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    if (req.method === "GET" && url === "/event") {
      if (opts.eventOk === false) {
        res.writeHead(404).end("nope");
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`: connected\n\n`);
      let remaining = deltas.length;
      const timers = deltas.map((d) =>
        setTimeout(() => {
          try {
            res.write(`data: ${JSON.stringify({ id: "evt_x", type: "message.part.delta", properties: { sessionID: d.sessionId, messageID: "msg_1", partID: "prt_1", field: "text", delta: d.text } })}\n\n`);
          } catch { /* client gone */ }
          if (--remaining === 0) deltasWritten();
        }, d.atMs),
      );
      req.on("close", () => {
        timers.forEach(clearTimeout);
        deltasWritten(); // never strand the turn if the client hangs up
      });
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && url === "/session") {
        res.end(JSON.stringify({ id: "ses_stream1" }));
        return;
      }
      const msg = /^\/session\/([^/]+)\/message$/.exec(url);
      if (req.method === "POST" && msg) {
        // Answer only after the stream has emitted everything, then honour the
        // configured delay. Ordering is causal, not timing-dependent.
        void allDeltasSent.then(() => {
          setTimeout(() => {
            res.end(JSON.stringify({
              info: { tokens: { input: 10, output: 5 }, modelID: "m" },
              parts: [{ type: "text", text: "final answer" }],
            }));
          }, opts.messageDelayMs ?? 50);
        });
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

test("opencode adapter forwards SSE text deltas to onToken without breaking the turn", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-stream-"));
  const mock = await startStreamingMock([
    { atMs: 50, sessionId: "ses_stream1", text: "hello " },
    { atMs: 150, sessionId: "ses_stream1", text: "streaming " },
    { atMs: 250, sessionId: "ses_other", text: "IGNORED " },
    { atMs: 300, sessionId: "ses_stream1", text: "world" },
  ]);
  try {
    const adapter = new OpenCodeRuntimeAdapter({ baseUrl: mock.url, requestTimeoutMs: 10000, controlTimeoutMs: 5000 });
    const session = await adapter.start(devDef, runtimeCtx(dir));
    const seen: string[] = [];
    const out = await adapter.send(session, baseInput((d) => seen.push(d)));
    assert.equal(out.text, "final answer");
    assert.equal(seen.join(""), "hello streaming world");
    await adapter.stop(session);
  } finally {
    mock.close();
  }
});

test("opencode adapter turn succeeds with full output when /event is unavailable", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-stream-"));
  const mock = await startStreamingMock([], { eventOk: false, messageDelayMs: 50 });
  try {
    const adapter = new OpenCodeRuntimeAdapter({ baseUrl: mock.url, requestTimeoutMs: 10000, controlTimeoutMs: 5000 });
    const session = await adapter.start(devDef, runtimeCtx(dir));
    const seen: string[] = [];
    const out = await adapter.send(session, baseInput((d) => seen.push(d)));
    assert.equal(out.text, "final answer");
    assert.deepEqual(seen, []);
    await adapter.stop(session);
  } finally {
    mock.close();
  }
});

test("TurnTracker.appendText buffers live deltas with a cap, ignoring finished turns", () => {
  const tracker = new TurnTracker();
  tracker.push({ turnId: "t1", agentId: "a", reason: { kind: "manual" }, startedAt: new Date().toISOString(), status: "running" });
  tracker.appendText("t1", "hello ");
  tracker.appendText("t1", "world");
  assert.equal(tracker.get("t1")?.text, "hello world");
  tracker.appendText("nope", "x");
  tracker.finish("t1", "a", { status: "ok" }, new Date().toISOString());
  tracker.appendText("t1", "late");
  assert.equal(tracker.get("t1")?.text, "hello world");
  tracker.push({ turnId: "t2", agentId: "a", reason: { kind: "manual" }, startedAt: new Date().toISOString(), status: "running" });
  tracker.appendText("t2", "z".repeat(30000));
  assert.ok((tracker.get("t2")?.text?.length ?? 0) <= 20000);
});

test("TurnTracker persists rich per-step data (phases/opTimings/text) across instances", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-turns-"));
  const file = path.join(dir, "turns.jsonl");
  const adapter = () => ({
    load: (): TurnRecord[] => {
      const out: TurnRecord[] = [];
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          out.push(JSON.parse(t) as TurnRecord);
        } catch { /* skip corrupt line */ }
      }
      return out;
    },
    save: (records: TurnRecord[]): void => fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n"), "utf8"),
  });
  try {
    const first = new TurnTracker(adapter());
    first.push({ turnId: "t1", agentId: "a", reason: { kind: "manual" }, startedAt: "2026-09-09T10:00:00.000Z", status: "running" });
    first.mark("t1", "llmCallAt", 1000);
    first.mark("t1", "llmDoneAt", 4000);
    first.appendText("t1", "streamed output");
    first.noteOp("t1", { op: "message_send", ms: 12, ok: true });
    first.finish("t1", "a", { status: "ok", text: "final text", summary: "all good", model: "gpt-x" }, "2026-09-09T10:00:05.000Z");
    first.flush();

    const second = new TurnTracker(adapter());
    const restored = second.get("t1");
    assert.ok(restored, "persisted turn restores");
    assert.equal(restored?.text, "final text");
    assert.equal(restored?.summary, "all good");
    assert.equal(restored?.model, "gpt-x");
    assert.equal(restored?.phases?.llmCallAt, 1000);
    assert.equal(restored?.phases?.llmDoneAt, 4000);
    assert.deepEqual(restored?.opTimings, [{ op: "message_send", ms: 12, ok: true }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("turn.token frames reach SSE subscribers out-of-band and never touch the log", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] }],
    mayContact: {},
    mode: "parked",
  });
  const server = createHttpServer(m, { dashboardDir: undefined });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const eventsBefore = m.kernel.state.eventCount;
  try {
    const frames: Array<{ event: string; data: unknown }> = [];
    let buf = "";
    const req = http.get(`http://127.0.0.1:${port}/events/stream`, (res) => {
      res.on("data", (c: Buffer) => {
        buf += c.toString("utf8");
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const ev = /^event: (.*)$/m.exec(block)?.[1];
          const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
          if (ev && dataLine) {
            try {
              frames.push({ event: ev, data: JSON.parse(dataLine.slice(5).trim()) });
            } catch { /* ignore */ }
          }
        }
      });
    });
    await new Promise((r) => setTimeout(r, 200));
    m.supervisor.deps.hooks?.onTurnToken?.("turn-9", "dev", "live delta");
    await new Promise((r) => setTimeout(r, 300));
    req.destroy();
    const tokenFrames = frames.filter((f) => f.event === "turn.token");
    assert.equal(tokenFrames.length, 1);
    assert.deepEqual(tokenFrames[0].data, { type: "turn.token", turnId: "turn-9", agentId: "dev", delta: "live delta", at: (tokenFrames[0].data as { at: string }).at });
    assert.equal(m.kernel.state.eventCount, eventsBefore, "token frames must not append to the event log");
  } finally {
    await closeHttpServer(server).catch(() => undefined);
    await m.cleanup();
  }
});
