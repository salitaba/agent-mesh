import { useEffect, useState } from "react";
import { api } from "../api";
import { plainLifecycle, RUNNING } from "../format";
import { useMesh } from "../store";
import { Card, ErrorState, rowKey } from "../components";
import { AgentDrawer } from "../drawers";

const KINDS: Array<[string, string, string]> = [
  ["REQUEST", "asked for help", "accent"],
  ["APPROVE", "approved", "ok"],
  ["BLOCK", "blocked", "bad"],
  ["ESCALATE", "escalated", "warn"],
  ["INFORM", "updated", "info"],
];
const KIND_VERB: Record<string, string> = { REQUEST: "asked", APPROVE: "approved", BLOCK: "blocked", ESCALATE: "escalated", INFORM: "updated", OTHER: "messaged" };

export default function Graph(): React.JSX.Element {
  const { events, openDrawer } = useMesh();
  const [graph, setGraph] = useState<any>(null);
  // A swallowed catch here left `graph` null forever, so a dead server was
  // indistinguishable from a slow one: the view said "loading graph" until
  // the tab was closed. Failure is now a state, and it is retryable.
  const [err, setErr] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let dead = false;
    setErr(null);
    api("GET", "/graph").then(({ json, timeout }) => {
      if (dead) return;
      if (timeout || !json || json.error) {
        setErr(timeout ? "the request timed out — the server may be busy." : String(json?.error ?? "the mesh server did not answer."));
        return;
      }
      setGraph(json);
    }).catch((e: unknown) => {
      if (!dead) setErr(e instanceof Error ? e.message : String(e));
    });
    return () => {
      dead = true;
    };
  }, [attempt]);

  if (err && !graph) return <ErrorState what="the graph" detail={err} onRetry={() => setAttempt((n) => n + 1)} />;
  if (!graph) return <div className="empty"><div className="big">…</div><div>loading graph</div></div>;
  const recentFlows = new Set(
    events.slice(-40).filter((e) => e.type === "message.sent").map((e) => `${e.payload?.message?.from}|${e.payload?.message?.to?.join(",")}`),
  );
  const nodes = (graph.nodes || []).filter((n: any) => n.id !== "human");
  // Zero agents used to render an empty 900x480 SVG: a blank rectangle that
  // looks like a broken canvas rather than an empty mesh.
  if (!nodes.length) {
    return (
      <>
        <div className="view-title"><h2>Graph</h2></div>
        <div className="view-sub">Who talks to whom. Thicker = more messages. Dashed = active right now. Click an agent for details.</div>
        <Card><div className="empty"><div className="big">◎</div><div>No agents in this mesh yet.</div><div className="muted">Hire a crew in the designer and the graph draws itself.</div></div></Card>
      </>
    );
  }
  const W = 900, H = 480, cx = W / 2, cy = H / 2;
  const R = Math.min(W, H) / 2 - 60;
  const pos: Record<string, { x: number; y: number; nd: any }> = {};
  const n = Math.max(nodes.length, 1);
  nodes.forEach((nd: any, i: number) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    pos[nd.id] = { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a), nd };
  });
  const edges = (graph.edges || []).slice().sort((a: any, b: any) => b.count - a.count).slice(0, 12);

  return (
    <>
      <div className="view-title"><h2>Graph</h2></div>
      <div className="view-sub">Who talks to whom. Thicker = more messages. Dashed = active right now. Click an agent for details.</div>
      <Card variant="graph-wrap">
        <svg id="graph-svg" role="img" aria-label="mesh graph" viewBox={`0 0 ${W} ${H}`}>
          <defs><marker id="ar" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L8 4L0 8z" fill="context-stroke" /></marker></defs>
          {(graph.edges || []).map((e: any, i: number) => {
            const p = pos[e.from], q = pos[e.to];
            if (!p || !q) return null;
            const dx = q.x - p.x, dy = q.y - p.y, dist = Math.hypot(dx, dy) || 1;
            const sx = p.x + (dx / dist) * 26, sy = p.y + (dy / dist) * 26;
            const ex = q.x - (dx / dist) * 30, ey = q.y - (dy / dist) * 30;
            const mx = (sx + ex) / 2 + dy * 0.14, my = (sy + ey) / 2 - dx * 0.14;
            const flow = [...recentFlows].some((f) => f.startsWith(`${e.from}|`) && f.includes(e.to));
            return <path key={i} className={`edge ${e.kind}${flow ? " flowing" : ""}`} d={`M ${sx} ${sy} Q ${mx} ${my} ${ex} ${ey}`} markerEnd="url(#ar)" strokeWidth={Math.min(4, 1 + e.count * 0.4)}><title>{`${e.from} ${e.kind} ${e.to} ×${e.count}`}</title></path>;
          })}
          {Object.keys(pos).map((id) => {
            const { x, y, nd } = pos[id];
            const cls = RUNNING.has(nd.lifecycle) ? "active" : nd.lifecycle === "WAITING" ? "waiting" : "";
            return (
              <g key={id} className="gn" data-id={id} style={{ cursor: "pointer" }} role="button" tabIndex={0} aria-label={`${id}, ${plainLifecycle(nd.lifecycle)} — open details`} onClick={() => openDrawer(<AgentDrawer id={id} />)} onKeyDown={rowKey(() => openDrawer(<AgentDrawer id={id} />))}>
                <circle className={`node ${cls}`} cx={x} cy={y} r={18} />
                <text x={x} y={y + 4} textAnchor="middle" style={{ font: "600 11px var(--mono)", fill: "var(--text)" }}>{id.slice(0, 2).toUpperCase()}</text>
                <text x={x} y={y + 34} textAnchor="middle">{id}</text>
                <text className="dim" x={x} y={y - 26} textAnchor="middle">{plainLifecycle(nd.lifecycle)}</text>
              </g>
            );
          })}
        </svg>
        <div className="legend" style={{ marginTop: 8 }}>{KINDS.map(([k, label, v]) => <span key={k}><b style={{ background: `var(--${v})` }} />{label}</span>)}</div>
      </Card>
      <Card title="Most active links" style={{ marginTop: 12 }}>
        {edges.length ? edges.map((e: any, i: number) => <div key={i} className="row" style={{ justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid var(--line)" }}><span><b>{(e.from)}</b> <span className="muted">{(KIND_VERB[e.kind] || "messaged")}</span> <b>{(e.to)}</b></span><span className="muted">×{e.count}</span></div>) : <div className="muted">No messages yet.</div>}
      </Card>
    </>
  );
}
