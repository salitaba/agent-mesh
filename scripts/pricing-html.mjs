/**
 * The HTML the site shows of the plan table, written from the same export as the JSON block (scripts/export-pricing.mjs puts
 * each of these between its markers in the pages). Static markup, so that the plans, their prices and the measured mission
 * read without a script, and so that no number on the pricing page is typed by hand: a price changes in
 * packages/licensing/src/plans.ts and `npm run pricing:export` carries it here.
 *
 * Nothing in this file is a template language: each function takes the export (see PricingExport in
 * packages/licensing/src/export.ts) and returns a string.
 */

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const usd = (n) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const usdc = (n) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const cents = (n) => Math.round(n * 100) / 100;
const UNLIMITED = '<span aria-hidden="true">&infin;</span><span class="sr">Unlimited</span>';
const shown = (n) => (n === null ? UNLIMITED : String(n));

export const MODEL_NAMES = {
  "claude-haiku-4-5": "Claude Haiku 4.5",
  "claude-sonnet-5-5": "Claude Sonnet 5.5",
  "claude-opus-5-5": "Claude Opus 5.5",
  "claude-fable-5-1": "Claude Fable 5.1",
};
const modelName = (id) => MODEL_NAMES[id] ?? id;

/** "about 17%" when every paid plan saves the same whole percent, "up to N%" when they differ. */
function savingText(out) {
  const pcts = out.plans.map((p) => p.annualSavingsPercent).filter((n) => n !== null);
  if (pcts.length === 0) return "";
  const max = Math.max(...pcts);
  return pcts.every((n) => n === max) ? `saves about ${max}%` : `saves up to ${max}%`;
}

function priceBlocks(p) {
  if (p.pricing === "free") return '<p class="price"><span class="amount">Free</span><span class="per">no licence needed, no expiry</span></p>';
  if (p.pricing === "contact") return '<p class="price"><span class="amount">Let&rsquo;s talk</span><span class="per">quoted for your terms</span></p>';
  return [
    `<p class="price price-annual"><span class="amount">${usd(p.priceMonthlyAnnualUsd)}</span><span class="per">per month, billed annually (${usd(p.priceAnnualTotalUsd)} a year)</span></p>`,
    `<p class="price price-monthly"><span class="amount">${usd(p.priceMonthlyUsd)}</span><span class="per">per month, billed monthly</span></p>`,
  ].join("\n      ");
}

/** The Annual/Monthly choice (plain radio buttons, switched by CSS) and the four plan cards. */
export function renderPlanCards(out) {
  const cards = out.plans.map((p) => {
    const free = p.pricing === "free";
    const quoted = p.pricing === "contact";
    const cta = free
      ? '<a class="btn" href="../#try">Start free</a>'
      : `<a class="btn btn-primary" href="../contact/#sales" data-contact data-subject="Curule ${esc(p.name)} plan">${quoted ? "Talk to us" : `Get ${esc(p.name)}`}</a>`;
    return `    <article class="plan" id="plan-${esc(p.id)}" aria-labelledby="plan-${esc(p.id)}-name">
      <header class="plan-head"><h3 id="plan-${esc(p.id)}-name">${esc(p.name)}</h3><p class="plan-tag">${esc(p.tagline)}</p></header>
      <div class="plan-price">
      ${priceBlocks(p)}
      </div>
      <dl class="plan-limits">
        <div><dt>projects open</dt><dd>${shown(p.limits.maxProjects)}</dd></div>
        <div><dt>agents per mesh</dt><dd>${shown(p.limits.maxSeatsPerMesh)}</dd></div>
        <div><dt>turns at once</dt><dd>${shown(p.limits.maxConcurrentTurns)}</dd></div>
      </dl>
      <ul class="plan-includes">
${p.includes.map((i) => `        <li>${esc(i)}</li>`).join("\n")}
      </ul>
      <div class="plan-meta">
        <p class="plan-support">Support: ${esc(p.support)}</p>${p.roadmap.length ? `\n        <p class="plan-planned">Planned, not included: ${p.roadmap.map(esc).join("; ")}</p>` : ""}
      </div>
      <p class="plan-cta">${cta}</p>
    </article>`;
  });
  const saving = savingText(out);
  return `<fieldset class="pricing">
<legend class="sr">Billing period</legend>
<input class="billing-input" type="radio" name="billing" id="billing-annual" value="annual" checked>
<input class="billing-input" type="radio" name="billing" id="billing-monthly" value="monthly">
<div class="billing">
  <label for="billing-annual">Annual${saving ? ` <small>${saving}</small>` : ""}</label>
  <label for="billing-monthly">Monthly</label>
</div>
<div class="plans">
${cards.join("\n")}
</div>
</fieldset>`;
}

