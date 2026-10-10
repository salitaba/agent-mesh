import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml } from "yaml";

/**
 * `apps/desktop` builds for Android now, and nothing on this machine can say whether it does: there is no Rust,
 * no JDK, no Android SDK and no NDK here, so the first Android compile is CI's. What can be read here is the
 * wiring a compiler would not complain about even if it were wrong — that the mobile capability file exists, is
 * scoped to the two mobile platforms and grants the baseline and nothing else; that the crate keeps the desktop
 * crates behind `#[cfg(desktop)]` while the address, the window and the link policy stay shared; that
 * `tauri.conf.json` carries the Android bundle settings and an identifier Android will accept as an application
 * id; that the workflow installs the JDK, the SDK and a pinned NDK, names all four Android targets, builds an APK
 * and pretends to sign nothing; and that nothing in the app carries a keystore, a password or a remote IPC grant.
 * A phone with a blank window and an unsigned APK nobody can update are the failures this catches on paper.
 */

const ROOT = path.resolve(__dirname, "..", "..", "..");
const APP = path.join(ROOT, "apps", "desktop");
const SRC_TAURI = path.join(APP, "src-tauri");

const read = (file: string) => fs.readFileSync(file, "utf8");
const readJson = <T>(file: string): T => JSON.parse(read(file)) as T;

interface Capability {
  $schema: string;
  identifier: string;
  description: string;
  platforms?: string[];
  windows: string[];
  permissions: string[];
  remote?: unknown;
}

interface Config {
  version: string;
  identifier: string;
  bundle: { android?: { minSdkVersion?: number; versionCode?: number } };
}

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  id?: string;
  with?: Record<string, string | number | boolean>;
  env?: Record<string, string>;
}

const capabilityDir = path.join(SRC_TAURI, "capabilities");
const capabilityFiles = fs.readdirSync(capabilityDir).filter((file) => file.endsWith(".json"));
const capabilities = capabilityFiles.map(
  (file) => [file, readJson<Capability>(path.join(capabilityDir, file))] as const,
);
const config = readJson<Config>(path.join(SRC_TAURI, "tauri.conf.json"));
const workflowFile = path.join(ROOT, ".github", "workflows", "mobile.yml");
const workflowSource = read(workflowFile);

/**
 * The top-level items of a Rust source file, each with the attribute lines that introduce it. This only works on
 * the layout `src/lib.rs` is written in — items start at column 0 and the attributes that gate them sit directly
 * above, with no blank line between — which is also the layout a reader checks at a glance.
 */
