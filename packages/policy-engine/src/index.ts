import type {
  Artifact,
  ArtifactStatus,
  MeshEvent,
  MeshMessage,
  PolicyDecisionResult,
} from "../../protocol/src/index";
import type { PolicyContext, PolicyEvaluator } from "../../core/src/ports";
import { checkApprovals, gateForTransition, holdsAuthority } from "../../core/src/projections";
import { approvalKey } from "../../core/src/state";
import type { RawPolicyRule } from "../../config/src/index";
import { HUMAN_AGENT_ID } from "../../core/src/supervisor";

const ALLOW: PolicyDecisionResult = { decision: "ALLOW", reason: "default allow" };

export class PolicyEngine implements PolicyEvaluator {
  private rules: RawPolicyRule[];

  constructor(rules: RawPolicyRule[] = []) {
    this.rules = rules;
  }

  setRules(rules: RawPolicyRule[]): void {
    this.rules = rules;
  }

  private agentDef(ctx: PolicyContext, id: string) {
    return ctx.projections.agents.get(id)?.definition;
  }

  // Layer 3: bus-level communication checks
  evaluateMessage(
    from: string,
    to: string[],
    message: Pick<MeshMessage, "type" | "threadId" | "payload" | "taskId">,
    ctx: PolicyContext,
  ): PolicyDecisionResult {
    if (from === HUMAN_AGENT_ID) return { decision: "ALLOW", reason: "human operator" };
    const senderDef = this.agentDef(ctx, from);
    if (!senderDef) return { decision: "DENY", reason: `sender ${from} is not registered`, ruleId: "registry" };

    const goal = ctx.goal ?? (ctx.projections.activeGoalId ? ctx.projections.goals.get(ctx.projections.activeGoalId) : undefined);
    if (goal && (goal.status === "ESCALATED" || goal.status === "BLOCKED") && message.type !== "ESCALATE") {
      return { decision: "DENY", reason: `goal is ${goal.status}; only escalation messages are accepted`, ruleId: "goal-state" };
    }

    const existingThread = ctx.projections.threads.get(message.threadId);
    const isReply = Boolean(existingThread || message.taskId);
    const allowed: string[] = [];
    const denied: string[] = [];
    for (const target of to) {
      const targetDef = this.agentDef(ctx, target);
      if (!targetDef) {
        denied.push(target);
        continue;
      }
      const hierarchical = target.startsWith(`${from}#`) || from.startsWith(`${target}#`);
      if (hierarchical) {
        allowed.push(target);
        continue;
      }
      const mayContact =
        communicationAllows(ctx, from, target) ||
        isReplyViaParticipants(ctx, message, from, target);
      if (target === HUMAN_AGENT_ID || mayContact) {
        allowed.push(target);
      } else {
        denied.push(target);
      }
    }
    if (denied.length > 0 && allowed.length === 0) {
      const rule = this.matchRule(ctx, { actorId: from, message: message.type });
      if (rule?.escalate) return { decision: "ESCALATE", reason: `contact ${from}->${denied.join(",")} forbidden by rule ${rule.id}`, ruleId: rule.id };
      return {
        decision: "DENY",
        reason: `communication policy forbids ${from} from initiating contact with ${denied.join(", ")} (replies inside existing threads are always allowed)`,
        ruleId: "communication",
      };
    }
    const custom = this.matchRule(ctx, { actorId: from, message: message.type, targets: denied });
    if (custom) {
      if (custom.deny?.message_types?.includes(message.type)) {
        return { decision: "DENY", reason: `denied by policy rule '${custom.id}'`, ruleId: custom.id };
      }
      if (custom.escalate) {
        return { decision: "ESCALATE", reason: `rule '${custom.id}' requires escalation`, ruleId: custom.id };
      }
    }
    if (denied.length > 0 && allowed.length > 0) {
      return { decision: "REDIRECT", reason: `dropped unauthorized recipients ${denied.join(", ")}`, redirects: allowed, ruleId: "communication" };
    }
    return { decision: "ALLOW", reason: allowed.length === to.length ? "all recipients permitted" : "partial redirect applied", redirects: allowed };
  }

