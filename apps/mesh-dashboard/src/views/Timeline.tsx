import { localDateTime, opsSummary, plainReason, zoneLabel } from "../format";
import { sinceText } from "../feed";
import { AgentAvatar, IconTile, OutcomePill, agentColor, useNow } from "../components";
import { EventSummary, evSeverity } from "../events";
import type { NameOf } from "../eventmodel";
import { eventLook } from "../overview-model";
import type { TimelineEvent, TurnStep } from "../store";
import "./overview.css";

/**
 * The Overview's two lists of what has been happening, drawn as one timeline: a mark for each row on a rail that joins them, the
 * sentence, and when, as the time since (the clock moves it) with the exact one on hover. A row opens what it is about. They are the
 * same shape on purpose: a person reads one the way they read the other, newest first.
 */
const since = (iso: string, now: number): string => sinceText(now - Date.parse(iso));
const exact = (iso: string): string => `${localDateTime(iso)} ${zoneLabel()}`;

/** The turns, as who did what: the seat's avatar (lit while its turn is running), why it woke, how long ago, and what it left behind. */
export function WorkTimeline({ steps, roleOf, onOpen }: { steps: TurnStep[]; roleOf: (id: string) => string; onOpen: (turnId: string) => void }): React.JSX.Element {
  const now = useNow(5000);
  return (
    <ul className="tl">
      {steps.map((s) => (
        <li key={s.turnId}>
          <button type="button" className="tl-row" data-turn={s.turnId} onClick={() => onOpen(s.turnId)}>
            <span className={`tl-mark${s.status === "running" ? " live lit" : ""}`}><AgentAvatar id={s.agentId} color={agentColor(roleOf(s.agentId))} size="sm" /></span>
            <span className="tl-main">
              <span className="tl-line"><b>{s.agentId}</b><span className="tl-dim"> · {plainReason(s.reasonKind)}</span></span>
              <span className="tl-sub"><time dateTime={s.startedAt} title={exact(s.startedAt)}>{since(s.startedAt, now)}</time> · {opsSummary(s)}</span>
            </span>
            <OutcomePill step={s} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The log, newest first: the icon of what kind of thing happened, the line eventmodel.ts writes for it, and when. */
export function EventTimeline({ events, nameOf, onOpen }: { events: TimelineEvent[]; nameOf: NameOf; onOpen: (seq: number) => void }): React.JSX.Element {
  const now = useNow(5000);
  return (
    <ul className="tl">
      {events.map((e) => {
        const look = eventLook(e.type, evSeverity(e));
        return (
          <li key={e.seq || e.id}>
            <button type="button" className={`tl-row sev-${evSeverity(e)}`} data-seq={e.seq} onClick={() => onOpen(e.seq)}>
              <span className="tl-mark"><IconTile size="sm" icon={look.icon} tone={look.tone} /></span>
              <span className="tl-main"><span className="tl-line"><EventSummary e={e} nameOf={nameOf} /></span></span>
              <time className="tl-time" dateTime={e.timestamp} title={exact(e.timestamp)}>{since(e.timestamp, now)}</time>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
