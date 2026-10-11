//! The dashboard inside the app: where its files come from, and the origin they are
//! served from.
//!
//! In `bundled` mode the window opens on `curule://localhost` — or its
//! `http://curule.localhost` spelling, which is what the webview on Windows and
//! Android actually loads and what this module's guard therefore has to accept — and
//! everything it shows comes from here. The pages are the control plane's own:
//! `apps/cloud-server/pages`, staged into `ui/app` by `scripts/stage-pages.mjs` and
//! embedded into the installer as the app's frontend assets, so the window opens with
//! the dashboard already in it and nothing about the session leaves the machine that
//! is not an API call.
//!
//! They cannot be served from `tauri://` or from a file path. The session cookie the
//! control plane sets is `__Host-`-prefixed — host-only, `Path=/`, `Secure` — and the
//! control plane refuses a state-changing request whose `Origin` is not its own. A page
//! on any other origin can sign nobody in. So the bundle is served from an origin the
//! shell owns, and the page's own `/api/...` calls — root-absolute, `credentials:
//! "same-origin"`, written for the control plane's origin — are proxied to the control
//! plane from there, with the `Origin` put back on the way out.
//!
//! Two pieces, one implementation:
//!
//! - a loopback HTTP server, bound to `127.0.0.1` on a port the OS assigns, which
//!   answers the bundle's files and proxies the API;
//! - the `curule` URI scheme handler, which takes each request the webview makes and
//!   hands it to that server over loopback, then returns what it answered.
//!
//! The loopback hop is not a formality. The port carries the session — the cookie
//! travels on every proxied request — so it is bound to the loopback address and never
//! to a routable one, and the server refuses a request that says it came from another
//! origin. That guard is about the cookie in the webview's jar: a page from somewhere
//! else, shown in one of this shell's windows, would otherwise be able to spend a
//! session it cannot read. It is not the only gate — the cookie is `SameSite=Lax`, so a
//! cross-site request would not carry it anyway — but it is the one this shell owns.
//!
//! ## What is here, and what is not
//!
//! - The window's own origin is the only origin the page is served from, and the only
//!   one the guard accepts.
//! - The bundle is a snapshot taken at build time: `bundle.json` in the staged
//!   directory names the commit and the moment. It does not reach for the network for
//!   anything but `/api/...`.
//! - On Android the bundle is not the default, and cannot be until the platform's
//!   request interception can carry a request body: the WebView hands
//!   `shouldInterceptRequest` a request with no body, so a sign-in POST would arrive
//!   empty. See `Mode::default_mode`.

