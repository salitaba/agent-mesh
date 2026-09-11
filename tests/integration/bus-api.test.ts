import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import { makeMesh, waitFor, goalOf, stub } from "../helpers";
import { createMcpToolset } from "../../apps/mesh-server/src/mcp";
import { createHttpServer } from "../../apps/mesh-server/src/index";
import { shortHash, type MeshOp } from "../../packages/protocol/src/index";

function mcpReq(method: string, params: unknown, id = 1) {
  return { jsonrpc: "2.0", id, method, params };
}

test("mcp bus: initialize, tools/list, and a policy-governed tools/call", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "qa", role: "qa", capabilities: ["test.write"], authority: ["quality.block"], interests: [] },
    ],
    mayContact: { dev: ["qa"], qa: ["dev"] },
  });
  const goalId = m.kernel.state.activeGoalId!;
  const mcp = createMcpToolset(m.supervisor);

  const tok = `${m.config.meshId}:dev:${shortHash(goalId)}`;
  const init = (await mcp.handle("dev", tok, mcpReq("initialize", { protocolVersion: "2025-06-18" }))) as { result: { protocolVersion: string; serverInfo: { name: string } } };
  assert.ok(init.result.serverInfo.name.startsWith("mesh-bus-"));

  const list = (await mcp.handle("dev", tok, mcpReq("tools/list", {}))) as { result: { tools: Array<{ name: string }> } };
  const names = list.result.tools.map((t) => t.name);
  for (const required of ["mesh_send", "mesh_approve", "mesh_reject", "mesh_block", "mesh_artifact_publish", "mesh_artifact_read", "mesh_task_claim", "mesh_task_complete", "mesh_delegate", "mesh_escalate"]) {
    assert.ok(names.includes(required), `missing MCP tool ${required}`);
  }

  const badToken = (await mcp.handle("dev", "wrong:dev:0000", mcpReq("tools/list", {}))) as { error?: { code: number } };
  assert.equal(badToken.error?.code, -32001);

  const publish = (await mcp.handle("dev", tok, mcpReq("tools/call", { name: "mesh_artifact_publish", arguments: { name: "mcp-patch", type: "CodePatch", content: "diff" } }))) as { result: { isError: boolean; content: Array<{ text: string }> } };
  const published = JSON.parse(publish.result.content[0].text);
  assert.equal(published.ok, true);
  assert.ok(published.artifactUri.startsWith("artifact://CodePatch/mcp-patch"));

  const illegal = (await mcp.handle("dev", tok, mcpReq("tools/call", { name: "mesh_block", arguments: { subject: "quality", reason: "I do not have blocking authority" } }))) as { result: { isError: boolean; content: Array<{ text: string }> } };
  const illegalBody = JSON.parse(illegal.result.content[0].text);
  assert.equal(illegalBody.ok, false, "developer must not exercise qa's blocking authority through the bus");
  await m.cleanup();
});

