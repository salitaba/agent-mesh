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
 * ## Browser safety (load-bearing — do not add value imports)
 *
 * `apps/mesh-dashboard` deep-imports {@link verdictText} from here. The only
 * *value* import below is `../../protocol/src/catalog`, which is a const table
 * that itself imports nothing but types — the same deliberate arrangement
 * `apps/mesh-dashboard/src/events.tsx` documents for `EVENT_SEVERITY`.
 * Everything else is `import type` and erases at compile time. Adding a value
 * import from `./state`, `./termination` or `../../protocol/src/index` would
 * drag AJV and the whole supervisor graph into the browser bundle.
 */
import { isSettledArtifactStatus } from "../../protocol/src/catalog";
import type { Artifact, ArtifactStatus, Escalation, Goal } from "../../protocol/src/types";
import type { Projections } from "./state";

/** Human-readable phrasing for one termination reason. */
export interface VerdictText {
  /** Headline, safe to show alone in a list or a card title. */
  title: string;
  /** One sentence explaining what happened, in an operator's vocabulary. */
  summary: string;
}

/**
 * Facts a caller already computed that sharpen the phrasing. All optional:
 * `verdictText(reason)` alone always returns usable text, because the CLI and
 * the report often have the reason and nothing else.
 */
export interface VerdictContext {
  /** Unanswered requests behind a stalemate. */
  waiting?: number;
  /** Agents named by a runtime failure. */
  agents?: string[];
  /** Exhausted thread budgets. */
  threads?: number;
}

/**
 * The one source of human-readable verdict text.
 *
 * Termination reasons are code literals (`packages/core/src/termination.ts`)
 * and were rendered into English in exactly one place — a switch inside the
 * dashboard's escalation card — which meant the CLI had no phrasing at all and
 * any new reason silently rendered as a raw snake_case token. Keys here are the
 * `reason` strings those verdicts and escalations actually carry.
 *
 * The dashboard still owns its own `what` / `next` / placeholder copy: that
 * text talks about clicking and answering *below*, which is true of a card and
 * false of a terminal. Only the shared half — what happened — lives here.
 */
const VERDICT_TEXT: Record<string, VerdictText> = {
  all_mandatory_criteria_evidenced: {
    title: "Goal met",
    summary: "Every mandatory acceptance criterion was evidenced, with no open escalations and no work still claimed.",
  },
  runtime_failure: {
    title: "An agent crashed",
    summary: "An agent hit a runtime failure while work was still outstanding, so the mission stopped rather than continuing around it.",
  },
  backend_unreachable: {
    title: "A model backend went down",
    summary: "An agent failed several turns in a row because its model backend stopped answering.",
  },
  budget_exhausted: {
    title: "Mission ran out of tokens",
    summary: "The mission token budget was spent before the goal was met.",
  },
  agent_budget_exhausted: {
    title: "An agent ran out of tokens",
    summary: "One agent spent its individual token budget and can take no further turns.",
  },
  thread_budget_exhausted: {
    title: "A conversation ran out of tokens",
    summary: "A thread spent its token budget, so no further turns can happen in it.",
  },
  thread_budgets_exhausted: {
    title: "Every open conversation is out of tokens",
    summary: "All open threads spent their token budgets and no agent is still running, so work stopped silently.",
  },
  budget_exhausted_tokens: {
    title: "Out of tokens",
    summary: "A token budget was spent before the goal was met.",
  },
  max_events_exceeded: {
    title: "Mission hit its event cap",
    summary: "The run produced more events than the configured mission cap allows.",
  },
  wall_clock_exceeded: {
    title: "Mission ran out of time",
    summary: "The run exceeded its configured wall-clock limit.",
  },
  stalemate: {
    title: "Stalemate",
    summary: "The mesh deadlocked: agents are waiting on answers that only a human can give.",
  },
  "stalemate:unanswered_request": {
    title: "An agent is waiting for an answer",
    summary: "A request went unanswered long enough to stall the agent that sent it.",
  },
  // Synthesized by `deriveVerdict` when a run stopped without the termination
  // manager recording a reason — a hard kill, a crash, or a log that ends
  // mid-mission. Phrased rather than left to the snake_case fallback because
  // these are the states an interrupted run actually lands in.
  no_goal: {
    title: "No mission",
    summary: "No goal was ever activated in this log, so there is nothing to report on.",
  },
  goal_failed: {
    title: "Mission failed",
    summary: "The goal was marked failed without a recorded termination reason — check the escalations and the last events.",
  },
  goal_escalated: {
    title: "Mission escalated",
    summary: "The goal is parked awaiting a human decision; see the open escalations below.",
  },
};

/**
 * Human-readable text for a termination or escalation `reason`.
 *
 * Unknown reasons degrade to the de-snaked literal rather than throwing or
 * rendering an empty card: a reason nobody has phrased yet is still better
 * shown than swallowed.
 */
export function verdictText(reason: string, ctx: VerdictContext = {}): VerdictText {
  const base = VERDICT_TEXT[reason];
  if (!base) {
    const plain = reason.replace(/[:_]+/g, " ").trim();
    return {
      title: plain ? plain.charAt(0).toUpperCase() + plain.slice(1) : "Mission stopped",
      summary: `The mission stopped for a reason this build has no phrasing for (\`${reason}\`). Check the escalations and the event log.`,
    };
  }
  if (reason === "runtime_failure" && ctx.agents?.length) {
    return { ...base, title: `Agent crashed: ${ctx.agents.join(", ")}` };
  }
  if (reason === "stalemate" && typeof ctx.waiting === "number") {
    return { ...base, title: ctx.waiting > 0 ? `Stalemate (${ctx.waiting} waiting)` : "Stalemate (clearing)" };
  }
  if (reason === "thread_budgets_exhausted" && typeof ctx.threads === "number" && ctx.threads > 0) {
    return { ...base, summary: `${ctx.threads} conversation thread${ctx.threads === 1 ? "" : "s"} spent their token budgets and no agent is still running, so work stopped silently.` };
  }
  return base;
}

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
 * Compose the report for the active goal (or `goalId`, to report on an older
 * mission in the same log).
 *
 * Pure and synchronous: everything it needs is already in projections, so it
 * can be called from a shutdown path, an HTTP handler, or a test without a
 * supervisor, a content store, or an await.
 */
export function buildRunReport(state: Projections, goalId?: string): RunReport {
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
      pendingRequests: pending.map((p) => ({ id: p.messageId, from: p.from, to: p.to, type: p.type })),
    },
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