use std::io::{Read, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use tauri::http::{Request, Response, StatusCode};
use tauri::{AppHandle, Manager, Url};

/// The scheme the bundled page is served from. Registered with Tauri in `lib.rs`; the
/// webview sees this, and never a port number.
pub const SCHEME: &str = "curule";

/// Which of the two shells to be: `bundled` or `hosted`. Read once, at startup.
pub const MODE_ENV: &str = "CURULE_DESKTOP_MODE";

/// The page's origin, as the two platforms spell it: the scheme itself on macOS, iOS
/// and Linux, and the loopback name the webview is given instead on Windows and
/// Android. The window is opened with the first, and which of the two the page *has*
/// depends on the platform: that is what `PageOrigin` is. A request may carry either
/// spelling — a navigation on Windows reports the `http` form, the scheme handler sees
/// the other — and both are this shell's own page.
const ORIGIN_SCHEME: &str = "curule://localhost";
const ORIGIN_LOOPBACK: &str = "http://curule.localhost";

/// The origin this platform's webview gives the bundled page. Windows and Android map
/// the scheme onto `http://<scheme>.localhost`; everywhere else the scheme is the
/// origin. The handler sees the request as `curule://localhost/...` on all of them.
#[cfg(any(windows, target_os = "android"))]
pub const PAGE_ORIGIN: &str = ORIGIN_LOOPBACK;
#[cfg(not(any(windows, target_os = "android")))]
pub const PAGE_ORIGIN: &str = ORIGIN_SCHEME;

/// Where the staged bundle lives inside the app's frontend assets: `ui/app` on disk,
/// which is what `tauri.conf.json` embeds from `../ui`. Asset keys are rooted, so the
/// paths this module names all start with a slash.
const PREFIX: &str = "/app/";

/// The first file that has to be there: it is what says a bundle was staged at all.
const INDEX: &str = "/app/index.html";

/// The policy the pages are served with, word for word what the control plane's own
/// server puts on them (`PAGE_CSP` in `packages/cloud/src/web-server.ts`). They are the
/// same pages, and they are written for this policy: everything of their own is same
/// origin, and there is no inline script among them.
const PAGE_CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/// How long the control plane is given to answer one request.
///
/// On Android it is shorter than the thirty seconds the desktop gets, because the
/// webview answers the scheme handler on its own thread and gives up on it: wry waits
/// ten seconds (`MAIN_PIPE_TIMEOUT`) and the wait is an `unwrap` on the Android side, so
/// a request that outlives it takes the process down rather than failing. Six seconds
/// is a slower failure than anybody wants and a faster one than the platform's.
#[cfg(target_os = "android")]
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(6);
#[cfg(not(target_os = "android"))]
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(30);

/// How long the loopback hop may take, end to end. Above the upstream timeout, so the
/// proxy's own is the one that answers.
#[cfg(target_os = "android")]
const HOP_TIMEOUT: Duration = Duration::from_secs(8);
#[cfg(not(target_os = "android"))]
const HOP_TIMEOUT: Duration = Duration::from_secs(32);

/// How long the startup probe is given: long enough for a healthy service, short enough
/// not to hold the window back on a bad connection.
const PROBE_TIMEOUT: Duration = Duration::from_secs(4);

/// The largest request body this server reads, and the largest upstream body it passes
/// back. Nothing the API does is near it — it is a ceiling on what one request can make
/// the app hold, not a limit anybody meets.
const MAX_BODY: usize = 32 * 1024 * 1024;

/// The largest request head this server reads, request line and headers together.
const MAX_HEAD: usize = 64 * 1024;

/// The request headers that go upstream, and nothing else. The page's own origin is not
/// among them — it is put back on the way out, and only where the control plane asks for
/// it — and neither are the local address the request arrived at, the connection's
/// framing, or the encodings the webview would have accepted from the control plane
/// directly.
const FORWARDED: [&str; 5] = ["content-type", "accept", "accept-language", "cookie", "user-agent"];

/// Headers that belong to one connection and are not passed along either way.
const HOP_BY_HOP: [&str; 6] = [
    "content-length",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "upgrade",
    "proxy-connection",
];

/// The address the window opens on in bundled mode. It is built from `PAGE_ORIGIN`, so
/// the page's own idea of where it is and the origin the guard accepts are the same
/// string by construction.
pub fn page_url() -> Url {
    let mut url = Url::parse(PAGE_ORIGIN).expect("the bundled page's origin is an address");
    url.set_path("/");
    url
}

/// Whether an address is the bundled page's own, in either spelling. This is the whole
/// of what the window may show of the shell's own surface, and it is what keeps a
/// navigation inside the bundle — `/login`, `/account` — from being handed to the
/// system browser.
pub fn is_local_url(url: &Url) -> bool {
    let host = url.host_str().unwrap_or_default();
    if url.scheme().eq_ignore_ascii_case(SCHEME) {
        return host.eq_ignore_ascii_case("localhost");
    }
    url.scheme().eq_ignore_ascii_case("http") && host.eq_ignore_ascii_case("curule.localhost")
}

/// Whether a request says it came from the bundled page. Both spellings count: on
/// Windows and Android the page's origin is the `http` one, and nothing else can be
/// served from either.
fn is_local_origin(origin: &str) -> bool {
    let origin = origin.trim().trim_end_matches('/');
    origin.eq_ignore_ascii_case(ORIGIN_SCHEME) || origin.eq_ignore_ascii_case(ORIGIN_LOOPBACK)
}

/// Which shell to be. `bundled` serves the dashboard out of the app; `hosted` is 0.1.1
/// exactly — the shell's own page asks the control plane whether it answers, and
/// connects to it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    Bundled,
    Hosted,
}

impl Mode {
    /// `CURULE_DESKTOP_MODE`, read once. A value that is neither of the two is a value
    /// somebody mistyped, and a typo is not worth refusing to start over: it takes the
    /// platform's default, like an unset variable.
    fn read() -> Mode {
        Self::parse(std::env::var(MODE_ENV).ok().as_deref())
    }

    /// The mode as one line of text, so that what the variable does can be read in one
    /// place — including by the tests, which read this file rather than run it.
    fn parse(raw: Option<&str>) -> Mode {
        match raw.map(|value| value.trim().to_ascii_lowercase()) {
            Some(ref value) if value == "hosted" => Mode::Hosted,
            Some(ref value) if value == "bundled" => Mode::Bundled,
            Some(ref value) if !value.is_empty() => {
                eprintln!("{MODE_ENV}={value} is neither bundled nor hosted; using the default");
                Mode::default_mode()
            }
            _ => Mode::default_mode(),
        }
    }

    /// What an unset variable means: the bundle on the desktop, and the hosted app on
    /// Android — for now.
    ///
    /// The Android default is not a preference. The bundle is served from the scheme's
    /// own origin, and the platform's `shouldInterceptRequest` — which is how every
    /// request to that origin reaches this module — is handed a request with no body:
    /// the WebView API does not expose one. A GET survives that, a form or a
    /// `fetch` POST does not, and signing in is a POST. A phone that falls back to the
    /// deployed app is a phone that works; a phone that opens the bundle is a phone that
    /// cannot sign in. `CURULE_DESKTOP_MODE=bundled` asks for it anyway, and this note
    /// is the thing to delete when the platform can carry a body.
    fn default_mode() -> Mode {
        if cfg!(target_os = "android") {
            Mode::Hosted
        } else {
            Mode::Bundled
        }
    }
}

