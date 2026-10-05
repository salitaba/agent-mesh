import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { globTool, grepTool, globToRegExp, MAX_GLOB_RESULTS, ToolFailure } from "../../packages/runtime-native/src/index";
import { run, workspace } from "./support";

const fails = async (p: Promise<unknown>, pattern: RegExp) => assert.rejects(p, (e: unknown) => e instanceof ToolFailure && pattern.test(e.message), String(pattern));

test("a glob means what a shell user expects: * stays in a name, ** crosses directories, ? is one character, {a,b} alternates", () => {
  const yes = (glob: string, ...paths: string[]) => paths.forEach((p) => assert.ok(globToRegExp(glob).test(p), `${glob} should match ${p}`));
  const no = (glob: string, ...paths: string[]) => paths.forEach((p) => assert.ok(!globToRegExp(glob).test(p), `${glob} should not match ${p}`));
  yes("*.ts", "a.ts", ".hidden.ts");
  no("*.ts", "src/a.ts", "a.tsx");
  yes("**/*.ts", "a.ts", "src/a.ts", "src/deep/er/a.ts");
  yes("src/**", "src/a", "src/a/b/c.txt");
  no("src/**", "other/a");
  yes("a/**/b", "a/b", "a/x/b", "a/x/y/b");
  no("a/**/b", "a/xb", "ab");
  yes("file?.txt", "file1.txt");
  no("file?.txt", "file12.txt", "file/.txt");
  yes("*.{json,yaml}", "a.json", "b.yaml");
  no("*.{json,yaml}", "a.yml");
  yes("{src,lib}/**/*.{ts,tsx}", "src/a.ts", "lib/x/y.tsx");
  yes("[ab].txt", "a.txt", "b.txt");
  no("[ab].txt", "c.txt");
  yes("[!ab].txt", "c.txt");
  no("[!ab].txt", "a.txt");
  yes("a.b", "a.b");
  no("a.b", "axb");
  yes("a+b(c).txt", "a+b(c).txt");
  yes("\\*.txt", "*.txt");
});

test("Glob lists matching files, newest first, relative to the workspace", async () => {
  const ws = workspace({ "src/a.ts": "a", "src/b.ts": "b", "README.md": "r", "src/deep/c.ts": "c" });
  try {
    const t = Date.now() / 1000;
    fs.utimesSync(path.join(ws.cwd, "src/a.ts"), t - 300, t - 300);
    fs.utimesSync(path.join(ws.cwd, "src/b.ts"), t - 100, t - 100);
    fs.utimesSync(path.join(ws.cwd, "src/deep/c.ts"), t - 200, t - 200);
    const r = await run(globTool, { pattern: "**/*.ts" }, ws);
    assert.equal(r.text, ["src/b.ts", "src/deep/c.ts", "src/a.ts"].join("\n"));
    assert.equal((await run(globTool, { pattern: "*.md" }, ws)).text, "README.md");
    assert.equal((await run(globTool, { pattern: "*.ts", path: "src" }, ws)).text.split("\n").sort().join(), "src/a.ts,src/b.ts");
  } finally {
    ws.cleanup();
  }
});

test("Glob skips .git and node_modules unless the pattern asks for them", async () => {
  const ws = workspace({ "a.js": "x", "node_modules/pkg/index.js": "x", ".git/hooks/h.js": "x" });
  try {
    assert.equal((await run(globTool, { pattern: "**/*.js" }, ws)).text, "a.js");
    assert.match((await run(globTool, { pattern: "node_modules/**/*.js" }, ws)).text, /node_modules\/pkg\/index\.js/);
  } finally {
    ws.cleanup();
  }
});

test("Glob says so when nothing matches, caps its list, and stays inside the workspace", async () => {
  const ws = workspace();
  try {
    assert.match((await run(globTool, { pattern: "**/*.zig" }, ws)).text, /^No files match \*\*\/\*\.zig\./);
    for (let i = 0; i < MAX_GLOB_RESULTS + 20; i++) ws.put(`many/f${String(i).padStart(4, "0")}.txt`, "x");
    const r = await run(globTool, { pattern: "many/*.txt" }, ws);
    assert.equal(r.text.split("\n").length, MAX_GLOB_RESULTS + 1);
    assert.match(r.text, /\[20 more not shown: narrow the pattern\.\]$/);
    await fails(run(globTool, { pattern: "*", path: "/etc" }, ws), /outside the directories/);
    await fails(run(globTool, { pattern: "*", path: "many/f0000.txt" }, ws), /must be a directory/);
    await fails(run(globTool, { pattern: "*", path: "nope" }, ws), /Path does not exist/);
  } finally {
    ws.cleanup();
  }
});

test("a symlinked directory is not entered, so a loop cannot trap the walk", async () => {
  const ws = workspace({ "a/x.txt": "x" });
  try {
    fs.symlinkSync(ws.cwd, path.join(ws.cwd, "a", "loop"));
    const r = await run(globTool, { pattern: "**/*.txt" }, ws);
    assert.equal(r.text, "a/x.txt");
  } finally {
    ws.cleanup();
  }
});

const REPO = {
  "src/a.ts": "const alpha = 1;\nconst beta = 2;\nconst ALPHA = 3;\n",
  "src/b.py": "alpha = 1\n",
  "docs/notes.md": "alpha beta gamma\n",
  "node_modules/dep/index.js": "alpha\n",
};

