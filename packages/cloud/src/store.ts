/**
 * The control plane's record: accounts, sessions, plans, payments and workspaces, as an append-only log and what it adds up to.
 *
 * Like the kernel's event log and the gateway's ledger it is append-only, and every view is a projection of it. An account
 * is not a row that gets updated: it is what `account.created`, `account.verified` and `account.password_changed` add up to.
 * Replaying the file gives the same state, which is what lets a payment be applied twice without harm (the second application
 * finds its own record) and a crash be recovered by reading what was written.
 *
 * The store sits behind an interface so that a database can replace the file when one process is no longer enough.
 */
import { randomBytes } from "node:crypto";
import { JsonlLog } from "../../ai-gateway/src/index";

interface Stamp {
  id: string;
  at: string;
}

export type WorkspaceStatus = "requested" | "provisioning" | "running" | "suspended" | "failed" | "destroyed";
export type SubscriptionStatus = "active" | "past_due" | "ended";

export type ControlEntry = Stamp &
  (
    | { type: "account.created"; accountId: string; email: string; passwordHash: string }
    | { type: "account.verified"; accountId: string }
    | { type: "account.password_changed"; accountId: string; passwordHash: string }
    | { type: "account.disabled"; accountId: string; reason: string }
    | { type: "account.enabled"; accountId: string }
    | { type: "verification.issued"; accountId: string; tokenHash: string; expiresAt: string; purpose: "verify" | "reset" }
    | { type: "verification.used"; tokenHash: string }
    | { type: "session.created"; sessionId: string; accountId: string; tokenHash: string; expiresAt: string; ip?: string; userAgent?: string }
    | { type: "session.seen"; sessionId: string }
    | { type: "session.revoked"; sessionId: string }
    | { type: "sessions.revoked_for"; accountId: string }
    | { type: "billing.customer_linked"; provider: string; accountId: string; customerRef: string }
    | { type: "billing.applied"; key: string; accountId: string; kind: string; amountMinor?: number; currency?: string; paymentRef?: string; grants: Array<{ id: string; bucket: "included" | "purchased"; mode: "add" | "set"; amountMicros: number }>; note?: string }
    | { type: "subscription.changed"; accountId: string; plan?: string; status: SubscriptionStatus; periodStart?: string; periodEnd?: string; subscriptionRef?: string; reason: string }
    | { type: "workspace.requested"; workspaceId: string; accountId: string; name: string; slug: string; plan: string }
    | { type: "workspace.provisioned"; workspaceId: string; handle: string; upstream: { host: string; port: number }; gatewayKeyId: string }
    | { type: "workspace.status"; workspaceId: string; status: WorkspaceStatus; reason?: string }
    | { type: "workspace.plan_changed"; workspaceId: string; plan: string }
    | { type: "owner.action"; action: string; detail: string }
  );

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type ControlEntryBody = DistributiveOmit<ControlEntry, "id" | "at">;

export interface Account {
  accountId: string;
  email: string;
  passwordHash: string;
  createdAt: string;
  verifiedAt?: string;
  disabledAt?: string;
  disabledReason?: string;
  /** The payment provider's customer for this account, by provider. */
  customers: Record<string, string>;
  subscription?: { plan: string; status: SubscriptionStatus; periodStart?: string; periodEnd?: string; subscriptionRef?: string; changedAt: string; pastDueSince?: string; endedAt?: string };
}

export interface SessionRecord {
  sessionId: string;
  accountId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  revokedAt?: string;
}

export interface Workspace {
  workspaceId: string;
  accountId: string;
  name: string;
  slug: string;
  plan: string;
  status: WorkspaceStatus;
  createdAt: string;
  statusAt: string;
  statusReason?: string;
  handle?: string;
  upstream?: { host: string; port: number };
  gatewayKeyId?: string;
}