/// Where the window is going, and — when it is not the bundle — why not. The reason is
/// the one line a person can be shown without reading a log, so it is written for a
/// person: it goes to the tray tooltip and to stderr.
pub struct Place {
    pub bundled: bool,
    why: Option<String>,
}

impl Place {
    fn bundled() -> Place {
        Place { bundled: true, why: None }
    }

    fn hosted(why: &str) -> Place {
        Place { bundled: false, why: Some(why.to_string()) }
    }

    /// The tray's tooltip: what the window is showing, and if it is not the bundle, why.
    pub fn tooltip(&self, control_plane: &Url) -> String {
        let host = control_plane.host_str().unwrap_or("the control plane");
        match &self.why {
            None => format!("Curule — the dashboard inside the app; {host} for the API"),
            Some(why) => format!("Curule — showing {host}: {why}"),
        }
    }
}

/// Decides where the window goes, and starts the server that serves it.
///
/// Three things can send it to the hosted app, and each one is named rather than
/// guessed at: the bundle is not staged, the control plane does not answer, or the
/// local server cannot bind. The first is a broken build, the second is a machine with
/// no network — the case the bundle exists for — and the third is this machine. None of
/// the three may leave a blank window: the fallback is 0.1.1, the shell's own page that
/// asks and connects.
pub fn place(app: &AppHandle, control_plane: &Url) -> Place {
    let mode = Mode::read();
    if mode == Mode::Hosted {
        return fall_back(match std::env::var(MODE_ENV) {
            Ok(_) => "CURULE_DESKTOP_MODE=hosted",
            Err(_) => "Android cannot carry a sign-in through the bundled origin",
        });
    }

    let bundle = Bundle::new(app);
    if !bundle.holds(INDEX) {
        return fall_back("no dashboard is staged in ui/app");
    }

    let origin = upstream_origin(control_plane);
    // The probe is a question asked once, at startup, and answered quickly or not at
    // all: it gets its own client with its own, shorter, patience. The client the API
    // is served with is the one that waits.
    if !answers(&agent(PROBE_TIMEOUT), &origin) {
        return fall_back("the control plane did not answer");
    }

    match Local::start(bundle, origin, agent(UPSTREAM_TIMEOUT)) {
        Ok(local) => {
            let _ = LOCAL.set(local);
            Place::bundled()
        }
        Err(err) => fall_back(&format!("the local server could not bind: {err}")),
    }
}

/// Says why the window is not going to the bundle, where both a person and a log can
/// find it, and answers with the fallback.
fn fall_back(why: &str) -> Place {
    eprintln!("curule-desktop: not serving the bundled dashboard — {why}");
    Place::hosted(why)
}

/// The control plane's own origin: scheme, host and port, with no path. A page path
/// from the API is appended to it, so it must not carry a trailing slash.
fn upstream_origin(control_plane: &Url) -> String {
    control_plane.origin().ascii_serialization()
}

/// Whether the control plane answers at all. Any answer counts — a 404 means there is
/// something there to talk to, which is the question being asked. The health address is
/// the one the service answers by name (`/healthz`, in `packages/cloud/src/web-server.ts`).
fn answers(agent: &ureq::Agent, origin: &str) -> bool {
    match agent.get(&format!("{origin}/healthz")).call() {
        Ok(_) => true,
        Err(ureq::Error::Status(_, _)) => true,
        Err(_) => false,
    }
}

/// The HTTP client the control plane is reached with.
///
/// `ureq` over rustls: pure Rust, no OpenSSL, no unix-only API, and it compiles for
/// Android like the rest of this crate. Redirects are not followed — the control
/// plane's own `Location` is rewritten to a local path and handed to the webview, so a
/// redirect stays inside the app instead of being chased behind its back.
fn agent(timeout: Duration) -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(timeout).redirects(0).build()
}

/// The staged dashboard.
struct Bundle {
    assets: tauri::AssetResolver<tauri::Wry>,
    /// Every file the build embedded, or `None` in a development build, where there is
    /// nothing embedded and the resolver reads the staged directory off disk instead.
    ///
    /// The distinction is not cosmetic. In an installed app the resolver falls back —
    /// `app/x.js` a miss, it tries `app/x.js.html`, then `app/x.js/index.html`, then the
    /// app's own `index.html` — so a request for a file that is not there would be
    /// answered with a page, as a 200. A script that arrives as HTML is a page that does
    /// nothing, which is exactly the failure this list prevents.
    keys: Option<Vec<String>>,
}

