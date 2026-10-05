/**
 * The ledger: the one record of who may call, what they were given and what they spent.
 *
 * It is append-only, and everything the gateway knows about money is a projection of it: a balance is the sum of the
 * entries, not a counter that something increments. An entry is never edited. A mistake is corrected by another entry.
 * Replaying the file gives back the same balances to the micro-unit, which is the property that makes it auditable, and it
 * is tested as one.
 *
 * Money is in two buckets. `included` is what a plan period gives and is replaced at the next period; `purchased` is bought
 * and does not expire. A spend draws on `included` first. Where the sum of the two goes below zero the account is
 * overdrawn, which can happen by at most the cost of the calls that were in flight when the balance ran out.
 */
import { randomBytes } from "node:crypto";
import { JsonlLog } from "./jsonl-log";
import { mintKey } from "./keys";
import type { Micros } from "./money";

export type Bucket = "included" | "purchased";

export interface KeyLimits {
  /** Calls per minute. */
  rpm?: number;
  /** Calls open at once. */
  concurrent?: number;
  /** The most the key may be charged in one UTC day. */
  dailyCapMicros?: Micros;
}

/** Tokens, in the four quantities every provider bills, as the model port normalises them. */
export interface UsageRecord {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
}

interface Stamp {
  id: string;
  /** ISO 8601, UTC. */
  at: string;
}

export type SpendOutcome =
  /** The call finished and the customer is charged for it. */
  | "ok"
  /** The caller went away mid-call. The customer is charged what had been produced, estimated. */
  | "aborted"
  /** The provider failed. The customer is not charged; the cost is recorded so the loss is visible. */
  | "failed";

export type LedgerEntry = Stamp &
  (
    | { type: "ledger.opened"; currency: string }
    | { type: "key.created"; keyId: string; accountId: string; workspaceId?: string; label?: string; secretHash: string; limits: KeyLimits; models?: string[] }
    | { type: "key.revoked"; keyId: string; reason?: string }
    | { type: "grant"; accountId: string; bucket: Bucket; mode: "add" | "set"; amountMicros: Micros; reason: string; reference?: string }
    | {
        type: "spend";
        requestId: string;
        accountId: string;
        keyId: string;
        workspaceId?: string;
        /** What the caller asked for: a tier such as `balanced`, or a `provider/model`. */
        alias: string;
        provider: string;
        model: string;
        /** The model as the provider reported it, which may be a dated snapshot. */
        modelReported?: string;
        priceVersion: string;
        usage: UsageRecord;
        costMicros: Micros;
        chargeMicros: Micros;
        outcome: SpendOutcome;
        /** True when the provider reported no usage and the figures are an estimate. */
        estimated: boolean;
        latencyMs: number;
      }
  );

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type EntryBody = DistributiveOmit<LedgerEntry, "id" | "at">;

export interface KeyRecord {
  keyId: string;
  accountId: string;
  workspaceId?: string;
  label?: string;
  secretHash: string;
  limits: KeyLimits;
  /** The tiers or models the key may name. Absent means any the gateway offers. */
  models?: string[];
  createdAt: string;
  revokedAt?: string;
  revokedReason?: string;
}

export interface AccountBalance {
  included: Micros;
  purchased: Micros;
  /** Everything ever charged to the account. */
  charged: Micros;
  /** Everything the calls cost the service. */
  cost: Micros;
}

interface GrantFacts {
  accountId: string;
  bucket: Bucket;
  mode: "add" | "set";
  amountMicros: Micros;
}

/** What the entries add up to. Pure: the same entries in the same order always give the same state. */
export class LedgerState {
  currency = "";
  readonly keys = new Map<string, KeyRecord>();
  readonly accounts = new Map<string, AccountBalance>();
  /** Per key, the UTC day it last spent on and what it was charged that day. */
  readonly daily = new Map<string, { day: string; charged: Micros }>();
  /** Grants by id, so the same grant sent twice counts once. */
  readonly grants = new Map<string, GrantFacts>();

  account(accountId: string): AccountBalance {
    let a = this.accounts.get(accountId);
    if (!a) {
      a = { included: 0, purchased: 0, charged: 0, cost: 0 };
      this.accounts.set(accountId, a);
    }
    return a;
  }

