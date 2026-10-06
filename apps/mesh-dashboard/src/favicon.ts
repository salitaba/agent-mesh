/**
 * The console's tab icon, and the three it wears when there is something to tell: a decision is waiting, the mission is
 * delivered, the mission stopped. DOM-free, so tests/dashboard can pin the drawing of each.
 *
 * People start a mission and go to another tab. In a row of a dozen tabs the title is cut to its first few letters (or to
 * nothing) and the icon is all that is left, so the icon carries the news. Each state differs from the others in shape and in
 * the mark inside it, not only in colour: a disc with a bar (needs you), a disc with a tick (delivered) and a square with a cross
 * (stopped). The badge sits over the ring's open side and the ring and its seat are drawn exactly as the brand file draws them.
 *
 * It is a `data:` image on purpose. The host serves the console under `img-src 'self' data: blob:` (web-security.ts), and the
 * icon in index.html is already one, so this adds no request and shows at once. tests/dashboard/favicon.test.ts fails if that
 * policy ever stops admitting `data:`, so a tightened policy cannot silently turn the icon blank.
 */

export type FaviconKind = "plain" | "needs-you" | "delivered" | "stopped";

/**
 * brand/favicon.svg and the icon in index.html draw the same ring: the first paint, before any script has run, and the plain
 * state here must stay one drawing (the test compares them).
 */
const MARK =
  "<path class='ink' d='M48.72 15.65A22 22 0 1 0 48.72 48.35' fill='none' stroke-width='9.2' stroke-linecap='round'/>" +
  "<circle class='seat' cx='48.72' cy='15.65' r='8'/>";

/** The ink and the seat follow the browser's colour scheme, as the brand file does. */
const BASE_LIGHT = ".ink{stroke:#1c1b1a}.seat{fill:#2b5fd9}";
const BASE_DARK = ".ink{stroke:#efece6}.seat{fill:#7ba0ff}";

/**
 * The badge's colours are the console's own status colours (styles.css `--bad`, `--ok` and the text laid over them), light and
 * dark, and the halo around it is the page surface, so a badge stays apart from the ring it overlaps on either tab strip.
 */
const BADGE_LIGHT = ".halo{fill:#fbfaf8}.bad{fill:#a53349}.ok{fill:#0a6b49}.mark{fill:none;stroke:#ffffff;stroke-width:4.6;stroke-linecap:round;stroke-linejoin:round}.dot{fill:#ffffff}";
const BADGE_DARK = ".halo{fill:#131211}.bad{fill:#f07381}.ok{fill:#43d6a0}.mark{stroke:#16070a}.dot{fill:#16070a}";

const DISC_HALO = "<circle class='halo' cx='46.5' cy='46.5' r='17.5'/>";

const BADGES: Record<Exclude<FaviconKind, "plain">, string> = {
  // A disc with a bar and a dot: something is asked of you.
  "needs-you": `${DISC_HALO}<circle class='bad' cx='46.5' cy='46.5' r='14.5'/><path class='mark' d='M46.5 39.5v7.4'/><circle class='dot' cx='46.5' cy='53.6' r='2.3'/>`,
  // A disc with a tick: done.
  delivered: `${DISC_HALO}<circle class='ok' cx='46.5' cy='46.5' r='14.5'/><path class='mark' d='M39.8 46.8l4.7 4.7 8.9-9.7'/>`,
  // A square with a cross: it stopped, and not because you asked it to.
  stopped: "<rect class='halo' x='29' y='29' width='35' height='35' rx='9'/><rect class='bad' x='32' y='32' width='29' height='29' rx='6.5'/><path class='mark' d='M41 41l11 11M52 41l-11 11'/>",
};

/** The icon as an SVG document. */
export function faviconSvg(kind: FaviconKind): string {
  const badge = kind === "plain" ? "" : BADGES[kind];
  const light = kind === "plain" ? BASE_LIGHT : BASE_LIGHT + BADGE_LIGHT;
  const dark = kind === "plain" ? BASE_DARK : BASE_DARK + BADGE_DARK;
  return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><style>${light}@media (prefers-color-scheme:dark){${dark}}</style>${MARK}${badge}</svg>`;
}

/** The icon as a value for a `<link rel="icon">`. */
export const faviconHref = (kind: FaviconKind): string => `data:image/svg+xml,${encodeURIComponent(faviconSvg(kind))}`;
