/**
 * A page read to its end says where else you can go, and the Overview says what is below it.
 *
 * The Overview measured 8,395 px tall on a phone — a delivered mission with a dozen checks and files — and the sections
 * after the hero sat several screens down with nothing at the top saying so. Long pages now end on a quiet row of real
 * destinations, and the Overview's own index names its sections and lands focus on them.
 *
 * Read as text: the browser that measured the pages is not part of the suite.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const read = (file: string): string => fs.readFileSync(path.join(SRC, file), "utf8");

test("the Overview says what is below it, and its panels are the anchors it lands on", () => {
  const overview = read("views/Overview.tsx");
  const panel = read("views/Panel.tsx");
  assert.match(overview, /<JumpRow delivered=\{delivered\} onOpen=\{openSection\} \/>/, "the index is drawn");
  for (const id of ["ov-shipped", "ov-work", "ov-goal", "ov-events"]) {
    assert.ok(overview.includes(`onOpen("${id}")`), `the row offers ${id}`);
    assert.ok(overview.includes(`id="${id}"`) || read("views/GoalChecks.tsx").includes(`id="${id}"`) || read("views/Shipped.tsx").includes(`id="${id}"`), `${id} exists as a section`);
  }
  assert.match(panel, /<section id=\{id\} tabIndex=\{-1\}/, "the section is the element with the id, and can take focus when a jump lands");
});

test("every page that can be read to its end ends on a way out, and the product leads", () => {
  const pages = ["views/Artifacts.tsx", "views/Cost.tsx", "views/Steps.tsx", "views/Agents.tsx", "views/Graph.tsx", "views/Playground.tsx", "views/Product.tsx", "views/Projects.tsx", "views/HostSettings.tsx"];
  for (const page of pages) {
    const tsx = read(page);
    assert.match(tsx, /<NextLinks links=\{\[/, `${page} ends on NextLinks`);
    assert.match(tsx, /label: "Open the product"|label: "Read the files"|label: "Host settings"|label: "Projects"/, `${page}'s links name a real destination`);
  }
  const productFirst = pages.filter((p) => !p.includes("HostSettings") && !p.includes("Projects") && !p.endsWith("Product.tsx"));
  for (const page of productFirst) {
    const tsx = read(page);
    const next = tsx.slice(tsx.indexOf("<NextLinks"));
    assert.ok(next.indexOf('label: "Open the product"') < next.indexOf('label: "Read the files"') || !next.includes('label: "Read the files"'), `${page} offers the product before the files`);
  }
});

test("the end-of-page doors are quiet links, and a thumb gets 44 px of each", () => {
  const css = read("ui/next.css").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(css, /\.next-link \{[^}]*background: none; border: 0;[^}]*color: var\(--accent-2\)/, "drawn as links, not as another row of buttons");
  assert.match(css, /@media \(max-width: 620px\)[\s\S]*\.next-link \{ min-height: 44px; \}/, "the phone floor, on the component's own class");
  assert.match(css, /\.next-links \{ display: flex; flex-wrap: wrap;/, "one row that wraps rather than scrolls sideways");
});
