import type { GoalId } from "../../protocol/src/index";
import type { ResolvedMeshConfig } from "../../config/src/index";
import type { Projections } from "./state";
import { agentKey, missionKey, taskKey, threadKey } from "./budgets";

export interface DeadlockFinding {
  kind: "thread_depth" | "repeated_conflict" | "review_rounds" | "idle_stall" | "fingerprint_loop";
  goalId: GoalId;
  conflictKey: string;
  threadId?: string;
  artifactId?: string;
  description: string;
  participants: string[];
}

export class DeadlockDetector {
  private reported = new Set<string>();

  constructor(private config: ResolvedMeshConfig) {}

  scan(state: Projections): DeadlockFinding[] {
    const findings: DeadlockFinding[] = [];
    const goalId = state.activeGoalId;
    if (!goalId) return findings;
    const goal = state.goals.get(goalId);
    if (!goal || goal.status === "COMPLETED" || goal.status === "FAILED" || goal.status === "PAUSED") return findings;

    for (const thread of state.threads.values()) {
      if (thread.status !== "OPEN") continue;
      if (thread.depth > this.config.escalation.threadMaxDepth) {
        findings.push({
          kind: "thread_depth",
          goalId,
          conflictKey: `depth:${thread.id}`,
          threadId: thread.id,
          description: `Thread ${thread.id} exceeded max depth ${this.config.escalation.threadMaxDepth} (depth ${thread.depth})`,
          participants: thread.participants,
        });
      }
    }

    for (const conflict of state.conflicts.values()) {
      if (conflict.count >= this.config.escalation.repeatedConflictThreshold) {
        findings.push({
          kind: "repeated_conflict",
          goalId,
          conflictKey: conflict.key,
          threadId: conflict.threadId,
          artifactId: conflict.artifactId,
          description: `Repeated conflict '${conflict.key}' reached threshold (${conflict.count} >= ${this.config.escalation.repeatedConflictThreshold})`,
          participants: [conflict.lastActor],
        });
      }
    }

    for (const [artifactId, rounds] of state.reviewRounds) {
      if (rounds >= this.config.escalation.artifactReviewRoundsMax) {
        const artifact = state.artifacts.get(artifactId);
        findings.push({
          kind: "review_rounds",
          goalId,
          conflictKey: `review_rounds:${artifactId}`,
          artifactId,
          description: `Artifact ${artifact?.name ?? artifactId} exceeded ${this.config.escalation.artifactReviewRoundsMax} review rounds`,
          participants: artifact ? [artifact.owner] : [],
        });
      }
    }

    return findings.filter((f) => !this.reported.has(f.conflictKey));
  }

  markReported(finding: DeadlockFinding): void {
    this.reported.add(finding.conflictKey);
  }

  clear(goalId: GoalId): void {
    for (const key of [...this.reported]) {
      if (key.endsWith(goalId)) this.reported.delete(key);
    }
  }
}

export interface TerminationInputs {
  state: Projections;
  config: ResolvedMeshConfig;
  wallClockMs: number;
}

export type TerminationVerdict =
  | { kind: "continue" }
  | { kind: "complete"; reason: string; evidenceSummary: string[] }
  | { kind: "escalate"; reason: string; detail: unknown }
  | { kind: "fail"; reason: string };

export class TerminationManager {
  evaluate(input: TerminationInputs): TerminationVerdict {
    const { state, config, wallClockMs } = input;
    const goalId = state.activeGoalId;
    if (!goalId) return { kind: "continue" };
    const goal = state.goals.get(goalId);
    if (!goal) return { kind: "continue" };
    if (goal.status === "COMPLETED" || goal.status === "FAILED" || goal.status === "ESCALATED") {
      return { kind: "continue" };
    }

    const missionTokens = state.budgets.get(missionKey(goalId));
    if (missionTokens && missionTokens.limit !== null && missionTokens.consumed > missionTokens.limit) {
      return {
        kind: "escalate",
        reason: "budget_exhausted",
        detail: { key: missionTokens.key, consumed: missionTokens.consumed, limit: missionTokens.limit },
      };
    }
    for (const b of state.budgets.values()) {
      if (b.exceeded && b.key.startsWith(`agent:${goalId}`)) {
        return { kind: "escalate", reason: "agent_budget_exhausted", detail: { key: b.key, consumed: b.consumed, limit: b.limit } };
      }
    }
    if (state.eventCount > config.budgets.mission.maxEvents) {
      return {
        kind: "escalate",
        reason: "max_events_exceeded",
        detail: { events: state.eventCount, limit: config.budgets.mission.maxEvents },
      };
    }
    if (wallClockMs > config.budgets.mission.wallClockMinutes * 60_000) {
      return {
        kind: "escalate",
        reason: "wall_clock_exceeded",
        detail: { wallClockMs, limitMs: config.budgets.mission.wallClockMinutes * 60_000 },
      };
    }

    const mandatory = goal.acceptanceCriteria.filter((c) => c.mandatory);
    if (mandatory.length > 0 && mandatory.every((c) => c.status === "EVIDENCED" || c.status === "WAIVED")) {
      const openEscalations = [...state.escalations.values()].filter((e) => e.status === "OPEN");
      const openTasks = [...state.tasks.values()].filter(
        (t) => (t.status === "OPEN" || t.status === "CLAIMED") && !t.id.startsWith("watch:"),
      );
      if (openEscalations.length === 0 && openTasks.length === 0) {
        return {
          kind: "complete",
          reason: "all_mandatory_criteria_evidenced",
          evidenceSummary: mandatory.flatMap((c) => c.evidence.map((e) => `${c.id}:${e.kind}:${e.eventId ?? e.artifactRef?.uri ?? "manual"}`)),
        };
      }
    }

    const failedRequired = [...state.agents.values()].filter((a) => a.state.lifecycle === "FAILED");
    if (failedRequired.length > 0) {
      const hasOpenWork = [...state.tasks.values()].some((t) => t.status === "OPEN" || t.status === "CLAIMED");
      const pending = [...state.pendingRequests.values()].length;
      if (hasOpenWork || pending > 0) {
        return {
          kind: "escalate",
          reason: "runtime_failure",
          detail: { failedAgents: failedRequired.map((a) => a.state.agentId) },
        };
      }
    }

    const stalemate = [...state.escalations.values()].some(
      (e) => e.status === "OPEN" && ["deadlock-detector", "recovery-manager"].includes(e.raisedBy),
    );
    if (stalemate) {
      const open = [...state.escalations.values()].filter((e) => e.status === "OPEN" && e.raisedBy === "deadlock-detector");
      return {
        kind: "escalate",
        reason: "stalemate",
        detail: { openDeadlockEscalations: open.map((e) => ({ id: e.id, conflictKey: e.conflictKey, reason: e.reason })) },
      };
    }

    return { kind: "continue" };
  }
}

export { agentKey, taskKey, threadKey };
