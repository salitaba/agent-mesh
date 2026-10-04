import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

import {
  LOG_CAP,
  RUN_SCRIPT_NAMES,
  TREE_WINDOW,
  changeKind,
  describeScript,
  failureLines,
  hasManifest,
  hasPlayground,
  isCapped,
  lastLines,
  noScriptsCopy,
  orderScripts,
  parseCommits,
  parseScripts,
  readPackage,
  runOutcome,
} from "../../apps/mesh-dashboard/src/product";

/**
 * What the Product page says about a script run. The logs below are the shapes real tools print; the property that matters is
 * that a run which failed leads with the lines that say so, and a run that passed is never made to look like it failed
 * because its summary contains the word "fail" with a zero beside it.
 */

const TSC = [
  "$ npm run typecheck",
  "",
  "> payment-endpoint@0.1.0 typecheck",
  "> tsc --noEmit",
  "",
  "src/tx/Pipeline.ts(42,17): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
  "src/tx/Pipeline.ts(51,3): error TS2322: Type 'undefined' is not assignable to type 'Receipt'.",
  "",
  "Found 2 errors in the same file, starting at: src/tx/Pipeline.ts:42",
  "npm error Lifecycle script `typecheck` failed with error:",
  "npm error code 2",
  "npm error path /work/main",
  "npm error A complete log of this run can be found in: /home/u/.npm/_logs/2026-10-04.log",
].join("\n");

const NODE_TEST_FAIL = [
  "$ npm run test",
  "✔ rejects a repeated key (1.2ms)",
  "✖ charges once for two identical requests (3.4ms)",
  "  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
  "  2 !== 1",
  "      at TestContext.<anonymous> (/work/test/idempotency.test.js:14:10)",
  "ℹ tests 2",
  "ℹ pass 1",
  "ℹ fail 1",
].join("\n");

const TAP_PASS = ["$ npm run test", "ok 1 - rejects a repeated key", "ok 2 - charges once", "# tests 2", "# pass 2", "# fail 0"].join("\n");

test("a tsc failure leads with the errors, by their line in the log, and with the count", () => {
  const f = failureLines(TSC);
  assert.deepEqual(f.lines.map((l) => l.n), [6, 7, 9]);
  assert.match(f.lines[0]!.text, /error TS2345/);
  assert.match(f.lines[2]!.text, /^Found 2 errors/);
  assert.equal(f.total, 3);
});

test("npm's own boilerplate after a failure is not listed as a failure", () => {
  const f = failureLines(TSC);
  assert.ok(f.lines.every((l) => !/complete log|npm error code|npm error path|Lifecycle script/.test(l.text)));
});

test("a failing test is listed with its assertion, and the stack frame under it is left in the full log", () => {
  const f = failureLines(NODE_TEST_FAIL);
  assert.deepEqual(f.lines.map((l) => l.n), [3, 4, 9]);
  assert.match(f.lines[0]!.text, /charges once/);
  assert.match(f.lines[1]!.text, /AssertionError/);
  assert.ok(f.lines.every((l) => !/^\s*at /.test(l.text)), "no stack frame");
});

test("a passing run that mentions zero failures lists none", () => {
  assert.deepEqual(failureLines(TAP_PASS), { lines: [], total: 0 });
  assert.deepEqual(failureLines("Tests: 0 failed, 12 passed, 12 total\nFound 0 errors."), { lines: [], total: 0 });
  // A line that starts like an error but says there were none is the runner being cheerful, not failing.
  assert.deepEqual(failureLines("error: 0 errors, 3 warnings"), { lines: [], total: 0 });
  assert.equal(failureLines("Tests: 1 failed, 11 passed, 12 total").total, 1, "but one failure is one");
});

test("other tools' shapes are recognised: jest, pytest, go, cargo, maven and a missing script", () => {
  const seen = (s: string): boolean => failureLines(s).total > 0;
  assert.ok(seen("FAIL src/tx/pipeline.test.ts"));
  assert.ok(seen("  ● pipeline › charges once"));
  assert.ok(seen("FAILED tests/test_tx.py::test_idempotent - assert 1 == 2"));
  assert.ok(seen("E       assert 1 == 2"));
  assert.ok(seen("--- FAIL: TestCharge (0.00s)"));
  assert.ok(seen("thread 'main' panicked at src/main.rs:4:5"));
  assert.ok(seen("error[E0308]: mismatched types"));
  assert.ok(seen("[ERROR] Failed to execute goal"));
  assert.ok(seen('npm error Missing script: "build"'));
  assert.ok(seen("npm ERR! enoent Could not read package.json"));
  assert.ok(!seen("Compiling 14 files…\nDone in 1.8s"), "an ordinary log is not a failure");
});

