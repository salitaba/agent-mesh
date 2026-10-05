import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_LIMITS, RateLimiter } from "../../packages/cloud/src/index";

const clockAt = (start = 1_000_000) => {
  const c = { now: start, read: () => c.now };
  return c;
};

test("a key may be hit as often as the limit says in a span, and the hit after that is refused with how long to wait", () => {
  const c = clockAt();
  const l = new RateLimiter(c.read);
  assert.deepEqual(l.hit("k", 3, 60_000), { ok: true });
  assert.deepEqual(l.hit("k", 3, 60_000), { ok: true });
  c.now += 10_000;
  assert.deepEqual(l.hit("k", 3, 60_000), { ok: true });
  c.now += 20_000;
  assert.deepEqual(l.hit("k", 3, 60_000), { ok: false, retryAfterSec: 30 }, "the first hit leaves the window in thirty seconds");
  c.now += 29_999;
  assert.deepEqual(l.hit("k", 3, 60_000), { ok: false, retryAfterSec: 1 }, "a wait is never less than a second");
  c.now += 1;
  assert.deepEqual(l.hit("k", 3, 60_000), { ok: true }, "the first two hits have left the window");
});

test("a window slides: a burst at the end of one span and the start of the next is still a burst", () => {
  const c = clockAt();
  const l = new RateLimiter(c.read);
  c.now += 50_000;
  assert.equal(l.hit("k", 2, 60_000).ok, true);
  assert.equal(l.hit("k", 2, 60_000).ok, true);
  c.now += 20_000;
  assert.deepEqual(l.hit("k", 2, 60_000), { ok: false, retryAfterSec: 40 }, "twenty seconds on, both are still inside a window of sixty");
});

test("a refused hit is not counted, so waiting out the limit is enough", () => {
  const c = clockAt();
  const l = new RateLimiter(c.read);
  l.hit("k", 1, 1_000);
  for (let i = 0; i < 20; i++) assert.equal(l.hit("k", 1, 1_000).ok, false);
  c.now += 1_000;
  assert.equal(l.hit("k", 1, 1_000).ok, true, "twenty refused hits did not push the end of the wait out");
});

test("keys are separate, and a limit of one means one", () => {
  const l = new RateLimiter(clockAt().read);
  assert.equal(l.hit("a", 1, 1_000).ok, true);
  assert.equal(l.hit("b", 1, 1_000).ok, true);
  assert.equal(l.hit("a", 1, 1_000).ok, false);
  assert.equal(l.hit("b", 1, 1_000).ok, false);
});

test("a key can be forgotten, and the last hit on it can be taken back", () => {
  const l = new RateLimiter(clockAt().read);
  l.hit("k", 2, 60_000);
  l.hit("k", 2, 60_000);
  assert.equal(l.hit("k", 2, 60_000).ok, false);
  l.undo("k");
  assert.equal(l.hit("k", 2, 60_000).ok, true, "one hit was taken back");
  assert.equal(l.hit("k", 2, 60_000).ok, false);
  l.reset("k");
  assert.equal(l.hit("k", 2, 60_000).ok, true);
  assert.equal(l.size, 1);
  assert.doesNotThrow(() => l.undo("never hit"));
});

test("keys that have gone quiet are dropped, and a flood of new ones cannot grow the map past its bound", () => {
  const c = clockAt();
  const l = new RateLimiter(c.read, 3);
  for (const k of ["a", "b", "c"]) l.hit(k, 5, 1_000);
  c.now += 5_000;
  l.hit("d", 5, 1_000);
  assert.equal(l.size, 1, "a, b and c were quiet for longer than the window and were dropped when the bound was passed");
  for (let i = 0; i < 20; i++) l.hit(`flood${i}`, 5, 1_000_000);
  assert.ok(l.size <= 3, `the map holds ${l.size} keys`);
  assert.equal(l.hit("flood19", 1, 1_000_000).ok, false, "and the newest are the ones kept");
});