export class ControlState {
  readonly accounts = new Map<string, Account>();
  readonly byEmail = new Map<string, string>();
  readonly sessions = new Map<string, SessionRecord>();
  readonly sessionsByToken = new Map<string, string>();
  readonly verifications = new Map<string, { accountId: string; expiresAt: string; used: boolean; purpose: "verify" | "reset" }>();
  readonly workspaces = new Map<string, Workspace>();
  readonly bySlug = new Map<string, string>();
  /** Billing events already applied, by their key, so applying one twice does nothing the second time. */
  readonly applied = new Map<string, Extract<ControlEntry, { type: "billing.applied" }>>();
  /** Which account a payment provider's customer is. */
  readonly customers = new Map<string, string>();
  /** The credit that refunds have taken back for each payment so far, in micro-units, by the payment's reference. */
  readonly creditRefundedMicros = new Map<string, number>();

  apply(e: ControlEntry): void {
    switch (e.type) {
      case "account.created":
        this.accounts.set(e.accountId, { accountId: e.accountId, email: e.email, passwordHash: e.passwordHash, createdAt: e.at, customers: {} });
        this.byEmail.set(e.email, e.accountId);
        return;
      case "account.verified": {
        const a = this.accounts.get(e.accountId);
        if (a && a.verifiedAt === undefined) a.verifiedAt = e.at;
        return;
      }
      case "account.password_changed": {
        const a = this.accounts.get(e.accountId);
        if (a) a.passwordHash = e.passwordHash;
        return;
      }
      case "account.disabled": {
        const a = this.accounts.get(e.accountId);
        if (a) {
          a.disabledAt = e.at;
          a.disabledReason = e.reason;
        }
        return;
      }
      case "account.enabled": {
        const a = this.accounts.get(e.accountId);
        if (a) {
          delete a.disabledAt;
          delete a.disabledReason;
        }
        return;
      }
      case "verification.issued":
        this.verifications.set(e.tokenHash, { accountId: e.accountId, expiresAt: e.expiresAt, used: false, purpose: e.purpose });
        return;
      case "verification.used": {
        const v = this.verifications.get(e.tokenHash);
        if (v) v.used = true;
        return;
      }
      case "session.created":
        this.sessions.set(e.sessionId, { sessionId: e.sessionId, accountId: e.accountId, tokenHash: e.tokenHash, createdAt: e.at, expiresAt: e.expiresAt, lastSeenAt: e.at });
        this.sessionsByToken.set(e.tokenHash, e.sessionId);
        return;
      case "session.seen": {
        const s = this.sessions.get(e.sessionId);
        if (s) s.lastSeenAt = e.at;
        return;
      }
      case "session.revoked": {
        const s = this.sessions.get(e.sessionId);
        if (s && s.revokedAt === undefined) s.revokedAt = e.at;
        return;
      }
      case "sessions.revoked_for":
        for (const s of this.sessions.values()) if (s.accountId === e.accountId && s.revokedAt === undefined) s.revokedAt = e.at;
        return;
      case "billing.customer_linked": {
        const a = this.accounts.get(e.accountId);
        if (a) a.customers[e.provider] = e.customerRef;
        this.customers.set(`${e.provider}:${e.customerRef}`, e.accountId);
        return;
      }
      case "billing.applied":
        this.applied.set(e.key, e);
        if (e.kind === "payment.refunded" && e.paymentRef !== undefined) {
          for (const g of e.grants) if (g.bucket === "purchased" && g.amountMicros < 0) this.creditRefundedMicros.set(e.paymentRef, (this.creditRefundedMicros.get(e.paymentRef) ?? 0) - g.amountMicros);
        }
        return;
      case "subscription.changed": {
        const a = this.accounts.get(e.accountId);
        if (!a) return;
        const before = a.subscription;
        const plan = e.plan ?? before?.plan;
        if (plan === undefined) return;
        a.subscription = {
          plan,
          status: e.status,
          ...(e.periodStart !== undefined ? { periodStart: e.periodStart } : before?.periodStart !== undefined ? { periodStart: before.periodStart } : {}),
          ...(e.periodEnd !== undefined ? { periodEnd: e.periodEnd } : before?.periodEnd !== undefined ? { periodEnd: before.periodEnd } : {}),
          ...(e.subscriptionRef !== undefined ? { subscriptionRef: e.subscriptionRef } : before?.subscriptionRef !== undefined ? { subscriptionRef: before.subscriptionRef } : {}),
          changedAt: e.at,
          ...(e.status === "past_due" ? { pastDueSince: before?.status === "past_due" && before.pastDueSince ? before.pastDueSince : e.at } : {}),
          ...(e.status === "ended" ? { endedAt: before?.status === "ended" && before.endedAt ? before.endedAt : e.at } : {}),
        };
        return;
      }
      case "workspace.requested":
        this.workspaces.set(e.workspaceId, { workspaceId: e.workspaceId, accountId: e.accountId, name: e.name, slug: e.slug, plan: e.plan, status: "requested", createdAt: e.at, statusAt: e.at });
        this.bySlug.set(e.slug, e.workspaceId);
        return;
      case "workspace.provisioned": {
        const w = this.workspaces.get(e.workspaceId);
        if (w) {
          w.handle = e.handle;
          w.upstream = e.upstream;
          w.gatewayKeyId = e.gatewayKeyId;
        }
        return;
      }
      case "workspace.status": {
        const w = this.workspaces.get(e.workspaceId);
        if (w) {
          w.status = e.status;
          w.statusAt = e.at;
          if (e.reason !== undefined) w.statusReason = e.reason;
          else delete w.statusReason;
        }
        return;
      }
      case "workspace.plan_changed": {
        const w = this.workspaces.get(e.workspaceId);
        if (w) w.plan = e.plan;
        return;
      }
      case "owner.action":
        return;
    }
  }
}

