import type { MeshEvent } from "../../protocol/src/index";
import { normalizeCapability } from "../../protocol/src/index";
import type { Projections } from "./state";
import { dischargeCommitment } from "./state";
import type { DecisionRecord, Escalation, Task, ArtifactRef } from "../../protocol/src/index";
import { ProjectionError, clearPendingForTask, holdsAuthority, unmetTaskDependencies } from "./projections-helpers";

/**
 * The reducers below restate the preconditions `Supervisor.claimTask`,
 * `completeTask`, `respondEscalation` and `ratifyDecision` check before they
 * emit. The supervisor is the path an agent goes through; these are the path
 * EVERY event goes through -- a raw `kernel.emit`, and every replay -- and an
 * event the supervisor would never have emitted must not project as if it had.
 *
 * They run on a LIVE emit only (`ApplyOptions` in projections.ts). A log
 * written by older code may hold events they refuse, and a restart must still
 * boot it; replay applies what was logged. The pointer bookkeeping below is not
 * a guard and runs on replay too -- it makes an old log project correctly.
 *
 * Every refusal comes BEFORE the reducer's first write. The kernel rolls a
 * refused event back regardless, but a reducer that refuses first is one whose
 * refusal costs nothing.
 *
 * Only what projections can see is restated. The policy engine's configured
 * rules (`rules:` deny lists, escalate rules) are config, not state, so they
 * stay supervisor-only; the registry-level checks -- does the seat hold the
 * capability, the authority -- are restated from the definition the log
 * recorded. An actor this projection does not know passes, the same as
 * `approverMayAdvance`: a hand-built or pre-registration log must still replay.
 */
const HUMAN = "human";

/** Drop `agentId`'s active-task pointer if, and only if, it points at `taskId`. */
function releasePointer(state: Projections, agentId: string | undefined, taskId: string): void {
  const rec = agentId ? state.agents.get(agentId) : undefined;
  if (rec && rec.state.activeTaskId === taskId) rec.state.activeTaskId = undefined;
}

