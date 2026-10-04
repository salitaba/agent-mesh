/* The canvas's arithmetic, with no DOM in it.
 *
 * Seats are stored in `W` by `H` units (geom.ts) because a saved position is an absolute coordinate and has to mean the same
 * thing on every screen. Cards are drawn in CSS pixels, because text that scales with the canvas is unreadable on a small one.
 * Everything here converts between the two, keeps a card inside the stage, finds where a wire meets a card, finds the next seat in
 * a direction for the keyboard, and finds a free place for a new seat. It exists so those rules can be tested instead of eyeballed:
 * the old canvas drew its wires to the middle of a circle, its labels on top of its wires, and put a new seat wherever the count
 * happened to land. */

import { CX, CY, H, W } from "./geom";
import type { Pos } from "./types";

export interface Size { w: number; h: number }

/** A card, in CSS pixels. The compact one is for a crowded or a narrow stage. */
export const CARD_REGULAR: Size = { w: 156, h: 56 };
export const CARD_COMPACT: Size = { w: 132, h: 48 };
/** The most seats that still read well as full cards on a stage of ordinary width. */
export const REGULAR_UP_TO = 8;
/** Below this stage width the cards go compact whatever the count. */
export const NARROW_STAGE = 700;

export function cardFor(seats: number, stageWidth: number): Size {
  return seats > REGULAR_UP_TO || stageWidth < NARROW_STAGE ? CARD_COMPACT : CARD_REGULAR;
}

/** The stage's height for a width: the unit space has one aspect ratio, so the canvas keeps it. */
export const stageHeight = (width: number): number => (width * H) / W;

export const toPx = (p: Pos, stage: Size): Pos => ({ x: (p.x * stage.w) / W, y: (p.y * stage.h) / H });
export const toUnits = (p: Pos, stage: Size): Pos => ({ x: (p.x * W) / stage.w, y: (p.y * H) / stage.h });

const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);

/** Keep a card's centre where the whole card stays inside the stage. A stage smaller than a card centres it. */
export function clampCenter(p: Pos, stage: Size, card: Size, margin = 6): Pos {
  const mx = card.w / 2 + margin;
  const my = card.h / 2 + margin;
  return {
    x: stage.w <= mx * 2 ? stage.w / 2 : clamp(p.x, mx, stage.w - mx),
    y: stage.h <= my * 2 ? stage.h / 2 : clamp(p.y, my, stage.h - my),
  };
}

/** Where a seat is drawn, in pixels: its stored position, held inside the stage as it is now. The stored one is never rewritten for this. */
export const displayPx = (p: Pos, stage: Size, card: Size): Pos => clampCenter(toPx(p, stage), stage, card);

/** A pixel position back to stored units, held inside the stage. */
export const storedFromPx = (p: Pos, stage: Size, card: Size): Pos => {
  const c = clampCenter(p, stage, card);
  const u = toUnits(c, stage);
  return { x: Math.round(u.x * 10) / 10, y: Math.round(u.y * 10) / 10 };
};

/* ---------------------------------------------------------------- default layout */

/** A tidy starting arrangement: by hand for one to four seats, then an ellipse that grows with the count and stops growing at the stage. */
export function defaultLayout(ids: string[]): Record<string, Pos> {
  const n = ids.length;
  const out: Record<string, Pos> = {};
  if (!n) return out;
  const at = (i: number, x: number, y: number): void => { out[ids[i]!] = { x: CX + x, y: CY + y }; };
  if (n === 1) at(0, 0, 0);
  else if (n === 2) { at(0, -170, 0); at(1, 170, 0); }
  else if (n === 3) { at(0, 0, -130); at(1, -230, 110); at(2, 230, 110); }
  else if (n === 4) { at(0, -200, -110); at(1, 200, -110); at(2, 200, 110); at(3, -200, 110); }
  else {
    const rx = Math.min(380, 190 + n * 22);
    const ry = Math.min(232, 110 + n * 14);
    ids.forEach((_, i) => {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      at(i, rx * Math.cos(a), ry * Math.sin(a));
    });
  }
  for (const id of ids) out[id] = { x: Math.round(out[id]!.x * 10) / 10, y: Math.round(out[id]!.y * 10) / 10 };
  return out;
}

/* ---------------------------------------------------------------- wires */

export interface Pair {
  key: string;
  a: string;
  b: string;
  /** `a` may message `b`. */
  ab: boolean;
  /** `b` may message `a`. */
  ba: boolean;
}

/** Wires folded into one line per pair of seats, an arrowhead at each end that has a direction. Order follows `order`, so keys are stable. */
export function pairsOf(wires: Array<{ src: string; tgt: string }>, order: string[]): Pair[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  const byKey = new Map<string, Pair>();
  for (const { src, tgt } of wires) {
    if (src === tgt) continue;
    const swap = (rank.get(src) ?? 0) > (rank.get(tgt) ?? 0);
    const a = swap ? tgt : src;
    const b = swap ? src : tgt;
    const key = `${a}\u0000${b}`;
    const p = byKey.get(key) ?? { key, a, b, ab: false, ba: false };
    if (swap) p.ba = true; else p.ab = true;
    byKey.set(key, p);
  }
  return [...byKey.values()];
}

