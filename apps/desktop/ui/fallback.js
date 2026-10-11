// The window's own page: the shell opens on it, it connects to the app, and a
// connection that fails stays here with a Retry. No network beyond the app's own
// address, no IPC, nothing fetched from anywhere else.
(function () {
  "use strict";

  var DEFAULT_APP_URL = "https://app.curule.dev";
  var CONNECT_TIMEOUT_MS = 6000;

  // The shell sets this before the page parses (src-tauri/src/lib.rs). The default
  // is the hosted app, so this page opened on its own still knows where to go.
  var appUrl = DEFAULT_APP_URL;
  try {
    // A page that navigates to whatever it was handed can be pointed somewhere
    // else: http(s) or nothing.
    var candidate = new URL(window.__CURULE_APP_URL__ || DEFAULT_APP_URL);
    if (candidate.protocol === "http:" || candidate.protocol === "https:") appUrl = candidate.href.replace(/\/+$/, "");
  } catch (err) {
    appUrl = DEFAULT_APP_URL;
  }

  var host = new URL(appUrl).host;
  var status = document.getElementById("status");
  var browser = document.getElementById("browser");
  var retry = document.getElementById("retry");

  document.getElementById("host").textContent = host;
  document.getElementById("note-host").textContent = host;
  browser.href = appUrl;

  function say(state, text) {
    status.dataset.state = state;
    status.textContent = text;
  }

  // Whether the app answers at all. A webview that cannot reach it shows an error
  // page of its own, and the shell cannot see that happen — tauri and wry report
  // no load failure, on any of the three platforms — so the page asks first and
  // stays where a Retry can be pressed when the answer is no.
  function reachable() {
    return new Promise(function (resolve) {
      var stop = new AbortController();
      var timer = setTimeout(function () {
        stop.abort();
        resolve(false);
      }, CONNECT_TIMEOUT_MS);
      var done = function (answer) {
        clearTimeout(timer);
        resolve(answer);
      };
      fetch(appUrl, { method: "HEAD", mode: "no-cors", cache: "no-store", signal: stop.signal })
        .then(function () {
          done(true);
        })
        .catch(function () {
          done(false);
        });
    });
  }

  function connect() {
    say("connecting", "Connecting to " + host + "…");
    retry.disabled = true;
    reachable().then(function (answered) {
      retry.disabled = false;
      if (answered) window.location.replace(appUrl);
      else say("failed", "Could not reach " + host + ".");
    });
  }

  retry.addEventListener("click", connect);
  connect();
})();
