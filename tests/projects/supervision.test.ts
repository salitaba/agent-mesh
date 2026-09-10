import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import {
  CHILD_BEAT_PREFIX,
  CHILD_READY_PREFIX,
  ChildProcessSupervisor,
  PIDFILE_NAME,
  SupervisionTree,
  backoffDelayMs,
  statusForFailure,
  type ProjectRef,
  type SupervisionEvent,
} from "../../packages/projects/src/index";
import { testConfigYaml } from "../helpers";

const AGENTS = { agents: [{ id: "a", role: "r", interests: [] }], mayContact: { a: [] } };

/** A real mesh child boots a whole runtime; allow for a cold start. */
const SPAWN_TIMEOUT_MS = 60_000;

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mesh-supervision-"));
}

function makeProject(base: string, folder: string, id: string, yaml?: string): ProjectRef {
  const dir = path.join(base, folder);
  fs.mkdirSync(dir, { recursive: true });
  const body = yaml ?? `project:\n  id: ${id}\n${testConfigYaml(AGENTS)}`;
  fs.writeFileSync(path.join(dir, "mesh.yaml"), body, "utf8");
  const root = fs.realpathSync(dir);
  return { id, name: id, root, configPath: path.join(root, "mesh.yaml"), addedAt: new Date().toISOString() };
}

/**
 * A stub standing in for a mesh child.
 *
 * Real children cost ~500ms each to boot, which makes backoff and crash-loop
 * timing assertions both slow and flaky. The stub speaks the same three-line
 * protocol the supervisor parses, so everything above the handshake — restart
 * policy, breaker, watchdog — is exercised for real.
 */
function stubChild(
  base: string,
  name: string,
  body: { beat?: boolean; exitAfterMs?: number; exitCode?: number },
): string {
  const file = path.join(base, `${name}.js`);
  const beat = body.beat
    ? `const t = setInterval(() => process.stdout.write(\`${CHILD_BEAT_PREFIX} \${JSON.stringify({ rss: process.memoryUsage.rss() })}\\n\`), 50); t.unref();`
    : "";
  const die =
    typeof body.exitAfterMs === "number"
      ? `setTimeout(() => process.exit(${body.exitCode ?? 1}), ${body.exitAfterMs});`
      : "";
  fs.writeFileSync(
    file,
    [
      `process.stdout.write(\`${CHILD_READY_PREFIX} \${JSON.stringify({ port: 1, pid: process.pid, projectId: 'stub', url: 'http://127.0.0.1:1' })}\\n\`);`,
      beat,
      die,
      "process.on('SIGTERM', () => process.exit(0));",
      "setInterval(() => {}, 1000);",
    ].join("\n"),
    "utf8",
  );
  return file;
}

