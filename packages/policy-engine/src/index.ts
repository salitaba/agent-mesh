import type {
  Artifact,
  ArtifactStatus,
  MeshEvent,
  MeshMessage,
  PolicyDecisionResult,
} from "../../protocol/src/index";
import type { PolicyContext, PolicyEvaluator } from "../../core/src/ports";
import { checkApprovals, gateForTransition } from "../../core/src/projections";
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
    const has = def.authority.includes(required) || def.authority.includes(`${subject}.*`) || def.authority.includes("*");
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
      const reviewCap = REVIEW_CAPABILITIES[artifact.type] ?? null;
      const hasAuthority = def.authority.includes(`${reviewSubject(artifact)}.approve`) || def.authority.includes(`${reviewSubject(artifact)}.*`) || def.authority.includes("*");
      const hasCap = reviewCap !== null && def.capabilities.includes(reviewCap);
      if (!hasAuthority && !hasCap) {
        return { decision: "DENY", reason: `reviewing ${artifact.type} requires authority '${reviewSubject(artifact)}.approve' or capability '${reviewCap}'`, ruleId: "review-authority" };
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
    if (def.budget.maxActivations !== undefined && def.budget.maxActivations <= (ctx.projections.agents.get(agentId)?.state.activations ?? 0)) {
      return { decision: "DEFER", reason: `max_activations ${def.budget.maxActivations} reached`, ruleId: "max-activations" };
    }
    const goal = ctx.goal;
    if (goal && goal.status === "PAUSED") return { decision: "DEFER", reason: "goal paused", ruleId: "goal-paused" };
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

function isReplyViaParticipants(ctx: PolicyContext, message: Pick<MeshMessage, "threadId">, from: string, target: string): boolean {
  const thread = ctx.projections.threads.get(message.threadId);
  if (!thread) return false;
  return thread.participants.includes(from) && thread.participants.includes(target);
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

export function reviewSubject(artifact: Artifact): string {
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
