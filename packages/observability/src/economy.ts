import type { TurnLedgerRow } from "./ledger";

/**
 * What the mission spent, against what it produced.
 *
 * The turn ledger answers "what did each turn cost". It cannot answer the only
 * question an operator actually has: whether the money bought anything. On the
 * live mission of 2026-10-23..11-03 the ledger could say 110.3M billable tokens
 * over 1,327 turns; nothing in the repo could divide that by the four criteria
 * that were accepted, the patches that merged or the tasks that completed.
 *
 * Outcomes are counted from the event log, money from the same audit file
 * `curule ledger` reads, so this works offline on a stopped or archived mission.
 * A ratio is `null` rather than 0 when nothing was produced: "no patch merged"
 * is not "each patch cost nothing".
 */

export interface EconomyEvent {
  type: string;
  actorId?: string;
  timestamp?: string;
  payload?: Record<string, unknown>;
}

export interface EconomyAgentRow {
  agentId: string;
  turns: number;
  billable: number;
  input: number;
  output: number;
  cacheRead: number;
  /** Share of the mission's billable tokens. */
  share: number;
}

export interface EconomyOutcomes {
  criterionAccepted: number;
  reviews: number;
  patchesMerged: number;
  tasksCompleted: number;
  artifactsPublished: number;
}

export interface EconomyReport {
  turns: number;
  billable: number;
  input: number;
  output: number;
  cacheRead: number;
  /** Cache reads over the whole prompt, over the turns that reported any. `null` when none did. */
  cacheHitRatio: number | null;
  byAgent: EconomyAgentRow[];
  outcomes: EconomyOutcomes;
  tokensPer: {
    criterion: number | null;
    review: number | null;
    mergedPatch: number | null;
    completedTask: number | null;
    artifact: number | null;
  };
  /** The most expensive turns, and the share of the bill the top 5% of turns carried. */
  topTurns: Array<{ turnId: string; agentId: string; billable: number; input: number; cacheRead: number | null; at: string }>;
  topShare: number;
}

export function buildEconomyReport(rows: TurnLedgerRow[], events: readonly EconomyEvent[], top = 10): EconomyReport {
  const input = rows.reduce((a, r) => a + r.input, 0);
  const output = rows.reduce((a, r) => a + r.output, 0);
  const cacheRead = rows.reduce((a, r) => a + (r.cacheRead ?? 0), 0);
  const billableOf = (r: TurnLedgerRow) => r.total ?? r.input + r.output;
  const billable = rows.reduce((a, r) => a + billableOf(r), 0);

  const agents = new Map<string, EconomyAgentRow>();
  for (const r of rows) {
    const a = agents.get(r.agentId) ?? { agentId: r.agentId, turns: 0, billable: 0, input: 0, output: 0, cacheRead: 0, share: 0 };
    a.turns++;
    a.billable += billableOf(r);
    a.input += r.input;
    a.output += r.output;
    a.cacheRead += r.cacheRead ?? 0;
    agents.set(r.agentId, a);
  }
  const byAgent = [...agents.values()]
    .map((a) => ({ ...a, share: billable ? a.billable / billable : 0 }))
    .sort((a, b) => b.billable - a.billable);

  const outcomes: EconomyOutcomes = {
    criterionAccepted: 0,
    reviews: 0,
    patchesMerged: 0,
    tasksCompleted: 0,
    artifactsPublished: 0,
  };
  for (const e of events) {
    if (e.type === "requirement.satisfied") outcomes.criterionAccepted++;
    else if (e.type === "review.approved" || e.type === "review.rejected") outcomes.reviews++;
    else if (e.type === "patch.merged") outcomes.patchesMerged++;
    else if (e.type === "task.completed") outcomes.tasksCompleted++;
    else if (e.type === "artifact.versioned") outcomes.artifactsPublished++;
  }
  const per = (n: number): number | null => (n > 0 ? Math.round(billable / n) : null);

  const sorted = [...rows].sort((a, b) => billableOf(b) - billableOf(a));
  const topCount = Math.max(1, Math.ceil(rows.length * 0.05));
  const topBillable = sorted.slice(0, topCount).reduce((a, r) => a + billableOf(r), 0);

  const measured = rows.filter((r) => r.cacheRead !== null);
  const promptOf = measured.reduce((a, r) => a + r.input + (r.cacheRead ?? 0), 0);

  return {
    turns: rows.length,
    billable,
    input,
    output,
    cacheRead,
    cacheHitRatio: promptOf > 0 ? cacheRead / promptOf : null,
    byAgent,
    outcomes,
    tokensPer: {
      criterion: per(outcomes.criterionAccepted),
      review: per(outcomes.reviews),
      mergedPatch: per(outcomes.patchesMerged),
      completedTask: per(outcomes.tasksCompleted),
      artifact: per(outcomes.artifactsPublished),
    },
    topTurns: sorted.slice(0, top).map((r) => ({
      turnId: r.turnId,
      agentId: r.agentId,
      billable: billableOf(r),
      input: r.input,
      cacheRead: r.cacheRead,
      at: r.at,
    })),
    topShare: billable ? topBillable / billable : 0,
  };
}
