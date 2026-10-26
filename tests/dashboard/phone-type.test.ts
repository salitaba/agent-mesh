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
