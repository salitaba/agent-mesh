/**
 * The missed-heartbeat window, and the record the host keeps of every kill.
 *
 * A child running three turns with tool calls in flight — beating normally the
 * whole time — was killed as "unhealthy" because the HOST's event loop could
 * not read its beats fast enough. The window was 15s and the poll was every 2s,
 * so two consecutive polls landing after a long synchronous block were enough
 * to stop a working project mid-mission and re-park it. Two things came out of
 * that: the window is now 60s, and the decision is written down where the
 * operator can find it, rather than scrolling past a terminal.
 *
 * The boundary itself is asserted against `heartbeatVerdict` (pure), and the
 * behaviour against a real stub child, because "not killed" is a claim about
 * time passing and nothing else can make it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  CHILD_BEAT_PREFIX,
  CHILD_READY_PREFIX,
  ChildProcessSupervisor,
  HEARTBEAT_TIMEOUT_MS,
  SUPERVISION_LOG_NAME,
  SupervisionTree,
  defaultHostConfig,
  heartbeatVerdict,
  parseHostConfig,
  supervisionLogPath,
  type ProjectRef,
  type SupervisionEvent,
} from "../../packages/projects/src/index";
import { testConfigYaml } from "../helpers";

const AGENTS = { agents: [{ id: "a", role: "r", interests: [] }], mayContact: { a: [] } };

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mesh-heartbeat-"));
}

function makeProject(base: string, folder: string, id: string): ProjectRef {
  const dir = path.join(base, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "mesh.yaml"), `project:\n  id: ${id}\n${testConfigYaml(AGENTS)}`, "utf8");
  const root = fs.realpathSync(dir);
  return { id, name: id, root, configPath: path.join(root, "mesh.yaml"), addedAt: new Date().toISOString() };
}

/**
 * A child that handshakes, beats for `beatMs`, then goes quiet — still alive,
 * still holding its port and its lock, and silent. That is exactly the shape a
 * wedged child has, and exactly the shape a child blocked in a long synchronous
 * operation has, which is why the host must not confuse the two quickly.
 */
