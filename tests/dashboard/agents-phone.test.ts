/**
 * The Agents ledger on a phone.
 *
 * At 360 a finished roster stacks each row into four bands and the table's head was `display: none`, so the token figure was a
 * bare "7.2k": the column's name was neither drawn nor in the accessibility tree. The Cost ledger had the same defect fixed on
 * 2026-10-29 ("both number columns unnamed → both named"); the fixed roster's last column was the one that was missed. The word
 * is drawn only where the head is not, so a desk keeps its table head and its 54 px rows.
 *
 * Read as text: the browser that measured the page is not part of the suite.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const read = (file: string): string => fs.readFileSync(path.join(SRC, file), "utf8");
const tsx = read("views/Agents.tsx");
const sheet = read("views/agents.css");

test("a stacked agent row names its token figure in words", () => {
  assert.match(tsx, /<span className="ag-t-tok-u">tokens<\/span>/, "the cell carries the column's word");
});

test("the word is drawn only where the head is not", () => {
  assert.match(sheet, /\.ag-t-tok-u \{ display: none; \}/, "a desk keeps the head and hides the repeat");
  const phoneAt = sheet.indexOf("@media (max-width: 900px)");
  assert.ok(phoneAt > 0, "the phone block exists");
  const phone = sheet.slice(phoneAt);
  assert.match(phone, /\.ag-table\.tbl\.dense \.ag-t-tok-u \{ display: inline; \}/, "the stacked row draws it");
});

test("the hidden head stays in the accessibility tree, so every column keeps its name", () => {
  const phoneAt = sheet.indexOf("@media (max-width: 900px)");
  const phone = sheet.slice(phoneAt);
  // `display: none` removed the <th>s from the tree as well as the screen; the sr-only pattern hides them visually only.
  assert.doesNotMatch(phone, /\.ag-table\.tbl\.dense thead \{ display: none; \}/);
  assert.match(phone, /\.ag-table\.tbl\.dense thead \{ position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect\(0 0 0 0\); white-space: nowrap; border: 0; \}/);
});