test("Grep lists the files that match by default, skipping node_modules", async () => {
  const ws = workspace(REPO);
  try {
    assert.equal((await run(grepTool, { pattern: "alpha" }, ws)).text, ["docs/notes.md", "src/a.ts", "src/b.py"].join("\n"));
  } finally {
    ws.cleanup();
  }
});

test("Grep content mode shows path, line number and the line; -n false drops the number; -i ignores case", async () => {
  const ws = workspace(REPO);
  try {
    assert.equal((await run(grepTool, { pattern: "alpha", output_mode: "content", path: "src/a.ts" }, ws)).text, "src/a.ts:1:const alpha = 1;");
    assert.equal((await run(grepTool, { pattern: "alpha", output_mode: "content", path: "src/a.ts", "-n": false }, ws)).text, "src/a.ts:const alpha = 1;");
    assert.equal(
      (await run(grepTool, { pattern: "alpha", output_mode: "content", path: "src/a.ts", "-i": true }, ws)).text,
      "src/a.ts:1:const alpha = 1;\nsrc/a.ts:3:const ALPHA = 3;",
    );
  } finally {
    ws.cleanup();
  }
});

test("Grep count mode, and narrowing by glob (a bare name matches at any depth) and by type", async () => {
  const ws = workspace(REPO);
  try {
    assert.equal((await run(grepTool, { pattern: "alpha", output_mode: "count", "-i": true }, ws)).text, ["docs/notes.md:1", "src/a.ts:2", "src/b.py:1"].join("\n"));
    assert.equal((await run(grepTool, { pattern: "alpha", glob: "*.py" }, ws)).text, "src/b.py");
    assert.equal((await run(grepTool, { pattern: "alpha", glob: "src/*.ts" }, ws)).text, "src/a.ts");
    assert.equal((await run(grepTool, { pattern: "alpha", type: "md" }, ws)).text, "docs/notes.md");
    await fails(run(grepTool, { pattern: "alpha", type: "cobol" }, ws), /type must be one of/);
  } finally {
    ws.cleanup();
  }
});

test("Grep context lines are marked with a dash, and separated groups with --", async () => {
  const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}${i === 1 || i === 9 ? " MATCH" : ""}`).join("\n");
  const ws = workspace({ "f.txt": lines });
  try {
    const r = await run(grepTool, { pattern: "MATCH", output_mode: "content", path: "f.txt", "-C": 1 }, ws);
    assert.equal(r.text, ["f.txt-1-line 1", "f.txt:2:line 2 MATCH", "f.txt-3-line 3", "--", "f.txt-9-line 9", "f.txt:10:line 10 MATCH", "f.txt-11-line 11"].join("\n"));
    const after = await run(grepTool, { pattern: "line 2 MATCH", output_mode: "content", path: "f.txt", "-A": 1 }, ws);
    assert.equal(after.text, "f.txt:2:line 2 MATCH\nf.txt-3-line 3");
  } finally {
    ws.cleanup();
  }
});

test("Grep skips binary and oversized files, and says how many", async () => {
  const ws = workspace({ "t.txt": "needle\n" });
  try {
    ws.put("bin.dat", Buffer.from("needle\0binary"));
    ws.put("big.txt", Buffer.alloc(2 * 1024 * 1024 + 1, "needle "));
    const r = await run(grepTool, { pattern: "needle" }, ws);
    assert.equal(r.text, "t.txt\n[2 file(s) skipped: binary or over 2 MB]");
  } finally {
    ws.cleanup();
  }
});

test("Grep head_limit cuts the output and says so; a pattern with no match says that", async () => {
  const ws = workspace({ "f.txt": Array.from({ length: 30 }, (_, i) => `hit ${i}`).join("\n") });
  try {
    const r = await run(grepTool, { pattern: "hit", output_mode: "content", path: "f.txt", head_limit: 5 }, ws);
    assert.equal(r.text.split("\n").length, 6);
    assert.match(r.text, /\[output cut at 5; narrow the search or raise head_limit\]$/);
    assert.match((await run(grepTool, { pattern: "absent" }, ws)).text, /^No matches for absent\./);
  } finally {
    ws.cleanup();
  }
});

test("Grep multiline lets a pattern span lines", async () => {
  const ws = workspace({ "f.txt": "function a() {\n  return 1;\n}\nfunction b() {}\n" });
  try {
    const r = await run(grepTool, { pattern: "function a\\(\\) \\{.*?return", multiline: true, output_mode: "content", path: "f.txt" }, ws);
    assert.equal(r.text, "f.txt:1:function a() {\nf.txt:2:  return 1;");
    assert.match((await run(grepTool, { pattern: "function a\\(\\) \\{.*?return", path: "f.txt", output_mode: "content" }, ws)).text, /^No matches/);
  } finally {
    ws.cleanup();
  }
});

test("Grep says what is wrong with a pattern, and stays inside the workspace", async () => {
  const ws = workspace(REPO);
  try {
    await fails(run(grepTool, { pattern: "(unclosed" }, ws), /invalid regular expression/);
    await fails(run(grepTool, { pattern: "x", path: "/etc" }, ws), /outside the directories/);
    await fails(run(grepTool, { pattern: "x", output_mode: "lines" }, ws), /output_mode must be/);
    fs.writeFileSync(path.join(ws.product, "p.txt"), "alpha\n");
    const r = await run(grepTool, { pattern: "alpha", path: ws.product }, ws);
    assert.equal(r.text, path.join(ws.product, "p.txt"), "a path outside the workspace is shown absolute");
  } finally {
    ws.cleanup();
  }
});
