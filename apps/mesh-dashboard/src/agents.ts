/**
 * What the Agents page decides, as a model: which group an agent belongs in, what its card says it is doing and for how long,
 * which controls make sense for it, and what a control's answer says back.
 *
 * The page used to show the lifecycle word twice and a "wake" button on every card. A stalled agent and a healthy one looked
 * alike until they were opened, a button that would be refused (an agent that finished with the mission) was offered all the same,
 * and "wake: pm: ok" did not say that a wake runs one turn and then lets the agent go back to waiting. Each of those is a function
 * here so that the tests can pin it. DOM-free: structural types, no React.
 */
import { RUNNING, dur, fmt, opsSummary, outcomeOf, plainBlocker, shortTurn, OUTCOME_META, type OutcomeInput } from "./format";
import { sinceText } from "./feed";

/* ---------------------------------- groups ---------------------------------- */

export type GroupId = "help" | "working" | "waiting" | "paused" | "idle";

export interface GroupDef {
  id: GroupId;
  title: string;
  /** One line under the heading: what being in this group means for the agent. */
  hint: string;
}

/** Most urgent first. A group with nobody in it is not drawn. */
export const GROUPS: readonly GroupDef[] = [
  { id: "help", title: "Needs you", hint: "Crashed, blocked, or in a turn that has stopped giving any sign of life." },
  { id: "working", title: "Working now", hint: "In a turn right now." },
  { id: "waiting", title: "Waiting for mail", hint: "Parked on the mailbox until someone writes to it. A healthy resting state." },
  { id: "paused", title: "Paused by you", hint: "Will not wake for mail, nudges or Run one step until you unpause it." },
  { id: "idle", title: "Idle or finished", hint: "Starting up, between turns, or done with the mission." },
];

/**
 * An agent's group. Crashed and blocked agents need a person, and so does one whose turn has gone silent (`stalled`, from the
 * turn's vitals): that is the one failure that otherwise reads as "working". Everything else follows the lifecycle.
 */
export function groupOf(lifecycle: string, stalled: boolean): GroupId {
  const l = String(lifecycle || "").toUpperCase();
  if (l === "FAILED" || l === "BLOCKED") return "help";
  if (RUNNING.has(l)) return stalled ? "help" : "working";
  if (l === "SUSPENDED") return "paused";
  if (l === "WAITING") return "waiting";
  return "idle";
}

export interface AgentLike {
  id: string;
  role: string;
  lifecycle: string;
  /** Unread messages. */
  mailbox?: number;
  tokens?: number;
  activations?: number;
}

export interface AgentGroup<T> extends GroupDef {
  agents: T[];
}

/**
 * The project as a seat that has never run sees it. Such a seat (STARTING) is set up the first time something wakes it: while the
 * mission runs that can be any moment, on a parked project nothing wakes it until the mission runs, and once the mission is over
 * nothing will.
 */
export interface SeatSetting {
  /** The project is parked: nothing wakes an agent on its own. */
  parked: boolean;
  /** The mission has run before, so it waits to continue rather than to start (the Overview's button says which). */
  started?: boolean;
  /** The mission is delivered or failed. */
  over?: boolean;
}

/** The idle group holds the seats that have never run, so its hint says what those are in this project's state. */
function idleHint(s: SeatSetting | undefined): string {
  if (s?.over) return "Done with the mission, or never woken during it.";
  if (s?.parked) return "Ready, between turns, or done with the mission.";
  return GROUPS.find((g) => g.id === "idle")!.hint;
}

/** Agents under their groups, in `GROUPS` order, each group in the order the roster gives (a seat's place in the mesh is stable). */
export function groupAgents<T extends AgentLike>(agents: readonly T[], stalled: ReadonlySet<string>, setting?: SeatSetting): AgentGroup<T>[] {
  return GROUPS
    .map((g) => ({ ...g, hint: g.id === "idle" ? idleHint(setting) : g.hint, agents: agents.filter((a) => groupOf(a.lifecycle, stalled.has(a.id)) === g.id) }))
    .filter((g) => g.agents.length > 0);
}

