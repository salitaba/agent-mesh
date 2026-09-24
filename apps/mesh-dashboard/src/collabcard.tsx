/* ---------------------------------------------------------------------- *
 * Open collaborations, with both of their edges.
 *
 * Two agents mid-conversation is the one piece of mesh activity that used to
 * be invisible from the console: the turn stream shows each of them working,
 * and the thread shows messages, but nothing said the pair was inside a box
 * that is going to close on them. The first an operator heard of it was the
 * overrun card after the fact.
 *
 * So this shows the box, not the conversation — the transcript already has a
 * home. Both meters are drawn for every session because either one can be the
 * one that ends it, and which one that is says different things: burning the
 * exchange count means they are talking past each other, burning the clock
 * means one of them has gone quiet.
 * ---------------------------------------------------------------------- */
import React, { useMemo } from "react";
import { AgentAvatar, Card, Pill, useNow, type PillTone } from "./components";
import { foldCollabs, pressedFirst, type CollabPressure, type CollabThread } from "./collab";
import { ago, dur } from "./format";
import { useMesh } from "./store";

/** Green while there is room, amber at 75%, red at 90% — the tones the rest of
 *  the console already uses for a budget running out. */
const TONE: Record<CollabPressure["tone"], PillTone> = {
  ok: "working",
  warn: "waiting",
  bad: "blocked",
};

function Meter({ label, ratio, value, tone }: {
  label: string; ratio: number; value: string; tone: CollabPressure["tone"];
}): React.JSX.Element {
  return (
    <div className="bar-row">
      <span className="lbl">{label}</span>
      <div className={`track${tone === "ok" ? "" : ` ${tone}`}`}>
        <div style={{ transform: `scaleX(${ratio})` }} />
      </div>
      <span className="num">{value}</span>
    </div>
  );
}

function CollabRow({ t, p }: { t: CollabThread; p: CollabPressure }): React.JSX.Element {
  // The opener first, then whoever else is in the room. Ordering by arrival
  // rather than alphabetically because "who started this" is the useful half.
  const others = t.participants.filter((a) => a !== t.openedBy);
  return (
    <div className="collab-row">
      <div className="collab-head">
        <span className="collab-topic">{t.topic || t.threadId}</span>
        <Pill tone={TONE[p.tone]} pulse={p.tone === "bad"}>
          {p.tone === "bad" ? "at the edge" : p.tone === "warn" ? "running long" : "open"}
        </Pill>
      </div>
      <div className="collab-who">
        <AgentAvatar id={t.openedBy} size="sm" />
        <span className="mono">{t.openedBy}</span>
        {others.length ? <span className="muted">with</span> : <span className="muted">— no one has answered</span>}
        {others.map((a) => (
          <React.Fragment key={a}>
            <AgentAvatar id={a} size="sm" />
            <span className="mono">{a}</span>
          </React.Fragment>
        ))}
        <span className="muted">· opened {ago(t.openedAt)}</span>
      </div>
      <Meter
        label="exchanges"
        ratio={p.exchangeRatio}
        tone={p.tone}
        value={t.maxExchanges ? `${t.exchanges} / ${t.maxExchanges}` : `${t.exchanges}`}
      />
      <Meter
        label="time box"
        ratio={p.timeRatio}
        tone={p.tone}
        // Past the edge the watchdog has not swept yet: the session is still
        // OPEN in the log but is already over, and saying "0s left" would read
        // as a session with a moment to spare.
        value={p.leftMs > 0 ? `${dur(p.leftMs)} left` : Number.isFinite(p.leftMs) ? "past its edge" : "no box"}
      />
    </div>
  );
}

/**
 * The card itself. Renders nothing at all when no collaboration is open —
 * which is most of the time, and an empty "no collaborations" panel on every
 * overview would cost more attention than it returns.
 */
export function CollabCard(): React.JSX.Element | null {
  const { events } = useMesh();
  const threads = useMemo(() => foldCollabs(events), [events]);
  if (!threads.some((t) => t.status === "OPEN")) return null;
  return <CollabBoard threads={threads} />;
}

/** Split out so the 1Hz clock is mounted only while something is open —
 *  a ticking `useNow` in the Overview re-renders it once a second forever. */
function CollabBoard({ threads }: { threads: CollabThread[] }): React.JSX.Element {
  const now = useNow(1000);
  const open = pressedFirst(threads, now);
  return (
    <Card
      title="Talking to each other"
      actions={<span className="muted">{open.length} open</span>}
      style={{ marginTop: 12 }}
    >
      {open.map(({ t, p }) => <CollabRow key={t.threadId} t={t} p={p} />)}
    </Card>
  );
}
