/**
 * What state the mission is in, and the one thing to do about it.
 *
 * The console used to answer that in three places from three readings of `/status`: the top bar said PARKED beside a goal
 * that read "done", the Overview stacked a "Parked. Continue" strip over a "Goal met" strip, and a letter key paused a
 * mission without asking. A state that reads two ways is a state the operator has to work out for themselves. This is the
 * one reading. The top bar, the Overview and the window title all take it from here, so they cannot disagree.
 *
 * DOM-free and React-free so tests/dashboard can pin the precedence, which is the part that carries the claim.
 */
import { RUNNING } from "./format";
import { holdsOf } from "./escalation-card";
import { goalIsSet, startNeedsGoal } from "./goal";
import type { View } from "./route";

export type MissionPhase =
  | "loading"
  | "offline"
  | "down"
  | "ceiling"
  | "needs-you"
  | "failed"
  | "done"
  | "paused"
  | "parked"
  | "stalled"
  | "quiet"
  | "running";

export type MissionTone = "ok" | "warn" | "bad" | "neutral";

/** The things a person can do to a mission from the bar or the Overview. The caller maps each to a handler. */
export type MissionAction = "start" | "pause" | "resume" | "reopen" | "review" | "settings" | "agents" | "designer";

export interface MissionControl {
  action: MissionAction;
  label: string;
  /** The tooltip: what the click does, including what it costs. */
  hint: string;
}

/**
 * Where a person looks at what a finished mission made and spent. Not things done to the mission, so they are not
 * `MissionAction`s: the bar and `useMissionActions` never see them, and the Overview, which is where they are offered, runs them.
 */
export type ResultAction = "files" | "cost" | "replay";
export type HeroAction = MissionAction | ResultAction;

/**
 * One thing the hero offers, and how loud. The hero draws at most two that are not `quiet`: a result is read, or it is sent back,
 * and everything else a person might do next sits quietly beside them.
 */
export interface NextStep {
  action: HeroAction;
  label: string;
  hint: string;
  look: "primary" | "soft" | "quiet";
}

export interface MissionFacts {
  hasStatus: boolean;
  serverDown: boolean;
  /**
   * The project's own state when its process is not running: crashed, locked, cannot open, closed. Null for an open or booting
   * project. Any status the console holds for it is from before, so this outranks the mission.
   */
  projectDown: { label: string; hint: string; severe: boolean } | null;
  /** CREATED, ACTIVE, PAUSED, BLOCKED, CONVERGING, COMPLETED, FAILED or ESCALATED; empty when there is no goal. */
  goalStatus: string;
  /** The process is parked: it answers questions and runs nothing on its own. */
  parked: boolean;
  /** Open decisions that are not notices. Each holds the whole mission or, for a seat's own budget card, one seat. */
  blockingDecisions: number;
  /** Of those, the seat each single-seat card holds (one entry per card): the rest of the mesh keeps working. */
  seatHeldDecisions: string[];
  /** Open decisions that are notices: the mission carries on whether or not anyone answers them. */
  advisoryDecisions: number;
  /** The host parked every project because aggregate spend crossed its ceiling. */
  hostCeilingTripped: boolean;
  /** Agents in the middle of a turn. */
  working: number;
  /** Agents waiting for something to do. */
  waiting: number;
  runningSteps: number;
  /** Anything has happened in this project before. Decides "Start" against "Continue". */
  hasHistory: boolean;
  /** How many seats boot was told to start; null when the server predates the field. */
  startupSeats: number | null;
  /** The mission's goal is one a person wrote and not the scaffold's placeholder. Absent reads as written: no fact, no nag. */
  goalWritten?: boolean;
}

