import type { GoalId } from "../../protocol/src/index";
import type { ResolvedMeshConfig } from "../../config/src/index";
import type { Projections } from "./state";
import { outstandingDebtors } from "./state";
import { agentKey, missionKey, taskKey, threadKey } from "./budgets";

export interface DeadlockFinding {
  kind: "thread_depth" | "repeated_conflict" | "review_rounds" | "idle_stall" | "fingerprint_loop" | "wait_cycle";
  goalId: GoalId;
  conflictKey: string;
  threadId?: string;
  artifactId?: string;
  description: string;
  participants: string[];
}

/**
 * The human seat is not an automaton: it never "waits" on anything, so an
 * edge through it can never close a deadlock cycle. Kept local (importing
 * HUMAN_AGENT_ID from supervisor.ts would close an import cycle).
 */
const HUMAN_ID = "human";

/** Lifecycles that mean "this agent cannot proceed on its own". */
const STUCK_LIFECYCLES = new Set(["WAITING", "BLOCKED"]);

export class DeadlockDetector {
  /**
   * conflictKey -> goalId of the finding we already escalated.
   *
   * Keyed by conflictKey (NOT `${goalId}:${conflictKey}`) because that is the
   * identity the supervisor dedupes escalations on; the goalId rides along so
   * `clear(goalId)` can actually find its entries. The previous version keyed
   * by conflictKey alone and cleared with `key.endsWith(goalId)` — but real
   * keys are `depth:<threadId>` / `loop:<agent>:<threadId>` /
   * `review_rounds:<artifactId>`, none of which contain a goalId. So `clear()`
   * matched nothing, the set grew forever, and a deadlock that was resolved
   * could never escalate again for the lifetime of the process.
   */
  private reported = new Map<string, GoalId>();

  constructor(private config: ResolvedMeshConfig) {}

  scan(state: Projections): DeadlockFinding[] {
    const goalId = state.activeGoalId;
    if (!goalId) return [];
    const goal = state.goals.get(goalId);
    if (!goal || goal.status === "COMPLETED" || goal.status === "FAILED" || goal.status === "PAUSED") return [];

    const findings: DeadlockFinding[] = [
      ...this.scanThreadDepth(state, goalId),
      ...this.scanConflicts(state, goalId),
      ...this.scanReviewRounds(state, goalId),
      ...this.scanWaitCycles(state, goalId),
    ];

    // Self-healing: a condition that no longer holds must be forgotten, or a
    // recurrence after a genuine fix stays invisible forever. Scoped to this
    // goal so a previous mission's memory is untouched.
    const live = new Set(findings.map((f) => f.conflictKey));
    for (const [key, gid] of [...this.reported]) {
      if (gid === goalId && !live.has(key)) this.reported.delete(key);
    }

    return findings.filter((f) => !this.reported.has(f.conflictKey));
  }

  private scanThreadDepth(state: Projections, goalId: GoalId): DeadlockFinding[] {
    const out: DeadlockFinding[] = [];
    for (const thread of state.threads.values()) {
      if (thread.status !== "OPEN") continue;
      if (thread.depth > this.config.escalation.threadMaxDepth) {
        out.push({
          kind: "thread_depth",
          goalId,
          conflictKey: `depth:${thread.id}`,
          threadId: thread.id,
          description: `Thread ${thread.id} exceeded max depth ${this.config.escalation.threadMaxDepth} (depth ${thread.depth})`,
          participants: thread.participants,
        });
      }
    }
    return out;
  }

  private scanConflicts(state: Projections, goalId: GoalId): DeadlockFinding[] {
    const out: DeadlockFinding[] = [];
    for (const conflict of state.conflicts.values()) {
      if (conflict.count < this.config.escalation.repeatedConflictThreshold) continue;
      if (this.alreadyEscalated(state, goalId, conflict.key, conflict.lastAt)) continue;
      // `loop:<agent>:<thread>` counters come from the duplicate-message
      // fingerprint check, which is a different failure (an agent repeating
      // itself verbatim) than two agents disagreeing. Labelling it as such
      // makes the escalation card actionable, and finally produces the
      // `fingerprint_loop` kind the type has always declared.
      const isFingerprintLoop = conflict.key.startsWith("loop:");
      out.push({
        kind: isFingerprintLoop ? "fingerprint_loop" : "repeated_conflict",
        goalId,
        conflictKey: conflict.key,
        threadId: conflict.threadId,
        artifactId: conflict.artifactId,
        description: isFingerprintLoop
          ? `${conflict.lastActor} re-sent an identical message ${conflict.count} times in thread ${conflict.threadId ?? "?"} — it is looping, not progressing`
          : `Repeated conflict '${conflict.key}' reached threshold (${conflict.count} >= ${this.config.escalation.repeatedConflictThreshold})`,
        participants: [conflict.lastActor],
      });
    }
    return out;
  }

