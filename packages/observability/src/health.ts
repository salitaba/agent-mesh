import { reviewDebt } from "../../core/src/artifact-hygiene";
import { liveSeats } from "../../core/src/budgets";
import { openRejections } from "../../core/src/projections";
import type { Projections } from "../../core/src/state";

/**
 * Why a mission is not moving, as one machine-readable answer.
 *
 * Every condition here is already a projection — nothing new is counted, nothing
 * is guessed from a log window. The point is that a stuck mission can say what
 * it is stuck on without an operator going to look: the review queue it cannot
 * close, the criterion nobody is proving, the rejected patch nobody reworked, the
 * card nobody answered. The console renders the first sentence; the supervisor's
 * remedies and `curule reviews archive-stale` read the same fields.
 */
export type HealthCode = "review_debt" | "criteria_unsatisfied" | "rejected_patches" | "open_cards" | "no_live_seats";

export interface HealthReason {
  code: HealthCode;
  /** One sentence an operator can act on. */
  detail: string;
  count: number;
}

export interface HealthReport {
  status: "ok" | "attention" | "blocked";
  goalStatus: string;
  reasons: HealthReason[];
  reviewDebt: { open: number; cited: number; uncited: number };
  criteria: { mandatory: number; unsatisfied: number };
  /**
   * The sentence for the one state that looks fine and is not: every mandatory
   * check is evidenced and the completion gate is held by a review queue.
   */
  completionHold?: string;
}

export function buildHealth(state: Projections): HealthReport {
  const goalId = state.activeGoalId ?? undefined;
  const goal = goalId ? state.goals.get(goalId) : undefined;
  const goalStatus = goal?.status ?? "";
  const mandatory = (goal?.acceptanceCriteria ?? []).filter((c) => c.mandatory);
  const unsatisfied = mandatory.filter((c) => c.status !== "EVIDENCED" && c.status !== "WAIVED");
  const debt = reviewDebt(state, goalId);
  const rejected = goalId ? openRejections(state, goalId) : [];
  const cards = goalId
    ? [...state.escalations.values()].filter((e) => e.status === "OPEN" && e.goalId === goalId && !e.advisory)
    : [];
  const seats = liveSeats(state);

  const reasons: HealthReason[] = [];
  if (unsatisfied.length > 0) {
    reasons.push({
      code: "criteria_unsatisfied",
      count: unsatisfied.length,
      detail:
        `${unsatisfied.length} mandatory criterion${unsatisfied.length === 1 ? "" : "s"} still need${unsatisfied.length === 1 ? "s" : ""} evidence: ` +
        unsatisfied.map((c) => c.id).join(", "),
    });
  }
  if (debt.open.length > 0) {
    reasons.push({
      code: "review_debt",
      count: debt.open.length,
      detail:
        `${debt.open.length} artifact${debt.open.length === 1 ? "" : "s"} await${debt.open.length === 1 ? "s" : ""} a verdict; ` +
        `${debt.uncited.length} uncited by any criterion and closable by the curator, ${debt.cited.length} cited by a criterion`,
    });
  }
  if (rejected.length > 0) {
    reasons.push({
      code: "rejected_patches",
      count: rejected.length,
      detail: `${rejected.length} rejected patch${rejected.length === 1 ? "" : "es"} neither landed nor withdrawn`,
    });
  }
  if (cards.length > 0) {
    reasons.push({
      code: "open_cards",
      count: cards.length,
      detail: `${cards.length} card${cards.length === 1 ? "" : "s"} await${cards.length === 1 ? "s" : ""} an answer`,
    });
  }
  if (seats.length === 0 && goalStatus === "ACTIVE") {
    reasons.push({ code: "no_live_seats", count: 0, detail: "no seat can take a turn: every live seat is parked, failed or exhausted" });
  }

  // "Ready to close but held" outranks everything else it coexists with: the
  // work is done, and the only thing between the mission and COMPLETED is a
  // queue nobody decided.
  const heldByReviews = goalStatus === "ACTIVE" && unsatisfied.length === 0 && debt.open.length > 0;
  const status: HealthReport["status"] = heldByReviews ? "blocked" : reasons.length > 0 ? "attention" : "ok";

  return {
    status,
    goalStatus,
    reasons,
    reviewDebt: { open: debt.open.length, cited: debt.cited.length, uncited: debt.uncited.length },
    criteria: { mandatory: mandatory.length, unsatisfied: unsatisfied.length },
    ...(heldByReviews
      ? {
          completionHold:
            `${debt.open.length} file${debt.open.length === 1 ? "" : "s"} still await${debt.open.length === 1 ? "s" : ""} a verdict ` +
            `(${debt.uncited.length} uncited and closable, ${debt.cited.length} cited by a criterion)`,
        }
      : {}),
  };
}
