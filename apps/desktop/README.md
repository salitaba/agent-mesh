# The Curule desktop shell

A Tauri 2 app whose window shows the hosted app at `app.curule.dev`. It is the shell and only the shell:
the window loads the deployed dashboard over the network, so a change to the dashboard reaches the desktop
the moment it is deployed, and there is nothing here to rebuild when it changes.

```
apps/desktop/
  icon.png              the 1024px master every installer icon is rendered from
  package.json          the app's own scripts, and the Tauri CLI as a devDependency
  ui/                   the page the window opens on, bundled into the app
    index.html          brand mark, the address, a Retry, a link to the browser
    fallback.js         asks whether the app answers, then goes there
  src-tauri/
    Cargo.toml          the crate: curule-desktop, edition 2021
    tauri.conf.json     the window, the CSP, and what an installer carries
    capabilities/       what the bundled page may ask the app for, per platform: the baseline, nothing else
    icons/              rendered from icon.png; the .icns and .ico are not hand-made
    src/main.rs         a shim over the library
    src/lib.rs          the address, the window, the navigation policy, the tray (desktop), the Android app
```

## Running it

The crate needs a Rust toolchain and the platform's webview libraries, and it has never been compiled on the
machine it was written on — see "What has not been verified" below. On a machine that has them:

```bash
npm install                  # at the repository root: the app is a workspace, and this links it
cd apps/desktop
npm run dev                  # tauri dev: compiles the crate and opens the window
```

`npm run build` bundles an installer for the platform it runs on. On Linux that needs root — `libwebkit2gtk-4.1-dev`,
`libayatana-appindicator3-dev`, `librsvg2-dev`, `patchelf` — which is why the installers people download are built
by CI (`.github/workflows/desktop.yml`) and not on a laptop. The Android app is CI's for a different reason: it needs
a JDK, the Android SDK and the NDK, none of which are installed here either — `tauri android init` and
`tauri android build` are never run on a laptop in this repository, only in `.github/workflows/mobile.yml`.

`npm run icon -- icon.png` re-renders `src-tauri/icons/` from the master.

## Which address the window opens

`app.curule.dev`, unless `CURULE_DESKTOP_URL` says otherwise — a self-hosted control plane, or a local run:

```bash
CURULE_DESKTOP_URL=http://127.0.0.1:7500 npm run dev
```

A value that is not an http(s) address is a value somebody mistyped: the shell starts on the hosted app rather
than refusing to start, and the value is never handed to a webview. Whatever the address is, it is the only
origin the window will show itself; everything else opens in the system browser, `target="_blank"` links included.

The window is the only window: a second launch focuses the one that is there, and the tray offers Show, Reload
and Quit. Reload reloads what is showing — the app, or the bundled page, which connects again. The window's size
and position are remembered (they live in the app data directory for `dev.curule.desktop`).

## Releasing

Push a tag `desktop-v<version>` matching the `version` in `src-tauri/tauri.conf.json` — the workflow refuses a tag
that disagrees, because tauri-action would otherwise cut a second tag of its own. The four bundles are built
(AppImage and deb, two dmgs, NSIS and msi) and attached to a **draft** release: an installer nobody has run is not
published, it is handed over. Runs from a branch, a pull request or the Actions button build the same bundles and
leave them as workflow artifacts, with no release anywhere.

The installers are **unsigned**. macOS will say the app is damaged and Windows will show a SmartScreen warning
until the secrets named at the bottom of the workflow exist (`APPLE_*`, `WINDOWS_*`, `AZURE_*` for Trusted Signing,
`TAURI_SIGNING_*` for updates). No step in the workflow signs anything, so a build cannot claim to be signed.

## Android

The same crate builds the Android app, and it is the same shell: the same window loading the same page, the same
address, the same rule that anything which is not the app's own origin opens in the system browser. What a phone has
no use for is behind `#[cfg(desktop)]` in `src/lib.rs` — the tray, the remembered window size and position, and
noticing a second launch, which the generated manifest's `android:launchMode="singleTask"` does for itself. There is
also no tray menu to fall back on, so nothing on Android depends on one.

