/**
 * The state lock when the writer is a pod.
 *
 * A Deployment replaces its pod under a new hostname, and a pod that is OOM-killed or evicted never
 * runs its shutdown, so the lock it held is still on the volume when its replacement starts. The old
 * rule (a lock from another host is never reclaimed) left that project locked until someone deleted the
 * file by hand, in a deployment whose whole point is to heal itself. Two answers, by what is known:
 *
 *   same deployment (MESH_INSTANCE_ID)  -> the holder is a process of an earlier life; judge it by
 *                                          whether THAT process still runs, not by its pid alone
 *   another instance                    -> only silence speaks: a heartbeat that stopped, for long enough
 *
 * and a holder that comes back after being taken over must stop writing, because two writers corrupt
 * the log.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  LOCK_STALE_MS,
  STATE_LOCK_FILENAME,
  StateLockError,
  acquireStateLock,
  judgeHolder,
  lockInstance,
  processIdentity,
  type HolderJudgement,
  type StateLockInfo,
} from "../../packages/persistence/src/index";

const haveProc = processIdentity(process.pid) !== null;
const NOW = Date.parse("2026-10-01T12:00:00Z");

function holder(over: Partial<StateLockInfo> = {}): StateLockInfo {
  return { pid: 31, host: "old-pod-7d9f", projectId: "p", startedAt: "2026-10-01T10:00:00Z", token: "t", ...over };
}

function me(over: Partial<HolderJudgement> = {}): HolderJudgement {
  return { instance: "mesh-prod", pid: 7, heldByMe: false, now: NOW, staleMs: LOCK_STALE_MS, reclaimForeign: true, ...over };
}

const ago = (ms: number): string => new Date(NOW - ms).toISOString();

// -------------------------------------------------------------- the decision

test("judge: no readable holder is taken", () => {
  assert.equal(judgeHolder(null, me()).reclaim, true);
});

test("judge: a dead pod's lock is taken at once when it is the same deployment, whatever the pod was called", () => {
  const deadPid = 2_147_483_000;
  const v = judgeHolder(holder({ instance: "mesh-prod", host: "mesh-prod-6c8f-abcde", pid: deadPid }), me());
  assert.equal(v.reclaim, true);
  assert.match(v.reason, /no longer running/);
});

test("judge: the same deployment, holder still running: not taken", () => {
  const v = judgeHolder(holder({ instance: "mesh-prod", pid: process.ppid }), me());
  assert.equal(v.reclaim, false);
  assert.match(v.reason, new RegExp(`pid ${process.ppid} is still running`));
});

test("judge: a locks written before instances existed falls back to the hostname for 'same deployment'", () => {
  const v = judgeHolder(holder({ host: "mesh-prod", pid: 2_147_483_000 }), me({ instance: "mesh-prod" }));
  assert.equal(v.reclaim, true, "host equals this instance, the holder is dead: the old same-host rule, unchanged");
});

test("judge: the holder's pid is worn by a different process now (a new container): taken", { skip: !haveProc }, () => {
  const boot = processIdentity(process.pid)!.split(":")[0];
  const v = judgeHolder(holder({ instance: "mesh-prod", pid: process.ppid, startId: `${boot}:1` }), me());
  assert.equal(v.reclaim, true, "alive by number, not the process that took the lock");
});

test("judge: the holder's pid is the very process that took the lock: not taken", { skip: !haveProc }, () => {
  const v = judgeHolder(holder({ instance: "mesh-prod", pid: process.ppid, startId: processIdentity(process.ppid)! }), me());
  assert.equal(v.reclaim, false);
});

test("judge: this process's own pid with no live handle is debris from a bootstrap that threw", () => {
  assert.equal(judgeHolder(holder({ instance: "mesh-prod", pid: 7 }), me({ pid: 7, heldByMe: false })).reclaim, true);
  assert.equal(judgeHolder(holder({ instance: "mesh-prod", pid: 7 }), me({ pid: 7, heldByMe: true })).reclaim, false);
});

test("judge: another instance's lock is taken only after its heartbeat has been silent for the stale window", () => {
  const at = (ms: number) => judgeHolder(holder({ heartbeatAt: ago(ms) }), me());
  assert.equal(at(5_000).reclaim, false);
  assert.equal(at(LOCK_STALE_MS - 1_000).reclaim, false);
  const stale = at(LOCK_STALE_MS + 1_000);
  assert.equal(stale.reclaim, true);
  assert.match(stale.reason, /no heartbeat from instance old-pod-7d9f for 121s/);
});

test("judge: a refusal says how long until it could be taken, so the restart loop is not a mystery", () => {
  const v = judgeHolder(holder({ heartbeatAt: ago(20_000) }), me());
  assert.equal(v.reclaim, false);
  assert.match(v.reason, /reported 20s ago/);
  assert.match(v.reason, /after 120s of silence/);
});

test("judge: another instance that never reports a heartbeat is never taken (a lock from before they existed)", () => {
  const v = judgeHolder(holder(), me());
  assert.equal(v.reclaim, false);
  assert.match(v.reason, /does not report a heartbeat/);
});

test("judge: a heartbeat from the future is a clock disagreement, not a death", () => {
  const v = judgeHolder(holder({ heartbeatAt: new Date(NOW + 5 * 60_000).toISOString() }), me());
  assert.equal(v.reclaim, false);
  assert.match(v.reason, /clocks disagree/);
  assert.equal(judgeHolder(holder({ heartbeatAt: new Date(NOW + 5_000).toISOString() }), me()).reclaim, false, "a little skew is fresh, not stale");
});

test("judge: an unreadable heartbeat is not evidence", () => {
  assert.equal(judgeHolder(holder({ heartbeatAt: "yesterday-ish" }), me()).reclaim, false);
});

test("judge: taking over another instance's lock can be switched off, whatever the age", () => {
  const v = judgeHolder(holder({ heartbeatAt: ago(10 * 60_000) }), me({ reclaimForeign: false }));
  assert.equal(v.reclaim, false);
  assert.match(v.reason, /switched off/);
});

test("the instance is MESH_INSTANCE_ID when set, and the hostname when not", () => {
  assert.equal(lockInstance({ MESH_INSTANCE_ID: "  mesh-prod " }), "mesh-prod");
  assert.equal(lockInstance({}), os.hostname());
  assert.equal(lockInstance({ MESH_INSTANCE_ID: "   " }), os.hostname());
});

// ------------------------------------------------------------ on real files

function dirOf(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mesh-podlock-"));
}
const lockFile = (dir: string): string => path.join(dir, STATE_LOCK_FILENAME);
const readLock = (dir: string): StateLockInfo => JSON.parse(fs.readFileSync(lockFile(dir), "utf8")) as StateLockInfo;
function plant(dir: string, info: Partial<StateLockInfo>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(lockFile(dir), JSON.stringify(holder(info)), "utf8");
}

test("the replacement pod takes the dead pod's lock at once when the deployment names itself", () => {
  const dir = dirOf();
  try {
    plant(dir, { instance: "mesh-prod", host: "mesh-prod-6c8f-old", pid: 2_147_483_000, token: "dead-pod" });
    const lock = acquireStateLock(dir, { projectId: "p", instance: "mesh-prod" });
    const held = readLock(dir);
    assert.equal(held.pid, process.pid);
    assert.equal(held.instance, "mesh-prod");
    assert.notEqual(held.token, "dead-pod");
    lock.release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("without an instance id, the replacement waits out the silence and then takes the lock", () => {
  const dir = dirOf();
  try {
    let t = NOW;
    plant(dir, { host: "old-pod-7d9f", pid: 31, heartbeatAt: new Date(t - 20_000).toISOString() });
    assert.throws(
      () => acquireStateLock(dir, { projectId: "p", instance: "new-pod-1a2b", now: () => t }),
      (err: unknown) => err instanceof StateLockError && /reported 20s ago/.test((err as Error).message),
    );
    assert.equal(readLock(dir).token, "t", "the refusal left the incumbent's lock alone");
    t += LOCK_STALE_MS;
    const lock = acquireStateLock(dir, { projectId: "p", instance: "new-pod-1a2b", now: () => t });
    assert.equal(readLock(dir).pid, process.pid);
    lock.release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MESH_LOCK_RECLAIM_FOREIGN=0 keeps the old never-take-another-host's-lock rule", () => {
  const dir = dirOf();
  const prev = process.env.MESH_LOCK_RECLAIM_FOREIGN;
  process.env.MESH_LOCK_RECLAIM_FOREIGN = "0";
  try {
    plant(dir, { host: "old-pod-7d9f", pid: 31, heartbeatAt: ago(60 * 60_000) });
    assert.throws(() => acquireStateLock(dir, { projectId: "p", instance: "new-pod", now: () => NOW }), StateLockError);
  } finally {
    if (prev === undefined) delete process.env.MESH_LOCK_RECLAIM_FOREIGN;
    else process.env.MESH_LOCK_RECLAIM_FOREIGN = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MESH_LOCK_STALE_MS moves the window", () => {
  const dir = dirOf();
  const prev = process.env.MESH_LOCK_STALE_MS;
  process.env.MESH_LOCK_STALE_MS = "5000";
  try {
    plant(dir, { host: "old-pod-7d9f", pid: 31, heartbeatAt: ago(10_000) });
    const lock = acquireStateLock(dir, { projectId: "p", instance: "new-pod", now: () => NOW });
    lock.release();
  } finally {
    if (prev === undefined) delete process.env.MESH_LOCK_STALE_MS;
    else process.env.MESH_LOCK_STALE_MS = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------- the heartbeat

test("a held lock keeps saying it is alive, and stops when released", async () => {
  const dir = dirOf();
  try {
    const lock = acquireStateLock(dir, { projectId: "p", heartbeatMs: 20 });
    const first = readLock(dir).heartbeatAt!;
    await new Promise((r) => setTimeout(r, 150));
    const later = readLock(dir).heartbeatAt!;
    assert.ok(Date.parse(later) > Date.parse(first), "the heartbeat advanced");
    lock.release();
    assert.equal(fs.existsSync(lockFile(dir)), false);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(fs.existsSync(lockFile(dir)), false, "a released lock is not rewritten by a timer that outlived it");
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), [], "no half-written file is left behind");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a holder that finds its lock taken says so and stops, and releasing afterwards does not delete the new holder's lock", async () => {
  const dir = dirOf();
  try {
    let lostTo: StateLockInfo | undefined;
    const lock = acquireStateLock(dir, { projectId: "p", heartbeatMs: 20, onLost: (h) => (lostTo = h) });
    // Another process took it while this one was paused.
    fs.writeFileSync(lockFile(dir), JSON.stringify(holder({ token: "usurper", pid: 99, host: "new-pod", projectId: "p" })), "utf8");
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(lostTo?.token, "usurper", "told who took it");
    assert.equal(readLock(dir).token, "usurper", "and did not overwrite the new holder");
    lock.release();
    assert.equal(readLock(dir).token, "usurper", "releasing a lost lock is a no-op");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a beat does not conjure back a state directory that a mission reset moved away", async () => {
  const base = dirOf();
  const dir = path.join(base, "state");
  try {
    const lock = acquireStateLock(dir, { projectId: "p", heartbeatMs: 20 });
    fs.renameSync(dir, `${dir}-archived`);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(fs.existsSync(dir), false, "the reset owns the directory until it calls refresh()");
    fs.mkdirSync(dir);
    lock.refresh();
    assert.equal(readLock(dir).token, lock.info.token);
    lock.release();
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
