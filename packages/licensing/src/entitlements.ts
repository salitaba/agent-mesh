/**
 * What an install is entitled to right now: its plan's limits, as of a licence (or the
 * lack of one), a clock, and an enforcement mode.
 *
 * The decision is a pure function of `(token, keys, now)`, so every state — no
 * licence, valid, expiring, in grace, expired, forged — is a test, and the answer
 * does not depend on when it is asked for anything but the clock it is handed.
 *
 * Enforcement has three modes. `warn` (the default) computes the limits and reports a
 * breach without ever refusing to run, so shipping this changes nothing for anyone
 * until the vendor turns it on; `enforce` refuses to START what the plan does not
 * allow (a mesh with too many seats, a project over the cap) and never stops
 * something already running or touches anyone's data; `off` checks nothing. An
 * expired licence degrades to the Community plan after its grace period instead of
 * failing: a customer whose card lapsed over a weekend is not locked out of their
 * own organization of agents.
 */
import * as fs from "fs";
import * as path from "path";
import { COMMUNITY, PLANS, type FeatureId, type PlanId, type PlanLimits } from "./plans";
import { LICENSE_PUBLIC_KEYS } from "./keys";
import { DEFAULT_GRACE_DAYS, verifyLicense, type PublicKeySet } from "./token";

export type LicenseStatus = "community" | "valid" | "grace" | "expired" | "invalid";
export type Enforcement = "off" | "warn" | "enforce";

export const DEFAULT_ENFORCEMENT: Enforcement = "warn";

/** Warn this many days before a licence expires. */
export const EXPIRY_WARNING_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface Entitlements {
  status: LicenseStatus;
  /** The plan whose limits apply right now: Community unless a licence is valid or in grace. */
  plan: PlanId;
  /** The plan the licence names, once it verified, even if it has since lapsed. */
  licensedPlan?: PlanId;
  licenseId?: string;
  customer?: string;
  expiresAt?: string;
  graceEndsAt?: string;
  limits: PlanLimits;
  features: FeatureId[];
  enforcement: Enforcement;
  /** One line for a banner or a log, never empty. */
  summary: string;
  /** Things the operator should act on. Empty when there is nothing to do. */
  warnings: string[];
}

export interface ResolveInput {
  /** The raw licence token, when the install has one. */
  token?: string | undefined;
  publicKeys?: PublicKeySet;
  now?: Date;
  enforcement?: Enforcement;
}

const limitText = (n: number | null): string => (n === null ? "unlimited" : String(n));

function limitsSentence(limits: PlanLimits): string {
  return `${limitText(limits.maxSeatsPerMesh)} seats per mesh, ${limitText(limits.maxProjects)} project(s), ${limitText(limits.maxConcurrentTurns)} concurrent turns`;
}

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function resolveEntitlements(input: ResolveInput = {}): Entitlements {
  const now = (input.now ?? new Date()).getTime();
  const enforcement = input.enforcement ?? DEFAULT_ENFORCEMENT;
  const community = (status: LicenseStatus, extra: Partial<Entitlements>): Entitlements => ({
    status,
    plan: "community",
    limits: { ...COMMUNITY.limits },
    features: [...COMMUNITY.features],
    enforcement,
    summary: `${COMMUNITY.name} plan: ${limitsSentence(COMMUNITY.limits)}.`,
    warnings: [],
    ...extra,
  });

  const token = input.token?.trim();
  if (!token) return community("community", {});

  const verified = verifyLicense(token, input.publicKeys ?? LICENSE_PUBLIC_KEYS);
  if (!verified.ok) {
    const warning = `Licence not accepted (${verified.reason}): ${verified.detail}. Running with the ${COMMUNITY.name} plan's limits.`;
    return community("invalid", { warnings: [warning], summary: `${COMMUNITY.name} plan (a licence was found but not accepted): ${limitsSentence(COMMUNITY.limits)}.` });
  }

  const { claims } = verified;
  const expires = Date.parse(claims.expiresAt);
  const graceEnds = expires + (claims.graceDays ?? DEFAULT_GRACE_DAYS) * DAY_MS;
  const named = {
    licensedPlan: claims.plan,
    licenseId: claims.id,
    customer: claims.customer,
    expiresAt: claims.expiresAt,
    graceEndsAt: new Date(graceEnds).toISOString(),
  } as const;

  if (now > graceEnds) {
    return community("expired", {
      ...named,
      warnings: [`Licence ${claims.id} for ${claims.customer} expired on ${isoDay(expires)}. Running with the ${COMMUNITY.name} plan's limits; install a renewed licence to restore ${PLANS[claims.plan].name}.`],
      summary: `${COMMUNITY.name} plan (the ${PLANS[claims.plan].name} licence expired on ${isoDay(expires)}): ${limitsSentence(COMMUNITY.limits)}.`,
    });
  }

  const plan = PLANS[claims.plan];
  const limits: PlanLimits = { ...plan.limits, ...claims.limits };
  const features = [...new Set<FeatureId>([...plan.features, ...(claims.features ?? [])])];
  const warnings: string[] = [];
  let status: LicenseStatus = "valid";
  if (now > expires) {
    status = "grace";
    warnings.push(`Licence ${claims.id} expired on ${isoDay(expires)}. ${plan.name} limits stay in force until ${isoDay(graceEnds)}; install a renewed licence before then.`);
  } else if (expires - now <= EXPIRY_WARNING_DAYS * DAY_MS) {
    warnings.push(`Licence ${claims.id} expires on ${isoDay(expires)} (${Math.ceil((expires - now) / DAY_MS)} day(s)). Renew it to keep ${plan.name} limits.`);
  }
  return {
    status,
    plan: claims.plan,
    ...named,
    limits,
    features,
    enforcement,
    summary: `${plan.name} licence for ${claims.customer} (${claims.id}), ${status === "grace" ? `expired ${isoDay(expires)}, in grace until ${isoDay(graceEnds)}` : `valid until ${isoDay(expires)}`}: ${limitsSentence(limits)}.`,
    warnings,
  };
}

