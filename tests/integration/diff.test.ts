import { test } from "node:test";
import assert from "node:assert/strict";
import { diffText } from "../../apps/mesh-server/src/diff";

test("identical text reports no changes", () => {
  const d = diffText("a\nb\nc\n", "a\nb\nc\n");
  assert.equal(d.identical, true);
  assert.equal(d.added, 0);
  assert.equal(d.removed, 0);
  assert.equal(d.hunks.length, 0);
});

test("added lines are counted and numbered on the right side", () => {
  const d = diffText("a\nb\n", "a\nx\nb\n");
  assert.equal(d.added, 1);
  assert.equal(d.removed, 0);
  assert.equal(d.identical, false);
  const add = d.hunks.flatMap((h) => h.lines).find((l) => l.op === "add");
  assert.ok(add);
  assert.equal(add.text, "x");
  assert.equal(add.a, null);
  assert.equal(add.b, 2);
});

test("removed lines are counted and numbered on the left side", () => {
  const d = diffText("a\nb\nc\n", "a\nc\n");
  assert.equal(d.removed, 1);
  assert.equal(d.added, 0);
  const del = d.hunks.flatMap((h) => h.lines).find((l) => l.op === "del");
  assert.ok(del);
  assert.equal(del.text, "b");
  assert.equal(del.a, 2);
  assert.equal(del.b, null);
});

test("first version diffs against empty content", () => {
  const d = diffText("", "hello\nworld\n");
  assert.equal(d.added, 2);
  assert.equal(d.removed, 0);
});

test("unchanged regions outside the context window are collapsed", () => {
  const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
  const after = before.replace("line 20", "line 20 changed");
  const d = diffText(before, after, 2);
  const kept = d.hunks.flatMap((h) => h.lines).length;
  assert.ok(kept < 40, `expected collapsed output, got ${kept} lines`);
  assert.equal(d.added, 1);
  assert.equal(d.removed, 1);
});

test("CRLF input diffs the same as LF input", () => {
  const d = diffText("a\r\nb\r\n", "a\nb\n");
  assert.equal(d.identical, true);
});
