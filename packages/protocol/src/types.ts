export type MessageId = string;
export type EventId = string;
export type AgentId = string;
export type GoalId = string;
export type ThreadId = string;
export type ArtifactId = string;
export type TaskId = string;
export type DecisionId = string;
export type EscalationId = string;
export type LeaseId = string;
/**
 * One logical run of a goal: `<goalId>#<n>`, where `n` starts at 1 and
 * increments on every `goal.reopened`.
 *
 * A goal that is reopened keeps its id, its artifacts, its decisions and its
 * ratified evidence — so "which run was this judged in?" had no answer, and
 * the runtime could not tell work that had already been rejected from work
 * produced in answer to the rejection. That was patched twice, identity-side
 * (`AcceptanceCriterion.rejectedEvidence`) and time-side (`Goal.reopenedAt`),
 * each time for one specific fact. Stamping the episode makes it a field
 * lookup instead of a bug class.
 */
export type EpisodeId = string;

export const PROTOCOL_VERSION = "1.0";

export type RuntimeTypeName = string;

/**
 * Operator intent for a project's artifact-storage mode, carried verbatim from
 * argv through the host to the child process.
 *
 * Three-valued on purpose. "auto" means the operator expressed no preference
 * and `mesh.workspace.git` decides; collapsing it to a boolean anywhere before
 * boot would turn "unspecified" into "off" and silently disable git for every
 * project whose config leaves the key out. The default is applied once, in
 * `bootstrapMesh`, by `resolveUseGit`.
 */
export type GitMode = "on" | "off" | "auto";

export type AgentMode = "peer" | "service";

/**
 * How much attention an event deserves in an operator-facing view.
 *
 * Derived from `EventType` through `EVENT_SEVERITY` rather than carried on the
 * wire, for two reasons: `eventSchema` sets `additionalProperties: false`, so a
 * new field on `MeshEvent` makes `JsonlEventStore.append` throw; and deriving it
 * means every event already on disk gets a severity retroactively instead of
 * only those emitted after the change.
 */
export type Severity = "alert" | "notice" | "routine";

export type LifecycleState =
  | "STARTING"
  | "IDLE"
  | "AWAKENED"
  | "OBSERVING"
  | "THINKING"
  | "REQUESTING"
  | "WORKING"
  | "WAITING"
  | "REVIEWING"
  | "BLOCKED"
  | "SUSPENDED"
  | "FAILED"
  | "COMPLETED"
  /**
   * Operator retired the seat. Terminal in a way COMPLETED is not: a completed
   * agent can be woken again for follow-up (`COMPLETED: ["IDLE"]`), a retired
   * one never runs again. Retirement is how capacity leaves a live mesh
   * without editing mesh.yaml and restarting it.
   */
  | "RETIRED";

export type MessageType =
  | "MISSION"
  | "INFORM"
  | "REQUEST"
  | "REQUEST_INFO"
  | "REQUEST_REVIEW"
  | "REQUEST_ARTIFACT"
  | "REQUEST_RESEARCH"
  | "REQUEST_EXECUTION"
  | "PROPOSE"
  | "CHALLENGE"
  | "APPROVE"
  | "REJECT"
  | "VETO"
  | "BLOCK"
  | "DELEGATE"
  | "HANDOFF"
  | "PATCH_READY"
  | "TEST_RESULT"
  | "SECURITY_FINDING"
  | "COMMIT"
  | "ROLLBACK"
  | "ESCALATE"
  | "WAIT"
  | "DONE";

export type MessagePriority = "LOW" | "NORMAL" | "HIGH" | "URGENT";

export type TrustSource =
  | "human"
  | "system"
  | "mesh_decision"
  | "agent"
  | "repository"
  | "external"
  | "tool";

export interface ContentProvenance {
  source: TrustSource;
  trustLevel: number;
}

export type ArtifactType =
  | "ArchitectureDocument"
  | "ADR"
  | "ApiSpec"
  | "DatabaseSchema"
  | "CodePatch"
  | "ReleasePlan"
  | "TestReport"
  | "SecurityReport"
  | "ResearchReport"
  | "Decision"
  | "Requirement"
  | "RequirementsDoc"
  | "TaskSpec"
  | "BenchmarkResult"
  | "DisagreementRecord";

export type ArtifactStatus =
  | "DRAFT"
  | "READY_FOR_REVIEW"
  | "UNDER_REVIEW"
  | "REJECTED"
  | "APPROVED"
  | "VERIFIED"
  | "MERGEABLE"
  | "MERGED"
  | "PROPOSED"
  | "IMPLEMENTED"
  | "QA_VERIFIED"
  | "SECURITY_VERIFIED"
  | "ACCEPTED"
  | "FINAL"
  | "ARCHIVED";

export type ArtifactStateMachineKind = "code" | "release" | "document";

/**
 * Who an artifact is background reading for.
 *
 * `mission` is shared reference material the whole mesh may need to consult —
 * the current architecture, the requirements everyone is building against.
 * `work` is the output of one piece of work: it matters to its owner, its
 * reviewers, and whoever was handed a reference to it, and to nobody else.
 *
 * This distinction used to be a hardcoded list of four artifact TYPES inside
 * the context builder, which made it unstateable: a mesh-wide TestReport could
 * not be shared reference material, and a throwaway ADR draft could not stop
 * being one. It is a property of the artifact because that is what it is.
 */
export type ArtifactScope = "mission" | "work";

export interface ArtifactRef {
  uri: string;
  version?: number;
  digest?: string;
}

export interface Artifact {
  id: ArtifactId;
  name: string;
  type: ArtifactType;
  goalId: GoalId;
  owner: AgentId;
  version: number;
  status: ArtifactStatus;
  contentRef: string;
  digest: string;
  parent?: ArtifactId;
  /**
   * Optional. Absent means "derive it from the type" — see `artifactScope`.
   * Left optional rather than backfilled so that logs written before this
   * existed replay to exactly the same answer they always did.
   */
  scope?: ArtifactScope;
  metadata: Record<string, unknown>;
  provenance: ContentProvenance;
  createdAt: string;
  createdBy: AgentId;
}

export interface Requirement {
  id: string;
  text: string;
}

export interface BudgetHint {
  maxTokens?: number;
  maxTurns?: number;
}

export interface MeshMessage {
  id: MessageId;
  protocolVersion?: string;
  type: MessageType;
  timestamp: string;
  goalId: GoalId;
  from: AgentId;
  to: AgentId[];
  threadId: ThreadId;
  replyTo?: MessageId;
  causationId?: EventId;
  artifactRefs: ArtifactRef[];
  payload: unknown;
  priority: MessagePriority;
  requires?: Requirement[];
  budgetHint?: BudgetHint;
  provenance?: ContentProvenance;
  taskId?: TaskId;
  /**
   * Prose attached to the message. NEVER parsed by the mesh.
   *
   * The one place a seat can write freely without the mesh reading it as
   * anything. Deliberately an ENVELOPE field and not a payload key, because
   * every payload key is live: `payloadDiscriminator` hashes unrecognised
   * payloads wholesale, so a `note` inside `payload` would change a message's
   * identity — two seats saying the same thing in different words would
   * collide or not based on the wording — while `validateContractResponse`
   * would reject it outright against any contract with a closed response
   * schema. On the envelope it reaches no parser, no contract check, no
   * discharge inference and no routing decision.
   *
   * Being outside `fingerprintOf` cuts both ways, and that is the intended
   * shape: a note cannot make two otherwise-identical sends distinct, so it
   * cannot be used to slip past loop detection.
   *
   * Not settable through `payload`, and stripped from `payload` like every
   * other reserved key, so a legacy reader cannot find a forged copy there.
   */
  note?: string;
  /**
   * Runtime-owned delivery control. NEVER settable by an agent.
   *
   * `payload` is verbatim agent input, so any routing decision keyed on a
   * payload field is a decision an agent can make for the kernel. This one
   * was: `cacheServed` lived in `payload`, and both the delivery reducer and
   * the scheduler skipped a message carrying it — so a sender could add
   * `payload: { cacheServed: true }` to a REQUEST and get an ask that opens a
   * pending request (parking the recipient's debt and the sender in WAITING)
   * while never landing in any mailbox and never waking anyone. A silent,
   * permanent stall from one key in free-form JSON.
   *
   * `control` is stripped from agent input on every send and re-applied only
   * by the supervisor, which makes forgery structurally impossible rather
   * than merely disallowed.
   */
  control?: MessageControl;
}

/**
 * Kernel-owned envelope fields: the runtime writes these, the schema closes
 * them, and `sanitizeAgentMessageInput` strips them from anything an agent
 * supplies.
 */
