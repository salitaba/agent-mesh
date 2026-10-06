/**
 * The live feed, as a model: is it live, how stale is it, and what does holding it still hide.
 *
 * Events and Steps are the pages an operator leaves open while a mission runs, and both used to say "live" unconditionally. The
 * word stayed on screen while the stream was down, and "pause" threw events away: the store dropped them as they arrived, so
 * resuming showed a list with a hole in it. Two decisions are made here, in plain functions, so that the tests can pin them:
 *
 * 1. What the connection looks like (`feedState`). The server being unreachable outranks a dropped stream, which outranks a
 *    stream that is open but silent, and only an open, recent connection is called live.
 * 2. What a hold hides (`heldList`). Pausing, scrolling away, pointing at the list or focusing a row each freeze the rows that are
 *    on screen so they stop moving under the pointer. Nothing is discarded: what arrives meanwhile is counted ("3 new events")
 *    and shown the moment the hold ends.
 *
 * DOM-free on purpose (no React, no window), so `tests/dashboard/feed.test.ts` can run it under node:test.
 */

export type FeedTone = "ok" | "warn" | "bad" | "neutral";

export type StreamState = "connecting" | "open" | "reconnecting";

export interface FeedInput {
  /** The live stream's own state (`useMesh().sseState`). */
  sse: StreamState;
  /** The server stopped answering liveness probes (`useMesh().serverDown`). */
  serverDown: boolean;
  /** When the console last heard from the server: a status poll, an event, a steps refresh. */
  heardAt: number;
  now: number;
}

export interface FeedState {
  tone: FeedTone;
  /** One or two words for the chip. */
  label: string;
  /** What is true, as a short sentence fragment: how old the picture is, or what the console is doing about it. */
  detail: string;
  /** Rows on screen are arriving as the mesh produces them. */
  live: boolean;
  /** What is on screen may be older than it looks. */
  stale: boolean;
}

/**
 * The console polls `/status` every four seconds, so a quiet but healthy connection is never more than a few seconds old.
 * Thirty seconds without any word is long enough to say so rather than keep claiming "live".
 */
export const STALE_AFTER_MS = 30_000;

