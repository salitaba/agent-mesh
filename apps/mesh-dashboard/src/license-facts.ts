/**
 * What the plan card and the licence banner say, with no DOM in it: the plan's limits against what is in use, when the licence
 * ends, what to do next, and the one case in which a banner appears at all.
 *
 * The facts come from the host (`GET /api/license`, which is packages/licensing's entitlements plus what is in use); the sentences
 * are this module's. They are written from what the licensing package and docs/commercial/licensing.md actually do, and
 * tests/dashboard/license-facts.test.ts reads those sources where a number or a promise is quoted. In particular nothing here
 * implies an account, a checkout or a server to phone: a licence is a signed line of text, checked offline on the host.
 */
import { longDate } from "./cost";

export type LicenseStatus = "community" | "valid" | "grace" | "expired" | "invalid";
export type Enforcement = "off" | "warn" | "enforce";
/** Every value of each, so a test can walk them all and compare them with packages/licensing. */
export const STATUSES: readonly LicenseStatus[] = ["community", "valid", "grace", "expired", "invalid"];
export const ENFORCEMENTS: readonly Enforcement[] = ["off", "warn", "enforce"];

/** What `/api/license` answers. Optional fields are absent for a plan with no licence. */
export interface LicenseView {
  status: LicenseStatus;
  plan: string;
  licensedPlan?: string;
  customer?: string;
  expiresAt?: string;
  graceEndsAt?: string;
  limits: { maxSeatsPerMesh: number | null; maxProjects: number | null; maxConcurrentTurns: number | null };
  features: string[];
  enforcement: Enforcement;
  summary: string;
  warnings: string[];
  source?: string;
  usage: Record<string, number>;
}

/** What is in use right now, as far as the console can see it. Null is "not shown here", never zero. */
export interface InUse {
  /** Projects open at once, which is what the plan limits. */
  open: number | null;
  /** Projects registered, which it does not. */
  registered: number | null;
  /** Seats in the project the console is looking at. */
  seats: number | null;
  /** Agent turns running now across every open project. */
  turns: number | null;
}

/** Warn this many days before a licence ends (packages/licensing: EXPIRY_WARNING_DAYS). */
export const EXPIRY_WARNING_DAYS = 30;
/** How long the host re-reads its licence (apps/mesh-server/src/license.ts), which is how soon a new key applies. */
export const LICENSE_REREAD_SECONDS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

const PLAN_NAMES: Record<string, string> = { community: "Community", team: "Team", business: "Business", enterprise: "Enterprise" };
/** "team" as "Team"; a plan this build has not heard of is shown as it came, capitalised. */
export const planName = (id: string | undefined): string => (id ? PLAN_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1) : "");

const FEATURE_NAMES: Record<string, string> = { "usage-export": "Usage export", "prometheus-metrics": "Prometheus metrics" };
export const featureName = (id: string): string => FEATURE_NAMES[id] ?? id;

const day = (iso: string | undefined): string => (iso ? longDate(iso.slice(0, 10)) : "");

/** Whole days until `iso`, rounded up as the host rounds them in its own warning. Negative once it has passed. */
export function daysUntil(iso: string, now: Date): number {
  return Math.ceil((Date.parse(iso) - now.getTime()) / DAY_MS);
}

export interface LimitRow {
  key: "seats" | "projects" | "turns";
  label: string;
  /** Null is no limit. */
  allowed: number | null;
  /** Null is not measured here. */
  inUse: number | null;
  /** What the number counts, said after it. */
  per: string;
  over: boolean;
  /** Running turns come and go, so being over for a moment is not a breach worth a banner. */
  transient: boolean;
  /** 0..1 against the limit, when both are known and the limit is a number. */
  ratio: number | null;
}

export function limitRows(l: LicenseView, use: InUse): LimitRow[] {
  const row = (key: LimitRow["key"], label: string, allowed: number | null, inUse: number | null, per: string, transient: boolean): LimitRow => ({
    key,
    label,
    allowed,
    inUse,
    per,
    over: allowed !== null && inUse !== null && inUse > allowed,
    transient,
    ratio: allowed !== null && allowed > 0 && inUse !== null ? Math.min(1, inUse / allowed) : null,
  });
  return [
    row("seats", "Seats per mesh", l.limits.maxSeatsPerMesh, use.seats, "in this project", false),
    row("projects", "Projects open at once", l.limits.maxProjects, use.open, "open now", false),
    row("turns", "Concurrent turns", l.limits.maxConcurrentTurns, use.turns, "running now", true),
  ];
}

/** The in-use figures the host sends (`usage.open`, `usage.registered`) put together with what the console knows itself. */
export function inUseOf(l: LicenseView | null, seats: number | null, turns: number | null): InUse {
  const n = (k: string): number | null => (l && typeof l.usage[k] === "number" ? l.usage[k]! : null);
  return { open: n("open"), registered: n("registered"), seats, turns };
}