  apply(e: LedgerEntry): void {
    switch (e.type) {
      case "ledger.opened":
        if (this.currency === "") this.currency = e.currency;
        return;
      case "key.created":
        this.keys.set(e.keyId, {
          keyId: e.keyId,
          accountId: e.accountId,
          ...(e.workspaceId !== undefined ? { workspaceId: e.workspaceId } : {}),
          ...(e.label !== undefined ? { label: e.label } : {}),
          secretHash: e.secretHash,
          limits: e.limits,
          ...(e.models !== undefined ? { models: e.models } : {}),
          createdAt: e.at,
        });
        return;
      case "key.revoked": {
        const key = this.keys.get(e.keyId);
        if (key && key.revokedAt === undefined) {
          key.revokedAt = e.at;
          if (e.reason !== undefined) key.revokedReason = e.reason;
        }
        return;
      }
      case "grant": {
        const account = this.account(e.accountId);
        if (e.mode === "set") account[e.bucket] = e.amountMicros;
        else account[e.bucket] += e.amountMicros;
        this.grants.set(e.id, { accountId: e.accountId, bucket: e.bucket, mode: e.mode, amountMicros: e.amountMicros });
        return;
      }
      case "spend": {
        const account = this.account(e.accountId);
        account.charged += e.chargeMicros;
        account.cost += e.costMicros;
        // Included credit goes first, and only the part of it that is there; the rest comes from what was bought.
        const fromIncluded = Math.min(Math.max(account.included, 0), e.chargeMicros);
        account.included -= fromIncluded;
        account.purchased -= e.chargeMicros - fromIncluded;
        const day = e.at.slice(0, 10);
        const today = this.daily.get(e.keyId);
        if (!today || today.day !== day) this.daily.set(e.keyId, { day, charged: e.chargeMicros });
        else today.charged += e.chargeMicros;
        return;
      }
    }
  }
}

export interface LedgerStore {
  /** Every entry, in order. Called once, when the ledger opens. */
  load(): Promise<LedgerEntry[]>;
  /** Resolves when the entry is durable. */
  append(entry: LedgerEntry): Promise<void>;
  /** Every entry, in order, for reports. Includes what was appended a moment ago. */
  scan(): AsyncIterable<LedgerEntry>;
  close(): Promise<void>;
  /** Set once a write has failed. After that nothing more is accepted: memory and disk may differ, and a restart replays the disk. */
  readonly failure: Error | undefined;
}

export class LedgerUnavailableError extends Error {
  constructor(cause: Error) {
    super(`the ledger cannot be written (${cause.message}); no more calls are accepted until the gateway is restarted`);
    this.name = "LedgerUnavailableError";
  }
}

/** A grant id reused for something other than the grant it named. */
export class LedgerConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerConflictError";
  }
}

export class MemoryLedgerStore implements LedgerStore {
  readonly entries: LedgerEntry[] = [];
  failure: Error | undefined;

  async load(): Promise<LedgerEntry[]> {
    return [...this.entries];
  }

  async append(entry: LedgerEntry): Promise<void> {
    if (this.failure) throw this.failure;
    this.entries.push(entry);
  }

  async *scan(): AsyncGenerator<LedgerEntry, void> {
    for (const e of [...this.entries]) yield e;
  }

  async close(): Promise<void> {}
}

/** The ledger on disk: one JSON object per line, appended and synced before the append resolves. See {@link JsonlLog}. */
export class JsonlLedgerStore extends JsonlLog<LedgerEntry> implements LedgerStore {
  constructor(file: string) {
    super(file, "the ledger");
  }
}

const NAME = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_GRANT_MICROS = 1_000_000_000_000;

export function isValidName(value: unknown): value is string {
  return typeof value === "string" && NAME.test(value);
}

function cleanLimits(limits: KeyLimits | undefined): KeyLimits {
  const out: KeyLimits = {};
  if (!limits) return out;
  const positive = (name: string, v: unknown, max: number): number => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > max) throw new RangeError(`${name} must be a whole number from 1 to ${max} (got ${JSON.stringify(v)})`);
    return v;
  };
  if (limits.rpm !== undefined) out.rpm = positive("rpm", limits.rpm, 1_000_000);
  if (limits.concurrent !== undefined) out.concurrent = positive("concurrent", limits.concurrent, 100_000);
  if (limits.dailyCapMicros !== undefined) out.dailyCapMicros = positive("dailyCapMicros", limits.dailyCapMicros, MAX_GRANT_MICROS);
  return out;
}

export interface LedgerOptions {
  /** The currency every amount is in. A ledger that holds another one is refused. */
  currency: string;
  now?: () => Date;
}

export class Ledger {
  readonly state = new LedgerState();
  private readonly now: () => Date;

  private constructor(
    private readonly store: LedgerStore,
    readonly currency: string,
    now: () => Date,
  ) {
    this.now = now;
  }

  static async open(store: LedgerStore, options: LedgerOptions): Promise<Ledger> {
    const ledger = new Ledger(store, options.currency, options.now ?? (() => new Date()));
    const entries = await store.load();
    if (entries.length === 0) {
      await ledger.write({ type: "ledger.opened", currency: options.currency });
      return ledger;
    }
    const first = entries[0]!;
    if (first.type !== "ledger.opened") throw new Error("the ledger does not begin with its opening record; refusing to use it");
    if (first.currency !== options.currency) {
      throw new Error(`the ledger holds ${first.currency} and the gateway is configured for ${options.currency}; refusing to mix currencies`);
    }
    for (const e of entries) ledger.state.apply(e);
    return ledger;
  }

