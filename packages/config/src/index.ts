import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  validateMeshConfig,
  EVENT_TYPES,
  AUTHORITY_TOKENS,
  CAPABILITY_TOKENS,
  MESSAGE_TYPES,
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
  type GitMode,
} from "../../protocol/src/index";

/**
 * Model that derives acceptance criteria when `mesh.criteria_model` is unset.
 *
 * Deliberately the cheapest current model rather than the designer runtime's
 * default. Criteria generation is a session-less one-shot — a fixed system
 * prompt plus the goal text, no conversation and no tools — so it is the one
 * model call in the mesh that gains nothing from a larger model's context or
 * from prompt-cache reuse, and it runs once per mission boot.
 *
 * Written bare and undated, which is what the Claude Code SDK expects and what
 * `toClaudeModelId` passes through untouched; that helper only strips a leading
 * provider segment, so it will forward a misspelled id just as happily as a
 * real one. Keep this in the same form as the other ids in the repo
 * ("claude-opus-5", "claude-sonnet-5") — a dated suffix is an older convention.
 */
export const DEFAULT_CRITERIA_MODEL = "claude-haiku-4-5";

/**
 * The single place a project's artifact-storage mode is decided.
 *
 * Precedence is CLI flag > `mesh.workspace.git` > ON. The default being ON is
 * the point: without a git workspace `deps.workspace` is undefined and every
 * `mesh_commit` is refused, so a mission can never evidence a criterion that
 * requires landed code. A mode that silently can't commit is not a supported
 * configuration, it is a broken one, so it is now opt-in rather than default.
 *
 * `meshKey` is deliberately `boolean | undefined` rather than defaulted at the
 * call site: absent means "no opinion", and only this function may collapse
 * that into a boolean. Callers must not pre-default it to `false`.
 */
