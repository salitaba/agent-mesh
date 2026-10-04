"use strict";
// The pricing page's calculator. The plans, their prices and the measured mission come from the data block in the page
// (script#plans-data, written by scripts/export-pricing.mjs); the plan cards and the table are generated from the same data,
// and the Annual/Monthly choice is plain CSS. This script only adds the estimate, and it needs nothing else to run.

(function () {
  var dataNode = document.getElementById("plans-data");
  var form = document.getElementById("calc");
  var out = document.getElementById("result");
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

  Object.keys(data.modelPrices.perMtokUsd).forEach(function (id) {
    var option = el("option", "", nameOf(id));
    option.value = id;
    if (id === run.model) option.selected = true;
    field("c-model").appendChild(option);
  });

  function calc() {
    var projects = Math.max(1, +field("c-projects").value || 1);
    var seats = Math.max(1, +field("c-seats").value || 1);
    var missions = Math.max(0, +field("c-missions").value || 0);
    var model = field("c-model").value;
    var reports = field("c-reports").checked;
    var plan = data.plans.filter(function (p) {
      if (reports && p.features.indexOf("usage-export") < 0) return false;
      return (p.limits.maxProjects === null || projects <= p.limits.maxProjects) && (p.limits.maxSeatsPerMesh === null || seats <= p.limits.maxSeatsPerMesh);
    })[0];
    var annual = period() === "annual";
    var fee = plan.pricing === "listed" ? (annual ? plan.priceMonthlyAnnualUsd : plan.priceMonthlyUsd) : plan.pricing === "free" ? 0 : null;
    var spend = missions * run.costUsdByModel[model];

    out.textContent = "";
    out.appendChild(row("Plan", "", plan.name));
    out.appendChild(row("Platform fee", "(to us)", fee === null ? "quoted" : money(fee) + " / month"));
    out.appendChild(row("Model usage", "(to your provider)", "about " + money(spend) + " / month"));
    out.appendChild(row("Roughly", "", fee === null ? "" : money(fee + spend) + " / month", true));
    out.appendChild(el("p", "fine",
      "Model usage assumes " + missions + " mission" + (missions === 1 ? "" : "s") + " like the one we measured (" + run.seats + " agents, " + run.turns + " turns, " +
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
