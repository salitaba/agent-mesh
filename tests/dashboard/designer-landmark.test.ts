/**
 * The Designer's inspector is one landmark, not two nested ones with one name.
 *
 * `.ms-side` is the panel: a `region` on a wide screen and a `dialog` on a phone, named "Inspector" (`Designer.tsx`). Inside it,
 * `Inspector.tsx` used to be an `<aside aria-label="Inspector">` as well, so axe reported `landmark-complementary-is-top-level`
 * (one node) and a screen reader listed two complementary landmarks called Inspector. The inner card is a `div` now; the panel
 * keeps the role and the name, and its tablist keeps its own "Inspector" label.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src", "designer");
const inspector = fs.readFileSync(path.join(SRC, "Inspector.tsx"), "utf8");
const designer = fs.readFileSync(path.join(SRC, "Designer.tsx"), "utf8");

test("the inspector card is not a second aside inside the inspector panel", () => {
  assert.doesNotMatch(inspector, /<aside/, "no complementary landmark inside the region");
  assert.match(inspector, /<div className="card ms-insp">/, "the card is a div");
  assert.doesNotMatch(inspector, /card ms-insp" aria-label="Inspector"/, "the name belongs to the panel, once");
});

test("the panel is the one landmark and it says whether it is a region or a dialog", () => {
  assert.match(designer, /id="ms-inspector"[^>]*role=\{compact \? "dialog" : "region"\}/, "one role for the panel");
  assert.match(designer, /aria-label=\{compact \? undefined : "Inspector"\}/, "the wide panel is named once");
  assert.match(designer, /id="ms-side-title"/, "the phone dialog is named by its own title");
});
