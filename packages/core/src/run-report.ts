/**
 * What a finished run actually produced, in words.
 *
 * The mesh has always been *queryable* — an event log, an artifact table, a
 * dashboard — but it had no **output**: a run ended by printing
 * `goal COMPLETED — shutting down` and nothing anywhere answered "so what did
 * it make, and should I trust it?". This module is that answer, composed
 * purely from projections so it works identically for the CLI at shutdown, an
 * HTTP endpoint, or a replayed log.
 *
 * Two rules keep it honest:
 *
 * 1. **Settled means delivered.** A REJECTED draft and a FINAL deliverable are
 *    not the same thing, and a report that lists both as "artifacts" is worse
 *    than no report — it launders a failure into a shipping list.
 *    `isSettledArtifactStatus` is the single source for that distinction.
 * 2. **Evidence carries its own doubt.** `EvidenceRef.verified === false` means
 *    the claiming turn invoked zero tools: the agent's own word, nothing read
 *    or run. That travels into the report rather than being flattened away,
 *    because "criterion met" and "agent said criterion met" are different
 *    claims and only one of them is worth shipping on.
 *
 * ## Import weight (deliberate — do not add value imports)
 *
 * Two *value* imports below. The bar for a third is the test both already pass:
 * does importing it drag AJV or the supervisor graph in behind it?
 *
 *   - `../../protocol/src/catalog`, a const table that itself imports nothing
 *     but types. That used to be load-bearing here, because the dashboard
 *     deep-imported the verdict phrasing from this file; the phrasing now lives
 *     in the catalog, so the browser reads it there and nothing in the bundle
 *     touches this module.
 *   - `./state`, for `outstandingDebtors` and `UNANSWERED_DISCHARGE_REASONS`.
 *     It carries no transitive weight at all: its only two imports are an
 *     `import type` and a type-position `import(...)`, both fully erased, so the
 *     emitted require reaches a module body of plain consts and functions and
 *     stops. Both symbols answer questions this file MUST answer the same way
 *     the ledger does, and a hand-copy of either diverges silently rather than
 *     loudly — an unanswered reason added to the real set and not mirrored here
 *     would under-count the one section that exists to report silent loss.
 *
 * The discipline is still worth keeping: `apps/mesh-server` resolves this module
 * lazily so a build without it answers 501 on one route instead of failing to
 * boot, and that stays cheap only while the rule above holds.
 */
import { isSettledArtifactStatus, verdictText } from "../../protocol/src/catalog";
import type {
  Artifact,
  ArtifactStatus,
  Escalation,
  Goal,
  InteractionMode,
  MeshMessage,
} from "../../protocol/src/types";
import { outstandingDebtors, UNANSWERED_DISCHARGE_REASONS } from "./state";
import type { DischargeReason, Projections } from "./state";
import type { AliasStats } from "../../protocol/src/op-aliases";

/** An artifact as the report talks about it — flattened, no content. */
export interface RunReportArtifact {
  id: string;
  name: string;
  type: string;
  status: ArtifactStatus;
  version: number;
  owner: string;
  /** Where the content lives, so a reader can go get it. */
  contentRef: string;
  createdAt: string;
}

/** One acceptance criterion and how well it is actually backed. */
export interface RunReportCriterion {
  id: string;
  description: string;
  mandatory: boolean;
  status: string;
  /** Evidence entries recorded against it. */
  evidenceCount: number;
  /**
   * True when at least one evidence entry came from a turn that invoked no
   * tools. The criterion may still be marked satisfied — this is the caveat.
   */
  assertedOnly: boolean;
  /** Artifact URIs / event ids cited as evidence, newest last. */
  evidence: string[];
}

export interface RunReportEscalation {
  id: string;
  reason: string;
  title: string;
  raisedBy: string;
  status: string;
  advisory: boolean;
  createdAt: string;
  respondedAt?: string;
  response?: string;
}

