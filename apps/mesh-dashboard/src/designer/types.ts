/* Shared types for the Mesh Studio (Designer) module. */

import type { Wire } from "./edits";
import type { Section } from "./locate";

export type Pos = { x: number; y: number };

/** Inspector tabs. Errors route to the tab that owns the offending field. The ids are stable; the labels are Seat, Mesh and Policy. */
export type Tab = "crew" | "mesh" | "policy";

/**
 * Loose shape of the editable mesh config. Sub-objects stay `any` until the
 * protocol types are wired here; the panels mutate and pad them in place.
 */
export interface MeshModel {
  version?: number;
  mesh?: any;
  startup?: any;
  agents: Record<string, any>;
  policies: any;
  budgets?: any;
  scheduling?: any;
  server?: any;
}

/** A request to open one part of the inspector and put focus in it: what a validation message's "Open" button sends. */
export interface Reveal {
  section?: Section;
  /** The `data-field` of a control inside the section. */
  field?: string;
  /** A new request is a new number, so asking for the same place twice still moves focus. */
  nonce: number;
  /** Select the text in the control, so what is typed replaces a placeholder (a new seat's role) instead of being added to it. */
  select?: boolean;
}

/**
 * Everything a sub-panel needs to read + mutate the model. The model object
 * itself (`m`) is mutated in place; every mutation must end with `touch()`
 * so the Designer re-renders, re-validates and re-stores the draft.
 */
export interface DCtx {
  m: MeshModel;
  cur: string | null;
  ids: string[];
  vocab: any;
  /** Every event type a seat can be woken for, plus the `type.*` patterns. */
  ints: string[];
  /** Call after a change to `m`. The label names the step for Undo when the change is not a keystroke in a field. */
  touch: (label?: string) => void;
  starts: Set<string>;
  toggleStart: (id: string) => void;
  addSeat: () => void;
  duplicateSeat: () => void;
  deleteSeat: () => void;
  renameSeat: (old: string, next: string) => boolean;
  /** Flip the selected seat's own `may_contact` entry. */
  toggleContact: (src: string, tgt: string) => void;
  /** Flip one entry in a seat's `may_be_contacted_by`. */
  toggleGrant: (id: string, sender: string) => void;
  /** Select a seat and show it in the inspector. */
  openSeat: (id: string) => void;
  wires: Wire[];
  reveal: Reveal | null;
}

/** Advice raised by the local advisors and the server's config-time warnings. */
export interface Advice {
  level: "warn" | "info";
  tab: Tab;
  msg: string;
}
