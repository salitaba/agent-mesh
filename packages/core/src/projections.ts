import type {
  AcceptanceCriterion,
  AgentDefinition,
  Artifact,
  ArtifactRef,
  ArtifactStatus,
  DecisionRecord,
  Escalation,
  Goal,
  MeshEvent,
  MeshMessage,
  Task,
  Thread,
  WorkspaceLease,
  EventType,
} from "../../protocol/src/index";
import {
  LIFECYCLE_TRANSITIONS,
  MACHINE_TRANSITIONS,
  artifactMachineOf,
} from "../../protocol/src/index";
import type { Projections } from "./state";
import { approvalKey, artifactKey, ensureBudget } from "./state";

export class ProjectionError extends Error {
  constructor(message: string, public readonly eventType: EventType) {
    super(message);
    this.name = "ProjectionError";
  }
}

export function applyEvent(state: Projections, event: MeshEvent, config?: { transitionGates: Record<string, string[]> }): void {
  const p = structuredClone((event.payload ?? {}) as Record<string, any>);
  switch (event.type) {
    case "goal.created": {
      const goal = p.goal as Goal;
      state.goals.set(goal.id, goal);
      if (!state.activeGoalId) state.activeGoalId = goal.id;
      state.goalHistory.push({ status: goal.status, at: event.timestamp, reason: "created" });
      break;
    }
    case "goal.status_changed": {
      const goal = state.goals.get(p.goalId);
      if (!goal) throw new ProjectionError(`unknown goal ${p.goalId}`, event.type);
      goal.status = p.status;
      state.goalHistory.push({ status: p.status, at: event.timestamp, reason: p.reason });
      if (p.status === "COMPLETED") goal.completedAt = event.timestamp;
      break;
    }
    case "goal.paused": {
      const goal = state.goals.get(p.goalId ?? state.activeGoalId ?? "");
      if (goal && (goal.status === "ACTIVE" || goal.status === "CONVERGING" || goal.status === "BLOCKED")) {
        goal.status = "PAUSED";
        state.goalHistory.push({ status: "PAUSED", at: event.timestamp, reason: p.reason });
      }
      break;
    }
    case "goal.resumed": {
      const goal = state.goals.get(p.goalId ?? state.activeGoalId ?? "");
      if (goal && goal.status === "PAUSED") {
        goal.status = "ACTIVE";
        state.goalHistory.push({ status: "ACTIVE", at: event.timestamp, reason: p.reason });
      }
      break;
    }
    case "goal.progress": {
      const gid = event.goalId ?? state.activeGoalId;
      if (gid) {
        state.progress.set(gid, {
          completed: p.completed ?? 0,
          total: p.total ?? 0,
          ratio: p.ratio ?? 0,
          updatedAt: event.timestamp,
        });
      }
      break;
    }
    case "goal.completed":
    case "goal.escalated":
    case "goal.failed": {
      const goal = state.goals.get(event.goalId ?? state.activeGoalId ?? "");
      if (goal) {
        const map: Record<string, Goal["status"]> = {
          "goal.completed": "COMPLETED",
          "goal.escalated": "ESCALATED",
          "goal.failed": "FAILED",
        };
        goal.status = map[event.type];
        if (event.type === "goal.completed") goal.completedAt = event.timestamp;
        state.goalHistory.push({ status: goal.status, at: event.timestamp, reason: p.reason });
      }
      break;
    }
    case "requirements.created": {
      const goal = state.goals.get(event.goalId ?? state.activeGoalId ?? "");
      if (goal && Array.isArray(p.criteria)) {
        for (const c of p.criteria as AcceptanceCriterion[]) {
          if (!goal.acceptanceCriteria.find((x) => x.id === c.id)) {
            goal.acceptanceCriteria.push(c);
          }
        }
      }
      break;
    }
    case "requirement.blocked": {
      const goal = state.goals.get(event.goalId ?? state.activeGoalId ?? "");
      if (goal && p.criterionId) {
        const c = goal.acceptanceCriteria.find((x) => x.id === p.criterionId);
        if (c) c.status = "UNSATISFIED";
      }
      break;
    }
    case "requirement.satisfied": {
      const goal = state.goals.get(event.goalId ?? state.activeGoalId ?? "");
      if (goal && p.criterionId) {
        const c = goal.acceptanceCriteria.find((x) => x.id === p.criterionId);
        if (c) {
          c.status = "EVIDENCED";
          if (p.evidence) c.evidence.push(p.evidence);
        }
      }
      break;
    }
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
        rec.state.currentArtifactIds = p.inheritArtifactIds ?? rec.state.currentArtifactIds;
        rec.state.activeTaskId = p.inheritTaskId ?? rec.state.activeTaskId;
      }
      break;
    }
    case "thread.created": {
      const t = p.thread as Thread;
      state.threads.set(t.id, t);
      break;
    }
    case "message.sent": {
      const m = p.message as MeshMessage;
      state.messages.set(m.id, m);
      const thread = state.threads.get(m.threadId);
      if (thread) {
        if (!thread.messageIds.includes(m.id)) thread.messageIds.push(m.id);
        for (const part of [m.from, ...m.to]) {
          if (!thread.participants.includes(part)) thread.participants.push(part);
        }
      }
      for (const target of m.to) {
        if (target === m.from) continue;
        if ((m.payload as Record<string, unknown> | undefined)?.cacheServed === true) continue;
        const box = state.unread.get(target) ?? [];
        box.push(m.id);
        state.unread.set(target, box);
        const rec = state.agents.get(target);
        if (rec) rec.state.mailboxDepth = box.length;
      }
      const isRequest = m.type.startsWith("REQUEST") || m.type === "ESCALATE" || m.type === "CHALLENGE";
      if (isRequest) {
        state.pendingRequests.set(m.id, {
          messageId: m.id,
          from: m.from,
          to: m.to,
          type: m.type,
          threadId: m.threadId,
          taskId: m.taskId,
          createdAt: m.timestamp,
        });
      }
      if (m.replyTo && state.pendingRequests.has(m.replyTo)) {
        state.pendingRequests.delete(m.replyTo);
      }
      if (m.type === "TEST_RESULT" || m.type === "SECURITY_FINDING") {
        const pl = (m.payload ?? {}) as Record<string, unknown>;
        if (pl.result === "PASSED") {
          const subject = (pl.subject as string) ?? (m.type === "TEST_RESULT" ? "quality" : "security");
          recordApproval(
            state,
            {
              subject,
              artifactId: (pl.artifactId as string) ?? undefined,
              artifactRef: m.artifactRefs[0],
              actorId: m.from,
              actorRole: state.agents.get(m.from)?.definition.role ?? "",
            },
            event,
            "pass",
          );
        }
      }
      if (m.type === "BLOCK") {
        const pl = (m.payload ?? {}) as Record<string, unknown>;
        const subject = (pl.subject as string) ?? "quality";
        recordApproval(
          state,
          {
            subject,
            artifactId: (pl.artifactId as string) ?? undefined,
            actorId: m.from,
            actorRole: state.agents.get(m.from)?.definition.role ?? "",
          },
          event,
          "block",
        );
      }
      const fp = fingerprintOf(m);
      const seen = state.messageFingerprints.get(m.threadId) ?? new Set<string>();
      if (seen.has(fp)) {
        const key = `loop:${m.from}:${m.threadId}`;
        bumpConflict(state, key, m.from, event.timestamp, m.threadId, m.artifactRefs[0]?.uri);
      }
      seen.add(fp);
      state.messageFingerprints.set(m.threadId, seen);
      break;
    }
    case "message.delivered": {
      const target = p.agentId as string;
      const mid = p.messageId as string;
      const box = state.unread.get(target) ?? [];
      const idx = box.indexOf(mid);
      if (idx >= 0) box.splice(idx, 1);
      state.unread.set(target, box);
      const rec = state.agents.get(target);
      if (rec) rec.state.mailboxDepth = box.length;
      break;
    }
    case "message.rejected": {
      break;
    }
    case "artifact.created": {
      const a = p.artifact as Artifact;
      state.artifacts.set(a.id, a);
      state.artifactByName.set(artifactKey(a.type, a.name), a);
      const hist = state.artifactHistory.get(a.id) ?? [];
      hist.push(a);
      state.artifactHistory.set(a.id, hist);
      const owner = state.agents.get(a.owner);
      if (owner && !owner.state.currentArtifactIds.includes(a.id)) {
        owner.state.currentArtifactIds.push(a.id);
      }
      break;
    }
    case "artifact.versioned": {
      const a = p.artifact as Artifact;
      state.artifacts.set(a.id, a);
      state.artifactByName.set(artifactKey(a.type, a.name), a);
      const hist = state.artifactHistory.get(a.id) ?? [];
      hist.push(a);
      state.artifactHistory.set(a.id, hist);
      for (const [key, list] of state.approvals) {
        const kept = list.filter((r) => !(r.kind === "block" && r.artifactId === a.id));
        if (kept.length !== list.length) {
          if (kept.length === 0) state.approvals.delete(key);
          else state.approvals.set(key, kept);
        }
      }
      break;
    }
    case "artifact.transition": {
      const a = state.artifacts.get(p.artifactId);
      if (!a) throw new ProjectionError(`unknown artifact ${p.artifactId}`, event.type);
      if (a.status === p.to) break;
      const from = a.status as ArtifactStatus;
      const to = p.to as ArtifactStatus;
      assertArtifactTransition(a.type, from, to, gateSatisfiedWithConfig(state, a, to, p.gateSatisfied !== false, config));
      const next: Artifact = { ...a, status: to };
      state.artifacts.set(a.id, next);
      state.artifactByName.set(artifactKey(next.type, next.name), next);
      const hist = state.artifactHistory.get(a.id) ?? [];
      hist.push(next);
      state.artifactHistory.set(a.id, hist);
      if (to === "UNDER_REVIEW") {
        state.reviewRounds.set(a.id, (state.reviewRounds.get(a.id) ?? 0) + 1);
      }
      if (to === "MERGED") {
        const lease = state.activeLeaseByArtifact.get(a.id);
        if (lease) {
          state.activeLeaseByArtifact.delete(a.id);
          const l = state.leases.get(lease);
          if (l) l.releasedAt = event.timestamp;
        }
      }
      break;
    }
    case "patch.created": {
      break;
    }
    case "patch.ready": {
      const a = p.artifactId ? state.artifacts.get(p.artifactId) : undefined;
      if (a && a.status === "DRAFT") {
        applyEvent(state, {
          ...event,
          type: "artifact.transition",
          payload: { artifactId: a.id, to: "READY_FOR_REVIEW", gateSatisfied: true },
        });
      }
      break;
    }
    case "patch.merged": {
      break;
    }
    case "review.requested": {
      const a = p.artifactId ? state.artifacts.get(p.artifactId) : undefined;
      if (a && a.status === "DRAFT") {
        applyEvent(state, {
          ...event,
          type: "artifact.transition",
          payload: { artifactId: a.id, to: "READY_FOR_REVIEW", gateSatisfied: true },
        });
      }
      const a2 = a ? state.artifacts.get(a.id) : undefined;
      if (a2 && a2.status === "READY_FOR_REVIEW") {
        applyEvent(state, {
          ...event,
          type: "artifact.transition",
          payload: { artifactId: a2.id, to: "UNDER_REVIEW", gateSatisfied: true },
        });
      }
      break;
    }
    case "review.approved": {
      recordApproval(state, p, event, "approve");
      const a = p.artifactId ? state.artifacts.get(p.artifactId) : undefined;
      if (a && (a.status === "UNDER_REVIEW" || a.status === "READY_FOR_REVIEW") && (a.type === "ArchitectureDocument" || a.type === "CodePatch" || a.type === "ApiSpec")) {
        applyEvent(state, {
          ...event,
          type: "artifact.transition",
          payload: { artifactId: a.id, to: "APPROVED", gateSatisfied: true },
        });
      }
      break;
    }
    case "review.rejected": {
      recordApproval(state, p, event, "reject");
      const a = p.artifactId ? state.artifacts.get(p.artifactId) : undefined;
      if (a && a.status === "UNDER_REVIEW") {
        applyEvent(state, {
          ...event,
          type: "artifact.transition",
          payload: { artifactId: a.id, to: "REJECTED", gateSatisfied: true },
        });
      }
      break;
    }
    case "architecture.approved": {
      recordApproval(state, p, event, "approve");
      const a = p.artifactId ? state.artifacts.get(p.artifactId) : undefined;
      if (a && a.status === "UNDER_REVIEW") {
        applyEvent(state, {
          ...event,
          type: "artifact.transition",
          payload: { artifactId: a.id, to: "APPROVED", gateSatisfied: true },
        });
      }
      break;
    }
    case "release.candidate": {
      break;
    }
    case "release.transition": {
      const a = p.artifactId ? state.artifacts.get(p.artifactId) : undefined;
      if (a && p.to && a.status !== p.to) {
        applyEvent(state, {
          ...event,
          type: "artifact.transition",
          payload: { artifactId: a.id, to: p.to, gateSatisfied: p.gateSatisfied !== false },
        }, config);
      }
      break;
    }
    case "release.accepted": {
      recordApproval(state, p, event, "accept");
      break;
    }
    case "implementation.completed": {
      recordApproval(state, p, event, "pass");
      break;
    }
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
    case "human.input": {
      break;
    }
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
      const ag = state.agents.get(p.agentId);
      if (ag && p.limitKind !== "events" && p.limitKind !== "wallclock_minutes") {
        ag.state.tokensConsumed += p.amount ?? 0;
      }
      if (b.limit !== null && b.consumed > b.limit) b.exceeded = true;
      break;
    }
    case "budget.exceeded": {
      const b = state.budgets.get(p.key);
      if (b) b.exceeded = true;
      break;
    }
    default:
      break;
  }

  state.lastEventSeq = event.seq ?? state.lastEventSeq;
  state.lastEventAt = event.timestamp;
  state.eventCount++;
  if (event.actorId) {
    state.eventsSinceActivation.set(event.actorId, (state.eventsSinceActivation.get(event.actorId) ?? 0) + 1);
  }
}

