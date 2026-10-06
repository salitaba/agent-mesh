/**
 * What the Graph page decides, as a model: where each seat sits, which way its label points, what each kind of line is called, how
 * many lines are drawn and which of them a recent message has just travelled.
 *
 * The drawing put every label above or below its seat, so on a ring the line from a seat to its neighbour ran straight through the
 * seat's own name. Labels now point away from the centre, where no line goes. A message from "dev" lit up the line to "developer"
 * (the match was a substring), the legend had no entry for the most common kind of line ("messaged"), two seats were drawn one above
 * the other, and the twelve-line cap was silent. Each is a function here so that the tests can pin it. DOM-free.
 */
import { RUNNING } from "./format";
import { count as plural } from "./text";
import { setFacet, toggleFacet } from "./eventmodel";

/* ------------------------------- kinds of line ------------------------------- */

export type Tone = "accent" | "ok" | "bad" | "warn" | "info" | "muted";

export interface KindDef {
  id: string;
  /** In the legend: what a line of this colour means. */
  label: string;
  /** In a sentence about one line: "pm asked architect". */
  verb: string;
  tone: Tone;
}

/** The last entry is the fallback: a message whose type the console has no word for is still a message. */
export const KINDS: readonly KindDef[] = [
  { id: "REQUEST", label: "asked for help", verb: "asked", tone: "accent" },
  { id: "APPROVE", label: "approved", verb: "approved", tone: "ok" },
  { id: "BLOCK", label: "blocked", verb: "blocked", tone: "bad" },
  { id: "ESCALATE", label: "escalated", verb: "escalated", tone: "warn" },
  { id: "INFORM", label: "updated", verb: "updated", tone: "info" },
  { id: "OTHER", label: "messaged", verb: "messaged", tone: "muted" },
];

export const kindOf = (kind: string): KindDef => KINDS.find((k) => k.id === kind) ?? KINDS[KINDS.length - 1]!;

export interface EdgeLike {
  from: string;
  to: string;
  kind: string;
  count: number;
}

export const edgeKey = (e: Pick<EdgeLike, "from" | "to" | "kind">): string => `${e.from}|${e.to}|${e.kind}`;

/** "pm asked architect, 3 messages": one line of the drawing in words, for its tooltip and for the list beside it. */
export function edgeText(e: EdgeLike): string {
  return `${e.from} ${kindOf(e.kind).verb} ${e.to}, ${plural(e.count, "message", "messages")}`;
}

/** Thicker is more messages, up to a line that is still a line. */
export const edgeWidth = (n: number): number => Math.min(4, 1 + n * 0.4);

/** The legend lists the kinds that are on the drawing, in the legend's order, and never one that is not. */
export function kindsPresent(edges: readonly EdgeLike[]): KindDef[] {
  const seen = new Set(edges.map((e) => kindOf(e.kind).id));
  return KINDS.filter((k) => seen.has(k.id));
}

/**
 * The busiest `cap` lines, busiest first (ties keep a stable order), and how many were left off. Leaving lines off is fine; not
 * saying so is not, so the caller prints `hidden`.
 */
export function capEdges<T extends EdgeLike>(edges: readonly T[], cap: number): { shown: T[]; hidden: number } {
  const sorted = [...edges].sort((a, b) => b.count - a.count || edgeKey(a).localeCompare(edgeKey(b)));
  return { shown: sorted.slice(0, cap), hidden: Math.max(0, sorted.length - cap) };
}

/**
 * The lines to draw: those of a kind the person has not hidden, the busiest `cap` of them, and how many were left off for each reason.
 * The kinds are hidden first and the cap applied after, so hiding "messaged" brings the next busiest lines of the other kinds into the
 * drawing rather than leaving a gap, and each count says what it counts.
 */
export function visibleEdges<T extends EdgeLike>(edges: readonly T[], hiddenKinds: ReadonlySet<string>, cap: number): { shown: T[]; hidden: number; off: number } {
  const kept = edges.filter((e) => !hiddenKinds.has(kindOf(e.kind).id));
  return { ...capEdges(kept, cap), off: edges.length - kept.length };
}

/** The legend's key for a kind, pressed: a kind that is shown becomes hidden, and one that is hidden is shown again. */
export function toggleKind(hidden: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(hidden);
  if (!next.delete(id)) next.add(id);
  return next;
}

/**
 * What pointing at a seat picks out: the lines that run to or from it, and the seats on the other end of them. Everything else is
 * context and is drawn back.
 */
export function around<T extends Pick<EdgeLike, "from" | "to" | "kind">>(edges: readonly T[], id: string): { lines: Set<string>; seats: Set<string> } {
  const lines = new Set<string>();
  const seats = new Set<string>([id]);
  for (const e of edges) {
    if (e.from !== id && e.to !== id) continue;
    lines.add(edgeKey(e));
    seats.add(e.from);
    seats.add(e.to);
  }
  return { lines, seats };
}

/**
 * The Events page's own filters, set to the messages one seat sent to another: the message kinds of event, by that actor, that mention
 * the recipient. The page's filters are one facet string and one search box, so nothing new is stored and the person can see, change
 * and clear what was set. A message to several seats names each of them, so the recipient is a search and not an exact match.
 */
export function pairFilter(from: string, to: string): { filter: string; search: string } {
  return { filter: setFacet(toggleFacet("", "grp:message"), "actor", from), search: to };
}

/**
 * The lines a recent message has travelled, by exact id: from the sender to each recipient. This used to compare
 * `"dev|qa".startsWith("dev|")` and `.includes("qa")`, so a message from "dev" lit up the line from "dev" to "qa-lead", and one
 * to "developer" lit up "dev".
 */