function makeTree(
  supervisorOpts: ConstructorParameters<typeof ChildProcessSupervisor>[0],
  treeOpts: Partial<ConstructorParameters<typeof SupervisionTree>[0]> = {},
): { tree: SupervisionTree; supervisor: ChildProcessSupervisor; events: SupervisionEvent[] } {
  const events: SupervisionEvent[] = [];
  let tree!: SupervisionTree;
  const supervisor = new ChildProcessSupervisor({
    readyTimeoutMs: 5_000,
    stopGraceMs: 1_000,
    ...supervisorOpts,
    onExit: (info) => tree.handleExit(info),
  });
  tree = new SupervisionTree({
    supervisor,
    onEvent: (e) => events.push(e),
    // Milliseconds, not seconds: the schedule's *shape* is what is under test,
    // and asserting it at real scale would cost 15s per case.
    backoff: (attempt) => Math.min(20 * 2 ** (attempt - 1), 200),
    healthPollMs: 25,
    heartbeatTimeoutMs: 300,
    shutdownDeadlineMs: 2_000,
    ...treeOpts,
  });
  return { tree, supervisor, events };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for a supervision transition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("backoff is 1s, 2s, 4s, 8s and caps at 30s", () => {
  assert.equal(backoffDelayMs(1), 1_000);
  assert.equal(backoffDelayMs(2), 2_000);
  assert.equal(backoffDelayMs(3), 4_000);
  assert.equal(backoffDelayMs(4), 8_000);
  assert.equal(backoffDelayMs(5), 16_000);
  // Capped, not unbounded: without this an all-night crash loop would back off
  // to hours and the project would look permanently dead.
  assert.equal(backoffDelayMs(6), 30_000);
  assert.equal(backoffDelayMs(20), 30_000);
  assert.equal(backoffDelayMs(0), 1_000, "a non-positive attempt must not produce a sub-second retry storm");
});

test("a crashed child is restarted after a backoff, not immediately", async () => {
  const base = tmpRoot();
  const ref = makeProject(base, "flaky", "flaky");
  const script = stubChild(base, "flaky-child", { exitAfterMs: 40 });
  const { tree, events } = makeTree({ childScript: script }, { backoff: () => 250 });
  try {
    const opened = await tree.open(ref);
    assert.equal(opened.status, "open");

    await waitFor(() => events.some((e) => e.status === "crashed"));
    const crash = events.find((e) => e.status === "crashed")!;
    assert.equal(crash.reason, "crash");
    assert.equal(crash.retryInMs, 250, "a crashed tab must say when it will come back");

    // The restart is scheduled, not synchronous: an instant respawn against a
    // resource that is still gone is what turns a crash into a hot loop.
    const beforeRetry = events.filter((e) => e.status === "booting").length;
    assert.equal(beforeRetry, 1, "the restart must wait out the backoff");

    await waitFor(() => events.filter((e) => e.status === "open").length >= 2, 8_000);
    assert.ok(
      events.filter((e) => e.status === "booting").length >= 2,
      "the child must actually come back up, not merely be marked crashed",
    );
  } finally {
    await tree.shutdown();
  }
});

test("backoff grows between successive restarts", async () => {
  const base = tmpRoot();
  const ref = makeProject(base, "growing", "growing");
  const script = stubChild(base, "growing-child", { exitAfterMs: 10 });
  const delays: number[] = [];
  const { tree } = makeTree(
    { childScript: script },
    {
      backoff: (attempt) => {
        const d = Math.min(30 * 2 ** (attempt - 1), 240);
        delays.push(d);
        return d;
      },
      // High enough that the breaker does not trip before we see the growth.
      crashLoopThreshold: 10,
    },
  );
  try {
    await tree.open(ref);
    await waitFor(() => delays.length >= 3, 8_000);
    assert.equal(delays[0], 30);
    assert.equal(delays[1], 60);
    assert.equal(delays[2], 120, "each successive failure must wait longer than the last");
  } finally {
    await tree.shutdown();
  }
});

test("more than 3 crashes in the window trips the breaker and stops auto-restart", async () => {
  const base = tmpRoot();
  const ref = makeProject(base, "looping", "looping");
  const script = stubChild(base, "looping-child", { exitAfterMs: 10 });
  const { tree, events } = makeTree(
    { childScript: script },
    { backoff: () => 10, crashLoopThreshold: 3, crashLoopWindowMs: 60_000 },
  );
  try {
    await tree.open(ref);
    await waitFor(() => tree.isTripped("looping"), 8_000);

    assert.equal(tree.status("looping"), "crashed");
    const boots = events.filter((e) => e.status === "booting").length;
    // 1 open + exactly 3 auto-restarts. The 4th crash trips instead.
    assert.equal(boots, 4, "the breaker must stop the loop, not merely slow it");

    const tripped = events.filter((e) => e.status === "crashed").at(-1)!;
    assert.match(tripped.detail ?? "", /auto-restart disabled/);
    assert.equal(tripped.retryInMs, undefined, "a tripped project must not advertise a retry that will not happen");

    // Settle: no further boots after the breaker trips.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(events.filter((e) => e.status === "booting").length, boots);
  } finally {
    await tree.shutdown();
  }
});

test("crashes outside the window do not accumulate toward the breaker", async () => {
  const base = tmpRoot();
  const ref = makeProject(base, "occasional", "occasional");
  const script = stubChild(base, "occasional-child", { exitAfterMs: 10 });
  let clock = 0;
  const { tree } = makeTree(
    { childScript: script },
    {
      backoff: () => 10,
      crashLoopThreshold: 3,
      crashLoopWindowMs: 60_000,
      // Each crash appears an hour after the last, so the window never holds
      // more than one. A project that dies once a day is not a crash loop.
      now: () => (clock += 3_600_000),
    },
  );
  try {
    await tree.open(ref);
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(tree.isTripped("occasional"), false, "rare crashes must keep being restarted");
  } finally {
    await tree.shutdown();
  }
});

test("a manual restart clears the breaker", async () => {
  const base = tmpRoot();
  const ref = makeProject(base, "retried", "retried");
  const dying = stubChild(base, "retried-child", { exitAfterMs: 10 });
  const { tree } = makeTree({ childScript: dying }, { backoff: () => 10, crashLoopThreshold: 3 });
  try {
    await tree.open(ref);
    await waitFor(() => tree.isTripped("retried"), 8_000);

    // The user asking again is new information: they may have fixed the cause.
    const healthy = stubChild(base, "retried-child", { beat: true });
    assert.equal(healthy, dying, "the stub is rewritten in place so the restart picks up a working child");
    const handle = await tree.restart(ref);
    assert.equal(handle.status, "open");
    assert.equal(tree.isTripped("retried"), false);
  } finally {
    await tree.shutdown();
  }
});

test("locked and invalid-config never auto-restart", async () => {
  const base = tmpRoot();

  // `locked`: exit 78. Retrying would hammer a project another host is running.
  const lockedRef = makeProject(base, "held", "held");
  const lockedScript = path.join(base, "locked-child.js");
  fs.writeFileSync(lockedScript, "process.exit(78);\n", "utf8");
  const locked = makeTree({ childScript: lockedScript }, { backoff: () => 10 });
  try {
    const result = await locked.tree.open(lockedRef);
    assert.equal(result.status, "locked");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(locked.events.filter((e) => e.status === "booting").length, 1, "a locked project must be tried once");
    assert.equal(locked.tree.status("held"), "locked");
  } finally {
    await locked.tree.shutdown();
  }

  // `error`: exit 79. A bad config is never fixed by being retried.
  const badRef = makeProject(base, "bad", "bad");
  const badScript = path.join(base, "bad-child.js");
  fs.writeFileSync(badScript, "process.exit(79);\n", "utf8");
  const bad = makeTree({ childScript: badScript }, { backoff: () => 10 });
  try {
    const result = await bad.tree.open(badRef);
    assert.equal(result.status, "error");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(bad.events.filter((e) => e.status === "booting").length, 1);
    assert.equal(bad.tree.status("bad"), "error");
  } finally {
    await bad.tree.shutdown();
  }

  assert.equal(statusForFailure("locked", 78), "locked");
  assert.equal(statusForFailure("invalid_config", 79), "error");
  assert.equal(statusForFailure("failed", 1), "crashed");
});

test("heartbeats report RSS for the tab indicator", async () => {
  const base = tmpRoot();
  const ref = makeProject(base, "beating", "beating");
  const script = stubChild(base, "beating-child", { beat: true });
  const beats: number[] = [];
  const { tree } = makeTree({ childScript: script, onHeartbeat: (i) => beats.push(i.rss) });
  try {
    await tree.open(ref);
    await waitFor(() => beats.length >= 2);
    assert.ok(beats[0] > 0, "RSS is what the tab indicator shows; zero would be a broken gauge");

    const health = tree.health("beating");
    assert.ok(health);
    assert.ok(health!.rss > 0);
    assert.equal(health!.restarts, 0);
    assert.ok(Date.parse(health!.lastHeartbeat) > 0);
  } finally {
    await tree.shutdown();
  }
});

test("a child that stops heartbeating is killed and restarted", async () => {
  const base = tmpRoot();
  const ref = makeProject(base, "wedged", "wedged");
  // Beats for a moment, then goes silent while staying alive: a wedged event
  // loop. Worse than a dead child — it still holds the port, lock and tab.
  const script = path.join(base, "wedged-child.js");
  fs.writeFileSync(
    script,
    [
      `process.stdout.write(\`${CHILD_READY_PREFIX} \${JSON.stringify({ port: 1, pid: process.pid })}\\n\`);`,
      `let n = 0;`,
      `const t = setInterval(() => {`,
      `  if (n++ > 2) return clearInterval(t);`,
      `  process.stdout.write(\`${CHILD_BEAT_PREFIX} \${JSON.stringify({ rss: 1234 })}\\n\`);`,
      `}, 30);`,
      "process.on('SIGTERM', () => process.exit(0));",
      "setInterval(() => {}, 1000);",
    ].join("\n"),
    "utf8",
  );

  const { tree, events } = makeTree(
    { childScript: script },
    { heartbeatTimeoutMs: 250, healthPollMs: 25, backoff: () => 20, crashLoopThreshold: 10 },
  );
  try {
    const opened = await tree.open(ref);
    assert.equal(opened.status, "open");

    await waitFor(() => events.some((e) => e.reason === "unhealthy"), 8_000);
    const unhealthy = events.find((e) => e.reason === "unhealthy")!;
    assert.match(unhealthy.detail ?? "", /no heartbeat/);

    // The restart path is the same one a crash takes.
    await waitFor(() => events.filter((e) => e.status === "booting").length >= 2, 8_000);
  } finally {
    await tree.shutdown();
  }
});

test("a healthy child is never restarted by the watchdog", async () => {
  const base = tmpRoot();
  const ref = makeProject(base, "steady", "steady");
  const script = stubChild(base, "steady-child", { beat: true });
  const { tree, events } = makeTree({ childScript: script }, { heartbeatTimeoutMs: 300, healthPollMs: 20 });
  try {
    await tree.open(ref);
    // Several watchdog cycles: a false positive here kills a working project
    // mid-mission, which is the worst outcome the health check can produce.
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(events.filter((e) => e.status === "booting").length, 1);
    assert.equal(tree.status("steady"), "open");
  } finally {
    await tree.shutdown();
  }
});

test("an operator close is not a crash and cancels a pending restart", async () => {
  const base = tmpRoot();
  const ref = makeProject(base, "closed", "closed");
  const script = stubChild(base, "closed-child", { exitAfterMs: 40 });
  const { tree, events } = makeTree({ childScript: script }, { backoff: () => 300 });
  try {
    await tree.open(ref);
    await waitFor(() => events.some((e) => e.status === "crashed"));

    await tree.close(ref);
    assert.equal(tree.status("closed"), "closed");

    // Past the backoff: a close that leaves a timer armed resurrects a project
    // the user explicitly shut down.
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(events.filter((e) => e.status === "booting").length, 1);
    assert.equal(tree.status("closed"), "closed");
  } finally {
    await tree.shutdown();
  }
});

test("closing a healthy child never triggers the restart path", async () => {
  const base = tmpRoot();
  const ref = makeProject(base, "quiet", "quiet");
  const script = stubChild(base, "quiet-child", { beat: true });
  const { tree, events } = makeTree({ childScript: script }, { backoff: () => 20 });
  try {
    await tree.open(ref);
    await tree.close(ref);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(events.filter((e) => e.status === "crashed").length, 0, "an intentional stop is not a failure");
    assert.equal(events.filter((e) => e.status === "booting").length, 1);
  } finally {
    await tree.shutdown();
  }
});

test("host shutdown closes every child in parallel against one deadline", async () => {
  const base = tmpRoot();
  const refs = ["s1", "s2", "s3"].map((id) => makeProject(base, id, id));
  // Each child ignores SIGTERM, so every stop must ride the full grace period.
  // Sequentially that is 3 x grace; in parallel it is one.
  const script = path.join(base, "stubborn-child.js");
  fs.writeFileSync(
    script,
    [
      `process.stdout.write(\`${CHILD_READY_PREFIX} \${JSON.stringify({ port: 1, pid: process.pid })}\\n\`);`,
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
    ].join("\n"),
    "utf8",
  );

  const { tree, supervisor } = makeTree({ childScript: script, stopGraceMs: 5_000 }, { shutdownDeadlineMs: 400 });
  for (const ref of refs) {
    const opened = await tree.open(ref);
    assert.equal(opened.status, "open");
  }
  const pids = refs.map((r) => supervisor.running(r.id)!.pid);

  const started = Date.now();
  await tree.shutdown();
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 1_500, `shutdown took ${elapsed}ms: children must close in parallel, not one after another`);
  for (const pid of pids) {
    assert.throws(() => process.kill(pid, 0), "a host that exits must not leave its children behind");
  }
  assert.deepEqual(supervisor.runningIds(), []);
});