/* ---------------------------------- turns ---------------------------------- */

/** What this model reads of a turn. Structural, so the store's `TurnStep` fits without this file importing a .tsx. */
export interface TurnLike extends OutcomeInput {
  agentId: string;
  startedAt: string;
  endedAt?: string;
  tokens: number;
  error?: string;
}

/**
 * The newest turn of each agent that is running, and the newest that is over. `/steps` is newest first, so the first one seen of
 * each kind wins; they are kept apart because "what is it doing" and "what did it last do" are different questions.
 */
export function turnsByAgent<T extends TurnLike>(steps: readonly T[]): { running: Map<string, T>; last: Map<string, T> } {
  const running = new Map<string, T>();
  const last = new Map<string, T>();
  for (const s of steps) {
    const into = s.status === "running" ? running : last;
    if (!into.has(s.agentId)) into.set(s.agentId, s);
  }
  return { running, last };
}

/** "Last turn 12m ago: produced 2 messages." Says what the turn left behind, not only that it happened. */
export function lastTurnText(last: TurnLike | undefined, now: number): string {
  if (!last) return "No turn in the loaded history.";
  const when = sinceText(now - Date.parse(last.endedAt || last.startedAt));
  const oc = outcomeOf(last);
  const what = oc === "shipped" || oc === "rejected" ? opsSummary(last) : OUTCOME_META[oc].label.toLowerCase();
  return `Last turn ${when}: ${what}.`;
}

/* -------------------------------- card text -------------------------------- */

export interface StateContext extends SeatSetting {
  /** The agent's running turn, if the history holds one. */
  running?: TurnLike;
  /** What it is doing this second ("Edit ledger-store.ts, running 6s"), from the live tool, or null when it has made no call. */
  doing: string | null;
  /** Its newest finished turn. */
  last?: TurnLike;
  now: number;
  /** The step history has arrived. Before it has, "no turn in the history" would be a claim about a list nobody has fetched. */
  loaded?: boolean;
}

export interface StateText {
  /** The state and, where it is known, how long it has lasted. */
  headline: string;
  /** What it is doing, or why it is in this state. */
  detail: string;
}

/**
 * What a seat that has never run is waiting for. Every card of a parked team said "Starting up. The seat is being set up." about
 * seats nobody would set up until the mission ran; the badge and the Graph said "starting" with it. The agent drawer says the same
 * sentence when the seat is not running.
 */
export function unstartedText(s: SeatSetting): StateText {
  if (s.over) return { headline: "Never ran", detail: "The mission ended before anything woke it." };
  if (s.parked) return { headline: "Ready", detail: `Waiting for the mission to ${s.started ? "continue" : "start"}.` };
  return { headline: "Starting up", detail: "The seat is being set up." };
}

/**
 * The two lines a card leads with. Every lifecycle the kernel reports has a branch: BLOCKED, COMPLETED and STARTING once fell
 * through to "idle", so the subtitle contradicted the badge beside it. "How long" is only said when the history knows it; an agent
 * with no turn in the loaded window says so, rather than a figure that would be a guess.
 */
