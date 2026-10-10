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
    capabilities/       what the bundled page may ask the app for: the baseline, and nothing else
    icons/              rendered from icon.png; the .icns and .ico are not hand-made
    src/main.rs         a shim over the library
    src/lib.rs          the address, the window, the navigation policy, the tray
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
by CI (`.github/workflows/desktop.yml`) and not on a laptop.

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
- **No installer exists.** Every icon format, every bundle format and the workflow's own steps were written from
  the Tauri 2 documentation and the action's published inputs, not from a build.
- What *was* checked: `tauri.conf.json` validates against the published Tauri 2 config schema; every API the Rust
  calls was read from the docs for the versions `Cargo.toml` pins; the icon set was rendered by the Tauri CLI
  itself from `icon.png`; and `tests/desktop/desktop-shell.test.ts` pins the wiring between the files — the window
  the Rust builds, the icons the bundle lists, the capability grant, the workflow's four targets.

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
