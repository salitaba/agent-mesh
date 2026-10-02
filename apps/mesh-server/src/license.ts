/**
 * The licence, as the server sees it.
 *
 * `packages/licensing` decides what an install is entitled to from a token, a clock and a mode; this reads
 * the token from where the operator put it and keeps the answer fresh. It re-reads on a short timer
 * rather than once at boot, so `curule license install` takes effect on a running server without a restart,
 * and an expiry that passes while the server is up is noticed.
 *
 * Nothing here talks to a network, and nothing here stops anything that is running: `enforce` refuses to
 * START what the plan does not allow, and the callers that ask (a mesh boot, a project open, a feature
 * route) decide what a refusal looks like.
 */
import {
  checkFeature,
  checkProjects,
  checkSeats,
  findLicense,
  loadEntitlements,
  type Check,
  type Entitlements,
  type FeatureId,
  type PublicKeySet,
} from "../../../packages/licensing/src/index";

/** A refusal to start something the plan does not allow, in `enforce` mode. The CLI exits 78 on it. */
export class LicenseLimitError extends Error {
  readonly code = "license_limit";
  constructor(message: string) {
    super(message);
    this.name = "LicenseLimitError";
  }
}

export interface LicenseProviderOptions {
  /** Where `license.key` lives when no environment variable names one: the mesh home. */
  home: string;
  env?: NodeJS.ProcessEnv;
  publicKeys?: PublicKeySet;
  now?: () => Date;
  /** How long an answer is reused. Default 30 seconds. */
  ttlMs?: number;
}

export interface CurrentLicense {
  entitlements: Entitlements;
  /** Where the token was found (`MESH_LICENSE`, a file path), or absent when there is no licence. */
  source?: string;
}

export class LicenseProvider {
  private cached: { at: number; value: CurrentLicense } | undefined;

  constructor(private readonly options: LicenseProviderOptions) {}

  current(): CurrentLicense {
    const now = (this.options.now ?? (() => new Date()))();
    const ttl = this.options.ttlMs ?? 30_000;
    if (this.cached && now.getTime() - this.cached.at < ttl) return this.cached.value;
    const env = this.options.env ?? process.env;
    const entitlements = loadEntitlements(env, this.options.home, now, this.options.publicKeys);
    const found = findLicense(env, this.options.home);
    const value: CurrentLicense = found ? { entitlements, source: found.source } : { entitlements };
    this.cached = { at: now.getTime(), value };
    return value;
  }

  /** Drop the cached answer, so the next `current()` reads the file again. */
  refresh(): void {
    this.cached = undefined;
  }
}

/** Throw `LicenseLimitError` when `check` is a refusal; otherwise return its message when there is one (a warning), else undefined. */
export function enforceOrWarn(check: Check): string | undefined {
  if (check.blocked) throw new LicenseLimitError(check.message ?? "this is outside the plan's limits");
  return check.ok ? undefined : check.message;
}

export { checkFeature, checkProjects, checkSeats };
export type { Check, Entitlements, FeatureId };

/** What `/license` answers: the entitlements, where they came from, and how much of them is in use. */
export interface LicenseView extends Entitlements {
  source?: string;
  usage: Record<string, number>;
}

export function licenseView(current: CurrentLicense, usage: Record<string, number>): LicenseView {
  return { ...current.entitlements, ...(current.source ? { source: current.source } : {}), usage };
}