test("a log with thirty errors lists the first twelve, in order, and says how many there were", () => {
  const log = Array.from({ length: 30 }, (_, i) => `src/f${i}.ts(1,1): error TS1005: ';' expected.`).join("\n");
  const f = failureLines(log);
  assert.equal(f.lines.length, 12);
  assert.equal(f.total, 30);
  assert.deepEqual(f.lines.map((l) => l.n), Array.from({ length: 12 }, (_, i) => i + 1));
  assert.equal(failureLines(log, 3).lines.length, 3);
});

test("carriage returns from a progress bar do not shift the line numbers", () => {
  const f = failureLines("start\r\nerror TS1005: x\r\nend\r\n");
  assert.deepEqual(f.lines.map((l) => l.n), [2]);
  assert.equal(f.lines[0]!.text, "error TS1005: x");
});

test("a run that passed shows the last lines of its log, the summary the runner prints", () => {
  assert.deepEqual(lastLines(TAP_PASS).map((l) => l.text), ["# tests 2", "# pass 2", "# fail 0"]);
  assert.deepEqual(lastLines("a\n\n\nb\n\n").map((l) => [l.n, l.text]), [[1, "a"], [4, "b"]], "blank lines are skipped, numbers are the log's");
  assert.deepEqual(lastLines(""), []);
});

test("how a run ended: running, passed, failed, stopped by a signal, or forgotten by the host", () => {
  assert.equal(runOutcome({ done: false, exitCode: null }), "running");
  assert.equal(runOutcome({ done: true, exitCode: 0 }), "passed");
  assert.equal(runOutcome({ done: true, exitCode: 1 }), "failed");
  assert.equal(runOutcome({ done: true, exitCode: -1 }), "failed", "a spawn error is a failure");
  // A run the host killed has no exit code. It used to read "exit ?".
  assert.equal(runOutcome({ done: true, exitCode: null }), "stopped");
  // The host restarted and forgot the run: nothing is known about the script, so it is neither passed nor failed.
  assert.equal(runOutcome({ done: false, exitCode: null }, true), "lost");
  assert.equal(runOutcome({ done: true, exitCode: 0 }, true), "lost");
});

test("a log the server cut is said to be cut, and one that fits is not", () => {
  assert.equal(isCapped("x".repeat(LOG_CAP)), true);
  assert.equal(isCapped("x".repeat(LOG_CAP - 50)), true, "the cap trims to a hair under 60,000");
  assert.equal(isCapped("x".repeat(20_000)), false);
});

test("scripts are read from a package.json, strings only, and a file that does not parse gives none", () => {
  assert.deepEqual(parseScripts('{"name":"p","scripts":{"build":"tsc -b","test":"node --test","weird":42}}'), { build: "tsc -b", test: "node --test" });
  assert.equal(parseScripts("{ not json"), null);
  assert.equal(parseScripts('{"name":"p"}'), null);
  assert.equal(parseScripts('{"scripts":null}'), null);
  assert.equal(parseScripts("[]"), null);
});

test("a package.json is either not JSON, or JSON that may or may not have scripts; the page says which", () => {
  assert.deepEqual(readPackage('{"scripts":{"build":"tsc -b"}}'), { state: "ok", scripts: { build: "tsc -b" } });
  assert.deepEqual(readPackage('{"name":"p"}'), { state: "ok", scripts: null }, "valid, but nothing to run");
  assert.deepEqual(readPackage("{ not json"), { state: "invalid", scripts: null });
  assert.deepEqual(readPackage(""), { state: "invalid", scripts: null });
});

test("a script button says exactly what it runs, and never more than the server does", () => {
  const b = describeScript("build", { build: "tsc -b" });
  assert.equal(b.command, "npm run build");
  assert.equal(b.body, "tsc -b");
  assert.equal(b.label, "Build");
  assert.equal(describeScript("build", null).body, null, "a package.json the page could not read claims nothing");
  assert.equal(describeScript("lint", { build: "x" }).body, null);
  assert.equal(describeScript("serve", null).usuallyStays, true);
  assert.equal(describeScript("test", null).usuallyStays, false);
  const h = describeScript("headless-hairpin", { "headless-hairpin": "ignored" });
  assert.match(h.command, /^node tools\/headless\/dist\/main\.js --scenario demos\/hairpin\.scenario\.json/);
  assert.equal(h.body, null);
  assert.equal(h.label, "Hairpin scenario");
});

