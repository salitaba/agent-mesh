/**
 * The product's own UI, running: the state machine behind the panel that shows it.
 *
 * The console starts a command of the product's own, learns the loopback port from what it prints, and proxies it into a
 * sandboxed frame (see apps/mesh-server/src/ui-live.ts). This file is what the page knows about that, with no DOM in it,
 * so a test can drive it with a fake client — the same split as `playground.ts`.
 *
 * The panel it replaces had one state where there are four, and that is where its two dead ends came from. `running` is
 * false when nothing has been started, when the command is up and has not yet said where it listens, and when it has
 * ended — so the page drew the *start* box in all three. Reload the console while the UI was up and the box came back
 * with no way to the frame that was still running; press Start and the host answered "the product's UI is already
 * running", which is true and leads nowhere, because Stop was only drawn beside `running`. And a UI that exited at once
 * left a log tail and no word about the exit code it died with.
 *
 * What the host answers is enough to tell all four apart — `command` says whether anything was ever started, `port`
 * whether it has named where it listens, `exitCode` whether it has ended — so the phase is read from that, and never
 * guessed from a boolean.
 */

import type { ProjectClient } from "./api";

/** What `GET /<project>/ui` answers with (see apps/mesh-server/src/ui-live.ts, `describeLiveUi`). */
export interface LiveUiAnswer {
  running: boolean;
  command: string | null;
  port: number | null;
  url?: string | null;
  log: string;
  livePath: string | null;
  exitCode?: number | null;
  stopped?: boolean;
  expiresAt?: string;
}

/**
 * Where the product's UI is.
 *
 * - `idle`: nothing has been started on this host (or the host restarted, and it keeps this in memory).
 * - `starting`: the command is up and has not printed a loopback address yet. It is *running*; it is not usable yet.
 * - `live`: it named its port, and the frame can load it through the console.
 * - `ended`: it exited (code, or a stop) and is not coming back on its own.
 */
export type LivePhase = "idle" | "starting" | "live" | "ended";

export interface LiveUiState {
  phase: LivePhase;
  /** The command: what the owner typed, or the one the host still remembers from last time. */
  command: string;
  port: number | null;
  exitCode: number | null;
  stopped: boolean;
  log: string;
  /** The capability the sandboxed frame loads, once it exists. */
  livePath: string | null;
  /** The frame is open, and `src` is the link it was opened with (captured once: a per-poll link would reload it). */
  open: boolean;
  src: string | null;
  /** When the host will stop it by itself, from the answer: the panel says so rather than letting it vanish unexplained. */
  expiresAt: string | null;
  /** The line the page shows under the heading when the UI is not simply "running". */
  problem: string | null;
  /** A start or a stop is in flight. */
  busy: boolean;
  /**
   * When this page began watching a command that has not named its port yet, by the browser's clock. Null when it is not
   * waiting for anything. Used to say, in words, that a UI which never prints an address cannot be shown here.
   */
  waitingSince: number | null;
}

const IDLE: LiveUiState = {
  phase: "idle",
  command: "",
  port: null,
  exitCode: null,
  stopped: false,
  log: "",
  livePath: null,
  open: false,
  src: null,
  expiresAt: null,
  problem: null,
  busy: false,
  waitingSince: null,
};

/** The phase of an answer from the host. The three falses of `running` are told apart by what else the answer carries. */
export function phaseOf(a: LiveUiAnswer): LivePhase {
  if (!a.command) return "idle";
  if (a.running) return "live";
  if (a.stopped) return "ended";
  return a.exitCode === null || a.exitCode === undefined ? "starting" : "ended";
}

/** How long a command may run without naming a port before the page says what that means. */
export const NO_PORT_AFTER_MS = 20_000;

/**
 * The sentence for a UI that is not usable, or null when there is nothing to explain.
 *
 * Every one of these is a state the old panel drew as the start box: a command that is up but has not said where it
 * listens, one that died, and one the console's own clock ended. A person on a phone gets the words, not a spinner.
 */
