import { localDateTime, plainReason, zoneLabel } from "../format";
import { sinceText } from "../feed";
import { AgentAvatar, IconTile, OutcomePill, Skeleton, agentColor, useNow } from "../components";
import { EventSummary, evSeverity } from "../events";
import type { MiniFeedRow, NameOf } from "../eventmodel";
import { eventLook, whatItLeft } from "../overview-model";
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
      {steps.map((s) => {
        // A quiet turn's pill says "no output"; the line under it says when, and what it left only when there is something to say.
        const left = whatItLeft(s);
        return (
          <li key={s.turnId}>
            <button type="button" className="tl-row" data-turn={s.turnId} onClick={() => onOpen(s.turnId)}>
              <span className={`tl-mark${s.status === "running" ? " live lit" : ""}`}><AgentAvatar id={s.agentId} color={agentColor(roleOf(s.agentId))} size="sm" /></span>
              <span className="tl-main">
                <span className="tl-line"><b>{s.agentId}</b><span className="tl-dim"> · {plainReason(s.reasonKind)}</span></span>
                <span className="tl-sub"><time dateTime={s.startedAt} title={exact(s.startedAt)}>{since(s.startedAt, now)}</time>{left ? <> · {left}</> : null}</span>
              </span>
              <OutcomePill step={s} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** One event as a row of a timeline: the mark for its kind, the line, and when. Shared by the full list and the Overview's summary. */
function EventRow({ e, nameOf, now, onOpen }: { e: TimelineEvent; nameOf: NameOf; now: number; onOpen: (seq: number) => void }): React.JSX.Element {
  const look = eventLook(e.type, evSeverity(e));
  return (
    <li>
      <button type="button" className={`tl-row sev-${evSeverity(e)}`} data-seq={e.seq} onClick={() => onOpen(e.seq)}>
        <span className="tl-mark"><IconTile size="sm" icon={look.icon} tone={look.tone} /></span>
        <span className="tl-main"><span className="tl-line"><EventSummary e={e} nameOf={nameOf} /></span></span>
        <time className="tl-time" dateTime={e.timestamp} title={exact(e.timestamp)}>{since(e.timestamp, now)}</time>
      </button>
    </li>
  );
}

/** The log, newest first: the icon of what kind of thing happened, the line eventmodel.ts writes for it, and when. */
export function EventTimeline({ events, nameOf, onOpen }: { events: TimelineEvent[]; nameOf: NameOf; onOpen: (seq: number) => void }): React.JSX.Element {
  const now = useNow(5000);
  return (
    <ul className="tl">
      {events.map((e) => <EventRow key={e.seq || e.id} e={e} nameOf={nameOf} now={now} onOpen={onOpen} />)}
    </ul>
  );
}

/**
 * The Overview's "Just happened": the same rows, with the runs eventmodel.ts's `miniFeed` folds said as one row. A fold is a
 * button too, and it goes to the place each event can be read: the folded rows are not hidden, only summarised. The line says
 * the count and what happened; the second line says where the rows are, so a press is not a guess — once, on the first fold the
 * panel draws, because it already speaks for each one and four folds printed the same sentence four times.
 */
export function MiniFeed({ rows, nameOf, onOpen, onAll }: { rows: MiniFeedRow<TimelineEvent>[]; nameOf: NameOf; onOpen: (seq: number) => void; onAll: () => void }): React.JSX.Element {
  const now = useNow(5000);
  const explained = rows.find((r) => r.kind === "fold")?.key;
  return (
    <ul className="tl">
      {rows.map((r) => {
        if (r.kind === "event") return <EventRow key={r.key} e={r.e} nameOf={nameOf} now={now} onOpen={onOpen} />;
        const newest = r.items[0]!;
        const oldest = r.items[r.items.length - 1]!;
        const look = eventLook(newest.type, evSeverity(newest));
        return (
          <li key={r.key}>
            <button type="button" className="tl-row tl-fold" onClick={onAll}>
              <span className="tl-mark"><IconTile size="sm" icon={look.icon} tone={look.tone} /></span>
              <span className="tl-main">
                <span className="tl-line"><b>{r.items.length}</b> {r.what}</span>
                {r.key === explained ? <span className="tl-sub">Folded. Open Events for each one.</span> : null}
              </span>
              <time className="tl-time" dateTime={newest.timestamp} title={`${exact(oldest.timestamp)} to ${exact(newest.timestamp)}`}>{since(newest.timestamp, now)}</time>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** What a timeline will be while it is read: the same rows, a mark and two lines of text each, so the page does not jump when they arrive. */
export function TimelineSkeleton({ label, rows = 3 }: { label: string; rows?: number }): React.JSX.Element {
  return (
    <div className="tl-skel" role="status" aria-busy="true">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="tl-row" aria-hidden="true">
          <span className="tl-mark"><Skeleton w={28} h={28} /></span>
          <span className="tl-main"><Skeleton w={`${62 - i * 9}%`} h={14} /><Skeleton w={`${34 + i * 6}%`} h={11} /></span>
        </div>
      ))}
    </div>
  );
}
