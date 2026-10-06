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