export type ExpiryKind = "none" | "later" | "soon" | "grace" | "expired";
export interface Expiry { kind: ExpiryKind; days: number | null; text: string }

export function expiryOf(l: LicenseView, now: Date): Expiry {
  const plan = planName(l.licensedPlan ?? l.plan);
  if (l.status === "invalid") return { kind: "none", days: null, text: "No licence is in force." };
  if (!l.expiresAt) return { kind: "none", days: null, text: "No expiry: the Community plan does not lapse." };
  if (l.status === "expired") return { kind: "expired", days: null, text: `Expired on ${day(l.expiresAt)}. Running with the Community plan's limits.` };
  if (l.status === "grace") return { kind: "grace", days: null, text: `Expired on ${day(l.expiresAt)}. The ${plan} limits stay in force until ${day(l.graceEndsAt)}.` };
  const days = daysUntil(l.expiresAt, now);
  if (days <= EXPIRY_WARNING_DAYS) return { kind: "soon", days, text: `Expires on ${day(l.expiresAt)}, in ${days} ${days === 1 ? "day" : "days"}.` };
  return { kind: "later", days, text: `Valid until ${day(l.expiresAt)}.` };
}

/** Where the key was read from (shown as code), or where Curule looks when there is none. */
export function whereFound(l: LicenseView): { text: string; code?: string } {
  if (l.source) return { text: "Read from", code: l.source };
  return { text: "No key is installed. Curule looks in MESH_LICENSE, then MESH_LICENSE_FILE, then license.key in the host's home folder." };
}

export function enforcementSentence(mode: Enforcement): string {
  switch (mode) {
    case "off": return "Limits are not checked.";
    case "warn": return "A limit that is exceeded is reported, and nothing is refused. This is the default.";
    case "enforce": return "What the plan does not allow will not start. Nothing that is running is stopped.";
  }
}

/** Whether anything that is not a passing burst is past what the plan allows. */
export const isOver = (rows: readonly LimitRow[]): boolean => rows.some((r) => r.over && !r.transient);

/** The headline under the plan's name: what the plan is, and why. `over` is `isOver` of its limits. */
export function headline(l: LicenseView, over = false): string {
  const more = over ? " More is in use than the plan allows." : "";
  switch (l.status) {
    case "community": return over ? "More is in use than the Community plan allows." : "No licence is needed within these limits.";
    case "valid": return `Licensed to ${l.customer ?? "this install"}.${more}`;
    case "grace": return `Licensed to ${l.customer ?? "this install"}. The licence has expired and is in its grace period.${more}`;
    case "expired": return `The ${planName(l.licensedPlan)} licence has expired, so the Community plan's limits apply.${more}`;
    case "invalid": return `A licence was found but not accepted, so the Community plan's limits apply.${more}`;
  }
}

export type StateTone = "ok" | "warn" | "bad";
/** The short state beside the plan's name, and how loudly to say it. A key that is lapsing or lapsed outranks being over a limit. */
export function stateOf(l: LicenseView, now: Date, over = false): { label: string; tone: StateTone } {
  switch (l.status) {
    case "community": return over ? { label: "Over a limit", tone: "warn" } : { label: "No licence", tone: "ok" };
    case "valid": {
      if (expiryOf(l, now).kind === "soon") return { label: "Expiring", tone: "warn" };
      return over ? { label: "Over a limit", tone: "warn" } : { label: "Valid", tone: "ok" };
    }
    case "grace": return { label: "Expired, in grace", tone: "warn" };
    case "expired": return { label: "Expired", tone: "bad" };
    case "invalid": return { label: "Not accepted", tone: "bad" };
  }
}

export interface Problem {
  /** Stable across polls, so a banner that was acknowledged stays quiet until this changes. */
  id: string;
  title: string;
  body: string;
}

/**
 * What needs the operator's attention, most urgent first: a key that was not accepted, one that has lapsed, one about to, and more
 * projects open than the plan allows. These are the cases docs/commercial/licensing.md says the banner is for. Nothing is a problem
 * when the host's enforcement is off, and Community with nothing over is not one: it is a plan, not an error.
 */
