import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import {
  MemoryControlStore,
  loadControlConfig,
  signWebhook,
  startControl,
  type CommandRunner,
} from "../../packages/cloud/src/index";
import { verifyLicense } from "../../packages/licensing/src/index";
import { fakeHost, waitFor } from "./edge-support";
import { ask } from "./net-support";
import { ENV, pricedCatalogue, workdir } from "./control-support";
import { APP_HOST, OWNER_AUTH, signedUp, stack } from "./control-stack";
import { FakeProvisioner, RecordingBilling, plane } from "./support";
import { PASSWORD, tokenIn } from "./web-support";

// ---- up ----

test("a started control plane answers on its public listener by name and on its owner listener by token, and says where it is", async () => {
  const s = await stack();
  try {
    assert.deepEqual(await s.app({ path: "/healthz" }).then((r) => [r.status, r.json]), [200, { ok: true }]);
    assert.equal((await s.app({ path: "/api/plans" })).json.plans.length, 3);
    assert.deepEqual(await s.owner({ path: "/owner/health" }).then((r) => [r.status, r.json.ok]), [200, true]);
    assert.equal((await ask(s.running.owner.port, { path: "/owner/health" })).status, 401);
    assert.equal((await ask(s.running.owner.port, { path: "/owner/health", headers: { authorization: "Bearer nope-nope-nope-nope-nope-nope" } })).status, 401);
    assert.equal((await s.app({ path: "/owner/health", headers: OWNER_AUTH })).status, 404, "the owner API is not on the public listener");
    assert.equal((await s.owner({ path: "/api/plans" })).status, 404, "and the customers' is not on the owner's");
    assert.equal((await s.app({ host: "other.example", path: "/api/plans" })).status, 404);
    const up = s.logs.find((l) => l.msg === "the control plane is listening");
    assert.deepEqual([up?.level, up?.public, up?.owner, up?.app, up?.workspaces, up?.plans], ["info", s.running.public.url, s.running.owner.url, "https://app.curule.example", "<slug>.curule-ws.example", ["team", "business", "yearly"]]);
    assert.match(s.running.public.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  } finally {
    await s.close();
  }
});

test("the account pages are served from the directory the configuration names", async () => {
  const s = await stack();
  try {
    fs.mkdirSync(path.join(s.config.pagesDir!, "assets"), { recursive: true });
    fs.writeFileSync(path.join(s.config.pagesDir!, "index.html"), "<!doctype html><title>Home</title>");
    fs.writeFileSync(path.join(s.config.pagesDir!, "assets", "app.js"), "// app");
    const home = await s.app({ path: "/" });
    assert.deepEqual([home.status, home.body], [200, "<!doctype html><title>Home</title>"]);
    assert.equal((await s.app({ path: "/assets/app.js" })).status, 200);
  } finally {
    await s.close();
  }
});

// ---- a customer, from the first page to their workspace ----

test("a customer signs up, is invoiced by hand, pays, makes a workspace and opens it at its own address, and the owner can stop them at once", async () => {
  const host = await fakeHost((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ authenticated: true }));
  });
  const s = await stack();
  try {
    s.provisioner.upstream = { host: "127.0.0.1", port: host.port };
    const ada = await signedUp(s);
    assert.deepEqual(await ada.post("/api/workspaces", { name: "Main" }).then((r) => r.json.error.code), "no_subscription");

    // The customer is sent to the operator's own page, with the reference to pay under.
    const checkout = await ada.post("/api/checkout", { purpose: "subscription", plan: "team" });
    assert.match(checkout.json.url, /^https:\/\/app\.curule\.example\/pay\?ref=manual_[0-9a-f]{32}$/);
    const ref = new URL(checkout.json.url).searchParams.get("ref")!;
    assert.equal(checkout.json.url, (await ada.post("/api/checkout", { purpose: "subscription", plan: "team" })).json.url);

    // The money arrives some other way, and the operator records it under that reference.
    const paid = await s.owner({ method: "POST", path: "/owner/payments", json: { accountId: ada.accountId, purpose: "subscription", plan: "team", amountMinor: 14_900, currency: "USD", ref: ref.replace(/^manual_/, "") } });
    assert.deepEqual([paid.status, paid.json], [200, { applied: true }]);
    const me = await ada.get("/api/me");
    assert.deepEqual([me.json.account.subscription.plan, me.json.account.subscription.status, me.json.balance.balance.included], ["team", "active", 20_000_000]);

    const made = await ada.post("/api/workspaces", { name: "Main" });
    assert.equal(made.status, 201);
    await s.running.plane.workspaces.idle();
    const spec = s.provisioner.ops("create")[0]!.spec!;
    assert.equal(spec.accountId, ada.accountId);
    assert.equal(spec.gateway!.baseUrl, "http://gateway.internal:8080/v1");
    const key = s.g.gateway.authenticate(`Bearer ${spec.gateway!.key}`);
    assert.equal(key.accountId, ada.accountId, "the key the workspace was given is a key at the gateway, for this account");
    assert.equal(verifyLicense(spec.licence!, { k1: s.w.publicKey }).ok, true, "and its licence is signed with the configured key");

    const open = await ada.post(`/api/workspaces/${made.json.workspace.workspaceId}/open`);
    const url = new URL(open.json.url);
    assert.deepEqual([url.protocol, url.hostname, url.pathname], ["https:", made.json.workspace.host, "/__enter"]);
    const entered = await ask(s.running.public.port, { host: url.host, path: `${url.pathname}${url.search}` });
    assert.equal(entered.status, 302);
    const wsCookie = String(entered.headers["set-cookie"]![0]).split(";")[0]!;
    const through = await ask(s.running.public.port, { host: url.host, path: "/auth/status", headers: { cookie: wsCookie } });
    assert.deepEqual([through.status, through.json], [200, { authenticated: true }]);
    assert.equal(host.requests.at(-1)!.headers.authorization, `Bearer ${s.running.plane.workspaces.operatorToken(made.json.workspace.workspaceId)}`);

    // The operator stops the account, and the very next request to the workspace is refused.
    assert.equal((await s.owner({ method: "POST", path: `/owner/accounts/${ada.accountId}/disable`, json: { reason: "abuse report 12" } })).status, 200);
    assert.equal((await ask(s.running.public.port, { host: url.host, path: "/auth/status", headers: { cookie: wsCookie } })).status, 401);
    assert.equal((await ada.get("/api/me")).status, 401);
    assert.equal(s.provisioner.ops("suspend").length, 1);
  } finally {
    await s.close();
    await host.close();
  }
});

