import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startServer } from "../../apps/mesh-server/src/index";
import { parsePriceTable, startGateway, type GatewayConfig, type LogRecord, type RunningGateway } from "../../packages/ai-gateway/src/index";
import { testConfigYaml } from "../helpers";
import { fakeServer, type FakeServer, type Seen } from "../llm/fake-server";
import { eventually, script, seatOf, serve, type ChatRequest } from "./native-support";

/**
 * A whole mission with the gateway between the mesh and the provider.
 *
 * Three real servers on real ports: the provider (a scripted OpenAI-compatible server), the model gateway in front of it, and
 * the mesh's own server with two native-runtime seats whose only provider is the gateway. A workspace holds a virtual key and
 * has never seen the provider's key; the operator holds the provider's key and has never seen a prompt in a log. What is under
 * test is that the two ledgers (the mesh's own event log and the gateway's ledger of spend) agree about the same calls, and
 * that a balance that runs out is a fault the mesh understands: it pauses the seats once and carries on when credit comes.
 */

const UPSTREAM_KEY = "sk-upstream-credential-never-seen-by-a-workspace";
const ADMIN_TOKEN = "admin-token-0123456789-abcdefgh";

interface Rig {
  dir: string;
  upstream: FakeServer;
  upstreamRequests: Array<{ seat: string; headers: Seen["headers"]; raw: string }>;
  gateway: RunningGateway;
  logs: LogRecord[];
  token: string;
  adminHeaders: Record<string, string>;
  handle: Awaited<ReturnType<typeof startServer>>;
  admin(method: string, route: string, body?: unknown): Promise<any>;
  close(): Promise<void>;
}

