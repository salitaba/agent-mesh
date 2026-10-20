/**
 * A bookmark to a host page on a server that runs one mesh. Measured at 360 px on a local console started with `run`/`console`:
 * `#/projects` and `#/hostsettings` rendered the "This server runs one mesh" empty state with no page heading at all
 * (`document.querySelector("#view .page-head")` was null on both). The state is right, but the page stopped saying which page
 * it was. It now keeps its name above the state.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const main = fs.readFileSync(path.join(SRC, "main.tsx"), "utf8");

test("the single-mesh fallback still names the page it stands in", () => {
  const branch = main.slice(main.indexOf("if (registry === false && isHostView(view))"), main.indexOf("return (<ViewBoundary"));
  assert.match(branch, /<PageHeader title=\{view === "projects" \? "Projects" : "Host settings"\} \/>/, "the fallback has a page heading");
  assert.match(branch, /<EmptyState/, "the state itself remains");
  assert.match(branch, /Back to the overview/, "the way out remains");
});