impl Bundle {
    fn new(app: &AppHandle) -> Bundle {
        let assets = app.asset_resolver();
        // `iter` is read for its keys only: with the compression feature on, the bytes
        // it yields are the compressed ones. The bytes come from `get`, which is the
        // same lookup the resolver does for a real asset request.
        let keys: Vec<String> = assets
            .iter()
            .map(|(key, _)| key.into_owned())
            .filter(|key| key.starts_with(PREFIX))
            .collect();
        Bundle { assets, keys: (!keys.is_empty()).then_some(keys) }
    }

    /// Whether the bundle holds this file, exactly: `/app/index.html`, and not
    /// `/app/index.html.html`.
    fn holds(&self, path: &str) -> bool {
        match &self.keys {
            Some(keys) => keys.iter().any(|key| key == path),
            None => self.assets.get(path.to_string()).is_some(),
        }
    }

    fn read(&self, path: &str) -> Option<Vec<u8>> {
        if !self.holds(path) {
            return None;
        }
        self.assets.get(path.to_string()).map(|asset| asset.bytes)
    }
}

/// The loopback server's handle: the port it bound, and nothing else. Everything the
/// server needs to answer is behind it, in the thread that owns it.
struct Local {
    port: u16,
}

/// The one server this process runs. `place` sets it; every request the webview makes
/// goes through it.
static LOCAL: OnceLock<Local> = OnceLock::new();

/// The `curule` scheme's handler: one request from the webview, one answer. Called with
/// the request the webview made and the responder Tauri waits on.
///
/// It is registered as an *asynchronous* handler and this is called on a thread of its
/// own (`lib.rs` spawns one per request), because the answer waits on the control plane:
/// the thread Tauri calls a synchronous handler on is the webview's own on Windows, and
/// a dashboard that blocks it is a window that freezes.
pub fn on_request(request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    match LOCAL.get() {
        Some(local) => local.forward(request),
        None => Answer::text(
            503,
            "The bundled dashboard is not running. Restart the app; if it keeps saying this, open the address in the tray in a browser.",
        )
        .into_response(),
    }
}

impl Local {
    /// Binds the loopback address — never a routable one: the port carries the session,
    /// and nothing on the network has any business reaching it — and starts the thread
    /// that answers on it.
    fn start(bundle: Bundle, origin: String, agent: ureq::Agent) -> std::io::Result<Local> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        let port = listener.local_addr()?.port();
        let server = Arc::new(Server { listener, bundle, origin, agent });
        std::thread::spawn(move || accept_loop(server));
        Ok(Local { port })
    }

    /// Takes one webview request to the local server and brings back what it answered.
    /// The request is re-made rather than tunnelled: the local server speaks HTTP/1.1
    /// over loopback, and this is the client side of that.
    fn forward(&self, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
        let method = request.method().as_str().to_string();
        let target = request
            .uri()
            .path_and_query()
            .map(|path| path.as_str().to_string())
            .unwrap_or_else(|| "/".to_string());
        let mut headers = Vec::new();
        for (name, value) in request.headers().iter() {
            let name = name.as_str();
            if HOP_BY_HOP.iter().any(|hop| name.eq_ignore_ascii_case(hop)) {
                continue;
            }
            if let Ok(value) = value.to_str() {
                headers.push((name.to_string(), value.to_string()));
            }
        }
        let body = request.into_body();

        match self.hop(&method, &target, &headers, &body) {
            Ok(answer) => answer.into_response(),
            Err(err) => Answer::text(502, &format!("The bundled dashboard could not answer: {err}")).into_response(),
        }
    }

    /// One request over loopback, one answer. The connection is used for exactly one
    /// exchange and closed with it: nothing is kept between requests, because there is
    /// nothing to keep — the session is a cookie the webview holds, not state here.
    fn hop(
        &self,
        method: &str,
        target: &str,
        headers: &[(String, String)],
        body: &[u8],
    ) -> std::io::Result<Answer> {
        let address = std::net::SocketAddr::from((Ipv4Addr::LOCALHOST, self.port));
        let mut stream = TcpStream::connect_timeout(&address, HOP_TIMEOUT)?;
        stream.set_read_timeout(Some(HOP_TIMEOUT))?;
        stream.set_write_timeout(Some(HOP_TIMEOUT))?;

        let mut head = format!(
            "{method} {target} HTTP/1.1\r\nhost: 127.0.0.1:{}\r\ncontent-length: {}\r\nconnection: close\r\n",
            self.port,
            body.len()
        );
        for (name, value) in headers {
            head.push_str(name);
            head.push_str(": ");
            head.push_str(value);
            head.push_str("\r\n");
        }
        head.push_str("\r\n");

        stream.write_all(head.as_bytes())?;
        if !body.is_empty() {
            stream.write_all(body)?;
        }
        stream.flush()?;

        read_answer(&mut stream)
    }
}

