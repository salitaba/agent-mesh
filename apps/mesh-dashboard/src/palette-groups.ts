/**
 * How the command palette lists its rows when nothing has been typed: grouped (where to go, which agent, what to do), in an order
 * that is the same on every machine. DOM-free, so the order the keyboard walks is the order the groups are drawn in and a test says so.
 *
 * Typed, the palette is one list ranked by how well each row matches (palette.ts); a group header there would push the best answer
 * down, so it does not group.
 */
import type { Command } from "./commands";

export interface PaletteGroup { label: string; items: Command[] }

/**
 * The commands in groups. The groups come in the order given in `order`; a group `groupOf` names that is not in it follows them, in
 * the order it first appears; inside a group the commands keep the order they came in. A group with nothing in it is not returned.
 */
export function groupCommands(commands: readonly Command[], groupOf: (c: Command) => string, order: readonly string[]): PaletteGroup[] {
  const byLabel = new Map<string, Command[]>();
  for (const c of commands) {
    const label = groupOf(c);
    const items = byLabel.get(label);
    if (items) items.push(c);
    else byLabel.set(label, [c]);
  }
  const known = order.filter((label) => byLabel.has(label));
  const rest = [...byLabel.keys()].filter((label) => !order.includes(label));
  return [...known, ...rest].map((label) => ({ label, items: byLabel.get(label)! }));
}

/** The same commands as one list, in the order the groups are drawn: what the arrow keys walk. */
export function paletteOrder(commands: readonly Command[], groupOf: (c: Command) => string, order: readonly string[]): Command[] {
  return groupCommands(commands, groupOf, order).flatMap((g) => g.items);
}
