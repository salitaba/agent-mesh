import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { TRIAL_MODEL_ADDRESS, startTrial, type RunningTrial, type TrialPorts } from "../../apps/cloud-server/src/trial";
import { ask, type Answer, type Ask } from "../cloud/net-support";

/**
 * The hosted service, whole, with nothing faked but what costs money: the real gateway, the real control plane and its pages, and a
 * real Curule host in a process of its own for the workspace a customer makes, behind the control plane's proxy at an address of its
 * own. A person signs up, pays on the trial's page, makes a workspace, opens it, makes a team in it that runs on the service's models,
 * asks it something, and sees in their account what that was charged. The stand-in model answers every call with one sentence.
 *
 * What is under test is the seams, which no unit test crosses: the edge's credentials and origins against the host's own checks,
 * the host's environment from the provisioner, the managed models glue writing a mesh.yaml that names the gateway and not a key,
 * the virtual key from the control plane being the one that works at the gateway, and the ledger's spend reaching the account page.
 */

const PASSWORD = "correct horse battery staple";

async function freePorts(n: number): Promise<number[]> {
  const servers = await Promise.all(
    Array.from({ length: n }, () => new Promise<net.Server>((resolve) => {
      const s = net.createServer();
      s.listen(0, "127.0.0.1", () => resolve(s));
    })),
  );
  const ports = servers.map((s) => (s.address() as net.AddressInfo).port);
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  return ports;
}

async function portsForTrial(): Promise<TrialPorts> {
  const [app, owner, pay, gatewayTenant, gatewayAdmin] = await freePorts(5);
  return { app: app!, owner: owner!, pay: pay!, gatewayTenant: gatewayTenant!, gatewayAdmin: gatewayAdmin! };
}

async function until<T>(what: string, look: () => Promise<T | undefined | false> | T | undefined | false, ms = 90_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await look();
    if (v) return v;
    if (Date.now() > end) throw new Error(`still waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

class Customer {
  cookie = "";
  constructor(
    readonly t: RunningTrial,
    readonly ports: TrialPorts,
  ) {}

  /** The control plane's public API, as the account pages call it. */
  api(method: string, at: string, json?: unknown): Promise<Answer> {
    return ask(this.ports.app, { host: `localhost:${this.ports.app}`, method, path: at, ...(json !== undefined ? { json } : {}), headers: { ...(method !== "GET" ? { origin: this.t.appUrl } : {}), ...(this.cookie ? { cookie: this.cookie } : {}) } });
  }

  mailTo(email: string, kind: string): { text: string }[] {
    return (fs.existsSync(this.t.outboxPath) ? fs.readFileSync(this.t.outboxPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { to: string; kind: string; text: string }) : []).filter((m) => m.to === email && m.kind === kind);
  }

  async signUpAndConfirm(email: string): Promise<void> {
    assert.equal((await this.api("POST", "/api/signup", { email, password: PASSWORD })).status, 202);
    const mail = await until("the confirmation mail", () => this.mailTo(email, "verify").at(-1));
    const token = new URL(/https?:\/\/\S+/.exec(mail.text)![0]).searchParams.get("token")!;
    const verified = await this.api("POST", "/api/verify", { token });
    assert.equal(verified.status, 200, verified.body);
    this.cookie = String(verified.headers["set-cookie"]![0]).split(";")[0]!;
  }

  /** What a person does on the pages: asks for a checkout, is sent to the trial's page, and presses its button. */
  async pay(body: Record<string, unknown>): Promise<Answer> {
    const checkout = await this.api("POST", "/api/checkout", body);
    assert.equal(checkout.status, 200, checkout.body);
    const url = new URL(checkout.json.url as string);
    assert.equal(`${url.protocol}//${url.host}`, this.t.payUrl, "the payment page is the trial's");
    const page = await ask(this.ports.pay, { path: `${url.pathname}${url.search}` });
    assert.equal(page.status, 200);
    assert.match(page.body, /Nothing is charged and no card is asked for/);
    const pressed = await ask(this.ports.pay, { method: "POST", path: "/pay", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `ref=${encodeURIComponent(url.searchParams.get("ref")!)}` });
    assert.equal(pressed.status, 303);
    assert.equal(pressed.headers.location, `${this.t.appUrl}/account?paid=1`, "and it sends the person back to their account");
    return page;
  }
}

