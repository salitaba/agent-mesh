import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { OpenCodeRuntimeAdapter, parseMeshOps, extractText } from "../../packages/runtime-opencode/src/index";
import { HttpRuntimeAdapter } from "../../packages/runtime-http/src/index";
import { BackendUnreachableError } from "../../packages/protocol/src/index";
import type { AgentDefinition, AgentInput, RuntimeContext } from "../../packages/protocol/src/index";

const devDef: AgentDefinition = {
  id: "developer",
  role: "developer",
  mode: "peer",
  runtime: "opencode",
  prompt: { text: "you build things" },
  capabilities: ["repository.write", "git.commit"],
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

function startMockOpenCode(): Promise<{ url: string; close(): void; sessions: Map<string, unknown[]>; aborts: string[] }> {
  const sessions = new Map<string, unknown[]>();
  const aborts: string[] = [];
  let counter = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      const url = req.url ?? "";
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && url === "/session") {
        res.end(JSON.stringify([...sessions.keys()].map((id) => ({ id }))));
        return;
      }
      if (req.method === "POST" && url === "/session") {
        const id = `ses_${++counter}`;
        sessions.set(id, []);
        res.end(JSON.stringify({ id }));
        return;
      }
      const msg = /^\/session\/([^/]+)\/message$/.exec(url);
      if (req.method === "POST" && msg) {
        const history = sessions.get(msg[1]) ?? [];
        const userText = (body.parts ?? [])[0]?.text ?? "";
        history.push({ role: "user", text: userText });
        const reply = {
          info: {
            tokens: { input: 900, output: 300, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "stub/provider-model",
          },
          parts: [
            { type: "text", text: `Acknowledged. I will proceed.\n\n\`\`\`mesh-json\n[{"op":"publish_artifact","name":"p1","type":"CodePatch","content":"diff"},{"op":"done"}]\n\`\`\`` },
          ],
        };
        history.push({ role: "assistant", text: JSON.stringify(reply) });
        sessions.set(msg[1], history);
        res.end(JSON.stringify(reply));
        return;
      }
      const abort = /^\/session\/([^/]+)\/abort$/.exec(url);
      if (req.method === "POST" && abort) {
        aborts.push(abort[1]);
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      const get = /^\/session\/([^/]+)$/.exec(url);
      if (req.method === "GET" && get) {
        if (!sessions.has(get[1])) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "not found" }));
          return;
        }
        res.end(JSON.stringify({ id: get[1] }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "no route" }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        sessions,
        aborts,
        close: () => server.close(),
      });
    });
  });
}