async function rig(options: { credit: number }): Promise<Rig> {
  const upstreamRequests: Rig["upstreamRequests"] = [];
  const upstream = await fakeServer((seen, res) => {
    const req = seen.body as ChatRequest;
    const seat = seatOf(req);
    upstreamRequests.push({ seat, headers: seen.headers, raw: seen.raw });
    serve(res, script(seat, req), 800 + 100 * req.messages.length);
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-mission-"));
  const logs: LogRecord[] = [];
  const config: GatewayConfig = {
    ledgerPath: path.join(dir, "gateway", "ledger.jsonl"),
    prices: parsePriceTable({ currency: "USD", version: "e2e", default_markup: 1.5, models: { "upstream/m1": { input: 1, output: 4, cache_read: 0.1, cache_write: 1.25 } } }),
    providers: new Map([["upstream", { kind: "openai-compatible", baseUrl: `${upstream.url}/v1`, apiKey: UPSTREAM_KEY, apiKeyEnv: "UPSTREAM_KEY" }]]),
    tiers: [{ name: "balanced", candidates: [{ id: "upstream/m1", provider: "upstream", model: "m1", maxOutputTokens: 1_000 }] }],
    tenant: { host: "127.0.0.1", port: 0 },
    admin: { host: "127.0.0.1", port: 0, token: ADMIN_TOKEN },
    limits: { defaultRpm: 6_000, defaultConcurrent: 8, reserveCapMicros: 5_000_000, deadlineMs: 60_000, commitMs: 10_000, maxBodyBytes: 16 * 1024 * 1024 },
    exposeUpstreamModel: true,
  };
  const gateway = await startGateway(config, { log: (r) => logs.push(r) });
  const adminHeaders = { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" };
  const admin = async (method: string, route: string, body?: unknown): Promise<any> => {
    const res = await fetch(`${gateway.admin.url}${route}`, { method, headers: adminHeaders, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return res.json();
  };
  const made = await admin("POST", "/admin/keys", { accountId: "acme", workspaceId: "ws-1", models: ["balanced"] });
  await admin("POST", "/admin/grants", { id: "top-up-1", accountId: "acme", bucket: "purchased", amountMicros: options.credit, reason: "test credit" });

  fs.mkdirSync(path.join(dir, "roles"));
  fs.writeFileSync(path.join(dir, "roles", "dev.md"), "You are the DEVELOPER seat. Write what the goal asks for, report it to the pm, and finish.");
  fs.writeFileSync(path.join(dir, "roles", "pm.md"), "You are the PM seat. Accept a criterion when a report evidences it.");
  const base = testConfigYaml({
    agents: [
      { id: "dev", role: "developer", prompt: "x", capabilities: ["repository.read", "repository.write"], interests: [] },
      { id: "pm", role: "product-manager", prompt: "x", capabilities: ["repository.read"], authority: ["requirements.accept"], interests: [] },
    ],
    mayContact: { dev: ["pm"], pm: ["dev"] },
    startup: ["dev"],
    criteria: [{ id: "hello-delivered", description: "hello.txt exists and holds the greeting", mandatory: true }],
    goal: "Write hello.txt containing a greeting.",
    turnTimeoutMs: 60_000,
  });
  const yaml = base
    .replace(/runtime: stub/g, "runtime: native")
    .replace(
      "  runtime:\n    default: stub\n",
      `  runtime:\n    default: native\n    model: curule/balanced\n    providers:\n      curule: { kind: openai-compatible, base_url: "${gateway.tenant.url}/v1", api_key_env: GATEWAY_E2E_KEY }\n    native: { shell_env: minimal }\n`,
    );
  fs.writeFileSync(path.join(dir, "mesh.yaml"), yaml);
  const saved = process.env.GATEWAY_E2E_KEY;
  process.env.GATEWAY_E2E_KEY = made.token;
  const handle = await startServer({ configPath: path.join(dir, "mesh.yaml"), inMemory: true, port: 0, host: "127.0.0.1", mode: "live" });
  return {
    dir,
    upstream,
    upstreamRequests,
    gateway,
    logs,
    token: made.token,
    adminHeaders,
    handle,
    admin,
    async close() {
      await handle.close();
      await gateway.stop(100);
      await upstream.close();
      if (saved === undefined) delete process.env.GATEWAY_E2E_KEY;
      else process.env.GATEWAY_E2E_KEY = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const goalDone = (r: Rig): boolean => {
  const { kernel } = r.handle.instance;
  return kernel.state.goals.get(kernel.state.activeGoalId!)?.status === "COMPLETED";
};

test("a mission converges with the gateway in the middle, and the mesh's ledger and the gateway's agree about every call", async () => {
  const r = await rig({ credit: 100_000_000 });
  try {
    const { kernel, scheduler, store } = r.handle.instance;
    await eventually("the goal to complete", () => ["COMPLETED", "FAILED", "ESCALATED"].includes(kernel.state.goals.get(kernel.state.activeGoalId!)?.status ?? ""), 45_000);
    await eventually("the seats' turns to end", () => scheduler.running() === 0 && scheduler.pending() === 0, 30_000);
    assert.equal(kernel.state.goals.get(kernel.state.activeGoalId!)!.status, "COMPLETED");
    assert.equal(fs.readFileSync(path.join(r.dir, "workspace", "hello.txt"), "utf8"), "hello, world\n");

    // What each side held. The workspace had a virtual key and the gateway had the provider's, and neither crossed over.
    assert.ok(r.upstreamRequests.length >= 8);
    assert.ok(r.upstreamRequests.every((q) => q.headers.authorization === `Bearer ${UPSTREAM_KEY}`), "the provider only ever saw the gateway's own key");
    assert.ok(r.upstreamRequests.every((q) => !q.raw.includes(r.token) && !JSON.stringify(q.headers).includes(r.token)), "the provider never saw the workspace's key");
    assert.ok(!JSON.stringify(r.logs).includes(UPSTREAM_KEY) && !JSON.stringify(r.logs).includes(r.token), "no key is in the gateway's log");

    // The gateway's ledger: one spend for each call the provider answered, charged to the account.
    const ledger = await r.admin("GET", "/admin/ledger?type=spend&limit=1000");
    const spends = ledger.entries as Array<{ requestId: string; usage: { input: number; output: number }; chargeMicros: number; costMicros: number; outcome: string; keyId: string; workspaceId: string; alias: string; provider: string; model: string; modelReported?: string; priceVersion: string }>;
    assert.equal(spends.length, r.upstreamRequests.length, "a spend for every call that reached the provider");
    assert.ok(spends.every((s) => s.outcome === "ok" && s.workspaceId === "ws-1" && s.alias === "balanced" && s.provider === "upstream" && s.model === "m1" && s.modelReported === "m1-snapshot" && s.priceVersion === "e2e"));
    assert.equal(new Set(spends.map((s) => s.requestId)).size, spends.length);

    // The mesh's own record of the same turns, from what the provider reported through the gateway.
    const events = await store.read();
    assert.ok(!events.some((e) => e.type === "agent.failed"), "no seat failed");
    const billed = (events.filter((e) => e.type === "budget.consumed") as Array<{ payload: { model?: string; modelVersion?: string; input?: number; output?: number } }>).filter((e) => e.payload.model !== undefined);
    assert.ok(billed.length >= 2);
    assert.ok(billed.every((e) => e.payload.model === "balanced" && e.payload.modelVersion === "m1-snapshot"), "the mesh records the tier it asked for and the model that answered");
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    assert.equal(sum(billed.map((e) => e.payload.output ?? 0)), sum(spends.map((s) => s.usage.output)), "the two ledgers count the same output tokens");
    assert.equal(sum(billed.map((e) => e.payload.input ?? 0)), sum(spends.map((s) => s.usage.input)), "and the same input tokens");

    // The money: the balance is what was granted less what was charged, and the report says the same.
    const account = await r.admin("GET", "/admin/accounts/acme");
    const charged = sum(spends.map((s) => s.chargeMicros));
    assert.equal(account.balance.purchased, 100_000_000 - charged);
    assert.equal(account.charged, charged);
    assert.equal(account.balance.held, 0);
    const report = await r.admin("GET", "/admin/report?groupBy=workspace");
    assert.deepEqual(report.groups.map((g: { group: string; calls: number }) => [g.group, g.calls]), [["ws-1", spends.length]]);
    assert.equal(report.total.marginMicros, charged - sum(spends.map((s) => s.costMicros)));
    assert.ok(charged > 0 && report.total.marginMicros > 0);
  } finally {
    await r.close();
  }
});

test("when the balance runs out the seats are told the provider refused them, nothing is lost, and the mission carries on when credit comes", async () => {
  const r = await rig({ credit: 100_000_000 });
  try {
    const { kernel, store } = r.handle.instance;
    // Let the mission get going, then take the credit back: the next call finds a balance that cannot cover it.
    await eventually("the first call to be billed", () => r.upstreamRequests.length >= 2, 30_000);
    const before = await r.admin("GET", "/admin/accounts/acme");
    await r.admin("POST", "/admin/grants", { id: "refund-1", accountId: "acme", bucket: "purchased", amountMicros: -Math.max(0, before.balance.available), reason: "balance used up" });

    let refused: Array<{ payload: { providerOutage?: string; status?: number; error?: string } }> = [];
    await eventually(
      "a seat to be refused for its balance",
      () => {
        if (goalDone(r)) throw new Error("the mission finished before the balance ran out: the test did not exercise it");
        return gatewayRefusals(r) > 0;
      },
      20_000,
    );
    await eventually(
      "the supervisor to record the refusal",
      async () => {
        refused = (await store.read()).filter((e) => e.type === "agent.failed") as typeof refused;
        return refused.length > 0;
      },
      20_000,
    );
    // The credit comes as soon as an operator tops up or a payment lands. A seat with mail waiting is woken again the moment a turn
    // fails, so the refusals can come faster than the credit does and open the provider breaker first. The operator then answers
    // its card, which is what the dashboard's "topped up" does, and the mission probes at once instead of sitting out the backoff.
    await r.admin("POST", "/admin/grants", { id: "top-up-2", accountId: "acme", bucket: "purchased", amountMicros: 100_000_000, reason: "top-up after the balance ran out" });
    const { supervisor } = r.handle.instance;
    let cardsAnswered = 0;
    await eventually(
      "the goal to complete",
      async () => {
        const card = [...kernel.state.escalations.values()].find((e) => e.status === "OPEN" && e.reason === "provider_unavailable");
        if (card) {
          assert.equal((await supervisor.respondEscalation(card.id, "topped up")).ok, true);
          cardsAnswered++;
        }
        return ["COMPLETED", "FAILED", "ESCALATED"].includes(kernel.state.goals.get(kernel.state.activeGoalId!)?.status ?? "");
      },
      60_000,
      () => diagnosis(r),
    );
    assert.ok(cardsAnswered <= 1, "one outage is one card, however many seats were refused");
    // A call that is still being answered has reached the provider and has no spend yet: count after the seats' turns have ended.
    await eventually("the seats' turns to end", () => r.handle.instance.scheduler.running() === 0 && r.handle.instance.scheduler.pending() === 0, 30_000, () => diagnosis(r));
    assert.equal(kernel.state.goals.get(kernel.state.activeGoalId!)!.status, "COMPLETED");
    assert.equal(fs.readFileSync(path.join(r.dir, "workspace", "hello.txt"), "utf8"), "hello, world\n");

    const failures = (await store.read()).filter((e) => e.type === "agent.failed") as typeof refused;
    assert.ok(failures.length >= 1);
    for (const f of failures) {
      assert.equal(f.payload.providerOutage, "billing", `every failure was the provider's refusal for the balance: ${JSON.stringify(f.payload)}`);
      assert.equal(f.payload.status, 402);
    }
    assert.match(failures[0]!.payload.error ?? "", /The balance is too low for this call: it may cost up to USD .* is available\. Add credit to continue\./);
    // The refusal was the gateway's, and the provider was not asked for the calls it refused.
    const refusals = r.logs.filter((l) => l.msg === "call refused" && l.status === 402);
    assert.ok(refusals.length >= 1);
    const ledger = await r.admin("GET", "/admin/ledger?type=spend&limit=1000");
    assert.equal(ledger.entries.length, r.upstreamRequests.length, "every call the provider answered was recorded, and no call it did not answer was");
  } finally {
    await r.close();
  }
});

function gatewayRefusals(r: Rig): number {
  return r.logs.filter((l) => l.msg === "call refused" && l.status === 402).length;
}

/** What the mission and the gateway had done when a wait gave up. */
async function diagnosis(r: Rig): Promise<string> {
  const { kernel, scheduler, store } = r.handle.instance;
  const events = await store.read();
  const lines = events.slice(-40).map((e) => `${e.type} ${JSON.stringify(e.payload).slice(0, 160)}`);
  const breaker = (scheduler as unknown as { providerBreaker?: () => unknown }).providerBreaker?.();
  return [
    `goal: ${kernel.state.goals.get(kernel.state.activeGoalId!)?.status}`,
    `upstream calls: ${r.upstreamRequests.length}, refusals at the gateway: ${gatewayRefusals(r)}`,
    `scheduler: running ${scheduler.running()}, pending ${scheduler.pending()}`,
    `provider breaker: ${JSON.stringify(breaker)}`,
    "last events:",
    ...lines,
  ].join("\n");
}