export interface MessageControl {
  /**
   * The research cache already answered this; the message is a log record,
   * not mail. Suppresses mailbox delivery and interest activation.
   */
  cacheServed?: boolean;
  /**
   * The contract this ask was opened under.
   *
   * Lives here rather than in `payload` for the reason stated above, and this
   * field is the concrete case that motivated the rule. The commitment ledger
   * reads it twice: once at open, to draw the ask's deadline from the
   * contract's `slaMs`, and once at discharge, to judge the answer against the
   * contract's `response` schema. Both are runtime decisions about an agent's
   * obligations, and while the stamp sat in `payload` -- verbatim agent input,
   * stripped of nothing but `cacheServed` -- a seat could hand-write a
   * contract name into a raw `send` and set its own creditor's clock without
   * its request ever meeting that contract's schema.
   *
   * Written only by the supervisor, and only after `validateContractRequest`
   * has passed, so the stamp's presence is itself the evidence that the ask
   * was checked.
   */
  contract?: string;
  contractVersion?: number;
  /**
   * Interaction mode, and the field that DETERMINES this exchange's obligation
   * semantics rather than describing them.
   *
   * Until now every exchange was the same kind of thing and its blocking
   * semantics were inferred from a type-string prefix: anything beginning
   * `REQUEST` opened a debt, everything else did not. That inference is wrong
   * in both directions. A `broadcast` of a REQUEST type opened an obligation
   * on EVERY seat in the mesh -- an ask nobody in particular owed, which no
   * single reply could honestly discharge. And open-ended discussion had no
   * representation at all, so it happened inside service asks, untracked and
   * unbounded.
   *
   * - `service` (default): one obligation per recipient, answered against a
   *   published contract. This is X-as-a-Service -- a narrow ask, no ongoing
   *   chatter -- and it is what a seat gets when it does not say otherwise.
   * - `collab`: no obligation, but TIME-BOXED at open and metered. Discovery
   *   genuinely needs it; the point is that a seat cannot enter it by accident
   *   and cannot stay in it quietly.
   * - `broadcast`: no obligation, and cannot be replied to. Wakes only
   *   declared interests.
   *
   * Runtime-owned for the same reason as `contract`: an agent choosing its own
   * obligation semantics is an agent deciding whether it owes anything.
   */
  mode?: InteractionMode;
  /**
   * What landing in the mailbox is allowed to COST the recipient.
   *
   * The mesh is asynchronous in its transport and synchronous in its
   * attention. Nothing blocks, but inbound mail wakes the recipient, a wake is
   * a turn, and a turn is a model call -- so every message is an interrupt
   * with a bill attached and the sender pays none of it. Delivery and wake
   * were fused for everything except broadcast, which means the cheapest
   * possible act in the system (writing a sentence) unilaterally spends the
   * most expensive resource another seat has.
   *
   * This field separates the two. Every class DELIVERS -- the reducer puts the
   * message in every recipient's mailbox before the scheduler ever sees it, so
   * an unwoken seat reads it on its next natural activation. They differ only
   * in whether and when the delivery also buys a turn:
   *
   * - `interrupt`: wake now, as mail has always done, and CHARGE the sender's
   *   budget line for it. Reserved for the wakes that are worth a turn: an
   *   URGENT, and an answer a seat is parked in WAITING for.
   * - `deliver`: no wake at send; the scheduler coalesces a burst and wakes
   *   once after `bus.delivery.coalesce_ms`, or not at all if the seat takes a
   *   turn for any other reason first. A service ask still gets answered, just
   *   not by a turn bought per message.
   * - `accrue`: never wakes and never counts as mail pressure. It rides the
   *   next turn the seat takes for its own reasons.
   *
   * ABSENT is not a fourth class and not a cheap default: it is today's wake
   * path, unchanged. Classes are stamped only where `bus.delivery.classes` is
   * configured, so no existing mesh changes behaviour, and a message that
   * predates the regime replays exactly as it ran.
   *
   * ORTHOGONAL TO `mode`, deliberately. `mode` answers what the exchange
   * obliges and therefore who is a candidate for a wake at all; `delivery`
   * answers whether being a candidate is worth a turn right now. The two could
   * have been collapsed -- `broadcast` already behaves like `accrue` -- and
   * they are not, because a broadcast's narrowing to declared interests is an
   * operator's decision written in config (`interests:`), and a class derived
   * from an envelope must never overrule it. So the deriver leaves broadcasts
   * unclassed and they keep their own gate; the class rides on top of the
   * recipient set `mode` chose, never widening it.
   *
   * Runtime-owned for the same reason as `mode`: a delivery class a sender
   * could set is a sender silencing its own interrupt, or handing itself the
   * one class nobody is charged for.
   */
  delivery?: DeliveryClass;
  /**
   * Why this interrupt did not get its class, when it did not.
   *
   * The tariff's whole purpose is to be a price, and a price that cannot
   * refuse is a receipt. When a sender has spent its attention line, the
   * message still ships and its mail still lands -- nothing in this mesh is a
   * suppressed delivery -- but it ships as `deliver` instead of `interrupt`,
   * so the wake it asked for is not bought. This records why, in the sender's
   * own words when it reads its tool result and in the log for everyone else.
   *
   * A sentence rather than a boolean because "refused" has more than one
   * cause, and they call for different answers from the sender: an exhausted
   * attention line means stop interrupting and let the backlog clear, while
   * an operator's `interrupt_cost_tokens` set past what any sender can afford
   * means the configuration is wrong, not the sender.
   *
   * Runtime-owned, reserved, and closed in the schema, exactly like
   * `delivery` itself: a sender that could write this could claim a refusal
   * that never happened, and `downgradedInterrupts` in the run report would
   * stop being evidence of anything.
   */
  downgraded?: string;
}

/**
 * Whether a delivered message also buys the recipient a turn. See
 * `MessageControl.delivery`, which carries the reasoning.
 */
export type DeliveryClass = "interrupt" | "deliver" | "accrue";

export const DELIVERY_CLASSES: readonly DeliveryClass[] = ["interrupt", "deliver", "accrue"];

/**
 * How an exchange is conducted, and therefore what it obliges.
 *
 * `service` is the default because it is the cheap one: a narrow published
 * ask, one answer, done. `collab` stays available because discovery needs it,
 * but it must be DECLARED and it is bounded -- that is the whole low-contact
 * mechanism. High-bandwidth interaction remains possible, becomes visible,
 * and becomes expensive.
 */
export type InteractionMode = "service" | "collab" | "broadcast";

export const INTERACTION_MODES: readonly InteractionMode[] = ["service", "collab", "broadcast"];

/**
 * An open-ended exchange, made expensive on purpose.
 *
 * `service` asks are cheap because they are narrow and self-closing. Real
 * discovery is not narrow, and before this existed it happened ANYWAY --
 * inside service asks, as a thread that kept going after the ask it opened
 * with had been answered. That traffic was invisible: no deadline could fire
 * (the ask was discharged), no ledger entry existed, and the only thing that
 * ever stopped it was a thread token budget running dry, which reads to an
 * operator as a budget fault rather than as two agents talking in circles.
 *
 * A collab session is that conversation, declared. It obliges nobody -- there
 * is no debt, no nudge, no stalemate -- but it is BOUNDED at the moment it
 * opens, by a wall clock and by a count of exchanges, and it is metered
 * against the thread budget line it runs on. When it overruns, an operator
 * gets a card naming what was spent, not a silent stall.
 *
 * Bounds are stamped at OPEN, into the event, rather than read from config at
 * sweep time: a mission that edits its box mid-flight must not retroactively
 * lengthen a session already running, and replay has to reproduce the same
 * expiry it originally produced.
 */
export interface CollabSession {
  /** The thread the session owns. One session per thread, at most. */
  threadId: ThreadId;
  goalId?: GoalId;
  openedBy: AgentId;
  participants: AgentId[];
  /** What it is for. Shown on the overrun card. */
  topic: string;
  openedAt: string;
  /** ISO-8601. The wall-clock edge of the box, fixed at open. */
  expiresAt: string;
  /** Messages in this thread before the box is considered overrun. */
  maxExchanges: number;
  /** Messages seen in this thread since the session opened. */
  exchanges: number;
  /**
   * The budget ledger key this session's tokens land on. Not a second meter:
   * every turn in the thread already charges `thread:<goalId>/<threadId>`,
   * so this records WHERE to read the spend rather than re-counting it.
   */
  budgetKey?: string;
  status: "OPEN" | "CLOSED" | "OVERRUN";
  /** Why it ended: `closed`, `expired`, or `exchanges_exhausted`. */
  closedReason?: string;
  closedAt?: string;
}

/**
 * Payload keys the runtime once trusted, now reserved and stripped on input.
 *
 * The list is the payload-side mirror of `MessageControl`, and it has to stay
 * that way. `sanitizeAgentMessageInput` deletes `control` wholesale, so a
 * runtime-owned field is already unforgeable in its real home; what this list
 * closes is the second copy an agent can leave in `payload`, which nothing
 * reads today but a legacy reader — or a future one — would find. A key that
 * exists on `control` and is missing here is that hole standing open.
 *
 * `mode` is the one that had drifted out of the mirror. It decides whether an
 * exchange obliges anyone at all, which is exactly the judgement an agent must
 * not be allowed to make about its own message.
 *
 * `delivery` is the same judgement about cost rather than obligation: it says
 * whether this message may spend a recipient's turn, and whether the sender is
 * billed for spending it. A seat that could write either key into `payload`
 * could price its own interrupts at zero.
 */
export const RESERVED_PAYLOAD_KEYS: readonly string[] = ["cacheServed", "contract", "contractVersion", "mode", "delivery", "downgraded"];

/**
 * Remove runtime-owned fields from agent-supplied message input.
 *
 * Applied to BOTH `control` and `payload`: the first stops an agent setting
 * the real field, the second stops a legacy reader (or a future one that
 * reaches into `payload`) from finding a forged copy there.
 */
export function sanitizeAgentMessageInput<T extends { payload?: unknown; control?: MessageControl }>(input: T): T {
  const cleaned = { ...input } as T & { payload?: unknown; control?: MessageControl };
  delete cleaned.control;
  const payload = cleaned.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const copy = { ...(payload as Record<string, unknown>) };
    let stripped = false;
    for (const key of RESERVED_PAYLOAD_KEYS) {
      if (key in copy) {
        delete copy[key];
        stripped = true;
      }
    }
    if (stripped) cleaned.payload = copy;
  }
  return cleaned;
}

export type EventType =
  | "goal.created"
  | "goal.budget_changed"
  | "goal.status_changed"
  | "goal.paused"
  | "goal.resumed"
  | "goal.progress"
  | "goal.completed"
  | "goal.reopened"
  | "goal.escalated"
  | "goal.failed"
  /**
   * The mission statement itself was rewritten. The goal is the reference every
   * acceptance judgement is measured against, so a replacement lands as an
   * auditable event carrying the previous text rather than a silent field
   * assignment nobody can diff after the fact.
   */
  | "goal.description_revised"
  | "requirements.created"
  | "requirement.blocked"
  | "requirement.satisfied"
  | "requirement.revised"
  | "requirement.removed"
  | "agent.created"
  | "agent.started"
  | "agent.awakened"
  | "agent.state_changed"
  | "agent.suspended"
  | "agent.resumed"
  | "agent.completed"
  | "agent.failed"
  | "agent.restarted"
  | "agent.replaced"
  | "agent.retired"
  /**
   * The seat's MCP bridge did not attach, so the agent cannot call back into
   * the mesh: it will burn whole turns producing text nobody can act on. Read
   * from the `init.mcp_servers` frame the runtime already records and which
   * nothing previously consumed.
   */
  | "agent.mute_suspected"
  /**
   * The backend session behind a seat is about to be torn down and replaced.
   * Raised BEFORE the teardown, while the seat still has a live transcript to
   * write a continuity record from, so the successor starts from that record
   * rather than from nothing.
   *
   * Rotation used to be invisible: the adapter's `onRotate` hook fired into no
   * consumer at all, so the one moment an agent loses its entire working memory
   * left no trace in the log, no card for the operator, and nothing for replay.
   */
  | "session.rotation_pending"
  /**
   * The replacement session is live. Carries the discarded transcript size, so
   * the cost of the amnesia is a number in the log rather than an inference
   * from a sudden drop in what the agent seems to know.
   */
  | "session.rotated"
  /**
   * A seat wrote down what it is carrying, before something takes its working
   * memory away. Emitted from the `write_continuity` op, so the record is on
   * the log — which is the entire point: the backend transcript is destroyed
   * by a rotation, and a projection rebuilt from the log is the only memory
   * that survives it.
   */
  | "continuity.recorded"
  | "thread.created"
  | "message.sent"
  | "message.delivered"
  | "message.rejected"
  | "artifact.created"
  | "artifact.versioned"
  | "artifact.transition"
  | "task.created"
  | "task.claimed"
  | "task.completed"
  | "review.requested"
  | "review.approved"
  | "review.rejected"
  | "patch.created"
  | "patch.ready"
  | "patch.merged"
  | "architecture.approved"
  | "design.question"
  | "dependency.changed"
  | "authentication.changed"
  | "authorization.changed"
  | "release.candidate"
  | "release.transition"
  | "release.accepted"
  | "research.requested"
  | "research.completed"
  | "implementation.completed"
  | "decision.proposed"
  | "decision.ratified"
  | "escalation.requested"
  | "escalation.responded"
  | "escalation.auto_resolved"
  | "deadlock.auto_resolved"
  /**
   * An outstanding ask stopped being outstanding. The ONLY event-sourced way
   * a commitment leaves the ledger, so replay reproduces it exactly.
   */
  | "commitment.discharged"
  /**
   * A time-boxed collaboration opened. Carries the bounds it was opened with,
   * so replay reproduces the same expiry rather than re-deriving one from
   * whatever the config says now.
   */
  | "collab.opened"
  /** It ended -- by choice, by its clock, or by exhausting its exchanges. */
  | "collab.closed"
  | "human.input"
  | "lease.acquired"
  | "lease.released"
  | "memory.updated"
  /**
   * What the runtime actually put in front of an agent for one turn: every
   * context slot with how many items were admitted, how many were eligible and
   * did not fit, and the token cost of each.
   *
   * Without it "why didn't the agent know X?" cannot be answered from the log.
   * Sub-turn detail is live-only enrichment and absent from any turn
   * reconstructed purely from the event stream, so a dropped item used to leave
   * no evidence that it had ever been a candidate.
   */
  | "context.assembled"
  | "plan.updated"
  | "plan.gate_rejected"
  | "budget.reserved"
  | "budget.consumed"
  | "budget.exceeded"
  | "budget.released"
  | "budget.limit_raised";

