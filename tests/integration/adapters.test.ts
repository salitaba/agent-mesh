import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseMeshOps } from "../../packages/agent-runtime/src/index";
import { HttpRuntimeAdapter } from "../../packages/runtime-http/src/index";
import { BackendUnreachableError } from "../../packages/protocol/src/index";
import { makeMesh } from "../helpers";
import type { AgentDefinition, AgentInput, RuntimeContext } from "../../packages/protocol/src/index";

const devDef: AgentDefinition = {
  id: "developer",
  role: "developer",
  mode: "peer",
  runtime: "claude",
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

function startMockOpenCode(): Promise<{ url: string; close(): void; sessions: Map<string, unknown[]>; aborts: string[]; requestBodies: Array<Record<string, unknown>> }> {
  const sessions = new Map<string, unknown[]>();
  const aborts: string[] = [];
  const requestBodies: Array<Record<string, unknown>> = [];
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
        requestBodies.push(body);
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
      if (req.method === "GET" && url === "/provider") {
        res.end(JSON.stringify({
          all: [
            { id: "stub", models: { "provider-model": { variants: { low: {}, high: {}, max: {} } } } },
            { id: "plain", models: { "no-variants": {} } },
          ],
          connected: ["stub", "plain"],
          default: { stub: "provider-model" },
        }));
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
        requestBodies,
        close: () => server.close(),
      });
    });
  });
}

const minimalInput = (agentId: string): AgentInput => ({
  agentId,
  goalId: "goal-1",
  activation: { kind: "manual" },
  context: { rolePrompt: "", mission: "", relevantPolicies: [], agentState: { agentId, lifecycle: "THINKING", mailboxDepth: 0, currentArtifactIds: [], tokensConsumed: 0, activations: 0, lastActivityAt: "" }, relevantDecisions: [], relevantArtifacts: [], unreadMail: [], recentOwnActivity: [], agentMemory: [], openThreads: [], budgetSnapshot: { agentTokensUsed: 0, agentTokenBudget: 0, missionTokensUsed: 0, missionTokenBudget: 0 }, outstanding: { awaitingResponse: [], owedByYou: [] }, goalCriteria: [] },
  instructions: "go",
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

// The op parser moved to agent-runtime when the opencode adapter was removed.
// It is still live code: the claude runtime falls back to it whenever a turn
// emits ops as prose rather than through the typed mesh_* MCP tools.
test("mesh ops: extraction handles arrays, objects, and plain prose", () => {
  const arr = parseMeshOps('text\n```mesh-json\n[{"op":"done"}]\n```');
  assert.equal(arr.length, 1);
  const obj = parseMeshOps('{"op":"wait","reason":"x"}');
  assert.equal(obj[0].op, "wait");
  assert.deepEqual(parseMeshOps("nothing structured here"), []);
  const wrapped = parseMeshOps('```json\n{"operations":[{"op":"remember","key":"k","value":"v"}]}\n```');
  assert.equal(wrapped[0].op, "remember");
});