export function stateText(a: AgentLike, c: StateContext): StateText {
  const l = String(a.lifecycle || "").toUpperCase();
  const since = (iso: string | undefined): string => (iso ? ` ${sinceText(c.now - Date.parse(iso))}` : "");
  const loading = c.loaded === false;
  if (RUNNING.has(l)) {
    const for_ = c.running ? ` for ${dur(Math.max(0, c.now - Date.parse(c.running.startedAt)))}` : "";
    return { headline: `Working${for_}`, detail: c.doing ?? (c.running ? "No tool call yet." : loading ? "Loading its turn." : "Its turn is not in the loaded history.") };
  }
  if (l === "FAILED") {
    return { headline: `Crashed${since(c.last?.endedAt ?? c.last?.startedAt)}`, detail: c.last?.error ? plainBlocker(c.last.error) : loading ? "Loading the reason." : "No error was recorded." };
  }
  if (l === "BLOCKED") {
    return { headline: `Blocked${since(c.last?.endedAt ?? c.last?.startedAt)}`, detail: c.last?.error ? plainBlocker(c.last.error) : loading ? "Loading the reason." : "It cannot continue until what blocks it is cleared." };
  }
  if (l === "SUSPENDED") return { headline: "Paused by you", detail: "It does not wake for mail until you unpause it." };
  if (l === "COMPLETED") return { headline: "Finished", detail: "Done with the mission, so there is nothing for it to run." };
  if (l === "STARTING") {
    const u = unstartedText(c);
    return c.parked && !c.over ? { ...u, detail: `${u.detail} Run one step wakes it for a single turn.` } : u;
  }
  if (l === "WAITING" && (a.mailbox ?? 0) > 0) {
    const n = a.mailbox ?? 0;
    return {
      headline: `${n} unread message${n === 1 ? "" : "s"}`,
      detail: c.parked ? "The project is parked, so nothing wakes it to read them." : "It reads them on its next wake.",
    };
  }
  return { headline: l === "WAITING" ? "Waiting for mail" : "Idle", detail: loading && !c.last ? "Loading its last turn." : lastTurnText(c.last, c.now) };
}

/** "31.0k tokens · 4 turns": the cheap totals, only the ones the roster carries. */
export function totalsText(a: AgentLike): string {
  const bits: string[] = [];
  if (typeof a.tokens === "number" && a.tokens > 0) bits.push(`${fmt(a.tokens)} tokens`);
  if (typeof a.activations === "number" && a.activations > 0) bits.push(`${a.activations} turn${a.activations === 1 ? "" : "s"}`);
  return bits.join(" · ");
}

/**
 * A memory note's key as the agent drawer's Memory tab shows it. After every turn the mesh files what the turn did under
 * `turn:<turn id>`: that key is an id, so it is shown short, the way the step drawer names a turn ("turn-3dc685"), with the whole
 * key in the tooltip. A key the seat chose ("decision:retries") is its name, and is shown as written.
 */
export function memoryKey(key: string): string {
  const m = /^turn:(turn-[A-Za-z0-9]+)$/.exec(key);
  return m ? `turn-${shortTurn(m[1])}` : key;
}

/* --------------------------------- controls --------------------------------- */

export type ControlId = "wake" | "suspend" | "resume";

export interface Control {
  id: ControlId;
  label: string;
  /** What pressing it does, in a sentence: the tooltip and the page's explanation. */
  title: string;
  /** Pressing it discards a turn in progress, so it asks first. */
  asks: boolean;
}

const WAKE: Control = {
  id: "wake", label: "Run one step", asks: false,
  title: "Wake this agent for one turn now. It does its work, then goes back to waiting; it is not left running.",
};
const RETRY: Control = { ...WAKE, label: "Retry one step", title: "Run one more turn for this agent. If it crashes again, open its last step for the failing call." };
const PAUSE: Control = {
  id: "suspend", label: "Pause", asks: false,
  title: "Keep this agent from waking for mail, nudges or Run one step until you unpause it.",
};
const PAUSE_MID_TURN: Control = {
  ...PAUSE, asks: true,
  title: "Stop the turn this agent is in (what it has spent so far is billed) and keep it asleep until you unpause it.",
};
const RESUME: Control = { id: "resume", label: "Unpause", asks: false, title: "Let this agent wake for mail and nudges again." };

/**
 * The controls worth offering an agent in this state, and only those. A button that the kernel will refuse (waking an agent that
 * finished with the mission, or one that is paused) is not shown, because a disabled button cannot say why. Pausing an agent that is
 * mid-turn stops that turn, so that one asks first.
 */
