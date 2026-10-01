/**
 * Licence tokens: a signed statement of what a customer bought, checkable offline.
 *
 *     AML1.<kid>.<payload>.<signature>
 *
 * `payload` is the claims as JSON, base64url; `signature` is an Ed25519 signature,
 * base64url, over the ASCII text `AML1.<kid>.<payload>` — the exact bytes that are
 * in the token, so nothing is re-serialized between signing and checking. `kid`
 * names which public key to check with and sits OUTSIDE the payload, so no
 * unverified JSON is parsed to decide how to verify it.
 *
 * Nothing here talks to a network. A licence is checked against public keys that
 * ship in the build (`./keys`), so an air-gapped install verifies the same way a
 * connected one does, and there is no licence server to run, secure or keep up.
 *
 * What this is not: copy protection. The runtime is JavaScript; anyone who can edit
 * it can remove the check. The licence is how an honest customer proves, and a
 * vendor enforces, what was bought — the contract does the rest.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "crypto";
import { isFeatureId, isPlanId, type FeatureId, type PlanId, type PlanLimits } from "./plans";

export const LICENSE_PREFIX = "AML1";

/** Days after `expiresAt` during which the plan's limits still apply, and the operator is told. */
export const DEFAULT_GRACE_DAYS = 14;
export const MAX_GRACE_DAYS = 90;

export interface LicenseClaims {
  /** Claims schema version. */
  v: 1;
  /** Unique licence id, for support and revocation lists. */
  id: string;
  /** Who it was issued to: a company name or account id. */
  customer: string;
  plan: PlanId;
  issuedAt: string;
  expiresAt: string;
  /** Defaults to `DEFAULT_GRACE_DAYS`. */
  graceDays?: number;
  /** Negotiated limits that replace the plan's, field by field (`null` is unlimited). */
  limits?: Partial<PlanLimits>;
  /** Features added to the plan's. */
  features?: FeatureId[];
  notes?: string;
}

export type VerifyFailure = "malformed" | "unsupported-version" | "unknown-key" | "bad-signature" | "bad-claims";

export type VerifyResult =
  | { ok: true; kid: string; claims: LicenseClaims }
  | { ok: false; reason: VerifyFailure; detail: string };

/** Public keys by key id; each value is an Ed25519 public key as base64url SPKI DER. */
export type PublicKeySet = Readonly<Record<string, string>>;

const b64url = (buf: Buffer): string => buf.toString("base64url");
const fromB64url = (text: string): Buffer => Buffer.from(text, "base64url");

const KID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export function generateLicenseKeyPair(): { privateKeyPem: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKey: b64url(publicKey.export({ format: "der", type: "spki" })),
  };
}

function privateKeyOf(key: string | KeyObject): KeyObject {
  return typeof key === "string" ? createPrivateKey(key) : key;
}

/** Sign claims. Throws on claims that would not verify, so a bad licence is never issued. */
export function signLicense(claims: LicenseClaims, kid: string, privateKey: string | KeyObject): string {
  if (!KID_PATTERN.test(kid)) throw new Error(`key id '${kid}' must be 1-32 characters of A-Z a-z 0-9 _ -`);
  const problem = claimsProblem(claims);
  if (problem) throw new Error(`refusing to sign: ${problem}`);
  const signingInput = `${LICENSE_PREFIX}.${kid}.${b64url(Buffer.from(JSON.stringify(claims), "utf8"))}`;
  const signature = sign(null, Buffer.from(signingInput, "ascii"), privateKeyOf(privateKey));
  return `${signingInput}.${b64url(signature)}`;
}

/** Check a token against `publicKeys`. Never throws: every failure is a result the caller can show. */
export function verifyLicense(token: string, publicKeys: PublicKeySet): VerifyResult {
  const text = typeof token === "string" ? token.trim() : "";
  const parts = text.split(".");
  if (parts.length !== 4) return fail("malformed", "expected AML1.<kid>.<payload>.<signature>");
  const [prefix, kid, payload, signature] = parts as [string, string, string, string];
  if (prefix !== LICENSE_PREFIX) {
    return /^AML\d+$/.test(prefix)
      ? fail("unsupported-version", `licence format ${prefix} is newer than this build understands (${LICENSE_PREFIX})`)
      : fail("malformed", "does not start with AML1");
  }
  if (!KID_PATTERN.test(kid) || !payload || !signature) return fail("malformed", "empty or invalid segment");
  const spki = publicKeys[kid];
  if (!spki) return fail("unknown-key", `no public key '${kid}' is built into this release`);
  let ok = false;
  try {
    const key = createPublicKey({ key: fromB64url(spki), format: "der", type: "spki" });
    ok = verify(null, Buffer.from(`${prefix}.${kid}.${payload}`, "ascii"), key, fromB64url(signature));
  } catch {
    return fail("bad-signature", "the signature could not be checked");
  }
  if (!ok) return fail("bad-signature", "the signature does not match: the licence was altered or signed with another key");
  let claims: unknown;
  try {
    claims = JSON.parse(fromB64url(payload).toString("utf8"));
  } catch {
    return fail("bad-claims", "the payload is not JSON");
  }
  const problem = claimsProblem(claims);
  if (problem) return fail("bad-claims", problem);
  return { ok: true, kid, claims: claims as LicenseClaims };
}

function fail(reason: VerifyFailure, detail: string): VerifyResult {
  return { ok: false, reason, detail };
}

const isDate = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));

const isLimit = (v: unknown): boolean => v === null || (typeof v === "number" && Number.isInteger(v) && v >= 0);

/** A description of what is wrong with `claims`, or `null` when they are well formed. */
export function claimsProblem(claims: unknown): string | null {
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) return "claims are not an object";
  const c = claims as Record<string, unknown>;
  if (c.v !== 1) return `claims version ${String(c.v)} is not 1`;
  if (typeof c.id !== "string" || !c.id.trim()) return "id is missing";
  if (typeof c.customer !== "string" || !c.customer.trim()) return "customer is missing";
  if (!isPlanId(c.plan)) return `plan '${String(c.plan)}' is not a plan`;
  if (!isDate(c.issuedAt)) return "issuedAt is not a date";
  if (!isDate(c.expiresAt)) return "expiresAt is not a date";
  if (Date.parse(c.expiresAt) <= Date.parse(c.issuedAt)) return "expiresAt is not after issuedAt";
  if (c.graceDays !== undefined && !(typeof c.graceDays === "number" && Number.isInteger(c.graceDays) && c.graceDays >= 0 && c.graceDays <= MAX_GRACE_DAYS)) {
    return `graceDays must be a whole number from 0 to ${MAX_GRACE_DAYS}`;
  }
  if (c.limits !== undefined) {
    if (!c.limits || typeof c.limits !== "object" || Array.isArray(c.limits)) return "limits is not an object";
    for (const [name, value] of Object.entries(c.limits as Record<string, unknown>)) {
      if (!["maxSeatsPerMesh", "maxProjects", "maxConcurrentTurns"].includes(name)) return `limits.${name} is not a limit`;
      if (!isLimit(value)) return `limits.${name} must be a whole number or null`;
    }
  }
  if (c.features !== undefined) {
    if (!Array.isArray(c.features) || !c.features.every(isFeatureId)) return "features must be a list of known features";
  }
  if (c.notes !== undefined && typeof c.notes !== "string") return "notes must be text";
  return null;
}
