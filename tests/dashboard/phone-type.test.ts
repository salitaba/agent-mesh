/**
 * Capital captions were the smallest type on a phone. Measured at 360 px: Overview had 12 elements at 11 px (five Stat labels
 * and seven avatar initials) and Projects had nine (four Stat labels and five project-card `dt`s). The initials are glyphs in
 * a 22 px disc; the captions are words. They move to 12, the ramp's next step, on a coarse pointer or a narrow window.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const styles = fs.readFileSync(path.join(SRC, "styles.css"), "utf8");
const projects = fs.readFileSync(path.join(SRC, "projects.css"), "utf8");
const topology = fs.readFileSync(path.join(SRC, "designer", "topology.css"), "utf8");
const steps = fs.readFileSync(path.join(SRC, "views", "steps.css"), "utf8");

/** Every media block whose condition names a phone or a coarse pointer, joined. */
function phoneBlocks(css: string): string {
  const out: string[] = [];
  for (const m of css.matchAll(/@media[^{]+\{/g)) {
    if (!/pointer:\s*coarse|max-width:\s*(?:620|760)px/.test(m[0])) continue;
    const start = m.index! + m[0].length;
    let depth = 1;
    let i = start;
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
    }
    out.push(css.slice(start, i - 1));
  }
  assert.ok(out.length, "phone media blocks exist");
  return out.join("\n");
}

test("Stat and other capital captions are 12 px on a phone, not 11", () => {
  assert.match(phoneBlocks(styles), /:is\(\.stat-k, \.kpi small, \.caps\) \{ font-size: 12px; \}/, "the shared caption step is 12");
});

test("the sidebar's and the palette's capital captions are 12 px on a phone", () => {
  // The shared caption rule above missed these two: the sidebar's group names and the palette's group and scope labels stayed
  // 11 px. They are words a phone reads, not the glyph marks the avatar initials are.
  assert.match(phoneBlocks(styles), /:is\(\.nav-label, \.palette-group, \.palette-scope\) \{ font-size: 12px; \}/, "the frame's captions take the same step");
});

test("a project card's dt captions are 12 px on a phone", () => {
  assert.match(phoneBlocks(projects), /\.pj-facts dt \{ font-size: 12px; \}/, "the project caption step is 12");
});

test("the goal id under the wordmark is a word at 12 px, like every other caption on a phone", () => {
  // Measured at 360: the `.sub` span was 11 px and 247 px wide, the last off-ladder word on the page (the 22 px avatar initials
  // and the 18 px key chips are glyphs and stay). A name set at 11 px is a caption that got smaller than the caption floor.
  assert.match(phoneBlocks(styles), /\.brand \.sub \{ font-size: 12px; \}/, "the goal id takes the phone's 12 px caption step");
});

test("a drawer's tab count is a figure at 12 px, not an 11 px glyph", () => {
  // Measured at 360 on the agent and graph drawers: the count beside "Now" was 11 px, a mixed-case-free figure rather than
  // the capital micro-label or glyph the 11 px step belongs to. The same 22 x 19 badge at 1,440. 12 is the ramp's next step.
  const tabn = /\.tab-n \{([^}]*)\}/.exec(styles);
  assert.ok(tabn, "the tab count's rule is read");
  assert.match(tabn![1]!, /font:\s*600 12px/, "the count is 12 px");
});

test("a status word and a clock tick are 12 px, not 11: the designer's seat flags and the timeline's axis", () => {
  // Measured on the delivered demo: the Designer's seat list drew "Starts" and "Service" at 11 px (mixed case, a chip a person
  // reads), and the Steps timeline's clock ticks ("23:39:30") were 11 px figures at 768 and 1,440. The 11 px step belongs to a
  // capital micro-label and to a glyph mark (the avatar initials), not to a word or a time. Both take the 12 px step.
  const flag = /\.ms-flag \{([^}]*)\}/.exec(topology);
  assert.ok(flag, "the seat flag's rule is read");
  assert.match(flag![1]!, /font:\s*600 12px/, "a seat flag is 12 px");
  const tick = /\.st-tick \{([^}]*)\}/.exec(steps);
  assert.ok(tick, "the timeline tick's rule is read");
  assert.match(tick![1]!, /font:\s*12px/, "a clock tick is 12 px");
});