  private alreadyEscalated(state: Projections, goalId: GoalId, conflictKey: string, lastAt: string): boolean {
    for (const esc of state.escalations.values()) {
      if (esc.goalId === goalId && esc.conflictKey === conflictKey && esc.createdAt >= lastAt) return true;
    }
    return false;
  }

  private scanReviewRounds(state: Projections, goalId: GoalId): DeadlockFinding[] {
    const out: DeadlockFinding[] = [];
    for (const [artifactId, rounds] of state.reviewRounds) {
      if (rounds < this.config.escalation.artifactReviewRoundsMax) continue;
      const artifact = state.artifacts.get(artifactId);
      out.push({
        kind: "review_rounds",
        goalId,
        conflictKey: `review_rounds:${artifactId}`,
        artifactId,
        description: `Artifact ${artifact?.name ?? artifactId} exceeded ${this.config.escalation.artifactReviewRoundsMax} review rounds`,
        participants: artifact ? [artifact.owner] : [],
      });
    }
    return out;
  }

  /**
   * Exact deadlock detection over the wait-for graph.
   *
   * Every other check here is a *proxy* for being stuck (thread got deep,
   * conflicts repeated, reviews churned) and only fires after a threshold of
   * wasted turns. A cycle in the wait-for graph is not a proxy: if A is
   * WAITING on B and B is WAITING on A, no future turn can ever resolve
   * either, and that is provable the instant the second request lands.
   *
   * Without this the runtime only noticed via the scheduler's nudge path:
   * MAX_NUDGES (3) x waitWakeupMs (60s by default) = three full model turns
   * and three minutes of wall clock burned per stuck agent, to reach a
   * conclusion available in O(V+E).
   *
   * An edge A->B exists only when A is actually parked (WAITING/BLOCKED) on
   * an open request addressed to B. An outstanding request from a still-
   * working agent is normal business, not a deadlock.
   */
  private scanWaitCycles(state: Projections, goalId: GoalId): DeadlockFinding[] {
    const waitsOn = new Map<string, Set<string>>();
    for (const pr of state.pendingRequests.values()) {
      if (pr.goalId && pr.goalId !== goalId) continue;
      const from = pr.from;
      if (from === HUMAN_ID) continue;
      const rec = state.agents.get(from);
      if (!rec || !STUCK_LIFECYCLES.has(rec.state.lifecycle)) continue;
      const edges = waitsOn.get(from) ?? new Set<string>();
      for (const target of outstandingDebtors(pr)) {
        if (target === from || target === HUMAN_ID) continue;
        if (!state.agents.has(target)) continue;
        edges.add(target);
      }
      if (edges.size > 0) waitsOn.set(from, edges);
    }
    if (waitsOn.size === 0) return [];

    // Iterative three-colour DFS (no recursion: cycle payloads are operator
    // facing and the graph is agent-sized, but a stack overflow inside the
    // watchdog would take the mesh down).
    const WHITE = 0;
    const GREY = 1;
    const BLACK = 2;
    const colour = new Map<string, number>();
    const path: string[] = [];
    const onPath = new Set<string>();
    const cycles = new Map<string, string[]>();

    const record = (cycle: string[]): void => {
      const key = [...cycle].sort().join(">");
      if (!cycles.has(key)) cycles.set(key, cycle);
    };

    for (const root of waitsOn.keys()) {
      if ((colour.get(root) ?? WHITE) !== WHITE) continue;
      const stack: Array<{ node: string; next: string[]; i: number }> = [
        { node: root, next: [...(waitsOn.get(root) ?? [])], i: 0 },
      ];
      colour.set(root, GREY);
      path.push(root);
      onPath.add(root);
      while (stack.length > 0) {
        const frame = stack[stack.length - 1];
        if (frame.i >= frame.next.length) {
          colour.set(frame.node, BLACK);
          onPath.delete(frame.node);
          path.pop();
          stack.pop();
          continue;
        }
        const neighbour = frame.next[frame.i++];
        if (onPath.has(neighbour)) {
          record(path.slice(path.indexOf(neighbour)));
          continue;
        }
        if ((colour.get(neighbour) ?? WHITE) !== WHITE) continue;
        colour.set(neighbour, GREY);
        path.push(neighbour);
        onPath.add(neighbour);
        stack.push({ node: neighbour, next: [...(waitsOn.get(neighbour) ?? [])], i: 0 });
      }
    }

    const out: DeadlockFinding[] = [];
    for (const [key, cycle] of cycles) {
      out.push({
        kind: "wait_cycle",
        goalId,
        conflictKey: `wait_cycle:${key}`,
        description:
          cycle.length === 1
            ? `${cycle[0]} is waiting on a request addressed to itself — no turn can ever resolve it`
            : `Circular wait detected: ${cycle.join(" waits on ")} waits on ${cycle[0]}. No agent in this cycle can proceed without an outside decision.`,
        participants: cycle,
      });
    }
    return out;
  }

