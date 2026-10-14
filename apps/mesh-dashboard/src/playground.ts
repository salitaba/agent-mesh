/**
 * The Playground: the workspace owner types a command and reads what the product prints.
 *
 * The state machine lives here, with no DOM in it, so a test can drive it with a fake client (the same
 * split as the designer's chat store). The view (`views/Playground.tsx`) is a rendering of this state.
 *
 * Two facts from the server shape everything below. A run is asynchronous: the POST answers 201 with a
 * `runId`, and the log is read back by polling `playground/exec/<id>` until `done`. And there is one
 * runner per checkout, shared with the Product page's script runs, so a start can be refused with 409
 * while another run is in flight — with the operator's own command being what was refused, that sentence
 * belongs on screen beside the output that is still there, not in place of it.
 */

import type { ProjectClient } from "./api";
import { runOutcome, type RunOutcome } from "./product";

/** One entry point the product declares for itself (`GET playground/commands`). */
export interface PlayCommand {
  command: string;
  label: string;
  kind: "bin" | "script";
}

/** A command that ran, and what it printed. Kept after it ends: the output is the whole reason for the page. */
export interface PlayRun {
  id: string;
  command: string;
  done: boolean;
  exitCode: number | null;
  log: string;
  /** The browser's clock. The host's `startedAt` is on its own, and two clocks are not a duration. */
  startedAt: number;
  endedAt?: number;
  /** The operator pressed Stop in this page. */
  stopped?: boolean;
  /** The host answered "unknown run": it restarted, and runs live in its memory. */
  lost?: boolean;
}

export interface PlayState {
  commands: PlayCommand[];
  commandsLoaded: boolean;
  commandsError: string | null;
  run: PlayRun | null;
  /**
   * The server's own sentence for a command it would not start (409 another run is in progress, 400 empty
   * or too long) or would not stop. Shown beside the last run's output, never in place of it.
   */
  refusal: string | null;
  /** A start is in flight. The Run button is locked until the server answers, so a double-click is one run. */
  starting: boolean;
}

const EMPTY: PlayState = {
  commands: [],
  commandsLoaded: false,
  commandsError: null,
  run: null,
  refusal: null,
  starting: false,
};

/**
 * The commands out of a `playground/commands` answer, or null when the shape was not one. A product with
 * no `package.json` declares none and gets `[]` — that is an answer, not a failure, and the command box
 * is still the point of the page.
 */
export function parseCommands(json: unknown): PlayCommand[] | null {
  const list = (json as { commands?: unknown } | null)?.commands;
  if (!Array.isArray(list)) return null;
  const out: PlayCommand[] = [];
  for (const raw of list) {
    const c = raw as { command?: unknown; label?: unknown; kind?: unknown };
    if (typeof c?.command !== "string" || !c.command.trim()) continue;
    out.push({
      command: c.command,
      label: typeof c.label === "string" && c.label.trim() ? c.label : c.command,
      kind: c.kind === "script" ? "script" : "bin",
    });
  }
  return out;
}

/** A run that has not finished, and that the host still knows about. */
export const isLive = (run: PlayRun | null): boolean => !!run && !run.done && !run.lost;

/** Something is running (or being started): the second click of a double-click is not a second run. */
export const isBusy = (s: PlayState): boolean => s.starting || isLive(s.run);

/**
 * The sentence for a start the server would not accept. The server's own words are used verbatim, because
 * it is the one that knows why (`a run is already in progress` names the other run, which the page cannot).
 */
export function startRefusal(status: number, json: unknown, timeout = false): string {
  const said = (json as { error?: unknown } | null)?.error;
  if (typeof said === "string" && said.trim()) return said;
  if (timeout) return "The server did not answer in time. The command was not started.";
  return `The command was not started (the server answered ${status || "nothing"}).`;
}

/** How the controller is tuned. Both are costs the caller owns: a poll interval and a run's ceiling. */
export interface PlaygroundOptions {
  /** How long to wait between polls of a running command. */
  pollMs?: number;
  /** How long the command may run. The server clamps this; it is passed so the caller's expectation matches. */
  timeoutMs?: number;
}

export interface Playground {
  getState(): PlayState;
  subscribe(fn: () => void): () => void;
  /** Read the product's own entry points. */
  loadCommands(client: ProjectClient): Promise<void>;
  /**
   * Start a command and resolve when the run ends (or the start was refused). The view does not need the
   * promise — it renders the state — but a test does, and awaiting it is what makes "the run finished"
   * deterministic without a timer race.
   */
  start(client: ProjectClient, command: string): Promise<void>;
  /** Stop the run in flight. The output so far is kept. */
  stop(client: ProjectClient): Promise<void>;
  /** Dismiss the output of a finished run. */
  clear(): void;
}

