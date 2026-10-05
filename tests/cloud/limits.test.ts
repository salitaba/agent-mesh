import { test } from "node:test";
import assert from "node:assert/strict";
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
