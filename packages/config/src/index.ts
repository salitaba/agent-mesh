import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  validateMeshConfig,
  EVENT_TYPES,
  AUTHORITY_TOKENS,
  CAPABILITY_TOKENS,
  DEFAULT_HARD_CAPABILITIES,
  effectiveHardActions,
  HARD_OP_CAPABILITY,
  normalizeCapability,
  PROJECT_ID_PATTERN,
  isProjectId,
  toProjectId,
  type AgentDefinition,
  type CommunicationPolicy,
  type DelegationPolicy,
  type MeshEvent,
  type EventType,
} from "../../protocol/src/index";

export interface RawMeshFile {
  version: number;
  /**
   * Project identity for the multi-project host. Optional: omitted, the loader
   * derives an id from the folder name and warns. `mesh.id` names the mesh
   * (the mission); `project.id` names the workspace it lives in.
   */
  project?: {
    id: string;
    name?: string;
  };
  mesh: {
    id: string;
    name?: string;
    goal: string;
    acceptance_criteria?: Array<{ id: string; description: string; mandatory?: boolean }>;
    /**
     * Derive acceptance criteria from `goal` when none are declared. Off by
     * default: it puts a model call in the boot path, and a mesh that already
     * declares its criteria should not start behaving differently because the
     * feature exists.
     */
    generate_acceptance_criteria?: boolean;
    workspace?: { path?: string };
    runtime?: { default?: string; model?: string; variant?: string };
    defaults?: { session?: RawSessionPolicy; delegation?: RawDelegationPolicy; hard_actions?: RawHardActions };
  };
  startup?: { activate?: string[] };
  agents: Record<string, RawAgent>;
  policies?: {
    communication?: Record<string, { may_contact?: string[]; may_be_contacted_by?: string[] }>;
    transitions?: Record<string, { requires?: string[] }>;
    escalation?: {
      thread?: { max_depth?: number };
      repeated_conflict?: { threshold?: number };
      artifact_review_rounds?: { max?: number };
    };
    rules?: RawPolicyRule[];
  };
  budgets?: {
    mission?: { tokens?: number; wall_clock_minutes?: number; max_events?: number };
    agent?: Record<string, number>;
    thread?: {
      tokens?: number;
      /**
       * Ceiling (and cold-start value) for the per-turn pre-flight hold taken
       * against a thread ledger. The runtime sizes the actual hold from what
       * that agent's turns have really cost; this only bounds it.
       */
      reserve_tokens?: number;
      /**
       * 0..1 ratio of the thread limit past which a turn is DEGRADED (smaller
       * context) rather than blocked. Blocking is reserved for zero headroom.
       */
      soft_cap?: number;
    };
    task?: { tokens?: number };
    /**
     * Raising an exhausted agent/thread budget is a MECHANICAL decision, and
     * routing it through a human made the escalation channel useless: in one
     * live run 9 of 9 escalations were budget-begging, each answered with the
     * identical "raised budget to XX — continue". Under the ceiling the
     * runtime raises by itself; the human is only asked at the ceiling, where
     * the answer is genuinely a judgement call ("is this mission worth more").
     */
    auto_raise?: {
      /** false disables auto-raise entirely (every exhaustion escalates). */
      enabled?: boolean;
      /** each raise multiplies the CURRENT limit by this. */
      factor?: number;
      /** hard stop as a multiple of the ORIGINAL limit; at it, escalate. */
      max_multiple?: number;
    };
  };
  bus?: {
    commitments?: {
      /**
       * How an outstanding ask may leave the ledger.
       *
       * - "compat" (default): exact signals (`replyTo`, `discharge`,
       *   operator, verdicts, supersede) plus inference when a response
       *   merely looks like an answer (same thread, taskId, artifact refs).
       * - "strict": only exact signals. Inference is disabled entirely —
       *   a response without `replyTo` delivers content but discharges
       *   nothing. Use for missions where a falsely-closed ask costs more
       *   than a re-ask.
       */
      semantic?: "compat" | "strict";
    };
    /**
     * How agent turns may issue ops.
     *
     * - "mixed" (default): typed MCP tools when mounted, text `mesh-json`
     *   parsing as fallback for adapters without MCP.
     * - "typed-only": text parsing is off. Only ops issued through MCP
     *   tools (or the equivalent structured adapter payload) execute. A
     *   prose-only turn reports `unproductive` to the circuit breaker.
     */
    transport?: "mixed" | "typed-only";
  };
  scheduling?: {
    mode?: "event-driven";
    activation?: { strategy?: "interest" | "interest+triage"; max_activation_delay_ms?: number };
    triage?: {
      mode?: "off" | "heuristic";
      rules?: Array<{
        agent: string;
        event?: string;
        ignore_if_text_matches?: string[];
        act_if_text_matches?: string[];
      }>;
    };
    concurrency?: { max_active_agents?: number; max_parallel_service_agents?: number; max_total_agents?: number };
    timeouts?: {
      turn_timeout_ms?: number;
      wait_wakeup_ms?: number;
      lease_ttl_ms?: number;
      idle_quiet_period_ms?: number;
      /** Mission-quiet threshold before the stall watchdog nudges a driver. */
      stall_idle_ms?: number;
      /** Minimum gap between two stall-watchdog nudges. */
      stall_cooldown_ms?: number;
      /**
       * Retry bound after a turn that changed NOTHING (zero ops parsed, every
       * op rejected, or only wait/done/remember). Such a turn restarts the
       * stall clock for nothing, so a stalled mission otherwise waits the full
       * stall_idle + stall_cooldown between attempts. When the last turn was
       * provably unproductive the watchdog may fire again after this short
       * bound instead, rotating to the next eligible driver.
       */
      stall_noop_retry_ms?: number;
      /**
       * Post-stream freeze threshold: a turn that streamed tokens then went
       * silent this long is interrupted as wedged (defaults to half the turn
       * timeout, never below a minute).
       */
      turn_silence_ms?: number;
    };
  };
  server?: { host?: string; port?: number; state_dir?: string; dashboard?: boolean };
}