export function controlsOf(lifecycle: string): Control[] {
  const l = String(lifecycle || "").toUpperCase();
  if (RUNNING.has(l)) return [PAUSE_MID_TURN];
  if (l === "SUSPENDED") return [RESUME];
  if (l === "COMPLETED") return [];
  if (l === "FAILED") return [RETRY, PAUSE];
  return [WAKE, PAUSE];
}

/** One sentence under a card's or a drawer's buttons that says what they do to an agent in this state. */
export function controlsHint(lifecycle: string, stalled = false): string {
  const l = String(lifecycle || "").toUpperCase();
  if (RUNNING.has(l)) {
    return stalled
      ? "It has gone quiet. Pause stops this turn, then Unpause lets it start fresh."
      : "Pause stops the turn it is in and keeps it asleep until you unpause it.";
  }
  if (l === "SUSPENDED") return "Unpause lets it wake for mail and nudges again.";
  if (l === "COMPLETED") return "It finished with the mission, so there is nothing to run.";
  if (l === "FAILED") return "Retry runs one more turn. Pause keeps it asleep instead.";
  if (l === "BLOCKED") return "It cannot continue until what blocks it clears. Run one step tries anyway and shows the server's answer.";
  return "Run one step wakes it for a single turn, then it goes back to waiting. Pause keeps it from waking for mail.";
}

/** What asking before a pause says. */
export function pauseWarning(id: string): { title: string; body: string[]; confirmLabel: string } {
  return {
    title: `Pause ${id}?`,
    body: [
      "It is in a turn. Pausing stops that turn, and what it has spent so far is billed.",
      `${id} will not wake for mail, nudges or Run one step until you unpause it.`,
    ],
    confirmLabel: "Pause agent",
  };
}

/* ---------------------------------- answers ---------------------------------- */

export interface ActionNote {
  title: string;
  text: string;
  kind: "ok" | "warn" | "bad";
}

const sentence = (s: string): string => {
  const t = s.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
};

/**
 * What the toast says after a control. The server's own reason is kept word for word when it refuses, and a success says what
 * now holds: a wake runs one turn and lets go; a pause that stopped a turn says so; a request that never got an answer says it is
 * not known whether it took effect, which is the truth, rather than "failed" or "ok".
 */
export function actionNote(act: string, id: string, status: number | null, json: { reason?: unknown; stoppedTurnId?: unknown } | null): ActionNote {
  if (status === null) {
    return { title: `${act === "wake" ? "Run one step" : act === "suspend" ? "Pause" : "Unpause"}: no answer`, text: `${id}: the server did not answer, so it is not known whether this took effect.`, kind: "bad" };
  }
  const reason = typeof json?.reason === "string" && json.reason.trim() ? sentence(json.reason) : "";
  if (act === "wake") {
    return status === 200
      ? { title: "Running one step", text: `${id} is in one turn now and goes back to waiting when it ends. Follow it under Steps.`, kind: "ok" }
      : { title: "Not started", text: `${id} did not start a turn. ${reason || "The server refused it."}`, kind: "warn" };
  }
  if (act === "suspend") {
    if (status !== 200) return { title: "Not paused", text: `${id} was not paused. ${reason || "The server refused it."}`, kind: "warn" };
    return {
      title: "Paused",
      text: json?.stoppedTurnId
        ? `${id} was in a turn, which is stopped. It will not wake for mail, nudges or Run one step until you unpause it.`
        : `${id} will not wake for mail, nudges or Run one step until you unpause it.`,
      kind: "ok",
    };
  }
  return status === 200
    ? { title: "Unpaused", text: `${id} wakes for mail and nudges again.`, kind: "ok" }
    : { title: "Not unpaused", text: `${id} was not unpaused. ${reason || "The server refused it."}`, kind: "warn" };
}
