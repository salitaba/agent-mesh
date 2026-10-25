/**
 * A panel whose record has not arrived: the drawer's head stays, and the pen does not fall on the floor.
 *
 * Measured at 360 px with `/agents/pm` delayed by 7 s: the agent drawer was the bare word "loading…" in a 360 × 800 panel —
 * no name, no close control and no live region — and the step drawer put focus on its close button at 86 ms, then dropped it
 * to `<body>` when the record replaced the skeleton. A keyboard reader had to Tab back into a panel they had just opened, and
 * a screen reader was told nothing at all. These read the source as text, the way `primitives-a11y.test.ts` does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const drawers = fs.readFileSync(path.join(SRC, "drawers.tsx"), "utf8");

test("an agent drawer that is still reading its record keeps its name, its close and a status line", () => {
  const start = drawers.indexOf("  if (!json) {");
  assert.ok(start >= 0, "the loading branch is a block, so it can hold the head");
  const end = drawers.indexOf("\n  }\n", start);
  assert.ok(end > start, "the loading branch ends");
  const loading = drawers.slice(start, end);
  assert.doesNotMatch(loading, /<div className="muted">loading…<\/div>/, "the bare word is gone");
  assert.match(loading, /<DrawerHeader>\{id\}<\/DrawerHeader>/, "the drawer is named while it is read");
  assert.match(loading, /role="status"/, "and says what it is doing");
  assert.match(loading, /<Skeleton/, "the shape of the record is drawn");
  // The first child of the loaded and failed branches is the same head, so React reuses the node and focus stays on its close.
  assert.ok((drawers.match(/<DrawerHeader>\{id\}<\/DrawerHeader>/g) || []).length >= 2, "the head is shared by the loading and error branches");
  assert.match(drawers, /<DrawerHeader>\s*<AgentAvatar id=\{id\}/, "and by the loaded branch");
});

test("the step drawer puts focus back in the panel if the record's arrival removed it", () => {
  const start = drawers.indexOf("const restoredFor");
  assert.ok(start >= 0, "the drawer remembers it has restored once per turn");
  const end = drawers.indexOf("}, [data]);", start);
  assert.ok(end > start, "the effect ends");
  const effect = drawers.slice(start, end);
  assert.match(effect, /restoredFor\.current === data\.id/, "once per turn");
  assert.match(effect, /document\.activeElement/, "it asks where focus is");
  assert.match(effect, /active !== document\.body/, "and acts only when focus was lost — never over a reader who moved on");
  assert.match(effect, /querySelector<HTMLElement>\("\.close-x"\)/, "the close the skeleton held is the landing place");
  assert.match(effect, /\?\?\s*root\.querySelector<HTMLElement>/, "or the panel's first control if there is no close");
  assert.match(effect, /\.focus\(\)/, "and it is focused");
});
