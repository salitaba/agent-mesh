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
