import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { OpenAiCompatibleProvider, type LlmProvider } from "../../packages/llm/src/index";
import { MemoryLedgerStore, loadGatewayConfig, startGateway, type LogRecord } from "../../packages/ai-gateway/src/index";
import { FAST, collect, fakeServer, frame, json, sseHead } from "../llm/fake-server";
import { ScriptedProvider, answer } from "./support";

const ADMIN_TOKEN = "admin-token-0123456789-abcdefgh";

const PRICE_YAML = `currency: USD
version: "2026-10-05"
default_markup: 1.5
models:
  alpha/small: { input: 1, output: 4, cache_read: 0.1, cache_write: 1.25 }
  alpha/large: { input: 10, output: 40, cache_read: 1, cache_write: 12.5, markup: 2 }
  beta/other: { input: 2, output: 8, cache_read: 0.2, cache_write: 0 }
`;

const CONFIG_YAML = `ledger: ./data/ledger.jsonl
prices: ./prices.yaml
tenant: { host: 127.0.0.1, port: 0 }
admin: { host: 127.0.0.1, port: 0, token_env: GATEWAY_ADMIN_TOKEN }
limits:
  default_rpm: 60
  default_concurrent: 8
  reserve_cap: 1.5
  deadline_seconds: 120
  commit_seconds: 3
  max_body_bytes: 4096
expose_upstream_model: false
providers:
  alpha: { kind: openai-compatible, base_url: "https://alpha.example/v1", api_key_env: ALPHA_KEY }
  beta: { kind: anthropic, api_key_env: BETA_KEY }
  local: { kind: openai-compatible, base_url: "http://localhost:11434/v1" }
tiers:
  fast: [alpha/small]
  balanced:
    - { model: alpha/small, max_output_tokens: 4000 }
    - beta/other
  best: [ { model: alpha/large } ]
`;