/** The point where a line from a card's centre toward `to` leaves the card, pushed `gap` further out. */
export function edgePoint(from: Pos, to: Pos, card: Size, gap = 0): Pos {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return { ...from };
  const ux = dx / d;
  const uy = dy / d;
  const t = Math.min(ux !== 0 ? card.w / 2 / Math.abs(ux) : Infinity, uy !== 0 ? card.h / 2 / Math.abs(uy) : Infinity);
  return { x: from.x + ux * (t + gap), y: from.y + uy * (t + gap) };
}

export interface Segment { from: Pos; to: Pos; mid: Pos }

/** The visible part of a wire between two cards, or null when they touch or overlap and there is nothing to draw. */
export function segment(a: Pos, b: Pos, card: Size, gap = 5): Segment | null {
  const from = edgePoint(a, b, card, gap);
  const to = edgePoint(b, a, card, gap);
  const total = Math.hypot(b.x - a.x, b.y - a.y);
  if (Math.hypot(to.x - from.x, to.y - from.y) < 6 || Math.hypot(from.x - a.x, from.y - a.y) + Math.hypot(to.x - b.x, to.y - b.y) >= total) return null;
  return { from, to, mid: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 } };
}

/* ---------------------------------------------------------------- keyboard */

export type Dir = "left" | "right" | "up" | "down";

const VEC: Record<Dir, Pos> = { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, up: { x: 0, y: -1 }, down: { x: 0, y: 1 } };

/**
 * The seat to move focus to when an arrow is pressed: the nearest one in that direction, weighting a seat that is lined up over one
 * that is merely closer. With nothing that way it wraps in list order (right and down go forward, left and up go back), so the arrows
 * can always reach every seat. Null only when there is one seat.
 */
export function neighborInDirection(centers: Record<string, Pos>, order: string[], from: string, dir: Dir): string | null {
  const here = centers[from];
  if (!here || order.length < 2) return null;
  const v = VEC[dir];
  let best: string | null = null;
  let bestScore = Infinity;
  for (const id of order) {
    const p = centers[id];
    if (id === from || !p) continue;
    const dx = p.x - here.x;
    const dy = p.y - here.y;
    const along = dx * v.x + dy * v.y;
    const across = Math.abs(dx * v.y - dy * v.x);
    if (along <= 4) continue;
    const score = along + 1.8 * across;
    if (score < bestScore) { bestScore = score; best = id; }
  }
  if (best) return best;
  const i = order.indexOf(from);
  const step = dir === "right" || dir === "down" ? 1 : -1;
  return order[(i + step + order.length) % order.length] ?? null;
}

/** A seat moved by an arrow key: `step` stored units, held inside the stage. */
export function nudge(p: Pos, dir: Dir, step: number, stage: Size, card: Size): Pos {
  const v = VEC[dir];
  const moved = toPx({ x: p.x + v.x * step, y: p.y + v.y * step }, stage);
  return storedFromPx(moved, stage, card);
}

/* ---------------------------------------------------------------- a place for a new seat */

const overlaps = (a: Pos, b: Pos, card: Size, pad: number): boolean => Math.abs(a.x - b.x) < card.w + pad && Math.abs(a.y - b.y) < card.h + pad;

/**
 * The nearest free place to `anchor` (the middle of the stage unless told) where a new card overlaps no existing one, searched
 * outward on a grid the size of a card. Positions are stored units; `stage` and `card` give the pixels the overlap is judged in.
 */
export function freeSpot(layout: Record<string, Pos>, stage: Size, card: Size, anchor: Pos = { x: CX, y: CY }): Pos {
  const taken = Object.values(layout).map((p) => toPx(p, stage));
  const center = toPx(anchor, stage);
  const stepX = card.w + 14;
  const stepY = card.h + 14;
  let best: Pos | null = null;
  let bestD = Infinity;
  for (let ring = 0; ring <= 6; ring++) {
    for (let gx = -ring; gx <= ring; gx++) {
      for (let gy = -ring; gy <= ring; gy++) {
        if (Math.max(Math.abs(gx), Math.abs(gy)) !== ring) continue;
        const p = clampCenter({ x: center.x + gx * stepX, y: center.y + gy * stepY }, stage, card);
        if (taken.some((t) => overlaps(p, t, card, 8))) continue;
        const d = Math.hypot(p.x - center.x, p.y - center.y);
        if (d < bestD) { bestD = d; best = p; }
      }
    }
    if (best) break;
  }
  return storedFromPx(best ?? center, stage, card);
}
