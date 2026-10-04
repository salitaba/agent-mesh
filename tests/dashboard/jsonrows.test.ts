import test from "node:test";
import assert from "node:assert/strict";

import {
  AUTO_DEPTH, AUTO_ROWS, LONG_STRING, PAGE, defaultOpen, jsonString, morePage, navigate, scalarText, toggled, treeRows, type TreeRow,
} from "../../apps/mesh-dashboard/src/jsonrows";

/**
 * The payload viewer's rows and its keyboard. A tree with ten thousand leaves has to be one tab stop and a hundred rows, strings
 * have to be told apart from numbers, and nothing the value holds may be unreachable.
 */

const ids = (rows: readonly TreeRow[]): string[] => rows.map((r) => r.id);

const PLAN = {
  agentId: "architect",
  turn: 3,
  done: false,
  note: null,
  plan: { steps: [{ id: "s1", text: "read" }, { id: "s2", text: "write" }], gate: { mode: "off" } },
};

test("small containers near the top open on their own; deeper ones wait to be asked", () => {
  const open = defaultOpen(PLAN);
  assert.ok(open.has("plan"), "depth 0 and small");
  assert.ok(open.has("plan/steps"), "depth 1 and small");
  assert.ok(!open.has("plan/steps/0"), `depth ${AUTO_DEPTH} stays shut`);
  assert.ok(!open.has("plan/gate/mode"));
});

test("a container with more than the auto limit stays shut, however shallow, and one exactly at it opens", () => {
  const wide = { list: Array.from({ length: AUTO_ROWS + 1 }, (_, i) => i), small: [1, 2], full: Array.from({ length: AUTO_ROWS }, (_, i) => i) };
  const open = defaultOpen(wide);
  assert.ok(!open.has("list"));
  assert.ok(open.has("small"));
  assert.ok(open.has("full"), "the limit itself is still small enough to open");
});

test("rows come out in reading order with the level, position and size a tree item announces", () => {
  const rows = treeRows(PLAN, defaultOpen(PLAN));
  assert.deepEqual(ids(rows).slice(0, 5), ["agentId", "turn", "done", "note", "plan"]);
  const agent = rows[0]!;
  assert.deepEqual({ depth: agent.depth, posInSet: agent.posInSet, setSize: agent.setSize, parent: agent.parent }, { depth: 1, posInSet: 1, setSize: 5, parent: null });
  const step0 = rows.find((r) => r.id === "plan/steps/0")!;
  assert.deepEqual({ depth: step0.depth, parent: step0.parent, posInSet: step0.posInSet, setSize: step0.setSize }, { depth: 3, parent: "plan/steps", posInSet: 1, setSize: 2 });
  assert.equal(step0.expanded, false);
  assert.equal(step0.text, "id, text", "a shut container says what it holds");
});

test("a string reads with its quotes, so the string 12 and the number 12 are different rows", () => {
  const rows = treeRows({ a: "12", b: 12, c: true, d: null, e: undefined }, new Set());
  assert.deepEqual(rows.map((r) => [r.label, r.kind, r.text]), [
    ["a", "string", '"12"'], ["b", "number", "12"], ["c", "boolean", "true"], ["d", "null", "null"], ["e", "null", "undefined"],
  ]);
  assert.equal(scalarText(Number.NaN), "not a number");
});

test("empty containers say so and cannot be opened", () => {
  const rows = treeRows({ a: [], b: {} }, new Set(["a", "b"]));
  assert.deepEqual(rows.map((r) => [r.text, r.expandable, r.expanded]), [["empty list", false, false], ["empty", false, false]]);
});

test("a long or multi-line string collapses to one line with its length, and opens to its whole text", () => {
  const long = "x".repeat(LONG_STRING + 10);
  const shut = treeRows({ s: long, t: "a\nb" }, new Set());
  assert.equal(shut[0]!.expandable, true);
  assert.equal(shut[0]!.size, long.length);
  assert.equal(shut[0]!.full, undefined);
  assert.ok(shut[0]!.text.length <= LONG_STRING + 2, "the collapsed line is clipped");
  assert.equal(shut[1]!.expandable, true, "a line break alone is enough");
  const opened = treeRows({ s: long }, new Set(["s"]));
  assert.equal(opened[0]!.full, long);
  assert.equal(opened[0]!.expanded, true);
});

test("a huge array draws one page and a row that says how many are hidden, and asking draws the next page", () => {
  const big = { items: Array.from({ length: 250 }, (_, i) => i) };
  const open = new Set(["items"]);
  const first = treeRows(big, open);
  assert.equal(first.length, 1 + PAGE + 1, "the container, one page, the more row");
  const more = first[first.length - 1]!;
  assert.equal(more.kind, "more");
  assert.equal(more.hidden, 250 - PAGE);
  assert.equal(more.parent, "items");
  const limits = morePage(first, more.id, new Map())!;
  const second = treeRows(big, open, limits);
  assert.equal(second.length, 1 + 2 * PAGE + 1);
  const third = treeRows(big, open, morePage(second, second[second.length - 1]!.id, limits)!);
  assert.equal(third.length, 1 + 250, "all drawn, so no more row");
  assert.ok(!third.some((r) => r.kind === "more"));
  assert.equal(morePage(first, "items", new Map()), null, "only a more row pages");
});

