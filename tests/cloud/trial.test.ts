import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { USAGE, main, type Io } from "../../apps/cloud-server/src/index";
import { DEFAULT_TRIAL_PORT, STAND_IN_SENTENCE, StandInModel, TRIAL_PLANS, TRIAL_PRICES, TrialBilling, createPayServer, describeTrial, startTrial, trialPorts, watchOutbox, type RunningTrial } from "../../apps/cloud-server/src/trial";
import { BillingUnsupportedError, BillingWebhookError, parseCatalogue, type BillingEvent, type CheckoutInput } from "../../packages/cloud/src/index";
import { parsePriceTable, type PriceTable } from "../../packages/ai-gateway/src/index";
import type { ModelEvent, ModelRequest } from "../../packages/llm/src/index";
import { ask, listen } from "./net-support";

// ---- the stand-in model ----

async function collect(stream: AsyncGenerator<ModelEvent, void>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

test("the stand-in answers every call with its one sentence, in words as a model streams, ends the turn, and reports usage from what it was sent", async () => {
  const model = new StandInModel();
  const request: ModelRequest = { model: "stand-in/small", system: "You are a seat.", messages: [{ role: "user", content: "Write hello.txt." }] };
  const events = await collect(model.stream(request));
  const text = events.filter((e): e is Extract<ModelEvent, { kind: "text" }> => e.kind === "text");
  assert.ok(text.length > 5, "it streams, a word at a time");
  assert.equal(text.map((e) => e.delta).join(""), STAND_IN_SENTENCE);
  const end = events.at(-1)!;
  assert.equal(end.kind, "end");
  if (end.kind !== "end") return;
  assert.deepEqual([end.result.text, end.result.toolCalls, end.result.stopReason, end.result.model], [STAND_IN_SENTENCE, [], "end_turn", "stand-in-1"]);
  assert.equal(end.result.usage.input, Math.ceil(JSON.stringify(["You are a seat.", request.messages]).length / 4), "what it was sent, four characters to a token");
  assert.equal(end.result.usage.output, Math.ceil(STAND_IN_SENTENCE.length / 4));
  assert.deepEqual([end.result.usage.cacheRead, end.result.usage.cacheWrite], [0, 0]);
  assert.equal(model.calls, 1);

  // A bigger prompt is more input; a call that was told to stop does not count.
  const more = await collect(model.stream({ ...request, messages: [{ role: "user", content: "x".repeat(4_000) }] }));
  assert.ok((more.at(-1) as Extract<ModelEvent, { kind: "end" }>).result.usage.input > 1_000);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => collect(model.stream({ ...request, signal: controller.signal })), (err: Error) => err.name === "AbortError");
  assert.equal(model.calls, 2);
  assert.equal(model.kind, "openai-compatible");
});

test("the trial's figures are a valid catalogue and a valid price table that prices every model its tiers name", () => {
  const catalogue = parseCatalogue(TRIAL_PLANS);
  assert.deepEqual(catalogue.plans().map((p) => [p.id, p.priceMinor, p.workspaces]), [["team", 4_900, 1], ["business", 19_900, 3]]);
  assert.equal(catalogue.currency, "USD");
  const prices: PriceTable = parsePriceTable(TRIAL_PRICES);
  for (const model of ["stand-in/small", "stand-in/medium", "stand-in/large"]) assert.ok(prices.get(model), model);
  assert.equal(prices.currency, catalogue.currency, "what is sold and what the models cost are in one currency");
  assert.match(TRIAL_PLANS.plans.team.summary, /not an offer/, "and the plans say they are not an offer");
});

test("a trial's ports sit beside the app's, and the default is the one the documents name", () => {
  assert.equal(DEFAULT_TRIAL_PORT, 7500);
  assert.deepEqual(trialPorts(7500), { app: 7500, owner: 7501, pay: 7502, gatewayTenant: 7510, gatewayAdmin: 7511 });
  assert.deepEqual(trialPorts(9000), { app: 9000, owner: 9001, pay: 9002, gatewayTenant: 9010, gatewayAdmin: 9011 });
});

// ---- the payment page ----

const checkout = (over: Partial<CheckoutInput> = {}): CheckoutInput => ({
  accountId: "acct_1",
  email: "ada@example.com",
  purpose: "subscription",
  plan: { id: "team", title: "Team", priceMinor: 4_900, period: "month" },
  currency: "USD",
  successUrl: "http://localhost:7500/account?paid=1",
  cancelUrl: "http://localhost:7500/account?cancelled=1",
  idempotencyKey: "k",
  ...over,
});