function fingerprintOf(m: MeshMessage): string {
  return `${m.from}->${m.to.join(",")}:${m.type}:${JSON.stringify(m.payload)}:${(m.artifactRefs || []).map((r) => r.uri).join(",")}`;
}

function bumpConflict(
  state: Projections,
  key: string,
  actor: string,
  ts: string,
  threadId?: string,
  artifactId?: string,
): void {
  const existing = state.conflicts.get(key);
  if (existing) {
    existing.count++;
    existing.lastAt = ts;
    existing.lastActor = actor;
  } else {
    state.conflicts.set(key, { key, count: 1, lastActor: actor, firstAt: ts, lastAt: ts, threadId, artifactId });
  }
}

export { bumpConflict };

function recordApproval(
  state: Projections,
  p: Record<string, any>,
  event: MeshEvent,
  kind: string,
): void {
  const subject = p.subject ?? `artifact:${p.artifactId ?? "general"}`;
  const key = approvalKey(subject, kind);
  const list = state.approvals.get(key) ?? [];
  list.push({
    id: `apr-${event.id}`,
    goalId: event.goalId ?? state.activeGoalId ?? "",
    kind: kind as any,
    subject,
    artifactId: p.artifactId,
    artifactRef: p.artifactRef,
    actorId: p.actorId ?? event.actorId ?? "unknown",
    actorRole: p.actorRole ?? "",
    evidenceEventId: event.id,
    recordedAt: event.timestamp,
  });
  state.approvals.set(key, list);
}