export interface ControlStore {
  load(): Promise<ControlEntry[]>;
  append(entry: ControlEntry): Promise<void>;
  scan(): AsyncIterable<ControlEntry>;
  close(): Promise<void>;
  readonly failure: Error | undefined;
}

export class MemoryControlStore implements ControlStore {
  readonly entries: ControlEntry[] = [];
  failure: Error | undefined;
  async load(): Promise<ControlEntry[]> {
    return [...this.entries];
  }
  async append(entry: ControlEntry): Promise<void> {
    if (this.failure) throw this.failure;
    this.entries.push(entry);
  }
  async *scan(): AsyncGenerator<ControlEntry, void> {
    for (const e of [...this.entries]) yield e;
  }
  async close(): Promise<void> {}
}

/** The control log on disk. See {@link JsonlLog}. */
export class JsonlControlStore extends JsonlLog<ControlEntry> implements ControlStore {
  constructor(file: string) {
    super(file, "the control log", "a record of who was given what");
  }
}

export class ControlUnavailableError extends Error {
  constructor(cause: Error) {
    super(`the control log cannot be written (${cause.message}); the service takes no more changes until it is restarted`);
    this.name = "ControlUnavailableError";
  }
}

/** The state, and the one way to change it: append an entry. */
export class ControlLog {
  readonly state = new ControlState();

  private constructor(
    private readonly store: ControlStore,
    private readonly now: () => Date,
  ) {}

  static async open(store: ControlStore, now: () => Date = () => new Date()): Promise<ControlLog> {
    const log = new ControlLog(store, now);
    for (const e of await store.load()) log.state.apply(e);
    return log;
  }

  get writable(): boolean {
    return this.store.failure === undefined;
  }

  /** Append an entry: visible in memory at once, and durable when this resolves. */
  async append(body: ControlEntryBody): Promise<ControlEntry> {
    if (this.store.failure) throw new ControlUnavailableError(this.store.failure);
    const entry = { id: `${body.type.replace(/\./g, "_")}_${randomBytes(8).toString("hex")}`, at: this.now().toISOString(), ...body } as ControlEntry;
    this.state.apply(entry);
    try {
      await this.store.append(entry);
    } catch (err) {
      throw new ControlUnavailableError(err instanceof Error ? err : new Error(String(err)));
    }
    return entry;
  }

  scan(): AsyncIterable<ControlEntry> {
    return this.store.scan();
  }

  async close(): Promise<void> {
    await this.store.close();
  }
}