test("the trial's provider sends a customer to its own page with a reference of its own, and has no portal and no messages", async () => {
  const billing = new TrialBilling((ref) => `http://localhost:7502/pay?ref=${ref}`);
  const a = await billing.createCheckout(checkout());
  const b = await billing.createCheckout(checkout());
  assert.match(a.ref, /^trial_[A-Za-z0-9_-]{12}$/);
  assert.notEqual(a.ref, b.ref);
  assert.equal(a.url, `http://localhost:7502/pay?ref=${a.ref}`);
  assert.equal(billing.pending.get(a.ref)!.accountId, "acct_1");
  assert.equal(billing.name, "trial");
  await assert.rejects(() => billing.openPortal(), (err: Error) => err instanceof BillingUnsupportedError && /nothing is charged/.test(err.message));
  assert.throws(() => billing.parseWebhook(), BillingWebhookError);
});

async function payPage(over: { apply?: (e: BillingEvent) => Promise<unknown> } = {}) {
  const billing = new TrialBilling((ref) => `http://localhost:1/pay?ref=${ref}`);
  const applied: BillingEvent[] = [];
  const apply = over.apply ?? (async (e: BillingEvent) => void applied.push(e));
  const plane = { billing: { apply: async (e: BillingEvent) => apply(e) } } as never;
  const server = await listen(createPayServer(billing, () => plane, () => new Date("2026-10-05T12:00:00.000Z")));
  const form = (ref: string): Parameters<typeof ask>[1] => ({ method: "POST", path: "/pay", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `ref=${encodeURIComponent(ref)}` });
  return { billing, applied, server, port: server.port, form };
}

