import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml } from "yaml";

/**
 * `apps/desktop` is a Tauri crate nobody on this machine can compile: the window, the capability file, the
 * icons and the workflow are all read by tools that are not installed here, and the first thing that compiles
 * the Rust is CI. So the files are checked for the things a compiler would not catch anyway — that the config
 * names the window the Rust builds, that every icon the bundle lists is on disk, that the capability file
 * grants the baseline and nothing with a wildcard in it, that the workflow builds all four bundles and signs
 * none of them, and that nothing in the app carries a remote IPC grant or a credential. A rename in one file
 * that the other file still refers to is exactly the failure that would otherwise be found by a person
 * downloading a broken installer.
 */

const ROOT = path.resolve(__dirname, "..", "..", "..");
const APP = path.join(ROOT, "apps", "desktop");
const SRC_TAURI = path.join(APP, "src-tauri");

const read = (file: string) => fs.readFileSync(file, "utf8");
const readJson = <T>(file: string): T => JSON.parse(read(file)) as T;

interface Config {
  productName: string;
  version: string;
  identifier: string;
  build: { devUrl?: string; frontendDist?: string; beforeDevCommand?: string; beforeBuildCommand?: string };
  app: {
    windows: Array<{ label: string; title: string; width: number; height: number; minWidth: number; minHeight: number; url: string; create: boolean }>;
    security: { csp: string };
  };
  bundle: {
    active: boolean;
    targets: string;
    icon: string[];
    category: string;
    shortDescription: string;
    longDescription: string;
  };
}
const config = readJson<Config>(path.join(SRC_TAURI, "tauri.conf.json"));
const workflowSource = read(path.join(ROOT, ".github", "workflows", "desktop.yml"));

test("the config names the app, and the window the Rust builds from it", () => {
  assert.equal(config.productName, "Curule");
  assert.equal(config.identifier, "dev.curule.desktop");
  assert.match(config.version, /^\d+\.\d+\.\d+$/, "a real version: the release tag has to match it");

  const windows = config.app.windows;
  assert.equal(windows.length, 1, "one window, and src/lib.rs builds it");
  const main = windows[0]!;
  assert.equal(main.label, "main", "the label the capability file and the Rust both name");
  assert.equal(main.title, "Curule");
  assert.equal(main.url, "app/index.html", "the window opens on the dashboard the installer carries; src/lib.rs decides whether to build it at all");
  assert.equal(main.create, false, "a window Rust builds cannot also be created by the config, or there are two");
  assert.ok(main.width >= main.minWidth && main.height >= main.minHeight, "a minimum larger than the size it opens at");
  assert.deepEqual([main.width, main.height, main.minWidth, main.minHeight], [1280, 860, 900, 600]);
});

test("the installer carries the dashboard, and the shell's own page is what it falls back to", () => {
  assert.equal(config.build.devUrl, "https://app.curule.dev", "the address the shell connects to when nothing overrides it");
  assert.equal(config.build.frontendDist, "../ui");
  const ui = path.resolve(SRC_TAURI, config.build.frontendDist!);
  assert.ok(fs.existsSync(path.join(ui, "index.html")), "frontendDist has to be a directory with the page in it");
  assert.ok(fs.existsSync(path.join(ui, "fallback.js")), "the page's whole behaviour is one file beside it");

  // The staged dashboard is the destination now, and it is built on the way into a bundle rather than committed:
  // `ui/app` is generated, so a build that skips the staging step would embed nothing and open on an empty window.
  assert.equal(
    config.build.beforeBuildCommand,
    "node scripts/stage-pages.mjs",
    "the dashboard has to be staged on the way into every build, or the installer carries an empty window",
  );
  assert.ok(fs.existsSync(path.join(APP, "scripts", "stage-pages.mjs")), "the command above has to exist");
  assert.equal(config.build.beforeDevCommand, undefined, "nothing is staged on the way into dev: dev opens the deployed app");
});

