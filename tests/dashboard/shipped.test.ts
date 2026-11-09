/**
 * The Overview's "What shipped" cards printed where the mesh stores each file's content (`.mesh-state/artifacts/artifacts/art-…`),
 * the same internal path on every card. A card now shows a path only when the file is in the product's repository, as the Files
 * list does. The cards are React, so these pin the decision (`repoPathOf`) and that the cards use it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

import { repoPathOf } from "../../apps/mesh-dashboard/src/files";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const shipped = fs.readFileSync(path.join(SRC, "views", "Shipped.tsx"), "utf8");

test("a file in the product's repository has a path; a document the mesh stores has none", () => {
  assert.equal(repoPathOf({ metadata: { path: "src/tx/Pipeline.java" } }), "src/tx/Pipeline.java");
  assert.equal(repoPathOf({ metadata: { file: "docs/adr/0001.md" } }), "docs/adr/0001.md");
  assert.equal(repoPathOf({ metadata: {} }), "");
  assert.equal(repoPathOf({}), "", "a requirements doc or a report lives only in the mesh's store");
});

test("the What shipped cards show the repository path and never the store's", () => {
  assert.match(shipped, /repoPathOf\(a\)/);
  assert.doesNotMatch(shipped, /contentRef|shortRef/, "the store path is not read for a card");
});

test("a group heading counts files with a space and a unit", () => {
  // Measured at 390 and 1440: the three headings' textContent was "Delivered3", "Closed without a verdict6" and "Drafts1".
  // They draw a flex row with a gap, so a reader saw three words and a screen reader heard the label and the figure as one
  // word, with no word for what the figure counted. The Files page's groups already read "Approved and merged 3 files".
  assert.match(shipped, /<span>\{g\.label\}<\/span>\{" "\}<b className="ship-n">\{g\.files\.length\} \{g\.files\.length === 1 \? "file" : "files"\}<\/b>/, "label, then a space, the count and its unit");
});

test("a delivered mission's undecided files say what the Files page says: closed without a verdict", () => {
  // The Overview used to say "Awaiting review" and "ready for review" beside "Delivered", while the Files page, one press
  // away, said "Closed without a verdict". A delivered mission is not waiting on a reviewer; `CLOSED_REVIEW` is the one set
  // of words both pages read (files.ts).
  assert.match(shipped, /delivered && g\.key === "review"/, "the result knows the mission is delivered");
  assert.match(shipped, /CLOSED_REVIEW\.label/, "the group heading is the shared label");
  assert.match(shipped, /CLOSED_REVIEW\.many/, "and so is the count's phrase");
  assert.match(shipped, /closed=\{delivered && g\.key === "review"\}/, "the row is told the same thing");
  assert.match(shipped, /CLOSED_REVIEW\.resultRow/, "and draws the short shared state the group heading completes");
});