test("a deployment on one machine over http puts the port in the address a workspace is opened at, and is not Secure", async () => {
  const s = await stack({
    change: (raw) => {
      raw.app_url = "http://localhost:7500";
      raw.workspaces = { domain: "localhost" };
      raw.provisioner = { kind: "local", base_dir: "./w", host_command: ["node"] };
      delete raw.licence;
      raw.billing = { provider: "manual", pay_url: "http://localhost:7500/pay?ref={ref}" };
    },
  });
  try {
    const post = (p: string, json: unknown, headers: Record<string, string> = {}) => ask(s.running.public.port, { host: "localhost", method: "POST", path: p, json, headers: { origin: "http://localhost:7500", ...headers } });
    await post("/api/signup", { email: "bob@example.com", password: PASSWORD });
    const mail = s.outbox().at(-1)!;
    const verified = await post("/api/verify", { token: tokenIn(mail.text) });
    const setCookie = String(verified.headers["set-cookie"]![0]);
    assert.match(setCookie, /^curule_session=/);
    assert.ok(!/Secure/.test(setCookie));
    const cookie = setCookie.split(";")[0]!;
    await s.running.plane.billing.apply({ type: "payment.succeeded", ref: "inv_1", purpose: "subscription", accountId: verified.json.account.accountId, plan: "team", amountMinor: 14_900, currency: "USD", at: new Date(s.clock.now).toISOString() });
    const made = await post("/api/workspaces", { name: "Local" }, { cookie });
    await s.running.plane.workspaces.idle();
    const open = await post(`/api/workspaces/${made.json.workspace.workspaceId}/open`, {}, { cookie });
    const url = new URL(open.json.url);
    assert.deepEqual([url.protocol, url.host.endsWith(".localhost:7500")], ["http:", true]);
  } finally {
    await s.close();
  }
});

// ---- billing ----