export interface RawSessionPolicy {
  persistent?: boolean;
  max_context_tokens?: number;
}

export interface RawDelegationPolicy {
  allow?: boolean;
  max_depth?: number;
  max_workers?: number;
  worker_budget_tokens?: number;
}

export interface RawHardActions {
  mode?: "off" | "warn" | "enforce";
  capabilities?: string[];
}

export interface RawAgent {
  role: string;
  runtime?: string;
  model?: string;
  /**
   * Provider-specific thinking variant (opencode: `low` | `high` | `max`).
   * Inert: that backend was removed, no registered runtime reads this, and the
   * mesh-wide `mesh.runtime.variant` never inherited onto it. Setting it is
   * surfaced as a config warning rather than silently ignored.
   */
  variant?: string;
  mode?: "peer" | "service";
  prompt?: string;
  capabilities?: string[];
  authority?: string[];
  interests?: string[];
  session?: RawSessionPolicy;
  delegation?: RawDelegationPolicy;
  hard_actions?: RawHardActions;
  budget?: { tokens?: number; wall_clock_minutes?: number; max_events?: number; max_activations?: number };
}

export interface RawPolicyRule {
  id: string;
  when: {
    event?: string;
    actor_role?: string;
    actor?: string;
    to?: string;
    message_type?: string;
    capability?: string;
  };
  requires?: {
    approvals?: Array<{ role?: string; agent?: string; kind?: string }>;
    evidence?: string[];
  };
  deny?: {
    capabilities?: string[];
    message_types?: string[];
    contact?: string[];
  };
  escalate?: boolean;
}

export interface ResolvedMeshConfig {
  filePath: string;
  dir: string;
  raw: RawMeshFile;
  /**
   * Stable workspace identity, used by the project registry and the state
   * lock. Declared as `project.id`, or derived from the config directory name
   * when absent (with a warning). Never empty.
   */
  projectId: string;
  projectName: string;
  /** True when `projectId` was derived rather than declared — the registry treats these as unpinned. */
  projectIdDerived: boolean;
  meshId: string;
  meshName: string;
  goalText: string;
  goalCriteria: Array<{ id: string; description: string; mandatory: boolean }> | null;
  /** Derive criteria from `goalText` when `goalCriteria` is null. */
  generateAcceptanceCriteria: boolean;
  workspacePath: string;
  stateDir: string;
  defaultRuntime: string;
  /** Mesh-wide model applied to agents that leave `model` blank. */
  defaultModel?: string;
  /**
   * Mesh-wide thinking variant, held for a runtime that reads it. Nothing does
   * today: it was the opencode knob, and it never inherited onto seats that
   * leave `variant` blank. Setting it is surfaced as a config warning.
   */
  defaultVariant?: string;
  startupActivate: string[];
  /**
   * Non-fatal configuration problems (currently: transition gates naming an
   * actor no agent can play). Surfaced by `mesh validate` so a mesh that will
   * silently deadlock at a gate says so before it is run.
   */
  warnings: string[];
  agents: Record<string, AgentDefinition>;
  agentOrder: string[];
  communication: Record<string, CommunicationPolicy>;
  transitionGates: Record<string, string[]>;
  escalation: {
    threadMaxDepth: number;
    repeatedConflictThreshold: number;
    artifactReviewRoundsMax: number;
  };
  policyRules: RawPolicyRule[];
  budgets: {
    mission: { tokens: number; wallClockMinutes: number; maxEvents: number };
    agentDefaults: { tokens: number };
    perAgent: Record<string, number>;
    threadTokens: number;
    /** Ceiling for the sized per-turn thread reservation. */
    threadReserveTokens: number;
    /** 0..1 ratio of the thread limit past which turns degrade instead of block. */
    threadSoftCap: number;
    taskTokens: number;
    autoRaise: { enabled: boolean; factor: number; maxMultiple: number };
  };
  bus: {
    /** How an outstanding ask may leave the ledger. See RawMeshFile.bus. */
    commitmentSemantic: "compat" | "strict";
    /** How agent turns may issue ops. See RawMeshFile.bus. */
    transport: "mixed" | "typed-only";
  };
  scheduling: {
    mode: "event-driven";
    strategy: "interest" | "interest+triage";
    maxActivationDelayMs: number;
    triageMode: "off" | "heuristic";
    triageRules: Array<{
      agent: string;
      event?: string;
      ignoreIfTextMatches: string[];
      actIfTextMatches: string[];
    }>;
    maxActiveAgents: number;
    maxParallelServiceAgents: number;
    /** Whole-team ceiling on simultaneous running turns (peers + services combined). */
    maxTotalAgents: number;
    turnTimeoutMs: number;
    waitWakeupMs: number;
    leaseTtlMs: number;
    idleQuietPeriodMs: number;
    /** Mission-quiet threshold before the stall watchdog nudges a driver. */
    stallIdleMs: number;
    /** Minimum gap between two stall-watchdog nudges. */
    stallCooldownMs: number;
    /** Retry bound after a turn that changed nothing (see raw `stall_noop_retry_ms`). */
    stallNoopRetryMs: number;
    /** Streamed-then-silent threshold before the watchdog interrupts a turn. */
    turnSilenceMs: number;
  };
  server: { host: string; port: number; dashboard: boolean };
}

