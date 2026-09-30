/**
 * What the host records about a child it killed for going quiet.
 *
 * A health kill used to leave one number behind: how long the child had been
 * silent. That number cannot tell the two cases apart, and they want opposite
 * responses — a loop blocked by synchronous work comes back on its own and its
 * in-flight turns are exactly what killing it destroys, while a wedged process
 * never comes back and waiting costs nothing but time. On 2026-09-28 a live
 * mission lost three in-flight turns (~100k tokens) to a kill the record could
 * not distinguish from a wedge.
 *
 * So the child reports its own loop lag on the beat it is already sending, the
 * host carries it through to the decision, and the supervision log — the durable
 * record of the kill — names it. The third test is the one that keeps this
 * honest: a child that never said must leave the field absent, because
 * `loopLagMaxMs=0` is a claim about the child's loop and "no beat carried it" is
 * not.
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
  SupervisionTree,
  supervisionLogPath,
  type ProjectRef,
  type SupervisionEvent,
} from "../../packages/projects/src/index";
import { testConfigYaml, waitFor } from "../helpers";

const AGENTS = { agents: [{ id: "a", role: "r", interests: [] }], mayContact: { a: [] } };

/** Spawning a real mesh child boots a whole runtime; allow for a cold start. */
const SPAWN_TIMEOUT_MS = 60_000;

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mesh-kill-lag-"));
}

function makeProject(base: string, folder: string, id: string): ProjectRef {
  const dir = path.join(base, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "mesh.yaml"), `project:\n  id: ${id}\n${testConfigYaml(AGENTS)}`, "utf8");
  const root = fs.realpathSync(dir);
  return { id, name: id, root, configPath: path.join(root, "mesh.yaml"), addedAt: new Date().toISOString() };
}

/**
 * A child that handshakes, beats `lag` on every beat for `beatMs`, then goes
 * quiet while staying alive. `lag` omitted means the beat carries no lag at all,
 * which is what a child too old to report one sends.
 */
function quietChildScript(base: string, fields: Record<string, unknown> = {}, beatMs = 400): string {
  const file = path.join(base, `quiet-child-${Math.random().toString(36).slice(2)}.js`);
  const payload = JSON.stringify({ rss: 1, runningTurns: 0, ...fields });
  fs.writeFileSync(
    file,
    [
      `process.stdout.write(\`${CHILD_READY_PREFIX} \${JSON.stringify({ port: 1, pid: process.pid, projectId: 'stub', url: 'http://127.0.0.1:1' })}\\n\`);`,
      `const t = setInterval(() => process.stdout.write(\`${CHILD_BEAT_PREFIX} ${payload}\\n\`), 50);`,
      `setTimeout(() => clearInterval(t), ${beatMs});`,
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
    // A restart far enough out that this tree makes exactly one decision.
    backoff: () => 60_000,
    healthPollMs: 50,
    shutdownDeadlineMs: 2_000,
    ...treeOpts,
  });
  return { tree, supervisor, events };
}

function supervisionLines(ref: ProjectRef): string[] {
  const file = supervisionLogPath(ref);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
}