test("the shell's own page stays a working fallback, because bundled mode is not the only mode", () => {
  // Nothing about hosted mode changes in 0.2.0: the same one file is still what `CURULE_DESKTOP_MODE=hosted` opens,
  // and it is what a window falls back to when the bundle is missing or the control plane cannot be reached.
  const html = read(path.join(APP, "ui", "index.html"));
  assert.match(html, /CURULE_DESKTOP_URL|app\.curule\.dev/, "the fallback page names the address it connects to");
  assert.match(read(path.join(APP, "ui", "fallback.js")), /fetch\(/, "it asks the control plane whether it answers");
});

test("the CSP forbids what the shell has no use for, and eval above all", () => {
  const csp = config.app.security.csp;
  assert.ok(csp.length > 0, "no CSP is a CSP that allows everything");
  assert.ok(!/unsafe-eval/.test(csp), "the page runs one file of its own; nothing needs to build code at runtime");
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'self'/);
  assert.match(csp, /frame-ancestors 'none'/, "nothing frames the app");
  assert.ok(!/unsafe-inline[^;]*script-src|script-src[^;]*unsafe-inline/.test(csp), "no inline script: the page loads fallback.js");
});

test("every icon the bundle lists is on disk, and the master they are rendered from is too", () => {
  assert.equal(config.bundle.active, true);
  assert.equal(config.bundle.targets, "all", "each platform's own formats; the workflow narrows it per runner");
  assert.ok(config.bundle.icon.length >= 5);
  for (const icon of config.bundle.icon) {
    assert.ok(fs.existsSync(path.resolve(SRC_TAURI, icon)), `${icon} is listed in bundle.icon and missing from src-tauri`);
  }
  for (const format of [".icns", ".ico"]) {
    assert.ok(config.bundle.icon.some((icon) => icon.endsWith(format)), `${format}: macOS and Windows installers need their own format`);
  }

  const master = path.join(APP, "icon.png");
  assert.ok(fs.existsSync(master), "CI renders the set from the master, so it has to be committed, not only rendered");
  const png = fs.readFileSync(master);
  assert.equal(png.readUInt32BE(16), 1024, "the master is the largest size any of the formats holds");
  assert.equal(png.readUInt32BE(20), 1024, "and it is square");
  assert.equal(config.bundle.category, "DeveloperTool");
  assert.ok(config.bundle.shortDescription.length > 0 && config.bundle.longDescription.length > config.bundle.shortDescription.length);
});

test("the capability file grants the baseline, to the one window, with no wildcard and no remote", () => {
  const dir = path.join(SRC_TAURI, "capabilities");
  const files = fs.readdirSync(dir).filter((file) => file.endsWith(".json"));
  assert.ok(files.length > 0, "a Tauri 2 app with no capability file has no window it can do anything in");
  for (const file of files) {
    const capability = readJson<{ identifier: string; description: string; windows: string[]; remote?: unknown; permissions: string[] }>(path.join(dir, file));
    assert.ok(capability.identifier.length > 0, `${file}: a capability needs an identifier`);
    assert.ok(capability.description.length > 0, `${file}: say what it is for`);
    assert.deepEqual(capability.windows, ["main"], `${file}: the one window, by the label the config uses`);
    assert.equal(capability.remote, undefined, `${file}: a remote address here would hand the app's IPC to a page served over the network`);
    assert.ok(capability.permissions.length > 0);
    for (const permission of capability.permissions) {
      assert.ok(!permission.includes("*"), `${file}: ${permission} — a wildcard is a grant nobody read`);
      assert.ok(!/^(shell|fs|process|http):/.test(permission), `${file}: ${permission} — the page asks the app for nothing, so it is granted nothing`);
    }
    assert.ok(capability.permissions.includes("core:default"), `${file}: the baseline the window's own page needs`);
  }
});