function workdir(files: Record<string, string> = {}): { dir: string; file: string; done: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-config-"));
  fs.writeFileSync(path.join(dir, "prices.yaml"), PRICE_YAML);
  fs.writeFileSync(path.join(dir, "gateway.yaml"), CONFIG_YAML);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return { dir, file: path.join(dir, "gateway.yaml"), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const ENV = { ALPHA_KEY: "alpha-secret", BETA_KEY: "beta-secret", GATEWAY_ADMIN_TOKEN: ADMIN_TOKEN };

test("a configuration is read: paths relative to the file, keys from the environment, tiers as chains, limits with their units", () => {
  const w = workdir();
  try {
    const c = loadGatewayConfig(w.file, ENV);
    assert.equal(c.ledgerPath, path.join(w.dir, "data", "ledger.jsonl"));
    assert.equal(c.prices.version, "2026-10-05");
    assert.equal(c.prices.get("alpha/large")?.markupBps, 20_000);
    assert.deepEqual(c.providers.get("alpha"), { kind: "openai-compatible", baseUrl: "https://alpha.example/v1", apiKey: "alpha-secret", apiKeyEnv: "ALPHA_KEY" });
    assert.deepEqual(c.providers.get("beta"), { kind: "anthropic", apiKey: "beta-secret", apiKeyEnv: "BETA_KEY" });
    assert.deepEqual(c.providers.get("local"), { kind: "openai-compatible", baseUrl: "http://localhost:11434/v1" }, "a provider that needs no key names none");
    assert.deepEqual(
      c.tiers.map((t) => [t.name, t.candidates.map((x) => [x.id, x.provider, x.model, x.maxOutputTokens])]),
      [
        ["fast", [["alpha/small", "alpha", "small", 16_384]]],
        ["balanced", [["alpha/small", "alpha", "small", 4_000], ["beta/other", "beta", "other", 16_384]]],
        ["best", [["alpha/large", "alpha", "large", 16_384]]],
      ],
    );
    assert.deepEqual(c.tenant, { host: "127.0.0.1", port: 0 });
    assert.deepEqual(c.admin, { host: "127.0.0.1", port: 0, token: ADMIN_TOKEN });
    assert.deepEqual(c.limits, { defaultRpm: 60, defaultConcurrent: 8, reserveCapMicros: 1_500_000, deadlineMs: 120_000, commitMs: 3_000, maxBodyBytes: 4_096 });
    assert.equal(c.exposeUpstreamModel, false);
  } finally {
    w.done();
  }
});

test("what is left out takes the defaults, and the secrets never come from the file", () => {
  const w = workdir({
    "gateway.yaml": `ledger: l.jsonl
prices: prices.yaml
admin: { token_env: GATEWAY_ADMIN_TOKEN }
providers:
  alpha: { kind: openai-compatible, base_url: "https://alpha.example/v1" }
tiers:
  fast: [alpha/small]
`,
  });
  try {
    const c = loadGatewayConfig(w.file, { GATEWAY_ADMIN_TOKEN: ADMIN_TOKEN });
    assert.deepEqual(c.limits, { defaultRpm: 120, defaultConcurrent: 16, reserveCapMicros: 2_000_000, deadlineMs: 600_000, commitMs: 10_000, maxBodyBytes: 8 * 1024 * 1024 });
    assert.deepEqual(c.tenant, { host: "127.0.0.1", port: 8080 }, "the default is loopback, not the world");
    assert.deepEqual(c.admin, { host: "127.0.0.1", port: 8081, token: ADMIN_TOKEN });
    assert.equal(c.exposeUpstreamModel, true);
    assert.equal(c.ledgerPath, path.join(w.dir, "l.jsonl"));
  } finally {
    w.done();
  }
});

test("a configuration that cannot work is refused with every problem at once, each naming what to fix", () => {
  const w = workdir({
    "gateway.yaml": `prices: ./missing.yaml
admin: { host: "", port: 99999 }
providers:
  "bad name": { kind: openai-compatible, base_url: "https://x.example/v1" }
  nokind: { base_url: "https://x.example/v1" }
  nourl: { kind: openai-compatible }
  badurl: { kind: openai-compatible, base_url: "not a url" }
  nokey: { kind: openai-compatible, base_url: "https://x.example/v1", api_key_env: MISSING_KEY }
  notmap: 7
  badenv: { kind: anthropic, api_key_env: "" }
tiers:
  notalist: oops
  fast:
    - alpha
    - { model: 5 }
    - { model: alpha/small, max_output_tokens: 0 }
limits: { default_rpm: 0, reserve_cap: lots, deadline_seconds: 1.5, max_body_bytes: 10 }
expose_upstream_model: maybe
`,
  });
  try {
    let message = "";
    try {
      loadGatewayConfig(w.file, { GATEWAY_ADMIN_TOKEN: "short" });
    } catch (err) {
      message = (err as Error).message;
    }
    const expected = [
      /ledger is required/,
      /cannot read the price table .*missing\.yaml/,
      /provider 'bad name': a name is 1 to 64 letters/,
      /provider 'nokind': kind must be one of openai-compatible, anthropic \(got undefined\)/,
      /provider 'nourl': an openai-compatible provider needs a base_url/,
      /provider 'badurl': base_url 'not a url' is not a URL/,
      /provider 'nokey': the environment variable MISSING_KEY is not set, so there is no key to call it with/,
      /provider 'notmap' must be a mapping/,
      /provider 'badenv': api_key_env must name an environment variable/,
      /tier 'notalist' must be a list of provider\/model entries/,
      /tier 'fast'\[0\] must be a provider\/model/,
      /tier 'fast'\[1\] must be a provider\/model/,
      /tier 'fast'\[2\]\.max_output_tokens must be a whole number from 1 to 10000000/,
      /admin\.host must be an address/,
      /admin\.port must be a whole number from 0 to 65535/,
      /admin\.token_env must name the environment variable/,
      /limits\.default_rpm must be a whole number from 1 to 1000000 \(got 0\)/,
      /limits\.reserve_cap must be a number of currency units per million tokens/,
      /limits\.deadline_seconds must be a whole number/,
      /limits\.max_body_bytes must be a whole number from 1024/,
      /expose_upstream_model must be true or false/,
    ];
    for (const re of expected) assert.match(message, re);
    assert.ok(message.split("\n").every((l) => l.startsWith(w.file)), "every line names the file");
  } finally {
    w.done();
  }
});

test("a tier that names a model nobody priced, or a provider nobody configured, stops the gateway from starting", () => {
  const w = workdir({
    "gateway.yaml": CONFIG_YAML.replace("fast: [alpha/small]", "fast: [alpha/small, gamma/x, alpha/free]"),
  });
  try {
    assert.throws(
      () => loadGatewayConfig(w.file, ENV),
      (err: Error) =>
        /tier 'fast': 'gamma\/x' names provider 'gamma', which is not configured \(providers: alpha, beta, local\)/.test(err.message) &&
        /tier 'fast': 'alpha\/free' has no price/.test(err.message) &&
        /tier 'fast': 'gamma\/x' has no price/.test(err.message),
    );
  } finally {
    w.done();
  }
});

test("the admin API must not share an address with the one workspaces use, and its token must be long", () => {
  const same = workdir({ "gateway.yaml": CONFIG_YAML.replace("tenant: { host: 127.0.0.1, port: 0 }", "tenant: { host: 127.0.0.1, port: 9000 }").replace("admin: { host: 127.0.0.1, port: 0,", "admin: { host: 127.0.0.1, port: 9000,") });
  try {
    assert.throws(() => loadGatewayConfig(same.file, ENV), /tenant and admin must not listen on the same address/);
    assert.throws(() => loadGatewayConfig(same.file, { ...ENV, GATEWAY_ADMIN_TOKEN: "short" }), /GATEWAY_ADMIN_TOKEN must hold an admin token of at least 24 characters/);
    assert.throws(() => loadGatewayConfig(same.file, { ALPHA_KEY: "a", BETA_KEY: "b" }), /GATEWAY_ADMIN_TOKEN must hold an admin token/);
  } finally {
    same.done();
  }
  const different = workdir({ "gateway.yaml": CONFIG_YAML.replace("tenant: { host: 127.0.0.1, port: 0 }", "tenant: { host: 127.0.0.1, port: 9000 }").replace("admin: { host: 127.0.0.1, port: 0,", "admin: { host: 127.0.0.1, port: 9001,") });
  try {
    assert.doesNotThrow(() => loadGatewayConfig(different.file, ENV));
  } finally {
    different.done();
  }
});

test("a file that cannot be read or is not a mapping says so by name", () => {
  const w = workdir({ "empty.yaml": "- just\n- a list\n", "broken.yaml": "providers: [unclosed" });
  try {
    assert.throws(() => loadGatewayConfig(path.join(w.dir, "nope.yaml"), ENV), /cannot read the gateway configuration .*nope\.yaml/);
    assert.throws(() => loadGatewayConfig(path.join(w.dir, "broken.yaml"), ENV), /cannot read the gateway configuration .*broken\.yaml/);
    assert.throws(() => loadGatewayConfig(path.join(w.dir, "empty.yaml"), ENV), /expected a mapping with ledger, prices, providers and tiers/);
  } finally {
    w.done();
  }
});

// ---- the whole thing, running ----

test("a gateway started from its configuration serves a workspace end to end: a key from the admin API, credit, a call through the native runtime's adapter, and the report", async () => {
  const w = workdir();
  const logs: LogRecord[] = [];
  const store = new MemoryLedgerStore();
  const providers = new Map<string, ScriptedProvider>();
  const running = await startGateway(loadGatewayConfig(w.file, ENV), {
    log: (r) => logs.push(r),
    ledgerStore: store,
    providerFactory: (name) => {
      const p = new ScriptedProvider(name, name === "alpha" ? answer("From alpha.", { usage: { input: 2_000, output: 500 }, model: "small-snapshot" }) : answer("From beta."));
      providers.set(name, p);
      return p as LlmProvider;
    },
  });
  try {
    assert.ok(logs.some((l) => l.msg === "the gateway is listening" && l.currency === "USD" && l.priceVersion === "2026-10-05"));
    const adminHeaders = { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" };
    const key = (await (await fetch(`${running.admin.url}/admin/keys`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ accountId: "acme", workspaceId: "ws-1", models: ["fast", "balanced"] }) })).json()) as any;
    await fetch(`${running.admin.url}/admin/grants`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ id: "pay_1", accountId: "acme", bucket: "purchased", amountMicros: 20_000_000, reason: "top-up" }) });

    const client = new OpenAiCompatibleProvider({ baseUrl: `${running.tenant.url}/v1`, apiKey: key.token, transport: FAST });
    assert.deepEqual(await client.listModels(), ["fast", "balanced"]);
    const events = await collect(client.stream({ model: "fast", messages: [{ role: "user", content: "hello" }] }));
    const end = events.at(-1) as { kind: "end"; result: { text: string; model: string; usage: unknown } };
    assert.equal(end.result.text, "From alpha.");
    assert.equal(end.result.model, "fast", "the operator chose not to show which model answered");
    assert.deepEqual(end.result.usage, { input: 2_000, output: 500, cacheRead: 0, cacheWrite: 0 });
    assert.equal(providers.get("alpha")!.requests[0]!.model, "small");
    assert.equal(providers.get("alpha")!.requests[0]!.maxOutputTokens, 16_384);

    const balanced = await collect(client.stream({ model: "balanced", messages: [{ role: "user", content: "hello" }] }));
    assert.equal((balanced.at(-1) as { result: { text: string } }).result.text, "From alpha.");
    assert.equal(providers.get("alpha")!.requests[1]!.maxOutputTokens, 4_000, "the tier's own cap for the first model in the chain");

    const report = (await (await fetch(`${running.admin.url}/admin/report?accountId=acme&groupBy=alias`, { headers: adminHeaders })).json()) as any;
    assert.deepEqual(report.groups.map((g: any) => [g.group, g.calls]), [["balanced", 1], ["fast", 1]]);
    // Each call: 2,000 x 1 + 500 x 4 = 4,000 millionths of cost, 6,000 charged at 1.5.
    assert.equal(report.total.chargeMicros, 12_000);
    assert.equal(report.total.costMicros, 8_000);
    assert.equal(report.total.marginMicros, 4_000);
    assert.equal((await fetch(`${running.admin.url}/admin/health`)).status, 401, "the admin API is behind its token");
    assert.equal((await fetch(`${running.tenant.url}/admin/health`, { headers: adminHeaders })).status, 404, "and is not on the workspaces' port");
    assert.notEqual(running.tenant.port, running.admin.port);
  } finally {
    await running.stop(100);
    w.done();
  }
});

