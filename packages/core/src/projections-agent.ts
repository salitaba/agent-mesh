import type { MeshEvent } from "../../protocol/src/index";
import type { Projections } from "./state";
import type { AgentDefinition } from "../../protocol/src/index";
import { ProjectionError, transitionLifecycle } from "./projections-helpers";

export function applyAgentEvent(state: Projections, event: MeshEvent, p: Record<string, any>): boolean {
  switch (event.type) {
    case "agent.created": {
      const def = p.agent as AgentDefinition;
      state.agents.set(def.id, {
        definition: def,
        state: {
          agentId: def.id,
          lifecycle: "STARTING",
          mailboxDepth: 0,
          currentArtifactIds: [],
          tokensConsumed: 0,
          activations: 0,
          lastActivityAt: event.timestamp,
        },
      });
      break;
    }
    case "agent.started": {
      const rec = state.agents.get(p.agentId);
      if (rec) transitionLifecycle(state, rec.state, "IDLE", event);
      break;
    }
    case "agent.awakened": {
      const rec = state.agents.get(p.agentId);
      if (rec) {
        transitionLifecycle(state, rec.state, "AWAKENED", event);
        rec.state.activations++;
        rec.state.lastActivityAt = event.timestamp;
        state.eventsSinceActivation.set(p.agentId, 0);
      }
      break;
    }
    case "agent.state_changed": {
      const rec = state.agents.get(p.agentId);
      if (rec) transitionLifecycle(state, rec.state, p.to, event);
      break;
    }
    case "agent.suspended": {
      const rec = state.agents.get(p.agentId);
      if (rec) transitionLifecycle(state, rec.state, "SUSPENDED", event);
      break;
    }
    case "agent.resumed": {
      const rec = state.agents.get(p.agentId);
      if (rec) transitionLifecycle(state, rec.state, "IDLE", event);
      break;
    }
    case "agent.completed": {
      const rec = state.agents.get(p.agentId);
      if (rec) transitionLifecycle(state, rec.state, "COMPLETED", event);
      break;
    }
    case "agent.failed": {
      const rec = state.agents.get(p.agentId);
      if (rec) {
        transitionLifecycle(state, rec.state, "FAILED", event);
        rec.state.lastError = p.error;
        if (typeof p.restartable === "boolean") rec.state.restartable = p.restartable;
        if (p.sessionId === null) rec.state.sessionId = undefined;
      }
      break;
    }
    case "agent.restarted": {
      const rec = state.agents.get(p.agentId);
      if (rec) {
        if (rec.state.lifecycle === "FAILED") transitionLifecycle(state, rec.state, "STARTING", event);
        rec.state.sessionId = p.sessionId ?? rec.state.sessionId;
        rec.state.lastError = undefined;
      }
      break;
    }
    case "agent.replaced": {
      const rec = state.agents.get(p.agentId);
      if (rec) {
        if (p.agent) rec.definition = p.agent as AgentDefinition;
        rec.state.currentArtifactIds = p.inheritArtifactIds ?? rec.state.currentArtifactIds;
        rec.state.activeTaskId = p.inheritTaskId ?? rec.state.activeTaskId;
      }
      break;
    }
    default:
      return false;
  }
  return true;
}