export function problemOf(s: LiveUiState, now: number): string | null {
  switch (s.phase) {
    case "starting":
      return s.waitingSince !== null && now - s.waitingSince > NO_PORT_AFTER_MS
        ? "It is running, but it has not printed the address it listens on. Only a UI that prints a 127.0.0.1:<port> line can be shown in this frame — everything it has printed is below."
        : "Started. Waiting for it to print the address it listens on.";
    case "ended":
      if (s.stopped) return "It was stopped. Start it again to use it.";
      return s.exitCode === 0
        ? "It ran and exited with code 0: this command finishes on its own, so there is nothing left to show."
        : `It exited with code ${s.exitCode ?? "?"} before it named a port. What it printed is below.`;
    case "idle":
      return s.command.trim()
        ? null
        : "Type how this product starts its own UI — its own command, the one that prints where it listens.";
    default:
      return null;
  }
}

export interface LiveUiOptions {
  /** How often to ask the host while a command is starting or up. */
  pollMs?: number;
  /** The clock's reading. Passed in so a test can say what "now" is. */
  now?: () => number;
  /** Where the command the owner last used is remembered, per project. */
  readRemembered?: () => string | null;
  writeRemembered?: (command: string) => void;
}

export interface LiveUi {
  getState(): LiveUiState;
  subscribe(fn: () => void): () => void;
  /**
   * Ask the host what it has. Called on arrival, which is the whole fix for the reload: a UI that is already up is
   * found, not started again. Resolves when the answer has been taken.
   */
  refresh(client: ProjectClient): Promise<void>;
  /** Start a command. The server's own sentence is kept when it refuses (another UI is already running, or none was given). */
  start(client: ProjectClient, command?: string): Promise<void>;
  stop(client: ProjectClient): Promise<void>;
  /** Point the frame at the running UI. Does nothing when it is not up. */
  open(projectId: string | null): void;
  close(): void;
  /** Keep asking while it matters; the caller runs this on a timer. */
  due(): boolean;
}

