/**
 * The plan table: what each plan allows, and what it costs.
 *
 * One table, read by three consumers: the entitlement checks in this package, the
 * pricing documents and site (through `pricing/plans.json`, which
 * `scripts/export-pricing.mjs` generates from this file and a test keeps in step),
 * and the vendor's licence-signing tool. A number that appears in two places is a
 * number that will differ, so prices live here and nowhere else.
 *
 * What is NOT here: model usage. The agents run on the customer's own Anthropic (or
 * Bedrock / Vertex / Foundry) credentials, billed to the customer by that provider;
 * Anthropic's terms for products built on Claude Code and the Agent SDK do not allow
 * a vendor to pay for, resell or intermediate that usage. So every price below is a
 * platform fee for the runtime, never a token price. See docs/commercial/pricing.md.
 *
 * What is NOT claimed: every entry in `features` exists in the product today, and a
 * feature that does not is listed under `roadmap` and never sold as included.
 */

export type PlanId = "community" | "team" | "business" | "enterprise";

export const PLAN_IDS: readonly PlanId[] = ["community", "team", "business", "enterprise"];

/** `null` means no limit. */
export interface PlanLimits {
  /** Agents (seats) in one mesh, the `human` seat not counted. */
  maxSeatsPerMesh: number | null;
  /** Projects open at once under one host. A single `ordane run` is one project. */
  maxProjects: number | null;
  /** Agent turns running at once, across every open project of a host. */
  maxConcurrentTurns: number | null;
}

/**
 * Product capabilities a plan includes. Each id is checked by code that exists (`checkFeature(…, "<id>")` in the
 * servers or the CLI), and a test fails on an id nothing checks: a flag that gates nothing is a claim, not a feature.
 * The multi-project host is deliberately not one: every plan can run it, and what separates the plans is how many
 * projects it may have open (`maxProjects`).
 */
export type FeatureId = "usage-export" | "prometheus-metrics";

export const FEATURE_IDS: readonly FeatureId[] = ["usage-export", "prometheus-metrics"];

export interface PlanDefinition {
  id: PlanId;
  name: string;
  /** One line a buyer can repeat. */
  tagline: string;
  /** USD per month billed monthly; `null` when the plan is free or quoted. */
  priceMonthlyUsd: number | null;
  /** USD per month when billed annually (a flat fraction off monthly). */
  priceMonthlyAnnualUsd: number | null;
  /** `contact` plans are quoted, not listed. */
  pricing: "free" | "listed" | "contact";
  limits: PlanLimits;
  features: readonly FeatureId[];
  support: string;
  /** Included in the plan today. Not a promise about the future. */
  includes: readonly string[];
  /** On the roadmap, not in the product; shown to buyers as such, never as included. */
  roadmap: readonly string[];
}

export const PLANS: Readonly<Record<PlanId, PlanDefinition>> = {
  community: {
    id: "community",
    name: "Community",
    tagline: "Run a whole AI team on your own machine, free.",
    priceMonthlyUsd: 0,
    priceMonthlyAnnualUsd: 0,
    pricing: "free",
    limits: { maxSeatsPerMesh: 8, maxProjects: 1, maxConcurrentTurns: 4 },
    features: [],
    support: "Community (issues and documentation)",
    includes: [
      "The full runtime: event-sourced kernel, policy enforcement, scheduler, artifacts, replay",
      "Dashboard, designer, CLI and the project host with its spend ceiling",
      "Token-free demo and stub runtime",
      "One open project, up to 8 seats, 4 concurrent turns",
    ],
    roadmap: [],
  },
  team: {
    id: "team",
    name: "Team",
    tagline: "Several projects under one host, with usage reporting.",
    priceMonthlyUsd: 149,
    priceMonthlyAnnualUsd: 124,
    pricing: "listed",
    limits: { maxSeatsPerMesh: 12, maxProjects: 5, maxConcurrentTurns: 8 },
    features: ["usage-export", "prometheus-metrics"],
    support: "Email, next business day",
    includes: [
      "Everything in Community",
      "Up to 5 projects open under one host, 12 seats per mesh, 8 concurrent turns",
      "Usage export (JSON and CSV) and Prometheus metrics",
    ],
    roadmap: [],
  },
  business: {
    id: "business",
    name: "Business",
    tagline: "A fleet of projects, with priority support and a deployment you can hand to ops.",
    priceMonthlyUsd: 599,
    priceMonthlyAnnualUsd: 499,
    pricing: "listed",
    limits: { maxSeatsPerMesh: 30, maxProjects: 25, maxConcurrentTurns: 24 },
    features: ["usage-export", "prometheus-metrics"],
    support: "Priority email, 4 business hours first response",
    includes: [
      "Everything in Team",
      "Up to 25 projects, 30 seats per mesh, 24 concurrent turns",
      "Support for the container image and Helm chart deployment, with upgrade and backup runbooks",
      "Security questionnaire support",
    ],
    roadmap: ["Single sign-on (OIDC)", "Per-operator identity and roles", "Audit-log export with operator identity"],
  },
  enterprise: {
    id: "enterprise",
    name: "Enterprise",
    tagline: "Unlimited scale, your terms, your environment.",
    priceMonthlyUsd: null,
    priceMonthlyAnnualUsd: null,
    pricing: "contact",
    limits: { maxSeatsPerMesh: null, maxProjects: null, maxConcurrentTurns: null },
    features: ["usage-export", "prometheus-metrics"],
    support: "Named contact and a support agreement",
    includes: [
      "Everything in Business",
      "No seat, project or concurrency limits",
      "Air-gapped and private-registry installs",
      "Custom terms, security review and a support agreement",
    ],
    roadmap: ["Single sign-on (OIDC)", "Per-operator identity and roles", "Audit-log export with operator identity"],
  },
};

/** What an install with no licence gets. */
export const COMMUNITY: PlanDefinition = PLANS.community;

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === "string" && (PLAN_IDS as readonly string[]).includes(value);
}

export function isFeatureId(value: unknown): value is FeatureId {
  return typeof value === "string" && (FEATURE_IDS as readonly string[]).includes(value);
}

/** The monthly price a buyer pays on the chosen billing, or `null` for a free or quoted plan. */
export function monthlyPrice(plan: PlanDefinition, billing: "monthly" | "annual"): number | null {
  return billing === "annual" ? plan.priceMonthlyAnnualUsd : plan.priceMonthlyUsd;
}
