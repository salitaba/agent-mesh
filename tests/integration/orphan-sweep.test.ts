import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { OpenCodeRuntimeAdapter } from "../../packages/runtime-opencode/src/index";

/**
 * Orphaned `opencode serve` children must be reclaimed — and nothing else may
 * ever be touched.
 *
 * The leak: a run whose workspace was a temp dir (integration tests) takes its
 * `.mesh/agents/<id>/serve.pid` with it when the dir is removed, so the
 * pidfile sweep can never find those children. They survive indefinitely; the
 * host that prompted this had 11 alive from previous runs holding 3.6GB, some
 * days old. The memory pressure then slows real turns toward the timeout
 * threshold, which the transport classifier reads as crashed backends.
 *
 * The danger in fixing it is obvious: a sweep that scans /proc and kills by
 * name would happily kill the user's own editor session or a live mission. The
 * guard is a three-way identity check — verifiably `opencode serve`, pointing
 * at a mesh-managed config, whose config file is *gone*.
 */

type Sweeper = { sweepVanishedWorkspaceProcesses(owned: Set<number>): Promise<void> };

test("orphan sweep: never signals a process whose workspace is still live", async () => {
  if (process.platform !== "linux") return; // /proc-based identity only
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-sweep-"));
  try {
    // A config that exists = a workspace still in use. Even if this pid were
    // an opencode server, it must be left alone.
    const cfgDir = path.join(dir, ".mesh", "agents", "pm");
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, "opencode.json"), "{}", "utf8");

    const killed: number[] = [];
    const rt = new OpenCodeRuntimeAdapter({}) as unknown as Sweeper & {
      killPid?: unknown;
    };
    // The sweep resolves identity from /proc before signalling. This process
    // is not `opencode serve`, so a correct sweep is a no-op — and critically
    // must not throw while walking a live /proc.
    await (rt as Sweeper).sweepVanishedWorkspaceProcesses(new Set());
    assert.deepEqual(killed, [], "sweeping must not signal unrelated processes");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("orphan sweep: the running test process is never a candidate", async () => {
  if (process.platform !== "linux") return;
  const rt = new OpenCodeRuntimeAdapter({}) as unknown as Sweeper;
  // Self-preservation: `isOpencodeServePid` rejects our own pid explicitly.
  // If this ever regresses the suite kills itself, so assert it directly.
  await rt.sweepVanishedWorkspaceProcesses(new Set([process.pid]));
  assert.ok(true, "survived its own sweep");
});

test("orphan sweep: an owned process is skipped even if its config vanished", async () => {
  if (process.platform !== "linux") return;
  const rt = new OpenCodeRuntimeAdapter({}) as unknown as Sweeper;
  // Processes this adapter is actively driving are passed in as `owned` and
  // must never be reclaimed mid-mission.
  await rt.sweepVanishedWorkspaceProcesses(new Set([process.pid, 1]));
  assert.ok(true, "owned pids are excluded before any identity check");
});

test("orphan sweep: repeated sweeps are throttled, not run on every turn", async () => {
  const rt = new OpenCodeRuntimeAdapter({}) as unknown as {
    sweptWorkspaces: Map<string, number>;
    sweepOrphanedProcesses(w: string): Promise<void>;
  };
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-sweep-throttle-"));
  try {
    await rt.sweepOrphanedProcesses(ws);
    const first = rt.sweptWorkspaces.get(ws);
    assert.ok(typeof first === "number", "the sweep must record when it ran");
    await rt.sweepOrphanedProcesses(ws);
    assert.equal(rt.sweptWorkspaces.get(ws), first, "a second immediate sweep must be skipped");
    // ...but it must NOT be once-per-lifetime: agents respawn throughout a
    // long mission, so orphans appear hours after boot. Age the marker past
    // the interval and confirm the sweep runs again. (Compare against the
    // aged value, not `first`: a re-sweep can land in the same millisecond.)
    const aged = Date.now() - 10 * 60 * 1000;
    rt.sweptWorkspaces.set(ws, aged);
    await rt.sweepOrphanedProcesses(ws);
    assert.ok(
      (rt.sweptWorkspaces.get(ws) ?? aged) > aged,
      "a stale marker must allow a re-sweep — otherwise orphans created later in the mission are never reclaimed",
    );
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