/** "just now", "4s ago", "2m ago", "3h ago". Floors, so "59s ago" is never printed as "60s ago". */
export function sinceText(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

/**
 * The precedence is the point. The first rule that holds wins:
 *
 * 1. The server is not answering: everything on screen is the last thing it said.
 * 2. The stream dropped: the console is reconnecting, and rows stop arriving until it is back.
 * 3. The stream has not connected yet.
 * 4. The stream is open but nothing has been heard for `STALE_AFTER_MS`: say so instead of "live".
 * 5. Live.
 */
export function feedState(i: FeedInput): FeedState {
  const age = Math.max(0, i.now - i.heardAt);
  const since = sinceText(age);
  if (i.serverDown) {
    return { tone: "bad", label: "Server not answering", detail: `Last update ${since}. What you see may be out of date.`, live: false, stale: true };
  }
  if (i.sse === "reconnecting") {
    return { tone: "warn", label: "Reconnecting", detail: `Live updates stopped. Last update ${since}.`, live: false, stale: true };
  }
  if (i.sse === "connecting") {
    return { tone: "neutral", label: "Connecting", detail: "Waiting for the live stream.", live: false, stale: false };
  }
  if (age > STALE_AFTER_MS) {
    return { tone: "warn", label: "Not updating", detail: `Last update ${since}.`, live: false, stale: true };
  }
  return { tone: "ok", label: "Live", detail: `Updated ${since}`, live: true, stale: false };
}

/* ------------------------------------------------------------------------------------------------------------------ *
 * Holding a list still
 * ------------------------------------------------------------------------------------------------------------------ */

/** Why the list is being held. Any one is enough. */
export interface HoldReasons {
  /** The reader pressed Pause. */
  paused: boolean;
  /** The list is scrolled away from its newest end. */
  scrolled: boolean;
  /** The pointer is over the list: rows must not move under it. */
  pointer: boolean;
  /** Focus is on a row: the same, for the keyboard. */
  focus: boolean;
}

export const NOT_HELD: HoldReasons = { paused: false, scrolled: false, pointer: false, focus: false };

export const isHolding = (h: HoldReasons): boolean => h.paused || h.scrolled || h.pointer || h.focus;

/**
 * What the hold remembers: the newest key on screen when it began, or null when nothing is held. Called once per render with
 * the current reasons; a hold that is already running keeps its original mark, so rows arriving during it never move it.
 *
 * An empty list is never held. A mouse left resting over the page while it loads counts as pointing at the list, and a mark taken
 * then would be "nothing", so every row that arrived first was counted as new and the list stayed blank behind a "17 new turns"
 * bar. With no rows there is nothing for a hold to keep still; it begins when the first rows are on screen.
 */
export function holdMark(prev: number | null, holding: boolean, newest: number): number | null {
  if (!holding || newest <= 0) return null;
  return prev ?? newest;
}

/**
 * The rows to draw. Held, only rows at or before the mark are drawn, and everything newer is counted instead. A row that was
 * already on screen still shows its latest data (a running turn that finishes during the hold turns green in place); only the
 * set of rows is frozen.
 *
 * Returns the same array when nothing is held, so a caller's memoisation is not defeated.
 */
export function heldList<T>(items: readonly T[], keyOf: (item: T) => number, mark: number | null): { shown: readonly T[]; fresh: number } {
  if (mark === null) return { shown: items, fresh: 0 };
  const shown: T[] = [];
  let fresh = 0;
  for (const item of items) {
    if (keyOf(item) <= mark) shown.push(item);
    else fresh++;
  }
  return { shown, fresh };
}

/** The newest key in a list, or 0 for an empty one. */
export function newestKey<T>(items: readonly T[], keyOf: (item: T) => number): number {
  let top = 0;
  for (const item of items) top = Math.max(top, keyOf(item));
  return top;
}

/** "3 new events", "1 new turn". */
export function newCountText(n: number, noun: "event" | "turn"): string {
  return `${n.toLocaleString("en-US")} new ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * The control that holds the list still. It read "Pause", a few centimetres from the mission's own Pause, and only its tooltip said
 * it stops the rows and not the agents. Its words name what it pauses now, and the tooltip says what it does not.
 */
export function pauseControl(paused: boolean, noun: "events" | "turns"): { label: string; title: string } {
  return paused
    ? { label: "Resume updates", title: `Show ${noun} as they arrive again` }
    : { label: "Pause updates", title: `Freeze the list so rows stop moving. This does not pause the mission: new ${noun} keep arriving and are counted, not lost.` };
}

/**
 * What a held list says above its rows, or null when nothing is held and nothing has arrived. Paused by the control, it says so and
 * what is waiting, and its button resumes; held only by pointing or scrolling, it owes the count and a way to the newest rows.
 */
export function holdText(paused: boolean, fresh: number, noun: "event" | "turn"): { lead: string | null; text: string; button: string } | null {
  if (!paused && fresh === 0) return null;
  if (!paused) return { lead: null, text: `${newCountText(fresh, noun)}.`, button: "Show" };
  return { lead: "Updates paused.", text: fresh > 0 ? `${newCountText(fresh, noun)} waiting.` : "Nothing new yet.", button: "Resume updates" };
}

/* ------------------------------------------------------------------------------------------------------------------ *
 * Time buckets: both pages group a newest-first list by how long ago, so the gap between "moving now" and "an hour ago" shows.
 * ------------------------------------------------------------------------------------------------------------------ */

export interface Bucket {
  id: string;
  label: string;
  /** Exclusive upper bound on age, in ms. */
  ms: number;
}

export const BUCKETS: readonly Bucket[] = [
  { id: "now", label: "Last 5 minutes", ms: 5 * 60_000 },
  { id: "recent", label: "5 to 30 minutes ago", ms: 30 * 60_000 },
  { id: "hour", label: "30 minutes to 2 hours ago", ms: 2 * 3_600_000 },
  { id: "day", label: "2 to 12 hours ago", ms: 12 * 3_600_000 },
  { id: "older", label: "Earlier", ms: Infinity },
];

/** The bucket a moment falls in. A moment in the future (clock skew) is "now". */
export function bucketOf(at: number, now: number): Bucket {
  const age = Math.max(0, now - at);
  return BUCKETS.find((b) => age < b.ms) ?? BUCKETS[BUCKETS.length - 1]!;
}
