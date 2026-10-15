/**
 * The report itself: what `analyze` decides is a failure and what it merely notes, and the text the
 * designer reads. The seats are language models, so this text is the interface — a section that is
 * missing is a fact the crew does not have.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, allRows, renderReport, renderSummary, verdict } from "../../packages/ux-report/src/index";
import { control, node, page } from "./fixture";

/** A page that is wrong in exactly the tested ways: a small target, a grey paragraph, a wide element. */
function badPage() {
  return page(
    [
      node({ path: "main", tag: "main", box: { x: 0, y: 0, width: 390, height: 300 } }),
      node({ path: "p.fine", tag: "p", text: "Footnote", fontSize: 13, color: "rgb(190, 190, 190)" }),
      control({ path: "button#go", tag: "button", name: "Go", box: { x: 12, y: 200, width: 38, height: 30 } }),
      node({ path: "table.grid", tag: "table", box: { x: 0, y: 260, width: 1000, height: 40 } }),
    ],
    { title: "Quarterly report", part: "Quarterly report", scrollWidth: 1024 },
  );
}

test("what fails and what is only worth saying are different lists", () => {
  const report = analyze(badPage(), { source: "file /tmp/bad.html", scheme: "light", screenshot: "/tmp/bad.png" });
  const checks = new Set(report.failures.map((r) => r.check));
  assert.deepEqual([...checks].sort(), ["overflow", "tap-target", "text-contrast"], "the three fatal kinds");
  assert.ok(report.failures.every((r) => r.fatal && !r.ok));
  assert.ok(report.notes.every((r) => !r.fatal && !r.ok));
  assert.equal(report.page.source, "file /tmp/bad.html");
  assert.equal(report.page.screenshot, "/tmp/bad.png");
  assert.equal(report.page.part, "Quarterly report");
  assert.equal(report.scroll.scrolls, true);
  // A row is also a pair that passed: a boundary measured and cleared is still a row a reader sees.
  assert.equal(allRows(report).filter((x) => !x.ok).length, report.failures.length + report.notes.length);
});

test("a clean page reports no failures and one line says so", () => {
  const report = analyze(
    page([node({ path: "p.one", tag: "p", text: "One", color: "rgb(22, 24, 29)" })]),
    { screenshot: "/tmp/clean.png" },
  );
  assert.deepEqual(report.failures, []);
  assert.equal(verdict(report), "no failures: 1 elements measured at 390px");
  assert.match(renderSummary(report), /^Fixture @ 390px: 0 failure\(s\), 0 note\(s\), 1 elements, shot \/tmp\/clean\.png$/);
});

test("the verdict counts failures by what kind they are", () => {
  const report = analyze(badPage());
  assert.match(verdict(report), /^4 failures: 2 overflow, 1 tap-target, 1 text-contrast$/);
});

test("the report names the page, the viewport, the screenshot path and every section a review quotes", () => {
  const report = analyze(badPage(), { source: "file /tmp/bad.html", screenshot: "/tmp/curule-ux-render/bad-390x844-light.png" });
  const text = renderReport(report);
  assert.match(text, /^ux-render — Quarterly report\n/);
  assert.match(text, /\n {2}read {6}file \/tmp\/bad\.html\n/);
  assert.match(text, /\n {2}title {5}Quarterly report\n/);
  assert.match(text, /\n {2}viewport {2}390×844 CSS px\n/);
  assert.match(text, /\n {2}shot {6}\/tmp\/curule-ux-render\/bad-390x844-light\.png\n/);
  for (const section of ["FAILURES", "TAP TARGETS under 44×44", "HORIZONTAL OVERFLOW", "CONTRAST — text", "CONTRAST — boundaries", "FOCUS", "TYPE AND SPACE CENSUS", "BOX TREE", "NOTES"]) {
    assert.ok(text.includes(section), `the report has a ${section} section`);
  }
  assert.doesNotMatch(text, /data:image/, "the screenshot is a path, never base64 in the report");
  assert.match(text, /button#go "Go" is 38×30 CSS px at \(12, 200\): the tap-target floor is 44×44 CSS px\./);
  assert.match(text, /#bebebe on #ffffff is 1\.86:1 at 13px\/400/);
  assert.match(text, /the document is 1024px wide at a 390px viewport: the page scrolls sideways\./);
});

test("the box tree carries the geometry a stylesheet cannot tell you", () => {
  const report = analyze(
    page([
      node({
        path: "main > button.primary",
        tag: "button",
        role: "button",
        name: "Start",
        text: "Start",
        interactive: true,
        box: { x: 16, y: 191.19, width: 67.86, height: 44 },
        fontSize: 16,
        fontWeight: 700,
        lineHeight: 24,
        color: "rgb(255, 255, 255)",
        background: "rgb(27, 79, 216)",
        radius: { topLeft: 6, topRight: 6, bottomRight: 6, bottomLeft: 6 },
        padding: { top: 8, right: 16, bottom: 8, left: 16 },
        margin: { top: 0, right: 0, bottom: 16, left: 0 },
      }),
    ]),
  );
  const [box] = report.boxes;
  assert.deepEqual(box.box, { x: 16, y: 191.19, width: 67.86, height: 44 });
  assert.equal(box.radius, "6px");
  assert.equal(box.padding, "8/16/8/16");
  assert.equal(box.margin, "0/0/16/0");
  assert.equal(box.background, "#1b4fd8");
  const text = renderReport(report);
  const line = text.split("\n").find((l) => l.startsWith("* main > button.primary"))!;
  for (const field of ["16,191.19,67.86,44", "button", "700", "#ffffff", "#1b4fd8", "6px", "8/16/8/16", "0/0/16/0", "system-ui"]) {
    assert.ok(line.includes(field), `the box row carries ${field}:\n${line}`);
  }
  assert.match(text, /\n\s+└ Start\n/);
});

test("what the page threw while it loaded is part of the report", () => {
  const report = analyze(page([node({ path: "p.one", tag: "p", text: "One" })], { errors: ["uncaught: app is not defined", "request failed: http://cdn.example/font.woff2"] }));
  assert.equal(report.errors.length, 2);
  const text = renderReport(report);
  assert.match(text, /PAGE ERRORS \(2\)/);
  assert.match(text, /note uncaught: app is not defined/);
});

test("a truncated walk says so rather than pretending the page is small", () => {
  const report = analyze(page([node({ path: "div.one", tag: "div" })], { truncatedAt: 4000 }));
  assert.match(renderReport(report), /elements {2}1 laid out \(stopped at 4000\)/);
});
