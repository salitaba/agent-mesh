/**
 * The 44×44 floor, and the one exemption that keeps the check honest: a link inside a sentence is not a
 * target a person aims at, and WCAG 2.5.5 says so. A tool that fails every prose link is a tool whose
 * output the crew learns to skip past.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tapTargetRows } from "../../packages/ux-report/src/index";
import { control, node, page } from "./fixture";

test("a control at or above 44×44 is not reported at all", () => {
  const snapshot = page([
    control({ path: "button#start", name: "Start", box: { x: 0, y: 0, width: 44, height: 44 } }),
    control({ path: "button#reset", name: "Reset", box: { x: 52, y: 0, width: 120, height: 48 } }),
  ]);
  assert.deepEqual(tapTargetRows(snapshot), []);
});

test("a control under the floor is reported, named and measured, and fails the run", () => {
  const snapshot = page([control({ path: "button#go", name: "Go", box: { x: 12, y: 480, width: 38, height: 30 } })]);
  const rows = tapTargetRows(snapshot);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].check, "tap-target");
  assert.equal(rows[0].ok, false);
  assert.equal(rows[0].fatal, true, "a thumb cannot hit 38×30, so this fails the run");
  assert.equal(rows[0].measured, "38×30 CSS px at (12, 480)");
  assert.equal(rows[0].floor, "44×44 CSS px");
  assert.equal(rows[0].text, 'button#go "Go" is 38×30 CSS px at (12, 480): the tap-target floor is 44×44 CSS px.');
});

test("one dimension under the floor is enough", () => {
  const snapshot = page([control({ path: "button#wide", name: "Wide", box: { x: 0, y: 0, width: 200, height: 30 } })]);
  assert.equal(tapTargetRows(snapshot).length, 1);
});

test("a link inside a sentence is reported and not failed, and the row says why", () => {
  const snapshot = page([
    node({ path: "p.terms > a.more", tag: "a", role: "link", name: "Terms", text: "Terms", interactive: true, inProse: true, box: { x: 120, y: 300, width: 32, height: 18 } }),
  ]);
  const rows = tapTargetRows(snapshot);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fatal, false, "WCAG 2.5.5 exempts a target in a block of text");
  assert.match(rows[0].text, /sits inside a sentence: WCAG 2\.5\.5 exempts an inline link/);
});

test("an element nobody can press is not a tap target", () => {
  const snapshot = page([
    node({ path: "div.card", tag: "div", box: { x: 0, y: 0, width: 20, height: 20 } }),
    node({ path: "span.dot", tag: "span", box: { x: 0, y: 0, width: 4, height: 4 } }),
  ]);
  assert.deepEqual(tapTargetRows(snapshot), []);
});

test("a control that was never laid out (zero area) is not measured", () => {
  const snapshot = page([control({ path: "button.hidden", name: "Hidden", box: { x: 0, y: 0, width: 0, height: 0 } })]);
  assert.deepEqual(tapTargetRows(snapshot), []);
});

test("the floor is a parameter, so another project's rules can be applied without editing this one", () => {
  const snapshot = page([control({ path: "button#go", name: "Go", box: { x: 0, y: 0, width: 30, height: 30 } })]);
  assert.equal(tapTargetRows(snapshot, 24).length, 0);
  assert.equal(tapTargetRows(snapshot, 44).length, 1);
});