export function resolveUseGit(override: GitMode | undefined, meshKey: boolean | undefined): boolean {
  if (override === "on") return true;
  if (override === "off") return false;
  return meshKey ?? true;
}

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
    /**
     * Model for criteria generation only. Defaults to `DEFAULT_CRITERIA_MODEL`
     * rather than the designer runtime's model: this is a one-shot with a fixed
     * system prompt and no conversation, so a small model costs a fraction and
     * forfeits no prompt-cache reuse. Unrelated to `runtime.model`, which is the
     * agents' default and must stay on a model that can hold a mission.
     */
    criteria_model?: string;
    /**
     * `git` selects the artifact-storage mode for this project. It is
     * deliberately tri-state at this layer: the key being ABSENT is not the
     * same as it being `false`. Absent means "no opinion", and the default
     * applied at boot is ON (see `resolveUseGit`). Present-and-false is an
     * explicit opt-out, and nothing may override it except the CLI flag.
     */
    workspace?: { path?: string; git?: boolean };
    runtime?: { default?: string; model?: string; variant?: string; requires_approval?: string[] };
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
       * - "strict" (default): only exact signals — `replyTo`, the `discharge`
       *   op, an operator answer, a review verdict, a superseding artifact
       *   version, and the worker-result contract (a HANDOFF carrying the
       *   taskId its REQUEST_EXECUTION minted). A response without one of
       *   those delivers its content and discharges nothing.
       * - "compat": the above plus inference, where a response that merely
       *   LOOKS like an answer (same thread, artifact refs) closes the ask.
       *
       * The default is strict because the two failure modes are not
       * symmetric. Inference that fires wrongly closes an ask nobody
       * answered, and does it silently: the asker's loop is marked done, the
       * nudge machinery stops, and no event records that a guess was made.
       * Inference that fails to fire leaves the ask open, which is visible —
       * the asker is nudged, the ledger shows the debt, and (with a TTL set)
       * it expires with a reason. A missing discharge costs a re-ask; a
       * wrong one costs work that was never done and nobody noticed.
       *
       * Set "compat" for a mesh whose agents cannot be relied on to set
       * `replyTo` and which would rather over-close than stall.
       */
      semantic?: "compat" | "strict";
      /**
       * How long an ask may go unanswered before the runtime closes it with
       * `expired`, in milliseconds. Omitted or `0` means no deadline, which
       * is how every mesh behaved before this key existed.
       *
       * The deadline is the debtor's, not the asker's: an ask to several
       * agents gets the LONGEST of their roles' TTLs, so a slow role is never
       * cut off because a fast one was also addressed.
       */
      ttl_ms?: number;
      /**
       * Per-role overrides of `ttl_ms`, keyed by the DEBTOR's role. A security
       * review and a one-line fact lookup are not the same kind of wait, and
       * a single global deadline has to be set for the slowest of them — at
       * which point it stops bounding the fast ones at all.
       */
      ttl_ms_by_role?: Record<string, number>;
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
    /**
     * Which comms vocabulary a seat's MCP manifest advertises.
     *
     * - absent, or "typed" (the default): the manifest every mesh has had.
     *   `mesh_send`, `mesh_broadcast` and `mesh_respond` each carry the full
     *   24-name `MessageType` enum, and a seat picks a speech act out of it.
     * - "contracts": the comms manifest collapses to the named asks.
     *   `mesh_contracts` lists what can be asked for, `mesh_call` raises one,
     *   `mesh_reply` answers one, `mesh_discharge` refuses one,
     *   `mesh_announce` says something that obliges nobody, and
     *   `mesh_collab`/`mesh_collab_close` bound a discussion. None of the
     *   seven names a message type, so there is no vocabulary to memorise and
     *   nothing to invent.
     *
     * The type-carrying tools are dropped from the ADVERTISED list only. They
     * stay callable — `callTool` resolves against the unfiltered map — so
     * collapsing the vocabulary can never take a capability away from a seat,
     * and a model that reaches for `mesh_send` still gets it.
     *
     * Deliberately independent of `transport`, although an operator will
     * usually set both. `transport` decides HOW an op may arrive (a typed
     * tool call, or ops parsed out of prose); this decides WHAT the typed
     * surface offers. A mesh can collapse the vocabulary while still
     * accepting prose, and a `typed-only` mesh can keep the full manifest —
     * which is exactly what every mesh written before this key existed does.
     */
    vocabulary?: "typed" | "contracts";
    /**
     * Bounds every collaboration opens with. See CollabSession.
     *
     * Unlike `commitments`, this has real defaults rather than an absent
     * regime: a collab is opened by an explicit op that did not exist before,
     * so no mesh inherits new behaviour from an upgrade, and "time-boxed at
     * open" is not optional -- an unbounded one is the thing this mode was
     * built to stop.
     */
    collab?: {
      /** Wall-clock box, ms. */
      box_ms?: number;
      /** Messages in the thread before the box is spent. */
      max_exchanges?: number;
    };
    /**
     * Whether a delivered message is allowed to spend the recipient's turn,
     * and what that costs the sender. See `MessageControl.delivery`.
     *
     * Absent means no regime: nothing is classed, every message wakes its
     * recipients exactly as it always has, and no send is charged. Like
     * `commitments`, and for the same reason -- attention is spent by turns
     * that are already running, so a mesh must not acquire a new pricing
     * model by being upgraded. `mesh init` writes the block into new meshes;
     * an existing one opts in by hand.
     */
    delivery?: {
      /**
       * The switch. `true` turns on envelope classing and the wake rules it
       * implies; absent or `false` is the pre-existing behaviour.
       */
      classes?: boolean;
      /**
       * How long a `deliver`-class burst gathers before it costs one wake,
       * in milliseconds. Measured from the FIRST message of the burst, not
       * the last: a window that restarts on every arrival never closes under
       * a steady stream, which is the exact traffic this exists to price.
       *
       * The scheduler checks it on the wait-wakeup tick, so a value below
       * `scheduling.timeouts.wait_wakeup_ms` buys nothing.
       */
      coalesce_ms?: number;
      /**
       * What one `interrupt` costs its SENDER, in tokens, per recipient
       * woken. A tariff rather than a transfer: the recipient's own line is
       * still charged for the turn it actually runs, and this lands only on
       * the sender's agent line so the mission ledger keeps reporting real
       * spend. `0` records the class and charges nothing.
       */
      interrupt_cost_tokens?: number;
      /**
       * What a seat may spend buying other seats' attention, in tokens,
       * before its interrupts stop being interrupts.
       *
       * Absent means no attention line at all: the tariff keeps landing on
       * the sender's agent line exactly as it did before this key existed,
       * which is what makes this a strictly-additive change. A mesh that
       * enabled `classes` and never wrote this key behaves byte for byte as
       * it did, including the accidental backstop that the agent line
       * provided -- a seat that interrupts a hundred times runs out of its
       * own budget and stops being activated.
       *
       * Written, it moves the tariff to a line of its own (`attention:<goal>/<agent>`)
       * and makes it a real price: when the line cannot cover the interrupt,
       * the message still ships and still lands in the mailbox, but it ships
       * as `deliver`, so the wake it asked for is not bought. Nothing is ever
       * suppressed; only the wake is refused.
       *
       * `0` is a real and useful answer: it is a mesh that never buys an
       * interrupt, where every one degrades to mail. That is the low-contact
       * setting, stated exactly.
       */
      attention_tokens?: number;
    };
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
      /**
       * INERT. Declared, schema'd, resolved and defaulted, and read by no code
       * anywhere: the scheduler declares the mesh idle on the first moment its
       * queue and its running turns are both empty (`Scheduler.checkIdle`), so
       * there is no quiet period for this to configure and no debounce to tune.
       *
       * Named `idleQuietPeriodMs` in the resolved config, which documents the
       * same inertness. Deliberately NOT wired to a load warning like
       * `scheduling.activation.*` is: the designer exposes this key as an
       * editable field and `tests/helpers.ts` writes it into every fixture, so
       * a warning would fire on essentially every config in this repo rather
       * than on the ones that made a choice.
       *
       * Kept rather than deleted because it is schema'd on a block that is
       * `additionalProperties: false`, so dropping the property would turn
       * every config that sets it — including everything `tests/helpers.ts`
       * writes — into a hard validation failure.
       */
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

/**
 * The recipient's own answer to "what am I willing to be woken for", as written
 * in `mesh.yaml`. Per-agent only, deliberately: the mesh-wide version of this
 * setting already exists as `bus.delivery.classes`, and `mesh.defaults` would
 * only give an operator two ways to say the same thing.
 */
export interface RawWakePolicy {
  defer_non_obliging?: boolean;
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
  /**
   * Capability tokens this seat holds but may not use unaided: an operator must
   * grant the tool first. Inherits `mesh.runtime.requires_approval` when absent;
   * an explicit `[]` opts the seat out of a mesh-wide gate.
   */
  requires_approval?: string[];
  mode?: "peer" | "service";
  prompt?: string;
  capabilities?: string[];
  authority?: string[];
  interests?: string[];
  session?: RawSessionPolicy;
  delegation?: RawDelegationPolicy;
  hard_actions?: RawHardActions;
  /** What this seat is willing to be woken for. Absent means "everything". */
  wake?: RawWakePolicy;
  budget?: { tokens?: number; wall_clock_minutes?: number; max_events?: number; max_activations?: number };
}