export class ConfigError extends Error {
  constructor(public errors: string[]) {
    super(`Invalid mesh configuration:\n- ${errors.join("\n- ")}`);
    this.name = "ConfigError";
  }
}

export function loadMeshFile(filePath: string): RawMeshFile {
  const abs = path.resolve(filePath);
  const text = fs.readFileSync(abs, "utf8");
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (e) {
    throw new ConfigError([`YAML parse error in ${abs}: ${(e as Error).message}`]);
  }
  const result = validateMeshConfig(doc);
  if (!result.valid) {
    throw new ConfigError(result.errors.map((e) => `${e.path}: ${e.message}`));
  }
  return doc as RawMeshFile;
}

/** Parse a YAML/JSON string into a raw mesh document, running the JSON schema. */
export function parseMeshSource(text: string): RawMeshFile {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (e) {
    throw new ConfigError([`YAML parse error: ${(e as Error).message}`]);
  }
  const result = validateMeshConfig(doc);
  if (!result.valid) {
    throw new ConfigError(result.errors.map((e) => `${e.path}: ${e.message}`));
  }
  return doc as RawMeshFile;
}

/** Serialize a raw mesh document back to YAML text. */
export function stringifyMesh(raw: unknown): string {
  return stringifyYaml(raw, { lineWidth: 0 });
}

/**
 * Validate a raw mesh document against schema + cross-field rules without
 * requiring it on disk. Returns the resolved config or throws ConfigError.
 * `baseDir` is used to resolve workspace/state/prompt paths (defaults to cwd).
 */
export function analyzeMeshConfig(input: unknown, baseDir: string = process.cwd()): { raw: RawMeshFile; resolved: ResolvedMeshConfig } {
  const schema = validateMeshConfig(input);
  if (!schema.valid) {
    throw new ConfigError(schema.errors.map((e) => `${e.path}: ${e.message}`));
  }
  const raw = input as RawMeshFile;
  return { raw, resolved: buildResolved(raw, path.resolve(baseDir)) };
}