test("a hosted checkout is wired with the provider's key and secret, and a plan is found from the price on its invoice", async () => {
  const provider = { requests: [] as Array<{ url: string; auth: string; form: URLSearchParams }> };
  const env = { ...ENV, BILLING_API_KEY: "sk_test_abc", BILLING_WEBHOOK_SECRET: "whsec_abc12345" };
  const s = await stack({
    catalogue: pricedCatalogue(),
    env,
    change: (raw) => (raw.billing = { provider: "hosted-checkout", api_key_env: "BILLING_API_KEY", webhook_secret_env: "BILLING_WEBHOOK_SECRET", base_url: "https://api.provider.example" }),
    start: {
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (!url.startsWith("https://api.provider.example")) return fetch(input, init);
        provider.requests.push({ url, auth: String((init?.headers as Record<string, string>).authorization), form: new URLSearchParams(String(init?.body)) });
        return new Response(JSON.stringify({ id: "cs_1", url: "https://pay.provider.example/c/cs_1" }), { status: 200 });
      }) as typeof fetch,
    },
  });
  try {
    const ada = await signedUp(s);
    const checkout = await ada.post("/api/checkout", { purpose: "subscription", plan: "business" });
    assert.deepEqual(checkout.json, { url: "https://pay.provider.example/c/cs_1" });
    assert.deepEqual([provider.requests[0]!.url, provider.requests[0]!.auth, provider.requests[0]!.form.get("line_items[0][price]")], ["https://api.provider.example/v1/checkout/sessions", "Bearer sk_test_abc", "price_business"]);

    const now = new Date(s.clock.now);
    const message = (type: string, object: Record<string, unknown>, id: string) => Buffer.from(JSON.stringify({ id, type, created: Math.floor(now.getTime() / 1000), data: { object } }));
    const deliver = (body: Buffer, secret = "whsec_abc12345") => s.app({ method: "POST", path: "/webhooks/billing", body, headers: { "stripe-signature": signWebhook(secret, body, now) } });
    assert.equal((await deliver(message("checkout.session.completed", { id: "cs_1", client_reference_id: ada.accountId, customer: "cus_1", mode: "subscription" }, "evt_1"), "whsec_wrong")).status, 400, "a message signed with another secret is refused");
    assert.deepEqual((await deliver(message("checkout.session.completed", { id: "cs_1", client_reference_id: ada.accountId, customer: "cus_1", mode: "subscription" }, "evt_1"))).json, { received: true, events: 1, applied: 1 });
    const start = Math.floor(now.getTime() / 1000);
    const invoice = message("invoice.paid", { id: "in_1", customer: "cus_1", subscription: "sub_1", amount_paid: 59_900, currency: "usd", lines: { data: [{ price: { id: "price_business" }, period: { start, end: start + 30 * 86_400 } }] } }, "evt_2");
    assert.deepEqual((await deliver(invoice)).json, { received: true, events: 1, applied: 1 });
    const me = await ada.get("/api/me");
    assert.deepEqual([me.json.account.subscription.plan, me.json.balance.balance.included], ["business", 100_000_000], "the plan comes from the price id the catalogue holds for it");
  } finally {
    await s.close();
  }
});

// ---- workspaces ----

