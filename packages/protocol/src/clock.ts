export interface Clock {
  now(): Date;
  iso(): string;
}

export const systemClock: Clock = {
  now: () => new Date(),
  iso: () => new Date().toISOString(),
};

export class FixedClock implements Clock {
  private ms: number;
  constructor(startISO: string | number = "2026-01-01T00:00:00.000Z") {
    this.ms = typeof startISO === "number" ? startISO : Date.parse(startISO);
  }
  now(): Date {
    return new Date(this.ms);
  }
  iso(): string {
    return new Date(this.ms).toISOString();
  }
  advance(ms: number): void {
    this.ms += ms;
  }
  set(iso: string): void {
    this.ms = Date.parse(iso);
  }
}

/**
 * The handle a `Timers` implementation hands back. Node's `Timeout` satisfies
 * it, and so does a test clock's plain object; `unref` is optional because
 * only a real event loop has anything to un-reference.
 */
export interface TimerHandle {
  unref?(): unknown;
}

/**
 * The timer half of time. `Clock` answers "what time is it"; this answers
 * "call me back at". Kept separate so the dozen `Clock` implementations that
 * only ever stamp events do not have to grow timer methods they never use.
 *
 * A clock that ALSO implements this (a test's manual clock) drives both halves
 * from one notion of now, which is the whole point: a watchdog that reads
 * `clock.now()` and is woken by a real `setTimeout` cannot be tested without
 * waiting for the real timeout.
 */
export interface Timers {
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle | undefined): void;
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle | undefined): void;
}

type NativeTimer = ReturnType<typeof setTimeout>;

export const systemTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NativeTimer | undefined),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as NativeTimer | undefined),
};

/**
 * The timers that belong to `clock`: its own when it has them, the real event
 * loop's otherwise. Every production clock takes the second branch, so
 * behaviour there is exactly `setTimeout`/`setInterval`.
 */
export function timersOf(clock: Clock): Timers {
  const c = clock as Partial<Timers>;
  return typeof c.setTimeout === "function" &&
    typeof c.clearTimeout === "function" &&
    typeof c.setInterval === "function" &&
    typeof c.clearInterval === "function"
    ? (clock as Clock & Timers)
    : systemTimers;
}