  markReported(finding: DeadlockFinding): void {
    this.reported.set(finding.conflictKey, finding.goalId);
  }

  clear(goalId: GoalId): void {
    for (const [key, gid] of [...this.reported]) {
      if (gid === goalId) this.reported.delete(key);
    }
  }
}

export interface TerminationInputs {
  state: Projections;
  config: ResolvedMeshConfig;
  wallClockMs: number;
}

/**
 * Whose open escalations count as evidence that the mission is deadlocked.
 * Single source of truth: both the trigger and the supporting-set query read
 * this, so a card can never claim a stalemate it cannot enumerate.
 */
export const STALEMATE_RAISERS = ["deadlock-detector", "recovery-manager"];

export type TerminationVerdict =
  | { kind: "continue" }
  | { kind: "complete"; reason: string; evidenceSummary: string[] }
  /**
   * `supports` is set only for derived verdicts (stalemate): the ids of the
   * open primary escalations that justify it. Absent means "this verdict
   * stands on its own" (budget, wall-clock, runtime failure).
   */
  | { kind: "escalate"; reason: string; detail: unknown; supports?: string[] }
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
    // An exhausted THREAD budget blocks every future turn in that thread, but
    // nothing else notices: the agents involved simply stop being activated
    // and the mission looks idle with no card to answer. Only escalate when
    // the stall is total — an exhausted thread while other work continues is
    // normal and self-correcting (agents open a fresh thread).
    const deadThreads = [...state.budgets.values()].filter((b) => b.exceeded && b.key.startsWith(`thread:${goalId}`));
    if (deadThreads.length > 0) {
      const liveThread = [...state.threads.values()].some((t) => {
        if (t.status !== "OPEN") return false;
        const ledger = state.budgets.get(threadKey(goalId, t.id));
        return !ledger || !ledger.exceeded;
      });
      const busy = [...state.agents.values()].some((a) => !["IDLE", "WAITING", "DONE", "FAILED"].includes(a.state.lifecycle));
      if (!liveThread && !busy) {
        return {
          kind: "escalate",
          reason: "thread_budgets_exhausted",
          detail: {
            threads: deadThreads.slice(0, 10).map((b) => ({ key: b.key, consumed: b.consumed, limit: b.limit })),
            exhaustedThreads: deadThreads.length,
          },
        };
      }
    }
    // Mission caps live on the goal (boot seeds them from config; operator
    // raises via goal.budget_changed persist in the log and survive restart).
    const maxEvents = goal.budget?.maxEvents ?? config.budgets.mission.maxEvents;
    if (state.eventCount > maxEvents) {
      return {
        kind: "escalate",
        reason: "max_events_exceeded",
        detail: { events: state.eventCount, limit: maxEvents },
      };
    }
    const wallMinutes = goal.budget?.wallClockMinutes ?? config.budgets.mission.wallClockMinutes;
    if (wallClockMs > wallMinutes * 60_000) {
      return {
        kind: "escalate",
        reason: "wall_clock_exceeded",
        detail: { wallClockMs, limitMs: wallMinutes * 60_000 },
      };
    }

    const mandatory = goal.acceptanceCriteria.filter((c) => c.mandatory);
    // Evidence must belong to the CURRENT round. A reopen resets criteria to
    // UNSATISFIED but keeps the evidence trail, so an agent re-approving on the
    // strength of the rejected round (ref-less `approval` / `*-pass` evidence
    // carries no artifact URI, so the identity gate in `markCriterionEvidence`
    // cannot see it) would re-complete the mission unchanged. One live mission
    // ran 6 completes / 5 reopens this way, re-approving the same architecture
    // six times and delivering nothing new.
    const satisfied = (c: (typeof mandatory)[number]): boolean => {
      if (c.status === "WAIVED") return true;
      // ASSERTED falls through here deliberately: an agent claiming a
      // criterion from a turn that invoked no verification tool has not
      // proven it, and an unproven mission must stay open. See
      // CriterionStatus in the protocol types.
      if (c.status !== "EVIDENCED") return false;
      if (!goal.reopenedAt) return true;
      return c.evidence.some((e) => e.recordedAt > goal.reopenedAt!);
    };
    if (mandatory.length > 0 && mandatory.every(satisfied)) {
      const openEscalations = [...state.escalations.values()].filter((e) => e.status === "OPEN");
      // Only work SOMEONE OWNS can hold a finished mission open.
      //
      // This used to block on any OPEN task too, which turned routine
      // bookkeeping into a permanent deadlock: agents post OPEN tasks as
      // intent ("implement the MVP"), satisfy the underlying criterion by
      // other means, and never claim the ticket. One live run ended with 5/5
      // criteria EVIDENCED and 7 unclaimed OPEN tasks, so the goal could never
      // reach COMPLETED — and the stall watchdog nudged agents forever on a
      // mission that was already done, burning 51% of its budget on turns that
      // wrote nothing. An unclaimed task with every criterion evidenced is
      // residue, not work; a CLAIMED task has an owner who may still be
      // mid-flight and is still worth waiting for.
      //
      // But ONLY while the owner is really on it. The same residue reappears
      // one level down: `activeTaskId` tracks just the LAST task an agent
      // claimed, and `task.completed` clears it only when the ids match. An
      // agent that claims X, then claims Y, then completes Y leaves X CLAIMED
      // forever with nobody holding it. One live run had 16/16 criteria
      // evidenced, zero open escalations, and still could not reach COMPLETED
      // because of exactly one such abandoned ticket — so the stall watchdog
      // nudged an already-finished mission for 90 minutes (27 turns that wrote
      // nothing, ~5k tokens each).
      //
      // The runtime's own pointer is the truth: a claim is live iff the
      // claiming agent still exists and its `activeTaskId` is this task.
      // A claim whose owner is gone, or who has moved on to another task, is
      // residue — the same as an unclaimed OPEN ticket.
      const ownedTasks = [...state.tasks.values()].filter((t) => {
        if (t.status !== "CLAIMED" || t.id.startsWith("watch:")) return false;
        const owner = t.claimedBy ? state.agents.get(t.claimedBy) : undefined;
        return owner?.state.activeTaskId === t.id;
      });
      if (openEscalations.length === 0 && ownedTasks.length === 0) {
        return {
          kind: "complete",
          reason: "all_mandatory_criteria_evidenced",
          evidenceSummary: mandatory.flatMap((c) => c.evidence.map((e) => `${c.id}:${e.kind}:${e.eventId ?? e.artifactRef?.uri ?? "manual"}`)),
        };
      }
    }

    // Restartable FAILED agents are excluded: the supervisor owns their retry
    // (scheduled milliseconds after the failure), and a watchdog tick landing
    // in that window must not freeze the goal over a recoverable blip. Only a
    // terminally-failed agent — one that will never run again — can end the
    // mission, and even then only if work is actually stranded on it.
    const failedRequired = [...state.agents.values()].filter(
      (a) => a.state.lifecycle === "FAILED" && a.state.restartable !== true,
    );
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

    // Stalemate must be scoped to the active goal: a stale OPEN escalation
    // from a previous mission (or a previous goal in the same log) must not
    // immediately escalate a brand-new goal on boot.
    //
    // The supporting set and the trigger MUST be the same query. They used to
    // differ (trigger accepted `recovery-manager`, the detail list collected
    // only `deadlock-detector`), which produced a "Stalemate (0 waiting)" card
    // that listed nothing, supported nothing, and could not be reconciled —
    // an escalation the operator had no way to act on.
    // Advisory cards never count: they record a loss the mesh already routed
    // around (dead debtor's asks discharged with notice). Counting them here
    // froze the whole goal behind a card that needs no urgent answer — one
    // dead agent parked every live one.
    const supporting = [...state.escalations.values()].filter(
      (e) => e.status === "OPEN" && e.goalId === goalId && !e.advisory && STALEMATE_RAISERS.includes(e.raisedBy),
    );
    if (supporting.length > 0) {
      return {
        kind: "escalate",
        reason: "stalemate",
        supports: supporting.map((e) => e.id),
        detail: { openDeadlockEscalations: supporting.map((e) => ({ id: e.id, conflictKey: e.conflictKey, reason: e.reason })) },
      };
    }

    return { kind: "continue" };
  }
}

export { agentKey, taskKey, threadKey };