test("the limits the public API starts with are all positive whole numbers, with sign-ups and sign-ins tighter than ordinary use", () => {
  for (const [name, l] of Object.entries(DEFAULT_LIMITS)) {
    assert.ok(Number.isInteger(l.max) && l.max > 0 && Number.isInteger(l.windowMs) && l.windowMs > 0, name);
  }
  assert.ok(DEFAULT_LIMITS.signupEmail.max < DEFAULT_LIMITS.signupIp.max);
  assert.ok(DEFAULT_LIMITS.loginEmail.max < DEFAULT_LIMITS.loginIp.max);
  assert.ok(DEFAULT_LIMITS.forgotEmail.max < DEFAULT_LIMITS.apiIp.max);
  assert.ok(DEFAULT_LIMITS.loginIp.max / (DEFAULT_LIMITS.loginIp.windowMs / 60_000) < DEFAULT_LIMITS.apiIp.max);
});

// ---- the edges of the bound, and the numbers as they are written down ----

test("the bound on keys is passed, not reached: nothing is dropped until there are more keys than it", () => {
  const c = clockAt();
  const l = new RateLimiter(c.read, 3);
  for (const k of ["a", "b"]) l.hit(k, 5, 1_000);
  c.now += 5_000;
  l.hit("c", 5, 1_000);
  assert.equal(l.size, 3, "a and b are quiet, and there is room for them");
  l.hit("d", 5, 1_000);
  assert.equal(l.size, 2, "and now that there is not, the quiet ones go: c and d are what is left");
});

test("a key is quiet once its last hit is as old as the window, and what is dropped for it is that key, whatever its place in the order", () => {
  const c = clockAt();
  const l = new RateLimiter(c.read, 2);
  l.hit("a", 2, 1_000);
  l.hit("b", 2, 1_000);
  c.now += 900;
  l.hit("a", 2, 1_000);
  c.now += 100;
  // b's last hit is exactly one window old and a's is not: past the bound, b is the one that goes.
  l.hit("c", 2, 1_000);
  assert.equal(l.size, 2);
  assert.equal(l.hit("a", 2, 1_000).ok, true, "a kept its hit from 100 ms ago");
  assert.equal(l.hit("a", 2, 1_000).ok, false, "and so this is its third in the window");
});

test("when every key is still busy the oldest are dropped down to the bound, and no further", () => {
  const c = clockAt();
  const l = new RateLimiter(c.read, 2);
  for (const k of ["a", "b", "c"]) l.hit(k, 5, 1_000_000);
  assert.equal(l.size, 2, "down to the bound");
  assert.equal(l.hit("a", 1, 1_000_000).ok, true, "a was the oldest and was dropped: it is a new key");
  assert.equal(l.hit("c", 1, 1_000_000).ok, false, "c was kept, with its hit");
});

test("the limits the public API starts with are the ones the documentation states", () => {
  const docs = fs.readFileSync(path.join(__dirname, "..", "..", "..", "docs", "cloud-control-plane.md"), "utf8");
  const UNITS: Record<string, number> = { "an hour": 3_600_000, "a minute": 60_000, "ten minutes": 600_000 };
  /** `10 an hour / 3 an hour`, or `30 / 10 in ten minutes` where the unit at the end is for both. */
  const read = (cell: string): Array<{ max: number; windowMs: number }> => {
    const parts = cell.split("/").map((p) => p.trim());
    const units = parts.map((p) => /(an hour|a minute|ten minutes)$/.exec(p)?.[1]);
    const last = [...units].reverse().find((u) => u !== undefined)!;
    return parts.map((p, i) => ({ max: Number(/^\d+/.exec(p)![0]), windowMs: UNITS[units[i] ?? last]! }));
  };
  const row = (what: string): Array<{ max: number; windowMs: number }> => {
    const line = docs.split("\n").find((l) => l.startsWith(`| ${what}`));
    assert.ok(line, `the documentation has a row for ${what}`);
    return read(line.split("|")[2]!);
  };
  assert.deepEqual(row("Sign-ups"), [DEFAULT_LIMITS.signupIp, DEFAULT_LIMITS.signupEmail]);
  assert.deepEqual(row("Sign-in attempts"), [DEFAULT_LIMITS.loginIp, DEFAULT_LIMITS.loginEmail]);
  assert.deepEqual(row("Reset requests"), [DEFAULT_LIMITS.forgotIp, DEFAULT_LIMITS.forgotEmail]);
  assert.deepEqual(row("Links tried"), [DEFAULT_LIMITS.tokenIp]);
  assert.deepEqual(row("Everything else"), [DEFAULT_LIMITS.apiIp]);
  assert.deepEqual(row("What costs something"), [DEFAULT_LIMITS.actionSession]);
});
