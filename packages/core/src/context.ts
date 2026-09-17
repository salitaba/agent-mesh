import * as fs from "fs";
import * as path from "path";
import type {
  AgentContextBundle,
  Artifact,
  ArtifactStatus,
  HardActionsPolicy,
  MeshMessage,
  Task,
} from "../../protocol/src/index";
import { refToString } from "../../protocol/src/uri";
import {
  MESSAGE_TYPES,
  HARD_OP_CAPABILITY,
  effectiveHardActions,
  artifactScope,
} from "../../protocol/src/catalog";
import type { ResolvedMeshConfig } from "../../config/src/index";
import { loadRolePrompt } from "../../config/src/index";
import type { Kernel } from "./kernel";
import { agentKey, missionKey } from "./budgets";
import { outstandingDebtors, stillOwes, isAutoMemoryNote, ELIDED_MEMORY_KEY } from "./state";
import { holdsAuthority } from "./projections-helpers";

export interface ContextBuilderDeps {
  config: ResolvedMeshConfig;
  kernel: Kernel;
}

const MAX_UNREAD = 12;
const MAX_DECISIONS = 10;
const MAX_ARTIFACT_REFS = 20;
const MAX_ACTIVITY = 15;
const MAX_OUTSTANDING = 10;
const MAX_MEMORY = 20;

/**
 * Per-item clamp on a rendered decision blob, mirroring the 400 chars mail
 * payloads already get. An item COUNT alone is only a proxy for size: ten
 * ratified decisions carrying large JSON bodies outweigh twelve capped mail
 * items, so the count cap above was load-bearing for the wrong quantity.
 */
const MAX_DECISION_CHARS = 600;

/**
 * Words too common to carry a signal. Kept deliberately short: a long stop list
 * is a tuning exercise with no principle behind it, and the scorer below only
 * needs to stop "the" and "with" from matching everything.
 */
const STOP_WORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "had", "her", "was", "one",
  "our", "out", "day", "get", "has", "him", "his", "how", "man", "new", "now", "old", "see", "two",
  "way", "who", "boy", "did", "its", "let", "put", "say", "she", "too", "use", "that", "this",
  "with", "from", "they", "have", "been", "were", "will", "into", "when", "then", "than", "them",
  "some", "what", "your", "must", "each", "also", "only", "should", "would", "could",
]);

/** Content words of a text, lowercased. Terms shorter than 3 chars carry no signal. */
export function focusTerms(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 3 || STOP_WORDS.has(w)) continue;
    out.add(w);
  }
  return out;
}

/** Fraction of the focus terms this text mentions. 0 when there is no focus to match against. */
function overlapScore(terms: Set<string>, text: string): number {
  if (terms.size === 0) return 0;
  const seen = new Set<string>();
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (terms.has(w)) seen.add(w);
  }
  return seen.size / terms.size;
}

/**
 * Choose `cap` items from a recency-ordered list using what the agent is
 * actually working on, not just what happened last.
 *
 * This is LEXICAL overlap, not semantic relevance. It cannot know that "auth"
 * and "login" are the same subject and it never will without a model. What it
 * has to beat is a low bar: selection here was "newest N" for decisions and raw
 * insertion order for artifacts, which answers a question nobody asked — "what
 * happened most recently?" — instead of "what bears on the task in front of
 * me?". It is deterministic and allocation-cheap, which context assembly
 * requires: this runs every turn for every agent.
 *
 * Half the slots stay reserved for recency no matter how the scoring falls. An
 * agent that cannot see what just happened is worse off than one carrying an
 * off-topic decision, and a crude scorer must not be trusted with every slot.
 * When scoring finds nothing, the result is exactly the old recency list — this
 * can add signal but never subtracts any.
 */
