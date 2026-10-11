import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "fs";
import * as path from "path";

/**
 * The installer carries the dashboard: `scripts/stage-pages.mjs` copies the control plane's pages into
 * `apps/desktop/ui/app` on the way into every build, and `src/serve.rs` serves them from the app's own origin.
 * Neither half can be checked by compiling, and the seam between them is where a bundle goes wrong quietly —
 * a page that is in the control plane's directory and not in the app, a page that is in the app and has no
 * route in the server's table, a page list written down by hand that stops matching the directory. What is
 * checked here is that seam: the script is run for real, against the real pages, and its output is compared
 * with the routes the server will actually answer.
 */

const ROOT = path.resolve(__dirname, "..", "..", "..");
const APP = path.join(ROOT, "apps", "desktop");
const SOURCE = path.join(ROOT, "apps", "cloud-server", "pages");
const TARGET = path.join(APP, "ui", "app");
const SCRIPT = path.join(APP, "scripts", "stage-pages.mjs");
const SERVE = path.join(APP, "src-tauri", "src", "serve.rs");

const read = (file: string) => fs.readFileSync(file, "utf8");
const htmlFiles = (dir: string) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
    .map((entry) => entry.name)
    .sort();

test("staging the dashboard copies the whole pages directory, not a list of it", () => {
  const output = execFileSync(process.execPath, [SCRIPT], { cwd: APP, encoding: "utf8" });

  const source = htmlFiles(SOURCE);
  const staged = htmlFiles(TARGET);
  assert.ok(source.length >= 10, "the pages directory is the dashboard's whole customer-facing surface");
  assert.deepEqual(staged, source, "every page the control plane serves has to be in the app, and nothing else");

  for (const asset of ["assets/app.js", "assets/app.css", "assets/favicon.svg"]) {
    assert.ok(
      fs.existsSync(path.join(TARGET, asset)),
      `${asset} is what a page loads, so an installer without it carries a page that does not work`,
    );
  }

  const manifest = JSON.parse(read(path.join(TARGET, "bundle.json"))) as {
    pages: string[];
    source: string | null;
    stagedAt: string;
  };
  assert.deepEqual(manifest.pages, source, "bundle.json names what was staged, so one installer can be told from another");
  assert.ok(
    manifest.source === null || /^[0-9a-f]{40}$/.test(manifest.source),
    "the commit the bundle came from, or null when there is no git to ask",
  );
  assert.ok(!Number.isNaN(Date.parse(manifest.stagedAt)), "and the moment it was staged, as a time");
  assert.match(output, new RegExp(`${source.length} pages`), "the build log says what it staged, and how much");
});

test("the script discovers the pages rather than naming them", () => {
  // The trap this exists for: a hand-written list of pages in the build step is a list that goes stale the
  // first time the control plane grows a page, and it goes stale silently — the app keeps working, minus one
  // address, discovered by whoever presses the link. The files a session cannot start without are the only
  // page names this script may contain.
  const script = read(SCRIPT);
  const named = new Set(script.match(/[\w-]+\.html/g) ?? []);
  assert.deepEqual(
    [...named].sort(),
    ["account.html", "index.html", "login.html"],
    "only the files a session cannot start without may be named in the build step; everything else is read from the directory",
  );
  assert.match(script, /cpSync\(SOURCE, TARGET, \{ recursive: true \}\)/, "the copy is the directory, not an enumeration of it");
  assert.match(script, /readdirSync\(TARGET/, "and the manifest is read back from what was copied rather than written down");
  assert.match(script, /refuse\(/, "an incomplete bundle ends the build; a sign-in form that does nothing is found by a customer");
});

test("every staged page has a route in the server that serves it", () => {
  const serve = read(SERVE);
  const start = serve.indexOf("fn page_file");
  const end = serve.indexOf("fn asset_file");
  assert.ok(start > 0 && end > start, "src/serve.rs has no page table to compare with the bundle");
  const routes = new Map<string, string>();
  for (const match of serve.slice(start, end).matchAll(/"([^"]*)" => Some\("([^"]+)"\)/g)) {
    routes.set(match[1]!, match[2]!);
  }

  assert.equal(routes.get(""), "index.html", "the app opens on the dashboard's front page");
  for (const page of htmlFiles(TARGET)) {
    if (page === "index.html" || page === "404.html") continue; // the route above, and what a miss is answered with
    const address = `/${page.replace(/\.html$/, "")}`;
    assert.equal(
      routes.get(address),
      page,
      `the bundle carries ${page} and the server has no route for ${address}: that link 404s inside the app`,
    );
  }
  assert.ok(!routes.has("/404"), "404 is not an address the dashboard links to; it is what a miss is answered with");
  assert.match(serve, /fn not_found/, "a miss shows the dashboard's own 404 page");
  assert.match(serve, /fn escapes/, "and no path is ever joined onto a directory: this table decides what may be read");
});
