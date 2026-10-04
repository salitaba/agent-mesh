import type { ReactNode } from "react";

/**
 * The console's icons: one 20-unit grid, one 1.6 stroke with round ends, `currentColor` throughout. An icon takes the colour
 * of the text it sits in, so it flips with the theme and with a hover or an active state for free.
 *
 * They replace Unicode glyphs (◧ ≋ ⚑ ⊘ ✉ ⚙ …). A glyph is drawn by whichever font the machine has, so the same nav item
 * looked different on every operating system, sat on a different baseline, and was announced by screen readers as its
 * Unicode name. These are the same drawing everywhere and are hidden from assistive technology unless given a `title`.
 *
 * Adding one: draw it on the 20 grid with the stroke defaults (no fill unless it is a solid shape, and then
 * `fill="currentColor" stroke="none"`), key it in kebab-case, and use it somewhere: tests/build/icons.test.ts fails on an
 * icon nothing uses, so the set stays the size of the interface.
 */
const SOLID = { fill: "currentColor", stroke: "none" } as const;

const ICONS = {
  // Navigation
  overview: (<><rect x="3" y="3" width="6" height="6" rx="1.5" /><rect x="11" y="3" width="6" height="4" rx="1.5" /><rect x="11" y="9" width="6" height="8" rx="1.5" /><rect x="3" y="11" width="6" height="6" rx="1.5" /></>),
  events: (<path d="M2.5 10h3l2-5.5 3 11 2.2-8 1.3 2.5h3.5" />),
  steps: (<><path d="M8 5h9M8 10h9M8 15h9" /><circle cx="4" cy="5" r="1" {...SOLID} /><circle cx="4" cy="10" r="1" {...SOLID} /><circle cx="4" cy="15" r="1" {...SOLID} /></>),
  agents: (<><circle cx="7.5" cy="7" r="2.8" /><path d="M2.5 16.5c0-2.8 2.2-4.8 5-4.8s5 2 5 4.8" /><circle cx="14" cy="7.8" r="2.2" /><path d="M14.5 11.8c1.9.3 3 1.9 3 4.2" /></>),
  inbox: (<><path d="M3 11l2.1-6.2a1.5 1.5 0 0 1 1.4-1h7a1.5 1.5 0 0 1 1.4 1L17 11" /><path d="M3 11v4a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 17 15v-4h-4l-1 2H8l-1-2z" /></>),
  lock: (<><rect x="4.5" y="9" width="11" height="8" rx="2" /><path d="M7 9V6.5a3 3 0 0 1 6 0V9" /></>),
  graph: (<><circle cx="5" cy="5.5" r="2" /><circle cx="15" cy="7" r="2" /><circle cx="9.5" cy="15" r="2" /><path d="M6.9 6l6.2.8M14 8.9l-3.2 4.4M8.2 13.5L5.6 7.4" /></>),
  files: (<><path d="M5 3h6l4 4v10H5z" /><path d="M11 3v4h4" /></>),
  product: (<><path d="M10 2.5l6.8 3.4v8.2L10 17.5l-6.8-3.4V5.9z" /><path d="M3.2 5.9L10 9.3l6.8-3.4M10 9.3v8.2" /></>),
  cost: (<path d="M3.5 16.5h13M5.5 16.5v-5M10 16.5v-12M14.5 16.5V8" />),
  designer: (<><path d="M3.5 16.5l.7-3.4 9-9a1.6 1.6 0 0 1 2.3 0l.4.4a1.6 1.6 0 0 1 0 2.3l-9 9z" /><path d="M11.6 5.9l2.5 2.5" /></>),
  host: (<><rect x="3" y="3.5" width="14" height="5.5" rx="1.6" /><rect x="3" y="11" width="14" height="5.5" rx="1.6" /><circle cx="6.5" cy="6.25" r=".8" {...SOLID} /><circle cx="6.5" cy="13.75" r=".8" {...SOLID} /></>),
  sliders: (<><path d="M3.5 6h8M15.5 6h1M3.5 14h1M8.5 14h8" /><circle cx="13.5" cy="6" r="1.8" /><circle cx="6.5" cy="14" r="1.8" /></>),
  // Chrome
  menu: (<path d="M3.5 5.5h13M3.5 10h13M3.5 14.5h13" />),
  search: (<><circle cx="8.8" cy="8.8" r="5.3" /><path d="M12.8 12.8l4 4" /></>),
  help: (<><circle cx="10" cy="10" r="7.2" /><path d="M7.9 8.1a2.2 2.2 0 1 1 3.4 1.9c-.9.5-1.3 1-1.3 2" /><circle cx="10" cy="14.2" r=".7" {...SOLID} /></>),
  sun: (<><circle cx="10" cy="10" r="3.2" /><path d="M10 2.8v1.6M10 15.6v1.6M2.8 10h1.6M15.6 10h1.6M4.9 4.9L6 6M14 14l1.1 1.1M15.1 4.9L14 6M6 14l-1.1 1.1" /></>),
  moon: (<path d="M16.4 11.6A6.8 6.8 0 1 1 8.4 3.6a5.4 5.4 0 0 0 8 8z" />),
  "sign-out": (<><path d="M8 3.5H5.2a1.7 1.7 0 0 0-1.7 1.7v9.6a1.7 1.7 0 0 0 1.7 1.7H8" /><path d="M12 6.5l3.5 3.5-3.5 3.5M15.5 10H8" /></>),
  more: (<><circle cx="4.5" cy="10" r="1.3" {...SOLID} /><circle cx="10" cy="10" r="1.3" {...SOLID} /><circle cx="15.5" cy="10" r="1.3" {...SOLID} /></>),
  spark: (<><path d="M9 3l1.3 4.3 4.3 1.3-4.3 1.3L9 14.2 7.7 9.9 3.4 8.6l4.3-1.3z" /><path d="M15 12.5l.6 1.9 1.9.6-1.9.6-.6 1.9-.6-1.9-1.9-.6 1.9-.6z" /></>),
  // Actions
  plus: (<path d="M10 4v12M4 10h12" />),
  x: (<path d="M5 5l10 10M15 5L5 15" />),
  check: (<path d="M4.5 10.5l3.6 3.6 7.4-8" />),
  "chevron-right": (<path d="M8 4.5L13.5 10 8 15.5" />),
  play: (<path d="M6.5 4.2l9 5.8-9 5.8z" {...SOLID} />),
  pause: (<><rect x="5" y="3.8" width="3.4" height="12.4" rx="1" {...SOLID} /><rect x="11.6" y="3.8" width="3.4" height="12.4" rx="1" {...SOLID} /></>),
  message: (<path d="M3.5 5.3A1.8 1.8 0 0 1 5.3 3.5h9.4a1.8 1.8 0 0 1 1.8 1.8v6.4a1.8 1.8 0 0 1-1.8 1.8H9.2L5.5 17v-3.5h-.2a1.8 1.8 0 0 1-1.8-1.8z" />),
  approve: (<><circle cx="10" cy="10" r="7.2" /><path d="M6.9 10.2l2.2 2.2 4-4.6" /></>),
  refresh: (<><path d="M16.2 10a6.2 6.2 0 1 1-1.9-4.4" /><path d="M16.2 3.8v3.4h-3.4" /></>),
  undo: (<><path d="M7 4.5L3.8 7.7 7 10.9" /><path d="M4 7.7h7.2a4.6 4.6 0 0 1 0 9.2H7.5" /></>),
  trash: (<path d="M4 6h12M8 6V4.2c0-.4.3-.7.7-.7h2.6c.4 0 .7.3.7.7V6M5.5 6l.7 9.8c0 .4.4.7.8.7h6c.4 0 .8-.3.8-.7L14.5 6M8.5 9v4.5M11.5 9v4.5" />),
  copy: (<><rect x="7" y="7" width="9.5" height="9.5" rx="1.8" /><path d="M13 7V5.3a1.8 1.8 0 0 0-1.8-1.8H5.3a1.8 1.8 0 0 0-1.8 1.8v5.9A1.8 1.8 0 0 0 5.3 13H7" /></>),
  folder: (<path d="M2.8 5.8a1.6 1.6 0 0 1 1.6-1.6h3.2l1.7 2h6.3a1.6 1.6 0 0 1 1.6 1.6v6.4a1.6 1.6 0 0 1-1.6 1.6H4.4a1.6 1.6 0 0 1-1.6-1.6z" />),
  key: (<><circle cx="6.8" cy="12.8" r="3.3" /><path d="M9.2 10.4l7.3-7.3M13.8 5.8l2.1 2.1M11.6 8l1.7 1.7" /></>),
  // Status
  alert: (<><path d="M10 3.2l7.3 12.7H2.7z" /><path d="M10 8.4v3.4" /><circle cx="10" cy="14" r=".7" {...SOLID} /></>),
  info: (<><circle cx="10" cy="10" r="7.2" /><path d="M10 9.2v4.6" /><circle cx="10" cy="6.4" r=".7" {...SOLID} /></>),
  // Designer
  redo: (<><path d="M13 4.5l3.2 3.2L13 10.9" /><path d="M16 7.7H8.8a4.6 4.6 0 0 0 0 9.2h4.7" /></>),
  "arrow-right": (<path d="M4 10h11.5M11 5.5l4.5 4.5-4.5 4.5" />),
  arrange: (<><rect x="3.5" y="3.5" width="5" height="5" rx="1.3" /><rect x="11.5" y="3.5" width="5" height="5" rx="1.3" /><rect x="3.5" y="11.5" width="5" height="5" rx="1.3" /><rect x="11.5" y="11.5" width="5" height="5" rx="1.3" /></>),
  expand: (<path d="M3.5 8V4.5a1 1 0 0 1 1-1H8M12 3.5h3.5a1 1 0 0 1 1 1V8M16.5 12v3.5a1 1 0 0 1-1 1H12M8 16.5H4.5a1 1 0 0 1-1-1V12" />),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof ICONS;

/** The names, for the test that keeps the set honest. */
export const ICON_NAMES = Object.keys(ICONS) as IconName[];

/**
 * An inline icon. Decorative by default (`aria-hidden`): the label beside it already says what it is. Give it a `title`
 * only when it stands alone (an icon-only button names itself with `aria-label` on the button, not here).
 */
export function Icon({ name, size = 16, title, className }: { name: IconName; size?: number; title?: string; className?: string }): React.JSX.Element {
  return (
    <svg
      className={`icon${className ? ` ${className}` : ""}`}
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      aria-label={title}
    >
      {ICONS[name]}
    </svg>
  );
}