export interface RawPolicyRule {
  id: string;
  /**
   * The rule's scope. Every clause present must hold for the rule to apply, so
   * a rule constrains exactly what it names.
   *
   * `to` names a recipient: the rule applies only to messages that address
   * that seat. It resolves like a communication-matrix recipient — by agent
   * id, by role, or by the base id of a hierarchical child — and it is only
   * ever satisfied by a message. A capability or authority check addresses
   * nobody, so a rule carrying `to` never applies to one.
   */
  when: {
    actor_role?: string;
    actor?: string;
    to?: string;
    message_type?: string;
    capability?: string;
  };
  /**
   * There is no `when.event` and no rule-level `requires`. Both are stranded
   * half of an abandoned transition-rule design (`agent-mesh-runtime.md` §19)
   * whose `when.to` named an artifact *status* — a shape since repurposed for
   * message recipients and, as a whole, implemented by `policies.transitions`.
   *
   * `when.event` was the dangerous half. Its value was never compared: the only
   * read was a guard that skipped the rule whenever there was no message under
   * evaluation, so its real effect was "do not apply to capability or authority
   * checks". `event: "artifact.published"` and `event: "banana"` were the same
   * rule, and a rule written to fire on one event fired on every message send
   * while denying *less* than it looked like it did. Deleting it therefore
   * widens such a rule, which is why a config still carrying it is refused at
   * load rather than ignored (`validateRemovedRuleClauses`): a mesh that cannot
   * boot cannot silently start denying work it used to allow.
   *
   * Rule-level `requires` was inert in both directions — never read, and
   * deleting it changes no behaviour — so it is warned about instead, the same
   * bargain `deny.contact` gets below. Note that three different keys in one
   * document were named `requires`; that is most of why this one went unread.
   */
  /**
   * There is no `deny.contact`. Contact is decided in exactly one place —
   * `policies.communication`, a per-seat default-DENY whitelist that keys on
   * agent, role or hierarchical child — and `matchRule` never read this field,
   * so a rule carrying it validated, booted, and restricted nobody. Every
   * denial it could express is a `may_contact` entry removed; the
   * recipient-scoped case is `when.to` plus `deny.message_types`. A second,
   * weaker source of truth for contact could only disagree with the first.
   *
   * A config still setting the key is told so rather than obeyed — see
   * `warnInertRuleContact`.
   */
  deny?: {
    capabilities?: string[];
    message_types?: string[];
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
  /**
   * Model used for that derivation. Always set — `DEFAULT_CRITERIA_MODEL` when
   * the mesh declares nothing — so the caller never has to decide what "unset"
   * means, and criteria generation never silently inherits an expensive seat
   * model just because someone left the key out.
   */
  criteriaModel: string;
  workspacePath: string;
  stateDir: string;
  /**
   * `mesh.workspace.git` verbatim. `undefined` means the key was absent, which
   * is NOT the same as `false` — absent defers to the default (ON), while
   * `false` is an explicit opt-out. Only `resolveUseGit` may collapse the two.
   */
  workspaceGit?: boolean;
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
    /**
     * Deadline an ask opens with, by debtor role. See RawMeshFile.bus.
     *
     * ABSENT means no deadline regime exists and asks never expire — which is
     * the default. It is deliberately not `{ defaultMs: 0 }`: `computeDueBy`
     * decides whether this mesh has deadlines AT ALL by testing this object's
     * presence, so handing it an always-present literal made that test
     * unreachable and let a contract's `slaMs` create deadlines on a mesh the
     * operator had never given any.
     */
    commitmentTtl?: { defaultMs: number; byRole: Record<string, number> };
    /** How agent turns may issue ops. See RawMeshFile.bus. */
    transport: "mixed" | "typed-only";
    /**
     * The collapsed contract vocabulary, or ABSENT when this mesh advertises
     * the full typed manifest. See RawMeshFile.bus.vocabulary.
     *
     * Absent rather than a resolved `"typed"` literal, for the same reason
     * `commitmentTtl` and `deliveryClasses` are absent: a manifest is what a
     * model is TAUGHT it may do, and a mesh must not acquire a different
     * vocabulary by being upgraded into the code. Every consumer therefore
     * asks `=== "contracts"`, and an absent field is the behaviour every
     * existing mesh already has, tool for tool.
     */
    vocabulary?: "contracts";
    /** Bounds a collaboration opens with. See RawMeshFile.bus. */
    collab: { boxMs: number; maxExchanges: number };
    /**
     * The delivery-class regime, or ABSENT when this mesh has none. See
     * RawMeshFile.bus.delivery and `MessageControl.delivery`.
     *
     * Absent rather than a zeroed literal for the same reason as
     * `commitmentTtl`: the supervisor decides whether to stamp a class at all
     * by testing this object's presence, so an always-present default would
     * make that test unreachable and start re-routing wakes on every mesh
     * that upgraded into the code.
     */
    deliveryClasses?: { coalesceMs: number; interruptCostTokens: number; attentionTokens?: number };
  };
  scheduling: {
    mode: "event-driven";
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
    /**
     * INERT: resolved, defaulted to 30000, and read by nothing. The scheduler
     * declares an idle moment the instant no turn is running and its queue is
     * empty, with no dwell time before it, so setting this key changes nothing
     * about when the mesh goes idle. See the raw key
     * (`scheduling.timeouts.idle_quiet_period_ms`) for why it is held rather
     * than removed.
     */
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

/**
 * Bounds a collaboration opens with, floored so a box can never be disabled.
 *
 * `0` and a negative are both read as "use the default", NOT as "unbounded":
 * an unbounded collab is exactly the untracked open-ended chatter the mode
 * replaces, so there is deliberately no way to spell it in config. An
 * operator who wants long sessions writes a long box and sees it on the card.
 */
export function resolveCollabBox(
  collab: NonNullable<RawMeshFile["bus"]>["collab"],
): { boxMs: number; maxExchanges: number } {
  const boxMs = collab?.box_ms && collab.box_ms > 0 ? collab.box_ms : DEFAULT_COLLAB_BOX_MS;
  const maxExchanges =
    collab?.max_exchanges && collab.max_exchanges > 0 ? collab.max_exchanges : DEFAULT_COLLAB_EXCHANGES;
  return { boxMs, maxExchanges };
}

/** 15 minutes: long enough for real discovery, short enough to notice. */
const DEFAULT_COLLAB_BOX_MS = 900_000;
/**
 * 20 messages. Two seats trading ten turns each is a substantial
 * conversation; past that they are either done or stuck, and both deserve a
 * look.
 */
const DEFAULT_COLLAB_EXCHANGES = 20;

/**
 * The commitment deadline regime, or `undefined` when this mesh has none.
 *
 * Returning `undefined` rather than `{ defaultMs: 0, byRole: {} }` is the whole
 * point of this function, and it is load-bearing.
 *
 * `computeDueBy` opens with `if (!ttl) return undefined` to enforce a decision
 * taken three times in this repo: expiry is an operator's choice, a contract's
 * `slaMs` may NARROW an existing regime but must never create one, and a mesh
 * must not inherit deadlines from an upgrade. That guard tests the OBJECT's
 * presence — so while this resolver returned an unconditional object literal,
 * the guard was unreachable and the decision it encodes was never enforced.
 * Every ask opened through a contract carrying an SLA (7 of the 8 built-ins,
 * 10 to 45 minutes) silently received a `dueBy` the operator never configured,
 * and no shipped example sets a TTL, so that was every default mesh.
 *
 * `ttl_ms: 0` stays indistinguishable from silence on purpose: zero is how an
 * operator writes "no deadline", and it should not conjure a regime either.
 */
export function resolveCommitmentTtl(
  commitments: NonNullable<RawMeshFile["bus"]>["commitments"],
): { defaultMs: number; byRole: Record<string, number> } | undefined {
  const defaultMs = commitments?.ttl_ms ?? 0;
  const byRole = commitments?.ttl_ms_by_role ?? {};
  // A per-role entry is itself a regime: it says "these seats have a clock",
  // which lets a contract SLA apply to the seats it does not name.
  if (defaultMs <= 0 && Object.keys(byRole).length === 0) return undefined;
  return { defaultMs, byRole };
}

/** One wait-wakeup tick's worth of gathering, matched to the sweep that drains it. */
const DEFAULT_COALESCE_MS = 60_000;
/**
 * 2000 tokens per recipient woken.
 *
 * Sized against the 200k default agent line: a seat can raise a hundred
 * interrupts before its own budget is the thing that stops it, which is high
 * enough that a genuinely urgent mission is never rationed and low enough that
 * a seat which interrupts by habit runs out of line before the mission runs
 * out of tokens. It is NOT an estimate of what the recipient's turn costs --
 * that is charged where it is spent, on the recipient's own line.
 */
const DEFAULT_INTERRUPT_COST_TOKENS = 2000;

/**
 * The delivery-class regime, or `undefined` when this mesh has none.
 *
 * Returning `undefined` for an absent or false `classes` is the whole point,
 * exactly as it is in `resolveCommitmentTtl`. Delivery classes decide which
 * messages are still allowed to wake a seat and which sends are billed, and
 * both of those are live behaviour on a running mission: a mesh that acquired
 * them from an upgrade would quietly stop waking agents its operator expected
 * to be woken, and start charging a budget line nobody had priced.
 *
 * `classes: false` is therefore identical to silence, not a third state, and
 * the two numeric keys are inert without it -- writing a `coalesce_ms` is not
 * a way to switch the regime on by accident.
 */
export function resolveDeliveryClasses(
  delivery: NonNullable<RawMeshFile["bus"]>["delivery"],
): { coalesceMs: number; interruptCostTokens: number; attentionTokens?: number } | undefined {
  if (!delivery?.classes) return undefined;
  const coalesceMs = delivery.coalesce_ms !== undefined && delivery.coalesce_ms > 0 ? delivery.coalesce_ms : DEFAULT_COALESCE_MS;
  // Zero is a real answer here (record the class, charge nothing), unlike the
  // window above where zero would mean "coalesce nothing" and make `deliver`
  // an `interrupt` by another name.
  const interruptCostTokens =
    delivery.interrupt_cost_tokens !== undefined && delivery.interrupt_cost_tokens >= 0
      ? delivery.interrupt_cost_tokens
      : DEFAULT_INTERRUPT_COST_TOKENS;
  // Unlike the two above, this one has NO default. Absent stays absent, so the
  // presence test in `chargeInterrupt` and in the pre-flight check stays
  // reachable instead of silently always-true -- the discipline the commitment
  // TTL established and that `docs/configuration.md` records as the shape any
  // future default of this kind should take. A default here would move every
  // existing interrupt onto a new ledger line and start downgrading wakes in
  // meshes whose operators never asked for a price they could not pay.
  const attentionTokens =
    delivery.attention_tokens !== undefined && delivery.attention_tokens >= 0
      ? delivery.attention_tokens
      : undefined;
  return { coalesceMs, interruptCostTokens, attentionTokens };
}

/**
 * The collapsed contract vocabulary, or `undefined` when this mesh keeps the
 * manifest it has always advertised.
 *
 * `"typed"` resolves to `undefined` rather than to itself. It is a NAME for
 * the default, written down so an operator can say "I looked at this and chose
 * the old surface", and folding it back to absence leaves exactly one
 * representation of "not opted in" for consumers to test — the same discipline
 * `resolveCommitmentTtl` and `resolveDeliveryClasses` keep, and for the same
 * reason: a presence test that has two false-y shapes is a presence test that
 * will eventually be written wrong.
 *
 * Unlike those two this cannot be switched on by accident, because there is no
 * neighbouring numeric key that implies it: the manifest either collapses or it
 * does not, and the only way to say so is this word.
 */
export function resolveBusVocabulary(
  vocabulary: NonNullable<RawMeshFile["bus"]>["vocabulary"],
): "contracts" | undefined {
  return vocabulary === "contracts" ? "contracts" : undefined;
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
  // Normalized here so a mesh writing an alias (`api.write`) gates the same
  // token the runtime checks. `??` at the seat, per the rule above: an explicit
  // `[]` means "ungated", and must beat a mesh-wide gate rather than inherit it.
  const defaultRequiresApproval = raw.mesh.runtime?.requires_approval?.map(normalizeCapability);
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
      requiresApproval: (a.requires_approval ?? defaultRequiresApproval)?.map(normalizeCapability),
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
      // Present only when declared. Unlike `hardActions`, whose absence still
      // resolves to a real value ("off" is a mode), this block's absence IS its
      // default, so materialising `{ deferNonObliging: false }` on every seat
      // would change every resolved definition — and every fixture that
      // deep-equals one — to say nothing new.
      ...(a.wake ? { wake: { deferNonObliging: a.wake.defer_non_obliging ?? false } } : {}),
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
    // `rule.when` is read defensively even though the type requires it: a
    // `policies.rules` item has no `items` schema, so a hand-written rule with
    // no `when` at all reaches here — `matchRule` meets it with `rule.when ?? {}`,
    // and until this was guarded it met it here with a raw TypeError.
    if (rule.when?.actor && !agents[rule.when.actor]) {
      errors.push(`policy rule '${rule.id}' references unknown actor '${rule.when.actor}'`);
    }
  }
  errors.push(...validateRuleClauseTokens(raw.policies?.rules ?? []));
  errors.push(...validateRemovedRuleClauses(raw.policies?.rules ?? []));

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
  for (const w of warnUngrantedApprovalGates(Object.values(agents))) {
    configWarnings.push(w);
  }
  for (const w of warnInertActivationKeys(raw.scheduling?.activation, raw.scheduling?.triage?.mode)) {
    configWarnings.push(w);
  }
  for (const w of warnInertRuleContact(raw.policies?.rules ?? [])) {
    configWarnings.push(w);
  }
  for (const w of warnUnreachableRuleRecipients(raw.policies?.rules ?? [], Object.values(agents))) {
    configWarnings.push(w);
  }
  for (const w of warnUnreachableRuleRoles(raw.policies?.rules ?? [], Object.values(agents))) {
    configWarnings.push(w);
  }
  for (const w of warnInertRuleRequires(raw.policies?.rules ?? [])) {
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
    // `|| DEFAULT` rather than `??`: a key present but blank is a typo, not a
    // request to inherit the runtime default, and handing the SDK "" would be
    // a turn-1 failure rather than a config error anyone can read.
    criteriaModel: raw.mesh.criteria_model?.trim() || DEFAULT_CRITERIA_MODEL,
    workspacePath,
    stateDir,
    workspaceGit: raw.mesh.workspace?.git,
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
    // Normalized, not passed through: the engine compares a rule's capability
    // against the CANONICAL token a seat holds, so an alias written in a rule
    // would match nothing. See `normalizeRuleCapabilities`.
    policyRules: normalizeRuleCapabilities(raw.policies?.rules ?? []),
    bus: {
      commitmentSemantic: raw.bus?.commitments?.semantic ?? "strict",
      // Defaults to "no deadline" on purpose. Expiry closes asks that would
      // otherwise stay open, so turning it on is a behaviour change an
      // operator should choose for a mission, not inherit from an upgrade.
      commitmentTtl: resolveCommitmentTtl(raw.bus?.commitments),
      transport: raw.bus?.transport ?? "mixed",
      // Absent by default, like `commitmentTtl` and `deliveryClasses`: this
      // one changes the tool list a model is shown, so it is opted into per
      // mesh rather than inherited from an upgrade.
      vocabulary: resolveBusVocabulary(raw.bus?.vocabulary),
      collab: resolveCollabBox(raw.bus?.collab),
      // Absent by default, like `commitmentTtl` and for the same reason: this
      // one re-routes wakes and bills sends, so it is opted into per mesh.
      deliveryClasses: resolveDeliveryClasses(raw.bus?.delivery),
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
 * Every key under `scheduling.activation` is declared, defaulted and in the
 * JSON schema — and read by nothing. The whole block is inert:
 *
 * - `strategy` — whether the router pass runs is decided by
 *   `scheduling.triage.mode` alone. See `triage()` in the scheduler.
 * - `max_activation_delay_ms` — activations are never delayed, whatever it
 *   says. Unlike `strategy` there is no other key to redirect to, because the
 *   behaviour it names was never implemented.
 *
 * Warned rather than rejected, and rather than dropped from the schema: the
 * activation block is `additionalProperties: false`, so removing a property
 * would turn every config that sets it — including everything `mesh init` has
 * ever written — into a hard validation failure. Wiring `strategy` instead
 * would be worse still: two keys for one behaviour, and every config pinning
 * the default would silently lose its triage rules.
 *
 * Accepting them in silence is the one option refused. The operator who sets a
 * switch is owed the news that it does nothing; that is the whole point. Each
 * key gets its own sentence because each has its own remedy — one says "use
 * this other key", the other says "there is nothing to use".
 *
 * Fires only on keys explicitly present. A default carries no claim, neither
 * key is editable in the designer any more, and `mesh init` writes neither.
 */
export function warnInertActivationKeys(
  activation: { strategy?: string; max_activation_delay_ms?: number } | undefined,
  triageMode: string | undefined,
): string[] {
  const warnings: string[] = [];
  if (activation?.strategy !== undefined) {
    warnings.push(
      `scheduling.activation.strategy is set to '${activation.strategy}' but inert — no code reads it, and whether the router pass runs is decided by scheduling.triage.mode alone (currently '${triageMode ?? "off"}'). Remove the key; set triage.mode: heuristic if you want the router pass`,
    );
  }
  if (activation?.max_activation_delay_ms !== undefined) {
    warnings.push(
      `scheduling.activation.max_activation_delay_ms is set to ${activation.max_activation_delay_ms} but inert — no code reads it, so activations always fire immediately and no other key delays them. Remove it`,
    );
  }
  return warnings;
}

/**
 * A policy rule setting `deny.contact`, which is not a policy field.
 *
 * The one thing an operator writing `deny` is sure of is that something is
 * being denied, and this key denied nothing: `matchRule` never read it. A rule
 * carrying it validated, booted, and restricted contact exactly as much as if
 * it had been left out — the failure mode this whole family of warnings exists
 * to end.
 *
 * Contact is decided in one place, `policies.communication`, and the remedy is
 * there: drop the recipient from that seat's `may_contact`. A recipient-scoped
 * veto is `when.to` plus `deny.message_types`. So the field is gone from
 * `RawPolicyRule` rather than implemented — adding a second, weaker source of
 * truth for contact could only disagree with the matrix — and a config still
 * using it is told where the real switch is instead of being quietly obeyed.
 *
 * Detected on the raw rule object rather than a typed one because the key is
 * no longer part of `RawPolicyRule`. It still reaches here: `policies.rules`
 * items are unconstrained in the JSON schema (`rules: { type: "array" }`), so
 * an unknown key loads without error whether or not the type declares it.
 */
export function warnInertRuleContact(rules: RawPolicyRule[]): string[] {
  const offenders = rules.filter((r) => (r.deny as { contact?: unknown } | undefined)?.contact !== undefined);
  if (offenders.length === 0) return [];
  const named = offenders.map((r) => `'${r.id}'`).join(", ");
  return [
    `policy rule${offenders.length === 1 ? "" : "s"} ${named} set${offenders.length === 1 ? "s" : ""} deny.contact but it is inert — contact is decided by policies.communication (may_contact / may_be_contacted_by), never by a rule. Remove the recipient from that seat's may_contact, or scope the rule with when.to`,
  ];
}

/**
 * A rule scoped to a recipient no seat can be.
 *
 * `when.to` is the clause that makes a rule apply to one seat instead of the
 * whole mesh, and it resolves the three ways the communication matrix resolves
 * a recipient: by agent id, by role, and by the base id of a hierarchical
 * child. A name that answers to none of those scopes the rule to NOBODY, so a
 * veto written to stop one seat blocks nothing and the message it was written
 * to stop goes through — silently, and in the permissive direction. That is the
 * one failure mode a contact rule can have.
 *
 * Warned rather than errored, unlike the `when.actor` check above, and the
 * difference is hierarchy: a child seat comes into being at runtime, so a
 * config may legitimately name a base id this process has not seen yet.
 * Refusing to boot over that would break working meshes, while a warning costs
 * an operator one line of output.
 *
 * A declared-but-EMPTY `to` is reported too. The policy engine reads it as
 * "nobody" (see `matchRule`), which is the right way round for a field an
 * operator cleared — but "this rule denies nothing" is exactly what its author
 * needs to be told, and a designer that clears the field by writing `""`
 * rather than dropping the key would otherwise do it silently.
 */
export function warnUnreachableRuleRecipients(rules: RawPolicyRule[], agents: AgentDefinition[]): string[] {
  const reachable = new Set<string>();
  for (const a of agents) {
    reachable.add(a.id);
    reachable.add(a.role);
    const hash = a.id.indexOf("#");
    if (hash > 0) reachable.add(a.id.slice(0, hash));
  }
  const offenders: string[] = [];
  for (const r of rules) {
    const to = (r.when as { to?: unknown } | undefined)?.to;
    if (to === undefined) continue;
    if (typeof to === "string" && reachable.has(to)) continue;
    offenders.push(r.id);
  }
  if (offenders.length === 0) return [];
  const named = offenders.map((id) => `'${id}'`).join(", ");
  return [
    `policy rule${offenders.length === 1 ? "" : "s"} ${named} scope${offenders.length === 1 ? "s" : ""} when.to to a name no seat answers to, so the rule denies nothing — when.to must name an agent id, a role, or the base id of a hierarchical child`,
  ];
}

/**
 * A rule whose capability or message-type clause names a token that cannot exist.
 *
 * `deny.capabilities`, `when.capability`, `deny.message_types` and
 * `when.message_type` are all compared by exact string equality against what the
 * mesh produces, so a token outside the catalog matches nothing and the clause
 * is dead: a veto that vetoes nothing, or a scope that scopes nothing. Both
 * directions are silent, which is why this is the same class of defect as the
 * `when.actor` check above — and why it gets the same severity.
 *
 * Errors rather than warnings, matching `validateCapabilityTokens` and the
 * `when.actor` check, and for the reason the `when.to` check next door gives in
 * reverse: a capability or a message type has no runtime-arrival escape hatch.
 * No seat can turn up later holding `repository.writ`, and no message can arrive
 * with a type the envelope schema would have rejected. A base id or a role can
 * (hierarchy, delegation), which is why those two are warnings and these are not.
 *
 * Capability tokens are matched through `normalizeCapability`, so a legal alias
 * is accepted here — the resolver normalizes rule clauses for exactly this
 * reason (see `normalizeRuleCapabilities`), and erroring on a token the catalog
 * calls legal would be telling an operator their working rule is broken.
 */
export function validateRuleClauseTokens(rules: RawPolicyRule[]): string[] {
  const caps = new Set(CAPABILITY_TOKENS);
  const types = new Set<string>(MESSAGE_TYPES);
  const errors: string[] = [];
  for (const r of rules) {
    const cap = (r.when as { capability?: unknown } | undefined)?.capability;
    if (typeof cap === "string" && !caps.has(normalizeCapability(cap))) {
      errors.push(
        `policy rule '${r.id}' names unknown capability '${cap}' in when.capability — the rule can never match an op (known: ${CAPABILITY_TOKENS.join(", ")})`,
      );
    }
    for (const token of denyList(r, "capabilities")) {
      if (!caps.has(normalizeCapability(token))) {
        errors.push(
          `policy rule '${r.id}' denies unknown capability '${token}' — the deny can never fire (known: ${CAPABILITY_TOKENS.join(", ")})`,
        );
      }
    }
    const mt = (r.when as { message_type?: unknown } | undefined)?.message_type;
    if (typeof mt === "string" && !types.has(mt)) {
      errors.push(
        `policy rule '${r.id}' names unknown message type '${mt}' in when.message_type — the rule can never match a message (see schemas/message.schema.json)`,
      );
    }
    for (const token of denyList(r, "message_types")) {
      if (!types.has(token)) {
        errors.push(
          `policy rule '${r.id}' denies unknown message type '${token}' — the deny can never fire (see schemas/message.schema.json)`,
        );
      }
    }
  }
  return errors;
}

/** The rule's `deny.<key>` list, tolerating a hand-written config's shape. */
function denyList(rule: RawPolicyRule, key: "capabilities" | "message_types"): string[] {
  const list = (rule.deny as Record<string, unknown> | undefined)?.[key];
  if (!Array.isArray(list)) return [];
  return list.filter((t): t is string => typeof t === "string");
}

/**
 * Rewrite rule capability clauses through the alias table, as every other
 * capability list in a config already is.
 *
 * This was the one surface that skipped normalization — `agents.*.capabilities`,
 * `requires_approval` and `hard_actions.capabilities` are all normalized during
 * resolution — and the omission was invisible: the engine compares a rule's
 * token against the CANONICAL token a seat holds, so `deny.capabilities:
 * [code.write]`, a legal spelling per `CAPABILITY_ALIASES`, matched nothing and
 * denied nothing. The rule read as live in the designer and was dead at runtime.
 * `CAPABILITY_TOKENS`' own docstring states the contract — "the aliases below
 * are normalized first so hand-written meshes keep working" — so normalizing is
 * what a rule was always supposed to get.
 *
 * Returns new rule objects rather than editing in place: `raw` is the resolved
 * config's copy of the document as written, and it has to keep saying what the
 * operator typed. Only the clauses that actually change are rebuilt.
 */
export function normalizeRuleCapabilities(rules: RawPolicyRule[]): RawPolicyRule[] {
  return rules.map((rule) => {
    const when = rule.when;
    const deny = rule.deny;
    const nextWhen =
      typeof when?.capability === "string" ? { ...when, capability: normalizeCapability(when.capability) } : when;
    const nextDeny =
      deny?.capabilities && Array.isArray(deny.capabilities)
        ? { ...deny, capabilities: deny.capabilities.map((t) => (typeof t === "string" ? normalizeCapability(t) : t)) }
        : deny;
    if (nextWhen === when && nextDeny === deny) return rule;
    return { ...rule, ...(nextWhen ? { when: nextWhen } : {}), ...(nextDeny ? { deny: nextDeny } : {}) };
  });
}

/**
 * A rule scoped to a role no configured seat has.
 *
 * `when.actor_role` is matched against the acting seat's role, so a role that
 * does not exist scopes the rule to nobody. Warned rather than errored for the
 * reason the transition-gate check gives above: a mesh may legitimately be
 * written for seats a larger mesh adds later, and delegated workers and the
 * synthesized `human` seat both arrive at runtime with roles this process never
 * saw in the config. A hard error there would refuse to boot a working mesh.
 */
export function warnUnreachableRuleRoles(rules: RawPolicyRule[], agents: AgentDefinition[]): string[] {
  const roles = new Set<string>(agents.map((a) => a.role));
  // Synthesized at runtime, never declared — same exemption
  // `validateTransitionGateActors` makes for the same reason.
  roles.add("human");
  const offenders = rules.filter((r) => {
    const role = (r.when as { actor_role?: unknown } | undefined)?.actor_role;
    return typeof role === "string" && role.length > 0 && !roles.has(role);
  });
  if (offenders.length === 0) return [];
  const named = offenders.map((r) => `'${r.id}'`).join(", ");
  return [
    `policy rule${offenders.length === 1 ? "" : "s"} ${named} scope${offenders.length === 1 ? "s" : ""} when.actor_role to a role no configured seat has — the rule applies to nobody until a seat with that role exists. Expected a declared role, a delegated worker's role, or 'human'`,
  ];
}

/**
 * A rule still carrying `when.event`, which no longer exists.
 *
 * The clause was accepted and never compared: its only effect was to skip the
 * rule whenever no message was under evaluation, which quietly *disabled*
 * capability and authority denial on every rule that also denied capabilities.
 * Worse than a dead clause, because it was documented as a scope: an operator
 * wrote `when: { event: "release.transition" }` believing it narrowed the rule
 * and got one that matched every message and denied less.
 *
 * An error rather than the warning a removed field usually gets, and the
 * asymmetry with `warnInertRuleRequires` below is the whole argument: removing
 * an inert field changes nothing, while removing this one makes the rule apply
 * where it previously did not. A config that cannot boot cannot silently
 * widen, so the operator is made to look — and the message says what the clause
 * had been doing, so the edit is a decision rather than a shrug. Same bargain
 * as the removal of `MeshMessage.ttl`.
 *
 * Keyed on the key's presence rather than its value, because every spelling was
 * the same mistake: the old guard tested truthiness, so `event: "x"` and
 * `event: ""` both meant "skip capability checks" and `event: null` meant
 * nothing at all. Presence is the only honest test for a field that is gone.
 */
export function validateRemovedRuleClauses(rules: RawPolicyRule[]): string[] {
  const errors: string[] = [];
  for (const r of rules) {
    const when: unknown = r.when;
    if (typeof when !== "object" || when === null || !("event" in when)) continue;
    errors.push(
      `policy rule '${r.id}' sets when.event, which was removed — its value was never compared. It only stopped the rule applying to capability and authority checks, so this rule will now deny more than it did. Delete the clause, and scope the rule with when.message_type (or when.to for one recipient)`,
    );
  }
  return errors;
}

/**
 * A rule carrying a rule-level `requires`, which no longer exists.
 *
 * Inert in both directions — nothing ever read it, so deleting the field
 * changes no behaviour — and therefore a warning, where `when.event` above is
 * an error. The live `requires` is `policies.transitions.<gate>.requires`,
 * which is what the abandoned design's `requires.approvals` became; and
 * `MeshMessage.requires` is a third field with the same name. Three keys named
 * `requires` in one document is most of why this one went unread, and is worth
 * saying out loud to whoever finds the key in their yaml.
 */
export function warnInertRuleRequires(rules: RawPolicyRule[]): string[] {
  const offenders = rules.filter((r) => "requires" in (r as unknown as Record<string, unknown>));
  if (offenders.length === 0) return [];
  const named = offenders.map((r) => `'${r.id}'`).join(", ");
  return [
    `policy rule${offenders.length === 1 ? "" : "s"} ${named} set${offenders.length === 1 ? "s" : ""} a rule-level requires, which no code reads — approvals and evidence are gated by policies.transitions instead. The key is ignored`,
  ];
}

/**
 * An approval gate on a capability the seat was never granted.
 *
 * `requires_approval` NARROWS an existing grant: it says "this seat may use
 * that capability's tools, but not until an operator says so". Naming a token
 * the seat does not hold gates nothing, because the capability check already
 * denies those tools outright — approval is never reached.
 *
 * Warned rather than errored: the seat is safe, just not what its author
 * meant. The likely intent was to grant the capability AND gate it, and a
 * config that silently does neither is the one worth flagging.
 */
export function warnUngrantedApprovalGates(agents: AgentDefinition[]): string[] {
  const warnings: string[] = [];
  for (const a of agents) {
    const held = new Set(a.capabilities);
    const stray = (a.requiresApproval ?? []).filter((t) => !held.has(t));
    if (stray.length === 0) continue;
    warnings.push(
      `agents.${a.id}.requires_approval names ${stray.join(", ")}, which this seat does not hold — that gates nothing, since the capability check already denies those tools. Grant the capability too, or drop it from requires_approval`,
    );
  }
  return warnings;
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
      // The human seat satisfies gates but is not an agent, so it never lands
      // in `actors` above. Without this exemption every `human.approve` gate is
      // reported as permanently unsatisfiable — a false alarm on a supported
      // pattern (tests/integration/human.test.ts: "humans are a mesh seat not
      // an external oracle"). The policy-engine's validateTransitionGates has
      // always skipped it; this check had drifted from it.
      // Literal rather than core's HUMAN_AGENT_ID (core/src/supervisor.ts:140):
      // config imports only protocol, which hardcodes the same string.
      if (actor === "human") continue;
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
    # Writing agents commit through git worktrees, and the product lives in
    # ./workspace/main. Set this to false (or run with --no-git) to write
    # product files straight into the workspace root instead — but note that
    # without a workspace every mesh_commit is refused, so a mission whose
    # criteria require landed code can never satisfy them.
    git: true
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

bus:
  # Which comms vocabulary this mesh advertises to its agents. With
  # "contracts" a seat's tool list is the named asks — mesh_contracts to see
  # them, mesh_call to raise one, mesh_reply to answer one, mesh_discharge to
  # refuse one, mesh_announce to say something nobody owes an answer to, and
  # mesh_collab for a bounded discussion — and not one of those tools asks for
  # a message type. Set this to "typed" (or remove the key) for the older
  # surface, where mesh_send, mesh_broadcast and mesh_respond each ask the
  # agent to pick one of 24 speech-act names. The tools "contracts" hides are
  # still callable by name, so nothing a seat could do becomes impossible —
  # and a mesh written before this key existed keeps the full list, so
  # upgrading changes nobody's manifest.
  vocabulary: contracts
  commitments:
    # How long an unanswered ask may sit before the runtime closes it as
    # expired, in milliseconds (30 minutes here). Without a deadline an ask
    # never leaves the ledger on its own: the debtor is nudged a few times and
    # a request that stays stuck raises an operator card, but the obligation
    # itself stays open for the rest of the mission. Remove this key, or set it
    # to 0, to switch deadlines off entirely — that is how a mesh with no bus
    # block behaves, so meshes written before this default existed keep their
    # old behaviour untouched.
    ttl_ms: 1800000
  delivery:
    # Price attention. Without this block every message wakes each of its
    # recipients the instant it is sent, and a wake is a full model turn — so
    # sending costs the sender nothing and costs the recipient everything.
    # With it, the runtime stamps each message with what its delivery may
    # spend: interrupt wakes now and charges the sender, deliver gathers a
    # burst into one wake, accrue never wakes and rides the next turn the
    # recipient takes anyway. Every class still lands in the mailbox; only the
    # wake differs. Remove this block, or set classes to false, to go back to
    # waking on every message — that is how a mesh with no bus block behaves,
    # so meshes written before this default existed keep their old behaviour.
    classes: true
    # How long a deliver burst gathers before it costs one turn.
    coalesce_ms: 60000
    # What one interrupt costs its sender, per recipient woken. 0 records
    # the class and charges nothing.
    interrupt_cost_tokens: 2000
    # What a seat may spend buying other seats' attention before its
    # interrupts stop being interrupts. Separate from the agent token line on
    # purpose: over-interrupting costs a seat its influence, not its ability
    # to work. Sized to the same rationing the agent line gave by accident --
    # 200000 / 2000 is a hundred interrupts -- but now landing on the wake.
    # 0 means this mesh never buys one; every interrupt degrades to mail.
    attention_tokens: 200000

scheduling:
  mode: event-driven
  concurrency:
    max_active_agents: 4
`;
  fs.writeFileSync(target, template, "utf8");
  materializeRolePrompts(parseMeshSource(template), targetDir);
  return target;
}
