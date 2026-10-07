import test from "node:test";
import assert from "node:assert/strict";

import { chordLabel, chordParts } from "../../apps/mesh-dashboard/src/ui/keys";
import { tipPosition } from "../../apps/mesh-dashboard/src/ui/tooltip-pos";
import { ratioOf, ringArcs, sparkGeometry } from "../../apps/mesh-dashboard/src/ui/chart-model";

/**
 * The arithmetic under the kit's small primitives: the caps of a key chord, where a tooltip sits, how a budget meter is read,
 * and the numbers of a sparkline and a ring. The components that draw them are in ui/*.tsx and only place what these return.
 */

test("a chord is read the way the person's machine names its keys", () => {
  assert.deepEqual(chordParts("mod+k", true), ["⌘", "K"]);
  assert.deepEqual(chordParts("mod+k", false), ["Ctrl", "K"]);
  assert.deepEqual(chordParts("mod+shift+p", true), ["⌘", "⇧", "P"]);
  assert.deepEqual(chordParts("mod+shift+p", false), ["Ctrl", "Shift", "P"]);
  assert.deepEqual(chordParts("esc", false), ["Esc"]);
  assert.deepEqual(chordParts("enter", true), ["↵"]);
  assert.deepEqual(chordParts("up", false), ["↑"]);
  assert.deepEqual(chordParts("?", false), ["?"], "a punctuation key is itself");
  assert.deepEqual(chordParts("/", true), ["/"]);
  assert.deepEqual(chordParts("F5", false), ["F5"], "a name the table does not know is kept as written");
  assert.deepEqual(chordParts("", false), [], "nothing in, nothing out");
  assert.equal(chordLabel("mod+k", false), "Ctrl K");
});

const VIEW = { width: 1000, height: 800 };
const TIP = { width: 80, height: 28 };

test("a tooltip sits above its control, centred, with a gap", () => {
  const p = tipPosition({ left: 480, top: 400, width: 36, height: 36 }, TIP, VIEW, "top");
  assert.deepEqual(p, { left: 458, top: 364, side: "top" });
});

test("a tooltip that has no room above goes below instead of off the screen", () => {
  const p = tipPosition({ left: 480, top: 6, width: 36, height: 36 }, TIP, VIEW, "top");
  assert.equal(p.side, "bottom");
  assert.equal(p.top, 6 + 36 + 8);
});

test("a tooltip is kept inside the window along the other axis", () => {
  assert.equal(tipPosition({ left: 0, top: 400, width: 36, height: 36 }, TIP, VIEW, "top").left, 8, "at the left edge");
  assert.equal(tipPosition({ left: 990, top: 400, width: 36, height: 36 }, TIP, VIEW, "top").left, 1000 - 80 - 8, "at the right edge");
});

test("the sides to the left and the right flip the same way", () => {
  assert.equal(tipPosition({ left: 20, top: 400, width: 36, height: 36 }, TIP, VIEW, "left").side, "right", "no room on the left");
  const right = tipPosition({ left: 100, top: 400, width: 36, height: 36 }, TIP, VIEW, "right");
  assert.deepEqual(right, { left: 144, top: 404, side: "right" });
});

test("with no room on either side it stays where it was asked to be", () => {
  const tall = { width: 80, height: 700 };
  assert.equal(tipPosition({ left: 480, top: 300, width: 36, height: 36 }, tall, VIEW, "top").side, "top");
});

test("a ratio is held between nothing and all of it, and a missing maximum is an empty bar", () => {
  assert.equal(ratioOf(50, 200), 0.25);
  assert.equal(ratioOf(300, 200), 1);
  assert.equal(ratioOf(-5, 200), 0);
  assert.equal(ratioOf(10, 0), 0, "no limit set");
  assert.equal(ratioOf(Number.NaN, 10), 0);
});

test("a sparkline scales a series into its box, last point at the right", () => {
  const g = sparkGeometry([0, 10], 100, 20, 2);
  assert.equal(g.line, "M2 18L98 2");
  assert.equal(g.area, "M2 18L98 2L98 18L2 18Z", "closed down to the baseline");
  assert.deepEqual(g.last, { x: 98, y: 2 });
});

test("a sparkline has an answer for nothing, one point and a flat series", () => {
  assert.deepEqual(sparkGeometry([], 100, 20), { line: "", area: "", last: null });
  assert.deepEqual(sparkGeometry([Number.NaN, Number.POSITIVE_INFINITY], 100, 20), { line: "", area: "", last: null }, "values that are not numbers are dropped");
  const one = sparkGeometry([5], 100, 20, 2);
  assert.equal(one.line, "M2 10H98");
  assert.equal(one.area, "");
  assert.deepEqual(one.last, { x: 50, y: 10 });
  const flat = sparkGeometry([4, 4, 4], 100, 20, 2);
  assert.equal(flat.line, "M2 10L50 10L98 10", "flat is the middle line, not a division by zero");
  assert.equal(flat.area, "", "and has no wash under it");
});

test("a sparkline read against a ceiling keeps its scale", () => {
  const g = sparkGeometry([0, 50], 100, 20, 2, [0, 100]);
  assert.equal(g.line, "M2 18L98 10", "half of the ceiling is half the height");
  const over = sparkGeometry([200], 100, 20, 2, [0, 100]);
  assert.equal(over.last?.y, 2, "a value past the ceiling is drawn at the top, not outside the box");
});

const C = (r: number): number => 2 * Math.PI * r;
const r2 = (n: number): number => Math.round(n * 100) / 100;

test("a ring of one whole is the full circle", () => {
  const [arc] = ringArcs([7], 10, 2, 7);
  assert.equal(arc!.dash, `${r2(C(10))} 0`);
  assert.equal(arc!.offset, 0);
  assert.equal(arc!.fraction, 1);
});

test("a ring of parts starts at twelve o'clock and cuts a gap from each arc", () => {
  const [a, b] = ringArcs([3, 1], 10, 2);
  assert.equal(a!.fraction, 0.75);
  assert.equal(a!.dash, `${r2(0.75 * C(10) - 2)} ${r2(C(10) - (0.75 * C(10) - 2))}`);
  assert.equal(a!.offset, 0);
  assert.equal(b!.offset, r2(-0.75 * C(10)), "the second begins where the first ended");
});

test("a ring that shows a part of a whole leaves the rest empty", () => {
  const [arc] = ringArcs([2], 10, 2, 8);
  assert.equal(arc!.fraction, 0.25);
  assert.equal(arc!.dash, `${r2(0.25 * C(10))} ${r2(C(10) - 0.25 * C(10))}`, "a lone arc has no gap to cut");
});

test("a ring with nothing in it draws nothing", () => {
  assert.deepEqual(ringArcs([0, 0], 10).map((a) => a.fraction), [0, 0]);
  assert.equal(ringArcs([], 10).length, 0);
});