export function transitionLifecycle(
  state: Projections,
  st: import("../../protocol/src/index").AgentRuntimeState,
  to: import("../../protocol/src/index").LifecycleState,
  event: MeshEvent,
): void {
  if (st.lifecycle === to) return;
  const allowed = LIFECYCLE_TRANSITIONS[st.lifecycle] ?? [];
  if (!allowed.includes(to)) {
    throw new ProjectionError(
      `illegal lifecycle transition ${st.lifecycle} -> ${to} for ${st.agentId}`,
      event.type,
    );
  }
  st.lifecycle = to;
  st.lastActivityAt = event.timestamp;
}

export function assertArtifactTransition(
  type: import("../../protocol/src/index").ArtifactType,
  from: ArtifactStatus,
  to: ArtifactStatus,
  gateSatisfied: boolean,
): void {
  const machine = artifactMachineOf(type);
  const table = MACHINE_TRANSITIONS[machine];
  const allowed = table[from] ?? [];
  if (!allowed.includes(to)) {
    throw new ProjectionError(
      `illegal artifact transition ${machine}:${from} -> ${to}`,
      "artifact.transition",
    );
  }
  if (!gateSatisfied) {
    throw new ProjectionError(
      `artifact transition ${from} -> ${to} blocked by unsatisfied gate`,
      "artifact.transition",
    );
  }
}

