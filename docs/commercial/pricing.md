# Pricing

Proposed list prices, and the reasoning behind them. The numbers live in one place,
`packages/licensing/src/plans.ts`, and are generated from it into this page, `pricing/plans.json` and the
website. A test fails if any of them disagree, so what a buyer reads is what the product enforces.

**Status of these numbers.** They are list prices built from the constraint and the measurement below, and they are
proposals: nothing in this repository measures what customers will pay.

## The constraint that shapes everything

Ordane runs the Claude Code agent runtime, through the Claude Agent SDK. Anthropic's terms for products that
run Claude Code say (read from [code.claude.com/docs/en/legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance)
on 2026-10-01; confirm they have not changed before you rely on them):

> Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf. Each end user must
> authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider
> credential (Amazon Bedrock, Google Cloud's Agent Platform, Microsoft Foundry). That usage is billed directly to
> the end user under their own agreement with Anthropic or, for third-party inference providers, with the
> applicable provider.

and, for products built on the SDK, that developers "should use API key authentication through Claude Console or
a supported cloud provider".

So **the vendor cannot sell model usage**: not tokens, not credits, not a bundle. Every plan is a **platform
fee for the runtime**. The customer brings their own Anthropic, Bedrock, Vertex or Foundry credentials, and their
provider bills them for the model. The product reports usage and an estimate of its cost, and never charges for
either.

This is also the strongest thing to say to a buyer: no markup on the model, their own enterprise discounts and
rate limits apply, and their code and prompts go to their provider and nowhere else.

## The plans

<!-- generated:plans:start (scripts/export-pricing.mjs; do not edit between the markers) -->
| | Community | Team | Business | Enterprise |
|---|---|---|---|---|
| Per month, billed monthly | Free | $149 | $599 | Contact us |
| Per month, billed annually | Free | $124 ($1,488 a year) | $499 ($5,988 a year) | Contact us |
| Projects open at once | 1 | 5 | 25 | Unlimited |
| Seats (agents) per mesh | 8 | 12 | 30 | Unlimited |
| Concurrent agent turns | 4 | 8 | 24 | Unlimited |
| Usage export and Prometheus metrics | No | Yes | Yes | Yes |
| Support | Community (issues and documentation) | Email, next business day | Priority email, 4 business hours first response | Named contact and a support agreement |
<!-- generated:plans:end -->

Prices are in US dollars, exclude taxes, and are for the runtime only. A **seat** is one agent in a mesh (the
operator at the console is not a seat). A **project** is one mesh, and the limit is how many are *open* at once;
registering more is free. **Concurrent turns** is how many agent turns may run at the same moment across the
whole host.

What a limit does depends on the instance's enforcement mode ([licensing.md](licensing.md)): by default a
limit is **reported and never refused**; under `enforce`, what the plan does not allow does not *start*, and
nothing that is running is ever stopped. The Community plan is real and unlimited in time: one open project,
eight seats, no licence needed, nothing expires. Those limits are also what the source licence lets anyone run in
production for free, whatever the enforcement mode ([licensing.md](licensing.md#the-source-licence)).

What each plan includes beyond the table is in `plans.ts` (`includes`) and on the website. Roadmap items
(single sign-on, per-operator identity and roles, audit-log export with operator identity) are listed as
roadmap and are never sold as included.

## What a customer actually spends

The platform fee is the smaller number. Model usage is the bigger one, and it is the customer's, so a buyer
asking "what will this cost me?" needs both. This is the one real mission we have measured, from
`pricing/measured-runs.json` (with its source), re-priced at Anthropic's published list prices.

<!-- generated:economics:start (scripts/export-pricing.mjs; do not edit between the markers) -->
**cronlite-run-7** (2026-10-01): 5 seats, 80 turns, 31 minutes, ran on `claude-haiku-4-5` for $5.52. Goal met twice (round 1 in 9 min 53 s; again 18 min 33 s after the reopen). The final product scored 99.6% of 3034 stratified checks on an oracle written from the spec before any output was read; its own suite passed 63 of 63.

Where that bill went: cache reads $3.23 (59%), cache writes $1.19 (22%), output $1.09 (20%), fresh input $0.00 (0%). Cache reads were 96% of the 33.5 million tokens the provider counted.

| Model | These tokens at 2026-10-01 list prices | A month of 10 runs | 25 runs | 100 runs |
|---|---|---|---|---|
| `claude-haiku-4-5` (what it ran on) | $5.52 | $55.20 | $138.00 | $552.00 |
| `claude-sonnet-5-5` | $11.03 | $110.30 | $275.75 | $1,103.00 |
| `claude-opus-5-5` | $15.60 | $156.00 | $390.00 | $1,560.00 |
| `claude-fable-5-1` | $30.93 | $309.30 | $773.25 | $3,093.00 |
<!-- generated:economics:end -->

How to read it, and how not to:

- **One run is an illustration, not a rate.** Missions differ in size by an order of magnitude. This one is a
  small library built by five agents and reopened once.
- **The same tokens on another model is arithmetic, not a forecast.** A different model takes a different
  number of turns and writes different amounts. The table shows the spread of prices, not what that model would
  cost on this mission.
- **Cached prompts dominate the bill.** Agents re-read their conversation every turn, so most tokens are cache
  reads, which are cheap per token and still more than half the money. This is why the host's spend ceiling
  prices all four token classes: a ceiling that counted only fresh input and output would have tripped at five
  times the intended spend.
- **The product's own estimate is a backstop, not an invoice.** The provider's bill is authoritative. The
  host's spend ceiling (default $50) parks every open project when the estimate reaches it.

For a sense of proportion: at 25 missions like this one a month, the model bill on Haiku is about the same as
the Team platform fee, and on Sonnet about twice it. The platform fee is the same order of magnitude as the
model bill, not ten times it, and that is the proportion the Team price is aimed at.

## What is deliberately not for sale

- **Model usage.** Above.
- **A hosted service.** This is software the customer runs. Running it for them would put the vendor in the
  position the terms above describe unless every customer authenticated with their own credentials, which is
  possible and is a separate product decision, not an option of this one.
- **Anything on the roadmap.** It is listed as roadmap until it exists and is tested.

## Changing a price

Edit `plans.ts`, run `npm run pricing:export`, commit. Existing licences are unaffected: a licence carries its
plan, limits and expiry, so a price change takes effect at renewal, when a new licence is issued.
