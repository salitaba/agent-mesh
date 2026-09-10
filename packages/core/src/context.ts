import type {
  AgentContextBundle,
  Artifact,
  MeshMessage,
  Task,
} from "../../protocol/src/index";
import { refToString } from "../../protocol/src/uri";
import { MESSAGE_TYPES } from "../../protocol/src/catalog";
import type { ResolvedMeshConfig } from "../../config/src/index";
import { loadRolePrompt } from "../../config/src/index";
import type { Kernel } from "./kernel";
import { agentKey, missionKey } from "./budgets";
import { outstandingDebtors, stillOwes } from "./state";

export interface ContextBuilderDeps {
  config: ResolvedMeshConfig;
  kernel: Kernel;
}

const MAX_UNREAD = 12;
const MAX_DECISIONS = 10;
const MAX_ARTIFACT_REFS = 20;
const MAX_ACTIVITY = 15;
const MAX_OUTSTANDING = 10;

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
  const state = kernel.state;
  const record = state.agents.get(agentId);
  if (!record) throw new Error(`unknown agent ${agentId}`);
  const goalId = state.activeGoalId ?? "";
  const goal = state.goals.get(goalId);

  const unreadIds = state.unread.get(agentId) ?? [];
  const unread: MeshMessage[] = unreadIds.slice(0, maxUnread).map((id) => state.messages.get(id)!).filter(Boolean);

  const decisions = [...state.decisions.values()]
    .filter((d) => d.goalId === goalId && d.status === "RATIFIED")
    .sort((a, b) => b.ratifiedAt!.localeCompare(a.ratifiedAt ?? a.createdAt))
    .slice(0, maxDecisions);

  const relevantArtifacts = [...state.artifacts.values()]
    .filter((a) => a.goalId === goalId && isRelevantArtifact(a, agentId, unread))
    .slice(0, maxArtifactRefs)
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
  }

  const memoryMap = state.memory.get(agentId);
  const agentMemory = memoryMap ? [...memoryMap.values()] : [];

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

  const relevantPolicies = describePoliciesFor(config, agentId);

  const goalCriteria = (goal?.acceptanceCriteria ?? []).map((c) => ({
    id: c.id,
    description: c.description,
    status: c.status,
    mandatory: c.mandatory,
  }));

  return {
    rolePrompt: cachedRolePrompt(deps, agentId),
    mission: goal ? goal.description : config.goalText,
    relevantPolicies,
    agentState: { ...record.state },
    currentTask: taskHint ?? (record.state.activeTaskId ? state.tasks.get(record.state.activeTaskId) : undefined),
    relevantDecisions: decisions,
    relevantArtifacts,
    unreadMail: unread,
    recentOwnActivity,
    agentMemory,
    openThreads,
    budgetSnapshot: {
      agentTokensUsed: agentBudget?.consumed ?? record.state.tokensConsumed,
      agentTokenBudget: agentBudget?.limit ?? config.agents[agentId]?.budget.tokens ?? 0,
      missionTokensUsed: missionBudget?.consumed ?? 0,
      missionTokenBudget: missionBudget?.limit ?? config.budgets.mission.tokens,
    },
    outstanding: { awaitingResponse: byAge(awaitingResponse), owedByYou: byAge(owedByYou) },
    goalCriteria,
    delegationEnabled: (config.agents[agentId]?.delegationPolicy.allowDelegation ?? false) &&
      (config.agents[agentId]?.delegationPolicy.maxDepth ?? 0) > 0,
  };
}

