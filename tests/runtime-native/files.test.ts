import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { editTool, readTool, writeTool, MAX_READ_LINES, MAX_READ_CHARS, ToolFailure } from "../../packages/runtime-native/src/index";
import { run, workspace } from "./support";

const fails = async (p: Promise<unknown>, pattern: RegExp) => assert.rejects(p, (e: unknown) => e instanceof ToolFailure && pattern.test(e.message), String(pattern));

/** Read, Write and Edit: what a seat sees and what it is refused, in the words models already recognise. */

test("Read numbers each line, and a trailing newline does not make a line", async () => {
  const ws = workspace({ "a.txt": "one\ntwo\nthree\n" });
  try {
    const r = await run(readTool, { file_path: "a.txt" }, ws);
    assert.equal(r.text, "     1\tone\n     2\ttwo\n     3\tthree");
  } finally {
    ws.cleanup();
  }
});

test("Read takes a range, and says where the rest begins", async () => {
  const ws = workspace({ "a.txt": Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n") });
  try {
    const r = await run(readTool, { file_path: "a.txt", offset: 3, limit: 2 }, ws);
    assert.equal(r.text, `     3\tline 3\n     4\tline 4\n[a.txt: lines 3-4 of 10. 6 more line(s): call Read again with offset 5.]`);
  } finally {
    ws.cleanup();
  }
});

test("Read stops at 2000 lines and at 60,000 characters, each time naming the offset to continue from", async () => {
  const ws = workspace({ "long.txt": Array.from({ length: MAX_READ_LINES + 50 }, (_, i) => `l${i + 1}`).join("\n"), "wide.txt": Array.from({ length: 100 }, () => "x".repeat(1000)).join("\n") });
  try {
    const long = await run(readTool, { file_path: "long.txt" }, ws);
    assert.match(long.text, /lines 1-2000 of 2050\. 50 more line\(s\): call Read again with offset 2001/);
    const wide = await run(readTool, { file_path: "wide.txt" }, ws);
    assert.ok(wide.text.length < MAX_READ_CHARS + 500, `${wide.text.length}`);
    assert.match(wide.text, /more line\(s\): call Read again with offset \d+/);
  } finally {
    ws.cleanup();
  }
});

test("a very long line is cut and says how much", async () => {
  const ws = workspace({ "a.txt": `${"y".repeat(2500)}\nshort` });
  try {
    const r = await run(readTool, { file_path: "a.txt" }, ws);
    assert.match(r.text, /^ {5}1\ty{2000}… \(\+500 chars\)\n {5}2\tshort$/);
  } finally {
    ws.cleanup();
  }
});

test("Read refuses a directory, a binary file, a missing file, a past-the-end offset and a file too big to read whole", async () => {
  const ws = workspace({ "dir/x.txt": "x", "empty.txt": "" });
  try {
    ws.put("bin.dat", Buffer.from([1, 2, 0, 3]));
    ws.put("big.txt", Buffer.alloc(2 * 1024 * 1024 + 10, "a"));
    await fails(run(readTool, { file_path: "dir" }, ws), /is a directory/);
    await fails(run(readTool, { file_path: "bin.dat" }, ws), /binary file/);
    await fails(run(readTool, { file_path: "nope.txt" }, ws), /File does not exist: nope\.txt/);
    assert.match((await run(readTool, { file_path: "empty.txt" }, ws)).text, /is empty/);
    await fails(run(readTool, { file_path: "dir/x.txt", offset: 5 }, ws), /past the end/);
    await fails(run(readTool, { file_path: "big.txt" }, ws), /too large to read whole/);
    const part = await run(readTool, { file_path: "big.txt", offset: 1, limit: 1 }, ws);
    assert.match(part.text, /^ {5}1\ta{100}/);
  } finally {
    ws.cleanup();
  }
});

test("Read opens the product checkout and nothing else outside the workspace", async () => {
  const ws = workspace();
  try {
    fs.writeFileSync(path.join(ws.product, "README.md"), "product\n");
    assert.equal((await run(readTool, { file_path: path.join(ws.product, "README.md") }, ws)).text, "     1\tproduct");
    await fails(run(readTool, { file_path: "/etc/passwd" }, ws), /outside the directories this seat may read/);
    await fails(run(readTool, { file_path: "/proc/self/environ" }, ws), /outside the directories/);
  } finally {
    ws.cleanup();
  }
});

test("Write creates a file and its directories, replaces one whole, and says which it did", async () => {
  const ws = workspace();
  try {
    const created = await run(writeTool, { file_path: "src/deep/a.ts", content: "export const a = 1;\n" }, ws);
    assert.match(created.text, /^Created src\/deep\/a\.ts \(20 bytes, 2 lines\)\.$/);
    assert.equal(fs.readFileSync(path.join(ws.cwd, "src/deep/a.ts"), "utf8"), "export const a = 1;\n");
    const replaced = await run(writeTool, { file_path: "src/deep/a.ts", content: "" }, ws);
    assert.match(replaced.text, /^Replaced src\/deep\/a\.ts \(0 bytes, 0 lines\)\.$/);
  } finally {
    ws.cleanup();
  }
});

test("Write refuses a directory, the product checkout, a path outside the workspace, .git, and an oversized body", async () => {
  const ws = workspace({ "dir/x": "x" });
  try {
    await fails(run(writeTool, { file_path: "dir", content: "x" }, ws), /is a directory/);
    await fails(run(writeTool, { file_path: path.join(ws.product, "x.txt"), content: "x" }, ws), /outside the directories this seat may write/);
    await fails(run(writeTool, { file_path: "../x.txt", content: "x" }, ws), /outside/);
    await fails(run(writeTool, { file_path: ".git/hooks/pre-commit", content: "#!/bin/sh\n" }, ws), /inside \.git/);
    await fails(run(writeTool, { file_path: "big.txt", content: "a".repeat(5 * 1024 * 1024 + 1) }, ws), /larger than/);
    await fails(run(writeTool, { file_path: "a.txt" }, ws), /content is required/);
    assert.equal(fs.existsSync(path.join(ws.product, "x.txt")), false);
  } finally {
    ws.cleanup();
  }
});

test("Edit replaces the one occurrence, and treats $ in the new text as text", async () => {
  const ws = workspace({ "a.ts": "const price = 10;\nconst tax = 2;\n" });
  try {
    const r = await run(editTool, { file_path: "a.ts", old_string: "const price = 10;", new_string: "const price = '$&' + 1;" }, ws);
    assert.equal(r.text, "Edited a.ts: replaced 1 occurrence.");
    assert.equal(fs.readFileSync(path.join(ws.cwd, "a.ts"), "utf8"), "const price = '$&' + 1;\nconst tax = 2;\n");
  } finally {
    ws.cleanup();
  }
});

test("Edit refuses a string that is absent, repeated, or unchanged, and replace_all handles the repeated one", async () => {
  const ws = workspace({ "a.ts": "x\nfoo\nfoo\n" });
  try {
    await fails(run(editTool, { file_path: "a.ts", old_string: "bar", new_string: "baz" }, ws), /String to replace not found in file/);
    await fails(run(editTool, { file_path: "a.ts", old_string: "foo", new_string: "bar" }, ws), /Found 2 matches of the string to replace, but replace_all is false/);
    await fails(run(editTool, { file_path: "a.ts", old_string: "foo", new_string: "foo" }, ws), /No changes to make/);
    const all = await run(editTool, { file_path: "a.ts", old_string: "foo", new_string: "bar", replace_all: true }, ws);
    assert.equal(all.text, "Edited a.ts: replaced 2 occurrences.");
    assert.equal(fs.readFileSync(path.join(ws.cwd, "a.ts"), "utf8"), "x\nbar\nbar\n");
  } finally {
    ws.cleanup();
  }
});

test("Edit refuses a missing file, a binary file, .git, and the product checkout", async () => {
  const ws = workspace();
  try {
    ws.put("bin.dat", Buffer.from([65, 0, 66]));
    fs.writeFileSync(path.join(ws.product, "p.ts"), "x");
    await fails(run(editTool, { file_path: "nope.ts", old_string: "a", new_string: "b" }, ws), /File does not exist/);
    await fails(run(editTool, { file_path: "bin.dat", old_string: "A", new_string: "B" }, ws), /binary file/);
    await fails(run(editTool, { file_path: path.join(ws.product, "p.ts"), old_string: "x", new_string: "y" }, ws), /outside the directories this seat may write/);
    ws.put(".git/config", "[core]\n");
    await fails(run(editTool, { file_path: ".git/config", old_string: "core", new_string: "x" }, ws), /inside \.git/);
    assert.equal(fs.readFileSync(path.join(ws.product, "p.ts"), "utf8"), "x");
  } finally {
    ws.cleanup();
  }
});

test("a symlink out of the workspace cannot be written or edited through", async () => {
  const ws = workspace();
  try {
    const outside = path.join(ws.base, "outside.txt");
    fs.writeFileSync(outside, "keep");
    fs.symlinkSync(outside, path.join(ws.cwd, "link.txt"));
    await fails(run(writeTool, { file_path: "link.txt", content: "overwritten" }, ws), /outside/);
    await fails(run(editTool, { file_path: "link.txt", old_string: "keep", new_string: "gone" }, ws), /outside/);
    assert.equal(fs.readFileSync(outside, "utf8"), "keep");
  } finally {
    ws.cleanup();
  }
});

test("argument types are checked in plain words", async () => {
  const ws = workspace({ "a.txt": "x" });
  try {
    await fails(run(readTool, {}, ws), /file_path is required/);
    await fails(run(readTool, { file_path: 5 }, ws), /file_path must be a string/);
    await fails(run(readTool, { file_path: "a.txt", offset: "x" }, ws), /offset must be a whole number/);
    await fails(run(readTool, { file_path: "a.txt", offset: 0 }, ws), /offset must be at least 1/);
    assert.equal((await run(readTool, { file_path: "a.txt", offset: "1" }, ws)).text, "     1\tx", "a number sent as a string is accepted");
  } finally {
    ws.cleanup();
  }
});
