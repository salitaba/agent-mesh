import type { BudgetProjectionEntry, EventId } from "../../protocol/src/index";
import { monotonicId } from "../../protocol/src/index";
import type { ResolvedMeshConfig } from "../../config/src/index";
import type { Kernel } from "./kernel";
import type { Projections } from "./state";
import { budgetEntries, ensureBudget } from "./state";

export type BudgetKey = string;

export function missionKey(goalId: string): BudgetKey {
  return `mission:${goalId}`;
}
export function agentKey(goalId: string, agentId: string): BudgetKey {
  return `agent:${goalId}/${agentId}`;
}
/**
 * What a seat may spend buying other seats' attention.
 *
 * A line of its own rather than a share of the agent's token line, because the
 * two answer different questions and the mesh was asking them of one number.
 * The agent line is "what may this seat spend thinking"; an interrupt is
 * "what may this seat spend making someone ELSE think". Charging the second to
 * the first conflated them in a way that was invisible until it bound: a seat
 * that interrupted forty times had spent 80k of the budget it needed to do its
 * own work, and nothing could tell that from a seat that had simply thought
 * hard for 80k. Worse, the consequence landed on the wrong party -- the
 * punishment for over-interrupting was losing the ability to work, when the
 * thing that should stop is the interrupting.
 *
 * Kept separate, `budget.exceeded` on this key means exactly one thing, and
 * the pre-flight check in `sendMessage` can read it before a wake is bought
 * rather than discovering it afterwards on the wrong ledger.
 */
export function attentionKey(goalId: string, agentId: string): BudgetKey {
  return `attention:${goalId}/${agentId}`;
}

/**
 * The most a backed-up recipient may multiply the price of waking them.
 *
 * Capped, and the cap is the point. A sender cannot see inside another seat's
 * mailbox, so an uncapped curve would make the price of a wake unknowable
 * before buying it -- and a price nobody can predict is not a price, it is a
 * penalty. With a cap the sender can reason about the worst case without
 * seeing the box at all: waking the most congested seat in the mesh costs a
 * known multiple of waking an idle one, and that multiple is in its prompt.
 *
 * Four because the curve has to say something at realistic depths. Boxes are
 * bounded at `MAX_UNREAD_PER_AGENT` (200) but a seat that is genuinely behind
 * sits at single digits, so with the documented divisor of 4 the cap is
 * reached around twelve unread -- a seat that is already a full render window
 * behind. A higher cap would only price boxes that mean the mesh has bigger
 * problems than pricing.
 */
export const MAX_INTERRUPT_SURCHARGE = 4;

/**
 * What waking a seat this backed-up costs, as a multiple of the flat tariff.
 *
 * `every` absent (or incoherent) is the flat tariff, 1x at every depth, which
 * is what every mesh that never wrote `congestion_every` has.
 */
export function interruptSurcharge(depth: number, every: number | undefined): number {
  if (every === undefined || every < 1) return 1;
  if (depth <= 0) return 1;
  return Math.min(MAX_INTERRUPT_SURCHARGE, 1 + Math.floor(depth / every));
}

export function threadKey(goalId: string, threadId: string): BudgetKey {
  return `thread:${goalId}/${threadId}`;
}
export function taskKey(goalId: string, taskId: string): BudgetKey {
  return `task:${goalId}/${taskId}`;
}

/**
 * The pessimistic hold for one upcoming turn, before that agent has spent a
 * token. Not an estimate of anything — no agent's turn is known to cost 32k;
 * `Supervisor.sizedTurnReserve` shrinks the hold towards observed cost once
 * real turns exist, so a nearly-empty ledger can still admit a cheap turn
 * instead of refusing every turn as if it were the worst case.
 *
 * `budgets.thread.reserve_tokens` overrides the ceiling for thread ledgers.
 *
 * Lives here rather than in the supervisor because `autoRaiseExhausted` below
 * has to reproduce `tryAutoRaise`'s arithmetic exactly, and a second copy of
 * this number is the drift that would make the verdict and the sweep disagree.
 */
export const TURN_RESERVE_TOKENS = 32000;

