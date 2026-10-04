/**
 * What the events console decides, as a model: how important an event is, which kind it is, how the filters combine, and how a
 * newest-first list folds into time headings and runs of routine bookkeeping.
 *
 * It lived inside `events.tsx` and `views/Events.tsx`, where nothing could test it. The parts that carry a claim ("Alerts 3"
 * means three alerts within what you are already looking at; a fold never straddles two time headings; a crash is never folded
 * away) are here, in plain functions. `events.tsx` keeps the one thing that needs React: the sentence for an event.
 */
import { plainEvent } from "./format";
import { bucketOf } from "./feed";
// Deep import, not the package barrel: `packages/protocol/src/index` star-exports the AJV-backed validators and schemas, and
// none of that belongs in a browser bundle. `catalog.ts` imports only types from `./types`, so this pulls in the const table and
// nothing else. It is the dashboard's one dependency on packages/ — worth it to keep a single source of truth for severity
// rather than a second 68-entry table here that would silently drift.
import { EVENT_SEVERITY } from "../../../packages/protocol/src/catalog";
import type { EventType, Severity } from "../../../packages/protocol/src/types";

export type { Severity };

/** What this model reads of an event. Structural, so the store's `TimelineEvent` fits without this file importing a .tsx. */
export interface EventLike {
  seq: number;
  id: string;
  type: string;
  timestamp: string;
  actorId?: string;
  correlationId?: string;
  payload?: any;
}

/* ---------------------------- kind (the colour class) ---------------------------- */

export function evClass(type: string): string {
  const p = String(type).split(".")[0];
  return (
    {
      goal: "t-goal", agent: "t-agent", message: type === "message.rejected" ? "t-bad" : "t-message",
      artifact: "t-artifact", budget: "t-budget", review: "t-review", task: "t-task", patch: "t-artifact",
      release: "t-artifact", escalation: "t-escalation", lease: "t-lease", requirements: "t-artifact",
      requirement: "t-artifact", architecture: "t-review", design: "t-message", dependency: "t-artifact",
      authentication: "t-artifact", authorization: "t-artifact", research: "t-artifact",
      implementation: "t-review", decision: "t-review", memory: "t-agent", human: "t-message",
      plan: type === "plan.gate_rejected" ? "t-bad" : "t-task",
      // A collaboration is a conversation, so it reads in the same tone as one.
      // `collab.closed` is deliberately not t-bad even when the watchdog is the
      // one closing it: an overrun is worth noticing, and the Overview card is
      // where it gets noticed. A red line for every expiry would cry wolf over
      // a session that merely ran to the end of its box.
      collab: "t-message",
    }[p] || ""
  );
}

/* ---------------------------- severity -------------------------------- */

/** `icon` is what draws the severity when colour is not enough: an alert is a triangle, the rest are a dot and a ring. */
export const SEVERITY_META: Record<Severity, { label: string; hint: string }> = {
  alert: { label: "Alerts", hint: "Went wrong, or needs you." },
  notice: { label: "Activity", hint: "Real progress: messages, files, decisions." },
  routine: { label: "Routine", hint: "Bookkeeping. Folded by default." },
};

export const SEVERITY_ORDER: Severity[] = ["alert", "notice", "routine"];

/** Lifecycle states that mean an agent is stuck or dead rather than working. */
const BAD_LIFECYCLE = new Set(["FAILED", "BLOCKED"]);

/**
 * The type-level floor from `EVENT_SEVERITY`, refined where the payload knows better.
 *
 * Only `agent.state_changed` is refined today, and deliberately so: it is both the highest-volume type in the log and the one
 * whose importance swings most on its payload — a transition into FAILED is the single most useful line in a crashed run, and
 * ranking it `routine` alongside the dozen THINKING/WORKING churns per turn would fold the crash away. Other types are left at
 * their floor rather than guessed at; a refinement is only worth adding for a payload shape that has actually been read.
 *
 * Unknown types fall back to `notice`, not `routine`: a dashboard older than the server it is pointed at should show new events
 * too loudly rather than hide them.
 */
export function evSeverity(e: Pick<EventLike, "type" | "payload">): Severity {
  const base: Severity = EVENT_SEVERITY[e.type as EventType] ?? "notice";
  if (e.type === "agent.state_changed" && BAD_LIFECYCLE.has(String(e.payload?.to))) return "alert";
  return base;
}

/* ------------------------------ kind facets --------------------------------- */

export const EV_GROUP = (t: string): string => String(t).split(".")[0]!;

/** Multi-select: an empty selection means "everything", so there is no "All" pseudo-facet to keep in sync with the real ones. */
export const EV_FILTER_GROUPS: { id: string; label: string; match: string[] }[] = [
  { id: "message", label: "Messages", match: ["message", "thread"] },
  { id: "agent", label: "Agents", match: ["agent", "memory"] },
  { id: "work", label: "Files and tasks", match: ["artifact", "task", "plan", "patch", "review", "release", "architecture", "implementation", "design", "dependency", "requirements", "requirement"] },
  { id: "system", label: "System", match: ["goal", "budget", "escalation", "lease", "human", "decision", "research", "authentication", "authorization", "deadlock", "commitment"] },
];

export const evGroupOf = (t: string): string => {
  const g = EV_GROUP(t);
  for (const f of EV_FILTER_GROUPS) if (f.match.includes(g)) return f.id;
  return "system";
};

