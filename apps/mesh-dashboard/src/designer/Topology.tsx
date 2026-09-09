/* Topology canvas: SVG org-chart with drag-to-arrange, click-to-inspect,
 * wiring mode (click two agents to add a "may message" edge) and hover-to-cut
 * edges. All layout math happens here; the model only changes via callbacks. */

import { useEffect, useRef, useState } from "react";
import { CX, CY, H, NODE_R, W } from "./geom";
import { clamp, fmtNum, TEMPLATES } from "./model";
import { saveLayout, draft } from "./storage";
import { hueVar } from "./ui";
import { Button } from "../components";
import type { Pos } from "./types";

export interface TopologyProps {
  agents: Record<string, any>;
  ids: string[];
  layout: Record<string, Pos>;
  setLayout: (l: Record<string, Pos>) => void;
  current: string | null;
  startup: Set<string>;
  meshId: string | undefined;
  hasError: (id: string) => boolean;
  /** Pairs already wired; edges render from this, direction = may message. */
  links: Array<{ src: string; tgt: string }>;
  onSelect: (id: string) => void;
  /** Toggle a may-message wire between two agents. */
  onWire: (src: string, tgt: string) => void;
  onCut: (src: string, tgt: string) => void;
  onBoot: (id: string) => void;
  onArrange: () => void;
  /** Empty-canvas actions (parent handles dirty-confirm). */
  onTemplate: (model: any) => void;
  onAddAgent: () => void;
}