/**
 * The limit this ledger was CONFIGURED with, which is not the limit it now has.
 *
 * The auto-raise ceiling is anchored to declared intent: if it were computed
 * from the current limit, each raise would raise the ceiling with it and the
 * cap would never bind. Both the sweep (`autoRaiseExhaustedLedgers`) and the
 * termination verdict need this same number, so it is one function.
 *
 * Returns null for keys this mesh never declared a limit for, and for mission
 * and task ledgers, which are deliberately never auto-raised.
 */
export function configuredBudgetLimit(state: Projections, config: ResolvedMeshConfig, key: BudgetKey): number | null {
  const goalId = state.activeGoalId;
  if (!goalId) return null;
  const agentPrefix = `agent:${goalId}/`;
  if (key.startsWith(agentPrefix)) {
    const agentId = key.slice(agentPrefix.length);
    return (
      state.agents.get(agentId)?.definition?.budget?.tokens ??
      config.budgets?.perAgent?.[agentId] ??
      config.budgets?.agentDefaults?.tokens ??
      null
    );
  }
  if (key.startsWith(`thread:${goalId}/`)) return config.budgets?.threadTokens ?? null;
  return null;
}

/**
 * Is this ledger beyond anything auto-raise will do for it?
 *
 * True means "nothing will raise this, so the latch is final" — which is the
 * only state in which an exhausted ledger is worth an operator's attention.
 *
 * This exists because `budget.exceeded` is emitted by `reserve` BEFORE the
 * caller gets a chance to await `tryAutoRaise`, so a watchdog that fires in
 * between sees a latch that is about to be cleared. Reading the latch alone
 * escalated two of five live halts on ledgers that were raised in the same
 * second — a read-too-early, not an exhaustion. Mirrors `tryAutoRaise`'s bail
 * set in order; the two must be changed together.
 *
 * Every config access is optional-chained on purpose: several termination
 * tests pass a bare `{ budgets: { mission } }` fixture, and for those the
 * honest answer is "no auto-raise is configured, so the latch IS final".
 */
export function autoRaiseExhausted(state: Projections, config: ResolvedMeshConfig, key: BudgetKey): boolean {
  const cfg = config.budgets?.autoRaise;
  if (!cfg?.enabled) return true;
  const original = configuredBudgetLimit(state, config, key);
  if (original === null || !Number.isFinite(original) || original <= 0) return true;
  const ledger = state.budgets.get(key);
  if (!ledger || ledger.limit === null) return true;
  const maxMultiple = cfg.maxMultiple;
  if (!Number.isFinite(maxMultiple) || maxMultiple <= 0) return true;
  const ceiling = Math.floor(original * maxMultiple);
  if (ledger.limit >= ceiling) return true;
  const next = Math.min(
    ceiling,
    Math.max(Math.floor(ledger.limit * (cfg.factor ?? 0)), ledger.consumed + ledger.reserved + TURN_RESERVE_TOKENS),
  );
  return next <= ledger.limit;
}

/**
 * Is this ledger on its LAST ladder rung — the one no auto-raise will lift it off?
 *
 * Narrower than `autoRaiseExhausted`: that one also answers true for a ledger
 * whose raise would not move the limit because it still has room, which is the
 * right answer for "is the latch final" and the wrong one for "may the door
 * check trust a raise to cover this turn". This asks only the second question:
 * with auto-raise off, no anchor to raise from, or the limit already at (or,
 * after an operator raise, past) `original x max_multiple`, nothing will add
 * headroom before this seat's next turn settles.
 *
 * An unlimited ledger has no rungs at all, so it is never on the last one.
 */
export function onFinalBudgetRung(state: Projections, config: ResolvedMeshConfig, key: BudgetKey): boolean {
  const ledger = state.budgets.get(key);
  if (!ledger || ledger.limit === null) return false;
  const cfg = config.budgets?.autoRaise;
  if (!cfg?.enabled) return true;
  const original = configuredBudgetLimit(state, config, key);
  if (original === null || !Number.isFinite(original) || original <= 0) return true;
  if (!Number.isFinite(cfg.maxMultiple) || cfg.maxMultiple <= 0) return true;
  return ledger.limit >= Math.floor(original * cfg.maxMultiple);
}

