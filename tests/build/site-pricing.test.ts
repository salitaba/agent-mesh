/**
 * The pricing page's calculator, run unchanged over the page's own data block in a DOM small enough to
 * read: what it does for a listed plan, and what it must not do for a quoted one. The bug this pins:
 * Enterprise used to end on a bold "Roughly" row with an empty value, which a phone read as a blank
 * price. A quoted plan now says what the total is made of.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as vm from "node:vm";
import { SITE } from "./site-pages";

const SCRIPT = fs.readFileSync(path.join(SITE, "assets", "pricing.js"), "utf8");
const PAGE = fs.readFileSync(path.join(SITE, "pricing", "index.html"), "utf8");
const CSS = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
const DATA = /<script type="application\/json" id="plans-data">([\s\S]*?)<\/script>/.exec(PAGE)![1]!;

class El {
  children: El[] = [];
  className = "";
  hidden = false;
  attrs = new Map<string, string>();
  private text = "";
  constructor(readonly tagName: string) {}
  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join("");
  }
  appendChild(node: El): El {
    this.children.push(node);
    return node;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  addEventListener(): void {
    // The script wires events for a browser; the test calls calc through the one run at load.
  }
}

function run(values: { projects: string; seats: string; missions: string; reports?: boolean }): { result: El; cells: string[][]; pinned: string[]; said: string; errors: Record<string, { hidden: boolean; text: string }>; invalid: Record<string, string | null> } {
  const result = new El("div");
  const pinnedPlan = new El("span");
  const pinnedFigure = new El("span");
  const said = new El("p");
  const field = (value: string): El & { value: string } => Object.assign(new El("input"), { value });
  const projects = field(values.projects);
  const seats = field(values.seats);
  const missions = field(values.missions);
  const error = (): El => Object.assign(new El("p"), { hidden: true });
  const errors = { projects: error(), seats: error(), missions: error() };
  const nodes: Record<string, unknown> = {
    "plans-data": Object.assign(new El("script"), { textContent: DATA }),
    calc: new El("form"),
    result,
    "calc-total-plan": pinnedPlan,
    "calc-total-figure": pinnedFigure,
    "calc-said": said,
    "c-projects": projects,
    "c-projects-error": errors.projects,
    "c-seats": seats,
    "c-seats-error": errors.seats,
    "c-missions": missions,
    "c-missions-error": errors.missions,
    "c-reports": Object.assign(new El("input"), { checked: values.reports ?? false }),
    "c-model": Object.assign(new El("select"), { value: "claude-haiku-4-5" }),
  };
  const document = {
    getElementById: (id: string) => nodes[id] ?? null,
    querySelector: (selector: string) => (selector === "input[name=billing]:checked" ? { value: "annual" } : null),
    querySelectorAll: () => [],
    createElement: (tag: string) => new El(tag),
    createTextNode: (text: string) => Object.assign(new El("#text"), { textContent: text }),
  };
  vm.runInNewContext(SCRIPT, { document }, { filename: "pricing.js" });
  const rows = result.children.filter((n) => n.className === "row");
  return {
    result,
    cells: rows.map((row) => row.children.map((cell) => cell.textContent.trim())),
    pinned: [pinnedPlan.textContent.trim(), pinnedFigure.textContent.trim()],
    said: said.textContent.trim(),
    errors: { projects: { hidden: errors.projects.hidden, text: errors.projects.textContent }, seats: { hidden: errors.seats.hidden, text: errors.seats.textContent }, missions: { hidden: errors.missions.hidden, text: errors.missions.textContent } },
    invalid: { projects: projects.getAttribute("aria-invalid"), seats: seats.getAttribute("aria-invalid"), missions: missions.getAttribute("aria-invalid") },
  };
}

test("a quoted plan ends on what the total is made of, not on a blank figure", () => {
  // 1,000 projects and 1,000 seats are beyond every listed plan, so only Enterprise is left.
  const { cells } = run({ projects: "1000", seats: "1000", missions: "10" });
  assert.deepEqual(cells.map(([label]) => label), ["Plan", "Platform fee (to us)", "Model usage (to your provider)", "Total"]);
  assert.deepEqual(cells[0], ["Plan", "Enterprise"]);
  assert.deepEqual(cells[1], ["Platform fee (to us)", "quoted"]);
  assert.match(cells[2]![1]!, /^about \$[\d,]+ \/ month$/, `the model usage is a figure: ${cells[2]![1]}`);
  assert.ok(cells.every(([, value]) => value && value.length > 0), "no value on the estimate is empty");
  assert.deepEqual(cells[3], ["Total", "Quoted, plus model usage"], "the last line says what is quoted and what is added to it");
});

test("a listed plan still ends on a figure, and the free plan says it is free", () => {
  const team = run({ projects: "3", seats: "7", missions: "25" }).cells;
  assert.deepEqual(team[0], ["Plan", "Team"]);
  assert.match(team[3]![1]!, /^\$[\d,]+ \/ month$/, `a figure: ${team[3]![1]}`);
  const free = run({ projects: "1", seats: "4", missions: "0" }).cells;
  assert.deepEqual(free[0], ["Plan", "Community"]);
  assert.deepEqual(free[3], ["Roughly", "$0 / month"]);
});

/**
 * The figure that sticks over the fields, at 360, is the only total a phone can see while it types: the ledger is a
 * screen below it. On the Community plan it said "Free" (the licence is $0) while the ledger said "$138 / month", so
 * the two figures on one screen disagreed by the reader's whole model bill. Measured today, before this test was
 * written: pinned "Community | Free", ledger "Roughly $138 / month" at 360.
 */