export function createPlayground(opts: PlaygroundOptions = {}): Playground {
  const pollMs = opts.pollMs ?? 1200;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  let state: PlayState = EMPTY;
  const listeners = new Set<() => void>();
  // Identifies the live poll loop. A loop whose token no longer matches is a loop for a run that is
  // over, replaced or dismissed, and it stops rather than writing the old run's log over the new one's.
  let gen = 0;

  const set = (patch: Partial<PlayState>): void => {
    state = { ...state, ...patch };
    for (const l of listeners) l();
  };

  const sleep = (ms: number): Promise<void> => new Promise<void>((r) => { setTimeout(r, ms); });

  /** Poll one run to its end. Returns when the run is done (or the host has forgotten it). */
  const follow = async (client: ProjectClient, id: string, mine: number): Promise<void> => {
    for (;;) {
      if (mine !== gen) return;
      let json: any = null;
      try {
        json = (await client.api("GET", `/playground/exec/${encodeURIComponent(id)}`)).json;
      } catch {
        // The host may be restarting: keep what is on screen and ask again on the next beat.
      }
      if (mine !== gen) return;
      if (json && typeof json.error === "string") {
        // The host restarted and forgot the run. Not a failure of the command, and not an exit status it has.
        set({ run: state.run?.id === id ? { ...state.run, lost: true } : state.run });
        return;
      }
      if (json && json.id === id) {
        const done = Boolean(json.done);
        const r = state.run;
        if (r && r.id === id) {
          set({
            run: {
              ...r,
              done,
              exitCode: done ? json.exitCode ?? null : r.exitCode,
              log: typeof json.log === "string" ? json.log : r.log,
              endedAt: done ? r.endedAt ?? Date.now() : undefined,
            },
          });
        }
        if (done) return;
      }
      await sleep(pollMs);
    }
  };

  const loadCommands = async (client: ProjectClient): Promise<void> => {
    try {
      const { json, timeout } = await client.api("GET", "/playground/commands");
      const commands = parseCommands(json);
      if (commands) {
        set({ commands, commandsLoaded: true, commandsError: null });
        return;
      }
      const said = (json as { error?: unknown } | null)?.error;
      set({
        commandsError: timeout
          ? "The request timed out. The server may be busy."
          : typeof said === "string" && said.trim() ? said : "The server sent something this page could not read.",
      });
    } catch (e: unknown) {
      set({ commandsError: e instanceof Error ? e.message : String(e) });
    }
  };

  const start = async (client: ProjectClient, command: string): Promise<void> => {
    // One run at a time is the server's rule too, but a double-click should not spend a request finding out.
    if (isBusy(state)) return;
    const text = command.trim();
    set({ starting: true, refusal: null });
    let res;
    try {
      res = await client.api("POST", "/playground/exec", { command: text, timeoutMs });
    } catch (e: unknown) {
      set({ starting: false, refusal: e instanceof Error ? e.message : String(e) });
      return;
    }
    const runId = typeof res.json?.runId === "string" ? res.json.runId : null;
    if (res.status === 201 && runId) {
      gen += 1;
      const mine = gen;
      set({
        starting: false,
        refusal: null,
        run: { id: runId, command: text, done: false, exitCode: null, log: "", startedAt: Date.now() },
      });
      await follow(client, runId, mine);
      return;
    }
    // 409 (another run is in progress) or 400 (an empty or over-long command): the server's own sentence,
    // and the last run's output stays where it is — it is still the answer to the last command that ran.
    set({ starting: false, refusal: startRefusal(res.status, res.json, res.timeout) });
  };

  const stop = async (client: ProjectClient): Promise<void> => {
    const run = state.run;
    if (!run || run.done || run.lost) return;
    // Say it immediately: the request may take a moment, and the button must not look unpressed meanwhile.
    set({ run: { ...run, stopped: true } });
    // The kill did not happen after all: put the button back and say what the host said.
    const backToStop = (said: string): void => {
      const r = state.run;
      set({ run: r && r.id === run.id ? { ...r, stopped: false } : r, refusal: said });
    };
    let res;
    try {
      res = await client.api("POST", `/workspace/run/kill/${encodeURIComponent(run.id)}`);
    } catch (e: unknown) {
      backToStop(e instanceof Error ? e.message : String(e));
      return;
    }
    if (!res.json?.ok) backToStop(startRefusal(res.status, res.json, res.timeout));
  };

  const clear = (): void => {
    gen += 1;
    set({ run: null, refusal: null });
  };

  return {
    getState: () => state,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    loadCommands,
    start,
    stop,
    clear,
  };
}

/** How a run of the playground ended, in the Product page's vocabulary. */
export const outcomeOf = (run: PlayRun): RunOutcome => runOutcome(run, run.lost);