export interface MeshEvent<T = unknown> {
  id: EventId;
  seq?: number;
  protocolVersion?: string;
  type: EventType;
  timestamp: string;
  goalId?: GoalId;
  actorId?: string;
  causationId?: EventId;
  correlationId?: string;
  payload: T;
}

export type GoalStatus =
  | "CREATED"
  | "ACTIVE"
  | "PAUSED"
  | "BLOCKED"
  | "CONVERGING"
  | "COMPLETED"
  | "FAILED"
  | "ESCALATED";

/**
 * ASSERTED sits between UNSATISFIED and EVIDENCED: an agent CLAIMED the
 * criterion is met, but the turn that made the claim invoked zero tools, so
 * nothing was read, run, or checked — the claim is the agent's own word.
 *
 * This exists because a live mission ran 138 turns with `toolCalls: 0` on
 * every single one and still closed: agents published TestReports asserting
 * determinism evidence and merged patches without ever invoking a tool, and
 * `requirement.satisfied` fired on peer approval with no verification gate.
 * Only EVIDENCED (or WAIVED) counts toward progress and termination, so an
 * asserted mission stays open and visibly unproven instead of shipping a
 * shell that every projection reported as done.
 */
export type CriterionStatus = "UNSATISFIED" | "ASSERTED" | "EVIDENCED" | "WAIVED";

export interface EvidenceRef {
  kind: string;
  eventId?: EventId;
  artifactRef?: ArtifactRef;
  by?: AgentId;
  recordedAt: string;
  /**
   * Did the turn that produced this evidence actually do anything checkable?
   * false === the claiming agent invoked no tools that turn (see
   * CriterionStatus.ASSERTED). Absent on evidence recorded out of band by the
   * operator, which is verified by definition.
   */
  verified?: boolean;
  /** Tool invocations in the claiming turn — the number `verified` is derived from. */
  toolCalls?: number;
}

export interface AcceptanceCriterion {
  id: string;
  description: string;
  mandatory: boolean;
  status: CriterionStatus;
  evidence: EvidenceRef[];
  /**
   * Artifact URIs the operator already rejected, snapshotted from `evidence`
   * every time the mission is reopened. Re-citing one of these cannot satisfy
   * the criterion again — otherwise a reopen is answered by handing back the
   * identical artifact and the mission re-completes within a tick.
   */
  rejectedEvidence?: string[];
}

export interface GoalBudget {
  tokens: number;
  wallClockMinutes: number;
  maxEvents: number;
}

export interface Goal {
  id: GoalId;
  description: string;
  acceptanceCriteria: AcceptanceCriterion[];
  status: GoalStatus;
  budget: GoalBudget;
  rootThreadId: ThreadId;
  createdAt: string;
  completedAt?: string;
  /**
   * When the operator last reopened this mission. Evidence recorded before it
   * belongs to the round that was rejected and no longer counts toward
   * completion.
   */
  reopenedAt?: string;
  /**
   * Which run of this goal is current: 1 on creation, +1 on every reopen.
   *
   * `reopenedAt` answers "when", which is enough to date a single fact against
   * the newest round and nothing more. An ordinal is an IDENTITY, so a fact
   * stamped with `<goalId>#2` stays legible after a third and fourth reopen,
   * and two facts can be compared without either of them carrying a clock.
   */
  episodeOrdinal?: number;
}

/** The episode this goal is currently in. See {@link EpisodeId}. */
export function episodeOf(goal: Pick<Goal, "id" | "episodeOrdinal">): EpisodeId {
  return `${goal.id}#${goal.episodeOrdinal ?? 1}`;
}

export type Authority = string;

export interface PromptReference {
  file?: string;
  text?: string;
}

export interface SessionPolicy {
  persistent: boolean;
  maxContextTokens?: number;
}

export interface DelegationPolicy {
  allowDelegation: boolean;
  maxDepth: number;
  maxWorkers: number;
  workerBudgetTokens?: number;
}

export interface CommunicationPolicy {
  mayContact: AgentId[];
  mayBeContactedBy: AgentId[];
}

export interface BudgetPolicy {
  tokens?: number;
  wallClockMinutes?: number;
  maxEvents?: number;
  maxActivations?: number;
}

export interface AgentDefinition {
  id: AgentId;
  role: string;
  mode: AgentMode;
  runtime: RuntimeTypeName;
  model?: string;
  /**
   * Provider-specific reasoning variant (opencode: `low` | `high` | `max`).
   * Inert since that backend was removed — no registered runtime reads it.
   */
  variant?: string;
  /**
   * Capability tokens this seat holds but may not use unaided: the tools they
   * authorize need an operator grant first. Resolved from `requires_approval`,
   * which inherits from `mesh.runtime.requires_approval` when the seat omits it.
   *
   * Listing a token the seat does not hold does nothing — this narrows an
   * existing grant, it never widens one.
   */
  requiresApproval?: string[];
  prompt: PromptReference;
  capabilities: string[];
  authority: Authority[];
  communicationPolicy: CommunicationPolicy;
  interests: string[];
  sessionPolicy: SessionPolicy;
  delegationPolicy: DelegationPolicy;
  budget: BudgetPolicy;
  /**
   * Absent means "off". Optional so that a hand-built AgentDefinition (tests,
   * adapter fixtures, the synthetic worker seat) keeps compiling and keeps
   * behaving exactly as it did before this feature existed.
   */
  hardActions?: HardActionsPolicy;
  /**
   * Absent means "wake me for everything", which is what every seat did before
   * this existed. Optional for the same reason `hardActions` is.
   */
  wake?: WakePolicy;
}

export type PlanStepStatus = "PENDING" | "DONE";

/** One step as the model supplies it: ids and status are optional. */
export interface PlanStepInput {
  id?: string;
  text: string;
  status?: PlanStepStatus;
  /** Hard-action capabilities this step intends to use (see HardActionsPolicy). */
  capabilities?: string[];
}

/** One step after the supervisor has resolved its id and defaults. */
export interface PlanStep {
  id: string;
  text: string;
  status: PlanStepStatus;
  capabilities: string[];
}

/**
 * An agent's PRIVATE working breakdown of the one task it has claimed.
 *
 * Deliberately not a mesh Task: nobody else can claim, delegate or review a
 * plan step. It exists so the agent can track its own sub-steps across turns,
 * and so a hard action can be checked against a step that declared it.
 *
 * Scoped by `taskId`. Staleness is decided at READ time by comparing against
 * AgentRuntimeState.activeTaskId — no reducer ever clears a plan, which keeps
 * the projection a pure function of the log.
 */
export interface AgentPlan {
  taskId?: TaskId;
  steps: PlanStep[];
  revision: number;
  updatedAt: string;
}

/**
 * Whether this agent must plan before acting.
 *
 * `off` (the default everywhere) is a complete no-op: no gate, no prompt
 * section, no events — an existing mesh.yaml behaves bit-identically.
 * `warn` records a `plan.gate_rejected` event but still runs the op.
 * `enforce` rejects the op until some plan step declares the capability.
 *
 * `capabilities` lists which capability tokens are "hard". Only tokens that
 * map to an op via HARD_OP_CAPABILITY can actually be enforced.
 */
export interface HardActionsPolicy {
  mode: "off" | "warn" | "enforce";
  capabilities: string[];
}

/**
 * What a seat is willing to be WOKEN for, authored by the recipient. That is
 * the point of the block: every other rationing knob in the mesh belongs to the
 * sender — `bus.delivery.attention_tokens` is the sender's wallet, the tariff
 * is charged to the sender, and `interests` gates only broadcasts. This is the
 * recipient's own answer to the same question.
 *
 * It is deliberately one step MILDER than `communicationPolicy.mayBeContactedBy`,
 * the existing recipient-authored preference: that one refuses the SEND, so the
 * message never exists. This refuses only the WAKE — the mail is delivered, sits
 * in the mailbox, and is read on the seat's next natural activation, exactly as
 * `accrue` already does mesh-wide. "Nothing is ever suppressed; only the wake is
 * refused."
 */
