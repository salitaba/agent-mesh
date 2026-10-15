/**
 * The contrast maths, checked against WCAG's own numbers. These are the values a design review quotes, so
 * a rounding error here is a designer being told to change a colour that was already compliant — or worse,
 * a pair that fails being waved through.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { contrastRatio, formatColor, parseColor, relativeLuminance, roundRatio, textContrastFloor } from "../../packages/ux-report/src/index";
import { page, node } from "./fixture";
import { contrastReport } from "../../packages/ux-report/src/checks";

const close = (actual: number, expected: number, tolerance = 0.01): void =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${expected} ± ${tolerance}, got ${actual}`);

test("a colour is read in every form a browser prints it", () => {
  assert.deepEqual(parseColor("rgb(28, 28, 28)"), { r: 28, g: 28, b: 28, a: 1 });
  assert.deepEqual(parseColor("rgba(28, 28, 28, 0.5)"), { r: 28, g: 28, b: 28, a: 0.5 });
  assert.deepEqual(parseColor("rgb(28 28 28 / 50%)"), { r: 28, g: 28, b: 28, a: 0.5 });
  assert.deepEqual(parseColor("#1c1c1c"), { r: 28, g: 28, b: 28, a: 1 });
  assert.deepEqual(parseColor("#fff"), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseColor("#00000080")!.a, 128 / 255);
  assert.deepEqual(parseColor("transparent"), { r: 0, g: 0, b: 0, a: 0 });
  assert.deepEqual(parseColor("currentcolor"), undefined, "a keyword this tool cannot resolve is not a colour it guesses at");
  assert.deepEqual(parseColor(""), undefined);
});

test("a colour is printed back the way a review writes it", () => {
  assert.equal(formatColor({ r: 28, g: 28, b: 28, a: 1 }), "#1c1c1c");
  assert.equal(formatColor({ r: 28, g: 28, b: 28, a: 0.5 }), "rgba(28, 28, 28, 0.5)");
  assert.equal(formatColor(parseColor("rgb(255, 255, 255)")!), "#ffffff");
});

test("luminance and the ratio are WCAG's", () => {
  const white = parseColor("#ffffff")!;
  const black = parseColor("#000000")!;
  close(relativeLuminance(white), 1);
  close(relativeLuminance(black), 0);
  close(contrastRatio(black, white), 21);
  close(contrastRatio(white, white), 1);
  // #767676 on white is the canonical "just passes 4.5:1" grey.
  close(contrastRatio(parseColor("#767676")!, white), 4.54, 0.01);
  // The order of the arguments does not change the ratio.
  close(contrastRatio(white, black), contrastRatio(black, white));
});

test("a translucent foreground is composited over what is behind it before it is judged", () => {
  const fiftyOnWhite = contrastRatio(parseColor("rgba(0, 0, 0, 0.5)")!, parseColor("#ffffff")!);
  close(fiftyOnWhite, contrastRatio(parseColor("#808080")!, parseColor("#ffffff")!), 0.05);
  assert.ok(fiftyOnWhite < 4.5, "half-black on white is not readable text, and the ratio has to say so");
});

test("the floor follows the type: 4.5:1, or 3:1 once the text is large", () => {
  assert.equal(textContrastFloor(16, 400), 4.5);
  assert.equal(textContrastFloor(23.9, 400), 4.5);
  assert.equal(textContrastFloor(24, 400), 3);
  assert.equal(textContrastFloor(18, 700), 4.5, "18px bold is under the 18.66px (14pt) line");
  assert.equal(textContrastFloor(18.66, 700), 3);
  assert.equal(textContrastFloor(20, 400), 4.5, "large is not the same as bold");
  assert.equal(textContrastFloor(24, 400), 3);
});

test("a text pair is reported with its ratio, its floor and the surface it actually sits on", () => {
  const snapshot = page([
    node({ path: "p.lead", tag: "p", text: "Set a timer for the bake.", color: "rgb(22, 24, 29)", backgroundBehind: "rgb(255, 255, 255)" }),
  ]);
  const { text, boundary } = contrastReport(snapshot);
  assert.equal(text.length, 1);
  assert.equal(boundary.length, 0, "no border and no ring on this fixture, so nothing to say about boundaries");
  assert.equal(text[0].ok, true);
  assert.equal(text[0].fatal, true);
  assert.equal(text[0].floor, "4.5:1");
  assert.equal(text[0].ratio, roundRatio(contrastRatio(parseColor("#16181d")!, parseColor("#ffffff")!)));
  assert.match(text[0].text, /#16181d on #ffffff is 17\.76:1 at 16px\/400 \(p\.lead "Set a timer for the bake\."\): the floor is 4\.5:1\./);
});

test("a pair that repeats is one row with a count, and a group is as good as its worst member", () => {
  const dim = { color: "rgb(85, 89, 95)" };
  const worse = { color: "rgb(190, 190, 190)" };
  const snapshot = page([
    node({ path: "p.one", tag: "p", text: "first", ...dim }),
    node({ path: "p.two", tag: "p", text: "second", ...dim }),
    node({ path: "p.bad", tag: "p", text: "third", ...worse }),
    node({ path: "p.four", tag: "p", text: "fourth", ...dim }),
  ]);
  const { text } = contrastReport(snapshot);
  assert.equal(text.length, 2, "four elements, two colours: one row for the dim pair and one for the bad paragraph");
  const badRow = text.find((r) => r.path === "p.bad")!;
  const dimRow = text.find((r) => r.count === 3)!;
  assert.equal(dimRow.count, 3, "the three dim paragraphs");
  assert.equal(dimRow.ok, true);
  assert.match(dimRow.target, /×3/);
  assert.match(dimRow.text, /3 elements share this pair: p\.one, p\.two, p\.four\./);
  assert.equal(badRow.ok, false);
  assert.equal(badRow.count, 1);
  assert.ok((badRow.ratio ?? 0) < 4.5);
});

test("a later worse element replaces the row it shares a pair with, rather than passing on its behalf", () => {
  // Same colour, but the second one is 24px: still one pair, two floors, and the small one is the one that fails.
  const snapshot = page([
    node({ path: "h1.big", tag: "h1", text: "Title", color: "rgb(140, 140, 140)", fontSize: 24, fontWeight: 700 }),
    node({ path: "p.small", tag: "p", text: "Body", color: "rgb(140, 140, 140)", fontSize: 16 }),
  ]);
  const { text } = contrastReport(snapshot);
  assert.equal(text.length, 2, "the same colour has two floors, so it is two rows");
  const body = text.find((r) => r.floor === "4.5:1")!;
  const heading = text.find((r) => r.floor === "3:1")!;
  assert.equal(body.ok, false);
  assert.equal(heading.ok, true, "3.4:1 grey is fine for large text and not for body text");
});

test("borders and focus rings are judged against the 3:1 floor, on the surface that is on the other side of the edge", () => {
  const snapshot = page([
    node({
      path: "button.primary",
      tag: "button",
      interactive: true,
      text: "Start",
      color: "rgb(255, 255, 255)",
      background: "rgb(27, 79, 216)",
      backgroundBehind: "rgb(27, 79, 216)",
      // The button is on a white page: that is what its edge has to be seen against, not its own fill.
      backgroundOutside: "rgb(255, 255, 255)",
      borders: [{ side: "top", width: 1, style: "solid", color: "rgb(27, 79, 216)" }],
      focusRing: { width: 2, color: "rgb(214, 222, 245)", from: "outline" },
    }),
  ]);
  const { boundary } = contrastReport(snapshot);
  assert.equal(boundary.length, 2, "one border and one focus ring");
  const ring = boundary.find((r) => r.text.includes("focus ring"))!;
  const border = boundary.find((r) => r.text.includes("border"))!;
  assert.equal(ring.measured, "1.34:1");
  assert.equal(ring.ok, false, "a pale ring on a white page is a ring nobody sees");
  assert.equal(ring.floor, "3:1");
  assert.match(ring.text, /the focus ring \(2px, #d6def5\) on #ffffff is 1\.34:1 \(button.primary "Start"\)/);
  assert.equal(border.ok, true, "a 1px border the same blue as the fill still gives the button a visible edge on white");
  assert.equal(border.measured, "6.65:1");
});

test("the four edges of one hairline box are one boundary, not four", () => {
  const snapshot = page([
    node({
      path: "input#email",
      tag: "input",
      interactive: true,
      focusRing: null,
      backgroundOutside: "rgb(255, 255, 255)",
      borders: [
        { side: "top", width: 1, style: "solid", color: "rgb(140, 140, 140)" },
        { side: "right", width: 1, style: "solid", color: "rgb(140, 140, 140)" },
        { side: "bottom", width: 1, style: "solid", color: "rgb(140, 140, 140)" },
        { side: "left", width: 1, style: "solid", color: "rgb(140, 140, 140)" },
      ],
    }),
  ]);
  const { boundary } = contrastReport(snapshot);
  assert.equal(boundary.length, 1, "one element, one colour, one row");
  assert.equal(boundary[0].count, 1);
  assert.match(boundary[0].text, /^the border \(1px, #8c8c8c\) on #ffffff is 3.36:1/);
  assert.doesNotMatch(boundary[0].text, /elements share/);
});

test("nothing is measured where nothing is painted", () => {
  const snapshot = page([
    node({ path: "div.wrapper", tag: "div" }),
    node({ path: "hr.rule", tag: "hr", borders: [{ side: "top", width: 0, style: "none", color: "rgb(0, 0, 0)" }] }),
  ]);
  const { text, boundary } = contrastReport(snapshot);
  assert.deepEqual(text, [], "no text nodes, no text pairs");
  assert.deepEqual(boundary, [], "a zero-width border is not a boundary");
});
