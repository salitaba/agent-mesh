import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { USAGE, describeGateway, main, type Io } from "../../apps/cloud-server/src/index";
import { loadGatewayConfig, type startGateway } from "../../packages/ai-gateway/src/index";

const TOKEN = "admin-token-0123456789-abcdefgh";
const PRICES = `currency: USD
version: "2026-10-05"
default_markup: 1.25
models:
  alpha/small: { input: 1, output: 4, cache_read: 0.1, cache_write: 1.25 }
  beta/other: { input: 2, output: 8, cache_read: 0.2, cache_write: 0, markup: 2 }
`;
const CONFIG = `ledger: ./ledger.jsonl
prices: ./prices.yaml
tenant: { host: 127.0.0.1, port: 0 }
admin: { host: 127.0.0.1, port: 0, token_env: GATEWAY_ADMIN_TOKEN }
providers:
  alpha: { kind: openai-compatible, base_url: "https://api.alpha.example/v1", api_key_env: ALPHA_KEY }
  beta: { kind: anthropic }
tiers:
  fast: [alpha/small]
  balanced: [ { model: alpha/small, max_output_tokens: 4000 }, beta/other ]
`;

function setup(config = CONFIG): { dir: string; file: string; done: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-server-"));
  fs.writeFileSync(path.join(dir, "prices.yaml"), PRICES);
  fs.writeFileSync(path.join(dir, "gateway.yaml"), config);
  return { dir, file: path.join(dir, "gateway.yaml"), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function io(): Io & { stdout: string[]; stderr: string[]; signals: EventEmitter } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (l) => void stdout.push(l), err: (l) => void stderr.push(l), signals: new EventEmitter() };
}

const ENV = { ALPHA_KEY: "alpha-secret-value", GATEWAY_ADMIN_TOKEN: TOKEN };