function buildResolved(raw: RawMeshFile, dir: string): ResolvedMeshConfig {
  const errors: string[] = [];
  const configWarnings: string[] = [];

  const agentIds = Object.keys(raw.agents);
  if (agentIds.length === 0) errors.push("at least one agent must be defined");

  // Migration path: a mesh.yaml written before `project.id` existed must still
  // boot. Derive from the folder name and warn — never a hard break. The
  // derived id is not stable across a rename, which is exactly what the
  // warning says.
  const projectIdDerived = !raw.project?.id;
  const projectId = raw.project?.id ?? toProjectId(path.basename(dir));
  if (projectIdDerived) {
    configWarnings.push(
      `mesh.yaml declares no project.id — using '${projectId}' derived from the folder name. ` +
        `Add 'project: { id: ${projectId} }' to pin it; a derived id changes if the folder is renamed.`,
    );
  } else if (!isProjectId(projectId)) {
    errors.push(`project.id '${projectId}' must match ${PROJECT_ID_PATTERN.source}`);
  }

  const defaultRuntime = raw.mesh.runtime?.default ?? "claude";
  // The opencode backend was removed. Caught here rather than at activation:
  // an unregistered runtime name otherwise resolves fine at boot and fails on
  // the first turn, long after the mesh looked healthy.
  const opencodeSeats = [
    ...(raw.mesh.runtime?.default === "opencode" ? ["mesh.runtime.default"] : []),
    ...agentIds.filter((id) => raw.agents[id].runtime === "opencode").map((id) => `agents.${id}.runtime`),
  ];
  if (opencodeSeats.length > 0) {
    errors.push(
      `runtime 'opencode' was removed; ${opencodeSeats.join(", ")} still names it. ` +
        "Set it to 'claude' (needs no separate install — it rides on the declared " +
        "@anthropic-ai/claude-agent-sdk dependency), or 'stub' to run with zero model calls.",
    );
  }
  // mesh-wide defaults an agent inherits when it leaves the key out. Resolved with
  // `??` everywhere below: an agent that explicitly sets `false` or `0` means it, and
  // must win over the mesh default — only an absent key inherits.
  const defSession = raw.mesh.defaults?.session;
  const defDelegation = raw.mesh.defaults?.delegation;
  const defHard = raw.mesh.defaults?.hard_actions;
  const defaultModel = raw.mesh.runtime?.model?.trim() || undefined;
  const defaultVariant = raw.mesh.runtime?.variant?.trim() || undefined;
  const workspacePath = path.resolve(dir, raw.mesh.workspace?.path ?? "./workspace");
  const stateDir = path.resolve(dir, raw.server?.state_dir ?? path.join(raw.mesh.workspace?.path ?? "./workspace", ".mesh-state"));

  const agents: Record<string, AgentDefinition> = {};
  const communication: Record<string, CommunicationPolicy> = {};
  const perAgentBudget: Record<string, number> = {};

  for (const id of agentIds) {
    const a = raw.agents[id];
    const comm = raw.policies?.communication?.[id];
    const capPolicy = new Set([...(a.capabilities ?? [])].map(normalizeCapability));
    const def: AgentDefinition = {
      id,
      role: a.role,
      mode: a.mode ?? "peer",
      runtime: a.runtime ?? defaultRuntime,
      model: a.model,
      variant: a.variant,
      prompt: { file: a.prompt },
      capabilities: [...capPolicy],
      authority: a.authority ?? [],
      communicationPolicy: {
        mayContact: comm?.may_contact ?? [],
        mayBeContactedBy: comm?.may_be_contacted_by ?? [],
      },
      interests: a.interests ?? [],
      sessionPolicy: {
        persistent: a.session?.persistent ?? defSession?.persistent ?? true,
        maxContextTokens: a.session?.max_context_tokens ?? defSession?.max_context_tokens,
      },
      delegationPolicy: {
        allowDelegation: a.delegation?.allow ?? defDelegation?.allow ?? false,
        maxDepth: a.delegation?.max_depth ?? defDelegation?.max_depth ?? 0,
        maxWorkers: a.delegation?.max_workers ?? defDelegation?.max_workers ?? 0,
        workerBudgetTokens: a.delegation?.worker_budget_tokens ?? defDelegation?.worker_budget_tokens,
      },
      hardActions: {
        mode: a.hard_actions?.mode ?? defHard?.mode ?? "off",
        capabilities: (a.hard_actions?.capabilities ?? defHard?.capabilities ?? DEFAULT_HARD_CAPABILITIES).map(
          normalizeCapability,
        ),
      },
      budget: {
        tokens: raw.budgets?.agent?.[id] ?? a.budget?.tokens ?? 200000,
        wallClockMinutes: a.budget?.wall_clock_minutes,
        maxEvents: a.budget?.max_events,
        maxActivations: a.budget?.max_activations,
      },
    };
    agents[id] = def;
    if (def.budget.tokens !== undefined) perAgentBudget[id] = def.budget.tokens;
    communication[id] = {
      mayContact: comm?.may_contact ?? [],
      mayBeContactedBy: comm?.may_be_contacted_by ?? [],
    };
  }

  const startupActivate = raw.startup?.activate ?? [];
  for (const id of startupActivate) {
    if (!agents[id]) errors.push(`startup.activate references unknown agent '${id}'`);
  }
  for (const [id, pol] of Object.entries(communication)) {
    for (const target of pol.mayContact) {
      if (!agents[target]) errors.push(`policies.communication.${id}.may_contact references unknown agent '${target}'`);
    }
    for (const source of pol.mayBeContactedBy) {
      if (!agents[source]) errors.push(`policies.communication.${id}.may_be_contacted_by references unknown agent '${source}'`);
    }
  }
  for (const id of Object.keys(raw.budgets?.agent ?? {})) {
    if (!agents[id]) errors.push(`budgets.agent references unknown agent '${id}'`);
  }
  for (const id of Object.keys(communication)) {
    if (!agents[id]) errors.push(`policies.communication references unknown agent '${id}'`);
  }
  for (const rule of raw.policies?.rules ?? []) {
    if (rule.when.actor && !agents[rule.when.actor]) {
      errors.push(`policy rule '${rule.id}' references unknown actor '${rule.when.actor}'`);
    }
  }

  const interestErrors = validateInterestExpressions(Object.values(agents));
  errors.push(...interestErrors);
  errors.push(...validateAuthorityTokens(Object.values(agents)));
  errors.push(...validateCapabilityTokens(Object.values(agents)));
  // Gate-actor problems are reported, not fatal: a gate may legitimately name
  // a role that a larger mesh adds later, and some fixtures assert on a
  // deliberately unsatisfiable gate. Surfacing beats silently deadlocking.
  for (const w of validateTransitionGateActors(Object.values(agents), raw.policies?.transitions ?? {})) {
    configWarnings.push(w);
  }
  for (const w of warnUnenforceableHardActions(Object.values(agents))) {
    configWarnings.push(w);
  }
  for (const w of warnUncoveredCapabilities(Object.values(agents))) {
    configWarnings.push(w);
  }
  for (const w of warnUnmergeableGates(Object.values(agents), raw.policies?.transitions ?? {})) {
    configWarnings.push(w);
  }
  for (const w of warnNoStartupActivation(Object.values(agents), startupActivate)) {
    configWarnings.push(w);
  }
  for (const w of warnUnreachableAgents(Object.values(agents))) {
    configWarnings.push(w);
  }
  for (const w of warnInertVariant(Object.values(agents), defaultVariant)) {
    configWarnings.push(w);
  }

  if (errors.length > 0) throw new ConfigError(dedupe(errors));

  return {
    filePath: path.join(dir, "mesh.yaml"),
    dir,
    raw,
    projectId,
    projectName: raw.project?.name ?? raw.mesh.name ?? projectId,
    projectIdDerived,
    meshId: raw.mesh.id,
    meshName: raw.mesh.name ?? raw.mesh.id,
    goalText: raw.mesh.goal.trim(),
    goalCriteria: (raw.mesh.acceptance_criteria ?? null)?.map((c) => ({
      id: c.id,
      description: c.description,
      mandatory: c.mandatory ?? true,
    })) ?? null,
    generateAcceptanceCriteria: raw.mesh.generate_acceptance_criteria ?? false,
    workspacePath,
    stateDir,
    defaultRuntime,
    defaultModel,
    defaultVariant,
    startupActivate,
    warnings: configWarnings,
    agents,
    agentOrder: agentIds,
    communication,
    transitionGates: mapValues(raw.policies?.transitions ?? {}, (t) => t.requires ?? []),
    escalation: {
      threadMaxDepth: raw.policies?.escalation?.thread?.max_depth ?? 8,
      repeatedConflictThreshold: raw.policies?.escalation?.repeated_conflict?.threshold ?? 3,
      artifactReviewRoundsMax: raw.policies?.escalation?.artifact_review_rounds?.max ?? 5,
    },
    policyRules: raw.policies?.rules ?? [],
    bus: {
      commitmentSemantic: raw.bus?.commitments?.semantic ?? "compat",
      transport: raw.bus?.transport ?? "mixed",
    },
    budgets: {
      mission: {
        tokens: raw.budgets?.mission?.tokens ?? 2000000,
        wallClockMinutes: raw.budgets?.mission?.wall_clock_minutes ?? 240,
        maxEvents: raw.budgets?.mission?.max_events ?? 10000,
      },
      agentDefaults: { tokens: 200000 },
      perAgent: perAgentBudget,
      threadTokens: raw.budgets?.thread?.tokens ?? 50000,
      threadReserveTokens: Math.max(1, raw.budgets?.thread?.reserve_tokens ?? 32000),
      threadSoftCap: Math.min(1, Math.max(0, raw.budgets?.thread?.soft_cap ?? 0.75)),
      taskTokens: raw.budgets?.task?.tokens ?? 100000,
      autoRaise: {
        enabled: raw.budgets?.auto_raise?.enabled ?? true,
        factor: Math.max(1.1, raw.budgets?.auto_raise?.factor ?? 2),
        maxMultiple: Math.max(1, raw.budgets?.auto_raise?.max_multiple ?? 8),
      },
    },
    scheduling: {
      mode: "event-driven",
      strategy: raw.scheduling?.activation?.strategy ?? "interest",
      maxActivationDelayMs: raw.scheduling?.activation?.max_activation_delay_ms ?? 0,
      triageMode: raw.scheduling?.triage?.mode ?? "off",
      triageRules: (raw.scheduling?.triage?.rules ?? []).map((r) => ({
        agent: r.agent,
        event: r.event,
        ignoreIfTextMatches: r.ignore_if_text_matches ?? [],
        actIfTextMatches: r.act_if_text_matches ?? [],
      })),
      maxActiveAgents: raw.scheduling?.concurrency?.max_active_agents ?? 4,
      maxParallelServiceAgents: raw.scheduling?.concurrency?.max_parallel_service_agents ?? 2,
      // Default preserves the old behavior exactly: peers + services at once.
      maxTotalAgents: raw.scheduling?.concurrency?.max_total_agents ??
        ((raw.scheduling?.concurrency?.max_active_agents ?? 4) + (raw.scheduling?.concurrency?.max_parallel_service_agents ?? 2)),
      turnTimeoutMs: raw.scheduling?.timeouts?.turn_timeout_ms ?? 600000,
      waitWakeupMs: raw.scheduling?.timeouts?.wait_wakeup_ms ?? 60000,
      leaseTtlMs: raw.scheduling?.timeouts?.lease_ttl_ms ?? 1800000,
      idleQuietPeriodMs: raw.scheduling?.timeouts?.idle_quiet_period_ms ?? 30000,
      stallIdleMs: raw.scheduling?.timeouts?.stall_idle_ms ?? 180000,
      stallCooldownMs: raw.scheduling?.timeouts?.stall_cooldown_ms ?? 300000,
      stallNoopRetryMs: raw.scheduling?.timeouts?.stall_noop_retry_ms ?? 45000,
      // Post-first-token silence means a frozen stream, not slow thinking, so
      // the default is capped at two minutes and decays with short turn
      // timeouts. Half-the-timeout alone tied the old 600s adapter cap, and a
      // 1200s turn timeout pushed detection to 10 minutes — by then the stall
      // had become a human escalation. Overridable per mesh via
      // turn_silence_ms.
      turnSilenceMs: raw.scheduling?.timeouts?.turn_silence_ms ??
        Math.min(120000, Math.max(60000, Math.floor((raw.scheduling?.timeouts?.turn_timeout_ms ?? 600000) / 2))),
    },
    server: {
      host: raw.server?.host ?? "127.0.0.1",
      port: raw.server?.port ?? 7420,
      dashboard: raw.server?.dashboard ?? true,
    },
  };
}