export function hasApproval(state: Projections, subject: string, kind: string, actor?: string): boolean {
  const list = state.approvals.get(approvalKey(subject, kind)) ?? [];
  if (list.length === 0) return false;
  if (!actor) return true;
  return list.some((a) => a.actorId === actor || a.actorRole === actor);
}

export function hasApprovalForArtifact(state: Projections, artifactId: string, kind: string): boolean {
  for (const list of state.approvals.values()) {
    for (const r of list) {
      if (r.kind === kind && r.artifactId === artifactId) return true;
    }
  }
  return false;
}

export function gateForTransition(artifactType: string, to: ArtifactStatus): string {
  if (artifactType === "CodePatch" && to === "MERGED") return "patch.merge";
  if (artifactType === "CodePatch" && to === "APPROVED") return "patch.approve";
  if (artifactType === "ReleasePlan" && to === "ACCEPTED") return "release.accepted";
  if (artifactType === "ReleasePlan" && to === "IMPLEMENTED") return "implementation.completed";
  return `${artifactType}.${to}`;
}

export interface ApprovalToken {
  actor: string;
  kind: string;
}

export function parseGateTokens(requires: string[]): ApprovalToken[] {
  const out: ApprovalToken[] = [];
  for (const token of requires) {
    const idx = token.lastIndexOf(".");
    if (idx <= 0) continue;
    out.push({ actor: token.slice(0, idx), kind: token.slice(idx + 1) });
  }
  return out;
}

