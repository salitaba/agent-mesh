/**
 * The answer comes before the evidence.
 *
 * Measured on the host-spend card at 360 with axe-core 4.14 and a real waiting decision (2026-11-04): the card's decision record
 * (72 px of `.dc-context`) sat between the consequence and the answer form, so the card's primary control began at y=772 — wholly
 * under the 747 px dock. "Needs you" is the page whose one job is the answer, and its first screen said there was no action. The
 * evidence is reference; it now follows the answer and its technical details. The DOM order is the visual order, so the tab order
 * still walks the screen from top to bottom.
 *
 * Read as text; the browser that measured it is not in the suite.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const decision = fs.readFileSync(path.join(SRC, "views", "DecisionCard.tsx"), "utf8");

test("a decision offers its answer before the record that evidences it", () => {
  const body = decision.slice(decision.indexOf("return (\n    <article"));
  assert.ok(body.length > 1000, "the card's render body is found");
  const next = body.indexOf('<p className="dc-next">');
  const answer = body.indexOf('{kind === "ceiling" && plan.primary.id === "open-settings"');
  const evidence = body.indexOf('{kind !== "stuck" && kind !== "derived" && (agents.length || disUri)');
  const tech = body.indexOf('<details className="disc dc-tech">');
  assert.ok(next > 0 && answer > 0 && evidence > 0 && tech > 0, "all four blocks are in the card");
  assert.ok(next < answer, "the consequence still comes before the press it decides");
  assert.ok(answer < evidence, "the answer is not behind its own evidence");
  assert.ok(evidence < tech, "the record comes before the raw technical details, and both follow the answer");
});

test("the CSS does not reorder the card behind the reader's tab order", () => {
  const css = fs.readFileSync(path.join(SRC, "views", "inbox.css"), "utf8");
  assert.doesNotMatch(css, /\.dc[^{]*\{[^}]*[;{]\s*order:/, "no flex order moves a control away from its DOM place");
});
