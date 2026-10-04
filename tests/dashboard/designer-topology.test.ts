import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CARD_COMPACT,
  CARD_REGULAR,
  STAGE_MARGIN,
  cardFor,
  clampCenter,
  defaultLayout,
  displayPx,
  edgePoint,
  freeSpot,
  neighborInDirection,
  nudge,
  pairsOf,
  segment,
  stageHeight,
  storedFromPx,
  toPx,
  toUnits,
} from "../../apps/mesh-dashboard/src/designer/topology";
import { H, W } from "../../apps/mesh-dashboard/src/designer/geom";

const STAGE = { w: 750, h: stageHeight(750) };

test("the stage keeps the unit space's aspect ratio at any width", () => {
  assert.equal(stageHeight(W), H);
  assert.equal(Math.round(stageHeight(500) * 10) / 10, 310);
});

test("units and pixels convert both ways", () => {
  const p = { x: 500, y: 310 };
  const px = toPx(p, STAGE);
  assert.deepEqual(px, { x: 375, y: STAGE.h / 2 });
  const back = toUnits(px, STAGE);
  assert.ok(Math.abs(back.x - 500) < 1e-9 && Math.abs(back.y - 310) < 1e-9);
});

test("cards are full size up to eight seats on a stage of ordinary width, and compact beyond or when narrow", () => {
  assert.equal(cardFor(2, 900), CARD_REGULAR);
  assert.equal(cardFor(8, 900), CARD_REGULAR);
  assert.equal(cardFor(9, 900), CARD_COMPACT);
  assert.equal(cardFor(3, 600), CARD_COMPACT);
});

/* ------------------------------------------------ staying inside the stage */

test("a card is held where all of it is on the stage", () => {
  const c = clampCenter({ x: -50, y: 9999 }, STAGE, CARD_REGULAR);
  assert.equal(c.x, CARD_REGULAR.w / 2 + STAGE_MARGIN);
  assert.equal(c.y, STAGE.h - CARD_REGULAR.h / 2 - STAGE_MARGIN);
});

test("a stage smaller than a card centres it rather than throwing it off the edge", () => {
  const tiny = { w: 100, h: 40 };
  assert.deepEqual(clampCenter({ x: 0, y: 0 }, tiny, CARD_REGULAR), { x: 50, y: 20 });
});

test("a seat saved outside a smaller stage is drawn inside it, and the saved position is not touched", () => {
  const saved = { x: 990, y: 610 };
  const shown = displayPx(saved, { w: 500, h: stageHeight(500) }, CARD_REGULAR);
  assert.ok(shown.x <= 500 - CARD_REGULAR.w / 2 - STAGE_MARGIN + 1e-9);
  assert.deepEqual(saved, { x: 990, y: 610 });
});

test("a dropped card is stored in units, clamped, to one decimal", () => {
  const u = storedFromPx({ x: 375.04, y: 232 }, STAGE, CARD_REGULAR);
  assert.equal(u.x, 500.1);
  assert.equal(storedFromPx({ x: -100, y: 0 }, STAGE, CARD_REGULAR).x, Math.round(((CARD_REGULAR.w / 2 + STAGE_MARGIN) * W) / STAGE.w * 10) / 10);
});

/* ------------------------------------------------ the starting arrangement */

test("one to four seats are laid out by hand and never overlap", () => {
  for (const n of [1, 2, 3, 4]) {
    const ids = Array.from({ length: n }, (_, i) => `s${i}`);
    const l = defaultLayout(ids);
    assert.equal(Object.keys(l).length, n);
    for (const a of ids) for (const b of ids) {
      if (a >= b) continue;
      const dx = Math.abs(l[a]!.x - l[b]!.x);
      const dy = Math.abs(l[a]!.y - l[b]!.y);
      assert.ok(dx >= CARD_REGULAR.w || dy >= CARD_REGULAR.h, `${n} seats: ${a} and ${b} overlap`);
    }
  }
  assert.deepEqual(defaultLayout([]), {});
});

test("a ring of any size up to twelve keeps every card clear of its neighbours at a stage of 750px", () => {
  for (const n of [5, 7, 8, 12]) {
    const ids = Array.from({ length: n }, (_, i) => `s${i}`);
    const card = cardFor(n, 750);
    const px = Object.fromEntries(ids.map((id) => [id, displayPx(defaultLayout(ids)[id]!, STAGE, card)]));
    for (const a of ids) for (const b of ids) {
      if (a >= b) continue;
      const dx = Math.abs(px[a]!.x - px[b]!.x);
      const dy = Math.abs(px[a]!.y - px[b]!.y);
      assert.ok(dx >= card.w - 0.5 || dy >= card.h - 0.5, `${n} seats: ${a} and ${b} overlap (${dx.toFixed(0)}, ${dy.toFixed(0)})`);
    }
  }
});

/* ------------------------------------------------ wires */

test("wires fold into one line per pair, with an arrowhead where there is a direction", () => {
  const order = ["pm", "qa", "dev"];
  const pairs = pairsOf([{ src: "pm", tgt: "qa" }, { src: "qa", tgt: "pm" }, { src: "dev", tgt: "pm" }], order);
  assert.equal(pairs.length, 2);
  const pmqa = pairs.find((p) => p.a === "pm" && p.b === "qa")!;
  assert.deepEqual([pmqa.ab, pmqa.ba], [true, true]);
  const pmdev = pairs.find((p) => p.a === "pm" && p.b === "dev")!;
  assert.deepEqual([pmdev.ab, pmdev.ba], [false, true], "dev messages pm, which is the b-to-a direction of the pm/dev pair");
});

