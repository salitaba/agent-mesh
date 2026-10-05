/**
 * Virtual keys: what a workspace holds instead of a provider's key.
 *
 * A token looks like `curule_vk_<12 hex>_<43 base64url>`: a fixed prefix so a leaked one is recognisable to secret scanners,
 * an id that is safe to log and to show, and 256 bits of secret. Only a SHA-256 of the secret is stored; with a secret that
 * long a fast hash is the right one, and a ledger that is read by operators never holds anything that can be spent.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const KEY_PREFIX = "curule_vk_";

const TOKEN = /^curule_vk_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;

export interface MintedKey {
  keyId: string;
  /** The whole token. Shown once, to whoever asked for the key, and never stored. */
  token: string;
  /** What the ledger keeps. */
  secretHash: string;
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function mintKey(): MintedKey {
  const keyId = randomBytes(6).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  return { keyId, token: `${KEY_PREFIX}${keyId}_${secret}`, secretHash: hashSecret(secret) };
}

/** The id and the secret of a token, or undefined when it is not shaped like one. */
export function parseToken(token: string): { keyId: string; secret: string } | undefined {
  const m = TOKEN.exec(token);
  return m ? { keyId: m[1]!, secret: m[2]! } : undefined;
}

/** Does `secret` hash to `secretHash`? Constant time, so the comparison does not say how many leading characters matched. */
export function secretMatches(secret: string, secretHash: string): boolean {
  const a = Buffer.from(hashSecret(secret), "hex");
  const b = Buffer.from(secretHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The token a request carries: `Authorization: Bearer <token>`. */
export function bearerToken(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(value ?? "");
  return m ? m[1] : undefined;
}