export default function Topology(props: TopologyProps): React.JSX.Element {
  const { agents, ids, layout, setLayout, current, startup, meshId, hasError, links, onSelect, onWire, onCut, onBoot, onArrange, onTemplate, onAddAgent } = props;
  const [wiring, setWiring] = useState(false);
  const [wireFrom, setWireFrom] = useState<string | null>(null);
  const [mouse, setMouse] = useState<Pos | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setWiring(false);
        setWireFrom(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const svgPoint = (e: { clientX: number; clientY: number }): Pos => {
    const svg = svgRef.current;
    const mtx = svg?.getScreenCTM?.();
    if (!svg || !mtx) return { x: CX, y: CY };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(mtx.inverse());
    return { x: p.x, y: p.y };
  };

  const nodeClick = (id: string) => {
    if (wiring) {
      if (!wireFrom) setWireFrom(id);
      else if (wireFrom === id) setWireFrom(null);
      else {
        onWire(wireFrom, id);
        setWireFrom(id); // chain: keep wiring from the node you just linked
      }
    } else {
      onSelect(id);
    }
  };

  const nodeDown = (ev: React.PointerEvent, id: string) => {
    ev.stopPropagation();
    ev.preventDefault();
    const start = svgPoint(ev);
    const pos0 = layout[id] || { x: CX, y: CY };
    let moved = false;
    const move = (e: PointerEvent) => {
      const p = svgPoint(e);
      if (!moved && Math.hypot(p.x - start.x, p.y - start.y) > 5) moved = true;
      if (moved) setLayout({ ...layout, [id]: { x: clamp(p.x - (start.x - pos0.x), NODE_R + 4, W - NODE_R - 4), y: clamp(p.y - (start.y - pos0.y), NODE_R + 4, H - NODE_R - 4) } });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (moved) {
        // setLayout kept draft.layout in sync while dragging; persist the final ring.
        if (meshId) saveLayout(meshId, draft.layout);
      } else nodeClick(id);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const edgeGeom = (a: Pos, b: Pos, paired: boolean) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1;
    const ux = dx / d;
    const uy = dy / d;
    const sx = a.x + ux * (NODE_R + 4);
    const sy = a.y + uy * (NODE_R + 4);
    const ex = b.x - ux * (NODE_R + 10);
    const ey = b.y - uy * (NODE_R + 10);
    const k = paired ? 0.16 : 0.07;
    const mx = (sx + ex) / 2 + dy * k;
    const my = (sy + ey) / 2 - dx * k;
    return { path: `M ${sx} ${sy} Q ${mx} ${my} ${ex} ${ey}`, mid: { x: 0.25 * sx + 0.5 * mx + 0.25 * ex, y: 0.25 * sy + 0.5 * my + 0.25 * ey } };
  };

  return (
    <section className="card ms-canvas" aria-label="mesh topology">
      <div className="ms-tools">
        <Button variant="small" extra={wiring ? "wire-on" : undefined} aria-pressed={wiring} onClick={() => { setWiring(!wiring); setWireFrom(null); }}>
          {wiring ? "✎ wiring — click two agents" : "✎ wire agents"}
        </Button>
        <Button variant="small" onClick={onArrange} title="re-space everyone in a ring">⌾ arrange</Button>
        <span className="ms-tool-hint muted">
          {wiring ? (wireFrom ? `linking FROM “${wireFrom}” — click a target (Esc cancels)` : "pick the sender first") : "drag to arrange · click to inspect · hover an arrow to cut it"}
        </span>
        <span className="ms-canvas-count muted" aria-hidden="true">{ids.length} agent{ids.length === 1 ? "" : "s"}{links.length ? ` · ${links.length} wire${links.length === 1 ? "" : "s"}` : ""}</span>
      </div>
      <svg ref={svgRef} className={`ms-svg${wiring ? " wiring" : ""}`} viewBox={`0 0 ${W} ${H}`} role="application"
        aria-label="mesh topology: agents and who may message whom"
        onPointerMove={(e) => { if (wireFrom) setMouse(svgPoint(e.nativeEvent)); }}
        onPointerDown={() => { if (wiring) setWireFrom(null); }}>
        <defs>
          <pattern id="ms-dots" width="26" height="26" patternUnits="userSpaceOnUse">
            <circle cx="1.5" cy="1.5" r="1" fill="var(--line)" opacity="0.55" />
          </pattern>
          <marker id="ms-ar" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto">
            <path d="M0 0L8 4L0 8z" fill="context-stroke" />
          </marker>
        </defs>
        <rect x="0" y="0" width={W} height={H} fill="url(#ms-dots)" />
        {links.map(({ src, tgt }) => {
          const a = layout[src];
          const b = layout[tgt];
          if (!a || !b) return null;
          const paired = links.some((l) => l.src === tgt && l.tgt === src);
          const g = edgeGeom(a, b, paired);
          return (
            <g key={`${src}→${tgt}`} className="tedge">
              <title>{`${src} may message ${tgt} — click × to cut`}</title>
              <path className="tedge-hit" d={g.path} />
              <path className={`tedge-line${paired ? " paired" : ""}`} d={g.path} markerEnd="url(#ms-ar)" />
              <g className="edel" transform={`translate(${g.mid.x} ${g.mid.y})`} onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); onCut(src, tgt); }} role="button" tabIndex={-1} aria-label={`cut wire ${src} to ${tgt}`}>
                <circle r="8" />
                <text y="3.5">×</text>
              </g>
            </g>
          );
        })}
        {wireFrom && mouse && layout[wireFrom] ? <path className="guide" d={`M ${layout[wireFrom].x} ${layout[wireFrom].y} L ${mouse.x} ${mouse.y}`} /> : null}
        {ids.map((id) => {
          const p = layout[id] || { x: CX, y: CY };
          const ag = agents[id] || {};
          const sel = id === current;
          const fromNode = id === wireFrom;
          const boot = startup.has(id);
          const err = hasError(id);
          return (
            <g key={id} style={hueVar(id)}
              className={`tnode${sel ? " sel" : ""}${ag.mode === "service" ? " svc" : ""}${err ? " err" : ""}${fromNode ? " from" : ""}`}
              transform={`translate(${p.x} ${p.y})`} onPointerDown={(e) => nodeDown(e, id)}
              tabIndex={0} role="button" aria-label={`${id}, ${ag.role || "no role"}${boot ? ", boots at startup" : ""}`}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); nodeClick(id); } }}>
              <title>{`${id} — ${ag.role || "?"}\ncaps ${(ag.capabilities || []).length} · wakes ${(ag.interests || []).length} · ${fmtNum(ag.budget?.tokens ?? 200000)} tokens`}</title>
              {ag.mode === "service" ? <circle className="ring" r={NODE_R + 7} /> : null}
              <circle className="body" r={NODE_R} />
              <text className="av" y="5">{(id[0] || "?").toUpperCase()}</text>
              <text className="nm" y={NODE_R + 18}>{id}</text>
              <text className="rl" y={NODE_R + 32}>{ag.role || "no role"}</text>
              <circle className={`bboot${boot ? " on" : ""}`} cx={NODE_R - 10} cy={-(NODE_R - 10)} r={8}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); onBoot(id); }}
                role="button" aria-label={`toggle boot for ${id}`}>
                <title>{boot ? `${id} boots at startup — click to stop` : `${id} does not boot — click to boot at startup`}</title>
              </circle>
              {err ? <circle className="err-mark" cx={-(NODE_R - 10)} cy={-(NODE_R - 10)} r={8}><title>has a validation error</title></circle> : null}
              {err ? <text className="errmark" x={-(NODE_R - 10)} y={-(NODE_R - 4)}>!</text> : null}
            </g>
          );
        })}
      </svg>
      {!ids.length ? (
        <div className="ms-empty">
          <div className="empty"><div className="big">⚒</div><div>this mesh has no crew yet — start from a template or hire one agent.</div></div>
          <div className="chips" style={{ justifyContent: "center" }}>
            {TEMPLATES.map((t) => (
              <button key={t.key} className="chip-toggle" onClick={() => onTemplate(t.make())}>{t.name} — {t.desc}</button>
            ))}
            <button className="chip-toggle on" onClick={onAddAgent}>+ or start from one agent</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
