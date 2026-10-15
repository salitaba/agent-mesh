/**
 * What the page is made of, counted. Contrast and tap sizes passed on the page the owner called ugly, and
 * they passed because they are the only things anyone had measured: hierarchy, density and restraint live
 * in the census — how many sizes, how many weights, how many colours, how many spacing steps.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CENSUS_LIMITS, census, censusNotes } from "../../packages/ux-report/src/index";
import { control, node, page } from "./fixture";

test("the type in use is counted, with how much of the page uses it", () => {
  const snapshot = page([
    node({ path: "h1", tag: "h1", text: "Title", fontSize: 24, fontWeight: 700, lineHeight: 31 }),
    node({ path: "p.one", tag: "p", text: "One" }),
    node({ path: "p.two", tag: "p", text: "Two" }),
  ]);
  const c = census(snapshot);
  assert.deepEqual(c.fontSizes, [
    { value: "16px", count: 2 },
    { value: "24px", count: 1 },
  ]);
  assert.deepEqual(c.fontWeights, [
    { value: "400", count: 2 },
    { value: "700", count: 1 },
  ]);
  assert.deepEqual(c.distinct.fontSizes, 2);
  assert.deepEqual(c.fontFamilies, [{ value: "system-ui, sans-serif", count: 3 }]);
  assert.deepEqual(c.lineHeights, [
    { value: "24px", count: 2 },
    { value: "31px", count: 1 },
  ]);
});

test("an element with no text of its own does not vote on the type scale", () => {
  const snapshot = page([
    node({ path: "div.wrapper", tag: "div", fontSize: 11 }),
    node({ path: "p.one", tag: "p", text: "One" }),
  ]);
  assert.deepEqual(census(snapshot).fontSizes, [{ value: "16px", count: 1 }]);
});

test("spacings are counted from padding and margin, and zero is not a step", () => {
  const snapshot = page([
    node({ path: "div.card", tag: "div", padding: { top: 16, right: 16, bottom: 16, left: 16 }, margin: { top: 0, right: 0, bottom: 8, left: 0 } }),
  ]);
  const c = census(snapshot);
  assert.deepEqual(c.spacings, [
    { value: "16px", count: 4 },
    { value: "8px", count: 1 },
  ]);
  assert.equal(c.distinct.spacings, 2);
});

test("colours are counted across text, fills, borders and focus rings", () => {
  const snapshot = page([
    control({
      path: "button.primary",
      tag: "button",
      name: "Start",
      text: "Start",
      color: "rgb(255, 255, 255)",
      background: "rgb(27, 79, 216)",
      borders: [{ side: "top", width: 1, style: "solid", color: "rgb(27, 79, 216)" }],
      focusRing: { width: 2, color: "rgb(27, 79, 216)", from: "outline" },
    }),
  ]);
  const c = census(snapshot);
  assert.deepEqual(c.colors, [
    { value: "#1b4fd8", count: 3 },
    { value: "#ffffff", count: 1 },
  ]);
  assert.equal(c.distinct.radii, 0);
});

test("a radius is counted once per distinct shape", () => {
  const snapshot = page([
    node({ path: "div.card", tag: "div", radius: { topLeft: 6, topRight: 6, bottomRight: 6, bottomLeft: 6 } }),
    node({ path: "div.pill", tag: "div", radius: { topLeft: 999, topRight: 999, bottomRight: 999, bottomLeft: 999 } }),
    node({ path: "div.square", tag: "div" }),
  ]);
  const c = census(snapshot);
  assert.deepEqual(c.radii, [
    { value: "6px", count: 1 },
    { value: "999px", count: 1 },
  ]);
});

test("a page inside the limits gets no advice", () => {
  assert.deepEqual(censusNotes(census(page([node({ path: "p.one", tag: "p", text: "One" })]))), []);
});

test("a page that has lost its scale is told so, with the numbers it is made of", () => {
  const sizes = [11, 12, 13, 14, 15, 16, 17, 18, 19];
  const snapshot = page(sizes.map((size, i) => node({ path: `p.s${i}`, tag: "p", text: `Line ${i}`, fontSize: size })));
  const notes = censusNotes(census(snapshot));
  assert.equal(notes.length, 1);
  assert.equal(notes[0].ok, false);
  assert.equal(notes[0].fatal, false, "a census is advice: the designer decides, the tool measures");
  assert.equal(notes[0].floor, `≤ ${CENSUS_LIMITS.fontSizes}`);
  assert.match(notes[0].text, /^9 distinct font sizes on this page \(11px×1, 12px×1, 13px×1, 14px×1, 15px×1, 16px×1, 17px×1, 18px×1, 19px×1\); a page wants a scale of four to six steps/);
});

test("weight and colour are counted too, because fourteen colours is also a sentence a page says about itself", () => {
  const snapshot = page(
    ["#101010", "#202020", "#303030", "#404040", "#505050", "#606060", "#707070", "#808080", "#909090", "#a0a0a0", "#b0b0b0", "#c0c0c0", "#d0d0d0"].map((hex, i) =>
      node({ path: `p.c${i}`, tag: "p", text: `Line ${i}`, color: `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})` }),
    ),
  );
  const notes = censusNotes(census(snapshot));
  const colours = notes.find((n) => n.target.includes("colours"))!;
  assert.ok(colours, "thirteen text colours is over the limit of twelve");
  assert.equal(colours.measured, "13 distinct");
  assert.match(colours.text, /a page wants one accent hue, one ink ramp, and the semantic four\./);
});