test("the payment page says what is being paid for and who by, says nothing is charged, and a link that is not the trial's is not a payment", async () => {
  const p = await payPage();
  try {
    const { ref } = await p.billing.createCheckout(checkout({ email: "<b>ada</b>@example.com" }));
    const page = await ask(p.port, { path: `/pay?ref=${ref}` });
    assert.equal(page.status, 200);
    assert.equal(page.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(page.headers["cache-control"], "no-store");
    assert.equal(page.headers["x-frame-options"], "DENY");
    assert.equal(page.headers["x-content-type-options"], "nosniff");
    assert.equal(page.headers["referrer-policy"], "no-referrer");
    assert.match(page.body, /^<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta name="robots" content="noindex">\n/, "a whole page, that a phone can read and a search engine is told to leave alone");
    assert.match(page.body, /<title>Pay: a trial<\/title>/);
    assert.match(page.body, /<\/style>\n<\/head>\n<body>\n<h1>Pay<\/h1>/);
    assert.match(page.body, /<\/form>\n<\/body>\n<\/html>\n$/);
    assert.match(page.body, /This is the trial's own payment page\. Nothing is charged and no card is asked for\./);
    assert.match(page.body, /Team, \$49\.00 a month/);
    assert.ok(page.body.includes("Paying as &lt;b&gt;ada&lt;/b&gt;@example.com."), "an address is text");
    assert.ok(!page.body.includes("<b>ada"));
    assert.ok(page.body.includes(`<input type="hidden" name="ref" value="${ref}">`));
    assert.ok(page.body.includes('href="http://localhost:7500/account?cancelled=1"'), "and a way back");

    const topup = await p.billing.createCheckout(checkout({ purpose: "topup", plan: undefined, amountMinor: 2_500 }));
    assert.match((await ask(p.port, { path: `/pay?ref=${topup.ref}` })).body, /Credit, \$25\.00/);

    for (const at of ["/pay?ref=trial_nothing", "/pay", "/pay?ref="]) {
      const unknown = await ask(p.port, { path: at });
      assert.equal(unknown.status, 404, at);
      assert.match(unknown.body, /This link is not one the trial made\. It may be from an earlier run\./);
    }
    assert.equal((await ask(p.port, { path: "/other" })).status, 404);
    assert.deepEqual(p.applied, [], "looking is not paying");
  } finally {
    await p.server.close();
  }
});

test("pressing the button applies the payment as a provider's message would, under the checkout's own reference, and sends the person back to their account", async () => {
  const p = await payPage();
  try {
    const sub = await p.billing.createCheckout(checkout());
    const done = await ask(p.port, p.form(sub.ref));
    assert.equal(done.status, 303);
    assert.equal(done.headers.location, "http://localhost:7500/account?paid=1");
    assert.equal(done.headers["cache-control"], "no-store");
    assert.deepEqual(p.applied, [{ type: "payment.succeeded", ref: sub.ref, purpose: "subscription", plan: "team", accountId: "acct_1", amountMinor: 4_900, currency: "USD", at: "2026-10-05T12:00:00.000Z" }]);

    const topup = await p.billing.createCheckout(checkout({ purpose: "topup", plan: undefined, amountMinor: 2_500 }));
    await ask(p.port, p.form(topup.ref));
    assert.deepEqual(p.applied[1], { type: "payment.succeeded", ref: topup.ref, purpose: "topup", accountId: "acct_1", amountMinor: 2_500, currency: "USD", at: "2026-10-05T12:00:00.000Z" }, "a top-up names no plan");

    // The same reference is the same payment, so pressing again, or going back to it, says the same thing to the service.
    await ask(p.port, p.form(sub.ref));
    assert.equal(p.applied.length, 3);
    assert.equal(p.applied[2]!.ref, sub.ref);

    for (const bad of [p.form("trial_nothing"), { method: "POST", path: "/pay", body: "" }]) assert.equal((await ask(p.port, bad)).status, 404, "a reference that is not the trial's, or none, pays nothing");
    const large = await ask(p.port, { method: "POST", path: "/pay", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `ref=${sub.ref}&pad=${"x".repeat(5_000)}` });
    assert.equal(large.status, 413, "and neither does a body larger than a payment is");
    assert.equal(p.applied.length, 3);
    const other = await ask(p.port, { method: "DELETE", path: "/pay" });
    assert.deepEqual([other.status, other.headers.allow], [405, "GET, POST"]);
    // A form of 4096 bytes is a payment, and one byte more is not.
    const sized = (bytes: number): Parameters<typeof ask>[1] => {
      const head = `ref=${sub.ref}&pad=`;
      return { method: "POST", path: "/pay", headers: { "content-type": "application/x-www-form-urlencoded" }, body: head + "x".repeat(bytes - Buffer.byteLength(head)) };
    };
    const before = p.applied.length;
    assert.equal((await ask(p.port, sized(4_096))).status, 303);
    assert.equal(p.applied.length, before + 1);
    assert.equal((await ask(p.port, sized(4_097))).status, 413);
    assert.equal(p.applied.length, before + 1);
  } finally {
    await p.server.close();
  }
});

test("a payment that could not be applied is said, on the page, and the page goes on serving", async () => {
  let fail = true;
  const p = await payPage({
    apply: async () => {
      if (fail) throw new Error("the log cannot be written <here>");
    },
  });
  try {
    const { ref } = await p.billing.createCheckout(checkout());
    const r = await ask(p.port, p.form(ref));
    assert.equal(r.status, 500);
    assert.ok(r.body.includes("the log cannot be written &lt;here&gt;"), "the reason, as text");
    fail = false;
    assert.equal((await ask(p.port, p.form(ref))).status, 303, "and pressing the button again works once the service does");
  } finally {
    await p.server.close();
  }
});

// ---- what a person is told ----

function fakeTrial(over: Partial<RunningTrial> = {}): RunningTrial {
  return { appUrl: "http://localhost:7500", ownerUrl: "http://127.0.0.1:7501", ownerToken: "owner-token-abc", payUrl: "http://localhost:7502", gatewayUrl: "http://127.0.0.1:7510", dir: "/tmp/curule-trial-x", outboxPath: "/tmp/curule-trial-x/control/outbox.jsonl", notes: [], standIn: new StandInModel(), hostingOnly: false, control: undefined as never, gateway: undefined as never, stop: async () => undefined, ...over };
}

test("what the trial says when it is up is where everything is, what is not real, and how to stop it", () => {
  const lines = describeTrial(fakeTrial({ notes: ["no licence key: workspaces run on the Community plan's limits"] }), trialPorts(7500), false).join("\n");
  assert.match(lines, /^Curule Cloud, on this machine\. A trial: nothing here is real\./);
  for (const expected of [
    /the app\s+http:\/\/localhost:7500\n/,
    /http:\/\/<its name>\.localhost:7500/,
    /payment\s+http:\/\/localhost:7502, a page of the trial's own: nothing is charged and no card is asked for/,
    /mail\s+printed here as it is written, and kept in \/tmp\/curule-trial-x\/control\/outbox\.jsonl/,
    /models\s+a stand-in that answers every call with one sentence/,
    /the owner's API\s+http:\/\/127\.0\.0\.1:7501, with the token owner-token-abc/,
    /the gateway\s+http:\/\/127\.0\.0\.1:7510\/v1 for workspaces/,
    /everything is in\s+\/tmp\/curule-trial-x \(removed when the trial stops\)/,
    /note: no licence key: workspaces run on the Community plan's limits/,
    /Ctrl\+C stops it, and the workspaces it started\.$/,
  ]) assert.match(lines, expected);
  const kept = describeTrial(fakeTrial(), trialPorts(7500), true).join("\n");
  assert.match(kept, /\(kept: start the trial on it again and the accounts and workspaces are there\)/);
  assert.doesNotMatch(kept, /note:/);
});

test("what the trial says is these lines, with the notes in a block of their own between blank lines, and no block when there are none", () => {
  const head = [
    "Curule Cloud, on this machine. A trial: nothing here is real.",
    "",
    "  the app           http://localhost:7500",
    "  a workspace       http://<its name>.localhost:7500 (opened from the account page; a browser finds *.localhost on this machine by itself)",
    "  payment           http://localhost:7502, a page of the trial's own: nothing is charged and no card is asked for",
    "  mail              printed here as it is written, and kept in /tmp/curule-trial-x/control/outbox.jsonl",
    "  models            a stand-in that answers every call with one sentence and uses no tool. The calls go through the real gateway, so keys,",
    "                    balance and usage are real, and a mission will not get far",
    "  the owner's API   http://127.0.0.1:7501, with the token owner-token-abc",
    "  the gateway       http://127.0.0.1:7510/v1 for workspaces",
    "  everything is in  /tmp/curule-trial-x (removed when the trial stops)",
  ];
  const tail = ["", "Open the app, create an account and follow the link that is printed here. Ctrl+C stops it, and the workspaces it started."];
  assert.deepEqual(describeTrial(fakeTrial(), trialPorts(7500), false), [...head, ...tail]);
  assert.deepEqual(describeTrial(fakeTrial({ notes: ["first", "second"] }), trialPorts(7500), false), [...head, "", "  note: first", "  note: second", ...tail]);
});

// ---- the outbox, watched ----

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const eventually = async (ok: () => boolean, ms = 5_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await sleep(10);
  assert.ok(ok(), "it did not come to pass in time");
};

test("each mail the outbox gains is printed once, whole, with the link in it; what was there before is not, and a line that is half written waits for the rest", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "outbox-watch-"));
  const file = path.join(dir, "outbox.jsonl");
  const mail = (to: string, subject: string, text: string): string => JSON.stringify({ to, subject, text });
  fs.writeFileSync(file, `${mail("before@example.com", "Already there", "see https://old.example/x for this")}\n`);
  const lines: string[] = [];
  const stop = watchOutbox(file, (line) => lines.push(line));
  try {
    fs.appendFileSync(file, `${mail("ada@example.com", "Confirm your address \u00e9", "Open https://app.example/verify?token=abc to go on")}\n`);
    await eventually(() => lines.length === 1);
    const second = mail("grace@example.com", "Reset \u00fc", "No link in this one");
    fs.appendFileSync(file, second.slice(0, 20));
    await sleep(600);
    assert.equal(lines.length, 1, "a line that is not finished is not printed");
    fs.appendFileSync(file, `${second.slice(20)}\nthis line is not a mail\n${mail("c@example.com", "Third", "go to http://c.example/z now")}\n`);
    await eventually(() => lines.length === 3);
  } finally {
    stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(lines, [
    "mail to ada@example.com: Confirm your address \u00e9\n  https://app.example/verify?token=abc",
    "mail to grace@example.com: Reset \u00fc",
    "mail to c@example.com: Third\n  http://c.example/z",
  ]);
});