**The APK comes from CI.** `.github/workflows/mobile.yml` is the only place it is built: JDK 25 (temurin), the
Android SDK with platform 37, NDK r29 (the version Tauri's CLI pins), and the four Rust targets. It generates the
Gradle project (`tauri android init --ci`), renders the launcher icons onto it from `icon.png`, builds with
`tauri android build --apk --ci`, and uploads the APK as that run's artifact. No tag, no release: a run's artifact is
how an APK reaches a person. The generated project under `src-tauri/gen/android` is **not committed** — it cannot be
generated on a machine without Rust and an Android SDK (`tauri android init` shells out to `cargo metadata` before it
looks at either), so every CI run generates one from the CLI the app's own `devDependency` pins. iOS is out of scope
for this pass; the workflow says what it would need rather than half-wiring it.

**Sideloading one.** Download the `curule-android-apk` artifact from the run, unzip it, get
`app-universal-release-unsigned.apk` onto the device (`adb install`, a USB cable, or the device's own file manager),
and allow installing from that source when Android asks. Android 7.0 (API 24) or newer.

**What an unsigned APK is, and is not.** It installs and runs — the signature is not what makes it work. What it
cannot do is update over an install that Play signed: the signatures differ, so Android refuses the new APK and asks
for an uninstall first, which takes the app's data with it. And nothing about it identifies a publisher: anybody can
rebuild this APK under a different key, and Android will treat the two as unrelated apps. The workflow's closing note
says the same thing where the build is configured.

**What signing would need.** A keystore and an upload key, kept as repository secrets, and written into a
`signingConfigs` block in the generated project's `app/build.gradle.kts` — since that project is generated per run,
that means a step between init and build which decodes the keystore and patches the file. For Play, additionally a
Play Console developer account (a one-time $25 registration). Play takes an app bundle, and refuses an unsigned one,
which is why this workflow builds APKs only.

**Why a store would look twice.** The app is a window onto a deployed site: the binary carries a page whose whole job
is to connect to `app.curule.dev`. Google Play's policies expect an app to do something of its own, and Apple's
guideline 4.2 — the same objection, for the iOS pass that is not written yet — is one line long. What answers it is
either native value the shell provides itself or the dashboard's own bundle shipped inside the app; the second is the
phase-2 item below, and it is also what makes the app open with no network at all. That is a decision to take before
a store submission, not after one.

## How the window reaches the app

The window opens on `ui/index.html`, which is inside the app: it holds the address the shell hands it, asks
whether the app answers, and navigates there. If it does not answer, the page stays — with the address, a Retry
that asks again, and a link that opens the app in the system browser.

The shell cannot ask that question itself. Tauri and wry report a load that started and a load that finished, and
nothing at all about a load that failed — on any of the three platforms — so a webview that cannot reach the
address shows an error page of its own and says nothing to the Rust beside it. What keeps a failed connection from
stranding somebody is the page that is still there to ask, which is why the address is handed to the bundled page
rather than navigated to from `setup`.

Two consequences worth knowing:

- The CSP in `tauri.conf.json` is injected into the bundled page, which is the only page it applies to: Tauri does
  not inject it into a page served over https. The app brings its own headers.
- The window shows the app's **origin** and the bundled page, nothing else. A sign-in flow that leaves the origin
  — an OAuth provider, or a `curule.dev` host that is not `app.curule.dev` — opens in the system browser rather
  than in the window, and comes back to the window through the browser. Widening that is a change to `is_ours` in
  `src/lib.rs`, and it should be a decision, not a default.

## What has not been verified

- **The crate has never been compiled.** Rust is not installed on the machine this was written on, and installing
  it was out of scope. No `tauri build` and no `tauri dev` has run. The first compile is CI's, and the first
  compile error will be read there.
- **Nothing has run on a phone either.** No Rust, no JDK, no Android SDK and no NDK on the machine this was written
  on, so `tauri android init` never ran here (it stops at `cargo metadata`, before it looks at any SDK), no Android
  project was ever generated, and no APK exists. The Android compile and the first APK are `.github/workflows/mobile.yml`'s
  to produce, and that run is also the first test of the assumption the mobile path rests on: that a window built by
  Rust from `tauri.conf.json` on a phone is the same window Tauri builds for a config-declared one.
- **No installer exists.** Every icon format, every bundle format and the workflow's own steps were written from
  the Tauri 2 documentation and the action's published inputs, not from a build.
- What *was* checked: `tauri.conf.json` validates against the published Tauri 2 config schema; every API the Rust
  calls was read from the docs for the versions `Cargo.toml` pins; the icon set was rendered by the Tauri CLI
  itself from `icon.png`; and `tests/desktop/desktop-shell.test.ts` and `tests/desktop/mobile-android.test.ts` pin
  the wiring between the files — the window the Rust builds, the icons the bundle lists, the two capability grants
  and the platforms each is scoped to, the workflow's four targets on each side, and the JDK, SDK and NDK the
  Android build needs.

## Phase 2: the dashboard inside the installer

Not implemented here, on purpose. The window loads the deployed app today; bundling the dashboard's built assets
into the app instead is a second pass, and the seams for it are already in place:

1. `build.frontendDist` (`../ui`) becomes the built dashboard, and a `beforeBuildCommand` builds it.
2. The address the window opens becomes the bundled page — `DEFAULT_APP_URL` in `src/lib.rs` and the default in
   `ui/fallback.js` — with the hosted app kept as the fallback rather than the destination.

What that buys: an app that opens with no network at all, a version of the dashboard that cannot change under the
user, and no dependency on a deploy being up. What it costs: an installer release for every dashboard change, and
a second place the SPA is built. It is a configuration change and a decision about which one is the default, not
a rewrite — which is why this pass wrote the address down in one place on each side.