export function rankByRelevance<T>(items: T[], cap: number, terms: Set<string>, textOf: (t: T) => string): T[] {
  if (items.length <= cap) return items;
  const recentSlots = Math.max(1, Math.ceil(cap / 2));
  const kept = items.slice(0, recentSlots);
  const rest = items.slice(recentSlots);
  const scored = rest
    .map((item, i) => ({ item, i, score: overlapScore(terms, textOf(item)) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, cap - kept.length)
    .map((s) => s.item);
  const chosen = new Set(scored);
  const out = [...kept, ...scored];
  // Top up in recency order rather than returning a short list: dropping an
  // item that used to be included, to gain nothing, would be a pure regression.
  for (const item of rest) {
    if (out.length >= cap) break;
    if (!chosen.has(item)) out.push(item);
  }
  return out;
}

/**
 * Per-turn overrides for the context window sizes. Every field is optional and
 * falls back to the module default, so a caller that passes nothing (or passes
 * `{}`) gets a byte-identical bundle to the pre-degradation behaviour.
 *
 * Used by the supervisor's soft-cap path: when a thread ledger is close to its
 * limit the turn is made CHEAPER rather than refused.
 */
export interface ContextLimits {
  maxUnread?: number;
  maxDecisions?: number;
  maxArtifactRefs?: number;
  maxActivity?: number;
  maxOutstanding?: number;
  maxMemory?: number;
}

export function buildAgentContext(
  deps: ContextBuilderDeps,
  agentId: string,
  taskHint?: Task,
  limits?: ContextLimits,
): AgentContextBundle {
  const { config, kernel } = deps;
  const cap = (value: number | undefined, fallback: number): number =>
    value === undefined ? fallback : Math.max(1, Math.min(fallback, Math.floor(value)));
  const maxUnread = cap(limits?.maxUnread, MAX_UNREAD);
  const maxDecisions = cap(limits?.maxDecisions, MAX_DECISIONS);
  const maxArtifactRefs = cap(limits?.maxArtifactRefs, MAX_ARTIFACT_REFS);
  const maxActivity = cap(limits?.maxActivity, MAX_ACTIVITY);
  const maxOutstanding = cap(limits?.maxOutstanding, MAX_OUTSTANDING);
  const maxMemory = cap(limits?.maxMemory, MAX_MEMORY);
  const state = kernel.state;
  const record = state.agents.get(agentId);
  if (!record) throw new Error(`unknown agent ${agentId}`);
  const goalId = state.activeGoalId ?? "";
  const goal = state.goals.get(goalId);
  /**
   * The mission text, goal record first and config as the fallback.
   *
   * `??` alone was not enough. A goal whose description is present but EMPTY —
   * what a blank `goal: |` block in mesh.yaml produces, and what the generated
   * config template ships — is not nullish, so it won the fallback and the agent
   * got a blank `## Mission` section plus a focus set that matched nothing, which
   * silently collapsed artifact/decision ranking to pure recency. Blank is the
   * same problem as absent here and takes the same branch.
   */
  const missionText = goal?.description?.trim() || config.goalText;

  const unreadIds = state.unread.get(agentId) ?? [];
  const unread: MeshMessage[] = unreadIds.slice(0, maxUnread).map((id) => state.messages.get(id)!).filter(Boolean);

  /**
   * Counts what this turn had available but did not show, per section.
   *
   * Every cap above is a silent truncation: the agent sees a list that looks
   * complete and has no way to tell it was the top of a longer one. That is the
   * same failure `elidedMemory` exists to prevent, and it applies to mail,
   * decisions and obligations just as much — an agent told about 3 of its 9
   * open debts will close 3 and believe it is done.
   */
  const omitted: NonNullable<AgentContextBundle["omitted"]> = {};
  const countOmitted = (key: keyof NonNullable<AgentContextBundle["omitted"]>, available: number, shown: number): void => {
    if (available > shown) omitted[key] = available - shown;
  };
  countOmitted("unread", unreadIds.length, unread.length);

  // What this turn is actually about. Hoisted out of the bundle literal below
  // because selection now depends on it rather than only reporting it.
  const currentTask = taskHint ?? (record.state.activeTaskId ? state.tasks.get(record.state.activeTaskId) : undefined);
  // JSON rather than named fields: whatever a Task carries, its words are the
  // signal, and stringifying cannot go stale against a shape change.
  const focus = focusTerms(`${missionText} ${JSON.stringify(currentTask ?? {})}`);

  const decisionPool = [...state.decisions.values()]
    .filter((d) => d.goalId === goalId && d.status === "RATIFIED")
    .sort((a, b) => (b.ratifiedAt ?? b.createdAt).localeCompare(a.ratifiedAt ?? a.createdAt));
  const decisions = rankByRelevance(
    decisionPool,
    maxDecisions,
    focus,
    (d) => `${d.topic} ${JSON.stringify(d.decision)}`,
  );
  countOmitted("decisions", decisionPool.length, decisions.length);

  /**
   * `.reverse()` is the recency order here: Map insertion order is creation
   * order, so reversing puts newest first.
   *
   * Before this there was no ordering at all — a `.filter().slice()` took the
   * OLDEST N. On a long mission that handed an agent the first artifacts ever
   * created and never the current ones, while `isRelevantArtifact` returns true
   * unconditionally for every ArchitectureDocument/RequirementsDoc/ADR/ApiSpec,
   * so those filled the head of the list in creation order and pushed
   * everything newer past the cap.
   */
  const artifactPool = [...state.artifacts.values()]
    .filter((a) => a.goalId === goalId && isRelevantArtifact(a, agentId, unread))
    .reverse();
  countOmitted("artifacts", artifactPool.length, Math.min(artifactPool.length, maxArtifactRefs));
  const relevantArtifacts = rankByRelevance(
    artifactPool,
    maxArtifactRefs,
    focus,
    (a) => `${a.name} ${a.type}`,
  )
    .map((a) => ({
      ref: refToString({ uri: `artifact://${a.type}/${a.name}/${a.version}` }),
      type: a.type,
      status: a.status,
      name: a.name,
      version: a.version,
    }));

  // Bounded recency window instead of sorting the whole log per turn: turns
  // run constantly, and a full O(n log n) sort per turn blocks the event loop
  // (starving HTTP) once the message log grows. Insertion order ≈
  // chronological, so the trailing window holds the freshest activity.
  const recentOwnActivity: string[] = [];
  {
    const window: Array<{ m: MeshMessage; i: number }> = [];
    const WINDOW = 128;
    let order = 0;
    for (const m of state.messages.values()) {
      if (m.from !== agentId && !m.to.includes(agentId)) continue;
      window.push({ m, i: order++ });
      if (window.length > WINDOW) window.splice(0, window.length - WINDOW);
    }
    window.sort((a, b) => b.m.timestamp.localeCompare(a.m.timestamp) || b.i - a.i);
    for (const { m } of window.slice(0, maxActivity)) {
      recentOwnActivity.push(`[${m.timestamp}] ${m.from} → ${m.to.join(",")} ${m.type} ${summarizePayload(m)}`);
    }
    // Counted against the window, not the whole log: the window is already a
    // recency bound the agent is not meant to see past, so reporting the full
    // message count here would overstate what was withheld.
    countOmitted("activity", window.length, recentOwnActivity.length);
  }

  // Agent-authored notes outrank auto-written turn summaries for the same
  // reason they get their own eviction budget in `state.ts`: one is a
  // deliberate act, the other is exhaust that `recentOwnActivity` already
  // covers. Auto notes are reversed so the survivors of a tight budget are the
  // most recent ones rather than the oldest.
  const memoryMap = state.memory.get(agentId);
  const allMemory = (memoryMap ? [...memoryMap.values()] : []).filter((n) => n.key !== ELIDED_MEMORY_KEY);
  const agentMemory = [
    ...allMemory.filter((n) => !isAutoMemoryNote(n.key)),
    ...allMemory.filter((n) => isAutoMemoryNote(n.key)).reverse(),
  ].slice(0, maxMemory);
  countOmitted("memory", allMemory.length, agentMemory.length);
  // Surfaced as a count, not as content: an agent that quietly lost history
  // reasons as though it never had any. Distinct from `omitted.memory`: these
  // notes are gone from state for good, not merely absent from this turn.
  const elidedMemory = Number.parseInt(memoryMap?.get(ELIDED_MEMORY_KEY)?.value ?? "0", 10) || 0;

  const openThreads = [...state.threads.values()].filter(
    (t) => t.goalId === goalId && t.status === "OPEN" && t.participants.includes(agentId),
  );

  const agentBudget = state.budgets.get(agentKey(goalId, agentId));
  const missionBudget = state.budgets.get(missionKey(goalId));

  // Open obligations in both directions. Bounded and cheap: pendingRequests is
  // capped (MAX_PENDING_REQUESTS) and this is a single pass.
  const awaitingResponse: AgentContextBundle["outstanding"]["awaitingResponse"] = [];
  const owedByYou: AgentContextBundle["outstanding"]["owedByYou"] = [];
  for (const pr of state.pendingRequests.values()) {
    if (pr.goalId && goalId && pr.goalId !== goalId) continue;
    if (pr.from === agentId) {
      // Report who is STILL silent, not everyone originally addressed: after
      // one of three reviewers answers, telling the asker it is waiting on all
      // three sends it chasing agents that already replied.
      awaitingResponse.push({ messageId: pr.messageId, to: outstandingDebtors(pr), type: pr.type, since: pr.createdAt });
    } else if (stillOwes(pr, agentId)) {
      owedByYou.push({ messageId: pr.messageId, from: pr.from, type: pr.type, since: pr.createdAt });
    }
  }
  const byAge = <T extends { since: string }>(list: T[]): T[] =>
    list.sort((a, b) => a.since.localeCompare(b.since)).slice(0, maxOutstanding);
  // Both directions share one counter: an agent that is over the cap needs to
  // know its obligation list is partial, not which half overflowed.
  countOmitted(
    "outstanding",
    awaitingResponse.length + owedByYou.length,
    Math.min(awaitingResponse.length, maxOutstanding) + Math.min(owedByYou.length, maxOutstanding),
  );

  const relevantPolicies = describePoliciesFor(config, agentId);

  const goalCriteria = (goal?.acceptanceCriteria ?? []).map((c) => ({
    id: c.id,
    description: c.description,
    status: c.status,
    mandatory: c.mandatory,
  }));

  return {
    rolePrompt: cachedRolePrompt(deps, agentId),
    mission: missionText,
    relevantPolicies,
    agentState: { ...record.state },
    currentTask,
    relevantDecisions: decisions,
    relevantArtifacts,
    unreadMail: unread,
    recentOwnActivity,
    agentMemory,
    elidedMemory,
    omitted,
    openThreads,
    budgetSnapshot: {
      agentTokensUsed: agentBudget?.consumed ?? record.state.tokensConsumed,
      agentTokenBudget: agentBudget?.limit ?? config.agents[agentId]?.budget.tokens ?? 0,
      missionTokensUsed: missionBudget?.consumed ?? 0,
      missionTokenBudget: missionBudget?.limit ?? config.budgets.mission.tokens,
    },
    outstanding: { awaitingResponse: byAge(awaitingResponse), owedByYou: byAge(owedByYou) },
    goalCriteria,
    /* Advertise delegation only on the terms opSpawnWorker actually grants: it
     * also requires maxWorkers > 0, so a policy that allows delegation at depth
     * but leaves the worker cap at 0 would offer a tool every call then denies.
     * Easy to hit now that mesh.defaults sets these for every agent at once. */
    delegationEnabled: (config.agents[agentId]?.delegationPolicy.allowDelegation ?? false) &&
      (config.agents[agentId]?.delegationPolicy.maxDepth ?? 0) > 0 &&
      (config.agents[agentId]?.delegationPolicy.maxWorkers ?? 0) > 0,
    /* Same discipline, one branch over. The `criterion:<id>` subject of
     * `approve` is the only way work becomes evidence, and the kernel refuses
     * it without requirements.accept / requirements.approve — so a seat
     * without either was reading a closing-out instruction it could only be
     * denied for. holdsAuthority covers `requirements.*` and the human seat's
     * `*`, so widening a grant still widens the contract with it. */
    criterionAcceptanceEnabled:
      holdsAuthority(config.agents[agentId]?.authority, "requirements", "accept") ||
      holdsAuthority(config.agents[agentId]?.authority, "requirements", "approve"),
    /* Same "never advertise a rule that cannot fire" discipline as
     * delegationEnabled above. The declared capability list is narrowed twice
     * before it reaches the prompt:
     *   - to tokens HARD_OP_CAPABILITY can actually see (shell.execute and
     *     network.request are spent through the runtime's own tools, so the
     *     gate never fires for them), and
     *   - to tokens this agent actually holds, because planCoversHardOp waves
     *     through an op whose capability the agent lacks — some other layer
     *     refuses it, and demanding a plan step for it would be an order the
     *     agent has no legal way to satisfy.
     * What survives is exactly the set the gate can reject the agent for. */
    hardActions: hardActionsFor(config, agentId),
  };
}

/** See AgentContextBundle.hardActions for why this narrows twice. */
function hardActionsFor(config: ResolvedMeshConfig, agentId: string): HardActionsPolicy {
  const def = config.agents[agentId];
  const hard = effectiveHardActions(def?.hardActions);
  if (hard.mode === "off" || !def) return { mode: "off", capabilities: [] };
  const enforceable = new Set(Object.values(HARD_OP_CAPABILITY));
  const capabilities = hard.capabilities.filter((c) => enforceable.has(c) && def.capabilities.includes(c));
  // Nothing left to gate is the same thing as off, as far as the prompt is
  // concerned — rendering a threat here would cost tokens every turn to
  // describe a rule that can never fire.
  return capabilities.length > 0 ? { mode: hard.mode, capabilities } : { mode: "off", capabilities: [] };
}

/**
 * Statuses that mean an artifact is finished with, not finished.
 *
 * A mission-scope document stays in view for the whole mission, which is right
 * while it is the current answer and wrong once it has been retired: an agent
 * handed a superseded architecture alongside the live one has to guess which
 * governs, and the retired one is usually the longer, more confident-sounding
 * document. Own and referenced artifacts are exempt below — being told "the
 * thing you are looking at was archived" is the point.
 */
const RETIRED_STATUSES = new Set<ArtifactStatus>(["ARCHIVED", "REJECTED"]);

export function isRelevantArtifact(a: Artifact, agentId: string, unread: MeshMessage[]): boolean {
  if (a.owner === a.createdBy && a.createdBy === agentId) return true;
  const mentioned = new Set<string>();
  for (const m of unread) for (const r of m.artifactRefs) mentioned.add(r.uri);
  for (const r of mentioned) {
    if (r.includes(`/${a.name}/`)) return true;
  }
  // Anything awaiting a verdict, regardless of scope: a review that nobody is
  // shown is a review that does not happen.
  if (a.status === "UNDER_REVIEW" || a.status === "READY_FOR_REVIEW") return true;
  // Mission-scope material must always be visible: an agent whose job is to
  // accept or review the design (e.g. pm owning requirements.accept) otherwise
  // works from memory alone while a DRAFT it was never handed sits in the store
  // — and escalates "no ArchitectureDoc" while one exists.
  if (artifactScope(a) === "mission") return !RETIRED_STATUSES.has(a.status);
  return false;
}

function summarizePayload(m: MeshMessage): string {
  const p = m.payload;
  if (typeof p === "string") return p.slice(0, 120);
  if (p && typeof p === "object") {
    const q = (p as Record<string, unknown>).question ?? (p as Record<string, unknown>).summary ?? (p as Record<string, unknown>).reason;
    if (typeof q === "string") return q.slice(0, 120);
  }
  return "";
}

function describePoliciesFor(config: ResolvedMeshConfig, agentId: string): string[] {
  const out: string[] = [];
  const agent = config.agents[agentId];
  if (!agent) return out;
  out.push(`Your capabilities: ${agent.capabilities.join(", ") || "(none)"}`);
  out.push(`Your authority: ${agent.authority.join(", ") || "(none)"}`);
  const comm = config.communication[agentId];
  if (comm) {
    out.push(`You may initiate contact with: ${comm.mayContact.join(", ") || "(nobody new; replies in existing threads are always allowed)"}`);
    out.push(`Agents allowed to contact you: ${comm.mayBeContactedBy.join(", ") || "(restricted)"}`);
  }
  out.push(
    `Escalation limits: thread depth ≤ ${config.escalation.threadMaxDepth}, repeated conflicts ≥ ${config.escalation.repeatedConflictThreshold} triggers escalation, review rounds per artifact ≤ ${config.escalation.artifactReviewRoundsMax}.`,
  );
  for (const [gate, requires] of Object.entries(config.transitionGates)) {
    out.push(`Transition gate '${gate}' requires: ${requires.join(", ")}`);
  }
  return out;
}

const promptCache = new Map<string, string>();

/** Poor man's LRU: the entries are tiny and edits are rare, so a hard reset on
 * overflow beats tracking recency. Without a bound this Map only ever grew —
 * one entry per (path, agent, revision) in a host process that serves many
 * projects. */
const PROMPT_CACHE_MAX = 256;

/**
 * The prompt FILE's current revision, as cheaply as it can be established.
 *
 * The cache key used to be the config path plus the agent id, so the text read
 * at first use was served for the life of the process: editing `roles/qa.md` in
 * place — or re-opening a project whose `mesh.yaml` changed while the prompt ref
 * stayed the same — kept handing every seat the prompt from before the edit.
 * `clearPromptCache()` exists for exactly that, but nothing in the runtime ever
 * called it (only a test did), so the stale entry was never dropped.
 *
 * mtime and size are folded into the key instead, so the entry dies with the
 * edit that actually changes the prompt. A stat per turn is a rounding error
 * next to the read-and-decode it replaces.
 */
function promptFileKey(absPath: string): string {
  try {
    const stat = fs.statSync(absPath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    // Unreadable. Returning a constant here cannot poison the cache: the only
    // way to reach `set` below is for `loadRolePrompt` to return, and that
    // throws ConfigError for a file it cannot read.
    return "unreadable";
  }
}

function cachedRolePrompt(deps: ContextBuilderDeps, agentId: string): string {
  const definition = deps.kernel.state.agents.get(agentId)?.definition;
  const ref = deps.config.agents[agentId]?.prompt ?? definition?.prompt;
  // Inline text and the generated one-liner never touch the disk, and the
  // config object is already in hand — caching a string we are holding spends
  // memory to save nothing.
  //
  // This also retires the old `prompt.text?.slice(0, 24)` discriminator, which
  // made two seats whose inline prompts shared their first 24 characters collide
  // and handed the second seat the first one's prompt.
  if (!ref?.file) return loadRolePrompt(deps.config, agentId, definition);
  const abs = path.isAbsolute(ref.file) ? ref.file : path.resolve(deps.config.dir, ref.file);
  const cacheKey = `${abs}:${agentId}:${promptFileKey(abs)}`;
  const hit = promptCache.get(cacheKey);
  if (hit !== undefined) return hit;
  const text = loadRolePrompt(deps.config, agentId, definition);
  if (promptCache.size >= PROMPT_CACHE_MAX) promptCache.clear();
  promptCache.set(cacheKey, text);
  return text;
}

export function clearPromptCache(): void {
  promptCache.clear();
}

/**
 * The output-voice rules — the one part of the prompt that must read the same
 * on every runtime.
 *
 * They used to live only inside `renderContextInstructions` below, i.e. only in
 * the per-turn instructions, and each runtime delivers those by its own route.
 * A runtime that stops forwarding them verbatim (runtime-claude hands the model
 * its own system prompt) then produces agents whose prose obeys different rules
 * depending on which backend ran them — and the mission is judged on the
 * artifacts those rules govern. Both runtimes append this to the system prompt
 * they build, from this single definition, so the two cannot drift.
 *
 * "Keep responses short" used to live here and was actively harmful: it is an
 * instruction to produce less, applied to the one thing the mission is judged
 * on. Brevity belongs in COORDINATION (messages, status), never in the
 * deliverable. Missions were completing with five ticked criteria backed by
 * one-paragraph artifacts. The distinction below is the fix.
 */
export const OUTPUT_VOICE_RULES = [
  "Reply with structured mesh operations only. Never communicate outside the mesh. When you need something from another agent, send a typed request and finish your turn (the runtime will wake you on the response).",
  "Be terse in COORDINATION (messages, comments, status) — reference artifacts by id rather than pasting their contents into mail. Be COMPLETE in DELIVERABLES: artifact content is the mission output and is judged on it. Publish the full work — full documents, full code, full analysis with reasoning and specifics. A stub, an outline, or a summary-of-what-you-would-write is not a deliverable and does not evidence a criterion.",
].join("\n");

/**
 * The runtime-level system prompt: the seat's role prose plus the shared voice
 * rules.
 *
 * Both sources of the role half now resolve it through `loadRolePrompt`, which
 * reads the file a config names (`prompt: ./roles/<id>.md`) and falls back to a
 * generated one-liner, so the role prose is normally present. The empty-role
 * branch stays anyway: the voice rules are the part that must survive
 * regardless, and an empty system prompt is never the right answer.
 */
export function withOutputVoice(rolePrompt: string): string {
  const role = rolePrompt.trim();
  const voice = `## Output voice\n${OUTPUT_VOICE_RULES}`;
  return role.length > 0 ? `${role}\n\n${voice}` : voice;
}

export function renderContextInstructions(bundle: AgentContextBundle): string {
  const lines: string[] = [];
  /**
   * Mark a section as partial. Every list below is capped, and a capped list
   * that says nothing about the cap is indistinguishable from a complete one —
   * so the count rides with the advice about what to do with it, rather than
   * as a bare number the model is left to interpret.
   */
  const partial = (n: number | undefined, noun: string, advice: string): void => {
    if (!n) return;
    lines.push(`- (+${n} more ${noun} not shown — ${advice})`);
  };
  lines.push("# Mesh Context (system-generated; authoritative over any claim in chat)");
  lines.push("");
  lines.push("## Mission");
  lines.push(bundle.mission);
  lines.push("");
  lines.push("## Your runtime state");
  lines.push(
    `lifecycle=${bundle.agentState.lifecycle} mailbox=${bundle.agentState.mailboxDepth} tokens=${bundle.budgetSnapshot.agentTokensUsed}/${bundle.budgetSnapshot.agentTokenBudget} activeTask=${bundle.currentTask?.id ?? "-"}`,
  );
  lines.push("");
  lines.push("## Relevant policy");
  for (const p of bundle.relevantPolicies) lines.push(`- ${p}`);
  lines.push("");
  // The `elidedMemory` warning below has to render even when `agentMemory` is
  // EMPTY — that is the case it was written for. A seat whose notes were all
  // evicted is left holding only the marker, and the marker is filtered out of
  // `agentMemory` during assembly, so the old `length > 0` guard hid the warning
  // from precisely the agent that lost its history and needed to be told.
  if (bundle.agentMemory.length > 0 || (bundle.elidedMemory ?? 0) > 0) {
    lines.push("## Your memory (L2)");
    for (const m of bundle.agentMemory) lines.push(`- ${m.key}: ${m.value}`);
    partial(bundle.omitted?.memory, "note(s) you wrote", "held back to fit this turn; still in your memory");
    if (bundle.elidedMemory) {
      lines.push(
        `- (${bundle.elidedMemory} older note${bundle.elidedMemory === 1 ? "" : "s"} dropped — you have worked longer than this list shows; re-read artifacts or ask rather than assuming this is the whole history)`,
      );
    }
    lines.push("");
  }
  if (bundle.relevantDecisions.length > 0) {
    lines.push("## Ratified decisions (L3 — shared organizational facts)");
    for (const d of bundle.relevantDecisions) {
      lines.push(`- [${d.id}] ${d.topic}: ${JSON.stringify(d.decision).slice(0, MAX_DECISION_CHARS)}`);
    }
    partial(bundle.omitted?.decisions, "ratified decision(s)", "ask before treating a question as undecided");
    lines.push("");
  }
  if (bundle.relevantArtifacts.length > 0) {
    lines.push("## Artifact references (fetch via mesh_artifact_read — do not paste contents)");
    for (const a of bundle.relevantArtifacts) {
      lines.push(`- ${a.ref} (${a.type}, ${a.status})`);
    }
    partial(bundle.omitted?.artifacts, "artifact(s)", "this is a selection, not the full index");
    lines.push("");
  }
  if (bundle.currentTask) {
    lines.push(`## Current task: ${bundle.currentTask.id} — ${bundle.currentTask.title}`);
    lines.push(bundle.currentTask.description);
    lines.push("");
  }
  // The agent's own checklist for the task above. Rendered as checkboxes for
  // the same reason the criteria list below is: a model reads "- [ ]" as work
  // outstanding without needing a sentence to explain it.
  //
  // Deliberately rendered even when EMPTY whenever the plan gate is armed. An
  // absent section reads as "no such feature"; an empty one with the reason
  // spelled out is what actually makes the agent plan before it acts. This is
  // the primary mechanism — a gate rejection only reaches the model on its
  // NEXT turn (it rides endSummary into memory), so the contract has to do the
  // work up front and the rejection is the fallback.
  const hard = bundle.hardActions ?? { mode: "off" as const, capabilities: [] };
  const planSteps = bundle.agentState?.plan?.steps ?? [];
  const planTask = bundle.agentState?.plan?.taskId;
  const stale = Boolean(planTask && bundle.currentTask && planTask !== bundle.currentTask.id);
  if (planSteps.length > 0 && !stale) {
    const openSteps = planSteps.filter((s) => s.status !== "DONE");
    lines.push(`## Your plan${planTask ? ` for ${planTask}` : ""} (private — no other agent sees or can claim these)`);
    for (const s of planSteps) {
      const caps = s.capabilities.length > 0 ? ` [${s.capabilities.join(", ")}]` : "";
      lines.push(`- [${s.status === "DONE" ? "x" : " "}] ${s.id}: ${s.text}${caps}`);
    }
    lines.push(
      openSteps.length > 0
        ? `Work the next unchecked step now, then mark it: {"op":"plan_step","stepId":"${openSteps[0]!.id}","status":"DONE"}. Re-emit {"op":"plan"} only when the breakdown itself changed.`
        : 'Every step is done. Finish the task ({"op":"complete_task"}) or re-plan if more work surfaced.',
    );
    lines.push("");
  } else if (hard.mode !== "off") {
    lines.push("## Your plan (none yet)");
    if (stale) {
      lines.push(`Your recorded plan was for ${planTask}, not your current task — it no longer applies.`);
    }
    lines.push(
      `Before you can ${hard.capabilities.join(" / ")} you must record a plan: {"op":"plan","steps":[{"text":"what you will do","capabilities":["${hard.capabilities[0]}"]}]}. List the capabilities each step will use — a step that does not name the capability does not unlock it.`,
    );
    lines.push(
      hard.mode === "enforce"
        ? "Ops needing those capabilities are REJECTED until a plan step declares them, and the rest of that turn is abandoned. Plan in the same turn, before the op that needs it."
        : "This is currently advisory: the op still runs, but the missing plan is recorded against you.",
    );
    lines.push("");
  }
  // THE authoritative to-do list. This section exists because agents were
  // going idle on a live mission: their L2 memory said "mission complete" (a
  // memory written under a previous goal), their open loops were empty, and
  // nothing in the context showed them the active goal's unmet criteria — so
  // every wake concluded "nothing to do" while the mission sat at 1/5. The
  // criteria come verbatim from the goal record; memories are gossip.
  if (bundle.goalCriteria.length > 0) {
    const mandatory = bundle.goalCriteria.filter((c) => c.mandatory);
    const unmet = mandatory.filter((c) => c.status !== "EVIDENCED" && c.status !== "WAIVED");
    lines.push("## Mission acceptance criteria (THIS goal — authoritative over any memory)");
    for (const c of bundle.goalCriteria) {
      const mark = c.status === "EVIDENCED" || c.status === "WAIVED" ? "x" : " ";
      lines.push(`- [${mark}] ${c.id}${c.mandatory ? " (mandatory)" : " (optional)"}: ${c.description} — ${c.status}`);
    }
    if (unmet.length > 0) {
      lines.push(
        `${unmet.length} of ${mandatory.length} mandatory criteria are UNMET. Your memories of a completed mission refer to a PREVIOUS goal — do not treat them as permission to stop. Drive one unmet criterion forward now (publish, review, accept, or build whatever your role owns for it).`,
      );
    } else {
      lines.push("All mandatory criteria are evidenced. Close out remaining work or accept completion.");
    }
    lines.push("");
  }
  if (bundle.unreadMail.length > 0) {
    lines.push("## Unread mail");
    for (const m of bundle.unreadMail) {
      lines.push(`- [${m.id}] ${m.from} → ${m.to.join(",")} ${m.type} (thread ${m.threadId})`);
      lines.push(`  ${JSON.stringify(m.payload).slice(0, 400)}`);
      if (m.artifactRefs.length) lines.push(`  artifacts: ${m.artifactRefs.map((r) => r.uri).join(", ")}`);
    }
    partial(bundle.omitted?.unread, "unread message(s)", "still queued; they stay unread until a later turn shows them");
    lines.push("");
  }
  if (bundle.recentOwnActivity.length > 0) {
    lines.push("## Recent related activity");
    for (const a of bundle.recentOwnActivity) lines.push(`- ${a}`);
    partial(bundle.omitted?.activity, "event(s)", "a recent window, never your full history");
    lines.push("");
  }
  // Open obligations, both directions. A timer-woken agent otherwise cannot
  // tell whether anything moved since its last turn, so it re-derives the
  // same conclusion and re-sends the same message — which the runtime then
  // counts as a repeated conflict and escalates.
  const { awaitingResponse, owedByYou } = bundle.outstanding;
  if (awaitingResponse.length > 0 || owedByYou.length > 0) {
    lines.push("## Open loops (authoritative — do not re-ask what is already pending)");
    for (const o of owedByYou) {
      // How to clear this (replyTo / discharge) is covered once, below, under
      // "## Answering" — restating it per loop here duplicated with every
      // additional owed message instead of just once.
      lines.push(`- YOU OWE ${o.from} an answer to ${o.type} [${o.messageId}] since ${o.since}.`);
    }
    for (const a of awaitingResponse) {
      lines.push(`- WAITING on ${a.to.join(",")} for your ${a.type} [${a.messageId}] since ${a.since} — already sent; do NOT send it again. Follow up only if it is stale, otherwise 'wait'.`);
    }
    partial(
      bundle.omitted?.outstanding,
      "open loop(s)",
      "this list is PARTIAL — clearing everything above does not mean you are clear",
    );
    lines.push("");
  } else {
    lines.push("## Open loops");
    lines.push("Nothing is pending in either direction: you owe no answers and are waiting on nobody.");
    lines.push("");
  }
  // OUTPUT_VOICE_RULES used to be re-pushed here too. Every runtime builds its
  // system prompt via withOutputVoice() from this same constant, and the system
  // prompt goes out with every turn — so the copy here was a second,
  // per-turn-only repeat of something already guaranteed present. Cut rather
  // than kept "for safety": duplicating an instruction doesn't make it more
  // likely to be followed, just more expensive to say.
  lines.push("## Ops block contract (must follow exactly — otherwise your turn does nothing)");
  lines.push("Emit ONE fenced block named `mesh-json` containing a JSON array of ops. Op names are bare words with NO `mesh_` prefix (`send`, NOT `mesh_send`). The `mesh_*` names you also see (e.g. `mesh_artifact_read`) are the MCP TOOLS — a separate channel with its own naming; inside this block always use the bare op name (`read_artifact`). `to` and `reviewers` are arrays. Publish needs `name`, `type`, `content`.");
  lines.push("```mesh-json");
  lines.push('[{"op":"send","type":"REQUEST","to":["tech-lead"],"newThread":{"subject":"review X"},"payload":{"question":"please review"}},');
  lines.push(' {"op":"publish_artifact","name":"notes","type":"ResearchReport","content":"...full text..."},');
  lines.push(' {"op":"wait","reason":"awaiting review"}]');
  lines.push("```");
  lines.push("Common ops: send (type/to/payload), publish_artifact (name/type/content), request_review (artifactId/reviewers), create_task (title/description/assignedTo), claim_task, complete_task, propose_decision (topic/decision), escalate (reason/detail), remember (key/value), discharge (messageId/reason), done (summary — the turn summary the mesh records, so make it say what actually happened), wait (reason), plan (steps: array of {text, capabilities}), plan_step (stepId/status DONE|PENDING). A turn that emits no valid ops changes nothing.");
  // The `send` type is a CLOSED enum, and until this line existed the contract
  // never said so — it showed one example ("REQUEST") and left the rest to be
  // guessed. Models guessed RESULT / RESPONSE / ResearchReport, every such
  // message failed schema validation and was dropped, and the recipient was
  // never woken. In one live run 23 of 30 messages died this way. Listing the
  // enum costs ~40 tokens per turn and removes the single largest source of
  // wasted turns in the mesh.
  lines.push(`\`send\` type MUST be exactly one of: ${MESSAGE_TYPES.join(", ")}. Any other value is rejected and your message is never delivered. Answering someone? Use INFORM in their thread — there is no RESULT/RESPONSE/REPLY type.`);
  lines.push("");
  // Everything below was implemented but absent from this contract, so agents
  // could not use it: 18 of 30 ops were undocumented. The costly one is
  // `approve` — the ONLY op that can satisfy an acceptance criterion. Without
  // it in the prompt, missions produced correct work (code merged, tests
  // green) and then stalled forever because nobody could convert that work
  // into evidence, while repeatedly attempting acceptance without the
  // required artifactId and being rejected every time.
  lines.push("## Closing out work (how evidence actually gets recorded)");
  // Shown only to a seat that can actually close a criterion. `approve` on
  // subject `criterion:<id>` is refused without requirements.accept /
  // requirements.approve, so for every other seat these two lines are an
  // instruction to spend turns on a call the kernel will deny — and the
  // denial names an authority, which is how a refusal became a request to
  // widen a grant. The artifact approve/reject line below stays visible to
  // every review-capability seat; only the criterion branch is gated.
  if (bundle.criterionAcceptanceEnabled) {
    lines.push(
      'Satisfy an acceptance criterion with: {"op":"approve","subject":"criterion:<criterionId>","artifactId":"<evidence artifact id>","comment":"why this proves it"}. Use the exact criterion id from the acceptance-criteria list above.',
    );
    // The artifactId requirement is enforced in recordDecision; stating it here
    // is what keeps agents from burning turns on rejected comment-only accepts.
    lines.push(
      'For a MANDATORY criterion the artifactId is REQUIRED and must point at a real published deliverable of THIS goal — a comment alone is rejected, and so is a stub or placeholder artifact. Publish the actual work first, then accept against it. Optional criteria may be accepted with a comment.',
    );
  }
  lines.push(
    'Approve or reject a reviewed artifact with: {"op":"approve","subject":"<what>","artifactId":"<id>"} — also "reject", "veto", "block", same shape. This needs the matching authority or review capability, and you cannot approve your own artifact when a peer reviewer exists.',
  );
  lines.push(
    'Move an artifact through its lifecycle with: {"op":"transition_artifact","artifactId":"<id>","to":"READY_FOR_REVIEW"}. ONLY the artifact owner may transition it — ask the owner otherwise. A DRAFT nobody transitions is never reviewed and never becomes evidence.',
  );
  lines.push("");
  lines.push("## Other available ops");
  lines.push("- respond (messageId/type/payload) — answer one specific request.");
  lines.push(
    "- read_artifact (artifactRef, offset?) — fetch content instead of guessing at it. A large artifact returns in parts: if the result says truncated, read again with the nextOffset it gives you before drawing conclusions.",
  );
  lines.push("- request_research (to/question) — ask the explorer a read-only question.");
  lines.push("- broadcast (type/payload) — inform everyone you may contact; prefer a targeted send.");
  lines.push("- ratify_decision (decisionId) — promote a proposed decision to a shared fact.");
  lines.push("- commit / request_commit / merge — version-control moves, subject to your capabilities.");
  lines.push("- delegate (taskId/to), acquire_lease / release_lease (resource) — hand off work, avoid collisions.");
  // Shown only when usable: with delegation off (the v1 default, max_depth 0)
  // every spawn_worker is denied, so advertising it would only buy wasted turns.
  if (bundle.delegationEnabled) {
    lines.push(
      "- spawn_worker (taskSpec) — start a sub-worker; it reports back ONLY via submit_result (result), and you never see its transcript.",
    );
  }
  lines.push("");
  lines.push("## Answering (this is how the mesh knows a question is settled)");
  lines.push(
    'Always set `replyTo` to the id of the request you are answering. That is the only exact signal the runtime has; without it it must guess from thread and timing, and a wrong guess either strands the asker waiting forever or closes a question nobody actually answered.',
  );
  lines.push(
    'If you cannot or will not answer a request addressed to you, say so with `discharge` (messageId + reason). Never just stay silent: silence is indistinguishable from "still working", so the runtime keeps nudging you, burns budget, and eventually escalates it to a human as a stalemate.',
  );
  return lines.join("\n");
}
