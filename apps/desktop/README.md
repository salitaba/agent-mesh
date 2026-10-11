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
than refusing to start, and the value is never handed to a webview.

`CURULE_DESKTOP_MODE` decides what the window opens on: `bundled` serves the dashboard out of the installer,
`hosted` opens `CURULE_DESKTOP_URL` and is 0.2.0's behaviour unchanged. Unset means bundled on the desktop and
hosted on Android; *The dashboard inside the installer* below says why, and what falls back when it cannot be
bundled.

## What the window shows itself, and what leaves for the browser

One product has several names, and the shell has to know they are one thing:

- the app's own origin — `app.curule.dev`, or whatever `CURULE_DESKTOP_URL` names;
- the bundled dashboard's own origin — `curule://localhost`, or `http://curule.localhost` where Tauri maps the
  scheme onto a loopback name — in either spelling, on whichever platform gave it that spelling;
- **any sibling under the same registrable domain** — the workspace consoles are served from
  `<workspace>.ws.curule.dev`, and they are the point of the app. Until this rule existed, signing in and pressing a
  workspace handed the console to Chrome, because the host was not the app's;
- the bundled page in `ui/`, which is the shell's own surface;
- anything `CURULE_DESKTOP_HOSTS` names, comma- or space-separated, as a host (`console.example.com`) or a domain that
  includes its subdomains (`.example.com`). It exists for deployments the sibling rule cannot guess: a control plane
  whose workspaces live on an unrelated host, or a domain under a two-label public suffix like `example.co.uk`, where
  "the last two labels" is not the registrable domain.

Everything else is somebody else's page and opens in the system browser — a payment provider's checkout above all.
A `target="_blank"` **to one of ours** opens a second window inside the app (titled with the host it shows); a
`target="_blank"` to anybody else goes to the browser. The webview is never allowed to stack a window of its own.

The window is the only window besides those: a second launch focuses the one that is there, and the tray offers Show,
Reload and Quit. Reload reloads what is showing — the app, or the bundled page, which connects again. The window's
size and position are remembered (they live in the app data directory for `dev.curule.desktop`).

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
- The window shows the app's own domain family and the bundled page (see *What the window shows itself*). A sign-in
  flow that leaves it — an OAuth provider, a payment provider — opens in the system browser and comes back to the
  window through the browser.
- **The workspace console shares this window's cookie jar.** `<workspace>.ws.curule.dev` runs the customer's own
  agent team's dashboard, and a page from there is now loaded inside the app that also holds the session cookie for
  `app.curule.dev` — the same trade the hosted service already makes by serving workspaces from a subdomain of the
  app's registrable domain (`workspaces.allow_same_site`). A deployment that wants them apart names the app and not
  the workspace domain in `CURULE_DESKTOP_HOSTS`… and loses the console to the browser, which is exactly the bug this
  fixed. Serve the workspaces from a domain of their own if that matters more.

## What has not been verified

- **Nothing has run.** The crate compiles — CI builds it for Linux, both macOS targets, Windows and Android, and
  every release from 0.1.0 on came out of that — but no window has ever been opened: no `tauri dev`, no installer
  launched, no APK installed on a phone by whoever wrote this. Nothing here has been seen working.
- **The bundled session has never been exercised.** A webview on this machine does not exist, so `serve.rs` has
  never served a page or proxied a call: that the pages come out right, that the `__Host-` cookie survives the
  proxy, that `Sec-Fetch-Site` is what the guard expects on each platform — all of it is reasoning and CI's
  compile, not a run. This is why hosted is the Android default and why the three fallbacks exist.
- **No code-signing, and no auto-update.** macOS will call an unsigned installer "damaged" and Windows will warn;
  a new version is a new download.
- What *was* checked: `tauri.conf.json` validates against the published Tauri 2 config schema; every API the Rust
  calls was read from the docs for the versions `Cargo.toml` pins (`register_asynchronous_uri_scheme_protocol`,
  `UriSchemeResponder::respond` and `WebviewUrl::CustomProtocol` from the `tauri` source at the tag being pinned);
  the icon set was rendered by the Tauri CLI itself from `icon.png`; and the three test files pin the wiring
  between the files — the window the Rust builds, the icons the bundle lists, the capability grants and the
  platforms each is scoped to, the workflow's four targets on each side, the JDK, SDK and NDK the Android build
  needs, the staged bundle against the server's route table, and the navigation policy that keeps a workspace
  console inside the app.

## The dashboard inside the installer

The window opens on the dashboard the installer carries. `scripts/stage-pages.mjs` — the `beforeBuildCommand` —
copies the control plane's own pages (`apps/cloud-server/pages`) into `ui/app`, and `src/serve.rs` serves them from
an origin this shell owns. Nothing about the session leaves the machine that is not an API call.

The bundle is a snapshot: `ui/app/bundle.json` names the commit it was staged from, so an installer's dashboard is
the dashboard it was built with, and a deploy of the hosted app does not change it. Shipping a page change is then
two steps — change the pages, cut an installer.

### Why the bundle is served, and not just loaded

It cannot be served from `tauri://`, from a file path, or from the hosted origin:

- the pages call root-absolute `/api/...` paths with `credentials: "same-origin"`;
- the session cookie is `__Host-`-prefixed — host-only, `Path=/`, `Secure` — so a page on any other origin can
  neither read it nor send it;
- the control plane refuses a state-changing request whose `Origin` is not its own address.

So the pages are served from `curule://localhost` (`http://curule.localhost` on Windows and Android, which is the
spelling Tauri maps a custom scheme onto) and `/api/...` is proxied to `CURULE_DESKTOP_URL` from there: the same
method, path, query and body; the headers the control plane reads; `Origin` set to the control plane's own address
for anything that changes state; `Set-Cookie` handed back untouched, the `__Host-` session cookie among them; and a
`Location` pointing at the control plane rewritten to the same path inside the app, so a redirect cannot bounce the
window into a browser.

The proxy refuses a request that did not come from the app's own page (`Origin`, and `Sec-Fetch-Site: cross-site`),
serves nothing out of the bundle that its own table does not name, and never joins a caller's path onto a directory.

### The two modes, and what falls back

`CURULE_DESKTOP_MODE=bundled|hosted`. Unset means **bundled on the desktop**, **hosted on Android** — and the
Android default is not a preference. The platform reaches the scheme's origin through `shouldInterceptRequest`,
which is handed a request with **no body**: a GET survives that, a sign-in POST does not. A phone that opens the
deployed app is a phone that works; `CURULE_DESKTOP_MODE=bundled` asks for the bundle anyway, once the platform
can carry a body.

Three things fall the window back to 0.1.1's behaviour rather than leaving it blank, and each says why on stderr
and in the tray tooltip: the bundle is not staged, the control plane does not answer, or the local server cannot
bind.

### What it costs

- An installer release per dashboard change, and the app's copy of a page is the deploy it was built from.
- One address table in two places: `page_file` in `src/serve.rs` names the routes these pages are served at.
  `tests/desktop/staged-pages.test.ts` runs the staging step against the real pages and fails, naming the page,
  when that table and the bundle disagree.
