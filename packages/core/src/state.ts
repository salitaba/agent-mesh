import type {
  AgentDefinition,
  AgentRuntimeState,
  Artifact,
  ArtifactId,
  BudgetProjectionEntry,
  DecisionRecord,
  Escalation,
  Goal,
  GoalId,
  LeaseId,
  MeshEvent,
  MeshMessage,
  MessageId,
  Task,
  Thread,
  ThreadId,
  CollabSession,
  WorkspaceLease,
  AgentMemoryNote,
  ContinuityRecord,
} from "../../protocol/src/index";

/**
 * How an outstanding ask was discharged. Recorded so an operator can see
 * WHETHER the mesh knew the answer arrived or merely guessed.
 *
 * `reply` is the only exact signal (the responder named the message it was
 * answering). Everything else is inference from shape, and every inference
 * rule here has historically both under- and over-fired: under-firing strands
 * an agent behind a false stalemate, over-firing strands it waiting on an ask
 * the runtime already forgot. Making the distinction first-class means the
 * inferred cases are measurable instead of invisible.
 */
export type DischargeReason =
  /** Responder set `replyTo` (or called `discharge`): exact, no guessing. */
  | "reply"
  /** Answer in the ask's thread, addressed to the asker. */
  | "in_thread"
  /** Answer carried the same taskId. */
  | "task"
  /** A review verdict landed on the artifact the ask referenced. */
  | "artifact_review"
  /** The task the ask belonged to completed. */
  | "task_completed"
  /** A newer artifact version replaced the one under review. */
  | "superseded"
  /** Operator answered or dropped it out of band. */
  | "operator"
  /** Runtime voided it to break a circular wait. */
  | "deadlock_break"
  /**
   * The ledger was full, so the ask was never opened at all.
   *
   * The one reason here that does NOT describe an ask leaving the ledger —
   * it describes one that was refused entry. It is recorded in the same ring
   * anyway because that ring is where an operator looks to answer "what
   * happened to my ask?", and "it was never accepted" is the answer.
   *
   * Distinct from `evicted_cap`, which is the opposite failure: that one says
   * an ask WAS open and something else forced it out.
   */
  | "refused_cap"
  /**
   * The debtor said no. Exact, not inferred: an agent called `discharge` on an
   * ask addressed to it and gave a reason, and the asker was told so.
   *
   * Split out of `reply` because recording a refusal as a reply made the two
   * indistinguishable in the ledger — `commitmentStats().byReason` counted a
   * team that answered nothing and a team that answered everything as the
   * same shape, and the only surviving trace of the difference was a
   * `declined: true` flag buried in the discharge event's detail.
   *
   * Deliberately NOT in `UNANSWERED_DISCHARGE_REASONS`: a refusal is a
   * settlement the asker was notified of, unlike an eviction or a deadlock
   * break, which are losses the asker never hears about.
   */
  | "refused"
  /**
   * The ask passed its `dueBy` with no answer.
   *
   * The ledger previously had no notion of lateness at all: an ask stayed open
   * forever, and the only bounded lifetime was three nudges and a 1000-entry
   * cap. That makes "waiting" and "abandoned" the same state, which is exactly
   * the state a low-contact mesh must be able to tell apart — an asker that
   * cannot distinguish them has to either block forever or poll.
   */
  | "expired"
  /**
   * The AGENT THAT ASKED closed its own ask before anyone answered it.
   *
   * The creditor's counterpart to `refused`, and it closes the same asymmetry
   * from the other side. A debtor that will not answer could say so; an asker
   * that no longer NEEDS an answer had no move at all. Its only options were
   * to keep waiting, or to chase -- and a chase is an interrupt, priced in
   * someone else's attention, to demand an answer to a question it had
   * already stopped needing. Failing that, the ask aged into the nudge ladder
   * and raised a card, so the operator was woken to arbitrate a question
   * nobody wanted answered.
   *
   * Withdrawing is therefore the cheap exit from exactly the situation the
   * escalation ladder is worst at. It says "stop working on this" in one
   * logged move, costs no model turn on either side, and retires the card
   * instead of manufacturing it.
   *
   * NOT a loss, and deliberately absent from `UNANSWERED_DISCHARGE_REASONS`:
   * the one party whose answer mattered is the party that chose to stop
   * wanting it. It is also absent from `PER_DEBTOR_DISCHARGE_REASONS` -- the
   * asker speaks for the whole ask, so one withdrawal releases every debtor,
   * and the released set is the record's own `to`, complete rather than
   * partial. The reason the asker gave lives on the `commitment.discharged`
   * event payload and in the notice the debtors receive; it is deliberately
   * NOT a `DischargeRecord` field, whose shape is fixed.
   */
  | "withdrawn_by_sender"
  /**
   * The bounded-state cap forced it out. NOT an answer: the ask is simply
   * gone, and everything downstream of the ledger (wait-cycle detection,
   * `owedByYou` context, stuck-request escalations) loses it. Recorded so
   * that loss is auditable instead of silent, and counted so operators can
   * see the ledger is over capacity.
   */
  | "evicted_cap";

/** Discharge reasons the runtime inferred rather than was told. */
export const INFERRED_DISCHARGE_REASONS: ReadonlySet<DischargeReason> = new Set<DischargeReason>([
  "in_thread",
  "task",
  "artifact_review",
  "task_completed",
  "superseded",
]);

/**
 * Discharges that do NOT mean "the ask was answered".
 *
 * `supervisor.reconcileEscalations` treats "no longer pending" as "answered
 * or withdrawn" and auto-resolves the operator card. For these reasons that
 * conclusion is false, so consumers must consult the discharge record before
 * claiming an ask resolved.
 */
export const UNANSWERED_DISCHARGE_REASONS: ReadonlySet<DischargeReason> = new Set<DischargeReason>([
  "evicted_cap",
  "deadlock_break",
  // A deadline passing is not an answer. `refused` is deliberately absent:
  // the debtor responded, the asker was told, and the ask really is settled.
  "expired",
  // Never opened, so certainly never answered.
  "refused_cap",
  // `withdrawn_by_sender` is absent for the same reason as `refused`, and the
  // membership is what retires the operator's card. A card raised for
  // `stalemate:unanswered_request` exists because a question was stuck; once
  // the asker withdraws it there is no question, no stalemate, and nobody for
  // the operator to arbitrate between. Leaving it in this set would keep the
  // card OPEN and the mission frozen over an ask that no longer exists.
]);

