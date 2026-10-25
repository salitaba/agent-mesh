"use strict";
// The pricing page's calculator. The plans, their prices and the measured mission come from the data block in the page
// (script#plans-data, written by scripts/export-pricing.mjs); the plan cards and the table are generated from the same data,
// and the Annual/Monthly choice is plain CSS. This script only adds the estimate, and it needs nothing else to run.

(function () {
  var dataNode = document.getElementById("plans-data");
  var form = document.getElementById("calc");
  var out = document.getElementById("result");
  // The same figure over the fields on a phone, where the form and the estimate cannot be on the screen together.
  var totalPlan = document.getElementById("calc-total-plan");
  var totalFigure = document.getElementById("calc-total-figure");
  if (!dataNode || !form || !out) return;
  var data = JSON.parse(dataNode.textContent);
  var run = data.measuredRuns[0];

  var MODEL_NAMES = { "claude-haiku-4-5": "Claude Haiku 4.5", "claude-sonnet-5-5": "Claude Sonnet 5.5", "claude-opus-5-5": "Claude Opus 5.5", "claude-fable-5-1": "Claude Fable 5.1" };
  var field = function (id) { return document.getElementById(id); };
  var money = function (n) { return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 }); };
  var money2 = function (n) { return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var nameOf = function (id) { return MODEL_NAMES[id] || id; };
  var period = function () {
    var checked = document.querySelector("input[name=billing]:checked");
    return checked ? checked.value : "annual";
  };
  var el = function (tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  var row = function (label, who, value, strong) {
    var r = el("div", "row");
    var left = el("span", strong ? "total" : "", label);
    if (who) { left.appendChild(document.createTextNode(" ")); left.appendChild(el("span", "who", who)); }
    r.appendChild(left);
    r.appendChild(el(strong ? "span" : "b", strong ? "total" : "", value));
    return r;
  };

  // A number field is a whole number in a stated range. Reading it returns the figure the estimate uses, and, when the
  // field is empty, not a whole number, or outside the range, the sentence that says so: the estimate used to replace 0
  // projects with 1 silently (the field invalid, the browser's message never shown because the form is never submitted)
  // while the ledger read "$138 / month" as if nothing had happened.
  var LIMITS = {
    "c-projects": { low: 1, high: 1000 },
    "c-seats": { low: 1, high: 1000 },
    "c-missions": { low: 0, high: 100000 },
  };
  var number = function (id) {
    var rule = LIMITS[id];
    var raw = field(id).value.trim();
    var n = raw === "" ? NaN : Number(raw);
    var used = !isFinite(n) ? rule.low : Math.max(rule.low, Math.min(rule.high, Math.round(n)));
    var problem = "";
    if (!isFinite(n)) problem = "Enter " + rule.low + " or more. The estimate uses " + rule.low + ".";
    else if (!Number.isInteger(n)) problem = "Enter a whole number. The estimate uses " + used + ".";
    else if (n < rule.low) problem = "Enter " + rule.low + " or more. The estimate uses " + rule.low + ".";
    else if (n > rule.high) problem = "Enter " + rule.high.toLocaleString("en-US") + " or less. The estimate uses " + rule.high.toLocaleString("en-US") + ".";
    return { value: used, problem: problem };
  };
  var setError = function (id, problem) {
    var node = document.getElementById(id + "-error");
    if (!node) return;
    var input = field(id);
    if (problem) {
      if (node.textContent !== problem) node.textContent = problem;
      node.hidden = false;
      if (input && input.setAttribute) input.setAttribute("aria-invalid", "true");
    } else {
      node.hidden = true;
      node.textContent = "";
      if (input && input.removeAttribute) input.removeAttribute("aria-invalid");
    }
  };
  // The ledger is the whole estimate; reading it out on every keystroke would be the fine print over and over, so a
  // screen reader hears one short sentence after a pause, and the ledger stays there to be read at leisure.
  var said = document.getElementById("calc-said");
  var saying = 0;
  var tell = function (text) {
    if (!said) return;
    if (typeof window === "undefined" || typeof window.setTimeout !== "function") { said.textContent = text; return; }
    window.clearTimeout(saying);
    saying = window.setTimeout(function () { said.textContent = text; }, 400);
  };

  Object.keys(data.modelPrices.perMtokUsd).forEach(function (id) {
    var option = el("option", "", nameOf(id));
    option.value = id;
    if (id === run.model) option.selected = true;
    field("c-model").appendChild(option);
  });

  function calc() {
    var projects = number("c-projects");
    var seats = number("c-seats");
    var missions = number("c-missions");
    setError("c-projects", projects.problem);
    setError("c-seats", seats.problem);
    setError("c-missions", missions.problem);
    var model = field("c-model").value;
    var reports = field("c-reports").checked;
    var plan = data.plans.filter(function (p) {
      if (reports && p.features.indexOf("usage-export") < 0) return false;
      return (p.limits.maxProjects === null || projects.value <= p.limits.maxProjects) && (p.limits.maxSeatsPerMesh === null || seats.value <= p.limits.maxSeatsPerMesh);
    })[0];
    var annual = period() === "annual";
    var fee = plan.pricing === "listed" ? (annual ? plan.priceMonthlyAnnualUsd : plan.priceMonthlyUsd) : plan.pricing === "free" ? 0 : null;
    var spend = missions.value * run.costUsdByModel[model];
    // One total, said the same in the figure pinned over the fields and in the ledger below it. The free plan's
    // licence is $0, but the reader is still quoted their provider's bill: the figure was the word "Free" while the
    // ledger's total was $138 / month, so the two numbers on one screen disagreed. Where the total is only model
    // usage the figure says so, since there is no licence fee in it.
    var total = fee === null ? "Quoted, plus model usage" : money(fee + spend) + " / month";
    var figure = total + (plan.pricing === "listed" ? " (" + (annual ? "annual" : "monthly") + ")" : plan.pricing === "free" ? " (model usage)" : "");

    if (totalPlan) totalPlan.textContent = plan.name;
    if (totalFigure) totalFigure.textContent = figure;
    // The same answer in the one sentence a screen reader hears, without the "/" or the ledger's fine print.
    var spokenTotal = fee === null ? "quoted, plus model usage" : money(fee + spend) + " a month";
    tell(plan.name + ": " + spokenTotal + (plan.pricing === "listed" ? ", billed " + (annual ? "annually" : "monthly") : plan.pricing === "free" ? ", including model usage" : ""));
    out.textContent = "";
    out.appendChild(row("Plan", "", plan.name));
    out.appendChild(row("Platform fee", "(to us)", fee === null ? "quoted" : money(fee) + " / month" + (plan.pricing === "listed" ? ", billed " + (annual ? "annually" : "monthly") : "")));
    out.appendChild(row("Model usage", "(to your provider)", "about " + money(spend) + " / month"));
    out.appendChild(fee === null
      ? row("Total", "", total, true)
      : row("Roughly", "", total, true));
    out.appendChild(el("p", "fine",
      "Model usage assumes " + missions.value + " mission" + (missions.value === 1 ? "" : "s") + " like the one we measured (" + run.seats + " agents, " + run.turns + " turns, " +
      money2(run.costUsd) + " on " + nameOf(run.model) + "), re-priced at " + nameOf(model) + "'s published list price of " + data.modelPrices.asOf +
      ". A different model takes a different number of turns, so treat the spread across models as a range of prices, not a forecast. Your provider bills you directly; we never touch it."));
    if (plan.pricing === "free") out.appendChild(el("p", "fine", "The free plan has no licence and no expiry."));
  }

  form.addEventListener("submit", function (event) { event.preventDefault(); });
  form.addEventListener("input", calc);
  form.addEventListener("change", calc);
  Array.prototype.forEach.call(document.querySelectorAll("input[name=billing]"), function (radio) { radio.addEventListener("change", calc); });
  calc();
  document.querySelectorAll("[data-needs-script]").forEach(function (node) { node.hidden = false; });
})();
