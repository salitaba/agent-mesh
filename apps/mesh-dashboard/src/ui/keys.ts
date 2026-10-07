/**
 * A key chord as the person reads it. "mod+k" is ⌘K on a Mac and Ctrl K everywhere else: the sidebar used to print ⌘K on
 * every machine, which on Windows and Linux names a key that is not there. DOM-free, so the table is tested; `isMac` (the one
 * place that looks at the machine) is in kbd.tsx.
 */

const NAMED: Record<string, { mac: string; other: string }> = {
  mod: { mac: "⌘", other: "Ctrl" },
  ctrl: { mac: "⌃", other: "Ctrl" },
  alt: { mac: "⌥", other: "Alt" },
  shift: { mac: "⇧", other: "Shift" },
  enter: { mac: "↵", other: "↵" },
  esc: { mac: "esc", other: "Esc" },
  tab: { mac: "⇥", other: "Tab" },
  space: { mac: "Space", other: "Space" },
  up: { mac: "↑", other: "↑" },
  down: { mac: "↓", other: "↓" },
  left: { mac: "←", other: "←" },
  right: { mac: "→", other: "→" },
};

/** The caps of a chord, in order: "mod+shift+p" is ["⌘", "⇧", "P"] on a Mac and ["Ctrl", "Shift", "P"] elsewhere. */
export function chordParts(spec: string, mac: boolean): string[] {
  return spec
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const named = NAMED[part.toLowerCase()];
      if (named) return mac ? named.mac : named.other;
      return part.length === 1 ? part.toUpperCase() : part;
    });
}

/** The chord as a sentence for a screen reader and a tooltip: "Ctrl K", "⌘ K". */
export function chordLabel(spec: string, mac: boolean): string {
  return chordParts(spec, mac).join(" ");
}