export interface PendingRequest {
  messageId: MessageId;
  from: string;
  to: string[];
  type: string;
  threadId: ThreadId;
  taskId?: string;
  createdAt: string;
  /**
   * When an answer stops being expected, ISO-8601. Absent means "no deadline",
   * which is what every ask from before this field looked like and what a mesh
   * with no configured TTL still produces.
   *
   * Set at open time from config rather than by the asker: a deadline the
   * asker chooses is a deadline the asker can set to infinity, and the whole
   * point is to bound how long a debtor's silence can hold a creditor open.
   * Derived from the DEBTORS' roles (the longest of them), because the
   * question it answers is "how long should this kind of work take?", not
   * "how patient is the asker?".
   */
  dueBy?: string;
  /**
   * The contract this ask was opened under, when it was opened through one.
   *
   * Recorded at open time because the answer is checked at DISCHARGE, and by
   * then the asking message is the only place the contract name survives --
   * re-deriving it from the reply would mean trusting the responder to say
   * what it was answering.
   */
  contract?: string;
  goalId?: string;
  /** Artifact URIs referenced by the request (used to clear reviews on approve/merge). */
  artifactUris?: string[];
  /**
   * Debtors who still owe an answer, of the original `to`.
   *
   * An ask addressed to three reviewers is three obligations, not one. The
   * ledger used to hold a single entry keyed only by message id, so the FIRST
   * reply closed it for everyone: ask dev+qa+security to review, dev says
   * "looks fine", and the runtime recorded reason `reply` — its most
   * confident, non-inferred discharge — while qa and security had said
   * nothing. Two review obligations disappeared with no record, no nudge, and
   * no stalemate, because a plural debtor is a diffuse debtor: nobody in
   * particular ever owed anything.
   *
   * With `broadcast` (which addresses every agent in the mesh) that made one
   * reply capable of discharging an obligation owed by the entire team.
   *
   * Absent on entries from older logs, where it degrades to the previous
   * behavior rather than rewriting history on replay.
   */
  outstanding?: string[];
}

/** A discharged ask, kept briefly so the runtime can explain what happened. */
export interface DischargeRecord {
  messageId: MessageId;
  from: string;
  to: string[];
  type: string;
  reason: DischargeReason;
  /** Who discharged it (responder, operator, or "system"). */
  by: string;
  at: string;
  /** The message that discharged it, when there was one. */
  viaMessageId?: MessageId;
  /**
   * One debtor of several answered; the ask is still owed by `remaining`.
   * A partial record explains a settled obligation, NOT a settled ask.
   */
  partial?: boolean;
  /** Debtors who still owe an answer after this discharge. */
  remaining?: string[];
  /**
   * Did the answer match the contract's `response` schema?
   *
   * `false` means the ask was settled by a reply that did not answer it --
   * empty, or missing every field the contract said an answer carries. The
   * debt is discharged either way (see `Contract.response` for why this fails
   * open), so this mark is the ONLY record that the settlement was thin.
   *
   * Absent means not checked: no contract, or a contract with no response
   * schema. Absent is not a failure, and consumers must not read it as one.
   */
  responseValid?: boolean;
  /** Why it did not match, at most a few entries. Present only when false. */
  responseIssues?: string[];
}

/**
 * A send that never happened, kept so the refusal is visible to an operator.
 *
 * The sender already learns of this synchronously — `sendMessage` returns
 * `{ accepted: false, reason }` and the op path hands that back as the op's
 * failure — so this record exists for the OTHER reader: the operator or the
 * run report asking "what did this mesh try to say and get stopped from
 * saying?". Without it a policy that refuses every send looks, in every
 * projection, exactly like a mesh whose agents chose not to talk.
 *
 * The refused `payload` is deliberately NOT kept. It is verbatim agent input
 * of unbounded size, it rides into every snapshot, and the three facts that
 * identify a refusal — who, to whom, and why — are all here already. The
 * event log still holds the payload for anyone who needs the body itself.
 */
export interface RefusedSend {
  from: string;
  to: string[];
  type: string;
  reason: string;
  /** The policy rule that refused it; absent when validation did. */
  ruleId?: string;
  at: string;
}

/**
 * One thing an agent was stopped from DOING, as `Supervisor.denied` records it.
 *
 * The other half of the overloaded `message.rejected` event. A send refusal
 * names recipients and a message type and becomes a {@link RefusedSend}; this
 * one names an `action` and no `to` at all — a denied op (`claim task
 * (missing capability test.execute)`, `publish_artifact`) or a denied
 * activation (`activate (mail)`), routed through the same event type because
 * both are the policy engine saying no.
 *
 * It is a different QUESTION — "what was I stopped from doing?" rather than
 * "what did the mesh try to say?" — which is why it gets its own ring with its
 * own cap instead of sharing `refusedSends`. One misconfigured op rule can
 * deny on every tick, and a shared ring would let that storm evict the record
 * of a message that never left the building.
 *
 * Like `RefusedSend`, this keeps the identifying facts and not the body: the
 * event log holds the full payload for anyone who needs it, and this rides
 * into every snapshot.
 */
export interface DeniedAction {
  /** The agent the denial was issued against. */
  agentId: string;
  /** What it was stopped from doing, in the supervisor's own words. */
  action: string;
  /** What the action named — a task id, an artifact id — when it named one. */
  subject?: string;
  reason: string;
  /** The policy rule that refused it, when the decision carried one. */
  ruleId?: string;
  /**
   * `DENY` or `DEFER`, verbatim from the policy decision. The distinction is
   * the first thing an operator needs: a DEFER clears itself when the budget
   * or the goal moves, a DENY does not and waiting for it is the trap.
   */
  decision?: string;
  at: string;
}

/** The verdict on one answer, as recorded by {@link dischargeCommitment}. */
export interface ResponseCheck {
  responseValid: boolean;
  responseIssues?: string[];
}

export interface ConflictRecord {
  key: string;
  count: number;
  lastActor: string;
  artifactId?: ArtifactId;
  threadId?: ThreadId;
  firstAt: string;
  lastAt: string;
}

export interface BudgetLedger {
  key: string;
  limitKind: BudgetProjectionEntry["limitKind"];
  limit: number | null;
  reserved: number;
  consumed: number;
  exceeded: boolean;
  reservations: Map<string, number>;
}

export interface AgentRecord {
  definition: AgentDefinition;
  state: AgentRuntimeState;
}

