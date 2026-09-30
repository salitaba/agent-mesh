import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import { HOST_PID_ENV, findOrphanSeats, reapOrphanSeats, seatEnv } from "../../packages/runtime-claude/src/orphans";
import { ClaudeRuntimeAdapter, type ClaudeAdapterOptions } from "../../packages/runtime-claude/src/index";
import type { AgentDefinition, RuntimeContext } from "../../packages/protocol/src/index";

/**
 * Seat CLIs a dead mesh process left running.
 *
 * SIGKILL takes the parent and leaves the `claude` child: reparented to init,
 * mid-turn, still calling the API with its spend recorded nowhere (pid 8267 was
 * still CPU-active 56 s after the kill, 2026-09-30), while the restarted mesh
 * resumed the same session id beside it. Every seat CLI is stamped with the pid of
 * the process that spawned it; the next process to start stops the stamped ones
 * whose host is gone, before it spawns anything.
 */

const SELF = 7_000;
const DEAD_HOST = 4_242;
const LIVE_HOST = 4_343;

/** A fake /proc: `{pid: environ}` where a string is the NUL-separated environment and null is unreadable. */
function fakeProc(entries: Record<string, string | null>, stats: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-proc-"));
  for (const [name, environ] of Object.entries(entries)) {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    if (environ !== null) fs.writeFileSync(path.join(dir, name, "environ"), environ, "utf8");
  }
  for (const [name, stat] of Object.entries(stats)) {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, "stat"), stat, "utf8");
  }
  return dir;
}
const stamp = (hostPid: number | string) => `PATH=/usr/bin\0${HOST_PID_ENV}=${hostPid}\0HOME=/root\0`;

test("a stamped process whose host is gone is an orphan; nothing else is", () => {
  const procDir = fakeProc({
    "100": stamp(DEAD_HOST), // the orphan
    "101": stamp(LIVE_HOST), // another mesh that is still running
    "102": stamp(SELF), // this process's own child
    "103": "PATH=/usr/bin\0HOME=/root\0", // an unrelated process
    "104": stamp("not-a-pid"), // a stamp that names nothing
    "105": null, // another user's: unreadable
    "1": stamp(DEAD_HOST), // init is never a seat
    self: stamp(DEAD_HOST), // not a pid
  });
  try {
    const found = findOrphanSeats({ procDir, selfPid: SELF, isAlive: (pid) => pid === LIVE_HOST || pid === SELF });
    assert.deepEqual(found, [{ pid: 100, hostPid: DEAD_HOST }]);
  } finally {
    fs.rmSync(procDir, { recursive: true, force: true });
  }
});

test("a host that is a zombie counts as gone, and one that is running does not", () => {
  // The zombie's pid still answers kill(0), which is why the scan reads its state.
  // `comm` with spaces and a parenthesis is the shape that breaks a naive split.
  const host = process.pid;
  const asZombie = fakeProc({ "100": stamp(host) }, { [String(host)]: `${host} (mesh (x) y) Z 1 1 1 0 -1 4194560` });
  const asRunning = fakeProc({ "100": stamp(host) }, { [String(host)]: `${host} (mesh (x) y) S 1 1 1 0 -1 4194560` });
  try {
    assert.deepEqual(findOrphanSeats({ procDir: asZombie, selfPid: SELF }), [{ pid: 100, hostPid: host }]);
    assert.deepEqual(findOrphanSeats({ procDir: asRunning, selfPid: SELF }), []);
  } finally {
    fs.rmSync(asZombie, { recursive: true, force: true });
    fs.rmSync(asRunning, { recursive: true, force: true });
  }
});

