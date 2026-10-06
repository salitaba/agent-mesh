/**
 * Accounts: sign up, verify, sign in, sessions and password reset.
 *
 * Three rules shape it. Nothing it says to a stranger reveals whether an email has an account: sign-up answers the same for a
 * new email and an old one, and the difference goes in the mail only the owner of the address reads; a sign-in that fails says
 * the same thing and takes the same time whatever was wrong. A token (verification, reset, session) is kept only as a hash, so
 * the log holds nothing that can be used. And a link in mail is used once.
 */
import { createHash, randomBytes } from "node:crypto";
import { ServiceError } from "./errors";
import type { Mailer } from "./mailer";
import { burnPasswordTime, hashPassword, passwordProblem, verifyPassword } from "./passwords";
import type { Account, ControlLog } from "./store";

export interface AccountsOptions {
  log: ControlLog;
  mailer: Mailer;
  /** The address of the app, for the links in mail. No trailing slash needed. */
  appUrl: string;
  clock?: () => Date;
  /** A session ends this long after it began, whatever else happens. */
  sessionDays?: number;
  /** And this long after it was last used. */
  idleDays?: number;
  verificationHours?: number;
  resetHours?: number;
  /** For tests. */
  random?: (bytes: number) => Buffer;
}

export interface SessionResult {
  /** The token for the cookie. Shown once. */
  sessionToken: string;
  expiresAt: string;
  account: Account;
}

export const hashToken = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");

export const DEFAULT_SESSION_DAYS = 30;
export const DEFAULT_IDLE_DAYS = 14;
export const DEFAULT_VERIFICATION_HOURS = 24;
export const DEFAULT_RESET_HOURS = 2;

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,63}$/;

export class Accounts {
  private readonly clock: () => Date;
  private readonly random: (n: number) => Buffer;

  constructor(private readonly o: AccountsOptions) {
    this.clock = o.clock ?? (() => new Date());
    this.random = o.random ?? randomBytes;
  }

  private get state() {
    return this.o.log.state;
  }

  /** The lifetimes the pages tell a person about, so that what they say is what this service does. */
  get policy(): { sessionDays: number; idleDays: number; verificationHours: number; resetHours: number } {
    return {
      sessionDays: this.o.sessionDays ?? DEFAULT_SESSION_DAYS,
      idleDays: this.o.idleDays ?? DEFAULT_IDLE_DAYS,
      verificationHours: this.o.verificationHours ?? DEFAULT_VERIFICATION_HOURS,
      resetHours: this.o.resetHours ?? DEFAULT_RESET_HOURS,
    };
  }

  private page(path: string): string {
    return `${this.o.appUrl.replace(/\/+$/, "")}${path}`;
  }

  private link(path: string, token: string): string {
    return `${this.page(path)}?token=${encodeURIComponent(token)}`;
  }

  normaliseEmail(raw: unknown): string {
    const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (email.length > 254 || !EMAIL.test(email)) throw new ServiceError(400, "invalid_email", "Enter an email address.");
    return email;
  }

  private newToken(): string {
    return this.random(32).toString("base64url");
  }

  private async issue(accountId: string, email: string, purpose: "verify" | "reset"): Promise<void> {
    const token = this.newToken();
    const hours = purpose === "verify" ? this.policy.verificationHours : this.policy.resetHours;
    const lasts = `${hours} hour${hours === 1 ? "" : "s"}`;
    await this.o.log.append({ type: "verification.issued", accountId, tokenHash: hashToken(token), expiresAt: new Date(this.clock().getTime() + hours * 3_600_000).toISOString(), purpose });
    if (purpose === "verify") {
      await this.o.mailer.send({ to: email, kind: "verify", subject: "Confirm your Curule account", text: `Confirm your email address to finish creating your account:\n\n${this.link("/verify", token)}\n\nThe link works once and expires in ${lasts}. If you did not sign up, ignore this message: nothing happens unless the link is opened.` });
    } else {
      await this.o.mailer.send({ to: email, kind: "reset", subject: "Reset your Curule password", text: `Open this link to choose a new password:\n\n${this.link("/reset", token)}\n\nThe link works once and expires in ${lasts}. If you did not ask for it, ignore this message: your password has not changed.` });
    }
  }

