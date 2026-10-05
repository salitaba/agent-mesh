/**
 * Rate limits for the public surface: how often one address, one email or one session may ask for a thing.
 *
 * A window is a list of the times of the last hits, so it is exact (the limit is `max` in any span of `windowMs`, not in a
 * fixed bucket that a burst can straddle). It lives in memory in one process, which is how the control plane runs; a limit
 * is a brake on guessing and on mail, not a record, so a restart that clears it costs nothing that matters.
 */

export type Verdict = { ok: true } | { ok: false; retryAfterSec: number };

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly now: () => number = Date.now,
    /** The most keys kept at once. Past it the ones that have gone quiet are dropped first. */
    private readonly maxKeys = 100_000,
  ) {}

  /** Count one hit for `key` and say whether it is within `max` in the last `windowMs`. A refused hit is not counted. */
  hit(key: string, max: number, windowMs: number): Verdict {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      this.hits.set(key, recent);
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((recent[0]! + windowMs - now) / 1000)) };
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > this.maxKeys) this.sweep(windowMs);
    return { ok: true };
  }

  /** Take back the last hit on a key: an attempt that was refused for what it said, and so did nothing that a limit is there to stop. */
  undo(key: string): void {
    this.hits.get(key)?.pop();
  }

  /** Forget a key: a sign-in that succeeded is not held against the address that made it. */
  reset(key: string): void {
    this.hits.delete(key);
  }

  get size(): number {
    return this.hits.size;
  }

  private sweep(windowMs: number): void {
    const now = this.now();
    for (const [key, times] of this.hits) {
      if (times.length === 0 || now - times[times.length - 1]! >= windowMs) this.hits.delete(key);
    }
    // Still over: whoever has been quiet longest goes, so a flood of new keys cannot grow the map without end.
    while (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next().value;
      if (oldest === undefined) break;
      this.hits.delete(oldest);
    }
  }
}

/** One named limit: this many hits in this long. */
export interface Limit {
  max: number;
  windowMs: number;
}

/** What the public API allows. Each is the most in the window, per the key named. */
export interface Limits {
  /** Sign-ups from one address. */
  signupIp: Limit;
  /** Sign-ups for one email, whatever the address: a way to fill a person's inbox. */
  signupEmail: Limit;
  /** Sign-in attempts from one address. */
  loginIp: Limit;
  /** Sign-in attempts at one email, whatever the address: guessing a password from many places. */
  loginEmail: Limit;
  /** Reset requests from one address. */
  forgotIp: Limit;
  /** Reset requests for one email. */
  forgotEmail: Limit;
  /** Confirmation and reset links tried from one address: guessing a link. */
  tokenIp: Limit;
  /** Everything else from one address. */
  apiIp: Limit;
  /** Things that cost something (a checkout, a portal, a workspace made or opened), per session. */
  actionSession: Limit;
}

const HOUR = 3_600_000;
const MINUTE = 60_000;

export const DEFAULT_LIMITS: Limits = {
  signupIp: { max: 10, windowMs: HOUR },
  signupEmail: { max: 3, windowMs: HOUR },
  loginIp: { max: 30, windowMs: 10 * MINUTE },
  loginEmail: { max: 10, windowMs: 10 * MINUTE },
  forgotIp: { max: 10, windowMs: HOUR },
  forgotEmail: { max: 3, windowMs: HOUR },
  tokenIp: { max: 30, windowMs: HOUR },
  apiIp: { max: 600, windowMs: MINUTE },
  actionSession: { max: 60, windowMs: HOUR },
};
