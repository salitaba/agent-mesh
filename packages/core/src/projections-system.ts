import type { MeshEvent, WorkspaceLease } from "../../protocol/src/index";
import type { Projections } from "./state";
import { dischargeCommitment, ensureBudget } from "./state";
import { MAX_CONFLICTS } from "./state";
import { ProjectionError } from "./projections-helpers";

export function applySystemEvent(state: Projections, event: MeshEvent, p: Record<string, any>): boolean {
  switch (event.type) {
    case "lease.acquired": {
      const lease = p.lease as WorkspaceLease;
      const existing = state.activeLeaseByArtifact.get(lease.artifactId);
      if (existing && existing !== lease.id) {
        const e = state.leases.get(existing);
        if (e && !e.releasedAt && e.agentId !== lease.agentId) {
          throw new ProjectionError(
            `artifact ${lease.artifactId} already leased to ${e.agentId} (single-writer invariant)`,
            event.type,
          );
        }
      }
      state.leases.set(lease.id, lease);
      state.activeLeaseByArtifact.set(lease.artifactId, lease.id);
      break;
    }
    case "lease.released": {
      const lease = state.leases.get(p.leaseId);
      if (lease) {
        lease.releasedAt = event.timestamp;
        if (state.activeLeaseByArtifact.get(lease.artifactId) === lease.id) {
          state.activeLeaseByArtifact.delete(lease.artifactId);
        }
      }
      break;
    }
    case "commitment.discharged": {
      // The event-sourced exit from the ledger. Every out-of-band discharge
      // (a superseding artifact version, an operator answer/drop, a deadlock
      // break) now emits this instead of mutating `pendingRequests` directly
      // from the supervisor — those mutations were invisible to replay, so a
      // rebuilt state kept asks the live mesh had already closed and the
      // "replay is equivalent" invariant did not actually hold.
      dischargeCommitment(
        state,
        p.messageId as string,
        (p.reason ?? "operator") as import("./state").DischargeReason,
        (p.by as string) ?? event.actorId ?? "system",
        event.timestamp,
        p.viaMessageId as string | undefined,
      );
      break;
    }
    case "memory.updated": {
      const { agentId, note } = p as { agentId: string; note: import("../../protocol/src/index").AgentMemoryNote };
      const m = state.memory.get(agentId) ?? new Map();
      m.set(note.key, note);
      state.memory.set(agentId, m);
      break;
    }
    case "budget.reserved": {
      const b = ensureBudget(state, p.key, p.limitKind ?? "tokens", p.limit ?? null);
      b.reserved += p.amount ?? 0;
      if (p.reservationId) b.reservations.set(p.reservationId, p.amount ?? 0);
      break;
    }
    case "budget.released": {
      const b = state.budgets.get(p.key);
      if (b) {
        if (p.reservationId) {
          b.reserved -= b.reservations.get(p.reservationId) ?? 0;
          b.reservations.delete(p.reservationId);
        } else {
          b.reserved = Math.max(0, b.reserved - (p.amount ?? 0));
        }
      }
      break;
    }
    case "budget.consumed": {
      const b = ensureBudget(state, p.key, p.limitKind ?? "tokens", p.limit ?? null);
      if (p.reservationId) {
        const res = b.reservations.get(p.reservationId) ?? 0;
        b.reserved = Math.max(0, b.reserved - res);
        b.reservations.delete(p.reservationId);
      }
      b.consumed += p.amount ?? 0;
      // Credit the agent's own running total ONCE per turn. Every turn settles
      // the same spend against three ledgers (agent, mission, thread) and all
      // three events carry `agentId` for attribution — so crediting on each of
      // them billed the agent ~3x. Live symptom: tech-lead showed 72M against
      // a 38M limit while real spend was ~700k, `/metrics` reported 161M
      // total, and agents sat near a ceiling they had not actually reached.
      // The `agent:` ledger is the one that represents this agent's budget;
      // the others are rollups that happen to name their actor.
      const isAgentTokens = p.key?.startsWith("agent:") && p.limitKind !== "events" && p.limitKind !== "wallclock_minutes";
      const ag = p.key?.startsWith("agent:") ? state.agents.get(p.agentId) : undefined;
      if (ag && p.limitKind !== "events" && p.limitKind !== "wallclock_minutes") {
        ag.state.tokensConsumed += p.amount ?? 0;
      }
      // Per-model rollup rides the same "count the agent ledger only" rule as
      // the agent total above, for the same reason: mission and thread events
      // mirror this spend and would treble it.
      if (isAgentTokens && typeof p.model === "string" && p.model) {
        let ms = state.modelSpend.get(p.model);
        if (!ms) {
          ms = { model: p.model, tokens: 0, input: 0, output: 0, cacheRead: 0, turns: 0, agents: new Set() };
          state.modelSpend.set(p.model, ms);
        }
        ms.tokens += p.amount ?? 0;
        ms.input += Number(p.input ?? 0);
        ms.output += Number(p.output ?? 0);
        ms.cacheRead += Number(p.cacheRead ?? 0);
        ms.turns++;
        if (p.agentId) ms.agents.add(String(p.agentId));
      }
      if (b.limit !== null && b.consumed > b.limit) b.exceeded = true;
      break;
    }
    case "budget.exceeded": {
      const b = state.budgets.get(p.key);
      if (b) b.exceeded = true;
      break;
    }
    case "budget.limit_raised": {
      // Operator raised a budget at runtime (escalation flow). Replay-safe:
      // the new limit comes from the event, and `exceeded` is recomputed so
      // a raise above current spend unblocks the mission.
      const b = ensureBudget(state, p.key, p.limitKind ?? "tokens", null);
      if (typeof p.limit === "number") b.limit = p.limit;
      if (b.limit === null || b.consumed <= b.limit) b.exceeded = false;
      break;
    }
    default:
      return false;
  }
  if (state.conflicts.size > MAX_CONFLICTS) {
    const keys = [...state.conflicts.keys()].slice(0, state.conflicts.size - MAX_CONFLICTS);
    for (const k of keys) state.conflicts.delete(k);
  }
  return true;
}