test("shutdown cancels pending restarts so none are stranded", async () => {
  const base = tmpRoot();
  const ref = makeProject(base, "pending", "pending");
  const script = stubChild(base, "pending-child", { exitAfterMs: 30 });
  const { tree, events, supervisor } = makeTree({ childScript: script }, { backoff: () => 400 });
  await tree.open(ref);
  await waitFor(() => events.some((e) => e.status === "crashed"));

  await tree.shutdown();
  const bootsAtShutdown = events.filter((e) => e.status === "booting").length;

  // A timer that fires after shutdown spawns a child no one owns — precisely
  // the orphan the next host has to reap.
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(events.filter((e) => e.status === "booting").length, bootsAtShutdown);
  assert.deepEqual(supervisor.runningIds(), []);
});

test("host start sweeps orphans across every registered project", async () => {
  const base = tmpRoot();
  const live = makeProject(base, "stranded", "stranded");
  const debris = makeProject(base, "debris", "debris");
  const clean = makeProject(base, "clean", "clean");

  // A child whose host was SIGKILLed: still running, still holding the state
  // lock, tracked by nobody.
  const stray = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000);"], { stdio: "ignore" });
  const strayFile = path.join(live.root, ".mesh", PIDFILE_NAME);
  fs.mkdirSync(path.dirname(strayFile), { recursive: true });
  fs.writeFileSync(strayFile, JSON.stringify({ pid: stray.pid, projectId: live.id, hostPid: 999999 }), "utf8");

  const deadFile = path.join(debris.root, ".mesh", PIDFILE_NAME);
  fs.mkdirSync(path.dirname(deadFile), { recursive: true });
  fs.writeFileSync(deadFile, JSON.stringify({ pid: 999999, projectId: debris.id, hostPid: 999999 }), "utf8");

  const script = stubChild(base, "sweep-child", { beat: true });
  const { tree } = makeTree({ childScript: script });
  try {
    // Every registered ref, not just the ones about to be opened: an orphan on
    // a project nobody opens today still makes it unopenable tomorrow.
    const reaped = await tree.start([live, debris, clean]);
    assert.deepEqual(reaped, ["stranded"]);
    assert.throws(() => process.kill(stray.pid!, 0));
    assert.equal(fs.existsSync(strayFile), false);
    assert.equal(fs.existsSync(deadFile), false, "debris must not be re-examined on every boot");
  } finally {
    await tree.shutdown();
  }
});