test("scripts are offered in the order a person runs them", () => {
  assert.deepEqual(orderScripts(["serve", "lint", "test", "build", "typecheck"]), ["build", "test", "typecheck", "lint", "serve"]);
  assert.deepEqual(orderScripts(["headless-hairpin", "zzz", "build"]), ["build", "headless-hairpin", "zzz"]);
  assert.deepEqual(orderScripts([]), []);
});

test("the names the page lists are the ones the server runs", () => {
  // Read from the server's own source, so a name added there is one the empty state has to mention or this fails.
  const root = path.resolve(__dirname, "..", "..", "..");
  const server = fs.readFileSync(path.join(root, "apps", "mesh-server", "src", "index.ts"), "utf8");
  const literal = /const RUN_SCRIPT_NAMES = new Set\(\[([^\]]+)\]\)/.exec(server);
  assert.ok(literal, "the server declares RUN_SCRIPT_NAMES");
  const theirs = [...literal![1]!.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]!).sort();
  assert.deepEqual([...RUN_SCRIPT_NAMES].sort(), theirs);
});

test("a change is read as a word as well as a mark, from git's two-character codes", () => {
  assert.deepEqual(changeKind("M"), { mark: "M", word: "modified", tone: "warn" });
  assert.equal(changeKind("MM").word, "modified");
  assert.equal(changeKind(" M").word, "modified", "git pads the code; the page does not care");
  assert.equal(changeKind("A").word, "added");
  assert.equal(changeKind("AM").word, "added");
  assert.equal(changeKind("D").word, "deleted");
  assert.equal(changeKind("D").tone, "bad");
  assert.equal(changeKind("??").word, "new, not tracked");
  assert.equal(changeKind("R").word, "renamed");
  assert.equal(changeKind("UU").word, "in conflict");
  assert.equal(changeKind("AA").word, "in conflict");
  assert.equal(changeKind("?").word, "changed", "an unknown code is still said");
});

test("recent commits split into a hash and a subject, and a line that is not in that shape is kept whole", () => {
  assert.deepEqual(parseCommits("1700b97 merge to main\ne9971c8 feat(tx): pipeline revision 2\n"), [
    { hash: "1700b97", subject: "merge to main" },
    { hash: "e9971c8", subject: "feat(tx): pipeline revision 2" },
  ]);
  assert.deepEqual(parseCommits("not a commit line"), [{ hash: "", subject: "not a commit line" }]);
  assert.deepEqual(parseCommits(""), []);
  assert.deepEqual(parseCommits(undefined), []);
});

test("with nothing to run, the card says why: no package.json, an unreadable one, or one with no script the console runs", () => {
  assert.match(noScriptsCopy("missing").body, /no package\.json/);
  assert.match(noScriptsCopy("invalid").body, /not valid JSON/);
  const ok = noScriptsCopy("ok").body;
  for (const name of RUN_SCRIPT_NAMES) assert.match(ok, new RegExp(`\\b${name}\\b`), `${name} is named`);
  assert.equal(noScriptsCopy("unknown").body, ok, "a read that failed says what the others say, not a guess");
});

test("the scripts are read only when the root lists a package.json, so a product without one is not a 404 in the console", () => {
  assert.equal(hasManifest([{ name: "package.json", type: "file" }, { name: "src", type: "dir" }]), true);
  assert.equal(hasManifest([{ name: "src", type: "dir" }]), false);
  assert.equal(hasManifest([{ name: "package.json", type: "dir" }]), false, "a folder called package.json is not a manifest");
  assert.equal(hasManifest([]), false, "an empty product has none");
  assert.equal(hasManifest(null), false, "a listing that did not come back says nothing, and the caller reads the file instead");
});

test("the playground is offered only when the checkout holds the page the server opens", () => {
  assert.equal(hasPlayground([{ name: "index.html", type: "file" }, { name: "app.js", type: "file" }]), true);
  assert.equal(hasPlayground([{ name: "app.js", type: "file" }]), false);
  assert.equal(hasPlayground([{ name: "index.html", type: "dir" }]), false, "a folder called index.html is not a page");
  assert.equal(hasPlayground([]), false, "an empty or missing folder lists as nothing");
  assert.equal(hasPlayground(null), false);
  assert.ok(TREE_WINDOW >= 100, "a folder window is a screenful or more");
});
