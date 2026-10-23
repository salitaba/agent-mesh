/**
 * WCAG 2.5.3 (Label in Name) on the three controls that failed it everywhere: the designer's dock button, a seat on the Graph, and a
 * seat card in the Designer. Each used to carry a shorter aria-label than the words drawn inside it ("Ask the designer" over "Ask
 * designer", "pm, done" over "PM pm done"), which axe reports as label-content-name-mismatch — 166 nodes across 50 view/width/theme
 * pairs on 2026-10-23. The rule is that the name a voice-control user says is the name they can see: a control either names itself
 * from its own visible text, or its aria-labelledby points at the text that is drawn. This reads the source, because the behaviour
 * depends on rendered text and the browser pass is `npm run qa:console` (docs/design-spec.md §7).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const read = (p: string): string => fs.readFileSync(path.join(SRC, p), "utf8");

test("the designer button is named by the words drawn in it", () => {
  const tsx = read(path.join("designer", "ChatDock.tsx"));
  assert.match(tsx, /<span className="act-lbl">\{busy \? "Thinking…" : "Ask designer"\}<\/span>/, "the visible label is the two words");
  assert.match(tsx, /aria-label=\{busy \? "Thinking… \(asking the designer\)" : "Ask designer"\}/, "the name contains them, including while it is thinking");
  assert.doesNotMatch(tsx, /aria-label=\{open \? "Close the designer assistant"/, "a closed/open toggle is aria-expanded, not a renamed visible label");
});

test("a Graph seat is named from its own text, initials and all", () => {
  const tsx = read(path.join("views", "Graph.tsx"));
  assert.match(tsx, /aria-labelledby=\{`gn-\$\{nd\.id\}-init gn-\$\{nd\.id\}-name gn-\$\{nd\.id\}-state`\}/, "the node's name is the three lines drawn on it");
  assert.doesNotMatch(tsx, /aria-label=\{`\$\{nd\.id/g, "no shorter label overrides the drawing");
  assert.match(tsx, /className="gr-seat-row" onClick=\{\(\) => open\(nd\.id\)\}/, "the phone row names itself from its content");
  assert.match(tsx, /<span className="sr-only"> Open details\.<\/span>/, "the action is added as hidden text, not as a replacement name");
});

test("a Designer seat is named from the face, the name and the role it draws", () => {
  const tsx = read(path.join("designer", "Topology.tsx"));
  assert.match(tsx, /aria-labelledby=\{\[`ms-seat-face-\$\{id\}`, `ms-seat-nm-\$\{id\}`, roleLine \? `ms-seat-rl-\$\{id\}` : ""\]/, "the name is the visible pieces");
  assert.match(tsx, /id=\{`ms-seat-face-\$\{id\}`\}/, "the face has an id because it holds the initial the person sees");
  assert.doesNotMatch(tsx, /data-seat=\{id\} aria-pressed=\{sel\} aria-label=\{label\}/, "no shorter label overrides the card");
});
