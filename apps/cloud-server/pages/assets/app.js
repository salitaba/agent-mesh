/*
 * The account pages' one script.
 *
 * It speaks to this service's own API and to nothing else; the pages' content security policy would refuse any other address.
 * Everything it puts on a page is a text node or an element it made, never markup built from a string, so nothing the API or a
 * person sends can become code. It keeps nothing in the browser that matters: the session is a cookie the page cannot read, and
 * what a page shows is what the API says when the page asks. (The one thing it remembers, in the tab, is what the account looked
 * like before a payment, so the page can tell on return whether the payment has been applied.)
 *
 * What each page needs from its own markup is listed in NEEDS, and a test compares that list with the pages, so a page and this
 * script cannot drift apart without the build failing. The pure parts (money, dates, amounts, addresses) are exported for the
 * tests when the file is loaded as a module; in a browser nothing is exported.
 */
(function () {
  "use strict";

  const LOCALE = "en";

  /**
   * Where people write for help, as a "mailto:" or an "https:" address: the operator's own, given by them. The footer's
   * Contact link stays hidden while this is empty.
   */
  const CONTACT = "mailto:ali79taba@gmail.com";

  const NEEDS = {
    home: ["plans", "topups"],
    signup: ["card", "form", "status", "email", "password", "agree"],
    login: ["form", "status", "email", "password"],
    verify: ["status", "again"],
    forgot: ["form", "status", "email"],
    reset: ["card", "form", "status", "password"],
    account: ["who", "notice", "workspaces", "create", "workspace-name", "create-note", "plan-status", "plan", "figures", "topup", "topup-amount", "topup-hint", "topup-status", "topup-options", "usage", "password-form", "password-status", "current", "next"],
    terms: [],
    privacy: [],
  };

  // ---- numbers, money, dates and addresses ----

  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  /** How many places after the point a currency's smallest unit has: 2 for dollars, 0 for yen. */
  function digitsOf(currency) {
    try {
      return new Intl.NumberFormat(LOCALE, { style: "currency", currency }).resolvedOptions().maximumFractionDigits;
    } catch {
      return 2;
    }
  }

  function format(amount, currency, least, most) {
    try {
      return new Intl.NumberFormat(LOCALE, { style: "currency", currency, minimumFractionDigits: least, maximumFractionDigits: most }).format(amount);
    } catch {
      return `${amount.toFixed(most)} ${currency}`;
    }
  }

  /** An amount in a currency's minor units (cents): 1900 USD is $19.00. */
  function money(minor, currency) {
    const d = digitsOf(currency);
    return format(minor / 10 ** d, currency, d, d);
  }

  /** An amount of usage, in millionths of a unit of the currency. One call can cost a fraction of a cent, so small amounts keep four places. */
  function usageMoney(micros, currency) {
    const d = digitsOf(currency);
    return format(micros / 1e6, currency, d, Math.max(d, 4));
  }

  /** What is left to spend, in whole minor units and rounded down, so the page never promises a fraction of a cent it cannot give. */
  function balanceMoney(micros, currency) {
    const d = digitsOf(currency);
    return format(Math.floor(micros / 10 ** (6 - d)) / 10 ** d, currency, d, d);
  }

  const count = (n) => new Intl.NumberFormat(LOCALE).format(n);

  /** A moment, as the day it falls on for the reader. */
  function when(iso) {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? "" : new Date(t).toLocaleDateString(LOCALE, { year: "numeric", month: "long", day: "numeric" });
  }

  /** The day a usage row is for. Days are UTC days, so they are shown as that day and not shifted into the reader's zone. */
  function dayLabel(group) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(group)) return group;
    return new Date(`${group}T00:00:00Z`).toLocaleDateString(LOCALE, { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" });
  }

  /** What a person typed for an amount, as minor units, or null when it is not an amount in that currency. */
  function parseAmount(raw, digits) {
    const m = /^(\d{1,9})(?:[.,](\d{1,9}))?$/.exec(String(raw).trim());
    if (!m) return null;
    const fraction = m[2] || "";
    if (fraction.length > digits) return null;
    return Number(m[1]) * 10 ** digits + Number(`${fraction}${"0".repeat(digits)}`.slice(0, digits) || 0);
  }

  const NEXT_OK = /^\/account(?:\?[\w=&-]*)?$/;

  /** Where to go after signing in: the account page, or the page the person was sent from when it is one of ours. */
  function nextPath(search) {
    const next = new URLSearchParams(search).get("next");
    return next !== null && NEXT_OK.test(next) ? next : "/account";
  }

  /** An address the page may send the person to, or null. Only http and https; nothing else a response says is followed. */
  function outsideUrl(value) {
    if (typeof value !== "string") return null;
    try {
      const u = new URL(value);
      return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
    } catch {
      return null;
    }
  }

  const REASONS = {
    "paused by its owner": "You paused it.",
    "payment is overdue": "Stopped because the last payment did not go through.",
    "the subscription ended": "Stopped because the subscription ended.",
  };

  /** Why a workspace is in the state it is in, said to the person it belongs to. */
  function reasonText(reason) {
    if (!reason) return "";
    if (REASONS[reason]) return REASONS[reason];
    return `${reason.charAt(0).toUpperCase()}${reason.slice(1)}${/[.!?]$/.test(reason) ? "" : "."}`;
  }

  const STATES = {
    running: ["Running", "ok"],
    suspended: ["Stopped", ""],
    requested: ["Starting", "warn"],
    provisioning: ["Starting", "warn"],
    failed: ["Could not start", "bad"],
  };

  const isStarting = (w) => w.status === "requested" || w.status === "provisioning";

  const POLICY_UNITS = { graceDays: "day", retentionDays: "day", sessionDays: "day", idleDays: "day", verificationHours: "hour", resetHours: "hour" };

  /** What a plan includes, one fact to a line. */
  function planFacts(plan, currency) {
    const facts = [`${usageMoney(plan.includedUsageMicros, currency)} of model usage each ${plan.period}`, plural(plan.workspaces, "workspace")];
    if (Array.isArray(plan.tiers) && plan.tiers.length > 0) facts.push(`Model tiers: ${plan.tiers.join(", ")}`);
    return facts;
  }

  /** What the account looks like in the ways a payment changes it. */
  function fingerprint(me) {
    const sub = me.account.subscription;
    const b = me.balance;
    return JSON.stringify([sub && [sub.plan, sub.status, sub.periodEnd], b && [b.balance.included, b.balance.purchased]]);
  }

  const exported = { NEEDS, plural, digitsOf, money, usageMoney, balanceMoney, count, when, dayLabel, parseAmount, nextPath, outsideUrl, reasonText, planFacts, fingerprint, isStarting, STATES, POLICY_UNITS };
  if (typeof module === "object" && module !== null && typeof module.exports === "object") module.exports = exported;
  if (typeof document === "undefined") return;

  // ---- the page ----

  const doc = document;
  const $ = (id) => doc.getElementById(id);

  /** An element, made the safe way: attributes by name, children as elements or text. */
  function el(tag, attrs, ...kids) {
    const node = doc.createElement(tag);
    for (const [name, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (name === "class") node.className = value;
      else if (name.startsWith("on") && typeof value === "function") node.addEventListener(name.slice(2), value);
      else node.setAttribute(name, value === true ? "" : String(value));
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) node.append(kid);
    return node;
  }

  function button(label, o = {}) {
    const classes = ["btn", o.kind ? `btn-${o.kind}` : "", o.small ? "btn-small" : ""].filter(Boolean).join(" ");
    return el("button", { type: o.type || "button", id: o.id, class: classes, disabled: o.disabled, onclick: o.onclick }, label);
  }

  /** Say something in a status area, or clear it. */
  function say(node, kind, text) {
    node.className = kind ? `note note-${kind}` : "note";
    node.textContent = text || "";
  }

  /** The quiet line under a form, which turns into a note when there is something to say. */
  function hint(node, kind, text) {
    node.className = kind ? `note note-${kind}` : "muted small";
    node.textContent = text || "";
  }

  /** A field that cannot be sent as it is: say why, mark it, and put the cursor in it. Returns false, so a check can `return invalid(...)`. */
  function invalid(input, status, text) {
    say(status, "bad", text);
    input.setAttribute("aria-invalid", "true");
    input.focus();
    return false;
  }

  // ---- the API ----

  /** One call to this service. It never throws: a failure is a reply with `ok: false` and an error that is fit to show. */
  async function call(method, path, body) {
    let response;
    try {
      response = await fetch(path, {
        method,
        credentials: "same-origin",
        headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      return { ok: false, status: 0, data: null, error: { code: "offline", message: "The service could not be reached. Check your connection and try again." } };
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    // Every answer this service gives is a JSON object. A success that is not one was cut short, and is no success.
    if (response.ok && data !== null && typeof data === "object") return { ok: true, status: response.status, data, error: null };
    if (response.ok) return { ok: false, status: response.status, data: null, error: { code: "unreadable", message: "The service's answer could not be read. Try again in a moment." } };
    const said = data && data.error && typeof data.error.message === "string" ? data.error : null;
    const fallback = response.status >= 500 ? "Something went wrong on our side. Try again in a moment." : "The request was not accepted.";
    return { ok: false, status: response.status, data, error: { code: said ? said.code : `http_${response.status}`, message: said ? said.message : fallback } };
  }

  const signedOut = (r) => r.status === 401 && r.error.code === "not_signed_in";

  let plansReply = null;
  /** The plans, asked for once per page however many parts of it want them. */
  function plans() {
    if (plansReply === null) plansReply = call("GET", "/api/plans");
    return plansReply;
  }

  /** A form whose submit is handled here: no double sends, buttons held while a call is out, and a failure that says so. */
  function onSubmit(node, status, handler) {
    let busy = false;
    node.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (busy) return;
      busy = true;
      const buttons = [...node.querySelectorAll("button")];
      for (const b of buttons) b.disabled = true;
      node.setAttribute("aria-busy", "true");
      try {
        await handler();
      } catch (err) {
        console.error(err);
        say(status, "bad", "Something went wrong in this page. Reload it and try again.");
      } finally {
        busy = false;
        for (const b of buttons) b.disabled = false;
        node.removeAttribute("aria-busy");
      }
    });
  }

  /** Leave for an address the API returns (a payment page, a workspace), or put the button back and say why not. `before` runs just ahead of the request. */
  async function leaveFor(trigger, request, failed, before) {
    const label = trigger.textContent;
    trigger.disabled = true;
    trigger.textContent = "One moment";
    if (before) before();
    const r = await request();
    const url = r.ok ? outsideUrl(r.data && r.data.url) : null;
    if (url) {
      location.assign(url);
      return;
    }
    trigger.disabled = false;
    trigger.textContent = label;
    // An answer that is fine but names no address this page will follow is a failure like any other, and is said as one.
    failed(r.ok ? { ok: false, status: r.status, data: r.data, error: { code: "bad_address", message: "The page we were meant to send you to could not be opened. Try again in a moment." } } : r);
  }

  // ---- the header, the footer and the numbers every page shares ----

  function paintChrome(me, page) {
    const signedIn = me !== null;
    for (const node of doc.querySelectorAll("[data-when]")) node.hidden = (node.dataset.when === "in") !== signedIn;
    const here = page === "home" ? "home" : page === "account" ? "account" : "";
    for (const a of doc.querySelectorAll("[data-nav]")) {
      if (a.dataset.nav === here) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
    for (const out of doc.querySelectorAll('[data-action="signout"]')) {
      out.addEventListener("click", async () => {
        out.disabled = true;
        const r = await call("POST", "/api/logout");
        if (r.ok || signedOut(r)) {
          location.assign("/");
          return;
        }
        out.disabled = false;
        out.textContent = "Try signing out again";
      });
    }
    if (/^(mailto:|https:)/.test(CONTACT)) {
      for (const a of doc.querySelectorAll("[data-contact]")) {
        a.href = CONTACT;
        a.hidden = false;
      }
    }
  }

  /** The periods the pages mention are the service's own settings, so the pages ask for them. */
  async function paintPolicy() {
    const nodes = [...doc.querySelectorAll("[data-policy]")];
    if (nodes.length === 0) return;
    const r = await plans();
    if (!r.ok || !r.data.policy) return;
    for (const node of nodes) {
      const n = r.data.policy[node.dataset.policy];
      const unit = POLICY_UNITS[node.dataset.policy];
      if (typeof n === "number" && unit) node.textContent = plural(n, unit);
    }
  }

  function planCard(plan, currency, o) {
    const sub = o.subscription;
    const current = Boolean(sub) && sub.status !== "ended" && sub.plan === plan.id;
    return el(
      "article",
      { class: current ? "plan current" : "plan" },
      el("h3", null, plan.title, current ? el("span", { class: "badge badge-ok" }, "Your plan") : null),
      el("div", { class: "price" }, money(plan.priceMinor, currency), el("small", null, ` per ${plan.period}`)),
      plan.summary ? el("p", { class: "muted" }, plan.summary) : null,
      el("ul", null, planFacts(plan, currency).map((fact) => el("li", null, fact))),
      current ? null : o.action(plan),
    );
  }

  function topupLine(topups, currency) {
    const d = digitsOf(currency);
    const rate = (topups.usageMicrosPerMinor * 10 ** d) / 1e6;
    return `Add credit at any time, from ${money(topups.minimumMinor, currency)} to ${money(topups.maximumMinor, currency)} at once. Each ${money(10 ** d, currency)} adds ${format(rate, currency, d, Math.max(d, 4))} of usage, and credit does not expire.`;
  }

  // ---- the front page ----

  async function homePage(me) {
    const box = $("plans");
    box.textContent = "Loading the plans.";
    const r = await plans();
    if (!r.ok || r.data.plans.length === 0) {
      box.replaceChildren(el("p", { class: "note note-warn" }, r.ok ? "No plan is on offer just now." : "The plans could not be loaded just now. Reload the page to try again."));
      return;
    }
    const { currency, topups } = r.data;
    const subscription = me ? me.subscription : null;
    const action = me ? () => el("a", { class: "btn", href: "/account#plan-h" }, "Choose in your account") : () => el("a", { class: "btn btn-primary", href: "/signup" }, "Get started");
    box.replaceChildren(...r.data.plans.map((plan) => planCard(plan, currency, { subscription, action })));
    $("topups").textContent = topupLine(topups, currency);
  }

  // ---- signing up and in ----

  function checkEmailAndPassword(email, password, status, o = {}) {
    if (!email.value.trim()) return invalid(email, status, "Enter your email address.");
    if (!password.value) return invalid(password, status, "Enter your password.");
    if (o.chosen && password.value.length < 10) return invalid(password, status, "Choose a password of at least 10 characters.");
    return true;
  }

  function signupPage(me) {
    if (me) {
      location.replace("/account");
      return;
    }
    const status = $("status");
    const email = $("email");
    const password = $("password");
    onSubmit($("form"), status, async () => {
      say(status, "", "");
      if (!checkEmailAndPassword(email, password, status, { chosen: true })) return;
      if (!$("agree").checked) {
        say(status, "bad", "Agree to the Terms and the Privacy notice to continue.");
        $("agree").focus();
        return;
      }
      const address = email.value.trim();
      const r = await call("POST", "/api/signup", { email: address, password: password.value });
      if (!r.ok) {
        say(status, "bad", r.error.message);
        return;
      }
      const card = $("card");
      card.replaceChildren(
        el("div", { class: "note note-ok", role: "status" }, r.data.message),
        el("p", null, "We sent the link to ", el("strong", null, address), ". It works once, and the email says when it expires."),
        el("p", { class: "muted small" }, "It can take a minute. Look in your spam folder if it has not come. To use another address, ", el("a", { href: "/signup" }, "start again"), "."),
      );
      card.setAttribute("tabindex", "-1");
      card.focus();
    });
  }

  function loginPage(me) {
    if (me) {
      location.replace(nextPath(location.search));
      return;
    }
    const status = $("status");
    const email = $("email");
    const password = $("password");
    onSubmit($("form"), status, async () => {
      say(status, "", "");
      if (!checkEmailAndPassword(email, password, status)) return;
      const r = await call("POST", "/api/login", { email: email.value.trim(), password: password.value });
      if (r.ok) {
        location.assign(nextPath(location.search));
        return;
      }
      say(status, "bad", r.error.message);
      password.value = "";
      password.focus();
    });
  }

  async function verifyPage() {
    const status = $("status");
    const token = new URLSearchParams(location.search).get("token");
    const failed = (text) => {
      say(status, "bad", text);
      $("again").hidden = false;
    };
    if (!token) {
      failed("This link is incomplete. Open the link in the email again.");
      return;
    }
    const r = await call("POST", "/api/verify", { token });
    // The link is spent now, or was no good: either way it has no place in the address bar or the history.
    history.replaceState(null, "", "/verify");
    if (!r.ok) {
      failed(r.error.message);
      return;
    }
    say(status, "ok", "Your address is confirmed. Taking you to your account.");
    location.replace("/account");
  }

  function forgotPage() {
    const status = $("status");
    const email = $("email");
    onSubmit($("form"), status, async () => {
      say(status, "", "");
      if (!email.value.trim()) return invalid(email, status, "Enter your email address.");
      const r = await call("POST", "/api/forgot", { email: email.value.trim() });
      say(status, r.ok ? "ok" : "bad", r.ok ? r.data.message : r.error.message);
    });
  }

  function resetPage() {
    const status = $("status");
    const password = $("password");
    const token = new URLSearchParams(location.search).get("token");
    const askAgain = () => el("p", null, el("a", { class: "btn", href: "/forgot" }, "Ask for a new link"));
    if (!token) {
      say(status, "bad", "This link is incomplete. Open the link in the email again, or ask for a new one.");
      $("card").append(askAgain());
      return;
    }
    // The form is hidden in the markup, so that nobody sees one that has no link to go with it.
    $("form").hidden = false;
    onSubmit($("form"), status, async () => {
      say(status, "", "");
      if (password.value.length < 10) return invalid(password, status, "Choose a password of at least 10 characters.");
      const r = await call("POST", "/api/reset", { token, password: password.value });
      if (!r.ok) {
        say(status, "bad", r.error.message);
        if (r.error.code === "invalid_token") $("card").append(askAgain());
        return;
      }
      history.replaceState(null, "", "/reset");
      $("card").replaceChildren(el("div", { class: "note note-ok", role: "status" }, "Your password is changed. Every device is signed out."), el("p", null, el("a", { class: "btn btn-primary", href: "/login" }, "Sign in")));
    });
  }

  // ---- the account ----

  const store = {
    get(key) {
      try {
        return window.sessionStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        window.sessionStorage.setItem(key, value);
      } catch {
        // A browser that keeps nothing is a browser that cannot tell, on return, whether a payment has landed. The page waits instead.
      }
    },
    remove(key) {
      try {
        window.sessionStorage.removeItem(key);
      } catch {
        // As above.
      }
    },
  };

  const BEFORE_PAYMENT = "curule:before-payment";
  /** How many days of usage the table by day shows. */
  const USAGE_DAYS = 14;
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const SIGN_IN = "/login?next=/account";

  async function accountPage(signedIn) {
    if (!signedIn) {
      location.replace(SIGN_IN);
      return;
    }
    // The header needed only to know who this is; the account needs the balance too.
    const first = await call("GET", "/api/me");
    if (!first.ok) {
      if (signedOut(first)) location.replace(SIGN_IN);
      else say($("notice"), "bad", `${first.error.message} Reload the page to try again.`);
      return;
    }
    const state = {
      me: first.data,
      plans: [],
      plansKnown: false,
      currency: "USD",
      usageCurrency: "USD",
      topups: null,
      policy: null,
      busy: new Set(),
      notes: new Map(),
      confirming: null,
      typed: "",
      flash: null,
      planNote: null,
      timer: 0,
      watched: 0,
    };

    const offered = await plans();
    if (offered.ok) {
      state.plans = offered.data.plans;
      state.plansKnown = true;
      state.currency = offered.data.currency;
      state.topups = offered.data.topups;
      state.policy = offered.data.policy;
    }

    const account = () => state.me.account;
    const subscription = () => account().subscription;
    const standing = () => {
      const sub = subscription();
      return !sub || sub.status === "ended" ? "none" : sub.status;
    };
    const planOf = () => (subscription() ? state.plans.find((p) => p.id === subscription().plan) : undefined);
    const nameOf = (id) => {
      const w = account().workspaces.find((x) => x.workspaceId === id);
      return w ? w.name : id === "" ? "No workspace" : "A deleted workspace";
    };
    const signInAgain = (r) => {
      if (!signedOut(r)) return false;
      location.replace(SIGN_IN);
      return true;
    };

    // -- the top of the page --

    function renderNotice() {
      const node = $("notice");
      if (state.flash) {
        say(node, state.flash.kind, state.flash.text);
        return;
      }
      const sub = subscription();
      const b = state.me.balance;
      if (sub && sub.status === "past_due") {
        const days = state.policy ? state.policy.graceDays : null;
        const ends = days !== null && sub.pastDueSince ? when(new Date(Date.parse(sub.pastDueSince) + days * 86_400_000).toISOString()) : "";
        say(node, "warn", `The last payment did not go through. ${ends ? `Your workspaces keep running until ${ends} and are then stopped.` : "Your workspaces are stopped after a short grace period."} A payment before then puts everything back.`);
      } else if (sub && sub.status === "ended") {
        const days = state.policy ? ` ${plural(state.policy.retentionDays, "day")}` : "";
        say(node, "warn", `Your subscription has ended and your workspaces are stopped. They are deleted${days} after it ended. Choose a plan again before then and they start again.`);
      } else if (sub && b && b.balance.available <= 0) {
        say(node, "warn", "Your balance is used up. Calls to models are refused until you add credit or your plan renews, and a mesh that needs them pauses with a notice that says why.");
      } else {
        say(node, "", "");
      }
    }

    function flash(kind, text) {
      state.flash = { kind, text };
      renderNotice();
    }

    // -- workspaces --

    function setNote(workspaceId, kind, text) {
      if (text) state.notes.set(workspaceId, { kind, text });
      else state.notes.delete(workspaceId);
    }

    async function refresh() {
      const r = await call("GET", "/api/me");
      if (signInAgain(r)) return false;
      if (!r.ok) return false;
      state.me = r.data;
      renderAll();
      return true;
    }

    /** One thing a person asked of a workspace: the row says it is under way, the request goes, and the page shows what is now true. */
    async function act(w, doing, request, after) {
      state.flash = null;
      setNote(w.workspaceId, "", doing);
      state.busy.add(w.workspaceId);
      renderWorkspaces();
      const r = await request();
      state.busy.delete(w.workspaceId);
      if (signInAgain(r)) return;
      if (!r.ok) {
        setNote(w.workspaceId, "bad", r.error.message);
        if (!(await refresh())) renderWorkspaces();
        return;
      }
      setNote(w.workspaceId, "", "");
      if (after) after(r);
      if (!(await refresh())) renderWorkspaces();
    }

    const path = (w, action) => `/api/workspaces/${encodeURIComponent(w.workspaceId)}/${action}`;

    function open(w) {
      return act(
        w,
        "Opening it.",
        () => call("POST", path(w, "open")),
        (r) => {
          const url = outsideUrl(r.data && r.data.url);
          if (url) location.assign(url);
          else setNote(w.workspaceId, "bad", "The address of this workspace is not one this page will open. Tell the operator.");
        },
      );
    }

    function confirmBox(w) {
      const input = el("input", { id: `confirm-${w.workspaceId}`, type: "text", autocomplete: "off", value: state.typed });
      const go = button("Delete workspace", { type: "submit", kind: "danger", disabled: state.typed !== w.name });
      input.addEventListener("input", () => {
        state.typed = input.value;
        go.disabled = input.value !== w.name;
      });
      return el(
        "form",
        {
          class: "confirm",
          onsubmit: (event) => {
            event.preventDefault();
            if (state.typed !== w.name) return;
            act(w, "Deleting it.", () => call("POST", path(w, "delete"), { confirm: w.name }), () => {
              state.confirming = null;
              state.typed = "";
            });
          },
        },
        el("p", null, "Deleting ", el("strong", null, w.name), " removes it and everything in it. It cannot be undone."),
        el("label", { for: input.id, class: "small" }, "Type its name to confirm"),
        input,
        el(
          "div",
          { class: "btn-row" },
          go,
          button("Keep it", {
            onclick: () => {
              state.confirming = null;
              state.typed = "";
              renderWorkspaces();
            },
          }),
        ),
      );
    }

    function workspaceRow(w) {
      const [label, kind] = STATES[w.status] || [w.status, ""];
      const held = state.busy.has(w.workspaceId);
      const note = state.notes.get(w.workspaceId);
      const reason = reasonText(w.statusReason);
      const actions = [];
      if (w.status === "running") {
        actions.push(button("Open", { id: `open-${w.workspaceId}`, kind: "primary", disabled: held, onclick: () => open(w) }));
        actions.push(button("Pause", { id: `pause-${w.workspaceId}`, disabled: held, onclick: () => act(w, "Pausing it.", () => call("POST", path(w, "suspend"))) }));
      }
      if (w.status === "suspended") actions.push(button("Resume", { id: `resume-${w.workspaceId}`, kind: "primary", disabled: held, onclick: () => act(w, "Starting it.", () => call("POST", path(w, "resume"))) }));
      if (!isStarting(w)) {
        actions.push(
          button("Delete", {
            id: `delete-${w.workspaceId}`,
            kind: "danger",
            disabled: held,
            onclick: () => {
              state.confirming = w.workspaceId;
              state.typed = "";
              renderWorkspaces();
              const input = $(`confirm-${w.workspaceId}`);
              if (input) input.focus();
            },
          }),
        );
      }
      return el(
        "li",
        { class: "row" },
        el("div", { class: "row-head" }, el("strong", null, w.name), el("span", { class: kind ? `badge badge-${kind}` : "badge" }, label)),
        el("p", { class: "muted small" }, el("code", null, w.host), reason ? ` ${reason}` : isStarting(w) ? " It starts in the background, and this page updates when it is ready." : ""),
        actions.length > 0 ? el("div", { class: "btn-row" }, actions) : null,
        state.confirming === w.workspaceId ? confirmBox(w) : null,
        note ? el("p", { class: note.kind ? `note note-${note.kind}` : "muted small", role: "status" }, note.text) : null,
      );
    }

    function renderWorkspaces() {
      const list = $("workspaces");
      const focused = doc.activeElement && list.contains(doc.activeElement) ? doc.activeElement.id : "";
      const items = account().workspaces;
      const sub = subscription();
      const standingNow = standing();
      const plan = planOf();
      const live = items.filter((w) => w.status !== "failed").length;
      list.replaceChildren(...items.map(workspaceRow));
      if (items.length === 0) list.append(el("li", { class: "row" }, el("p", { class: "muted" }, "You have no workspace yet.")));

      const form = $("create");
      const note = $("create-note");
      if (standingNow === "none") {
        form.hidden = true;
        hint(note, "", sub ? "Choose a plan below to create a workspace." : "Choose a plan below to create your first workspace.");
      } else if (standingNow === "past_due") {
        form.hidden = true;
        hint(note, "", "The last payment did not go through. Update your payment details to create a workspace.");
      } else if (plan && live >= plan.workspaces) {
        form.hidden = true;
        hint(note, "", `Your plan includes ${plural(plan.workspaces, "workspace")}. Delete one to make room, or choose a larger plan.`);
      } else {
        form.hidden = false;
        // What went wrong with the last attempt stays until the next one.
        if (!note.className.includes("note-bad")) hint(note, "", "");
      }
      restoreFocus(focused);
    }

    function restoreFocus(id) {
      const target = id ? $(id) : null;
      if (target) target.focus();
    }

    /** While a workspace is starting the page asks again every few seconds, for ten minutes at most, and not while the tab is hidden. */
    function watch() {
      if (state.timer !== 0 || state.watched >= 200 || !account().workspaces.some(isStarting)) return;
      state.timer = setTimeout(async () => {
        state.timer = 0;
        if (doc.visibilityState !== "hidden") {
          state.watched++;
          await refresh();
        }
        watch();
      }, 3000);
    }

    // -- plan --

    function renderPlan() {
      const box = $("plan");
      const sub = subscription();
      const parts = [];
      if (sub) {
        const label = sub.status === "ended" ? ["Ended", "bad"] : sub.status === "past_due" ? ["Payment overdue", "warn"] : sub.status === "active" ? ["Active", "ok"] : [sub.status, ""];
        parts.push(
          el(
            "div",
            { class: "row" },
            el("div", { class: "row-head" }, el("strong", null, sub.title), el("span", { class: label[1] ? `badge badge-${label[1]}` : "badge" }, label[0])),
            sub.status !== "ended" && sub.periodEnd ? el("p", { class: "muted small" }, `Paid until ${when(sub.periodEnd)}.`) : null,
            sub.status !== "ended" ? el("div", { class: "btn-row" }, button("Manage billing", { small: true, onclick: (event) => leaveFor(event.currentTarget, () => call("POST", "/api/portal"), failedHere) })) : null,
          ),
        );
      }
      const live = sub && sub.status !== "ended";
      if (!state.plansKnown) {
        parts.push(el("p", { class: "muted" }, "The plans could not be loaded just now. Reload the page to try again."));
      } else if (state.plans.length > 0 && (!live || state.plans.length > 1)) {
        parts.push(
          el("h3", null, live ? "Change plan" : "Choose a plan"),
          el(
            "div",
            { class: "plans" },
            state.plans.map((plan) =>
              planCard(plan, state.currency, {
                subscription: sub,
                action: (p) => button(live ? `Switch to ${p.title}` : `Choose ${p.title}`, { kind: live ? "" : "primary", onclick: (event) => leaveFor(event.currentTarget, () => call("POST", "/api/checkout", { purpose: "subscription", plan: p.id }), failedHere, rememberBefore) }),
              }),
            ),
          ),
        );
      }
      box.replaceChildren(...parts);
      const status = $("plan-status");
      if (state.planNote) say(status, state.planNote.kind, state.planNote.text);
      else say(status, "", "");
    }

    function failedHere(r) {
      if (signInAgain(r)) return;
      state.planNote = { kind: "bad", text: r.error.message };
      say($("plan-status"), "bad", r.error.message);
    }

    function rememberBefore() {
      store.set(BEFORE_PAYMENT, fingerprint(state.me));
    }

    // -- balance and credit --

    function figure(label, value) {
      return el("div", null, el("dt", null, label), el("dd", null, value));
    }

    function renderBalance() {
      const b = state.me.balance;
      if (b === null) {
        $("figures").replaceChildren(figure("Available", "Not available just now"));
        return;
      }
      $("figures").replaceChildren(figure("Available", balanceMoney(b.balance.available, b.currency)), figure("From your plan", balanceMoney(b.balance.included, b.currency)), figure("From credit you added", balanceMoney(b.balance.purchased, b.currency)));
    }

    function renderTopups() {
      const t = state.topups;
      if (!t) {
        $("topup-hint").textContent = "";
        $("topup-options").replaceChildren();
        return;
      }
      const d = digitsOf(state.currency);
      const rate = (t.usageMicrosPerMinor * 10 ** d) / 1e6;
      $("topup-hint").textContent = `From ${money(t.minimumMinor, state.currency)} to ${money(t.maximumMinor, state.currency)}. Each ${money(10 ** d, state.currency)} adds ${format(rate, state.currency, d, Math.max(d, 4))} of usage, and credit does not expire.`;
      $("topup-options").replaceChildren(...t.optionsMinor.map((minor) => button(`Add ${money(minor, state.currency)}`, { small: true, onclick: (event) => payTopup(minor, event.currentTarget) })));
    }

    function payTopup(minor, trigger) {
      say($("topup-status"), "", "");
      return leaveFor(
        trigger,
        () => call("POST", "/api/checkout", { purpose: "topup", amountMinor: minor }),
        (r) => {
          if (!signInAgain(r)) say($("topup-status"), "bad", r.error.message);
        },
        rememberBefore,
      );
    }

    // -- usage --

    function usageTable(caption, heading, rows, total, showFailed) {
      const head = [heading, "Calls", ...(showFailed ? ["Failed"] : []), "Input tokens", "Output tokens", "Charged"];
      const cells = (row, label) => [label, count(row.calls), ...(showFailed ? [count(row.failed)] : []), count(row.inputTokens), count(row.outputTokens), usageMoney(row.chargedMicros, state.usageCurrency)];
      const line = (values, tag) => el("tr", null, values.map((v, i) => el(i === 0 ? "th" : tag, i === 0 ? { scope: "row" } : { class: "num" }, v)));
      // A table that can scroll sideways on a narrow screen must be reachable by keyboard, and say what it is.
      return el(
        "div",
        { class: "table-wrap", tabindex: 0, role: "region", "aria-label": caption },
        el(
          "table",
          null,
          el("caption", null, caption),
          el("thead", null, el("tr", null, head.map((h, i) => el("th", { scope: "col", class: i === 0 ? "" : "num" }, h)))),
          el("tbody", null, rows.map((row) => line(cells(row, row.label), "td"))),
          total ? el("tfoot", null, line(cells(total, "Total"), "td")) : null,
        ),
      );
    }

    async function loadUsage() {
      const box = $("usage");
      box.replaceChildren(el("p", { class: "muted" }, "Loading."));
      const r = await call("GET", "/api/usage");
      if (signInAgain(r)) return;
      if (!r.ok) {
        box.replaceChildren(el("p", { class: "note note-warn" }, r.error.message), button("Try again", { small: true, onclick: loadUsage }));
        return;
      }
      const u = r.data;
      state.usageCurrency = u.currency;
      if (u.total.calls === 0) {
        box.replaceChildren(el("p", { class: "muted" }, "Nothing has been used yet. Calls appear here when a mesh in one of your workspaces asks a model for something."));
        return;
      }
      const days = u.byDay
        .slice()
        .sort((a, b) => b.group.localeCompare(a.group))
        .slice(0, USAGE_DAYS)
        .map((row) => ({ ...row, label: dayLabel(row.group) }));
      const spaces = u.byWorkspace.map((row) => ({ ...row, label: nameOf(row.group) }));
      const showFailed = u.total.failed > 0;
      box.replaceChildren(usageTable(`By day, the last ${USAGE_DAYS} days with calls`, "Day", days, u.total, showFailed), usageTable("By workspace, in all", "Workspace", spaces, null, showFailed));
    }

    // -- everything that is drawn from the account --

    function renderAll() {
      $("who").textContent = `Signed in as ${account().email}`;
      renderNotice();
      renderWorkspaces();
      renderPlan();
      renderBalance();
      watch();
    }

    // -- forms --

    onSubmit($("create"), $("create-note"), async () => {
      const input = $("workspace-name");
      const note = $("create-note");
      const name = input.value.trim();
      if (!name) {
        input.setAttribute("aria-invalid", "true");
        input.focus();
        hint(note, "bad", "Give the workspace a name.");
        return;
      }
      const r = await call("POST", "/api/workspaces", { name });
      if (signInAgain(r)) return;
      if (!r.ok) {
        hint(note, "bad", r.error.message);
        return;
      }
      input.value = "";
      hint(note, "", "");
      if (!(await refresh())) renderWorkspaces();
    });

    onSubmit($("topup"), $("topup-status"), async () => {
      const status = $("topup-status");
      const input = $("topup-amount");
      say(status, "", "");
      const t = state.topups;
      if (!t) return invalid(input, status, "Credit cannot be bought just now. Reload the page to try again.");
      const minor = parseAmount(input.value, digitsOf(state.currency));
      if (minor === null) return invalid(input, status, `Enter an amount such as ${money(t.optionsMinor[0] || t.minimumMinor, state.currency)}.`);
      if (minor < t.minimumMinor) return invalid(input, status, `The smallest amount is ${money(t.minimumMinor, state.currency)}.`);
      if (minor > t.maximumMinor) return invalid(input, status, `The largest amount is ${money(t.maximumMinor, state.currency)}.`);
      rememberBefore();
      const r = await call("POST", "/api/checkout", { purpose: "topup", amountMinor: minor });
      const url = r.ok ? outsideUrl(r.data && r.data.url) : null;
      if (signInAgain(r)) return;
      if (!url) {
        say(status, "bad", r.ok ? "The payment page could not be opened. Try again in a moment." : r.error.message);
        return;
      }
      location.assign(url);
    });

    onSubmit($("password-form"), $("password-status"), async () => {
      const status = $("password-status");
      const current = $("current");
      const next = $("next");
      say(status, "", "");
      if (!current.value) return invalid(current, status, "Enter your current password.");
      if (next.value.length < 10) return invalid(next, status, "Choose a new password of at least 10 characters.");
      const r = await call("POST", "/api/password", { current: current.value, next: next.value });
      if (signInAgain(r)) return;
      if (!r.ok) {
        say(status, "bad", r.error.message);
        return;
      }
      current.value = "";
      next.value = "";
      say(status, "ok", "Your password is changed. Every other device is signed out.");
    });

    // -- the first paint, and what a return from the payment page means --

    renderTopups();
    renderAll();
    loadUsage();
    // The browser's back button can bring this page back from where it was, and with a payment page's button still pressed.
    window.addEventListener("pageshow", (event) => {
      if (event.persisted) location.reload();
    });

    const params = new URLSearchParams(location.search);
    const paid = params.get("paid") === "1";
    const cancelled = params.get("cancelled") === "1";
    if (paid || cancelled) history.replaceState(null, "", "/account");
    if (cancelled) flash("", "Checkout was cancelled. Nothing was charged.");
    if (paid) {
      // What the account looked like before the person left is kept in the tab, so that a payment that was applied while they were
      // away is seen as one. Without it (another tab, a browser that keeps nothing) the page can only watch for a change.
      const before = store.get(BEFORE_PAYMENT);
      store.remove(BEFORE_PAYMENT);
      const known = before !== null;
      const then = known ? before : fingerprint(state.me);
      if (known && fingerprint(state.me) !== then) {
        flash("ok", "Your payment has arrived.");
      } else {
        flash("", known ? "Thank you. The payment provider confirms a payment a few moments after checkout, and this page updates when yours is confirmed." : "Thank you. The payment provider confirms a payment a few moments after checkout, and your plan and balance below update when it does.");
        for (let i = 0; i < 20; i++) {
          await delay(3000);
          if (doc.visibilityState === "hidden") continue;
          if ((await refresh()) && fingerprint(state.me) !== then) {
            flash("ok", "Your payment has arrived.");
            await loadUsage();
            return;
          }
        }
        if (known) flash("warn", "Your payment has not shown up yet. It can take a few minutes, and nothing more is needed from you. Reload this page later to see it.");
        else flash("", "If your payment is not in the figures below yet, it can take a few minutes. Nothing more is needed from you. Reload this page later to see it.");
      }
    }
  }

  // ---- start ----

  const PAGES = {
    home: homePage,
    signup: signupPage,
    login: loginPage,
    verify: verifyPage,
    forgot: forgotPage,
    reset: resetPage,
    account: accountPage,
  };

  async function start() {
    const page = doc.body.dataset.page || "";
    const missing = (NEEDS[page] || []).filter((id) => !$(id));
    if (missing.length > 0) {
      console.error(`This page lacks what its script needs: ${missing.join(", ")}`);
      return;
    }
    doc.addEventListener("input", (event) => {
      if (event.target && event.target.removeAttribute) event.target.removeAttribute("aria-invalid");
    });
    const asked = call("GET", "/api/session");
    const polite = paintPolicy();
    const reply = await asked;
    const me = reply.ok ? reply.data.account : null;
    paintChrome(me, page);
    if (page === "account" && !reply.ok) {
      say($("notice"), "bad", `${reply.error.message} Reload the page to try again.`);
      return;
    }
    const run = PAGES[page];
    try {
      if (run) await run(me);
    } catch (err) {
      console.error(err);
      const status = $("status") || $("notice");
      if (status) say(status, "bad", "Something went wrong in this page. Reload it and try again.");
    }
    await polite;
  }

  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", start);
  else start();
})();