export interface MissionState {
  phase: MissionPhase;
  tone: MissionTone;
  /** One or two words for a chip. */
  label: string;
  /** What is true, as a sentence. */
  headline: string;
  /** The one thing to do about it, or null when there is nothing to do. */
  primary: MissionControl | null;
  /** Everything else the operator may want, for an overflow menu, in order. */
  secondary: MissionControl[];
  /**
   * What the Overview's hero offers next, in the order it draws them. It is `primary` for every state with one, so the bar and the
   * hero cannot disagree; a delivered mission, which has nothing for the bar to press, offers what people do with a result: read it,
   * send it back with feedback, see what it cost, replay it.
   */
  next: NextStep[];
  /** The process is parked. Reported separately because a finished mission can be parked, and that is not a problem. */
  parked: boolean;
  /** The one phase that moves: a mission with agents mid-turn. */
  pulse: boolean;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
/** "a", "a and b", "a, b and c". */
const listOf = (items: string[]): string => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

const PAUSE: MissionControl = { action: "pause", label: "Pause", hint: "Pause the mission: agents stop, nothing is lost" };
const REOPEN: MissionControl = {
  action: "reopen",
  label: "Reopen with feedback",
  hint: "Say what was wrong: the agents go back to work with your feedback as their brief. Nothing is deleted.",
};

/** What a person does with a delivered mission. The first is how they find out whether it is right; the second is what they do when it is not. */
const DELIVERED_NEXT: NextStep[] = [
  { action: "files", label: "Open the files", hint: "Read what the team made: each file, its versions and what changed", look: "primary" },
  { ...REOPEN, look: "soft" },
  { action: "cost", label: "What it cost", hint: "Spend by agent and by budget, in tokens and dollars", look: "quiet" },
  { action: "replay", label: "Replay", hint: "Rebuild the mission from its event log, with no model calls", look: "quiet" },
];

/** The reading of one `/status` payload (plus what only the console knows) that `describeMission` works from. */
export function factsFromStatus(
  status: any,
  extra: { serverDown?: boolean; projectDown?: MissionFacts["projectDown"]; hostCeilingTripped?: boolean; runningSteps?: number; hasHistory?: boolean } = {},
): MissionFacts {
  const agents: any[] = (status?.agents ?? []).filter((a: any) => a.id !== "human");
  const decisions: any[] = status?.openEscalations ?? [];
  const blocking = decisions.filter((e) => e?.advisory !== true);
  return {
    hasStatus: Boolean(status),
    serverDown: extra.serverDown === true,
    projectDown: extra.projectDown ?? null,
    goalStatus: String(status?.goal?.status ?? ""),
    parked: Boolean(status?.uiOnly) || status?.mode === "parked",
    blockingDecisions: blocking.length,
    seatHeldDecisions: blocking.flatMap((e) => {
      const held = holdsOf(e);
      return held.scope === "seat" ? [held.seat] : [];
    }),
    advisoryDecisions: decisions.filter((e) => e?.advisory === true).length,
    hostCeilingTripped: extra.hostCeilingTripped === true,
    working: agents.filter((a) => RUNNING.has(a.lifecycle)).length,
    waiting: agents.filter((a) => a.lifecycle === "WAITING").length,
    runningSteps: extra.runningSteps ?? 0,
    hasHistory: extra.hasHistory === true,
    startupSeats: typeof status?.startupActivateCount === "number" ? status.startupActivateCount : null,
    goalWritten: goalIsSet(status?.goal?.description),
  };
}

/**
 * The precedence is the point. The first rule that holds wins:
 *
 * 1. The server is not answering: everything below is the last known state, so say that and nothing else.
 * 2. The host answers but the project's own process does not (crashed, locked, closed): what the console holds about its mission
 *    is from before it stopped.
 * 3. No status yet, or a status with no goal (a project still starting): there is nothing to say about a mission, and no control.
 * 4. The host's spend ceiling parked the project: Continue cannot fix it (the host re-parks on the next heartbeat), so the
 *    one action is to raise the ceiling.
 * 5. A decision holds the mission, or the goal is ESCALATED: the operator is the blocker. A decision that holds only one seat
 *    is still a call on the operator, but says what it holds and does not claim the mission has stopped.
 * 6. The goal is over (failed, delivered): a parked process is irrelevant to a finished mission, so "parked" never
 *    outranks "delivered".
 * 7. Paused, then parked: two ways of not running, and the action for each is different. A mission that has never run on a goal nobody
 *    wrote is not offered Start: the goal is the first thing to do.
 * 8. Running: nobody working and nobody waiting is a fault worth naming; waiting without working is quiet; otherwise it is
 *    simply running.
 *
 * Open decisions that are only notices do not change the phase: they hold nothing, and they are counted by the caller.
 */
export function describeMission(f: MissionFacts): MissionState {
  const s = describePhase(f);
  const step = (c: MissionControl): NextStep => ({ ...c, look: c.action === "pause" ? "soft" : "primary" });
  return { ...s, next: s.next ?? (s.primary ? [step(s.primary)] : []) };
}

function describePhase(f: MissionFacts): Omit<MissionState, "next"> & { next?: NextStep[] } {
  const base = { secondary: [] as MissionControl[], parked: f.parked, pulse: false };
  if (f.serverDown) {
    return f.hasStatus
      ? { ...base, phase: "offline", tone: "bad", label: "Offline", primary: null, headline: "The server is not answering. This is the last state it reported, and it may be stale." }
      : { ...base, phase: "offline", tone: "bad", label: "Offline", primary: null, headline: "The server is not answering." };
  }
  if (f.projectDown) {
    // The host answers; the project's own process does not. Whatever status the console holds is from before it stopped.
    const word = f.projectDown.label.charAt(0).toUpperCase() + f.projectDown.label.slice(1);
    return { ...base, phase: "down", tone: f.projectDown.severe ? "bad" : "neutral", label: word, primary: null, headline: f.projectDown.hint };
  }
  if (!f.hasStatus) {
    return { ...base, phase: "loading", tone: "neutral", label: "Connecting", headline: "Connecting to the mission.", primary: null };
  }
  if (!f.goalStatus) {
    // A mesh must declare a goal (mesh.yaml requires one), so a status without one is a child that has answered before it
    // finished reading its log. It is a project still starting, and "this mesh has no goal" would be false.
    return {
      ...base, phase: "loading", tone: "neutral", label: "Starting", primary: null,
      headline: "The project is starting. The mission appears once its log has been read.",
    };
  }
  if (f.parked && f.hostCeilingTripped && f.goalStatus !== "COMPLETED" && f.goalStatus !== "FAILED") {
    return {
      ...base, phase: "ceiling", tone: "bad", label: "Spend ceiling",
      headline: "The host reached its spend ceiling, so this project is parked.",
      primary: { action: "settings", label: "Raise the ceiling", hint: "The ceiling is host-wide: raise it in Host settings and it applies on the next heartbeat" },
    };
  }
  const holdsMission = f.blockingDecisions - f.seatHeldDecisions.length;
  const over = f.goalStatus === "COMPLETED" || f.goalStatus === "FAILED";
  if (f.goalStatus === "ESCALATED" || (holdsMission > 0 && !over)) {
    const n = Math.max(f.blockingDecisions, 1);
    // All of them hold the mission: it is paused until they are answered. Some hold only a seat: the mission is paused
    // until the ones that hold it are, and saying "until they are answered" would overstate what the seat cards do. An
    // ESCALATED goal is halted whatever the cards say (the list may lag the goal), so it keeps the plain wording.
    const until = f.seatHeldDecisions.length === 0 || holdsMission <= 0
      ? `${n === 1 ? "it is" : "they are"} answered`
      : `the ${holdsMission === 1 ? "one that holds it is" : `${holdsMission} that hold it are`} answered`;
    return {
      ...base, phase: "needs-you", tone: "bad", label: "Needs you",
      headline: `${plural(n, "decision")} waiting on you. The mission is paused until ${until}.`,
      primary: { action: "review", label: "Review decisions", hint: "Open the inbox: the mission stays paused until each decision that holds it is answered" },
    };
  }
  if (f.seatHeldDecisions.length > 0 && !over) {
    // A seat's own budget card parks that seat and nothing else, so the mission is not paused: the person is needed, and
    // the headline says what is held instead of claiming a halt.
    const n = f.seatHeldDecisions.length;
    const seats = [...new Set(f.seatHeldDecisions)];
    return {
      ...base, phase: "needs-you", tone: "warn", label: "Needs you",
      headline: `${plural(n, "decision")} waiting on you. ${n === 1 ? "It holds" : "They hold"} ${listOf(seats)} only, and the rest of the mesh keeps working.`,
      primary: { action: "review", label: "Review decisions", hint: "Open the inbox: the mission keeps running without these seats until each decision is answered" },
    };
  }
  if (f.goalStatus === "FAILED") {
    return {
      ...base, phase: "failed", tone: "bad", label: "Failed", headline: "The mission failed.",
      primary: { action: "reopen", label: "Reopen", hint: "Withdraw the verdict and put the agents back to work. Nothing is deleted." },
    };
  }
  if (f.goalStatus === "COMPLETED") {
    return {
      ...base, phase: "done", tone: "ok", label: "Delivered", primary: null,
      headline: "Delivered. Every mandatory check is evidenced.",
      secondary: [REOPEN],
      next: DELIVERED_NEXT,
    };
  }
  if (f.goalStatus === "PAUSED") {
    return {
      ...base, phase: "paused", tone: "warn", label: "Paused", headline: "Paused. Nothing is running.",
      primary: { action: "resume", label: "Resume", hint: "Wake the agents and carry on against the mission budget" },
    };
  }
  if (f.parked && startNeedsGoal(f)) {
    // A mission started on the scaffold's placeholder spends on a goal that says nothing, and every agent reads it on every turn.
    return {
      ...base, phase: "parked", tone: "warn", label: "Parked",
      headline: "The goal is not written yet. Say what the team should deliver, then start the mission.",
      primary: { action: "designer", label: "Write the goal first", hint: "Open the Designer on the goal: every agent reads it on every turn, so the mission needs one before it starts" },
    };
  }
  if (f.parked) {
    return {
      ...base, phase: "parked", tone: "warn", label: "Parked",
      headline: f.hasHistory
        ? "Parked. Progress is loaded and nothing runs until you continue."
        : "Parked. Nothing runs on its own until you start the mission.",
      primary: {
        action: "start",
        label: f.hasHistory ? "Continue" : "Start mission",
        hint: "Start the scheduler: agents run until you pause or park the mission again",
      },
    };
  }
  if (f.working === 0 && f.runningSteps === 0) {
    if (f.waiting === 0) {
      return {
        ...base, phase: "stalled", tone: "warn", label: "Idle",
        headline: "Live, but no agent is working.",
        primary: f.startupSeats === 0
          ? { action: "designer", label: "Set startup agents", hint: "No seat starts on its own: choose which agents begin in the designer" }
          : { action: "agents", label: "Wake an agent", hint: "Open Agents and wake one to get going" },
        secondary: [PAUSE],
      };
    }
    return {
      ...base, phase: "quiet", tone: "neutral", label: "Running",
      headline: `Running. ${plural(f.waiting, "agent")} waiting, none working right now.`,
      primary: PAUSE,
    };
  }
  return {
    ...base, phase: "running", tone: "ok", label: "Running", pulse: true,
    headline: f.working > 0 ? `${plural(f.working, "agent")} working.` : "A turn is in flight.",
    primary: PAUSE,
  };
}

/**
 * Whether a bar button goes to the page the person is already on. "Review decisions" on the Needs you page was a button that took
 * them where they were, and on a phone it cost a row of the header above the very card they came to answer. The bar's buttons that
 * only navigate stand down on the page they point at; the ones that act on the mission never do.
 */
export function barActionIsHere(action: MissionAction, view: View, inboxView: View): boolean {
  switch (action) {
    case "review": return view === inboxView;
    case "settings": return view === "hostsettings";
    case "agents": return view === "agents";
    case "designer": return view === "designer";
    default: return false;
  }
}

/**
 * The browser tab's title. A mission waiting on you is the one thing worth a glance at a background tab, so the count leads
 * and the tab says what is true of the mission, not only what the product is called.
 */
export function documentTitle(opts: { phaseLabel: string | null; decisions: number; project: string | null }): string {
  const lead = opts.decisions > 0 ? `(${opts.decisions}) ` : "";
  const bits = [opts.phaseLabel, opts.project].filter((s): s is string => Boolean(s));
  return `${lead}${bits.length ? `${bits.join(" · ")} — ` : ""}Curule`;
}
