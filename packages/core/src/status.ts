import type { BudgetProjectionEntry, Escalation, Goal, LifecycleState, MeshEvent } from "../../protocol/src/index";
import type { ResolvedMeshConfig } from "../../config/src/index";
import { applyEvent, projectionConfigFor } from "./projections";
import { openCardSummary, type OpenCardSummary } from "./termination";
import { budgetEntries, createInitialState, readableMailDepth, type Projections } from "./state";

/**
 * What `GET /status` and `curule status` say of a mission: its goal, how far it has got, what it has spent, and what each seat is doing.
 *
 * One function over the projections, so a live mesh and an event log read from disk describe a mission in the same words. The log read
 * from disk used to be summarised on its own: the goal as `goal.created` first wrote it, no progress, no budgets. A mission that had
 * finished printed `[ACTIVE]` at 0% with no tokens line (fourteenth cronlite run), because nothing in that pass applied `goal.completed`,
 * and `curule status` is the first command anyone runs to ask whether a run is over.
 */
export interface MissionStatus {
  goal?: Goal;
  agents: Array<{
    id: string;
    role: string;
    lifecycle: LifecycleState;
    mailbox: number;
    tokens: number;
    taskId: string | null;
    activations: number;
    /**
     * Scalar projection of the agent's private plan, for the dashboard's card badge. Deliberately NOT the plan itself: this payload is
     * polled for every agent at once, so a growing array does not belong here. The full steps stay on the per-agent detail fetch.
     */
    planDone: number | null;
    planTotal: number;
    planTaskId: string | null;
  }>;
  budgets: BudgetProjectionEntry[];
  progress: { completed: number; total: number; ratio: number } | null;
  openEscalations: Escalation[];
  /**
   * The OPEN escalation cards an operator still owes an answer, as summaries: the same list `openEscalations` carries, dated and
   * trimmed to what one acts on. They no longer gate completion (`termination.ts`), so without this a finished mission's unanswered
   * cards would be invisible to anything reading the status payload — a run that closes with one is exactly the state a reader has to
   * be able to see. Empty when there are none.
   */
  needsOperator: OpenCardSummary[];
  eventCount: number;
}

export function missionStatus(
  state: Projections,
  budgets: BudgetProjectionEntry[] = budgetEntries(state),
  nowMs: number = Date.now(),
): MissionStatus {
  const goalId = state.activeGoalId;
  const goal = goalId ? state.goals.get(goalId) : undefined;
  const progress = goalId ? state.progress.get(goalId) : undefined;
  const openEscalations = [...state.escalations.values()].filter((e) => e.status === "OPEN");
  return {
    goal,
    agents: [...state.agents.values()].map((r) => ({
      id: r.definition.id,
      role: r.definition.role,
      lifecycle: r.state.lifecycle,
      mailbox: readableMailDepth(state, r.definition.id),
      tokens: r.state.tokensConsumed,
      taskId: r.state.activeTaskId ?? null,
      activations: r.state.activations,
      planDone: r.state.plan ? r.state.plan.steps.filter((s) => s.status === "DONE").length : null,
      planTotal: r.state.plan?.steps.length ?? 0,
      planTaskId: r.state.plan?.taskId ?? null,
    })),
    budgets,
    progress: progress ? { completed: progress.completed, total: progress.total, ratio: progress.ratio } : null,
    openEscalations,
    needsOperator: openEscalations.map((e) => openCardSummary(e, nowMs)),
    eventCount: state.eventCount,
  };
}

/** An event the replay could not apply: where it sits in the log and why. */
export interface UnappliedEvent {
  seq: number | undefined;
  type: string;
  message: string;
}

/**
 * The status of a mission that is not running, from its event log alone, with nothing started and no model invoked.
 *
 * It is the live status but for the ledgers: one that was declared at boot and never reserved or booked on leaves no event, so the log
 * does not know it (it holds nothing).
 *
 * An event that does not apply is skipped and reported rather than ending the read: this is what one runs when something has gone
 * wrong, and a status that refuses to print because of one bad line in the log is of no use then. The figures are then possibly off
 * by what that event carried, which is why the caller is handed the list.
 */
export function statusFromLog(events: Iterable<MeshEvent>, config?: ResolvedMeshConfig): { status: MissionStatus; unapplied: UnappliedEvent[] } {
  const state = createInitialState();
  const projection = config ? projectionConfigFor(config) : undefined;
  const unapplied: UnappliedEvent[] = [];
  for (const event of events) {
    try {
      applyEvent(state, event, projection);
    } catch (err) {
      unapplied.push({ seq: event.seq, type: event.type, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { status: missionStatus(state), unapplied };
}
