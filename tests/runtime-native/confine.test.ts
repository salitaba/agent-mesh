import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { confine, realPath, touchesGitDir, isInside } from "../../packages/runtime-native/src/index";
import { workspace } from "./support";

/**
 * A seat's file tools stay inside the directories it is given, by the path the kernel will actually open: a link out of the
 * workspace is not a way out, and a file that does not exist yet is held to the same rule as one that does.
 */

test("a path inside the workspace is accepted, relative or absolute, and comes back as its real path", () => {
  const ws = workspace({ "src/a.ts": "x" });
  try {
    assert.equal(confine("src/a.ts", ws.cwd, [ws.cwd], "read"), path.join(ws.cwd, "src", "a.ts"));
    assert.equal(confine(path.join(ws.cwd, "src", "a.ts"), ws.cwd, [ws.cwd], "read"), path.join(ws.cwd, "src", "a.ts"));
    assert.equal(confine(".", ws.cwd, [ws.cwd], "read"), ws.cwd);
  } finally {
    ws.cleanup();
  }
});

test("a way out is refused: .., an absolute path elsewhere, a sibling that shares the prefix, the process's own environment", () => {
  const ws = workspace();
  try {
    fs.mkdirSync(`${ws.cwd}-sibling`);
    for (const bad of ["../main/x", "../../etc/passwd", "/etc/passwd", `${ws.cwd}-sibling/x`, "/proc/self/environ", "src/../../ws2/x"]) {
      assert.throws(() => confine(bad, ws.cwd, [ws.cwd], "read"), /outside the directories this seat may read/, bad);
    }
  } finally {
    ws.cleanup();
  }
});

test("a symlink that points out of the workspace is not a way out, for a file, a directory or a file not yet written", () => {
  const ws = workspace();
  try {
    const secret = path.join(ws.base, "secret.txt");
    fs.writeFileSync(secret, "s3cret");
    fs.symlinkSync(secret, path.join(ws.cwd, "link.txt"));
    fs.symlinkSync(ws.base, path.join(ws.cwd, "outdir"));
    assert.throws(() => confine("link.txt", ws.cwd, [ws.cwd], "read"), /outside/);
    assert.throws(() => confine("outdir/secret.txt", ws.cwd, [ws.cwd], "read"), /outside/);
    assert.throws(() => confine("outdir/new-file.txt", ws.cwd, [ws.cwd], "write"), /outside/);
  } finally {
    ws.cleanup();
  }
});

test("a symlink that stays inside the workspace is fine", () => {
  const ws = workspace({ "real/a.txt": "x" });
  try {
    fs.symlinkSync(path.join(ws.cwd, "real"), path.join(ws.cwd, "alias"));
    assert.equal(confine("alias/a.txt", ws.cwd, [ws.cwd], "read"), path.join(ws.cwd, "real", "a.txt"));
  } finally {
    ws.cleanup();
  }
});

test("a file that does not exist yet is judged by where it would be", () => {
  const ws = workspace();
  try {
    assert.equal(confine("new/deep/file.txt", ws.cwd, [ws.cwd], "write"), path.join(ws.cwd, "new", "deep", "file.txt"));
    assert.throws(() => confine("../new.txt", ws.cwd, [ws.cwd], "write"), /outside/);
  } finally {
    ws.cleanup();
  }
});

test("a tilde is a directory called ~, never the operator's home", () => {
  const ws = workspace();
  try {
    assert.equal(confine("~/x", ws.cwd, [ws.cwd], "write"), path.join(ws.cwd, "~", "x"));
  } finally {
    ws.cleanup();
  }
});

test("a NUL byte is refused, and so is a seat with no roots at all", () => {
  const ws = workspace();
  try {
    assert.throws(() => confine("a\0b", ws.cwd, [ws.cwd], "read"), /NUL/);
    assert.throws(() => confine("a", ws.cwd, [], "read"), /outside the directories this seat may read\./);
  } finally {
    ws.cleanup();
  }
});

test("realPath resolves through the nearest existing parent and isInside is not fooled by a prefix", () => {
  const ws = workspace({ "a/b.txt": "x" });
  try {
    assert.equal(realPath(path.join(ws.cwd, "a", "missing", "c.txt")), path.join(ws.cwd, "a", "missing", "c.txt"));
    assert.equal(isInside("/x/wsfoo", "/x/ws"), false);
    assert.equal(isInside("/x/ws", "/x/ws"), true);
    assert.equal(isInside("/x/ws/a", "/x/ws"), true);
  } finally {
    ws.cleanup();
  }
});

test("a path through .git is recognised so a seat cannot plant a hook", () => {
  const ws = workspace();
  try {
    assert.equal(touchesGitDir(path.join(ws.cwd, ".git", "hooks", "pre-commit"), ws.cwd), true);
    assert.equal(touchesGitDir(path.join(ws.cwd, "sub", ".git", "config"), ws.cwd), true);
    assert.equal(touchesGitDir(path.join(ws.cwd, ".gitignore"), ws.cwd), false);
    assert.equal(touchesGitDir(path.join(ws.cwd, "src", "git.ts"), ws.cwd), false);
  } finally {
    ws.cleanup();
  }
});
