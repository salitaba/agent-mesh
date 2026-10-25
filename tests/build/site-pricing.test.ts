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
const DATA = /<script type="application\/json" id="plans-data">([\s\S]*?)<\/script>/.exec(PAGE)![1]!;

class El {
  children: El[] = [];
  className = "";
  hidden = false;
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
  addEventListener(): void {
    // The script wires events for a browser; the test calls calc through the one run at load.
  }
}

function run(values: { projects: string; seats: string; missions: string; reports?: boolean }): { result: El; cells: string[][]; pinned: string[] } {
  const result = new El("div");
  const pinnedPlan = new El("span");
  const pinnedFigure = new El("span");
  const field = (value: string): El & { value: string } => Object.assign(new El("input"), { value });
  const nodes: Record<string, unknown> = {
    "plans-data": Object.assign(new El("script"), { textContent: DATA }),
    calc: new El("form"),
    result,
    "calc-total-plan": pinnedPlan,
    "calc-total-figure": pinnedFigure,
    "c-projects": field(values.projects),
    "c-seats": field(values.seats),
    "c-missions": field(values.missions),
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
  return { result, cells: rows.map((row) => row.children.map((cell) => cell.textContent.trim())), pinned: [pinnedPlan.textContent.trim(), pinnedFigure.textContent.trim()] };
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
