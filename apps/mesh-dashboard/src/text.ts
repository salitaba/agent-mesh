/**
 * Small text helpers the live views share. DOM-free, so node:test can cover them.
 */

/**
 * An id short enough to sit in a row, keeping both ends: `evt-muu7bezm-uizlvct6` stays whole, a 40-character one becomes
 * `evt-muu7bezm…c6a91f`. The ends are what a person compares (a prefix says what kind of thing it is, a suffix tells two apart),
 * and the middle is what a stylesheet's end-ellipsis would have thrown away. The whole id belongs in the element's title and
 * behind a copy button.
 */
export function middleClip(s: string, max = 24): string {
  const t = String(s ?? "");
  if (t.length <= max || max < 5) return t;
  const keep = max - 1;
  const head = Math.ceil(keep * 0.6);
  const tail = keep - head;
  return `${t.slice(0, head)}…${t.slice(t.length - tail)}`;
}

/** "1 turn", "2 turns". The plural is regular unless given. */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}