/** Plain-text fallback of an event's sentence, for search haystacks. Kept deliberately crude: it exists to be matched against. */
export function evSearchText(e: Pick<EventLike, "type" | "payload" | "actorId">): string {
  const p = e.payload || {};
  if (typeof p.summary === "string" && p.summary) return p.summary;
  return `${plainEvent(e.type, p)} ${e.actorId || ""}`;
}

/* ------------------------------ facet string -------------------------------- */

/* One comma-joined, namespaced string holds every facet -- `sev:alert,grp:message,actor:pm`. It lives in the store's `evFilter`,
   which already survives view switches. Keeping it one string means no new store state for four independent filters, and the
   whole filter set is one value to reset. */

export const parseFacets = (s: string): Set<string> => new Set(s.split(",").filter(Boolean));

export const facetValues = (f: ReadonlySet<string>, ns: string): string[] =>
  [...f].filter((x) => x.startsWith(`${ns}:`)).map((x) => x.slice(ns.length + 1));

export const facetOne = (f: ReadonlySet<string>, ns: string): string | null => facetValues(f, ns)[0] ?? null;

/** Adds the token if it is absent, removes it if present. */
export function toggleFacet(s: string, token: string): string {
  const next = parseFacets(s);
  if (next.has(token)) next.delete(token);
  else next.add(token);
  return [...next].join(",");
}

/** A single-valued facet replaces rather than accumulates; null clears it. */
export function setFacet(s: string, ns: string, value: string | null): string {
  const next = [...parseFacets(s)].filter((x) => !x.startsWith(`${ns}:`));
  if (value) next.push(`${ns}:${value}`);
  return next.join(",");
}

/* -------------------------------- filtering --------------------------------- */

export interface EventFilter {
  /** Lower-cased, trimmed. */
  search: string;
  /** Group ids; empty means every group. */
  groups: ReadonlySet<string>;
  actor: string | null;
  /** A correlation id: follow one thread. */
  thread: string | null;
}

/** The haystack for one event. Built once per buffer change, not once per keystroke: it stringifies a payload. */
export function eventHaystack(e: EventLike): string {
  return `${e.type} ${e.actorId || ""} ${evSearchText(e)} ${JSON.stringify(e.payload || {}).slice(0, 600)}`.toLowerCase();
}

/**
 * Everything except the severity facet, newest first. The severity counts are taken from this list, so "Alerts 3" means three
 * alerts within what you are already looking at: a count against the whole buffer would send you to an empty list.
 *
 * `events` is oldest first (the store's order) and `hay` holds the haystack at the same index.
 */
export function filterBase<T extends EventLike>(events: readonly T[], hay: readonly string[], f: EventFilter): T[] {
  const out: T[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (f.groups.size && !f.groups.has(evGroupOf(e.type))) continue;
    if (f.actor && e.actorId !== f.actor) continue;
    if (f.thread && e.correlationId !== f.thread) continue;
    if (f.search && !hay[i]!.includes(f.search)) continue;
    out.push(e);
  }
  return out;
}

export function severityCounts(list: readonly EventLike[]): Record<Severity, number> {
  const c: Record<Severity, number> = { alert: 0, notice: 0, routine: 0 };
  for (const e of list) c[evSeverity(e)]++;
  return c;
}

/** The severity facet applied to the base list. No severity selected means all of them. */
export const applySeverity = <T extends EventLike>(list: readonly T[], on: ReadonlySet<string>): readonly T[] =>
  on.size ? list.filter((e) => on.has(evSeverity(e))) : list;

/** The busiest agents in the buffer, for the agent filter. */
export function topActors(events: readonly EventLike[], limit = 12): string[] {
  const n = new Map<string, number>();
  for (const e of events) if (e.actorId) n.set(e.actorId, (n.get(e.actorId) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([id]) => id);
}

/* ---------------------------------- rows ------------------------------------ */

/** A run of this many consecutive routine events collapses into one row. */
export const FOLD_AT = 3;

export type EventRowModel<T extends EventLike = EventLike> =
  | { kind: "bucket"; key: string; label: string }
  | { kind: "event"; key: string; e: T }
  | { kind: "fold"; key: string; items: T[] };

/**
 * Bucket headers and folded runs in one pass over a newest-first list.
 *
 * A run is flushed on a non-routine event and on a bucket boundary, so a fold never straddles two time headings and claims
 * events happened closer together than they did. A fold is keyed by its OLDEST event: new routine events join a run at the top,
 * so keying on the newest remounted the fold and snapped shut one the reader had just opened.
 */
export function buildRows<T extends EventLike>(list: readonly T[], now: number, fold: boolean): EventRowModel<T>[] {
  const out: EventRowModel<T>[] = [];
  let run: T[] = [];
  let bucket = "";

  const flush = (): void => {
    if (run.length >= FOLD_AT) out.push({ kind: "fold", key: `f${run[run.length - 1]!.seq}`, items: run });
    else for (const e of run) out.push({ kind: "event", key: String(e.seq || e.id), e });
    run = [];
  };

  for (const e of list) {
    const b = bucketOf(Date.parse(e.timestamp), now);
    if (b.id !== bucket) {
      flush();
      bucket = b.id;
      out.push({ kind: "bucket", key: `b${b.id}`, label: b.label });
    }
    if (fold && evSeverity(e) === "routine") {
      run.push(e);
      continue;
    }
    flush();
    out.push({ kind: "event", key: String(e.seq || e.id), e });
  }
  flush();
  return out;
}