/** Resolve a mesh config from disk: schema + cross-field + prompt-file existence. */
export function resolveConfig(filePath: string): ResolvedMeshConfig {
  const abs = path.resolve(filePath);
  const dir = path.dirname(abs);
  const raw = loadMeshFile(abs);
  const promptErrors: string[] = [];
  for (const id of Object.keys(raw.agents)) {
    const p = raw.agents[id].prompt;
    if (p && !fs.existsSync(path.resolve(dir, p))) {
      promptErrors.push(`agent '${id}' prompt file not found: ${p}`);
    }
  }
  if (promptErrors.length > 0) throw new ConfigError(promptErrors);
  const config = buildResolved(raw, dir);
  return { ...config, filePath: abs };
}

export function loadRolePrompt(config: ResolvedMeshConfig, agentId: string, fallback?: AgentDefinition): string {
  const ref = config.agents[agentId]?.prompt ?? fallback?.prompt;
  if (ref?.text) return ref.text;
  if (ref?.file) {
    const abs = path.isAbsolute(ref.file) ? ref.file : path.resolve(config.dir, ref.file);
    // A seat that CONFIGURED a prompt and cannot get it is a broken invariant,
    // not a default: falling through here handed the agent a one-line
    // synthesized role and let it run on, answering competently without
    // knowing who it was. Nothing in the output distinguishes that from a
    // working seat, so it has to be loud.
    if (!fs.existsSync(abs)) {
      throw new ConfigError([`agent '${agentId}' prompt file not found: ${ref.file}`]);
    }
    return fs.readFileSync(abs, "utf8");
  }
  // No prompt configured at all is a different case and stays a default: the
  // hardcoded seats rely on it.
  return `You are the ${config.agents[agentId]?.role ?? fallback?.role ?? agentId} agent in mesh '${config.meshId}'.`;
}

export interface RolePromptRef {
  mesh: { id: string };
  agents: Record<string, { role: string; prompt?: string }>;
}

export interface MaterializedRolePrompt {
  agent: string;
  file: string;
  source: "role" | "generated";
}

