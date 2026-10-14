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

/** The same mechanism for the product's own live UI: a separate prefix, so neither capability opens the other. */
export const LIVE_UI_PREFIX = "_ui";

/**
 * What a capability opens, laid out as the product's own tree: the page at `apps/playground/` and the
 * `presets/` beside `apps/`. Keeping the layout is what lets a page's own relative URL
 * (`../../presets/x.json`, as the playground has always fetched them) land on the right file under the
 * capability prefix with nothing rewritten. Nothing else in the checkout is reachable through it.
 */
export const PREVIEW_PAGE_DIR = ["apps", "playground"] as const;

/**
 * Where a product may have put the page the console opens, in the order worth trying.
 *
 * `apps/playground/` is the convention and wins when it exists: that page is written *for* this sandbox, so it works
 * with no server of the product running. But products also ship their own UI in the ordinary places — a live mesh built
 * a real one at `public/index.html` and had it served by its own `ui` command, and the console could not see it at all,
 * which its owner reported as "I can't see it in playground". The last entry is the product root itself, for a
 * single-page product that kept `index.html` where it is.
 */
export const PREVIEW_PAGE_CANDIDATES: readonly (readonly string[])[] = [
  PREVIEW_PAGE_DIR,
  ["public"],
  ["dist"],
  ["build"],
  [],
] as const;
export const PREVIEW_PRESETS_DIR = ["presets"] as const;

export class PreviewCapabilities {
  private readonly secret = randomBytes(32);

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = PREVIEW_TTL_MS,
    private readonly prefix: string = PREVIEW_PREFIX,
  ) {}

  private sign(expiresAt: number): string {
    return createHmac("sha256", this.secret).update(`preview:${expiresAt}`).digest("base64url");
  }

  /**
   * A capability and the path of the page it opens, with its trailing slash so relative URLs resolve beneath it.
   *
   * The page's directory is in the path, so the same capability opens whichever of a product's pages the console asked
   * for — its own (`apps/playground/`, the default) or one the product ships (`public/`). The signature covers only the
   * expiry, so the caller can choose among the candidates the server serves, and nothing else.
   */
  mint(pageDir: readonly string[] = PREVIEW_PAGE_DIR): { capability: string; path: string; expiresAt: number } {
    const expiresAt = this.now() + this.ttlMs;
    const capability = `${expiresAt}.${this.sign(expiresAt)}`;
    const trailing = pageDir.length > 0 ? `${pageDir.join("/")}/` : "";
    return { capability, path: `/${this.prefix}/${capability}/${trailing}`, expiresAt };
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