/** The plans side by side: the table a person scans, and the only place every limit and every price is in one grid. */
export function renderPlanTable(out) {
  const head = out.plans.map((p) => `<th scope="col">${esc(p.name)}</th>`).join("");
  const row = (label, cell) => `      <tr><th scope="row">${label}</th>${out.plans.map((p) => `<td${cell(p).cls ? ` class="${cell(p).cls}"` : ""}>${cell(p).html}</td>`).join("")}</tr>`;
  const price = (p, annual) => {
    if (p.pricing === "free") return { html: "Free" };
    if (p.pricing === "contact") return { html: "Quoted" };
    return { html: annual ? `${usd(p.priceMonthlyAnnualUsd)} <span class="muted unit">(${usd(p.priceAnnualTotalUsd)} a year)</span>` : usd(p.priceMonthlyUsd) };
  };
  const yes = (on) => (on ? { html: "Yes", cls: "yes" } : { html: "No", cls: "no" });
  const hasReports = (p) => p.features.includes("usage-export") && p.features.includes("prometheus-metrics");
  return `<div class="table-wrap" role="region" aria-label="The plans compared" tabindex="0">
  <table class="compare">
    <caption class="sr">The four plans side by side: price, limits, features and support. Prices are in US dollars and exclude taxes.</caption>
    <thead><tr><th scope="col"><span class="sr">Plan</span></th>${head}</tr></thead>
    <tbody>
${row("Per month, billed annually", (p) => price(p, true))}
${row("Per month, billed monthly", (p) => price(p, false))}
${row("Projects open at once", (p) => ({ html: shown(p.limits.maxProjects) }))}
${row("Agents (seats) per mesh", (p) => ({ html: shown(p.limits.maxSeatsPerMesh) }))}
${row("Concurrent agent turns", (p) => ({ html: shown(p.limits.maxConcurrentTurns) }))}
${row("Usage export and Prometheus metrics", (p) => yes(hasReports(p)))}
${row("Support", (p) => ({ html: esc(p.support) }))}
    </tbody>
  </table>
</div>`;
}

/** What the measured mission costs at each model's list price, and a month of such missions. */
export function renderRunCosts(out) {
  const run = out.measuredRuns[0];
  if (!run) return "";
  const models = Object.keys(out.modelPrices.perMtokUsd);
  const rows = models
    .map((m) => {
      const one = run.costUsdByModel[m];
      const own = m === run.model ? ' <span class="tag">what it ran on</span>' : "";
      return `      <tr><th scope="row">${esc(modelName(m))}${own}</th><td>${usdc(one)}</td><td>${usdc(cents(one * 10))}</td><td>${usdc(cents(one * 25))}</td><td>${usdc(cents(one * 100))}</td></tr>`;
    })
    .join("\n");
  return `<div class="table-wrap" role="region" aria-label="What the measured mission costs at each model's list price" tabindex="0">
  <table class="compare">
    <caption class="sr">The tokens of the measured mission priced at each model's list price of ${esc(out.modelPrices.asOf)}, and a month of 10, 25 or 100 such missions</caption>
    <thead><tr><th scope="col">Model</th><th scope="col">This mission</th><th scope="col">10 a month</th><th scope="col">25 a month</th><th scope="col">100 a month</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
</div>
<p class="small muted mt-s">Each model&rsquo;s list price on ${esc(out.modelPrices.asOf)}. The product&rsquo;s own estimate of spend is a backstop and not an invoice: your provider&rsquo;s bill is the one that counts.</p>`;
}

/** The four plans in a line, for the home page: a price and what it allows, and nothing else. */
export function renderPlanTeaser(out) {
  const items = out.plans.map((p) => {
    const amount = p.pricing === "free" ? "Free" : p.pricing === "contact" ? "Let&rsquo;s talk" : usd(p.priceMonthlyUsd);
    const per =
      p.pricing === "free"
        ? "no licence key, no expiry"
        : p.pricing === "contact"
          ? "quoted for your terms"
          : `per month, or ${usd(p.priceMonthlyAnnualUsd)} billed annually`;
    const u = p.limits;
    const part = (n, one, many) => (n === null ? `unlimited ${many}` : `${n} ${n === 1 ? one : many}`);
    const limits =
      u.maxProjects === null && u.maxSeatsPerMesh === null && u.maxConcurrentTurns === null
        ? "No limit on projects, agents or concurrent turns"
        : `${part(u.maxProjects, "project", "projects")} open, ${part(u.maxSeatsPerMesh, "agent", "agents")} per mesh, ${part(u.maxConcurrentTurns, "concurrent turn", "concurrent turns")}`;
    return `    <li><h3>${esc(p.name)}</h3><p class="amount">${amount}</p><p class="per">${per}</p><p class="limits">${limits}</p></li>`;
  });
  return `<ul class="teaser" aria-label="The plans">\n${items.join("\n")}\n</ul>`;
}