test("a huge top-level array pages too, under the root", () => {
  const rows = treeRows(Array.from({ length: PAGE + 5 }, (_, i) => i), new Set());
  const more = rows[rows.length - 1]!;
  assert.equal(more.kind, "more");
  assert.equal(more.parent, null);
  assert.equal(morePage(rows, more.id, new Map())!.get(""), 2 * PAGE);
});

test("keys with slashes cannot collide with a path", () => {
  const rows = treeRows({ "a/b": 1, a: { b: 2 } }, new Set(["a"]));
  assert.equal(new Set(ids(rows)).size, rows.length);
  assert.ok(ids(rows).includes("a~1b"));
  assert.ok(ids(rows).includes("a/b"));
});

test("toggling opens a shut id and shuts an open one, without touching the set it was given", () => {
  const open = new Set(["a"]);
  assert.deepEqual([...toggled(open, "b")], ["a", "b"]);
  assert.deepEqual([...toggled(open, "a")], []);
  assert.deepEqual([...open], ["a"]);
});

/* ---------------------------------------------------------------- keyboard */

const rows = treeRows(PLAN, defaultOpen(PLAN));

test("Down and Up walk the visible rows and stop at the ends", () => {
  assert.deepEqual(navigate(rows, "agentId", "ArrowDown"), { focus: "turn" });
  assert.deepEqual(navigate(rows, "turn", "ArrowUp"), { focus: "agentId" });
  assert.deepEqual(navigate(rows, "agentId", "ArrowUp"), { focus: "agentId" });
  const last = rows[rows.length - 1]!.id;
  assert.deepEqual(navigate(rows, last, "ArrowDown"), { focus: last });
});

test("Home and End jump to the first and last visible row", () => {
  assert.deepEqual(navigate(rows, "plan", "Home"), { focus: "agentId" });
  assert.deepEqual(navigate(rows, "plan", "End"), { focus: rows[rows.length - 1]!.id });
});

test("Right opens a shut row, then steps into an open one", () => {
  assert.deepEqual(navigate(rows, "plan/steps/0", "ArrowRight"), { expand: "plan/steps/0" });
  assert.deepEqual(navigate(rows, "plan", "ArrowRight"), { focus: "plan/steps" }, "plan is open: its first child");
  assert.equal(navigate(rows, "agentId", "ArrowRight"), null, "a leaf has nowhere to go");
});

test("Right on an open long string has no child to step into and stays put, rather than jumping to the next row", () => {
  const long = "x".repeat(LONG_STRING + 1);
  const tree = treeRows({ note: long, after: 1 }, new Set(["note"]));
  assert.equal(tree[0]!.expanded, true);
  assert.equal(tree[0]!.full, long);
  assert.equal(navigate(tree, "note", "ArrowRight"), null);
  assert.deepEqual(navigate(tree, "note", "ArrowLeft"), { collapse: "note" }, "Left still closes it");
});

test("Left closes an open row, then steps out to the parent", () => {
  assert.deepEqual(navigate(rows, "plan", "ArrowLeft"), { collapse: "plan" });
  assert.deepEqual(navigate(rows, "plan/steps/0", "ArrowLeft"), { focus: "plan/steps" });
  assert.equal(navigate(rows, "agentId", "ArrowLeft"), null, "a top-level leaf has no parent");
});

test("Enter and Space activate a row that can open, and do nothing on a plain value", () => {
  assert.deepEqual(navigate(rows, "plan", "Enter"), { activate: "plan" });
  assert.deepEqual(navigate(rows, "plan/steps/0", " "), { activate: "plan/steps/0" });
  assert.equal(navigate(rows, "turn", "Enter"), null);
});

test("Enter on a show-more row asks for the next page", () => {
  const big = treeRows({ items: Array.from({ length: PAGE + 1 }, (_, i) => i) }, new Set(["items"]));
  const more = big[big.length - 1]!;
  assert.deepEqual(navigate(big, more.id, "Enter"), { activate: more.id });
});

test("keys the tree does not own, and an empty tree, are left to the page", () => {
  assert.equal(navigate(rows, "turn", "Tab"), null);
  assert.equal(navigate(rows, "turn", "a"), null);
  assert.equal(navigate([], null, "ArrowDown"), null);
  assert.deepEqual(navigate(rows, null, "ArrowDown"), { focus: "agentId" }, "focus not on a row yet: enter at the top");
});

test("the raw view writes the whole value, and a value that cannot be written says so rather than throwing", () => {
  assert.equal(jsonString({ a: 1 }), '{\n  "a": 1\n}');
  const cyc: Record<string, unknown> = {};
  cyc.self = cyc;
  assert.match(jsonString(cyc), /cannot be written/);
  assert.equal(jsonString(undefined), "undefined");
});