test("a gateway that cannot open its ledger, or whose ports are taken, does not leave anything running", async () => {
  const w = workdir();
  const holders: Array<{ stop(grace?: number): Promise<void> }> = [];
  try {
    const config = loadGatewayConfig(w.file, ENV);
    const first = await startGateway({ ...config, ledgerPath: path.join(w.dir, "one.jsonl") }, { log: () => undefined, providerFactory: (n) => new ScriptedProvider(n, answer("x")) as LlmProvider });
    holders.push(first);
    // The same ledger file again: refused, because one gateway writes it.
    await assert.rejects(
      () => startGateway({ ...config, ledgerPath: path.join(w.dir, "one.jsonl") }, { log: () => undefined, providerFactory: (n) => new ScriptedProvider(n, answer("x")) as LlmProvider }),
      /is in use by process/,
    );
    // The admin port taken: the tenant server that was already listening is closed again and the ledger released.
    const second = startGateway(
      { ...config, ledgerPath: path.join(w.dir, "two.jsonl"), admin: { ...config.admin, port: first.admin.port } },
      { log: () => undefined, providerFactory: (n) => new ScriptedProvider(n, answer("x")) as LlmProvider },
    );
    await assert.rejects(second, /EADDRINUSE/);
    assert.equal(fs.existsSync(path.join(w.dir, "two.jsonl.lock")), false, "the ledger it opened was released");
  } finally {
    for (const h of holders) await h.stop(100);
    w.done();
  }
});