export interface Projections {
  goals: Map<GoalId, Goal>;
  activeGoalId: GoalId | null;
  agents: Map<string, AgentRecord>;
  artifacts: Map<ArtifactId, Artifact>;
  artifactByName: Map<string, Artifact>;
  artifactHistory: Map<ArtifactId, Artifact[]>;
  threads: Map<ThreadId, Thread>;
  messages: Map<MessageId, MeshMessage>;
  unread: Map<string, MessageId[]>;
  tasks: Map<string, Task>;
  decisions: Map<string, DecisionRecord>;
  approvals: Map<string, import("../../protocol/src/index").ApprovalRecord[]>;
  escalations: Map<string, Escalation>;
  budgets: Map<string, BudgetLedger>;
  leases: Map<LeaseId, WorkspaceLease>;
  activeLeaseByArtifact: Map<ArtifactId, LeaseId>;
  memory: Map<string, Map<string, AgentMemoryNote>>;
  /**
   * The latest continuity record each seat wrote, keyed by agent id.
   *
   * Latest-wins rather than a per-episode history: the consumer is the seat's
   * NEXT session, which wants exactly one record — the most recent thing its
   * predecessor knew. The record carries its own `episode`, so a reader can
   * still tell a note written in this run from one inherited across a reopen,
   * without the projection having to keep every generation alive forever.
   */
  continuity: Map<string, ContinuityRecord>;
  /**
   * How many backend sessions each seat has burned through: 1 while it is on
   * its first, 2 after one rotation. Projected from `session.rotated`, which
   * until now had no reducer at all — the one moment an agent loses its entire
   * working memory was invisible to every projection in the mesh.
   */
  sessionOrdinal: Map<string, number>;
  pendingRequests: Map<MessageId, PendingRequest>;
  /**
   * Time-boxed collaborations, keyed by the thread each one owns. See
   * CollabSession. Not part of the commitment ledger on purpose: a collab
   * obliges nobody, so it must never be nudged, chased for an answer, or
   * counted in `inferredRatio`. Its only enforcement is its own clock.
   */
  collabSessions: Map<ThreadId, CollabSession>;
  /**
   * Recently discharged asks, newest last. Bounded ring: this is an
   * explanation buffer for operators and for the "was it answered or merely
   * assumed answered?" question, not a second source of truth.
   */
  discharged: DischargeRecord[];
  /**
   * Sends policy or protocol validation turned away, newest last. Bounded
   * ring, like `discharged`, and for the same reason: an explanation buffer,
   * not a second source of truth — the event log is that.
   *
   * Holds only refusals that had RECIPIENTS. `message.rejected` is overloaded:
   * the same event type also carries op and activation denials, which name an
   * `action` instead of a `to`. Those are already aggregated for the operator
   * from the log, and letting a burst of them share this ring would evict the
   * record of a message that never left the building.
   */
  refusedSends: RefusedSend[];
  /**
   * Ops and activations policy turned away, newest last. Bounded ring, with
   * its OWN cap rather than a share of `refusedSends`.
   *
   * Holds exactly the half of `message.rejected` that `refusedSends` refuses:
   * the denials that name an `action` and no recipients. Until this existed
   * they were projected nowhere, so "what was this agent stopped from doing?"
   * could only be answered by folding the raw event log — which the MCP
   * failure digest does, and nothing built on projections could.
   *
   * Two rings rather than one because the ring is also a blast radius. Op
   * denials arrive in storms (one misconfigured rule denies on every tick);
   * sends refused by policy are comparatively rare. Sharing would let the
   * first silently delete the record of the second.
   */
  deniedActions: DeniedAction[];
  /**
   * How many unread messages the `MAX_UNREAD_PER_AGENT` cap has dropped for
   * each agent, keyed by agent id.
   *
   * The cap is oldest-first and silent: mail simply stopped existing, and
   * nothing downstream could tell a seat that read everything from a seat that
   * was flooded past its box. A counter cannot bring the messages back, but it
   * makes the loss countable, which is the difference between mail that
   * vanished and mail that is known to have vanished.
   *
   * A count rather than an event on purpose: a reducer that emits is a reducer
   * whose output depends on more than the log, and this number has to be
   * re-derivable by replaying it.
   */
  mailOverflowDropped: Map<string, number>;
  conflicts: Map<string, ConflictRecord>;
  reviewRounds: Map<ArtifactId, number>;
  messageFingerprints: Map<ThreadId, Set<string>>;
  lastEventSeq: number;
  lastEventAt: string | null;
  eventCount: number;
  eventsSinceActivation: Map<string, number>;
  sessionMap: Map<string, { sessionId: string; runtime: string }>;
  goalHistory: Array<{ status: string; at: string; reason?: string }>;
  progress: Map<GoalId, { completed: number; total: number; ratio: number; updatedAt: string }>;
  turnAudit: Map<string, { turnId: string; events: MeshEvent["id"][] }>;
  /**
   * Token spend keyed by model id, accumulated from `budget.consumed`.
   *
   * Cost was previously reported per agent only, which cannot answer the
   * question that actually controls the bill: which model is eating the
   * budget. Only `agent:` ledger events are counted — the mission and thread
   * events mirror the same spend, so counting all three inflated every model
   * by ~3x (the same bug that once made an agent appear to be over budget).
   */
  modelSpend: Map<string, ModelSpend>;
  /**
   * What the comms layer actually did, in counts.
   *
   * This exists because the branch that prices a wake could not answer whether
   * pricing it changed anything. Every other comms field in the run report is a
   * *shape* -- how many messages, of what mode, still unread -- and none of them
   * is the number the delivery-class regime was built to move: how many model
   * turns the mesh bought in order to say something.
   *
   * Counters rather than a derived scan of `messages`, for two reasons. A scan
   * is bounded by whatever the message table happens to hold, so a long run
   * would silently report the tail as if it were the total; and `wakesByKind`
   * has no message to derive from at all, because a wake is not a message.
   *
   * Counts, not events: a reducer that emits is a reducer whose output depends
   * on more than the log, and every number here has to be re-derivable by
   * replaying it. Same discipline as `mailOverflowDropped`.
   */
  comms: CommsCounters;
}

/**
 * The numbers that answer "did any of this reduce contact?".
 *
 * Four questions, and each is the one no other projection in the mesh can
 * answer:
 *
 * - `wakesByKind` -- activations split by what asked for them. `activations`
 *   already counts every wake, but it counts a startup kick, an operator
 *   nudge and an inbound message as the same event, so it cannot say how much
 *   of a seat's spend was *communication* rather than the mission's own
 *   machinery. Kind `message` and `interest_event` are the comms half.
 * - `sendsByClass` -- what the classifier decided. Without it the delivery
 *   regime is unfalsifiable: a mesh where every send is `accrue` and a mesh
 *   where the classifier never ran look identical everywhere else.
 * - `interruptsBySender` -- who is spending other seats' attention. This is
 *   the number the tariff is meant to move, and the one worth pairing with
 *   `heavyestPair` traffic: a pair that talks a lot and interrupts never is
 *   the low-contact behaviour working.
 * - `downgradedInterrupts` -- interrupts asked for and refused. A downgrade is
 *   invisible on the envelope (the message ships as `deliver`, which is the
 *   point), so without this count the mesh cannot distinguish "nobody
 *   interrupts" from "everybody's interrupts are being refused", which are
 *   opposite findings about the same silence.
 */
export interface CommsCounters {
  /** ActivationReasonKind -> how many wakes it bought. */
  wakesByKind: Map<string, number>;
  /** DeliveryClass, or "unclassed" when no regime configured -> sends. */
  sendsByClass: Map<string, number>;
  /** Sender agent id -> interrupts it bought. */
  interruptsBySender: Map<string, number>;
  /** Sender agent id -> interrupts it asked for and did not get. */
  downgradedInterrupts: Map<string, number>;
}

/**
 * Increment one comms counter.
 *
 * Every consumer wants "add one to this key", and writing that out at each
 * site is how one of them ends up assigning instead of adding — which for a
 * counter is indistinguishable from a correct zero until the run is long
 * enough to have counted something twice.
 */
export function bumpComms(counter: Map<string, number>, key: string): void {
  counter.set(key, (counter.get(key) ?? 0) + 1);
}

export interface ModelSpend {
  model: string;
  tokens: number;
  input: number;
  output: number;
  /** Replayed transcript tokens: recorded but never billed. */
  cacheRead: number;
  turns: number;
  agents: Set<string>;
}

export function createInitialState(): Projections {
  return {
    goals: new Map(),
    activeGoalId: null,
    agents: new Map(),
    artifacts: new Map(),
    artifactByName: new Map(),
    artifactHistory: new Map(),
    threads: new Map(),
    messages: new Map(),
    unread: new Map(),
    tasks: new Map(),
    decisions: new Map(),
    approvals: new Map(),
    escalations: new Map(),
    budgets: new Map(),
    leases: new Map(),
    activeLeaseByArtifact: new Map(),
    memory: new Map(),
    continuity: new Map(),
    sessionOrdinal: new Map(),
    pendingRequests: new Map(),
    collabSessions: new Map(),
    discharged: [],
    refusedSends: [],
    deniedActions: [],
    mailOverflowDropped: new Map(),
    conflicts: new Map(),
    reviewRounds: new Map(),
    messageFingerprints: new Map(),
    lastEventSeq: 0,
    lastEventAt: null,
    eventCount: 0,
    eventsSinceActivation: new Map(),
    sessionMap: new Map(),
    goalHistory: [],
    progress: new Map(),
    turnAudit: new Map(),
    modelSpend: new Map(),
    comms: {
      wakesByKind: new Map(),
      sendsByClass: new Map(),
      interruptsBySender: new Map(),
      downgradedInterrupts: new Map(),
    },
  };
}

