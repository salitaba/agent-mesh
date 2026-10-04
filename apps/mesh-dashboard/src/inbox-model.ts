/**
 * What is waiting on the operator, counted once.
 *
 * The inbox used to be two views. "Needs you" said "Waiting on you (0)  all clear" while a tool request sat in "Tool gates",
 * and its own count was the number of stalled-request cards, so a budget decision on the same page left the header at zero.
 * Everything that waits on a person now goes through here: decisions (a card that holds the mission, a card that holds one
 * seat, a notice that holds nothing) and tool requests. The header, the tab badges, the empty state and the order of the
 * list are all computed from the same two lists, so they cannot say different things.
 *
 * The shell's badge and window title count the same things from `/status` and `/tool-approvals`; `waiting` is that number.
 */
import { holdsOf, type EscalationLike } from "./escalation-card";

/** A seat the approval gate holds, as `GET /tool-approvals` reports it. */
export interface ToolSeat {
  agentId: string;
  requiresApproval: string[];
  granted: string[];
  /** Tools the seat reached for and the gate refused. */
  requested: string[];
}

export interface InboxCounts {
  /** Open cards that hold the mission or a seat. */
  blocking: number;
  /** Of those, the ones that hold a single seat: the rest of the mesh keeps working. */
  seatOnly: number;
  /** Open notices: they hold nothing. */
  advisory: number;
  /** Blocking and advisory: what the Decisions tab holds. */
  decisions: number;
  toolRequests: number;
  /** Everything waiting on the operator. The shell's badge. */
  waiting: number;
}

const isOpen = (e: EscalationLike): boolean => e.status === "OPEN";

export function inboxCounts(escalations: readonly EscalationLike[], seats: readonly ToolSeat[]): InboxCounts {
  const open = escalations.filter(isOpen);
  const advisory = open.filter((e) => e.advisory === true).length;
  const blocking = open.length - advisory;
  const seatOnly = open.filter((e) => holdsOf(e).scope === "seat").length;
  const toolRequests = seats.reduce((n, s) => n + (Array.isArray(s.requested) ? s.requested.length : 0), 0);
  return { blocking, seatOnly, advisory, decisions: open.length, toolRequests, waiting: open.length + toolRequests };
}

export type LoadState = "loading" | "ready" | "error";
export type SummaryTone = "ok" | "warn" | "bad" | "neutral";

