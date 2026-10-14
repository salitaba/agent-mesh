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
  /**
   * The console's own clock ended it, not a person and not the command. A run that was signalled has no exit code, and
   * the panel used to read that as "Ended by a signal" — a true sentence that blamed nobody and explained nothing while
   * a test suite that needed two minutes was killed every time. See RUN_CEILING_MS.
   */
  timedOut?: boolean;
  /** The clock the host was given for this run, so the sentence can name a duration. */
  timeoutMs?: number | null;
}

/**
 * The host's longest clock for one run (`playground/exec` clamps `timeoutMs` to this; see apps/mesh-server/src/index.ts).
 *
 * The page used to ask for a minute. That is not a bug in the host and it was reported as one in the page: a suite that
 * takes ninety seconds was signalled at sixty and shown as "Ended by a signal", with no mention of a clock anywhere.
 * Nothing here waits for ever — the host still ends the run, and now the page asks for the whole time it is allowed.
 */
export const RUN_CEILING_MS = 300_000;

/** A run the host will not start another beside, as the 409 body names it. */
export interface BlockedRun {
  id: string;
  command: string;
  /** The host's clock (epoch ms), so the page can say how long it has been going. */
  startedAt: number;
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
  /**
   * The run that is in the way, when the refusal was a 409. The host names it, so the page can offer to end it:
   * without this the answer to "a run is already in progress" was a sentence with no button under it, from a page that
   * cannot see the other tab, the other page or the reload that left the run behind.
   */
  blocked: BlockedRun | null;
  /** The command that was refused, kept so ending the blocking run can go straight on to it. */
  pending: string | null;
  /** A start is in flight. The Run button is locked until the server answers, so a double-click is one run. */
  starting: boolean;
  /** Ending the blocking run is in flight. */
  clearing: boolean;
}

const EMPTY: PlayState = {
  commands: [],
  commandsLoaded: false,
  commandsError: null,
  run: null,
  refusal: null,
  blocked: null,
  pending: null,
  starting: false,
  clearing: false,
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
export const isBusy = (s: PlayState): boolean => s.starting || s.clearing || isLive(s.run);

/**
 * The run a refusal names, or null. Only a 409 carries one: the host is the only one that knows what is in the way
 * (another tab's command, or a script the Product page started), and it says so rather than leaving the page guessing.
 */
export function blockedRunOf(status: number, json: unknown): BlockedRun | null {
  if (status !== 409) return null;
  const r = (json as { run?: { id?: unknown; command?: unknown; startedAt?: unknown } } | null)?.run;
  if (!r || typeof r.id !== "string" || !r.id) return null;
  return {
    id: r.id,
    command: typeof r.command === "string" && r.command.trim() ? r.command : "a command",
    startedAt: typeof r.startedAt === "number" ? r.startedAt : Date.now(),
  };
}

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

/**
 * How a run that ended without an exit code ended: by the console's clock, by a person, or by a signal nobody here
 * sent. The three read differently because they are different, and only the first two can be answered on this page.
 */
export function stopReason(run: PlayRun): "clock" | "you" | "signal" {
  if (run.timedOut) return "clock";
  return run.stopped ? "you" : "signal";
}

/** The sentence under a run the console's own clock ended, naming the clock it was given. */
export function clockWords(timeoutMs: number | null | undefined): string {
  const mins = Math.max(1, Math.round((timeoutMs ?? RUN_CEILING_MS) / 60_000));
  return `The console stopped it after ${mins} minute${mins === 1 ? "" : "s"}, the longest a command may run here.`;
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
  /**
   * End the run that is in the way and then run the command that was refused.
   *
   * One press, because that is the whole point: on a phone the person has one thumb, the sentence told them a run is
   * going, and the only way out used to be another page or another tab. The killed run is adopted as this page's run
   * first, so its output and its ending are on screen, and the refused command starts once the host has really let go.
   */
  stopBlocking(client: ProjectClient): Promise<void>;
  /** Dismiss the output of a finished run. */
  clear(): void;
}

export function createPlayground(opts: PlaygroundOptions = {}): Playground {
  const pollMs = opts.pollMs ?? 1200;
  // The host's own ceiling, not a minute: a page that asks for less than it is allowed is a page that kills long work
  // and then reports it as a signal (see RUN_CEILING_MS).
  const timeoutMs = opts.timeoutMs ?? RUN_CEILING_MS;
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
              timedOut: json.timedOut === true,
              timeoutMs: typeof json.timeoutMs === "number" ? json.timeoutMs : r.timeoutMs,
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
    set({ starting: true, refusal: null, blocked: null, pending: text });
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
      const clock = typeof res.json.timeoutMs === "number" ? res.json.timeoutMs : timeoutMs;
      set({
        starting: false,
        refusal: null,
        blocked: null,
        pending: null,
        run: { id: runId, command: text, done: false, exitCode: null, log: "", startedAt: Date.now(), timeoutMs: clock },
      });
      await follow(client, runId, mine);
      return;
    }
    // 409 (another run is in progress) or 400 (an empty or over-long command): the server's own sentence,
    // and the last run's output stays where it is — it is still the answer to the last command that ran.
    // A 409 also names the run in the way, which is the difference between a sentence and a way out.
    set({
      starting: false,
      refusal: startRefusal(res.status, res.json, res.timeout),
      blocked: blockedRunOf(res.status, res.json),
    });
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

  /**
   * End the run that is in the way, then run what the person asked for. The order matters: the host will not start a
   * second run until the first is really gone, so the page waits for the run it killed to end rather than pressing
   * again and being refused by the same run it just stopped.
   */
  const stopBlocking = async (client: ProjectClient): Promise<void> => {
    const b = state.blocked;
    const want = state.pending;
    if (!b || state.clearing) return;
    set({ clearing: true });
    let res;
    try {
      res = await client.api("POST", `/workspace/run/kill/${encodeURIComponent(b.id)}`);
    } catch (e: unknown) {
      set({ clearing: false, blocked: null, refusal: e instanceof Error ? e.message : String(e) });
      return;
    }
    if (res.json?.ok !== true) {
      // The host would not end it (it finished on its own between the refusal and the press, most likely). Say what it
      // said, and let the person press Run again rather than pretending the way is clear.
      set({ clearing: false, blocked: null, refusal: startRefusal(res.status, res.json, res.timeout) });
      return;
    }
    // Watch it out: it is a run like any other, and its last lines are worth having on screen.
    gen += 1;
    const mine = gen;
    set({
      clearing: false,
      blocked: null,
      refusal: null,
      run: { id: b.id, command: b.command, done: false, exitCode: null, log: "", startedAt: b.startedAt, stopped: true },
    });
    await follow(client, b.id, mine);
    if (want && want !== b.command) await start(client, want);
  };

  const clear = (): void => {
    gen += 1;
    set({ run: null, refusal: null, blocked: null, pending: null, clearing: false });
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
    stopBlocking,
    clear,
  };
}

/** How a run of the playground ended, in the Product page's vocabulary. */
export const outcomeOf = (run: PlayRun): RunOutcome => runOutcome(run, run.lost);