function isRelevantArtifact(a: Artifact, agentId: string, unread: MeshMessage[]): boolean {
  if (a.owner === a.createdBy && a.createdBy === agentId) return true;
  const mentioned = new Set<string>();
  for (const m of unread) for (const r of m.artifactRefs) mentioned.add(r.uri);
  for (const r of mentioned) {
    if (r.includes(`/${a.name}/`)) return true;
  }
  if (a.status === "UNDER_REVIEW" || a.status === "READY_FOR_REVIEW") return true;
  // Mission-level design documents must always be visible: an agent whose job
  // is to accept/review the design (e.g. pm owning requirements.accept)
  // otherwise works from memory alone while a DRAFT it was never handed sits
  // in the store — and escalates "no ArchitectureDoc" while one exists.
  if (a.type === "ArchitectureDocument" || a.type === "RequirementsDoc" || a.type === "ADR" || a.type === "ApiSpec") return true;
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

function cachedRolePrompt(deps: ContextBuilderDeps, agentId: string): string {
  const definition = deps.kernel.state.agents.get(agentId)?.definition;
  const cacheKey = `${deps.config.filePath}:${agentId}:${definition?.prompt.file ?? definition?.prompt.text?.slice(0, 24) ?? "default"}`;
  const hit = promptCache.get(cacheKey);
  if (hit) return hit;
  const text = loadRolePrompt(deps.config, agentId, definition);
  promptCache.set(cacheKey, text);
  return text;
}

export function clearPromptCache(): void {
  promptCache.clear();
}

export function renderContextInstructions(bundle: AgentContextBundle): string {
  const lines: string[] = [];
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
  if (bundle.agentMemory.length > 0) {
    lines.push("## Your memory (L2)");
    for (const m of bundle.agentMemory) lines.push(`- ${m.key}: ${m.value}`);
    lines.push("");
  }
  if (bundle.relevantDecisions.length > 0) {
    lines.push("## Ratified decisions (L3 — shared organizational facts)");
    for (const d of bundle.relevantDecisions) {
      lines.push(`- [${d.id}] ${d.topic}: ${JSON.stringify(d.decision)}`);
    }
    lines.push("");
  }
  if (bundle.relevantArtifacts.length > 0) {
    lines.push("## Artifact references (fetch via mesh_artifact_read — do not paste contents)");
    for (const a of bundle.relevantArtifacts) {
      lines.push(`- ${a.ref} (${a.type}, ${a.status})`);
    }
    lines.push("");
  }
  if (bundle.currentTask) {
    lines.push(`## Current task: ${bundle.currentTask.id} — ${bundle.currentTask.title}`);
    lines.push(bundle.currentTask.description);
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
    lines.push("");
  }
  if (bundle.recentOwnActivity.length > 0) {
    lines.push("## Recent related activity");
    for (const a of bundle.recentOwnActivity) lines.push(`- ${a}`);
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
      lines.push(
        `- YOU OWE ${o.from} an answer to ${o.type} [${o.messageId}] since ${o.since} — answer it (reply with replyTo: "${o.messageId}"), or close it with discharge if you will not.`,
      );
    }
    for (const a of awaitingResponse) {
      lines.push(`- WAITING on ${a.to.join(",")} for your ${a.type} [${a.messageId}] since ${a.since} — already sent; do NOT send it again. Follow up only if it is stale, otherwise 'wait'.`);
    }
    lines.push("");
  } else {
    lines.push("## Open loops");
    lines.push("Nothing is pending in either direction: you owe no answers and are waiting on nobody.");
    lines.push("");
  }
  lines.push("## How to act");
  // "Keep responses short" used to live here and was actively harmful: it is an
  // instruction to produce less, applied to the one thing the mission is judged
  // on. Brevity belongs in COORDINATION (messages, status), never in the
  // deliverable. Missions were completing with five ticked criteria backed by
  // one-paragraph artifacts. The distinction below is the fix.
  lines.push(
    "Reply with structured mesh operations only. Never communicate outside the mesh. When you need something from another agent, send a typed request and finish your turn (the runtime will wake you on the response).",
  );
  lines.push(
    "Be terse in COORDINATION (messages, comments, status) — reference artifacts by id rather than pasting their contents into mail. Be COMPLETE in DELIVERABLES: artifact content is the mission output and is judged on it. Publish the full work — full documents, full code, full analysis with reasoning and specifics. A stub, an outline, or a summary-of-what-you-would-write is not a deliverable and does not evidence a criterion.",
  );
  lines.push("");
  lines.push("## Ops block contract (must follow exactly — otherwise your turn does nothing)");
  lines.push("Emit ONE fenced block named `mesh-json` containing a JSON array of ops. Op names are bare words with NO `mesh_` prefix (`send`, NOT `mesh_send`). `to` and `reviewers` are arrays. Publish needs `name`, `type`, `content`.");
  lines.push("```mesh-json");
  lines.push('[{"op":"send","type":"REQUEST","to":["tech-lead"],"newThread":{"subject":"review X"},"payload":{"question":"please review"}},');
  lines.push(' {"op":"publish_artifact","name":"notes","type":"ResearchReport","content":"...full text..."},');
  lines.push(' {"op":"wait","reason":"awaiting review"}]');
  lines.push("```");
  lines.push("Common ops: send (type/to/payload), publish_artifact (name/type/content), request_review (artifactId/reviewers), create_task (title/description/assignedTo), claim_task, complete_task, propose_decision (topic/decision), escalate (reason/detail), remember (key/value), discharge (messageId/reason), done (summary), wait (reason). A turn that emits no valid ops changes nothing.");
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
  lines.push(
    'Satisfy an acceptance criterion with: {"op":"approve","subject":"criterion:<criterionId>","artifactId":"<evidence artifact id>","comment":"why this proves it"}. Use the exact criterion id from the acceptance-criteria list above.',
  );
  // The artifactId requirement is enforced in recordDecision; stating it here
  // is what keeps agents from burning turns on rejected comment-only accepts.
  lines.push(
    'For a MANDATORY criterion the artifactId is REQUIRED and must point at a real published deliverable of THIS goal — a comment alone is rejected, and so is a stub or placeholder artifact. Publish the actual work first, then accept against it. Optional criteria may be accepted with a comment.',
  );
  lines.push(
    'Approve or reject a reviewed artifact with: {"op":"approve","subject":"<what>","artifactId":"<id>"} — also "reject", "veto", "block", same shape. This needs the matching authority or review capability, and you cannot approve your own artifact when a peer reviewer exists.',
  );
  lines.push(
    'Move an artifact through its lifecycle with: {"op":"transition_artifact","artifactId":"<id>","to":"READY_FOR_REVIEW"}. ONLY the artifact owner may transition it — ask the owner otherwise. A DRAFT nobody transitions is never reviewed and never becomes evidence.',
  );
  lines.push("");
  lines.push("## Other available ops");
  lines.push("- respond (messageId/type/payload) — answer one specific request.");
  lines.push("- read_artifact (artifactRef) — fetch content instead of guessing at it.");
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
