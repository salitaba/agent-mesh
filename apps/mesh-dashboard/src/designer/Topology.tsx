/* The canvas: seats as cards, wires as lines between them.
 *
 * It was one SVG with every part of every seat inside a role="button" group, and a second button (the boot dot) inside that, so a
 * screen reader met controls nested in controls (axe: nested-interactive x7), every wire was a role="button" carrying aria-selected,
 * which a button may not have (aria-allowed-attr x36, critical), and each of the 36 wires was a tab stop. Its labels were SVG text
 * painted over its own wires, and a seat's name could not be truncated.
 *
 * Now the cards are real buttons laid over an SVG that only draws wires and takes pointer hits. The cards are one tab stop (a roving
 * tabindex): arrows move between seats, Shift+arrow moves the seat, Enter opens it, W starts a wire from it, B flips whether it starts
 * with the mission. A wire is edited from the keyboard in the inspector (Communication), which is also where a screen reader finds it;
 * on the canvas it is a pointer shortcut. Geometry is in ./topology so it is tested, not eyeballed. */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject, type SetStateAction } from "react";
import { fmtNum, type Template } from "./model";
import "./topology.css";
import { EmptySeats, KeysHelp } from "./Guide";
import { CX, CY } from "./geom";
import { cardFor, displayPx, edgePoint, neighborInDirection, nudge, pairsOf, segment, stageHeight, storedFromPx, type Dir, type Pair, type Size } from "./topology";
import type { Wire } from "./edits";
import { ToolButton } from "./ui";
import { AgentAvatar, agentColor } from "../components";
import { Icon } from "../icons";
import { register, unregister } from "../commands";
import { useFocusMode } from "../shell";
import type { Pos } from "./types";

export type ConnectResult = "added" | "exists" | "refused";

export interface TopologyProps {
  seats: Record<string, any>;
  ids: string[];
  layout: Record<string, Pos>;
  setLayout: (next: SetStateAction<Record<string, Pos>>) => void;
  /** Called once a drag, a nudge or an arrange has settled: the place to save the layout. */
  persistLayout: () => void;
  current: string | null;
  starts: Set<string>;
  problems: (id: string) => boolean;
  wires: Wire[];
  onSelect: (id: string) => void;
  onConnect: (src: string, tgt: string) => ConnectResult;
  /** Remove wires by every route that makes them, as one step. */
  onCut: (cuts: Array<[string, string]>) => void;
  onToggleStart: (id: string) => void;
  onArrange: () => void;
  onAddSeat: () => void;
  /** Empty-canvas actions. The parent asks before it replaces a draft. */
  onTemplate: (t: Template) => void;
  onAsk: () => void;
}

const DIRS: Record<string, Dir> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
/** Stored units a Shift+arrow moves a seat, and a Shift+Alt+arrow. */
const NUDGE = 12;

