/**
 * A page is named by the name you pressed.
 *
 * The sidebar's "Tool gates" and the palette's "Go to Tool gates" opened a page headed "Needs you": one page with two routes, and
 * the heading ignored which route you came by. A reader who pressed one name landed on another and had to find the tab to believe
 * they were in the right place. Both routes still render the same component (so the data and the scroll survive a tab press); the
 * heading now follows the tab in front. Its document title already followed the route ("Delivered · Tool gates — Curule").
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const inbox = fs.readFileSync(path.join(SRC, "views", "Escalations.tsx"), "utf8");

test("the inbox's heading is the tab in front, not one fixed word", () => {
  assert.match(inbox, /const tab = tabOfView\(view\);/, "the tab comes from the route");
  assert.match(inbox, /<PageHeader title=\{tab === "tools" \? "Tool gates" : "Needs you"\}/, "the heading follows it");
  assert.equal((inbox.match(/<PageHeader title="Needs you"/g) ?? []).length, 0, "and no fixed Needs you head is left to disagree with it");
});
