/**
 * The Overview is a briefing, not a scroll. On a delivered mission at 360 px it stood 4,132 px tall: six file rows, five turns,
 * seven checks and the whole folded event feed were between the hero and the end, and the page's own index (four buttons) was
 * still 883 px down. This pass makes every section below the hero one 44 px row until it is opened. From 2026-10-28 those rows are
 * the phone's index too: the button row above them said the same four names 120 px before they were read again, so a phone draws
 * no jump row, and each closed row is a door across its whole width. The browser that measured it is not in this suite, so the
 * shape is pinned in the sources.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), "utf8");

const overview = read("views/Overview.tsx");
const panel = read("views/Panel.tsx");
const shipped = read("views/Shipped.tsx");
const goal = read("views/GoalChecks.tsx");
const css = read("views/overview.css");

test("a phone folds the four evidence sections to one row each, and a wide screen never does", () => {
  assert.match(overview, /const PHONE = "\(max-width: 620px\)";/, "the fold uses the phone's own breakpoint");
  assert.match(overview, /const phone = useMedia\(PHONE\);/, "and asks CSS's answer rather than a second copy of it");
  assert.match(overview, /const foldOf = \(id: string, summary: React\.ReactNode\): Fold \| undefined =>\s*phone \? \{ open: openSections\.has\(id\), onToggle: \(\) => toggleSection\(id\), summary \} : undefined;/, "the fold exists only where a thumb is");
  for (const id of ["ov-shipped", "ov-work", "ov-goal", "ov-events"]) {
    assert.ok(overview.includes(`foldOf("${id}"`), `${id} folds`);
  }
  assert.match(goal, /fold=\{fold\}/, "the goal card carries the fold through");
  assert.match(shipped, /fold=\{fold\}/, "and so does what shipped");
  assert.match(overview, /const stepsFold = stepsErr && !steps\.length \? "could not load"/, "a failed read is said in the closed row, not left reading forever");
  assert.match(overview, /const artsFold = artsState === "error" \? "could not load"/, "the files' own first failure too");
  assert.match(overview, /const eventsFold = sseState === "reconnecting" \? "paused while reconnecting" : behind && tailFailed \? "latest could not load"/, "and a paused or partial stream");
});

test("the closed head says what is inside and how to open it; the body is hidden, not merely tucked away", () => {
  assert.match(panel, /const closed = fold !== undefined && !fold\.open;/, "one answer decides the head and the body");
  assert.match(panel, /<span className="card-meta card-fold-sum">\{fold\.summary\}<\/span>/, "a closed section carries its one figure");
  assert.match(panel, /<Button variant="small" aria-expanded=\{fold\.open\} aria-controls=\{bodyId\} aria-label=\{named\} onClick=\{fold\.onToggle\}>/, "the control says whether it is open, what it opens and which section it belongs to");
  assert.match(panel, /\{fold\.open \? "Hide" : "Show"\}/, "and names what pressing it does");
  assert.match(panel, /<div id=\{bodyId\} hidden=\{!fold\.open\}>\{children\}<\/div>/, "the closed body is hidden from the page and from a screen reader");
  assert.match(panel, /\$\{closed \? " closed" : ""\}/, "the section names its closed state");
  assert.match(css, /\.ov \.card-fold-sum \{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/, "a long summary stays on the row's one line");
  assert.match(css, /\.ov \.card\.closed \{[^}]*background: none;[^}]*border-top: 1px solid var\(--line\);[^}]*padding: var\(--s1\) var\(--s2\)/, "closed, a section is a ruled row, not a card with a heading and nothing under it");
  assert.match(css, /\.ov \.card\.closed \.card-head \{[^}]*flex-wrap: nowrap;[^}]*padding: 0;[^}]*border: 0;/, "and its head spends no room on a rule with no body under it");
});

test("the index is the wide screen's; on a phone the four rows are the index", () => {
  assert.match(overview, /\{phone \? null : <JumpRow delivered=\{delivered\} onOpen=\{jumpTo\} \/>\}/, "the row is drawn where the sections are open, and not where they are one row each");
  assert.match(overview, /const phone = useMedia\(PHONE\);/, "the same answer the fold uses");
  assert.doesNotMatch(css, /@media \(max-width: 620px\) \{\s*\.ov-jump/, "and no phone rule is left for a row a phone never draws");
});

test("a jump lands on the section it names", () => {
  assert.match(overview, /const jumpTo = \(id: string\): void => setPendingJump\(id\);/, "a wide jump is a landing, not an open: the sections are already open there");
  assert.match(overview, /const \[pendingJump, setPendingJump\] = useState<string \| null>\(null\);/, "the landing is a commit later, not the same tick");
  assert.match(overview, /el\.focus\(\{ preventScroll: true \}\);\s*const still = window\.matchMedia\("\(prefers-reduced-motion: reduce\)"\)\.matches;\s*el\.scrollIntoView\(\{ block: "start", behavior: still \? "auto" : "smooth" \}\);/, "the effect takes the focus and asks the motion preference");
});

test("each closed row's control is named by the section it opens", () => {
  assert.match(panel, /const named = typeof title === "string" \? `\$\{title\}: \$\{fold\?\.open \? "Hide" : "Show"\}` : undefined;/, "the name is the section's, then what the press does");
  assert.match(panel, /aria-label=\{named\}/, "four controls reading Show alone say nothing about what they open");
});
