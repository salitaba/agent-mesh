/**
 * The sideways scroll. The owner works on a phone, so a page that is wider than 390px is a page whose
 * right-hand side nobody will ever see — and the interesting part is *which* element did it, not just
 * that it happened.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { overflowReport } from "../../packages/ux-report/src/index";
import { node, page } from "./fixture";

test("a page that fits is reported as fitting, and nothing else is said", () => {
  const report = overflowReport(page([node({ path: "main", tag: "main", box: { x: 0, y: 0, width: 390, height: 900 } })]));
  assert.equal(report.scrolls, false);
  assert.equal(report.rows.length, 1, "the document row is always there, and it passes");
  assert.equal(report.rows[0].ok, true);
  assert.match(report.rows[0].text, /the document is 390px wide at a 390px viewport: it does not scroll sideways\./);
});

test("a document wider than the viewport fails, and says both numbers", () => {
  const report = overflowReport(
    page([node({ path: "table.grid", tag: "table", box: { x: 0, y: 40, width: 1000, height: 200 } })], { scrollWidth: 1024, clientWidth: 390 }),
  );
  assert.equal(report.scrolls, true);
  const documentRow = report.rows.find((r) => r.target === "document")!;
  assert.equal(documentRow.ok, false);
  assert.equal(documentRow.fatal, true);
  assert.match(documentRow.text, /the document is 1024px wide at a 390px viewport: the page scrolls sideways\./);
});

test("the element that exceeds the viewport is named with its numbers", () => {
  const report = overflowReport(
    page([node({ path: "table.grid", tag: "table", box: { x: 12, y: 40, width: 1000, height: 200 } })], { scrollWidth: 1012 }),
  );
  const offender = report.rows.find((r) => r.path === "table.grid")!;
  assert.equal(offender.ok, false);
  assert.equal(offender.fatal, true);
  assert.equal(offender.floor, "≤ 390px");
  assert.match(offender.text, /table\.grid reaches 1012px, past the 390px viewport\./);
});

test("an element exactly at the edge is inside it", () => {
  const report = overflowReport(page([node({ path: "div.card", tag: "div", box: { x: 0, y: 0, width: 390, height: 100 } })], { scrollWidth: 390 }));
  assert.equal(report.rows.filter((r) => r.path === "div.card").length, 0);
});

test("content in a deliberate horizontal scroller is the pattern, not the defect", () => {
  const report = overflowReport(
    page([node({ path: "div.scroll > table.grid", tag: "table", box: { x: 0, y: 40, width: 900, height: 200 }, scrollAncestor: "auto" })]),
  );
  const row = report.rows.find((r) => r.path === "div.scroll > table.grid")!;
  assert.equal(row.ok, false, "it is still wider than the viewport, and still worth saying");
  assert.equal(row.fatal, false, "but a scroller is how a wide table is meant to be shown");
  assert.match(row.text, /inside a horizontal scroller: that is the pattern/);
});

test("content an ancestor clips is content nobody can reach, and fails", () => {
  const report = overflowReport(
    page([node({ path: "div.clip > p.long", tag: "p", box: { x: 0, y: 40, width: 700, height: 20 }, scrollAncestor: "hidden" })]),
  );
  const row = report.rows.find((r) => r.path === "div.clip > p.long")!;
  assert.equal(row.fatal, true);
  assert.match(row.text, /an ancestor clips it: that content cannot be reached\./);
});

test("an element pushed off the left edge is reported too", () => {
  const report = overflowReport(page([node({ path: "div.offscreen", tag: "div", box: { x: -40, y: 0, width: 380, height: 40 } })]));
  const row = report.rows.find((r) => r.path === "div.offscreen")!;
  assert.equal(row.fatal, true);
  assert.match(row.text, /starts at -40px, past the 390px viewport\./);
});
