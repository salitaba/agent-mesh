/**
 * A pid says "something is running under this number". Once a state directory outlives the container
 * that wrote into it, that is the wrong question: the next container numbers its processes from the
 * same small integers. These pin the identity that replaces it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "child_process";
import { pidAlive, processAlive, processIdentity, startTimeFromStat } from "../../packages/persistence/src/process-identity";

const haveProc = processIdentity(process.pid) !== null;

/** A /proc/<pid>/stat line whose field N holds the value N, for N >= 3, with the given comm. */
function fakeStat(pid: number, comm: string): string {
  const fields = Array.from({ length: 50 }, (_, i) => String(i + 3));
  return `${pid} (${comm}) ${fields.join(" ")}\n`;
}

test("the start time is field 22, wherever the command name puts its spaces and parentheses", () => {
  for (const comm of ["node", "my proc", "a (b) c", "))((", "x y) z (w", ""]) {
    assert.equal(startTimeFromStat(fakeStat(4242, comm)), "22", `comm ${JSON.stringify(comm)}`);
  }
  assert.equal(startTimeFromStat("garbage"), null);
  assert.equal(startTimeFromStat("1 (a) S 1 2"), null, "a short line is not guessed at");
  assert.equal(startTimeFromStat(`1 (a) ${Array.from({ length: 30 }, () => "x").join(" ")}`), null, "a non-numeric field is not a start time");
});

test("a live process has a stable identity, and a different process has a different one", { skip: !haveProc }, async () => {
  const mine = processIdentity(process.pid);
  assert.match(mine!, /^[0-9a-f-]{36}:\d+$/, "boot id and start ticks");
  assert.equal(processIdentity(process.pid), mine, "stable for the life of the process");
  const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  try {
    const theirs = processIdentity(other.pid!);
    assert.ok(theirs && theirs !== mine);
    assert.equal(theirs!.split(":")[0], mine!.split(":")[0], "same boot");
  } finally {
    other.kill("SIGKILL");
  }
});

test("an exited process has no identity, and nonsense pids have none", { skip: !haveProc }, async () => {
  const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
  await new Promise((r) => child.once("exit", r));
  assert.equal(processIdentity(child.pid!), null);
  for (const pid of [0, -1, 1.5, NaN]) assert.equal(processIdentity(pid), null, String(pid));
});

test("a pid is the recorded process only if its identity matches; an old record without one is judged by the pid alone", { skip: !haveProc }, async () => {
  const mine = processIdentity(process.pid)!;
  assert.equal(processAlive(process.pid, mine), true);
  assert.equal(processAlive(process.pid, `${mine.split(":")[0]}:1`), false, "the number is taken by a different process now");
  assert.equal(processAlive(process.pid, "another-boot:" + mine.split(":")[1]), false, "same ticks, different boot");
  assert.equal(processAlive(process.pid), true, "no identity recorded: the pid is all there is to go on");
  assert.equal(processAlive(process.pid, null), true);
  const dead = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
  await new Promise((r) => dead.once("exit", r));
  assert.equal(processAlive(dead.pid!, mine), false);
  assert.equal(pidAlive(dead.pid!), false);
});

test("where identities cannot be read, a recorded one does not condemn a live pid", { skip: haveProc }, () => {
  assert.equal(processAlive(process.pid, "anything:1"), true);
});