test("pair keys are stable whichever way round a wire is listed", () => {
  const order = ["a", "b"];
  assert.equal(pairsOf([{ src: "a", tgt: "b" }], order)[0]!.key, pairsOf([{ src: "b", tgt: "a" }], order)[0]!.key);
  assert.deepEqual(pairsOf([{ src: "a", tgt: "a" }], order), [], "a seat is not wired to itself");
});

test("a wire leaves a card at its edge, not its centre, and stands a gap clear of it", () => {
  const p = edgePoint({ x: 100, y: 100 }, { x: 400, y: 100 }, CARD_REGULAR, 5);
  assert.equal(p.x, 100 + CARD_REGULAR.w / 2 + 5);
  assert.equal(p.y, 100);
  const down = edgePoint({ x: 100, y: 100 }, { x: 100, y: 400 }, CARD_REGULAR, 0);
  assert.equal(down.y, 100 + CARD_REGULAR.h / 2);
});

test("on a diagonal a wire leaves through the nearer side", () => {
  const p = edgePoint({ x: 0, y: 0 }, { x: 300, y: 300 }, CARD_REGULAR, 0);
  assert.ok(Math.abs(p.x - p.y) < 1e-9, "45 degrees stays on the diagonal");
  assert.ok(Math.abs(p.y - CARD_REGULAR.h / 2) < 1e-9, "the card is wider than tall, so the top or bottom edge is hit first");
});

test("cards that touch have no wire to draw", () => {
  assert.equal(segment({ x: 0, y: 0 }, { x: 100, y: 0 }, CARD_REGULAR), null);
  const s = segment({ x: 0, y: 0 }, { x: 400, y: 0 }, CARD_REGULAR)!;
  assert.ok(s.from.x > CARD_REGULAR.w / 2 && s.to.x < 400 - CARD_REGULAR.w / 2);
  assert.equal(s.mid.x, (s.from.x + s.to.x) / 2);
});

/* ------------------------------------------------ keyboard */

const CENTERS = { a: { x: 100, y: 100 }, b: { x: 300, y: 100 }, c: { x: 100, y: 300 }, d: { x: 320, y: 320 } };
const ORDER = ["a", "b", "c", "d"];

test("an arrow goes to the nearest seat that way", () => {
  assert.equal(neighborInDirection(CENTERS, ORDER, "a", "right"), "b");
  assert.equal(neighborInDirection(CENTERS, ORDER, "a", "down"), "c");
  assert.equal(neighborInDirection(CENTERS, ORDER, "d", "up"), "b");
  assert.equal(neighborInDirection(CENTERS, ORDER, "d", "left"), "c");
});

test("a seat that is lined up beats one that is merely closer", () => {
  const centers = { a: { x: 0, y: 0 }, near: { x: 60, y: 90 }, far: { x: 200, y: 0 } };
  assert.equal(neighborInDirection(centers, ["a", "near", "far"], "a", "right"), "far");
});

test("with nothing that way the arrows wrap in list order, so every seat stays reachable", () => {
  assert.equal(neighborInDirection(CENTERS, ORDER, "a", "left"), "d", "left from the first goes back, wrapping to the last");
  assert.equal(neighborInDirection(CENTERS, ORDER, "d", "down"), "a", "down from the last goes forward, wrapping to the first");
});

test("with one seat there is nowhere to go", () => {
  assert.equal(neighborInDirection({ a: { x: 1, y: 1 } }, ["a"], "a", "right"), null);
});

test("a nudge moves a seat a few units and holds it inside the stage", () => {
  const moved = nudge({ x: 500, y: 300 }, "right", 12, STAGE, CARD_REGULAR);
  assert.equal(moved.x, 512);
  const edge = nudge({ x: 995, y: 300 }, "right", 12, STAGE, CARD_REGULAR);
  assert.ok(edge.x < 995, "held inside the stage");
});

/* ------------------------------------------------ a place for a new seat */

test("the first seat goes to the middle of the stage", () => {
  const p = freeSpot({}, STAGE, CARD_REGULAR);
  assert.deepEqual(p, { x: 500, y: 300 });
});

test("a new seat does not land on top of an existing one", () => {
  const layout = { a: { x: 500, y: 300 } };
  const p = freeSpot(layout, STAGE, CARD_REGULAR);
  const px = toPx(p, STAGE);
  const a = toPx(layout.a, STAGE);
  assert.ok(Math.abs(px.x - a.x) >= CARD_REGULAR.w || Math.abs(px.y - a.y) >= CARD_REGULAR.h);
});

test("it finds the gap in a ring of seven, and stays on the stage", () => {
  const ids = Array.from({ length: 7 }, (_, i) => `s${i}`);
  const layout = defaultLayout(ids);
  const p = freeSpot(layout, STAGE, CARD_REGULAR);
  const px = toPx(p, STAGE);
  for (const id of ids) {
    const o = displayPx(layout[id]!, STAGE, CARD_REGULAR);
    assert.ok(Math.abs(px.x - o.x) >= CARD_REGULAR.w || Math.abs(px.y - o.y) >= CARD_REGULAR.h, `overlaps ${id}`);
  }
  assert.ok(px.x >= CARD_REGULAR.w / 2 && px.x <= STAGE.w - CARD_REGULAR.w / 2);
});
