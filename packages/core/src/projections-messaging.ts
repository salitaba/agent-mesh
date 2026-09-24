import type { MeshEvent } from "../../protocol/src/index";
import type { Projections } from "./state";
import type { MeshMessage, Thread, ThreadId, CollabSession } from "../../protocol/src/index";
import { RESPONSE_TYPES, contractForMessageType, findContract, validateContractResponse } from "../../protocol/src/index";
// Straight from the catalog rather than through the package index: this is the
// ONE obligation predicate, and the two core sites that ask it (here and the
// prompt's inbox band in `context.ts`) should be visibly reaching for the same
// module. See `obligesRecipients` there for why neither the type name nor the
// interaction mode answers on its own.
import { obligesRecipients } from "../../protocol/src/catalog";
import type { CommitmentTtlConfig, DeniedAction, DischargeRecord, PendingRequest, RefusedSend, ResponseCheck } from "./state";
import {
  MAX_DENIED_ACTIONS,
  MAX_DISCHARGE_HISTORY,
  MAX_REFUSED_SENDS,
  MAX_UNREAD_PER_AGENT,
  MAX_FINGERPRINTS_PER_THREAD,
  bumpComms,
  computeDueBy,
  dischargeCommitment,
  evictOverflowingPendingRequests,
  ledgerAtCapacity,
  pushBounded,
  readableMailDepth,
  setBounded,
  stillOwes,
} from "./state";
import { artifactForRef, bumpConflict, clearPendingForArtifactReview, fingerprintOf, hasPeerReviewerFor, holdsAuthority, pendingTargetsArtifact, recordApproval } from "./projections-helpers";

/**
 * The contract an ask was opened under, or undefined.
 *
 * Reads the runtime-owned `control` first and falls back to `payload` only for
 * messages written before the stamp moved. The fallback is what keeps replay
 * of an existing log exact; forgery is closed at the other end, by stripping
 * these keys from agent-supplied payload on every send, so no NEW message can
 * reach here with a hand-written stamp.
 *
 * The catalogue is static, closed and compiled in, so everything derived from
 * this stays a pure function of the log. An unknown name never reaches here
 * (the op refuses it at the edge); an unrecognised one simply yields nothing.
 */
function contractOf(
  m: { type?: string; payload?: unknown; control?: { contract?: string } },
  defaultByType = false,
): string | undefined {
  const fromControl = m.control?.contract;
  if (typeof fromControl === "string") return fromControl;
  const legacy = (m.payload as { contract?: unknown } | undefined)?.contract;
  if (typeof legacy === "string") return legacy;
  // The type's own contract, when the mesh asked for it (`bus.commitments.
  // by_type`). Resolved HERE, in the reducer, and deliberately not stamped
  // onto `control.contract` at send time: a stamp on the wire is documented
  // to mean "this ask passed its request schema", and this default has
  // checked no schema. What it claims is narrower and true -- that the debt
  // now on the ledger is governed by the contract its type speaks for.
  //
  // Pure, so replay re-derives it: the catalogue is frozen and the flag rides
  // in ProjectionConfig with the semantic and the TTL. A mesh that flips the
  // key and replays an old log correctly rebuilds a ledger holding its old
  // asks to their types' contracts -- the flag describes how this mesh reads
  // its ledger, not what was true the day a message was sent.
  if (defaultByType && typeof m.type === "string") return contractForMessageType(m.type)?.name;
  return undefined;
}

function contractSlaOf(
  m: { type?: string; payload?: unknown; control?: { contract?: string } },
  defaultByType = false,
): number | undefined {
  const name = contractOf(m, defaultByType);
  return name !== undefined ? findContract(name)?.slaMs : undefined;
}