test("mcp bus: read-only observability tools answer run questions", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "qa", role: "qa", capabilities: ["test.execute"], authority: ["quality.block"], interests: [] },
    ],
    mayContact: { dev: ["qa"], qa: ["dev"] },
  });
  const goalId = m.kernel.state.activeGoalId!;
  const mcp = createMcpToolset(m.supervisor);
  const tok = `${m.config.meshId}:dev:${shortHash(goalId)}`;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await mcp.handle("dev", tok, mcpReq("tools/call", { name, arguments: args }))) as { result: { isError: boolean; content: Array<{ text: string }> } };
    assert.equal(res.result.isError, false, res.result.content[0]?.text);
    return JSON.parse(res.result.content[0].text) as any;
  };

  const list = (await mcp.handle("dev", tok, mcpReq("tools/list", {}))) as { result: { tools: Array<{ name: string }> } };
  const names = list.result.tools.map((t) => t.name);
  for (const required of ["mesh_run_status", "mesh_query_events", "mesh_steps", "mesh_failures", "mesh_agent_activity", "mesh_run_digest"]) {
    assert.ok(names.includes(required), `missing read tool ${required}`);
  }

  await m.supervisor.createArtifact({ actorId: "dev", name: "obs-doc", type: "ApiSpec", content: "openapi: 3.1" });
  await m.supervisor.sendMessage({ from: "dev", to: ["qa"], type: "INFORM", newThread: { subject: "obs thread" }, payload: { note: "x" } });

  const status = await call("mesh_run_status");
  assert.equal(status.goal.status, "ACTIVE");
  assert.ok(status.metrics.events > 0);
  assert.ok(status.agents.find((a: { agentId: string }) => a.agentId === "dev"));

  const events = await call("mesh_query_events", { type: "message.sent", limit: 5 });
  assert.ok(events.events.some((e: { type: string }) => e.type === "message.sent"));
  assert.equal(typeof events.lastSeq, "number");
  assert.ok(!("payload" in events.events[0]), "payload omitted unless includePayload");
  const withPayload = await call("mesh_query_events", { type: "message.sent", limit: 1, includePayload: true });
  assert.ok("payload" in withPayload.events[0]);

  const steps = await call("mesh_steps", { limit: 5 });
  assert.ok(Array.isArray(steps.steps));

  const failures = await call("mesh_failures");
  assert.ok(Array.isArray(failures.agentFailures));
  assert.ok(failures.stuckArtifacts.some((a: { name: string }) => a.name === "obs-doc"));

  const activity = await call("mesh_agent_activity", { agentId: "dev" });
  assert.equal(activity.agents.length, 1);
  assert.equal(activity.agents[0].agentId, "dev");

  const digest = await call("mesh_run_digest");
  assert.equal(digest.outcome, "UNTERMINATED");
  assert.ok(digest.eventCount > 0);
  assert.ok(digest.topEventTypes.length > 0);

  await m.cleanup();
});

