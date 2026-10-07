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
import { FakeNode, parsePage, type FakeDocument } from "../cloud/pages-support";
import { SITE, decode, page, sitePages } from "./site-pages";

const SCRIPT = fs.readFileSync(path.join(SITE, "assets", "site.js"), "utf8");
const CSS = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
const pages = sitePages();

// The small DOM has no appendChild, insertBefore, firstChild, nextSibling or parentNode, which the copy buttons use in a browser: the
// few lines that give it those, so that the script can run on a page with a clipboard. Each test file is its own process.
const nodes = FakeNode.prototype as unknown as Record<string, unknown>;
if (!("insertBefore" in nodes)) {
  Object.defineProperties(nodes, {
    parentNode: { get(this: FakeNode) { return this.parent; } },
    firstChild: { get(this: FakeNode) { return this.children[0] ?? null; } },
    nextSibling: { get(this: FakeNode) { return this.parent?.children[this.parent.children.indexOf(this) + 1] ?? null; } },
  });
  nodes.appendChild = function (this: FakeNode, node: FakeNode): FakeNode {
    this.append(node);
    return node;
  };
  nodes.insertBefore = function (this: FakeNode, node: FakeNode, before: FakeNode | null): FakeNode {
    node.parent?.children.splice(node.parent.children.indexOf(node), 1);
    node.parent = this;
    const at = before ? this.children.indexOf(before) : -1;
    if (at < 0) this.children.push(node);
    else this.children.splice(at, 0, node);
    return node;
  };
}

