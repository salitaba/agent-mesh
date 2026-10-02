/**
 * The source is under the Business Source License 1.1, and what that licence lets anyone run for free is what the
 * Community plan allows.
 *
 * A licence key is JavaScript on the customer's machine and a limit only warns by default, so the legal text is what
 * makes a plan's limits binding (docs/commercial/licensing.md). Three things would quietly undo that, and each is
 * pinned here:
 *
 *  - The stock terms edited. The licence's own covenant says "Not to modify this License in any other way", so the
 *    terms are held to a hash of the text SPDX publishes for BUSL-1.1.
 *  - The free grant drifting from the plan table. A number that appears in two places is a number that will differ
 *    (plans.ts), so the grant's numbers are read back out of the licence and compared with `PLANS.community.limits`.
 *    Changing what the free plan allows is a change to the licence, and this test is where that is noticed.
 *  - The licence not travelling with the product. It must be displayed on every copy, so package.json, the lockfile,
 *    the image and the image's labels all have to say it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { PLANS } from "../../packages/licensing/src/index";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), "utf8");
const licence = read("LICENSE");

/** SHA-256 of "Terms" through the last covenant, as published for BUSL-1.1 (spdx/license-list-data, text/BUSL-1.1.txt). */
const BSL_1_1_TERMS_SHA256 = "20092e66cdf7c39bfe30c359bed5556b0e58a61cf29e648413751a2dd4ef2293";
const SPDX_ID = "BUSL-1.1";

const NAMES = ["Licensor", "Licensed Work", "Additional Use Grant", "Change Date", "Change License"] as const;

/** The parameters block as {name: value}, continuation lines joined with single spaces. */
function parameters(): Record<string, string> {
  const block = /\nParameters\n([\s\S]*?)\nFor information about alternative licensing/.exec(licence)?.[1];
  assert.ok(block, "the licence has a Parameters block");
  const out: Record<string, string> = {};
  let current = "";
  for (const line of block.split("\n")) {
    const label = /^([A-Z][A-Za-z ]+):\s+(.*)$/.exec(line);
    if (label) {
      current = label[1]!;
      out[current] = label[2]!;
    } else if (current && line.trim()) {
      out[current] += ` ${line.trim()}`;
    }
  }
  return out;
}

test("the terms are the stock Business Source License 1.1, unmodified", () => {
  const terms = licence.slice(licence.indexOf("\nTerms\n") + 1).trimEnd();
  assert.ok(terms.startsWith("Terms\n"), "the licence has its Terms");
  assert.ok(terms.endsWith("4. Not to modify this License in any other way."), "and ends at the last covenant");
  assert.equal(
    createHash("sha256").update(terms, "utf8").digest("hex"),
    BSL_1_1_TERMS_SHA256,
    "the terms differ from the published text; covenant 4 says not to modify them. Edit the Parameters, not the Terms.",
  );
  assert.match(licence, /^License text copyright © 2017 MariaDB Corporation Ab, All Rights Reserved\.\n"Business Source License" is a trademark of MariaDB Corporation Ab\./, "the header the licence asks to be kept");
  assert.match(licence, /\nNotice\n\nBusiness Source License 1\.1\n\nTerms\n/);
});

test("every parameter is filled in, and the change licence is one the stock covenant allows", () => {
  const p = parameters();
  for (const name of NAMES) assert.ok(p[name] && p[name] !== "None", `${name} is set`);
  assert.deepEqual(Object.keys(p).sort(), [...NAMES].sort(), "no parameter is missing or invented");
  assert.ok(!/[<>]|\bTODO\b|\bFIXME\b|\bTBD\b|\bXXX\b/.test(licence.slice(0, licence.indexOf("\nTerms\n"))), "no placeholder is left in the parameters");
  assert.ok(p["Licensed Work"]!.includes(`© 2026 ${p["Licensor"]}`), "the work is credited to the licensor");
  // Covenant 1: the change licence must be GPL-2.0-or-later compatible. These are the ones this project would pick.
  assert.match(p["Change License"]!, /^(Apache License, Version 2\.0|MIT License|GNU General Public License.*)$/);
  assert.match(p["Change Date"]!, /^(Four years from the date the Licensed Work is published\.|\d{4}-\d{2}-\d{2})$/, "a rule or a date, within the four years the licence allows");
});

test("what the licence lets anyone run for free is the Community plan's limits", () => {
  const grant = parameters()["Additional Use Grant"]!;
  const { maxProjects, maxSeatsPerMesh, maxConcurrentTurns } = PLANS.community.limits;
  const number = (re: RegExp): number => Number(re.exec(grant)?.[1]);
  assert.equal(number(/no more than (\d+) projects? open at a time/), maxProjects, "open projects");
  assert.equal(number(/no more than (\d+) agents \(seats\) in any one mesh/), maxSeatsPerMesh, "seats per mesh");
  assert.equal(number(/no more than (\d+) agent turns running at once/), maxConcurrentTurns, "concurrent turns");
  // The two conditions the plans rely on: the licence key cannot be taken out, and the software cannot be resold as a service.
  assert.match(grant, /do not move, change, disable, or circumvent the license key functionality/);
  assert.match(grant, /do not remove or obscure any functionality in the Licensed Work that is protected by the license key/);
  assert.match(grant, /do not provide the Licensed Work to third parties as a hosted or managed service/);
  assert.match(grant, /embed it in a product or service you provide to third parties/);
});

test("the licence travels: package.json, the lockfile, the image and its labels all say it", () => {
  assert.equal(JSON.parse(read("package.json")).license, SPDX_ID);
  assert.equal(JSON.parse(read("package-lock.json")).packages[""].license, SPDX_ID, "the lockfile's root entry follows package.json");
  const dockerfile = read("Dockerfile");
  assert.match(dockerfile, /^COPY tsconfig\.json .*\bLICENSE\b/m, "the build stage takes LICENSE in");
  assert.match(dockerfile, /^COPY --from=build \/src\/LICENSE \.\/LICENSE$/m, "and the image the customer runs carries it");
  assert.match(read(".github/workflows/release.yml"), new RegExp(`org\\.opencontainers\\.image\\.licenses=${SPDX_ID.replace(".", "\\.")}`), "the published image is labelled with it");
});