test("a watch that is stopped takes one last look, and a file that is not there yet is waited for", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "outbox-watch-"));
  const file = path.join(dir, "later.jsonl");
  const lines: string[] = [];
  const stop = watchOutbox(file, (line) => lines.push(line));
  try {
    await sleep(300);
    assert.deepEqual(lines, []);
    fs.writeFileSync(file, `${JSON.stringify({ to: "ada@example.com", subject: "Late", text: "https://late.example/l" })}\n`);
    stop();
    assert.deepEqual(lines, ["mail to ada@example.com: Late\n  https://late.example/l"], "what was written just before the stop is not lost");
  } finally {
    stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- a trial that is started on this machine ----

async function freePorts(n: number): Promise<number[]> {
  const servers = await Promise.all(Array.from({ length: n }, () => new Promise<net.Server>((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => resolve(s)); })));
  const ports = servers.map((s) => (s.address() as net.AddressInfo).port);
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  return ports;
}
const trialPortsOn = async () => {
  const [app, owner, pay, gatewayTenant, gatewayAdmin] = await freePorts(5);
  return { app: app!, owner: owner!, pay: pay!, gatewayTenant: gatewayTenant!, gatewayAdmin: gatewayAdmin! };
};

test("a trial keeps what it makes in a folder that is named, in the places the documents say, and what it says about failures it says on its output", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trial-folder-"));
  const said: string[] = [];
  const trial = await startTrial({ dir, ports: await trialPortsOn(), out: (line) => said.push(line), reconcileMs: 30 });
  try {
    for (const file of ["trial.json", "gateway/prices.yaml", "gateway/gateway.yaml", "gateway/ledger.jsonl", "control/plans.yaml", "control/control.yaml", "control/control.jsonl"]) {
      assert.ok(fs.existsSync(path.join(dir, file)), `${file} is kept`);
    }
    assert.equal(trial.dir, dir);
    assert.equal(trial.outboxPath, path.join(dir, "control", "outbox.jsonl"));
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "trial.json"), "utf8"));
    assert.deepEqual(Object.keys(saved).sort(), ["gatewayAdminToken", "ownerToken", "secret"]);
    assert.equal(saved.ownerToken, trial.ownerToken);
    assert.deepEqual([saved.secret.length, saved.ownerToken.length, saved.gatewayAdminToken.length], [48, 36, 36], "24 and 18 random bytes, in hex");
    assert.equal(fs.statSync(path.join(dir, "trial.json")).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(path.join(dir, "trial.json"), "utf8"), JSON.stringify(saved, null, 2), "written to be read by a person");
    assert.equal(said.length, 0, "an information record is not said");
    Object.assign(trial.control.plane.workspaces, { reconcile: async () => { throw Object.assign(new Error("the provisioner is down"), { name: "ProvisionError" }); } });
    await eventually(() => said.some((l) => l.startsWith("control: the checks on workspaces failed")));
    assert.ok(said.includes("control: the checks on workspaces failed (ProvisionError: the provisioner is down)"), JSON.stringify(said));
  } finally {
    await trial.stop(0);
  }
  assert.ok(fs.existsSync(dir), "a folder that is named is kept when the trial stops");
  const again = await startTrial({ dir, ports: await trialPortsOn() });
  try {
    assert.equal(again.ownerToken, JSON.parse(fs.readFileSync(path.join(dir, "trial.json"), "utf8")).ownerToken);
  } finally {
    await again.stop(0);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a trial that is not given a folder makes one in the temporary folder, and removes it when it stops", async () => {
  const trial = await startTrial({ ports: await trialPortsOn() });
  const dir = trial.dir;
  assert.equal(path.dirname(dir), fs.realpathSync(os.tmpdir()));
  assert.match(path.basename(dir), /^curule-trial-/);
  assert.ok(fs.existsSync(dir));
  await trial.stop(0);
  assert.equal(fs.existsSync(dir), false);
});