export function getBudget(state: Projections, key: string): BudgetLedger | undefined {
  return state.budgets.get(key);
}

export function ensureBudget(
  state: Projections,
  key: string,
  limitKind: BudgetProjectionEntry["limitKind"],
  limit: number | null,
): BudgetLedger {
  let b = state.budgets.get(key);
  if (!b) {
    b = { key, limitKind, limit, reserved: 0, consumed: 0, exceeded: false, reservations: new Map() };
    state.budgets.set(key, b);
  } else if (b.limit === null && limit !== null) {
    b.limit = limit;
  }
  return b;
}

export function artifactKey(type: string, name: string): string {
  return `${type}:${name}`;
}

export function approvalKey(subject: string, kind: string): string {
  return `${subject}::${kind}`;
}

/** Bounded-state caps: projections must never grow without bound. */
export const MAX_UNREAD_PER_AGENT = 200;
export const MAX_FINGERPRINTS_PER_THREAD = 500;
export const MAX_PENDING_REQUESTS = 1000;
export const MAX_ARTIFACT_HISTORY = 100;
export const MAX_CONFLICTS = 500;
export const MAX_DISCHARGE_HISTORY = 500;
/**
 * Tighter than `MAX_DISCHARGE_HISTORY` because refusals arrive in storms, not
 * in ones: the shape that fills this ring is a misconfigured rule denying
 * every send a seat attempts, and the two hundredth identical refusal tells an
 * operator nothing the second did not.
 */
export const MAX_REFUSED_SENDS = 200;

/**
 * Independent of `MAX_REFUSED_SENDS` on purpose, even though the two happen to
 * be equal today. They bound different rings holding different questions, and
 * the reason one of them is tight — refusals arrive in storms — applies harder
 * here: an op rule that denies every turn fills this in minutes. Tuning one
 * must never be a decision about the other.
 */
export const MAX_DENIED_ACTIONS = 200;

/**
 * L2 memory was the one projection missing from the caps above, and the only
 * one fed automatically: the supervisor writes a note under a unique
 * `turn:<id>` key after every successful turn. Uncapped, that map grew by one
 * entry per turn for the life of a mission, was re-rendered in full into every
 * later prompt, and was serialized into every snapshot — so prompt size grew
 * linearly in turns and total tokens quadratically, defeating the item caps
 * every other context section already carried.
 *
 * Auto-written and agent-authored notes get SEPARATE budgets deliberately.
 * Under one shared cap a long run's turn summaries would evict the notes an
 * agent explicitly chose to keep, which is a worse failure than the growth:
 * the mesh would silently forget what it was told to remember. Turn exhaust is
 * also the cheaper of the two to lose — `recentOwnActivity` already covers
 * recent-turn ground in the same prompt.
 */
export const AUTO_MEMORY_PREFIX = "turn:";
export const MAX_AUTO_MEMORY = 10;
export const MAX_AGENT_MEMORY = 30;
export const MAX_MEMORY_VALUE_CHARS = 2000;

/**
 * Continuity caps. Tighter than the memory caps above because a continuity
 * record is read whole, at the top of the successor's very first prompt, when
 * it has the least context to spend and the most to gain. A record that has to
 * be truncated by the renderer is one that arrived too late to be edited.
 */
export const MAX_CONTINUITY_BELIEFS = 8;
export const MAX_CONTINUITY_REJECTIONS = 8;
export const MAX_CONTINUITY_COMMITMENTS = 12;
export const MAX_CONTINUITY_TEXT = 500;

/**
 * Bookkeeping slot recording how many turn summaries have been dropped. It is
 * neither auto nor authored and counts against neither budget.
 *
 * There is deliberately no digest of the dropped notes. Folding them into one
 * concatenated string would be compaction in name only — without a model you
 * cannot compress meaning, only join and truncate, which is what eviction
 * already does, at the cost of machinery that merely looks like progress. What
 * an agent actually needs is the same thing a truncated artifact read gives it:
 * knowledge that something is missing, so it does not mistake the window it has
 * for the whole history. Real summarization is a model call and a deliberate
 * spend; this is the honest cheap half.
 */
export const ELIDED_MEMORY_KEY = "memory:elided";

export function isAutoMemoryNote(key: string): boolean {
  return key.startsWith(AUTO_MEMORY_PREFIX);
}

/**
 * Evict oldest-first within each class until both are under budget.
 *
 * Deterministic on replay, which a reducer requires: JS Maps iterate in
 * insertion order, and the caller deletes before re-setting an existing key so
 * that order tracks LAST write rather than first. Replaying the same log
 * therefore evicts the same notes in the same sequence.
 */
export function evictMemory(m: Map<string, AgentMemoryNote>, agentId: string, at: string): void {
  const auto: string[] = [];
  const authored: string[] = [];
  for (const key of m.keys()) {
    if (key === ELIDED_MEMORY_KEY) continue;
    (isAutoMemoryNote(key) ? auto : authored).push(key);
  }

  const dropAuto = auto.slice(0, Math.max(0, auto.length - MAX_AUTO_MEMORY));
  const dropAuthored = authored.slice(0, Math.max(0, authored.length - MAX_AGENT_MEMORY));
  for (const key of dropAuto) m.delete(key);
  for (const key of dropAuthored) m.delete(key);

  const dropped = dropAuto.length + dropAuthored.length;
  if (dropped === 0) return;
  const marker = m.get(ELIDED_MEMORY_KEY);
  const before = marker ? Number.parseInt(marker.value, 10) || 0 : 0;
  const total = before + dropped;
  m.delete(ELIDED_MEMORY_KEY);
  m.set(ELIDED_MEMORY_KEY, {
    agentId,
    key: ELIDED_MEMORY_KEY,
    value: String(total),
    updatedAt: at,
    eventId: "",
  } as AgentMemoryNote);
}

/**
 * The single place an ask leaves the ledger.
 *
 * Every discharge path funnels through here so that (a) the reason is always
 * recorded, and (b) there is exactly one line to audit when asking "how can a
 * pending request disappear?" — previously the answer was eight scattered
 * `pendingRequests.delete(...)` calls across four files, four of which ran
 * OUTSIDE the reducer and therefore did not survive replay.
 */
