/**
 * The limits a key has that are about load, not money: how often it may call and how many calls it may have open at once.
 *
 * They live in memory. A restart forgets them, which only ever lets a key call a little sooner than it would have; the
 * limits that protect the balance (the account's credit and a key's daily cap) are in the ledger and survive anything.
 */

export type Take = { ok: true } | { ok: false; retryAfterMs: number };

/** A token bucket per key: it holds a minute's calls and refills continuously, so a burst is allowed and a flood is not. */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  /** `now` is a monotonic clock in milliseconds: a wall clock that is set back would hand out calls that were not earned. */
  constructor(private readonly now: () => number = () => performance.now()) {}

  /** Take one call from `key`'s allowance of `perMinute`. */
  take(key: string, perMinute: number): Take {
    const now = this.now();
    const perMs = perMinute / 60_000;
    const bucket = this.buckets.get(key) ?? { tokens: perMinute, at: now };
    bucket.tokens = Math.min(perMinute, bucket.tokens + Math.max(0, now - bucket.at) * perMs);
    bucket.at = Math.max(bucket.at, now);
    this.buckets.set(key, bucket);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { ok: true };
    }
    // The small subtraction keeps floating point noise from turning an exact 600 into 601.
    return { ok: false, retryAfterMs: Math.ceil((1 - bucket.tokens) / perMs - 1e-6) };
  }

  /** Drop what is held for a key that no longer exists. */
  forget(key: string): void {
    this.buckets.delete(key);
  }
}

/** How many calls each key has open. */
export class ConcurrencyLimiter {
  private readonly open = new Map<string, number>();

  /** A slot, or undefined when the key already has `max` calls open. The function returned closes the slot, once. */
  acquire(key: string, max: number): (() => void) | undefined {
    const n = this.open.get(key) ?? 0;
    if (n >= max) return undefined;
    this.open.set(key, n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.open.get(key) ?? 1) - 1;
      if (left <= 0) this.open.delete(key);
      else this.open.set(key, left);
    };
  }

  inFlight(key: string): number {
    return this.open.get(key) ?? 0;
  }
}
