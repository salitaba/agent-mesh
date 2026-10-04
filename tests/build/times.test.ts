/**
 * Every time of day the console prints is local, and comes from one formatter.
 *
 * The Events console, the event pane, the step inspector and the drawers used to print the UTC slice of an ISO string with no
 * label, while the Overview printed local time, so one event showed two different times depending on where you looked. Local
 * time is `localTime` in format.ts (`hhmmss` is its old name); the zone is said once above a run of them (`zoneLabel`,
 * `ZoneNote`). This guards the three ways the old behaviour comes back: slicing the clock out of an ISO string, reading UTC
 * fields, and a second formatter next to the shared one.
 *
 * The Designer is not covered: it has its own work package and prints one local time in a banner.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "designer" ? [] : walk(full);
    return /\.(ts|tsx)$/.test(e.name) ? [full] : [];
  });
}

const files = walk(SRC).map((f) => ({ name: path.relative(SRC, f), text: fs.readFileSync(f, "utf8") }));

/** Source with comments removed, so a sentence that explains the old behaviour is not mistaken for it. */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

test("nobody slices the clock out of an ISO string, which is UTC under no label", () => {
  const bad = files.filter((f) => /\.(slice|substring|substr)\(\s*11\b/.test(code(f.text))).map((f) => f.name);
  assert.deepEqual(bad, []);
});

test("nobody reads UTC fields to print a time", () => {
  const bad = files.filter((f) => /\bgetUTC(Hours|Minutes|Seconds)\b/.test(code(f.text))).map((f) => f.name);
  assert.deepEqual(bad, []);
});

test("a time of day is formatted by format.ts and nowhere else", () => {
  const bad = files.filter((f) => f.name !== "format.ts" && /\.toLocaleTimeString\(/.test(code(f.text))).map((f) => f.name);
  assert.deepEqual(bad, [], "use localTime (and say the zone once with zoneLabel or ZoneNote)");
});

test("the shared formatter is local, 24-hour and zoned from one place", () => {
  const format = fs.readFileSync(path.join(SRC, "format.ts"), "utf8");
  assert.match(code(format), /export const hhmmss = localTime;/, "hhmmss stays an alias, so the old call sites are local too");
  assert.match(code(format), /hour12: false/);
});