test("http api: Â§60 endpoints serve projections built from events", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "qa", role: "qa", capabilities: ["test.execute"], authority: ["quality.block"], interests: [] },
    ],
    mayContact: { dev: ["qa"], qa: ["dev"] },
    goal: "API smoke",
  });
  const created = await m.supervisor.createArtifact({ actorId: "dev", name: "api-doc", type: "ApiSpec", content: "openapi: 3.1" });
  if (!("artifact" in created)) throw new Error("artifact failed");
  await m.supervisor.sendMessage({ from: "dev", to: ["qa"], type: "INFORM", newThread: { subject: "smoke thread" }, payload: { note: "spec published" } });

  const server = createHttpServer(m, { dashboardDir: undefined });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const getJson = async (p: string) => (await fetch(`${base}${p}`)).json() as Promise<any>;
  try {
    const status = await getJson("/status");
    assert.equal(status.goal.status, "ACTIVE");
    assert.ok(status.agents.find((a: { id: string }) => a.id === "dev"));

    const agents = await getJson("/agents");
    assert.equal(agents.filter((a: { id: string }) => a.id !== "human").length, 2);
    const inspect = await getJson("/agents/dev");
    assert.equal(inspect.definition.role, "developer");

    const artifacts = await getJson("/artifacts");
    assert.equal(artifacts.length, 1);
    const versions = await getJson(`/artifacts/${created.artifact.id}/versions`);
    assert.equal(versions.length, 1);
    const content = await (await fetch(`${base}/artifacts/${created.artifact.id}/content`)).text();
    assert.match(content, /openapi/);

    const threads = [...m.kernel.state.threads.values()];
    const thread = await getJson(`/threads/${threads[threads.length - 1].id}`);
    assert.ok(thread.messages.length >= 1);

    const messages = [...m.kernel.state.messages.values()];
    const msg = await getJson(`/messages/${messages[0].id}`);
    assert.equal(msg.type, "INFORM");

    const budgets = await getJson("/budgets");
    assert.ok(budgets.entries.some((b: { key: string }) => b.key.startsWith("mission:")));

    const events = await getJson("/events?limit=100");
    assert.ok(events.some((e: { type: string }) => e.type === "message.sent"));

    const graph = await getJson("/graph");
    assert.ok(graph.nodes.length >= 2);

    const metrics = await getJson("/metrics");
    assert.ok(metrics.metrics.events > 0);

    const replay = await getJson(`/goals/${m.kernel.state.activeGoalId}/replay`);
    assert.equal(replay.goal.status, "ACTIVE");

    const devActsBefore = m.kernel.state.agents.get("dev")?.state.activations ?? 0;
    const sent = await fetch(`${base}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: ["dev"], type: "INFORM", payload: { from: "operator" } }) });
    assert.equal(sent.status, 202);
    await waitFor("dev woken by human mail", () => (m.kernel.state.agents.get("dev")?.state.activations ?? 0) > devActsBefore, 5000);
    const humanMsg = [...m.kernel.state.messages.values()].find((x) => x.from === "human");
    assert.equal(humanMsg?.provenance?.source, "human");

    const paused = await fetch(`${base}/goals/${m.kernel.state.activeGoalId}/pause`, { method: "POST" });
    assert.equal(paused.status, 200);
    assert.equal(goalOf(m)?.status, "PAUSED");
    const resumed = await fetch(`${base}/goals/${m.kernel.state.activeGoalId}/resume`, { method: "POST" });
    assert.equal(resumed.status, 200);
    await waitFor("goal active again", () => goalOf(m)?.status === "ACTIVE", 4000);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await m.cleanup();
  }
});

test("http api: dashboard SPA shell + bundle served (vite build)", async () => {
  const m = await makeMesh({ agents: [{ id: "a", role: "r", interests: [] }], mayContact: { a: [] } });
  const dashDir = require("path").resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "dist");
  const server = createHttpServer(m, { dashboardDir: dashDir });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const idx = await fetch(`${base}/`);
    assert.equal(idx.status, 200);
    assert.equal(idx.headers.get("content-type"), "text/html; charset=utf-8");
    const html = await idx.text();
    assert.ok(html.includes("Agent Mesh"));
    assert.ok(html.includes('id="root"'), "SPA mount point rendered");

    // Bundle + stylesheet referenced by the shell must serve and stay wired
    // to the API (escalation replies, designer save, live SSE, all views).
    const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((x) => x[1]);
    const hrefs = [...html.matchAll(/<link[^>]+href="([^"]+\.css)"/g)].map((x) => x[1]);
    assert.ok(srcs.length >= 1, "shell references a JS bundle");
    let js = "";
    for (const src of srcs) {
      const r = await fetch(`${base}${src}`);
      assert.equal(r.status, 200);
      assert.match(r.headers.get("content-type") ?? "", /javascript/);
      js += await r.text();
    }
    assert.ok(js.includes("respond-form") && js.includes("/config/save") && js.includes("EventSource"), "escalation replies, designer save, live SSE all wired");
    assert.ok(js.includes("data-view") && js.includes("Needs you"), "all views present in bundle");
    assert.ok(hrefs.length >= 1, "shell references a stylesheet");
    let css = "";
    for (const href of hrefs) {
      const r = await fetch(`${base}${href}`);
      assert.equal(r.status, 200);
      assert.match(r.headers.get("content-type") ?? "", /text\/css/);
      css += await r.text();
    }
    assert.ok(css.includes(".row-actions"));

    const notFound = await fetch(`${base}/missing.does-not-exist`);
    assert.equal(notFound.status, 404);
    const trav = await fetch(`${base}/..%2F..%2Fpackage.json`);
    assert.ok(trav.status === 404 || !(await trav.text()).includes("agent-mesh\""));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await m.cleanup();
  }
});

test("http api: config designer — validate/parse/save + designer page served", async () => {
  const m = await makeMesh({ agents: [{ id: "pm", role: "pm", authority: ["requirements.accept"], interests: [] }], mayContact: { pm: [] } });
  const path = require("path");
  const os = require("os");
  const fs = require("fs");
  const dashDir = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "dist");
  const server = createHttpServer(m, { dashboardDir: dashDir });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const post = async (p: string, body: unknown) => {
    const res = await fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as any };
  };
  try {
    // The designer is a hash route inside the SPA shell now (no legacy page).
    const gone = await fetch(`${base}/designer.html`);
    assert.equal(gone.status, 404);

    const current = (await (await fetch(`${base}/config`)).json()) as any;
    assert.equal(current.raw.mesh.id, m.config.meshId);
    assert.ok(current.filePath.endsWith("mesh.yaml"));

    const vocab = (await (await fetch(`${base}/config/vocabulary`)).json()) as any;
    assert.ok(vocab.eventTypes.includes("message.sent"));
    assert.ok(vocab.gateKinds.includes("release.accepted"));

    const doc = {
      version: 1,
      mesh: { id: "designed", goal: "designer test mesh" },
      startup: { activate: ["lead"] },
      agents: {
        lead: { role: "lead", prompt: "./roles/lead.md", capabilities: ["repository.write"], authority: ["implementation.approve"], interests: ["patch.ready"] },
        qa: { role: "qa", prompt: "./roles/qa.md", capabilities: ["test.write"], authority: ["quality.block"], interests: ["release.candidate"] },
      },
      policies: { communication: { lead: { may_contact: ["qa"] }, qa: { may_contact: ["lead"] } }, transitions: { "patch.merge": { requires: ["lead.approve"] } } },
      budgets: { mission: { tokens: 100000 } },
    };
    const good = await post("/config/validate", { config: doc });
    assert.equal(good.status, 200);
    assert.ok(good.json.yaml.includes("designed"));
    assert.deepEqual(good.json.summary.agents, ["lead", "qa"]);

    const bad = JSON.parse(JSON.stringify(doc));
    bad.policies.communication.lead.may_contact = ["ghost"];
    const badRes = await post("/config/validate", { config: bad });
    assert.equal(badRes.status, 400);
    assert.ok(badRes.json.errors.some((e: string) => /ghost/.test(e)));

    const badInterest = JSON.parse(JSON.stringify(doc));
    badInterest.agents.qa.interests = ["NotACanonical.Foo"];
    const bi = await post("/config/validate", { config: badInterest });
    assert.equal(bi.status, 400);

    const parsed = await post("/config/parse", { yaml: "version: 1\nmesh: { id: y, goal: g }\nagents: { a: { role: r } }\n" });
    assert.equal(parsed.status, 200);
    assert.equal(parsed.json.config.mesh.id, "y");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-design-"));
    const target = path.join(dir, "mesh.yaml");
    const saved = await post("/config/save", { config: doc, path: target });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.equal(saved.json.savedTo, target);
    // A save whose config references prompt files must leave the project openable:
    // the refs are materialized (repo role file or generated stub), no dangling
    // path for resolveConfig to reject as invalid_config.
    assert.deepEqual(saved.json.createdPrompts.map((c: any) => c.agent).sort(), ["lead", "qa"]);
    assert.ok(fs.existsSync(path.join(dir, "roles", "qa.md")), "referenced role prompts are written next to mesh.yaml");
    assert.ok(fs.existsSync(path.join(dir, "roles", "lead.md")));
    const { loadMeshFile, analyzeMeshConfig, resolveConfig } = require("../../packages/config/src/index");
    const rawBack = loadMeshFile(target);
    assert.equal(rawBack.mesh.id, "designed");
    analyzeMeshConfig(rawBack, dir);
    resolveConfig(target);
    assert.equal(saved.json.archived, null, "first save has nothing to archive");
    const revisedCopy = JSON.parse(JSON.stringify(doc));
    revisedCopy.mesh.goal = "second proposal";
    const resaved = await post("/config/save", { config: revisedCopy, path: target });
    assert.equal(resaved.status, 200, JSON.stringify(resaved.json));
    assert.ok(String(resaved.json.archived).startsWith(path.join(dir, ".mesh-versions")), `archived: ${resaved.json.archived}`);
    assert.match(fs.readFileSync(resaved.json.archived, "utf8"), /designed/, "the overwritten bytes are recoverable");
    assert.equal(loadMeshFile(target).mesh.goal, "second proposal");
    fs.rmSync(dir, { recursive: true, force: true });

    const noPath = await post("/config/save", { config: doc });
    assert.equal(noPath.status, 400);

    // GET /config is the designer's running-FILE baseline: after an overwrite
    // it must reflect the bytes on disk, not the snapshot resolved at boot.
    const revised = JSON.parse(JSON.stringify(current.raw));
    revised.mesh.goal = "revised from the designer";
    const overwrite = await post("/config/save", { config: revised, path: current.filePath });
    assert.equal(overwrite.status, 200, JSON.stringify(overwrite.json));
    const afterSave = (await (await fetch(`${base}/config`)).json()) as any;
    assert.equal(afterSave.raw.mesh.goal, "revised from the designer", "GET /config must re-read the overwritten running file");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await m.cleanup();
  }
});

test("ui-only mode: parked (no autonomy) but operator wake works; start flips it live", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", capabilities: ["repository.write"], interests: ["message.sent"] }],
    mayContact: { dev: [] },
    startup: ["dev"],
    uiOnly: true,
  });
  const s = stub(m);
  let runs = 0;
  s.setScript("dev", async () => {
    runs++;
    return { operations: [{ op: "done" } as MeshOp] };
  });
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(runs, 0, "startup activation must not run while parked");

  // 1) explicit operator wake runs exactly one turn even while parked
  const wake = await m.supervisor.activateAgent("dev", { kind: "manual" });
  assert.equal(wake.queued, true, "manual wake must be honored while parked");
  await waitFor("manual turn ran", () => runs === 1, 5000);

  // 2) cascades stay parked: a human message queues mail but wakes nobody
  await m.supervisor.humanSend(["dev"], "INFORM", { note: "queued only" });
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(runs, 1, "cascades must not auto-activate while parked");
  assert.ok((m.kernel.state.unread.get("dev")?.length ?? 0) >= 1, "mail stays queued");

  const server = createHttpServer(m);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    // 3) honest wake endpoint (already-running returns 409 with reason)
    const w = await fetch(`http://127.0.0.1:${port}/agents/dev/wake`, { method: "POST" });
    assert.ok(w.status === 200 || w.status === 409);
    const wj = (await w.json()) as any;
    assert.ok(typeof wj.queued === "boolean");
    const nope = await (await fetch(`http://127.0.0.1:${port}/agents/nope/wake`, { method: "POST" })).json() as any;
    assert.equal(nope.queued, false, "unknown agent honestly refused");

    // 4) start mission: parked -> live, startup activation runs, cascades resume
    const boot = await fetch(`http://127.0.0.1:${port}/mission/start`, { method: "POST" });
    assert.equal(boot.status, 200);
    const bj = (await boot.json()) as any;
    assert.equal(bj.started, true);
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/status`)).json() as any).uiOnly, false, "console reports live");
    // now live: queued mail for dev must auto-deliver (cascade active)
    await waitFor("cascade resumed after start", () => runs >= 2, 6000);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await m.cleanup();
  }
});

test("http api: SSE stream relays live events", async () => {
  const m = await makeMesh({ agents: [{ id: "solo", role: "solo", capabilities: ["repository.write"], interests: [] }], mayContact: { solo: [] } });
  const server = createHttpServer(m);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const controller = new AbortController();
  try {
    const resPromise = fetch(`http://127.0.0.1:${port}/events/stream`, { signal: controller.signal });
    await m.supervisor.createArtifact({ actorId: "solo", name: "sse", type: "ADR", content: "x" });
    const res = await resPromise;
    const reader = res.body?.getReader();
    assert.ok(reader);
    let received = "";
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !received.includes("artifact.created")) {
      const { value } = await reader.read();
      if (value) received += Buffer.from(value).toString("utf8");
    }
    controller.abort();
    assert.match(received, /event: artifact\.created/);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await m.cleanup();
  }
});

void http;
