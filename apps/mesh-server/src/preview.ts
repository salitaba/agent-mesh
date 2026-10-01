/**
 * Capability URLs for the playground.
 *
 * The playground is a page an agent wrote, shown inside the dashboard. It runs
 * in an opaque origin (`PREVIEW_CSP` in `web-security.ts`) so that nothing it
 * does can reach this server with the operator's authority. The price is that
 * its own requests (`./app.js`, `./data.json`) carry no cookie and no bearer, so
 * they cannot pass operator auth.
 *
 * Instead the signed-in dashboard asks for a URL that CONTAINS a capability: an
 * expiry and an HMAC of it under a secret minted when this server started. The
 * page's relative requests inherit the prefix, so each one carries the proof.
 * The capability grants one thing, a read of the playground directory, and
 * lapses on its own: it is neither the operator token nor derivable from it, and
 * a restart invalidates every one.
 */
import { createHmac, randomBytes, timingSafeEqual } from "crypto";

/** Long enough for a working session with the page open; short enough that a leaked URL does not last. */
export const PREVIEW_TTL_MS = 8 * 60 * 60 * 1000;

/** Where a capability's files are served from, under the project's own path. */
export const PREVIEW_PREFIX = "_pg";

export class PreviewCapabilities {
  private readonly secret = randomBytes(32);

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = PREVIEW_TTL_MS,
  ) {}

  private sign(expiresAt: number): string {
    return createHmac("sha256", this.secret).update(`preview:${expiresAt}`).digest("base64url");
  }

  /** A capability and the path that carries it, with its trailing slash so relative URLs resolve beneath it. */
  mint(): { capability: string; path: string; expiresAt: number } {
    const expiresAt = this.now() + this.ttlMs;
    const capability = `${expiresAt}.${this.sign(expiresAt)}`;
    return { capability, path: `/${PREVIEW_PREFIX}/${capability}/`, expiresAt };
  }

  /** Whether `capability` was minted by this server and has not lapsed. */
  verify(capability: string | undefined): boolean {
    if (!capability) return false;
    const dot = capability.indexOf(".");
    if (dot <= 0) return false;
    const expiresAt = Number(capability.slice(0, dot));
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now()) return false;
    const given = Buffer.from(capability.slice(dot + 1), "utf8");
    const wanted = Buffer.from(this.sign(expiresAt), "utf8");
    return given.length === wanted.length && timingSafeEqual(given, wanted);
  }
}
