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
    signup: ["card", "form", "status", "title", "lede", "email", "password", "agree"],
    login: ["form", "status", "email", "password"],
    verify: ["status", "title", "again"],
    forgot: ["form", "status", "email"],
    reset: ["card", "form", "status", "title", "lede", "password"],
    account: ["who", "notice", "stage", "stage-steps", "stage-title", "stage-text", "stage-actions", "stage-live", "workspaces-panel", "workspaces", "create-slot", "create-box", "create", "workspace-name", "create-note", "plan-panel", "plan-h", "plan-status", "plan", "balance-panel", "usage-panel", "figures", "topup", "topup-amount", "topup-unit", "topup-hint", "topup-status", "topup-options", "usage", "password-form", "password-status", "current", "next"],
    terms: [],
    privacy: [],
    notfound: [],
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

  /** A minor-unit amount as a bare number in the currency's own places ("25.00"), the example a field can show before anything is typed. */
  function bareAmount(minor, currency) {
    const d = digitsOf(currency);
    return (minor / 10 ** d).toFixed(d);
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
  /** A workspace that has finished starting, running or stopped: a model key can be given to it. */
  const canKey = (w) => w.status === "running" || w.status === "suspended";
  /** A workspace of a plan that sells hosting only and has no key yet: its team has no model to think with. */
  const lacksKey = (w) => Boolean(w.models) && w.models.key === null;
  /** A subscription that still holds a plan. One that has ended is a plan that can be chosen again. */
  const holdsPlan = (sub) => Boolean(sub) && sub.status !== "ended";

  const POLICY_UNITS = { graceDays: "day", retentionDays: "day", sessionDays: "day", idleDays: "day", verificationHours: "hour", resetHours: "hour" };

  /** What a plan includes, one fact to a line. */
  function planFacts(plan, currency) {
    // A hosting-only plan sells no model usage: the customer's own key is what the workspace runs on.
    const facts = plan.byok ? ["Your own model key; you pay your provider directly", plural(plan.workspaces, "workspace")] : [`${usageMoney(plan.includedUsageMicros, currency)} of model usage each ${plan.period}`, plural(plan.workspaces, "workspace")];
    if (Array.isArray(plan.tiers) && plan.tiers.length > 0) facts.push(`Model tiers: ${plan.tiers.join(", ")}`);
    return facts;
  }

  // ---- where a customer is, and what the account says to them there ----

  const STEP_LABELS = { plan: "Plan", workspace: "Workspace", key: "Model key", open: "Open" };

  /**
   * Whether the workspaces run on the customer's own model key: the plan says so, or a workspace of it carries the state of a key. A
   * visitor with no plan is told what every plan on offer says, so that the steps do not change count when they choose.
   */
  function isByok(view) {
    const sub = view.subscription;
    const plan = holdsPlan(sub) ? view.plans.find((p) => p.id === sub.plan) : undefined;
    if (plan) return Boolean(plan.byok);
    if (view.workspaces.some((w) => Boolean(w.models))) return true;
    return !holdsPlan(sub) && view.plans.length > 0 && view.plans.every((p) => p.byok);
  }

  /**
   * The steps of getting started in the order they can be done, and the one a person is at: the first not done. A key can only be given to
   * a workspace that has started, so on a plan that sells hosting only the key comes after the workspace. Open is never done (a person
   * opens a workspace again and again), so with everything else done the step is Open, and stays there.
   */
  function stepsOf(view, byok) {
    const started = view.workspaces.filter(canKey);
    const done = { plan: holdsPlan(view.subscription), workspace: started.length > 0, key: started.some((w) => Boolean(w.models) && w.models.key !== null), open: false };
    const ids = byok ? ["plan", "workspace", "key", "open"] : ["plan", "workspace", "open"];
    const current = ids.find((id) => !done[id]);
    return { current, steps: ids.map((id) => ({ id, label: STEP_LABELS[id], state: id === current ? "now" : done[id] ? "done" : "next" })) };
  }

  /**
   * Where the account is, from what the service says of it. `view` is `{ subscription, workspaces, plans, plansKnown, topups, policy }`:
   * the account's, and the plans on offer. The stage is one of `no-plan`, `late` (the last payment failed), `no-workspace`, `ready`
   * (a workspace can be opened), `needs-key` (running, on a plan that sells hosting only, with no key), `starting`, `stopped` and
   * `failed`, and names the workspace it is about. With several workspaces the one that can be opened comes first, then one that
   * needs a key, then one starting, stopped and failed: what is working is not hidden behind what is not.
   */
  function stageOf(view) {
    const sub = view.subscription;
    const byok = isByok(view);
    const { current, steps } = stepsOf(view, byok);
    const base = { byok, step: current, steps };
    if (!holdsPlan(sub)) return { id: "no-plan", ended: Boolean(sub), workspace: null, ...base };
    const items = view.workspaces;
    const first = (test) => items.find(test) || null;
    if (sub.status === "past_due") return { id: "late", workspace: first((w) => w.status === "running") || first(canKey) || items[0] || null, ...base };
    if (items.length === 0) return { id: "no-workspace", workspace: null, ...base };
    const running = (w) => w.status === "running";
    const order = [
      ["ready", (w) => running(w) && !lacksKey(w)],
      ["needs-key", (w) => running(w) && lacksKey(w)],
      ["starting", isStarting],
      ["stopped", (w) => w.status === "suspended"],
      ["failed", (w) => w.status === "failed"],
    ];
    for (const [id, test] of order) {
      const w = first(test);
      if (w) return { id, workspace: w, ...base };
    }
    return { id: "ready", workspace: items[0], ...base };
  }

  /**
   * What the card at the top of the account says for a stage: a title, a sentence, the tone it is said in, and the one action it offers
   * (`kind` is what the page does: follow a link, open a workspace, resume it, give it a key, update billing, or make the first workspace).
   */
  function nextStepOf(stage, view) {
    const sub = view.subscription;
    const w = stage.workspace;
    const name = w ? w.name : "";
    switch (stage.id) {
      case "no-plan": {
        const action = { kind: "link", label: "Choose a plan", href: "#plan-h" };
        if (stage.ended) {
          const days = view.policy ? ` ${plural(view.policy.retentionDays, "day")}` : "";
          return { tone: "warn", title: "Choose a plan to start again", text: `Your subscription has ended and your workspaces are stopped. They are deleted${days} after it ended. Choose a plan again before then and they start again.`, action };
        }
        const pays = "Choose one below and pay on the next page.";
        return { tone: "", title: "Choose a plan", text: stage.byok ? `A plan is a flat monthly price for hosting your workspace. ${pays} You bring your own model key and pay your model provider yourself.` : `A plan is a flat monthly price for your workspace. ${pays}`, action };
      }
      case "late": {
        const stopped = view.workspaces.some((x) => x.statusReason === "payment is overdue");
        const days = view.policy ? view.policy.graceDays : null;
        const ends = days !== null && sub.pastDueSince ? when(new Date(Date.parse(sub.pastDueSince) + days * 86_400_000).toISOString()) : "";
        const text = stopped ? "Your workspaces were stopped because of it. A payment puts everything back." : ends ? `Your workspaces keep running until ${ends} and are then stopped. A payment before then puts everything back.` : "Your workspaces are stopped after a short grace period. A payment before then puts everything back.";
        return { tone: "warn", title: "Your last payment did not go through", text, action: { kind: "billing", label: "Update payment details" } };
      }
      case "no-workspace":
        return {
          tone: "",
          title: "Make your first workspace",
          text: `${sub && sub.title ? `Your ${sub.title} plan is active.` : "Your plan is active."} A workspace is your own Curule host, with its own projects, event log and files.${stage.byok ? " You give it your model key once it has started." : ""}`,
          action: { kind: "create", label: "Create workspace" },
        };
      case "starting":
        return { tone: "", title: `${name} is starting`, text: `${view.stale ? "This page has stopped checking. Reload it to look again." : "This page checks every few seconds and shows when it is ready."}${stage.byok ? " Then you give it your model key." : ""}`, action: null };
      case "needs-key":
        return { tone: "", title: "Add your model key", text: `${name} is running, but its team has no model yet. Give it the key of your model provider. Curule does not resell model usage, so your provider bills you directly.`, action: { kind: "key", label: "Add your model key" } };
      case "stopped": {
        const own = w.statusReason === "paused by its owner";
        return { tone: "", title: own ? `${name} is paused` : `${name} is stopped`, text: own ? "Its files are kept. Resume it to open it." : `${reasonText(w.statusReason) || "It is not running."} Resume it to open it.`, action: { kind: "resume", label: "Resume" } };
      }
      case "failed":
        return { tone: "bad", title: `${name} could not start`, text: `${reasonText(w.statusReason) || "The workspace could not be started."} Delete it and make a new one. If it fails again, tell the operator.`, action: null, contact: true };
      default: {
        const several = view.workspaces.filter((x) => x.status === "running" && !lacksKey(x)).length > 1;
        if (several) return { tone: "", title: "Your workspaces are running", text: "Open the one you want to work in.", action: null };
        return { tone: "", title: `${name} is running`, text: "Open it to describe your team and start a mission.", action: { kind: "open", label: "Open" } };
      }
    }
  }

  /**
   * Which parts of the account are shown. Workspaces when there are some; the plans to choose from before there is one and the plan
   * itself, with the others behind a button, after; credit and usage only for a plan that sells model usage (never before a plan, and
   * not on hosting only), and usage only once there is a workspace to use it or something was used.
   */
  function sectionsOf(view) {
    const live = holdsPlan(view.subscription);
    const plan = live ? view.plans.find((p) => p.id === view.subscription.plan) : undefined;
    const hostingOnly = plan ? Boolean(plan.byok) : view.workspaces.some((w) => Boolean(w.models));
    const sellsUsage = live && !hostingOnly && !(view.plansKnown && view.topups === null);
    return { workspaces: view.workspaces.length > 0, plan: live ? "summary" : "choose", balance: sellsUsage, usage: sellsUsage && (view.workspaces.length > 0 || (view.usageCalls || 0) > 0) };
  }

  /**
   * Whether a person can start a workspace that is stopped: the service starts none for an account whose plan is not paid up (it answers
   * that a payment is needed), and starts them all itself when the payment comes.
   */
  function resumable(w, view) {
    const sub = view.subscription;
    return w.status === "suspended" && holdsPlan(sub) && sub.status === "active";
  }

  /**
   * What a workspace says of itself under its name and state, in a sentence or two: why it is as it is and what can be done. A workspace
   * that is running and ready says nothing more than its state and its Open button do.
   */
  function workspaceSays(w, view) {
    switch (w.status) {
      case "running":
        return lacksKey(w) ? "Its team has no model yet. Give it your model key to put it to work." : "";
      case "requested":
      case "provisioning":
        return "It starts in the background, and this page updates when it is ready.";
      case "suspended": {
        const why = w.statusReason === "paused by its owner" ? "Paused by you. Its files are kept." : w.statusReason ? reasonText(w.statusReason) : "It is not running.";
        if (resumable(w, view)) return `${why} Resume it to open it.`;
        return `${why} ${holdsPlan(view.subscription) ? "A payment starts it again." : "Choose a plan again and it starts again."}`;
      }
      case "failed":
        return `${w.statusReason ? reasonText(w.statusReason) : "The workspace could not be started."} Delete it and make a new one. If it fails again, tell the operator.`;
      default:
        return "";
    }
  }

  /** What the account looks like in the ways a payment changes it. */
  function fingerprint(me) {
    const sub = me.account.subscription;
    const b = me.balance;
    return JSON.stringify([sub && [sub.plan, sub.status, sub.periodEnd], b && [b.balance.included, b.balance.purchased]]);
  }

  const exported = { NEEDS, plural, digitsOf, bareAmount, money, usageMoney, balanceMoney, count, when, dayLabel, parseAmount, nextPath, outsideUrl, reasonText, planFacts, fingerprint, isStarting, holdsPlan, canKey, lacksKey, isByok, stepsOf, stageOf, nextStepOf, sectionsOf, resumable, workspaceSays, STATES, POLICY_UNITS };
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

  /**
   * A control that is held while its request is out says so (aria-disabled) and does nothing when it is pressed. A disabled one would take
   * the cursor away from a person at a keyboard, in a browser that does not leave it on a control that cannot be used.
   */
  const isHeld = (node) => node.getAttribute("aria-disabled") === "true";
  function hold(node, on) {
    if (on) node.setAttribute("aria-disabled", "true");
    else node.removeAttribute("aria-disabled");
  }

  function button(label, o = {}) {
    const classes = ["btn", o.kind ? `btn-${o.kind}` : "", o.small ? "btn-small" : ""].filter(Boolean).join(" ");
    const onclick = o.onclick ? (event) => (isHeld(event.currentTarget) ? undefined : o.onclick(event)) : undefined;
    return el("button", { type: o.type || "button", id: o.id, class: classes, disabled: o.disabled, onclick, ...o.attrs }, label);
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

  /** A form whose submit is handled here: no double sends, buttons held while a call is out (the main one says what it is doing), and a failure that says so. */
  function onSubmit(node, status, handler) {
    let busy = false;
    node.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (busy) return;
      busy = true;
      const focused = doc.activeElement && node.contains(doc.activeElement) ? doc.activeElement : null;
      const buttons = [...node.querySelectorAll("button")];
      for (const b of buttons) b.disabled = true;
      // A button that has a word for it says so, so that a slow answer does not look like a button that did nothing.
      const main = node.querySelector("[data-busy]");
      const label = main ? main.textContent : "";
      if (main) main.textContent = main.dataset.busy;
      node.setAttribute("aria-busy", "true");
      // Whatever is sent is not left showing for the next person at the screen.
      for (const b of node.querySelectorAll("[data-reveal]")) hideSecret(b);
      try {
        await handler();
      } catch (err) {
        console.error(err);
        say(status, "bad", "Something went wrong in this page. Reload it and try again.");
      } finally {
        busy = false;
        for (const b of buttons) b.disabled = false;
        if (main) main.textContent = label;
        node.removeAttribute("aria-busy");
        // A button that is disabled loses the cursor in some browsers: it comes back, unless the handler put it somewhere else.
        if (focused && (!doc.activeElement || doc.activeElement === doc.body)) focused.focus();
      }
    });
  }

  // ---- what a page does for the person at it ----

  const secrets = new Map();

  /** A password field's Show/Hide. The markup carries the button hidden, so a browser that runs no script shows no control that does nothing. */
  function wireSecret(button) {
    const input = $(button.dataset.reveal);
    if (!input) return;
    const set = (shown) => {
      input.setAttribute("type", shown ? "text" : "password");
      button.textContent = shown ? "Hide" : "Show";
      button.setAttribute("aria-label", shown ? "Hide password" : "Show password");
    };
    secrets.set(button, set);
    button.addEventListener("click", () => set(input.getAttribute("type") !== "text"));
    button.hidden = false;
  }

  function hideSecret(button) {
    const set = secrets.get(button);
    if (set) set(false);
  }

  /** The page's heading and the tab's title say what the page is now: a link that was sent is no longer "Create your account". */
  function retitle(heading, lede) {
    const title = $("title");
    if (title) title.textContent = heading;
    const line = $("lede");
    if (line) {
      line.textContent = lede || "";
      line.hidden = !lede;
    }
    doc.title = `${heading} – Curule Cloud`;
  }

  /** Someone at a keyboard starts typing at once. A phone is left alone: a keyboard that opens by itself covers the page it was opened for. */
  function focusFirst(input) {
    const fine = typeof window.matchMedia === "function" && window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    if (fine) input.focus();
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

  /** What the front page says where there is no credit to add: this service sells hosting, and the customer's own key pays for models. */
  const NO_USAGE_SOLD = "Curule does not resell model usage. You bring your own model key and pay your provider directly.";

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
    // What the page says about model usage is true of a service that sells none. One that sells credit says what its plans include,
    // and says nothing that its own plans contradict.
    for (const node of doc.querySelectorAll("[data-hosting-only]")) node.hidden = topups !== null;
    const subscription = me ? me.subscription : null;
    const action = me ? () => el("a", { class: "btn", href: "/account#plan-h" }, "Choose in your account") : () => el("a", { class: "btn btn-primary", href: "/signup" }, "Get started");
    box.replaceChildren(...r.data.plans.map((plan) => planCard(plan, currency, { subscription, action })));
    $("topups").textContent = topups ? topupLine(topups, currency) : NO_USAGE_SOLD;
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
    focusFirst(email);
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
      retitle("Check your email", "");
      card.replaceChildren(
        el("div", { class: "note note-ok", role: "status" }, r.data.message),
        el("p", null, "We sent the link to ", el("strong", null, address), ". It works once, and the email says when it expires."),
        el("p", { class: "muted small" }, "It can take a minute. Look in your spam folder if it has not come. Still nothing? Sign in with your email and password, and we send the link again. To use another address, ", el("a", { href: "/signup" }, "start again"), "."),
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
    focusFirst(email);
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
      retitle("That link did not work", "");
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
    retitle("Address confirmed", "");
    say(status, "ok", "Your address is confirmed. Taking you to your account.");
    location.replace("/account");
  }

  function forgotPage() {
    const status = $("status");
    const email = $("email");
    focusFirst(email);
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
    focusFirst(password);
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
      retitle("Password changed", "");
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
  /** How many times the page looks again while a workspace is starting: every three seconds, so for ten minutes. */
  const WATCH_LIMIT = 200;
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
      keyBusy: new Set(),
      drafts: new Map(),
      notes: new Map(),
      confirming: null,
      typed: "",
      flash: null,
      planNote: null,
      timer: 0,
      watched: 0,
      /** Whether the other plans are shown under the plan the account is on. */
      changing: false,
      /** The workspaces whose less used actions (deleting one) are shown. */
      more: new Set(),
      /** The workspaces whose person asked for them to be opened as soon as they are ready. */
      autoOpen: new Set(),
      /** What the card at the top said last, so that it is drawn again only when it says something else. */
      stageShape: "",
      stageId: undefined,
      /** Set by something the person did, so that the card they were using is not left without the cursor when it says something else. */
      focusStage: false,
      createAt: "panel",
      /** What the card at the top offers, and of which workspace, so that the workspace's own button is not a second one of the same weight. */
      stageTarget: null,
      usageCalls: 0,
      usageLoaded: false,
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
    /** What the pure parts decide from: the account, the plans on offer and what the service says its periods are. */
    const viewOf = () => ({ subscription: subscription(), workspaces: account().workspaces, plans: state.plans, plansKnown: state.plansKnown, topups: state.topups, policy: state.policy, stale: state.watched >= WATCH_LIMIT, usageCalls: state.usageCalls });
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
      const b = state.me.balance;
      if (sectionsOf(viewOf()).balance && b && b.balance.available <= 0) {
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
      renderStage();
      const r = await request();
      state.busy.delete(w.workspaceId);
      if (signInAgain(r)) return;
      if (!r.ok) {
        setNote(w.workspaceId, "bad", r.error.message);
        if (!(await refresh())) {
          renderWorkspaces();
          renderStage();
        }
        return;
      }
      setNote(w.workspaceId, "", "");
      if (after) after(r);
      if (!(await refresh())) {
        renderWorkspaces();
        renderStage();
      }
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
              state.focusStage = true;
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

    /** Whether the card at the top offers this workspace's person the same thing as a button of their own. */
    const cardOffers = (id, kind) => Boolean(state.stageTarget) && state.stageTarget.id === id && state.stageTarget.kind === kind;

    /**
     * One card to a workspace, made once and kept. Each part of it is drawn again only when what it says has changed, so that a key being
     * typed, or the name typed to confirm a deletion, is not lost when the page looks at the account again, and a button that was pressed
     * is still the one that has the cursor while its request is out.
     */
    const cards = new Map();
    const CARD_PARTS = [
      ["head", "div", "row-head"],
      ["says", "p", "ws-says"],
      ["auto", "div", "ws-auto"],
      ["actions", "div", "ws-actions"],
      ["key", "div", "ws-key"],
      ["confirm", "div", "ws-confirm"],
    ];

    function cardFor(id) {
      let card = cards.get(id);
      if (card) return card;
      const boxes = {};
      for (const [name, tag, cls] of CARD_PARTS) boxes[name] = el(tag, { class: cls });
      // What is under way, or came of the last thing asked: one line that stays, so that a change in it is read out.
      // While it says nothing it is kept out of sight, not out of the page (`sr`): a line that is not in the page is not read out when it fills.
      const note = el("p", { class: "ws-note sr", role: "status", "aria-live": "polite" });
      const address = el("p", { class: "muted small ws-address" });
      card = { li: el("li", { class: "row ws" }, Object.values(boxes), note, address), boxes, note, address, shapes: {}, noteShape: "", addressShape: "" };
      cards.set(id, card);
      return card;
    }

    function part(card, name, shape, make) {
      if (card.shapes[name] === shape) return;
      card.shapes[name] = shape;
      const box = card.boxes[name];
      const had = doc.activeElement && box.contains(doc.activeElement) ? doc.activeElement.id : null;
      box.replaceChildren(...make());
      if (had === null) return;
      // The cursor goes back to what it was on, or, when that is gone (Pause is replaced by Resume), to the first control there is now.
      const target = (had ? $(had) : null) || box.querySelector("button, input, select, a");
      if (target) target.focus();
    }

    /** What can be done to a workspace in the state it is in. Deleting is behind More, away from Open; a workspace that could not start has nothing else to be done, so there it is shown. */
    function actionsOf(w, view) {
      const id = w.workspaceId;
      const buttons = [];
      if (w.status === "running") {
        buttons.push(button("Open", { id: `open-${id}`, kind: cardOffers(id, "open") || lacksKey(w) ? "" : "primary", onclick: () => open(w), attrs: { "aria-label": `Open ${w.name}` } }));
        buttons.push(button("Pause", { id: `pause-${id}`, onclick: () => act(w, "Pausing it.", () => call("POST", path(w, "suspend"))), attrs: { "aria-label": `Pause ${w.name}` } }));
      }
      if (resumable(w, view)) buttons.push(button("Resume", { id: `resume-${id}`, kind: cardOffers(id, "resume") ? "" : "primary", onclick: () => act(w, "Starting it.", () => call("POST", path(w, "resume"))), attrs: { "aria-label": `Resume ${w.name}` } }));
      const remove = button("Delete this workspace", {
        id: `delete-${id}`,
        kind: "danger",
        attrs: { "aria-label": `Delete this workspace: ${w.name}` },
        onclick: () => {
          state.confirming = id;
          state.typed = "";
          renderWorkspaces();
          const input = $(`confirm-${id}`);
          if (input) input.focus();
        },
      });
      let panel = null;
      if (w.status === "failed") buttons.push(remove);
      else if (!isStarting(w)) {
        const shown = state.more.has(id) || state.confirming === id;
        buttons.push(
          button("More", {
            id: `more-${id}`,
            kind: "quiet",
            attrs: { "aria-expanded": shown ? "true" : "false", "aria-controls": `more-panel-${id}`, "aria-label": `More actions for ${w.name}` },
            onclick: () => {
              if (state.more.has(id)) state.more.delete(id);
              else state.more.add(id);
              renderWorkspaces();
              restoreFocus(`more-${id}`);
            },
          }),
        );
        panel = el("div", { id: `more-panel-${id}`, class: "disclosed", hidden: !shown }, remove);
      }
      return [buttons.length > 0 ? el("div", { class: "btn-row" }, buttons) : null, panel].filter(Boolean);
    }

    /** "Open it when it is ready", off until the person asks: a page that takes someone away on its own does so only because they said it may. */
    function autoOpenBox(w) {
      const id = w.workspaceId;
      // It is drawn unchecked: a ticked offer is dropped as soon as the workspace is not on its way to being ready, so none is drawn again ticked.
      const input = el("input", { id: `auto-${id}`, type: "checkbox" });
      input.addEventListener("change", () => {
        if (input.checked) state.autoOpen.add(id);
        else state.autoOpen.delete(id);
      });
      return el("label", { class: "check" }, input, "Open it when it is ready");
    }

    function drawCard(w, view) {
      const id = w.workspaceId;
      const card = cardFor(id);
      const [label, kind] = STATES[w.status] || [w.status, ""];
      const says = workspaceSays(w, view);
      // Ready is not running only: on a plan that sells hosting only a workspace with no key is up, and has nothing to open for.
      const waiting = isStarting(w) || (w.status === "running" && lacksKey(w));
      const showAuto = isStarting(w) || (waiting && state.autoOpen.has(id));
      part(card, "head", JSON.stringify([w.name, w.status]), () => [el("strong", null, w.name), el("span", { class: kind ? `badge badge-${kind}` : "badge" }, label)]);
      part(card, "says", says, () => (says ? [says] : []));
      part(card, "auto", String(showAuto), () => (showAuto ? [autoOpenBox(w)] : []));
      part(card, "actions", JSON.stringify([w.name, w.status, resumable(w, view), lacksKey(w), cardOffers(id, "open"), cardOffers(id, "resume"), state.more.has(id), state.confirming === id]), () => actionsOf(w, view));
      part(card, "key", keyShape(w), () => keyBlock(w));
      part(card, "confirm", String(state.confirming === id), () => (state.confirming === id ? [confirmBox(w)] : []));
      // A request that is out holds the buttons without drawing them again: the one that was pressed keeps the cursor.
      const held = state.busy.has(id);
      for (const b of card.boxes.actions.querySelectorAll("button")) hold(b, held);
      const note = state.notes.get(id);
      const noteShape = note ? `${note.kind}|${note.text}` : "";
      if (card.noteShape !== noteShape) {
        card.noteShape = noteShape;
        card.note.className = !note ? "ws-note sr" : note.kind ? `note note-${note.kind} ws-note` : "muted small ws-note";
        card.note.textContent = note ? note.text : "";
      }
      if (card.addressShape !== w.host) {
        card.addressShape = w.host;
        card.address.replaceChildren("Address ", el("code", null, w.host));
      }
      return card;
    }

    function renderWorkspaces() {
      const items = account().workspaces;
      const view = viewOf();
      const list = $("workspaces");
      const lis = items.map((w) => drawCard(w, view).li);
      // The list is touched only when a workspace came or went, and one that came is added after the others: moving a card that has the cursor in it takes the cursor away.
      const shown = [...list.children];
      if (shown.length <= lis.length && shown.every((li, i) => li === lis[i])) list.append(...lis.slice(shown.length));
      else list.replaceChildren(...lis);
      $("workspaces-panel").hidden = items.length === 0;
      renderCreate(items);
    }

    /** A workspace whose person asked for it to be opened when it is ready is opened as soon as it is, as if they had pressed Open. */
    function openWhenReady() {
      if (state.autoOpen.size === 0) return;
      const mine = new Map(account().workspaces.map((w) => [w.workspaceId, w]));
      for (const id of [...state.autoOpen]) {
        // One that is gone, or has stopped, or could not start, is not on its way to being ready: it is not waited for any more.
        const w = mine.get(id);
        if (!w || !(isStarting(w) || w.status === "running")) state.autoOpen.delete(id);
      }
      if (doc.visibilityState === "hidden") return;
      for (const w of account().workspaces) {
        if (!state.autoOpen.has(w.workspaceId) || w.status !== "running" || lacksKey(w)) continue;
        state.autoOpen.delete(w.workspaceId);
        open(w);
        return;
      }
    }

    /** Whether a workspace can be made, and why not when it cannot. The form itself is where the page puts it: in the card at the top for a first workspace. */
    function renderCreate(items) {
      const form = $("create");
      const note = $("create-note");
      const plan = planOf();
      const live = items.filter((w) => w.status !== "failed").length;
      const standingNow = standing();
      if (standingNow === "none") {
        form.hidden = true;
        hint(note, "", "");
      } else if (standingNow === "past_due") {
        form.hidden = true;
        hint(note, "", "Update your payment details to create a workspace.");
      } else if (plan && live >= plan.workspaces) {
        form.hidden = true;
        // While the workspace that fills the plan is starting nothing is asked of the person, so nothing is said about being full.
        hint(note, "", items.some(isStarting) ? "" : `Your plan includes ${plural(plan.workspaces, "workspace")}. To make another, delete ${plan.workspaces === 1 ? "this one" : "one"} or change your plan.`);
      } else {
        form.hidden = false;
        // What went wrong with the last attempt stays until the next one.
        if (!note.className.includes("note-bad")) hint(note, "", "");
      }
    }

    function restoreFocus(id) {
      const target = id ? $(id) : null;
      if (target) target.focus();
    }

    // -- the card at the top: where the account is, and the one thing it is waiting for --

    function stepItem(step, index) {
      const said = { done: " (done)", now: " (you are here)", next: " (still to do)" }[step.state];
      return el(
        "li",
        { class: step.state, "aria-current": step.state === "now" ? "step" : false },
        el("span", { class: "num", "aria-hidden": "true" }, step.state === "done" ? "\u2713" : String(index + 1)),
        step.label,
        el("span", { class: "sr" }, said),
      );
    }

    /** The key's fields, for the workspace the card is about: the model first, as the key is useless to a team without one. */
    function focusKey(w) {
      const model = $(`key-model-${w.workspaceId}`);
      const target = model && model.value.trim() === "" ? model : $(`key-secret-${w.workspaceId}`);
      if (target) target.focus();
    }

    function stageAction(a, w) {
      const named = w ? { "aria-label": `${a.label} ${w.name}` } : undefined;
      switch (a.kind) {
        case "link":
          return el("a", { class: "btn btn-primary", href: a.href }, a.label);
        case "billing":
          return button(a.label, { kind: "primary", onclick: (event) => leaveFor(event.currentTarget, () => call("POST", "/api/portal"), failedHere) });
        case "key":
          return button(a.label, { kind: "primary", onclick: () => focusKey(w) });
        case "open":
          return button(a.label, { id: "stage-open", kind: "primary", onclick: () => open(w), ...(named ? { attrs: named } : {}) });
        default:
          return button(a.label, { id: "stage-resume", kind: "primary", onclick: () => act(w, "Starting it.", () => call("POST", path(w, "resume"))), ...(named ? { attrs: named } : {}) });
      }
    }

    /** Drawn again only when it says something else, so that a name being typed into its form is not lost to a look at the account. */
    function renderStage() {
      const view = viewOf();
      const stage = stageOf(view);
      const card = nextStepOf(stage, view);
      const w = stage.workspace;
      const shape = JSON.stringify([stage.id, stage.step, card, stage.steps, w ? w.workspaceId : ""]);
      if (shape !== state.stageShape) {
        state.stageShape = shape;
        drawStage(stage, card, w);
      }
      // A request that is out holds the card's button without drawing it again: the one that was pressed keeps the cursor.
      const held = Boolean(w) && state.busy.has(w.workspaceId);
      for (const id of ["stage-open", "stage-resume"]) {
        const b = doc.getElementById(id);
        if (b) hold(b, held);
      }
      if (state.focusStage) {
        state.focusStage = false;
        $("stage-title").focus();
      }
    }

    function drawStage(stage, card, w) {
      const box = $("stage");
      // The cursor goes back to what it was on, or, when that is gone (Resume is not offered once it is running), to what the card says now.
      const had = box.contains(doc.activeElement) ? doc.activeElement.id : null;
      state.stageTarget = card.action && w ? { kind: card.action.kind, id: w.workspaceId } : null;
      box.hidden = false;
      box.className = card.tone ? `stage stage-${card.tone}` : "stage";
      // The steps are for a person who is getting started; one whose workspace can be opened is not shown them.
      const steps = $("stage-steps");
      steps.hidden = stage.step === "open";
      steps.replaceChildren(...stage.steps.map(stepItem));
      $("stage-title").textContent = card.title;
      const text = $("stage-text");
      text.replaceChildren(card.text);
      if (card.contact && /^(mailto:|https:)/.test(CONTACT)) text.append(" ", el("a", { href: CONTACT }, "Contact the operator"), ".");
      const actions = $("stage-actions");
      const form = $("create-box");
      if (card.action && card.action.kind === "create") {
        actions.replaceChildren(form);
        state.createAt = "stage";
      } else {
        if (state.createAt === "stage") {
          $("create-slot").append(form);
          state.createAt = "panel";
        }
        actions.replaceChildren(...(card.action ? [stageAction(card.action, w)] : []));
      }
      // What a screen reader is told, once, when the account moves on: the page was not asked, and nothing it was looking at is gone.
      if (state.stageId !== undefined && state.stageId !== stage.id) $("stage-live").textContent = `${card.title}. ${card.text}`;
      state.stageId = stage.id;
      if (had !== null) ((had ? doc.getElementById(had) : null) || $("stage-title")).focus();
    }

    /** While a workspace is starting the page asks again every few seconds, for ten minutes at most, and not while the tab is hidden. */
    function watch() {
      if (state.timer !== 0 || state.watched >= WATCH_LIMIT || !account().workspaces.some(isStarting)) return;
      state.timer = setTimeout(async () => {
        state.timer = 0;
        if (doc.visibilityState !== "hidden") {
          state.watched++;
          await refresh();
        }
        watch();
      }, 3000);
    }

    // -- the customer's own model key, in the card of the workspace it is for --

    const PROVIDER_NAMES = { anthropic: "Anthropic", "openai-compatible": "OpenAI-compatible" };

    /** What the key part of a card shows, so that it is drawn again when that changes and not otherwise: a key being typed is in it. */
    const keyShape = (w) => (w.models ? JSON.stringify([w.status === "failed" ? "failed" : canKey(w) ? "can" : "not yet", w.models.key]) : "");

    /**
     * The form that gives a workspace its key. The page can send a key and can say that one is kept, for which provider and model; it can
     * never show one, because the service never sends one back. What was typed is cleared from the field as soon as it has been sent.
     */
    function keyForm(w, kept, note, buttons) {
      const id = w.workspaceId;
      const draft = state.drafts.get(id) || { provider: kept ? kept.provider : "anthropic", model: kept ? kept.model : "", baseUrl: kept && kept.baseUrl ? kept.baseUrl : "" };
      state.drafts.set(id, draft);
      const provider = el("select", { id: `key-provider-${id}`, name: "provider" }, Object.entries(PROVIDER_NAMES).map(([value, label]) => el("option", { value, selected: value === draft.provider }, label)));
      provider.value = draft.provider;
      const model = el("input", { id: `key-model-${id}`, name: "model", type: "text", autocomplete: "off", spellcheck: "false", value: draft.model, maxlength: 128 });
      const base = el("input", { id: `key-base-${id}`, name: "baseUrl", type: "text", inputmode: "url", autocomplete: "off", spellcheck: "false", value: draft.baseUrl, placeholder: "https://openrouter.ai/api/v1" });
      // autocomplete off and a password field: the browser neither fills in nor offers to remember a secret that is not a sign-in.
      const key = el("input", { id: `key-secret-${id}`, name: "key", type: "password", autocomplete: "off", spellcheck: "false", maxlength: 512 });
      const baseField = el("div", { class: "field" }, el("label", { for: base.id }, "Provider address"), base, el("span", { class: "hint" }, "Starts with https://, and is your provider's public address. OpenRouter, OpenAI, DeepSeek and Gemini's compatible endpoint all work."));
      const chosen = () => provider.value || draft.provider;
      const sync = () => {
        draft.provider = chosen();
        baseField.hidden = draft.provider !== "openai-compatible";
      };
      sync();
      for (const type of ["input", "change"]) provider.addEventListener(type, sync);
      model.addEventListener("input", () => (draft.model = model.value));
      base.addEventListener("input", () => (draft.baseUrl = base.value));
      const save = button(kept ? "Save new key" : "Save key", { type: "submit", kind: "primary", id: `key-save-${id}` });
      buttons.push(save);
      return {
        key,
        form: el(
          "form",
          {
            id: `key-form-${id}`,
            novalidate: true,
            onsubmit: async (event) => {
              event.preventDefault();
              if (state.keyBusy.has(id)) return;
              const kind = chosen();
              const typed = key.value.trim();
              say(note, "", "");
              if (!draft.model.trim()) return invalid(model, note, "Name the model your teams should run on, as your provider names it.");
              if (kind === "openai-compatible" && !/^https:\/\//i.test(draft.baseUrl.trim())) return invalid(base, note, "Give your provider's address, starting with https://.");
              if (typed.length < 8 || /\s/.test(typed)) return invalid(key, note, "Paste the whole key, with no spaces.");
              state.keyBusy.add(id);
              for (const b of buttons) hold(b, true);
              say(note, "", "Keeping it, and starting the workspace again with it.");
              const body = { provider: kind, model: draft.model.trim(), key: typed, ...(kind === "openai-compatible" ? { baseUrl: draft.baseUrl.trim() } : {}) };
              const r = await call("POST", path(w, "model-key"), body);
              // Whatever came of it, the page does not hold the key any longer.
              key.value = "";
              state.keyBusy.delete(id);
              for (const b of buttons) hold(b, false);
              if (signInAgain(r)) return;
              if (!r.ok) {
                say(note, "bad", r.error.message);
                return;
              }
              flash("ok", `The key for ${w.name} is kept, and the workspace was started again with it.`);
              if (!(await refresh())) renderWorkspaces();
            },
          },
          el("div", { class: "field" }, el("label", { for: provider.id }, "Provider"), provider),
          el("div", { class: "field" }, el("label", { for: model.id }, "Model"), model, el("span", { class: "hint" }, "As your provider names it, like claude-sonnet-4-5 or openai/gpt-4o.")),
          baseField,
          el("div", { class: "field" }, el("label", { for: key.id }, kept ? "New key" : "Key"), key, el("span", { class: "hint" }, "Paste it here once. It is never shown again, by this page or by anything else of ours.")),
          el("div", { class: "btn-row" }, save),
          el("p", { class: "muted small" }, "Saving or removing a key starts the workspace's host again, which ends a turn that is running. Its files are kept."),
        ),
      };
    }

    /**
     * The key part of a workspace's card, for a workspace of a plan that sells hosting only: which key is kept (or that none is), and the
     * form to give one. With none the form is open; with one it is behind Replace key, and the key can be removed.
     */
    function keyBlock(w) {
      if (!w.models || w.status === "failed") return [];
      const id = w.workspaceId;
      const kept = w.models.key;
      const note = el("p", { id: `key-note-${id}`, class: "muted small", role: "status", "aria-live": "polite" });
      const head = el("p", { class: "key-line" }, el("strong", null, "Model key"), el("span", { class: kept ? "badge badge-ok" : "badge badge-warn" }, kept ? "Key kept" : "No key yet"));
      if (!canKey(w)) return [head, el("p", { class: "muted small" }, "Until you give it a key, a team in this workspace has no model to run on. You can set its key once the workspace has started.")];
      const promise = el("p", { class: "muted small" }, "Your key stays with your workspace. Curule does not resell model usage, so you pay your provider directly. A key is only ever sent to the workspace it is for, and nobody can read it back, including you.");
      const buttons = [];
      const { key, form } = keyForm(w, kept, note, buttons);
      if (!kept) return [head, el("p", { class: "muted small" }, "Until you give it a key, a team in this workspace has no model to run on."), promise, form, note];

      const panel = el("div", { id: `key-replace-${id}`, class: "disclosed", hidden: true }, promise, form);
      const toggle = button("Replace key", {
        id: `key-toggle-${id}`,
        small: true,
        kind: "quiet",
        attrs: { "aria-expanded": "false", "aria-controls": panel.id },
        onclick: () => {
          const opening = panel.hidden;
          panel.hidden = !opening;
          toggle.setAttribute("aria-expanded", opening ? "true" : "false");
          // Opening is for typing a key, so the cursor goes to the field; closing puts away what was typed.
          if (opening) focusKey(w);
          else key.value = "";
        },
      });
      const remove = button("Remove key", { id: `key-delete-${id}`, small: true, kind: "danger", onclick: () => removeKey(w, note, buttons) });
      buttons.push(toggle, remove);
      const facts = el("p", { class: "muted small" }, `${PROVIDER_NAMES[kept.provider] || kept.provider}, model ${kept.model}${kept.baseUrl ? `, at ${kept.baseUrl}` : ""}. Set ${when(kept.setAt)}. The key itself is never shown again.`);
      return [head, facts, el("div", { class: "btn-row" }, toggle, remove), panel, note];
    }

    async function removeKey(w, note, buttons) {
      if (state.keyBusy.has(w.workspaceId)) return;
      state.keyBusy.add(w.workspaceId);
      for (const b of buttons) hold(b, true);
      say(note, "", "Removing it, and starting the workspace again without it.");
      const r = await call("POST", path(w, "model-key/delete"));
      state.keyBusy.delete(w.workspaceId);
      for (const b of buttons) hold(b, false);
      if (signInAgain(r)) return;
      if (!r.ok) {
        say(note, "bad", r.error.message);
        return;
      }
      state.drafts.delete(w.workspaceId);
      flash("ok", `The key for ${w.name} is removed. A team in it has no model to run on until you give it another.`);
      if (!(await refresh())) renderWorkspaces();
    }

    // -- plan --

    function renderPlan() {
      const box = $("plan");
      const sub = subscription();
      const live = holdsPlan(sub);
      const plan = planOf();
      $("plan-panel").hidden = false;
      // A person with no plan is at the step of choosing one, and the panel says so; a customer's is their plan.
      $("plan-h").textContent = live ? "Plan" : "Choose a plan";
      const checkout = (p, kind) => (event) => leaveFor(event.currentTarget, () => call("POST", "/api/checkout", { purpose: "subscription", plan: p.id }), failedHere, rememberBefore);
      const parts = [];
      if (sub) {
        const label = sub.status === "ended" ? ["Ended", "bad"] : sub.status === "past_due" ? ["Payment overdue", "warn"] : sub.status === "active" ? ["Active", "ok"] : [sub.status, ""];
        const others = live ? state.plans.filter((p) => p.id !== sub.plan) : [];
        const said = [plan && live ? `${money(plan.priceMinor, state.currency)} per ${plan.period}.` : "", live && sub.periodEnd ? `Paid until ${when(sub.periodEnd)}.` : ""].filter(Boolean).join(" ");
        parts.push(
          el(
            "div",
            { class: "row" },
            el("div", { class: "row-head" }, el("strong", null, sub.title), el("span", { class: label[1] ? `badge badge-${label[1]}` : "badge" }, label[0])),
            said ? el("p", { class: "muted small plan-line" }, said) : null,
            plan && live ? el("ul", { class: "facts-list muted small" }, planFacts(plan, state.currency).map((fact) => el("li", null, fact))) : null,
            live
              ? el(
                  "div",
                  { class: "btn-row" },
                  button("Manage billing", { small: true, onclick: (event) => leaveFor(event.currentTarget, () => call("POST", "/api/portal"), failedHere) }),
                  others.length > 0
                    ? button("Change plan", {
                        id: "plan-change-toggle",
                        small: true,
                        kind: "quiet",
                        attrs: { "aria-expanded": state.changing ? "true" : "false", "aria-controls": "plan-change" },
                        onclick: () => {
                          state.changing = !state.changing;
                          renderPlan();
                          restoreFocus("plan-change-toggle");
                        },
                      })
                    : null,
                )
              : null,
            live && others.length > 0
              ? el("div", { id: "plan-change", class: "disclosed", hidden: !state.changing }, el("div", { class: "plans" }, others.map((p) => planCard(p, state.currency, { subscription: sub, action: (x) => button(`Switch to ${x.title}`, { onclick: checkout(x) }) }))))
              : null,
          ),
        );
      }
      if (!state.plansKnown) parts.push(el("p", { class: "muted" }, "The plans could not be loaded just now. Reload the page to try again."));
      else if (!live && state.plans.length > 0) parts.push(el("div", { class: "plans" }, state.plans.map((p) => planCard(p, state.currency, { subscription: sub, action: (x) => button(`Choose ${x.title}`, { kind: "primary", onclick: checkout(x) }) }))));
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
      // The field is in the currency's own places, and says so before anything is typed.
      $("topup-unit").textContent = `(${state.currency})`;
      $("topup-amount").setAttribute("placeholder", bareAmount(Math.max(t.minimumMinor, t.optionsMinor[1] || t.optionsMinor[0] || t.minimumMinor), state.currency));
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
      state.usageCalls = u.total.calls;
      $("usage-panel").hidden = !sectionsOf(viewOf()).usage;
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
      const sections = sectionsOf(viewOf());
      renderNotice();
      renderStage();
      renderWorkspaces();
      renderPlan();
      $("balance-panel").hidden = !sections.balance;
      $("usage-panel").hidden = !sections.usage;
      renderBalance();
      // Credit and usage are asked for once the account has a plan that sells them, whenever that comes to be.
      if (sections.balance && !state.usageLoaded) {
        state.usageLoaded = true;
        loadUsage();
      }
      watch();
      openWhenReady();
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
      state.focusStage = true;
      const r = await call("POST", "/api/workspaces", { name });
      if (signInAgain(r)) return;
      if (!r.ok) {
        state.focusStage = false;
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
    // A workspace that became ready while the tab was behind another is opened when the person comes back to it.
    doc.addEventListener("visibilitychange", openWhenReady);
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
            // A plan that sells usage has some to show now; one that sells hosting only has none, and none is asked for.
            if (sectionsOf(viewOf()).balance) await loadUsage();
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
    for (const button of doc.querySelectorAll("[data-reveal]")) wireSecret(button);
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