export interface InboxSummary {
  tone: SummaryTone;
  /** The chip beside the title. */
  label: string;
  /** One line under it. */
  line: string;
  /** True only when both lists have been read and both are empty. */
  clear: boolean;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * The header. "All clear" is a verdict, so it may only be said once everything that can wait has been read: before the lists
 * arrive it must not appear, and when one of them failed to load the page says so instead of reporting a quiet queue. That
 * is the screen where a false all-clear costs the most.
 */
export function inboxSummary(c: InboxCounts, load: { decisions: LoadState; tools: LoadState }): InboxSummary {
  const failed: string[] = [];
  if (load.decisions === "error") failed.push("The decision queue did not load.");
  if (load.tools === "error") failed.push("Tool requests did not load.");
  const pending = load.decisions === "loading" || load.tools === "loading";

  if (c.waiting > 0) {
    const parts: string[] = [];
    const missionHolders = c.blocking - c.seatOnly;
    if (missionHolders > 0) parts.push(`${plural(missionHolders, "decision")} hold${missionHolders === 1 ? "s" : ""} the mission`);
    if (c.seatOnly > 0) parts.push(`${plural(c.seatOnly, "decision")} hold${c.seatOnly === 1 ? "s" : ""} one seat`);
    if (c.advisory > 0) parts.push(plural(c.advisory, "notice"));
    if (c.toolRequests > 0) parts.push(plural(c.toolRequests, "tool request"));
    const tone: SummaryTone = c.blocking > 0 ? "bad" : c.toolRequests > 0 ? "warn" : "neutral";
    return { tone, label: `${c.waiting} waiting`, line: [parts.join(" · ") + ".", ...failed].join(" "), clear: false };
  }
  if (failed.length) {
    return { tone: "bad", label: "Not loaded", line: `${failed.join(" ")} There may be items waiting that this page cannot show.`, clear: false };
  }
  if (pending) return { tone: "neutral", label: "Checking", line: "Checking what is waiting on you.", clear: false };
  return { tone: "ok", label: "All clear", line: "Nothing is waiting on you.", clear: true };
}

/* ------------------------------- the list ---------------------------------- */

/** When a card started waiting. The undatable sort last rather than pretending to be the oldest. */
export function waitedSince(e: EscalationLike): number {
  const d = e.detail && typeof e.detail === "object" ? (e.detail as Record<string, unknown>) : {};
  const t = Date.parse(String(d.awaitingSince || e.createdAt || ""));
  return Number.isNaN(t) ? Infinity : t;
}

export interface OrderedDecisions<T> {
  /** Cards that hold the mission or a seat, longest-waiting first. */
  blocking: T[];
  /** Notices, newest first: they hold nothing, so what is new is what is worth reading. */
  notices: T[];
  /** Everything answered or retired, newest first. */
  done: T[];
}

/**
 * These are agents stopped dead waiting on an answer, so the queue is ordered by how long each has been stopped. Newest-first
 * buried the longest-blocked question at the bottom, where it kept accruing the most idle time: the inversion of what a triage
 * queue is for. A notice holds nothing, so it sorts below every decision and is ordered the other way.
 */
export function orderDecisions<T extends EscalationLike>(list: readonly T[]): OrderedDecisions<T> {
  const created = (e: EscalationLike): number => {
    const t = Date.parse(String(e.createdAt ?? ""));
    return Number.isNaN(t) ? 0 : t;
  };
  const closed = (e: EscalationLike): number => {
    const t = Date.parse(String((e as { respondedAt?: unknown }).respondedAt ?? e.createdAt ?? ""));
    return Number.isNaN(t) ? 0 : t;
  };
  return {
    blocking: list.filter((e) => isOpen(e) && e.advisory !== true).sort((a, b) => waitedSince(a) - waitedSince(b)),
    notices: list.filter((e) => isOpen(e) && e.advisory === true).sort((a, b) => created(b) - created(a)),
    done: list.filter((e) => !isOpen(e)).sort((a, b) => closed(b) - closed(a)),
  };
}

/* -------------------------------- the tabs --------------------------------- */

export type InboxTab = "decisions" | "tools";
export type InboxView = "escalations" | "gates";

/** `escalations` is the inbox; `gates` is the same page opened on its tool section, so both routes keep working. */
export const tabOfView = (view: string): InboxTab => (view === "gates" ? "tools" : "decisions");
export const viewOfTab = (tab: InboxTab): InboxView => (tab === "tools" ? "gates" : "escalations");

export interface InboxTabDef {
  id: InboxTab;
  label: string;
  hint: string;
  /** Shown only when something is waiting there: a zero is noise. */
  badge?: number;
  hot: boolean;
}

export function inboxTabs(c: InboxCounts): InboxTabDef[] {
  return [
    {
      id: "decisions", label: "Decisions", hot: c.blocking > 0, badge: c.decisions > 0 ? c.decisions : undefined,
      hint: "Questions the mesh needs answered, and notices it wants you to see.",
    },
    {
      id: "tools", label: "Tool gates", hot: c.toolRequests > 0, badge: c.toolRequests > 0 ? c.toolRequests : undefined,
      hint: "Seats waiting for you to unlock a tool, and what you have already unlocked.",
    },
  ];
}

/* ----------------------------- tool requests -------------------------------- */

export interface ToolRequestRow {
  agentId: string;
  tool: string;
}

/** One row per tool a seat is waiting on, in seat order. */
export function toolRequestRows(seats: readonly ToolSeat[]): ToolRequestRow[] {
  return seats.flatMap((s) => (Array.isArray(s.requested) ? s.requested.map((tool) => ({ agentId: s.agentId, tool })) : []));
}

/** The seats that have asked, with what each asked for: the Overview's one-line summary. */
export function toolRequestsBySeat(seats: readonly ToolSeat[]): Array<{ agentId: string; tools: string[] }> {
  return seats.filter((s) => Array.isArray(s.requested) && s.requested.length > 0).map((s) => ({ agentId: s.agentId, tools: [...s.requested] }));
}
