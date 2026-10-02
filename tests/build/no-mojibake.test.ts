/**
 * Text that was read in one encoding and written in another is what a user sees first when it is wrong: the progress
 * bar of `curule status` printed three characters where it meant one, the bench table's rule did the same, and the
 * instruction handed to a delegated worker carried a garbled dash. All of it was UTF-8 that had been decoded as
 * Windows-1252 and saved again ("mojibake"): `—` (U+2014) became U+00E2 U+20AC U+201D, `█` (U+2588) became
 * U+00E2 U+2013 U+02C6, and so on, one lead character and two or three that look like punctuation.
 *
 * Every text file in the repository is scanned for that shape. Nothing in it is meant to carry one: a document that
 * has to talk about the fault names the code points (U+00E2 U+20AC U+201D) and does not paste the characters.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..", "..", "..");

/** What a UTF-8 continuation byte (0x80 to 0xBF) becomes when it is read as Windows-1252, or as Latin-1. */
const CONTINUATION = "[\\u0080-\\u00bf\\u0152\\u0153\\u0160\\u0161\\u0178\\u017d\\u017e\\u0192\\u02c6\\u02dc\\u2013\\u2014\\u2018-\\u201e\\u2020-\\u2022\\u2026\\u2030\\u2039\\u203a\\u20ac\\u2122]";

/**
 * A lead byte of a two, three or four byte sequence (0xC2 to 0xF4, read as Latin-1) followed by that many continuation
 * bytes. The last byte of a three-byte sequence is sometimes lost (Windows-1252 leaves 0x8F undefined and the control
 * character survives or not), so a three-byte lead with one continuation is a hit too.
 */
const SHAPE = `[\\u00c2-\\u00df]${CONTINUATION}|[\\u00e0-\\u00ef]${CONTINUATION}{1,2}|[\\u00f0-\\u00f4]${CONTINUATION}{1,3}`;
/** For `test` and `assert.match`: a global regular expression remembers where it stopped, so these two are separate. */
const MOJIBAKE = new RegExp(SHAPE);
const MOJIBAKE_EVERYWHERE = new RegExp(SHAPE, "g");

const SKIP_DIRS = new Set(["node_modules", "dist", "dist-dev", ".git", "business", ".mesh-state", ".mesh-backups", "workspace"]);
const TEXT = /\.(md|ts|tsx|mjs|cjs|js|json|yml|yaml|sh|html|css|txt|tpl|svg|toml|env|example)$|^(LICENSE|Dockerfile|\.dockerignore|\.gitignore)$/;

function* files(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".mesh")) yield* files(rel);
    } else if (TEXT.test(entry.name)) {
      yield rel;
    }
  }
}

/** What the text was meant to say, when the damage can be undone (it cannot when a byte was lost). */
function repaired(garbled: string): string | null {
  const bytes: number[] = [];
  for (const ch of garbled) {
    const code = ch.codePointAt(0)!;
    const cp1252 = CP1252_EXTRAS.get(code);
    if (cp1252 !== undefined) bytes.push(cp1252);
    else if (code <= 0xff) bytes.push(code);
    else return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
}

/** Windows-1252's renderings of 0x80 to 0x9F, the part that differs from Latin-1. */
const CP1252_EXTRAS = new Map<number, number>([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88],
  [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93],
  [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97], [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b],
  [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
]);

const codePoints = (s: string): string => [...s].map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`).join(" ");

test("no text file in the repository holds UTF-8 that was decoded as Windows-1252 and saved again", () => {
  const found: string[] = [];
  for (const rel of files("")) {
    const lines = fs.readFileSync(path.join(ROOT, rel), "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const m of line.matchAll(MOJIBAKE_EVERYWHERE)) {
        const fix = repaired(m[0]);
        found.push(`${rel}:${i + 1}  ${codePoints(m[0])}  ${fix === null ? "(a byte was lost; the original has to be read from the context)" : `was meant to be ${codePoints(fix)}`}`);
      }
    });
  }
  assert.deepEqual(found, [], `garbled text (write the character that was meant, or name the code points in prose):\n${found.join("\n")}`);
});

test("the scan reads the places the damage was in, so an empty result is not an empty walk", () => {
  const seen = new Set(files(""));
  for (const must of ["apps/mesh-cli/src/index.ts", "apps/mesh-cli/src/bench.ts", "packages/core/src/supervisor.ts", "tests/integration/mission.test.ts", "README.md", "docs/runtime.md", "site/index.html", "LICENSE"]) {
    assert.ok(seen.has(must), `${must} is scanned`);
  }
  assert.ok(seen.size > 500, `${seen.size} files scanned`);
});

test("the detector sees every form this repository once had, and none of the characters those forms were meant to be", () => {
  const meant = ["█", "░", "●", "○", "─", "—", "§", "Δ"]; // █ ░ ● ○ ─ — § Δ
  for (const ch of meant) {
    const bytes = Buffer.from(ch, "utf8");
    // What an editor that thinks the file is Windows-1252 writes back: each byte as the character it would show.
    const garbled = [...bytes].map((b) => String.fromCodePoint([...CP1252_EXTRAS].find(([, v]) => v === b)?.[0] ?? b)).join("");
    assert.notEqual(garbled, ch);
    assert.match(garbled, MOJIBAKE, `${codePoints(ch)} damaged as ${codePoints(garbled)} is not seen`);
    assert.equal(repaired(garbled), ch, `${codePoints(garbled)} is repaired to ${codePoints(ch)}`);
    assert.doesNotMatch(ch, MOJIBAKE, `${codePoints(ch)} is itself fine`);
  }
  // The form in which the last byte was lost (0x8F, undefined in Windows-1252, kept as a control character or dropped).
  assert.match(String.fromCharCode(0xe2, 0x2014, 0x8f), MOJIBAKE, "the three-byte form with its undefined byte kept");
  assert.match(String.fromCharCode(0xe2, 0x2014), MOJIBAKE, "the three-byte form with its last byte dropped");
  assert.equal(repaired(String.fromCharCode(0xe2, 0x2014)), null, "which cannot be repaired from the text alone");
  // Text that merely contains accents, symbols and other scripts is not damaged text.
  for (const fine of ["NÃO", "café", "naïve", "©", "→", "✓", "é", "×", "½", "Ünal", "ß", "日本語", "فارسی", "…", "“quoted”", "Ωmega", "²"]) {
    assert.doesNotMatch(fine, MOJIBAKE, `${fine} is fine`);
  }
});