/// The state the server thread answers with: the listener it accepts on, the bundle it
/// serves, and the control plane it proxies to.
struct Server {
    listener: TcpListener,
    bundle: Bundle,
    origin: String,
    agent: ureq::Agent,
}

/// Accepts for the life of the process. A connection that dies before it is accepted is
/// the next iteration's problem; the listener itself does not fail while the process is
/// running.
fn accept_loop(server: Arc<Server>) {
    loop {
        match server.listener.accept() {
            Ok((stream, _)) => {
                let server = Arc::clone(&server);
                std::thread::spawn(move || serve_connection(&server, stream));
            }
            Err(_) => continue,
        }
    }
}

/// One connection: one request, one answer. A request that cannot be read is dropped
/// without an answer — the only clients that reach this port are the app's own forwarder
/// and whatever else on this machine asks, and neither is owed a diagnosis. A body over
/// the ceiling is answered, because that one is worth saying.
fn serve_connection(server: &Server, mut stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(HOP_TIMEOUT));
    let _ = stream.set_write_timeout(Some(HOP_TIMEOUT));
    let ask = match read_ask(&mut stream, MAX_BODY) {
        Ok(ask) => ask,
        Err(ReadError::TooLarge) => {
            let _ = write_answer(&mut stream, &Answer::text(413, "That request is too large."), false);
            return;
        }
        Err(ReadError::Unreadable) => return,
    };
    let answer = handle(server, &ask);
    let _ = write_answer(&mut stream, &answer, ask.method == "HEAD");
}

/// What to do with one request: refuse it, proxy it, or serve it out of the bundle.
fn handle(server: &Server, ask: &Ask) -> Answer {
    if let Some(refusal) = refused(ask) {
        return refusal;
    }
    if is_api(&ask.path) {
        return server.proxy(ask);
    }
    if !ask.is_read() {
        return Answer::text(405, "The bundled dashboard has no page at this address.");
    }
    static_answer(server, ask)
}

/// The guard: a request that did not come from the app's own page is refused. Two
/// rules, and both are about what the request *says* about itself — the session cookie
/// belongs to the page in this window, and a page from anywhere else has no business
/// spending it.
///
/// An absent `Origin` is not a pass: it is what a navigation and a subresource request
/// carry, and that is how the page itself is loaded. A request that names an origin has
/// to name the right one, and one the webview itself labelled cross-site is refused
/// whatever else it says.
fn refused(ask: &Ask) -> Option<Answer> {
    if let Some(origin) = ask.header("origin") {
        if !is_local_origin(origin) {
            return Some(Answer::text(403, "That request did not come from the app's own page."));
        }
    }
    if let Some(site) = ask.header("sec-fetch-site") {
        if site.trim().eq_ignore_ascii_case("cross-site") {
            return Some(Answer::text(403, "That request did not come from the app's own page."));
        }
    }
    None
}

/// Whether a path is the API: the one part of the control plane the page calls, and the
/// only thing proxied. Everything else is the bundle's, and a path that is neither is
/// answered with the 404 page.
fn is_api(path: &str) -> bool {
    path == "/api" || path.starts_with("/api/")
}

/// A page or an asset out of the bundle, or the 404 page. A path that is not one of the
/// pages the control plane serves — by the same table, because they are the same pages —
/// and not a name under `/assets` falls through to the 404 page rather than being joined
/// onto a directory: nothing a caller writes reaches the filesystem.
fn static_answer(server: &Server, ask: &Ask) -> Answer {
    if escapes(&ask.path) {
        return Answer::text(403, "That path is not inside the app.");
    }

    let file = match page_file(&ask.path) {
        Some(page) => Some(format!("{PREFIX}{page}")),
        None => asset_file(&ask.path),
    };

    match file.and_then(|path| server.bundle.read(&path).map(|body| (path, body))) {
        Some((path, body)) => {
            let mut answer = Answer { status: 200, headers: Vec::new(), body };
            answer.headers.push(("content-type".into(), content_type(&path).into()));
            if path.ends_with(".html") {
                answer.headers.extend(page_headers());
            } else {
                answer.headers.extend(asset_headers());
            }
            answer
        }
        None => not_found(server),
    }
}

/// The page the window is shown when it asks for an address the bundle does not have.
/// It is the control plane's own 404 page, so a typo in a link looks the same in the app
/// as it does in a browser — and if the bundle is old enough not to have one, a sentence
/// is still better than nothing.
fn not_found(server: &Server) -> Answer {
    let fallback = Answer::text(404, "That address is not in this app.");
    let body = match server.bundle.read(&format!("{PREFIX}404.html")) {
        Some(body) => body,
        None => return fallback,
    };
    let mut answer = Answer { status: 404, headers: Vec::new(), body };
    answer.headers.push(("content-type".into(), "text/html; charset=utf-8".into()));
    answer.headers.extend(page_headers());
    answer
}