export interface WakePolicy {
  /**
   * Never wake me for mail that obliges me nothing.
   *
   * Obligation is the one thing that overrides this, by construction rather than
   * by exception: `obligesRecipients` is the same predicate the debt is opened
   * with, so a message this setting ignores is a message that opened no
   * `pendingRequests` entry and owes nobody an answer. An ask always wakes the
   * seat that owes it — a mesh where a seat could quietly opt out of its own
   * debts would not be a mesh.
   *
   * It does not refund the sender. An `interrupt` sent to a deferring seat was
   * already charged to the sender's attention ledger at send time, and stays
   * charged: the setting is part of mesh.yaml, so it is a public declaration a
   * sender can read before spending, which is the same bargain
   * `may_be_contacted_by` already strikes one step harder.
   */
  deferNonObliging?: boolean;
  /**
   * How much of a NON-OBLIGING message the wake carries: `"full"` (the default)
   * inlines the body, `"claims"` renders a one-line claim and leaves the body to
   * be fetched with `mesh_inbox`.
   *
   * This is "push the obligation, pull the content", and the split falls at the
   * obligation rather than at a size threshold on purpose: a message that owes
   * this seat an answer is the reason the turn exists, so its body is always
   * inlined and a seat can never answer one blind. Only mail that obliges
   * nothing — the half a wake *interrupts* for rather than *owes* — becomes a
   * claim.
   *
   * What it does not do is un-deliver anything. `message.delivered` is emitted
   * for mail the turn RENDERED and the model ANSWERED (`supervisor.ts`), and a
   * claim line is a rendering: the seat was told the message exists, by id, with
   * its sender, type, priority and thread. The debt therefore closes exactly as
   * it did before; what is deferred is the *reading*, not the receipt.
   *
   * Off by default, and it should stay that way until a mission says otherwise:
   * the measured `Unread mail` section is 2.2% of a turn's briefing block
   * (`NOTES-communication-measured-review.md` §1d), so this is a contact-quality
   * lever, not a cost one.
   */
  mail?: "full" | "claims";
}

export interface AgentRuntimeState {
  agentId: AgentId;
  lifecycle: LifecycleState;
  sessionId?: string;
  mailboxDepth: number;
  activeTaskId?: TaskId;
  currentArtifactIds: ArtifactId[];
  tokensConsumed: number;
  activations: number;
  lastActivityAt: string;
  lastError?: string;
  /**
   * Whether a FAILED agent is expected to restart (persistent session with
   * attempts remaining). The termination manager must not treat a
   * restartable FAILED agent as a mission-ending runtime failure: the
   * supervisor owns the retry, and a watchdog tick landing between
   * `agent.failed` and the restart would otherwise freeze the whole goal
   * over a recoverable blip.
   */
  restartable?: boolean;
  /** Private working breakdown of `activeTaskId`. See AgentPlan. */
  plan?: AgentPlan;
}

export type TaskStatus =
  | "OPEN"
  | "CLAIMED"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "BLOCKED"
  | "CANCELLED";

export interface Task {
  id: TaskId;
  goalId: GoalId;
  title: string;
  description: string;
  createdBy: AgentId;
  assignedTo?: AgentId;
  claimedBy?: AgentId;
  status: TaskStatus;
  requiredCapabilities: string[];
  artifactRefs: ArtifactRef[];
  parentTaskId?: TaskId;
  delegationDepth: number;
  budget: BudgetPolicy;
  createdAt: string;
  completedAt?: string;
}

export type ApprovalKind =
  | "approve"
  | "reject"
  | "pass"
  | "block"
  | "veto"
  | "accept"
  | "merge";

export interface ApprovalRecord {
  id: string;
  goalId: GoalId;
  kind: ApprovalKind;
  subject: string;
  artifactId?: ArtifactId;
  artifactRef?: ArtifactRef;
  actorId: AgentId;
  actorRole: string;
  evidenceEventId: EventId;
  recordedAt: string;
}

export interface Thread {
  id: ThreadId;
  goalId: GoalId;
  subject: string;
  initiator: AgentId;
  artifactRefs: ArtifactRef[];
  participants: AgentId[];
  depth: number;
  parentThreadId?: ThreadId;
  rootThreadId?: ThreadId;
  messageIds: MessageId[];
  status: "OPEN" | "RESOLVED" | "ESCALATED";
  budget: BudgetPolicy;
  createdAt: string;
}

export type DecisionStatus = "PROPOSED" | "RATIFIED" | "REJECTED" | "SUPERSEDED";

export interface DecisionRecord {
  id: DecisionId;
  goalId: GoalId;
  topic: string;
  decision: Record<string, unknown>;
  status: DecisionStatus;
  proposedBy: AgentId;
  approvedBy: AgentId[];
  evidence: ArtifactRef[];
  artifactRef?: ArtifactRef;
  createdAt: string;
  ratifiedAt?: string;
}

export type EscalationStatus = "OPEN" | "RESPONDED" | "AUTO_RESOLVED";

/**
 * Escalations come in two kinds, and the distinction is load-bearing:
 *
 * - `primary`   — a real question only a human can answer (budget exhausted,
 *                 runtime failure, an unanswered request, a deadlock finding).
 *                 It owns its own lifecycle: it stays OPEN until somebody
 *                 decides it.
 * - `derived`   — a *summary* the watchdog computes over the currently-open
 *                 primaries (today: `stalemate`). It carries no decision of
 *                 its own; it is true exactly as long as its supports are
 *                 open. The runtime maintains the invariant
 *                 "a derived card is OPEN iff >=1 supporting primary is OPEN"
 *                 by auto-resolving it, so a derived card can never outlive
 *                 the facts it describes and strand the mission.
 *
 * `supports` lists the primary escalation ids a derived card summarizes. It is
 * empty/absent on primaries.
 */
export type EscalationKind = "primary" | "derived";

export interface Escalation {
  id: EscalationId;
  goalId: GoalId;
  reason: string;
  detail: unknown;
  raisedBy: string;
  conflictKey?: string;
  disagreementArtifactRef?: ArtifactRef;
  status: EscalationStatus;
  /** Defaults to "primary" when absent (older logs predate the field). */
  kind?: EscalationKind;
  /** Primary escalation ids this derived card summarizes. */
  supports?: EscalationId[];
  /**
   * Advisory cards inform the operator but must NOT freeze the goal: the mesh
   * already routed around the problem (e.g. a dead debtor's asks were
   * discharged with notice). Without this every personnel loss becomes a
   * mission-wide freeze behind a card nobody needs to answer urgently.
   * Absent (older logs) means freezing, preserving old behavior on replay.
   */
  advisory?: boolean;
  response?: string;
  createdAt: string;
  respondedAt?: string;
}

export interface WorkspaceLease {
  id: LeaseId;
  artifactId: ArtifactId;
  agentId: AgentId;
  worktreePath: string;
  files: string[];
  acquiredAt: string;
  expiresAt?: string;
  releasedAt?: string;
}

export interface AgentMemoryNote {
  agentId: AgentId;
  key: string;
  value: string;
  updatedAt: string;
  eventId: EventId;
}

/**
 * The slots a turn's context is assembled from, in the order they are admitted.
 *
 * Order is the eviction policy. Everything above `mail` is what the agent needs
 * to not repeat itself or contradict a standing obligation; everything below it
 * is useful background. When the budget runs out the tail is dropped first, and
 * the drop is recorded rather than silent, so a starved slot can be re-offered
 * on the next turn instead of vanishing.
 */
export type ContextSlot =
  /** What this seat's predecessor session knew. First because losing it is the
   * one gap the agent cannot detect from inside the turn. */
  | "continuity"
  /** Outstanding asks this seat owes or is owed. Second because an agent that
   * forgets an obligation stalls a peer, not just itself. */
  | "commitments"
  | "mission"
  | "policy"
  | "task"
  | "decisions"
  | "artifacts"
  | "mail"
  | "own_activity"
  | "memory";

export interface ContextSlotUsage {
  slot: ContextSlot;
  /** Items that made it into the prompt. */
  admitted: number;
  /** Items that were eligible and did not fit. Non-zero here is the signal
   * that the agent is being asked to work from a partial picture. */
  dropped: number;
  tokens: number;
}

/**
 * What the runtime actually put in front of an agent for one turn.
 *
 * The assembled bundle itself is not logged — it is large, mostly redundant
 * across turns, and reconstructible. The manifest is the cheap durable record
 * that makes the bundle's *shape* auditable: which slots were present, how much
 * each cost, and what was left on the floor.
 */
export interface ContextManifest {
  agentId: AgentId;
  goalId?: GoalId;
  /** Which logical run of the goal. A fact carried across a reopen belongs to
   * the episode it was judged in, not the one reading it. */
  episode?: string;
  budgetTokens: number;
  usedTokens: number;
  slots: ContextSlotUsage[];
  /**
   * Which rung of the degradation ladder produced this bundle. Names match
   * `tierName` in the supervisor rather than introducing a parallel vocabulary.
   * `minimal` means the agent is working from little more than its task, and a
   * turn that goes wrong under `minimal` should be read as starved rather than
   * incapable.
   */
  tier: "full" | "reduced" | "tight" | "minimal";
  /**
   * True when even the tightest tier did not fit under the soft cap and the
   * prompt was sent oversized. The alternative — slicing the string — would cut
   * the ops contract off the end, so the turn goes out over budget by design.
   */
  overSoftCap: boolean;
}

/**
 * Why a backend session is being replaced.
 *
 * `rotation` is the routine one: the transcript approached the context window
 * and the adapter chose a fresh session over a truncated one. The others are
 * involuntary.
 */
export type SessionEndReason = "rotation" | "restart" | "suspend" | "episode_boundary";

export interface SessionRotationPending {
  agentId: AgentId;
  /** The session about to be discarded. */
  sessionId: string;
  reason: SessionEndReason;
  /**
   * The size of the memory about to be thrown away: the largest prompt a single
   * model call of the seat's last turn was handed — the context the window was
   * actually holding. A per-call size, not a turn's summed reads; the two differ
   * by the number of calls in a turn (see `promptSize` in
   * `@mesh/runtime-claude`, and §11c of `NOTES-communication-measured-review.md`).
   */
  transcriptTokens: number;
  /** The threshold that tripped, for operators asking "why now?". */
  thresholdTokens: number;
}

export interface SessionRotated {
  agentId: AgentId;
  fromSessionId: string;
  toSessionId: string;
  /** 1 for a seat's first session, incrementing on every replacement. A seat
   * on ordinal 6 has forgotten five times. */
  sessionOrdinal: number;
  reason: SessionEndReason;
  /**
   * The outgoing transcript's size, so the cost of the amnesia is a number in
   * the log rather than a story. Written on every rotation
   * (`apps/mesh-server/src/index.ts`, the `onRotate` hook); nothing reads it
   * back yet, and an operator reconstructs a rotation history from the events
   * themselves.
   */
  transcriptTokensDiscarded: number;
}

/**
 * A claim a seat is carrying forward, and what it is standing on.
 *
 * `basis` is mandatory. A belief with no citable basis is a rumour, and the
 * whole reason the successor session can trust this record at all is that
 * every line in it points at something still in the log.
 */
export interface Belief {
  claim: string;
  /** An artifact URI, a commitment (message) id, or an event id. */
  basis: string;
  /**
   * `asserted` means the seat verified it. `assumed` means it proceeded on it
   * without checking — which the successor needs to know, because an
   * assumption inherited as a fact is how a wrong turn outlives the turn that
   * took it.
   */
  confidence: "asserted" | "assumed";
}

/**
 * Something this seat tried that was turned down, and by whom.
 *
 * Carried across a rotation because it is the single most expensive thing to
 * rediscover: without it the successor re-proposes the rejected thing, the
 * reviewer rejects it again, and neither of them can see the loop.
 */
