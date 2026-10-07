import React, { useMemo, useState } from "react";
import { ago, localDateTime, localTime, plainEvent, zoneLabel } from "./format";
import { Button, Chip, CopyButton, IconButton, IdChip, Pill } from "./components";
import { Icon } from "./icons";
import { JsonTree } from "./jsontree";
import { EventSummary, SevMark, evSeverity, sevWord, useNameOf } from "./events";
import type { NameOf } from "./eventmodel";
import type { TimelineEvent } from "./store";

/**
 * The right pane of the events console.
 *
 * It answers three questions in order, because that is the order an operator asks them while a run is live: what happened, what
 * caused it, and what else belongs to the same turn. The payload comes last: it is the thing you read once the first three have
 * told you which event to care about.
 *
 * Deliberately propless of the store: the console owns the buffer and the selection, and passes both down. That keeps this
 * renderable against any list of events, including a future server-fetched one.
 */

/** A thread longer than this shows its first rows and a button, so one chatty turn does not become two hundred buttons. */
const THREAD_ROWS = 40;

function ThreadRow({ e, current, onSelect, nameOf }: { e: TimelineEvent; current: boolean; onSelect: (seq: number) => void; nameOf: NameOf }): React.JSX.Element {
  return (
    <button type="button" className={`evd-tr sev-${evSeverity(e)}${current ? " on" : ""}`} aria-current={current ? "true" : undefined} onClick={() => onSelect(e.seq)}>
      <i className="evd-dot" aria-hidden="true" />
      <span className="sr-only">{sevWord(evSeverity(e))}</span>
      <time dateTime={e.timestamp} title={`${localDateTime(e.timestamp)} (${e.timestamp})`}>{localTime(e.timestamp)}</time>
      <span className="evd-tr-sum"><EventSummary e={e} nameOf={nameOf} /></span>
    </button>
  );
}

/** The importance of one event, in a word. The filter's labels are plural because they are groups. */
const SEV_WORD = { alert: "Alert", notice: "Activity", routine: "Routine" } as const;

/** A field the operator may want to paste into a grep. */
function IdField({ label, value }: { label: string; value?: string }): React.JSX.Element | null {
  if (!value) return null;
  return (
    <div className="evd-id">
      <span className="k">{label}</span>
      <IdChip value={value} label={label} max={30} />
    </div>
  );
}

/* -------------------------- the missing case --------------------------- */

/**
 * A deep link to an event the client no longer holds.
 *
 * The situation is not a bug and not recoverable on the client: `primeEvents` feeds the same retain cap the live stream does, so
 * re-fetching history would be trimmed straight back to the newest 800. Reaching further needs a server-side query. Say that
 * plainly and give back the one control that works.
 */
export function EventMissing({ seq, onClose }: { seq: number; onClose: () => void }): React.JSX.Element {
  return (
    <div className="evd evd-gone">
      <span className="empty-icon"><Icon name="info" size={22} /></span>
      <b className="empty-title">Event #{seq} is no longer in the live buffer.</b>
      <p className="empty-body">
        The console keeps the newest events in memory. Older ones are still in the log on the server, but this console cannot fetch
        them yet.
      </p>
      <Button variant="small" onClick={onClose}>Back to the stream</Button>
    </div>
  );
}

/* ------------------------------ the pane ------------------------------- */

