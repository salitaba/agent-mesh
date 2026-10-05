import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { USAGE, main, type Io } from "../../apps/cloud-server/src/index";
import { startControl, type ControlConfig } from "../../packages/cloud/src/index";
import { ENV, trial, workdir } from "./control-support";
import { ask } from "./net-support";

function io(): Io & { stdout: string[]; stderr: string[]; signals: EventEmitter } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (l) => void stdout.push(l), err: (l) => void stderr.push(l), signals: new EventEmitter() };
}

/** The control plane listens for a stop signal only once it is running; a signal sent before that would be lost. */
async function untilRunning(signals: EventEmitter): Promise<void> {
  for (let i = 0; i < 500 && signals.listenerCount("SIGTERM") === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(signals.listenerCount("SIGTERM") > 0, "the control plane never started");
}

const never = (async () => {
  throw new Error("this test starts nothing");
}) as unknown as typeof startControl;

test("the usage names the control command beside the gateway's", () => {
  assert.match(USAGE, /gateway --config <gateway\.yaml> \[--check\]/);
  assert.match(USAGE, /control --config <control\.yaml> \[--check\]\s+run the control plane/);
});

test("--check reads and validates the configuration, shows what it would run, listens on nothing, and writes nothing", async () => {
  const w = workdir(trial);
  try {
    const out = io();
    const code = await main(["control", "--config", w.file, "--check"], ENV, out, undefined, never);
    assert.equal(code, 0);
    const shown = out.stdout.join("\n");
    assert.match(shown, /^the app is at http:\/\/localhost:7500; workspaces are at <slug>\.localhost:7500 over http \(a trial: no Secure cookies\)/);
    assert.match(shown, /billing is manual/);
    assert.match(shown, /WARNING: no licence key: workspaces run on the Community plan's limits/);
    assert.match(shown, /\nthe configuration is valid$/);
    assert.equal(out.stderr.length, 0);
    assert.equal(fs.existsSync(path.join(w.dir, "data")), false, "no log, no outbox, no directory was made");
    for (const secret of [ENV.CONTROL_SECRET, ENV.CONTROL_OWNER_TOKEN, ENV.GATEWAY_ADMIN_TOKEN]) assert.ok(!shown.includes(secret));
  } finally {
    w.done();
  }
});

test("a production configuration whose licence key this build does not trust is refused by the command, with what to do about it", async () => {
  const w = workdir();
  try {
    const out = io();
    assert.equal(await main(["control", "--config", w.file, "--check"], ENV, out, undefined, never), 1);
    assert.match(out.stderr.join("\n"), /the licence key does not verify \(this build trusts no public key 'k1': add it to packages\/licensing\/src\/keys\.ts and rebuild\)/);
    assert.equal(out.stdout.length, 0);
  } finally {
    w.done();
  }
});

test("--check of a configuration with a mistake says what is wrong, all of it, and exits with a failure", async () => {
  const w = workdir((raw) => {
    raw.app_url = "https://app.curule.example/dashboard";
    raw.workspaces = { domain: "ws.curule.example" };
    delete raw.plans;
  });
  try {
    const out = io();
    assert.equal(await main(["control", "--config", w.file, "--check"], ENV, out, undefined, never), 1);
    assert.equal(out.stdout.length, 0);
    const message = out.stderr.join("\n");
    assert.match(message, /app_url 'https:\/\/app\.curule\.example\/dashboard' must be an address with no path/);
    assert.match(message, /plans is required/);
    assert.ok(message.split("\n").every((l) => l.startsWith(w.file)));
    const missing = io();
    assert.equal(await main(["control", "--config", path.join(w.dir, "nonesuch.yaml"), "--check"], ENV, missing, undefined, never), 1);
    assert.match(missing.stderr.join("\n"), /cannot read the control-plane configuration/);
  } finally {
    w.done();
  }
});

test("a command line that cannot be run says why and shows the usage", async () => {
  const a = io();
  assert.equal(await main(["control"], ENV, a, undefined, never), 1);
  assert.equal(a.stderr.join("\n"), `curule-cloud control: --config is required\n${USAGE}`);
  const b = io();
  assert.equal(await main(["control", "--config", "x.yaml", "--frobnicate"], ENV, b, undefined, never), 1);
  assert.equal(b.stderr.join("\n"), `curule-cloud control: unknown option '--frobnicate'\n${USAGE}`);
  const c = io();
  assert.equal(await main(["control", "--config=x.yaml", "--check"], ENV, c, undefined, never), 1);
  assert.match(c.stderr.join("\n"), /cannot read the control-plane configuration x\.yaml/, "--config=<file> is the same as --config <file>");
});

test("the control plane runs until it is told to stop, says what it is stopping for, finishes, and exits cleanly; warnings are shown at the start", async () => {
  const w = workdir(trial);
  try {
    const running = io();
    const seen: ControlConfig[] = [];
    let stops = 0;
    const start = (async (config: ControlConfig) => {
      seen.push(config);
      return {
        stop: async () => {
          stops++;
        },
      };
    }) as unknown as typeof startControl;
    const done = main(["control", "--config", w.file], ENV, running, undefined, start);
    await untilRunning(running.signals);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.appHost, "localhost");
    assert.equal(seen[0]!.secret, ENV.CONTROL_SECRET, "the secrets the file names were read from the environment it was given");
    assert.deepEqual(running.stderr, ["WARNING: no licence key: workspaces run on the Community plan's limits"]);
    running.signals.emit("SIGTERM");
    assert.equal(running.signals.listenerCount("SIGINT"), 0, "the first signal takes away the listener for the other one too");
    assert.equal(running.signals.emit("SIGINT"), false, "a second signal does what the process does by default and ends it");
    assert.equal(await done, 0);
    assert.equal(stops, 1);
    assert.match(running.stdout.join("\n"), /^SIGTERM: no longer taking requests; finishing the ones in flight$/m);
  } finally {
    w.done();
  }
});

test("a control plane that cannot start, or fails while stopping, says so with the command's name and exits with a failure", async () => {
  const w = workdir(trial);
  try {
    const failing = io();
    const refuses = (async () => {
      throw new Error("the log is in use by process 4242");
    }) as unknown as typeof startControl;
    assert.equal(await main(["control", "--config", w.file], ENV, failing, undefined, refuses), 1);
    assert.equal(failing.stderr.at(-1), "curule-cloud control: the log is in use by process 4242");
    assert.equal(failing.signals.listenerCount("SIGTERM"), 0, "nothing is left waiting for a signal");

    const running = io();
    const breaks = (async () => ({
      stop: async () => {
        throw new Error("the disk went away");
      },
    })) as unknown as typeof startControl;
    const done = main(["control", "--config", w.file], ENV, running, undefined, breaks);
    await untilRunning(running.signals);
    running.signals.emit("SIGINT");
    assert.equal(await done, 1);
    assert.equal(running.stderr.at(-1), "curule-cloud control: stopping failed: the disk went away");
  } finally {
    w.done();
  }
});

test("started for real it serves, and a signal stops it and releases its log", async () => {
  const w = workdir((raw) => {
    trial(raw);
    raw.public = { host: "127.0.0.1", port: 0, trust_proxy_hops: 0 };
    raw.gateway.admin_url = "http://127.0.0.1:9";
  });
  try {
    const running = io();
    const logs: Array<Record<string, unknown>> = [];
    const start = ((c: ControlConfig, options?: Parameters<typeof startControl>[1]) => startControl(c, { ...options, log: (r) => void logs.push(r) })) as typeof startControl;
    const done = main(["control", "--config", w.file], ENV, running, undefined, start);
    await untilRunning(running.signals);
    const up = logs.find((l) => l.msg === "the control plane is listening")!;
    const port = Number(new URL(String(up.public)).port);
    assert.deepEqual(await ask(port, { host: "localhost", path: "/healthz" }).then((r) => [r.status, r.json]), [200, { ok: true }]);
    assert.ok(fs.existsSync(path.join(w.dir, "data", "control.jsonl.lock")), "the log is held while it runs");
    running.signals.emit("SIGTERM");
    assert.equal(await done, 0);
    assert.equal(fs.existsSync(path.join(w.dir, "data", "control.jsonl.lock")), false, "and released when it stops");
    await assert.rejects(() => ask(port, { host: "localhost", path: "/healthz" }), /ECONNREFUSED|ECONNRESET/);
  } finally {
    w.done();
  }
});