  /** The same answer for an address that has an account and one that has not. The difference is in the mail. */
  async signup(rawEmail: unknown, password: unknown): Promise<void> {
    const email = this.normaliseEmail(rawEmail);
    if (typeof password !== "string") throw new ServiceError(400, "weak_password", "Choose a password.");
    const problem = passwordProblem(password, email);
    if (problem) throw new ServiceError(400, "weak_password", problem);
    const existing = this.state.byEmail.get(email);
    if (existing === undefined) {
      const accountId = `acct_${this.random(10).toString("hex")}`;
      await this.o.log.append({ type: "account.created", accountId, email, passwordHash: await hashPassword(password) });
      await this.issue(accountId, email, "verify");
      return;
    }
    // Spend the same time as a new account costs, so the response does not say which this was.
    await burnPasswordTime(password);
    const account = this.state.accounts.get(existing)!;
    if (account.verifiedAt === undefined) await this.issue(existing, email, "verify");
    else {
      await this.o.mailer.send({ to: email, kind: "signup-existing", subject: "You already have a Curule account", text: `Someone, probably you, tried to create an account with this address, and you already have one, so no new one was made.\n\nSign in: ${this.page("/login")}\nForgotten your password? ${this.page("/forgot")}\n\nIf it was not you, ignore this message.` });
    }
  }

  private async openSession(account: Account, meta: { ip?: string; userAgent?: string }): Promise<SessionResult> {
    const token = `s_${this.newToken()}`;
    const expiresAt = new Date(this.clock().getTime() + this.policy.sessionDays * 86_400_000).toISOString();
    await this.o.log.append({
      type: "session.created",
      sessionId: `sess_${this.random(8).toString("hex")}`,
      accountId: account.accountId,
      tokenHash: hashToken(token),
      expiresAt,
      ...(meta.ip ? { ip: meta.ip } : {}),
      ...(meta.userAgent ? { userAgent: meta.userAgent.slice(0, 200) } : {}),
    });
    return { sessionToken: token, expiresAt, account };
  }

  /** A link from mail: it confirms the address, and signs in whoever holds it. Once. */
  async verify(token: unknown, meta: { ip?: string; userAgent?: string } = {}): Promise<SessionResult> {
    const invalid = new ServiceError(400, "invalid_token", "That link is not valid, or it has expired. Ask for a new one.");
    if (typeof token !== "string" || token === "") throw invalid;
    const tokenHash = hashToken(token);
    const v = this.state.verifications.get(tokenHash);
    if (!v || v.used || v.purpose !== "verify" || Date.parse(v.expiresAt) <= this.clock().getTime()) throw invalid;
    const account = this.state.accounts.get(v.accountId);
    if (!account || account.disabledAt !== undefined) throw invalid;
    await this.o.log.append({ type: "verification.used", tokenHash });
    if (account.verifiedAt === undefined) await this.o.log.append({ type: "account.verified", accountId: account.accountId });
    return this.openSession(this.state.accounts.get(account.accountId)!, meta);
  }

  /** The same refusal, after the same work, for every way a sign-in can fail. */
  async login(rawEmail: unknown, password: unknown, meta: { ip?: string; userAgent?: string } = {}): Promise<SessionResult> {
    const refusal = new ServiceError(401, "invalid_credentials", "That email and password do not match an account.");
    let email: string;
    try {
      email = this.normaliseEmail(rawEmail);
    } catch {
      await burnPasswordTime(typeof password === "string" ? password : "");
      throw refusal;
    }
    const accountId = this.state.byEmail.get(email);
    const account = accountId ? this.state.accounts.get(accountId) : undefined;
    if (!account || typeof password !== "string") {
      await burnPasswordTime(typeof password === "string" ? password : "");
      throw refusal;
    }
    if (!(await verifyPassword(password, account.passwordHash))) throw refusal;
    if (account.disabledAt !== undefined) throw refusal;
    if (account.verifiedAt === undefined) {
      // Whoever knows the password is the person who signed up: send the link again, and say nothing more here.
      await this.issue(account.accountId, email, "verify");
      throw refusal;
    }
    return this.openSession(account, meta);
  }

  /** The account a session cookie belongs to, or undefined. Pure: it writes nothing. */
  authenticate(token: unknown): Account | undefined {
    return this.identify(token)?.account;
  }

  /** The account and the session a cookie belongs to, or undefined when it is not a session that is good now. */
  identify(token: unknown): { account: Account; sessionId: string } | undefined {
    if (typeof token !== "string" || token === "") return undefined;
    const sid = this.state.sessionsByToken.get(hashToken(token));
    return sid ? this.session(sid) : undefined;
  }

