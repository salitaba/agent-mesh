/**
 * What the shared script does for a person on a long page, run unchanged in the small DOM the account pages' tests use
 * (tests/cloud/pages-support.ts), with the little a browser adds that the DOM does not have: where things are on the screen, a
 * window, timers the test runs by hand, and an IntersectionObserver the test drives. How it looks and how it moves is looked at
 * in a browser; what is pinned here is the script's own part: which pages carry the On this page bar and where its chips go,
 * which chip is marked for a reading position, and that a chip that is followed is marked at once and stays marked on the way.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as vm from "node:vm";
import { parsePage, type FakeDocument, type FakeNode } from "../cloud/pages-support";
import { SITE, page, sitePages } from "./site-pages";

const SCRIPT = fs.readFileSync(path.join(SITE, "assets", "site.js"), "utf8");
const CSS = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
const pages = sitePages();

interface Pure {
  readingAt(tops: number[], line: number): number;
  docMatches(text: string, query: string): boolean;
}

/** The script's pure parts, as it exports them when it is loaded as a module (in a browser nothing is exported). */
function pure(): Pure {
  const module = { exports: {} as Record<string, unknown> };
  vm.runInNewContext(SCRIPT, { module }, { filename: "site.js" });
  return module.exports as unknown as Pure;
}

/** A node of the small DOM with the parts of a browser's element the script reads or calls, which the test sets by hand. */
type Placed = FakeNode & {
  getBoundingClientRect?: () => { top: number; bottom: number; left: number; right: number };
  closest?: (selector: string) => FakeNode | null;
  scrollLeft?: number;
  scrollTo?: (to: { left: number; behavior: string }) => void;
};

class FakeObserver {
  static made: FakeObserver[] = [];
  observed: FakeNode[] = [];
  constructor(
    readonly callback: () => void,
    readonly options: { rootMargin: string },
  ) {
    FakeObserver.made.push(this);
  }
  observe(node: FakeNode): void {
    this.observed.push(node);
  }
  disconnect(): void {
    this.observed = [];
  }
}

interface Reading {
  doc: FakeDocument;
  chips: Placed[];
  marked: () => string[];
  /** Put the sections' tops where they would be (pixels from the top of the window) and let the observer say so. */
  at: (tops: number[]) => void;
  fire: (type: string) => void;
  runTimers: () => void;
  rowScrolls: number[];
  observer: () => FakeObserver;
}

/** A page with the script run on it, in a window `height` pixels tall whose observer, timers and events the test drives. */
function read(rel: string, height = 800): Reading {
  FakeObserver.made = [];
  const doc = parsePage(page(pages, rel).html);
  const bar = doc.querySelector(".toc-bar")!;
  const row = bar.querySelector(".toc") as Placed;
  const chips = row.querySelectorAll("a") as Placed[];
  const sections = chips.map((a) => doc.getElementById(a.getAttribute("href")!.slice(1)) as Placed);
  let tops = sections.map(() => 5000);
  sections.forEach((s, i) => (s.getBoundingClientRect = () => ({ top: tops[i]!, bottom: tops[i]! + 600, left: 0, right: 1280 })));
  // The row is 390 wide and each chip 160, so that from the third on a chip is out of view until the row is scrolled.
  row.scrollLeft = 0;
  const rowScrolls: number[] = [];
  row.scrollTo = ({ left }) => {
    rowScrolls.push(left);
    row.scrollLeft = left;
  };
  row.getBoundingClientRect = () => ({ top: 69, bottom: 130, left: 0, right: 390 });
  chips.forEach((chip, i) => {
    chip.getBoundingClientRect = () => ({ top: 77, bottom: 121, left: 16 + i * 168 - row.scrollLeft!, right: 16 + i * 168 + 160 - row.scrollLeft! });
    chip.closest = () => chip;
  });
  const listeners = new Map<string, Array<() => void>>();
  const timers: Array<() => void> = [];
  const window = {
    IntersectionObserver: FakeObserver,
    innerHeight: height,
    getComputedStyle: () => ({ scrollPaddingTop: "150px" }),
    matchMedia: () => ({ matches: true }),
    addEventListener: (type: string, fn: () => void) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    setTimeout: (fn: () => void) => timers.push(fn),
    clearTimeout: () => undefined,
  };
  vm.runInNewContext(SCRIPT, { document: doc, navigator: {}, window }, { filename: "site.js" });
  const observer = (): FakeObserver => FakeObserver.made[FakeObserver.made.length - 1]!;
  return {
    doc,
    chips,
    marked: () => chips.filter((a) => a.getAttribute("aria-current") !== null).map((a) => `${a.textContent}=${a.getAttribute("aria-current")}`),
    at: (next) => {
      tops = next;
      observer().callback();
    },
    fire: (type) => (listeners.get(type) ?? []).forEach((fn) => fn()),
    runTimers: () => timers.splice(0).forEach((fn) => fn()),
    rowScrolls,
    observer,
  };
}