test("a configuration with no providers or no tiers is refused, whether they are left out, empty or not mappings", () => {
  const head = "ledger: l.jsonl\nprices: prices.yaml\nadmin: { token_env: GATEWAY_ADMIN_TOKEN }\n";
  const variants: Array<[string, string]> = [
    ["left out", head],
    ["empty", `${head}providers: {}\ntiers: {}\n`],
    ["lists", `${head}providers: [alpha]\ntiers: [fast]\n`],
  ];
  for (const [what, yaml] of variants) {
    const w = workdir({ "gateway.yaml": yaml });
    try {
      assert.throws(
        () => loadGatewayConfig(w.file, { GATEWAY_ADMIN_TOKEN: ADMIN_TOKEN }),
        (err: Error) => /providers must name at least one model provider/.test(err.message) && /tiers must name at least one tier, for example fast, balanced and best/.test(err.message),
        what,
      );
    } finally {
      w.done();
    }
  }
});

test("a key that is only spaces, or empty, is no key: the provider it is for stops the gateway from starting", () => {
  const w = workdir();
  try {
    for (const blank of ["   ", "", "\t\n"]) {
      assert.throws(() => loadGatewayConfig(w.file, { ...ENV, ALPHA_KEY: blank }), /provider 'alpha': the environment variable ALPHA_KEY is not set, so there is no key to call it with/, JSON.stringify(blank));
    }
  } finally {
    w.done();
  }
});

