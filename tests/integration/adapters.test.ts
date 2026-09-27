import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
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