test("the figure pinned over the fields is the ledger's own total, on every kind of plan", () => {
  const free = run({ projects: "1", seats: "7", missions: "25" });
  assert.deepEqual(free.cells[3], ["Roughly", "$138 / month"], "the ledger's total, model usage included on the free plan");
  assert.deepEqual(free.pinned, ["Community", "$138 / month (model usage)"], "and the pinned figure says the same number, and what it pays for");
  const team = run({ projects: "3", seats: "7", missions: "25" });
  assert.deepEqual(team.cells[3], ["Roughly", "$262 / month"]);
  assert.deepEqual(team.pinned, ["Team", "$262 / month (annual)"], "a listed plan's figure is the fee plus the model, and names the period");
  const quoted = run({ projects: "1000", seats: "1000", missions: "10" });
  assert.deepEqual(quoted.cells[3], ["Total", "Quoted, plus model usage"]);
  assert.deepEqual(quoted.pinned, ["Enterprise", "Quoted, plus model usage"]);
  // The rule, not the examples: every figure's money is the ledger's money.
  const money = (text: string): string | null => (/\$[\d,]+/.exec(text) ?? [null])[0];
  for (const values of [{ projects: "1", seats: "7", missions: "25" }, { projects: "3", seats: "7", missions: "25" }, { projects: "1000", seats: "1000", missions: "10" }, { projects: "1", seats: "7", missions: "0" }]) {
    const r = run(values);
    assert.equal(money(r.pinned[1]!), money(r.cells[3]![1]!), `${JSON.stringify(values)}: the pinned figure and the ledger agree`);
  }
});

/**
 * The ledger is several rows and a paragraph of fine print; announcing it on every keystroke flooded a screen reader
 * with the same words and buried the figure. One sentence now carries the same answer, and the ledger is read at
 * leisure. The fields' hints were visible only: a description of the field is where a screen reader looks for them.
 */
test("the estimate is announced in one sentence, and each field's hint is its description", () => {
  const free = run({ projects: "1", seats: "7", missions: "25" });
  assert.equal(free.said, "Community: $138 a month, including model usage", "the initial figure, in words rather than the ledger's '/' and fine print");
  const team = run({ projects: "3", seats: "7", missions: "25" });
  assert.equal(team.said, "Team: $262 a month, billed annually");
  const quoted = run({ projects: "1000", seats: "1000", missions: "10" });
  assert.equal(quoted.said, "Enterprise: quoted, plus model usage");
  // The page, not just the script: the hints are named by the fields, the errors are beside them, and the live region is one sentence.
  assert.match(PAGE, /<input id="c-projects" type="number" min="1" max="1000" step="1" value="1" inputmode="numeric" aria-describedby="c-projects-hint c-projects-error">/);
  assert.match(PAGE, /<div class="hint" id="c-projects-hint">/);
  assert.match(PAGE, /<input id="c-missions"[^>]*aria-describedby="c-missions-hint c-missions-error">/);
  assert.match(PAGE, /<div class="hint" id="c-missions-hint">/);
  assert.match(PAGE, /<p class="field-error" id="c-projects-error" role="alert" hidden><\/p>/);
  assert.match(PAGE, /<p class="field-error" id="c-seats-error" role="alert" hidden><\/p>/);
  assert.match(PAGE, /<p class="field-error" id="c-missions-error" role="alert" hidden><\/p>/);
  assert.match(PAGE, /<p class="sr" id="calc-said" role="status"><\/p>/);
  assert.ok(!/<div class="result" id="result" aria-live=/.test(PAGE), "the ledger is not read out row by row on every keystroke");
  assert.match(CSS, /\.field-error \{[^}]*color: var\(--k-bad\);[^}]*font-size: \.875rem;/, "the refusal is the site's refusal colour, at the hint's size");
});

/**
 * A number field used to be made usable in silence: 0 projects was replaced with 1, the field was left invalid, and
 * the browser's message was never seen because the form is never submitted. The estimate now says which figure it
 * used, on the field, and marks the field invalid for a screen reader.
 */
test("a number outside its field's range says what the estimate used, and the field is marked invalid", () => {
  const zero = run({ projects: "0", seats: "7", missions: "25" });
  assert.deepEqual(zero.errors.projects, { hidden: false, text: "Enter 1 or more. The estimate uses 1." });
  assert.equal(zero.invalid.projects, "true");
  assert.deepEqual(zero.cells[0], ["Plan", "Community"], "the estimate is the one it says it used");
  assert.deepEqual(zero.cells[3], ["Roughly", "$138 / month"]);
  const high = run({ projects: "1001", seats: "7", missions: "25" });
  assert.equal(high.errors.projects.text, "Enter 1,000 or less. The estimate uses 1,000.");
  assert.deepEqual(high.cells[0], ["Plan", "Enterprise"]);
  const fraction = run({ projects: "1.5", seats: "7", missions: "25" });
  assert.equal(fraction.errors.projects.text, "Enter a whole number. The estimate uses 2.");
  const many = run({ projects: "1", seats: "7", missions: "100001" });
  assert.equal(many.errors.missions.text, "Enter 100,000 or less. The estimate uses 100,000.");
  assert.deepEqual(many.cells[3], ["Roughly", "$552,000 / month"]);
  const valid = run({ projects: "1", seats: "7", missions: "25" });
  assert.deepEqual(valid.errors, { projects: { hidden: true, text: "" }, seats: { hidden: true, text: "" }, missions: { hidden: true, text: "" } });
  assert.deepEqual(valid.invalid, { projects: null, seats: null, missions: null });
});