test("reaping: SIGTERM first, SIGKILL only for what ignored it, and a process that will not die is reported", async () => {
  const procDir = fakeProc({ "100": stamp(DEAD_HOST), "106": stamp(DEAD_HOST), "107": stamp(DEAD_HOST) });
  try {
    const up = new Set([100, 106, 107]);
    const sent: Array<[number, string]> = [];
    const res = await reapOrphanSeats({
      procDir,
      selfPid: SELF,
      graceMs: 0,
      sleep: async () => undefined,
      isAlive: (pid) => up.has(pid),
      kill: (pid, sig) => {
        sent.push([pid, sig]);
        // 100 exits on SIGTERM; 106 ignores it and dies to SIGKILL; 107 survives both.
        if (pid === 100 && sig === "SIGTERM") up.delete(100);
        if (pid === 106 && sig === "SIGKILL") up.delete(106);
      },
    });

    assert.deepEqual(sent.filter(([, s]) => s === "SIGTERM").map(([p]) => p), [100, 106, 107], "every orphan is asked to stop first");
    assert.deepEqual(sent.filter(([, s]) => s === "SIGKILL").map(([p]) => p), [106, 107], "and only the ones still up are killed");
    assert.deepEqual(res.stopped.sort(), [100, 106]);
    assert.deepEqual(res.survivors, [107]);
  } finally {
    fs.rmSync(procDir, { recursive: true, force: true });
  }
});

test("reaping with nothing to reap signals nothing and waits for nothing", async () => {
  const procDir = fakeProc({ "103": "PATH=/usr/bin\0" });
  try {
    let slept = false;
    const res = await reapOrphanSeats({ procDir, selfPid: SELF, sleep: async () => void (slept = true), kill: () => assert.fail("nothing to signal") });
    assert.deepEqual(res, { found: [], stopped: [], survivors: [] });
    assert.equal(slept, false);
    // And a machine with no /proc at all (macOS, Windows) is simply nothing to do.
    assert.deepEqual(findOrphanSeats({ procDir: path.join(procDir, "nope") }), []);
  } finally {
    fs.rmSync(procDir, { recursive: true, force: true });
  }
});

test("seatEnv: the stamp rides on the operator's own environment, which it does not replace", () => {
  assert.equal(seatEnv({ PATH: "/x", KEEP: "1" }, 99)[HOST_PID_ENV], "99");
  assert.deepEqual(seatEnv({ PATH: "/x", KEEP: "1" }, 99), { PATH: "/x", KEEP: "1", [HOST_PID_ENV]: "99" });
  // No base: the process environment, as the SDK would have inherited it, plus the stamp.
  const inherited = seatEnv(undefined, 99);
  assert.equal(inherited[HOST_PID_ENV], "99");
  assert.equal(inherited.PATH, process.env.PATH);
  // A stale stamp inherited from a parent mesh is overwritten, never kept.
  assert.equal(seatEnv({ [HOST_PID_ENV]: "1" }, 99)[HOST_PID_ENV], "99");
});

test("a real orphan is found by its stamp and stopped", { skip: process.platform !== "linux" }, async () => {
  // A pid that certainly names nobody: a child that has already exited.
  const dead = spawn(process.execPath, ["-e", "0"]);
  await new Promise((resolve) => dead.once("exit", resolve));
  const deadPid = dead.pid!;

  const orphan = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    env: { ...process.env, [HOST_PID_ENV]: String(deadPid) },
    stdio: "ignore",
  });
  const exited = new Promise((resolve) => orphan.once("exit", resolve));
  try {
    // Signals only the fixture: the real /proc is scanned, but a stray orphan on the
    // machine running the tests is none of this test's business.
    const res = await reapOrphanSeats({ graceMs: 2000, kill: (pid, sig) => void (pid === orphan.pid && process.kill(pid, sig)) });
    assert.ok(res.found.some((o) => o.pid === orphan.pid && o.hostPid === deadPid), "the stamped process with a dead host was found");
    await exited;
    assert.equal(orphan.exitCode === null ? orphan.signalCode : "exited", "SIGTERM", "and stopped with SIGTERM, which a seat CLI honours");
  } finally {
    orphan.kill("SIGKILL");
  }
});

// ---------------------------------------------------------------- the adapter