export function EventDetail({
  e,
  all,
  onSelect,
  onFollowThread,
  onOpenStep,
  threadOn,
  onClose,
}: {
  e: TimelineEvent;
  all: TimelineEvent[];
  onSelect: (seq: number) => void;
  onFollowThread: (correlationId: string | null) => void;
  onOpenStep: (turnId: string) => void;
  threadOn: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const sev = evSeverity(e);
  const [allRows, setAllRows] = useState(false);
  const nameOf = useNameOf(all);
  // A correlation id that names a turn is the one link out of here that goes somewhere richer: the step view knows what the agent
  // was doing, not just what it emitted. Other correlation ids have no such page.
  const turnId = e.correlationId && String(e.correlationId).startsWith("turn-") ? String(e.correlationId) : null;

  const { parent, thread } = useMemo(() => {
    const byId = new Map<string, TimelineEvent>();
    for (const x of all) byId.set(x.id, x);
    return {
      parent: e.causationId ? byId.get(e.causationId) ?? null : null,
      thread: e.correlationId ? all.filter((x) => x.correlationId === e.correlationId).sort((a, b) => a.seq - b.seq) : [],
    };
  }, [e, all]);
  const shownThread = allRows ? thread : thread.slice(0, THREAD_ROWS);

  return (
    <div className="evd">
      <div className="evd-head">
        <div className="evd-title">
          <span className={`evd-tile ${sev}`}><SevMark s={sev} /></span>
          <h3>{plainEvent(e.type, e.payload)}</h3>
          <IconButton icon="x" label="Close event detail" title="Close (Esc)" onClick={onClose} />
        </div>
        <p className="evd-meta">
          <time dateTime={e.timestamp} title={`${localDateTime(e.timestamp)} (${e.timestamp})`}>{localTime(e.timestamp)} {zoneLabel()}</time>
          <span>{ago(e.timestamp)}</span>
          {e.actorId ? <b>{e.actorId}</b> : null}
          <code className="evd-seq">#{e.seq}</code>
        </p>
        <p className="evd-sum"><EventSummary e={e} nameOf={nameOf} /></p>
        {/* The raw type is here and not in the heading: the heading is the human label, and this is the string you would grep for. */}
        <p className="evd-raw">
          <Pill tone={sev === "alert" ? "bad" : sev === "notice" ? "accent" : "neutral"}>{SEV_WORD[sev]}</Pill>
          <Chip mono title="The event's type, as the log records it">{e.type}</Chip>
          <CopyButton text={e.type} what="event type" compact />
        </p>
      </div>

      <section className="evd-sec" aria-labelledby="evd-why">
        <h4 id="evd-why">Why it happened</h4>
        {parent ? (
          <div className="evd-thread"><ThreadRow e={parent} current={false} onSelect={onSelect} nameOf={nameOf} /></div>
        ) : e.causationId ? (
          <p className="evd-note">Caused by <IdChip value={e.causationId} label="causation id" max={26} />, which has scrolled out of the live buffer.</p>
        ) : (
          <p className="evd-note">No cause is recorded. Most events do not name one, so an empty answer does not mean nothing caused it.</p>
        )}
      </section>

      <section className="evd-sec" aria-labelledby="evd-thread">
        <div className="evd-sec-head">
          <h4 id="evd-thread">Thread{thread.length ? <span className="evd-n">{thread.length}</span> : null}</h4>
          {e.correlationId ? <span className="evd-zone">Times in {zoneLabel()}</span> : null}
          {turnId ? (
            <Button variant="small" onClick={() => onOpenStep(turnId)}>
              Open the step <Icon name="chevron-right" size={14} />
            </Button>
          ) : null}
          {e.correlationId ? (
            <Button variant="small" aria-pressed={threadOn} onClick={() => onFollowThread(threadOn ? null : e.correlationId ?? null)}>
              {threadOn ? "Stop following" : "Follow this thread"}
            </Button>
          ) : null}
        </div>
        {e.correlationId ? (
          <>
            <div className="evd-thread">
              {shownThread.map((x) => <ThreadRow key={x.seq || x.id} e={x} current={x.seq === e.seq} onSelect={onSelect} nameOf={nameOf} />)}
            </div>
            {thread.length > THREAD_ROWS ? (
              <Button variant="linklike" onClick={() => setAllRows((a) => !a)} aria-expanded={allRows}>
                {allRows ? `Show the first ${THREAD_ROWS} only` : `Show all ${thread.length.toLocaleString("en-US")} events in this thread`}
              </Button>
            ) : null}
          </>
        ) : (
          <p className="evd-note">Not part of a thread. This event carries no correlation id, so it cannot be tied to the rest of its turn.</p>
        )}
      </section>

      <JsonTree key={e.id} value={e.payload} />

      <section className="evd-sec evd-ids" aria-label="Identifiers">
        <IdField label="Event id" value={e.id} />
        <IdField label="Correlation id" value={e.correlationId} />
        <IdField label="Causation id" value={e.causationId} />
        <IdField label="Goal id" value={e.goalId} />
      </section>
    </div>
  );
}
