import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import type { AddressInfo } from "net";
import { formatBudgetRows, goalHeadline, main } from "../../apps/mesh-cli/src/index";

/**
 * Two things `curule` prints that a customer reads first, found by running its commands against the live fourteenth cronlite run.
 *
 * `curule budgets` padded the key to 36 characters. A key is longer than that as soon as it names a goal and a seat
 * (`agent:goal-M3ZKMQQP00b23ad76ed5/architect` is 41, a task's is 60), so the numbers of those rows sat to the right of the others'
 * and the table read as a staircase. `curule status` cut the goal at 60 characters with nothing to say it had: "Build `cronlite`:
 * a dependency-free Node.js (>=20, plain ESM [ACTIVE]" read as if the goal ended there.
 */

const KEYS = [
  { key: "mission:goal-M3ZKMQQP00b23ad76ed5", consumed: 0, limit: 3_000_000 },
  { key: "agent:goal-M3ZKMQQP00b23ad76ed5/pm", consumed: 41_889, limit: 250_000 },
  { key: "agent:goal-M3ZKMQQP00b23ad76ed5/architect", consumed: 0, limit: 350_000 },
  { key: "task:goal-M3ZKMQQP00b23ad76ed5/task-M3ZKP1AD00d10657e04f", consumed: 0, limit: 100_000, exceeded: false },
];

test("budgets: every row's numbers start in the same column, whatever the longest key is", () => {
  const rows = formatBudgetRows(KEYS);
  assert.equal(rows.length, 4);
  const longest = Math.max(...KEYS.map((k) => k.key.length));
  for (const row of rows) {
    assert.equal(row.length, 2 + longest + 1 + 8 + 1 + 8, `a row is as wide as the longest key plus its numbers: ${JSON.stringify(row)}`);
  }
  assert.equal(new Set(rows.map((r) => r.indexOf("/", 2 + longest))).size, 1, "the slash between consumed and limit is in one column");
  assert.match(rows[1]!, /^  agent:goal-M3ZKMQQP00b23ad76ed5\/pm\s+41889\/\s+250000$/);
});

test("budgets: short keys keep the width they always had, a missing limit is a question mark, an exceeded key is marked", () => {
  const rows = formatBudgetRows([
    { key: "mission:g", consumed: 5, limit: undefined },
    { key: "agent:g/pm", consumed: 300_001, limit: 300_000, exceeded: true },
  ]);
  assert.equal(rows[0], `  ${"mission:g".padEnd(36)} ${"5".padStart(8)}/${"?".padStart(8)}`);
  assert.equal(rows[1], `  ${"agent:g/pm".padEnd(36)} ${"300001".padStart(8)}/${"300000".padStart(8)}  EXCEEDED`);
  assert.deepEqual(formatBudgetRows([]), []);
});

test("status: a goal line that was cut says so, and one that was not is left alone", () => {
  const goal = "Build `cronlite`: a dependency-free Node.js (>=20, plain ESM, no build step) library and\nCLI for standard 5-field cron expressions";
  const cut = goalHeadline(goal);
  assert.equal(cut, "Build `cronlite`: a dependency-free Node.js (>=20, plain…", "cut at a word");
  assert.ok(cut.length <= 60, "no longer than the limit, the ellipsis included");
  assert.equal(goalHeadline("Ship the thing"), "Ship the thing");
  assert.equal(goalHeadline("x".repeat(60)), "x".repeat(60), "exactly the limit is not a cut");
  assert.equal(goalHeadline("x".repeat(61)), `${"x".repeat(59)}…`, "no word to cut at: cut where the limit falls");
  assert.equal(goalHeadline(`${"a".repeat(10)} ${"b".repeat(60)}`), `${"a".repeat(10)} ${"b".repeat(48)}…`, "a space too early in the line is not worth cutting back to");
  assert.equal(goalHeadline("First line  \nSecond"), "First line", "the first line only, without its trailing space");
  assert.equal(goalHeadline(undefined), "(none)");
});

/** A bus that answers with what a live mesh answered, and the lines `main` printed against it. */
async function printed(argv: string[], routes: Record<string, unknown>): Promise<string[]> {
  const server = http.createServer((req, res) => {
    const body = routes[String(req.url)];
    res.writeHead(body === undefined ? 404 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(body ?? {}));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    assert.equal(await main([...argv, "--bus", url]), 0);
  } finally {
    console.log = log;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return lines;
}

test("the commands print through them: `curule budgets` aligned, `curule status` with its goal cut at a word", async () => {
  const budgets = await printed(["budgets"], { "/budgets": { entries: KEYS } });
  assert.deepEqual(budgets, formatBudgetRows(KEYS));
  const status = await printed(["status"], {
    "/status": {
      goal: { description: "Build `cronlite`: a dependency-free Node.js (>=20, plain ESM, no build step) library and\nCLI for cron", status: "ACTIVE" },
      progress: { ratio: 0 },
      budgets: [],
      eventCount: 59,
      agents: [],
    },
  });
  assert.equal(status[0], "Goal:      Build `cronlite`: a dependency-free Node.js (>=20, plain… [ACTIVE]");
});