export interface RejectionNote {
  /** An artifact URI, or a short description when nothing was published. */
  what: string;
  rejectedBy: AgentId;
  reason: string;
  /** The run it was judged in. A rejection from a previous episode is history;
   * one from this episode is a constraint. */
  episode?: EpisodeId;
}

/**
 * What a seat hands to its own successor when its backend session is replaced.
 *
 * The mesh and the backend hold two different memories of an agent. The mesh's
 * is rebuilt from projections every turn and is bounded and inspectable; the
 * backend's is an accumulating transcript the kernel cannot see, and it ends by
 * being *destroyed* rather than rebuilt — rotation mints a fresh session, not a
 * resume. This record is the only thing that crosses that gap, so it is written
 * by the outgoing session, on the log, before the cliff.
 *
 * `openCommitments` is derived (the ledger already knows) and is included so
 * the successor does not have to infer its obligations from prose. Everything
 * else is authored: it is what the seat concluded, what it already tried, and
 * what it was about to do next.
 */
export interface ContinuityRecord {
  agentId: AgentId;
  episode?: EpisodeId;
  /** 1, 2, 3… successive backend sessions for one seat. */
  sessionOrdinal: number;
  writtenAt: string;
  reason: SessionEndReason;
  /** DERIVED from the commitment ledger at write time, not authored. */
  openCommitments: MessageId[];
  workingBeliefs: Belief[];
  rejected: RejectionNote[];
  /** One sentence: what this seat was about to do. */
  nextIntent: string;
  /** The `continuity.recorded` event this came from. */
  eventId?: EventId;
}

/**
 * A seat whose MCP bridge did not attach.
 *
 * The bridge is how an agent calls back into the mesh; without it the agent is
 * still scheduled, still billed, and structurally incapable of acting. Detected
 * from the backend's own `init` frame rather than inferred from silence, so it
 * fires on the first turn instead of after a stall timeout.
 */
export interface MuteSuspected {
  agentId: AgentId;
  sessionId: string;
  /** Servers the backend reported, with whatever status it gave them. */
  servers: Array<{ name: string; status: string }>;
  /** The mesh bridge specifically — its absence is what makes the seat mute. */
  meshBridgeAttached: boolean;
}

export type ActivationReasonKind =
  | "interest_event"
  | "message"
  | "startup"
  | "manual"
  | "recovery"
  | "timer";

export interface ActivationReason {
  kind: ActivationReasonKind;
  eventId?: EventId;
  eventType?: EventType;
  messageId?: MessageId;
  threadId?: ThreadId;
  note?: string;
}

export interface MeshOpSend {
  op: "send";
  /**
   * Contract this send desugared from. Set by `callContract` after the
   * request schema has passed; carried onto the envelope's `control`, never
   * into `payload`. Mirrors the same pair on the request_review and
   * request_research ops.
   */
  contract?: string;
  contractVersion?: number;
  type: MessageType;
  to: AgentId[];
  threadId?: ThreadId;
  newThread?: { subject: string; artifactRefs?: ArtifactRef[] };
  replyTo?: MessageId;
  artifactRefs?: ArtifactRef[];
  payload?: unknown;
  /**
   * Free prose for the recipient. Never parsed — see `MeshMessage.note`.
   *
   * Separate from `payload` on purpose: `payload` is what a contract validates
   * and what loop detection fingerprints, and prose belongs in neither.
   */
  note?: string;
  priority?: MessagePriority;
  taskId?: TaskId;
  requires?: Requirement[];
  budgetHint?: BudgetHint;
}

export interface MeshOpBroadcast {
  op: "broadcast";
  type: MessageType;
  payload?: unknown;
  /** Free prose for every recipient. Never parsed — see `MeshMessage.note`. */
  note?: string;
  artifactRefs?: ArtifactRef[];
}

/**
 * Open a time-boxed, metered collaboration. See CollabSession.
 *
 * Deliberately a DECLARED op rather than a flag on `send`: entering an
 * open-ended exchange is a decision with a cost, and a seat should not be
 * able to drift into one. The box comes from mesh config unless overridden
 * here, and an override may only SHORTEN it -- an agent cannot vote itself a
 * longer leash.
 */
export interface MeshOpCollab {
  op: "collab";
  /** Who is in the room. */
  with: AgentId[];
  /** What it is for. Becomes the thread subject and the card's title. */
  topic: string;
  /** Opening message. */
  payload?: unknown;
  /** Shorten the wall-clock box. Ignored if longer than the configured one. */
  boxMs?: number;
  /** Shorten the exchange budget. Ignored if larger than the configured one. */
  maxExchanges?: number;
  artifactRefs?: ArtifactRef[];
}

/**
 * Close a collaboration you opened, before its box runs out.
 *
 * The cheap exit. A session that ends here costs no card; one that runs to
 * its edge always raises one, because an exchange nobody chose to end is the
 * failure mode this whole mode exists to make visible.
 */
export interface MeshOpCloseCollab {
  op: "close_collab";
  threadId: ThreadId;
  /** What came of it. Recorded on the session and shown to participants. */
  outcome: string;
}

export interface MeshOpRequestResearch {
  op: "request_research";
  to: AgentId;
  question: string;
  artifactRefs?: ArtifactRef[];
  /**
   * Set only when this op was desugared from a `call`: the contract that
   * produced it, and its version. Never typed by a model.
   *
   * It rides into the message payload so the commitment ledger can read the
   * contract's SLA on replay, and so a reader of the log can see WHICH named
   * ask this was without re-deriving it from the prose. Without it these two
   * ops would be the only contracts whose SLA silently did not apply.
   */
  contract?: string;
  contractVersion?: number;
}

export interface MeshOpRespond {
  op: "respond";
  messageId: MessageId;
  type: MessageType;
  payload?: unknown;
  artifactRefs?: ArtifactRef[];
}

/**
 * Close an ask addressed to you WITHOUT answering it.
 *
 * The gap this fills: an agent that cannot or will not answer had no way to
 * say so. It could only stay silent, and silence is indistinguishable from
 * "still working" — so the ask sat until the nudge limit and then escalated
 * to a human as a false stalemate. Now "I am not going to answer this, and
 * here is why" is a first-class, cheap, logged move.
 */
export interface MeshOpDischarge {
  op: "discharge";
  /** The request message being closed. */
  messageId: MessageId;
  /** Why it will not be answered — recorded and shown to the asker. */
  reason: string;
  /**
   * WHICH "no" this is, named from the contract's closed `refusals` set.
   *
   * Optional, and its absence is the pre-existing behaviour: a discharge with
   * only prose settles the ask exactly as it always did. Present, it must be
   * one of the names the ask's contract declares, or the op is refused at the
   * edge with the legitimate ones listed -- the same "getting it wrong teaches
   * you the right one in the same breath" contract `unknownContractReason`
   * makes for contract names.
   *
   * The reason this is a separate field rather than a convention for `reason`
   * is that the asker is supposed to BRANCH on it. `contracts.ts` says the
   * closed set exists so a refusal can be told apart as "I am the wrong seat"
   * (re-route) from "your ask is incomplete" (re-ask) from "I disagree"
   * (escalate) -- three situations that free text makes indistinguishable.
   * Deriving that from prose would mean the mesh guessing at a sentence, which
   * is the failure mode the whole typed-envelope design exists to avoid. So
   * the kind is stated as a value or it is not stated at all.
   */
  refusal?: string;
}

/**
 * Close an ask YOU raised, before anyone answers it.
 *
 * The creditor's mirror of `discharge`, and the move that was missing from the
 * same asymmetry. A debtor that will not answer can now say so; an asker that
 * no longer NEEDS an answer could only stay quiet and keep waiting. Its
 * alternatives were both bad. A chase is an interrupt -- priced in another
 * seat's attention -- sent to demand an answer to a question the asker had
 * already stopped needing. And silence fed the nudge ladder, so the ask aged
 * into a `stalemate:unanswered_request` card and the operator was woken to
 * arbitrate a question nobody wanted answered.
 *
 * This is the cheap exit from exactly that. It is also the only move that
 * releases a DEBTOR: "stop working on this" is information the debtor cannot
 * otherwise get, and a seat mid-review on a withdrawn question is burning
 * turns on work that has been cancelled.
 *
 * Addressed by message id and authorized by the ask's own `from`, so it needs
 * no recipient list and cannot be aimed at someone else's ask.
 */
export interface MeshOpWithdraw {
  op: "withdraw";
  /** The ask being retracted. Only its original sender may withdraw it. */
  messageId: MessageId;
  /** Why it is no longer wanted -- recorded, and shown to the debtors. */
  reason?: string;
}

export interface MeshOpPublishArtifact {
  op: "publish_artifact";
  name: string;
  type: ArtifactType;
  status?: ArtifactStatus;
  content: string;
  /**
   * Overrides the type-derived default. An agent publishing something the whole
   * mesh should keep in view says so here rather than hoping its type is on a
   * list it cannot see.
   */
  scope?: ArtifactScope;
  metadata?: Record<string, unknown>;
  parentArtifactId?: ArtifactId;
  asVersionOf?: ArtifactId;
}

export interface MeshOpReadArtifact {
  op: "read_artifact";
  artifactRef: string;
  /**
   * Character offset to resume from. Artifact content is the one thing an agent
   * can pull into its own window without limit, so reads are sliced and paged
   * rather than returned whole.
   */
  offset?: number;
}

export interface MeshOpTransitionArtifact {
  op: "transition_artifact";
  artifactId: ArtifactId;
  artifactUri?: string;
  to: ArtifactStatus;
  evidence?: string;
}

export interface MeshOpRequestReview {
  op: "request_review";
  artifactId: ArtifactId;
  artifactUri?: string;
  reviewers: AgentId[];
  /**
   * Set only when this op was desugared from a `call`: the contract that
   * produced it, and its version. Never typed by a model.
   *
   * It rides into the message payload so the commitment ledger can read the
   * contract's SLA on replay, and so a reader of the log can see WHICH named
   * ask this was without re-deriving it from the prose. Without it these two
   * ops would be the only contracts whose SLA silently did not apply.
   */
  contract?: string;
  contractVersion?: number;
}

export interface MeshOpApprove {
  op: "approve";
  subject: string;
  artifactId?: ArtifactId;
  artifactUri?: string;
  comment?: string;
  kind?: "approve" | "pass";
}

export interface MeshOpReject {
  op: "reject";
  subject: string;
  artifactId?: ArtifactId;
  artifactUri?: string;
  comment?: string;
}

export interface MeshOpVeto {
  op: "veto";
  subject: string;
  artifactId?: ArtifactId;
  artifactUri?: string;
  comment?: string;
}