/**
 * Seats of the active goal whose OWN ledger is spent past anything auto-raise
 * will do: exactly the ledgers the termination verdict used to halt the whole
 * goal on. They are parked instead — the policy's `budget` rule defers their
 * activations while `exceeded` holds — and only when every live seat is on this
 * list does the mission stop, because then nobody can take a turn at all.
 *
 * Live means a seat that could otherwise still run: not the operator seat, not
 * retired/completed/suspended, and not terminally failed.
 */
export function budgetParkedSeats(state: Projections, config: ResolvedMeshConfig): string[] {
  const goalId = state.activeGoalId;
  if (!goalId) return [];
  const out: string[] = [];
  for (const b of state.budgets.values()) {
    if (!b.exceeded || !b.key.startsWith(`agent:${goalId}/`)) continue;
    if (!autoRaiseExhausted(state, config, b.key)) continue;
    out.push(b.key.slice(`agent:${goalId}/`.length));
  }
  return out;
}

/** Seats that could take a turn if nothing else stopped them. See `budgetParkedSeats`. */
export function liveSeats(state: Projections): string[] {
  const out: string[] = [];
  // Keyed by the map key, which IS the agent id; several termination fixtures
  // build records with neither `state.agentId` nor `definition.id`.
  for (const [id, rec] of state.agents) {
    if (!id || id === "human") continue;
    const lc = rec.state?.lifecycle;
    if (lc === "RETIRED" || lc === "COMPLETED" || lc === "SUSPENDED") continue;
    if (lc === "FAILED" && rec.state?.restartable !== true) continue;
    out.push(id);
  }
  return out;
}

/**
 * What one settled turn is billed, and how lucky its cache was.
 *
 * `total` is the backend's billable work (input + output + cache writes); cache
 * reads are reported beside it and, by default, cost nothing. Measured
 * 2026-09-25: that made budgets bill cache LUCK — five cache-miss turns were 64%
 * of all fresh input, while a turn that read 6.77M from cache billed 267k.
 * `budgets.cache_read_weight` (0..1, default 0) lets a mesh charge reads at a
 * fraction so a cold transcript and a warm one cost comparably; at 0 the billed
 * figure is byte-for-byte what it always was.
 *
 * `cacheReadRatio` is reads over the whole prompt (fresh input + reads): the
 * number an operator needs to tell "this turn was expensive" from "this turn
 * missed the cache". Absent when the backend reported no reads.
 */
export function billedTurnTokens(
  usage: { input?: number; output?: number; total?: number; cacheRead?: number } | undefined,
  cacheReadWeight: number | undefined,
): { billed: number; cacheRead?: number; cacheReadRatio?: number; cacheReadBilled?: number } {
  const total = Number.isFinite(usage?.total) ? Math.max(0, usage!.total!) : 0;
  const cacheRead = Number.isFinite(usage?.cacheRead) ? Math.max(0, usage!.cacheRead!) : undefined;
  const weight = Number.isFinite(cacheReadWeight) ? Math.min(1, Math.max(0, cacheReadWeight!)) : 0;
  const cacheReadBilled = cacheRead !== undefined && weight > 0 ? Math.round(cacheRead * weight) : undefined;
  const input = Number.isFinite(usage?.input) ? Math.max(0, usage!.input!) : 0;
  const prompt = input + (cacheRead ?? 0);
  return {
    billed: total + (cacheReadBilled ?? 0),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheRead !== undefined && prompt > 0 ? { cacheReadRatio: Math.round((cacheRead / prompt) * 1000) / 1000 } : {}),
    ...(cacheReadBilled !== undefined ? { cacheReadBilled } : {}),
  };
}