/// The file a page address names. The same table the control plane serves its pages from (`PAGES` in
/// `packages/cloud/src/web-server.ts`): the bundle is that server's own pages, so an address that has no page
/// there has none here either.
///
/// This list is also the whitelist that decides what may be read out of the bundle — nothing is ever joined
/// onto a directory — which is why a page added to the control plane has to be named here as well. That is a
/// step a person has to take, so it is a step a test fails on:
/// `tests/desktop/staged-pages.test.ts` compares this table with the staged bundle and names the page that is
/// missing a route.
///
/// A page may be asked for with a trailing slash and is the same page: `/login/` is `/login`, which is what
/// the control plane's own server does with it.
fn page_file(path: &str) -> Option<&'static str> {
    match path.trim_end_matches('/') {
        "" => Some("index.html"),
        "/signup" => Some("signup.html"),
        "/login" => Some("login.html"),
        "/verify" => Some("verify.html"),
        "/forgot" => Some("forgot.html"),
        "/reset" => Some("reset.html"),
        "/account" => Some("account.html"),
        "/terms" => Some("terms.html"),
        "/privacy" => Some("privacy.html"),
        _ => None,
    }
}

/// The asset a path names: `/assets/` and a file name with nothing in it that could
/// name another directory. The name is matched, not joined, so a request cannot reach
/// past the bundle's own assets however it is spelled — and the escapes are already
/// decoded by the time this runs.
fn asset_file(path: &str) -> Option<String> {
    let name = path.strip_prefix("/assets/")?;
    let mut characters = name.chars();
    match characters.next() {
        Some(first) if first.is_ascii_alphanumeric() => {}
        _ => return None,
    }
    if !characters.all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-') {
        return None;
    }
    Some(format!("{PREFIX}assets/{name}"))
}

/// Whether a decoded path is written to reach outside the bundle: a `..` segment, a
/// leading `//`, or a backslash where a separator is meant. The paths this server sees
/// are already decoded, so a request that arrived as `%2e%2e%2f` is read here as `../`.
fn escapes(path: &str) -> bool {
    path.contains('\\')
        || path.contains('\0')
        || path.split('/').any(|segment| segment == ".." || segment == ".")
        || path.starts_with("//")
}