const devDef: AgentDefinition = {
  id: "developer",
  role: "developer",
  mode: "peer",
  runtime: "claude",
  prompt: { text: "you build things" },
  capabilities: ["repository.write"],
  authority: [],
  communicationPolicy: { mayContact: [], mayBeContactedBy: [] },
  interests: [],
  sessionPolicy: { persistent: true },
  delegationPolicy: { allowDelegation: false, maxDepth: 0, maxWorkers: 0 },
  budget: {},
};
const ctx = (dir: string): RuntimeContext => ({
  goalId: "goal-1",
  meshId: "test",
  workspacePath: dir,
  busUrl: "http://127.0.0.1:1",
  agentToken: "test:developer:abcd",
  rolePromptText: "you build things",
  capabilityGrants: devDef.capabilities,
  env: {},
});

/** A transport that records how it was spawned and never answers, which is all `start` needs. */
function recordingQuery(log: string[], seen: Array<Record<string, unknown>>): ClaudeAdapterOptions["queryFn"] {
  return (({ prompt, options }: { prompt: unknown; options: Record<string, unknown> }) => {
    log.push("spawn");
    seen.push(options);
    const gen = (async function* () {
      yield { type: "system", subtype: "init", session_id: String(options.sessionId ?? options.resume), model: "claude-test", mcp_servers: [{ name: "mesh", status: "connected" }] };
      for await (const _ of prompt as AsyncIterable<unknown>) void _;
    })();
    return Object.assign(gen, {
      interrupt: async () => undefined,
      setPermissionMode: async () => undefined,
      setModel: async () => undefined,
      supportedModels: async () => [],
      supportedCommands: async () => [],
      mcpServerStatus: async () => ({}),
    });
  }) as unknown as ClaudeAdapterOptions["queryFn"];
}

test("the adapter stamps every seat CLI, on top of the operator's own env", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-orph-"));
  const seen: Array<Record<string, unknown>> = [];
  const rt = new ClaudeRuntimeAdapter({ queryFn: recordingQuery([], seen), extraOptions: { env: { ONLY_THIS: "1" } } });
  try {
    const s = await rt.start(devDef, ctx(dir));
    await rt.stop(s);
    const env = seen[0]!.env as Record<string, string>;
    assert.equal(env[HOST_PID_ENV], String(process.pid));
    assert.equal(env.ONLY_THIS, "1", "the operator's env is kept");
    assert.equal(env.PATH, undefined, "and not silently widened to the whole process environment");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the adapter reaps once, before the first seat is spawned, and says what it stopped", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-orph-"));
  const log: string[] = [];
  const notices: Array<{ kind: string; message: string }> = [];
  const rt = new ClaudeRuntimeAdapter({
    queryFn: recordingQuery(log, []),
    reapOrphans: async () => {
      log.push("reap");
      return { found: [{ pid: 555, hostPid: DEAD_HOST }], stopped: [555], survivors: [] };
    },
    onNotice: (n) => notices.push(n),
  });
  try {
    const a = await rt.start(devDef, ctx(dir));
    const b = await rt.restoreSession(devDef, "11111111-1111-4111-8111-111111111111", ctx(dir));
    await rt.stop(a);
    if (b) await rt.stop(b);
    assert.deepEqual(log.slice(0, 2), ["reap", "spawn"], "the reaper runs before the first spawn");
    assert.equal(log.filter((l) => l === "reap").length, 1, "once per adapter, not once per seat");
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.kind, "orphan_seats_reaped");
    assert.match(notices[0]!.message, /stopped 1 seat process\(es\).*pid 4242.*555/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a reaper that throws does not stop a seat from starting; and a fake transport reaps nothing by default", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-orph-"));
  const log: string[] = [];
  try {
    const failing = new ClaudeRuntimeAdapter({
      queryFn: recordingQuery(log, []),
      reapOrphans: async () => {
        throw new Error("/proc is unreadable");
      },
    });
    const s = await failing.start(devDef, ctx(dir));
    await failing.stop(s);
    assert.deepEqual(log, ["spawn"]);

    // No `reapOrphans` and a replaced transport: a test must not go signalling real processes.
    const quiet = new ClaudeRuntimeAdapter({ queryFn: recordingQuery(log, []), onNotice: () => assert.fail("no reaping was asked for") });
    const q = await quiet.start(devDef, ctx(dir));
    await quiet.stop(q);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
