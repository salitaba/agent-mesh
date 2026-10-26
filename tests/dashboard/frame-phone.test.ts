/**
 * The frame around every page, on the owner's phone. Measured at 360x844 against the running console before this pass:
 *
 * - the top bar was three rows and 154px (25% of the viewport once the 57px project strip was counted), because a 220px goal
 *   basis forced the actions onto a second row and the goal onto a third;
 * - the project strip scrolled sideways: 437px of tabs in a 233px window, so the third project was off screen;
 * - the off-canvas navigation was 288px of page floating without a scrim, a close control or aria-modal; 8 controls behind it
 *   stayed in the tab order and a tap outside did nothing;
 * - the Help panel scrolled its own close control away (y = -136 after scrolling 400);
 * - the drawer's close X was 32x32; the palette had no close control and 40px rows;
 * - the page behind a drawer, the palette or the navigation still scrolled.
 *
 * The fixes are structure and CSS, and .tsx is not compiled by the node test build, so each promise is read from the source
 * text the way primitives-a11y.test.ts reads its promises. The browser half (sizes at 360/768/1440) is the pass report.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const SRC = path.join(ROOT, "apps", "mesh-dashboard", "src");
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), "utf8");

const styles = read("styles.css");
const shell = read("shell.tsx");
const tabs = read("tabs.tsx");
const palette = read("commandpalette.tsx");
const components = read("components.tsx");
const store = read("store.tsx");
const live = read("live.css");
const index = fs.readFileSync(path.join(ROOT, "apps", "mesh-dashboard", "index.html"), "utf8");

/** Every media block whose condition names a phone, joined (the reader phone-type.test.ts uses). */
function blocks(css: string, test: RegExp): string {
  const out: string[] = [];
  for (const m of css.matchAll(/@media[^{]+\{/g)) {
    if (!test.test(m[0])) continue;
    const start = m.index! + m[0].length;
    let depth = 1;
    let i = start;
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
    }
    out.push(css.slice(start, i - 1));
  }
  assert.ok(out.length, `a ${test} block exists`);
  return out.join("\n");
}
const phone = (): string => blocks(styles, /max-width:\s*620px/);
const narrow = (): string => blocks(styles, /max-width:\s*800px/);
/** A thumb's blocks: the phone width or a coarse pointer, the reader phone-targets.test.ts uses for the 44 px floor. */
const touch = (): string => blocks(styles, /pointer:\s*coarse|max-width:\s*(?:620|760)px/);

test("the phone bar is one row: the goal and the telemetry leave it, and the actions no longer wrap", () => {
  const css = phone();
  assert.match(css, /#goal-strip \{ display: none; \}/, "the goal is not a row of chrome on a phone");
  assert.match(css, /\.bar-strip \{ display: none; \}/, "the telemetry is not a row of chrome on a phone");
  // The inbox keeps its icon and its number; its accessible name is the words that left.
  assert.match(css, /\.top-actions \.act-lbl \{[^}]*position: absolute/, "the label becomes the accessible name, not a second row");
  assert.match(shell, /aria-label=\{`Needs you: \$\{inbox\} waiting on you`\}/, "the icon-only button still says what it does");
  // The same rule at 800: measured at 768 the bar was 116px with the goal and telemetry in it.
  assert.match(narrow(), /#goal-strip \{ display: none; \}/);
  assert.match(narrow(), /\.bar-strip \{ display: none; \}/);
});

test("a tablet's primary action stays in the bar; a phone's moves to the top of the overflow menu", () => {
  assert.match(shell, /&& !phone \? \(\s*<Button id=\{`btn-\$\{primary\.action\}`\}/, "the bar's primary is not drawn on a phone");
  assert.match(shell, /if \(phone && barPrimary && primary\) \{/, "the menu takes it instead");
  assert.match(shell, /moreItems\.push\(\{ id: `mi-\$\{primary\.action\}`/, "as its first row");
});

test("the project strip is one button and a sheet on a phone, not a sideways scroller", () => {
  const css = phone();
  assert.match(css, /\.ptabs-nav \{ display: none; \}/, "the scrolling row of tabs is gone");
  assert.match(css, /\.pj-switch \{ display: flex;/, "one row names the project in front");
  assert.match(tabs, /className="pj-switch"/);
  assert.match(tabs, /aria-haspopup="dialog"/);
  assert.match(tabs, /<Dialog onClose=\{\(\) => setSwitcher\(false\)\} title="Projects" wide>/, "the full list is the dialog primitive");
  assert.match(tabs, /className=\{`pj-opt\$\{p\.id === activeId \? " on" : ""\}`\}/, "one row per project");
  assert.match(styles, /\.pj-opt \{[^}]*min-height: 52px/, "a row is a thumb's target without leaning on the floor");
  assert.match(tabs, /inert=\{inert \|\| undefined\}/, "the strip goes inert under an open navigation sheet");
  // The sheet is a Dialog with `wide`; that desk width (92vw) outranked the phone's docked `width: auto` and measured 331px flush
  // left at 360, with a 29px slice of page beside it.
  assert.match(live, /@media \(max-width: 560px\) \{ \.confirm\.wide \{ width: auto; \} \}/, "a docked sheet spans the phone");
});

test("the navigation sheet is a layer: a scrim, a close control, aria-modal and an inert page", () => {
  assert.match(shell, /const navModal = narrow && menuOpen;/);
  assert.match(shell, /\{navModal \? <div id="nav-scrim" aria-hidden="true" onClick=\{closeMenu\} \/> : null\}/);
  assert.match(shell, /role=\{narrow \? "dialog" : "complementary"\}/);
  assert.match(shell, /aria-modal=\{navModal \|\| undefined\}/);
  assert.match(shell, /aria-label="Close navigation"/, "a visible way out that is not a nav item");
  assert.match(shell, /<header id="topbar"[^>]*inert=\{navModal \|\| undefined\}/);
  assert.match(shell, /<main id="view"[^>]*inert=\{navModal \|\| undefined\}/);
  assert.match(shell, /<ProjectTabs[^>]*inert=\{navModal\}/);
  assert.match(shell, /document\.addEventListener\("keydown", onTab, true\)/, "Tab cycles inside the sheet");
});

test("the Help panel's close control is the sticky header every other panel uses", () => {
  assert.match(shell, /<DrawerHead onClose=\{closeDrawer\}>Help<\/DrawerHead><Help \/>/);
  assert.doesNotMatch(shell, /close-x-float/, "the floating control that scrolled away is gone");
  assert.doesNotMatch(styles, /close-x-float/);
  assert.match(styles, /\.drawer-head \{ position: sticky; top: calc\(var\(--s5\) \* -1\)/, "the header sticks at a desk");
});

test("a phone's panel is the whole screen and its close control is a thumb's target", () => {
  const css = phone();
  assert.match(css, /\.drawer \{ width: 100vw; max-width: 100vw; height: 100dvh;/, "92vw left a sliver of a page nobody could read");
  assert.match(css, /\.drawer-head \{ top: calc\(-1 \* \(var\(--s5\) \+ env\(safe-area-inset-top\)\)\)/, "the header stays under the notch");
  // The floor at the foot of the stylesheet names the close control (phone-targets.test.ts reads it too).
  assert.match(styles, /\.icon-btn, button\.linklike, summary, \.close-x, \.palette-x, \.palette-item, \.pj-opt, \.toast-x,/);
});

test("the command palette has a close control and thumb-sized rows on a phone", () => {
  assert.match(palette, /className="palette-x" aria-label="Close the command palette"/);
  assert.match(palette, /e\.preventDefault\(\);\s*closeRef\.current\?\.focus\(\)/, "Tab moves to it instead of pinning focus in the field");
  assert.match(touch(), /\.palette-item \{ min-height: 44px; \}/);
  assert.match(touch(), /\.palette-x \{ width: 44px; height: 44px; \}/);
});

test("the page behind a layer does not scroll", () => {
  assert.match(styles, /#app:has\(#drawer\) #view, #app:has\(#palette-scrim\) #view, #app:has\(\.confirm-scrim\) #view \{ overflow: hidden; \}/);
  assert.match(styles, /body:has\(#drawer\), body:has\(#palette-scrim\), body:has\(\.confirm-scrim\) \{ overflow: hidden; \}/);
  assert.match(narrow(), /#app:has\(#sidebar\.open\) #view \{ overflow: hidden; \}/);
  assert.match(narrow(), /body:has\(#sidebar\.open\) \{ overflow: hidden; \}/);
});

test("the frame stays on the type ramp: a count is 600 13px, and the skip link has a base font", () => {
  assert.match(styles, /\.count \{ margin-left: var\(--s1\); font: 600 13px\/1 var\(--sans\);/, "the Needs-you count was 14px/900 from the browser's <b>");
  assert.match(styles, /\.skip-link \{[^}]*font: 600 14px var\(--sans\);/, "the hidden control had no font until it was focused");
});

test("a phone's edges are its own: the viewport is safe-area aware", () => {
  assert.match(index, /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" \/>/);
  assert.match(styles, /env\(safe-area-inset-top\)/, "the top bar and the drawer clear the notch");
  assert.match(styles, /env\(safe-area-inset-bottom\)/, "the foot of the view and the drawer clear the home bar");
});

test("a notice can be taken down without waiting out its timer", () => {
  assert.match(store, /dismissToast: \(id: number\) => void;/);
  assert.match(store, /const dismissToast = useCallback\(\(id: number\) =>/);
  assert.match(shell, /onDismiss=\{\(\) => dismissToast\(t\.id\)\}/);
  assert.match(components, /className="toast-x" aria-label="Dismiss this notice"/);
});

test("a touch screen shows a tab's close control without a hovering pointer", () => {
  assert.match(touch(), /\.ptab-x \{ opacity: 1; \}/, "inside the coarse/760 block, where there is no hover");
});