test("a real child reports its own loop lag on the beat", { timeout: SPAWN_TIMEOUT_MS + 30_000 }, async () => {
  const base = tmpRoot();
  const ref = makeProject(base, "reporting", "reporting");
  const supervisor = new ChildProcessSupervisor({
    childScript: path.resolve(process.cwd(), "dist", "apps", "mesh-server", "src", "child.js"),
    readyTimeoutMs: SPAWN_TIMEOUT_MS,
    stopGraceMs: 5_000,
  });
  try {
    assert.equal((await supervisor.launch(ref)).status, "open");
    await waitFor("a beat carrying the child's own loop lag", () => supervisor.heartbeat("reporting")?.eventLoopLagMaxMs !== undefined, 30_000);

    const beat = supervisor.heartbeat("reporting")!;
    const { eventLoopLagMs, eventLoopLagMaxMs } = beat;
    assert.equal(typeof eventLoopLagMs, "number", "the spot reading rides the beat too");
    assert.equal(typeof eventLoopLagMaxMs, "number");
    assert.ok(eventLoopLagMs !== undefined && eventLoopLagMaxMs !== undefined);
    assert.ok(eventLoopLagMaxMs >= 0 && eventLoopLagMs >= 0, "lag is a duration, never negative");
    assert.ok(eventLoopLagMaxMs >= eventLoopLagMs, "the high-water mark cannot be below the latest sample");
  } finally {
    await supervisor.stopAll();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a health kill records the lag the child last reported about itself", { timeout: 30_000 }, async () => {
  const base = tmpRoot();
  const ref = makeProject(base, "blocked", "blocked");
  const { tree, events } = makeTree(
    { childScript: quietChildScript(base, { eventLoopLagMs: 12_000, eventLoopLagMaxMs: 88_000 }) },
    { heartbeatTimeoutMs: 300, crashLoopThreshold: 10 },
  );
  try {
    assert.equal((await tree.open(ref)).status, "open");
    await waitFor("the kill", () => events.some((e) => e.reason === "unhealthy"), 10_000);

    const kill = events.find((e) => e.reason === "unhealthy")!;
    assert.equal(kill.eventLoopLagMaxMs, 88_000, "the event carries what the child said, not a re-measurement by the host");
    assert.ok((kill.silenceMs ?? 0) >= 300, "alongside the silence it cannot replace");

    // The durable record is the point: the operator reads this file after the
    // fact, and until now it said only how long the child had been quiet.
    const lines = supervisionLines(ref);
    assert.equal(lines.length, 1, `one line per decision, got: ${JSON.stringify(lines)}`);
    assert.match(lines[0], /reason=unhealthy/);
    assert.match(lines[0], /silenceMs=\d+/);
    assert.match(lines[0], /eventLoopLagMaxMs=88000/);
  } finally {
    await tree.shutdown();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a child that never reported a lag leaves the field out rather than writing zero", { timeout: 30_000 }, async () => {
  const base = tmpRoot();
  const ref = makeProject(base, "silent-about-it", "silent-about-it");
  const { tree, events } = makeTree(
    { childScript: quietChildScript(base) },
    { heartbeatTimeoutMs: 300, crashLoopThreshold: 10 },
  );
  try {
    assert.equal((await tree.open(ref)).status, "open");
    await waitFor("the kill", () => events.some((e) => e.reason === "unhealthy"), 10_000);

    const kill = events.find((e) => e.reason === "unhealthy")!;
    assert.equal(kill.eventLoopLagMaxMs, undefined, "never asked is not the same answer as never blocked");
    assert.doesNotMatch(supervisionLines(ref)[0], /eventLoopLagMaxMs/, "and the record must not invent one");
  } finally {
    await tree.shutdown();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a crash after a blocking child also carries the last lag it reported", { timeout: 30_000 }, async () => {
  const base = tmpRoot();
  const ref = makeProject(base, "blocked-then-dead", "blocked-then-dead");
  // Beats a large lag for long enough that the 2s watchdog polls it, then exits
  // on its own: the crash path has to reach for the value the watchdog cached,
  // because by then the supervisor has already forgotten the child.
  const file = path.join(base, "crash-child.js");
  fs.writeFileSync(
    file,
    [
      `process.stdout.write(\`${CHILD_READY_PREFIX} \${JSON.stringify({ port: 1, pid: process.pid, projectId: 'stub', url: 'http://127.0.0.1:1' })}\\n\`);`,
      `const t = setInterval(() => process.stdout.write(\`${CHILD_BEAT_PREFIX} \${JSON.stringify({ rss: 1, runningTurns: 0, eventLoopLagMaxMs: 47_000 })}\\n\`), 50);`,
      "setTimeout(() => { clearInterval(t); process.exit(1); }, 600);",
    ].join("\n"),
    "utf8",
  );
  const { tree, events } = makeTree({ childScript: file }, { healthPollMs: 50, crashLoopThreshold: 10 });
  try {
    assert.equal((await tree.open(ref)).status, "open");
    await waitFor("the crash decision", () => events.some((e) => e.reason === "crash"), 10_000);

    const crash = events.find((e) => e.reason === "crash")!;
    assert.equal(crash.eventLoopLagMaxMs, 47_000);
    assert.match(supervisionLines(ref)[0], /eventLoopLagMaxMs=47000/);
  } finally {
    await tree.shutdown();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
