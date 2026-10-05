import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { bashTool, shellEnv, ToolFailure } from "../../packages/runtime-native/src/index";
import { run, workspace } from "./support";

/** Bash: bounded in time and output, unable to leave a process behind, and started with only what a seat may hold. */

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const until = async (what: string, cond: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

test("a command's output is returned, stdout and stderr together, and it runs in the workspace", async () => {
  const ws = workspace({ "marker.txt": "here" });
  try {
    const r = await run(bashTool, { command: "pwd; ls; echo out; echo err >&2" }, ws);
    assert.equal(r.text, `${ws.cwd}\nmarker.txt\nout\nerr\n`);
    assert.ok(!r.isError);
  } finally {
    ws.cleanup();
  }
});

test("a command that fails reports its exit code, and has still run: it is not a failed call", async () => {
  const ws = workspace();
  try {
    const r = await run(bashTool, { command: "echo tests failed; exit 3" }, ws);
    assert.equal(r.text, "tests failed\n[exit code: 3]");
    assert.ok(!r.isError, "a failing test run checked something");
    assert.equal((await run(bashTool, { command: "true" }, ws)).text, "(no output)");
  } finally {
    ws.cleanup();
  }
});

test("a command that outlives its timeout is killed, with its children, and the call is a failed one", async () => {
  const ws = workspace();
  try {
    const pidFile = path.join(ws.cwd, "child.pid");
    const started = Date.now();
    const r = await run(bashTool, { command: `sleep 30 & echo $! > ${pidFile}; wait`, timeout: 300 }, ws);
    assert.ok(Date.now() - started < 5000, "it did not wait for the sleep");
    assert.match(r.text, /\[timed out after 0s and was killed\]|\[timed out after \d+s and was killed\]/);
    assert.equal(r.isError, true);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    await until("the child to die", () => !alive(pid));
  } finally {
    ws.cleanup();
  }
});

test("the mesh ending the turn stops the command at once", async () => {
  const ws = workspace();
  try {
    const started = Date.now();
    const pending = run(bashTool, { command: "echo started; sleep 30" }, ws);
    setTimeout(() => ws.abort.abort(), 150);
    const r = await pending;
    assert.ok(Date.now() - started < 5000);
    assert.match(r.text, /started/);
    assert.match(r.text, /\[stopped: the mesh ended this turn\]/);
    assert.equal(r.isError, true);
  } finally {
    ws.cleanup();
  }
});

test("a command that starts something in the background does not leave it running", async () => {
  const ws = workspace();
  try {
    const pidFile = path.join(ws.cwd, "bg.pid");
    const r = await run(bashTool, { command: `(sleep 60 </dev/null >/dev/null 2>&1 & echo $! > ${pidFile}); echo done` }, ws);
    assert.equal(r.text, "done\n");
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    await until("the background process to be killed", () => !alive(pid));
  } finally {
    ws.cleanup();
  }
});

test("a flood of output is kept to its beginning and its end, with the middle accounted for", async () => {
  const ws = workspace();
  try {
    const r = await run(bashTool, { command: `node -e "process.stdout.write('A'.repeat(20000) + 'M'.repeat(200000) + 'Z'.repeat(10000))"` }, ws);
    assert.ok(r.text.length < 31_000, `${r.text.length}`);
    assert.ok(r.text.startsWith("A".repeat(20000)));
    assert.ok(r.text.trimEnd().endsWith("Z".repeat(10000)));
    assert.match(r.text, /\[\.\.\. 200000 characters omitted \.\.\.\]/);
  } finally {
    ws.cleanup();
  }
});

test("there is no stdin: a command that reads it gets the end of input and does not hang", async () => {
  const ws = workspace();
  try {
    const started = Date.now();
    const r = await run(bashTool, { command: "cat; echo after" }, ws);
    assert.equal(r.text, "after\n");
    assert.ok(Date.now() - started < 3000);
  } finally {
    ws.cleanup();
  }
});

test("each call is a fresh shell, and the environment is the one the runtime gave it", async () => {
  const ws = workspace();
  try {
    ws.ctx.shellEnv = { ...ws.ctx.shellEnv, ONLY_THIS: "yes" };
    await run(bashTool, { command: "cd /tmp; export LEAK=1" }, ws);
    const r = await run(bashTool, { command: 'echo "[$LEAK] [$ONLY_THIS] [$MESH_API_TOKEN] [$HOME]"' }, ws);
    assert.equal(r.text, `[] [yes] [] [${ws.base}]\n`);
  } finally {
    ws.cleanup();
  }
});

test("a bad timeout or a missing command is refused in plain words", async () => {
  const ws = workspace();
  try {
    await assert.rejects(run(bashTool, {}, ws), (e: unknown) => e instanceof ToolFailure && /command is required/.test(e.message));
    await assert.rejects(run(bashTool, { command: "true", timeout: 700000 }, ws), (e: unknown) => e instanceof ToolFailure && /timeout must be at most 600000/.test(e.message));
  } finally {
    ws.cleanup();
  }
});

test("a shell's environment never carries the mesh's credentials or the runtime's provider keys, in either mode", () => {
  const base = {
    PATH: "/usr/bin",
    HOME: "/home/u",
    LANG: "C.UTF-8",
    LC_ALL: "C",
    MESH_API_TOKEN: "operator",
    MESH_LICENSE: "AML1.x",
    MESH_AGENT_TOKEN: "seat",
    OPENAI_API_KEY: "sk-openai",
    CURULE_GATEWAY_KEY: "cvk_1",
    GITHUB_TOKEN: "gh",
    SECRET_UNRELATED: "x",
  };
  const deny = ["OPENAI_API_KEY", "CURULE_GATEWAY_KEY"];
  const inherit = shellEnv(base, "inherit", deny);
  assert.deepEqual(Object.keys(inherit).sort(), ["GITHUB_TOKEN", "GIT_PAGER", "GIT_TERMINAL_PROMPT", "HOME", "LANG", "LC_ALL", "PAGER", "PATH", "SECRET_UNRELATED", "TERM"]);
  const minimal = shellEnv(base, "minimal", deny);
  assert.deepEqual(Object.keys(minimal).sort(), ["GIT_PAGER", "GIT_TERMINAL_PROMPT", "HOME", "LANG", "LC_ALL", "PAGER", "PATH", "TERM"]);
  assert.equal(minimal.GIT_TERMINAL_PROMPT, "0", "git never waits on a credential prompt nobody can answer");
  assert.equal(shellEnv(base, "minimal", [], { EXTRA: "1" }).EXTRA, "1");
});