/** The gateway listens for a stop signal only once it is running; a signal sent before that would be lost. */
async function untilRunning(signals: EventEmitter): Promise<void> {
  for (let i = 0; i < 500 && signals.listenerCount("SIGTERM") === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(signals.listenerCount("SIGTERM") > 0, "the gateway never started");
}

test("with no command, or one that does not exist, the usage is shown and the exit is a failure; help is a success", async () => {
  const none = io();
  assert.equal(await main([], ENV, none), 1);
  assert.equal(none.stderr.join("\n"), USAGE);
  const odd = io();
  assert.equal(await main(["serve"], ENV, odd), 1);
  assert.match(odd.stderr.join("\n"), /unknown command 'serve'/);
  for (const flag of ["help", "--help", "-h"]) {
    const help = io();
    assert.equal(await main([flag], ENV, help), 0);
    assert.equal(help.stdout.join("\n"), USAGE);
  }
});

test("the gateway needs a configuration, and an option it does not know is named", async () => {
  const a = io();
  assert.equal(await main(["gateway"], ENV, a), 1);
  assert.match(a.stderr.join("\n"), /--config is required/);
  const b = io();
  assert.equal(await main(["gateway", "--config", "x.yaml", "--frobnicate"], ENV, b), 1);
  assert.match(b.stderr.join("\n"), /unknown option '--frobnicate'/);
});

test("--check says what the gateway would run, without a key or a token in it, and without listening", async () => {
  const w = setup();
  try {
    const out = io();
    assert.equal(await main(["gateway", "--config", w.file, "--check"], ENV, out), 0);
    const text = out.stdout.join("\n");
    assert.match(text, /currency USD, prices 2026-10-05/);
    assert.match(text, /workspaces connect on 127\.0\.0\.1:0; the admin API is on 127\.0\.0\.1:0/);
    assert.match(text, /alpha: openai-compatible at api\.alpha\.example, key from ALPHA_KEY/);
    assert.match(text, /beta: anthropic at \(the provider's default address\), no key/);
    assert.match(text, /fast:\n\s+first alpha\/small: USD 1\.00 in, USD 4\.00 out per million tokens at cost, charged at 1\.25x; answers up to 16384 tokens/);
    assert.match(text, /then\s+beta\/other: USD 2\.00 in, USD 8\.00 out per million tokens at cost, charged at 2x/);
    assert.match(text, /answers up to 4000 tokens/);
    assert.match(text, /limits: 120 calls a minute and 16 open at once per key by default; one call holds back at most USD 2\.00; 600s deadline/);
    assert.match(text, /the model that answered is shown to callers/);
    assert.match(text, /the configuration is valid$/);
    for (const secret of ["alpha-secret-value", TOKEN]) assert.ok(!text.includes(secret), `the output holds '${secret}'`);
    assert.equal(fs.existsSync(path.join(w.dir, "ledger.jsonl")), false, "checking opens no ledger");
  } finally {
    w.done();
  }
});

test("--check on a configuration that cannot work prints the problems and fails; so does starting it", async () => {
  const w = setup(CONFIG.replace("api_key_env: ALPHA_KEY", "api_key_env: NOT_SET"));
  try {
    for (const args of [["gateway", "--config", w.file, "--check"], ["gateway", `--config=${w.file}`]]) {
      const out = io();
      assert.equal(await main(args, ENV, out), 1);
      assert.match(out.stderr.join("\n"), /the environment variable NOT_SET is not set/);
      assert.deepEqual(out.stdout, []);
    }
  } finally {
    w.done();
  }
});

test("a gateway that cannot start says why and exits with a failure, and one that can runs until it is told to stop, finishes, and exits cleanly", async () => {
  const w = setup();
  try {
    // The ledger's directory is a file: the gateway cannot open it.
    fs.writeFileSync(path.join(w.dir, "blocked"), "x");
    const blocked = setup(CONFIG.replace("ledger: ./ledger.jsonl", "ledger: ./blocked/ledger.jsonl"));
    fs.writeFileSync(path.join(blocked.dir, "blocked"), "x");
    const failing = io();
    assert.equal(await main(["gateway", "--config", blocked.file], ENV, failing), 1);
    assert.match(failing.stderr.join("\n"), /^curule-cloud gateway: /);
    blocked.done();

    const running = io();
    const done = main(["gateway", "--config", w.file], ENV, running);
    await untilRunning(running.signals);
    assert.ok(fs.existsSync(path.join(w.dir, "ledger.jsonl")), "the gateway opened its ledger");
    running.signals.emit("SIGTERM");
    assert.equal(running.signals.listenerCount("SIGINT"), 0, "the first signal takes away the listener for the other one too");
    assert.equal(running.signals.listenerCount("SIGTERM"), 0);
    assert.equal(running.signals.emit("SIGINT"), false, "a second signal finds nothing to handle it, so it does what the process does by default and ends it");
    assert.equal(await done, 0);
    assert.match(running.stdout.join("\n"), /^SIGTERM: no longer taking calls; finishing the ones in flight$/m);
    assert.equal(running.stdout.filter((l) => l.includes("no longer taking calls")).length, 1, "one shutdown, not two");
    assert.equal(fs.existsSync(path.join(w.dir, "ledger.jsonl.lock")), false, "the ledger was released");
  } finally {
    w.done();
  }
});

test("a SIGINT stops it the same way", async () => {
  const w = setup();
  try {
    const running = io();
    const done = main(["gateway", "--config", w.file], ENV, running);
    await untilRunning(running.signals);
    running.signals.emit("SIGINT");
    assert.equal(running.signals.listenerCount("SIGTERM"), 0, "and the listener for the other signal goes with it");
    assert.equal(await done, 0);
    assert.match(running.stdout.join("\n"), /SIGINT: no longer taking calls/);
  } finally {
    w.done();
  }
});

test("a gateway that fails while stopping says so and exits with a failure, so what supervises it knows the ledger may not have been closed", async () => {
  const w = setup();
  try {
    const running = io();
    let stops = 0;
    const start = (async () => ({
      stop: async () => {
        stops++;
        throw new Error("the disk went away");
      },
    })) as unknown as typeof startGateway;
    const done = main(["gateway", "--config", w.file], ENV, running, start);
    await untilRunning(running.signals);
    running.signals.emit("SIGTERM");
    assert.equal(await done, 1);
    assert.equal(stops, 1);
    assert.equal(running.stderr.join("\n"), "curule-cloud gateway: stopping failed: the disk went away");
  } finally {
    w.done();
  }
});

test("a start that fails is reported with the command's name and the reason, and nothing is left listening for signals", async () => {
  const w = setup();
  try {
    const failing = io();
    const start = (async () => {
      throw new Error("the port is taken");
    }) as unknown as typeof startGateway;
    assert.equal(await main(["gateway", "--config", w.file], ENV, failing, start), 1);
    assert.equal(failing.stderr.join("\n"), "curule-cloud gateway: the port is taken");
    assert.equal(failing.signals.listenerCount("SIGTERM"), 0);
    assert.equal(failing.signals.listenerCount("SIGINT"), 0);
  } finally {
    w.done();
  }
});

test("describing a gateway shows a hidden upstream model as hidden", () => {
  const w = setup(CONFIG + "expose_upstream_model: false\n");
  try {
    const lines = describeGateway(loadGatewayConfig(w.file, ENV));
    assert.ok(lines.includes("the model that answered is hidden from callers"));
  } finally {
    w.done();
  }
});
