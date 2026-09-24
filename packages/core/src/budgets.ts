import type { BudgetProjectionEntry, EventId } from "../../protocol/src/index";
import { monotonicId } from "../../protocol/src/index";
import type { ResolvedMeshConfig } from "../../config/src/index";
import type { Kernel } from "./kernel";
import type { Projections } from "./state";
import { ensureBudget } from "./state";

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

export class BudgetManager {
  private exceededEmitted = new Set<string>();
  constructor(private kernel: Kernel) {}

  declare(key: BudgetKey, kind: BudgetProjectionEntry["limitKind"], limit: number | null): void {
    ensureBudget(this.kernel.state, key, kind, limit);
  }

  async reserve(
    key: BudgetKey,
    kind: BudgetProjectionEntry["limitKind"],
    amount: number,
    limit: number | null,
    opts: { actorId?: string; goalId?: string; causationId?: string } = {},
  ): Promise<{ reservationId: string; blocked: boolean; reason?: string; requested: number; granted: number }> {
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
        // Partial headroom: hold what is left rather than refusing outright.
        //
        // On its own this is a LIE — the caller was told "not blocked" and then
        // spent whatever it liked, so a 32k ask against 5k of headroom became a
        // 5k decoration and the cap never bound. `granted < requested` is the
        // signal that made it honest: the caller can see it did not get what it
        // asked for and shrink the turn to fit.
        amount = Math.min(amount, headroom);
      } else {
        await this.exceeded(key, ledger.limit, ledger.consumed, opts);
        return { reservationId: "", blocked: true, reason: `budget ${key} exhausted (${ledger.consumed}/${ledger.limit})`, requested, granted: 0 };
      }
    }
    const reservationId = monotonicId("res");
    await this.kernel.emit(
      "budget.reserved",
      { key, limitKind: kind, limit, amount, reservationId },
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

  async release(key: BudgetKey, reservationId: string, opts: { actorId?: string; goalId?: string } = {}): Promise<void> {
    const ledger = this.kernel.state.budgets.get(key);
    if (!ledger || !ledger.reservations.has(reservationId)) return;
    await this.kernel.emit("budget.released", { key, reservationId }, opts);
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
      },
      { actorId: opts.actorId, goalId: opts.goalId, causationId: opts.causationId },
    );
    const unblocked = ledger.limit === null || ledger.consumed <= ledger.limit;
    return { previous, limit, unblocked };
  }

  snapshot(): BudgetProjectionEntry[] {
    return [...this.kernel.state.budgets.values()].map((b) => ({
      key: b.key,
      limit: b.limit,
      limitKind: b.limitKind,
      reserved: b.reserved,
      consumed: b.consumed,
      exceeded: b.exceeded,
    }));
  }
}