  /** False once a write has failed. The gateway stops taking calls then, because it can no longer record what they cost. */
  get writable(): boolean {
    return this.store.failure === undefined;
  }

  private async write(body: EntryBody, id?: string): Promise<LedgerEntry> {
    if (this.store.failure) throw new LedgerUnavailableError(this.store.failure);
    const entry = { id: id ?? `${body.type.replace(".", "_")}_${randomBytes(8).toString("hex")}`, at: this.now().toISOString(), ...body } as LedgerEntry;
    // Memory first, so the next check sees it; the disk write follows, and a failure of it stops the gateway.
    this.state.apply(entry);
    try {
      await this.store.append(entry);
    } catch (err) {
      throw new LedgerUnavailableError(err instanceof Error ? err : new Error(String(err)));
    }
    return entry;
  }

  async createKey(input: { accountId: string; workspaceId?: string; label?: string; limits?: KeyLimits; models?: string[] }): Promise<{ keyId: string; token: string }> {
    if (!isValidName(input.accountId)) throw new RangeError("accountId must be 1 to 128 letters, digits and . _ : -");
    if (input.workspaceId !== undefined && !isValidName(input.workspaceId)) throw new RangeError("workspaceId must be 1 to 128 letters, digits and . _ : -");
    if (input.models !== undefined && (!Array.isArray(input.models) || input.models.some((m) => typeof m !== "string" || m === ""))) throw new RangeError("models must be a list of tier or model names");
    const minted = mintKey();
    await this.write({
      type: "key.created",
      keyId: minted.keyId,
      accountId: input.accountId,
      ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
      ...(input.label !== undefined ? { label: String(input.label).slice(0, 120) } : {}),
      secretHash: minted.secretHash,
      limits: cleanLimits(input.limits),
      ...(input.models !== undefined ? { models: input.models } : {}),
    });
    return { keyId: minted.keyId, token: minted.token };
  }

  async revokeKey(keyId: string, reason?: string): Promise<"revoked" | "already" | "unknown"> {
    const key = this.state.keys.get(keyId);
    if (!key) return "unknown";
    if (key.revokedAt !== undefined) return "already";
    await this.write({ type: "key.revoked", keyId, ...(reason !== undefined ? { reason: String(reason).slice(0, 200) } : {}) });
    return "revoked";
  }

  /**
   * Add to a bucket (`add`, which may be negative to take back credit that was refunded) or replace it (`set`, which a plan
   * period does at its start). `id` makes the call safe to repeat: the same grant sent twice counts once, and an id reused
   * for a different grant is refused.
   */
  async grant(input: { id: string; accountId: string; bucket: Bucket; mode?: "add" | "set"; amountMicros: Micros; reason: string; reference?: string }): Promise<"recorded" | "duplicate"> {
    const mode = input.mode ?? "add";
    if (!isValidName(input.id)) throw new RangeError("id must be 1 to 128 letters, digits and . _ : -");
    if (!isValidName(input.accountId)) throw new RangeError("accountId must be 1 to 128 letters, digits and . _ : -");
    if (input.bucket !== "included" && input.bucket !== "purchased") throw new RangeError("bucket must be included or purchased");
    if (mode !== "add" && mode !== "set") throw new RangeError("mode must be add or set");
    if (!Number.isSafeInteger(input.amountMicros) || Math.abs(input.amountMicros) > MAX_GRANT_MICROS) throw new RangeError("amountMicros must be a whole number of micro-units, no larger than a million units");
    if (mode === "set" && input.amountMicros < 0) throw new RangeError("a bucket cannot be set below zero");
    if (typeof input.reason !== "string" || input.reason.trim() === "") throw new RangeError("a grant needs a reason");
    const earlier = this.state.grants.get(input.id);
    if (earlier) {
      if (earlier.accountId === input.accountId && earlier.bucket === input.bucket && earlier.mode === mode && earlier.amountMicros === input.amountMicros) return "duplicate";
      throw new LedgerConflictError(`grant id '${input.id}' was already used for a different grant`);
    }
    await this.write(
      {
        type: "grant",
        accountId: input.accountId,
        bucket: input.bucket,
        mode,
        amountMicros: input.amountMicros,
        reason: input.reason.slice(0, 200),
        ...(input.reference !== undefined ? { reference: String(input.reference).slice(0, 200) } : {}),
      },
      input.id,
    );
    return "recorded";
  }

  async recordSpend(spend: Omit<Extract<LedgerEntry, { type: "spend" }>, "id" | "at" | "type">): Promise<void> {
    await this.write({ type: "spend", ...spend }, `spend_${spend.requestId}`);
  }

  balance(accountId: string): AccountBalance {
    return { ...(this.state.accounts.get(accountId) ?? { included: 0, purchased: 0, charged: 0, cost: 0 }) };
  }

  scan(): AsyncIterable<LedgerEntry> {
    return this.store.scan();
  }

  async close(): Promise<void> {
    await this.store.close();
  }
}