/**
 * Did this answer actually answer?
 *
 * Runs at discharge, on the reply's payload, against the contract the ASK was
 * opened under. Returns undefined when there is nothing to judge -- no
 * contract, or a contract with no response schema -- and that absence is
 * recorded as absence, never as a failure.
 *
 * Pure: the catalogue is frozen and the validator is deterministic, so a
 * rebuilt projection re-derives identical marks. Fail-open is enforced by the
 * CALLER -- every site discharges regardless of this verdict.
 */
function checkResponse(pr: PendingRequest, m: MeshMessage): ResponseCheck | undefined {
  if (!pr.contract) return undefined;
  const contract = findContract(pr.contract);
  if (!contract?.response) return undefined;
  const res = validateContractResponse(contract, m.payload);
  if (res.valid) return { responseValid: true };
  return {
    responseValid: false,
    // Bounded: this rides in a capped ring buffer, and three issues is already
    // more than enough to tell an operator what was missing.
    responseIssues: res.errors.slice(0, 3).map((e) => `${e.path} ${e.message}`),
  };
}

export function applyMessagingEvent(
  state: Projections,
  event: MeshEvent,
  p: Record<string, any>,
  config?: { commitmentSemantic?: "compat" | "strict"; commitmentTtl?: CommitmentTtlConfig; contractsByType?: boolean },
): boolean {
  switch (event.type) {
    case "collab.opened": {
      const cs = p.session as CollabSession;
      state.collabSessions.set(cs.threadId, cs);
      break;
    }
    case "collab.closed": {
      const cs = state.collabSessions.get(p.threadId as ThreadId);
      if (cs) {
        // `OVERRUN` is kept distinct from `CLOSED` because they mean opposite
        // things to an operator reading a run report: one session ended
        // because someone decided it was done, the other ran until a clock
        // stopped it. Collapsing them would hide every runaway.
        cs.status = p.reason === "closed" ? "CLOSED" : "OVERRUN";
        cs.closedReason = String(p.reason ?? "closed");
        cs.closedAt = event.timestamp;
      }
      /**
       * And the THREAD the session owned reaches a terminal state (D13).
       *
       * `Thread.status` declares `OPEN | RESOLVED | ESCALATED` and, until
       * this line, nothing in the repo ever wrote either terminal value: a
       * thread was minted OPEN and stayed OPEN for the life of the mission.
       * Every reader that asks "which conversations are live?" — the prompt's
       * open-threads section, the deadlock depth scan, the thread-budget
       * stalemate check — was therefore drawing from a pool that only ever
       * grew, and the prompt paid for it every turn.
       *
       * Done from `collab.closed` rather than from a new `thread.resolved`
       * event on purpose. This reducer is the sole writer of `state.threads`,
       * the fact is already in the log, and a second event type would buy
       * nothing but a wider `EventType` union to keep in step with
       * `EVENT_SEVERITY`. It is a projection of an event that already
       * happened, which is exactly what a reducer is for.
       *
       * The two exits are NOT collapsed. `close_collab` is an agent deciding
       * the discussion is done, and that is RESOLVED. `sweepCollabOverruns`
       * reaches this same case with `expired` / `exchanges_exhausted` and
       * raises an operator card, so its thread reads ESCALATED — a value the
       * type has always declared, and the honest one next to the card the
       * operator is holding. Both are terminal, so every liveness reader gets
       * the fix either way; only the dashboard's thread row can tell them
       * apart, and it is the one that should.
       *
       * Guarded on OPEN so replaying the event twice is idempotent and a
       * thread already escalated by some future path is not quietly relabelled
       * as cleanly resolved.
       */
      const thread = state.threads.get(p.threadId as ThreadId);
      if (thread && thread.status === "OPEN") {
        thread.status = p.reason === "closed" ? "RESOLVED" : "ESCALATED";
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
      // What the classifier decided, recorded in the reducer so a replay
      // reaches it too. `unclassed` is a real answer and not a missing one: it
      // is what a mesh with no delivery regime stamps, and folding it in with
      // any of the three classes would leave a report unable to tell "nobody
      // chose a class" (no regime) from "the cheapest class was chosen"
      // (a regime working). Those are opposite findings.
      bumpComms(state.comms.sendsByClass, m.control?.delivery ?? "unclassed");
      // Who is spending other seats' attention. Counted from the envelope, not
      // from the budget ledger, so it stays true even when the tariff is zero
      // or the charge was skipped -- this answers "how often does this seat
      // interrupt", which is a question about behaviour, not about spend. The
      // operator is counted like anybody else and gets its own row: it really
      // does interrupt, it usually interrupts the most, and `chargeInterrupt`
      // skipping it is a statement about billing rather than about contact.
      if (m.control?.delivery === "interrupt") {
        bumpComms(state.comms.interruptsBySender, m.from);
      }
      // An interrupt that was asked for and refused. Invisible on the envelope
      // by design (it ships as `deliver`), so this counter is the only place
      // the refusal is recorded.
      if (typeof m.control?.downgraded === "string") {
        bumpComms(state.comms.downgradedInterrupts, m.from);
      }
      const thread = state.threads.get(m.threadId);
      if (thread) {
        if (!thread.messageIds.includes(m.id)) thread.messageIds.push(m.id);
        for (const part of [m.from, ...m.to]) {
          if (!thread.participants.includes(part)) thread.participants.push(part);
        }
      }
      // Meter. In the REDUCER, not at the send site, because a replay has to
      // arrive at the same exchange count the live run did -- an overrun that
      // only exists in the live process is an overrun that vanishes on
      // restart, which is precisely when a runaway session would survive.
      // Counts every message in the thread, including an outsider's: the box
      // bounds the CONVERSATION, not one seat's share of it.
      const collab = state.collabSessions.get(m.threadId);
      if (collab && collab.status === "OPEN") {
        collab.exchanges++;
        for (const part of [m.from, ...m.to]) {
          if (!collab.participants.includes(part)) collab.participants.push(part);
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
        if (rec) rec.state.mailboxDepth = readableMailDepth(state, target);
      }
      /**
       * Does this exchange oblige anybody, and therefore open a ledger entry?
       *
       * One call, to the one predicate. The reasoning that used to be written
       * out here — why the type prefix alone is wrong, why `broadcast` and
       * `collab` oblige nobody, why the answer is read off `control` and never
       * off `payload` — now lives with the predicate in
       * `protocol/src/catalog.ts`, because it was also written out in
       * `context.ts` and the two copies were what let the exported
       * `REQUEST_TYPES` quietly become a third, wrong answer.
       *
       * This is the authority: whatever opens a `pendingRequests` entry is
       * what the prompt's obligation band must rank first, and they are now
       * the same function rather than two that agree today.
       */
      const isRequest = obligesRecipients(m);
      if (isRequest && ledgerAtCapacity(state)) {
        // Backpressure at open. The alternative — take the ask and evict the
        // oldest to make room — drops the entries most likely to be genuinely
        // stuck, and does it silently. Refusing here costs the asker one
        // immediate, visible failure and loses nothing that was already owed.
        //
        // Recorded in the same ring an operator already reads to answer "what
        // happened to my ask?". `refused_cap` says it was never opened, which
        // is a different fact from `evicted_cap`'s "it was open and forced out".
        const refusal: DischargeRecord = {
          messageId: m.id,
          from: m.from,
          to: m.to,
          type: m.type,
          reason: "refused_cap",
          by: "system",
          at: m.timestamp,
        };
        pushBounded(state.discharged, refusal, MAX_DISCHARGE_HISTORY);
      } else if (isRequest) {
        /**
         * A fresh ask makes an answered thread live again (D13).
         *
         * `settleThread` ends a thread when its last ask settles, and the MCP
         * send surface advertises `threadId` precisely so a follow-up ask
         * lands in the thread that raised it ("without them every request
         * opened a fresh thread, which split one exchange"). Without this
         * line that follow-up would open a real commitment inside a
         * conversation that no liveness reader can see: never in the prompt's
         * open-threads section, never scanned for depth, never counted by the
         * thread-budget stall check, and never resolvable again either.
         *
         * Only from RESOLVED. An ESCALATED thread is not relabelled by new
         * traffic, because escalation says something went wrong here and a
         * human may still be holding a card -- a new ask is not a retraction,
         * and quietly moving the thread back to OPEN would hide the card's
         * subject from every reader that shows status.
         */
        const revived = state.threads.get(m.threadId);
        if (revived && revived.status === "RESOLVED") revived.status = "OPEN";
        /**
         * The asker's own fallback, and the clock that makes it real.
         *
         * `computeDueBy` refuses to invent a deadline where the mesh
         * configured none -- deliberately, and rightly, since a deadline the
         * asker picks is a deadline the asker can set to infinity. But that
         * rule would make `ifUnanswered` a promise the runtime cannot keep on
         * any mesh without `bus.commitments.ttl_ms`: the default would be
         * recorded, never fire, and the asker would wait forever for a
         * fallback it was told it had.
         *
         * So a declared `afterMs` -- and ONLY that, on an ask that carries a
         * default -- may draw its own clock. This is not the asker extending
         * a debtor's rope: it shortens the ask's own life and releases every
         * debtor at the end of it, which is the opposite move. The op is
         * refused at the edge when neither this nor a configured regime
         * exists, so a recorded default always has a deadline behind it.
         */
        const assumed = m.control?.ifUnanswered;
        const ownClock = assumed && typeof assumed.afterMs === "number" && assumed.afterMs > 0
          ? Date.parse(m.timestamp) + assumed.afterMs
          : NaN;
        state.pendingRequests.set(m.id, {
          messageId: m.id,
          from: m.from,
          to: m.to,
          type: m.type,
          threadId: m.threadId,
          taskId: m.taskId,
          createdAt: m.timestamp,
          contract: contractOf(m, config?.contractsByType === true),
          dueBy: Number.isFinite(ownClock)
            ? new Date(ownClock).toISOString()
            : computeDueBy(state, m.to, m.timestamp, config?.commitmentTtl, contractSlaOf(m, config?.contractsByType === true)),
          goalId: m.goalId ?? event.goalId,
          artifactUris: (m.artifactRefs ?? []).map((r) => r.uri),
          // An ask to N agents is N obligations. Tracking them individually is
          // what stops one reply from closing everybody else's debt.
          outstanding: [...m.to],
          ...(assumed ? { ifUnanswered: assumed } : {}),
        });
      }
      const answered = m.replyTo ? state.pendingRequests.get(m.replyTo) : undefined;
      if (m.replyTo && answered) {
        // Exact: the responder named the ask it answers. No inference.
        // The answer is judged against the ask's contract and settles the debt
        // either way -- a thin reply is marked, never held open.
        dischargeCommitment(state, m.replyTo, "reply", m.from, m.timestamp, m.id, checkResponse(answered, m));
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
              dischargeCommitment(state, pid, "task", m.from, m.timestamp, m.id, checkResponse(pr, m));
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
            dischargeCommitment(state, pid, "in_thread", m.from, m.timestamp, m.id, checkResponse(pr, m));
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
              dischargeCommitment(state, pid, "artifact_review", m.from, m.timestamp, m.id, checkResponse(pr, m));
              continue;
            }
            const refs = Array.isArray(m.artifactRefs) ? m.artifactRefs : [];
            if (refs.length > 0) {
              const prUris = new Set([
                ...(pr.artifactUris ?? []),
                ...(state.messages.get(pr.messageId)?.artifactRefs.map((r) => r.uri) ?? []),
              ]);
              if (refs.some((r) => prUris.has(r.uri))) {
                dischargeCommitment(state, pid, "artifact_review", m.from, m.timestamp, m.id, checkResponse(pr, m));
              }
            }
          }
        }
      }
      if (m.type === "TEST_RESULT" || m.type === "SECURITY_FINDING") {
        const pl = (m.payload ?? {}) as Record<string, unknown>;
        if (pl.result === "PASSED") {
          const subject = (pl.subject as string) ?? (m.type === "TEST_RESULT" ? "quality" : "security");
          const sender = state.agents.get(m.from);
          /**
           * A sign-off requires the authority to sign, on the message path
           * exactly as on the op path.
           *
           * `payload` is verbatim agent input. Without this check any agent
           * permitted to send a TEST_RESULT to anyone could satisfy a
           * `<role>.pass` transition gate — for ANY subject, since
           * `payload.subject` above is agent-supplied too — purely by
           * asserting `result: "PASSED"`. The op path runs
           * `evaluateAuthority` before recording (see recordDecision in
           * supervisor.ts); this path ran nothing, so the cheapest way to
           * move an artifact was to claim rather than to be entitled.
           *
           * The message stays in the log and is still delivered either way:
           * an unentitled PASSED is a report, not a verdict.
           *
           * The second screen is self-approval, and it mirrors the op path
           * (`recordDecision` in supervisor.ts): holding `<subject>.pass` is
           * standing to sign OTHER agents' work, not licence to sign your
           * own. Without it the owner of an artifact who happens to hold the
           * authority could satisfy its own gate by message, which is the
           * whole point of a gate. Self-sign stays legal only when no peer
           * could have reviewed — `hasPeerReviewerFor` carries that rule, and
           * the single-agent control group depends on it.
           *
           * The target is resolved from `payload.artifactId` OR
           * `artifactRefs[0].uri`, because `recordApproval` below records
           * under both and screening only one would leave the other open.
           */
          const target = artifactForRef(state, pl.artifactId as string | undefined, m.artifactRefs[0]?.uri);
          const selfApproval = !!target && target.owner === m.from && hasPeerReviewerFor(state, m.from, target);
          if (holdsAuthority(sender?.definition.authority, subject, "pass") && !selfApproval) {
            recordApproval(
              state,
              {
                subject,
                artifactId: (pl.artifactId as string) ?? undefined,
                artifactRef: m.artifactRefs[0],
                actorId: m.from,
                actorRole: sender?.definition.role ?? "",
              },
              event,
              "pass",
            );
          }
        }
      }
      if (m.type === "BLOCK") {
        const pl = (m.payload ?? {}) as Record<string, unknown>;
        const subject = (pl.subject as string) ?? "quality";
        const blocker = state.agents.get(m.from);
        /**
         * A block is a verdict too, so it needs `<subject>.block` exactly as a
         * sign-off needs `<subject>.pass`. `payload.subject` is agent-supplied,
         * so without this any agent able to send a BLOCK could withhold a
         * MERGED transition in a domain it has no standing in.
         *
         * A refused block must NOT vanish. Unlike an unentitled PASSED — where
         * recording nothing is the safe outcome — an unentitled BLOCK that is
         * silently discarded means the sender believes it objected while the
         * artifact ships anyway. So the refusal is counted as a conflict, which
         * `metrics.ts` reports and the deadlock scan escalates once it repeats
         * (`repeatedConflictThreshold`). The supervisor's send path
         * additionally tells the sender directly.
         *
         * The message itself is still logged and delivered: an unentitled
         * BLOCK is a concern, not a verdict.
         */
        if (holdsAuthority(blocker?.definition.authority, subject, "block")) {
          recordApproval(
            state,
            {
              subject,
              artifactId: (pl.artifactId as string) ?? undefined,
              actorId: m.from,
              actorRole: blocker?.definition.role ?? "",
            },
            event,
            "block",
          );
        } else {
          bumpConflict(
            state,
            `unauthorized-block:${m.from}:${subject}`,
            m.from,
            event.timestamp,
            m.threadId,
            (pl.artifactId as string) ?? m.artifactRefs[0]?.uri,
          );
        }
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
      if (rec) rec.state.mailboxDepth = readableMailDepth(state, target);
      break;
    }
    case "message.rejected": {
      /**
       * A send that was refused is still something the mesh tried to say.
       *
       * The sender is told synchronously (`sendMessage` returns
       * `{ accepted: false, reason }` and the send op fails with it), so this
       * is not a lost-message fix — it is the missing half of the record.
       * Nothing projected this event, so from every view built on state a
       * mesh whose policy refused every send was indistinguishable from a
       * mesh whose agents had nothing to say.
       *
       * Only refusals that named RECIPIENTS land in `refusedSends`. This
       * event type is overloaded: `Supervisor.denied` routes op and activation
       * denials through it too, and those carry an `action` and no `to` at
       * all. They are a different question ("what was I stopped from doing?")
       * rather than "what did the mesh try to say?", and admitting them to
       * this ring would let one misconfigured op rule evict every record of a
       * message that never left the building.
       *
       * So they go to a ring of their OWN, with its own cap, below. That is
       * the half that used to be projected nowhere at all: an operator could
       * only get at it by folding the raw event log, which the MCP failure
       * digest does and nothing built on projections could.
       */
      const to = p.to;
      if (Array.isArray(to)) {
        const refusal: RefusedSend = {
          from: String(p.from ?? ""),
          to: to.map((t) => String(t)),
          type: String(p.type ?? ""),
          reason: String(p.reason ?? ""),
          // Present when a policy rule refused it, absent when protocol
          // validation did; the distinction is the first thing an operator
          // needs, because only one of the two is theirs to change.
          ...(typeof p.ruleId === "string" ? { ruleId: p.ruleId } : {}),
          at: event.timestamp,
        };
        pushBounded(state.refusedSends, refusal, MAX_REFUSED_SENDS);
      } else if (typeof p.action === "string" && p.action) {
        // The op/activation half. Keyed on `action` rather than on the
        // `denied: true` flag the supervisor also stamps, because `action` is
        // the field the record cannot be written without — a denial with no
        // recipients AND no action names nothing an operator could act on, so
        // it is better dropped than stored as a row of empty strings.
        const denial: DeniedAction = {
          agentId: String(p.from ?? ""),
          action: p.action,
          ...(typeof p.subject === "string" && p.subject ? { subject: p.subject } : {}),
          reason: String(p.reason ?? ""),
          ...(typeof p.ruleId === "string" ? { ruleId: p.ruleId } : {}),
          // DENY clears itself for nobody; DEFER clears when the budget or the
          // goal moves. An operator who cannot tell them apart waits on the
          // one that will never come.
          ...(typeof p.decision === "string" ? { decision: p.decision } : {}),
          at: event.timestamp,
        };
        pushBounded(state.deniedActions, denial, MAX_DENIED_ACTIONS);
      }
      break;
    }
    default:
      return false;
  }
  // Bounded-state enforcement: caps applied after mutation.
  for (const [agentId, box] of state.unread) {
    if (box.length <= MAX_UNREAD_PER_AGENT) continue;
    const dropped = box.length - MAX_UNREAD_PER_AGENT;
    box.splice(0, dropped);
    // Counted, because this is the one place in the messaging path where mail
    // ceases to exist and nothing anywhere says so: the messages are gone from
    // the box, the sender was told delivery succeeded, and the recipient never
    // learns there was a queue behind what it read. An event would be the
    // honest signal, but a reducer that emits stops being a function of the
    // log, so the count is what replay can carry.
    state.mailOverflowDropped.set(agentId, (state.mailOverflowDropped.get(agentId) ?? 0) + dropped);
    // `mailboxDepth` is written on every delivery and every read; capping the
    // box without re-syncing it left the agent's own state claiming a deeper
    // mailbox than exists, which the scheduler and context both surface.
    const rec = state.agents.get(agentId);
    if (rec) rec.state.mailboxDepth = readableMailDepth(state, agentId);
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