/** The outcome of asking whether something is allowed. */
export interface Check {
  /** Within the plan's limits. */
  ok: boolean;
  /** `ok` is false AND enforcement is `enforce`: the caller must refuse. */
  blocked: boolean;
  /** Why not, and what to do about it. Present when `ok` is false. */
  message?: string;
}

const UPGRADE_HINT = "Install a licence with 'curule license install <key>', or ask your vendor to change your plan.";

function verdict(ent: Entitlements, within: boolean, message: string): Check {
  if (within || ent.enforcement === "off") return { ok: true, blocked: false };
  return { ok: false, blocked: ent.enforcement === "enforce", message: `${message} ${UPGRADE_HINT}` };
}

const planLabel = (ent: Entitlements): string => `${PLANS[ent.plan].name} plan`;

export function checkSeats(ent: Entitlements, seats: number): Check {
  const max = ent.limits.maxSeatsPerMesh;
  return verdict(ent, max === null || seats <= max, `This mesh has ${seats} seats; the ${planLabel(ent)} allows ${limitText(max)} per mesh.`);
}

/** `wouldBeOpen` is the number of projects open once this one is, so opening the 2nd passes 2. */
export function checkProjects(ent: Entitlements, wouldBeOpen: number): Check {
  const max = ent.limits.maxProjects;
  return verdict(ent, max === null || wouldBeOpen <= max, `Opening this project would make ${wouldBeOpen} open; the ${planLabel(ent)} allows ${limitText(max)}.`);
}

export function checkFeature(ent: Entitlements, feature: FeatureId, label: string = feature): Check {
  return verdict(ent, ent.features.includes(feature), `${label} is not part of the ${planLabel(ent)}.`);
}

/**
 * The turn cap a host should run with: the tighter of what the operator configured and
 * what the plan allows. Only `enforce` tightens it; `warn` and `off` leave the
 * operator's setting alone, because a limit that is only reported cannot also be applied.
 */
export function effectiveConcurrentTurns(ent: Entitlements, configured: number | null): number | null {
  const plan = ent.limits.maxConcurrentTurns;
  if (ent.enforcement !== "enforce" || plan === null) return configured;
  return configured === null ? plan : Math.min(configured, plan);
}

/** Parse `MESH_LICENSE_ENFORCEMENT`; anything unrecognized falls back to the default rather than guessing. */
export function parseEnforcement(raw: string | undefined): Enforcement {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "off" || v === "warn" || v === "enforce" ? v : DEFAULT_ENFORCEMENT;
}

export const LICENSE_FILENAME = "license.key";

export interface LicenseSource {
  token: string;
  /** Where it came from, for messages: `MESH_LICENSE`, a file path. */
  source: string;
}

/**
 * Find the install's licence: `MESH_LICENSE` (the token itself), then the file named by
 * `MESH_LICENSE_FILE`, then `<home>/license.key`. The first that exists wins; an
 * unreadable file is skipped rather than fatal, because an unreadable licence is the
 * Community plan, not an outage.
 */
export function findLicense(env: NodeJS.ProcessEnv, home: string): LicenseSource | undefined {
  const inline = (env.MESH_LICENSE ?? "").trim();
  if (inline) return { token: inline, source: "MESH_LICENSE" };
  const candidates = [(env.MESH_LICENSE_FILE ?? "").trim(), path.join(home, LICENSE_FILENAME)].filter(Boolean);
  for (const file of candidates) {
    try {
      const text = fs.readFileSync(file, "utf8").trim();
      if (text) return { token: text, source: file };
    } catch {
      /* not there, or not readable */
    }
  }
  return undefined;
}

/** `findLicense` + `resolveEntitlements` with the enforcement mode read from the environment. */
export function loadEntitlements(env: NodeJS.ProcessEnv, home: string, now: Date = new Date(), publicKeys?: PublicKeySet): Entitlements {
  const found = findLicense(env, home);
  const input: ResolveInput = { token: found?.token, now, enforcement: parseEnforcement(env.MESH_LICENSE_ENFORCEMENT) };
  if (publicKeys) input.publicKeys = publicKeys;
  return resolveEntitlements(input);
}