test("a restarted real child replays from its snapshot and serves again", { timeout: SPAWN_TIMEOUT_MS + 40_000 }, async () => {
  const base = tmpRoot();
  const ref = makeProject(base, "real", "real");
  const { tree, supervisor } = makeTree(
    { childScript: path.resolve(process.cwd(), "dist", "apps", "mesh-server", "src", "child.js"), readyTimeoutMs: SPAWN_TIMEOUT_MS },
    { backoff: () => 50, heartbeatTimeoutMs: 60_000, healthPollMs: 1_000 },
  );
  try {
    const opened = await tree.open(ref);
    assert.equal(opened.status, "open", `open failed: ${JSON.stringify(opened.error)}`);
    const first = supervisor.running("real")!;

    // Hard-kill, the way an OOM would. The restart must reacquire the state
    // lock the dead child was holding: if the sweep or the lock handoff were
    // broken this comes back `locked` forever.
    process.kill(first.pid, "SIGKILL");
    await waitFor(() => {
      const child = supervisor.running("real");
      return !!child && child.pid !== first.pid;
    }, 60_000);

    await waitFor(() => tree.status("real") === "open", 60_000);
    const second = supervisor.running("real")!;
    assert.notEqual(second.pid, first.pid);
    assert.notEqual(second.token, first.token, "a restarted child must mint a fresh token");

    const res = await fetch(`${second.url}/health`, { headers: { authorization: `Bearer ${second.token}` } });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { ok: boolean }).ok, true);
  } finally {
    await tree.shutdown();
  }
});
