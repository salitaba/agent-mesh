import type { AgentDefinition, AcceptanceCriterion, StagedMutation, StagedProposal } from "../../../packages/protocol/src/index";
import type { ResolvedMeshConfig } from "../../../packages/config/src/index";
import type { MeshInstance } from "./index";

/**
 * What a just-saved mesh.yaml would have to do to the RUNNING mesh to match it.
 *
 * mesh.yaml is a seed, not a mirror. `supervisor.boot` reads it once: the goal
 * is minted only when the mesh is not resuming, seats are reconciled per boot,
 * budgets are declared per boot. `GET /config` re-reads the file on every poll.
 * So after a Save the Config view shows the file and the Overview shows the
 * mission that actually booted, and the two legitimately disagree.
 *
 * This module turns that disagreement into a `StagedProposal` — the exact shape
 * the designer assistant already produces — so the operator applies it through
 * `POST /designer/staged/apply` like any other proposal, and inherits every
 * guard, refusal and destructive-confirm that path already has. Nothing here
 * mutates anything; it only describes what would have to change.
 *
 * It runs SERVER-side because `seat.spawn` needs a fully resolved
 * `AgentDefinition`. Building one in the browser would mean re-implementing
 * `buildResolved`'s defaults and letting the two drift apart.
 *
 * `problems` carries what CANNOT be synced, so a partial proposal never reads
 * as a complete one. Three cases, all real:
 *   - a live seat whose definition changed (no staged kind replaces a live
 *     seat's definition — boot's `agent.replaced` has no mutation counterpart),
 *   - a seat that was RETIRED (terminal; it can never come back),
 *   - the mission token budget (`adjustGoalBudget` accepts only the other two).
 */

const HUMAN_SEAT = "human";

function norm(s: unknown): string {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

export function configDrift(resolved: ResolvedMeshConfig, instance: MeshInstance): StagedProposal {
  const state = instance.kernel.state;
  const mutations: StagedMutation[] = [];
  const problems: string[] = [];
  const why = "mesh.yaml was saved with this value";

  const proposal = (): StagedProposal => ({
    id: `config-save-${Date.now()}`,
    createdAt: new Date().toISOString(),
    mutations,
    problems,
  });

  const goalId = state.activeGoalId;
  const goal = goalId ? state.goals.get(goalId) : undefined;
  if (!goal) {
    problems.push("no active mission is running, so there is nothing to bring in line — this file is the seed for the next boot.");
    return proposal();
  }

  /* ---- goal text ---- */
  if (norm(resolved.goalText) && norm(resolved.goalText) !== norm(goal.description)) {
    mutations.push({ kind: "goal.description", description: resolved.goalText, reason: why });
  }

  /* ---- acceptance criteria ----
   * A file with NO `acceptance_criteria` is the ordinary shape of a mesh whose
   * criteria were derived at boot. Reading that as "delete them all" would let
   * a Save empty the definition of done, so absence is reported, never acted on. */
  const liveCriteria = goal.acceptanceCriteria ?? [];
  const fileCriteria = resolved.goalCriteria;
  if (!fileCriteria) {
    if (liveCriteria.length) {
      problems.push(`mesh.yaml declares no acceptance_criteria, so the mission's ${liveCriteria.length} live criteri${liveCriteria.length === 1 ? "on is" : "a are"} left alone — an absent section is not a request to clear them.`);
    }
  } else {
    const liveById = new Map(liveCriteria.map((c) => [c.id, c]));
    const fileIds = new Set(fileCriteria.map((c) => c.id));
    const added = fileCriteria.filter((c) => !liveById.has(c.id));
    if (added.length) mutations.push({ kind: "criteria.add", criteria: added as AcceptanceCriterion[], reason: why });
    for (const c of fileCriteria) {
      const live = liveById.get(c.id);
      if (!live) continue;
      const descChanged = norm(c.description) !== norm(live.description);
      const mandChanged = Boolean(c.mandatory) !== Boolean(live.mandatory);
      if (!descChanged && !mandChanged) continue;
      mutations.push({
        kind: "criteria.edit",
        criterionId: c.id,
        ...(descChanged ? { description: c.description } : {}),
        ...(mandChanged ? { mandatory: c.mandatory } : {}),
        reason: why,
      });
    }
    for (const live of liveCriteria) {
      if (!fileIds.has(live.id)) {
        mutations.push({ kind: "criteria.delete", criterionId: live.id, reason: "no longer present in the saved mesh.yaml" });
      }
    }
  }

  /* ---- seats ---- */
  for (const id of resolved.agentOrder) {
    const def: AgentDefinition = resolved.agents[id];
    const rec = state.agents.get(id);
    if (!rec) {
      mutations.push({ kind: "seat.spawn", agent: def, reason: why });
      continue;
    }
    if (rec.state.lifecycle === "RETIRED") {
      problems.push(`seat '${id}' is in mesh.yaml but was retired, and retirement is terminal — it cannot be brought back without a restart.`);
      continue;
    }
    if (JSON.stringify(rec.definition) !== JSON.stringify(def)) {
      problems.push(`seat '${id}' differs from the running definition. No staged kind replaces a live seat's definition — boot does that, so restart the mesh to pick it up.`);
    }
  }
  for (const [id, rec] of state.agents) {
    if (id === HUMAN_SEAT) continue;
    if (rec.state.lifecycle === "RETIRED") continue;
    if (!resolved.agents[id]) {
      mutations.push({ kind: "seat.retire", agentId: id, reason: "no longer present in the saved mesh.yaml" });
    }
  }

  /* ---- mission budget ----
   * `run.budget` is inline `{ maxEvents?, wallClockMinutes? }` because
   * `adjustGoalBudget` accepts only those two. A changed token cap is real
   * drift that this surface cannot carry, so it is reported instead. */
  const fileBudget = resolved.budgets.mission;
  const budget: { maxEvents?: number; wallClockMinutes?: number } = {};
  if (fileBudget.maxEvents !== goal.budget.maxEvents) budget.maxEvents = fileBudget.maxEvents;
  if (fileBudget.wallClockMinutes !== goal.budget.wallClockMinutes) budget.wallClockMinutes = fileBudget.wallClockMinutes;
  if (budget.maxEvents !== undefined || budget.wallClockMinutes !== undefined) {
    mutations.push({ kind: "run.budget", budget, reason: why });
  }
  if (fileBudget.tokens !== goal.budget.tokens) {
    problems.push(`the mission token budget differs (file ${fileBudget.tokens}, running ${goal.budget.tokens}), and the live budget call accepts only the event and wall-clock caps — raise tokens from the mission controls instead.`);
  }

  return proposal();
}
