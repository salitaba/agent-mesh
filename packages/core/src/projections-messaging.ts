import type { MeshEvent } from "../../protocol/src/index";
import type { Projections } from "./state";
import type { MeshMessage, Thread } from "../../protocol/src/index";
import { RESPONSE_TYPES } from "../../protocol/src/index";
import { MAX_UNREAD_PER_AGENT, MAX_FINGERPRINTS_PER_THREAD, dischargeCommitment, evictOverflowingPendingRequests, setBounded, stillOwes } from "./state";
import { bumpConflict, clearPendingForArtifactReview, fingerprintOf, pendingTargetsArtifact, recordApproval } from "./projections-helpers";

export function applyMessagingEvent(
  state: Projections,
  event: MeshEvent,
  p: Record<string, any>,
  config?: { commitmentSemantic?: "compat" | "strict" },
): boolean {
  switch (event.type) {
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
        // Runtime-owned envelope field, not payload: `payload` is verbatim
        // agent input, so reading delivery control from it let a sender
        // suppress its own message's delivery while still opening a pending
        // request — an ask nobody could ever see, let alone answer.
        if (m.control?.cacheServed === true) continue;
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
          goalId: m.goalId ?? event.goalId,
          artifactUris: (m.artifactRefs ?? []).map((r) => r.uri),
          // An ask to N agents is N obligations. Tracking them individually is
          // what stops one reply from closing everybody else's debt.
          outstanding: [...m.to],
        });
      }
      if (m.replyTo && state.pendingRequests.has(m.replyTo)) {
        // Exact: the responder named the ask it answers. No inference.
        dischargeCommitment(state, m.replyTo, "reply", m.from, m.timestamp, m.id);
      }
      // Compat inference: a response that only *looks* like an answer may
      // still discharge the ask (agents often approve via a fresh message
      // instead of `respond`; `reply` aliases to INFORM and small models
      // answer REQUESTs with plain INFORMs). Strict mode disables thread
      // and artifact-shape inference: without `replyTo` the response delivers
      // content and wakes the asker, but discharges nothing. A re-asked
      // question in strict mode is cheap and explicit; a falsely-closed one
      // is silent and strands the asker.
      //
      // The taskId match below is NOT inference: it is the worker-result
      // contract (REQUEST_EXECUTION taskId == HANDOFF taskId), surviving in
      // both modes so delegated workers keep working.
      const strict = config?.commitmentSemantic === "strict";
      const isResponse = (RESPONSE_TYPES as readonly string[]).includes(m.type) || m.type === "INFORM";
      // Strict keeps ONLY the worker-result contract: a HANDOFF carrying the
      // same taskId the REQUEST_EXECUTION minted (fresh threads, parent never
      // on the recipient list — by design). Everything else needs `replyTo`.
      if (strict) {
        if (isResponse && m.taskId) {
          for (const [pid, pr] of [...state.pendingRequests]) {
            if (pid !== m.id && pr.taskId && m.taskId === pr.taskId) {
              dischargeCommitment(state, pid, "task", m.from, m.timestamp, m.id);
            }
          }
        }
      } else if (isResponse) {
        const pl = (m.payload ?? {}) as Record<string, unknown>;
        /**
         * An answer only discharges an ask it actually reaches.
         *
         * Every heuristic below used to test "was the sender one of the
         * askees?" and nothing else, so ONE reply cleared EVERY pending ask
         * matching that loose shape. Two agents asking the same reviewer in
         * one thread (architect and pm both asking dev — routine) meant dev's
         * single answer to architect silently discharged pm's ask too: pm
         * then waited forever on a question the runtime believed answered,
         * and no nudge or stalemate could ever fire for it, because the
         * pending entry that would have raised one was gone.
         *
         * The asker must be an addressee of the answer (or the answer must be
         * a broadcast to the whole thread). `replyTo` above stays exact and is
         * unaffected.
         */
        const reaches = (pr: { from: string }): boolean => m.to.includes(pr.from);
        for (const [pid, pr] of [...state.pendingRequests]) {
          if (pid === m.id) continue;
          if (pr.threadId === m.threadId && stillOwes(pr, m.from) && reaches(pr)) {
            dischargeCommitment(state, pid, "in_thread", m.from, m.timestamp, m.id);
            continue;
          }
          // BLOCK / REJECT / APPROVE carried as messages with an artifact
          // pointer but on a fresh thread (e.g. recordDecision's BLOCK path):
          // match by artifact when the responder was asked. Agents disagree
          // on the field name (`artifactId` vs `artifact` vs a bare
          // `artifactRefs` URI), so accept all three.
          if (stillOwes(pr, m.from) && reaches(pr)) {
            const artifactPtr =
              typeof pl.artifactId === "string"
                ? pl.artifactId
                : typeof pl.artifact === "string"
                  ? pl.artifact
                  : undefined;
            if (artifactPtr && pendingTargetsArtifact(state, pr, artifactPtr)) {
              dischargeCommitment(state, pid, "artifact_review", m.from, m.timestamp, m.id);
              continue;
            }
            const refs = Array.isArray(m.artifactRefs) ? m.artifactRefs : [];
            if (refs.length > 0) {
              const prUris = new Set([
                ...(pr.artifactUris ?? []),
                ...(state.messages.get(pr.messageId)?.artifactRefs.map((r) => r.uri) ?? []),
              ]);
              if (refs.some((r) => prUris.has(r.uri))) {
                dischargeCommitment(state, pid, "artifact_review", m.from, m.timestamp, m.id);
              }
            }
          }
        }
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
    default:
      return false;
  }
  // Bounded-state enforcement: caps applied after mutation.
  for (const [agentId, box] of state.unread) {
    if (box.length <= MAX_UNREAD_PER_AGENT) continue;
    box.splice(0, box.length - MAX_UNREAD_PER_AGENT);
    // `mailboxDepth` is written on every delivery and every read; capping the
    // box without re-syncing it left the agent's own state claiming a deeper
    // mailbox than exists, which the scheduler and context both surface.
    const rec = state.agents.get(agentId);
    if (rec) rec.state.mailboxDepth = box.length;
  }
  for (const [tid, set] of state.messageFingerprints) {
    if (set.size > MAX_FINGERPRINTS_PER_THREAD) {
      const arr = [...set].slice(-MAX_FINGERPRINTS_PER_THREAD);
      state.messageFingerprints.set(tid, new Set(arr));
    }
  }
  evictOverflowingPendingRequests(state, event.timestamp);
  return true;
}
