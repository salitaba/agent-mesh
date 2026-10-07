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

  // Text as a reader compares it: in lower case, with curly apostrophes straight, and any run of space as one.
  var plain = function (text) { return String(text).toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, " "); };
  var words = function (query) { return plain(query).split(" ").filter(Boolean); };
  // A document matches a filter when every word typed is somewhere in its text (its title, what it is for, its label, its path
  // and the group it is in), as a whole word or a piece of one. Nothing typed matches everything.
  var docMatches = function (text, query) {
    var hay = plain(text);
    return words(query).every(function (word) { return hay.indexOf(word) >= 0; });
  };

  // Whether the header shows its line and its blur: once the page has moved off its top by more than the shake of a thumb.
  var scrolledOff = function (y) { return y > 4; };
  // Where a child comes in a group that arrives together: 0 to 5, so that a long row of cards is not a long wait for the last one.
  var staggerOf = function (index) { return Math.max(0, Math.min(index, 5)); };
  // Whether something is hidden to arrive when the reader gets to it: only what is below the first screen. What can be seen already is
  // never hidden and shown again.
  var startsHidden = function (top, windowHeight) { return top > windowHeight; };
  // A node's classes with one added or taken away.
  var withClass = function (names, name, on) {
    var list = String(names || "").split(/\s+/).filter(Boolean);
    var at = list.indexOf(name);
    if (on && at < 0) list.push(name);
    if (!on && at >= 0) list.splice(at, 1);
    return list.join(" ");
  };
  // A node's classes without the ones that made it arrive (rv, rv-in, rv-1 ... rv-5).
  var withoutArrival = function (names) {
    return String(names || "").split(/\s+/).filter(function (name) { return name && !/^rv(-|$)/.test(name); }).join(" ");
  };

  // The pure parts, for the tests, when the file is loaded as a module; in a browser nothing is exported.
  if (typeof module === "object" && module !== null && typeof module.exports === "object") {
    module.exports = { readingAt: readingAt, docMatches: docMatches, scrolledOff: scrolledOff, staggerOf: staggerOf, startsHidden: startsHidden, withClass: withClass, withoutArrival: withoutArrival };
  }
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
  // Curule Cloud: while it is open the links into it have their addresses and the sentences that say it is not offered give way
  // to the ones that say it is, and while it is not, the reverse. The pages are written in this state already (scripts/set-domain.mjs
  // does it when CLOUD_URL is set, so that nothing moves after the first paint and a page with no script says the same), so for a
  // page that is right this changes nothing; it puts right one that is not. Nothing is fetched: a visitor who follows "Sign in"
  // lands on the account pages, which send someone who is already signed in on to their account.
  var cloud = CLOUD_URL.replace(/\/+$/, "");
  var CLOUD_PATH = { home: "/", login: "/login", signup: "/signup", terms: "/terms", privacy: "/privacy" };
  all("[data-cloud]").forEach(function (a) {
    var path = CLOUD_PATH[a.getAttribute("data-cloud")];
    if (path === undefined) return;
    a.href = CLOUD_URL ? cloud + path : "#";
    a.hidden = !CLOUD_URL;
  });
  all("[data-cloud-only]").forEach(function (node) { node.hidden = !CLOUD_URL; });
  all("[data-selfhost-only]").forEach(function (node) { node.hidden = !!CLOUD_URL; });
  // Two sign-in links would ask a visitor which one is theirs: the account is what the site offers.
  if (CLOUD_URL) all("[data-app]").forEach(function (a) { a.hidden = true; });
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
    // A button that copies what `text()` returns. It says "Copied" for a moment, and says so to a screen reader through the live
    // region, whose words are `spoken`; its name is `label`. When the browser does not allow it, it says so and where to look.
    var copyButton = function (label, spoken, text) {
      var button = el("button", "copy", "Copy");
      button.type = "button";
      button.setAttribute("aria-label", label);
      var timer = 0;
      var say = function (shown, said, done) {
        button.textContent = shown;
        button.className = done ? "copy is-done" : "copy";
        status.textContent = said;
        window.clearTimeout(timer);
        timer = window.setTimeout(function () { button.textContent = "Copy"; button.className = "copy"; status.textContent = ""; }, 2200);
      };
      button.addEventListener("click", function () {
        navigator.clipboard.writeText(text()).then(
          function () { say("Copied", spoken, true); },
          function () { say("Not copied", "The browser did not allow copying; select the text instead"); }
        );
      });
      return button;
    };
    all(".code").forEach(function (box) {
      var pre = box.querySelector("pre");
      if (!pre || box.querySelector(".copy")) return;
      var bar = el("div", "code-bar");
      bar.appendChild(copyButton("Copy these commands", "Copied to the clipboard", function () { return pre.textContent.replace(/\s+$/, ""); }));
      box.insertBefore(bar, box.firstChild);
    });
    // An address to write to is copied in one tap: on a phone with no mail program set up, or with webmail, the link opens nothing
    // useful, and a copied address goes where the person's mail is. The address stays text and a link without a script.
    all("a[data-mail]").forEach(function (link) {
      var address = link.textContent.trim();
      if (!/^[^\s@]+@[^\s@]+$/.test(address) || (link.nextSibling && link.nextSibling.className === "copy")) return;
      var kind = link.getAttribute("data-mail");
      link.parentNode.insertBefore(copyButton("Copy the " + kind + " address", "Copied the " + kind + " address to the clipboard", function () { return address; }), link.nextSibling);
    });
  }

  // The header is pinned once the script has run, and shows its line and its blur only while the page is away from its top (the
  // stylesheet draws both from these two classes), so at rest it is part of the page, and a page without the script has a header that
  // scrolls away like the rest of it.
  var header = document.querySelector(".site-header");
  if (header && typeof window.addEventListener === "function" && typeof window.requestAnimationFrame === "function") {
    header.className = withClass(header.className, "is-live", true);
    var away = null;
    var settle = function () {
      var now = scrolledOff(window.scrollY || 0);
      if (now === away) return;
      away = now;
      header.className = withClass(header.className, "is-scrolled", now);
    };
    var settling = false;
    window.addEventListener("scroll", function () {
      if (settling) return;
      settling = true;
      window.requestAnimationFrame(function () {
        settling = false;
        settle();
      });
    }, { passive: true });
    settle();
  }

  // What is below the first screen arrives as the reader gets to it: a short rise and a fade, once, the children of a group one after
  // another. The stylesheet hides nothing by itself (.rv is added here, and only for a visitor who has not asked for less), so a page
  // that this does not run on is whole. What is already in view is left alone.
  var GROUP = /\b(ways|bento|steps|tiles|teaser|plans|starts|doc-grid|try|grid)\b/;
  if (!reducedMotion() && typeof window.IntersectionObserver === "function" && typeof window.innerHeight === "number") {
    var arrival = new window.IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var node = entry.target;
        arrival.unobserve(node);
        node.className = withClass(node.className, "rv-in", true);
        window.setTimeout(function () { node.className = withoutArrival(node.className); }, 800);
      });
    }, { rootMargin: "0px 0px -48px 0px" });
    var arrive = function (parent) {
      Array.prototype.forEach.call(parent.children, function (child, i) {
        if (GROUP.test(child.className || "")) return arrive(child);
        if (typeof child.getBoundingClientRect !== "function" || !startsHidden(child.getBoundingClientRect().top, window.innerHeight)) return;
        var step = staggerOf(i);
        child.className = withClass(withClass(child.className, "rv", true), "rv-" + step, step > 0);
        arrival.observe(child);
      });
    };
    all(".section").forEach(function (section) { within(section, ".wrap").forEach(arrive); });
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
    // Nothing being read (the reader is back at the top): the row goes back to its first chips, as it is at rest.
    var rewind = function () {
      if (!row.scrollLeft) return;
      if (typeof row.scrollTo === "function") row.scrollTo({ left: 0, behavior: reducedMotion() ? "auto" : "smooth" });
      else row.scrollLeft = 0;
    };
    var mark = function (i) {
      if (i === current) return;
      current = i;
      chips.forEach(function (a, j) {
        if (j === i) a.setAttribute("aria-current", "true");
        else a.removeAttribute("aria-current");
      });
      if (i >= 0) reveal(chips[i]);
      else rewind();
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
    // The observer says when a section's top crosses the line, which is not said when a jump passes whole sections at once (Back to top
    // under reduced motion goes from the last section to the top in one step), so the reading position is looked at as the window
    // scrolls too, once a frame, and the bar never says the reader is somewhere they are not.
    var checking = false;
    window.addEventListener("scroll", function () {
      if (checking) return;
      checking = true;
      window.requestAnimationFrame(function () {
        checking = false;
        spy();
      });
    }, { passive: true });
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

  // Back to top: once the reader is about two screens down a page and turns back (scrolls up), or has come to the end of the content,
  // a button in the corner goes back to the start, and takes the keyboard's focus to the top of the content too, so that Tab carries
  // on from there. While the reader is going down it is not there: in the corner of a phone it would sit on the end of the lines
  // being read. It sits at the end of the page's main content and stays at the bottom of the window only while that content is in
  // view, so it never covers the footer's links.
  var main = document.getElementById("main");
  if (main && typeof window.addEventListener === "function" && typeof window.scrollTo === "function") {
    var dock = el("div", "to-top-dock");
    var up = el("button", "to-top");
    up.setAttribute("type", "button");
    up.append(el("span", "sr", "Back to top"));
    dock.append(up);
    main.append(dock);
    var shown = false;
    var looking = false;
    var turning = false; // the last movement of eight pixels or more was upward
    var from = window.scrollY || 0; // where that movement ended: a few pixels of shake do not turn the reader round
    // The end of the content has been reached when the dock is in its place, above the bottom of the window, and not riding at it.
    var atEnd = function () {
      return typeof dock.getBoundingClientRect === "function" && dock.getBoundingClientRect().top < window.innerHeight - 1;
    };
    var look = function () {
      looking = false;
      var y = window.scrollY;
      if (Math.abs(y - from) >= 8) {
        turning = y < from;
        from = y;
      }
      var now = y > 2 * window.innerHeight && (turning || atEnd());
      if (now === shown) return;
      shown = now;
      up.className = shown ? "to-top is-shown" : "to-top";
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

  // The documentation page's filter: what is typed keeps the documents that have every word, hides a group with none left, and
  // says how many are left, after a pause in the typing so that a screen reader is not read every keystroke. It works on the page
  // as it is and asks nothing of anyone. Without a script the field is not there and every document is shown.
  var filter = document.getElementById("doc-filter");
  if (filter) {
    var field = document.getElementById("doc-filter-input");
    var count = document.getElementById("doc-filter-count");
    var none = document.getElementById("doc-filter-none");
    var said = document.getElementById("doc-filter-said");
    var groups = all(".doc-card").map(function (card) {
      var name = card.querySelector("h2");
      var about = card.querySelector("p");
      var group = (name ? name.textContent : "") + " " + (about ? about.textContent : "");
      return { card: card, docs: within(card, ".doc-list li").map(function (li) { return { node: li, text: li.textContent + " " + group }; }) };
    });
    var total = groups.reduce(function (n, g) { return n + g.docs.length; }, 0);
    var saying = 0;
    var tell = function (shown, filtering) { count.textContent = filtering ? shown + " of " + total + " documents" : "All " + total + " documents"; };
    var apply = function () {
      var query = field.value;
      var shown = 0;
      groups.forEach(function (g) {
        var left = 0;
        g.docs.forEach(function (doc) {
          var match = docMatches(doc.text, query);
          doc.node.hidden = !match;
          if (match) left++;
        });
        g.card.hidden = left === 0;
        shown += left;
      });
      var filtering = words(query).length > 0;
      none.hidden = shown > 0;
      said.textContent = query.trim();
      window.clearTimeout(saying);
      saying = window.setTimeout(function () { tell(shown, filtering); }, 400);
    };
    var clear = function () {
      field.value = "";
      apply();
    };
    field.addEventListener("input", apply);
    field.addEventListener("keydown", function (event) {
      if (event.key !== "Escape" || !field.value) return;
      event.preventDefault();
      clear();
    });
    document.getElementById("doc-filter-clear").addEventListener("click", function () {
      clear();
      field.focus();
    });
    tell(total, false);
    filter.hidden = false;
  }

  // The phone menu closes when a link in it is followed (on the same page) and on Escape. It closes too when the reader touches
  // the page anywhere else, and when Tab takes the focus out of it: an open panel is never left over the page, where it would
  // hide the very link the keyboard has moved to.
  all(".menu").forEach(function (menu) {
    menu.addEventListener("click", function (event) {
      var target = event.target;
      if (target && target.closest && target.closest("a")) menu.removeAttribute("open");
    });
    document.addEventListener("pointerdown", function (event) {
      if (menu.open && !menu.contains(event.target)) menu.open = false;
    });
    menu.addEventListener("focusout", function (event) {
      if (menu.open && event.relatedTarget && !menu.contains(event.relatedTarget)) menu.open = false;
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