/** A click on a chip, as the browser sends it to the row's listener. */
function click(r: Reading, i: number): void {
  const chip = r.chips[i]!;
  const row = chip.parent!.parent!;
  for (const fn of row.listeners.get("click") ?? []) fn({ type: "click", target: chip, currentTarget: row, defaultPrevented: false, preventDefault() {} });
}

test("the long pages carry an On this page bar right under their heading, and each chip names a section of the page, in order", () => {
  const withBar = pages.filter((p) => p.markup.includes('class="toc-bar"'));
  assert.deepEqual(withBar.map((p) => p.rel), ["legal/index.html", "pricing/index.html", "security/index.html"]);
  for (const p of withBar) {
    // The bar follows the page's heading inside <main>, so that it can stay under the header through the whole of the page (a
    // sticky element never leaves the box it is in), and it is one navigation landmark with a name.
    assert.match(p.markup, /<main id="main" tabindex="-1">\s*<section class="page-head has-toc">[\s\S]*?<\/section>\s*<nav class="toc-bar" aria-label="On this page">\s*<ul class="toc">/, p.rel);
    const nav = /<nav class="toc-bar"[\s\S]*?<\/nav>/.exec(p.markup)![0];
    const ids = [...nav.matchAll(/<li><a href="#([\w-]+)">[^<]+<\/a><\/li>/g)].map((m) => m[1]!);
    assert.equal(ids.length, (nav.match(/<a /g) ?? []).length, `${p.rel}: every chip is a plain link to a place on the page`);
    assert.ok(ids.length >= 3, `${p.rel}: a bar of ${ids.length} sections`);
    const where = ids.map((id) => {
      const section = new RegExp(`<section\\b[^>]*\\sid="${id}"[^>]*>`).exec(p.markup);
      assert.ok(section, `${p.rel}: #${id} is a section of the page`);
      // A section that the Curule Cloud switch hides would leave a chip that goes nowhere.
      assert.ok(!/\shidden\b|data-cloud-only|data-selfhost-only/.test(section[0]), `${p.rel}: #${id} is on the page whether or not Curule Cloud is open`);
      return section.index;
    });
    assert.deepEqual(where, [...where].sort((a, b) => a - b), `${p.rel}: the chips are in the order of the page`);
  }
  for (const p of pages) assert.equal((p.markup.match(/aria-label="On this page"/g) ?? []).length, withBar.includes(p) ? 1 : 0, `${p.rel}: one list of the page's sections at most`);
});

