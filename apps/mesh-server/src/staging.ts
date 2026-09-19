import type { StagedMutation, AgentDefinition } from "../../../packages/protocol/src/index";
import { DESTRUCTIVE_KINDS } from "../../../packages/protocol/src/index";
import type { MeshInstance } from "./index";

/**
 * Execution half of the staged-mutation surface.
 *
 * The dashboard assistant authors `StagedMutation`s but never runs them; the
 * operator presses Apply and the proposal arrives here. Every kind maps onto a
 * Supervisor method that already exists and already carries its own guards —
 * this module adds no authority of its own, it only routes and re-validates.
 *
 * Two rules the callers depend on:
 *
 * 1. **Array order, halt on first failure.** A proposal is usually a sequence
 *    someone reasoned about ("retire the duplicate seat, then reopen against
 *    the tightened criterion"), so running the tail of a proposal whose head
 *    failed would apply a plan nobody proposed. What already landed stays
 *    landed — these are events, not a transaction — so the result reports
 *    exactly how far it got.
 * 2. **No partial silence.** Staging happens a turn or more before applying,
 *    and the mesh moves in between: a criterion can be satisfied, a seat
 *    retired, a goal completed. Several Supervisor methods return `void` and
 *    refuse internally, so calling one blind would report success on a no-op.
 *    Anything reachable is re-checked here, immediately before the call.
 */

export interface StagedApplyResult {
  kind: StagedMutation["kind"];
  ok: boolean;
  /** Operator-facing sentence: what happened, or why it did not. */
  detail: string;
}

export interface StagedApplyReport {
  ok: boolean;
  /** Count of mutations that ran and succeeded, i.e. the prefix that landed. */
  applied: number;
  /** One entry per mutation attempted. Shorter than the input iff one failed. */
  results: StagedApplyResult[];
}

export interface ApplyContext {
  /**
   * The mesh id the operator typed, for the mutations whose blast radius is the
   * whole mission. Checked here, at apply time, and not when the mutation was
   * staged: a guard at admission binds the agent, which can supply any field it
   * is handed, while this one binds whoever presses Apply — and pressing Apply
   * is the only thing that makes the reset happen.
   */
  confirmId?: string;
}

/**
 * Whether a typed confirmation answers the mesh id.
 *
 * Three doors ask for this string — `POST /mission/reset`, `POST /mission/restore`,
 * and a `mission.reset` arriving on the staged-apply route — and the console
 * card arms on the same value. They share this one comparison so that the
 * string a card accepts is never refused a moment later by the route behind
 * it, which reads as a bug rather than as a guard.
 *
 * Trimmed and case-folded, but empty never matches: an unset `meshId` on either
 * side would otherwise compare equal to an unset other side and quietly arm
 * the door this exists to close.
 */
export function matchesMeshId(typed: unknown, meshId: string): boolean {
  const typedId = String(typed ?? "").trim().toLowerCase();
  const actual = String(meshId ?? "").trim().toLowerCase();
  return typedId.length > 0 && typedId === actual;
}

const ok = (kind: StagedMutation["kind"], detail: string): StagedApplyResult => ({ kind, ok: true, detail });
const no = (kind: StagedMutation["kind"], detail: string): StagedApplyResult => ({ kind, ok: false, detail });

/**
 * Destructive kinds carry a required `reason` in the type, but the proposal
 * arrives as JSON over HTTP, so the compiler has guaranteed nothing about it.
 */
function statedReason(m: StagedMutation): string {
  const r = (m as { reason?: unknown }).reason;
  return typeof r === "string" ? r.trim() : "";
}

