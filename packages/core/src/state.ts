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
  WorkspaceLease,
  AgentMemoryNote,
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
]);

export interface PendingRequest {
  messageId: MessageId;
  from: string;
  to: string[];
  type: string;
  threadId: ThreadId;
  taskId?: string;
  createdAt: string;
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
  pendingRequests: Map<MessageId, PendingRequest>;
  /**
   * Recently discharged asks, newest last. Bounded ring: this is an
   * explanation buffer for operators and for the "was it answered or merely
   * assumed answered?" question, not a second source of truth.
   */
  discharged: DischargeRecord[];
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
    pendingRequests: new Map(),
    discharged: [],
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
    };
    pushBounded(state.discharged, partial, MAX_DISCHARGE_HISTORY);
    return partial;
  }

  state.pendingRequests.delete(messageId);
  const record: DischargeRecord = { messageId, from: pr.from, to: pr.to, type: pr.type, reason, by, at, viaMessageId };
  pushBounded(state.discharged, record, MAX_DISCHARGE_HISTORY);
  return record;
}

/**
 * Reasons that settle ONE debtor's obligation rather than the whole ask.
 *
 * These are all "an agent responded" paths. Everything else — an operator
 * answering or dropping it, a newer artifact version superseding the review,
 * the task completing, a deadlock break, ledger capacity — is a decision
 * about the ask itself and closes it for every debtor at once.
 */
export const PER_DEBTOR_DISCHARGE_REASONS: ReadonlySet<DischargeReason> = new Set<DischargeReason>([
  "reply",
  "in_thread",
  "artifact_review",
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
 * Ask-ledger overflow, handled as a discharge instead of a silent delete.
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

/** Plain-object snapshot of Projections (Maps -> arrays) for SnapshotStore. */
export function exportState(state: Projections): {
  goals: unknown[];
  activeGoalId: unknown;
  agents: unknown[];
  artifacts: unknown[];
  threads: unknown[];
  messages: unknown[];
  tasks: unknown[];
  decisions: unknown[];
  approvals: unknown[];
  escalations: unknown[];
  budgets: unknown[];
  leases: unknown[];
  memory: unknown[];
  pendingRequests: unknown[];
  discharged: unknown[];
  reviewRounds: unknown[];
  conflicts: unknown[];
  modelSpend: unknown[];
  eventCount: number;
  throughSeq: number;
} {
  return {
    goals: [...state.goals.values()],
    activeGoalId: state.activeGoalId,
    agents: [...state.agents.values()],
    artifacts: [...state.artifacts.values()],
    threads: [...state.threads.values()],
    messages: [...state.messages.values()].slice(-2000),
    tasks: [...state.tasks.values()],
    decisions: [...state.decisions.values()],
    approvals: [...state.approvals.values()],
    escalations: [...state.escalations.values()],
    budgets: [...state.budgets.values()].map((b) => ({ ...b, reservations: [...b.reservations] })),
    leases: [...state.leases.values()],
    memory: [...state.memory.entries()].map(([k, v]) => [k, [...v.entries()]]),
    pendingRequests: [...state.pendingRequests.values()],
    discharged: [...state.discharged],
    reviewRounds: [...state.reviewRounds.entries()],
    conflicts: [...state.conflicts.values()],
    // Sets do not survive JSON; the agent list is small and worth keeping.
    modelSpend: [...state.modelSpend.values()].map((m) => ({ ...m, agents: [...m.agents] })),
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
  tasks?: unknown[];
  decisions?: unknown[];
  approvals?: unknown[];
  escalations?: unknown[];
  budgets?: Array<Record<string, unknown>>;
  leases?: unknown[];
  memory?: Array<[string, Array<[string, unknown]>]>;
  pendingRequests?: unknown[];
  discharged?: unknown[];
  reviewRounds?: unknown[];
  conflicts?: unknown[];
  modelSpend?: unknown[];
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
  for (const [k, entries] of (data.memory ?? [])) state.memory.set(k, new Map(entries as Array<[string, never]>));
  if (typeof data.activeGoalId === "string" && data.activeGoalId) state.activeGoalId = data.activeGoalId as never;
  for (const pr of (data.pendingRequests ?? []) as Array<{ messageId: string }>) {
    state.pendingRequests.set((pr as { messageId: string }).messageId as never, pr as never);
  }
  state.discharged = [...((data.discharged ?? []) as DischargeRecord[])];
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
  if (typeof data.eventCount === "number" && Number.isFinite(data.eventCount)) state.eventCount = data.eventCount;
  if (data.throughSeq !== undefined) state.lastEventSeq = data.throughSeq;
}