export function applyWorkEvent(state: Projections, event: MeshEvent, p: Record<string, any>, opts: { live?: boolean } = {}): boolean {
  const live = opts.live === true;
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
          // A release. Emitted by the terminal-failure path for the failed
          // seat's active task, which is a task it holds -- so a release of
          // anything not held (a COMPLETED task above all) would reopen work
          // that is done.
          if (live && t.status !== "CLAIMED" && t.status !== "IN_PROGRESS") {
            throw new ProjectionError(`task ${t.id} is ${t.status}; only a held task can be released`, event.type);
          }
          // The holder lets go of it too. Reopening the task while its holder's
          // `activeTaskId` still named it left two seats sharing one task as
          // soon as anyone claimed it again.
          releasePointer(state, t.claimedBy, t.id);
          t.status = "OPEN";
          t.claimedBy = undefined;
          break;
        }
        // `reassign` no longer waives this. No supervisor path emits it on a
        // task that is not OPEN (`claimTask` refuses a non-OPEN task not
        // assigned to the claimant first), so the waiver only ever served a raw
        // emit taking a task out from under its claimer.
        //
        // Stricter than `claimTask`, which lets the ASSIGNEE re-claim a
        // non-OPEN task. That branch has never reached the log: this reducer
        // has always refused it, and a re-claim of a COMPLETED task would
        // reopen finished work.
        //
        // Replay keeps the old rule, waiver included, so a log that used it boots.
        if (t.status !== "OPEN" && (live || !p.reassign)) {
          throw new ProjectionError(`task ${t.id} is already ${t.status}`, event.type);
        }
        // `claimTask`'s dependency screen. A task with work upstream of it is
        // not claimable until that work is done; before `dependsOn` existed the
        // order lived only in prose and frontend claimed W6-S3 with W6-S1 never
        // claimed (skill-panel 2026-09-25, §16).
        if (live) {
          const unmet = unmetTaskDependencies(state, t);
          if (unmet.length > 0) {
            throw new ProjectionError(`task ${t.id} depends on ${unmet.join(", ")}, not yet completed`, event.type);
          }
        }
        // `claimTask`'s `evaluateCapability` loop, over the claimant's recorded
        // definition. Normalized on both sides: a worker's capabilities come
        // from its spawn op verbatim while the task's list is normalized at
        // creation, and an alias is the same capability.
        const def = !live || p.agentId === HUMAN ? undefined : state.agents.get(p.agentId)?.definition;
        if (def) {
          const held = new Set((def.capabilities ?? []).map((c) => normalizeCapability(c)));
          const missing = (t.requiredCapabilities ?? []).find((c) => !held.has(normalizeCapability(c)));
          if (missing) {
            throw new ProjectionError(`agent ${p.agentId} does not hold capability '${missing}' required by task ${t.id}`, event.type);
          }
        }
        if (t.claimedBy && t.claimedBy !== p.agentId) releasePointer(state, t.claimedBy, t.id);
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
        // `completeTask`: only a held task completes -- which also refuses the
        // second completion that used to rewrite `completedAt` -- and only its
        // claimer or the operator completes it.
        if (live && t.status !== "CLAIMED" && t.status !== "IN_PROGRESS") {
          throw new ProjectionError(`task ${t.id} is ${t.status}`, event.type);
        }
        const completer = p.agentId ?? event.actorId;
        if (live && completer && completer !== HUMAN && completer !== t.claimedBy) {
          throw new ProjectionError(`task ${t.id} is claimed by ${t.claimedBy}, not ${completer}`, event.type);
        }
        t.status = "COMPLETED";
        t.completedAt = event.timestamp;
        // The CLAIMER is freed, not the completer: when the operator completes
        // a seat's task, the seat is the one whose pointer would dangle.
        releasePointer(state, t.claimedBy, t.id);
        if (completer !== t.claimedBy) releasePointer(state, completer, t.id);
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
        // `ratifyDecision`'s `evaluateAuthority(actor, "architecture", "approve")`.
        const actor = event.actorId;
        const def = live && actor && actor !== HUMAN ? state.agents.get(actor)?.definition : undefined;
        if (def && !holdsAuthority(def.authority, "architecture", "approve")) {
          throw new ProjectionError(`agent ${actor} lacks authority 'architecture.approve' to ratify ${d.id}`, event.type);
        }
        d.status = "RATIFIED";
        d.ratifiedAt = event.timestamp;
        if (p.approvedBy) d.approvedBy = Array.from(new Set([...d.approvedBy, ...p.approvedBy]));
        if (p.evidence) d.evidence = Array.from(new Set([...d.evidence, ...(p.evidence as ArtifactRef[])]));
        // The ratification IS the answer to the ask `proposeDecision` routed to
        // the seats that could ratify it, for every one of them: once one
        // ratifier settles the decision nobody else owes it. Closed here rather
        // than by the supervisor so replay closes it too. `task_completed` is
        // the whole-ask reason whose meaning fits — the work the ask was for is
        // done — and, being a reducer close, it wakes nobody.
        for (const [pid, pr] of [...state.pendingRequests]) {
          if (pr.from !== d.proposedBy) continue;
          const ask = state.messages.get(pid)?.payload as { ratifyDecision?: unknown } | undefined;
          if (ask?.ratifyDecision === d.id) dischargeCommitment(state, pid, "task_completed", actor ?? "system", event.timestamp);
        }
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
        // `respondEscalation` answers OPEN cards only. An AUTO_RESOLVED card
        // answered here would become a faked operator decision in the audit
        // trail, and a RESPONDED one would have its recorded answer rewritten.
        if (live && e.status !== "OPEN") {
          throw new ProjectionError(`escalation ${e.id} is ${e.status}`, event.type);
        }
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