export function dischargeCommitment(
  state: Projections,
  messageId: MessageId,
  reason: DischargeReason,
  by: string,
  at: string,
  viaMessageId?: MessageId,
  /**
   * Verdict on the answering payload, when there was an answer to judge.
   * Computed by the caller (the reducer holds the reply message; this
   * function holds only ids) and recorded verbatim.
   */
  response?: ResponseCheck,
): DischargeRecord | null {
  const pr = state.pendingRequests.get(messageId);
  if (!pr) return null;

  // One debtor answering discharges THEIR obligation, not everyone else's.
  // `by` is the agent whose debt is being settled; a runtime-level reason
  // (operator, supersede, deadlock break, capacity) settles the whole ask,
  // because those are decisions about the ask itself rather than an answer
  // from one debtor.
  const outstanding = outstandingDebtors(pr);
  const perDebtor = PER_DEBTOR_DISCHARGE_REASONS.has(reason);
  if (perDebtor && !outstanding.includes(by) && pr.to.includes(by)) {
    // `by` was addressed but has already answered. A second reply settles
    // nothing — and without this guard it would fall through to the
    // whole-ask path and silently close the debts of everyone still silent.
    //
    // Note the deliberate asymmetry with a discharger who was NEVER a debtor
    // (the human operator answering on a dead agent's behalf, or the runtime
    // acting as "system"): that is an outside resolution of the ask itself,
    // so it settles the whole thing.
    return null;
  }
  const remaining = perDebtor && outstanding.includes(by) ? outstanding.filter((d) => d !== by) : [];

  if (remaining.length > 0) {
    // Partial: the ask stays on the ledger owed by the agents who have still
    // said nothing, so nudges, stalemate detection and the wait-for graph all
    // keep pointing at them.
    pr.outstanding = remaining;
    const partial: DischargeRecord = {
      messageId, from: pr.from, to: pr.to, type: pr.type, reason, by, at, viaMessageId, partial: true, remaining: [...remaining],
      ...response,
    };
    pushBounded(state.discharged, partial, MAX_DISCHARGE_HISTORY);
    return partial;
  }

  state.pendingRequests.delete(messageId);
  const record: DischargeRecord = { messageId, from: pr.from, to: pr.to, type: pr.type, reason, by, at, viaMessageId, ...response };
  pushBounded(state.discharged, record, MAX_DISCHARGE_HISTORY);
  return record;
}

/**
 * Reasons that settle ONE debtor's obligation rather than the whole ask.
 *
 * These are all "an agent responded" paths. Everything else — an operator
 * answering or dropping it, a newer artifact version superseding the review,
 * the task completing, a deadlock break, ledger capacity, the asker
 * withdrawing — is a decision about the ask itself and closes it for every
 * debtor at once.
 *
 * `withdrawn_by_sender` belongs to that second group and is absent below: an
 * asker closing its own ask is a statement about the ask, not one debtor's
 * share of it, so it must release the reviewers who have not answered as
 * surely as the one who did.
 */
export const PER_DEBTOR_DISCHARGE_REASONS: ReadonlySet<DischargeReason> = new Set<DischargeReason>([
  "reply",
  "in_thread",
  "artifact_review",
  // One of three reviewers declining settles that reviewer's obligation and
  // nothing else — the other two still owe an answer, and the asker must keep
  // being told so. `expired` is NOT here: a deadline is a property of the ask,
  // so when it passes it passes for every debtor at once.
  "refused",
]);

/**
 * Who still owes an answer on this ask.
 *
 * Every consumer that asks "does X owe me something?" must read THIS, not
 * `pr.to`: `to` is the original address list and never shrinks, so after one
 * of three reviewers replies it still claims all three are on the hook —
 * nudging agents who already answered and mis-drawing the wait-for graph.
 *
 * Falls back to `to` for entries written before per-debtor tracking existed,
 * so replaying an old log reproduces the behavior that log was created under.
 */
export function outstandingDebtors(pr: PendingRequest): string[] {
  return pr.outstanding ?? pr.to;
}

/** Does `agentId` still owe an answer on this ask? */
export function stillOwes(pr: PendingRequest, agentId: string): boolean {
  return outstandingDebtors(pr).includes(agentId);
}

/**
 * How long a debtor's silence may hold a creditor open, per debtor role.
 *
 * `default` applies when no role matches and when the debtor is not a known
 * agent (the human operator, a seat that has since been retired). Zero or
 * absent means no deadline — the pre-deadline behaviour, kept reachable so a
 * mission that genuinely wants unbounded asks can say so.
 */
export interface CommitmentTtlConfig {
  defaultMs?: number;
  byRole?: Record<string, number>;
}

/**
 * The deadline an ask opens with, or undefined for "no deadline".
 *
 * Takes the LONGEST TTL among the debtors' roles. An ask addressed to a
 * reviewer and an architect is not overdue until the slower of the two has
 * had its time — expiring on the faster one would close an obligation the
 * other agent is still legitimately working on, which is the exact failure
 * (`evicted_cap`) that made every other consumer of this ledger draw a wrong
 * conclusion.
 */
export function computeDueBy(
  state: Projections,
  debtors: string[],
  createdAt: string,
  ttl?: CommitmentTtlConfig,
  contractSlaMs?: number,
): string | undefined {
  // Unchanged: no configured TTL means no deadline. A contract's SLA NARROWS an
  // existing deadline regime; it must not create one, because expiry is an
  // operator's choice and a mesh should not inherit deadlines from an upgrade.
  if (!ttl) return undefined;
  let longest = 0;
  for (const debtor of debtors) {
    const role = state.agents.get(debtor)?.definition.role;
    // Precedence: the operator's explicit per-role number, then the contract's
    // own SLA, then the mesh-wide default. The role override wins because it is
    // the most specific thing the OPERATOR said; the contract beats the default
    // because a cheap question and an expensive review should not share a clock.
    const roleMs = role !== undefined ? ttl.byRole?.[role] : undefined;
    const ms = roleMs ?? (contractSlaMs && contractSlaMs > 0 ? contractSlaMs : undefined) ?? ttl.defaultMs ?? 0;
    if (ms > longest) longest = ms;
  }
  if (longest <= 0) return undefined;
  const base = Date.parse(createdAt);
  // A message with an unparseable timestamp is a bug elsewhere; giving it a
  // NaN deadline would make it instantly and permanently overdue.
  if (!Number.isFinite(base)) return undefined;
  return new Date(base + longest).toISOString();
}

/**
 * Asks whose deadline has passed, oldest first.
 *
 * Identifies only — it does not discharge. Expiry has to leave the ledger
 * through a `commitment.discharged` EVENT, like every other out-of-reducer
 * close, or a rebuilt state would keep asks the live mesh had already expired
 * and the "replay is equivalent" invariant would stop holding.
 *
 * Honours the same escalation protection as cap eviction: an ask an operator
 * is already looking at is not reaped out from under them. Their card is the
 * deadline now.
 */
export function overdueCommitments(state: Projections, nowMs: number): PendingRequest[] {
  const protectedIds = escalatedRequestIds(state);
  const out: PendingRequest[] = [];
  for (const pr of state.pendingRequests.values()) {
    if (pr.dueBy === undefined) continue;
    if (protectedIds.has(pr.messageId)) continue;
    const due = Date.parse(pr.dueBy);
    if (Number.isFinite(due) && due <= nowMs) out.push(pr);
  }
  return out.sort((a, b) => Date.parse(a.dueBy!) - Date.parse(b.dueBy!));
}

/**
 * Is the ledger too full to take another ask?
 *
 * Backpressure at open, rather than eviction at overflow. Dropping the OLDEST
 * ask to make room for the newest is precisely backwards: insertion order is
 * roughly chronological, so the entries eviction reaches first are the ones
 * that have been waiting longest — the most likely to be genuinely stuck, and
 * the ones whose loss hides a real deadlock. Refusing the new ask instead
 * costs the asker one immediate, visible failure and loses nothing.
 */
export function ledgerAtCapacity(state: Projections): boolean {
  return state.pendingRequests.size >= MAX_PENDING_REQUESTS;
}

