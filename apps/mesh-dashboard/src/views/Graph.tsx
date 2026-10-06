import { useEffect, useMemo, useState } from "react";
import { plainLifecycle } from "../format";
import { useMesh } from "../store";
import { useMission } from "../useMission";
import { Button, Card, EmptyState, ErrorState, PageHeader, rowKey, useNow } from "../components";
import { AgentDrawer } from "../drawers";
import { sinceText } from "../feed";
import { middleClip } from "../text";
import { around, edgeKey, edgeText, edgeWidth, flowingKeys, isFlowing, kindOf, kindsPresent, labelPlacement, nodeTone, pairFilter, ringLayout, toggleKind, visibleEdges, type NodeTone } from "../graph";
import "./graph.css";

/* Who talks to whom. Where the seats sit, which way their names point and which lines are drawn is decided in graph.ts, which
   node:test covers; this file draws it and keeps the keyboard way in: every seat is a button, and every line is a button in the list
   under the drawing. Pointing at or focusing a seat picks out its lines, the key hides a kind of line, and a line in the list opens
   its messages in Events. */

const W = 900, H = 480;
/** Lines drawn at most; the page says how many it left off. */
const MAX_LINES = 12;
/** A message among the newest events makes its line flow. */
const RECENT_EVENTS = 40;

const RING_WORD: Record<NodeTone, string> = {
  working: "working", waiting: "waiting for mail", stopped: "crashed or blocked", paused: "paused", idle: "idle or finished",
};