export interface MeshOpBlock {
  op: "block";
  subject: string;
  artifactId?: ArtifactId;
  artifactUri?: string;
  reason: string;
}

export interface MeshOpDelegate {
  op: "delegate";
  to: AgentId;
  title: string;
  description: string;
  requiredCapabilities?: string[];
  artifactRefs?: ArtifactRef[];
  budgetHint?: BudgetHint;
}

export interface MeshOpClaimTask {
  op: "claim_task";
  taskId: TaskId;
}

export interface MeshOpCompleteTask {
  op: "complete_task";
  taskId: TaskId;
  summary: string;
  artifacts?: ArtifactRef[];
}

export interface MeshOpCreateTask {
  op: "create_task";
  title: string;
  description: string;
  assignedTo?: AgentId;
  requiredCapabilities?: string[];
  artifactRefs?: ArtifactRef[];
  budgetHint?: BudgetHint;
}

export interface MeshOpProposeDecision {
  op: "propose_decision";
  topic: string;
  decision: Record<string, unknown>;
  evidence?: ArtifactRef[];
}

export interface MeshOpRatifyDecision {
  op: "ratify_decision";
  decisionId: DecisionId;
}

export interface MeshOpEscalate {
  op: "escalate";
  reason: string;
  detail?: unknown;
  conflictKey?: string;
}

export interface MeshOpWait {
  op: "wait";
  reason?: string;
}

export interface MeshOpDone {
  op: "done";
  summary?: string;
}

/**
 * Hand this seat's working state to its own successor session.
 *
 * Distinct from `remember` on purpose. A memory note is a durable key/value an
 * agent chooses to keep across the whole mission; a continuity record is a
 * snapshot of one session's in-flight reasoning, written at one moment, read
 * once by the session that replaces it. Overloading `remember` would have put
 * transient beliefs into permanent memory and blown its eviction budget.
 *
 * `openCommitments` is deliberately NOT a field: the ledger already knows what
 * this seat owes, and an agent retyping its obligations would get them wrong in
 * exactly the cases that matter. The reducer fills them in.
 */
/**
 * Discovery. Ships in the same change as `call` and is not optional: a larger
 * vocabulary that cannot be enumerated at runtime is strictly worse than a
 * small one, because the only remaining way to find a name is to guess — which
 * is the failure `op-aliases.ts` was built to absorb.
 */
export interface MeshOpContracts {
  op: "contracts";
  /** Narrow to what one role can answer. Omit for everything. */
  role?: string;
}

/**
 * One generic ask, against a published contract.
 *
 * `contract` names the ask; `request` is validated against that contract's
 * schema BEFORE anything is sent, so a malformed ask is refused at the edge
 * rather than delivered as a well-formed message carrying nonsense.
 *
 * `to` is optional on purpose. Omitting it asks the mesh to resolve a provider
 * from the contract's capability among the seats this one may contact — the
 * direction no existing table in the repo runs.
 */
export interface MeshOpCall {
  op: "call";
  contract: string;
  request?: unknown;
  to?: AgentId[];
}

export interface MeshOpWriteContinuity {
  op: "write_continuity";
  /** One sentence: what you were about to do next. */
  nextIntent: string;
  beliefs?: Belief[];
  rejected?: RejectionNote[];
}

export interface MeshOpRemember {
  op: "remember";
  key: string;
  value: string;
}

export interface MeshOpPlan {
  op: "plan";
  /** Defaults to the agent's activeTaskId when omitted. */
  taskId?: TaskId;
  steps: PlanStepInput[];
}

export interface MeshOpPlanStep {
  op: "plan_step";
  stepId: string;
  status: PlanStepStatus;
}

export interface MeshOpAcquireLease {
  op: "acquire_lease";
  artifactId: ArtifactId;
  files: string[];
}

export interface MeshOpReleaseLease {
  op: "release_lease";
  artifactId: ArtifactId;
}

export interface MeshOpCommit {
  op: "commit";
  message: string;
  artifactId: ArtifactId;
  files?: string[];
}

export interface MeshOpRequestCommit {
  op: "request_commit";
  artifactId: ArtifactId;
  comment?: string;
}

export interface MeshOpMerge {
  op: "merge";
  artifactId: ArtifactId;
  artifactUri?: string;
  comment?: string;
}

export interface MeshOpSubmitResult {
  op: "submit_result";
  taskId: TaskId;
  result: SubAgentResult;
}

export interface MeshOpSpawnWorker {
  op: "spawn_worker";
  taskSpec: string;
  title: string;
  capabilities?: string[];
  budgetTokens?: number;
}

export type MeshOp =
  | MeshOpSend
  | MeshOpBroadcast
  | MeshOpCollab
  | MeshOpCloseCollab
  | MeshOpRequestResearch
  | MeshOpRespond
  | MeshOpDischarge
  | MeshOpWithdraw
  | MeshOpPublishArtifact
  | MeshOpReadArtifact
  | MeshOpTransitionArtifact
  | MeshOpRequestReview
  | MeshOpApprove
  | MeshOpReject
  | MeshOpVeto
  | MeshOpBlock
  | MeshOpDelegate
  | MeshOpClaimTask
  | MeshOpCompleteTask
  | MeshOpCreateTask
  | MeshOpProposeDecision
  | MeshOpRatifyDecision
  | MeshOpEscalate
  | MeshOpWait
  | MeshOpDone
  | MeshOpWriteContinuity
  | MeshOpContracts
  | MeshOpCall
| MeshOpRemember
  | MeshOpPlan
  | MeshOpPlanStep
  | MeshOpAcquireLease
  | MeshOpReleaseLease
  | MeshOpCommit
  | MeshOpRequestCommit
  | MeshOpMerge
  | MeshOpSubmitResult
  | MeshOpSpawnWorker;

export interface SubAgentResult {
  status: "COMPLETED" | "FAILED" | "PARTIAL";
  summary: string;
  artifacts: ArtifactRef[];
  findings: string[];
  risks: string[];
  recommendation: string;
}

export interface AgentInput {
  agentId: AgentId;
  goalId: GoalId;
  activation: ActivationReason;
  context: AgentContextBundle;
  instructions: string;
  /**
   * Run this turn on the CURRENT transcript even though it is over the
   * rotation threshold.
   *
   * Set only for the handover turn. Without it the adapter would rotate on the
   * way in and the seat would be asked to write down what it knew by the one
   * session that no longer knows it — the handover would run, produce a record
   * full of nothing, and look like it had worked.
   */
  suppressRotation?: boolean;
  /**
   * Tools the operator has unlocked for this seat, as of THIS turn.
   *
   * Carried per-turn rather than read from `RuntimeContext.approvalGranted`
   * because context is built once per session (`start`/`restoreSession`) while
   * grants change while the session is live. A runtime that gates tools
   * refreshes its gate from this, so an unlock reaches a seat that is already
   * running; runtimes without a gate ignore it. Absent means "not told" — the
   * gate keeps whatever it already had, it does not reset to empty.
   */
  approvalGranted?: string[];
  /**
   * Best-effort live token callback. Runtimes backed by a streaming backend
   * (opencode SSE) invoke it with text deltas as the model responds; others
   * ignore it. Never fails the turn — streaming is observability only, the
   * authoritative output is still AgentOutput.text. Deltas are forwarded
   * out-of-band (never kernel events) so the event log stays compact.
   */
  onToken?: (delta: string) => void;
  /**
   * Best-effort live tool-activity callback: the tool-side twin of `onToken`.
   * Fires when a call is announced, and again if the backend refines it, so an
   * operator watching a slow turn sees what the agent is doing while it does
   * it -- `AgentOutput.toolCalls` structurally cannot, since it only lands
   * once the turn is over. Same contract as `onToken`: never fails the turn,
   * never a kernel event. Only the streaming path can serve it; a `send`-only
   * runtime has no frames to observe and simply never invokes it.
   */
  onToolEvent?: (ev: AgentEventToolCall | AgentEventToolCallUpdate) => void;
}

export interface AgentOutput {
  text: string;
  operations: MeshOp[];
  /**
   * Tools the approval gate refused this turn, in call order, deduplicated.
   *
   * Empty/absent for the ordinary case (nothing gated, or nothing blocked).
   * A runtime without a permission gate never sets it. This is a report of
   * what was held, not a request queue: a refused call cannot be replayed,
   * so granting one of these unlocks the tool for the seat's NEXT turn.
   */
  heldTools?: string[];
  /**
   * True when `operations` came from typed tool calls (MCP `mesh_*`, or the
   * equivalent structured adapter payload) rather than from parsing the
   * model's prose.
   *
   * Under `bus.transport: typed-only` the supervisor ignores parsed ops when
   * this is false, so a model that answers in prose gets one visible retry
   * with the error in context instead of a silent zero-op turn that the
   * circuit breaker must Park later.
   */
  typedOps?: boolean;
  tokensUsed: {
    input: number;
    output: number;
    /**
     * Billable work for THIS turn (input + output + reasoning + cache writes).
     * Deliberately excludes `cacheRead`: with persistent sessions the backend
     * replays the whole transcript every turn and reports it as a cache read,
     * so including it charges the entire history again on each turn and grows
     * without bound.
     */
    total: number;
    /** Replayed/cached prompt prefix. Observability only — never billed. */
    cacheRead?: number;
    /**
     * The reasoning slice of `output`, already counted in it and in `total`.
     *
     * Additive reporting only. `total` above says "input + output + reasoning
     * + cache writes" and that is exactly right: the backend bills reasoning
     * inside `output`, so this is a decomposition of a number already counted,
     * never a new one to add. Summing it into any total is double-billing.
     *
     * Absent, rather than 0, when the backend reported no breakdown — so "we
     * do not know" stays distinguishable from "it did not think", which is the
     * whole point of measuring it.
     */
    thinking?: number;
  };
  model?: string;
  modelVersion?: string;
  temperature?: number;
  toolCalls?: Array<{ name: string; args: unknown; resultDigest: string }>;
  summary?: string;
  /**
   * Turn summary the agent declared explicitly via the `done` op, as opposed to
   * `summary`, which is scraped heuristically from the model's prose. Prefer this
   * when present; scraping drifts per model.
   */
  declaredSummary?: string;
  turnId?: string;
  error?: string;
}

export type AgentRuntimeStatus =
  | "RUNNING"
  | "IDLE"
  | "SUSPENDED"
  | "STOPPED"
  | "UNREACHABLE";

export interface AgentSession {
  sessionId: string;
  agentId: AgentId;
  runtime: RuntimeTypeName;
  createdAt: string;
  handle: unknown;
}

