/**
 * A seat's authority is a row per domain of the protocol's catalogue, with one switch per verb, and it has to fit the inspector.
 *
 * What it was: a seven-column table of checkboxes. Measured in the running console, its narrowest form is 393px, and the inspector is
 * never that wide — the column is clamp(340px, 30vw, 400px), so at 1440px the table sat 393px inside a 366px panel, at 900px inside a
 * 367px one and at 360px inside 332px. The panel scrolled sideways at every width and the last verb ("pass") was off the edge, and the
 * checkbox was an 18x18 target in a 31px row, under the 24px a thumb is allowed to miss by. The browser is not in this run, so the
 * shape that replaced it is pinned in the source: verbs that wrap under the domain name, switches the size of a finger.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), "utf8");

const ui = read("designer/ui.tsx");
const inspector = read("designer/inspector.css");
const styles = read("styles.css");

/** The source of one exported function: from its declaration to the closing brace at the start of a line. */
function bodyOf(source: string, name: string): string {
  const start = source.indexOf(`export function ${name}`);
  assert.ok(start >= 0, `${name} is exported`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `${name} ends`);
  return source.slice(start, end + 3);
}

/** Every declaration block whose selector list names `selector` as one of its parts: `.chip, .sbx-chip, .chip-toggle { … }` counts. */
function blocksFor(css: string, selector: string): string[] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];
  for (const m of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1]!.split(",").some((s) => s.trim() === selector)) out.push(m[2]!);
  }
  return out;
}

test("a seat's authority is a row per domain whose switches wrap, not a table that cannot fit", () => {
  const grid = bodyOf(ui, "AuthorityGrid");
  assert.ok(!/<table/.test(grid), "no table: its seven columns set 393px of width the inspector does not have");
  assert.match(grid, /className="ms-auth-rows"/, "the domains are a list of rows");
  assert.match(grid, /className="ms-auth-row"[\s\S]*?className="chips"/, "each row is a domain name and a wrapping row of switches");
  // The switch is named for both halves: "architecture approve" is what a screen reader reads, and the visible word is in it.
  assert.match(grid, /aria-label=\{`\$\{d\} \$\{v\}`\}/, "a switch says which domain and which verb it grants");
  assert.match(grid, /aria-pressed=\{on\}/, "a switch says whether it is on");
});

test("the row of switches cannot push the panel sideways", () => {
  const rows = blocksFor(inspector, ".ms-auth-row");
  assert.ok(rows.length, ".ms-auth-row has a rule");
  assert.ok(rows.some((r) => /grid-template-columns: minmax\(0, \d+px\) minmax\(0, 1fr\)/.test(r)),
    "the domain column is capped and the switches column may shrink");
  // The switches themselves are the kit's chips, whose list wraps (styles.css): six verbs never make one unbreakable line.
  const chips = blocksFor(styles, ".chips").join(";");
  assert.match(chips, /display: flex/, "a chip list is a row");
  assert.match(chips, /flex-wrap: wrap/, "a chip list wraps rather than overflowing");
});

test("a switch is at least a thumb's target: 24px everywhere, 44px on a phone", () => {
  const heights = blocksFor(styles, ".chip-toggle").map((b) => /min-height:\s*(\d+)px/.exec(b)?.[1]).filter((h) => h != null).map(Number);
  assert.ok(heights.length, "the kit gives a switch a minimum height");
  const floor = Math.max(...heights);
  assert.ok(floor >= 24, `a switch is at least 24px tall, not ${floor}px`);
  const phone = blocksFor(inspector, ".ms-auth-row .chip-toggle");
  assert.ok(phone.length, "the phone block sizes an authority switch");
  const rule = phone.join(";");
  assert.match(rule, /min-height: 44px/, "a phone switch is 44px tall");
  assert.match(rule, /flex: 1 1 30%/, "three to a row at 360px, so nothing is a sliver to hit");
  assert.match(rule, /justify-content: center/, "the word is centred in the switch it belongs to");
});

test("nothing is left of the table: no cell rule and no checkbox rule for authority", () => {
  assert.doesNotMatch(inspector, /\.ms-auth (table|th|td)\b/, "the table's rules are gone");
  assert.doesNotMatch(inspector, /\.ms-auth td > input/, "the 18px checkbox rule is gone");
  assert.equal(blocksFor(inspector, ".ms-auth-domain").length, 1, "the domain name has its own rule");
});
