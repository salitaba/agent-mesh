import type { BudgetProjectionEntry, EventId } from "../../protocol/src/index";
import { monotonicId } from "../../protocol/src/index";
import type { Kernel } from "./kernel";
import { ensureBudget } from "./state";

export type BudgetKey = string;

export function missionKey(goalId: string): BudgetKey {
  return `mission:${goalId}`;
}
export function agentKey(goalId: string, agentId: string): BudgetKey {
  return `agent:${goalId}/${agentId}`;
}
export function threadKey(goalId: string, threadId: string): BudgetKey {
  return `thread:${goalId}/${threadId}`;
}
export function taskKey(goalId: string, taskId: string): BudgetKey {
  return `task:${goalId}/${taskId}`;
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
  ): Promise<{ reservationId: string; blocked: boolean; reason?: string }> {
    const state = this.kernel.state;
    const ledger = ensureBudget(state, key, kind, limit);
    const projected = ledger.consumed + ledger.reserved + amount;
    if (ledger.limit !== null && projected > ledger.limit) {
      if (ledger.consumed <= ledger.limit) {
        const headroom = Math.max(0, ledger.limit - ledger.consumed - ledger.reserved);
        if (headroom <= 0) {
          await this.exceeded(key, ledger.limit, ledger.consumed, opts);
          return { reservationId: "", blocked: true, reason: `budget ${key} exhausted (${ledger.consumed}/${ledger.limit})` };
        }
        amount = Math.min(amount, headroom);
      } else {
        await this.exceeded(key, ledger.limit, ledger.consumed, opts);
        return { reservationId: "", blocked: true, reason: `budget ${key} exhausted (${ledger.consumed}/${ledger.limit})` };
      }
    }
    const reservationId = monotonicId("res");
    await this.kernel.emit(
      "budget.reserved",
      { key, limitKind: kind, limit, amount, reservationId },
      { actorId: opts.actorId, goalId: opts.goalId, causationId: opts.causationId },
    );
    return { reservationId, blocked: false };
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
    opts: { actorId?: string; goalId?: string; causationId?: string; reason?: string } = {},
  ): Promise<{ previous: number | null; limit: number; unblocked: boolean }> {
    const ledger = ensureBudget(this.kernel.state, key, "tokens", null);
    const previous = ledger.limit;
    this.exceededEmitted.delete(key);
    await this.kernel.emit(
      "budget.limit_raised",
      { key, limitKind: ledger.limitKind, limit, previous, reason: opts.reason ?? "operator raise" },
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
