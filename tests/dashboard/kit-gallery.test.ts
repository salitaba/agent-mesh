/**
 * The kit gallery (apps/mesh-dashboard/kit.html, kit.tsx) draws every primitive of components.tsx in every state. It is the page a
 * person restyling a view photographs, so it must not fall behind: a primitive exported from components.tsx that the gallery does not
 * draw fails here, and so does a state the gallery draws with a class the stylesheet has no rule for (a picture of a rule that is not
 * there). The files are read as text: they are .tsx, which the node test build does not compile.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const APP = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard");
const read = (rel: string): string => fs.readFileSync(path.join(APP, rel), "utf8");

const components = read("src/components.tsx");
const gallery = read("src/kit.tsx");
const styles = read("src/styles.css");

/**
 * What components.tsx exports as a component: `export function Name(` and `export { A, B } from "./ui/..."`, a name in PascalCase.
 * (A hook, a helper and a constant are not primitives: they do not start with a capital followed by lower case.)
 */
function primitives(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/^export function ([A-Za-z0-9_]+)\(/gm)) names.add(m[1]!);
  for (const m of source.matchAll(/^export \{([^}]+)\} from "[^"]+";/gm)) for (const n of m[1]!.split(",")) names.add(n.trim());
  return [...names].filter((n) => /^[A-Z][a-z]/.test(n)).sort();
}

test("the list of primitives is read from the source, and is not empty", () => {
  const list = primitives(components);
  assert.ok(list.length >= 30, `found ${list.length} primitives`);
  for (const must of ["Button", "IconButton", "Menu", "Tabs", "Banner", "EmptyState", "ConfirmDialog", "Tooltip", "Kbd", "Switch", "Progress", "Sparkline", "Ring", "Skeleton"]) {
    assert.ok(list.includes(must), `${must} is among them`);
  }
});

test("the gallery draws every primitive of components.tsx", () => {
  const missing = primitives(components).filter((name) => !new RegExp(`<${name}[\\s/>]`).test(gallery));
  assert.deepEqual(missing, [], "primitives the gallery does not draw: add them to kit.tsx, in every state they have");
});

test("every state the gallery forces has a rule in the stylesheet", () => {
  const forced = new Set([...gallery.matchAll(/\bis-(hover|active|focus)\b/g)].map((m) => m[0]));
  assert.ok(forced.size >= 3, "the gallery forces hover, pressed and focus");
  for (const cls of forced) assert.ok(styles.includes(`.${cls}`), `styles.css has a rule for .${cls}`);
});

test("the gallery is its own page: it is built as a second entry and loads nothing of the console's state", () => {
  const config = read("vite.config.mts");
  assert.match(config, /kit: resolve\(root, "kit\.html"\)/, "kit.html is a build entry");
  assert.match(read("kit.html"), /src="\/src\/kit\.tsx"/);
  // The page shows no data: nothing in it may reach for the store, the router or the host's API.
  const runtimeImports = gallery.replace(/^import type .*$/gm, "");
  assert.doesNotMatch(runtimeImports, /from "\.\/(store|shell|drawers|auth|projects|api)"/, "the gallery imports no module that needs a mission or a host");
});