/**
 * What an operator should be told before a seat's limit moves past the mission.
 *
 * Measured 2026-09-25: tech-lead was raised to 22,000,000 on a mesh whose
 * mission cap was 12,640,000, and nothing said that the seat's limit no longer
 * bound anything — the mission ledger would stop it first — or that the seats'
 * ceilings now summed well past the cap the mesh.yaml comment claimed they
 * matched. Both are facts, not refusals: the raise still happens.
 *
 * A seat's ceiling is the most its ledger can reach without an operator: its
 * live limit, or `original x max_multiple` while auto-raise can still climb.
 */
export function missionCapWarnings(state: Projections, config: ResolvedMeshConfig, key: BudgetKey, next: number): string[] {
  const goalId = state.activeGoalId;
  if (!goalId || !key.startsWith(`agent:${goalId}/`)) return [];
  const mKey = missionKey(goalId);
  const cap = state.budgets.get(mKey)?.limit ?? config.budgets?.mission?.tokens ?? null;
  if (cap === null || !Number.isFinite(cap) || cap <= 0) return [];
  const seat = key.slice(`agent:${goalId}/`.length);
  const out: string[] = [];
  if (next > cap) {
    out.push(`${seat} limit ${next} is above the mission cap (${cap}): the mission ledger, not this seat's, is now what stops it`);
  }
  const cfg = config.budgets?.autoRaise;
  let sum = 0;
  for (const id of liveSeats(state)) {
    const k = agentKey(goalId, id);
    const limit = k === key ? next : (state.budgets.get(k)?.limit ?? configuredBudgetLimit(state, config, k));
    if (limit === null || !Number.isFinite(limit)) continue;
    const original = configuredBudgetLimit(state, config, k);
    const climb = cfg?.enabled && original !== null && original > 0 && Number.isFinite(cfg.maxMultiple) ? Math.floor(original * cfg.maxMultiple) : 0;
    sum += Math.max(limit, climb);
  }
  if (sum > cap) {
    out.push(`seat ceilings now sum to ${sum}, above the mission cap ${cap}: seats can jointly spend past it, so the mission ledger will halt the goal before every seat's own ceiling binds`);
  }
  return out;
}

export interface ReserveOptions {
  actorId?: string;
  goalId?: string;
  causationId?: string;
  /**
   * Accept a grant smaller than the ask instead of being refused.
   *
   * Off by default, because a hold cannot cap the spend it admits: under a
   * partial grant the caller's full cost is still consumed and the ledger passes
   * its limit. Callers turn it on only where a short hold is honest -- an ask
   * that is a worst-case bound rather than an estimate (a seat's first turn), a
   * ledger whose shortfall the caller answers by shrinking the work (threads),
   * or a top-up on a turn that is already admitted.
   */
  allowPartial?: boolean;
}

export interface ReserveResult {
  reservationId: string;
  blocked: boolean;
  reason?: string;
  requested: number;
  granted: number;
}

export class BudgetManager {
  private exceededEmitted = new Set<string>();
  /** Tail of the in-flight `reserve` chain per key; see `reserve`. */
  private reserving = new Map<string, Promise<unknown>>();
  constructor(private kernel: Kernel) {}

  declare(key: BudgetKey, kind: BudgetProjectionEntry["limitKind"], limit: number | null): void {
    ensureBudget(this.kernel.state, key, kind, limit);
  }