/// What a file is, by its extension. The same table the control plane serves its pages
/// with (`TYPES` in `packages/cloud/src/web-server.ts`).
fn content_type(path: &str) -> &'static str {
    match path.rsplit('.').next() {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("json") => "application/json; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// What a page is served with, word for word what the control plane's own server sends
/// with it (`sendFile` in `packages/cloud/src/web-server.ts`). A page is never stored:
/// it is a snapshot of one build, and a cached one is a page from a control plane that
/// has moved on.
fn page_headers() -> Vec<(String, String)> {
    vec![
        ("content-security-policy".into(), PAGE_CSP.into()),
        ("cross-origin-opener-policy".into(), "same-origin".into()),
        ("x-frame-options".into(), "DENY".into()),
        ("cache-control".into(), "no-store".into()),
        ("x-content-type-options".into(), "nosniff".into()),
        ("referrer-policy".into(), "no-referrer".into()),
    ]
}

/// What an asset is served with. The same reasoning as a page, for the same reason: a
/// script and the page that loads it are one build, and there is no fingerprint here to
/// revalidate against — the control plane sends an `ETag` and the browser asks each time
/// whether the file changed, and this server has nothing to ask with. An asset kept
/// without one is the old dashboard running under the new one.
fn asset_headers() -> Vec<(String, String)> {
    vec![
        ("cache-control".into(), "no-store".into()),
        ("x-content-type-options".into(), "nosniff".into()),
        ("referrer-policy".into(), "no-referrer".into()),
    ]
}

impl Server {
    /// One API call, made to the control plane as the page meant it: the same method,
    /// path, query and body, with the headers the control plane reads, and with the
    /// page's own origin replaced by the control plane's for anything that changes
    /// state — which is exactly what the control plane demands, and what a browser would
    /// have sent had the page been served from there.
    fn proxy(&self, ask: &Ask) -> Answer {
        if ask.body.len() > MAX_BODY {
            return Answer::text(413, "That request is too large.");
        }

        let url = format!("{}{}", self.origin, ask.target);
        let mut request = self.agent.request(&ask.method, &url);
        for (name, value) in ask.headers.iter() {
            if FORWARDED.iter().any(|forwarded| name.eq_ignore_ascii_case(forwarded)) {
                request = request.set(name.as_str(), value.as_str());
            }
        }
        if !ask.is_read() {
            request = request.set("origin", &self.origin);
        }

        let sent = if ask.body.is_empty() {
            request.call()
        } else {
            request.send_bytes(&ask.body)
        };

        match sent {
            Ok(response) => self.from_upstream(response),
            Err(ureq::Error::Status(_, response)) => self.from_upstream(response),
            Err(err) => Answer::text(
                502,
                &format!("The control plane could not be reached. The app still works offline; try again in a moment. ({err})"),
            ),
        }
    }

    /// What the control plane answered, handed back as it came: the status, every
    /// header — several `Set-Cookie`s are several headers, and the session cookie among
    /// them has to arrive untouched, `__Host-` prefix and all — and the body.
    fn from_upstream(&self, response: ureq::Response) -> Answer {
        let status = response.status();
        let mut headers = Vec::new();
        for name in response.headers_names() {
            if HOP_BY_HOP.iter().any(|hop| name.eq_ignore_ascii_case(hop)) {
                continue;
            }
            for value in response.all(&name) {
                headers.push((name.clone(), value.to_string()));
            }
        }

        let mut body = Vec::new();
        let read = response
            .into_reader()
            .take(MAX_BODY as u64 + 1)
            .read_to_end(&mut body);
        if read.is_err() {
            return Answer::text(502, "The control plane's answer could not be read.");
        }
        if body.len() > MAX_BODY {
            return Answer::text(502, "The control plane's answer was larger than this app will hold.");
        }

        let mut answer = Answer { status, headers, body };
        rewrite_redirects(&mut answer, &self.origin);
        answer
    }
}

/// A `Location` that points at the control plane becomes the same path inside the app,
/// so a redirect cannot bounce the window out of the bundle and into the browser. An
/// address the control plane does not own is somebody else's — a checkout, an OAuth
/// provider — and is left exactly as it is, which is what sends it to the browser.
fn rewrite_redirects(answer: &mut Answer, origin: &str) {
    for (name, value) in answer.headers.iter_mut() {
        if !name.eq_ignore_ascii_case("location") {
            continue;
        }
        if let Some(path) = local_path(value, origin) {
            *value = path;
        }
    }
}

/// The local path an address names, when the address is the control plane's own: the
/// origin and nothing else, and a path or a query after it. Anything else is `None` —
/// including a host that merely begins with the same letters
/// (`https://app.curule.dev.example.com`), which is somebody else's host.
fn local_path(address: &str, origin: &str) -> Option<String> {
    if address.len() < origin.len() {
        return None;
    }
    let (head, rest) = address.split_at(origin.len());
    if !head.eq_ignore_ascii_case(origin) {
        return None;
    }
    match rest.chars().next() {
        None => Some("/".to_string()),
        Some('/') => Some(rest.to_string()),
        Some('?') => Some(format!("/{rest}")),
        Some(_) => None,
    }
}

/// One answer, before it is written to a socket or handed to the webview.
struct Answer {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Answer {
    fn text(status: u16, message: &str) -> Answer {
        Answer {
            status,
            headers: vec![("content-type".into(), "text/plain; charset=utf-8".into())],
            body: message.as_bytes().to_vec(),
        }
    }

    /// The same answer, as the webview's protocol handler returns it. A header that
    /// cannot be written as one is dropped rather than failing the answer: what is
    /// dropped is a header from upstream, and a page without it beats a page that does
    /// not load.
    fn into_response(self) -> Response<Vec<u8>> {
        let status = StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        let mut builder = Response::builder().status(status);
        for (name, value) in self.headers {
            builder = builder.header(name, value);
        }
        builder
            .body(self.body)
            .unwrap_or_else(|_| Response::new(Vec::new()))
    }
}

/// One request, as the local server reads it.
struct Ask {
    method: String,
    /// The target as it was sent: `/account?x=1`.
    target: String,
    /// The path, decoded, which is what routing and the file table are done on.
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Ask {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    fn is_read(&self) -> bool {
        self.method == "GET" || self.method == "HEAD"
    }
}

/// Why a request could not be read.
enum ReadError {
    Unreadable,
    TooLarge,
}

/// Reads one request: the head, then as much of the body as its `content-length` asks
/// for, up to `max`. The head is read a chunk at a time and capped, so a client that
/// never ends a line is not a way to make this process hold memory.
fn read_ask(stream: &mut TcpStream, max: usize) -> Result<Ask, ReadError> {
    let mut raw = Vec::new();
    let mut chunk = [0u8; 8192];

    let head_end = loop {
        if let Some(at) = find_head_end(&raw) {
            break at;
        }
        if raw.len() > MAX_HEAD {
            return Err(ReadError::Unreadable);
        }
        let read = stream.read(&mut chunk).map_err(|_| ReadError::Unreadable)?;
        if read == 0 {
            return Err(ReadError::Unreadable);
        }
        raw.extend_from_slice(&chunk[..read]);
    };

    let head = std::str::from_utf8(&raw[..head_end]).map_err(|_| ReadError::Unreadable)?;
    let mut lines = head.split("\r\n");
    let request_line = lines.next().ok_or(ReadError::Unreadable)?;
    let mut parts = request_line.split(' ');
    let method = parts.next().ok_or(ReadError::Unreadable)?.to_string();
    let raw_target = parts.next().ok_or(ReadError::Unreadable)?.to_string();

    let mut headers = Vec::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
        }
    }

    let length: usize = headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .and_then(|(_, value)| value.parse().ok())
        .unwrap_or(0);
    if length > max {
        return Err(ReadError::TooLarge);
    }

    let mut body = raw[head_end + 4..].to_vec();
    while body.len() < length {
        let read = stream.read(&mut chunk).map_err(|_| ReadError::Unreadable)?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }
    body.truncate(length);

    let (raw_path, query) = path_and_query(&raw_target).ok_or(ReadError::Unreadable)?;
    let path = decode(&raw_path).ok_or(ReadError::Unreadable)?;
    let target = if query.is_empty() { raw_path } else { format!("{raw_path}?{query}") };

    Ok(Ask { method, target, path, headers, body })
}

/// The path and query a target names, in either form a client may write it: `/x?y`, or
/// the absolute `http://host/x?y` a proxy-style client sends. `None` for anything else,
/// which is not a request this server answers.
fn path_and_query(target: &str) -> Option<(String, String)> {
    if target.starts_with('/') {
        return Some(match target.split_once('?') {
            Some((path, query)) => (path.to_string(), query.to_string()),
            None => (target.to_string(), String::new()),
        });
    }
    let url = Url::parse(target).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    Some((url.path().to_string(), url.query().unwrap_or_default().to_string()))
}

/// A path with its percent-escapes decoded, or `None` if it is not UTF-8 once they are.
/// A server that routed on the escapes would answer for `/assets/app.js` to a request
/// spelled `/assets%2fapp.js`, and one that routed on the decoded path without this
/// check would be reading a string that is not one.
fn decode(path: &str) -> Option<String> {
    if !path.contains('%') {
        return Some(path.to_string());
    }
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' && at + 2 < bytes.len() {
            let pair = std::str::from_utf8(&bytes[at + 1..at + 3]).ok()?;
            let byte = u8::from_str_radix(pair, 16).ok()?;
            out.push(byte);
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Where a head ends: the blank line between it and the body, or `None` while there is
/// none yet.
fn find_head_end(raw: &[u8]) -> Option<usize> {
    raw.windows(4).position(|window| {
        window.len() == 4 && window[0] == b'\r' && window[1] == b'\n' && window[2] == b'\r' && window[3] == b'\n'
    })
}

/// Writes one answer to the connection a client is waiting on. The connection is closed
/// with it — `connection: close`, and the length is always written — so the client knows
/// where the answer ends without being told twice.
fn write_answer(stream: &mut TcpStream, answer: &Answer, head_only: bool) -> std::io::Result<()> {
    let mut head = format!("HTTP/1.1 {} {}\r\n", answer.status, reason(answer.status));
    for (name, value) in &answer.headers {
        head.push_str(name);
        head.push_str(": ");
        head.push_str(value);
        head.push_str("\r\n");
    }
    head.push_str(&format!("content-length: {}\r\n", answer.body.len()));
    head.push_str("connection: close\r\n\r\n");
    stream.write_all(head.as_bytes())?;
    if !head_only {
        stream.write_all(&answer.body)?;
    }
    stream.flush()
}

/// The words that go with a status. The local server's clients read the number; a human
/// reading a log reads this.
fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        204 => "No Content",
        304 => "Not Modified",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "OK",
    }
}

/// Reads an answer off the loopback connection: everything sent, until the server closes
/// it, parsed into the same `Answer` an upstream response becomes.
fn read_answer(stream: &mut TcpStream) -> std::io::Result<Answer> {
    let mut raw = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        raw.extend_from_slice(&chunk[..read]);
        if raw.len() > MAX_BODY + MAX_HEAD {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "the local server's answer was larger than this app will hold",
            ));
        }
    }
    parse_answer(&raw).ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, "the local server's answer could not be read")
    })
}

/// The status, headers and body of an answer read off the wire. The server on the other
/// end is this process, but the parse still refuses what it cannot read rather than
/// guessing at it.
fn parse_answer(raw: &[u8]) -> Option<Answer> {
    let at = find_head_end(raw)?;
    let head = std::str::from_utf8(&raw[..at]).ok()?;
    let mut lines = head.split("\r\n");
    let status: u16 = lines.next()?.split(' ').nth(1)?.parse().ok()?;
    let mut headers = Vec::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.push((name.trim().to_string(), value.trim().to_string()));
        }
    }
    Some(Answer { status, headers, body: raw[at + 4..].to_vec() })
}