/**
 * Ask-ledger overflow, handled as a discharge instead of a silent delete.
 *
 * Now a LAST RESORT rather than the primary mechanism: `ledgerAtCapacity`
 * refuses to open an ask once the map is full, so in a live mesh this finds
 * nothing to do. It still runs because a map can arrive over cap by other
 * routes — importing a snapshot written before refusal-to-open existed, or a
 * lowered `MAX_PENDING_REQUESTS` — and in those cases the old behaviour is
 * still the least-bad one available.
 *
 * The cap used to `pendingRequests.delete(...)` directly, which is the one
 * thing `dischargeCommitment`'s contract forbids. Three consumers read this
 * map and each drew a wrong conclusion from a raw delete:
 *
 *  - `DeadlockDetector.scanWaitCycles` builds the wait-for graph from it, so
 *    an evicted edge makes a provable circular wait undetectable — and the
 *    oldest entries (which insertion order evicts first) are exactly the ones
 *    most likely to be genuinely stuck.
 *  - `buildAgentContext` derives `owedByYou` / `awaitingResponse` from it, so
 *    the agent stops being told it owes an answer.
 *  - `reconcileEscalations` treats "no longer pending" as "answered or
 *    withdrawn" and auto-resolves the operator's card with that claim —
 *    eviction turned a stuck ask into a false statement in the audit log.
 *
 * Two rules follow. Asks that an OPEN escalation still points at are never
 * evicted (the card must outlive the pressure that caused it), and every
 * eviction is recorded with `reason: "evicted_cap"`, which
 * `UNANSWERED_DISCHARGE_REASONS` marks as "gone, not answered".
 */
export function evictOverflowingPendingRequests(state: Projections, at: string): DischargeRecord[] {
  const overflow = state.pendingRequests.size - MAX_PENDING_REQUESTS;
  if (overflow <= 0) return [];

  const protectedIds = escalatedRequestIds(state);
  const evicted: DischargeRecord[] = [];
  // Insertion order ~= chronological, so this drops oldest-first, skipping
  // anything an operator is already looking at.
  for (const messageId of state.pendingRequests.keys()) {
    if (evicted.length >= overflow) break;
    if (protectedIds.has(messageId)) continue;
    evicted.push({ messageId } as DischargeRecord);
  }
  const out: DischargeRecord[] = [];
  for (const { messageId } of evicted) {
    const rec = dischargeCommitment(state, messageId, "evicted_cap", "system", at);
    if (rec) out.push(rec);
  }
  // Every remaining ask is escalation-protected: the ledger stays over cap
  // rather than deleting an ask an operator was asked to resolve. Bounded by
  // MAX_OPEN escalation pressure, not by message volume.
  return out;
}

/** Message ids that an OPEN escalation card is waiting on. */
function escalatedRequestIds(state: Projections): Set<MessageId> {
  const ids = new Set<MessageId>();
  for (const esc of state.escalations.values()) {
    if (esc.status !== "OPEN") continue;
    const d = (esc.detail ?? {}) as Record<string, unknown>;
    if (typeof d.requestMessageId === "string") ids.add(d.requestMessageId);
    const m = /^stuck:(.+):([^:]+)$/.exec(String(esc.conflictKey ?? ""));
    if (m) ids.add(m[1]);
  }
  return ids;
}

export function pushBounded<T>(arr: T[], item: T, max: number): T[] {
  arr.push(item);
  if (arr.length > max) arr.splice(0, arr.length - max);
  return arr;
}

export function setBounded<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  if (!map.has(key) && map.size >= max) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

/**
 * The messages a seat is actually holding, in box order.
 *
 * The one place that answers "what is in this mailbox", so that the six
 * callers that each wrote their own `.map(get).filter(Boolean)` cannot drift
 * apart. O(box), bounded by `MAX_UNREAD_PER_AGENT`.
 */
export function resolveUnread(state: Projections, agentId: string): MeshMessage[] {
  const out: MeshMessage[] = [];
  for (const id of state.unread.get(agentId) ?? []) {
    const m = state.messages.get(id);
    if (m) out.push(m);
  }
  return out;
}

/**
 * How much mail a seat can actually open.
 *
 * NOT the same as `state.unread.get(agentId).length`, and the difference is
 * the whole reason this function exists. A box can hold an id with no message
 * behind it: `importState` screens for exactly that, so the snapshot can no
 * longer *create* one, but nothing stops a projection from being handed one
 * directly -- `tests/core/state.test.ts` asserts a box may hold a dangler and
 * that it "must not consume a slot". Such an id is not mail: nobody can read
 * it, nobody can discharge it, and a seat shown `mailbox=3` when it can open
 * two has been handed a number it cannot act on.
 *
 * Which is why this counts, deliberately, for the question *can you read it*
 * -- the attention signal, the wake gates, and the depth in the agent's own
 * prompt. It is NOT the accounting question. `run-report.ts` asks *were you
 * owed it* and counts raw ids on purpose: "the mail was owed whether or not
 * its body survived." Both are right, about different things.
 */
export function readableMailDepth(state: Projections, agentId: string): number {
  const box = state.unread.get(agentId);
  if (!box?.length) return 0;
  let n = 0;
  for (const id of box) if (state.messages.has(id)) n += 1;
  return n;
}

/**
 * How many messages one snapshot carries.
 *
 * A hard ceiling on the exported array rather than a floor under the tail:
 * `exportMessages` spends this budget on owed mail first and fills the rest
 * with the newest messages, so the array is never longer than this however
 * deep the mailboxes are.
 */
export const MAX_SNAPSHOT_MESSAGES = 2000;

/**
 * The newest `MAX_SNAPSHOT_MESSAGES` messages, plus every older message still
 * sitting in somebody's mailbox.
 *
 * A plain tail slice loses the BODY of any unread message older than the tail,
 * while `unread` is carried verbatim -- so that id comes back pointing at
 * nothing. The dangling id is not sticky: the supervisor emits
 * `message.delivered` for every id in the box without resolving it first, and
 * `buildAgentContext` drops ids it cannot resolve from the rendered inbox. But
 * until that next turn the agent's `mailbox=N` over-counts by the dangling
 * ids, and the mail itself is simply gone -- a message somebody was owed,
 * deleted by the restart that was supposed to preserve it.
 *
 * Owed mail therefore outranks mere recency WITHIN the same budget instead of
 * being added on top of it. The union has to stay bounded: a box is capped per
 * agent (`MAX_UNREAD_PER_AGENT`) but the agent count is not, so "the tail plus
 * everything owed" grows with the size of the mesh. Paying for the old owed
 * messages with the oldest of the tail is near-free -- outside the
 * pathological case the trade costs a handful of the least recent messages
 * nobody is waiting on, and when nothing is owed from outside the tail the
 * result is byte-for-byte the tail slice this replaced.
 *
 * When the boxes alone exceed the whole budget (upwards of ten agents each
 * sitting on a full 200-deep box), the newest owed mail wins and the oldest
 * owed mail is dropped: the same oldest-first rule `MAX_UNREAD_PER_AGENT`
 * already applies to the box itself, so the overflow degrades to the
 * dangling-id behaviour that was the status quo rather than to an unbounded
 * snapshot.
 */
