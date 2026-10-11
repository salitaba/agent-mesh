#!/usr/bin/env node
/**
 * Stages the control plane's pages into the app, so the window can open on the dashboard the installer
 * carries rather than on whatever `app.curule.dev` happens to be serving at the moment.
 *
 * `tauri.conf.json` bundles `../ui` as the app's frontend, and this script writes the pages into
 * `ui/app/` — a directory of its own, beside the shell's own `index.html` and `fallback.js`, which stay
 * where they are because hosted mode still opens on them. It is the `beforeBuildCommand`, so it runs on
 * every `tauri build`, in CI and on a laptop; it is also safe to run by hand, and running it twice
 * stages the same thing (the target is cleared first).
 *
 * Plain Node and no dependencies: it runs before anything is installed, on whatever Node the machine
 * has, and it must never be the reason a build fails for a reason that is not about the bundle.
 *
 * A bundle that cannot log in is not a bundle. The pages a session needs to start — the landing page,
 * sign in, sign up and the account page, with the script and the stylesheet they load — have to be
 * there, or nothing is staged at all and the exit code says which file was missing. The alternative is
 * an installer that carries a dashboard whose sign-in form does nothing, which is discovered by a person
 * who has already downloaded it.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)); // apps/desktop/scripts
const APP = resolve(HERE, ".."); // apps/desktop
const SOURCE = resolve(APP, "..", "cloud-server", "pages");
const TARGET = join(APP, "ui", "app");

/**
 * The files a session cannot start without. Not a list of what to copy — everything in the source
 * directory is copied — only of what has to be there for the copy to be worth making.
 */
const REQUIRED = ["index.html", "login.html", "account.html", "assets/app.js", "assets/app.css"];

/** Says what is wrong and ends the build, rather than staging a bundle that is missing a piece of itself. */
function refuse(message) {
  console.error(`stage-pages: ${message}`);
  process.exit(1);
}

/**
 * The commit the bundle was staged from, or null when there is no git to ask. A bundle staged from a
 * working tree with uncommitted changes still names the commit it was staged near, which is what the
 * file is for: telling two installers apart. A missing git is not a reason to fail a build.
 */
function sourceRevision() {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: APP,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return head === "" ? null : head;
  } catch {
    return null;
  }
}

function main() {
  if (!existsSync(SOURCE)) {
    refuse(`there is no pages directory at ${relative(APP, SOURCE)} — the dashboard cannot be staged from nothing`);
  }

  const missing = REQUIRED.filter((file) => !existsSync(join(SOURCE, file)));
  if (missing.length > 0) {
    refuse(
      `${relative(APP, SOURCE)} is incomplete — missing ${missing.join(", ")}. ` +
        `A bundle that cannot log in is not a bundle, so nothing was staged.`,
    );
  }

  rmSync(TARGET, { recursive: true, force: true });
  mkdirSync(TARGET, { recursive: true });
  cpSync(SOURCE, TARGET, { recursive: true });

  // Every page in the directory that was just copied — read, never listed here, so a page added to the
  // control plane's folder is in the next installer without this file being touched.
  const pages = readdirSync(TARGET, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
    .map((entry) => entry.name)
    .sort();

  const manifest = { pages, source: sourceRevision(), stagedAt: new Date().toISOString() };
  writeFileSync(join(TARGET, "bundle.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  console.log(
    `stage-pages: ${pages.length} pages from ${relative(APP, SOURCE)} to ${relative(APP, TARGET)}` +
      ` (${manifest.source === null ? "no git" : manifest.source.slice(0, 12)})`,
  );
}

main();
