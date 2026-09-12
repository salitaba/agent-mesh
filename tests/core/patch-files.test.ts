import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPatchFiles, safeProductPath } from "../../packages/core/src/patch-files";

/**
 * Non-git CodePatch materialization reads files back out of an artifact.
 * These fixtures mirror the two shapes real agents produced: a single file
 * under `## File: <path>` followed by trailing prose, and a multi-file
 * `### <path>` bundle ending in a "How to run" section. Both must never leak
 * prose into a written file.
 */

const UI_BUNDLE = [
  "# Skill Panel playground",
  "",
  "Intro prose that is not part of any file.",
  "",
  "## File: web/playground.html",
  "<!doctype html>",
  "<html>",
  "  <body><h1>Playground</h1></body>",
  "</html>",
  "",
  "## Manual verification / AC traceability",
  "- opened in the browser",
].join("\n");

const BACKEND_BUNDLE = [
  "# Handoff",
  "",
  "## Files",
  "### package.json",
  "{",
  '  "name": "playground"',
  "}",
  "### src/playground/core.mjs",
  "export function core() {",
  "  return 1;",
  "}",
  "### Dockerfile",
  "FROM node:20",
  "## How to run",
  "npm start",
].join("\n");

test("extractPatchFiles parses a single `## File:` section and stops at the next heading", () => {
  const files = extractPatchFiles(UI_BUNDLE);
  assert.equal(files.length, 1);
  assert.equal(files[0]!.path, "web/playground.html");
  assert.equal(files[0]!.content, ["<!doctype html>", "<html>", "  <body><h1>Playground</h1></body>", "</html>"].join("\n"));
  assert.ok(!files[0]!.content.includes("Manual verification"), "trailing prose is not file content");
});

test("extractPatchFiles parses a `### <path>` bundle and skips prose headings", () => {
  const files = extractPatchFiles(BACKEND_BUNDLE);
  assert.deepEqual(files.map((f) => f.path), ["package.json", "src/playground/core.mjs", "Dockerfile"]);
  assert.equal(files[0]!.content, '{\n  "name": "playground"\n}');
  assert.equal(files[1]!.content, "export function core() {\n  return 1;\n}");
  assert.equal(files[2]!.content, "FROM node:20");
});

test("extractPatchFiles strips a wrapping code fence", () => {
  const fenced = ["### src/a.ts", "```ts", "const a = 1;", "```"].join("\n");
  assert.deepEqual(extractPatchFiles(fenced), [{ path: "src/a.ts", content: "const a = 1;" }]);
});

test("extractPatchFiles with metadata.path returns exactly that bundle section", () => {
  const only = extractPatchFiles(BACKEND_BUNDLE, "src/playground/core.mjs");
  assert.deepEqual(only.map((f) => f.path), ["src/playground/core.mjs"]);
  assert.equal(only[0]!.content, "export function core() {\n  return 1;\n}");
});

test("metadata.path over content with no sections means the whole body is that file", () => {
  const plain = "export const x = 1;\nexport const y = 2;";
  assert.deepEqual(extractPatchFiles(plain, "src/plain.ts"), [{ path: "src/plain.ts", content: plain }]);
});

test("metadata.path matching no section of a bundle materializes nothing", () => {
  assert.deepEqual(extractPatchFiles(BACKEND_BUNDLE, "src/missing.ts"), []);
});

test("safeProductPath confines writes to the product root", () => {
  const root = "/tmp/mesh-product";
  assert.equal(safeProductPath(root, "src/app.ts"), "/tmp/mesh-product/src/app.ts");
  assert.equal(safeProductPath(root, "./src/app.ts"), "/tmp/mesh-product/src/app.ts");
  assert.equal(safeProductPath(root, "../escape.ts"), null);
  assert.equal(safeProductPath(root, "src/../../escape.ts"), null);
  assert.equal(safeProductPath(root, "/etc/passwd"), null);
  assert.equal(safeProductPath(root, ""), null);
});