export function problemsOf(l: LicenseView, use: InUse, now: Date): Problem[] {
  if (l.enforcement === "off") return [];
  const out: Problem[] = [];
  const plan = planName(l.plan);
  const ex = expiryOf(l, now);
  if (l.status === "invalid") {
    out.push({ id: "invalid", title: "The licence was not accepted.", body: "Curule is running with the Community plan's limits." });
  } else if (l.status === "expired") {
    out.push({ id: `expired:${l.expiresAt}`, title: "The licence has expired.", body: "Curule is running with the Community plan's limits. Nothing was deleted." });
  } else if (l.status === "grace") {
    out.push({ id: `grace:${l.graceEndsAt}`, title: "The licence has expired.", body: `The ${plan} limits stay in force until ${day(l.graceEndsAt)}.` });
  } else if (ex.kind === "soon") {
    out.push({ id: `soon:${l.expiresAt}`, title: `The licence expires in ${ex.days} ${ex.days === 1 ? "day" : "days"}.`, body: `Install a renewed key before ${day(l.expiresAt)} to keep the ${plan} limits.` });
  }
  const projects = limitRows(l, use).find((r) => r.key === "projects")!;
  if (projects.over) {
    out.push({
      id: `projects:${projects.inUse}/${projects.allowed}`,
      title: "More projects are open than the plan allows.",
      body: `${projects.inUse} are open; the ${plan} plan allows ${projects.allowed}.${l.enforcement === "warn" ? " Nothing is refused." : ""}`,
    });
  }
  return out;
}

/** The banner above every view, or null. One title, and what else there is folded into one clause. */
export function bannerOf(l: LicenseView, use: InUse, now: Date): { title: string; body: string; signature: string } | null {
  const problems = problemsOf(l, use, now);
  const first = problems[0];
  if (!first) return null;
  const more = problems.length - 1;
  return {
    title: first.title,
    body: `${first.body}${more > 0 ? ` ${more} more ${more === 1 ? "thing needs" : "things need"} a look.` : ""}`,
    signature: problems.map((p) => p.id).join("|"),
  };
}

export interface Next { text: string; command?: string }

const INSTALL = "curule license install <key>";

/**
 * What to do about it, in the order of how much it matters, as sentences with the command where there is one. The last
 * sentence of the card (nothing is sent anywhere; no account) is not here because it is true in every state.
 */
export function nextSteps(l: LicenseView, use: InUse, now: Date): Next[] {
  const out: Next[] = [];
  const ex = expiryOf(l, now);
  const plan = planName(l.licensedPlan ?? l.plan);
  if (l.status === "invalid") {
    const why = l.warnings[0];
    if (why) out.push({ text: why });
    out.push({ text: "Check a key without saving it:", command: "curule license verify <key>" });
    out.push({ text: "Replace the saved one:", command: INSTALL });
    out.push({ text: "Or go back to Community:", command: "curule license remove" });
  } else if (l.status === "expired") {
    out.push({ text: `Install a renewed key and the ${plan} plan returns within ${LICENSE_REREAD_SECONDS} seconds. Nothing was deleted.`, command: INSTALL });
  } else if (l.status === "grace") {
    out.push({ text: `Install a renewed key before ${day(l.graceEndsAt)}. The ${plan} limits stay in force until then.`, command: INSTALL });
  } else if (ex.kind === "soon") {
    out.push({ text: `Install the renewed key before ${day(l.expiresAt)} to keep the ${plan} limits.`, command: INSTALL });
  }
  for (const r of limitRows(l, use)) {
    if (!r.over || r.transient) continue;
    const consequence = l.enforcement === "enforce" ? (r.key === "projects" ? "A project beyond the limit will not open." : "A mesh beyond the limit will not start.") : l.enforcement === "warn" ? "Nothing is refused while enforcement is warn." : "";
    if (r.key === "projects") {
      out.push({ text: `${r.inUse} projects are open and the ${planName(l.plan)} plan allows ${r.allowed}. Close ${r.inUse! - r.allowed!} to be within the plan, or install a licence for a plan with more. ${consequence}`.trim() });
    } else {
      out.push({ text: `This mesh has ${r.inUse} seats and the ${planName(l.plan)} plan allows ${r.allowed} per mesh. Remove seats from mesh.yaml, or install a licence for a plan with more. ${consequence}`.trim() });
    }
  }
  if (out.length === 0) {
    out.push(
      l.status === "community"
        ? { text: "Nothing to do. To lift a limit, install a licence key from your vendor:", command: INSTALL }
        : { text: `Nothing to do before ${day(l.expiresAt)}. To replace the key:`, command: INSTALL },
    );
  }
  return out;
}

/** Where the commands are run. */
export const RUN_WHERE = "Run commands on the machine that runs the host. With Docker Compose, start them with docker compose exec mesh.";

/** True in every state, and the reason there is nothing to sign in to. */
export const OFFLINE_NOTE = `A licence is a signed line of text. It is checked on the host against public keys built into Curule: there is no account to sign in to, no checkout in this console, and nothing is sent anywhere. A running host reads a new key within ${LICENSE_REREAD_SECONDS} seconds, with no restart.`;