  /**
   * Reserve `amount` against `key`.
   *
   * Serialized per key. The headroom is read from state and the hold lands only
   * when the emit applies, so two concurrent reserves on one ledger both read the
   * headroom before either hold existed and were both granted it -- which is how
   * two seats' turns jointly overran a mission cap that could pay for one.
   */
  reserve(
    key: BudgetKey,
    kind: BudgetProjectionEntry["limitKind"],
    amount: number,
    limit: number | null,
    opts: ReserveOptions = {},
  ): Promise<ReserveResult> {
    const prev = this.reserving.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => this.reserveNow(key, kind, amount, limit, opts));
    const tail = next.catch(() => undefined);
    this.reserving.set(key, tail);
    void tail.then(() => {
      if (this.reserving.get(key) === tail) this.reserving.delete(key);
    });
    return next;
  }

  private async reserveNow(
    key: BudgetKey,
    kind: BudgetProjectionEntry["limitKind"],
    amount: number,
    limit: number | null,
    opts: ReserveOptions,
  ): Promise<ReserveResult> {
    const state = this.kernel.state;
    const ledger = ensureBudget(state, key, kind, limit);
    const requested = amount;
    const projected = ledger.consumed + ledger.reserved + amount;
    if (ledger.limit !== null && projected > ledger.limit) {
      if (ledger.consumed <= ledger.limit) {
        const headroom = Math.max(0, ledger.limit - ledger.consumed - ledger.reserved);
        if (headroom <= 0) {
          await this.exceeded(key, ledger.limit, ledger.consumed, opts);
          return { reservationId: "", blocked: true, reason: `budget ${key} exhausted (${ledger.consumed}/${ledger.limit})`, requested, granted: 0 };
        }
        // Partial headroom. Refused unless the caller opted in: a hold does not
        // cap what the holder goes on to spend, so a short grant admitted a turn
        // whose full cost was then consumed past the limit -- a 32k ask against
        // 5k of headroom became a 5k decoration and the cap never bound.
        //
        // Not an exhaustion, so no `budget.exceeded`: the ledger still has
        // headroom, just less than this ask, and the latch is once per key.
        if (!opts.allowPartial) {
          return {
            reservationId: "",
            blocked: true,
            reason: `budget ${key} short: ${headroom} left of ${ledger.limit} (consumed ${ledger.consumed}, held ${ledger.reserved}), ${requested} asked`,
            requested,
            granted: 0,
          };
        }
        // Opted in: hold what is left. `granted < requested` is the signal that
        // keeps this honest -- the caller can see it did not get what it asked
        // for, and owns what it does about that.
        amount = Math.min(amount, headroom);
      } else {
        await this.exceeded(key, ledger.limit, ledger.consumed, opts);
        return { reservationId: "", blocked: true, reason: `budget ${key} exhausted (${ledger.consumed}/${ledger.limit})`, requested, granted: 0 };
      }
    }
    const reservationId = monotonicId("res");
    // `requested` rides along because `amount` alone cannot be read. A hold below
    // TURN_RESERVE_TOKENS has two unrelated causes — a partial grant against thin
    // headroom, and a smaller ask sized down from the EWMA of past turns — and the
    // event recorded only the outcome, so the log could not tell them apart. On
    // 2026-09-24 two seats reserved 16,470 and 12,865 against a 32,000 ceiling and
    // there was no way to say from the log whether either was short.
    //
    // `limit` is the ledger's LIVE limit, not the caller's argument: callers pass
    // the declared figure (it only seeds a ledger that does not exist yet), so an
    // auto-raised 1.44M ledger logged its holds against 180,000 and a reader
    // could not tell what the hold was actually measured against. Replay-safe:
    // the reducer only uses this to seed a missing ledger, and `ensureBudget`
    // above already made the two equal in that case.
    await this.kernel.emit(
      "budget.reserved",
      { key, limitKind: kind, limit: ledger.limit, amount, requested, reservationId },
      { actorId: opts.actorId, goalId: opts.goalId, causationId: opts.causationId },
    );
    return { reservationId, blocked: false, requested, granted: amount };
  }

  async consume(
    key: BudgetKey,
    kind: BudgetProjectionEntry["limitKind"],
    amount: number,
    reservationId?: string,
    detail: Record<string, unknown> = {},
    opts: { actorId?: string; goalId?: string; causationId?: string; correlationId?: string } = {},
  ): Promise<void> {
    const ledger = ensureBudget(this.kernel.state, key, kind, null);
    const wasExceeded = ledger.exceeded;
    await this.kernel.emit(
      "budget.consumed",
      { key, limitKind: kind, limit: ledger.limit, amount, reservationId, agentId: opts.actorId, ...detail },
      opts,
    );
    if (!wasExceeded && ledger.exceeded) {
      await this.exceeded(key, ledger.limit ?? ledger.consumed, ledger.consumed, opts);
    }
  }

  async release(key: BudgetKey, reservationId: string, opts: { actorId?: string; goalId?: string; reason?: string } = {}): Promise<void> {
    const ledger = this.kernel.state.budgets.get(key);
    if (!ledger || !ledger.reservations.has(reservationId)) return;
    const { reason, ...meta } = opts;
    await this.kernel.emit("budget.released", { key, reservationId, ...(reason ? { reason } : {}) }, meta);
  }

  private async exceeded(
    key: BudgetKey,
    limit: number,
    consumed: number,
    opts: { actorId?: string; goalId?: string },
  ): Promise<void> {
    if (this.exceededEmitted.has(key)) return;
    this.exceededEmitted.add(key);
    await this.kernel.emit("budget.exceeded", { key, limit, consumed }, opts);
  }

  /**
   * Latch a ledger whose seat can no longer afford a turn, although it is not
   * yet overdrawn.
   *
   * The door check on a seat's last rung holds the seat's real per-turn estimate
   * (see `Supervisor.sizedTurnReserve`), so a refusal there means "the headroom
   * left is less than what this seat's turns cost, and nothing will raise it".
   * Without a latch that seat stayed activatable: every wake reached the door,
   * was turned away, and went BLOCKED again. Latching it parks it exactly like
   * an overdrawn seat — the policy's `budget` rule defers its activations, the
   * watchdog carries its card to the operator, and a raise clears the latch the
   * same way (`budget.limit_raised` recomputes `exceeded`).
   *
   * `short: true` is what tells this apart from an overrun in the log: consumed
   * is still below the limit, and the payload says how much was asked for.
   */
  async latchShort(
    key: BudgetKey,
    detail: { requested: number; headroom: number },
    opts: { actorId?: string; goalId?: string; causationId?: string } = {},
  ): Promise<void> {
    const ledger = this.kernel.state.budgets.get(key);
    if (!ledger || ledger.limit === null || ledger.exceeded || this.exceededEmitted.has(key)) return;
    this.exceededEmitted.add(key);
    await this.kernel.emit("budget.exceeded", { key, limit: ledger.limit, consumed: ledger.consumed, short: true, ...detail }, opts);
  }

  /**
   * Raise a budget limit at runtime (operator action from an escalation).
   * Emits `budget.limit_raised` so the change survives replay. Clears the
   * exceeded latch when the new limit covers current spend, and re-arms
   * `budget.exceeded` so a future overrun emits again.
   */
  async raiseLimit(
    key: BudgetKey,
    limit: number,
    opts: {
      actorId?: string;
      goalId?: string;
      causationId?: string;
      reason?: string;
      /**
       * Who actually decided this. In a field, because `actorId` cannot answer
       * it: the turn path labels an auto-raise with the agent's id, the watchdog
       * sweep labelled it `human`, and a genuine operator raise is `human` too —
       * three values for two meanings. One live run recorded ten raises as
       * `actorId: "human"` when the operator had made exactly one decision, and
       * the only way to tell them apart was to parse the prose in `reason`.
       */
      decidedBy?: "auto" | "operator";
      /**
       * Facts the operator should see about this raise (see
       * `missionCapWarnings`). On the event, so the log says it was known at
       * the time and not only in an HTTP response nobody kept.
       */
      warnings?: string[];
    } = {},
  ): Promise<{ previous: number | null; limit: number; unblocked: boolean }> {
    const ledger = ensureBudget(this.kernel.state, key, "tokens", null);
    const previous = ledger.limit;
    this.exceededEmitted.delete(key);
    await this.kernel.emit(
      "budget.limit_raised",
      {
        key,
        limitKind: ledger.limitKind,
        limit,
        previous,
        reason: opts.reason ?? "operator raise",
        decidedBy: opts.decidedBy ?? "operator",
        ...(opts.warnings && opts.warnings.length > 0 ? { warnings: opts.warnings } : {}),
      },
      { actorId: opts.actorId, goalId: opts.goalId, causationId: opts.causationId },
    );
    const unblocked = ledger.limit === null || ledger.consumed <= ledger.limit;
    return { previous, limit, unblocked };
  }

  snapshot(): BudgetProjectionEntry[] {
    return budgetEntries(this.kernel.state);
  }
}
