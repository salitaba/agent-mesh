"use strict";
// The one script every page loads. It only improves things: each page reads and works without it (the menu, the tabs and the
// billing toggle are plain CSS, the contact page carries the addresses as text). It makes no request of its own, and it keeps
// nothing: no cookie, no stored choice. The links it sets are followed by the visitor, not fetched by the page.

// Where the documents are published: the repository, until a documentation site exists.
var DOCS_BASE = "https://github.com/salitaba/agent-mesh/blob/main/docs/";
// The repository the source is in: the "Source code" links, and the address the "Try it" commands clone.
var REPO_URL = "https://github.com/salitaba/agent-mesh";
var APP_URL = ""; // No hosted dashboard: the "Sign in" link is removed
var CLOUD_URL = "https://app.curule.dev"; // Curule Cloud's address: the pages offer "Sign in" and "Get started", and say Curule is also run for you
var CONTACT_HREF = "mailto:ali79taba@gmail.com"; // "Talk to us" and the paid plans
// Off until the first release tag has published the image to ghcr.io: a command that pulls it fails until then. Switch it to
// true on the day of the release and the "Try it" steps also show the pull-and-run path.
var IMAGE_RELEASED = false;
var IMAGE_NAME = "ghcr.io/salitaba/curule";

(function () {
  // Of a page's sections, by the distance of each top from the top of the window, the one being read: the last whose top has
  // passed the line (a section scrolled into the upper part of the window has started), or -1 while none has.
  var readingAt = function (tops, line) {
    var at = -1;
    for (var i = 0; i < tops.length; i++) if (tops[i] <= line) at = i;
    return at;
  };

  // The pure parts, for the tests, when the file is loaded as a module; in a browser nothing is exported.
  if (typeof module === "object" && module !== null && typeof module.exports === "object") module.exports = { readingAt: readingAt };
  if (typeof document === "undefined") return;

  var all = function (selector) { return Array.prototype.slice.call(document.querySelectorAll(selector)); };
  var within = function (node, selector) { return Array.prototype.slice.call(node.querySelectorAll(selector)); };
  var reducedMotion = function () { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); };
  var el = function (tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };

  // Links out of the site are never written into the pages: they are set here, from the constants above.
  all("[data-doc]").forEach(function (a) {
    a.href = DOCS_BASE + a.getAttribute("data-doc");
    a.rel = "noopener noreferrer";
  });
  all("[data-repo]").forEach(function (a) {
    var path = a.getAttribute("data-repo");
    a.href = REPO_URL + (path ? "/" + path : "");
    a.rel = "noopener noreferrer";
  });
  if (APP_URL) {
    all("[data-app]").forEach(function (a) {
      a.href = APP_URL;
      a.hidden = false;
      if (/^https?:/.test(APP_URL)) a.rel = "noopener noreferrer";
    });
  }
  // Curule Cloud, once it is open: the links into it are set here, and the sentences that say it is not offered give way to the
  // ones that say it is. Nothing is fetched: a visitor who follows "Sign in" lands on the account pages, which send someone who is
  // already signed in on to their account.
  if (CLOUD_URL) {
    var cloud = CLOUD_URL.replace(/\/+$/, "");
    var CLOUD_PATH = { home: "/", login: "/login", signup: "/signup", terms: "/terms", privacy: "/privacy" };
    all("[data-cloud]").forEach(function (a) {
      var path = CLOUD_PATH[a.getAttribute("data-cloud")];
      if (path === undefined) return;
      a.href = cloud + path;
      a.hidden = false;
    });
    all("[data-cloud-only]").forEach(function (node) { node.hidden = false; });
    all("[data-selfhost-only]").forEach(function (node) { node.hidden = true; });
    // Two sign-in links would ask a visitor which one is theirs: the account is what the site offers.
    all("[data-app]").forEach(function (a) { a.hidden = true; });
  }
  if (/^mailto:/.test(CONTACT_HREF)) {
    all("[data-contact]").forEach(function (a) {
      var subject = a.getAttribute("data-subject");
      a.href = CONTACT_HREF + (subject ? "?subject=" + encodeURIComponent(subject) : "");
    });
  }

  // After the first release the demo can be started from the published image as well as from a build.
  if (IMAGE_RELEASED) {
    all("[data-image-off]").forEach(function (node) { node.hidden = true; });
    all("[data-image-slot]").forEach(function (slot) {
      slot.appendChild(el("p", "", "Or skip the build and run the published image:"));
      var box = el("div", "code");
      var pre = el("pre");
      var code = el("code", "", "docker run --rm -p 127.0.0.1:7420:7420 -v mesh-demo:/data \\\n  -e MESH_API_TOKEN=\"$MESH_API_TOKEN\" \\\n  " + IMAGE_NAME + ":latest demo");
      pre.appendChild(code);
      box.appendChild(pre);
      slot.appendChild(box);
    });
  }

  // Copy buttons, only where the browser can copy: one click, one write to the clipboard, nothing else.
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    var status = el("div", "sr");
    status.setAttribute("role", "status");
    document.body.appendChild(status);
    all(".code").forEach(function (box) {
      var pre = box.querySelector("pre");
      if (!pre || box.querySelector(".copy")) return;
      var button = el("button", "copy", "Copy");
      button.type = "button";
      button.setAttribute("aria-label", "Copy these commands");
      var timer = 0;
      var say = function (shown, spoken) {
        button.textContent = shown;
        status.textContent = spoken;
        window.clearTimeout(timer);
        timer = window.setTimeout(function () { button.textContent = "Copy"; status.textContent = ""; }, 2200);
      };
      button.addEventListener("click", function () {
        navigator.clipboard.writeText(pre.textContent.replace(/\s+$/, "")).then(
          function () { say("Copied", "Copied to the clipboard"); },
          function () { say("Not copied", "The browser did not allow copying; select the text instead"); }
        );
      });
      var bar = el("div", "code-bar");
      bar.appendChild(button);
      box.insertBefore(bar, box.firstChild);
    });
  }

  // On this page: on a long page the row of its sections stays under the header while the page is read, and the chip of the
  // section being read is marked. The line a section's top has to pass is a third of the way down the window, and never above
  // where a followed section lands (the page's scroll padding), or a section that was followed would not count as read. The
  // observer's root is the window above that line, so it says when a top crosses it, which is when the section being read can
  // change. A browser without one keeps the row where it is, a row of plain links, as it is without a script.
  var tocBar = document.querySelector(".toc-bar");
  var row = tocBar && tocBar.querySelector(".toc");
  if (row && typeof window.IntersectionObserver === "function") {
    var chips = within(row, "a").filter(function (a) { return /^#./.test(a.getAttribute("href") || ""); });
    var sections = chips.map(function (a) { return document.getElementById(a.getAttribute("href").slice(1)); });
    var current = -1;
    var held = -1;
    var holding = 0;
    var line = 0;
    var watcher = null;
    var resizing = 0;
    // The marked chip is kept in view in the row, with a little of its neighbours, without scrolling the page.
    var reveal = function (chip) {
      var box = row.getBoundingClientRect();
      var at = chip.getBoundingClientRect();
      var room = 24;
      var to = at.left - room < box.left ? row.scrollLeft + at.left - box.left - room : at.right + room > box.right ? row.scrollLeft + at.right - box.right + room : null;
      if (to === null) return;
      if (typeof row.scrollTo === "function") row.scrollTo({ left: Math.max(0, to), behavior: reducedMotion() ? "auto" : "smooth" });
      else row.scrollLeft = Math.max(0, to);
    };
    var mark = function (i) {
      if (i === current) return;
      current = i;
      chips.forEach(function (a, j) {
        if (j === i) a.setAttribute("aria-current", "true");
        else a.removeAttribute("aria-current");
      });
      if (i >= 0) reveal(chips[i]);
    };
    // A chip that is followed is the section being read from the moment it is chosen: the sections a smooth scroll passes on the
    // way there are not marked one after another. The hold ends when the page gets there, or when the scroll ends anywhere else
    // (the reader took over), or after a few seconds in a browser that does not say when a scroll ends.
    var spy = function () {
      var i = readingAt(sections.map(function (s) { return s ? s.getBoundingClientRect().top : Infinity; }), line);
      if (held >= 0) {
        if (i !== held) return;
        held = -1;
        window.clearTimeout(holding);
      }
      mark(i);
    };
    var release = function () {
      window.clearTimeout(holding);
      held = -1;
      spy();
    };
    row.addEventListener("click", function (event) {
      var i = chips.indexOf(event.target && event.target.closest ? event.target.closest("a") : null);
      if (i < 0) return;
      mark(i);
      held = i;
      window.clearTimeout(holding);
      holding = window.setTimeout(release, 3000);
    });
    window.addEventListener("scrollend", function () { if (held >= 0) release(); });
    var watch = function () {
      var landing = parseFloat(window.getComputedStyle(document.documentElement).scrollPaddingTop) || 0;
      line = Math.round(Math.max(window.innerHeight / 3, landing + 20));
      if (watcher) watcher.disconnect();
      watcher = new window.IntersectionObserver(spy, { rootMargin: "0px 0px " + (line - window.innerHeight) + "px 0px" });
      sections.forEach(function (s) { if (s) watcher.observe(s); });
    };
    window.addEventListener("resize", function () {
      window.clearTimeout(resizing);
      resizing = window.setTimeout(watch, 150);
    });
    watch();
    tocBar.className += " is-live";
  }

  // Back to top: once the reader is about two screens down a page, a button in the corner goes back to the start, and takes the
  // keyboard's focus to the top of the content too, so that Tab carries on from there. It sits at the end of the page's main
  // content and stays at the bottom of the window only while that content is in view, so it never covers the footer's links.
  var main = document.getElementById("main");
  if (main && typeof window.addEventListener === "function" && typeof window.scrollTo === "function") {
    var dock = el("div", "to-top-dock");
    var up = el("button", "to-top");
    up.setAttribute("type", "button");
    up.append(el("span", "sr", "Back to top"));
    dock.append(up);
    main.append(dock);
    var far = false;
    var looking = false;
    var look = function () {
      looking = false;
      var now = window.scrollY > 2 * window.innerHeight;
      if (now === far) return;
      far = now;
      up.className = far ? "to-top is-shown" : "to-top";
    };
    window.addEventListener("scroll", function () {
      if (looking) return;
      looking = true;
      window.requestAnimationFrame(look);
    }, { passive: true });
    window.addEventListener("resize", look);
    up.addEventListener("click", function () {
      window.scrollTo({ top: 0, behavior: reducedMotion() ? "auto" : "smooth" });
      main.focus({ preventScroll: true });
    });
    look();
  }

  // The phone menu closes when a link in it is followed (on the same page) and on Escape.
  all(".menu").forEach(function (menu) {
    menu.addEventListener("click", function (event) {
      var target = event.target;
      if (target && target.closest && target.closest("a")) menu.removeAttribute("open");
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && menu.open) {
        menu.open = false;
        var summary = menu.querySelector("summary");
        if (summary) summary.focus();
      }
    });
  });
})();