  // Layer 2: tool/capability enforcement
  evaluateCapability(actorId: string, capability: string, ctx: PolicyContext): PolicyDecisionResult {
    if (actorId === HUMAN_AGENT_ID) return ALLOW;
    const def = this.agentDef(ctx, actorId);
    if (!def) return { decision: "DENY", reason: `unknown agent ${actorId}`, ruleId: "registry" };
    const rule = this.matchRule(ctx, { actorId, capability });
    if (rule?.deny?.capabilities?.includes(capability)) {
      return { decision: "DENY", reason: `capability '${capability}' denied by rule '${rule.id}'`, ruleId: rule.id };
    }
    if (!def.capabilities.includes(capability)) {
      return { decision: "DENY", reason: `agent ${actorId} does not hold capability '${capability}'`, ruleId: "capabilities" };
    }
    return ALLOW;
  }

  evaluateAuthority(actorId: string, subject: string, kind: string, ctx: PolicyContext): PolicyDecisionResult {
    if (actorId === HUMAN_AGENT_ID) return { decision: "ALLOW", reason: "human override authority" };
    const def = this.agentDef(ctx, actorId);
    if (!def) return { decision: "DENY", reason: `unknown agent ${actorId}`, ruleId: "registry" };
    const required = `${subject}.${kind}`;
    const has = holdsAuthority(def.authority, subject, kind);
    if (!has) {
      const rule = this.matchRule(ctx, { actorId, authority: required });
      if (rule?.escalate) return { decision: "ESCALATE", reason: `authority '${required}' missing; rule '${rule.id}' escalates`, ruleId: rule.id };
      return { decision: "DENY", reason: `agent ${actorId} (role ${def.role}) lacks authority '${required}'`, ruleId: "authority" };
    }
    const rule = this.matchRule(ctx, { actorId, authority: required });
    if (rule && (rule.deny?.capabilities?.length ?? 0) > 0) {
      return { decision: "DENY", reason: `authority '${required}' denied by rule '${rule.id}'`, ruleId: rule.id };
    }
    return { decision: "ALLOW", reason: `authority '${required}' held by ${actorId}` };
  }