export function createLiveUi(opts: LiveUiOptions = {}): LiveUi {
  const pollMs = opts.pollMs ?? 1500;
  const now = opts.now ?? (() => Date.now());
  let state: LiveUiState = { ...IDLE, command: opts.readRemembered?.() ?? "" };
  const listeners = new Set<() => void>();
  // A start or stop in flight owns the state until it answers: a poll that lands in between must not report the old
  // phase over it.
  let seq = 0;

  const set = (patch: Partial<LiveUiState>): void => {
    state = { ...state, ...patch };
    for (const l of listeners) l();
  };

  const absorb = (a: LiveUiAnswer, mine: number): void => {
    if (mine !== seq) return;
    const phase = phaseOf(a);
    const command = a.command ?? state.command;
    set({
      phase,
      command,
      port: a.port,
      exitCode: a.exitCode ?? null,
      stopped: a.stopped ?? false,
      log: typeof a.log === "string" ? a.log : "",
      livePath: a.livePath,
      expiresAt: typeof a.expiresAt === "string" ? a.expiresAt : state.expiresAt,
      busy: false,
      // The clock starts when this page first sees a command that has not named a port, and stops when it has one.
      waitingSince: phase === "starting" ? state.waitingSince ?? now() : null,
      // A frame open on a UI that is no longer up would sit on a dead link: close it with the UI it was showing.
      ...(phase === "live" ? {} : { open: false, src: null }),
      problem: null,
    });
    if (command.trim()) opts.writeRemembered?.(command.trim());
  };

  const refresh = async (client: ProjectClient): Promise<void> => {
    const mine = ++seq;
    try {
      const { json, status } = await client.api("GET", "/ui");
      // A failed poll is not an answer. A 5xx body is `{error}`, and absorbing it read as "nothing has ever been started":
      // it closed a frame that was showing a UI, and put back the start box for a command the host was still running. Keep
      // what is on the screen and ask again on the next beat.
      if (status >= 400) return;
      if (json && typeof json === "object") absorb(json as LiveUiAnswer, mine);
    } catch {
      /* the host may be restarting: keep what is on screen, and ask again on the next beat */
    }
  };

  const start = async (client: ProjectClient, command?: string): Promise<void> => {
    const text = (command ?? state.command).trim();
    if (!text) {
      set({ problem: "Type how this product starts its own UI — its own command, the one that prints where it listens." });
      return;
    }
    const mine = ++seq;
    // Said at once: the command may take a moment to print its address, and the box must not look unpressed meanwhile.
    set({ busy: true, command: text, problem: null, waitingSince: now() });
    let res;
    try {
      res = await client.api("POST", "/ui/start", { command: text });
    } catch (e: unknown) {
      if (mine === seq) set({ busy: false, phase: "idle", waitingSince: null, problem: e instanceof Error ? e.message : String(e) });
      return;
    }
    if (mine !== seq) return;
    const said = (res.json as { error?: unknown } | null)?.error;
    if (res.status >= 400) {
      // The host's own words: it is the one that knows a UI is already running, and this page cannot see the other one.
      const refusal = typeof said === "string" && said.trim() ? said : "The product's UI would not start.";
      set({ busy: false, phase: "idle", waitingSince: null, problem: refusal });
      // A refusal is a fact about a host this page may not have looked at yet — "already running" is exactly the case
      // where the panel should show the running UI rather than a box that will be refused again. So ask. What comes
      // back decides: a UI that is up takes the panel, and a host with nothing running leaves the sentence standing.
      await refresh(client);
      if (state.phase === "idle" && !state.busy && !state.problem) set({ problem: refusal });
      return;
    }
    if (res.json && typeof res.json === "object") absorb(res.json as LiveUiAnswer, mine);
  };

  const stop = async (client: ProjectClient): Promise<void> => {
    const mine = ++seq;
    set({ busy: true, open: false, src: null });
    try {
      const { json } = await client.api("POST", "/ui/stop", {});
      if (mine !== seq) return;
      const next = (json as { state?: LiveUiAnswer } | null)?.state;
      if (next) absorb(next, mine);
      else set({ busy: false, phase: "ended", stopped: true, waitingSince: null });
    } catch {
      if (mine === seq) set({ busy: false });
    }
  };

  return {
    getState: () => state,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    refresh,
    start,
    stop,
    /**
     * The frame is bound to one link, taken once: the host mints a new capability on every poll, and re-pointing the
     * iframe at a fresh one would reload the product's page under the person using it.
     */
    open: (projectId) => {
      if (state.phase !== "live" || !state.livePath) return;
      set({ open: true, src: liveSrc(projectId, state.livePath) });
    },
    close: () => set({ open: false, src: null }),
    due: () => state.busy || state.phase === "starting" || state.phase === "live",
  };
}

/** The frame's address: the capability is relative to the project, like every other path this console calls. */
export function liveSrc(projectId: string | null, livePath: string): string {
  const rest = livePath.startsWith("/") ? livePath : `/${livePath}`;
  const path = projectId ? `/api/p/${encodeURIComponent(projectId)}${rest}` : rest;
  // The frame needs the file name to end on: a link that ends in `/` resolves the product's own relative references
  // against the directory above it.
  return path.endsWith("/") ? path : `${path}/`;
}

/** How long the host will keep a UI it started before its own clock stops it, in words. */
export function lifetimeText(expiresAt: string | undefined | null, now: number): string | null {
  if (!expiresAt) return null;
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at)) return null;
  const left = Math.round((at - now) / 60_000);
  return left <= 0 ? "The console is stopping it now: it has run for as long as it is allowed to." : `The console stops it by itself in about ${left} minute${left === 1 ? "" : "s"}.`;
}

const rememberKey = (projectId: string | null): string => `mesh-live:${projectId ?? "-"}`;

/** The command this product's UI was last started with, which is the one it will be started with again. */
export function rememberedCommand(projectId: string | null): string | null {
  try {
    const c = localStorage.getItem(rememberKey(projectId));
    return c && c.trim() ? c : null;
  } catch {
    return null;
  }
}

export function rememberCommand(projectId: string | null, command: string): void {
  try {
    localStorage.setItem(rememberKey(projectId), command);
  } catch {
    /* a private window: the command is simply not remembered */
  }
}