export function flowingKeys(recent: ReadonlyArray<{ from: string; to: readonly string[] }>): Set<string> {
  const out = new Set<string>();
  for (const m of recent) for (const t of m.to) out.add(`${m.from}|${t}`);
  return out;
}

export const isFlowing = (e: Pick<EdgeLike, "from" | "to">, flowing: ReadonlySet<string>): boolean => flowing.has(`${e.from}|${e.to}`);

/* --------------------------------- the seats --------------------------------- */

export type NodeTone = "working" | "waiting" | "stopped" | "paused" | "idle";

/** The ring around a seat. The word beside it says the same, so the colour is never the only cue. */
export function nodeTone(lifecycle: string): NodeTone {
  const l = String(lifecycle || "").toUpperCase();
  if (RUNNING.has(l)) return "working";
  if (l === "WAITING") return "waiting";
  if (l === "FAILED" || l === "BLOCKED") return "stopped";
  if (l === "SUSPENDED") return "paused";
  return "idle";
}

export interface Seat {
  x: number;
  y: number;
  /** Which way is out, from the centre of the ring (radians). */
  angle: number;
}

/** What the ring leaves free beyond its seats: each side for a name, the top and the bottom for a name and the word for its state. */
const SIDE_ROOM = 150;
const END_ROOM = 70;

/**
 * Where the seats sit. One is in the middle, two face each other left and right, and three or more share an ellipse that starts at
 * the top. The ring is narrower than the drawing so there is room for a name beyond each seat: a ring as wide as the canvas left
 * the side labels nowhere to go. In a drawing narrower than the one it was designed on (`DRAWING_MAX`), the ring narrows with it.
 */
export function ringLayout(n: number, W: number, H: number): Seat[] {
  if (n <= 0) return [];
  const cx = W / 2, cy = H / 2;
  if (n === 1) return [{ x: cx, y: cy, angle: Math.PI / 2 }];
  const room = W / 2 - SIDE_ROOM;
  const rx = n === 2 ? Math.min(150, room) : n <= 5 ? Math.min(230, room) : room;
  const ry = n === 2 ? 0 : n <= 5 ? 130 : H / 2 - END_ROOM;
  const start = n === 2 ? Math.PI : -Math.PI / 2;
  return Array.from({ length: n }, (_, i) => {
    const a = start + (i / n) * Math.PI * 2;
    return { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a), angle: a };
  });
}

/** The width the drawing was designed on, and the most it is ever made at. */
export const DRAWING_MAX = 900;
/** The narrowest it is made at: a ring much narrower than this is a column, and its lines cross its names. */
const DRAWING_MIN = 520;
/** The height it is made at, which does not change with the width. */
const DRAWING_H = 480;
/** The least that two names side by side along the top or the bottom of the ring may be apart, in the drawing's own units. */
const NAMES_APART = 100;

/** The least distance along the drawing between two names that sit on the same side of the ring, above it or below it. */
function nearestNames(seats: readonly Seat[]): number {
  let least = Infinity;
  for (let i = 0; i < seats.length; i++) {
    const a = labelPlacement(seats[i]!.angle);
    if (a.anchor !== "middle") continue;
    for (let j = i + 1; j < seats.length; j++) {
      const b = labelPlacement(seats[j]!.angle);
      if (b.anchor === "middle" && Math.sign(b.name.dy) === Math.sign(a.name.dy)) least = Math.min(least, Math.abs(seats[i]!.x - seats[j]!.x));
    }
  }
  return least;
}

/**
 * The width to draw at, given the width it is shown at. A drawing made at 900 and shown at 530 (a tablet beside the sidebar) has its
 * text at 59%: seven-pixel names. Made at the width it is shown at, the text is its authored size, and the ring narrows with it (see
 * `ringLayout`). It is never made narrower than the ring needs for its seats, though: the seats nearest the top (or the bottom) of
 * the ring come closer together as there are more of them or the ring is narrower, and closer than `NAMES_APART` their names run into
 * each other. A roster that needs more than the width it is shown at is drawn wider and shrunk to fit, as before, and a width that
 * is not known (nothing measured yet) is the designed one.
 */
export function drawingWidth(shown: number, seats: number): number {
  if (!Number.isFinite(shown) || shown <= 0) return DRAWING_MAX;
  let needs = DRAWING_MIN;
  while (needs < DRAWING_MAX && nearestNames(ringLayout(seats, needs, DRAWING_H)) < NAMES_APART) needs += 4;
  return Math.round(Math.min(DRAWING_MAX, Math.max(shown, needs)));
}

export interface LabelSpot {
  anchor: "start" | "middle" | "end";
  /** Offsets from the seat's centre: the seat's name, and under (or over) it the word for its state. */
  name: { dx: number; dy: number };
  state: { dx: number; dy: number };
}

/**
 * Where a seat's label goes: away from the centre of the ring, because every line in the drawing runs inside it. At the top the
 * name sits above the seat with the state above that; at the bottom, below; at the sides the name goes out to the side.
 */
export function labelPlacement(angle: number): LabelSpot {
  const ux = Math.cos(angle), uy = Math.sin(angle);
  if (Math.abs(uy) > 0.7) {
    return uy < 0
      ? { anchor: "middle", name: { dx: 0, dy: -28 }, state: { dx: 0, dy: -43 } }
      : { anchor: "middle", name: { dx: 0, dy: 34 }, state: { dx: 0, dy: 49 } };
  }
  const right = ux > 0;
  const dx = right ? 28 : -28;
  return { anchor: right ? "start" : "end", name: { dx, dy: -1 }, state: { dx, dy: 13 } };
}