  /** The same, by the session's own id: how a workspace's access, which holds an id and never a token, asks whether it is still good. */
  session(sessionId: string): { account: Account; sessionId: string } | undefined {
    const s = this.state.sessions.get(sessionId);
    if (!s || s.revokedAt !== undefined) return undefined;
    const now = this.clock().getTime();
    if (Date.parse(s.expiresAt) <= now) return undefined;
    if (now - Date.parse(s.lastSeenAt) > this.policy.idleDays * 86_400_000) return undefined;
    const account = this.state.accounts.get(s.accountId);
    if (!account || account.disabledAt !== undefined || account.verifiedAt === undefined) return undefined;
    return { account, sessionId };
  }

  /** Record that a session was used, at most every ten minutes, so a busy page does not write on every request. */
  async touch(token: string): Promise<void> {
    const sid = this.state.sessionsByToken.get(hashToken(token));
    const s = sid ? this.state.sessions.get(sid) : undefined;
    if (!s || s.revokedAt !== undefined) return;
    if (this.clock().getTime() - Date.parse(s.lastSeenAt) < 600_000) return;
    await this.o.log.append({ type: "session.seen", sessionId: s.sessionId });
  }

  async logout(token: unknown): Promise<void> {
    if (typeof token !== "string") return;
    const sid = this.state.sessionsByToken.get(hashToken(token));
    if (sid && this.state.sessions.get(sid)?.revokedAt === undefined) await this.o.log.append({ type: "session.revoked", sessionId: sid });
  }

  /** Change a password the person knows. Every other session ends; the one that asked, if given, stays. */
  async changePassword(accountId: string, current: unknown, next: unknown, keepToken?: string): Promise<void> {
    const account = this.state.accounts.get(accountId);
    if (!account) throw new ServiceError(404, "not_found", "There is no such account.");
    if (typeof current !== "string" || !(await verifyPassword(current, account.passwordHash))) throw new ServiceError(403, "invalid_credentials", "The current password is not right.");
    if (typeof next !== "string") throw new ServiceError(400, "weak_password", "Choose a password.");
    const problem = passwordProblem(next, account.email);
    if (problem) throw new ServiceError(400, "weak_password", problem);
    await this.o.log.append({ type: "account.password_changed", accountId, passwordHash: await hashPassword(next) });
    await this.o.log.append({ type: "sessions.revoked_for", accountId });
    if (keepToken) await this.openKept(account, keepToken);
  }

  /** Revoking every session ended the caller's too; a fresh record for the same cookie keeps them signed in. */
  private async openKept(account: Account, token: string): Promise<void> {
    await this.o.log.append({
      type: "session.created",
      sessionId: `sess_${this.random(8).toString("hex")}`,
      accountId: account.accountId,
      tokenHash: hashToken(token),
      expiresAt: new Date(this.clock().getTime() + this.policy.sessionDays * 86_400_000).toISOString(),
    });
  }

  /** Always the same answer. Mail goes only to an address that has a verified account. */
  async requestReset(rawEmail: unknown): Promise<void> {
    let email: string;
    try {
      email = this.normaliseEmail(rawEmail);
    } catch {
      return;
    }
    const id = this.state.byEmail.get(email);
    const account = id ? this.state.accounts.get(id) : undefined;
    if (account && account.verifiedAt !== undefined && account.disabledAt === undefined) await this.issue(account.accountId, email, "reset");
  }

  async completeReset(token: unknown, password: unknown): Promise<{ email: string }> {
    const invalid = new ServiceError(400, "invalid_token", "That link is not valid, or it has expired. Ask for a new one.");
    if (typeof token !== "string" || token === "") throw invalid;
    const tokenHash = hashToken(token);
    const v = this.state.verifications.get(tokenHash);
    if (!v || v.used || v.purpose !== "reset" || Date.parse(v.expiresAt) <= this.clock().getTime()) throw invalid;
    const account = this.state.accounts.get(v.accountId);
    if (!account || account.disabledAt !== undefined) throw invalid;
    if (typeof password !== "string") throw new ServiceError(400, "weak_password", "Choose a password.");
    const problem = passwordProblem(password, account.email);
    if (problem) throw new ServiceError(400, "weak_password", problem);
    await this.o.log.append({ type: "verification.used", tokenHash });
    await this.o.log.append({ type: "account.password_changed", accountId: account.accountId, passwordHash: await hashPassword(password) });
    await this.o.log.append({ type: "sessions.revoked_for", accountId: account.accountId });
    return { email: account.email };
  }
}
