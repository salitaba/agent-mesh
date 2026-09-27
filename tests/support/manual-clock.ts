import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Clock, TimerHandle, Timers } from "../../packages/protocol/src/index";
import type { StubRuntime } from "../../packages/agent-runtime/src/index";
import { bootstrapMesh, type MeshInstance } from "../../apps/mesh-server/src/index";
import { testConfigYaml, type TestMeshOptions } from "../helpers";

/**
 * A clock that only moves when a test moves it, and whose timers only fire
 * when that happens.
 *
 * Implements both halves the runtime reads: `Clock` (what time is it) and
 * `Timers` (call me back at). Handing one to `bootstrapMesh({ clock })` puts
 * the kernel's timestamps, the supervisor's watchdogs and the scheduler's
 * backoffs on the same notion of now — so a test about a 30-second park or a
 * 5-minute silence floor advances 30 seconds or 5 minutes, instantly, and can
 * name the exact millisecond a boundary is crossed.
 *
 * What it does NOT control: promises. A timer callback that starts async work
 * (a turn, an emit) returns before that work lands. `advance` is synchronous
 * and fires callbacks only; use `advanceAndSettle` when each callback's async
 * tail must land before the next due timer fires, or `waitFor` afterwards.
 */
interface ManualTimer extends TimerHandle {
  id: number;
  dueAt: number;
  fn: () => void;
  /** Set for an interval: its period, used to re-arm after each fire. */
  every?: number;
}

export class ManualClock implements Clock, Timers {
  private ms: number;
  private seq = 0;
  private timers = new Map<number, ManualTimer>();

  /**
   * @param start epoch ms or ISO string. Defaults to a fixed instant so two
   *   runs of a test see identical timestamps; pass `Date.now()` when the code
   *   under test compares against something still stamped by the wall clock.
   */
  constructor(start: number | string = "2026-01-01T00:00:00.000Z") {
    this.ms = typeof start === "number" ? start : Date.parse(start);
  }

  now(): Date {
    return new Date(this.ms);
  }

  iso(): string {
    return new Date(this.ms).toISOString();
  }

  /** Current time in epoch ms. */
  nowMs(): number {
    return this.ms;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    return this.arm(fn, ms);
  }

  setInterval(fn: () => void, ms: number): TimerHandle {
    // A zero period would fire forever inside one `advance`; Node clamps to 1ms
    // and so does this.
    return this.arm(fn, ms, Math.max(1, ms));
  }

  clearTimeout(handle: TimerHandle | undefined): void {
    if (handle) this.timers.delete((handle as ManualTimer).id);
  }

  clearInterval(handle: TimerHandle | undefined): void {
    this.clearTimeout(handle);
  }

  /** Timers armed and not yet fired or cleared. */
  pending(): number {
    return this.timers.size;
  }

  /**
   * Move time forward by `ms`, firing every timer that falls due on the way,
   * in due-time order (ties in the order they were armed). The clock reads
   * each timer's own due time while its callback runs, and a timer armed by a
   * callback fires in the same call if it falls due inside the window.
   */
  advance(ms: number): void {
    if (ms < 0) throw new Error(`ManualClock cannot go backwards (${ms}ms)`);
    const target = this.ms + ms;
    for (let t = this.nextDue(target); t; t = this.nextDue(target)) this.fire(t);
    this.ms = target;
  }

  /**
   * `advance`, but after every fired timer the event loop is drained so the
   * callback's async work lands before the next timer fires. Use this when a
   * timer's effect is the input to a later one (a restart timer arming a turn
   * that arms a turn timeout).
   */
  async advanceAndSettle(ms: number): Promise<void> {
    if (ms < 0) throw new Error(`ManualClock cannot go backwards (${ms}ms)`);
    const target = this.ms + ms;
    await settle();
    for (let t = this.nextDue(target); t; t = this.nextDue(target)) {
      this.fire(t);
      await settle();
    }
    this.ms = target;
    await settle();
  }

  private arm(fn: () => void, ms: number, every?: number): ManualTimer {
    const timer: ManualTimer = {
      id: ++this.seq,
      // Node treats a negative or NaN delay as "as soon as possible"; so does
      // this. Callers compute delays like `1000 - elapsed`, which can go below 0.
      dueAt: this.ms + (Number.isFinite(ms) && ms > 0 ? ms : 0),
      fn,
      every,
      unref: () => timer,
    };
    this.timers.set(timer.id, timer);
    return timer;
  }

  private nextDue(target: number): ManualTimer | undefined {
    let best: ManualTimer | undefined;
    for (const t of this.timers.values()) {
      if (t.dueAt > target) continue;
      if (!best || t.dueAt < best.dueAt || (t.dueAt === best.dueAt && t.id < best.id)) best = t;
    }
    return best;
  }

  private fire(t: ManualTimer): void {
    this.ms = Math.max(this.ms, t.dueAt);
    if (t.every !== undefined) {
      t.dueAt += t.every;
    } else {
      this.timers.delete(t.id);
    }
    t.fn();
  }
}

/**
 * Let pending promise chains run: a few macrotask turns, no wall-clock wait.
 * `setImmediate` rather than a microtask flush, because the chains under test
 * cross I/O-shaped boundaries (event-store appends) that microtasks alone do
 * not drain.
 */
export async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
}

/**
 * `makeMesh`, on a manual clock.
 *
 * A stand-in until `makeMesh` itself threads `clock` through to
 * `bootstrapMesh` (the option is `BootstrapOptions.clock`); it builds the same
 * in-memory, live-mode mesh from the same generated YAML. `yamlPatch` edits the
 * generated config for keys the fixture builder does not expose (e.g.
 * `turn_silence_ms`), and `runtimeOverrides` replaces the stub runtime.
 */
export async function makeClockedMesh(
  opts: TestMeshOptions,
  clock: ManualClock,
  extra: { yamlPatch?: (yaml: string) => string; runtimeOverrides?: Record<string, StubRuntime> } = {},
): Promise<MeshInstance & { cleanup(): Promise<void> }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-clock-test-"));
  const configPath = path.join(dir, "mesh.yaml");
  const yaml = testConfigYaml(opts);
  fs.writeFileSync(configPath, extra.yamlPatch ? extra.yamlPatch(yaml) : yaml, "utf8");
  const instance = await bootstrapMesh({
    configPath,
    inMemory: true,
    mode: "live",
    clock,
    ...(extra.runtimeOverrides ? { runtimeOverrides: extra.runtimeOverrides } : {}),
  });
  return Object.assign(instance, {
    async cleanup() {
      await instance.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  });
}
