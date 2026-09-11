/* Shared types for the Mesh Studio (Designer) module. */

export type Pos = { x: number; y: number };

/** Inspector tabs. Errors route to the tab that owns the offending field;
 *  "chat" is proposal-only and owns no fields (its count stays zero). */
export type Tab = "crew" | "mesh" | "policy" | "chat";

/** Where a save goes: overwrite the mesh the console runs, or a new file. */
export type SaveTarget = "running" | "copy";

/**
 * Everything a sub-panel needs to read + mutate the model. The model object
 * itself (`m`) is mutated in place; every mutation must end with `touch()`
 * so the Designer re-renders, re-validates and re-stores the draft.
 */
export interface DCtx {
  m: any;
  cur: string | null;
  ids: string[];
  vocab: any;
  ints: string[];
  touch: () => void;
  pushUndo: (label: string) => void;
  startupSet: Set<string>;
  toggleStartup: (id: string) => void;
  addAgent: (preset?: any) => void;
  duplicateAgent: () => void;
  deleteAgent: () => void;
  renameAgent: (old: string, next: string) => boolean;
  toggleWire: (src: string, tgt: string) => void;
  setCur: (id: string) => void;
}

/** Advice raised by the local advisors (soft checks the server won't flag). */
export interface Advice {
  level: "warn" | "info";
  tab: Tab;
  msg: string;
}
