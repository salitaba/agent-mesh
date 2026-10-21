/**
 * The path from "open the console" to "I am using my product", as the pages state it.
 *
 * A delivered mission's loudest action used to be "Open the files": the file list is where the team's work is audited, not
 * where it is used, and the person who had just delivered a product was sent to read its source. The product is now the
 * first thing the hero offers, the first card on Product, and the first door at the end of every page that has an end.
 * The Overview also measured 8,395 px tall on a phone, with nothing at the top saying what was below it.
 *
 * Read as text: the browser that measured the pages is not part of the suite.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const read = (file: string): string => fs.readFileSync(path.join(SRC, file), "utf8");

test("a delivered mission's first action is the product, and the files follow quietly", () => {
  const mission = read("mission.ts");
  const delivered = mission.slice(mission.indexOf("const DELIVERED_NEXT"), mission.indexOf("];", mission.indexOf("const DELIVERED_NEXT")));
  assert.match(delivered, /\{ action: "product", label: "Open the product",[^}]*look: "primary" \}/, "the product is the loud one");
  assert.ok(delivered.indexOf('action: "product"') < delivered.indexOf('action: "files"'), "it comes before the files");
  assert.match(delivered, /\{ action: "files",[^}]*look: "quiet" \}/, "reading the files is what you do about a result, not the first thing");
  assert.match(read("views/Overview.tsx"), /case "product": return setView\("product"\)/, "the hero's action lands on the product page");
  assert.match(read("views/MissionHero.tsx"), /product: "product"/, "and it has a mark of its own");
});

test("Product opens on the product itself, before the checkout's branch and the script runner", () => {
  const product = read("views/Product.tsx");
  assert.ok(product.indexOf("<YourProduct") > 0, "the card is on the page");
  assert.ok(product.indexOf("<YourProduct") < product.indexOf("prod-facts-card"), "the product is the first card");
  assert.ok(product.indexOf("<YourProduct") < product.indexOf("prod-run"), "and before the scripts");
});