export default function Graph(): React.JSX.Element {
  const { events, openDrawer, client, setView, setEvSearch, setEvFilter } = useMesh();
  // A seat that has never run is "ready" on a parked team, as its card says, not "starting".
  const { facts } = useMission();
  const where = { parked: facts.parked, over: facts.goalStatus === "COMPLETED" || facts.goalStatus === "FAILED" };
  const [graph, setGraph] = useState<any>(null);
  // A swallowed catch here left `graph` null forever, so a dead server was indistinguishable from a slow one. Failure is a state.
  const [err, setErr] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // When this drawing was made. The flowing lines come from the live event stream, so a frozen /graph fetch put two moments in one
  // picture: current activity drawn on stale lines. The page says how old the drawing is.
  const [at, setAt] = useState<string | null>(null);
  // A line in the list is picked out in the drawing while it is pointed at or focused, and stays picked out once pressed (a touch has
  // no hover, and a press that un-picked what the pointer had just picked would read as nothing happening).
  const [hover, setHover] = useState<string | null>(null);
  const [pin, setPin] = useState<string | null>(null);
  const hot = pin ?? hover;
  // The seat the pointer is on or the keyboard has reached: its lines are picked out and the rest drawn back, as a line in the list does.
  const [seat, setSeat] = useState<string | null>(null);
  // The kinds of line the person has hidden with the key.
  const [off, setOff] = useState<ReadonlySet<string>>(() => new Set());
  const now = useNow(5000);
  // Lines are message counts and seats are the roster, so those two event families are what invalidates the drawing. Keying on the
  // top seq refetches once per change rather than on a timer.
  const graphSeq = useMemo(() => {
    let top = 0;
    for (const e of events) if ((e.type === "message.sent" || e.type.startsWith("agent.")) && e.seq > top) top = e.seq;
    return top;
  }, [events]);
  useEffect(() => {
    let dead = false;
    setErr(null);
    client.api("GET", "/graph").then(({ json, timeout }) => {
      if (dead) return;
      if (timeout || !json || json.error) {
        setErr(timeout ? "The request timed out. The server may be busy." : String(json?.error ?? "The mesh server did not answer."));
        return;
      }
      setGraph(json);
      setAt(new Date().toISOString());
    }).catch((e: unknown) => {
      if (!dead) setErr(e instanceof Error ? e.message : String(e));
    });
    return () => {
      dead = true;
    };
  }, [attempt, graphSeq, client]);

  const flowing = useMemo(
    () => flowingKeys(
      events.slice(-RECENT_EVENTS).filter((e) => e.type === "message.sent").map((e) => ({ from: String(e.payload?.message?.from ?? ""), to: (e.payload?.message?.to ?? []) as string[] })),
    ),
    [events],
  );
  const nodes: { id: string; lifecycle: string }[] = useMemo(() => (graph?.nodes || []).filter((n: { id: string }) => n.id !== "human"), [graph]);
  const seats = useMemo(() => ringLayout(nodes.length, W, H), [nodes.length]);
  const pos = useMemo(() => new Map(nodes.map((n, i) => [n.id, seats[i]!])), [nodes, seats]);
  // A line is drawn only between two seats on the ring. The operator ("human") is not a seat, so lines to and from it are counted, not drawn.
  const lines = useMemo(() => {
    const all: { from: string; to: string; kind: string; count: number }[] = graph?.edges || [];
    const drawable = all.filter((e) => e.from !== e.to && pos.has(e.from) && pos.has(e.to));
    return { ...visibleEdges(drawable, off, MAX_LINES), drawable, withYou: all.filter((e) => e.from === "human" || e.to === "human").length };
  }, [graph, pos, off]);
  const near = useMemo(() => (seat ? around(lines.shown, seat) : null), [seat, lines.shown]);

  const header = (status?: React.ReactNode): React.JSX.Element => (
    <PageHeader
      title="Graph"
      status={status}
      lede={`Who talks to whom. A thicker line is more messages. A dashed, moving line carried a message in the last ${RECENT_EVENTS} events. Point at a seat to see only its lines; press it to open it.`}
    />
  );

  if (err && !graph) return <>{header()}<ErrorState what="the graph" detail={err} onRetry={() => setAttempt((n) => n + 1)} /></>;
  if (!graph) return <>{header()}<div role="status"><EmptyState icon="graph" title="Loading the graph" /></div></>;
  if (!nodes.length) {
    return (
      <>
        {header()}
        <EmptyState icon="graph" title="No agents in this mesh yet">Add seats in the Designer and the graph draws itself.</EmptyState>
      </>
    );
  }

  const open = (id: string): void => openDrawer(<AgentDrawer id={id} />);
  const tones = new Set(nodes.map((n) => nodeTone(n.lifecycle)));
  // The key lists every kind that is on the graph, hidden or not: a kind that disappeared from the key when it was hidden could not be shown again.
  const kinds = kindsPresent(lines.drawable);
  // The messages of one line, in the Events console's own filters, which the person can see and clear there.
  const openMessages = (e: { from: string; to: string }): void => {
    const f = pairFilter(e.from, e.to);
    setEvFilter(f.filter);
    setEvSearch(f.search);
    setView("events");
  };
  return (
    <>
      {header(<span className="feed-meta">{err ? "Refresh failed. Showing the last drawing." : at ? `Drawn ${sinceText(now - Date.parse(at))}` : ""}</span>)}
      <Card variant="graph-wrap">
        {/* A group, not an image: an img has presentational children, and the seats inside are buttons. */}
        <svg className={`gr-svg${hot || near ? " focus" : ""}`} role="group" aria-label="Mesh graph: one button per agent, with lines for the messages between them" viewBox={`0 0 ${W} ${H}`}>
          <defs><marker id="ar" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L8 4L0 8z" fill="context-stroke" /></marker></defs>
          {lines.shown.map((e) => {
            const p = pos.get(e.from)!, q = pos.get(e.to)!;
            const dx = q.x - p.x, dy = q.y - p.y, dist = Math.hypot(dx, dy) || 1;
            const sx = p.x + (dx / dist) * 26, sy = p.y + (dy / dist) * 26;
            const ex = q.x - (dx / dist) * 30, ey = q.y - (dy / dist) * 30;
            const mx = (sx + ex) / 2 + dy * 0.14, my = (sy + ey) / 2 - dx * 0.14;
            const key = edgeKey(e);
            return (
              <path
                key={key}
                className={`edge ${kindOf(e.kind).id}${isFlowing(e, flowing) ? " flowing" : ""}${hot === key || near?.lines.has(key) ? " hot" : ""}`}
                d={`M ${sx} ${sy} Q ${mx} ${my} ${ex} ${ey}`}
                markerEnd="url(#ar)"
                strokeWidth={edgeWidth(e.count)}
              >
                <title>{edgeText(e)}</title>
              </path>
            );
          })}
          {nodes.map((nd) => {
            const s = pos.get(nd.id)!;
            const spot = labelPlacement(s.angle);
            const state = plainLifecycle(nd.lifecycle, where);
            return (
              <g
                key={nd.id}
                className={`gn ${nodeTone(nd.lifecycle)}${near && !near.seats.has(nd.id) ? " dim" : ""}`}
                data-id={nd.id}
                role="button"
                tabIndex={0}
                aria-label={`${nd.id}, ${state}. Open details.`}
                onClick={() => open(nd.id)}
                onKeyDown={rowKey(() => open(nd.id))}
                onMouseEnter={() => setSeat(nd.id)}
                onMouseLeave={() => setSeat((c) => (c === nd.id ? null : c))}
                onFocus={() => setSeat(nd.id)}
                onBlur={() => setSeat((c) => (c === nd.id ? null : c))}
              >
                <title>{nd.id}</title>
                <circle className="node" cx={s.x} cy={s.y} r={18} />
                <text className="init" x={s.x} y={s.y + 4} textAnchor="middle">{nd.id.slice(0, 2).toUpperCase()}</text>
                <text className="name" x={s.x + spot.name.dx} y={s.y + spot.name.dy} textAnchor={spot.anchor}>{middleClip(nd.id, 16)}</text>
                <text className="dim" x={s.x + spot.state.dx} y={s.y + spot.state.dy} textAnchor={spot.anchor}>{state}</text>
              </g>
            );
          })}
        </svg>

        {/* The legend says what the colours, the dashes and the rings mean, and lists only what is on the drawing. Each kind of line is
            a key: pressed, it is shown; pressed again, it is hidden, and the list below follows. */}
        <ul className="gr-legend" aria-label="Legend. Each kind of line is a button that shows or hides it.">
          {kinds.map((k) => (
            <li key={k.id}>
              <button
                type="button" className="gr-key" aria-pressed={!off.has(k.id)} aria-label={`Show lines: ${k.label}`}
                title={off.has(k.id) ? `Show the lines that ${k.label}` : `Hide the lines that ${k.label}`}
                onClick={() => setOff((o) => toggleKind(o, k.id))}
              >
                <i className={`gr-line ${k.id}`} aria-hidden="true" />{k.label}
              </button>
            </li>
          ))}
          <li><i className="gr-line dash" aria-hidden="true" />carried a message in the last {RECENT_EVENTS} events</li>
          {(["working", "waiting", "stopped", "paused", "idle"] as NodeTone[]).filter((t) => tones.has(t)).map((t) => (
            <li key={t}><i className={`gr-ring ${t}`} aria-hidden="true" />{t === "idle" && where.parked && !where.over ? "ready, idle or finished" : RING_WORD[t]}</li>
          ))}
        </ul>
      </Card>

      <Card title="Most active links">
        {lines.shown.length ? (
          <ul className="gr-links">
            {lines.shown.map((e) => {
              const key = edgeKey(e);
              return (
                <li key={key} className="gr-row">
                  {/* A button, so a line can be reached and highlighted from the keyboard. */}
                  <button
                    type="button"
                    className="gr-link"
                    aria-pressed={pin === key}
                    onClick={() => setPin(pin === key ? null : key)}
                    onMouseEnter={() => setHover(key)}
                    onMouseLeave={() => setHover((h) => (h === key ? null : h))}
                    onFocus={() => setHover(key)}
                    onBlur={() => setHover((h) => (h === key ? null : h))}
                  >
                    <i className={`gr-line ${kindOf(e.kind).id}`} aria-hidden="true" />
                    <span><b>{e.from}</b> <span className="muted">{kindOf(e.kind).verb}</span> <b>{e.to}</b></span>
                    <span className="muted gr-n">{e.count.toLocaleString("en-US")}</span>
                  </button>
                  <Button
                    variant="small" extra="gr-open" aria-label={`See the messages from ${e.from} to ${e.to} in Events`}
                    title={`Open Events with ${e.from}'s messages that name ${e.to}`} onClick={() => openMessages(e)}
                  >
                    See messages
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : <p className="muted">{lines.off ? "Every line is hidden by the key above." : "No messages between agents yet."}</p>}
        {lines.hidden ? <p className="gr-note muted">Showing the {lines.shown.length} busiest of {lines.shown.length + lines.hidden} links.</p> : null}
        {lines.off ? (
          <p className="gr-note muted">
            {lines.off} {lines.off === 1 ? "link is" : "links are"} hidden by the key. <Button variant="small" onClick={() => setOff(new Set())}>Show every kind</Button>
          </p>
        ) : null}
        {lines.withYou ? <p className="gr-note muted">{lines.withYou} {lines.withYou === 1 ? "link" : "links"} to or from you {lines.withYou === 1 ? "is" : "are"} not drawn.</p> : null}
      </Card>
    </>
  );
}
