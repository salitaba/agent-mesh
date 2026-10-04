/* Undo and redo for the draft, as a plain value.
 *
 * It was one slot: Undo restored a snapshot and cleared itself, typing never recorded one at all, and the stack lived in the
 * Designer's component state, so leaving the page forgot it. An assistant proposal that replaced the whole draft could be undone
 * once, and only from the page it landed on. Here the history is a value the draft store owns: many steps, a redo for each,
 * a burst of typing in one field counts as one step, and it survives a visit to another view.
 *
 * DOM-free, so tests/dashboard can pin the stack rules. */

/** The draft as it was at one moment: enough to put it back. */
export interface Snap {
  /** What the step that LEFT this state did, as the person would name it ("Added seat seat-2"). */
  label: string;
  model: any;
  cur: string | null;
}

export interface History {
  past: Snap[];
  future: Snap[];
  /** What the last recorded step was a burst of, and when: the key a following keystroke is compared with. */
  lastKey: string | null;
  lastAt: number;
}

export const LIMIT = 60;
/** Typing in the same field within this long of the last keystroke is one step. */
export const BURST_MS = 1200;

export const emptyHistory = (): History => ({ past: [], future: [], lastKey: null, lastAt: 0 });

export interface RecordOpts {
  /** Edits with the same key close together are one step. Omit for a step that always stands alone. */
  key?: string;
  at?: number;
  windowMs?: number;
  limit?: number;
}

/**
 * Record the state BEFORE a change. A new change forks the history, so the redo stack is dropped. A change in the same field
 * as the last one, soon after it, is not a new step: the earlier snapshot already holds the state before the burst began.
 */
export function record(h: History, before: Snap, opts: RecordOpts = {}): History {
  const at = opts.at ?? Date.now();
  const burst = opts.key !== undefined && h.lastKey === opts.key && at - h.lastAt <= (opts.windowMs ?? BURST_MS) && h.past.length > 0;
  if (burst) return { ...h, future: [], lastAt: at };
  const past = [...h.past, before];
  const limit = opts.limit ?? LIMIT;
  return { past: past.length > limit ? past.slice(past.length - limit) : past, future: [], lastKey: opts.key ?? null, lastAt: at };
}

export interface Step { history: History; restore: Snap }

/** Step back. `now` is the state being left; it becomes the redo. Null when there is nothing to undo. */
export function undo(h: History, now: { model: any; cur: string | null }): Step | null {
  const restore = h.past[h.past.length - 1];
  if (!restore) return null;
  return {
    restore,
    history: {
      past: h.past.slice(0, -1),
      future: [...h.future, { label: restore.label, model: now.model, cur: now.cur }],
      lastKey: null,
      lastAt: 0,
    },
  };
}

/** Step forward again. Null when there is nothing to redo. */
export function redo(h: History, now: { model: any; cur: string | null }): Step | null {
  const restore = h.future[h.future.length - 1];
  if (!restore) return null;
  return {
    restore,
    history: {
      past: [...h.past, { label: restore.label, model: now.model, cur: now.cur }],
      future: h.future.slice(0, -1),
      lastKey: null,
      lastAt: 0,
    },
  };
}

/** What the buttons can say: the step Undo would take back and the step Redo would put back. */
export function labels(h: History): { undo: string | null; redo: string | null } {
  return { undo: h.past[h.past.length - 1]?.label ?? null, redo: h.future[h.future.length - 1]?.label ?? null };
}
