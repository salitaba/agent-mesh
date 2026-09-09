import type { Projections } from "../../core/src/state";
import type { ResolvedMeshConfig } from "../../config/src/index";

export interface ModelCost {
  model: string;
  tokens: number;
  input: number;
  output: number;
  /** Replayed transcript tokens — recorded for visibility, never billed. */
  cacheRead: number;
  turns: number;
  agents: string[];
  /** Share of total spend, 0..1. */
  share: number;
  /** Mean billed tokens per turn on this model. */
  avgPerTurn: number;
}

export interface CostReport {
  perAgent: Array<{ agentId: string; tokens: number; activations: number; perTurn: number }>;
  missionTokens: number;
  missionBudget: number;
  /** Legacy shape: model -> billed tokens. Kept so old callers keep working. */
  perModel: Record<string, number>;
  /** Full per-model breakdown, most expensive first. */
  models: ModelCost[];
}

/**
 * Token accounting for the mission.
 *
 * `perModel` used to be a declared field filled by an empty loop — every
 * consumer received `{}` and nobody could see which model was spending the
 * budget. It is now derived from the `modelSpend` projection, which is fed by
 * `budget.consumed` and therefore replays and snapshots like everything else.
 */
export function buildCostReport(state: Projections, config: ResolvedMeshConfig): CostReport {
  const perAgent = [...state.agents.values()].map((r) => ({
    agentId: r.definition.id,
    tokens: r.state.tokensConsumed,
    activations: r.state.activations,
    perTurn: r.state.activations ? Math.round(r.state.tokensConsumed / r.state.activations) : 0,
  }));

  const spend = [...state.modelSpend.values()];
  const billed = spend.reduce((a, m) => a + m.tokens, 0);
  const models: ModelCost[] = spend
    .map((m) => ({
      model: m.model,
      tokens: m.tokens,
      input: m.input,
      output: m.output,
      cacheRead: m.cacheRead,
      turns: m.turns,
      agents: [...m.agents].sort(),
      share: billed ? m.tokens / billed : 0,
      avgPerTurn: m.turns ? Math.round(m.tokens / m.turns) : 0,
    }))
    .sort((a, b) => b.tokens - a.tokens);

  const perModel: Record<string, number> = {};
  for (const m of models) perModel[m.model] = m.tokens;

  const mission = state.budgets.get(`mission:${state.activeGoalId ?? ""}`);
  return {
    perAgent,
    missionTokens: mission?.consumed ?? perAgent.reduce((a, b) => a + b.tokens, 0),
    missionBudget: mission?.limit ?? config.budgets.mission.tokens,
    perModel,
    models,
  };
}