function exportMessages(state: Projections): MeshMessage[] {
  const all = [...state.messages.values()];
  if (all.length <= MAX_SNAPSHOT_MESSAGES) return all;

  const owedIds = new Set<MessageId>();
  for (const ids of state.unread.values()) for (const id of ids) owedIds.add(id);

  const owed: MeshMessage[] = [];
  const rest: MeshMessage[] = [];
  for (const m of all) (owedIds.has(m.id) ? owed : rest).push(m);

  const keptOwed = owed.slice(-MAX_SNAPSHOT_MESSAGES);
  const restBudget = MAX_SNAPSHOT_MESSAGES - keptOwed.length;
  // Guarded rather than `slice(-restBudget)`: `slice(-0)` is `slice(0)`, which
  // would return the entire history precisely when there is no room for any of
  // it.
  const keptRest = restBudget > 0 ? rest.slice(-restBudget) : [];

  const keep = new Set<MessageId>();
  for (const m of keptOwed) keep.add(m.id);
  for (const m of keptRest) keep.add(m.id);
  // One filtering pass over the history, so the export keeps insertion order
  // and cannot duplicate an owed message that was inside the tail already:
  // `messages` is keyed by id, so each message lands in exactly one partition.
  return all.filter((m) => keep.has(m.id));
}

/** Plain-object snapshot of Projections (Maps -> arrays) for SnapshotStore. */
export function exportState(state: Projections): {
  goals: unknown[];
  activeGoalId: unknown;
  agents: unknown[];
  artifacts: unknown[];
  threads: unknown[];
  messages: unknown[];
  unread: unknown[];
  tasks: unknown[];
  decisions: unknown[];
  approvals: unknown[];
  escalations: unknown[];
  budgets: unknown[];
  leases: unknown[];
  memory: unknown[];
  continuity: unknown[];
  sessionOrdinal: unknown[];
  pendingRequests: unknown[];
  collabSessions: unknown[];
  discharged: unknown[];
  refusedSends: unknown[];
  deniedActions: unknown[];
  mailOverflowDropped: unknown[];
  reviewRounds: unknown[];
  conflicts: unknown[];
  modelSpend: unknown[];
  comms?: {
    wakesByKind?: unknown[];
    sendsByClass?: unknown[];
    interruptsBySender?: unknown[];
    downgradedInterrupts?: unknown[];
  };
  eventCount: number;
  throughSeq: number;
} {
  return {
    goals: [...state.goals.values()],
    activeGoalId: state.activeGoalId,
    agents: [...state.agents.values()],
    artifacts: [...state.artifacts.values()],
    threads: [...state.threads.values()],
    // The newest messages, plus the body of anything still owed. See
    // `exportMessages`: a mailbox id whose body missed the cut is mail nobody
    // can ever be handed again.
    messages: exportMessages(state),
    // Carried rather than rebuilt, because there is nothing left to rebuild it
    // from: the tail replay after a restore starts STRICTLY above `throughSeq`,
    // so every `message.sent` at or below the cut is never applied again. A box
    // left out of the snapshot is an agent whose unread mail is silently
    // deleted by the restart that was supposed to preserve it.
    unread: [...state.unread.entries()],
    tasks: [...state.tasks.values()],
    decisions: [...state.decisions.values()],
    approvals: [...state.approvals.values()],
    escalations: [...state.escalations.values()],
    budgets: [...state.budgets.values()].map((b) => ({ ...b, reservations: [...b.reservations] })),
    leases: [...state.leases.values()],
    memory: [...state.memory.entries()].map(([k, v]) => [k, [...v.entries()]]),
    continuity: [...state.continuity.values()],
    sessionOrdinal: [...state.sessionOrdinal.entries()],
    pendingRequests: [...state.pendingRequests.values()],
    collabSessions: [...state.collabSessions.values()],
    discharged: [...state.discharged],
    refusedSends: [...state.refusedSends],
    // Carried for the same reason `refusedSends` is: a restart that forgets
    // what policy refused makes a mesh strangled by its own rules look like a
    // mesh with nothing to do, and the restart is exactly when an operator is
    // looking.
    deniedActions: [...state.deniedActions],
    // A cap-dropped count that does not survive a restart is a cap-dropped
    // count that resets to zero every time the mesh is resumed, which would
    // make a flooded mailbox look clean in exactly the run that flooded it.
    mailOverflowDropped: [...state.mailOverflowDropped.entries()],
    reviewRounds: [...state.reviewRounds.entries()],
    conflicts: [...state.conflicts.values()],
    // Sets do not survive JSON; the agent list is small and worth keeping.
    modelSpend: [...state.modelSpend.values()].map((m) => ({ ...m, agents: [...m.agents] })),
    // Carried for the same reason `mailOverflowDropped` is: a counter that
    // resets on every restart would make the run that resumed the most look
    // like the run that talked the least. The savepoint is mid-mission, which
    // is exactly when these are non-zero and exactly when they matter.
    comms: {
      wakesByKind: [...state.comms.wakesByKind.entries()],
      sendsByClass: [...state.comms.sendsByClass.entries()],
      interruptsBySender: [...state.comms.interruptsBySender.entries()],
      downgradedInterrupts: [...state.comms.downgradedInterrupts.entries()],
    },
    eventCount: state.eventCount,
    throughSeq: state.lastEventSeq,
  };
}