  // Layer 3+4 boundary: transitions need structural validity + configured gates
  evaluateTransition(artifact: Artifact, to: ArtifactStatus, actorId: string, ctx: PolicyContext): PolicyDecisionResult {
    if (actorId === HUMAN_AGENT_ID) return ALLOW;
    const def = this.agentDef(ctx, actorId);
    if (!def) return { decision: "DENY", reason: `unknown agent ${actorId}`, ruleId: "registry" };
    const owner = artifact.owner;
    const actorRole = def.role;

    const needsOwner = to === "READY_FOR_REVIEW" || to === "DRAFT" || to === "ARCHIVED";
    if (needsOwner && owner !== actorId) {
      return { decision: "DENY", reason: `transition to ${to} is reserved for the artifact owner (${owner})`, ruleId: "single-writer" };
    }
    if (to === "APPROVED" || to === "REJECTED") {
      if (owner === actorId && hasPeerReviewerFor(ctx, actorId, artifact)) {
        return { decision: "DENY", reason: "artifact owner cannot approve or reject their own artifact", ruleId: "self-approval" };
      }
      const review = canReviewArtifactType(def, artifact.type);
      if (!review.ok) {
        return { decision: "DENY", reason: `reviewing ${artifact.type} requires authority '${review.required}' or capability '${review.capability}'`, ruleId: "review-authority" };
      }
    }
    if (to === "MERGED") {
      const cap = this.evaluateCapability(actorId, "git.merge", ctx);
      if (cap.decision !== "ALLOW") return cap;
    }
    if (to === "VERIFIED") {
      const ok = def.capabilities.some((c) => ["test.execute", "security.review"].includes(c)) || def.authority.includes("implementation.approve");
      if (!ok) return { decision: "DENY", reason: "VERIFIED requires a verification role or implementation approval authority", ruleId: "verified-actor" };
    }
    if (to === "QA_VERIFIED") {
      const evidence = this.isSatisfied("release.accepted", ctx) && checkApprovals(ctx.projections, ["qa.pass"], undefined).ok;
      const ok = actorRole === "qa" || def.capabilities.includes("test.execute") || evidence === true;
      if (!ok) return { decision: "DENY", reason: "QA_VERIFIED requires qa, test.execute, or recorded qa.pass evidence", ruleId: "qa-verified-actor" };
    }
    if (to === "SECURITY_VERIFIED") {
      const evidence = checkApprovals(ctx.projections, ["security.pass"], undefined).ok;
      const ok = actorRole === "security" || def.capabilities.some((c) => c === "security.review" || c === "security.scan") || evidence;
      if (!ok) return { decision: "DENY", reason: "SECURITY_VERIFIED requires security role, capability, or recorded security.pass evidence", ruleId: "sec-verified-actor" };
    }
    if (to === "ACCEPTED") {
      const ok = def.authority.some((a) => a === "requirements.accept" || a === "release.accept" || a === "implementation.approve");
      if (!ok) return { decision: "DENY", reason: "release ACCEPTED requires requirements.accept authority", ruleId: "release-accept-actor" };
    }
    const machineName = gateForTransition(artifact.type, to);
    const requires = ctx.config.transitionGates[machineName];
    if (requires && requires.length > 0) {
      const missionLevel = machineName === "implementation.completed" || machineName === "release.accepted";
      const res = checkApprovals(ctx.projections, requires, missionLevel ? undefined : artifact.id);
      if (!res.ok) {
        return {
          decision: "DENY",
          reason: `transition '${machineName}' requires ${requires.join(", ")}; missing: ${res.missing.join(", ")}`,
          ruleId: `gate:${machineName}`,
        };
      }
    }
    const blocks = [...ctx.projections.approvals.values()].flat().filter((r) => r.kind === "block" && r.artifactId === artifact.id);
    if (blocks.length > 0) {
      const latestBlock = blocks.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0];
      const laterFix = [...ctx.projections.artifactHistory.get(artifact.id) ?? []].find(
        (v) => v.createdAt > latestBlock.recordedAt && (v.status === "DRAFT" || v.status === "READY_FOR_REVIEW"),
      );
      if (!laterFix && to !== "REJECTED" && to !== "DRAFT" && to !== "ARCHIVED") {
        return {
          decision: "DENY",
          reason: `active ${latestBlock.actorRole || latestBlock.actorId} BLOCK on ${artifact.name} must be resolved by a new version first`,
          ruleId: "active-block",
        };
      }
    }
    return { decision: "ALLOW", reason: `transition ${artifact.status} -> ${to} permitted` };
  }

  isSatisfied(gate: string, ctx: PolicyContext, subject?: string): { ok: boolean; missing: string[] } {
    const requires = ctx.config.transitionGates[gate];
    if (!requires || requires.length === 0) return { ok: true, missing: [] };
    return checkApprovals(ctx.projections, requires, subject);
  }

  evaluateActivation(agentId: string, event: MeshEvent, ctx: PolicyContext): PolicyDecisionResult {
    if (agentId === HUMAN_AGENT_ID) return { decision: "DENY", reason: "human seat is activated by operators only" };
    const def = this.agentDef(ctx, agentId);
    if (!def) return { decision: "DENY", reason: `unknown agent ${agentId}`, ruleId: "registry" };
    if (def.mode === "service" && !["message.sent", "research.requested", "task.created", "task.claimed"].includes(event.type)) {
      return { decision: "DENY", reason: "service agents activate on requests only", ruleId: "service-mode" };
    }
    const budgetKey = `agent:${ctx.projections.activeGoalId}/${agentId}`;
    const budget = ctx.projections.budgets.get(budgetKey);
    if (budget?.exceeded) {
      return { decision: "DEFER", reason: `agent budget exhausted (${budget.consumed}/${budget.limit ?? "?"})`, ruleId: "budget" };
    }
    // A turn bound to a blown thread budget fails instantly at reservation
    // time; parking the activation beats spinning fail-turns (which starve
    // the event loop). Thread-agnostic reasons (recovery/manual/timer) still
    // run once and fail visibly instead of looping.
    const threadId = (event.payload as { threadId?: unknown } | null)?.threadId;
    if (typeof threadId === "string" && threadId) {
      const threadBudget = ctx.projections.budgets.get(`thread:${ctx.projections.activeGoalId}/${threadId}`);
      if (threadBudget?.exceeded) {
        return { decision: "DEFER", reason: `thread budget exhausted (${threadBudget.consumed}/${threadBudget.limit ?? "?"})`, ruleId: "thread-budget" };
      }
    }
    if (def.budget.maxActivations !== undefined && def.budget.maxActivations <= (ctx.projections.agents.get(agentId)?.state.activations ?? 0)) {
      return { decision: "DEFER", reason: `max_activations ${def.budget.maxActivations} reached`, ruleId: "max-activations" };
    }
    const goal = ctx.goal;
    if (goal && goal.status === "PAUSED") return { decision: "DEFER", reason: "goal paused", ruleId: "goal-paused" };
    // A halted mission runs no turns (runTurn refuses them all). Parking the
    // activation here — instead of letting it reach the scheduler queue — is
    // what breaks the wedge: queued-then-silently-dropped turns finish
    // instantly and requeue forever in a timer-free microtask loop that
    // starves HTTP while emitting nothing (invisible in the log).
    // Post-completion feedback: a human message must still wake its recipient
    // so it can be answered. This is the one thing that runs on a completed
    // goal; every other activation stays denied.
    if (goal && goal.status === "COMPLETED" && event.type === "message.sent") {
      return ALLOW;
    }
    if (goal && (goal.status === "ESCALATED" || goal.status === "COMPLETED" || goal.status === "FAILED")) {
      const why = goal.status === "ESCALATED" ? "mission is escalated — respond to the open escalation first" : `mission is ${goal.status.toLowerCase()}`;
      return { decision: "DENY", reason: why, ruleId: "goal-halted" };
    }
    return ALLOW;
  }

  checkOwnership(actorId: string, artifactId: string, ctx: PolicyContext): PolicyDecisionResult {
    const a = ctx.projections.artifacts.get(artifactId);
    if (!a) return { decision: "DENY", reason: `unknown artifact ${artifactId}`, ruleId: "registry" };
    if (actorId === HUMAN_AGENT_ID) return ALLOW;
    if (a.owner !== actorId) {
      return { decision: "DENY", reason: `single-writer invariant: ${a.owner} holds ${artifactId}`, ruleId: "single-writer" };
    }
    return ALLOW;
  }

  private matchRule(
    ctx: PolicyContext,
    match: { actorId?: string; message?: string; capability?: string; authority?: string; targets?: string[] },
  ): RawPolicyRule | undefined {
    for (const rule of this.rules) {
      const w = rule.when ?? {};
      if (w.actor && match.actorId && w.actor !== match.actorId) continue;
      if (w.actor_role && match.actorId) {
        const role = this.agentDef(ctx, match.actorId)?.role;
        if (role !== w.actor_role) continue;
      }
      if (w.message_type && match.message && w.message_type !== match.message) continue;
      if (w.capability && match.capability && w.capability !== match.capability) continue;
      if (w.event && !match.message) continue;
      return rule;
    }
    return undefined;
  }
}

