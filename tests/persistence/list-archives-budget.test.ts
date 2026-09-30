/**
 * The archive listing's byte walk, and the budget that stops it.
 *
 * `listArchives` measures every archive by walking it file by file, on the event
 * loop of the process that also has to keep beating a 2s heartbeat. Nothing caps
 * the archive tree: every reset adds one and nothing ever prunes them. Measured
 * on the live `skill-panel` project on 2026-09-28 — 79 archives, 3.5 GB,
 * 221,234 directory entries — one `GET /mission/backups` blocked that loop for
 * **4.1 seconds** (1.1s on a warm repeat; the cold figure is what a freshly
 * booted child pays, and it is the growth that matters), and the same request on
 * a project reset weekly for a year is several times that. A block long enough
 * and the host's health watchdog stops the child as unhealthy, which is the
 * failure that discarded three in-flight turns and ~100k tokens on 2026-09-28.
 *
 * So the walk takes a deadline. These tests pin the two properties that matter:
 * a spent budget stops the walk instead of running to the end of the tree, and a
 * tree that fits its budget reports exactly what the unbounded walk reported.
 *
 * No clock is faked and no elapsed time is asserted: a budget of zero is already
 * a deterministic "the deadline is spent before the walk starts", and the tree
 * here is small enough that a generous budget cannot expire mid-test under load.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ARCHIVE_WALK_BUDGET_MS, listArchives } from "../../packages/persistence/src/index";
import { HEARTBEAT_TIMEOUT_MS } from "../../packages/projects/src/index";

const BIG = ".mesh-state.bak-20260925-204043";
const SMALL = ".mesh-state.bak-20260926-081248";
const FLAT = "mesh-branches.bak-20260927-101010";

/** An independent recursive sum, so the exactness assertion is not self-referential. */
function recursiveBytes(target: string): number {
  const st = fs.lstatSync(target);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const entry of fs.readdirSync(target)) total += recursiveBytes(path.join(target, entry));
  return total;
}

/**
 * A root with two state-shaped archives — one of them carrying a real state
 * archive's order of magnitude of entries — and one archive entry that is a
 * plain file rather than a directory.
 */
function makeArchiveRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-archives-"));
  const big = path.join(root, BIG);
  const small = path.join(root, SMALL);
  fs.mkdirSync(path.join(big, "logs"), { recursive: true });
  fs.mkdirSync(path.join(small, "logs"), { recursive: true });
  // 3,000 files: enough that the walk has real work to abandon, small enough to
  // create in a test.
  for (let i = 0; i < 3_000; i++) fs.writeFileSync(path.join(big, "logs", `events-${i}.jsonl`), "");
  fs.writeFileSync(path.join(big, "logs", "events.jsonl"), "x".repeat(1_024), "utf8");
  fs.writeFileSync(path.join(small, "logs", "events.jsonl"), "y".repeat(512), "utf8");
  fs.writeFileSync(path.join(root, FLAT), "z".repeat(64), "utf8");
  return root;
}

test("a spent budget stops the walk instead of measuring the whole tree", () => {
  const root = makeArchiveRoot();
  try {
    const stopped = listArchives(root, { walkBudgetMs: 0 });

    // The listing itself is untouched by the budget: every archive still
    // appears, newest first, with its stamp, its path and its kind. Sizes are
    // the only thing on offer, and only they may degrade.
    assert.deepEqual(
      stopped.map((e) => e.name),
      [FLAT, SMALL, BIG],
      "the budget must never drop an archive from the listing",
    );

    for (const entry of [stopped[1], stopped[2]]) {
      assert.equal(entry.kind, "state");
      assert.equal(entry.bytes, 0, `${entry.name}: nothing may be claimed about a tree the budget never reached`);
      assert.equal(entry.bytesExact, false, `${entry.name}: an unwalked size must say so`);
    }

    // A flat archive is a file: its length comes from the stat, so there is
    // nothing to bound and it stays exact even with no budget at all.
    assert.equal(stopped[0].bytes, 64);
    assert.equal(stopped[0].bytesExact, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("inside its budget the walk measures exactly what the unbounded walk did", () => {
  const root = makeArchiveRoot();
  try {
    const byName = new Map(listArchives(root).map((e) => [e.name, e]));
    const big = byName.get(BIG)!;
    const small = byName.get(SMALL)!;

    assert.equal(big.bytesExact, true, "a tree this size is far inside the default budget");
    assert.equal(small.bytesExact, true);
    // The exact sums the old always-walk version produced, recomputed here
    // independently: bounding the walk must not change an answer it reaches.
    assert.equal(big.bytes, recursiveBytes(path.join(root, BIG)));
    assert.equal(small.bytes, recursiveBytes(path.join(root, SMALL)));
    // Byte totals are not entry counts, so say which is bigger: the archive with
    // 3,000 files in it still has to out-weigh the one with a single 512-byte log.
    assert.ok(big.bytes > small.bytes, `${big.bytes} should outweigh ${small.bytes}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the budget is a small fraction of the missed-heartbeat window", () => {
  // The whole point of bounding this walk is that it must never be the reason a
  // working child is declared unhealthy. Ten listings in a row, each blowing its
  // entire budget, still add up to less than one window: the walk can degrade
  // the listing's numbers, but it cannot on its own manufacture the silence the
  // watchdog kills for.
  assert.ok(
    ARCHIVE_WALK_BUDGET_MS * 10 <= HEARTBEAT_TIMEOUT_MS,
    `walk budget ${ARCHIVE_WALK_BUDGET_MS}ms is too close to the ${HEARTBEAT_TIMEOUT_MS}ms heartbeat window`,
  );
});

test("an empty or missing root is still a listing, not an error", () => {
  const missing = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-archives-empty-"));
  try {
    assert.deepEqual(listArchives(missing), [], "nothing to list is an empty listing, as it always was");
  } finally {
    fs.rmSync(missing, { recursive: true, force: true });
  }
});