test("the stylesheet's heights for the header and the bar are the heights it gives them, so a followed heading lands below both", () => {
  const head = Number(/--head-h: (\d+)px;/.exec(CSS)![1]);
  const toc = Number(/--toc-h: (\d+)px;/.exec(CSS)![1]);
  assert.equal(head, Number(/\n\.bar \{[^}]*min-height: (\d+)px/.exec(CSS)![1]) + 1, "the header: its row and its line");
  const chip = Number(/\n\.toc a \{[^}]*min-height: (\d+)px/.exec(CSS)![1]);
  const room = Number(/\n\.toc \{[^}]*padding: (\d+)px /.exec(CSS)![1]);
  assert.ok(chip >= 44, "a chip is a 44 pixel target");
  assert.equal(toc, chip + 2 * room + 1, "the bar: a chip, the room above and below it, and its line");
  assert.match(CSS, /\nhtml \{[^}]*scroll-padding-top: calc\(var\(--head-h\) \+ \d+px\);/, "a page without the bar: below the header");
  assert.match(CSS, /\nhtml:has\(\.toc-bar\) \{ scroll-padding-top: calc\(var\(--head-h\) \+ var\(--toc-h\) \+ \d+px\); \}/, "a page with it: below both");
  assert.match(CSS, /\n\.toc-bar\.is-live \{ position: sticky; top: var\(--head-h\);/, "it stays right under the header, and only once the script says so");
  assert.match(CSS, /\n\.toc \{[^}]*overflow-x: auto;/, "one row, scrolled sideways when it does not fit");
  assert.ok(!/\n\.toc \{[^}]*flex-wrap: wrap/.test(CSS), "never wrapped onto more rows, which would make it taller when it stays");
});

test("the section being read is the last one whose top has passed the line, and none before the first has", () => {
  const { readingAt } = pure();
  assert.equal(readingAt([], 300), -1);
  assert.equal(readingAt([400, 900, 1500], 300), -1, "the page's heading is still being read");
  assert.equal(readingAt([300, 900, 1500], 300), 0, "a top on the line has passed it");
  assert.equal(readingAt([-1200, 120, 900], 300), 1);
  assert.equal(readingAt([-3000, -2000, -900], 300), 2, "past the last section, the last one stays the one being read");
  assert.equal(readingAt([-500, Infinity, 200], 300), 2, "a section that is not there is skipped");
});

test("on a page, the bar is made to stay and the chip of the section being read is marked, by itself and with aria-current", () => {
  const r = read("security/index.html");
  assert.match(r.doc.querySelector(".toc-bar")!.className, /\bis-live\b/);
  // The line is a third of an 800 pixel window, never above the scroll padding (150) and 20 more; the observer's root ends there.
  assert.equal(r.observer().options.rootMargin, "0px 0px -533px 0px");
  assert.equal(r.observer().observed.length, 6, "each section is watched");
  r.at([500, 2000, 2700, 3800, 4600, 5300]);
  assert.deepEqual(r.marked(), [], "at the top of the page no section is being read yet");
  r.at([-1300, 200, 900, 2000, 2800, 3500]);
  assert.deepEqual(r.marked(), ["What leaves your environment=true"]);
  r.at([-4500, -3000, -2300, -1200, -400, 260]);
  assert.deepEqual(r.marked(), ["Reporting a problem=true"]);
  r.at([500, 2000, 2700, 3800, 4600, 5300]);
  assert.deepEqual(r.marked(), [], "and back at the top, none");
});

test("the marked chip is scrolled into view in its row, and only when it is not in view already", () => {
  const r = read("security/index.html");
  r.at([-1300, 200, 900, 2000, 2800, 3500]);
  assert.deepEqual(r.rowScrolls, [], "the second chip is in view in a 390 pixel row");
  r.at([-2000, -900, 200, 1300, 2100, 2800]);
  // The third chip spans 352 to 512: the row scrolls to show it with 24 pixels to spare (512 + 24 - 390).
  assert.deepEqual(r.rowScrolls, [146]);
  r.at([-1300, 200, 900, 2000, 2800, 3500]);
  // Back to the second (184 to 344, less the 146 scrolled): it is in view, so the row stays where it is.
  assert.deepEqual(r.rowScrolls, [146]);
  r.at([-300, 1200, 1900, 3000, 3800, 4500]);
  assert.deepEqual(r.rowScrolls, [146, 0], "the first chip, back at the start of the row");
});

test("a chip that is followed is marked at once, and the sections passed on the way there are not marked", () => {
  const r = read("security/index.html");
  r.at([500, 2000, 2700, 3800, 4600, 5300]);
  click(r, 4);
  assert.deepEqual(r.marked(), ["Assurance=true"], "marked as it is chosen");
  r.at([-900, 600, 1300, 2400, 3200, 3900]);
  r.at([-2500, -1000, -300, 800, 1600, 2300]);
  assert.deepEqual(r.marked(), ["Assurance=true"], "the page passes What leaves your environment and What it does not do");
  r.at([-4000, -2500, -1800, -700, 150, 800]);
  assert.deepEqual(r.marked(), ["Assurance=true"], "and gets there");
  r.at([-4600, -3100, -2400, -1300, -450, 200]);
  assert.deepEqual(r.marked(), ["Reporting a problem=true"], "from there on, reading is followed again");
});

test("when the scroll ends somewhere else, or never says it has ended, the chip of where the reader is gets the mark", () => {
  const r = read("security/index.html");
  r.at([500, 2000, 2700, 3800, 4600, 5300]);
  click(r, 5);
  r.at([-1300, 200, 900, 2000, 2800, 3500]);
  assert.deepEqual(r.marked(), ["Reporting a problem=true"]);
  r.fire("scrollend");
  assert.deepEqual(r.marked(), ["What leaves your environment=true"], "the reader stopped the scroll on the way");
  click(r, 0);
  r.at([-2000, -900, 200, 1300, 2100, 2800]);
  assert.deepEqual(r.marked(), ["What it protects=true"]);
  r.runTimers();
  assert.deepEqual(r.marked(), ["What it does not do=true"], "a browser without scrollend lets go after a while");
});

test("on a short window the line stays below where a followed section lands, so a section that was followed counts as read", () => {
  const r = read("legal/index.html", 390);
  // A third of 390 is 130, above the 150 where a followed section's top lands: the line is the landing place and 20 more.
  assert.equal(r.observer().options.rootMargin, "0px 0px -220px 0px");
  r.at([150, 1200, 2300]);
  assert.deepEqual(r.marked(), ["The licence=true"]);
});

test("without an IntersectionObserver the bar is left as it is without a script: where it is, with nothing marked", () => {
  for (const rel of ["security/index.html", "pricing/index.html", "legal/index.html"]) {
    const doc = parsePage(page(pages, rel).html);
    vm.runInNewContext(SCRIPT, { document: doc, navigator: {}, window: { setTimeout, clearTimeout } }, { filename: "site.js" });
    assert.ok(!/is-live/.test(doc.querySelector(".toc-bar")!.className), rel);
    assert.equal(doc.querySelectorAll("[aria-current]").filter((n) => n.getAttribute("aria-current") === "true").length, 0, rel);
  }
});

// ---------------------------------------------------------------- back to top

interface Scrolled {
  doc: FakeDocument;
  win: { innerHeight: number; scrollY: number };
  scrolls: Array<{ top: number; behavior: string }>;
  fire: (type: string) => void;
  button: () => FakeNode | null;
}

/** A page with the script run on it in a window that scrolls, as tall as `height`; `reduce` is the visitor's motion setting. */
function scrolled(rel: string, reduce = true, height = 800): Scrolled {
  const doc = parsePage(page(pages, rel).html);
  const listeners = new Map<string, Array<() => void>>();
  const scrolls: Array<{ top: number; behavior: string }> = [];
  const win = {
    innerHeight: height,
    scrollY: 0,
    matchMedia: () => ({ matches: reduce }),
    addEventListener: (type: string, fn: () => void) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    requestAnimationFrame: (fn: () => void) => fn(),
    scrollTo: (to: { top: number; behavior: string }) => {
      // Copied: an object made inside the sandbox has another realm's prototype, which deepEqual tells apart.
      scrolls.push({ top: to.top, behavior: to.behavior });
      win.scrollY = to.top;
    },
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(SCRIPT, { document: doc, navigator: {}, window: win }, { filename: "site.js" });
  return { doc, win, scrolls, fire: (type) => (listeners.get(type) ?? []).forEach((fn) => fn()), button: () => doc.querySelector(".to-top") };
}

test("every page gets a Back to top button at the end of its content: a real button with a name, shown from two screens down", () => {
  for (const p of pages) {
    const r = scrolled(p.rel);
    const main = r.doc.getElementById("main")!;
    const dock = main.children[main.children.length - 1]!;
    assert.equal(dock.className, "to-top-dock", `${p.rel}: the last thing in <main>, so that it stops above the footer`);
    const button = r.button()!;
    assert.ok(button.parent === dock, `${p.rel}: the button is in the dock`);
    assert.equal(button.tag, "button");
    assert.equal(button.getAttribute("type"), "button", `${p.rel}: it submits nothing`);
    assert.equal(button.textContent, "Back to top", `${p.rel}: its name, said by a screen reader`);
    assert.equal(button.querySelector(".sr")!.textContent, "Back to top", "and shown as the arrow");
    assert.equal(button.className, "to-top", `${p.rel}: not shown at the top of the page`);
    r.win.scrollY = 1600;
    r.fire("scroll");
    assert.equal(button.className, "to-top", "two screens down exactly is not yet past them");
    r.win.scrollY = 1700;
    r.fire("scroll");
    assert.equal(button.className, "to-top is-shown");
    r.win.scrollY = 900;
    r.fire("scroll");
    assert.equal(button.className, "to-top", "and it goes when the reader is back near the top");
    r.win.innerHeight = 400;
    r.fire("resize");
    assert.equal(button.className, "to-top is-shown", "two screens of a smaller window");
  }
});

test("Back to top goes to the top at once under reduced motion and smoothly otherwise, and takes the focus to the content", () => {
  for (const reduce of [true, false]) {
    const r = scrolled("security/index.html", reduce);
    r.win.scrollY = 5000;
    r.fire("scroll");
    const button = r.button()!;
    for (const fn of button.listeners.get("click") ?? []) fn({ type: "click", target: button, currentTarget: button, defaultPrevented: false, preventDefault() {} });
    // "auto" is the stylesheet's choice, which is to jump: it scrolls smoothly only for a visitor who has not asked for less.
    assert.deepEqual(r.scrolls, [{ top: 0, behavior: reduce ? "auto" : "smooth" }]);
    // Compared as nodes, not printed: a node of the small DOM holds the whole page, and a failure would print all of it.
    assert.ok(r.doc.activeElement === r.doc.getElementById("main"), "the next Tab starts from the top of the content");
  }
  assert.match(CSS, /@media \(prefers-reduced-motion: no-preference\) \{\s*html \{ scroll-behavior: smooth; \}/, "and the stylesheet scrolls smoothly only then");
});

test("a hidden Back to top button is out of the way of the keyboard and of print, and is a 44 pixel target when it is shown", () => {
  assert.match(CSS, /\n\.to-top:not\(\.is-shown\) \{ visibility: hidden;/, "a hidden button cannot be reached with Tab or heard");
  const size = /\n\.to-top \{[^}]*width: (\d+)px; height: (\d+)px;/.exec(CSS)!;
  assert.ok(Number(size[1]) >= 44 && Number(size[2]) >= 44, `${size[1]} by ${size[2]}`);
  assert.match(CSS, /\n\.to-top-dock \{ position: sticky; bottom: 0;[^}]*height: 0; \}/, "it rides at the bottom of the window only while the content is there");
  assert.match(/@media print \{[\s\S]*?\n\}/.exec(CSS)![0], /\.to-top-dock \{ display: none; \}/);
});

test("a window that cannot be scrolled by the script gets no Back to top button, and the page is as it was", () => {
  for (const p of pages) {
    const doc = parsePage(p.html);
    vm.runInNewContext(SCRIPT, { document: doc, navigator: {}, window: { setTimeout, clearTimeout } }, { filename: "site.js" });
    assert.equal(doc.querySelectorAll(".to-top").length, 0, p.rel);
  }
});

// ---------------------------------------------------------------- the documentation page's filter

test("a document matches when every word typed is in its text, in any case and order, with a curly apostrophe typed straight", () => {
  const { docMatches } = pure();
  const text = "Security questionnaire Short Answers to the questions a buyer\u2019s security team usually asks. docs/commercial/security-questionnaire.md Security What it protects";
  assert.equal(docMatches(text, ""), true, "nothing typed keeps everything");
  assert.equal(docMatches(text, "   "), true);
  assert.equal(docMatches(text, "QUESTIONNAIRE"), true);
  assert.equal(docMatches(text, "security   short"), true, "any space between the words");
  assert.equal(docMatches(text, "short security"), true, "in any order");
  assert.equal(docMatches(text, "buyer's"), true, "an apostrophe typed straight finds a curly one");
  assert.equal(docMatches(text, "commercial/security-q"), true, "a piece of a path");
  assert.equal(docMatches(text, "ques"), true, "a piece of a word");
  assert.equal(docMatches(text, "security guide"), false, "every word has to be there");
});

interface Filtered {
  doc: FakeDocument;
  field: FakeNode;
  type: (value: string) => void;
  key: (key: string) => boolean;
  shown: () => string[];
  groups: () => number;
  count: () => string;
  runTimers: () => void;
}

/** An event as the browser hands it to a listener. */
const event = (target: FakeNode, extra: Record<string, unknown> = {}) => ({ type: "", target, currentTarget: target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra });

/** The documentation page with the script run on it. Its timers wait until the test runs them, as a pause in the typing would. */
function docsPage(): Filtered {
  const doc = parsePage(page(pages, "docs/index.html").html);
  const timers: Array<() => void> = [];
  vm.runInNewContext(SCRIPT, { document: doc, navigator: {}, window: { setTimeout: (fn: () => void) => timers.push(fn), clearTimeout: () => undefined } }, { filename: "site.js" });
  const field = doc.getElementById("doc-filter-input")!;
  const visible = (n: FakeNode): boolean => {
    for (let x: FakeNode | null = n; x; x = x.parent) if (x.hidden) return false;
    return true;
  };
  return {
    doc,
    field,
    type: (value) => {
      field.value = value;
      for (const fn of field.listeners.get("input") ?? []) fn(event(field));
    },
    key: (key) => {
      const e = event(field, { key });
      for (const fn of field.listeners.get("keydown") ?? []) fn(e);
      return e.defaultPrevented;
    },
    shown: () => doc.querySelectorAll(".doc-list li").filter(visible).map((li) => li.querySelector("a")!.textContent),
    groups: () => doc.querySelectorAll(".doc-card").filter(visible).length,
    count: () => doc.getElementById("doc-filter-count")!.textContent,
    runTimers: () => timers.splice(0).forEach((fn) => fn()),
  };
}

test("the filter is not on the page without a script, and with one it is there, with how many documents there are", () => {
  const html = page(pages, "docs/index.html").html;
  assert.match(html, /<div class="doc-filter[^"]*" id="doc-filter" hidden>/, "hidden until the script has wired it");
  assert.match(html, /<div class="doc-none[^"]*" id="doc-filter-none" hidden>/);
  assert.match(html, /<label for="doc-filter-input">Filter the documents<\/label>/, "a field with a label that says what it does");
  assert.match(html, /<p class="count" id="doc-filter-count" role="status"><\/p>/, "and a polite live region for the count");
  const r = docsPage();
  const all = r.doc.querySelectorAll(".doc-list li").length;
  assert.ok(all >= 14);
  assert.equal(r.doc.getElementById("doc-filter")!.hidden, false);
  assert.equal(r.doc.getElementById("doc-filter-none")!.hidden, true);
  assert.equal(r.count(), `All ${all} documents`);
  assert.equal(r.shown().length, all);
});

test("typing keeps the documents with every word, hides a group with none left, and says how many after a pause", () => {
  const r = docsPage();
  const all = r.doc.querySelectorAll(".doc-list li");
  const guides = all.filter((li) => li.getAttribute("data-kind") === "guide").map((li) => li.querySelector("a")!.textContent);
  r.type("Guide");
  assert.deepEqual(r.shown(), guides, "the label is part of what is matched: Guide keeps the guides, and only them");
  assert.ok(r.groups() < r.doc.querySelectorAll(".doc-card").length, "a group with no guide is hidden");
  assert.equal(r.count(), `All ${all.length} documents`, "the count waits for a pause in the typing");
  r.runTimers();
  assert.equal(r.count(), `${guides.length} of ${all.length} documents`);
  r.type("guide deploy");
  assert.deepEqual(r.shown(), ["Try it in a minute", "Deploying Curule"]);
  r.type("concepts");
  assert.deepEqual(r.shown(), ["Architecture"], "a group's name finds its documents");
  r.type("SECURITY.md");
  assert.deepEqual(r.shown(), ["Security", "Security policy"], "a path, in any case: SECURITY.md and docs/commercial/security.md");
  r.type("commercial/security.md");
  assert.deepEqual(r.shown(), ["Security"]);
  assert.equal(r.doc.getElementById("doc-filter-none")!.hidden, true);
});

test("when nothing matches the page says so, names what was typed, and Clear the filter brings everything back to the field", () => {
  const r = docsPage();
  const all = r.doc.querySelectorAll(".doc-list li").length;
  r.type("  kubernetes   operator ");
  r.runTimers();
  assert.deepEqual(r.shown(), []);
  assert.equal(r.groups(), 0);
  const none = r.doc.getElementById("doc-filter-none")!;
  assert.equal(none.hidden, false);
  assert.equal(r.doc.getElementById("doc-filter-said")!.textContent, "kubernetes   operator");
  assert.equal(r.count(), `0 of ${all} documents`);
  const clear = r.doc.getElementById("doc-filter-clear")!;
  assert.equal(clear.tag, "button");
  for (const fn of clear.listeners.get("click") ?? []) fn(event(clear));
  r.runTimers();
  assert.equal(r.field.value, "");
  assert.equal(r.shown().length, all);
  assert.equal(none.hidden, true);
  assert.equal(r.count(), `All ${all} documents`);
  assert.ok(r.doc.activeElement === r.field, "the focus goes back to the field");
});

test("Escape clears what is typed, and is left alone when there is nothing to clear", () => {
  const r = docsPage();
  const all = r.doc.querySelectorAll(".doc-list li").length;
  r.type("reference");
  assert.ok(r.shown().length < all);
  assert.equal(r.key("Escape"), true, "taken by the field");
  assert.equal(r.field.value, "");
  assert.equal(r.shown().length, all);
  assert.equal(r.key("Escape"), false, "an empty field lets Escape through");
  assert.equal(r.key("a"), false);
});

test("the filter is for the map and leaves the cards at the top alone: they are shown with nothing matching, and their links are set", () => {
  const r = docsPage();
  const starts = r.doc.querySelectorAll(".start");
  assert.equal(starts.length, 4);
  const visible = (n: FakeNode): boolean => {
    for (let x: FakeNode | null = n; x; x = x.parent) if (x.hidden) return false;
    return true;
  };
  r.type("kubernetes operator");
  assert.equal(r.groups(), 0, "nothing in the map matches");
  assert.deepEqual(starts.map(visible), [true, true, true, true], "and the cards that start a visitor are still there");
  assert.equal(r.doc.getElementById("doc-filter-none")!.hidden, false);
  for (const a of r.doc.querySelectorAll(".start a")) {
    if (a.hasAttribute("data-doc")) assert.match(a.href, /^https:\/\/github\.com\/salitaba\/agent-mesh\/blob\/main\/docs\/[\w/.#-]+$/, "the script gave the title its address");
  }
});

// ---------------------------------------------------------------- the phone menu

test("the phone menu closes on a touch anywhere else and when Tab takes the focus out of it, and stays open while the focus is in it", () => {
  for (const p of pages) {
    const doc = parsePage(p.html);
    vm.runInNewContext(SCRIPT, { document: doc, navigator: {}, window: { setTimeout, clearTimeout } }, { filename: "site.js" });
    const menu = doc.querySelector(".menu") as FakeNode & { open?: boolean };
    const summary = menu.querySelector("summary")!;
    const inside = menu.querySelector(".menu-panel a")!;
    const outside = doc.getElementById("main")!;
    const touch = (target: FakeNode): void => (doc.listeners.get("pointerdown") ?? []).forEach((fn) => fn(event(target)));
    const leave = (to: FakeNode | null): void => (menu.listeners.get("focusout") ?? []).forEach((fn) => fn(event(summary, { relatedTarget: to })));
    menu.open = true;
    touch(inside);
    touch(summary);
    assert.equal(menu.open, true, `${p.rel}: a touch in the menu is the menu's own (the summary opens and closes it itself)`);
    touch(outside);
    assert.equal(menu.open, false, `${p.rel}: a touch on the page closes it`);
    menu.open = true;
    leave(inside);
    leave(null);
    assert.equal(menu.open, true, `${p.rel}: the focus moving inside it, or the window losing it, leaves it open`);
    leave(outside);
    assert.equal(menu.open, false, `${p.rel}: Tab out of it closes it`);
  }
});