export function importState(state: Projections, data: {
  goals?: unknown[];
  activeGoalId?: unknown;
  agents?: unknown[];
  artifacts?: unknown[];
  threads?: unknown[];
  messages?: unknown[];
  unread?: Array<[string, string[]]>;
  tasks?: unknown[];
  decisions?: unknown[];
  approvals?: unknown[];
  escalations?: unknown[];
  budgets?: Array<Record<string, unknown>>;
  leases?: unknown[];
  memory?: Array<[string, Array<[string, unknown]>]>;
  continuity?: unknown[];
  sessionOrdinal?: Array<[string, number]>;
  pendingRequests?: unknown[];
  collabSessions?: unknown[];
  discharged?: unknown[];
  refusedSends?: unknown[];
  deniedActions?: unknown[];
  mailOverflowDropped?: Array<[string, number]>;
  reviewRounds?: unknown[];
  conflicts?: unknown[];
  modelSpend?: unknown[];
  comms?: {
    wakesByKind?: Array<[string, number]>;
    sendsByClass?: Array<[string, number]>;
    interruptsBySender?: Array<[string, number]>;
    downgradedInterrupts?: Array<[string, number]>;
  };
  eventCount?: number;
  throughSeq?: number;
}): void {
  const fresh = createInitialState();
  Object.assign(state, fresh);
  for (const g of (data.goals ?? []) as Array<{ id: string }>) state.goals.set(g.id as never, g as never);
  for (const a of (data.agents ?? []) as Array<{ definition: { id: string } }>) state.agents.set(a.definition.id, a as never);
  for (const a of (data.artifacts ?? []) as Array<{ id: string }>) {
    const art = a as { id: string; type: string; name: string };
    state.artifacts.set(art.id as never, a as never);
    state.artifactByName.set(artifactKey(art.type, art.name), a as never);
    state.artifactHistory.set(art.id as never, [a] as never);
  }
  for (const t of (data.threads ?? []) as Array<{ id: string }>) state.threads.set(t.id as never, t as never);
  for (const m of (data.messages ?? []) as Array<{ id: string }>) state.messages.set(m.id as never, m as never);
  // Screened like `sessionOrdinal` below: a snapshot written before this field
  // existed has no entries at all, and a corrupt one must not be able to put a
  // number or an object where a MessageId belongs -- an id that is not a string
  // resolves to no message, so it would sit in the box inflating the depth
  // until a turn delivered it away.
  //
  // Screened against `messages` as well, and that half is not about corruption:
  // `exportMessages` caps the history at MAX_SNAPSHOT_MESSAGES and partitions
  // by what is OWED first, but `keptOwed` is itself a `slice(-cap)` — with
  // enough seats at MAX_UNREAD_PER_AGENT each, owed mail alone overruns the
  // budget and the codec drops some. Those ids come back pointing at nothing.
  // Keeping them does not recover the mail; it only makes `mailboxDepth` lie,
  // and a box of nothing but danglers buys a wake for a turn that renders zero
  // messages. So drop them — and COUNT them, into the same counter the
  // MAX_UNREAD_PER_AGENT cap uses, because this is the same event: mail that
  // ceased to exist with nobody told. An uncounted drop here would be the one
  // silent-loss path left in the delivery chain.
  //
  // Requires `messages` to be loaded first, which it is, immediately above.
  for (const [agentId, ids] of (data.unread ?? []) as Array<[string, string[]]>) {
    if (typeof agentId !== "string" || !Array.isArray(ids)) continue;
    const kept = ids.filter((id) => typeof id === "string" && state.messages.has(id as never));
    const lost = ids.length - kept.length;
    if (lost > 0) state.mailOverflowDropped.set(agentId, (state.mailOverflowDropped.get(agentId) ?? 0) + lost);
    state.unread.set(agentId, kept as never);
  }
  // `mailboxDepth` is not its own key: it rides along inside each exported
  // agent record, so it comes back saying whatever the live mesh last wrote.
  // Re-deriving it from the box restored above is what stops the two from
  // disagreeing -- an older snapshot carries depths with no mail behind them,
  // and that number is what the agent is shown as `mailbox=N` in its prompt.
  for (const [agentId, rec] of state.agents) {
    if (rec?.state) rec.state.mailboxDepth = readableMailDepth(state, agentId);
  }
  for (const t of (data.tasks ?? []) as Array<{ id: string } & { id: string }>) state.tasks.set((t as { id: string }).id, t as never);
  for (const d of (data.decisions ?? []) as Array<{ id: string }>) state.decisions.set(d.id, d as never);
  for (const list of (data.approvals ?? []) as Array<Array<{ subject: string; kind: string }>>) {
    const first = (list as unknown[])[0] as { subject: string; kind: string } | undefined;
    if (first) state.approvals.set(approvalKey(first.subject, first.kind), list as never);
  }
  for (const e of (data.escalations ?? []) as Array<{ id: string }>) state.escalations.set(e.id, e as never);
  for (const b of (data.budgets ?? [])) {
    const rec = b as unknown as { key: string; reservations?: Array<[string, number]> };
    state.budgets.set(rec.key, { ...(rec as object), reservations: new Map(rec.reservations ?? []) } as never);
  }
  for (const l of (data.leases ?? []) as Array<{ id: string }>) state.leases.set(l.id as never, l as never);
  // Derived rather than exported, the way `artifactByName` is: this map is only
  // ever an index into `leases`, which the snapshot already carries in full.
  // Rebuilding it here is what keeps a restore from dropping the single-writer
  // invariant -- an unreleased lease that no index points at is a lease
  // `lease.acquired` cannot see, so the next agent to ask for that artifact is
  // handed it while someone else is still holding it. `releasedAt` is the
  // release marker for both exits (an explicit `lease.released` and the
  // implicit one when an artifact reaches MERGED), and a later entry wins
  // because the reducer's index is last-acquire-wins too.
  for (const lease of state.leases.values()) {
    if (lease.releasedAt) continue;
    state.activeLeaseByArtifact.set(lease.artifactId, lease.id);
  }
  for (const [k, entries] of (data.memory ?? [])) state.memory.set(k, new Map(entries as Array<[string, never]>));
  for (const r of (data.continuity ?? []) as ContinuityRecord[]) {
    if (r && typeof r.agentId === "string") state.continuity.set(r.agentId, r);
  }
  for (const [k, n] of (data.sessionOrdinal ?? []) as Array<[string, number]>) {
    if (typeof k === "string" && Number.isFinite(n)) state.sessionOrdinal.set(k, n);
  }
  if (typeof data.activeGoalId === "string" && data.activeGoalId) state.activeGoalId = data.activeGoalId as never;
  for (const pr of (data.pendingRequests ?? []) as Array<{ messageId: string }>) {
    state.pendingRequests.set((pr as { messageId: string }).messageId as never, pr as never);
  }
  // Restored like every other map: a snapshot that dropped these would let a
  // restarted mission hold an unbounded collab that no sweep can ever find.
  for (const cs of (data.collabSessions ?? []) as Array<{ threadId: string }>) {
    state.collabSessions.set(cs.threadId as never, cs as never);
  }
  state.discharged = [...((data.discharged ?? []) as DischargeRecord[])];
  state.refusedSends = [...((data.refusedSends ?? []) as RefusedSend[])];
  state.deniedActions = [...((data.deniedActions ?? []) as DeniedAction[])];
  // Screened like `sessionOrdinal` above: a snapshot written before this field
  // existed has no entries, and a corrupt one must not put NaN where a count
  // belongs — a NaN drop count poisons every sum a report takes of it.
  // Added to rather than assigned: the unread screen above runs first and may
  // already have counted danglers this same restore dropped. `importState`
  // normally fills a state straight out of `createInitialState`, so every
  // other key here is 0 and this reads as a plain assignment -- it differs
  // only in the one case where it must.
  for (const [k, n] of (data.mailOverflowDropped ?? []) as Array<[string, number]>) {
    if (typeof k === "string" && Number.isFinite(n)) {
      state.mailOverflowDropped.set(k, (state.mailOverflowDropped.get(k) ?? 0) + n);
    }
  }
  for (const [k, v] of (data.reviewRounds ?? []) as Array<[string, number]>) state.reviewRounds.set(k as never, v as never);
  for (const c of (data.conflicts ?? []) as Array<{ key: string }>) state.conflicts.set((c as { key: string }).key as never, c as never);
  for (const m of (data.modelSpend ?? []) as Array<Record<string, unknown>>) {
    const model = String(m.model ?? "");
    if (!model) continue;
    state.modelSpend.set(model, {
      model,
      tokens: Number(m.tokens ?? 0),
      input: Number(m.input ?? 0),
      output: Number(m.output ?? 0),
      cacheRead: Number(m.cacheRead ?? 0),
      turns: Number(m.turns ?? 0),
      agents: new Set((m.agents ?? []) as string[]),
    });
  }
  // Screened exactly like `mailOverflowDropped`, and for the same reason: a
  // snapshot written before this field existed has no entries, and a corrupt
  // one must not put a NaN where a count belongs. Added to rather than
  // assigned so a restore that already bumped something above is not undone.
  for (const field of ["wakesByKind", "sendsByClass", "interruptsBySender", "downgradedInterrupts"] as const) {
    for (const [k, n] of (data.comms?.[field] ?? []) as Array<[string, number]>) {
      if (typeof k === "string" && Number.isFinite(n)) {
        const m = state.comms[field];
        m.set(k, (m.get(k) ?? 0) + n);
      }
    }
  }
  if (typeof data.eventCount === "number" && Number.isFinite(data.eventCount)) state.eventCount = data.eventCount;
  if (data.throughSeq !== undefined) state.lastEventSeq = data.throughSeq;
}