export interface RuntimeContext {
  goalId: GoalId;
  meshId: string;
  workspacePath: string;
  busUrl: string;
  agentToken: string;
  rolePromptText: string;
  capabilityGrants: string[];
  /**
   * Capability tokens among `capabilityGrants` whose tools need an operator
   * grant before use. Absent means nothing is gated.
   */
  approvalRequired?: string[];
  /**
   * Tool names the operator has already unlocked for this session.
   *
   * The grant is per tool, not per call: a denied tool call cannot be replayed
   * — the model re-decides on the next turn — so what the operator unlocks is
   * the tool for the rest of the session, and the surface must say so.
   */
  approvalGranted?: string[];
  env: Record<string, string>;
}

/**
 * One frame of a turn while it is still happening.
 *
 * `AgentOutput` is what a turn WAS; `AgentEvent` is what a turn IS DOING. Both
 * exist on purpose: every turn still ends in an `AgentOutput` (folded by
 * `collectAgentOutput` in packages/agent-runtime), so this union can grow
 * toward live tool visibility without moving the ~20 sites that read the
 * struct. A runtime that cannot stream simply omits `AgentRuntime.stream`.
 *
 * Member names mirror ACP's `session/update` variants
 * (agentclientprotocol.com) WITHOUT depending on ACP, so a runtime that later
 * speaks ACP natively maps onto this union rather than translating between two
 * vocabularies that mean the same thing.
 *
 * Deliberately absent: a `plan` member. ACP carries plans as session updates,
 * but here a plan is an op (`MeshOpPlan`, `op: "plan"`) that already flows
 * through `AgentOutput.operations` and is already projected. A second path for
 * the same fact would give the plan gate two sources of truth.
 *
 * Discriminated on `kind`, never on `op`: tests/protocol/ops-contract.test.ts
 * scrapes this file for `op: "..."` and asserts every hit is a mesh op named in
 * the agent instructions, so an `op`-keyed event would break that contract for
 * a reason that has nothing to do with the bus.
 */
export type AgentEvent =
  | AgentEventMessageChunk
  | AgentEventThoughtChunk
  | AgentEventToolCall
  | AgentEventToolCallUpdate
  | AgentEventTurnEnd;

/**
 * Assistant text as it arrives. Observability only: the authoritative text is
 * `AgentEventTurnEnd.text`, because a backend may revise or re-emit content,
 * so the concatenated deltas are not guaranteed to equal the final message.
 */
export interface AgentEventMessageChunk {
  kind: "agent_message_chunk";
  delta: string;
}

/**
 * Reasoning text as it arrives, mirroring the `"thinking"` case this codebase
 * already distinguishes in `DesignerStreamDelta`. Kept separate from
 * `agent_message_chunk` because thinking must never be appended to the visible
 * transcript nor parsed for ops: a `send` op the model quotes while reasoning
 * aloud is not a request to send anything.
 *
 * No agent runtime emits this yet — the Claude pump taps `text_delta` only.
 */
export interface AgentEventThoughtChunk {
  kind: "agent_thought_chunk";
  delta: string;
}

/**
 * A tool invocation, reported when it STARTS rather than after the turn ends.
 * This is what `AgentOutput.toolCalls` structurally cannot give: an operator
 * watching a slow turn needs to see what the agent is doing while it does it.
 */
export interface AgentEventToolCall {
  kind: "tool_call";
  /** Correlates with a later `tool_call_update`. Unique within the turn. */
  toolCallId: string;
  name: string;
  args: unknown;
  /**
   * Digest available at call time. Named for the field it lands in
   * (`AgentOutput.toolCalls[].resultDigest`) and kept here because the Claude
   * adapter has only the arguments when the call is announced; a backend that
   * reports real results refines it via `tool_call_update`.
   */
  resultDigest?: string;
}

/**
 * Terminal state of a call announced earlier by `tool_call`. Correlated by
 * `toolCallId`, never by arrival order: backends interleave concurrent calls,
 * so position in the stream says nothing about which one finished.
 */
export interface AgentEventToolCallUpdate {
  kind: "tool_call_update";
  toolCallId: string;
  status: "completed" | "failed";
  resultDigest?: string;
}

/**
 * The turn's authoritative result. Exactly one of these ends a stream, and a
 * stream that closes without it is a transport failure, not an empty turn.
 *
 * It carries the parsed payload rather than leaving the fold to derive it,
 * because prose parsing is still a per-backend concern today (`parseMeshOps`
 * lives in agent-runtime). Once ops move to typed MCP tools that
 * parsing disappears and these fields thin out to the stream proper.
 */
export interface AgentEventTurnEnd {
  kind: "turn_end";
  /** Why the turn stopped. `error` means the backend reported failure. */
  stopReason: "end_turn" | "error";
  text: string;
  operations: MeshOp[];
  typedOps?: boolean;
  tokensUsed: AgentOutput["tokensUsed"];
  model?: string;
  modelVersion?: string;
  temperature?: number;
  summary?: string;
  declaredSummary?: string;
  /** Present iff `stopReason` is "error". Surfaced as `AgentOutput.error`. */
  error?: string;
  /**
   * Tools this turn tried to call and the approval gate held. Surfaced as
   * `AgentOutput.heldTools` so the supervisor can show the operator what the
   * seat is actually blocked on, rather than the operator having to guess a
   * tool name and type it in.
   */
  heldTools?: string[];
}

export interface AgentRuntime {
  readonly name: string;
  start(agent: AgentDefinition, context: RuntimeContext): Promise<AgentSession>;
  send(session: AgentSession, input: AgentInput): Promise<AgentOutput>;
  /**
   * Live event stream for one turn, when the backend can provide one.
   *
   * Optional by design: `send` stays the contract every runtime implements, and
   * a runtime that streams implements `send` as a fold over this (see
   * `collectAgentOutput`) so the two can never drift. The supervisor prefers
   * `stream` when present and falls back to `send` otherwise.
   */
  stream?(session: AgentSession, input: AgentInput): AsyncIterable<AgentEvent>;
  interrupt(session: AgentSession): Promise<void>;
  suspend(session: AgentSession): Promise<void>;
  /**
   * Bring a suspended session back.
   *
   * Carries the definition and context because a runtime that tore its backend
   * down on `suspend` needs both to rebuild: the session struct names the
   * transcript but not how to reopen it. Without them an adapter can only flip
   * a status field and hope the next turn repairs things.
   *
   * Returns the live session — whose handle may differ from the one passed in,
   * since rebuilding can mint a new one — or null when the backend could not be
   * reached, which tells the caller to drop its cached session rather than keep
   * a struct pointing at a query nobody is running.
   */
  resume(session: AgentSession, agent: AgentDefinition, context: RuntimeContext): Promise<AgentSession | null>;
  stop(session: AgentSession): Promise<void>;
  getStatus(session: AgentSession): Promise<AgentRuntimeStatus>;
  restoreSession?(agent: AgentDefinition, sessionId: string, context: RuntimeContext): Promise<AgentSession | null>;
  /**
   * Is this session about to have its transcript thrown away?
   *
   * Asked BEFORE the turn, by the supervisor, because the rotation itself is
   * the adapter's business but the response to it is the mesh's. An adapter
   * that simply rotated when it needed to left the mesh no moment at which the
   * outgoing session was both alive and known to be ending — and that moment
   * is the only one in which a continuity record can be written.
   *
   * Optional: a runtime with no notion of a context window answers by not
   * implementing it, and the supervisor skips the whole path.
   */
  rotationPending?(session: AgentSession): RotationPendingInfo | null;
}

/** Why the supervisor is about to spend a turn on a handover. */
export interface RotationPendingInfo {
  /** The context the outgoing session is holding: a per-call prompt size, not a
   * sum over the turn's calls. See `SessionRotationPending.transcriptTokens`. */
  transcriptTokens: number;
  /** The figure `transcriptTokens` was compared against. */
  thresholdTokens: number;
}

/** One turn of designer conversation: persona and model, no mesh session. */
export interface DesignerPromptOptions {
  /** System prompt for this turn (persona/instructions). */
  system?: string;
  /** Per-call model override. Falls back to the runtime's default. */
  model?: string;
  /**
   * Per-call reasoning effort. Omitted means "whatever the backend defaults
   * to", which is what every caller got before this existed.
   *
   * Deliberately per-call rather than a runtime-wide setting, because the two
   * callers on this path want opposite things: the designer chat is a human
   * watching every turn, so a reduction is caught immediately and is worth the
   * tokens, while acceptance-criteria generation shares the same one-shot call
   * on a model that may have no effort support at all. Only the caller knows
   * which of those it is, so only the caller sets it.
   */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /**
   * Remote MCP endpoint the designer may call for this turn, carrying the
   * staging tools plus read-only observability.
   *
   * The turn is correlated by `headers`, not by anything the model says: a
   * staged mutation has to land in the buffer for THIS turn, and a model that
   * echoes an id can echo the wrong one. The runtime's only job is to pass
   * both through to its MCP client config verbatim.
   */
  mcp?: { url: string; headers?: Record<string, string> };
}

export interface DesignerStreamDelta {
  kind: "text" | "thinking";
  delta: string;
}

export interface DesignerStreamResult {
  reply: string;
  thinking: string;
}

export interface ModelCatalogue {
  models: string[];
  default?: string;
  error?: string;
  variants?: Record<string, string[]>;
}

/**
 * The designer's backend, kept deliberately separate from `AgentRuntime`.
 *
 * These are one-shot prompts with no mesh session, no capability grants and no
 * bus identity — the designer is a human's chat partner while they build a
 * mesh, not a seat inside one. Folding them into `AgentRuntime` would oblige
 * every agent backend to answer questions it has no business answering, so
 * they live here and a runtime opts in by implementing this as well.
 *
 * It exists as a port because `apps/mesh-server` previously held the concrete
 * opencode adapter for exactly these five calls, which made the designer
 * unreachable on any other backend.
 */
export interface DesignerRuntime {
  prompt(text: string, opts?: DesignerPromptOptions): Promise<string>;
  promptStream(
    text: string,
    opts?: DesignerPromptOptions,
    onDelta?: (delta: DesignerStreamDelta) => void,
  ): Promise<DesignerStreamResult>;
  listModels(): Promise<ModelCatalogue>;
  /**
   * Late-bind the bus locator. The HTTP server only learns its port at listen
   * time, which is after the designer backend is constructed.
   */
  setDesignerObserve(provider: () => { busUrl: string; token: string } | undefined): void;
  stopAll(): Promise<void>;
}

/**
 * One change the dashboard assistant wants made, described but NOT performed.
 *
 * The assistant never executes: it stages, the operator commits. That split is
 * the whole design, and it is why this is a data shape rather than a method
 * call — a staged mutation can be shown, diffed, refused, or applied hours
 * later by someone who was not in the conversation that produced it.
 *
 * Two apply targets, and they are not interchangeable:
 *   - `config.replace` rewrites the operator's CLIENT-SIDE draft and still
 *     needs a separate Save. Nothing in the running mesh moves.
 *   - every other kind applies SERVER-SIDE to the live run, immediately.
 * The UI must keep these visibly distinct; see `DESTRUCTIVE_KINDS` for the
 * subset that additionally warrants a typed confirmation.
 */