export interface RunReportUnfinished {
  /** Tasks never claimed by anybody. */
  open: Array<{ id: string; title: string }>;
  /** Tasks claimed but never completed. */
  claimed: Array<{ id: string; title: string; claimedBy?: string }>;
  /** Requests that never got an answer. */
  pendingRequests: Array<{ id: string; from: string; to: string[]; type: string }>;
  /**
   * Asks that WERE settled, by a reply that did not answer them.
   *
   * The counterpart to `pendingRequests`, and the more dangerous half. An
   * unanswered ask is visible: it sits on the ledger, it gets nudged, it shows
   * up above. An ask closed by an empty or contentless reply looks finished
   * from every angle -- the debt is gone, the asker's loop moved on -- so
   * before the contract `response` schema existed there was nothing anywhere
   * that recorded the difference between "answered" and "replied to".
   *
   * This is a report, not a verdict: the settlement stood, and the mesh kept
   * running. Listing them is how an operator finds out.
   */
  thinAnswers: Array<{ id: string; from: string; to: string[]; type: string; issues: string[] }>;
  /**
   * Discussions that ran to the edge of their box instead of being closed.
   *
   * Reported next to the unfinished work rather than under spend, because
   * that is what an overrun IS: two agents who never reached the point where
   * one of them could say it was done. The tokens are already counted in
   * `spend` -- this says which conversation to blame them on.
   */
  collabOverruns: Array<{
    threadId: string;
    topic: string;
    participants: string[];
    exchanges: number;
    maxExchanges: number;
    reason: string;
  }>;
}

/**
 * What the agents said to each other, and what the saying cost.
 *
 * Every other section of this report is about WORK -- what was made, what was
 * owed, what was left. This one is about the CHANNEL, and it is separate from
 * `unfinished` because the channel fails in ways that leave no mark on the
 * work at all. Mail delivered into a box and never read, mail the box cap
 * destroyed, a send a policy turned away: in every other projection each of
 * those is indistinguishable from a mesh whose agents simply had nothing to
 * say. A run that "finished cleanly" having thrown away half its traffic
 * looks, from the rest of this report, exactly like one that did not.
 *
 * The bar for a field here is that an operator can DO something about it. A
 * message count is not that -- which is why `volume` exists but never renders
 * on its own: it is the denominator the findings are read against, not a
 * finding. The text renderer emits nothing at all for a mission whose comms
 * were clean, however much it talked.
 */
export interface RunReportComms {
  /**
   * Traffic shape, by the mode that decides what a message obliges.
   *
   * Not a scoreboard. It is here so the findings below have a size to be read
   * against -- "5 unread" means one thing out of 8 messages and another out
   * of 800 -- and so the low-contact question ("what KIND of talking was
   * this?") has an answer at all. A mesh that is nearly all `broadcast` is
   * announcing into the void: broadcasts oblige nobody and cannot be replied
   * to, so they buy attention without buying an answer.
   */
  volume: {
    total: number;
    /** `service`: a directed ask or answer between named seats. The default. */
    service: number;
    /** `collab`: bounded discussion, obliges nobody, metered by its own clock. */
    collab: number;
    /** `broadcast`: addressed to the roster, unanswerable. */
    broadcast: number;
    /**
     * The two seats that carried the most traffic between them, directed
     * only. Absent when nothing was sent.
     *
     * The actionable form of "who talked to whom": it names the one coupling
     * worth looking at, where a full matrix would name every pair and
     * therefore none of them.
     */
    heaviestPair?: { from: string; to: string; messages: number };
  };
  /**
   * Mail sitting unread in a mailbox when the run ended, worst box first.
   *
   * The run report has never been able to say this, and it is the difference
   * between a seat that considered its mail and a seat that never saw it. An
   * ask in here was made, delivered, counted against the asker's patience,
   * and read by nobody -- so the asker's nudges, its stalemate, and any
   * escalation that followed were all chasing a message that was never shown.
   *
   * Counts message IDS -- deliberately NOT `readableMailDepth`, which every
   * other depth in the tree now uses. Those two answer different questions and
   * this one is the accounting question: an id whose body fell off the
   * snapshot's message tail still counts here, because the mail was owed
   * whether or not its body survived. `readableMailDepth` answers "can this
   * seat open it", which is what an attention signal and a wake gate need and
   * what this report must not ask.
   */
  unread: Array<{ agent: string; messages: number }>;
  /**
   * Mail the `MAX_UNREAD_PER_AGENT` cap destroyed, per agent.
   *
   * Distinct from `unread` in the only way that matters: unread mail is still
   * there, and this is not. The cap drops oldest-first and silently, so
   * without this line a flooded seat and a quiet one are the same seat. There
   * is nothing to re-read and no turn that will show it -- the only actions
   * left are to raise the box or to stop the flood, and an operator cannot
   * choose either without knowing it happened.
   */
  dropped: Array<{ agent: string; messages: number }>;
  /**
   * Sends the mesh refused, grouped by who refused them and why.
   *
   * `refusedBy` is the first thing to read, because only one of the two is
   * the operator's to change: `policy` means a rule in this mesh's own config
   * said no, and `protocol` means the envelope failed validation, which is a
   * defect in the sending agent or the tool it used. Answering a run of
   * refusals with a config edit when validation was rejecting them is how an
   * operator loosens a policy that was never the problem.
   *
   * Grouped rather than listed: the finding is "this rule stopped four
   * sends", not four near-identical lines. `from`/`to`/`type` are one example
   * from the group, so the line names a real pair rather than a statistic.
   */
  refused: Array<{
    refusedBy: "policy" | "protocol";
    /** The policy rule that refused it. Absent when validation did. */
    rule?: string;
    reason: string;
    count: number;
    from: string;
    to: string[];
    type: string;
  }>;
  /**
   * Asks that left the ledger without ever being answered.
   *
   * The gap between `unfinished.pendingRequests` (asks still open, visible,
   * nudged) and `unfinished.thinAnswers` (asks answered badly). These are
   * neither: the ask was taken off the ledger by the runtime -- the cap
   * evicted it, a deadlock break voided it, its deadline passed, or the
   * ledger was full and never accepted it -- and in every one of those cases
   * the ASKER WAS NOT TOLD. It is still parked on a reply that no longer
   * exists anywhere in the system, and nothing else in this report or the
   * dashboard records that the ask was ever made.
   *
   * A refusal (`refused`) is deliberately not here: the debtor said no and
   * the asker heard it. That is an answer.
   */
  lostAsks: Array<{ id: string; from: string; to: string[]; type: string; reason: DischargeReason }>;
  /**
   * Prose alias rewrites the CALLER observed, or absent when it supplied none.
   *
   * The one field here that is not a projection, which is why it arrives as an
   * argument rather than a module read: `op-aliases.ts` counts process-wide and
   * deliberately so, and a report that quietly reached for that global would
   * stop being pure -- and would answer a different question from the one it
   * claims to, since the counter is not scoped to this goal.
   *
   * Present even when `total` is 0, because that zero is the finding that
   * matters: it is the precondition for ever retiring the tables. The TEXT
   * prints a line only when it is non-zero (`volume` is never the reason a
   * section appears, and neither is this) -- the JSON always carries it, which
   * is where anything measuring across runs should read it.
   */
  aliases?: AliasStats;
}

