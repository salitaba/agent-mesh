import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  acquireStateLock,
  StateLockError,
  STATE_LOCK_FILENAME,
  type StateLockInfo,
} from "../../packages/persistence/src/index";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mesh-lock-"));
}

function lockFile(dir: string): string {
  return path.join(dir, STATE_LOCK_FILENAME);
}

function writeHolder(dir: string, info: Partial<StateLockInfo>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    lockFile(dir),
    JSON.stringify({
      pid: 1,
      host: os.hostname(),
      projectId: "other",
      startedAt: new Date().toISOString(),
      token: "foreign-token",
      ...info,
    }),
    "utf8",
  );
}

test("state lock: acquiring writes a lock file naming this process", () => {
  const dir = tmpDir();
  try {
    const lock = acquireStateLock(dir, { projectId: "demo" });
    assert.ok(fs.existsSync(lockFile(dir)), "lock file must exist while held");
    const held = JSON.parse(fs.readFileSync(lockFile(dir), "utf8")) as StateLockInfo;
    assert.equal(held.pid, process.pid);
    assert.equal(held.projectId, "demo");
    assert.equal(held.host, os.hostname());
    assert.ok(held.token.length > 0, "a generation token is required for safe release");
    lock.release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("state lock: the directory is created if missing", () => {
  const base = tmpDir();
  const dir = path.join(base, "nested", "state");
  try {
    const lock = acquireStateLock(dir);
    assert.ok(fs.existsSync(lockFile(dir)));
    lock.release();
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("state lock: a live holder rejects the second acquisition", () => {
  const dir = tmpDir();
  try {
    // A live PID that is not ours: the test runner's own parent is guaranteed
    // to exist for the duration of the test.
    writeHolder(dir, { pid: process.ppid, projectId: "first" });
    assert.throws(
      () => acquireStateLock(dir, { projectId: "second" }),
      (err: unknown) => {
        assert.ok(err instanceof StateLockError, "must be a StateLockError, not a bare Error");
        assert.equal(err.holder?.pid, process.ppid);
        assert.match(err.message, /already in use/);
        // The message must name the holding PID: "locked" with no owner is
        // an unactionable error for someone with two terminals open.
        assert.match(err.message, new RegExp(String(process.ppid)));
        return true;
      },
    );
    // The rejected attempt must not have clobbered the incumbent's lock.
    const still = JSON.parse(fs.readFileSync(lockFile(dir), "utf8")) as StateLockInfo;
    assert.equal(still.projectId, "first");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("state lock: this process opening the same dir twice is rejected", () => {
  const dir = tmpDir();
  let first: ReturnType<typeof acquireStateLock> | undefined;
  try {
    first = acquireStateLock(dir, { projectId: "a" });
    assert.throws(() => acquireStateLock(dir, { projectId: "b" }), StateLockError);
  } finally {
    first?.release();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("state lock: a stale lock with a dead PID is reclaimed", () => {
  const dir = tmpDir();
  try {
    // Find a PID that is definitely not running rather than assuming one.
    let deadPid = 999_999;
    for (; deadPid > 100_000; deadPid--) {
      try {
        process.kill(deadPid, 0);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ESRCH") break;
      }
    }
    writeHolder(dir, { pid: deadPid, projectId: "crashed" });
    const lock = acquireStateLock(dir, { projectId: "recovered" });
    const held = JSON.parse(fs.readFileSync(lockFile(dir), "utf8")) as StateLockInfo;
    assert.equal(held.pid, process.pid, "the dead holder's lock must be taken over");
    assert.equal(held.projectId, "recovered");
    lock.release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("state lock: a lock from another host is never reclaimed", () => {
  const dir = tmpDir();
  try {
    // Liveness is unknowable across machines, and a shared filesystem is
    // exactly where guessing "probably dead" corrupts the log.
    writeHolder(dir, { pid: 424242, host: "some-other-machine" });
    assert.throws(() => acquireStateLock(dir), StateLockError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("state lock: an unparseable lock file does not wedge the directory", () => {
  const dir = tmpDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(lockFile(dir), '{"pid": 12', "utf8"); // killed mid-write
    const lock = acquireStateLock(dir, { projectId: "recovered" });
    const held = JSON.parse(fs.readFileSync(lockFile(dir), "utf8")) as StateLockInfo;
    assert.equal(held.pid, process.pid);
    lock.release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("state lock: release removes the file and allows re-acquisition", () => {
  const dir = tmpDir();
  try {
    const first = acquireStateLock(dir, { projectId: "a" });
    first.release();
    assert.ok(!fs.existsSync(lockFile(dir)), "release must remove the lock file");
    const second = acquireStateLock(dir, { projectId: "b" });
    second.release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("state lock: release is idempotent and never unlinks a newer lock", () => {
  const dir = tmpDir();
  try {
    const first = acquireStateLock(dir, { projectId: "a" });
    first.release();
    const second = acquireStateLock(dir, { projectId: "b" });
    // Double release of the old handle must not evict the current holder.
    first.release();
    assert.ok(fs.existsSync(lockFile(dir)), "the second lock must survive a stale release");
    const held = JSON.parse(fs.readFileSync(lockFile(dir), "utf8")) as StateLockInfo;
    assert.equal(held.projectId, "b");
    second.release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("state lock: refresh restores the lock after the state dir is replaced", () => {
  const dir = tmpDir();
  try {
    const lock = acquireStateLock(dir, { projectId: "a" });
    // What archiveStateDir does: rename the whole directory away, recreate it.
    fs.renameSync(dir, `${dir}-archived`);
    fs.mkdirSync(dir, { recursive: true });
    assert.ok(!fs.existsSync(lockFile(dir)), "precondition: the lock left with the archive");
    lock.refresh();
    assert.ok(fs.existsSync(lockFile(dir)), "refresh must re-stake the claim");
    // Still exclusive afterwards.
    assert.throws(() => acquireStateLock(dir, { projectId: "b" }), StateLockError);
    lock.release();
    fs.rmSync(`${dir}-archived`, { recursive: true, force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