/**
 * "Replies inside an existing thread are always allowed" — but only between
 * agents that thread actually put in contact.
 *
 * `thread.participants` is an ever-growing roster: the reducer appends every
 * sender AND every recipient of every message (projections-messaging.ts). One
 * broadcast therefore enrolls the whole mesh into a single thread, after
 * which this check returned true for ANY pair of agents in it — silently
 * voiding the communication matrix that the mesh config, the role prompts and
 * the escalation rules all assume is being enforced.
 *
 * A real reply relationship needs a conversational link: the target must have
 * spoken in the thread, or have been addressed in it. Merely being swept into
 * the roster by someone else's broadcast is not consent to be contacted.
 */
function isReplyViaParticipants(ctx: PolicyContext, message: Pick<MeshMessage, "threadId">, from: string, target: string): boolean {
  const thread = ctx.projections.threads.get(message.threadId);
  if (!thread) return false;
  if (!thread.participants.includes(from) || !thread.participants.includes(target)) return false;
  // The thread opener is always reachable by anyone it invited.
  if (thread.initiator === target || thread.initiator === from) return true;
  for (const mid of thread.messageIds) {
    const m = ctx.projections.messages.get(mid);
    if (!m) continue;
    // target spoke to us, or we were both on the same message.
    if (m.from === target && (m.to.includes(from) || from === thread.initiator)) return true;
    if (m.from === from && m.to.includes(target)) return true;
    if (m.to.includes(target) && m.to.includes(from)) return true;
  }
  return false;
}