export interface RunReportSpend {
  tokens: number;
  events: number;
  byModel: Array<{ model: string; tokens: number; input: number; output: number; turns: number }>;
}

/**
 * A finished run, described. Plain serializable data end to end: no class
 * instances, no Maps, no Dates — it round-trips through `JSON.stringify`
 * unchanged so the HTTP layer can hand it over untouched.
 */
export interface RunReport {
  generatedAt: string;
  goal: {
    id: string;
    description: string;
    status: string;
    createdAt: string;
    completedAt?: string;
    /** Set when the operator reopened the mission; evidence before it is stale. */
    reopenedAt?: string;
    durationMs?: number;
  } | null;
  verdict: {
    /** Raw reason literal, preserved so tooling can switch on it. */
    reason: string;
    title: string;
    summary: string;
    /** True only for a goal that actually reached COMPLETED. */
    succeeded: boolean;
  };
  criteria: {
    total: number;
    mandatory: number;
    satisfied: number;
    mandatorySatisfied: number;
    /** Mandatory criteria satisfied only by an agent's unverified word. */
    assertedOnly: number;
    items: RunReportCriterion[];
  };
  /** Settled artifacts — the deliverables. */
  delivered: RunReportArtifact[];
  /** Artifacts still mid-flight: drafts, in review, proposed. */
  inProgress: RunReportArtifact[];
  /** Artifacts explicitly rejected. */
  rejected: RunReportArtifact[];
  escalations: {
    open: number;
    answered: number;
    items: RunReportEscalation[];
  };
  unfinished: RunReportUnfinished;
  /** What the mission's agents said to each other, and what it cost. */
  comms: RunReportComms;
  spend: RunReportSpend;
}

/** Criterion statuses that count as satisfied. WAIVED counts: a human said so. */
const SATISFIED_CRITERION_STATUSES = ["EVIDENCED", "WAIVED"];

function flattenArtifact(a: Artifact): RunReportArtifact {
  return {
    id: a.id,
    name: a.name,
    type: a.type,
    status: a.status,
    version: a.version,
    owner: a.owner,
    contentRef: a.contentRef,
    createdAt: a.createdAt,
  };
}

