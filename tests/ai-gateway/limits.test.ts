import { test } from "node:test";
import assert from "node:assert/strict";
import { ConcurrencyLimiter, RateLimiter } from "../../packages/ai-gateway/src/index";

const clock = () => {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => void (t += ms), set: (v: number) => void (t = v) };
};

test("a key may burst up to a minute's calls and then waits for the next one to refill", () => {
  const c = clock();
  const limiter = new RateLimiter(c.now);
  for (let i = 0; i < 60; i++) assert.deepEqual(limiter.take("k", 60), { ok: true }, `call ${i + 1}`);
  // 60 a minute is one a second: the next is a second away.
  assert.deepEqual(limiter.take("k", 60), { ok: false, retryAfterMs: 1000 });
  c.advance(400);
  assert.deepEqual(limiter.take("k", 60), { ok: false, retryAfterMs: 600 });
  c.advance(600);
  assert.deepEqual(limiter.take("k", 60), { ok: true });
  assert.deepEqual(limiter.take("k", 60), { ok: false, retryAfterMs: 1000 });
});

test("the wait is reported to the millisecond, whatever the floating point does to the last digit", () => {
  const c = clock();
  const limiter = new RateLimiter(c.now);
  for (let i = 0; i < 60; i++) limiter.take("k", 60);
  c.advance(289);
  assert.deepEqual(limiter.take("k", 60), { ok: false, retryAfterMs: 711 });
  c.advance(1);
  assert.deepEqual(limiter.take("k", 60), { ok: false, retryAfterMs: 710 });
});

test("an idle key earns back no more than a minute's calls", () => {
  const c = clock();
  const limiter = new RateLimiter(c.now);
  for (let i = 0; i < 60; i++) limiter.take("k", 60);
  c.advance(60 * 60_000);
  let allowed = 0;
  while (limiter.take("k", 60).ok && allowed < 1000) allowed++;
  assert.equal(allowed, 60);
});

test("keys are limited one by one", () => {
  const c = clock();
  const limiter = new RateLimiter(c.now);
  for (let i = 0; i < 3; i++) assert.equal(limiter.take("a", 3).ok, true);
  assert.equal(limiter.take("a", 3).ok, false);
  assert.equal(limiter.take("b", 3).ok, true);
});

test("a clock that steps back earns nothing while it is back, and nothing for the time it then covers again", () => {
  const c = clock();
  const limiter = new RateLimiter(c.now);
  const start = c.now();
  for (let i = 0; i < 6; i++) assert.equal(limiter.take("k", 6).ok, true);
  c.set(start - 10 * 60_000);
  assert.equal(limiter.take("k", 6).ok, false, "a clock set back hands out nothing");
  // Back to thirty seconds past where it was: thirty seconds of refill at six a minute is three calls, not a full bucket.
  c.set(start + 30_000);
  assert.equal(limiter.take("k", 6).ok, true);
  assert.equal(limiter.take("k", 6).ok, true);
  assert.equal(limiter.take("k", 6).ok, true);
  assert.equal(limiter.take("k", 6).ok, false);
});

test("a limit that is lowered applies at once: the bucket never holds more than the new capacity", () => {
  const c = clock();
  const limiter = new RateLimiter(c.now);
  limiter.take("k", 600);
  c.advance(60_000);
  assert.equal(limiter.take("k", 2).ok, true);
  assert.equal(limiter.take("k", 2).ok, true);
  assert.equal(limiter.take("k", 2).ok, false);
});

test("a forgotten key starts again with a full allowance", () => {
  const c = clock();
  const limiter = new RateLimiter(c.now);
  for (let i = 0; i < 2; i++) limiter.take("k", 2);
  assert.equal(limiter.take("k", 2).ok, false);
  limiter.forget("k");
  assert.equal(limiter.take("k", 2).ok, true);
});

test("a key may have as many calls open as its limit and no more, and a closed call makes room", () => {
  const limiter = new ConcurrencyLimiter();
  const a = limiter.acquire("k", 2);
  const b = limiter.acquire("k", 2);
  assert.ok(a && b);
  assert.equal(limiter.inFlight("k"), 2);
  assert.equal(limiter.acquire("k", 2), undefined);
  a();
  assert.equal(limiter.inFlight("k"), 1);
  const c = limiter.acquire("k", 2);
  assert.ok(c);
  assert.equal(limiter.acquire("k", 2), undefined);
  b();
  c();
  assert.equal(limiter.inFlight("k"), 0);
});

test("closing a call twice frees one slot, not two", () => {
  const limiter = new ConcurrencyLimiter();
  const a = limiter.acquire("k", 2)!;
  const b = limiter.acquire("k", 2)!;
  a();
  a();
  assert.equal(limiter.inFlight("k"), 1);
  assert.ok(limiter.acquire("k", 2));
  assert.equal(limiter.acquire("k", 2), undefined, "the second release of a did not open a third slot");
  b();
});

test("calls are counted per key, and a lowered limit refuses new calls without closing open ones", () => {
  const limiter = new ConcurrencyLimiter();
  assert.ok(limiter.acquire("a", 1));
  assert.equal(limiter.acquire("a", 1), undefined);
  assert.ok(limiter.acquire("b", 1));
  const open = limiter.acquire("c", 5)!;
  limiter.acquire("c", 5);
  assert.equal(limiter.acquire("c", 1), undefined);
  assert.equal(limiter.inFlight("c"), 2);
  open();
  assert.equal(limiter.inFlight("c"), 1);
});