test("a trial whose payment page cannot have its port says so, and leaves nothing listening and no folder behind", async () => {
  const ports = await trialPortsOn();
  const taken = net.createServer();
  await new Promise<void>((resolve) => taken.listen(ports.pay, "127.0.0.1", resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trial-taken-"));
  try {
    await assert.rejects(() => startTrial({ dir, ports }), /EADDRINUSE/);
    for (const port of [ports.app, ports.owner, ports.gatewayTenant, ports.gatewayAdmin]) {
      const free = net.createServer();
      await new Promise<void>((resolve, reject) => { free.once("error", reject); free.listen(port, "127.0.0.1", resolve); });
      await new Promise<void>((resolve) => free.close(() => resolve()));
    }
  } finally {
    await new Promise<void>((resolve) => taken.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the command ----

function io(): Io & { stdout: string[]; stderr: string[]; signals: EventEmitter } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (l) => void stdout.push(l), err: (l) => void stderr.push(l), signals: new EventEmitter() };
}

const unused = (async () => {
  throw new Error("this test starts nothing else");
}) as never;

test("the usage names the trial command", () => {
  assert.match(USAGE, /trial \[--port <n>\] \[--dir <folder>\] \[--hosting-only\]\s+the whole service on this machine, with nothing real behind it/);
});

test("the trial command refuses what it cannot run, saying why, and starts nothing", async () => {
  const cases: Array<[string[], RegExp]> = [
    [["--port", "80"], /--port must be a whole number from 1024 to 65000 \(the trial uses the twelve above it too\), not '80'/],
    [["--port=abc"], /not 'abc'/],
    [["--port"], /not ''/],
    [["--port", "65001"], /not '65001'/],
    [["--port", "7500.5"], /not '7500\.5'/],
    [["--dir"], /--dir needs a folder/],
    [["--dir="], /--dir needs a folder/],
    [["--frobnicate"], /unknown option '--frobnicate'/],
  ];
  for (const [args, said] of cases) {
    const out = io();
    const code = await main(["trial", ...args], {}, out, unused, unused, (async () => {
      throw new Error("it started");
    }) as never);
    assert.equal(code, 1, args.join(" "));
    assert.match(out.stderr.join("\n"), said, args.join(" "));
    assert.match(out.stderr.join("\n"), /^curule-cloud trial: /);
    assert.equal(out.stdout.length, 0);
  }
});

test("the trial command starts the trial on the ports beside the one it was given, says where everything is, and on a stop signal stops it and the workspaces", async () => {
  const out = io();
  const seen: Array<{ ports: unknown; dir?: string; said: boolean }> = [];
  let stopped = 0;
  const code = main(
    ["trial", "--port", "9000", "--dir", "/tmp/kept-trial"],
    {},
    out,
    unused,
    unused,
    (async (options: { ports: unknown; dir?: string; out: (l: string) => void }) => {
      options.out("mail to ada@example.com: Confirm your email address");
      seen.push({ ports: options.ports, ...(options.dir !== undefined ? { dir: options.dir } : {}), said: true });
      return fakeTrial({ appUrl: "http://localhost:9000", dir: "/tmp/kept-trial", stop: async () => void stopped++ });
    }) as never,
  );
  for (let i = 0; i < 500 && out.signals.listenerCount("SIGTERM") === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(seen, [{ ports: trialPorts(9000), dir: "/tmp/kept-trial", said: true }]);
  assert.ok(out.stdout.includes("mail to ada@example.com: Confirm your email address"), "what the trial says goes where the command says things");
  assert.match(out.stdout.join("\n"), /the app\s+http:\/\/localhost:9000/);
  assert.match(out.stdout.join("\n"), /\(kept: start the trial on it again/, "a named folder is said to be kept");
  out.signals.emit("SIGINT");
  assert.equal(await code, 0);
  assert.equal(stopped, 1);
  assert.ok(out.stdout.includes("SIGINT: stopping, and ending the workspaces' hosts"));

  // With no folder named there is none to keep, and with no port the default is used.
  const plain = io();
  let ports: unknown;
  let dir: unknown = "unset";
  const second = main(["trial"], {}, plain, unused, unused, (async (options: { ports: unknown; dir?: string }) => {
    ports = options.ports;
    dir = options.dir;
    return fakeTrial();
  }) as never);
  for (let i = 0; i < 500 && plain.signals.listenerCount("SIGTERM") === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(ports, trialPorts(7500));
  assert.equal(dir, undefined);
  assert.match(plain.stdout.join("\n"), /\(removed when the trial stops\)/);
  plain.signals.emit("SIGTERM");
  assert.equal(await second, 0);
});

test("a trial that cannot start is a failure with the reason, and one that cannot stop says so", async () => {
  const out = io();
  assert.equal(
    await main(["trial"], {}, out, unused, unused, (async () => {
      throw new Error("listen EADDRINUSE: address already in use 127.0.0.1:7500");
    }) as never),
    1,
  );
  assert.match(out.stderr.join("\n"), /^curule-cloud trial: listen EADDRINUSE/);
  assert.equal(out.stdout.length, 0);

  const stuck = io();
  const code = main(["trial"], {}, stuck, unused, unused, (async () =>
    fakeTrial({
      stop: async () => {
        throw new Error("a host would not end");
      },
    })) as never);
  for (let i = 0; i < 500 && stuck.signals.listenerCount("SIGINT") === 0; i++) await new Promise((r) => setTimeout(r, 10));
  stuck.signals.emit("SIGINT");
  assert.equal(await code, 1);
  assert.match(stuck.stderr.join("\n"), /curule-cloud trial: stopping failed: a host would not end/);
});
