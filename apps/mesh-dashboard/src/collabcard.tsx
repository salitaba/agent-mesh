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
import { AgentAvatar, Pill, Progress, agentColor, useNow, type PillTone } from "./components";
import { foldCollabs, pressedFirst, type CollabPressure, type CollabThread } from "./collab";
import { ago, dur } from "./format";
import { useMesh } from "./store";
import { Panel } from "./views/Panel";
import "./views/overview.css";

/** Green while there is room, amber at 75%, red at 90% — the tones the rest of
 *  the console already uses for a budget running out. */
const TONE: Record<CollabPressure["tone"], PillTone> = {
  ok: "working",
  warn: "waiting",
  bad: "blocked",
};

/** One of the two edges as a labelled meter: what it counts, where it stands in words, and the bar. The tone is the pair's, not the bar's own. */
function Meter({ label, ratio, value, tone }: {
  label: string; ratio: number; value: string; tone: CollabPressure["tone"];
}): React.JSX.Element {
  return (
    <div className="cb-meter">
      <div className="cb-meter-top"><span>{label}</span><b>{value}</b></div>
      <Progress value={ratio} max={1} label={label} tone={tone === "ok" ? undefined : tone} valueText={value} />
    </div>
  );
}

function CollabRow({ t, p, roleOf }: { t: CollabThread; p: CollabPressure; roleOf: (id: string) => string }): React.JSX.Element {
  // The opener first, then whoever else is in the room. Ordering by arrival
  // rather than alphabetically because "who started this" is the useful half.
  const others = t.participants.filter((a) => a !== t.openedBy);
  const seat = (a: string): React.JSX.Element => (
    <span className="cb-seat"><AgentAvatar id={a} color={agentColor(roleOf(a))} size="sm" /><b>{a}</b></span>
  );
  return (
    <div className="cb-row">
      <div className="cb-head">
        <span className="cb-topic" title={t.topic || t.threadId}>{t.topic || t.threadId}</span>
        <Pill tone={TONE[p.tone]} pulse={p.tone === "bad"}>
          {p.tone === "bad" ? "at the edge" : p.tone === "warn" ? "running long" : "open"}
        </Pill>
      </div>
      <div className="cb-who">
        {seat(t.openedBy)}
        {others.length ? <span>with</span> : <span>— no one has answered</span>}
        {others.map((a) => <React.Fragment key={a}>{seat(a)}</React.Fragment>)}
        <span>· opened {ago(t.openedAt)}</span>
      </div>
      <div className="cb-meters">
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
  const { status } = useMesh();
  const open = pressedFirst(threads, now);
  const roles = useMemo(() => new Map<string, string>(((status?.agents ?? []) as Array<{ id?: string; role?: string }>).map((a) => [String(a.id), String(a.role ?? "")])), [status]);
  return (
    <Panel id="ov-collab" title="Talking to each other" meta={`${open.length} open`}>
      {open.map(({ t, p }) => <CollabRow key={t.threadId} t={t} p={p} roleOf={(id) => roles.get(id) ?? ""} />)}
    </Panel>
  );
}