function communicationAllows(ctx: PolicyContext, from: string, target: string): boolean {
  const fromKey = configKeyFor(ctx, from);
  const targetKey = configKeyFor(ctx, target);
  const outPol = fromKey ? ctx.config.communication[fromKey] : undefined;
  const inPol = targetKey ? ctx.config.communication[targetKey] : undefined;
  if (outPol && outPol.mayContact.includes(target ?? "")) return true;
  if (outPol && outPol.mayContact.includes(targetKey ?? "")) return true;
  if (inPol && inPol.mayBeContactedBy.includes(from ?? "")) return true;
  if (inPol && inPol.mayBeContactedBy.includes(fromKey ?? "")) return true;
  const fromRole = ctx.projections.agents.get(from)?.definition.role;
  const targetRole = ctx.projections.agents.get(target)?.definition.role;
  if (fromRole && inPol?.mayBeContactedBy.includes(fromRole)) return true;
  if (targetRole && outPol?.mayContact.includes(targetRole)) return true;
  return false;
}

function configKeyFor(ctx: PolicyContext, id: string): string | undefined {
  if (ctx.config.communication[id]) return id;
  const base = id.split("#")[0];
  if (ctx.config.communication[base]) return base;
  const role = ctx.projections.agents.get(id)?.definition.role;
  if (role && ctx.config.communication[role]) return role;
  return undefined;
}

export const REVIEW_CAPABILITIES: Partial<Record<Artifact["type"], string>> = {
  ArchitectureDocument: "review.design",
  ADR: "review.design",
  ApiSpec: "review.design",
  DatabaseSchema: "review.design",
  CodePatch: "code.review",
  ReleasePlan: "code.review",
  TestReport: "test.write",
  SecurityReport: "security.review",
  RequirementsDoc: "review.design",
};

export function reviewSubject(artifact: Pick<Artifact, "type">): string {
  switch (artifact.type) {
    case "ArchitectureDocument":
    case "ADR":
    case "ApiSpec":
    case "DatabaseSchema":
      return "architecture";
    case "CodePatch":
    case "ReleasePlan":
      return "implementation";
    case "TestReport":
      return "quality";
    case "SecurityReport":
      return "security";
    case "RequirementsDoc":
    case "Requirement":
      return "requirements";
    default:
      return "architecture";
  }
}

/**
 * Can this agent definition review artifacts of `type`?
 *
 * The single source of truth for the `review-authority` rule: evaluateTransition
 * enforces it and config-time gate validation mirrors it. Duplicating the
 * authority grammar here and there is how a valid config silently becomes an
 * unsatisfiable gate.
 */