test("a container provisioner is given the image, the network and the egress proxy, with the gateway kept off the proxy", async () => {
  const calls: Array<{ command: string; args: string[]; env: Record<string, string> }> = [];
  const runner: CommandRunner = {
    async run(command, args, options) {
      calls.push({ command, args, env: options?.env ?? {} });
      return { code: 0, stdout: "container-id\n", stderr: "" };
    },
  };
  const s = await stack({ start: { provisioner: undefined, runner, waitReady: async () => undefined } });
  try {
    // The container engine answers nothing about an address, so the host a workspace is reached at is the one a test provides.
    const ada = await signedUp(s);
    await s.running.plane.billing.apply({ type: "payment.succeeded", ref: "inv_1", purpose: "subscription", accountId: ada.accountId, plan: "team", amountMinor: 14_900, currency: "USD", at: new Date(s.clock.now).toISOString() });
    await ada.post("/api/workspaces", { name: "Main" });
    await s.running.plane.workspaces.idle();
    const run = calls.find((c) => c.args[0] === "run")!;
    assert.equal(run.command, "docker");
    const line = run.args.join(" ");
    assert.match(line, /--network curule-workspaces/);
    assert.match(line, /--memory 2048m --memory-swap 2048m --cpus 1/);
    assert.match(line, /--pids-limit 512/);
    assert.match(line, /ghcr\.io\/example\/curule:1 host$/);
    assert.match(line, /--env HTTPS_PROXY=http:\/\/egress\.curule-workspaces:3128\//);
    assert.match(line, /--env NO_PROXY=gateway\.internal,localhost,127\.0\.0\.1/, "the gateway is ours, and is not reached through the proxy customers' traffic goes out by");
    assert.match(line, /--env MESH_ALLOWED_HOSTS=main-[0-9a-f]{6}\.curule-ws\.example/);
    assert.match(line, /--env CURULE_GATEWAY_URL=http:\/\/gateway\.internal:8080\/v1/);
    assert.ok(!line.includes(ENV.CONTROL_SECRET) && !line.includes(s.w.privateKeyPem), "no secret is in the arguments");
    assert.equal(Object.keys(run.env).sort().join(","), "CURULE_GATEWAY_KEY,CURULE_GATEWAY_MODEL,MESH_API_TOKEN,MESH_LICENSE", "the credentials and the plan's default tier go in the environment of the command, by name");
    assert.equal(run.env.CURULE_GATEWAY_MODEL, "balanced");
  } finally {
    await s.close();
  }
});

// ---- the checks ----

test("what was starting when the last process ended is looked at as soon as the next one begins, and given up on once it is old enough", async () => {
  // A first life: an account on a plan, and a workspace that was asked for and never finished.
  const first = await plane();
  const ada = await first.account("ada@example.com");
  await first.subscribe(ada.accountId);
  first.provisioner.hold = new Promise<void>(() => undefined);
  const workspace = await first.plane.workspaces.create(ada.accountId, "Stuck");
  assert.equal(first.log.state.workspaces.get(workspace.workspaceId)!.status, "provisioning");
  const entries = [...first.store.entries];

  const store = new MemoryControlStore();
  for (const e of entries) await store.append(e);
  const s = await stack({ start: { store } });
  try {
    await s.running.reconcile();
    s.clock.now += 10 * 60_000;
    const actions = await s.running.reconcile();
    assert.deepEqual(actions, [`${workspace.workspaceId}: failed, it never finished starting`]);
    assert.equal(s.running.plane.o.log.state.workspaces.get(workspace.workspaceId)!.status, "failed");
    assert.ok(s.logs.some((l) => l.level === "info" && l.msg === "a check changed a workspace" && l.action === actions[0]));
    assert.deepEqual(await s.running.reconcile(), [], "and nothing more is done to it");
  } finally {
    await s.close();
  }
});

test("the checks run again on a timer, one at a time, and one that fails is logged and does not end the timer", async () => {
  let calls = 0;
  let fail = false;
  let release: (() => void) | undefined;
  const s = await stack({ start: { reconcileMs: 15 } });
  try {
    Object.assign(s.running.plane.workspaces, {
      reconcile: async () => {
        calls++;
        if (fail) throw new Error("the provisioner is down at 10.0.0.9");
        if (release === undefined) await new Promise<void>((resolve) => (release = resolve));
        return [];
      },
    });
    await waitFor("a check to start", () => calls >= 1);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(calls, 1, "a check that is still running is not started again on top of itself");
    const together = [s.running.reconcile(), s.running.reconcile()];
    assert.equal(together[0], together[1], "two asks for a check at once are one check");
    release!();
    await Promise.all(together);
    await waitFor("the timer to run it again", () => calls >= 3);
    fail = true;
    await waitFor("a failure to be logged", () => s.logs.some((l) => l.level === "error" && l.msg === "the checks on workspaces failed"));
    const before = calls;
    await waitFor("the timer to go on", () => calls > before + 1);
    assert.match(String(s.logs.find((l) => l.msg === "the checks on workspaces failed")?.error), /Error: the provisioner is down at 10\.0\.0\.9/);
  } finally {
    await s.close();
  }
});

// ---- down ----

test("a payment provider given to the start is the one customers are sent to, whatever the configuration names", async () => {
  const billing = new RecordingBilling();
  const s = await stack({ start: { billing } });
  try {
    const ada = await signedUp(s);
    const out = await ada.post("/api/checkout", { purpose: "subscription", plan: "team" });
    assert.equal(out.status, 200);
    assert.match(out.json.url, /^https:\/\/pay\.example\/c\//, "not the configuration's manual page");
    assert.equal(billing.checkouts.length, 1);
    assert.equal(billing.checkouts[0]!.accountId, ada.accountId);
  } finally {
    await s.close();
  }
});

test("stopping ends the hosts that were this process's children, and leaves alone what a provisioner keeps running by itself", async () => {
  let stopped = 0;
  const children = Object.assign(new FakeProvisioner(), { stopAll: async () => void stopped++ });
  const a = await stack({ start: { provisioner: children } });
  await a.running.stop(0);
  assert.equal(stopped, 1);
  await a.admin.close(0);
  a.w.done();

  const b = await stack();
  await b.running.stop(0);
  assert.equal((b.provisioner as FakeProvisioner & { stopAll?: unknown }).stopAll, undefined, "a container is not stopped because the control plane is");
  assert.equal(b.provisioner.ops("suspend").length, 0);
  await b.admin.close(0);
  b.w.done();
});

test("stopping closes both listeners and the log, so the same log can be opened again, and a second process on it is refused", async () => {
  const w = workdir((raw) => ((raw.gateway.admin_url = "http://127.0.0.1:9"), (raw.public = { host: "127.0.0.1", port: 0, trust_proxy_hops: 0 })));
  const config = () => loadControlConfig(w.file, ENV, { publicKeys: { k1: w.publicKey } });
  const options = { provisioner: new FakeProvisioner(), log: () => undefined, reconcileMs: 3_600_000 };
  try {
    const first = await startControl(config(), options);
    const port = first.public.port;
    assert.ok(fs.existsSync(`${config().logPath}.lock`), "the log is held");
    await assert.rejects(() => startControl(config(), options), /control log|lock|another process/i);
    assert.equal((await ask(port, { host: APP_HOST, path: "/healthz" })).status, 200, "the refused start did not disturb the one running");
    await first.stop(0);
    await assert.rejects(() => ask(port, { host: APP_HOST, path: "/healthz" }), /ECONNREFUSED|ECONNRESET/);
    assert.equal(fs.existsSync(`${config().logPath}.lock`), false, "the log was released");
    const again = await startControl(config(), options);
    assert.equal((await ask(again.public.port, { host: APP_HOST, path: "/healthz" })).status, 200);
    await again.stop(0);
  } finally {
    w.done();
  }
});

test("a start that cannot bind its listeners leaves nothing behind: the log is released and the listener that did bind is closed", async () => {
  const taken = http.createServer();
  await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", () => resolve()));
  const busy = (taken.address() as { port: number }).port;
  const free = http.createServer();
  await new Promise<void>((resolve) => free.listen(0, "127.0.0.1", () => resolve()));
  const spare = (free.address() as { port: number }).port;
  await new Promise<void>((resolve) => free.close(() => resolve()));
  const w = workdir((raw) => ((raw.gateway.admin_url = "http://127.0.0.1:9"), (raw.public = { host: "127.0.0.1", port: spare, trust_proxy_hops: 0 }), (raw.owner = { host: "127.0.0.1", port: busy, token_env: "CONTROL_OWNER_TOKEN" })));
  const config = loadControlConfig(w.file, ENV, { publicKeys: { k1: w.publicKey } });
  try {
    await assert.rejects(() => startControl(config, { provisioner: new FakeProvisioner(), log: () => undefined }), /EADDRINUSE/);
    assert.equal(fs.existsSync(`${config.logPath}.lock`), false, "the log is not left held");
    const probe = http.createServer();
    await new Promise<void>((resolve, reject) => probe.once("error", reject).listen(spare, "127.0.0.1", () => resolve()));
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  } finally {
    await new Promise<void>((resolve) => taken.close(() => resolve()));
    w.done();
  }
});

test("a stop gives requests in flight the time it was told and then ends them, and a workspace still being made is waited for no longer than that", async () => {
  const host = await fakeHost((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
  });
  const s = await stack();
  try {
    s.provisioner.upstream = { host: "127.0.0.1", port: host.port };
    const ada = await signedUp(s);
    await s.running.plane.billing.apply({ type: "payment.succeeded", ref: "inv_1", purpose: "subscription", accountId: ada.accountId, plan: "team", amountMinor: 14_900, currency: "USD", at: new Date(s.clock.now).toISOString() });
    const made = await ada.post("/api/workspaces", { name: "Main" });
    await s.running.plane.workspaces.idle();
    const open = new URL((await ada.post(`/api/workspaces/${made.json.workspace.workspaceId}/open`)).json.url);
    const wsCookie = String((await ask(s.running.public.port, { host: open.host, path: `${open.pathname}${open.search}` })).headers["set-cookie"]![0]).split(";")[0]!;
    const stream = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: s.running.public.port, path: "/events", headers: { host: open.host, cookie: wsCookie }, agent: false }, resolve);
      req.on("error", reject);
      req.end();
    });
    let ended = false;
    stream.on("data", () => undefined);
    stream.on("close", () => (ended = true));
    const started = Date.now();
    await s.running.stop(150);
    assert.ok(Date.now() - started < 2_000, "a stream that would never end did not hold the stop");
    await waitFor("the stream to be ended", () => ended);
  } finally {
    await s.close();
    await host.close();
  }
});
