/**
 * Three surfaces in the Designer cover the page at 360px: the inspector drawer, the YAML slide and the assistant dock. A thing that
 * covers the page is a layer, not a panel that happens to be on top. Measured in the running console before this: the inspector was
 * a fixed 360x844 box with no role, no modal state and no ground behind it, Tab and Shift+Tab walked into the seat rows and the
 * toolbar behind it, and a press outside it hit the page; the YAML slide had a dialog role but no aria-modal and the page gutter
 * stayed live; the dock covered the screen with none of it. The browser is not in this run, so the shape is pinned in the source and
 * the stylesheets, the way `designer-phone.test.ts` and `drawers-css.test.ts` pin theirs.
 *
 * The other two claims here are the reading ones: a roster cuts no name, and a canvas card neither cuts its name nor repeats it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), "utf8");

/** Every declaration block whose selector list names `selector` as one of its parts, comments removed. */
function blocksFor(css: string, selector: string): string[] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];
  for (const m of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1]!.split(",").some((s) => s.trim() === selector)) out.push(m[2]!);
  }
  return out;
}

/** The text of the first `@media <condition> { … }` block whose condition matches: braces counted, so nested rules are whole. */
function mediaBlock(css: string, condition: RegExp): string {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of bare.matchAll(/@media([^{]+)\{/g)) {
    if (!condition.test(m[1]!)) continue;
    const start = (m.index ?? 0) + m[0].length;
    let depth = 1;
    let i = start;
    for (; i < bare.length && depth > 0; i++) {
      if (bare[i] === "{") depth++;
      else if (bare[i] === "}") depth--;
    }
    if (depth === 0) return bare.slice(start, i - 1);
  }
  return "";
}

const designer = read("designer/Designer.tsx");
const designerCss = read("designer/designer.css");
const chrome = read("designer/chrome.tsx");
const dock = read("designer/ChatDock.tsx");
const dockCss = read("designer/assistant.css");
const topology = read("designer/Topology.tsx");
const topologyCss = read("designer/topology.css");
const seatList = read("designer/SeatList.tsx");
const guide = read("designer/Guide.tsx");

/* ------------------------------------------------ what covers the page is a layer */

test("the phone inspector is a dialog: named, modal, trapped, on its own ground, and it does not take the field keyboard's focus", () => {
  const drawer = designer.slice(designer.indexOf('id="ms-inspector"'), designer.indexOf("<Inspector ctx="));
  assert.match(drawer, /role=\{compact \? "dialog" : "region"\}/, "below the drawer breakpoint it is a dialog; above it, a named region");
  assert.match(drawer, /aria-modal=\{compact \? "true" : undefined\}/, "it says the page behind it is not available");
  assert.match(drawer, /aria-labelledby=\{compact \? "ms-side-title" : undefined\}/, "its name is the line that says which seat it shows");
  assert.match(drawer, /ref=\{layerRef\} tabIndex=\{-1\}/, "the layer itself can take the focus on open");
  assert.match(designer, /const sideTitle = tab === "crew" \? \(current \? `Seat: \$\{current\}` : "No seat selected"\)/, "the heading names the seat, not just 'Inspector'");
  assert.match(
    designer,
    /useDismissable<HTMLDivElement>\(compact && ctxOpen, \(\) => setCtxOpen\(false\), \{ escape: false, initialFocus: "root" \}\)/,
    "focus enters the drawer at its heading rather than its first input (a phone would open the keyboard), and Escape keeps the field's meaning",
  );
  const scrim = designer.indexOf('compact && ctxOpen ? <div className="ms-scrim"');
  assert.ok(scrim > 0, "a scrim is drawn while the drawer is open");
  assert.ok(scrim < designer.indexOf('className="ms-body"'), "the scrim is a sibling before the body, not something inside it");
});

test("the drawer and its scrim are ordered by the console's own z ladder, and the page under them does not scroll", () => {
  const scrim = blocksFor(designerCss, ".ms-scrim").join(";");
  assert.match(scrim, /position:\s*fixed/, "the ground covers the viewport");
  assert.match(scrim, /inset:\s*0/);
  assert.match(scrim, /z-index:\s*calc\(var\(--z-overlay\)\s*-\s*1\)/, "the ground sits one step under the drawer");
  const phone = mediaBlock(designerCss, /max-width:\s*1280px/);
  assert.match(phone, /\.ms-side \{[^}]*z-index:\s*var\(--z-overlay\)/, "the drawer is above its ground");
  assert.match(designerCss, /body:has\(\.ms-scrim\)[^{]*\{[^}]*overflow:\s*hidden/, "the page under the layer is held still");
});

test("the YAML slide is a modal layer too, not a dialog floating over a live page", () => {
  assert.match(chrome, /<div className="ms-scrim" aria-hidden="true" onClick=\{onClose\} \/>/, "the slide has a ground");
  assert.match(chrome, /role="dialog" aria-modal="true" aria-label="YAML preview"/, "and says the page behind it cannot be used");
  assert.match(chrome, /<pre className=\{`yaml-pane\$\{wrap \? " wrap" : ""\}`\} tabIndex=\{0\} aria-label="YAML text">/, "the long output is reachable and scrolls");
});

test("the YAML preview wraps on a phone, where a 462 px line was read through a 295 px window", () => {
  // Measured at 360 on the demo draft: the pane was 295 px wide and its longest line reached 462, so 167 px of every long line sat
  // behind a sideways drag inside a layer that already fills the screen. The phone wraps by default; a desk keeps `pre` and the
  // toggle is there for either.
  assert.match(chrome, /const phone = useMedia\("\(max-width: 620px\)"\);/, "the pane asks the phone's own breakpoint");
  assert.match(chrome, /const wrap = wrapPref \?\? phone;/, "the phone starts wrapped, and a press overrides it");
  assert.match(chrome, /<Button variant="small" aria-pressed=\{wrap\} onClick=\{\(\) => setWrapPref\(!wrap\)\}>Wrap lines<\/Button>/, "the toggle names its state to a screen reader and to a thumb");
  const wrap = blocksFor(designerCss, ".yaml-pane.wrap").join(";");
  assert.match(wrap, /white-space:\s*pre-wrap/, "a wrapped line breaks at the pane's edge");
  assert.match(wrap, /overflow-wrap:\s*anywhere/, "and a path with no space in it breaks too");
});

test("at 560px and below the assistant dock is the whole screen, so it is a layer; above that it stays beside the work", () => {
  assert.match(dock, /const phone = useMedia\("\(max-width: 560px\)"\);/, "the same breakpoint the sheet sizes it at");
  assert.match(dock, /useDismissable<HTMLDivElement>\(open && phone, close, \{ initialFocus: "root" \}\)/, "only the phone dock traps Tab, and focus starts on the layer, not the composer");
  assert.match(dock, /if \(!phone\) panelRef\.current\?\.querySelector<HTMLTextAreaElement>\("textarea"\)\?\.focus\(\);/, "the phone does not open the keyboard over the transcript");
  assert.match(dock, /aria-modal=\{phone \? "true" : undefined\}/, "only the phone dock is modal");
  assert.match(dock, /\{phone \? <div className="ms-dock-scrim" aria-hidden="true" onClick=\{close\} \/> : null\}/, "only the phone dock has a ground");
  const scrim = blocksFor(dockCss, ".ms-dock-scrim").join(";");
  assert.match(scrim, /position:\s*fixed/);
  assert.match(scrim, /z-index:\s*calc\(var\(--z-overlay\)\s*-\s*1\)/);
  const phoneCss = mediaBlock(dockCss, /max-width:\s*560px/);
  assert.match(phoneCss, /\.ms-dock \{[^}]*z-index:\s*var\(--z-overlay\)/, "the phone dock is above the ground it sits on");
  assert.match(dockCss, /body:has\(\.ms-dock-scrim\)[^{]*\{[^}]*overflow:\s*hidden/, "and the page under it does not scroll");
});

/* ------------------------------------------------ names are read, not cut */

test("the phone roster gives a seat's name its own line and wraps it: no ellipsis, no flags beside it", () => {
  assert.match(seatList, /<span className="nm">\{id\}<\/span>\s*\{shownRole \|\| hasFlags \? \(\s*<span className="ms-seatrow-sub">/, "the name has the line; role and flags are in the block below");
  const name = blocksFor(topologyCss, ".ms-seatrow .nm").join(";");
  assert.match(name, /overflow-wrap:\s*anywhere/, "a long hyphenated name breaks instead of overflowing");
  assert.doesNotMatch(name, /text-overflow:\s*ellipsis/, "and it is never cut with an ellipsis");
  assert.doesNotMatch(name, /white-space:\s*nowrap/, "nor held to one line");
});

test("a canvas card wraps its name over two lines, and shows a role only when it says something the name does not", () => {
  const name = blocksFor(topologyCss, ".ms-seat .nm").join(";");
  assert.match(name, /-webkit-line-clamp:\s*2/, "two lines are allowed");
  assert.match(name, /overflow-wrap:\s*anywhere/);
  assert.doesNotMatch(name, /text-overflow:\s*ellipsis/, "the old single-line cut is gone");
  assert.match(topology, /const roleLine = \[role === id \? "" : role \|\| "no role"/, "the role is blanked when it is the id over again");
});

/* ------------------------------------------------ the guide opens one step, not four */

test("the setup guide opens the step that is now, and every other step is a button that opens it", () => {
  assert.match(guide, /const \[extra, setExtra\] = useState<string\[\]>\(\[\]\);/, "the other steps are opened by the person");
  assert.match(guide, /const isOpen = \(key: string\): boolean => stateOf\(key\) === "now" \|\| extra\.includes\(key\);/, "the now step is open by itself");
  assert.match(guide, /<button type="button" className="ms-step-toggle" aria-expanded=\{open\}/, "a collapsed step is a named button that says whether it is open");
  assert.match(guide, /\{open \? s\.body : null\}/, "a step's body is rendered only while it is open");
  const phoneCss = mediaBlock(designerCss, /max-width:\s*760px/);
  assert.match(phoneCss, /\.ms-guide button[^{]*\{[^}]*min-height:\s*44px/, "those buttons are a thumb's height on the phone (and tablet) the guide is for");
});