function items(source: string): Array<{ attrs: string[]; declaration: string; body: string }> {
  const lines = source.split("\n");
  const declarations: number[] = [];
  lines.forEach((line, index) => {
    if (/^(pub )?(fn|const|static|struct|enum|impl|mod)\b/.test(line)) declarations.push(index);
  });

  const attributeStart = (declaration: number) => {
    let first = declaration;
    while (first > 0 && /^#\[/.test(lines[first - 1]!)) first -= 1;
    return first;
  };

  return declarations.map((declaration, n) => {
    const end = n + 1 < declarations.length ? attributeStart(declarations[n + 1]!) : lines.length;
    return {
      attrs: lines.slice(attributeStart(declaration), declaration).map((line) => line.trim()),
      declaration: lines[declaration]!.trim(),
      body: lines.slice(declaration, end).join("\n"),
    };
  });
}

const lib = items(read(path.join(SRC_TAURI, "src", "lib.rs")));
const item = (declaration: string) => {
  const found = lib.find((entry) => entry.declaration.startsWith(declaration));
  assert.ok(found, `src/lib.rs has no ${declaration}: this is looking at the wrong file, or it was renamed`);
  return found!;
};
const desktopOnly = (declaration: string) => item(declaration).attrs.includes("#[cfg(desktop)]");

test("the capability a phone's page is granted is the baseline, on the two mobile platforms, and nothing else", () => {
  const mobile = capabilities.find(([file]) => file === "mobile.json");
  assert.ok(mobile, "a capability file scoped to mobile is what keeps the desktop grant from being the mobile one");

  const capability = mobile![1];
  assert.deepEqual(capability.platforms, ["android", "iOS"], "the two platforms Tauri names, spelled as it spells them");
  assert.deepEqual(capability.windows, ["main"], "the label src/lib.rs builds the window with, on both platforms");
  assert.deepEqual(
    capability.permissions,
    ["core:default"],
    "the whole grant: no filesystem, shell, http or process permission, and no wildcard",
  );
  assert.equal(capability.remote, undefined, "a remote address here would hand the app's IPC to a page served over the network");
  assert.match(capability.$schema, /gen\/schemas\/mobile-schema\.json$/, "the schema tauri-build writes on a mobile build");
  assert.ok(capability.description.length > 0, "say what it is for");
  assert.ok(
    !JSON.stringify(capability).includes("dangerousRemoteDomainIpcAccess"),
    "the v1 key that gave a remote page the app's IPC has no business coming back",
  );

  const desktop = capabilities.find(([file]) => file === "default.json");
  assert.ok(desktop, "the desktop capability is what this one is scoped away from");
  assert.deepEqual(
    desktop![1].platforms,
    ["linux", "macOS", "windows"],
    "the desktop grant is for the desktop platforms: neither file may quietly apply to the other's",
  );

  // Every platform is covered by exactly one capability file: a file that forgot to say which platforms it is
  // for would apply everywhere, and a platform named by none would have a window that can ask for nothing.
  const named = capabilities.flatMap(([, entry]) => entry.platforms ?? []);
  assert.deepEqual(
    [...new Set(named)].sort(),
    ["android", "iOS", "linux", "macOS", "windows"].sort(),
    "the platform names in capabilities/, with no platform covered twice and none left out",
  );
});

test("the desktop crates are behind #[cfg(desktop)] and the shell is not", () => {
  // All three are compiled out on a mobile target — `tauri_plugin_single_instance` and `tauri_plugin_window_state`
  // declare `#![cfg(not(any(target_os = "android", target_os = "ios")))]`, and `tauri::tray` is behind
  // `all(desktop, feature = "tray-icon")` — so an ungated call is a compile error, and gating anything else is a
  // feature quietly taken off the phone.
  for (const declaration of ["fn tray", "fn focus_window", "fn reload_window", "const WINDOW_LABEL"]) {
    assert.ok(desktopOnly(declaration), `${declaration} exists only on the desktop and has to say so`);
  }
  for (const declaration of [
    "const DEFAULT_APP_URL",
    "const APP_URL_ENV",
    "fn app_url",
    "fn is_ours",
    "fn open_window",
    "fn address_script",
    "fn open_in_browser",
  ]) {
    assert.ok(!desktopOnly(declaration), `${declaration} is shared: the address and the window are Android's too`);
  }

  const run = item("pub fn run");
  assert.ok(
    run.attrs.includes("#[cfg_attr(mobile, tauri::mobile_entry_point)]"),
    "on mobile the entry point is called by the platform, and this attribute is what makes run() it",
  );
  assert.ok(!desktopOnly("pub fn run"), "run() is the entry point on all four platforms");

  const registration = run.body.match(/#\[cfg\(desktop\)\]\s*\n\s*let builder = builder([\s\S]*?);\n/);
  assert.ok(registration, "the two desktop plugins are registered in a #[cfg(desktop)] block of their own");
  assert.match(registration![1]!, /tauri_plugin_single_instance::/, "registered first, before the rest of setup runs");
  assert.match(registration![1]!, /tauri_plugin_window_state::/);
  assert.ok(
    !/tauri_plugin_opener::/.test(registration![1]!),
    "opener is supported on Android and iOS (opening a link is an Intent), so it is registered for every platform",
  );
  assert.match(run.body, /#\[cfg\(desktop\)\]\s*\n\s*tray\(app\)\?;/, "the tray is set up on the desktop, and only there");

  // The one branch a reader might expect and that is deliberately absent. Comments are dropped first, because the
  // code says in prose which attribute it does not use.
  const code = (source: string) =>
    source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
  assert.ok(
    !/#\[cfg\(mobile\)\]/.test(code(read(path.join(SRC_TAURI, "src", "lib.rs")))),
    "no mobile branch was needed: the window comes from the same config entry on both",
  );
});

test("tauri.conf.json carries the Android bundle settings, and an identifier Android accepts", () => {
  const android = config.bundle.android;
  assert.ok(android, "without bundle.android the Android build falls back to Tauri's defaults with nothing written down");

  // Android 7.0 (API 24) is the floor Tauri itself supports and the schema's default; the APK's versionCode is
  // what Play and the device compare, and Tauri derives it from `version` as major*1000000 + minor*1000 + patch.
  assert.equal(android!.minSdkVersion, 24, "the minimum API level the APK installs on");
  const [major, minor, patch] = config.version.split(".").map(Number);
  assert.equal(
    android!.versionCode,
    major * 1000000 + minor * 1000 + patch,
    "versionCode has to be the derivation of `version` (the single source of truth the release tag is checked against), or a release would ship a code the store has already seen",
  );

  // The schema sets `additionalProperties: false` on bundle.android: a key Tauri does not know fails the build.
  const accepted = ["minSdkVersion", "versionCode", "autoIncrementVersionCode", "debugApplicationIdSuffix"];
  for (const key of Object.keys(android!)) {
    assert.ok(accepted.includes(key), `bundle.android.${key} is not a key the config schema accepts`);
  }

  // The identifier is the Android application id, and Android is stricter about it than the desktop bundlers:
  // reverse-DNS, at least two segments, each starting with a letter, and no hyphen anywhere.
  assert.equal(config.identifier, "dev.curule.desktop", "the id the app is installed under, on every platform");
  assert.match(
    config.identifier,
    /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/,
    "an application id Android refuses is a build that fails in Gradle rather than here",
  );
  assert.ok(!config.identifier.endsWith(".app"), "the CLI refuses an identifier ending in .app (it collides with the macOS bundle)");
});

test("the workflow builds an APK on the toolchain Android needs, and signs nothing", () => {
  const workflow = parseYaml(workflowSource) as {
    on: Record<string, { paths?: string[]; tags?: string[] }>;
    permissions: Record<string, string>;
    concurrency: { group: string; "cancel-in-progress": boolean };
    jobs: Record<
      string,
      { "runs-on": string; "timeout-minutes": number; permissions?: Record<string, string>; steps: Step[] }
    >;
  };

  assert.deepEqual(Object.keys(workflow.jobs), ["android"], "iOS is out of scope, and a half-wired job would be worse than none");
  const job = workflow.jobs["android"]!;
  const steps = job.steps;
  assert.equal(job["runs-on"], "ubuntu-22.04", "the runner the desktop job uses, so the two builds read alike");
  assert.ok(job["timeout-minutes"] >= 60, "four ABIs of this crate do not compile in the desktop job's budget");
  assert.equal(job.permissions, undefined, "nothing here writes to the repository: the APK is an artifact, not a release");
  assert.deepEqual(workflow.permissions, { contents: "read" });

  const use = (prefix: string) => {
    const step = steps.find((candidate) => candidate.uses?.startsWith(prefix));
    assert.ok(step, `no step uses ${prefix}`);
    return step!;
  };
  const named = (fragment: string) => {
    const step = steps.find((candidate) => candidate.run?.includes(fragment) || candidate.name?.includes(fragment));
    assert.ok(step, `no step runs ${fragment}`);
    return step!;
  };

  // The JDK: the Android Gradle plugin needs one, and Gradle 9.6 (what the project Tauri 2.12 generates pins in
  // its wrapper) refuses anything newer than Java 26 — Tauri's own Android workflow settles on temurin 25.
  const java = use("actions/setup-java@");
  assert.equal(java.with?.["distribution"], "temurin");
  assert.equal(java.with?.["java-version"], 25, "the JDK the generated Gradle project is known to run on");
  assert.equal(java.with?.["cache"], "gradle");

  // The NDK: pinned to a release, because the CLI pins one too (NDK_VERSION = 29.0.13846066, r29, for 2.12), and
  // passed on as NDK_HOME — which is how the CLI finds it, at init and at build.
  const ndk = use("nttld/setup-ndk@");
  assert.equal(ndk.with?.["ndk-version"], "r29", "a pinned NDK, never whatever is newest");
  assert.ok(ndk.id, "the step's id is what the NDK path is read from");
  assert.equal(ndk.with?.["local-cache"], true);
  const withNdk = steps.filter((step) => step.env?.["NDK_HOME"]?.includes("steps.setup-ndk.outputs.ndk-path"));
  assert.ok(withNdk.length >= 2, "the NDK is handed to both the init and the build");

  // The SDK: the runner image has one, but not the platform compileSdk 37 in the generated project points at.
  const sdk = named("sdkmanager");
  assert.match(sdk.run!, /platforms;android-37/, "the platform the generated Gradle project compiles against");
  assert.match(sdk.run!, /--licenses/, "sdkmanager installs nothing until the licences are accepted");

  const rust = use("dtolnay/rust-toolchain@");
  assert.deepEqual(
    String(rust.with?.["targets"] ?? "")
      .split(",")
      .map((target) => target.trim())
      .sort(),
    ["aarch64-linux-android", "armv7-linux-androideabi", "i686-linux-android", "x86_64-linux-android"].sort(),
    "all four Android targets: the APK is universal, with one .so per ABI inside it",
  );
  assert.ok(steps.some((step) => step.uses?.startsWith("Swatinem/rust-cache@")), "a crate this size is not compiled from scratch, four times over, every run");
  assert.ok(
    steps.some((step) => step.run?.trim() === "npm ci"),
    "the dependencies come from the lockfile",
  );

  // The generated project cannot be committed (init shells out to `cargo metadata` before it looks at any SDK),
  // so every run generates it — from the CLI the app's own devDependency pins.
  const init = named("android init");
  assert.match(init.run!, /--ci\b/, "the CLI prompts for values without it, and a runner has nobody to answer");
  assert.match(init.run!, /--skip-targets-install/, "the four targets are installed by the toolchain step above");
  assert.match(init.run!, /npm run tauri --/, "the app's own CLI, the version its package.json pins");

  const icons = named("npm run icon");
  const build = named("android build");
  assert.match(build.run!, /--apk\b/);
  assert.match(build.run!, /--ci\b/);
  assert.ok(
    !/--aab\b/.test(build.run!),
    "an AAB is what Play takes and Play refuses an unsigned one, so building one here would produce a file nobody can use",
  );

  const order = [init, icons, build].map((step) => steps.indexOf(step));
  assert.ok(order[0]! < order[1]! && order[1]! < order[2]!, "the icons are rendered onto the generated project, which exists only after init");
  assert.ok(
    steps.findIndex((step) => step.run?.trim() === "npm ci") < order[0]!,
    "the dependencies come first: `npm run tauri` is the CLI they install",
  );
  assert.ok(
    steps.findIndex((step) => step.run?.includes("sdkmanager")) < order[0]!,
    "the SDK packages come before the CLI looks for them",
  );

  const upload = use("actions/upload-artifact@");
  assert.match(String(upload.with?.["path"] ?? ""), /gen\/android\/.*\.apk$/, "where Gradle writes the APK");
  assert.equal(upload.with?.["if-no-files-found"], "error", "an empty upload is a failed build, not a green one");
  assert.match(String(upload.with?.["name"] ?? ""), /apk/, "and the artifact says what it is");

  // Signing is described and not attempted: no step decodes a keystore, and the repository has no secret to
  // decode — the only name this workflow may reach for is the token GitHub hands every run. Prose in a comment
  // block wraps, so the note is read with its comment lines joined before a phrase is looked for.
  const note = workflowSource
    .split("\n")
    .filter((line) => line.trimStart().startsWith("#"))
    .map((line) => line.trimStart().replace(/^#\s?/, ""))
    .join(" ");
  assert.match(note, /unsigned/i, "the note has to say what the APK is, or a download claims more than it is");
  assert.match(note, /keystore/i, "and what signing would need: a keystore and an upload key");
  assert.match(note, /Play Console/i, "and the Play Console account a store release also needs");
  for (const step of steps) {
    const body = `${step.name ?? ""} ${step.run ?? ""}`;
    assert.ok(
      !/keystore|apksigner|jarsigner|signingConfig/i.test(body),
      `${step.name ?? step.uses}: this workflow signs nothing, so no step may look like it does`,
    );
  }
  for (const match of workflowSource.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    assert.equal(match[1], "GITHUB_TOKEN", `the workflow reaches for secrets.${match[1]}, which this repository does not have`);
  }

  // Where it runs, and what it is for: a run from a branch, a pull request or the Actions button, producing an APK.
  assert.ok(Object.keys(workflow.on).includes("workflow_dispatch"));
  assert.deepEqual(workflow.on["push"]?.paths, ["apps/desktop/**", ".github/workflows/mobile.yml"], "the app, and this workflow");
  assert.deepEqual(workflow.on["pull_request"]?.paths, ["apps/desktop/**", ".github/workflows/mobile.yml"]);
  assert.equal(workflow.on["push"]?.tags, undefined, "no tag cuts a release here: the APK is a workflow artifact");
  assert.equal(workflow.concurrency["cancel-in-progress"], true);
});

test("nothing in the app carries a keystore, a password or a remote IPC grant", () => {
  const skip = new Set(["target", "node_modules", ".git", "gen"]);
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return skip.has(entry.name) ? [] : walk(full);
      return /\.(ts|tsx|js|mjs|cjs|json|html|css|md|rs|toml|yml|yaml|txt|gitignore|example|keystore|jks|pepk)$|^\.gitignore$/.test(
        entry.name,
      )
        ? [full]
        : [];
    });

  const files = walk(APP);
  assert.ok(files.length >= 10, `only ${files.length} files found under apps/desktop: the scan is looking in the wrong place`);

  for (const file of files) {
    const relative = path.relative(ROOT, file);
    assert.ok(
      !/\.(keystore|jks|pepk)$/.test(relative),
      `${relative}: a signing key is never committed — the workflow says what an unsigned APK cannot do`,
    );

    const body = read(file);
    const forbidden = [
      /dangerousRemoteDomainIpcAccess/,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      /(store|key)Password\s*[:=]\s*["'][^"']+["']/i,
      /storeFile\s*[:=]\s*["'][^"']+["']/i,
    ];
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(body), `${relative} matches ${pattern}: the shell carries no credential and no signing key`);
    }
  }

  // The generated Android project is a build product, not source: it is written by the CLI on every run, and the
  // tree has to stay clean when somebody generates one locally.
  assert.match(
    read(path.join(APP, ".gitignore")),
    /^src-tauri\/gen\/android\/$/m,
    "`tauri android init` output is generated per run, so it is ignored rather than committed",
  );
});
