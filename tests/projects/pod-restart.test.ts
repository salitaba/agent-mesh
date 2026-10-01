/**
 * What a replacement pod finds on the volume the old one left behind.
 *
 * The pidfile in each project names a host pid and a child pid from a pid namespace that no longer
 * exists. The new pod numbers its processes from the same small integers, so those numbers are very
 * likely worn by processes of the new pod. Judged by number alone, a dead pod's host looked like a live
 * host (nothing was reaped and the debris stayed) and a dead pod's child could have been an innocent
 * process, which the sweep would have signalled. Start time settles which is which.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn, type ChildProcess } from "child_process";
import { ChildProcessSupervisor, PIDFILE_NAME, type ProjectRef } from "../../packages/projects/src/index";
import { processIdentity } from "../../packages/persistence/src/process-identity";
import { testConfigYaml } from "../helpers";

const haveProc = processIdentity(process.pid) !== null;
const AGENTS = { agents: [{ id: "a", role: "r", interests: [] }], mayContact: { a: [] } };

function project(id: string): ProjectRef {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-podrestart-"));
  fs.writeFileSync(path.join(dir, "mesh.yaml"), `project:\n  id: ${id}\n${testConfigYaml(AGENTS)}`, "utf8");
  const root = fs.realpathSync(dir);
  return { id, name: id, root, configPath: path.join(root, "mesh.yaml"), addedAt: new Date().toISOString() };
}

function writePidfile(ref: ProjectRef, record: Record<string, unknown>): string {
  const file = path.join(ref.root, ".mesh", PIDFILE_NAME);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ projectId: ref.id, ...record }), "utf8");
  return file;
}

const stray = (): ChildProcess => spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const supervisor = (): ChildProcessSupervisor => new ChildProcessSupervisor({ stopGraceMs: 1_000, readyTimeoutMs: 5_000 });

test("a child pid that is now a different process is left alone, and the pidfile is cleared", { skip: !haveProc }, async () => {
  const ref = project("recycled-child");
  const innocent = stray();
  try {
    const boot = processIdentity(process.pid)!.split(":")[0];
    // The old pod's child was pid N, started at tick 1. Pid N is now somebody else.
    const file = writePidfile(ref, { pid: innocent.pid, startId: `${boot}:1`, hostPid: 999_999 });
    assert.deepEqual(await supervisor().sweepOrphans([ref]), [], "nothing was a stranded child of this project");
    assert.ok(alive(innocent.pid!), "the process that merely shares the number was not signalled");
    assert.equal(fs.existsSync(file), false, "the debris is cleared so it is not re-examined every boot");
  } finally {
    innocent.kill("SIGKILL");
  }
});

test("a stranded child that really is the recorded process is still reaped", { skip: !haveProc }, async () => {
  const ref = project("real-orphan");
  const orphan = stray();
  try {
    writePidfile(ref, { pid: orphan.pid, startId: processIdentity(orphan.pid!), hostPid: 999_999 });
    assert.deepEqual(await supervisor().sweepOrphans([ref]), ["real-orphan"]);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(alive(orphan.pid!), false, "freeing the state lock is what reaping is for");
  } finally {
    orphan.kill("SIGKILL");
  }
});

test("a host pid that is now a different process does not count as a live host", { skip: !haveProc }, async () => {
  const ref = project("recycled-host");
  const orphan = stray();
  try {
    const boot = processIdentity(process.pid)!.split(":")[0];
    // hostPid is this very test process: alive by number, but not the host the pidfile was written by.
    writePidfile(ref, { pid: orphan.pid, startId: processIdentity(orphan.pid!), hostPid: process.pid, hostStartId: `${boot}:1` });
    assert.deepEqual(await supervisor().sweepOrphans([ref]), ["recycled-host"], "the host that owned it is gone, so the child is an orphan");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(alive(orphan.pid!), false);
  } finally {
    orphan.kill("SIGKILL");
  }
});

test("a child owned by a host that really is alive is neither reaped nor disturbed", { skip: !haveProc }, async () => {
  const ref = project("live-host");
  const child = stray();
  try {
    const file = writePidfile(ref, { pid: child.pid, startId: processIdentity(child.pid!), hostPid: process.pid, hostStartId: processIdentity(process.pid) });
    assert.deepEqual(await supervisor().sweepOrphans([ref]), []);
    assert.ok(alive(child.pid!));
    assert.equal(fs.existsSync(file), true, "another host's bookkeeping is not ours to delete");
  } finally {
    child.kill("SIGKILL");
  }
});

test("a pidfile from before identities existed behaves exactly as it did", async () => {
  const ref = project("old-format");
  const orphan = stray();
  try {
    writePidfile(ref, { pid: orphan.pid, hostPid: 999_999 });
    assert.deepEqual(await supervisor().sweepOrphans([ref]), ["old-format"]);
  } finally {
    orphan.kill("SIGKILL");
  }
});