const completion = (res: import("node:http").ServerResponse): void => {
  sseHead(res);
  frame(res, { id: "c1", model: "small-2026", choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }] });
  frame(res, { id: "c1", model: "small-2026", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  frame(res, { id: "c1", model: "small-2026", choices: [], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } });
  frame(res, "[DONE]");
  res.end();
};

async function keyFor(running: Awaited<ReturnType<typeof startGateway>>): Promise<string> {
  const adminHeaders = { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" };
  const key = (await (await fetch(`${running.admin.url}/admin/keys`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ accountId: "acme", workspaceId: "ws-1" }) })).json()) as { token: string };
  await fetch(`${running.admin.url}/admin/grants`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ id: "pay_1", accountId: "acme", bucket: "purchased", amountMicros: 20_000_000, reason: "top-up" }) });
  return key.token;
}

test("a gateway built from its configuration gives each adapter its name, address and key, and the gateway the limits the file set", async () => {
  const upstream = await fakeServer((_req, res) => completion(res));
  const w = workdir({ "gateway.yaml": CONFIG_YAML.replace('"https://alpha.example/v1"', `"${upstream.url}/v1"`) });
  const running = await startGateway(loadGatewayConfig(w.file, ENV), { log: () => undefined });
  try {
    const o = running.gateway.options;
    assert.deepEqual([o.defaultRpm, o.defaultConcurrent, o.reserveCapMicros, o.deadlineMs, o.commitMs, o.exposeUpstreamModel], [60, 8, 1_500_000, 120_000, 3_000, false], "the limits the file set");
    assert.deepEqual([...o.providers].map(([name, p]) => [name, p.kind, p.endpoint]), [["alpha", "openai-compatible", "alpha"], ["beta", "anthropic", "beta"], ["local", "openai-compatible", "local"]], "each adapter knows the name the file gave it");
    const token = await keyFor(running);
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const answered = await fetch(`${running.tenant.url}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify({ model: "fast", stream: false, messages: [{ role: "user", content: "hi" }] }) });
    assert.equal(answered.status, 200);
    assert.equal(upstream.seen.length, 1);
    assert.equal(upstream.seen[0]!.url, "/v1/chat/completions", "at the address the file gave");
    assert.equal(upstream.seen[0]!.headers.authorization, "Bearer alpha-secret", "with the key the environment held");
    const tooBig = await fetch(`${running.tenant.url}/v1/chat/completions`, { method: "POST", headers, body: "x".repeat(5_000) });
    assert.equal(tooBig.status, 413, "the body limit the file set");
    assert.match(((await tooBig.json()) as any).error.message, /larger than 4096 bytes/);
  } finally {
    await running.stop(100);
    await upstream.close();
    w.done();
  }
});

test("the adapters a gateway builds ask a failing provider once more and then give up on it, because the gateway has the rest of the tier to try", async () => {
  const upstream = await fakeServer((_req, res) => json(res, 503, { error: { message: "overloaded" } }));
  const w = workdir({ "gateway.yaml": CONFIG_YAML.replace('"https://alpha.example/v1"', `"${upstream.url}/v1"`) });
  const running = await startGateway(loadGatewayConfig(w.file, ENV), { log: () => undefined });
  try {
    const token = await keyFor(running);
    const out = await fetch(`${running.tenant.url}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ model: "fast", stream: false, messages: [{ role: "user", content: "hi" }] }) });
    assert.equal(out.status, 503);
    assert.equal(upstream.seen.length, 2, "the call and one retry");
  } finally {
    await running.stop(100);
    await upstream.close();
    w.done();
  }
});

test("stopping a gateway closes its ledger, so the file can be opened again", async () => {
  const w = workdir();
  try {
    const config = loadGatewayConfig(w.file, ENV);
    const running = await startGateway(config, { log: () => undefined, providerFactory: (n) => new ScriptedProvider(n, answer("x")) as LlmProvider });
    const lock = `${config.ledgerPath}.lock`;
    assert.ok(fs.existsSync(lock), "the ledger is held while the gateway runs");
    await running.stop(100);
    assert.equal(fs.existsSync(lock), false);
    const again = await startGateway(config, { log: () => undefined, providerFactory: (n) => new ScriptedProvider(n, answer("x")) as LlmProvider });
    await again.stop(100);
  } finally {
    w.done();
  }
});