/** The workspace's own address, and the cookie it gives for it. */
async function enter(c: Customer, workspaceId: string) {
  const opened = await c.api("POST", `/api/workspaces/${workspaceId}/open`);
  assert.equal(opened.status, 200, opened.body);
  const url = new URL(opened.json.url as string);
  assert.match(url.host, /^[a-z0-9-]+\.localhost:\d+$/);
  const entered = await ask(c.ports.app, { host: url.host, path: `${url.pathname}${url.search}` });
  assert.equal(entered.status, 302, entered.body);
  const cookie = String(entered.headers["set-cookie"]![0]).split(";")[0]!;
  const origin = `http://${url.host}`;
  const at = (a: Ask = {}): Promise<Answer> => ask(c.ports.app, { host: url.host, ...a, headers: { cookie, ...(a.method && a.method !== "GET" ? { origin } : {}), ...a.headers } });
  return { host: url.host, cookie, origin, at };
}

test("a customer signs up, pays on the trial's page, makes a workspace, makes a team in it that runs on the service's models, and sees what that cost", { timeout: 240_000 }, async () => {
  const ports = await portsForTrial();
  const said: string[] = [];
  const t = await startTrial({ ports, reconcileMs: 600_000, out: (line) => void said.push(line) });
  try {
    const c = new Customer(t, ports);
    assert.ok(t.notes.some((n) => /no licence key: workspaces run on the Community plan's limits/.test(n)), "what the configuration warns of is kept for whoever starts it to read");

    // ---- the front door: plans, with the periods the pages state ----
    const plans = await c.api("GET", "/api/plans");
    assert.deepEqual(plans.json.plans.map((p: { id: string }) => p.id), ["team", "business"]);
    assert.deepEqual(plans.json.policy, { sessionDays: 30, idleDays: 14, verificationHours: 24, resetHours: 2, graceDays: 3, retentionDays: 30 });
    assert.equal((await ask(ports.app, { host: `localhost:${ports.app}`, path: "/" })).status, 200, "the pages are served");
    assert.deepEqual((await c.api("GET", "/api/session")).json, { account: null });

    // ---- signing up, paying ----
    const email = "ada@example.com";
    await c.signUpAndConfirm(email);
    await until("the mail to be printed where the trial says things", () => said.find((l) => l.startsWith(`mail to ${email}: Confirm your Curule account\n  ${t.appUrl}/verify?token=`)));
    assert.equal((await c.api("GET", "/api/session")).json.account.email, email);
    assert.equal((await c.api("GET", "/api/me")).json.account.subscription, null);
    const page = await c.pay({ purpose: "subscription", plan: "team" });
    assert.match(page.body, /Team, \$49\.00 a month/);
    let me = (await c.api("GET", "/api/me")).json;
    assert.deepEqual([me.account.subscription.plan, me.account.subscription.status], ["team", "active"]);
    assert.equal(me.balance.balance.included, 10_000_000, "the plan's usage is in the balance");

    // Pressing the button a second time, or going back to it, pays once.
    const ref = new URL((await c.api("POST", "/api/checkout", { purpose: "topup", amountMinor: 1_000 })).json.url as string).searchParams.get("ref")!;
    for (let i = 0; i < 2; i++) assert.equal((await ask(ports.pay, { method: "POST", path: "/pay", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `ref=${ref}` })).status, 303);
    me = (await c.api("GET", "/api/me")).json;
    assert.equal(me.balance.balance.purchased, 100_000_000 / 10, "a ten dollar top-up is ten dollars of credit, once");
    assert.equal((await ask(ports.pay, { path: "/pay?ref=trial_nothing" })).status, 404, "and a link the trial did not make is not a payment");

    // ---- a workspace: a real host process, started by the control plane ----
    const made = await c.api("POST", "/api/workspaces", { name: "Research" });
    assert.equal(made.status, 201, made.body);
    const workspaceId = made.json.workspace.workspaceId as string;
    const running = await until("the workspace to run", async () => {
      const w = ((await c.api("GET", "/api/me")).json.account.workspaces as Array<{ workspaceId: string; status: string; statusReason?: string }>).find((x) => x.workspaceId === workspaceId)!;
      if (w.status === "failed") throw new Error(`the workspace failed: ${w.statusReason}\n${fs.readFileSync(path.join(t.dir, "workspaces", workspaceId, "host.log"), "utf8")}`);
      return w.status === "running" ? w : undefined;
    });
    assert.ok(running);
    const hostLog = fs.readFileSync(path.join(t.dir, "workspaces", workspaceId, "host.log"), "utf8");
    assert.match(hostLog, /curule host online at http:\/\/127\.0\.0\.1:\d+/, "what the host said is kept");

    // ---- through the edge: the host's own pages and API, with the host's own checks ----
    const w = await enter(c, workspaceId);
    const dashboard = await w.at({ path: "/" });
    assert.equal(dashboard.status, 200);
    assert.match(String(dashboard.headers["content-type"]), /text\/html/);
    assert.deepEqual((await w.at({ path: "/auth/status" })).json, { required: true, authenticated: true }, "the host is asked as its operator, which the browser never is");
    assert.equal((await ask(ports.app, { host: w.host, path: "/auth/status" })).status === 200 && (await ask(ports.app, { host: w.host, path: "/api/projects" })).status === 200, false, "with no cookie nothing of the workspace is shown");

    // ---- the host knows it is given its models, so a team made on it needs no key ----
    const templates = (await w.at({ path: "/api/templates" })).json;
    const team = templates.templates.find((x: { id: string }) => x.id === "default");
    assert.equal(team.runtime, "native");
    const created = await w.at({ method: "POST", path: "/api/projects", json: { root: team.suggestedRoot, template: "default" } });
    assert.equal(created.status, 201, created.body);
    const projectId = created.json.id as string;
    const meshYaml = fs.readFileSync(path.join(team.suggestedRoot, "mesh.yaml"), "utf8");
    assert.match(meshYaml, /kind: openai-compatible/);
    assert.ok(meshYaml.includes(`base_url: ${t.gatewayUrl}/v1`), "the team names the service's gateway");
    assert.match(meshYaml, /api_key_env: CURULE_GATEWAY_KEY/);
    assert.doesNotMatch(meshYaml, /curule_vk_|sk-ant|ANTHROPIC/, "and holds no key, and no other vendor");

    // ---- a call to the model, from the workspace, through the gateway, to the stand-in ----
    const opened = await w.at({ method: "POST", path: `/api/projects/${projectId}/open` });
    assert.equal(opened.status, 200, opened.body);
    assert.equal(opened.json.status, "open", opened.body);
    assert.equal(t.standIn.calls, 0);
    const chat = await w.at({ method: "POST", path: `/api/p/${projectId}/designer/chat/stream`, json: { messages: [{ role: "user", content: "A team of two: an architect and a reviewer." }], currentConfig: null } });
    assert.equal(chat.status, 200, chat.body);
    assert.match(chat.body, /This is the trial's stand-in model/, chat.body.slice(0, 400));
    assert.ok(t.standIn.calls >= 1, "the call reached the stand-in");

    // ---- and the customer sees it, as what they were charged ----
    const usage = await until("the usage", async () => {
      const u = (await c.api("GET", "/api/usage")).json;
      return u.total.calls >= 1 ? u : undefined;
    });
    assert.deepEqual(usage.byWorkspace.map((g: { group: string }) => g.group), [workspaceId]);
    assert.ok(usage.total.chargedMicros > 0 && usage.total.inputTokens > 0 && usage.total.outputTokens > 0);
    assert.ok(!JSON.stringify(usage).includes("cost"), "what the model cost the service is not shown");
    me = (await c.api("GET", "/api/me")).json;
    assert.equal(me.balance.balance.included, 10_000_000 - usage.total.chargedMicros, "the plan's usage is spent first");
    assert.equal(me.balance.balance.purchased, 10_000_000, "and the credit that was bought is not touched");

    // ---- pausing stops the host; resuming starts it again; signing out takes the workspace away ----
    assert.equal((await c.api("POST", `/api/workspaces/${workspaceId}/suspend`)).status, 200);
    const paused = await w.at({ path: "/healthz" });
    assert.equal(paused.status, 503, "a workspace that is stopped says so");
    assert.equal((await c.api("POST", `/api/workspaces/${workspaceId}/resume`)).status, 200);
    assert.equal((await w.at({ path: "/healthz" })).status, 200);
    await c.api("POST", "/api/logout");
    assert.notEqual((await w.at({ path: "/auth/status" })).status, 200, "a session that is over is a workspace that is closed");
    c.cookie = "";
    const again = await c.api("POST", "/api/login", { email, password: PASSWORD });
    assert.equal(again.status, 200);
    c.cookie = String(again.headers["set-cookie"]![0]).split(";")[0]!;

    // ---- deleting takes the host and its files ----
    assert.equal((await c.api("POST", `/api/workspaces/${workspaceId}/delete`, { confirm: "wrong" })).status, 400);
    assert.equal((await c.api("POST", `/api/workspaces/${workspaceId}/delete`, { confirm: "Research" })).status, 200);
    assert.equal(fs.existsSync(path.join(t.dir, "workspaces", workspaceId)), false);
    assert.equal((await c.api("GET", "/api/me")).json.account.workspaces.length, 0);
  } finally {
    await t.stop(0);
  }
  assert.equal(fs.existsSync(t.dir), false, "a trial that made its folder removes it");
});

test("on a hosting-only trial a customer pays for hosting, makes a workspace that has no model, gives it a key that points at the stand-in, and the team made in it answers through that key", { timeout: 240_000 }, async () => {
  const ports = await portsForTrial();
  const t = await startTrial({ ports, hostingOnly: true, reconcileMs: 600_000 });
  const KEY = "any-key-12345";
  try {
    const c = new Customer(t, ports);
    assert.equal(t.gateway, undefined, "there is no gateway: nothing is sold but hosting");

    // ---- plans that sell hosting, and an account with no balance, no usage and no credit to buy ----
    const plans = await c.api("GET", "/api/plans");
    assert.deepEqual(plans.json.plans.map((p: { id: string; byok?: boolean }) => [p.id, p.byok]), [["team", true], ["business", true]]);
    assert.equal(plans.json.topups, null);
    await c.signUpAndConfirm("ada@example.com");
    const page = await c.pay({ purpose: "subscription", plan: "team" });
    assert.match(page.body, /Team, \$49\.00 a month/);
    const me = (await c.api("GET", "/api/me")).json;
    assert.deepEqual([me.account.subscription.plan, me.account.subscription.status, me.balance], ["team", "active", null]);
    assert.equal((await c.api("GET", "/api/usage")).json.error.code, "no_usage");
    assert.equal((await c.api("POST", "/api/checkout", { purpose: "topup", amountMinor: 1_000 })).json.error.code, "no_topups");

    // ---- a workspace: a real host, with no model until the customer gives it a key ----
    const made = await c.api("POST", "/api/workspaces", { name: "Research" });
    assert.equal(made.status, 201, made.body);
    const workspaceId = made.json.workspace.workspaceId as string;
    const view = async () => {
      const w = ((await c.api("GET", "/api/me")).json.account.workspaces as Array<{ workspaceId: string; status: string; statusReason?: string; models?: { key: unknown } }>).find((x) => x.workspaceId === workspaceId)!;
      if (w.status === "failed") throw new Error(`the workspace failed: ${w.statusReason}\n${fs.readFileSync(path.join(t.dir, "workspaces", workspaceId, "host.log"), "utf8")}`);
      return w;
    };
    const running = await until("the workspace to run", async () => ((await view()).status === "running" ? view() : undefined));
    assert.deepEqual(running.models, { source: "own", key: null });
    let w = await enter(c, workspaceId);
    const before = (await w.at({ path: "/api/templates" })).json;
    assert.deepEqual([before.managed, before.modelAccess], [false, []], "the host has no model, and says so");

    // ---- the key: the route the account page calls, with the address the trial hands out and any key ----
    const keyed = await c.api("POST", `/api/workspaces/${workspaceId}/model-key`, { provider: "openai-compatible", model: "stand-in", baseUrl: TRIAL_MODEL_ADDRESS, key: KEY });
    assert.equal(keyed.status, 200, keyed.body);
    assert.deepEqual([keyed.json.workspace.models.key.provider, keyed.json.workspace.models.key.model, keyed.json.workspace.models.key.baseUrl], ["openai-compatible", "stand-in", TRIAL_MODEL_ADDRESS]);
    assert.ok(!keyed.body.includes(KEY), "the key is never in an answer");
    await until("the workspace to run again, with its key", async () => {
      const v = await view();
      return v.status === "running" && v.models?.key !== null ? v : undefined;
    });

    // ---- the host was started again with the key: it takes the customer's own, and a team made on it names it ----
    w = await enter(c, workspaceId);
    const templates = (await w.at({ path: "/api/templates" })).json;
    assert.deepEqual([templates.managed, templates.modelSource], [true, "own"], "the host's models are the customer's own key, which the page then says");
    const team = templates.templates.find((x: { id: string }) => x.id === "default");
    assert.equal(team.runtime, "native");
    const created = await w.at({ method: "POST", path: "/api/projects", json: { root: team.suggestedRoot, template: "default" } });
    assert.equal(created.status, 201, created.body);
    const projectId = created.json.id as string;
    const meshYaml = fs.readFileSync(path.join(team.suggestedRoot, "mesh.yaml"), "utf8");
    assert.match(meshYaml, /kind: openai-compatible/);
    assert.ok(meshYaml.includes(`base_url: ${TRIAL_MODEL_ADDRESS}`), "the team names the address the customer gave");
    assert.match(meshYaml, /api_key_env: CURULE_MODEL_KEY/);
    assert.ok(!meshYaml.includes(KEY), "and holds no key");

    // ---- a call to the model, from the workspace, to the address the customer gave: the stand-in answers it ----
    assert.equal(t.standIn.calls, 0);
    const opened = await w.at({ method: "POST", path: `/api/projects/${projectId}/open` });
    assert.equal(opened.status, 200, opened.body);
    const chat = await w.at({ method: "POST", path: `/api/p/${projectId}/designer/chat/stream`, json: { messages: [{ role: "user", content: "A team of two: an architect and a reviewer." }], currentConfig: null } });
    assert.equal(chat.status, 200, chat.body);
    assert.match(chat.body, /This is the trial's stand-in model/, chat.body.slice(0, 400));
    assert.ok(t.standIn.calls >= 1, "the call went from the workspace's host to the stand-in, by the address the customer gave");
    assert.equal((await c.api("GET", "/api/me")).json.balance, null, "and nothing was charged to a balance there is not");

    // ---- deleting the workspace deletes its key with it ----
    assert.equal((await c.api("POST", `/api/workspaces/${workspaceId}/delete`, { confirm: "Research" })).status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(t.dir, "control", "model-keys.json"), "utf8")).keys, {});
  } finally {
    await t.stop(0);
  }
});

test("a trial started again on the same folder finds its accounts, and the workspaces that were running are started again without anyone asking", { timeout: 240_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "trial-restart-"));
  const ports = await portsForTrial();
  try {
    let t = await startTrial({ dir, ports, reconcileMs: 600_000 });
    const first = new Customer(t, ports);
    await first.signUpAndConfirm("grace@example.com");
    await first.pay({ purpose: "subscription", plan: "team" });
    const workspaceId = (await first.api("POST", "/api/workspaces", { name: "Kept" })).json.workspace.workspaceId as string;
    await until("the workspace to run", async () => ((await first.api("GET", "/api/me")).json.account.workspaces[0].status === "running" ? true : undefined));
    const before = (await first.api("GET", "/api/me")).json;
    const upstream = JSON.parse(fs.readFileSync(path.join(dir, "workspaces", workspaceId, ".provision", "env.json"), "utf8")).port as number;
    assert.equal(await reachable(upstream), true, "the host is running");

    await t.stop(0);
    assert.equal(await reachable(upstream), false, "stopping the trial ends the hosts it started: they are its children");
    assert.equal(fs.existsSync(dir), true, "a folder that was named is kept");

    t = await startTrial({ dir, ports, reconcileMs: 600_000 });
    try {
      const c = new Customer(t, ports);
      const login = await c.api("POST", "/api/login", { email: "grace@example.com", password: PASSWORD });
      assert.equal(login.status, 200, "the account is there, and so is its password");
      c.cookie = String(login.headers["set-cookie"]![0]).split(";")[0]!;
      const after = (await c.api("GET", "/api/me")).json;
      assert.deepEqual(after.account.subscription, before.account.subscription);
      assert.deepEqual(after.balance, before.balance, "the balance is the gateway's, and it kept its ledger");
      await until("the host to be started again", async () => (await reachable(upstream)) || undefined, 30_000);
      const w = await enter(c, workspaceId);
      assert.equal((await w.at({ path: "/auth/status" })).status, 200, "and it is reached at the same address, with the same credential");
    } finally {
      await t.stop(0);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function reachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}
