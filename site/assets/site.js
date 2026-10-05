"use strict";
// The one script every page loads. It only improves things: each page reads and works without it (the menu, the tabs and the
// billing toggle are plain CSS, the contact page carries the addresses as text). It makes no request of its own, and it keeps
// nothing: no cookie, no stored choice. The links it sets are followed by the visitor, not fetched by the page.

// Where the documents are published: the repository, until a documentation site exists.
var DOCS_BASE = "https://github.com/salitaba/agent-mesh/blob/main/docs/";
// The repository the source is in: the "Source code" links, and the address the "Try it" commands clone.
var REPO_URL = "https://github.com/salitaba/agent-mesh";
var APP_URL = ""; // No hosted dashboard: the "Sign in" link is removed
var CONTACT_HREF = "mailto:ali79taba@gmail.com"; // "Talk to us" and the paid plans
// Off until the first release tag has published the image to ghcr.io: a command that pulls it fails until then. Switch it to
// true on the day of the release and the "Try it" steps also show the pull-and-run path.
var IMAGE_RELEASED = false;
var IMAGE_NAME = "ghcr.io/salitaba/curule";

(function () {
  var all = function (selector) { return Array.prototype.slice.call(document.querySelectorAll(selector)); };
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
