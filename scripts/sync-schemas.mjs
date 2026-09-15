/**
 * Regenerate `schemas/*.schema.json` from the compiled protocol schemas.
 *
 * The protocol is published twice: `schemas/` is the documented,
 * vendor-independent contract, and `packages/protocol/src/schemas.ts` is what
 * actually validates at runtime. `tests/protocol/protocol.test.ts` asserts the
 * two are identical, so every edit to schemas.ts must be mirrored here.
 *
 * Run after a build:  npm run schemas:sync
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compiledEntry = path.join(root, "dist/packages/protocol/src/index.js");

if (!fs.existsSync(compiledEntry)) {
  console.error(`missing ${path.relative(root, compiledEntry)} — run \`npm run build\` first.`);
  process.exit(1);
}

const { SCHEMAS } = require(compiledEntry);
let changed = 0;

for (const [name, schema] of Object.entries(SCHEMAS)) {
  const target = path.join(root, "schemas", `${name}.schema.json`);
  const next = `${JSON.stringify(schema, null, 2)}\n`;
  const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
  if (current === next) continue;
  fs.writeFileSync(target, next);
  console.log(`updated schemas/${name}.schema.json`);
  changed += 1;
}

console.log(changed === 0 ? "schemas already in sync" : `${changed} schema file(s) regenerated`);
