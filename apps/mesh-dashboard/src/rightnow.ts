/**
 * What is happening in a running mission this minute, in a few plain lines, from facts the console already holds.
 *
 * Someone who comes back to a mission that runs for an hour used to read "Running. 1 agent waiting, none working right now." and,
 * under it, "Agents wake when something they care about happens. If nothing is coming, wake one or send a message." That is true
 * and says nothing about this mission: who is in a turn and for how long, what is next, whether anything is asked of them, and,
 * when nothing is happening, why not. The answers are in `/status` (the agents' lifecycles, the turns in flight, the scheduler's
 * queue, the count of requests nobody has answered) and in what the Overview already counts for the person.
 *
 * Three rules. Each line is a fact at this moment and not a diagnosis: nothing here says an agent is stuck, because a quiet
 * second looks the same as a stuck one. No ids and no codes: an agent is named by its seat, a time is a minute count. And at most
 * three short lines, the last one always the answer to "does it need me".
 *
 * That answer has two parts, because the console has two places that ask something of a person: the Overview's attention list, and
 * the Agents page's "Needs you", where a crashed seat (it does not start again by itself) or a blocked one waits. A mission with a
 * crashed seat used to read "Nothing is waiting for you." here while the Agents page said the opposite, so the seats are said too.
 * A turn that has gone silent is on the Agents page only: whether a turn is silent is read from timing that page refreshes every
 * few seconds, and this one is read when events arrive, so a quiet minute here would be a guess.
 *
 * What it cannot say is who waits for whom. The kernel knows each open request's sender and recipient, but `/status` carries only
 * how many there are (`commitments.open`), and an agent's own panel is the only place its requests are listed, so a line like
 * "pm waits for security's review" would be a guess the console has no way to check. DOM-free, so tests/dashboard can pin each case.
 */
import { RUNNING } from "./format";
import type { MissionPhase } from "./mission";

export interface RightNowInput {
  phase: MissionPhase;
  /** The clock, in ms: the lines say how long a turn has been going. */
  now: number;
  /** The seats, the human excluded. */
  agents: ReadonlyArray<{ id: string; lifecycle: string; mailbox?: number }>;
  /** Turns, from `/status` and `/steps` alike: only those still running are read. */
  turns: ReadonlyArray<{ agentId: string; startedAt?: string; status?: string }>;
  /** The scheduler's queue, in order: seats that are woken and waiting for their turn to start. */
  queued: readonly string[];
  /** Requests asked and not yet answered, or null when the server does not say. */
  openRequests: number | null;
  /** What waits for the person that is not already the headline: the Overview's attention items that need a look, and notices. */
  forYou: number;
}

/** How many seats a line names before it counts the rest. */
const NAMED = 3;

/** "a", "a and b", "a, b and c". */
const list = (items: readonly string[]): string => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);
const are = (n: number): string => (n === 1 ? "is" : "are");

/** A span as a person says it at a glance: a minute count, not a stopwatch. */
export function spanWord(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return "less than a minute";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
}

/** The seats in a turn, longest first, each with how long it has been going when the console knows when it began. */
function inTurn(i: RightNowInput): Array<{ id: string; ms: number | null }> {
  const began = new Map<string, number>();
  for (const t of i.turns) {
    const at = Date.parse(String(t.startedAt ?? ""));
    if (t.status !== "running" || !Number.isFinite(at)) continue;
    began.set(t.agentId, Math.min(at, began.get(t.agentId) ?? at));
  }
  const ids = new Set(i.agents.filter((a) => RUNNING.has(String(a.lifecycle).toUpperCase())).map((a) => a.id));
  // A turn in flight is a seat in a turn even when the roster has not caught up with it.
  for (const t of i.turns) if (t.status === "running") ids.add(t.agentId);
  return [...ids]
    .map((id) => ({ id, ms: began.has(id) ? Math.max(0, i.now - began.get(id)!) : null }))
    .sort((a, b) => (b.ms ?? -1) - (a.ms ?? -1) || a.id.localeCompare(b.id));
}

function workingLine(turns: Array<{ id: string; ms: number | null }>): string {
  const one = (t: { id: string; ms: number | null }): string => (t.ms === null ? t.id : `${t.id} (${spanWord(t.ms)})`);
  if (turns.length === 1) {
    const t = turns[0]!;
    return t.ms === null ? `${t.id} is working.` : `${t.id} has been working for ${spanWord(t.ms)}.`;
  }
  if (turns.length === 2) return `${one(turns[0]!)} and ${one(turns[1]!)} are working.`;
  const first = turns[0]!;
  return `${turns.length} agents are working.${first.ms === null ? "" : ` The longest, ${first.id}, has been going for ${spanWord(first.ms)}.`}`;
}

/** Seats named up to `NAMED`, then counted: "pm, qa and security", "4 agents". */
const some = (ids: readonly string[]): string => (ids.length <= NAMED ? list(ids) : `${ids.length} agents`);

const asked = (n: number): string => `${n} ${n === 1 ? "request is" : "requests are"} waiting for an answer.`;

const lifecycleOf = (a: { lifecycle: string }): string => String(a.lifecycle).toUpperCase();

/** "qa has crashed and security is blocked: see Agents." Counted past `NAMED`, as everywhere in these lines. */
function trouble(crashed: readonly string[], blocked: readonly string[]): string {
  const n = crashed.length + blocked.length;
  if (n === 0) return "";
  if (n > NAMED) return `${n} agents have crashed or are blocked: see Agents.`;
  const parts = [
    ...(crashed.length ? [`${list(crashed)} ${crashed.length === 1 ? "has" : "have"} crashed`] : []),
    ...(blocked.length ? [`${list(blocked)} ${are(blocked.length)} blocked`] : []),
  ];
  return `${parts.join(" and ")}: see Agents.`;
}

