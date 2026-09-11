/* Cross-session persistence: the draft store (survives view switches without
 * re-fetching the running mesh) plus localStorage mirrors for the draft + node
 * positions. The store is a module singleton with useSyncExternalStore
 * subscriptions; `model` is still mutated in place by the designer's edit
 * handlers, so every commit must replace the snapshot wrapper to notify. */

import { useSyncExternalStore } from "react";
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

const INITIAL: DraftState = {
  model: null, cur: null, layout: {},
  runningPath: "", runningRaw: null,
  saveMode: "copy", copyPath: "examples/my-mesh/mesh.yaml", loaded: false,
};

let snapshot: DraftState = INITIAL;
const listeners = new Set<() => void>();

export function subscribeDraft(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Stable between commits — safe as a useSyncExternalStore snapshot. */
export function getDraftSnapshot(): DraftState {
  return snapshot;
}

/** Replace the snapshot and notify subscribers. An updater receives the
 *  latest snapshot so concurrent handlers (e.g. drag moves) never drop each
 *  other's patch. */
export function commitDraft(patch: Partial<DraftState> | ((prev: DraftState) => Partial<DraftState>)): void {
  snapshot = { ...snapshot, ...(typeof patch === "function" ? patch(snapshot) : patch) };
  for (const l of listeners) l();
}

/** Subscribe the calling component to every draft commit. */
export function useDraft(): DraftState {
  return useSyncExternalStore(subscribeDraft, getDraftSnapshot);
}

/* ---------------- browser-local draft ---------------- */

const DRAFT_KEY = "mesh-designer-draft-v2";

export function storeDraft(): void {
  try {
    const { model, saveMode, copyPath } = snapshot;
    if (!model) return;
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ ts: Date.now(), model, saveMode, copyPath }));
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
