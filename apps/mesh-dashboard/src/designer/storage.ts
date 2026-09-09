/* Cross-session persistence: the module-level draft (survives view switches
 * without re-fetching the running mesh) and localStorage mirrors for the
 * draft + node positions. */

import { CX, CY } from "./geom";
import type { Pos, SaveTarget } from "./types";

export interface DraftState {
  model: any | null;
  cur: string | null;
  layout: Record<string, Pos>;
  runningPath: string;
  runningRaw: any | null;
  saveMode: SaveTarget;
  copyPath: string;
  loaded: boolean;
}

/* Module-level draft so switching views doesn't lose work. Mutate in place,
 * then notify the Designer so it re-renders. */
export const draft: DraftState = {
  model: null, cur: null, layout: {},
  runningPath: "", runningRaw: null,
  saveMode: "copy", copyPath: "examples/my-mesh/mesh.yaml", loaded: false,
};

/* ---------------- browser-local draft ---------------- */

const DRAFT_KEY = "mesh-designer-draft-v2";

export function storeDraft(): void {
  try {
    if (!draft.model) return;
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ ts: Date.now(), model: draft.model, saveMode: draft.saveMode, copyPath: draft.copyPath }));
  } catch {
    /* storage may be unavailable */
  }
}

export function readStored(): { ts: number; model: any; saveMode?: SaveTarget; copyPath?: string } | null {
  try {
    const s = JSON.parse(String(localStorage.getItem(DRAFT_KEY) || "null"));
    return s && s.model ? s : null;
  } catch {
    return null;
  }
}

export function clearStored(): void {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* noop */
  }
}

/* ---------------- node positions ---------------- */

export function layoutKey(meshId: string): string {
  return `mesh-designer-layout:${meshId || "default"}`;
}

function circleLayout(ids: string[]): Record<string, Pos> {
  const out: Record<string, Pos> = {};
  const n = ids.length;
  if (!n) return out;
  const R = n === 1 ? 0 : Math.min(255, 110 + n * 22);
  ids.forEach((id, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    out[id] = { x: CX + R * Math.cos(a), y: CY + R * 0.72 * Math.sin(a) };
  });
  return out;
}

/** Saved positions win where they exist; everything else sits on a circle. */
export function loadLayout(meshId: string, ids: string[]): Record<string, Pos> {
  let saved: Record<string, Pos> = {};
  try {
    saved = JSON.parse(String(localStorage.getItem(layoutKey(meshId)) || "{}"));
  } catch {
    saved = {};
  }
  const out = circleLayout(ids);
  for (const id of ids) if (saved[id] && Number.isFinite(saved[id].x) && Number.isFinite(saved[id].y)) out[id] = saved[id];
  return out;
}

export function saveLayout(meshId: string, layout: Record<string, Pos>): void {
  try {
    localStorage.setItem(layoutKey(meshId), JSON.stringify(layout));
  } catch {
    /* noop */
  }
}

/** A fresh ring layout, used by "arrange" and as the base for new meshes. */
export function ringLayout(ids: string[]): Record<string, Pos> {
  return circleLayout(ids);
}