/** The last line: what waits for the person, from the attention list and from the seats, or that nothing does. */
function forYouLine(forYou: number, crashed: readonly string[], blocked: readonly string[]): string {
  const attention = forYou > 0 ? `${forYou} ${forYou === 1 ? "item" : "items"} under Attention ${forYou === 1 ? "needs" : "need"} a look.` : "";
  return [attention, trouble(crashed, blocked)].filter(Boolean).join(" ") || "Nothing is waiting for you.";
}

/** What a line is about, so the page can mark it: a seat in a turn, who is next, who waits, requests open, nobody, and the person. */
export type RightNowKind = "working" | "queue" | "waiting" | "asked" | "idle" | "you";

export interface RightNowRow {
  text: string;
  kind: RightNowKind;
  /** The seat the line is about when one stands out: the one that has been in its turn the longest. */
  seat?: string;
  /** The last line only: something is waiting for the person, so the page marks it. */
  look?: boolean;
}

/**
 * The lines to show, or none, each with what it is about. Only a mission that is live and moving or resting between turns has a
 * "right now": a paused, parked, delivered or halted one is already said by its headline, and an idle one by what explains it
 * (`idleCause`).
 */
export function rightNowRows(i: RightNowInput): RightNowRow[] {
  if (i.phase !== "running" && i.phase !== "quiet") return [];
  const turns = inTurn(i);
  const waiting = i.agents.filter((a) => String(a.lifecycle).toUpperCase() === "WAITING" && !turns.some((t) => t.id === a.id)).map((a) => a.id);
  const queued = [...new Set(i.queued)].filter((id) => !turns.some((t) => t.id === id));
  const unanswered = i.openRequests !== null && i.openRequests > 0 ? asked(i.openRequests) : "";
  const rows: RightNowRow[] = [];

  if (turns.length > 0) {
    rows.push({ text: workingLine(turns), kind: "working", seat: turns[0]!.id });
    const rest = queued.length
      ? `Next in line: ${some(queued)}.`
      : waiting.length
        ? `${some(waiting)} ${are(waiting.length)} waiting for mail.`
        : "";
    const second = [rest, unanswered].filter(Boolean).join(" ");
    if (second) rows.push({ text: second, kind: queued.length ? "queue" : waiting.length ? "waiting" : "asked" });
  } else {
    // Nobody is in a turn. A seat that is queued is about to be; otherwise nothing will happen until something does, and that is the
    // one thing worth saying plainly, with the two things a person can do about it.
    const everyone = waiting.length > 0 && waiting.length === i.agents.filter((a) => lifecycleOf(a) !== "COMPLETED").length;
    if (queued.length) rows.push({ text: `Nobody is working this moment. Next in line: ${some(queued)}.`, kind: "queue" });
    else if (waiting.length) {
      rows.push({ text: `${everyone ? "Everyone is waiting for mail" : `${some(waiting)} ${are(waiting.length)} waiting for mail`}: nothing is queued. If it stays that way, send a message or wake an agent.`, kind: "waiting" });
    } else rows.push({ text: "Nobody is working and nothing is queued. If it stays that way, send a message or wake an agent.", kind: "idle" });
    if (unanswered) rows.push({ text: unanswered, kind: "asked" });
  }

  const crashed = i.agents.filter((a) => lifecycleOf(a) === "FAILED").map((a) => a.id);
  const blocked = i.agents.filter((a) => lifecycleOf(a) === "BLOCKED").map((a) => a.id);
  rows.push({ text: forYouLine(i.forYou, crashed, blocked), kind: "you", look: i.forYou > 0 || crashed.length + blocked.length > 0 });
  return rows;
}

/** The lines alone: `rightNowRows` without what each is about. */
export const rightNow = (i: RightNowInput): string[] => rightNowRows(i).map((r) => r.text);

/**
 * The input, read off a `/status` payload. Everything is optional because a server predates some of it, and a missing figure is
 * never read as zero: `openRequests` stays null when the server does not say how many requests are open.
 */
export function rightNowInput(status: any, extra: { phase: MissionPhase; now: number; forYou: number; steps?: ReadonlyArray<{ turnId?: string; agentId: string; startedAt?: string; status?: string }> }): RightNowInput {
  const queue: any[] = Array.isArray(status?.scheduler?.queue) ? status.scheduler.queue : [];
  const open = status?.commitments?.open;
  // The status is read with every event and carries the ten latest turns; the steps are read every few seconds. A step that says
  // "running" for a turn the status says is over is the older reading, so where both name a turn the status is the one believed. A
  // step the status does not know is a turn that began since, and it counts.
  const fresh = ((status?.recentTurns ?? []) as any[]).filter((t) => t?.agentId);
  const known = new Set(fresh.map((t) => t.turnId).filter(Boolean));
  const older = (extra.steps ?? []).filter((t) => !t.turnId || !known.has(t.turnId));
  return {
    phase: extra.phase,
    now: extra.now,
    agents: ((status?.agents ?? []) as any[]).filter((a) => a?.id && a.id !== "human").map((a) => ({ id: String(a.id), lifecycle: String(a.lifecycle ?? ""), mailbox: typeof a.mailbox === "number" ? a.mailbox : undefined })),
    turns: [...fresh, ...older].filter((t) => t?.agentId).map((t) => ({ agentId: String(t.agentId), startedAt: t.startedAt, status: t.status })),
    queued: queue.map((q) => String(q?.agentId ?? "")).filter(Boolean),
    openRequests: typeof open === "number" ? open : null,
    forYou: extra.forYou,
  };
}