export async function applyStagedMutation(
  m: StagedMutation,
  instance: MeshInstance,
  ctx: ApplyContext = {},
): Promise<StagedApplyResult> {
  const supervisor = instance.supervisor;
  const state = instance.kernel.state;

  if (!m || typeof (m as { kind?: unknown }).kind !== "string") return no("config.replace" as never, "mutation has no kind");
  if ((DESTRUCTIVE_KINDS as readonly string[]).includes(m.kind) && !statedReason(m)) {
    return no(m.kind, `${m.kind} is destructive and requires a stated reason`);
  }

  switch (m.kind) {
    // Draft-side, deliberately unreachable from here. `config.replace` rewrites
    // the operator's mesh.yaml draft in the browser and still needs a separate
    // Save; applying one against the running mesh would be a config change
    // nobody reviewed. A client that sends it here has mis-routed.
    case "config.replace":
      return no("config.replace", "config.replace applies to the local draft, not the running mesh — apply it in the designer and Save");

    case "goal.description": {
      const r = await supervisor.reviseGoalDescription(m.description, { reason: m.reason });
      return r.ok
        ? ok(m.kind, `mission statement replaced (was: ${JSON.stringify(r.previous ?? "")})`)
        : no(m.kind, r.reason ?? "revision refused");
    }

    case "criteria.add": {
      const r = await supervisor.addCriteria(m.criteria, { reason: m.reason });
      return r.ok ? ok(m.kind, `added ${r.added?.length ?? 0} criterion(s): ${r.added?.join(", ")}`) : no(m.kind, r.reason ?? "add refused");
    }

    case "criteria.edit": {
      const r = await supervisor.reviseCriterion(m.criterionId, { description: m.description, mandatory: m.mandatory }, { reason: m.reason });
      return r.ok ? ok(m.kind, `criterion '${m.criterionId}' revised`) : no(m.kind, r.reason ?? "revision refused");
    }

    // The guard that makes this whole surface safe lives inside
    // `removeCriterion`, not here: deleting the last unproven criterion makes
    // the remainder vacuously complete and the watchdog then declares a
    // mission done that nobody finished.
    case "criteria.delete": {
      const r = await supervisor.removeCriterion(m.criterionId, { reason: statedReason(m) });
      return r.ok ? ok(m.kind, `criterion '${m.criterionId}' removed`) : no(m.kind, r.reason ?? "removal refused");
    }

    case "seat.spawn": {
      const def = m.agent as AgentDefinition | undefined;
      if (!def || typeof def.id !== "string" || !def.id.trim()) return no(m.kind, "seat.spawn needs an agent definition with an id");
      if (typeof def.role !== "string" || !def.role.trim()) return no(m.kind, `seat '${def.id}' needs a role`);
      // `registerAgent` is a bare emit with no duplicate check, and the reducer
      // would overwrite the live record — including the lifecycle of a seat
      // that is mid-turn.
      if (state.agents.has(def.id)) return no(m.kind, `seat '${def.id}' already exists`);
      await supervisor.registerAgent(def);
      return ok(m.kind, `seat '${def.id}' registered as ${def.role}`);
    }

    case "seat.retire": {
      const r = await supervisor.retireAgent(m.agentId, { reason: statedReason(m) });
      return r.ok ? ok(m.kind, `seat '${m.agentId}' retired`) : no(m.kind, r.reason ?? "retirement refused");
    }

    // suspend/resume return void and refuse internally on a retired or missing
    // seat, so without these checks a stale proposal would report success
    // while nothing moved.
    case "seat.suspend": {
      const rec = state.agents.get(m.agentId);
      if (!rec) return no(m.kind, `unknown agent '${m.agentId}'`);
      if (rec.state.lifecycle === "RETIRED") return no(m.kind, `seat '${m.agentId}' was retired — retirement is terminal`);
      if (rec.state.lifecycle === "SUSPENDED") return no(m.kind, `seat '${m.agentId}' is already suspended`);
      await supervisor.suspendAgent(m.agentId);
      return ok(m.kind, `seat '${m.agentId}' suspended`);
    }

    case "seat.resume": {
      const rec = state.agents.get(m.agentId);
      if (!rec) return no(m.kind, `unknown agent '${m.agentId}'`);
      if (rec.state.lifecycle === "RETIRED") return no(m.kind, `seat '${m.agentId}' was retired — retirement is terminal`);
      if (rec.state.lifecycle !== "SUSPENDED") return no(m.kind, `seat '${m.agentId}' is ${rec.state.lifecycle}, not suspended`);
      await supervisor.resumeAgent(m.agentId);
      return ok(m.kind, `seat '${m.agentId}' resumed`);
    }

    case "seat.wake": {
      if (!state.agents.has(m.agentId)) return no(m.kind, `unknown agent '${m.agentId}'`);
      const r = await supervisor.activateAgent(m.agentId, { kind: "manual", note: m.reason ?? "staged wake applied by operator" });
      return r.queued ? ok(m.kind, `seat '${m.agentId}' queued for a turn`) : no(m.kind, r.blocked ?? "scheduler refused the wake");
    }

    case "run.pause": {
      await supervisor.pauseGoal();
      return ok(m.kind, "mission paused");
    }

    case "run.resume": {
      await supervisor.resumeGoal();
      return ok(m.kind, "mission resumed");
    }

    case "run.budget": {
      const b = m.budget ?? {};
      if (typeof b.maxEvents !== "number" && typeof b.wallClockMinutes !== "number") {
        return no(m.kind, "run.budget needs maxEvents and/or wallClockMinutes");
      }
      const r = await supervisor.adjustGoalBudget({ maxEvents: b.maxEvents, wallClockMinutes: b.wallClockMinutes }, { reason: m.reason });
      return r.ok ? ok(m.kind, "mission caps raised") : no(m.kind, r.reason ?? "budget change refused");
    }

    case "run.reopen": {
      const r = await supervisor.reopenGoal({ reason: statedReason(m) || undefined, criteria: m.criteria });
      if (!r.ok) return no(m.kind, r.reason ?? "reopen refused");
      // A reopened mission that stays parked repeats the original complaint:
      // criteria go back to UNSATISFIED and nothing runs. Same follow-through
      // as POST /mission/reopen.
      if (instance.mode === "parked") await instance.goLive("mission reopened from a staged proposal");
      return ok(m.kind, `mission reopened; ${r.unsatisfied?.length ?? 0} criteria back to UNSATISFIED, revived: ${r.revived?.join(", ") || "(none)"}`);
    }

    // The most destructive thing the surface can do. The required reason above
    // distinguishes a proposal from a stray replay, but it cannot distinguish
    // an operator from anything else that can POST: the agent writes the
    // reason, so a reason-only guard is one the agent satisfies by existing.
    //
    // The typed mesh id is the half the agent cannot supply — it is asked for
    // at Apply, by the console, after the operator has read what this will
    // delete. An agent-proposed reset still works: it stages as it always did,
    // the card asks for the id, and Apply carries it.
    case "mission.reset": {
      if (!matchesMeshId(ctx.confirmId, instance.config.meshId)) {
        return no(
          m.kind,
          `mission.reset requires the operator to type this mesh's id ("${instance.config.meshId}") before applying — ` +
            `the reason alone is not a confirmation`,
        );
      }
      const report = await instance.reset({});
      return ok(m.kind, report.archivedTo
        ? `mission reset to zero; previous state archived at ${report.archivedTo}. Mesh is parked.`
        : "mission reset to zero; mesh is parked.");
    }

    default: {
      const unknown = m as { kind: string };
      return no(unknown.kind as StagedMutation["kind"], `unknown mutation kind '${unknown.kind}'`);
    }
  }
}

export async function applyStagedProposal(
  mutations: StagedMutation[],
  instance: MeshInstance,
  ctx: ApplyContext = {},
): Promise<StagedApplyReport> {
  const results: StagedApplyResult[] = [];
  for (const m of mutations) {
    const r = await applyStagedMutation(m, instance, ctx);
    results.push(r);
    if (!r.ok) break;
  }
  return { ok: results.every((r) => r.ok), applied: results.filter((r) => r.ok).length, results };
}