export function canReviewArtifactType(
  def: { authority?: readonly string[]; capabilities?: readonly string[] },
  type: Artifact["type"],
): { ok: boolean; required: string; capability: string | null } {
  const subject = reviewSubject({ type });
  const capability = REVIEW_CAPABILITIES[type] ?? null;
  const authority = def.authority ?? [];
  const ok =
    authority.includes(`${subject}.approve`) ||
    authority.includes(`${subject}.*`) ||
    authority.includes("*") ||
    (capability !== null && (def.capabilities ?? []).includes(capability));
  return { ok, required: `${subject}.approve`, capability };
}

export interface GateIssue {
  gate: string;
  token: string;
  reason: string;
}

/** Gates whose artifact type is fixed by `gateForTransition`. */
const GATE_ARTIFACT_TYPES: Record<string, Artifact["type"]> = {
  "patch.merge": "CodePatch",
  "patch.approve": "CodePatch",
  "release.accepted": "ReleasePlan",
  "implementation.completed": "ReleasePlan",
};

/**
 * Can every transition gate in this config ever be satisfied?
 *
 * AJV validates the shape of `policies.transitions` but not whether the agents
 * it names can produce the approval it demands. A gate on `architect.approve`
 * where the architect holds neither `implementation.approve` nor `code.review`
 * validates, boots, and then DEADLOCKS every mission at that transition.
 *
 * Checks each token's actor resolves to an agent id or role (the human seat is
 * always valid) and that `approve` tokens on known artifact gates pass the same
 * review predicate the runtime applies.
 */
export function validateTransitionGates(
  transitions: Record<string, { requires?: string[] } | undefined> | undefined,
  agents: Record<string, { role?: string; authority?: string[]; capabilities?: string[] } | undefined> | undefined,
): GateIssue[] {
  const issues: GateIssue[] = [];
  for (const [gate, entry] of Object.entries(transitions ?? {})) {
    const artifactType = GATE_ARTIFACT_TYPES[gate];
    for (const token of entry?.requires ?? []) {
      const idx = token.lastIndexOf(".");
      if (idx <= 0) {
        issues.push({ gate, token, reason: `token '${token}' is not '<actor>.<kind>'; it can never match an approval` });
        continue;
      }
      const actor = token.slice(0, idx);
      const kind = token.slice(idx + 1);
      if (actor === HUMAN_AGENT_ID) continue;
      const matches = Object.entries(agents ?? {}).filter(([id, a]) => id === actor || a?.role === actor);
      if (matches.length === 0) {
        issues.push({ gate, token, reason: `no agent has id or role '${actor}'` });
        continue;
      }
      if (kind !== "approve" || !artifactType) continue;
      const reviews = matches.map(([, a]) => canReviewArtifactType(a ?? {}, artifactType));
      if (!reviews.some((r) => r.ok)) {
        const need = reviews[0];
        issues.push({
          gate,
          token,
          reason: `${matches.map(([id]) => id).join("/")} cannot review ${artifactType}: needs authority '${need.required}' or capability '${need.capability}'`,
        });
      }
    }
  }
  return issues;
}

function hasPeerReviewerFor(ctx: PolicyContext, actorId: string, artifact: Artifact): boolean {
  const cap = REVIEW_CAPABILITIES[artifact.type] ?? null;
  const subject = reviewSubject(artifact);
  for (const rec of ctx.projections.agents.values()) {
    const id = rec.definition.id;
    if (id === actorId || id === HUMAN_AGENT_ID) continue;
    if (rec.state.lifecycle === "COMPLETED" || rec.state.lifecycle === "FAILED") continue;
    const auth = rec.definition.authority;
    if (auth.includes(`${subject}.approve`) || auth.includes(`${subject}.*`) || auth.includes("*")) return true;
    if (cap && rec.definition.capabilities.includes(cap)) return true;
  }
  return false;
}