function defaultRolePrompt(role: string, meshId: string): string {
  if (role === "architect") {
    return `# Architect\n\nYou are the architect of mesh '${meshId}'.\n\n- Turn mission goals into approved architecture artifacts.\n- Publish ArchitectureDocument / ADR artifacts; never paste large documents into messages — reference artifacts.\n- Request review from the tech lead before implementation begins.\n- Consult the explorer for repository facts instead of guessing.\n- Respond to reviews with APPROVE/REJECT/PROPOSE via mesh tools only.\n`;
  }
  const title = role.charAt(0).toUpperCase() + role.slice(1);
  return `# ${title}\n\nYou are the ${role} agent in mesh '${meshId}'.\n\n- Work from the mission goal and approved architecture artifacts; never paste large documents into messages — reference artifacts.\n- Respond to reviews with APPROVE/REJECT/PROPOSE via mesh tools only.\n`;
}

/**
 * Make a config's prompt refs real. `resolveConfig` deliberately refuses a
 * config whose agent prompt file is missing, but the designer happily writes
 * `prompt: ./roles/<id>.md` refs that point nowhere — the saved project then
 * opens as `invalid_config`. Called at the write boundary (scaffold + save):
 * for every relative prompt ref that has no file yet, copy the repo's
 * `roles/<agent.role>.md` when one exists, else generate a stub header. Never
 * overwrites an existing file, and never writes outside `targetDir`.
 */