export function checkApprovals(
  state: Projections,
  requires: string[],
  artifactId?: string,
): { ok: boolean; missing: string[] } {
  const all: import("../../protocol/src/index").ApprovalRecord[] = [];
  for (const list of state.approvals.values()) all.push(...list);
  const missing: string[] = [];
  for (const { actor, kind } of parseGateTokens(requires)) {
    const relevant = all.filter(
      (r) =>
        (r.actorId === actor || r.actorRole === actor) &&
        (artifactId === undefined || r.artifactId === undefined || r.artifactId === artifactId),
    );
    const satisfiedKind = (r: import("../../protocol/src/index").ApprovalRecord) =>
      r.kind === kind || (kind === "approve" && (r.kind === "accept" || r.kind === "merge")) ||
      (kind === "pass" && (r.kind === "accept" || r.kind === "merge"));
    const approving = relevant.filter(satisfiedKind);
    if (approving.length === 0) {
      missing.push(`${actor}.${kind}`);
      continue;
    }
    const latest = approving.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0];
    const laterBlock = relevant.find(
      (r) => r.kind === "block" && r.recordedAt > latest.recordedAt,
    );
    if (laterBlock) missing.push(`${actor}.${kind} (superseded by ${actor}.block)`);
  }
  return { ok: missing.length === 0, missing };
}

function gateSatisfiedWithConfig(
  state: Projections,
  artifact: Artifact,
  to: ArtifactStatus,
  callerSatisfied: boolean,
  config?: { transitionGates: Record<string, string[]> },
): boolean {
  if (!callerSatisfied) return false;
  const gateName = gateForTransition(artifact.type, to);
  const requires = config?.transitionGates?.[gateName];
  if (requires && requires.length > 0) {
    const missionLevel = gateName === "implementation.completed" || gateName === "release.accepted";
    const res = checkApprovals(state, requires, missionLevel ? undefined : artifact.id);
    if (!res.ok) return false;
  }
  if (to === "APPROVED" && !hasApprovalForArtifact(state, artifact.id, "approve")) {
    return false;
  }
  if (to === "MERGED" && hasApprovalForArtifact(state, artifact.id, "block")) {
    const blocks = [...state.approvals.values()].flat().filter((r) => r.kind === "block" && r.artifactId === artifact.id);
    const approves = [...state.approvals.values()].flat().filter(
      (r) => (r.kind === "approve" || r.kind === "pass") && r.artifactId === artifact.id,
    );
    const latestBlock = blocks.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0];
    const latestApprove = approves.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0];
    if (latestBlock && (!latestApprove || latestBlock.recordedAt > latestApprove.recordedAt)) return false;
  }
  return true;
}

export function isTerminalGoal(status: Goal["status"]): boolean {
  return status === "COMPLETED" || status === "FAILED";
}