function quietChildScript(base: string, beatMs = 0): string {
  const file = path.join(base, "quiet-child.js");
  const beat =
    beatMs > 0
      ? `const t = setInterval(() => process.stdout.write(\`${CHILD_BEAT_PREFIX} \${JSON.stringify({ rss: 1, runningTurns: 0 })}\\n\`), 50);
setTimeout(() => clearInterval(t), ${beatMs});`
      : "";
  fs.writeFileSync(
    file,
    [
      `process.stdout.write(\`${CHILD_READY_PREFIX} \${JSON.stringify({ port: 1, pid: process.pid, projectId: 'stub', url: 'http://127.0.0.1:1' })}\\n\`);`,
      beat,
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
    backoff: () => 20,
    healthPollMs: 25,
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

/** One line per decision, as the tree writes them. */
function supervisionLines(ref: ProjectRef): string[] {
  const file = supervisionLogPath(ref);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
}

test("the default window is 60s, and silence under it is not even stale", () => {
  assert.equal(HEARTBEAT_TIMEOUT_MS, 60_000);
  assert.equal(defaultHostConfig().heartbeatTimeoutMs, 60_000, "the host config default tracks the tree's");
  assert.equal(defaultHostConfig().projectMemoryMb, null, "the window is the only default that moved");

  // THE regression. 16s is past the old 15s window: under it this reading made a
  // working child killable, which is how a mission lost two mid-flight turns.
  assert.deepEqual(heartbeatVerdict(16_000, HEARTBEAT_TIMEOUT_MS, 0), { stale: false, stop: false, nextChecks: 0 });
  assert.deepEqual(heartbeatVerdict(59_999, HEARTBEAT_TIMEOUT_MS, 1), { stale: false, stop: false, nextChecks: 0 });

  // Past the window the old rule still holds: one stale reading is an artefact,
  // two are a wedged child.
  assert.deepEqual(heartbeatVerdict(60_000, HEARTBEAT_TIMEOUT_MS, 0), { stale: true, stop: false, nextChecks: 1 });
  assert.deepEqual(heartbeatVerdict(61_000, HEARTBEAT_TIMEOUT_MS, 1), { stale: true, stop: true, nextChecks: 2 });
});

test("a child silent for longer than the old window is still not killed", { timeout: 40_000 }, async () => {
  const base = tmpRoot();
  const ref = makeProject(base, "quiet", "quiet");
  // No `heartbeatTimeoutMs` override anywhere: this is the shipped default, and
  // the point is that 16 seconds of silence is no longer enough to stop it.
  const { tree, supervisor, events } = makeTree({ childScript: quietChildScript(base, 300) }, { healthPollMs: 250 });
  try {
    const opened = await tree.open(ref);
    assert.equal(opened.status, "open");
    await new Promise((r) => setTimeout(r, 16_000));
    assert.equal(tree.status("quiet"), "open", "16s of silence must not stop a child any more");
    assert.ok(supervisor.running("quiet"), "it is still the same process, still holding its lock");
    assert.equal(events.some((e) => e.reason === "unhealthy"), false, "and nothing was recorded as a kill");
    assert.deepEqual(supervisionLines(ref), [], "no decision, no line");
  } finally {
    await tree.shutdown();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("past the window the child is stopped, and the decision is written down", { timeout: 30_000 }, async () => {
  const base = tmpRoot();
  const ref = makeProject(base, "wedged", "wedged");
  // A restart 60s out, so the kill under test is the only decision this tree
  // gets to make before the test is over.
  const { tree, supervisor, events } = makeTree(
    { childScript: quietChildScript(base) },
    { heartbeatTimeoutMs: 300, healthPollMs: 50, backoff: () => 60_000, crashLoopThreshold: 10 },
  );
  try {
    assert.equal((await tree.open(ref)).status, "open");
    await waitFor(() => events.some((e) => e.reason === "unhealthy"), 10_000);

    const kill = events.find((e) => e.reason === "unhealthy")!;
    assert.equal(kill.status, "crashed");
    assert.match(kill.detail ?? "", /no heartbeat for \d+s/);
    assert.ok((kill.silenceMs ?? 0) >= 300, "the event carries the measured silence, not just a rounded one");
    assert.equal(kill.logFile, supervisionLogPath(ref), "and says where the record lives");
    assert.equal(kill.retryInMs, 60_000, "and what it will do about it");

    // The line is the whole point: before this, the only trace of a health kill
    // was a line in the child's own rotated stderr, which the operator whose
    // mission was killed while it was working never saw.
    const lines = supervisionLines(ref);
    assert.equal(lines.length, 1, `one line per decision, got: ${JSON.stringify(lines)}`);
    const line = lines[0];
    assert.match(line, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z project=wedged /);
    assert.match(line, /reason=unhealthy/);
    assert.match(line, /silenceMs=\d+/);
    assert.match(line, /action=restart-with-backoff/);
    assert.match(line, /retryInMs=60000/);
    assert.match(line, /detail="no heartbeat for \d+s"/);

    // The log directory did not exist before this decision; the tree creates it
    // rather than losing the record to a missing folder.
    assert.ok(fs.existsSync(path.join(path.dirname(ref.configPath), ".mesh")), "the .mesh dir is created for it");
    assert.equal(supervisor.running("wedged"), undefined, "the silent child really was stopped");
    assert.equal(tree.status("wedged"), "crashed");
  } finally {
    await tree.shutdown();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a crash loop that trips the breaker records the trip", { timeout: 30_000 }, async () => {
  const base = tmpRoot();
  const ref = makeProject(base, "looping", "looping");
  const script = path.join(base, "dying-child.js");
  fs.writeFileSync(
    script,
    [
      `process.stdout.write(\`${CHILD_READY_PREFIX} \${JSON.stringify({ port: 1, pid: process.pid, projectId: 'stub', url: 'http://127.0.0.1:1' })}\\n\`);`,
      "setTimeout(() => process.exit(1), 30);",
    ].join("\n"),
    "utf8",
  );
  const { tree, events } = makeTree({ childScript: script }, { backoff: () => 20, crashLoopThreshold: 2, healthPollMs: 50 });
  try {
    assert.equal((await tree.open(ref)).status, "open");
    await waitFor(() => events.some((e) => e.detail?.includes("auto-restart disabled")), 15_000);

    const lines = supervisionLines(ref);
    assert.ok(lines.length >= 3, `every crash decision is recorded, got ${lines.length}`);
    assert.ok(lines.slice(0, -1).every((l) => l.includes("reason=crash") && l.includes("action=restart-with-backoff")));
    const last = lines[lines.length - 1];
    assert.match(last, /action=breaker-tripped/);
    assert.match(last, /crashes=\d+/);
    assert.equal(events[events.length - 1].logFile, supervisionLogPath(ref));
  } finally {
    await tree.shutdown();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("host.yaml can widen or narrow the window, and null is refused out loud", () => {
  const explicit = parseHostConfig("host:\n  heartbeat_timeout_ms: 120000\n");
  assert.equal(explicit.heartbeatTimeoutMs, 120_000, "a host that has been killed by this must be able to move it");
  assert.deepEqual(explicit.explicitKeys, ["heartbeat_timeout_ms"], "and 'you chose this' has to be visible");
  assert.deepEqual(explicit.warnings, []);

  const defaulted = parseHostConfig("host:\n  spend_ceiling_usd: 5\n");
  assert.equal(defaulted.heartbeatTimeoutMs, HEARTBEAT_TIMEOUT_MS);

  const garbage = parseHostConfig("host:\n  heartbeat_timeout_ms: soon\n");
  assert.equal(garbage.heartbeatTimeoutMs, HEARTBEAT_TIMEOUT_MS, "an unparseable value falls back rather than guessing");
  assert.equal(garbage.warnings.length, 1);

  const big = parseHostConfig("host:\n  heartbeat_timeout_ms: 600000\n");
  assert.equal(big.heartbeatTimeoutMs, 600_000, "the only way to make a silent child effectively unkillable");

  const nulled = parseHostConfig("host:\n  heartbeat_timeout_ms: null\n");
  assert.equal(nulled.heartbeatTimeoutMs, HEARTBEAT_TIMEOUT_MS);
  assert.equal(nulled.warnings.length, 1, "an operator who wrote `null` believes they turned it off — say so");
  assert.match(nulled.warnings[0], /cannot be null/);
  assert.deepEqual(nulled.explicitKeys, []);
});

test("the file name is the one the docs and the UI point at", () => {
  assert.equal(SUPERVISION_LOG_NAME, "host-supervision.log");
  const base = tmpRoot();
  const ref = makeProject(base, "named", "named");
  try {
    assert.equal(supervisionLogPath(ref), path.join(path.dirname(ref.configPath), ".mesh", SUPERVISION_LOG_NAME));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
