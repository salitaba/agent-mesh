import { useCallback, useMemo, useRef } from "react";
import { Icon } from "./icons";
import { SEVERITY_META, eventLine, eventNames, type EventLine, type LineEvent, type NameOf, type Severity } from "./eventmodel";

// The model (severity, kinds, filters, folding, the line) is DOM-free and lives in eventmodel.ts, where node:test covers it.
// These names are re-exported so the components that grew up importing them from here keep working.
export {
  EV_FILTER_GROUPS, EV_GROUP, SEVERITY_META, SEVERITY_ORDER, evClass, evGroupOf, evSearchText, evSeverity,
  type Severity,
} from "./eventmodel";

/**
 * How serious an event is, drawn so that colour is never the only cue: a triangle for an alert, a filled dot for activity and a
 * ring for routine bookkeeping. Rows, filters and the detail pane all use it, so an alert looks like an alert wherever it turns up.
 */
export function SevMark({ s }: { s: Severity }): React.JSX.Element {
  return s === "alert"
    ? <Icon name="alert" size={14} className="sev-mark alert" />
    : <i className={`sev-mark ${s}`} aria-hidden="true" />;
}

/** What a screen reader hears for the mark. Activity is the default and says nothing. */
export const sevWord = (s: Severity): string => (s === "alert" ? "Alert. " : s === "routine" ? "Routine. " : "");

/** A line as nodes: what it is about set apart, the rest after it. React escapes both, so nothing in a payload becomes markup. */
export function Line({ l }: { l: EventLine }): React.JSX.Element {
  return l.lead ? <><b>{l.lead}</b>{l.rest}</> : <>{l.rest}</>;
}

/**
 * The one-line "what happened" for an event, the same on every surface that shows one: what it says is decided in eventmodel.ts
 * (`eventLine`). `nameOf` names the files, tasks and messages the payload refers to by id (`useNameOf`).
 */
export function EventSummary({ e, nameOf }: { e: LineEvent; nameOf?: NameOf }): React.JSX.Element {
  return <Line l={eventLine(e, nameOf)} />;
}

/**
 * Names for the ids in a list of events, read from the events it holds. The lookup keeps one identity for the life of the
 * component, so a memoised row that is handed it does not re-render each time the list grows; it reads the newest names when it
 * does render.
 */
export function useNameOf(events: readonly LineEvent[]): NameOf {
  const names = useMemo(() => eventNames(events), [events]);
  const latest = useRef(names);
  latest.current = names;
  return useCallback((id: string) => latest.current.get(id), []);
}

/** An event as the server lists it (an agent's recent events, a step's timeline), where the actor is `actor`. */
export const serverRow = (r: { type: string; actor?: string; payload?: unknown; summary?: string }): LineEvent => ({
  type: r.type, actorId: r.actor, payload: r.payload, summary: r.summary,
});

/** The title a severity chip carries: the label and what it means, so a hover or a screen reader gets both. */
export const severityTitle = (s: Severity): string => `${SEVERITY_META[s].label}. ${SEVERITY_META[s].hint}`;
