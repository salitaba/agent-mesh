/**
 * Presentation helpers for an agent's private plan.
 *
 * Pure and dependency-free so they can be unit-tested without a DOM: the
 * drawer only renders what these return.
 */

export interface PlanStepView {
  id: string;
  text: string;
  status: string;
  capabilities?: string[];
}

export interface PlanView {
  taskId?: string;
  steps: PlanStepView[];
  revision?: number;
  updatedAt?: string;
}

/** `{done, total, pct}` — pct is 0 for an empty plan rather than NaN. */
export function planProgress(plan: PlanView | null | undefined): { done: number; total: number; pct: number } {
  const steps = plan?.steps ?? [];
  const done = steps.filter((s) => s.status === "DONE").length;
  return { done, total: steps.length, pct: steps.length ? Math.round((done / steps.length) * 100) : 0 };
}

/**
 * A plan recorded for a task the agent is no longer on.
 *
 * The runtime never clears a stale plan (a reducer that did would make replay
 * and snapshot restore disagree), so staleness is a read-time question here
 * exactly as it is in the policy gate. Unknown on either side means "not
 * stale" — we do not grey out a plan on missing data.
 */
function staleById(planTaskId: string | null | undefined, activeTaskId: string | null | undefined): boolean {
  if (!planTaskId || !activeTaskId) return false;
  return planTaskId !== activeTaskId;
}

export function planStale(plan: PlanView | null | undefined, activeTaskId: string | null | undefined): boolean {
  return staleById(plan?.taskId, activeTaskId);
}

/**
 * The plan as it travels in the agent LIST payload: three scalars, no steps.
 *
 * The list is polled for every agent at once, so it carries a projection rather
 * than the array; the drawer still fetches the real plan for the checklist.
 */
export interface PlanSummary {
  done: number;
  total: number;
  taskId: string | null;
}

/** Null when there is nothing to badge — a missing plan, or an empty one. */
export function planSummary(
  row: { planDone?: number | null; planTotal?: number; planTaskId?: string | null } | null | undefined,
): PlanSummary | null {
  const total = row?.planTotal ?? 0;
  if (!total) return null;
  return { done: row?.planDone ?? 0, total, taskId: row?.planTaskId ?? null };
}

/** The same read-time staleness rule, applied to the list projection. */
export function planSummaryStale(s: PlanSummary | null | undefined, activeTaskId: string | null | undefined): boolean {
  return staleById(s?.taskId, activeTaskId);
}

export function planLabel(plan: PlanView | null | undefined): string {
  const { done, total } = planProgress(plan);
  if (!total) return "No plan";
  return `${done}/${total} steps`;
}