test("the Rust the crate compiles is the shell: one window, the three plugins, a tray", () => {
  const manifest = read(path.join(SRC_TAURI, "Cargo.toml"));
  assert.match(manifest, /^name = "curule-desktop"$/m);
  assert.match(manifest, /^edition = "2021"$/m);
  assert.match(manifest, /^name = "curule_desktop_lib"$/m, "main.rs calls the library by this name");
  assert.match(manifest, /^rust-version = "1\.\d+"$/m, "CI installs stable; the crate says which stable it needs");
  assert.match(manifest, /tauri = \{ version = "2", features = \["tray-icon"\] \}/, "the tray is a feature, not a plugin");
  for (const plugin of ["tauri-plugin-opener", "tauri-plugin-single-instance", "tauri-plugin-window-state"]) {
    assert.match(manifest, new RegExp(`^${plugin} = "2"$`, "m"), `${plugin} is registered in lib.rs and has to be a dependency`);
  }

  const main = read(path.join(SRC_TAURI, "src", "main.rs"));
  assert.match(main, /curule_desktop_lib::run\(\)/, "the binary is a shim over the library");
  assert.match(main, /windows_subsystem = "windows"/, "no console window behind the app on Windows");

  const lib = read(path.join(SRC_TAURI, "src", "lib.rs"));
  assert.match(lib, /CURULE_DESKTOP_URL/, "the address override the README documents");
  assert.match(lib, /"https:\/\/app\.curule\.dev"/, "and the address it overrides");
  assert.match(lib, /std::env::var/, "read from the environment, not from a file beside the app");
  assert.match(lib, /unwrap_or_else/, "a value that is not an address falls back rather than refusing to start");
  assert.ok(!/dangerous_remote_domain_ipc_access|dangerousRemoteDomainIpcAccess/.test(lib), "the window shows the app's origin and nothing else");
  for (const plugin of ["single_instance", "window_state", "opener"]) {
    assert.match(lib, new RegExp(`tauri_plugin_${plugin}::`), `${plugin} is a dependency and has to be registered`);
  }
  // The navigation policy, including the bug that took the console out of the app: a
  // workspace is served from `<workspace>.ws.curule.dev`, a different host from the
  // app's, and while `is_ours` compared the whole host the account page's
  // `location.assign(workspace url)` handed the console to the system browser. One
  // product, several names: the shell has to know its own domain family.
  assert.match(lib, /fn is_ours/, "the window decides for itself what it may show");
  assert.match(lib, /fn registrable/, "`app.curule.dev` and `<workspace>.ws.curule.dev` are one product to it");
  assert.match(lib, /registrable\(host\) == registrable\(app_host\)/, "so a sibling is ours, not the browser's");
  assert.match(lib, /CURULE_DESKTOP_HOSTS|EXTRA_HOSTS_ENV/, "and a deployment the guess does not fit can name its hosts");
  assert.match(lib, /fn open_child_window/, "a page of ours that asks for a window gets one, inside the app");
  assert.match(lib, /on_new_window/, "the webview is still never allowed to stack a window of its own");
  assert.match(lib, /open_in_browser/, "and somebody else's page — a checkout — still leaves for the system browser");
  assert.match(lib, /on_navigation/, "every navigation is checked, not only the first");
  assert.match(lib, /TrayIconBuilder/, "the window can end up behind everything else");

  // Phase 2: the dashboard is served out of the app. It cannot be served any other way — the page calls
  // root-absolute `/api/...` paths with `credentials: "same-origin"`, the session cookie is `__Host-`
  // (host-only, `Secure`), and the control plane refuses a state-changing request whose `Origin` is not its
  // own. So the bundle is served from an origin this shell owns and the API is proxied from there.
  assert.match(lib, /register_asynchronous_uri_scheme_protocol/, "the bundled page is served by the shell, not read from a path");
  assert.match(lib, /serve::SCHEME/, "under the one scheme src/serve.rs owns");
  assert.match(lib, /serve::place\(/, "the mode is decided once and the window is built from that decision");
  assert.match(lib, /WebviewUrl::CustomProtocol/, "the bundled origin is the URL the handler receives");

  const serve = read(path.join(SRC_TAURI, "src", "serve.rs"));
  assert.match(serve, /MODE_ENV/, "which shell to be is one environment variable");
  assert.match(serve, /Mode::Hosted/, "hosted is 0.1.1, kept as a fallback and as a choice");
  assert.match(serve, /fn default_mode/, "and one of the two is the default");
  assert.match(serve, /fn fall_back/, "a bundle that is missing, a control plane that does not answer, a port that will not bind: all three fall back");
  assert.ok(!/Mode::Bundled\s*=>\s*Mode::Hosted|Mode::Bundled\s*\}\s*else\s*\{\s*Mode::Hosted/.test(serve), "a fallback is not the default: bundled mode is what an unset variable means on the desktop");
  assert.match(serve, /fn refused/, "a request that did not come from the app's own page is refused");
  assert.match(serve, /sec-fetch-site/, "including one that announces it came from another site");
  assert.match(serve, /is_local_origin/, "and one whose Origin is not this shell's own");
  assert.match(serve, /fn escapes/, "a path written to leave the bundle is not a path this server serves");
  assert.match(serve, /request\.set\("origin", &self\.origin\)/, "a state-changing call names the control plane's own origin, which is what it demands");
  assert.match(serve, /all\(&name\)/, "several Set-Cookie headers come back as several: the session cookie is one of them");
  assert.match(serve, /FORWARDED/, "the page's headers go upstream by a list, not by whatever a caller sends");
  assert.match(serve, /fn rewrite_redirects/, "a redirect to the control plane stays inside the app");
  assert.match(serve, /MAX_BODY/, "one request cannot make the app hold more than it should");

  // The crate's version and the config's are one version: the release tag is checked against one of them, and a
  // versionCode is derived from the other.
  assert.match(
    manifest,
    new RegExp(`^version = "${config.version}"$`, "m"),
    "Cargo.toml and tauri.conf.json disagree about the version",
  );
  assert.match(manifest, /^ureq = \{ version = "2", default-features = false, features = \["tls"\] \}$/m, "the proxy's HTTP client, with rustls rather than native-tls");
  assert.ok(!/^\s*(openssl|native-tls)\s*=/m.test(manifest), "no OpenSSL as a dependency: the same crate builds for Android in CI");
});

test("the fallback page offers what a failed connection needs, and names elements that exist", () => {
  const html = read(path.join(APP, "ui", "index.html"));
  const script = read(path.join(APP, "ui", "fallback.js"));

  for (const id of ["status", "retry", "browser", "host", "note-host"]) {
    assert.match(html, new RegExp(`id="${id}"`), `index.html has no #${id} for the script to reach`);
  }
  assert.ok(!/<script(?![^>]*src=)/.test(html), "the page's script is a file, so the CSP needs no inline exception");
  assert.match(html, /<style>/, "and its styles are inline, so the page needs no network at all");
  assert.ok(!/https?:\/\/(?!app\.curule\.dev)/.test(html), "the page fetches nothing from anywhere but the app");

  for (const match of script.matchAll(/getElementById\("([^"]+)"\)/g)) {
    assert.match(html, new RegExp(`id="${match[1]}"`), `fallback.js reaches for #${match[1]}, which index.html does not have`);
  }
  assert.match(script, /__CURULE_APP_URL__/, "the address the shell hands the page");
  assert.match(script, /https:\/\/app\.curule\.dev/, "and the one it uses when nothing handed it any");
  assert.match(script, /location\.replace/, "connecting is a navigation, not a window opened beside it");
  assert.match(script, /"http:"|'http:'/, "the address is validated before it is navigated to");
  assert.ok(!/innerHTML/.test(script), "the address is text, never markup");
});

test("the workflow compiles the crate on all four targets and bundles what each platform installs", () => {
  const workflow = parseYaml(workflowSource) as {
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    concurrency: { group: string; "cancel-in-progress": boolean };
    jobs: Record<string, { "runs-on": string; permissions?: Record<string, string>; strategy: { "fail-fast"?: boolean; matrix: { include: Array<Record<string, string>> } }; steps: Array<{ name?: string; uses?: string; run?: string; if?: string; with?: Record<string, string | boolean> }> }>;
  };
  const job = workflow.jobs["bundle"]!;
  const steps = job.steps;

  const targets = job.strategy.matrix.include;
  assert.deepEqual(
    targets.map((entry) => entry["os"]),
    ["ubuntu-22.04", "macos-14", "macos-14", "windows-latest"],
    "the three platforms; both Mac architectures are built on the arm64 runner, the Intel one by cross-compiling, " +
      "because a macos-13 job waits in the queue long enough for the next push to cancel it",
  );
  for (const entry of targets) {
    assert.match(entry["target"]!, /^(x86_64|aarch64)-/, `${entry["os"]}: every build names its target`);
    assert.ok(entry["bundles"]!.length > 0, `${entry["os"]}: an installer format per platform`);
  }
  assert.deepEqual(targets.map((entry) => entry["bundles"]), ["appimage,deb", "dmg", "dmg", "nsis,msi"]);
  assert.deepEqual(
    targets.map((entry) => entry["target"]),
    ["x86_64-unknown-linux-gnu", "aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-pc-windows-msvc"],
    "an Intel dmg is still built: the target is what changes, not the deliverable",
  );

  const build = steps.find((step) => step.uses?.startsWith("tauri-apps/tauri-action@"));
  assert.ok(build, "tauri-action is what builds and bundles");
  assert.equal(build!.with?.["projectPath"], "apps/desktop", "the app, not the repository root");
  const args = String(build!.with?.["args"] ?? "");
  assert.match(args, /--target \$\{\{ matrix\.target \}\}/);
  assert.match(args, /--bundles \$\{\{ matrix\.bundles \}\}/);
  assert.equal(build!.with?.["releaseDraft"], true, "an installer nobody has run is a draft, not a release");
  // tauri-action has no artifact input — it lists the inputs it accepts and none of
  // them uploads a branch build's bundles (a run that passes one fails outright), so
  // the installers are collected by a step of its own.
  const upload = steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
  assert.ok(upload, "a build from a branch is still an installer somebody can try");
  assert.match(
    String(upload!.with?.["path"] ?? ""),
    /target\/\$\{\{ matrix\.target \}\}\/release\/bundle/,
    "the directory the bundler writes, per target",
  );
  assert.equal(upload!.with?.["if-no-files-found"], "error", "an empty upload is a failed build, not a green one");

  const tagName = String(build!.with?.["tagName"] ?? "");
  assert.match(tagName, /github\.ref_type == 'tag'/, "no release is created off a tag");
  assert.match(tagName, /desktop-v__VERSION__/);
  assert.ok(Object.keys(workflow.on).includes("push"));
  assert.match(JSON.stringify((workflow.on["push"] as { tags: string[] }).tags), /desktop-v\*/, "the tag the release is cut from");

  const setup = steps.findIndex((step) => step.uses?.startsWith("dtolnay/rust-toolchain@"));
  const linux = steps.findIndex((step) => step.run?.includes("libwebkit2gtk-4.1-dev"));
  const install = steps.findIndex((step) => step.run?.trim() === "npm ci");
  const icons = steps.findIndex((step) => step.run?.includes("npm run icon"));
  const buildAt = steps.indexOf(build!);
  assert.ok(setup >= 0 && linux >= 0 && install >= 0 && icons >= 0, "Rust, the Linux libraries, the dependencies and the icon set");
  assert.ok(setup < buildAt && linux < buildAt && install < buildAt && icons < buildAt, "and all of them before the build");
  assert.ok(String(steps[setup]!.with?.["targets"]).includes("matrix.target"), "the toolchain installs the target it will be asked to build");
  assert.equal(steps[linux]!.if, "matrix.os == 'ubuntu-22.04'", "the libraries are for the one runner that needs them");
  assert.ok(steps.some((step) => step.uses?.startsWith("Swatinem/rust-cache@")), "a crate this size is not compiled from scratch every run");

  const versionCheck = steps.find((step) => step.name?.includes("tag must match"));
  assert.ok(versionCheck, "a tag that disagrees with the app's version would cut a second tag");
  assert.equal(versionCheck!.if, "github.ref_type == 'tag'");
  assert.match(versionCheck!.run ?? "", /tauri\.conf\.json/);

  assert.deepEqual(workflow.permissions, { contents: "read" }, "the workflow as a whole reads the repository");
  assert.deepEqual(job.permissions, { contents: "write" }, "and the job that cuts the draft release is the one that can write");
  assert.equal(job.strategy["fail-fast"], false, "one platform's failure is that platform's problem");
});

test("nothing in the app carries a remote IPC grant or a credential", () => {
  const skip = new Set(["target", "node_modules", ".git", "gen"]);
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return skip.has(entry.name) ? [] : walk(full);
      return /\.(ts|tsx|js|mjs|cjs|json|html|css|md|rs|toml|yml|yaml|txt|gitignore|example)$|^\.gitignore$/.test(entry.name) ? [full] : [];
    });

  const files = walk(APP);
  assert.ok(files.length >= 10, `only ${files.length} files found under apps/desktop: the scan is looking in the wrong place`);

  // The old v1 config key handed a remote page the app's own IPC. Tauri 2 has no
  // such key, and a capability's `remote` field is the way it would come back.
  const secrets = [
    /dangerousRemoteDomainIpcAccess/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\b(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,})\b/,
    /(api[_-]?key|secret|password|passwd|token)["']?\s*[:=]\s*["'][A-Za-z0-9_\-+/=]{16,}["']/i,
  ];
  for (const file of files) {
    const body = read(file);
    for (const pattern of secrets) {
      assert.ok(!pattern.test(body), `${path.relative(ROOT, file)} matches ${pattern}: the shell carries no credential and no remote IPC grant`);
    }
  }

  // The workflow's own secret surface: the token GitHub hands every run, and nothing else.
  for (const match of workflowSource.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    assert.equal(match[1], "GITHUB_TOKEN", `the workflow reaches for secrets.${match[1]}, which this repository does not have`);
  }
});
