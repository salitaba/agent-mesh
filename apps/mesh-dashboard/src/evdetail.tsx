import React, { useMemo } from "react";
import { ago, hhmmss, plainEvent } from "./format";
import { CopyBtn } from "./stepdetail";
import { JsonTree } from "./jsontree";
import { EventSummary, SEVERITY_META, evClass, evSeverity } from "./events";
import type { TimelineEvent } from "./store";

/**
 * The right pane of the events console.
 *
 * It answers three questions in order, because that is the order an operator
 * asks them while a run is live: what happened, what caused it, and what else
 * belongs to the same turn. The payload comes last — it is the thing you read
 * once the first three have told you which event to care about.
 *
 * Deliberately propless of the store: the console owns the buffer and the
 * selection, and passes both down. That keeps this renderable against any list
 * of events, including a future server-fetched one.
 */

/* --------------------------- small pieces ------------------------------ */

function ThreadRow({ e, current, onSelect }: { e: TimelineEvent; current: boolean; onSelect: (seq: number) => void }): React.JSX.Element {
  return (
    <button
      type="button"
      className={`evd-tr sev-${evSeverity(e)}${current ? " on" : ""}`}
      aria-current={current ? "true" : undefined}
      onClick={() => onSelect(e.seq)}
    >
      <time>{hhmmss(e.timestamp)}</time>
      <span className={`type ${evClass(e.type)}`}>{plainEvent(e.type)}</span>
      <span className="summary"><EventSummary e={e} /></span>
    </button>
  );
}

/** A field the operator may want to paste into a grep. */
function IdField({ label, value }: { label: string; value?: string }): React.JSX.Element | null {
  if (!value) return null;
  return (
    <div className="evd-id">
      <span className="k">{label}</span>
      <code>{value}</code>
      <CopyBtn text={value} />
    </div>
  );
}

/* -------------------------- the missing case --------------------------- */

/**
 * A deep link to an event the client no longer holds.
 *
 * The old drawer said "event #N is no longer in the live window" and stopped
 * there, which reads as a bug. The situation is not a bug and not recoverable
 * on the client either: `primeEvents` feeds the same retain cap the live
 * stream does, so re-fetching history would be trimmed straight back to the
 * newest 800. Reaching further genuinely needs the server-side query. Say that
 * plainly and give back the one control that works.
 */
export function EventMissing({ seq, onClose }: { seq: number; onClose: () => void }): React.JSX.Element {
  return (
    <div className="evd evd-gone">
      <div className="evd-gone-body">
        <div className="big">#{seq}</div>
        <p>This event has scrolled out of the live buffer.</p>
        <p className="muted">
          The console keeps the most recent events in memory. Older ones are still on disk on the
          server — fetching them needs a query this build does not have yet.
        </p>
        <button type="button" className="fchip" onClick={onClose}>back to the stream</button>
      </div>
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
  const meta = SEVERITY_META[sev];
  // A correlation id that names a turn is the one link out of here that goes
  // somewhere richer: the step view knows what the agent was doing, not just
  // what it emitted. Other correlation ids have no such page.
  const turnId = e.correlationId && String(e.correlationId).startsWith("turn-") ? String(e.correlationId) : null;

  const { parent, thread } = useMemo(() => {
    const byId = new Map<string, TimelineEvent>();
    for (const x of all) byId.set(x.id, x);
    return {
      parent: e.causationId ? byId.get(e.causationId) ?? null : null,
      thread: e.correlationId
        ? all.filter((x) => x.correlationId === e.correlationId).sort((a, b) => a.seq - b.seq)
        : [],
    };
  }, [e, all]);

  return (
    <div className="evd">
      <header className="evd-head">
        <div className="evd-title">
          <span className={`evd-sev sev-${sev}`} title={meta.hint} aria-label={meta.label}>{meta.glyph}</span>
          <h3 className={evClass(e.type)}>{plainEvent(e.type)}</h3>
          <button type="button" className="evd-x" onClick={onClose} aria-label="Close this event">✕</button>
        </div>
        <div className="evd-meta">
          <span title={e.timestamp}>{hhmmss(e.timestamp)} · {ago(e.timestamp)}</span>
          {e.actorId ? <><span aria-hidden="true">·</span><b>{e.actorId}</b></> : null}
          <span aria-hidden="true">·</span>
          <code className="evd-seq">#{e.seq}</code>
          {/* The raw type is here and not in the heading: the heading is the
              human label, and this is the string you would grep the log for. */}
          <code className="evd-raw">{e.type}</code>
        </div>
        <p className="evd-sum"><EventSummary e={e} /></p>
      </header>

      <section className="evd-sec">
        <h4>Why it happened</h4>
        {parent ? (
          <ThreadRow e={parent} current={false} onSelect={onSelect} />
        ) : e.causationId ? (
          <p className="muted evd-note">
            Caused by <code>{e.causationId}</code>, which is not in the live buffer.
          </p>
        ) : (
          <p className="muted evd-note">
            This event does not record what caused it. Most emitters do not set a causation id yet,
            so an empty answer here means "not recorded", not "nothing caused it".
          </p>
        )}
      </section>

      <section className="evd-sec">
        <div className="evd-sec-head">
          <h4>Thread{thread.length ? <span className="evd-n">{thread.length}</span> : null}</h4>
          {turnId ? (
            <button type="button" className="fchip" onClick={() => onOpenStep(turnId)}>see the full step →</button>
          ) : null}
          {e.correlationId ? (
            <button
              type="button"
              className="fchip"
              aria-pressed={threadOn}
              onClick={() => onFollowThread(threadOn ? null : e.correlationId ?? null)}
            >
              {threadOn ? "stop following" : "follow this thread"}
            </button>
          ) : null}
        </div>
        {e.correlationId ? (
          <div className="evd-thread">
            {thread.map((x) => <ThreadRow key={x.seq || x.id} e={x} current={x.seq === e.seq} onSelect={onSelect} />)}
          </div>
        ) : (
          <p className="muted evd-note">
            No correlation id, so this event cannot be tied to the rest of its turn. Coverage is
            partial today — a thread is only as complete as the emitter that wrote it.
          </p>
        )}
      </section>

      <JsonTree value={e.payload} />

      <section className="evd-sec evd-ids">
        <IdField label="event id" value={e.id} />
        <IdField label="correlation" value={e.correlationId} />
        <IdField label="causation" value={e.causationId} />
        <IdField label="goal" value={e.goalId} />
      </section>
    </div>
  );
}
