/* Where the open turn sits among the loaded steps, for the step view's ‹/›
   walker and its j/k keys.

   DOM-free, like route.ts and ledger.ts, so the placement rules are pinned by
   tests/dashboard/stepwalk.test.ts. */

export interface StepPlace {
  /** Index in the loaded list, or -1 when the turn is not in it. */
  idx: number;
  /** The loaded step ‹ (k) goes to, if any. */
  newer?: string;
  /** The loaded step › (j) goes to, if any. */
  older?: string;
  /**
   * `listed`: in the list. Otherwise placed by its start time among the
   * loaded steps: older or newer than all of them, `between` two, or
   * `unplaced` when there is nothing to place it by (no start time yet, or
   * nothing loaded).
   */
  where: "listed" | "older-than-list" | "newer-than-list" | "between" | "unplaced";
}

interface StepLike { turnId?: string; startedAt?: string }

/**
 * Place `turnId` among `list`, newest first as the Steps view orders it.
 *
 * The walker used to find the turn by id and nothing else, and the store
 * loads the newest 60 steps: a deep link to anything older showed "—" with
 * both arrows dead. A turn outside the list is placed by `startedAt`, so ‹
 * goes to the nearest newer loaded step and › to the nearest older one. A
 * step that started at the very same instant is neither, rather than a coin
 * toss between the two.
 */
export function placeStep(list: readonly StepLike[], turnId: string, startedAt?: string): StepPlace {
  const idx = list.findIndex((s) => s.turnId === turnId);
  if (idx >= 0) return { idx, newer: list[idx - 1]?.turnId, older: list[idx + 1]?.turnId, where: "listed" };
  const t = startedAt ? Date.parse(startedAt) : NaN;
  if (Number.isNaN(t)) return { idx: -1, where: "unplaced" };
  let newer: { id: string; at: number } | undefined;
  let older: { id: string; at: number } | undefined;
  for (const s of list) {
    const at = Date.parse(s.startedAt ?? "");
    if (!s.turnId || Number.isNaN(at)) continue;
    if (at > t && (!newer || at < newer.at)) newer = { id: s.turnId, at };
    if (at < t && (!older || at > older.at)) older = { id: s.turnId, at };
  }
  const where = newer && older ? "between" : newer ? "older-than-list" : older ? "newer-than-list" : "unplaced";
  return { idx: -1, newer: newer?.id, older: older?.id, where };
}

/** The walker's counter: a position when listed, and otherwise where the
 *  turn stands relative to what is loaded, rather than a bare dash. */
export function placeLabel(p: StepPlace, loaded: number): { text: string; title: string } {
  switch (p.where) {
    case "listed":
      return { text: `${p.idx + 1} of ${loaded}`, title: `step ${p.idx + 1} of the ${loaded} loaded, newest first` };
    case "older-than-list":
      return { text: "older than loaded", title: `this step started before all ${loaded} loaded steps; ‹ goes to the oldest of them` };
    case "newer-than-list":
      return { text: "newer than loaded", title: `this step started after all ${loaded} loaded steps; › goes to the newest of them` };
    case "between":
      return { text: "not in list", title: "this step is not in the loaded list; ‹ and › go to the loaded steps that started just after and just before it" };
    default:
      return { text: "not in list", title: loaded ? "this step is not in the loaded list, and has no start time to place it by" : "no steps are loaded to walk through" };
  }
}
