/* Cross-session persistence: the draft store (survives view switches without
 * re-fetching the running mesh) plus localStorage mirrors for the draft + node
 * positions. The store is a module singleton with useSyncExternalStore
 * subscriptions; `model` is still mutated in place by the designer's edit
 * handlers, so every commit must replace the snapshot wrapper to notify.
 *
 * The undo history lives here too, for the same reason the draft does: it used to
 * be component state, so leaving the Designer forgot every step. */

import { useSyncExternalStore } from "react";
import { emptyHistory, type History } from "./history";
import { defaultLayout } from "./topology";
import type { Pos } from "./types";

export interface DraftState {
  model: any | null;
  cur: string | null;
  layout: Record<string, Pos>;
  /** Absolute path of the project's mesh.yaml, "" when no file is known. */
  runningPath: string;
  /** The file as the server last returned it: what the draft is compared with and saved over. */
  runningRaw: any | null;
  /** Where "Save a copy" writes, relative to the project folder; "" until the person picks. */
  copyPath: string;
  loaded: boolean;
  history: History;
}

const INITIAL: DraftState = {
  model: null, cur: null, layout: {},
  runningPath: "", runningRaw: null,
  copyPath: "", loaded: false,
  history: emptyHistory(),
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
    const { model, copyPath } = snapshot;
    if (!model) return;
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ ts: Date.now(), model, copyPath }));
  } catch {
    /* storage may be unavailable */
  }
}

export function readStored(): { ts: number; model: any; copyPath?: string } | null {
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

/** Saved positions win where they exist; everything else is placed by the default arrangement. */
export function loadLayout(meshId: string, ids: string[]): Record<string, Pos> {
  let saved: Record<string, Pos> = {};
  try {
    saved = JSON.parse(String(localStorage.getItem(layoutKey(meshId)) || "{}"));
  } catch {
    saved = {};
  }
  const out = defaultLayout(ids);
  for (const id of ids) if (saved[id] && Number.isFinite(saved[id].x) && Number.isFinite(saved[id].y)) out[id] = saved[id];
  return out;
}

/** Positions are saved for the seats that exist: a seat that was deleted does not leave a stale place behind. */
export function saveLayout(meshId: string, layout: Record<string, Pos>, ids?: string[]): void {
  try {
    const keep = ids ? Object.fromEntries(Object.entries(layout).filter(([id]) => ids.includes(id))) : layout;
    localStorage.setItem(layoutKey(meshId), JSON.stringify(keep));
  } catch {
    /* noop */
  }
}

/** A fresh default arrangement, used by "Arrange" and as the base for new meshes. */
export function ringLayout(ids: string[]): Record<string, Pos> {
  return defaultLayout(ids);
}

/* ---------------- small preferences ---------------- */

const GUIDE_KEY = "mesh-designer-guide-hidden";

export function guideHidden(): boolean {
  try {
    return localStorage.getItem(GUIDE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setGuideHidden(hidden: boolean): void {
  try {
    if (hidden) localStorage.setItem(GUIDE_KEY, "1");
    else localStorage.removeItem(GUIDE_KEY);
  } catch {
    /* noop */
  }
}
