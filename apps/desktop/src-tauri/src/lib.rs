//! The Curule shell: the hosted app in a window of its own, on the desktop and on
//! Android.
//!
//! The window opens on the page bundled from `ui/`, which is the shell's own
//! surface: it knows the address to connect to, it connects, and it is where a
//! connection that fails leaves the user — with a Retry. Everything else the
//! window needs is policy: which addresses it may show itself, and what a second
//! launch, the tray and a `target="_blank"` link do.
//!
//! One crate builds both apps, and what a phone has no use for is behind
//! `#[cfg(desktop)]`: the tray, the remembered window geometry, and noticing a
//! second launch — Android's `launchMode="singleTask"` resumes the activity that
//! is there instead. The address, the window and the navigation policy are shared,
//! because Tauri 2 supports all three on both.
//!
//! `README.md` (one directory up) says why the bundled page connects rather than
//! the shell navigating to the app URL from here, and what is left unverified.

use tauri::{webview::NewWindowResponse, App, AppHandle, Manager, Url, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

// The tray and its menu are desktop-only: `tauri::menu` is `#[cfg(desktop)]` in the
// tauri crate, and `tauri::tray` is behind `all(desktop, feature = "tray-icon")`.
// Importing either on a mobile target does not compile.
#[cfg(desktop)]
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
};

/// Where the window connects when nothing says otherwise.
const DEFAULT_APP_URL: &str = "https://app.curule.dev";
/// The address to connect to instead: a self-hosted control plane, or a local run.
const APP_URL_ENV: &str = "CURULE_DESKTOP_URL";
/// The window `tauri.conf.json` declares (with `create: false`, so this module can
/// build it with the handlers a config-declared window cannot carry).
///
/// Desktop-only because only the tray and a second launch address a window by
/// label; on mobile the activity owns the one window there is.
#[cfg(desktop)]
const WINDOW_LABEL: &str = "main";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // `single-instance` and `window-state` are desktop crates: both declare
    // `#![cfg(not(any(target_os = "android", target_os = "ios")))]`, so on a mobile
    // target their items do not exist and registering them there would not compile.
    // Nothing is lost on Android: the generated manifest gives the activity
    // `android:launchMode="singleTask"`, so a second launch resumes the activity
    // that is there, and a phone — not the app — decides a window's geometry.
    #[cfg(desktop)]
    let builder = builder
        // Registered first: a second launch has to be noticed before the rest of
        // setup runs, and before it can open a window of its own.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| focus_window(app)))
        .plugin(tauri_plugin_window_state::Builder::default().build());

    builder
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let address = app_url();
            // The same call on both platforms, and deliberately no `#[cfg(mobile)]`
            // branch: Tauri builds a config-declared window (`create: true`) from
            // this same config entry, at this same point in startup, on every
            // platform — this module only builds it by hand because a
            // config-declared window cannot carry the handlers below.
            open_window(app, &address)?;
            #[cfg(desktop)]
            tray(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Curule");
}

/// The address the window connects to: `CURULE_DESKTOP_URL` when it is an http(s)
/// address, and the hosted app when it is anything else. A value that is not an
/// address is a value somebody mistyped: it is not worth refusing to start over,
/// and it must never be handed to a webview to load.
fn app_url() -> Url {
    std::env::var(APP_URL_ENV)
        .ok()
        .and_then(|raw| Url::parse(raw.trim().trim_end_matches('/')).ok())
        .filter(|url| matches!(url.scheme(), "http" | "https") && url.has_host())
        .unwrap_or_else(|| Url::parse(DEFAULT_APP_URL).expect("the default app URL is an address"))
}

/// Whether the window may show this address itself: the app's own origin, or the
/// bundled page. Anything else is somebody else's page and belongs to a browser.
fn is_ours(url: &Url, app_url: &Url) -> bool {
    let bundled = url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost");
    bundled
        || (url.scheme() == app_url.scheme()
            && url.host_str() == app_url.host_str()
            && url.port_or_known_default() == app_url.port_or_known_default())
}

/// Builds the window from its `tauri.conf.json` declaration — the size, the title
/// and the minimums live there — and adds what only Rust can: the address handed
/// to the bundled page, and the two navigation handlers.
///
/// The size and the title are desktop manners; on Android the activity and
/// `strings.xml` own them and the config's are ignored. What is not ignored is
/// `url`: the webview is built from this entry on both platforms.
///
/// `on_new_window` is documented as unsupported on Android and iOS, so on a phone
/// the navigation handler below is the whole of the external-link behaviour —
/// which is the one that matters, since it is what keeps somebody else's page out
/// of the app.
fn open_window(app: &mut App, address: &Url) -> Result<(), Box<dyn std::error::Error>> {
    let config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or("tauri.conf.json declares no window to open")?;
    let for_navigation = app.handle().clone();
    let for_new_window = app.handle().clone();
    let target = address.clone();

    WebviewWindowBuilder::from_config(app.handle(), &config)?
        .initialization_script(&address_script(address)?)
        .on_navigation(move |url| {
            if is_ours(url, &target) {
                return true;
            }
            open_in_browser(&for_navigation, url);
            false
        })
        .on_new_window(move |url, _features| {
            // `target="_blank"` is a page asking for somewhere else: the system
            // browser, never a second window stacked on the app.
            open_in_browser(&for_new_window, &url);
            NewWindowResponse::Deny
        })
        .build()?;
    Ok(())
}

/// Hands the bundled page the address to connect to. It runs on every page in this
/// webview, so it sets the value only where it is meant to be read: a page served
/// from the app is the app's own, and has no business seeing the shell's.
fn address_script(address: &Url) -> Result<String, serde_json::Error> {
    let value = serde_json::to_string(address.as_str())?;
    Ok(format!(
        "if (location.protocol === 'tauri:' || location.hostname === 'tauri.localhost') {{ window.__CURULE_APP_URL__ = {value}; }}"
    ))
}

/// Sends an address the window will not show to the system browser. There is
/// nothing to fall back to if the desktop has no browser to open it with: the
/// window stays on the page it is showing, which is the app.
fn open_in_browser(app: &AppHandle, url: &Url) {
    let _ = app.opener().open_url(url.as_str(), None::<&str>);
}

/// Brings the window back: a second launch, or the tray's Show. Desktop-only, like
/// both of its callers.
#[cfg(desktop)]
fn focus_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Reloads whatever the window is showing: the app, or the bundled page, which
/// connects again. Always reloading the app URL would strand whoever lost their
/// connection on the webview's own error page. The tray's Reload is the only
/// caller, so this is desktop-only with it.
#[cfg(desktop)]
fn reload_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.eval("window.location.reload()");
    }
}

/// The tray icon. A window can end up behind everything else, and a desktop app
/// that cannot be brought back is a desktop app that has to be killed. There is no
/// tray on Android or iOS, which is why nothing here is compiled for them.
#[cfg(desktop)]
fn tray(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    let show = MenuItemBuilder::with_id("show", "Show Curule").build(app)?;
    let reload = MenuItemBuilder::with_id("reload", "Reload").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
    let menu = MenuBuilder::new(app).items(&[&show, &reload, &quit]).build()?;

    let mut tray = TrayIconBuilder::with_id("curule")
        .menu(&menu)
        // Linux shows the menu on a click and reports no click event of its own.
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => focus_window(app),
            "reload" => reload_window(app),
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.handle().default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}
