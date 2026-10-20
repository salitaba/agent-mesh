/**
 * Escape did not close the Designer's phone drawer. The drawer opens with focus in its first field; the shell's global key router
 * blurs a focused field on Escape and calls preventDefault before view handlers run, so the first press only moved focus to <body>
 * and the full-screen drawer stayed up. Measured at 360px in the running console, 2026-10-20: Escape #1 -> drawer still open, active
 * element body; Escape #2 -> drawer closed, focus back on "Add seat". A field that used Escape itself (the seat id reverts an
 * uncommitted rename) must still keep the drawer open, so the rule is a function with cases.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

import { drawerTakesEscape } from "../../apps/mesh-dashboard/src/designer/escape";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const designer = fs.readFileSync(path.join(SRC, "designer", "Designer.tsx"), "utf8");

test("Escape closes the phone drawer on the first press", () => {
  assert.equal(drawerTakesEscape({ key: "Escape", defaultPrevented: false }, true, true), true);
});

test("a field that used Escape keeps the drawer, and a key that is not Escape never closes it", () => {
  assert.equal(drawerTakesEscape({ key: "Escape", defaultPrevented: true }, true, true), false, "the seat id's own Escape reverts its draft; the drawer stays");
  assert.equal(drawerTakesEscape({ key: "Enter", defaultPrevented: false }, true, true), false);
});

test("the inspector is not a layer on a wide screen, and a closed drawer owns nothing", () => {
  assert.equal(drawerTakesEscape({ key: "Escape", defaultPrevented: false }, false, true), false, "a column on a wide screen stays open");
  assert.equal(drawerTakesEscape({ key: "Escape", defaultPrevented: false }, true, false), false);
});

test("the drawer claims Escape on its own container, before the shell's window handler", () => {
  const start = designer.indexOf('id="ms-inspector"');
  assert.ok(start >= 0, "the drawer is in the page");
  const drawer = designer.slice(start, start + 500);
  assert.match(drawer, /onKeyDown=/, "the drawer handles the key where the field handlers have already run");
  assert.match(drawer, /drawerTakesEscape\(/, "the rule is the tested one");
  assert.match(drawer, /setCtxOpen\(false\)/, "it closes the drawer");
});
