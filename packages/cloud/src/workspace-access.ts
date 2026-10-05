/**
 * How a person who is signed in to their account gets into one of their workspaces.
 *
 * A workspace is served at an address of its own, and a cookie for the account's address is not sent there. So opening one is
 * done in two steps. The account page asks for a one-time code, good for a minute, and sends the browser to the workspace's
 * address with it. The workspace's address trades the code for a cookie that belongs to that address alone.
 *
 * The cookie holds no secret that can be used elsewhere and is not looked up anywhere: it is a statement (this account, this
 * workspace, this session, until this time) signed with a key derived from the service's secret. Whether it is still good is
 * decided on each request from the control log, by asking whether that session is still a session and whether that workspace
 * is still the account's, so signing out, changing the password and stopping an account end access to every open workspace at
 * once, and a restart of the service signs nobody out.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface AccessGrant {
  accountId: string;
  workspaceId: string;
  /** The account session this access rests on. */
  sessionId: string;
}

export interface AccessOptions {
  /** The service's secret: at least 32 characters. */
  secret: string;
  clock?: () => Date;
  /** How long a code may be redeemed. Default one minute. */
  codeTtlMs?: number;
  /** How long a cookie lasts. Default twelve hours: a working day, not a standing credential. */
  cookieTtlMs?: number;
  /** The most codes waiting at once. Default 10,000. */
  maxCodes?: number;
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const b64 = (buf: Buffer | string): string => Buffer.from(buf).toString("base64url");

export class WorkspaceAccess {
  private readonly clock: () => Date;
  private readonly key: Buffer;
  /** Waiting codes by the hash of the code, so a dump of memory holds nothing a browser could present. */
  private readonly codes = new Map<string, AccessGrant & { expiresAt: number }>();

  constructor(private readonly o: AccessOptions) {
    if (o.secret.length < 32) throw new Error("the service secret must be at least 32 characters");
    this.clock = o.clock ?? (() => new Date());
    this.key = createHmac("sha256", o.secret).update("workspace-access-cookie").digest();
  }

  get cookieMaxAgeSec(): number {
    return Math.floor((this.o.cookieTtlMs ?? 12 * 3_600_000) / 1000);
  }

  /** A code that opens this workspace once, for this session, within a minute. */
  issueCode(grant: AccessGrant): string {
    const now = this.clock().getTime();
    for (const [hash, g] of this.codes) if (g.expiresAt <= now) this.codes.delete(hash);
    while (this.codes.size >= (this.o.maxCodes ?? 10_000)) {
      const oldest = this.codes.keys().next().value;
      if (oldest === undefined) break;
      this.codes.delete(oldest);
    }
    const code = randomBytes(24).toString("base64url");
    this.codes.set(sha256(code), { ...grant, expiresAt: now + (this.o.codeTtlMs ?? 60_000) });
    return code;
  }

  /** What a code was issued for. A code is spent by being tried, whether or not it was good. */
  redeemCode(code: unknown): AccessGrant | undefined {
    if (typeof code !== "string" || code === "") return undefined;
    const hash = sha256(code);
    const found = this.codes.get(hash);
    this.codes.delete(hash);
    if (!found || found.expiresAt <= this.clock().getTime()) return undefined;
    const { expiresAt: _expiresAt, ...grant } = found;
    return grant;
  }

  /** The value of a cookie that says this grant is good for the cookie's lifetime. */
  cookieValue(grant: AccessGrant): string {
    const payload = b64(JSON.stringify({ a: grant.accountId, w: grant.workspaceId, s: grant.sessionId, e: Math.floor((this.clock().getTime() + (this.o.cookieTtlMs ?? 12 * 3_600_000)) / 1000) }));
    return `v1.${payload}.${b64(createHmac("sha256", this.key).update(`v1.${payload}`).digest())}`;
  }

  /** What a cookie says, when it is one this service signed and has not run out. Whether the session behind it is good is the caller's to ask. */
  read(value: string | undefined): (AccessGrant & { expiresAt: number }) | undefined {
    if (!value) return undefined;
    const parts = value.split(".");
    if (parts.length !== 3 || parts[0] !== "v1") return undefined;
    const given = Buffer.from(parts[2]!, "base64url");
    const expected = createHmac("sha256", this.key).update(`v1.${parts[1]!}`).digest();
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
    let claims: { a?: unknown; w?: unknown; s?: unknown; e?: unknown };
    try {
      claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as typeof claims;
    } catch {
      return undefined;
    }
    if (typeof claims.a !== "string" || typeof claims.w !== "string" || typeof claims.s !== "string" || typeof claims.e !== "number") return undefined;
    if (claims.e * 1000 <= this.clock().getTime()) return undefined;
    return { accountId: claims.a, workspaceId: claims.w, sessionId: claims.s, expiresAt: claims.e * 1000 };
  }

  get waiting(): number {
    return this.codes.size;
  }
}
