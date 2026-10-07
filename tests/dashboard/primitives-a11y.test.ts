/**
 * What the console's primitives promise a keyboard and a screen reader. They are .tsx, which the node test build does not compile, so
 * each promise is pinned in the source text, named by the sentence it keeps. The browser half of the same promises (axe on every view,
 * at three widths in both themes, and on the gallery) is scripts/qa-console.mjs; this half fails in the unit run, before a browser.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), "utf8");

const components = read("components.tsx");
const tooltip = read("ui/tooltip.tsx");
const controls = read("ui/controls.tsx");
const feedback = read("ui/feedback.tsx");
const scrollStop = read("ui/scroll-stop.tsx");
const search = read("ui/search.tsx");
const styles = read("styles.css");
const live = read("live.css");

/** The source of one exported function: from its declaration to the closing brace at the start of a line. */
function bodyOf(source: string, name: string): string {
  const start = source.indexOf(`export function ${name}`);
  assert.ok(start >= 0, `${name} is exported`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `${name} ends`);
  return source.slice(start, end + 3);
}

test("an icon button has a name, and a tooltip that says it", () => {
  const body = bodyOf(components, "IconButton");
  assert.match(body, /aria-label=\{label\}/, "the glyph alone is not a name");
  assert.match(body, /<Tooltip content=\{title \?\? label\}/, "the tooltip is the same words, or a fuller title");
  assert.match(body, /aria-pressed=\{pressed\}/, "a toggle says whether it is on");
});

test("an icon button that opens something says whether it is open and what it controls, and is drawn open", () => {
  const body = bodyOf(components, "IconButton");
  for (const part of ["aria-expanded={expanded}", "aria-controls={controls}", "aria-haspopup={haspopup}"]) assert.ok(body.includes(part), `IconButton has ${part}`);
  assert.match(live, /\.icon-btn\[aria-expanded="true"\] \{[^}]*background: var\(--k-accent-soft\)/, "open has the ground a pressed one has");
});

test("a search box is one search field named for what it searches, with a clear button named for what it does", () => {
  assert.match(search, /type="search" aria-label=\{label\}/, "a search field, named by the page");
  assert.match(search, /aria-label="Clear the search"/, "the way to empty it says so");
  assert.match(search, /aria-hidden="true"><Kbd>/, "the key is drawn, not read: the field's name already says what it is");
  assert.match(components, /export \{ SearchField \} from "\.\/ui\/search";/);
  assert.match(live, /\.srch:focus-within \.srch-hint \{ opacity: 0; \}/, "the key leaves while the person types");
  assert.match(live, /\.srch-clear \{ width: 40px; height: 40px; \}/, "the clear button is a thumb's target on a phone");
});

test("the title row of a panel is not a second banner: the page has one, the top bar", () => {
  const body = bodyOf(components, "DrawerHead");
  assert.doesNotMatch(body, /<header/, "a header outside a section is a banner landmark, and the panel sits beside the top bar's");
  assert.match(body, /<div className="drawer-head">/);
  assert.doesNotMatch(read("stepdetail.tsx"), /<header/, "the step's loading shape is not one either");
  assert.doesNotMatch(read("evdetail.tsx"), /<header/, "nor is the event's title row");
});

test("a wide dialog is the same dialog, 640 wide, and it is the panel that says so", () => {
  assert.match(bodyOf(components, "DialogPanel"), /className=\{`confirm\$\{wide \? " wide" : ""\}`\}/);
  assert.match(live, /\.confirm\.wide \{ width: min\(640px, 92vw\); \}/);
});

test("a tooltip is described-by, can be pointed at, goes on Escape and is not shown for a touch or a click", () => {
  assert.match(tooltip, /role="tooltip"/);
  assert.match(tooltip, /"aria-describedby": open \? id/, "the control is described by it while it is up");
  assert.match(tooltip, /onPointerEnter=\{\(\) => window\.clearTimeout\(timer\.current\)\}/, "pointing at the tip keeps it (WCAG 1.4.13)");
  assert.match(tooltip, /e\.key === "Escape"/, "dismissable without moving the pointer");
  assert.match(tooltip, /e\.pointerType !== "touch"/, "a tap does not show a hover label");
  assert.match(tooltip, /matches\(":focus-visible"\)/, "only a keyboard's focus shows it, not a click's");
});

test("tabs are one tab stop with the arrow keys, and say which is selected", () => {
  const body = bodyOf(components, "Tabs");
  for (const part of ['role="tablist"', 'role="tab"', "aria-selected={t.id === value}", "tabIndex={t.id === value ? 0 : -1}", '"ArrowRight"', '"ArrowLeft"', '"Home"', '"End"']) {
    assert.ok(body.includes(part), `Tabs has ${part}`);
  }
  assert.match(bodyOf(components, "TabPanel"), /role="tabpanel"[\s\S]*aria-labelledby/, "a panel is named by its tab");
});

test("a dialog is modal and named, and a body that scrolls is a tab stop", () => {
  const body = bodyOf(components, "DialogPanel");
  assert.match(body, /aria-modal="true"/);
  assert.match(body, /aria-labelledby=\{labelId\}/);
  assert.match(body, /useScrolls\(body\)/, "it asks whether the body scrolls");
  assert.match(body, /tabIndex=\{scrolls \? 0 : undefined\}/, "and gives it a tab stop exactly then, never otherwise");
  assert.match(scrollStop, /el\.scrollHeight > el\.clientHeight/, "scrolls means it holds more than it shows");
  assert.match(scrollStop, /new ResizeObserver\(measure\)/, "measured again when it changes");
});

test("a switch is a switch, a field says what is wrong, a meter says what it measures", () => {
  assert.match(controls, /role=\{kind === "switch" \? "switch" : undefined\}/);
  const field = bodyOf(controls, "Field");
  assert.match(field, /htmlFor=\{id\}/, "the label is the field's");
  assert.match(field, /"aria-describedby": described/, "the hint and the error are read with it");
  assert.match(field, /"aria-invalid": error \? true : undefined/);
  assert.match(field, /role="alert"/, "an error is announced when it appears");
  const bar = bodyOf(feedback, "Progress");
  for (const part of ['role="progressbar"', "aria-label={label}", "aria-valuemin={0}", "aria-valuemax={max}", "aria-valuenow="]) {
    assert.ok(bar.includes(part), `Progress has ${part}`);
  }
});

test("a person who asks for less motion gets none: every animation, transition and smooth scroll is cut at once", () => {
  const rule = /@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{([^}]*)\}/.exec(styles);
  assert.ok(rule, "one rule under the media query covers every element");
  for (const decl of ["animation-duration: .01ms !important", "animation-iteration-count: 1 !important", "transition-duration: .01ms !important", "scroll-behavior: auto !important"]) {
    assert.ok(rule![1]!.includes(decl), decl);
  }
});

test("forced colours: what is drawn with a background says so, so it survives Windows High Contrast", () => {
  const block = /@media \(forced-colors: active\) \{([\s\S]*?)\n\}/.exec(styles);
  assert.ok(block, "the stylesheet has a forced-colours block");
  for (const part of ['input[type="checkbox"]::before', 'input[type="checkbox"][role="switch"]', ".tabs-ink", ".prog > i", ".seg button", "select.sel", ".menu-item", "CanvasText", "Highlight"]) {
    assert.ok(block![1]!.includes(part), `the block covers ${part}`);
  }
  assert.doesNotMatch(block![1]!, /#[0-9a-fA-F]{3,8}\b/, "system colours only, no literal");
});

