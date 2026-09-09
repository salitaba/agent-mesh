import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  validateMeshConfig,
  EVENT_TYPES,
  AUTHORITY_TOKENS,
  type AgentDefinition,
  type CommunicationPolicy,
  type DelegationPolicy,
  type MeshEvent,
  type EventType,
} from "../../protocol/src/index";

export interface RawMeshFile {
  version: number;
  mesh: {
    id: string;
    name?: string;
    goal: string;
    acceptance_criteria?: Array<{ id: string; description: string; mandatory?: boolean }>;
    workspace?: { path?: string };
    runtime?: { default?: string };
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
    thread?: { tokens?: number };
    task?: { tokens?: number };
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

export interface RawAgent {
  role: string;
  runtime?: string;
  model?: string;
  mode?: "peer" | "service";
  prompt?: string;
  capabilities?: string[];
  authority?: string[];
  interests?: string[];
  session?: { persistent?: boolean; max_context_tokens?: number };
  delegation?: { allow?: boolean; max_depth?: number; max_workers?: number; worker_budget_tokens?: number };
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
  meshId: string;
  meshName: string;
  goalText: string;
  goalCriteria: Array<{ id: string; description: string; mandatory: boolean }> | null;
  workspacePath: string;
  stateDir: string;
  defaultRuntime: string;
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
    taskTokens: number;
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

  const defaultRuntime = raw.mesh.runtime?.default ?? "opencode";
  const workspacePath = path.resolve(dir, raw.mesh.workspace?.path ?? "./workspace");
  const stateDir = path.resolve(dir, raw.server?.state_dir ?? path.join(raw.mesh.workspace?.path ?? "./workspace", ".mesh-state"));

  const agents: Record<string, AgentDefinition> = {};
  const communication: Record<string, CommunicationPolicy> = {};
  const perAgentBudget: Record<string, number> = {};

  for (const id of agentIds) {
    const a = raw.agents[id];
    const comm = raw.policies?.communication?.[id];
    const capPolicy = new Set([...(a.capabilities ?? [])]);
    const def: AgentDefinition = {
      id,
      role: a.role,
      mode: a.mode ?? "peer",
      runtime: a.runtime ?? defaultRuntime,
      model: a.model,
      prompt: { file: a.prompt },
      capabilities: [...capPolicy],
      authority: a.authority ?? [],
      communicationPolicy: {
        mayContact: comm?.may_contact ?? [],
        mayBeContactedBy: comm?.may_be_contacted_by ?? [],
      },
      interests: a.interests ?? [],
      sessionPolicy: {
        persistent: a.session?.persistent ?? true,
        maxContextTokens: a.session?.max_context_tokens,
      },
      delegationPolicy: {
        allowDelegation: a.delegation?.allow ?? false,
        maxDepth: a.delegation?.max_depth ?? 0,
        maxWorkers: a.delegation?.max_workers ?? 0,
        workerBudgetTokens: a.delegation?.worker_budget_tokens,
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
  // Gate-actor problems are reported, not fatal: a gate may legitimately name
  // a role that a larger mesh adds later, and some fixtures assert on a
  // deliberately unsatisfiable gate. Surfacing beats silently deadlocking.
  for (const w of validateTransitionGateActors(Object.values(agents), raw.policies?.transitions ?? {})) {
    configWarnings.push(w);
  }

  if (errors.length > 0) throw new ConfigError(dedupe(errors));

  return {
    filePath: path.join(dir, "mesh.yaml"),
    dir,
    raw,
    meshId: raw.mesh.id,
    meshName: raw.mesh.name ?? raw.mesh.id,
    goalText: raw.mesh.goal.trim(),
    goalCriteria: (raw.mesh.acceptance_criteria ?? null)?.map((c) => ({
      id: c.id,
      description: c.description,
      mandatory: c.mandatory ?? true,
    })) ?? null,
    workspacePath,
    stateDir,
    defaultRuntime,
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
      taskTokens: raw.budgets?.task?.tokens ?? 100000,
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
      turnSilenceMs: raw.scheduling?.timeouts?.turn_silence_ms ??
        Math.max(60000, Math.floor((raw.scheduling?.timeouts?.turn_timeout_ms ?? 600000) / 2)),
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
    if (fs.existsSync(abs)) return fs.readFileSync(abs, "utf8");
  }
  return `You are the ${config.agents[agentId]?.role ?? fallback?.role ?? agentId} agent in mesh '${config.meshId}'.`;
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

export function writeDefaultMeshYaml(targetDir: string, meshId: string, defaultRuntime: string = "opencode"): string {
  const target = path.join(targetDir, "mesh.yaml");
  if (fs.existsSync(target)) {
    throw new ConfigError([`${target} already exists`]);
  }
  fs.mkdirSync(targetDir, { recursive: true });
  const template = `version: 1

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
  const rolesDir = path.join(targetDir, "roles");
  fs.mkdirSync(rolesDir, { recursive: true });
  const architectRole = path.join(rolesDir, "architect.md");
  if (!fs.existsSync(architectRole)) {
    fs.writeFileSync(
      architectRole,
      `# Architect\n\nYou are the architect of mesh '${meshId}'.\n\n- Turn mission goals into approved architecture artifacts.\n- Publish ArchitectureDocument / ADR artifacts; never paste large documents into messages — reference artifacts.\n- Request review from the tech lead before implementation begins.\n- Consult the explorer for repository facts instead of guessing.\n- Respond to reviews with APPROVE/REJECT/PROPOSE via mesh tools only.\n`,
      "utf8",
    );
  }
  return target;
}
