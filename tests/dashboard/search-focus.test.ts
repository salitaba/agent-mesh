/**
 * A search's Clear controls are the only controls that exist for as long as there is text. Pressing one removes the pressed
 * button from the document, and the browser drops focus on <body>. Measured at 360 on Events: clearing the field's own button,
 * the toolbar's Clear filters, or the empty state's Clear filters all left activeElement as <body>, so the next Tab restarted at
 * the skip link and the search field the person was using was behind them. The field stays where it was; the cursor belongs in it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), "utf8");

const searchField = read("ui/search.tsx");
const events = read("views/Events.tsx");

test("a search field keeps the cursor in itself after its clear button removes the button", () => {
  assert.match(searchField, /const inputRef = useRef<HTMLInputElement>\(null\);/, "the field can find itself after the press");
  assert.match(searchField, /<input ref=\{inputRef\} className="search"/, "the ref is on the field");
  assert.match(searchField, /onClick=\{\(\) => \{ onClear\(\); inputRef\.current\?\.focus\(\); \}\}/, "the press clears and puts the cursor back");
});

test("Events' toolbar and empty-state Clear controls hand the cursor to the search", () => {
  assert.match(events, /const clearAll = useCallback\(\(\) => \{[\s\S]*?setEvSearch\(""\);[\s\S]*?document\.getElementById\("ev-search"\)\?\.focus\(\);[\s\S]*?\}, \[setEvFilter, setEvSearch\]\);/, "both Clear controls use clearAll, and clearAll lands on the field");
  assert.match(events, /\{filtered \? <Button variant="ghost" icon="x" onClick=\{clearAll\}>Clear filters<\/Button> : null\}/, "the toolbar action still clears");
  assert.match(events, /action=\{<Button variant="small" onClick=\{clearAll\}>Clear filters<\/Button>\}/, "the empty state's action still clears");
});