test("opencode adapter: creates sessions, sends turns, parses mesh ops and tokens", async () => {
  const mock = await startMockOpenCode();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-oc-"));
  try {
    const adapter = new OpenCodeRuntimeAdapter({ baseUrl: mock.url, spawnProcesses: false, model: { providerID: "stub", modelID: "provider-model" } });
    const session = await adapter.start(devDef, runtimeCtx(dir));
    assert.ok(session.sessionId.startsWith("ses_"));
    assert.ok(fs.existsSync(path.join(dir, ".mesh", "agents", "developer", "opencode.json")), "per-agent opencode config generated with MCP mesh server");
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, ".mesh", "agents", "developer", "opencode.json"), "utf8"));
    assert.equal(cfg.mcp.mesh.enabled, true);
    assert.equal(cfg.permission.edit, "allow");

    const output = await adapter.send(session, {
      agentId: "developer",
      goalId: "goal-1",
      activation: { kind: "manual" },
      context: { rolePrompt: "x", mission: "m", relevantPolicies: [], agentState: { agentId: "developer", lifecycle: "THINKING", mailboxDepth: 0, currentArtifactIds: [], tokensConsumed: 0, activations: 0, lastActivityAt: "" }, relevantDecisions: [], relevantArtifacts: [], unreadMail: [], recentOwnActivity: [], agentMemory: [], openThreads: [], budgetSnapshot: { agentTokensUsed: 0, agentTokenBudget: 0, missionTokensUsed: 0, missionTokenBudget: 0 }, outstanding: { awaitingResponse: [], owedByYou: [] }, goalCriteria: [] },
      instructions: "please implement",
    });
    assert.equal(output.operations.length, 2);
    assert.equal(output.operations[0].op, "publish_artifact");
    assert.equal(output.tokensUsed.total, 1200);
    assert.equal(output.model, "stub/provider-model");

    await adapter.interrupt(session);
    assert.deepEqual(mock.aborts, [session.sessionId]);

    const status = await adapter.getStatus(session);
    assert.notEqual(status, "UNREACHABLE");

    const restored = await adapter.restoreSession(devDef, session.sessionId, runtimeCtx(dir));
    assert.equal(restored?.sessionId, session.sessionId, "persistent session restoration by id");
    const missing = await adapter.restoreSession(devDef, "ses_does_not_exist", runtimeCtx(dir));
    assert.equal(missing, null, "unknown session forces recreation");
    await adapter.stop(session);
  } finally {
    mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("opencode adapter: missing CLI rejects with a clear error instead of crashing the process", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-oc-missing-"));
  // Refusing fetch makes the readiness probe hermetic: on a crowded box a
  // random nextPort() can collide with an unrelated listener and the probe
  // would succeed spuriously (flaky resolve instead of the expected reject).
  const refuse = () => Promise.reject(Object.assign(new Error("fetch failed"), { cause: new Error("connect ECONNREFUSED") }));
  const adapter = new OpenCodeRuntimeAdapter({ executable: "definitely-not-installed-opencode-xyz", spawnProcesses: true, startupTimeoutMs: 6000, fetchImpl: refuse as typeof fetch });
  try {
    await assert.rejects(() => adapter.start(devDef, runtimeCtx(dir)), /not found on PATH|failed to launch|exited early/i);
  } finally {
    await adapter.stopAll().catch(() => undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("opencode adapter: unreachable process surfaces UNREACHABLE instead of hanging", async () => {
  const adapter = new OpenCodeRuntimeAdapter({ baseUrl: "http://127.0.0.1:1", spawnProcesses: false });
  const session = { sessionId: "x", agentId: "developer", runtime: "opencode", createdAt: "", handle: { baseUrl: "http://127.0.0.1:1" } };
  const status = await adapter.getStatus(session);
  assert.equal(status, "UNREACHABLE");
});

const minimalInput = (agentId: string): AgentInput => ({
  agentId,
  goalId: "goal-1",
  activation: { kind: "manual" },
  context: { rolePrompt: "", mission: "", relevantPolicies: [], agentState: { agentId, lifecycle: "THINKING", mailboxDepth: 0, currentArtifactIds: [], tokensConsumed: 0, activations: 0, lastActivityAt: "" }, relevantDecisions: [], relevantArtifacts: [], unreadMail: [], recentOwnActivity: [], agentMemory: [], openThreads: [], budgetSnapshot: { agentTokensUsed: 0, agentTokenBudget: 0, missionTokensUsed: 0, missionTokenBudget: 0 }, outstanding: { awaitingResponse: [], owedByYou: [] }, goalCriteria: [] },
  instructions: "go",
});

test("opencode adapter: dead backend throws a labeled BackendUnreachableError", async () => {
  const adapter = new OpenCodeRuntimeAdapter({ baseUrl: "http://127.0.0.1:1", spawnProcesses: false });
  const session = { sessionId: "x", agentId: "developer", runtime: "opencode", createdAt: "", handle: { baseUrl: "http://127.0.0.1:1" } };
  await assert.rejects(() => adapter.send(session, minimalInput("developer")), (err: unknown) => {
    assert.ok(err instanceof BackendUnreachableError, `expected BackendUnreachableError, got ${err}`);
    assert.equal((err as BackendUnreachableError).backend, "http://127.0.0.1:1");
    assert.match((err as Error).message, /backend unreachable at http:\/\/127\.0\.0\.1:1/);
    return true;
  });
});

test("opencode adapter: our own request timeout stays unlabeled (slow, not dead)", async () => {
  const sockets = new Set<import("net").Socket>();
  const hanging = http.createServer(() => { /* never responds */ });
  hanging.on("connection", (s) => sockets.add(s));
  await new Promise<void>((r) => hanging.listen(0, "127.0.0.1", r));
  const port = (hanging.address() as { port: number }).port;
  try {
    const adapter = new OpenCodeRuntimeAdapter({ baseUrl: `http://127.0.0.1:${port}`, spawnProcesses: false, requestTimeoutMs: 150 });
    const session = { sessionId: "x", agentId: "developer", runtime: "opencode", createdAt: "", handle: { baseUrl: `http://127.0.0.1:${port}` } };
    await assert.rejects(() => adapter.send(session, minimalInput("developer")), (err: unknown) => {
      assert.ok(!(err instanceof BackendUnreachableError), "aborts must not be classified as dead backends");
      return true;
    });
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => hanging.close(() => r()));
  }
});

test("http adapter: dead backend throws a labeled BackendUnreachableError", async () => {
  const adapter = new HttpRuntimeAdapter({ baseUrl: "http://127.0.0.1:1" });
  const session = { sessionId: "http-x", agentId: "developer", runtime: "http", createdAt: "", handle: null };
  await assert.rejects(() => adapter.send(session, minimalInput("developer")), (err: unknown) => {
    assert.ok(err instanceof BackendUnreachableError);
    assert.equal((err as BackendUnreachableError).backend, "http://127.0.0.1:1");
    return true;
  });
});

test("opencode: mesh-json op extraction handles arrays, objects, and plain prose", () => {
  const arr = parseMeshOps('text\n```mesh-json\n[{"op":"done"}]\n```');
  assert.equal(arr.length, 1);
  const obj = parseMeshOps('{"op":"wait","reason":"x"}');
  assert.equal(obj[0].op, "wait");
  assert.deepEqual(parseMeshOps("nothing structured here"), []);
  const wrapped = parseMeshOps('```json\n{"operations":[{"op":"remember","key":"k","value":"v"}]}\n```');
  assert.equal(wrapped[0].op, "remember");
});

test("opencode: extractText joins assistant parts", () => {
  assert.equal(extractText({ parts: [{ type: "text", text: "a" }, { type: "tool", tool: "x" }, { type: "text", text: "b" }] }), "a\nb");
});

test("http runtime adapter: full session lifecycle against a mock endpoint", async () => {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    const url = req.url ?? "";
    if (req.method === "POST" && url === "/sessions") return void res.end(JSON.stringify({ sessionId: "http-1" }));
    if (req.method === "POST" && /\/turn$/.test(url)) {
      return void res.end(JSON.stringify({ text: "ok", operations: [{ op: "done" }], tokensUsed: { input: 10, output: 5, total: 15 }, model: "custom-agent" }));
    }
    if (req.method === "GET") return void res.end(JSON.stringify({ status: "IDLE" }));
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const adapter = new HttpRuntimeAdapter({ baseUrl: `http://127.0.0.1:${port}` });
  const session = await adapter.start(devDef, runtimeCtx("/tmp"));
  assert.equal(session.sessionId, "http-1");
  const out = await adapter.send(session, { agentId: "developer", goalId: "g", activation: { kind: "manual" }, context: { rolePrompt: "", mission: "", relevantPolicies: [], agentState: { agentId: "d", lifecycle: "IDLE", mailboxDepth: 0, currentArtifactIds: [], tokensConsumed: 0, activations: 0, lastActivityAt: "" }, relevantDecisions: [], relevantArtifacts: [], unreadMail: [], recentOwnActivity: [], agentMemory: [], openThreads: [], budgetSnapshot: { agentTokensUsed: 0, agentTokenBudget: 0, missionTokensUsed: 0, missionTokenBudget: 0 }, outstanding: { awaitingResponse: [], owedByYou: [] }, goalCriteria: [] }, instructions: "" });
  assert.equal(out.operations[0].op, "done");
  assert.equal(out.tokensUsed.total, 15);
  assert.equal(await adapter.getStatus(session), "IDLE");
  await adapter.interrupt(session);
  await adapter.stop(session);
  assert.ok(calls.some((c) => c.includes("/turn")));
  server.close();
});