/** The stage's size in pixels, measured before paint and kept current. */
function useStageSize(ref: RefObject<HTMLElement | null>): Size {
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = (): void => {
      const r = el.getBoundingClientRect();
      setSize((prev) => (prev.w === r.width && prev.h === r.height ? prev : { w: r.width, h: r.height }));
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

export default function Topology(props: TopologyProps): React.JSX.Element {
  const { seats, ids, layout, setLayout, persistLayout, current, starts, problems, wires, onSelect, onConnect, onCut, onToggleStart, onArrange, onAddSeat, onTemplate, onAsk } = props;
  const { focusMode, setFocusMode } = useFocusMode();
  const stageRef = useRef<HTMLDivElement | null>(null);
  const seatRefs = useRef(new Map<string, HTMLButtonElement>());
  const stage = useStageSize(stageRef);
  const card = cardFor(ids.length, stage.w || 760);

  const [wiring, setWiring] = useState(false);
  const [wireFrom, setWireFrom] = useState<string | null>(null);
  const [selPair, setSelPair] = useState<string | null>(null);
  const [guide, setGuide] = useState<{ from: string; to: Pos } | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const [tabStop, setTabStop] = useState<string | null>(null);
  const dragRef = useRef<{ id: string; sx: number; sy: number; at: Pos; moved: boolean } | null>(null);
  const justDragged = useRef(false);
  const handleRef = useRef<{ id: string; moved: boolean } | null>(null);

  const centers = useMemo(() => {
    const out: Record<string, Pos> = {};
    for (const id of ids) out[id] = displayPx(layout[id] ?? { x: CX, y: CY }, stage, card);
    return out;
  }, [ids, layout, stage, card]);

  const pairs = useMemo(() => pairsOf(wires, ids), [wires, ids]);
  const outgoing = useMemo(() => {
    const m = new Map<string, number>();
    for (const w of wires) m.set(w.src, (m.get(w.src) ?? 0) + 1);
    return m;
  }, [wires]);
  const activePair: Pair | null = pairs.find((p) => p.key === selPair) ?? null;

  const say = useCallback((msg: string) => setSaid(msg), []);

  // The one tab stop is the selected seat, else the last one focused, else the first.
  const stop = ids.includes(tabStop ?? "") ? tabStop : ids.includes(current ?? "") ? current : ids[0] ?? null;

  const focusSeat = useCallback((id: string) => {
    setTabStop(id);
    seatRefs.current.get(id)?.focus();
  }, []);

  // A seat or wire that no longer exists cannot stay selected.
  useEffect(() => {
    if (selPair && !pairs.some((p) => p.key === selPair)) setSelPair(null);
  }, [pairs, selPair]);
  useEffect(() => {
    if (wireFrom && !ids.includes(wireFrom)) setWireFrom(null);
  }, [ids, wireFrom]);
  useEffect(() => {
    setSelPair(null);
  }, [current]);

  const stopWiring = useCallback(() => {
    setWiring(false);
    setWireFrom(null);
    setGuide(null);
  }, []);

  // The palette's "Wire seats" lands here, so the command exists only while the canvas does.
  useEffect(() => {
    register("designer-wire", [{
      id: "designer.connect",
      label: "Wire seats",
      keywords: "connect link edge may message wire",
      scope: "designer",
      run: () => { setWiring(true); setWireFrom(null); setSelPair(null); say("Wiring. Pick the seat that sends."); },
    }]);
    return () => unregister("designer-wire");
  }, [say]);

  useEffect(() => {
    const typing = (t: EventTarget | null): boolean => {
      if (!(t instanceof HTMLElement)) return false;
      return /^(input|textarea|select)$/i.test(t.tagName) || t.isContentEditable;
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return;
      if (e.key === "Escape") {
        if (!wiring && !wireFrom && !selPair) return;
        e.preventDefault();
        stopWiring();
        setSelPair(null);
        say("Stopped.");
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && activePair && !typing(e.target)) {
        e.preventDefault();
        const cuts: Array<[string, string]> = [];
        if (activePair.ab) cuts.push([activePair.a, activePair.b]);
        if (activePair.ba) cuts.push([activePair.b, activePair.a]);
        onCut(cuts);
        setSelPair(null);
        say(`Cut the wire between ${activePair.a} and ${activePair.b}.`);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [wiring, wireFrom, selPair, activePair, onCut, stopWiring, say]);

  /* ---------------- choosing and wiring by click ---------------- */

  const pick = (id: string): void => {
    if (wiring) {
      if (!wireFrom) { setWireFrom(id); say(`Wiring from ${id}. Pick a seat it may message.`); return; }
      if (wireFrom === id) { setWireFrom(null); setGuide(null); say("Pick the seat that sends."); return; }
      const r = connect(wireFrom, id);
      if (r === "added") setWireFrom(id); // chain: carry on from the seat just wired
      return;
    }
    setSelPair(null);
    onSelect(id);
  };

  const connect = (src: string, tgt: string): ConnectResult => {
    const r = onConnect(src, tgt);
    say(r === "added" ? `${src} may now message ${tgt}.` : r === "exists" ? `${src} may already message ${tgt}.` : `${src} cannot be wired to ${tgt}.`);
    return r;
  };

  /* ---------------- dragging a seat ---------------- */

  const onSeatDown = (e: ReactPointerEvent<HTMLButtonElement>, id: string): void => {
    if (e.button !== 0 || wiring) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = { id, sx: e.clientX, sy: e.clientY, at: centers[id] ?? { x: 0, y: 0 }, moved: false };
  };
  const onSeatMove = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.moved && Math.hypot(dx, dy) < 5) return;
    d.moved = true;
    const next = storedFromPx({ x: d.at.x + dx, y: d.at.y + dy }, stage, card);
    setLayout((prev) => ({ ...prev, [d.id]: next }));
  };
  const onSeatUp = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    const d = dragRef.current;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (d?.moved) {
      // The click that follows a drag is the end of the drag, not a choice.
      justDragged.current = true;
      window.setTimeout(() => { justDragged.current = false; }, 0);
      persistLayout();
    }
  };

  /* ---------------- dragging a wire out of a seat ---------------- */

  const stagePoint = (e: { clientX: number; clientY: number }): Pos => {
    const r = stageRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };
  const seatUnder = (e: { clientX: number; clientY: number }): string | null => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    return el instanceof Element ? el.closest<HTMLElement>("[data-seat]")?.dataset.seat ?? null : null;
  };
  const onHandleDown = (e: ReactPointerEvent<HTMLButtonElement>, id: string): void => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    handleRef.current = { id, moved: false };
    e.stopPropagation();
  };
  const onHandleMove = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    const h = handleRef.current;
    if (!h) return;
    const p = stagePoint(e);
    const from = centers[h.id];
    if (!from) return;
    if (!h.moved && Math.hypot(p.x - from.x, p.y - from.y) < card.w / 2 + 14) return;
    h.moved = true;
    setGuide({ from: h.id, to: p });
    const over = seatUnder(e);
    setDropOn(over && over !== h.id ? over : null);
  };
  const onHandleUp = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    const h = handleRef.current;
    handleRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    setGuide(null);
    setDropOn(null);
    if (!h || !h.moved) return; // a plain click is handled by onClick: it starts wiring from this seat
    justDragged.current = true;
    window.setTimeout(() => { justDragged.current = false; }, 0);
    const over = seatUnder(e);
    if (over && over !== h.id) connect(h.id, over);
  };
  const startWiringFrom = (id: string): void => {
    setWiring(true);
    setWireFrom(id);
    setSelPair(null);
    say(`Wiring from ${id}. Pick a seat it may message.`);
  };

  /* ---------------- the keyboard ---------------- */

  const onSeatKey = (e: ReactKeyboardEvent<HTMLButtonElement>, id: string): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const dir = DIRS[e.key];
    if (dir) {
      e.preventDefault();
      if (e.shiftKey) {
        const at = layout[id] ?? { x: CX, y: CY };
        setLayout((prev) => ({ ...prev, [id]: nudge(at, dir, NUDGE, stage, card) }));
        persistLayout();
        say(`Moved ${id}.`);
        return;
      }
      const to = neighborInDirection(centers, ids, id, dir);
      if (to) focusSeat(to);
      return;
    }
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const to = e.key === "Home" ? ids[0] : ids[ids.length - 1];
      if (to) focusSeat(to);
      return;
    }
    const k = e.key.toLowerCase();
    if (k === "w") { e.preventDefault(); startWiringFrom(id); return; }
    if (k === "b") {
      e.preventDefault();
      const was = starts.has(id);
      onToggleStart(id);
      say(was ? `${id} no longer starts with the mission.` : `${id} now starts with the mission.`);
    }
  };

  /* ---------------- drawing ---------------- */

  const hint = wiring
    ? wireFrom ? `Wiring from ${wireFrom}. Pick a seat it may message, or press Esc to stop.` : "Wiring. Pick the seat that sends."
    : activePair ? "Wire selected. Press Delete to cut it, or Esc to let go." : "Drag a seat to move it. Select a seat to edit it.";

  const guideSeg = guide && centers[guide.from]
    ? (() => {
      const a = centers[guide.from]!;
      const start = edgePoint(a, guide.to, card, 4);
      return { from: start, to: guide.to };
    })()
    : null;

  const pairSegs = pairs.map((p) => {
    const a = centers[p.a];
    const b = centers[p.b];
    return { pair: p, seg: a && b ? segment(a, b, card, 6) : null };
  });

  return (
    <section className="card ms-canvas" aria-label="Team topology">
      <div className="ms-tools">
        <ToolButton icon="plus" label="Add seat" text onClick={onAddSeat} title="Add a seat to the team" />
        <ToolButton
          icon="graph" label={wiring ? "Wiring: pick two seats" : "Wire seats"} text pressed={wiring}
          title="Pick a seat that sends, then a seat it may message. Shortcut: W on a focused seat."
          onClick={() => { if (wiring) stopWiring(); else { setWiring(true); setWireFrom(null); setSelPair(null); say("Wiring. Pick the seat that sends."); } }}
        />
        <ToolButton icon="arrange" label="Arrange" text onClick={onArrange} title="Space the seats out again. Where seats sit is kept in this browser, not in mesh.yaml." disabled={ids.length < 2} />
        <ToolButton icon="expand" label="Focus" text pressed={focusMode} id="ms-focus-toggle" onClick={() => setFocusMode(!focusMode)} title="Hide the inspector and the notes below, and give the canvas the page" />
        <KeysHelp />
        <span className="ms-tool-hint" id="ms-canvas-hint">{hint}</span>
      </div>

      <div className="ms-stage-wrap">
        <div
          className={`ms-stage${wiring ? " wiring" : ""}`} ref={stageRef}
          style={{ "--card-w": `${card.w}px`, "--card-h": `${card.h}px`, aspectRatio: `1000 / ${stageHeight(1000)}` } as React.CSSProperties}
          onPointerDown={(e) => { if (e.target === e.currentTarget || (e.target as Element).closest(".ms-wires")) { if (wiring) { setWireFrom(null); setGuide(null); } else setSelPair(null); } }}
          onPointerMove={(e) => { if (wiring && wireFrom) setGuide({ from: wireFrom, to: stagePoint(e) }); }}
        >
          <svg className="ms-wires" width={stage.w} height={stage.h} viewBox={`0 0 ${stage.w || 1} ${stage.h || 1}`} aria-hidden="true">
            <defs>
              <marker id="ms-ar" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
                <path d="M1 1.2L9 5 1 8.8z" fill="context-stroke" />
              </marker>
            </defs>
            {pairSegs.map(({ pair, seg }) => {
              if (!seg) return null;
              const sel = selPair === pair.key;
              const rel = !!current && (pair.a === current || pair.b === current);
              const dim = !!current && !rel && !sel;
              const d = `M ${seg.from.x} ${seg.from.y} L ${seg.to.x} ${seg.to.y}`;
              return (
                <g key={pair.key} className={`ms-pair${sel ? " sel" : ""}${rel ? " rel" : ""}${dim ? " dim" : ""}`}>
                  <title>{wireTitle(pair)}</title>
                  <path className="hit" d={d} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); if (!wiring) setSelPair(sel ? null : pair.key); }} />
                  <path className="line" d={d} markerEnd={pair.ab ? "url(#ms-ar)" : undefined} markerStart={pair.ba ? "url(#ms-ar)" : undefined} />
                </g>
              );
            })}
            {guideSeg ? <path className="guide" d={`M ${guideSeg.from.x} ${guideSeg.from.y} L ${guideSeg.to.x} ${guideSeg.to.y}`} /> : null}
          </svg>

          {stage.w > 0 ? (
            <div className="ms-nodes" role="group" aria-label={`Seats: ${ids.length}. Wires: ${wires.length}.`}>
              {ids.map((id) => {
                const ag = seats[id] || {};
                const c = centers[id];
                if (!c) return null;
                const sel = id === current;
                const starting = starts.has(id);
                const bad = problems(id);
                const out = outgoing.get(id) ?? 0;
                const role = String(ag.role || "").trim();
                const label = `${id}, ${role || "no role"}.${starting ? " Starts with the mission." : ""}${ag.mode === "service" ? " Service seat." : ""}${bad ? " Has a problem." : ""} May message ${out} ${out === 1 ? "seat" : "seats"}.`;
                return (
                  <div
                    key={id} className={`ms-node${sel ? " sel" : ""}${wireFrom === id ? " from" : ""}${dropOn === id ? " drop" : ""}`}
                    style={{ left: c.x, top: c.y }}
                  >
                    <button
                      type="button" ref={(el) => { if (el) seatRefs.current.set(id, el); else seatRefs.current.delete(id); }}
                      className={`ms-seat${ag.mode === "service" ? " svc" : ""}${bad ? " err" : ""}`}
                      data-seat={id} aria-pressed={sel} aria-label={label}
                      aria-describedby={id === stop ? "ms-canvas-keys" : undefined}
                      tabIndex={id === stop ? 0 : -1}
                      title={`${id}: ${role || "no role"}. ${(ag.capabilities || []).length} tools, ${(ag.interests || []).length} wake events, ${fmtNum(ag.budget?.tokens ?? 200000)} tokens.`}
                      onFocus={() => setTabStop(id)}
                      onClick={() => { if (justDragged.current) return; pick(id); }}
                      onPointerDown={(e) => onSeatDown(e, id)} onPointerMove={onSeatMove} onPointerUp={onSeatUp} onPointerCancel={onSeatUp}
                      onKeyDown={(e) => onSeatKey(e, id)}
                    >
                      <AgentAvatar id={id} color={agentColor(role)} size="sm" />
                      <span className="ms-seat-text">
                        <span className="ms-seat-top">
                          <span className="nm">{id}</span>
                          {bad || starting ? (
                            <span className="ms-seat-flags" aria-hidden="true">
                              {bad ? <Icon name="alert" size={14} className="flag-bad" /> : null}
                              {starting ? <Icon name="play" size={12} className="flag-start" /> : null}
                            </span>
                          ) : null}
                        </span>
                        <span className="rl">{role || "no role"}{ag.mode === "service" ? " · service" : ""}</span>
                      </span>
                    </button>
                    <button
                      type="button" className="ms-handle" tabIndex={-1}
                      aria-label={`Wire from ${id} to another seat`} title={`Drag to another seat to let ${id} message it`}
                      onPointerDown={(e) => onHandleDown(e, id)} onPointerMove={onHandleMove} onPointerUp={onHandleUp} onPointerCancel={onHandleUp}
                      onClick={() => { if (!justDragged.current && !wiring) startWiringFrom(id); }}
                    >
                      <Icon name="arrow-right" size={12} />
                    </button>
                  </div>
                );
              })}
            </div>
          ) : null}

          {activePair ? <PairPills pair={activePair} segs={pairSegs.find((x) => x.pair.key === activePair.key)?.seg ?? null} onCut={(s, t) => { onCut([[s, t]]); say(`Cut ${s} to ${t}.`); }} /> : null}

          {!ids.length ? <EmptySeats onAddSeat={onAddSeat} onTemplate={onTemplate} onAsk={onAsk} /> : null}
        </div>
      </div>

      <p className="ms-stage-foot">
        <span><b>{ids.length}</b> {ids.length === 1 ? "seat" : "seats"} and <b>{wires.length}</b> {wires.length === 1 ? "wire" : "wires"}.</span>
        <span className="ms-legend"><Icon name="play" size={12} className="flag-start" /> starts with the mission</span>
        <span className="ms-legend"><Icon name="arrow-right" size={12} /> a wire: the arrow points at the seat that may be messaged</span>
      </p>

      <p className="sr-only" id="ms-canvas-keys">
        Arrow keys move between seats. Enter opens the seat in the inspector. Shift plus an arrow key moves the seat. W starts a wire from it, then pick another seat with the arrow keys and Enter. B flips whether it starts with the mission. Escape stops wiring. Wires are listed below and edited in the inspector under Communication.
      </p>
      <ul className="sr-only" aria-label="Wires">
        {wires.map((w) => <li key={`${w.src}>${w.tgt}`}>{w.src} may message {w.tgt}</li>)}
      </ul>
      <div className="sr-only" role="status" aria-live="polite">{said}</div>
    </section>
  );
}

function wireTitle(p: Pair): string {
  if (p.ab && p.ba) return `${p.a} and ${p.b} may message each other. Click to select the wire.`;
  return `${p.ab ? p.a : p.b} may message ${p.ab ? p.b : p.a}. Click to select the wire.`;
}

/** The buttons that cut a selected wire, at its middle. HTML, so they are real controls with a real focus ring. */
function PairPills({ pair, segs, onCut }: { pair: Pair; segs: { mid: Pos } | null; onCut: (src: string, tgt: string) => void }): React.JSX.Element | null {
  if (!segs) return null;
  const two = pair.ab && pair.ba;
  return (
    <div className="ms-pills" style={{ left: segs.mid.x, top: segs.mid.y }} role="group" aria-label="Cut this wire">
      {pair.ab ? <button type="button" className="ms-cut" onClick={() => onCut(pair.a, pair.b)}><Icon name="x" size={12} />{two ? `Cut ${pair.a} to ${pair.b}` : "Cut wire"}</button> : null}
      {pair.ba ? <button type="button" className="ms-cut" onClick={() => onCut(pair.b, pair.a)}><Icon name="x" size={12} />{two ? `Cut ${pair.b} to ${pair.a}` : "Cut wire"}</button> : null}
    </div>
  );
}
