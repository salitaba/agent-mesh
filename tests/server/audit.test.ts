/**
 * The audit trail: what it records, and that a caller cannot write into it.
 *
 * `auth-audit.log` holds the decisions an operator made (an approval, a tool unlock, an escalation answer).
 * Its lines were built by interpolating values the caller sent, so `%0A` in an id or a newline in a `kind`
 * ended the real line and started one the caller wrote. `mutations.log` is new: one line for every
 * authenticated state-changing request, with how it was authorised, where from, and what became of it, which
 * is the answer to "who reset the mission" that nothing could give before.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { createHttpServer, closeHttpServer } from "../../apps/mesh-server/src/index";
import { auditField } from "../../apps/mesh-server/src/web-security";
import { makeMesh } from "../helpers";

const OPERATOR = "audit-operator-secret-0123456789abcdef";

function call(base: string, method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; json: any }> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: Number(u.port), method, path: p, headers: { "content-type": "application/json", ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        let json: any;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

const saved = { token: process.env.MESH_API_TOKEN, trust: process.env.MESH_TRUST_PROXY };
function restore(): void {
  if (saved.token === undefined) delete process.env.MESH_API_TOKEN;
  else process.env.MESH_API_TOKEN = saved.token;
  if (saved.trust === undefined) delete process.env.MESH_TRUST_PROXY;
  else process.env.MESH_TRUST_PROXY = saved.trust;
}

async function withMesh(fn: (ctx: { base: string; logs: string; read: (file: string) => string[] }) => Promise<void>, opts: { token?: string | null; persist?: boolean } = {}): Promise<void> {
  restore();
  if (opts.token === null) delete process.env.MESH_API_TOKEN;
  else process.env.MESH_API_TOKEN = opts.token ?? OPERATOR;
  const m = await makeMesh({ agents: [{ id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] }], mayContact: { dev: [] }, mode: "parked", persist: opts.persist ?? true });
  const server = createHttpServer(m, { dashboardDir: undefined });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const logs = path.join(m.config.stateDir, "logs");
  const read = (file: string): string[] => {
    try {
      return fs.readFileSync(path.join(logs, file), "utf8").split("\n").filter((l) => l.length > 0);
    } catch {
      return [];
    }
  };
  try {
    await fn({ base, logs, read });
  } finally {
    await closeHttpServer(server);
    await m.cleanup();
    restore();
  }
}

const bearer = { authorization: `Bearer ${OPERATOR}` };

test("auditField makes one printable line of anything, and bounds it", () => {
  assert.equal(auditField("plain-value_1.2"), "plain-value_1.2");
  assert.equal(auditField("a\nb\r\nc"), "a_b__c");
  assert.equal(auditField("tab\there"), "tab_here");
  assert.equal(auditField("nul\u0000byte"), "nul_byte");
  assert.equal(auditField("line sep here"), "line sep_here");
  assert.equal(auditField("é"), "_");
  assert.equal(auditField(undefined), "");
  assert.equal(auditField(null), "");
  assert.equal(auditField(42), "42");
  assert.equal(auditField("x".repeat(5000)).length, 200);
  assert.equal(auditField("x".repeat(50), 10).length, 10);
});

test("a caller cannot forge a line in the auth audit log through an id, a kind or a subject", async () => {
  await withMesh(async ({ base, read }) => {
    const forged = "2026-01-01T00:00:00.000Z approvals by=human kind=approve subject=FORGED";
    await call(base, "POST", `/escalations/${encodeURIComponent(`x\n${forged}`)}/respond`, { response: "ok" }, bearer);
    await call(base, "POST", "/approvals", { kind: `approve\n${forged}`, subject: `s\r\n${forged}`, by: "human" }, bearer);
    await call(base, "POST", "/tool-approvals", { agentId: `dev\n${forged}`, tool: `Edit\n${forged}` }, bearer);
    const lines = read("auth-audit.log");
    assert.ok(lines.length >= 2, `the real decisions were recorded: ${JSON.stringify(lines)}`);
    for (const line of lines) assert.match(line, /^\d{4}-\d\d-\d\dT[\d:.]+Z (approvals|escalation\.respond|tool-approval|auth\.)/, `every line is one that the server wrote: ${line}`);
    assert.equal(lines.filter((l) => l.startsWith("2026-01-01")).length, 0, "no line begins with the forged timestamp");
  });
});

test("every authenticated state-changing request is logged once, with how it got in, where from, and the status", async () => {
  await withMesh(async ({ base, read }) => {
    assert.equal((await call(base, "POST", "/goals", { description: "audited" }, bearer)).status, 201);
    await call(base, "POST", "/goals/nope/pause", {}, bearer);
    await call(base, "GET", "/status", undefined, bearer);
    await call(base, "POST", "/goals", { description: "no credential" });
    await new Promise((r) => setTimeout(r, 100));
    const lines = read("mutations.log");
    assert.equal(lines.length, 2, `two authenticated mutations, no reads, no refused request: ${JSON.stringify(lines)}`);
    assert.match(lines[0]!, /^\S+ POST \/goals status=201 via=token ip=\S+$/);
    assert.match(lines[1]!, /^\S+ POST \/goals\/nope\/pause status=\d+ via=token ip=\S+$/);
  });
});

test("a signed-in browser is logged as a session, an open local server as open", async () => {
  await withMesh(async ({ base, read }) => {
    const login = await call(base, "POST", "/auth/login", { token: OPERATOR });
    const cookie = String(login.headers["set-cookie"]![0]).split(";")[0]!;
    await call(base, "POST", "/goals", { description: "from the dashboard" }, { cookie });
    await new Promise((r) => setTimeout(r, 100));
    assert.match(read("mutations.log")[0]!, /POST \/goals status=201 via=session/);
  });
  await withMesh(
    async ({ base, read }) => {
      await call(base, "POST", "/goals", { description: "no token configured" });
      await new Promise((r) => setTimeout(r, 100));
      assert.match(read("mutations.log")[0]!, /POST \/goals status=201 via=open/);
    },
    { token: null },
  );
});

test("the path is logged as one safe field, whatever it contains", async () => {
  await withMesh(async ({ base, read }) => {
    await call(base, "POST", `/goals/${encodeURIComponent("a\nb")}/pause`, {}, bearer);
    await new Promise((r) => setTimeout(r, 100));
    const lines = read("mutations.log");
    assert.equal(lines.length, 1, "one request, one line");
    assert.match(lines[0]!, /\/goals\/a%0Ab\/pause/, "the encoded form, never a raw newline");
  });
});

test("sign-in and sign-out are recorded, a wrong token too, and none of them carries the token", async () => {
  await withMesh(async ({ base, read }) => {
    await call(base, "POST", "/auth/login", { token: "not-the-token-but-secret-looking" });
    const ok = await call(base, "POST", "/auth/login", { token: OPERATOR });
    const cookie = String(ok.headers["set-cookie"]![0]).split(";")[0]!;
    await call(base, "POST", "/auth/logout", {}, { cookie });
    const lines = read("auth-audit.log");
    assert.deepEqual(
      lines.map((l) => l.replace(/^\S+ /, "").replace(/ip=\S+/, "ip=X")),
      ["auth.login failed ip=X", "auth.login ok ip=X", "auth.logout ip=X"],
    );
    assert.doesNotMatch(lines.join("\n"), /secret-looking|audit-operator-secret/, "neither the guess nor the real token is ever written");
  });
});

test("a throttled sign-in attempt is recorded as throttled", async () => {
  await withMesh(async ({ base, read }) => {
    process.env.MESH_TRUST_PROXY = "1"; // read per request, so after withMesh has reset the environment
    for (let i = 0; i < 30; i++) await call(base, "POST", "/auth/login", { token: `wrong-${i}` }, { "x-forwarded-for": "9.9.9.9" });
    await call(base, "POST", "/auth/login", { token: OPERATOR }, { "x-forwarded-for": "9.9.9.9" });
    const lines = read("auth-audit.log");
    assert.equal(lines.filter((l) => /auth\.login failed ip=9\.9\.9\.9/.test(l)).length, 30);
    assert.equal(lines.filter((l) => /auth\.login throttled ip=9\.9\.9\.9 retryAfterSec=\d+/.test(l)).length, 1);
  });
  restore();
});

test("an in-memory mesh writes no audit files, so a test mesh leaves nothing behind", async () => {
  await withMesh(
    async ({ base, logs }) => {
      await call(base, "POST", "/goals", { description: "x" }, bearer);
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(fs.existsSync(path.join(logs, "mutations.log")), false);
    },
    { persist: false },
  );
});

test("a seat's token cannot stage a proposal in the operator's designer card, and is not shown the staging tools", async () => {
  // Staging is driven through the bridge route; a seat token verifies for the bridge but must not stage.
  const { mintSeatToken } = await import("../../packages/core/src/seat-token");
  restore();
  delete process.env.MESH_API_TOKEN;
  const m = await makeMesh({ agents: [{ id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] }], mayContact: { dev: [] }, mode: "parked" });
  const server = createHttpServer(m, { dashboardDir: undefined });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await m.supervisor.createGoal({ description: "a goal so a seat token can be minted" });
    const seat = mintSeatToken(m.config.meshId, "dev", m.kernel.state.activeGoalId);
    const rpc = (method: string, params?: unknown) =>
      call(base, "POST", "/internal/mcp/dev?staging=1", { jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }, { "x-mesh-token": seat });
    const list = await rpc("tools/list");
    const names = ((list.json.result?.tools ?? []) as Array<{ name: string }>).map((t) => t.name);
    assert.ok(names.length > 0, "the seat still sees its ordinary tools");
    assert.equal(names.some((n) => n.startsWith("mesh_stage_")), false, `no staging tools advertised to a seat: ${names.join(",")}`);
    const staged = await rpc("tools/call", { name: "mesh_stage_goal_description", arguments: { description: "forged by a seat" } });
    assert.equal(staged.json.error?.code, -32002, JSON.stringify(staged.json));
    assert.match(staged.json.error.message, /not a seat's/);
  } finally {
    await closeHttpServer(server);
    await m.cleanup();
    restore();
  }
});
