import type {
  AgentContextBundle,
  Artifact,
  MeshMessage,
  Task,
} from "../../protocol/src/index";
import { refToString } from "../../protocol/src/uri";
import type { ResolvedMeshConfig } from "../../config/src/index";
import { loadRolePrompt } from "../../config/src/index";
import type { Kernel } from "./kernel";
import { agentKey, missionKey } from "./budgets";

export interface ContextBuilderDeps {
  config: ResolvedMeshConfig;
  kernel: Kernel;
}

const MAX_UNREAD = 12;
const MAX_DECISIONS = 10;
const MAX_ARTIFACT_REFS = 20;
const MAX_ACTIVITY = 15;

export function buildAgentContext(deps: ContextBuilderDeps, agentId: string, taskHint?: Task): AgentContextBundle {
  const { config, kernel } = deps;
  const state = kernel.state;
  const record = state.agents.get(agentId);
  if (!record) throw new Error(`unknown agent ${agentId}`);
  const goalId = state.activeGoalId ?? "";
  const goal = state.goals.get(goalId);

  const unreadIds = state.unread.get(agentId) ?? [];
  const unread: MeshMessage[] = unreadIds.slice(0, MAX_UNREAD).map((id) => state.messages.get(id)!).filter(Boolean);

  const decisions = [...state.decisions.values()]
    .filter((d) => d.goalId === goalId && d.status === "RATIFIED")
    .sort((a, b) => b.ratifiedAt!.localeCompare(a.ratifiedAt ?? a.createdAt))
    .slice(0, MAX_DECISIONS);

  const relevantArtifacts = [...state.artifacts.values()]
    .filter((a) => a.goalId === goalId && isRelevantArtifact(a, agentId, unread))
    .slice(0, MAX_ARTIFACT_REFS)
    .map((a) => ({
      ref: refToString({ uri: `artifact://${a.type}/${a.name}/${a.version}` }),
      type: a.type,
      status: a.status,
      name: a.name,
      version: a.version,
    }));

  const recentOwnActivity = [...state.messages.values()]
    .filter((m) => m.from === agentId || m.to.includes(agentId))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, MAX_ACTIVITY)
    .map((m) => `[${m.timestamp}] ${m.from} → ${m.to.join(",")} ${m.type} ${summarizePayload(m)}`);

  const memoryMap = state.memory.get(agentId);
  const agentMemory = memoryMap ? [...memoryMap.values()] : [];

  const openThreads = [...state.threads.values()].filter(
    (t) => t.goalId === goalId && t.status === "OPEN" && t.participants.includes(agentId),
  );

  const agentBudget = state.budgets.get(agentKey(goalId, agentId));
  const missionBudget = state.budgets.get(missionKey(goalId));

  const relevantPolicies = describePoliciesFor(config, agentId);

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
  };
}

function isRelevantArtifact(a: Artifact, agentId: string, unread: MeshMessage[]): boolean {
  if (a.owner === a.createdBy && a.createdBy === agentId) return true;
  const mentioned = new Set<string>();
  for (const m of unread) for (const r of m.artifactRefs) mentioned.add(r.uri);
  for (const r of mentioned) {
    if (r.includes(`/${a.name}/`)) return true;
  }
  return a.status === "UNDER_REVIEW" || a.status === "READY_FOR_REVIEW";
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
    lines.push("## Artifact references (fetch via mesh.artifact.read — do not paste contents)");
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
  lines.push("## How to act");
  lines.push(
    "Reply with structured mesh operations only. Never communicate outside the mesh. Keep responses short; reference artifacts instead of pasting content. When you need something from another agent, send a typed request and finish your turn (the runtime will wake you on the response).",
  );
  return lines.join("\n");
}