export function materializeRolePrompts(
  source: RolePromptRef,
  targetDir: string,
  opts: { rolesDir?: string } = {},
): MaterializedRolePrompt[] {
  const root = path.resolve(targetDir);
  const rolesDir = opts.rolesDir ?? path.resolve(__dirname, "..", "..", "..", "..", "roles");
  const created: MaterializedRolePrompt[] = [];
  for (const [id, agent] of Object.entries(source.agents)) {
    const ref = agent.prompt;
    if (!ref || path.isAbsolute(ref)) continue;
    const dest = path.resolve(root, ref);
    const rel = path.relative(root, dest);
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
    if (fs.existsSync(dest)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const roleFile = path.join(rolesDir, `${agent.role}.md`);
    let kind: MaterializedRolePrompt["source"] = "generated";
    if (fs.existsSync(roleFile)) {
      fs.copyFileSync(roleFile, dest);
      kind = "role";
    } else {
      fs.writeFileSync(dest, defaultRolePrompt(agent.role, source.mesh.id), "utf8");
    }
    created.push({ agent: id, file: dest, source: kind });
  }
  return created;
}

const INTEREST_PATTERN = /^[a-z_]+(\.[a-z_*]+)+$/;

export function validateInterestExpressions(agents: AgentDefinition[]): string[] {
  const errors: string[] = [];
  for (const agent of agents) {
    for (const pattern of agent.interests) {
      if (!INTEREST_PATTERN.test(pattern)) {
        errors.push(`agent '${agent.id}' has invalid interest expression '${pattern}' (expected lower.dot.patterns like architecture.*)`);
        continue;
      }
      const base = pattern.split(".")[0];
      if (base === "goal" || base === "budget") continue;
      const isWildcard = pattern.endsWith(".*");
      const isCanonical = EVENT_TYPES.includes(pattern as EventType);
      if (!isWildcard && !isCanonical) {
        errors.push(`agent '${agent.id}' interest '${pattern}' is not a canonical event type (see schemas/event.schema.json)`);
      }
    }
  }
  return errors;
}

/**
 * Authority tokens must be ones the runtime can actually satisfy.
 *
 * A typo (`architecture.aprove`) or an invented domain (`design.approve`)
 * used to load, validate and boot cleanly — then DENY on every check, because
 * `evaluateAuthority` looks for an exact string. The agent silently never had
 * the power its config claimed to grant, and the only visible symptom was a
 * mission that would not converge. Fail at load instead.
 */
export function validateAuthorityTokens(agents: AgentDefinition[]): string[] {
  const errors: string[] = [];
  const known = new Set(AUTHORITY_TOKENS);
  for (const agent of agents) {
    for (const token of agent.authority) {
      if (!known.has(token)) {
        errors.push(
          `agent '${agent.id}' declares unknown authority '${token}' — the runtime can never satisfy it (known: ${AUTHORITY_TOKENS.join(", ")})`,
        );
      }
    }
  }
  return errors;
}

/**
 * Capability tokens must be ones the policy engine can actually match.
 *
 * Mirrors validateAuthorityTokens: an invented name used to load and boot,
 * then silently grant nothing (no edit/bash tools, every capability check
 * DENY). Aliases are normalized before this runs, so the error only names
 * genuinely unknown tokens.
 */
export function validateCapabilityTokens(agents: AgentDefinition[]): string[] {
  const errors: string[] = [];
  const known = new Set(CAPABILITY_TOKENS);
  for (const agent of agents) {
    for (const token of agent.capabilities) {
      if (!known.has(token)) {
        errors.push(
          `agent '${agent.id}' declares unknown capability '${token}' — the policy engine can never match it (known: ${CAPABILITY_TOKENS.join(", ")})`,
        );
      }
    }
    // Same failure mode, one layer over: a typo here loads and boots, and the
    // plan gate then silently never fires for the capability the operator
    // meant to protect.
    for (const token of effectiveHardActions(agent.hardActions).capabilities) {
      if (!known.has(token)) {
        errors.push(
          `agent '${agent.id}' declares unknown hard_actions capability '${token}' — the plan gate can never match it (known: ${CAPABILITY_TOKENS.join(", ")})`,
        );
      }
    }
  }
  return errors;
}

/**
 * Hard-action tokens the op layer cannot see.
 *
 * `shell.execute` and `network.request` are real capabilities, but they are
 * spent through the coding agent's own tools rather than a MeshOp, so no
 * `HARD_OP_CAPABILITY` entry exists and the gate can never fire for them. An
 * operator who lists only those gets a policy that enforces nothing — a
 * warning, not an error, because the tokens are legitimate elsewhere.
 */
export function warnUnenforceableHardActions(agents: AgentDefinition[]): string[] {
  const warnings: string[] = [];
  const enforceable = new Set(Object.values(HARD_OP_CAPABILITY));
  for (const agent of agents) {
    const hard = effectiveHardActions(agent.hardActions);
    if (hard.mode === "off") continue;
    const blind = hard.capabilities.filter((c) => !enforceable.has(c));
    if (blind.length === hard.capabilities.length) {
      warnings.push(
        `agent '${agent.id}' has hard_actions.mode '${hard.mode}' but none of its capabilities (${blind.join(", ")}) map to a mesh op — the plan gate will never fire (enforceable: ${[...enforceable].join(", ")})`,
      );
    } else if (blind.length > 0) {
      warnings.push(
        `agent '${agent.id}' lists hard_actions capabilities the plan gate cannot see: ${blind.join(", ")} — they are used by the runtime's own tools, not a mesh op`,
      );
    }
  }
  return warnings;
}

/**
 * A mesh that can write, but can never land.
 *
 * `validateCapabilityTokens` proves every declared token EXISTS; nothing
 * proves the capabilities the mission will REQUIRE are held by anyone. A mesh
 * whose seats can produce work but where no seat holds `git.commit` loads
 * clean, boots clean, and then deadlocks the first time a binding commit gate
 * is reached: the gate is unsatisfiable, and no amount of waiting fixes it.
 * Same failure class as an unknown token — validates fine, stalls at runtime —
 * one layer up.
 *
 * Deliberately narrow. It fires only once some seat can write, so a mesh that
 * is read-only on purpose (review, audit, research) stays silent, and it asks
 * a question with one defensible answer: who lands the work this mesh is
 * about to produce? A warning rather than an error, because the commit may
 * legitimately happen outside the mesh, and erroring would refuse meshes that
 * boot and finish today.
 */
export function warnUncoveredCapabilities(agents: AgentDefinition[]): string[] {
  const writers = agents.filter((a) => a.capabilities.includes("repository.write"));
  if (writers.length === 0) return [];
  if (agents.some((a) => a.capabilities.includes("git.commit"))) return [];
  const who = writers.map((a) => `'${a.id}'`).join(", ");
  return [
    `no agent holds 'git.commit', but ${writers.length === 1 ? "agent" : "agents"} ${who} can write the repository — this mesh can produce work it can never land, and will deadlock at the first binding commit gate`,
  ];
}

/**
 * A mesh that gates a merge no one can perform.
 *
 * `warnUncoveredCapabilities` asks who lands the work; this asks who merges
 * it. A `*.merge` transition gate is the config stating outright that this
 * mesh merges patches, and the artifact state machine demands capability
 * `git.merge` for any transition to MERGED. With no holder, every approval
 * the gate names can be collected and the merge is still refused forever.
 *
 * Fires only when a merge gate is declared, so a mesh that never merges stays
 * silent. A warning rather than an error for the same reason as the commit
 * check: the merge may legitimately happen outside the mesh.
 */
export function warnUnmergeableGates(
  agents: AgentDefinition[],
  transitions: Record<string, { requires?: string[] }>,
): string[] {
  const gates = Object.keys(transitions).filter((g) => g.endsWith(".merge"));
  if (gates.length === 0) return [];
  if (agents.some((a) => a.capabilities.includes("git.merge"))) return [];
  const names = gates.map((g) => `'${g}'`).join(", ");
  return [
    `no agent holds 'git.merge', but ${names} ${gates.length === 1 ? "is a merge gate" : "are merge gates"} — every approval it names can be collected and the transition to MERGED will still be refused`,
  ];
}

/**
 * A mesh where nobody boots.
 *
 * `startup.activate` is the only list a fresh boot reads: the supervisor
 * activates `recoveryCandidates()` on resume and `config.startupActivate`
 * otherwise. Empty, and going live registers every seat and wakes none.
 *
 * Deliberately not an error, and deliberately not phrased as a deadlock: the
 * stall watchdog does eventually nudge an arbitrary live agent, so the
 * mission recovers. What it cannot recover is intent — the first seat to move
 * is a watchdog's guess rather than the lead the operator meant to start.
 */
export function warnNoStartupActivation(agents: AgentDefinition[], startupActivate: string[]): string[] {
  if (agents.length === 0 || startupActivate.length > 0) return [];
  return [
    "startup.activate is empty — going live registers every agent and activates none, so the mesh opens idle until the stall watchdog nudges an arbitrary seat. Name the agent that should start.",
  ];
}

/**
 * An agent wired to nobody.
 *
 * Promoted out of the designer's advisor list so a CLI or server boot sees it
 * too. A seat with no communication edge in either direction can neither ask
 * for help nor be asked for any; it can only ever act alone on whatever it
 * was activated with.
 *
 * Connectivity is read generously — either direction, either side of the
 * policy — so a mesh that declares only `may_be_contacted_by` is not accused
 * of isolating a seat it wired perfectly well.
 */
export function warnUnreachableAgents(agents: AgentDefinition[]): string[] {
  if (agents.length < 2) return [];
  const warnings: string[] = [];
  for (const agent of agents) {
    const own = agent.communicationPolicy;
    const wired =
      own.mayContact.some((t) => t !== agent.id) ||
      own.mayBeContactedBy.some((t) => t !== agent.id) ||
      agents.some(
        (o) =>
          o.id !== agent.id &&
          (o.communicationPolicy.mayContact.includes(agent.id) ||
            o.communicationPolicy.mayBeContactedBy.includes(agent.id)),
      );
    if (!wired) {
      warnings.push(
        `agent '${agent.id}' is wired to nobody — no agent may contact it and it may contact no one, so it can never ask for help or be asked for any`,
      );
    }
  }
  return warnings;
}

/**
 * A knob no surviving runtime reads.
 *
 * `variant` was the opencode runtime's thinking knob (`low` | `high` | `max`).
 * That backend was removed and nothing took the field over, so no registered
 * runtime reads it. The mesh-wide key does not inherit either: a seat that
 * leaves `variant` blank gains nothing from `mesh.runtime.variant`, which is
 * stored and ignored, while `mesh.runtime.model` genuinely does inherit onto
 * seats. So a mesh.yaml setting either one is asking for something nothing
 * will do.
 *
 * Reported rather than removed. The key is schema'd at both levels and sits on
 * `AgentDefinition`, which is persisted in `agent.registered` events, so
 * deleting it would be a protocol change for no runtime benefit. A warning
 * rather than an error because it is inert, not broken.
 */
export function warnInertVariant(agents: AgentDefinition[], defaultVariant: string | undefined): string[] {
  const paths = [
    ...(defaultVariant ? ["mesh.runtime.variant"] : []),
    ...agents
      .filter((a) => typeof a.variant === "string" && a.variant.trim().length > 0)
      .map((a) => `agents.${a.id}.variant`),
  ];
  if (paths.length === 0) return [];
  return [
    `${paths.join(", ")} ${paths.length === 1 ? "is" : "are"} set but inert — 'variant' was the opencode runtime's thinking knob, that backend was removed, and no registered runtime reads the field. Remove the key, or leave it for a runtime that consumes it`,
  ];
}

/**
 * A transition gate names the approvals a state change requires, as
 * `<actorRole|actorId>.<kind>` (e.g. `tech-lead.approve`, `qa.pass`). If no
 * configured agent can ever produce one of those approvals, the gate is
 * unsatisfiable and every artifact that needs it deadlocks — the mission
 * stalls with no error anywhere. Catch it at load.
 */
export function validateTransitionGateActors(
  agents: AgentDefinition[],
  transitions: Record<string, { requires?: string[] }>,
): string[] {
  const errors: string[] = [];
  const actors = new Set<string>();
  for (const a of agents) {
    actors.add(a.id);
    actors.add(a.role);
  }
  for (const [gate, spec] of Object.entries(transitions)) {
    for (const requirement of spec.requires ?? []) {
      const actor = requirement.slice(0, requirement.lastIndexOf("."));
      if (!actor) {
        errors.push(`transition gate '${gate}' requirement '${requirement}' must be '<agent-or-role>.<kind>'`);
        continue;
      }
      if (!actors.has(actor)) {
        errors.push(
          `transition gate '${gate}' requires '${requirement}', but no agent or role '${actor}' exists — the gate can never be satisfied`,
        );
      }
    }
  }
  return errors;
}

export function interestMatches(pattern: string, eventType: EventType | string): boolean {
  const p = pattern.split(".");
  const e = eventType.split(".");
  if (p.length > e.length) return false;
  for (let i = 0; i < p.length; i++) {
    if (p[i] === "*") {
      if (i === p.length - 1) {
        const prefix = p.slice(0, i).join(".");
        return eventType.startsWith(`${prefix}.`);
      }
      continue;
    }
    if (p[i] !== e[i]) return false;
  }
  return p.length === e.length;
}

function mapValues<T, U>(obj: Record<string, T>, fn: (v: T) => U): Record<string, U> {
  const out: Record<string, U> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = fn(v);
  return out;
}

function dedupe(list: string[]): string[] {
  return [...new Set(list)];
}

export function defaultEventEnvelopeBase(goalId: string): Pick<MeshEvent, "goalId" | "protocolVersion"> {
  return { goalId, protocolVersion: "1.0" };
}

export function writeDefaultMeshYaml(
  targetDir: string,
  meshId: string,
  defaultRuntime: string = "claude",
  opts: { projectId?: string } = {},
): string {
  const target = path.join(targetDir, "mesh.yaml");
  if (fs.existsSync(target)) {
    throw new ConfigError([`${target} already exists`]);
  }
  fs.mkdirSync(targetDir, { recursive: true });
  // Slugged, not the raw name: `meshId` comes from a directory name, which may
  // hold spaces, capitals or dots that the schema pattern rejects.
  const projectId = opts.projectId ?? toProjectId(meshId);
  if (!isProjectId(projectId)) {
    throw new ConfigError([`project id '${projectId}' must match ${PROJECT_ID_PATTERN.source}`]);
  }
  const template = `version: 1

project:
  id: ${projectId}
  name: ${meshId}

mesh:
  id: ${meshId}
  name: ${meshId}
  goal: |
    Describe the mission goal here.
  workspace:
    path: ./workspace
  runtime:
    default: ${defaultRuntime}

startup:
  activate:
    - architect

agents:
  architect:
    role: architect
    runtime: ${defaultRuntime}
    prompt: ./roles/architect.md
    capabilities:
      - repository.read
      - architecture.write
      - review.design
    authority:
      - architecture.approve
    interests:
      - architecture.*
      - design.question
      - goal.escalated
    session:
      persistent: true

policies:
  communication: {}
  escalation:
    thread:
      max_depth: 8
    repeated_conflict:
      threshold: 3
    artifact_review_rounds:
      max: 5

budgets:
  mission:
    tokens: 2000000
    wall_clock_minutes: 240
    max_events: 10000

scheduling:
  mode: event-driven
  activation:
    strategy: interest
  concurrency:
    max_active_agents: 4
`;
  fs.writeFileSync(target, template, "utf8");
  materializeRolePrompts(parseMeshSource(template), targetDir);
  return target;
}