interface Pure {
  readingAt(tops: number[], line: number): number;
  docMatches(text: string, query: string): boolean;
  scrolledOff(y: number): boolean;
  staggerOf(index: number): number;
  startsHidden(top: number, windowHeight: number): boolean;
  withClass(names: string, name: string, on: boolean): string;
  withoutArrival(names: string): string;
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
  unobserve(node: FakeNode): void {
    this.observed = this.observed.filter((n) => n !== node);
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
  /** The same, without the observer saying anything (a jump that passes whole sections at once), and the window's scroll event instead. */
  jumpTo: (tops: number[]) => void;
  fire: (type: string) => void;
  runTimers: () => void;
  rowScrolls: number[];
  observer: () => FakeObserver;
}

/** A page with the script run on it, in a window `height` pixels tall whose observer, timers and events the test drives. */
function read(rel: string, height = 800, reduce = true): Reading {
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
    matchMedia: () => ({ matches: reduce }),
    addEventListener: (type: string, fn: () => void) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    requestAnimationFrame: (fn: () => void) => fn(),
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
    jumpTo: (next) => {
      tops = next;
      (listeners.get("scroll") ?? []).forEach((fn) => fn());
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

test("a jump that passes whole sections at once (Back to top under reduced motion) clears the mark and brings the row back to its first chips", () => {
  const r = read("security/index.html");
  r.at([-4500, -3000, -2300, -1200, -400, 260]);
  assert.deepEqual(r.marked(), ["Reporting a problem=true"]);
  assert.ok(r.chips[0]!.getBoundingClientRect!().left < 0, "the row was scrolled to the last chips");
  // The observer is told when a top crosses the line; nothing crosses it from where the last section is to the top in one step.
  r.jumpTo([500, 2000, 2700, 3800, 4600, 5300]);
  assert.deepEqual(r.marked(), [], "the bar does not say the reader is in the last section at the top of the page");
  assert.equal(r.rowScrolls[r.rowScrolls.length - 1], 0, "and the row shows its first chips again");
  assert.ok(r.chips[0]!.getBoundingClientRect!().left >= 0);
  // With the row already at its start there is nothing to bring back: reading the first section and then going to the top moves nothing.
  r.jumpTo([-300, 1200, 1900, 3000, 3800, 4500]);
  assert.deepEqual(r.marked(), ["What it protects=true"]);
  const scrolled = r.rowScrolls.length;
  r.jumpTo([500, 2000, 2700, 3800, 4600, 5300]);
  assert.deepEqual(r.marked(), []);
  assert.equal(r.rowScrolls.length, scrolled, "the row is not scrolled when it is at its start");
  // A jump the other way, from the top to a section in the middle, is marked as well.
  r.jumpTo([-1300, 200, 900, 2000, 2800, 3500]);
  assert.deepEqual(r.marked(), ["What leaves your environment=true"]);
  // It is looked at once a frame, not on every event, and a hold on a followed chip is still held until the page gets there.
  const held = read("security/index.html");
  held.at([500, 2000, 2700, 3800, 4600, 5300]);
  click(held, 4);
  held.jumpTo([-900, 600, 1300, 2400, 3200, 3900]);
  assert.deepEqual(held.marked(), ["Assurance=true"], "the sections the page passes on the way to a chip that was followed are not marked");
});

test("the bar and Back to top work together on a long page: one scroll event updates both, and neither holds the other back", () => {
  FakeObserver.made = [];
  const doc = parsePage(page(pages, "security/index.html").html);
  const row = doc.querySelector(".toc-bar")!.querySelector(".toc") as Placed;
  const chips = row.querySelectorAll("a") as Placed[];
  const sections = chips.map((a) => doc.getElementById(a.getAttribute("href")!.slice(1)) as Placed);
  let tops = sections.map(() => 5000);
  sections.forEach((s, i) => (s.getBoundingClientRect = () => ({ top: tops[i]!, bottom: tops[i]! + 600, left: 0, right: 1280 })));
  row.scrollLeft = 0;
  row.scrollTo = ({ left }) => void (row.scrollLeft = left);
  row.getBoundingClientRect = () => ({ top: 69, bottom: 130, left: 0, right: 390 });
  chips.forEach((chip, i) => (chip.getBoundingClientRect = () => ({ top: 77, bottom: 121, left: 16 + i * 168 - row.scrollLeft!, right: 16 + i * 168 + 160 - row.scrollLeft! })));
  const listeners = new Map<string, Array<() => void>>();
  // A frame comes after the event, as it does in a browser: the work that was asked for runs once the listeners have all been called.
  const frames: Array<() => void> = [];
  const win = {
    IntersectionObserver: FakeObserver,
    innerHeight: 800,
    scrollY: 0,
    getComputedStyle: () => ({ scrollPaddingTop: "150px" }),
    matchMedia: () => ({ matches: true }),
    addEventListener: (type: string, fn: () => void) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    requestAnimationFrame: (fn: () => void) => frames.push(fn),
    scrollTo: () => undefined,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  };
  vm.runInNewContext(SCRIPT, { document: doc, navigator: {}, window: win }, { filename: "site.js" });
  const button = doc.querySelector(".to-top")!;
  const scroll = (y: number, next: number[]): void => {
    win.scrollY = y;
    tops = next;
    (listeners.get("scroll") ?? []).forEach((fn) => fn());
    frames.splice(0).forEach((fn) => fn());
  };
  const marked = (): string[] => chips.filter((a) => a.getAttribute("aria-current") !== null).map((a) => a.textContent);
  scroll(9000, [-4500, -3000, -2300, -1200, -400, 260]);
  assert.equal(button.className, "to-top", "going down it stays out of the way of the lines being read, though the bar looked at the same event");
  assert.deepEqual(marked(), ["Reporting a problem"], "and the bar followed it");
  scroll(8200, [-3700, -2200, -1500, -400, 400, 1060]);
  assert.equal(button.className, "to-top is-shown", "a reader who turns back is offered it, in the one event that moves the bar");
  assert.deepEqual(marked(), [chips[3]!.textContent], "and the bar went back with them");
  scroll(0, [500, 2000, 2700, 3800, 4600, 5300]);
  assert.equal(button.className, "to-top");
  assert.deepEqual(marked(), []);
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

test("every page gets a Back to top button at the end of its content: a real button with a name, shown to a reader who is two screens down and turns back", () => {
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
    r.win.scrollY = 1700;
    r.fire("scroll");
    assert.equal(button.className, "to-top", "going down it is not there, however far: on a phone it would sit on the ends of the lines being read");
    r.win.scrollY = 1600;
    r.fire("scroll");
    assert.equal(button.className, "to-top", "turned back, but two screens down exactly is not yet past them");
    r.win.scrollY = 1650;
    r.fire("scroll");
    r.win.scrollY = 1620;
    r.fire("scroll");
    assert.equal(button.className, "to-top is-shown", "a reader who is past two screens and turns back is offered it");
    r.win.scrollY = 900;
    r.fire("scroll");
    assert.equal(button.className, "to-top", "and it goes when the reader is back near the top");
    r.win.innerHeight = 400;
    r.fire("resize");
    assert.equal(button.className, "to-top is-shown", "two screens of a smaller window");
  }
});

test("Back to top follows the way the reader is going, and a shake of a few pixels does not turn them round", () => {
  const r = scrolled("security/index.html");
  const button = r.button()!;
  const at = (y: number): string => {
    r.win.scrollY = y;
    r.fire("scroll");
    return button.className;
  };
  assert.equal(at(3000), "to-top", "down");
  assert.equal(at(2996), "to-top", "four pixels back is a shake of the thumb, not a turn");
  assert.equal(at(3003), "to-top");
  assert.equal(at(2990), "to-top is-shown", "ten pixels back is");
  assert.equal(at(2993), "to-top is-shown", "and a few pixels the other way do not put it away");
  assert.equal(at(2960), "to-top is-shown", "further back, it stays");
  assert.equal(at(2965), "to-top is-shown", "a little down again: still the same turn");
  assert.equal(at(3010), "to-top", "and going on down puts it away");
  assert.equal(at(3500), "to-top");
  assert.equal(at(3400), "to-top is-shown", "turning back anywhere below two screens offers it again");
  assert.equal(at(0), "to-top", "and at the top there is nothing to go back to");
  assert.equal(at(400), "to-top", "going down from there it is not shown either");
});

test("a reader who has come to the end of the content is offered Back to top whichever way they are going, where it covers nothing", () => {
  const r = scrolled("pricing/index.html");
  const dock = r.doc.getElementById("main")!.children.at(-1) as Placed;
  let top = 800;
  dock.getBoundingClientRect = () => ({ top, bottom: top, left: 0, right: 0 });
  const button = r.button()!;
  const go = (y: number, dockTop: number): string => {
    r.win.scrollY = y;
    top = dockTop;
    r.fire("scroll");
    return button.className;
  };
  assert.equal(go(5000, 800), "to-top", "going down with the end of the content out of sight (the dock rides at the bottom of the window)");
  assert.equal(go(5400, 799.5), "to-top", "the dock is at the window's edge, and not yet in its place");
  assert.equal(go(6000, 700), "to-top is-shown", "the end has come into view: the button is where it rests, above the footer, and covers no text");
  assert.equal(go(6100, 600), "to-top is-shown", "and it stays while the end is in view, going down");
  assert.equal(go(5000, 800), "to-top is-shown", "going up it is shown for the other reason");
  assert.equal(go(5300, 800), "to-top", "and going down again, with the end out of view, it is put away");
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

// ---------------------------------------------------------------- copy buttons

interface Copying {
  doc: FakeDocument;
  /** What the page wrote to the clipboard, in order. */
  written: string[];
  /** The live region the script makes for a screen reader. */
  said: () => string;
  runTimers: () => void;
  click: (button: FakeNode) => Promise<void>;
}

/** A page with the script run on it in a browser that can copy, and that allows it or does not. */
function copying(rel: string, allow = true, edit: (html: string) => string = (html) => html): Copying {
  const doc = parsePage(edit(page(pages, rel).html));
  const written: string[] = [];
  const timers: Array<() => void> = [];
  const navigator = { clipboard: { writeText: (text: string) => (written.push(text), allow ? Promise.resolve() : Promise.reject(new Error("not allowed"))) } };
  vm.runInNewContext(SCRIPT, { document: doc, navigator, window: { setTimeout: (fn: () => void) => timers.push(fn), clearTimeout: () => undefined } }, { filename: "site.js" });
  const region = doc.querySelectorAll("div").find((d) => d.getAttribute("role") === "status")!;
  return {
    doc,
    written,
    said: () => region.textContent,
    runTimers: () => timers.splice(0).forEach((fn) => fn()),
    click: async (button) => {
      for (const fn of button.listeners.get("click") ?? []) fn(event(button));
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test("an address to write to has a copy button right beside it that copies the address and says so, and the address stays a link and text", async () => {
  const r = copying("contact/index.html");
  const rows = r.doc.querySelectorAll(".address-row");
  assert.deepEqual(rows.map((row) => row.id), ["sales", "support", "security"]);
  for (const row of rows) {
    const link = row.querySelector("a[data-mail]")!;
    const button = row.querySelector("button")!;
    const kind = row.id;
    assert.equal(link.getAttribute("data-mail"), kind);
    assert.ok(link.href.startsWith("mailto:") && link.textContent.includes("@"), `${kind}: the address is still a link to a mail program, and text`);
    assert.ok(link.parent!.children.indexOf(button) === link.parent!.children.indexOf(link) + 1, `${kind}: the button is right after the address`);
    assert.equal(button.getAttribute("type") ?? (button as unknown as { type: string }).type, "button", `${kind}: it submits nothing`);
    assert.equal(button.getAttribute("aria-label"), `Copy the ${kind} address`, `${kind}: its name says which address`);
    assert.equal(button.textContent, "Copy");
    await r.click(button);
    assert.equal(r.written[r.written.length - 1], link.textContent.trim(), `${kind}: the address is what was copied`);
    assert.equal(button.textContent, "Copied", `${kind}: and the button says so`);
    assert.equal(button.className, "copy is-done", `${kind}: and the stylesheet can show it, in the colour of what went well as well as in words`);
    assert.equal(r.said(), `Copied the ${kind} address to the clipboard`, `${kind}: and so does the live region, for a screen reader`);
    r.runTimers();
    assert.equal(button.textContent, "Copy", `${kind}: after a moment it is a copy button again`);
    assert.equal(button.className, "copy", `${kind}: that looks like one`);
    assert.equal(r.said(), "");
  }
  assert.equal(r.written.length, 3);
});

test("a browser that does not allow copying is told so, with where to look, and the code boxes' buttons copy the commands without the trailing space", async () => {
  const refused = copying("contact/index.html", false);
  const button = refused.doc.querySelector(".address-row button")!;
  await refused.click(button);
  assert.equal(button.textContent, "Not copied");
  assert.equal(button.className, "copy", "a refusal is not shown as a success");
  assert.equal(refused.said(), "The browser did not allow copying; select the text instead");
  // A block that ends in a blank line (an editor leaves one) is copied without it, or the paste would run the last command at once.
  const home = copying("index.html", true, (html) => html.replace('echo "$MESH_API_TOKEN"</code>', 'echo "$MESH_API_TOKEN"\n\n</code>'));
  const boxes = home.doc.querySelectorAll(".code");
  assert.equal(boxes.length, 3);
  assert.match(boxes[0]!.querySelector("pre")!.textContent, /\s\n$/, "the first block ends in a blank line");
  for (const box of boxes) {
    const copy = box.querySelector(".code-bar button")!;
    assert.equal(copy.getAttribute("aria-label"), "Copy these commands");
    await home.click(copy);
    assert.equal(home.written[home.written.length - 1], decode(box.querySelector("pre")!.textContent).replace(/\s+$/, ""));
    assert.ok(!/\s$/.test(home.written[home.written.length - 1]!), "no trailing space or line");
    assert.equal(home.said(), "Copied to the clipboard");
  }
});

test("the copy buttons are 44 pixel targets on a phone and where a finger points, and so is the address beside one", () => {
  assert.match(CSS, /@media \(max-width: 719px\), \(pointer: coarse\) \{ \.copy \{ min-height: 44px; \} \}/);
  assert.match(CSS, /\n\.address-row \.address a \{[^}]*min-height: 44px;/);
  assert.match(CSS, /\n\.copy \{ min-height: 36px;/, "and a button with a mouse is a little smaller, as the code boxes' always were");
});

test("without a clipboard no page has a copy button, and an address that is not one yet (a marker) is not offered to copy", () => {
  for (const p of pages) {
    const doc = parsePage(p.html);
    vm.runInNewContext(SCRIPT, { document: doc, navigator: {}, window: { setTimeout, clearTimeout } }, { filename: "site.js" });
    assert.equal(doc.querySelectorAll(".copy").length, 0, p.rel);
  }
  const r = copying("contact/index.html", true, (html) => html.replace(/(<a data-mail="support" href="[^"]*">)[^<]*(<\/a>)/, "$1TODO(owner): support address$2"));
  assert.deepEqual(r.doc.querySelectorAll(".address-row").map((row) => row.querySelectorAll("button").length), [1, 0, 1], "the placeholder is text, and nothing is offered to copy");
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

// ---------------------------------------------------------------- the header, and what arrives as the reader scrolls

test("a header shows its line only while the page is away from its top, a section is hidden only below the first screen, and the stagger stops at five", () => {
  const { scrolledOff, staggerOf, startsHidden, withClass, withoutArrival } = pure();
  assert.equal(scrolledOff(0), false);
  assert.equal(scrolledOff(4), false, "the shake of a thumb at the top is still the top");
  assert.equal(scrolledOff(5), true);
  assert.deepEqual([0, 1, 4, 5, 6, 40].map(staggerOf), [0, 1, 4, 5, 5, 5], "five steps of delay, so that the seventh card is not a long wait");
  assert.equal(staggerOf(-1), 0);
  assert.equal(startsHidden(801, 800), true, "below the window");
  assert.equal(startsHidden(800, 800), false, "at its edge it can be seen");
  assert.equal(startsHidden(-300, 800), false, "above the window, the reader has been past it");
  assert.equal(withClass("a b", "c", true), "a b c");
  assert.equal(withClass("a b c", "c", true), "a b c", "once");
  assert.equal(withClass("a b c", "b", false), "a c");
  assert.equal(withClass("", "x", true), "x");
  assert.equal(withClass(undefined as unknown as string, "x", false), "");
  assert.equal(withoutArrival("grid rv rv-3 rv-in tile"), "grid tile", "the arrival's classes go and the node's own stay");
  assert.equal(withoutArrival("rvx rv-"), "rvx", "only the script's names: rv, rv-in and rv-1 to rv-5 (and a class that merely starts with rv is left)");
});

test("the header is pinned by the script and carries the scrolled class while the page is away from its top", () => {
  const r = scrolled("pricing/index.html");
  const header = r.doc.querySelector(".site-header")!;
  assert.equal(header.className, "site-header is-live", "pinned, and at rest part of the page");
  r.win.scrollY = 300;
  r.fire("scroll");
  assert.equal(header.className, "site-header is-live is-scrolled");
  r.win.scrollY = 3;
  r.fire("scroll");
  assert.equal(header.className, "site-header is-live", "back at the top, it is part of the page again");
  const first = scrolled("contact/index.html");
  first.win.scrollY = 900;
  const header2 = first.doc.querySelector(".site-header")!;
  first.fire("scroll");
  assert.match(header2.className, /is-scrolled/, "a page that is reached part-way down (a reload, the back button) shows it from the first scroll event");
  for (const p of pages) {
    const doc = parsePage(p.html);
    vm.runInNewContext(SCRIPT, { document: doc, navigator: {}, window: { setTimeout, clearTimeout } }, { filename: "site.js" });
    assert.equal(doc.querySelector(".site-header")!.className, "site-header", `${p.rel}: without a window that scrolls, the header is left as the page wrote it`);
  }
});

test("the header settles once a frame however many scroll events come in, and is right at once on a page that starts part-way down", () => {
  const run = (scrollY: number) => {
    const doc = parsePage(page(pages, "contact/index.html").html);
    const listeners = new Map<string, Array<() => void>>();
    const frames: Array<() => void> = [];
    const win = {
      innerHeight: 800,
      scrollY,
      matchMedia: () => ({ matches: true }),
      addEventListener: (type: string, fn: () => void) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
      requestAnimationFrame: (fn: () => void) => frames.push(fn),
      scrollTo: () => undefined,
      setTimeout,
      clearTimeout,
    };
    vm.runInNewContext(SCRIPT, { document: doc, navigator: {}, window: win }, { filename: "site.js" });
    return { header: doc.querySelector(".site-header")!, win, frames, scroll: () => (listeners.get("scroll") ?? []).forEach((fn) => fn()) };
  };
  assert.equal(run(900).header.className, "site-header is-live is-scrolled", "a page that is already down shows its line before any scroll event");
  assert.equal(run(0).header.className, "site-header is-live");
  const r = run(0);
  r.win.scrollY = 300;
  r.scroll();
  const queued = r.frames.length;
  r.scroll();
  r.scroll();
  assert.equal(r.frames.length, queued, "the scroll events of one frame wait for the same frame");
  assert.equal(r.header.className, "site-header is-live", "and nothing changes until it comes");
  r.frames.splice(0).forEach((fn) => fn());
  assert.equal(r.header.className, "site-header is-live is-scrolled");
});

interface Arriving {
  doc: FakeDocument;
  /** The classes of every piece of the page the script hid to let it arrive. */
  hidden: () => string[];
  observer: () => FakeObserver | undefined;
  /** The reader gets to a piece: the observer says so. */
  see: (node: FakeNode) => void;
  runTimers: () => void;
}

/** The home page with the script run on it in a window 800 tall, whose first section head is in view and the rest of the page is below. */
function arriving(options: { reduce?: boolean; observer?: boolean } = {}): Arriving {
  FakeObserver.made = [];
  const doc = parsePage(page(pages, "index.html").html);
  const first = doc.querySelector(".section-head")!;
  for (const node of doc.querySelector("main")!.descendants()) {
    (node as Placed).getBoundingClientRect = () => ({ top: node === first || first.contains(node) ? 320 : 4000, bottom: 4400, left: 0, right: 1280 });
  }
  const timers: Array<() => void> = [];
  const window = {
    ...(options.observer === false ? {} : { IntersectionObserver: FakeObserver }),
    innerHeight: 800,
    scrollY: 0,
    matchMedia: () => ({ matches: options.reduce === true }),
    addEventListener: () => undefined,
    requestAnimationFrame: (fn: () => void) => fn(),
    scrollTo: () => undefined,
    getComputedStyle: () => ({ scrollPaddingTop: "150px" }),
    setTimeout: (fn: () => void) => timers.push(fn),
    clearTimeout: () => undefined,
  };
  vm.runInNewContext(SCRIPT, { document: doc, navigator: {}, window }, { filename: "site.js" });
  return {
    doc,
    hidden: () => doc.querySelectorAll("main .rv").map((n) => n.className),
    observer: () => FakeObserver.made[0],
    see: (node) => (FakeObserver.made[0]!.callback as unknown as (entries: unknown[]) => void)([{ isIntersecting: true, target: node }]),
    runTimers: () => timers.splice(0).forEach((fn) => fn()),
  };
}

test("what is below the first screen is hidden to arrive, one child after another up to a fifth, and what can be seen already is left alone", () => {
  const r = arriving();
  const watched = r.observer()!.observed;
  assert.ok(watched.length >= 25, `the pieces of the page below the first screen are watched (${watched.length})`);
  const head = r.doc.querySelector(".section-head")!;
  assert.ok(!/\brv\b/.test(head.className), "the heading that is in view is never hidden and shown again");
  assert.ok(!watched.includes(head));
  // The children of a group arrive in order: the first at once, the second 50 ms after it, and from the sixth on the last step.
  const tiles = r.doc.querySelector(".tiles")!.children.filter((c) => !c.isText);
  assert.equal(tiles.length, 6);
  assert.deepEqual(tiles.map((t) => t.className), ["tile rv", "tile rv rv-1", "tile rv rv-2", "tile rv rv-3", "tile rv rv-4", "tile rv rv-5"]);
  const cta = r.doc.querySelectorAll("section.cta")[0]!;
  assert.deepEqual(cta.querySelectorAll(".wrap")[0]!.children.filter((c) => !c.isText).map((c) => /rv(?: rv-\d)?/.exec(c.className)![0]), ["rv", "rv rv-1", "rv rv-2"], "a heading, its line and its buttons, one after the other");
  for (const n of watched) assert.match(n.className, /\brv\b/);
  assert.ok(r.doc.querySelector(".hero")!.querySelectorAll(".rv").length === 0, "nothing in the hero: it is the first screen, and the picture is what the page is waiting for");
});

test("a piece arrives once, when the reader gets to it, and the script then takes its marks off so that its own hover and motion are the stylesheet's again", () => {
  const r = arriving();
  const tile = r.doc.querySelector(".tiles")!.children.filter((c) => !c.isText)[2]!;
  assert.equal(tile.className, "tile rv rv-2");
  // A browser tells an observer about every piece it starts to watch, in view or not: that first word does not bring a piece in.
  (r.observer()!.callback as unknown as (entries: unknown[]) => void)([{ isIntersecting: false, target: tile }]);
  assert.equal(tile.className, "tile rv rv-2", "a piece that is not in view stays as it is when the observer first reports on it");
  r.see(tile);
  assert.equal(tile.className, "tile rv rv-2 rv-in", "in view: the stylesheet moves it from 8 px down and clear to where it is");
  assert.ok(!r.observer()!.observed.includes(tile), "and it is not watched again");
  r.runTimers();
  assert.equal(tile.className, "tile", "once it has arrived, nothing of the script is left on it");
});

test("a visitor who has asked for less motion, and a browser that cannot watch, are shown the whole page at once", () => {
  assert.deepEqual(arriving({ reduce: true }).hidden(), [], "nothing is hidden");
  assert.equal(arriving({ reduce: true }).observer(), undefined, "and nothing is watched");
  const bare = arriving({ observer: false });
  assert.deepEqual(bare.hidden(), []);
  const everyPage = pages.map((p) => {
    const doc = parsePage(p.html);
    vm.runInNewContext(SCRIPT, { document: doc, navigator: {}, window: { setTimeout, clearTimeout } }, { filename: "site.js" });
    return doc.querySelectorAll(".rv").length;
  });
  assert.deepEqual(everyPage, pages.map(() => 0), "a page the script cannot run on all the way is whole");
});

test("on a page with the On this page bar, the bar's observer is still the last one the script makes, after the one that lets the sections arrive", () => {
  const r = read("pricing/index.html", 800, false);
  assert.equal(FakeObserver.made.length, 2, "one for the sections, one for the bar");
  assert.equal(r.observer().options.rootMargin, "0px 0px -533px 0px", "and the bar's is the last, so that what it does is as it was");
  assert.equal(r.observer().observed.length, 6, "watching its six sections");
});