/**
 * Why a run ended, derived from state rather than taken on trust.
 *
 * The goal's own status is the spine: COMPLETED is the only success. For a
 * stopped-but-not-completed run the newest goal-history entry usually carries
 * the termination reason; failing that, the newest open escalation explains it.
 */
function deriveVerdict(state: Projections, goal: Goal | null): RunReport["verdict"] {
  const succeeded = goal?.status === "COMPLETED";
  const historyReason = [...state.goalHistory].reverse().find((h) => h.reason)?.reason;
  const openEscalation = [...state.escalations.values()]
    .filter((e) => e.status === "OPEN" && !e.advisory && (!goal || e.goalId === goal.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .pop();

  if (succeeded) {
    const text = verdictText(historyReason ?? "all_mandatory_criteria_evidenced");
    return { reason: historyReason ?? "all_mandatory_criteria_evidenced", title: text.title, summary: text.summary, succeeded: true };
  }

  const reason = historyReason ?? openEscalation?.reason ?? (goal ? `goal_${goal.status.toLowerCase()}` : "no_goal");
  const waiting = [...state.escalations.values()].filter(
    (e) => e.status === "OPEN" && !e.advisory && (!goal || e.goalId === goal.id),
  ).length;
  const agents = [...state.agents.values()]
    .filter((a) => a.state.lifecycle === "FAILED")
    .map((a) => a.state.agentId);
  const text = verdictText(reason, { waiting, agents });
  return { reason, title: text.title, summary: text.summary, succeeded: false };
}

function summarizeCriteria(goal: Goal | null): RunReport["criteria"] {
  const items: RunReportCriterion[] = (goal?.acceptanceCriteria ?? []).map((c) => {
    // `verified === false` is the meaningful signal: absent means the operator
    // recorded it out of band, which is verified by definition.
    const assertedOnly = c.evidence.some((e) => e.verified === false);
    return {
      id: c.id,
      description: c.description,
      mandatory: c.mandatory,
      status: c.status,
      evidenceCount: c.evidence.length,
      assertedOnly,
      evidence: c.evidence.map((e) => e.artifactRef?.uri ?? e.eventId ?? e.kind),
    };
  });
  const satisfied = items.filter((c) => SATISFIED_CRITERION_STATUSES.includes(c.status));
  const mandatory = items.filter((c) => c.mandatory);
  return {
    total: items.length,
    mandatory: mandatory.length,
    satisfied: satisfied.length,
    mandatorySatisfied: mandatory.filter((c) => SATISFIED_CRITERION_STATUSES.includes(c.status)).length,
    assertedOnly: mandatory.filter((c) => c.assertedOnly && SATISFIED_CRITERION_STATUSES.includes(c.status)).length,
    items,
  };
}

function summarizeEscalation(e: Escalation): RunReportEscalation {
  const detail = (e.detail && typeof e.detail === "object" ? e.detail : {}) as Record<string, unknown>;
  const agents = Array.isArray(detail.failedAgents) ? (detail.failedAgents as string[]) : undefined;
  return {
    id: e.id,
    reason: e.reason,
    title: verdictText(e.reason, { agents }).title,
    raisedBy: e.raisedBy,
    status: e.status,
    advisory: e.advisory === true,
    createdAt: e.createdAt,
    respondedAt: e.respondedAt,
    response: e.response,
  };
}

/**
 * What mode a message was sent in, defaulting an absent one to `service`.
 *
 * A THIRD local copy of that default. The other two are the `message.sent`
 * reducer (`projections-messaging.ts`, `(m.control?.mode ?? "service")`,
 * which decides whether the ask opens a ledger entry) and `obligesRecipients`
 * (`context.ts`, which decides inbox order). This module may not take a value
 * import from either -- see "Import weight" at the top of this file -- so the
 * duplication is deliberate, and named here so it is findable from any of the
 * three.
 *
 * The default is load-bearing rather than defensive: every message written
 * before `control.mode` existed has no mode, and reading those as a fourth,
 * unnamed traffic class would put the whole pre-mode history in a bucket that
 * means nothing. `service` is what they all were.
 *
 * Read off `control`, never `payload`: `payload` is verbatim agent input, so
 * a sender could otherwise relabel its own chatter as an announcement and
 * disappear from this report's directed-traffic count.
 */
function messageMode(m: MeshMessage): InteractionMode {
  const mode = m.control?.mode;
  return mode === "broadcast" || mode === "collab" ? mode : "service";
}

/**
 * The comms section, composed from projections alone.
 *
 * Only `messages` carries a `goalId`, so only traffic is scoped to the
 * mission. The bounded rings (`refusedSends`, `discharged`) and the mailbox
 * maps carry no goal, so they are mesh-wide -- the same treatment
 * `collabOverruns` already gives `collabSessions`, and the honest one: a
 * refusal or a destroyed message has no mission to be attributed to.
 */
function summarizeComms(state: Projections, goal: Goal | null, aliases?: AliasStats): RunReportComms {
  const messages = [...state.messages.values()].filter((m) => !goal || m.goalId === goal.id);

  let service = 0;
  let collab = 0;
  let broadcast = 0;
  const pairs = new Map<string, { from: string; to: string; messages: number }>();
  for (const m of messages) {
    const mode = messageMode(m);
    if (mode === "broadcast") {
      // Counted, but never paired. A broadcast addresses the whole roster, so
      // letting it contribute pairs would make the heaviest pair a function
      // of headcount rather than of who actually talks to whom -- and in a
      // mesh of six seats one announcement would outweigh five real asks.
      broadcast++;
      continue;
    }
    if (mode === "collab") collab++;
    else service++;
    for (const to of m.to) {
      // The delivery reducer skips the sender's own box; a self-addressed
      // recipient is an addressing artefact, not a conversation.
      if (to === m.from) continue;
      const key = `${m.from}\u0000${to}`;
      const entry = pairs.get(key);
      if (entry) entry.messages++;
      else pairs.set(key, { from: m.from, to, messages: 1 });
    }
  }
  const rankedPairs = [...pairs.values()].sort(
    (a, b) => b.messages - a.messages || a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  );

  const byCountThenName = (a: { agent: string; messages: number }, b: { agent: string; messages: number }) =>
    b.messages - a.messages || a.agent.localeCompare(b.agent);

  // Raw ids, on purpose -- see this field's comment in `RunReportComms`. This
  // is the one depth in the tree that is NOT `readableMailDepth`.
  const unread = [...state.unread.entries()]
    .map(([agent, ids]) => ({ agent, messages: ids.length }))
    .filter((u) => u.messages > 0)
    .sort(byCountThenName);

  const dropped = [...state.mailOverflowDropped.entries()]
    .map(([agent, messages]) => ({ agent, messages }))
    .filter((d) => d.messages > 0)
    .sort(byCountThenName);

  // `ruleId` present means a policy rule said no; absent means protocol
  // validation did. That is the whole distinction, and it is recorded at the
  // refusal site rather than inferred from the reason string, which is prose.
  const refusedGroups = new Map<string, RunReportComms["refused"][number]>();
  for (const r of state.refusedSends) {
    const refusedBy = r.ruleId ? "policy" : "protocol";
    const key = `${refusedBy}\u0000${r.ruleId ?? ""}\u0000${r.reason}`;
    const existing = refusedGroups.get(key);
    if (existing) {
      existing.count++;
      continue;
    }
    refusedGroups.set(key, {
      refusedBy,
      rule: r.ruleId,
      reason: r.reason,
      count: 1,
      from: r.from,
      to: r.to,
      type: r.type,
    });
  }
  const refused = [...refusedGroups.values()].sort((a, b) => {
    // Policy first: it is the half the operator can actually change.
    if (a.refusedBy !== b.refusedBy) return a.refusedBy === "policy" ? -1 : 1;
    return b.count - a.count || a.reason.localeCompare(b.reason);
  });

  const lostAsks = state.discharged
    .filter((d) => UNANSWERED_DISCHARGE_REASONS.has(d.reason))
    .map((d) => ({ id: d.messageId, from: d.from, to: d.to, type: d.type, reason: d.reason }));

  return {
    volume: {
      total: messages.length,
      service,
      collab,
      broadcast,
      ...(rankedPairs.length > 0 ? { heaviestPair: rankedPairs[0] } : {}),
    },
    unread,
    dropped,
    refused,
    lostAsks,
    ...(aliases ? { aliases } : {}),
  };
}

/**
 * Compose the report for the active goal (or `goalId`, to report on an older
 * mission in the same log).
 *
 * Pure and synchronous: everything it needs is either in projections or handed
 * to it, so it can be called from a shutdown path, an HTTP handler, or a test
 * without a supervisor, a content store, or an await. `opts.aliases` is the
 * one non-projection input, passed explicitly so that stays true.
 */
export function buildRunReport(state: Projections, goalId?: string, opts?: { aliases?: AliasStats }): RunReport {
  const id = goalId ?? state.activeGoalId;
  const goal = (id ? state.goals.get(id) : undefined) ?? null;
  const scoped = <T extends { goalId: string }>(v: Iterable<T>): T[] =>
    [...v].filter((x) => !goal || x.goalId === goal.id);

  const artifacts = scoped(state.artifacts.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const delivered: RunReportArtifact[] = [];
  const inProgress: RunReportArtifact[] = [];
  const rejected: RunReportArtifact[] = [];
  for (const a of artifacts) {
    const flat = flattenArtifact(a);
    if (isSettledArtifactStatus(a.status)) delivered.push(flat);
    else if (a.status === "REJECTED") rejected.push(flat);
    else inProgress.push(flat);
  }

  const escalations = scoped(state.escalations.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const tasks = scoped(state.tasks.values()).filter((t) => !t.id.startsWith("watch:"));
  const pending = [...state.pendingRequests.values()].filter((p) => !goal || !p.goalId || p.goalId === goal.id);

  const byModel = [...state.modelSpend.values()]
    .map((m) => ({ model: m.model, tokens: m.tokens, input: m.input, output: m.output, turns: m.turns }))
    .sort((a, b) => b.tokens - a.tokens);

  const durationMs =
    goal && goal.completedAt
      ? Math.max(0, Date.parse(goal.completedAt) - Date.parse(goal.createdAt))
      : goal && state.lastEventAt
        ? Math.max(0, Date.parse(state.lastEventAt) - Date.parse(goal.createdAt))
        : undefined;

  return {
    generatedAt: new Date().toISOString(),
    goal: goal
      ? {
          id: goal.id,
          description: goal.description,
          status: goal.status,
          createdAt: goal.createdAt,
          completedAt: goal.completedAt,
          reopenedAt: goal.reopenedAt,
          durationMs: Number.isFinite(durationMs) ? durationMs : undefined,
        }
      : null,
    verdict: deriveVerdict(state, goal),
    criteria: summarizeCriteria(goal),
    delivered,
    inProgress,
    rejected,
    escalations: {
      open: escalations.filter((e) => e.status === "OPEN").length,
      answered: escalations.filter((e) => e.status !== "OPEN").length,
      items: escalations.map(summarizeEscalation),
    },
    unfinished: {
      open: tasks.filter((t) => t.status === "OPEN").map((t) => ({ id: t.id, title: t.title })),
      claimed: tasks.filter((t) => t.status === "CLAIMED").map((t) => ({ id: t.id, title: t.title, claimedBy: t.claimedBy })),
      // `outstandingDebtors`, not `p.to`: once one recipient of a multi-addressed
      // ask has answered, the remainder ARE the debt. Rendering `to` named every
      // original recipient as never having answered — the same over-count the
      // catalog's obligation note describes, where nudges and stalemate detection
      // pointed at agents who were never individually asked. `context.ts:457` and
      // `supervisor.ts:6227` both already ask it this way; this was the last site
      // that did not. Byte-identical output whenever `outstanding` is absent.
      pendingRequests: pending.map((p) => ({ id: p.messageId, from: p.from, to: outstandingDebtors(p), type: p.type })),
      // `responseValid === false` is the meaningful signal, exactly as with
      // `EvidenceRef.verified`: absent means the ask carried no contract or
      // the contract specified no answer shape, which is "not checked", not
      // "failed". Only an explicit false is a finding.
      thinAnswers: state.discharged
        .filter((d) => d.responseValid === false)
        .map((d) => ({ id: d.messageId, from: d.from, to: d.to, type: d.type, issues: d.responseIssues ?? [] })),
      // OVERRUN only. A session still OPEN at report time is reported as part
      // of the run being unfinished, and a CLOSED one cost nothing worth
      // saying: someone decided it was done, which is the outcome this whole
      // mode is trying to produce.
      collabOverruns: [...state.collabSessions.values()]
        .filter((c) => c.status === "OVERRUN")
        .map((c) => ({
          threadId: c.threadId,
          topic: c.topic,
          participants: c.participants,
          exchanges: c.exchanges,
          maxExchanges: c.maxExchanges,
          reason: c.closedReason ?? "overrun",
        })),
    },
    comms: summarizeComms(state, goal, opts?.aliases),
    spend: {
      tokens: byModel.reduce((n, m) => n + m.tokens, 0),
      events: state.eventCount,
      byModel,
    },
  };
}

function humanDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function humanTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Render a report as terminal text.
 *
 * Ordered by what a person needs first: the verdict, then what they can
 * actually use (delivered artifacts), then how much to trust it (evidence),
 * then what is still owed. Failures and unfinished work are never omitted for
 * brevity — a summary that hides them is how a stalled run gets mistaken for a
 * finished one.
 */
export function renderRunReport(report: RunReport): string {
  const out: string[] = [];
  const rule = "─".repeat(64);
  const bullet = (s: string) => `  ${s}`;

  out.push("");
  out.push(rule);
  out.push(`  ${report.verdict.succeeded ? "✔" : "✖"}  ${report.verdict.title.toUpperCase()}`);
  out.push(rule);
  if (report.goal) {
    out.push("");
    out.push(bullet(`goal: ${report.goal.description}`));
    const meta = [
      report.goal.status.toLowerCase(),
      report.goal.durationMs !== undefined ? humanDuration(report.goal.durationMs) : null,
      `${report.spend.events} events`,
      report.spend.tokens > 0 ? `${humanTokens(report.spend.tokens)} tokens` : null,
    ].filter(Boolean);
    out.push(bullet(`      ${meta.join("  ·  ")}`));
  }
  out.push("");
  out.push(bullet(report.verdict.summary));

  if (report.delivered.length > 0) {
    out.push("");
    out.push(`  DELIVERED (${report.delivered.length})`);
    for (const a of report.delivered) {
      out.push(bullet(`  ${a.name.padEnd(30)} ${a.type.padEnd(18)} v${a.version} ${a.status.toLowerCase()}`));
      out.push(bullet(`  ${" ".repeat(30)} ${a.contentRef}`));
    }
  } else {
    out.push("");
    out.push("  DELIVERED (0)");
    out.push(bullet("  nothing reached a settled state — this run produced no deliverable."));
  }

  const { criteria } = report;
  if (criteria.total > 0) {
    out.push("");
    out.push(`  ACCEPTANCE (${criteria.mandatorySatisfied}/${criteria.mandatory} mandatory met)`);
    for (const c of criteria.items) {
      const met = SATISFIED_CRITERION_STATUSES.includes(c.status);
      const mark = met ? "✔" : c.status === "ASSERTED" ? "~" : "·";
      const tag = c.mandatory ? "" : " (optional)";
      out.push(bullet(`${mark} ${c.description}${tag}`));
      if (met && c.evidence.length > 0) {
        out.push(bullet(`    evidence: ${c.evidence.slice(0, 3).join(", ")}${c.evidence.length > 3 ? ` (+${c.evidence.length - 3})` : ""}`));
      }
      if (c.assertedOnly) {
        out.push(bullet("    ! claimed without tool use — the agent's own word, nothing was read or run"));
      }
      if (!met && c.evidence.length === 0) {
        out.push(bullet("    no evidence recorded"));
      }
    }
  }

  if (report.rejected.length > 0) {
    out.push("");
    out.push(`  REJECTED (${report.rejected.length})`);
    for (const a of report.rejected) out.push(bullet(`✖ ${a.name.padEnd(30)} ${a.type} v${a.version}`));
  }

  if (report.inProgress.length > 0) {
    out.push("");
    out.push(`  UNFINISHED DRAFTS (${report.inProgress.length})`);
    for (const a of report.inProgress) out.push(bullet(`· ${a.name.padEnd(30)} ${a.type.padEnd(18)} ${a.status.toLowerCase()}`));
  }

  const openEsc = report.escalations.items.filter((e) => e.status === "OPEN");
  if (openEsc.length > 0) {
    out.push("");
    out.push(`  NEEDS YOU (${openEsc.length})`);
    for (const e of openEsc) {
      out.push(bullet(`! ${e.title}${e.advisory ? "  (advisory)" : ""}`));
      out.push(bullet(`    raised by ${e.raisedBy} · mesh respond ${e.id} "<your answer>"`));
    }
  }

  const { unfinished } = report;
  const owed = unfinished.open.length + unfinished.claimed.length + unfinished.pendingRequests.length;
  if (owed > 0) {
    out.push("");
    out.push(`  LEFT UNFINISHED (${owed})`);
    for (const t of unfinished.claimed) out.push(bullet(`· ${t.title} — claimed by ${t.claimedBy ?? "?"}, never finished`));
    for (const t of unfinished.open) out.push(bullet(`· ${t.title} — never picked up`));
    for (const p of unfinished.pendingRequests) out.push(bullet(`· ${p.from} → ${p.to.join(", ")} (${p.type}) — never answered`));
  }

  if (unfinished.thinAnswers.length > 0) {
    out.push("");
    out.push(`  ANSWERED THINLY (${unfinished.thinAnswers.length})`);
    for (const t of unfinished.thinAnswers) {
      out.push(bullet(`· ${t.to.join(", ")} → ${t.from} (${t.type}) — settled, but the reply carried no answer`));
      if (t.issues.length > 0) out.push(bullet(`    ${t.issues.join("; ")}`));
    }
  }

  if (unfinished.collabOverruns.length > 0) {
    out.push("");
    out.push(`  RAN LONG (${unfinished.collabOverruns.length})`);
    for (const c of unfinished.collabOverruns) {
      const how = c.reason === "expired" ? "ran out of time" : `used all ${c.maxExchanges} exchanges`;
      out.push(bullet(`· "${c.topic}" — ${c.participants.join(", ")} ${how} (${c.exchanges} messages), never closed it`));
    }
  }

  const { comms } = report;
  // The section renders only when it has a FINDING. `volume` is never a
  // reason to print: a mission that talked a lot and lost nothing has nothing
  // here an operator can act on, and a header over one message count is how a
  // report starts training people to skip it. The numbers stay in the JSON
  // either way, for anyone measuring across runs.
  // A non-zero alias count IS a finding: a seat is inventing names the mesh has
  // to translate, which is something an operator can act on. A ZERO is not, and
  // must not open the section -- else every clean run prints a COMMS header over
  // nothing, which is how a report starts training people to skip it.
  const commsFindings =
    comms.unread.length +
    comms.dropped.length +
    comms.refused.length +
    comms.lostAsks.length +
    (comms.aliases && comms.aliases.total > 0 ? 1 : 0);
  if (commsFindings > 0) {
    out.push("");
    out.push("  COMMS");
    if (comms.volume.total > 0) {
      const { total, service, collab, broadcast, heaviestPair } = comms.volume;
      const shape = `${total} message${total === 1 ? "" : "s"} — ${service} directed, ${collab} collab, ${broadcast} broadcast`;
      const heaviest = heaviestPair ? `; heaviest ${heaviestPair.from} → ${heaviestPair.to} (${heaviestPair.messages})` : "";
      out.push(bullet(`· ${shape}${heaviest}`));
    }
    if (comms.unread.length > 0) {
      const boxes = comms.unread.map((u) => `${u.agent} ${u.messages}`).join(", ");
      out.push(bullet(`· delivered and never read: ${boxes} — the run ended with mail nobody was shown`));
    }
    if (comms.dropped.length > 0) {
      const boxes = comms.dropped.map((d) => `${d.agent} ${d.messages}`).join(", ");
      out.push(bullet(`· destroyed by the mailbox cap: ${boxes} — those messages are gone, not queued`));
    }
    if (comms.aliases && comms.aliases.total > 0) {
      const { total, byRewrite } = comms.aliases;
      const worst = byRewrite.slice(0, 3).map((b) => `${b.rewrite} x${b.count}`).join(", ");
      out.push(bullet(`· ${total} prose rewrite${total === 1 ? "" : "s"} went through the alias tables — ${worst}. A seat is inventing names; the tables are load-bearing until it stops.`));
    }
    for (const r of comms.refused) {
      const who = r.refusedBy === "policy" ? `policy rule ${r.rule} refused` : "protocol validation refused";
      out.push(bullet(`· ${who} ${r.count} send${r.count === 1 ? "" : "s"} — e.g. ${r.from} → ${r.to.join(", ")} (${r.type}): ${r.reason}`));
    }
    if (comms.lostAsks.length > 0) {
      out.push(bullet(`· ${comms.lostAsks.length} ask${comms.lostAsks.length === 1 ? " was" : "s were"} settled without an answer, and the asker was never told`));
      for (const a of comms.lostAsks.slice(0, 5)) {
        out.push(bullet(`  · ${a.from} → ${a.to.join(", ")} (${a.type}) — ${a.reason}`));
      }
      if (comms.lostAsks.length > 5) out.push(bullet(`  · (+${comms.lostAsks.length - 5} more)`));
    }
  }

  if (report.spend.byModel.length > 0) {
    out.push("");
    out.push("  SPEND");
    for (const m of report.spend.byModel) {
      out.push(bullet(`  ${m.model.padEnd(34)} ${humanTokens(m.tokens).padStart(7)}  ${m.turns} turns`));
    }
  }

  out.push("");
  return out.join("\n");
}
