/**
 * The documents a customer reads must not send them to a page that is not there.
 *
 * Checked for every public document: each relative link resolves to a file, each `#anchor` names a heading in the
 * file it points at, and each `tests/...` path cited as evidence exists. Business-internal papers are not in the
 * repository and no public document may link to one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..", "..", "..");

function publicDocs(): string[] {
  const docs = ["README.md", "CHANGELOG.md", "SECURITY.md", "THIRD_PARTY_NOTICES.md", "PRODUCT.md", "packages/README.md", "site/README.md", "docs/operations.md"];
  const commercial = path.join(ROOT, "docs", "commercial");
  if (fs.existsSync(commercial)) for (const f of fs.readdirSync(commercial)) if (f.endsWith(".md")) docs.push(`docs/commercial/${f}`);
  return docs.filter((d) => fs.existsSync(path.join(ROOT, d)));
}

/** GitHub's heading anchors: lower-case, punctuation dropped, spaces to hyphens. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
}

function anchorsOf(file: string): Set<string> {
  const out = new Set<string>();
  const seen = new Map<string, number>();
  let fenced = false;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = slug(m[1]!);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

test("every relative link in the public documents resolves, and every anchor names a heading", () => {
  const problems: string[] = [];
  for (const doc of publicDocs()) {
    const text = fs.readFileSync(path.join(ROOT, doc), "utf8").replace(/```[\s\S]*?```/g, "");
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const href = m[1]!;
      if (/^(https?:|mailto:)/.test(href)) continue;
      const [rel, anchor] = href.split("#");
      const target = rel ? path.normalize(path.join(ROOT, path.dirname(doc), rel)) : path.join(ROOT, doc);
      if (!fs.existsSync(target)) {
        problems.push(`${doc}: ${href} does not exist`);
        continue;
      }
      if (anchor && target.endsWith(".md") && !anchorsOf(target).has(anchor)) problems.push(`${doc}: ${href}: no heading '#${anchor}' in ${path.relative(ROOT, target)}`);
    }
  }
  assert.deepEqual(problems, []);
});

test("every test cited as evidence in the public documents exists", () => {
  const missing: string[] = [];
  for (const doc of publicDocs()) {
    for (const m of fs.readFileSync(path.join(ROOT, doc), "utf8").matchAll(/`(tests\/[A-Za-z0-9_./-]+\.test\.ts)`/g)) {
      if (!fs.existsSync(path.join(ROOT, m[1]!))) missing.push(`${doc}: ${m[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("no public document links to, or names, a business-internal paper", () => {
  const offences: string[] = [];
  for (const doc of publicDocs()) {
    const text = fs.readFileSync(path.join(ROOT, doc), "utf8");
    for (const word of ["business/", "owner-actions", "sales-kit", "pricing-rationale", "eula-draft", "licence-options"]) {
      if (text.includes(word)) offences.push(`${doc} mentions '${word}'`);
    }
  }
  assert.deepEqual(offences, [], "those papers are not in the repository: it is public");
});

test("the headings used as anchors by the checker agree with GitHub's rules on the awkward ones", () => {
  assert.equal(slug("Many tenants: a fleet"), "many-tenants-a-fleet");
  assert.equal(slug("`mesh usage` and costs (Team)"), "mesh-usage-and-costs-team");
  assert.equal(slug("Back up and restore"), "back-up-and-restore");
});