export type StagedMutation =
  | { kind: "config.replace"; yaml: string; reason?: string }
  | { kind: "goal.description"; description: string; reason?: string }
  | { kind: "criteria.add"; criteria: AcceptanceCriterion[]; reason?: string }
  | { kind: "criteria.edit"; criterionId: string; description?: string; mandatory?: boolean; reason?: string }
  /**
   * `reason` is required here alone. Removing a criterion shrinks the
   * denominator completion is measured over, which can flip a live run to
   * COMPLETED — so the operator gets told why, in words, before they press it.
   */
  | { kind: "criteria.delete"; criterionId: string; reason: string }
  | { kind: "seat.spawn"; agent: AgentDefinition; reason?: string }
  | { kind: "seat.retire"; agentId: AgentId; reason: string }
  | { kind: "seat.suspend"; agentId: AgentId; reason?: string }
  | { kind: "seat.resume"; agentId: AgentId; reason?: string }
  | { kind: "seat.wake"; agentId: AgentId; reason?: string }
  | { kind: "run.pause"; reason?: string }
  | { kind: "run.resume"; reason?: string }
  /**
   * Inline rather than `GoalBudget`: that interface requires `tokens`, and the
   * executor (`Supervisor.adjustGoalBudget`) accepts only these two caps.
   */
  | { kind: "run.budget"; budget: { maxEvents?: number; wallClockMinutes?: number }; reason?: string }
  | { kind: "run.reopen"; criteria?: string[]; reason?: string }
  | { kind: "mission.reset"; reason?: string };

/**
 * Kinds that destroy state a run cannot get back by itself, and so earn an
 * extra confirmation step in the dashboard before they are applied.
 *
 * `run.reopen` is here because it invalidates accepted evidence; `config.replace`
 * because it overwrites the operator's whole working draft.
 */
export const DESTRUCTIVE_KINDS: readonly StagedMutation["kind"][] = [
  "config.replace",
  "criteria.delete",
  "seat.retire",
  "run.reopen",
  "mission.reset",
];

/** A turn's worth of staged mutations, applied in array order. */
export interface StagedProposal {
  id: string;
  createdAt: string;
  mutations: StagedMutation[];
  /**
   * Things the assistant could not stage cleanly (an agent id it could not
   * find, a criterion it was asked to edit that no longer exists). Surfaced to
   * the operator alongside what DID stage, so a partial proposal never reads
   * as a complete one.
   */
  problems: string[];
}

export interface AgentContextBundle {
  rolePrompt: string;
  mission: string;
  relevantPolicies: string[];
  agentState: AgentRuntimeState;
  currentTask?: Task;
  relevantDecisions: DecisionRecord[];
  relevantArtifacts: Array<{ ref: string; type: ArtifactType; status: ArtifactStatus; name: string; version: number }>;
  unreadMail: MeshMessage[];
  recentOwnActivity: string[];
  agentMemory: AgentMemoryNote[];
  /**
   * What the previous session in this seat handed over, if there was one.
   *
   * Renders FIRST, ahead of the mission, and is the last thing evicted under
   * pressure. A seat reading this is by definition one whose working memory was
   * just destroyed: everything else in the bundle it could in principle
   * re-derive from the projections, and this is the only part it cannot.
   */
  continuity?: ContinuityRecord;
  /**
   * The run this turn is happening in. Carried on the bundle so anything the
   * agent produces can be stamped with it without re-deriving it from the
   * goal, and so the renderer can tell a record written in THIS run from one
   * inherited across a reopen.
   */
  episode?: EpisodeId;
  /** Count of memory notes dropped by eviction; 0 when nothing was lost. */
  elidedMemory?: number;
  /**
   * Per-section count of what this turn had available but did not include,
   * because a cap cut the list short.
   *
   * Absent keys mean nothing was withheld from that section. Rendered into the
   * prompt so an agent can tell a complete list from the top of a long one —
   * without it, every capped section reads as exhaustive, and an agent shown
   * 3 of 9 open obligations will close 3 and report itself finished.
   */
  omitted?: {
    unread?: number;
    decisions?: number;
    artifacts?: number;
    activity?: number;
    outstanding?: number;
    memory?: number;
  };
  openThreads: Thread[];
  /**
   * Subject for every conversation this bundle's mail mentions, plus every
   * open thread. Absent from bundles assembled by hand (fixtures, adapters
   * that stub a bundle rather than build one), where `openThreads` is the
   * fallback.
   *
   * It exists because the two lists no longer coincide. `openThreads` is the
   * LIVE set, and a settled thread leaves it the moment its last ask is
   * answered (D13) — which is the same moment the answer is sitting unread in
   * a mailbox. Deriving the mail section's titles from the live set therefore
   * dropped the heading off the one conversation whose subject the reader most
   * needs, on the turn the reply arrived.
   */
  threadSubjects?: Record<string, string>;
  budgetSnapshot: { agentTokensUsed: number; agentTokenBudget: number; missionTokensUsed: number; missionTokenBudget: number };
  /**
   * What this agent is still owed, and what it still owes.
   *
   * Without it a timer-woken agent cannot tell whether anything moved since
   * its last turn, so it re-derives the same conclusion and re-sends the same
   * message — which the fingerprint check then counts as a conflict and
   * escalates. The agent was punished for a repetition the context made
   * unavoidable.
   */
  outstanding: {
    /**
     * Asks this agent made that nobody has answered yet.
     *
     * `dueBy` is the ask's own clock, copied from the ledger entry the reducer
     * opened it with — absent when no TTL regime is configured, which is a
     * different statement from a deadline that has passed.
     */
    awaitingResponse: Array<{ messageId: string; to: string[]; type: string; since: string; dueBy?: string }>;
    /** Asks addressed to this agent that it has not discharged. `dueBy` as above. */
    owedByYou: Array<{ messageId: string; from: string; type: string; since: string; dueBy?: string }>;
  };
  /**
   * THIS goal's acceptance criteria, verbatim from the goal record.
   *
   * Without it an agent whose L2 memory says "mission complete" (a memory
   * written under a PREVIOUS goal) concludes there is nothing to do and waits
   * — while the active goal's criteria sit unmet. The criteria are the
   * authoritative to-do list; memories are gossip.
   */
  goalCriteria: Array<{ id: string; description: string; status: string; mandatory: boolean }>;
  /**
   * Whether this agent may spawn sub-workers (`spawn_worker` / `submit_result`).
   *
   * Delegation is off by default (v1 flat mesh: `max_depth: 0`), and every
   * attempt is denied. Documenting the ops unconditionally would invite turns
   * that can only fail, so the contract shows them exactly when they are
   * usable.
   */
  delegationEnabled?: boolean;
  /**
   * Whether this agent may satisfy an acceptance criterion — `approve` on
   * `subject: "criterion:<id>"`, as opposed to approving a reviewed artifact.
   *
   * That branch requires `requirements.accept` or `requirements.approve`, and
   * the kernel refuses every other seat. Same "never advertise a rule that
   * cannot fire" discipline as `delegationEnabled` above: a seat without the
   * authority was being told to close criteria it could only be denied for,
   * and each denial then read as an argument for widening its grant.
   */
  criterionAcceptanceEnabled?: boolean;
  /**
   * Whether this mesh refuses ops parsed out of prose (`bus.transport:
   * "typed-only"`).
   *
   * Same "never advertise a rule that cannot fire" discipline as the two
   * flags above, one channel over. Under typed-only the supervisor parses a
   * `mesh-json` block and then refuses every op in it, so the contract that
   * teaches a seat to emit one is teaching a turn that cannot land -- and the
   * seat is charged a full turn to discover it.
   */
  typedOpsOnly?: boolean;
  /**
   * Effective hard-action policy for this agent: `capabilities` is already
   * intersected with what the agent actually holds AND with the tokens the op
   * layer can enforce, so the prompt never threatens a rule that cannot fire.
   */
  hardActions?: HardActionsPolicy;
  /**
   * How much of each message's content this seat's prompt carries: the whole
   * body (`"full"`, the default and what every mesh written before this key
   * gets), or a one-line claim per message for mail that owes the reader
   * nothing (`"claims"`).
   *
   * Resolved from `agents.<id>.wake.mail` by the turn builder, and read by the
   * renderer with a `"full"` fallback so a hand-built bundle is unchanged.
   * Under `claims` the body is not lost -- it is in the mailbox, and
   * `mesh_inbox` returns it -- but the recipient was not SHOWN it, which is
   * why obliging mail keeps its body in both modes: `message.delivered` marks
   * a message answered once the turn ends, and a seat must never be made to
   * answer something it was not shown.
   */
  wakeMail?: "full" | "claims";
}

export interface CreateGoalInput {
  description: string;
  acceptanceCriteria?: Array<Partial<AcceptanceCriterion> & { id?: string; description: string }>;
  budget?: Partial<GoalBudget>;
}

export interface SendResult {
  accepted: boolean;
  messageId?: MessageId;
  eventId?: EventId;
  reason?: string;
  redirectedTo?: AgentId[];
  escalated?: EscalationId;
  /**
   * Why this send did not get the delivery class it asked for.
   *
   * Present only when an `interrupt` was refused its wake and shipped as
   * `deliver` instead. The send SUCCEEDED -- `accepted` is still true, the
   * message has an id, and the recipient will read it -- so this is not a
   * failure and must not be reported as one. It is the sender being told what
   * its message actually cost, which is the whole difference between a tariff
   * the sender can respond to and a ledger entry nobody reads.
   */
  deliveryDowngraded?: string;
}

export interface ReplayState {
  goalId: GoalId;
  asOfSeq: number;
  goal?: Goal;
  agents: AgentRuntimeState[];
  artifacts: Artifact[];
  threads: Thread[];
  tasks: Task[];
  decisions: DecisionRecord[];
  approvals: ApprovalRecord[];
  escalations: Escalation[];
  budgets: BudgetProjectionEntry[];
  leases: WorkspaceLease[];
  eventCount: number;
}

export interface BudgetProjectionEntry {
  key: string;
  limit: number | null;
  limitKind: "tokens" | "events" | "wallclock_minutes" | "activations";
  reserved: number;
  consumed: number;
  exceeded: boolean;
}

export interface ArtifactTransition {
  to: ArtifactStatus;
  evidenceEventIds?: EventId[];
  comment?: string;
}

export interface PolicyDecisionResult {
  decision: "ALLOW" | "DENY" | "REDIRECT" | "DEFER" | "ESCALATE";
  reason: string;
  ruleId?: string;
  redirects?: AgentId[];
  escalation?: string;
}
