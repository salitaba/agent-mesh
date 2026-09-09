import type { MeshEvent } from "../../protocol/src/index";
import type { Projections } from "./state";
import type { DecisionRecord, Escalation, Task, ArtifactRef } from "../../protocol/src/index";
import { ProjectionError, clearPendingForTask } from "./projections-helpers";

export function applyWorkEvent(state: Projections, event: MeshEvent, p: Record<string, any>): boolean {
  switch (event.type) {
    case "task.created": {
      const t = p.task as Task;
      state.tasks.set(t.id, t);
      break;
    }
    case "task.claimed": {
      const t = state.tasks.get(p.taskId);
      if (t) {
        if (p.agentId === null) {
          t.status = "OPEN";
          t.claimedBy = undefined;
          break;
        }
        if (t.status !== "OPEN" && !p.reassign) {
          throw new ProjectionError(`task ${t.id} is already ${t.status}`, event.type);
        }
        t.status = "CLAIMED";
        t.claimedBy = p.agentId;
        t.assignedTo = p.agentId;
        const rec = state.agents.get(p.agentId);
        if (rec) rec.state.activeTaskId = t.id;
      }
      break;
    }
    case "task.completed": {
      const t = state.tasks.get(p.taskId);
      if (t) {
        t.status = "COMPLETED";
        t.completedAt = event.timestamp;
        const rec = state.agents.get(p.agentId ?? t.claimedBy ?? "");
        if (rec && rec.state.activeTaskId === t.id) rec.state.activeTaskId = undefined;
      }
      if (p.taskId) clearPendingForTask(state, p.taskId);
      break;
    }
    case "decision.proposed": {
      const d = p.decision as DecisionRecord;
      state.decisions.set(d.id, d);
      break;
    }
    case "decision.ratified": {
      const d = state.decisions.get(p.decisionId);
      if (d) {
        d.status = "RATIFIED";
        d.ratifiedAt = event.timestamp;
        if (p.approvedBy) d.approvedBy = Array.from(new Set([...d.approvedBy, ...p.approvedBy]));
        if (p.evidence) d.evidence = Array.from(new Set([...d.evidence, ...(p.evidence as ArtifactRef[])]));
      }
      break;
    }
    case "escalation.requested": {
      const e = p.escalation as Escalation;
      state.escalations.set(e.id, e);
      break;
    }
    case "escalation.responded": {
      const e = state.escalations.get(p.escalationId);
      if (e) {
        e.status = "RESPONDED";
        e.response = p.response;
        e.respondedAt = event.timestamp;
      }
      break;
    }
    // A derived card whose supporting primaries all closed. The runtime
    // retires it on its own: no human decided it, so it must NOT be recorded
    // as RESPONDED (that would fake an operator decision in the audit trail).
    case "escalation.auto_resolved": {
      const e = state.escalations.get(p.escalationId);
      if (e && e.status === "OPEN") {
        e.status = "AUTO_RESOLVED";
        e.response = p.reason;
        e.respondedAt = event.timestamp;
      }
      break;
    }
    case "human.input": {
      break;
    }
    default:
      return false;
  }
  return true;
}
