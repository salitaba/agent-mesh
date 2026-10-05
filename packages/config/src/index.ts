import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  validateMeshConfig,
  EVENT_TYPES,
  AUTHORITY_TOKENS,
  AUTO_EVIDENCED_CRITERIA,
  DEFAULT_CRITERIA,
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
  type MessageType,
  type GitMode,
} from "../../protocol/src/index";
import { resolveProviderModel } from "../../llm/src/index";

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
    runtime?: {
      default?: string;
      model?: string;
      variant?: string;
      requires_approval?: string[];
      /** Window of `model`, in tokens, for a model the claude adapter cannot place. */
      context_window?: number;
      /**
       * How long a seat's session may sit idle before the adapter rotates it,
       * in ms. Defaults to the adapter's own 10 minutes, which assumes the
       * prompt cache died in the gap; a route whose cache outlives that (a
       * proxy, measured at 94% cached after 10+ minutes) wants an hour.
       */
      stale_after_ms?: number;
      /**
       * Run every seat without what the launching machine would otherwise lend it:
       * no filesystem settings (the user's hooks, allow rules, `env`, model and
       * effort), and none of the environment variables of a Claude Code session the
       * mesh was started from. Off by default, because a mesh that works today may
       * depend on either; the boot log says when something would leak. Credentials,
       * proxies and CA variables are kept either way. See `host-isolation.ts`.
       */
      isolate_host?: boolean;
      /** The native runtime's providers, by the name a seat's `model: provider/model` uses. */
      providers?: Record<string, RawProvider>;
      default_provider?: string;
      /** Settings per bare model id. */
      models?: Record<string, RawModelSettings>;
      /** Which runtime answers the designer's chat. Defaults to the default runtime when that is `native`. */
      designer?: "claude" | "native";
      designer_model?: string;
      native?: { shell_env?: "inherit" | "minimal"; extra_read_roots?: string[]; max_steps?: number };
    };
    defaults?: { session?: RawSessionPolicy; delegation?: RawDelegationPolicy; hard_actions?: RawHardActions };
    /**
     * What a turn's brief does with a mailbox it cannot read in full.
     *
     * All three keys are ON by default, which is the one place in this file
     * that departs from "absent means the behaviour every existing mesh already
     * has". The departures are deliberate: the mesh these were built for had
     * tech-lead holding 145 unread messages and qa 43 while three seats ran at
     * once, and every turn of those seats began by draining a mailbox. A
     * rationing key that has to be discovered before it does anything would
     * have bought nothing on that mission.
     *
     * 0 disables any of them.
     */
    messages?: {
      /**
       * Above this many readable messages, the brief carries ONE digest block
       * -- count, senders, types, thread subjects, message ids -- instead of a
       * body per message. The mail is not deleted and not marked read by the
       * digest: every id it names is still in the mailbox, still owed, and can
       * be pulled individually while the turn runs.
       */
      digest_threshold?: number;
      /**
       * Age past which a plain INFORM stops being admitted to the brief. It is
       * still in the event log and still in the mailbox; it simply no longer
       * spends brief tokens on a turn that has newer things to read.
       *
       * Only mail that owes nothing and moves no work may expire: a REQUEST_*,
       * an ESCALATION or anything else that opens a debt is admitted at any
       * age, because the seat that owes the answer is the only one who can
       * close it.
       */
      inform_expiry_ms?: number;
      /**
       * How many messages one seat's turn may send before the rest of its
       * FYI-class chatter is batched into a single digest at turn end. 0
       * disables.
       *
       * The mailbox half of the problem `inform_expiry_ms` and
       * `digest_threshold` address from the reader's side. Those two decide how
       * much of a full box a turn READS; this one decides how full the box gets.
       * Measured on the 2026-09-27 run: 282 messages in a day, 119 of them to
       * one seat, ~100 never read, one mailbox peaking at 145 unread.
       *
       * Only mail that obliges nobody and moves no work is ever held — an ask,
       * a verdict, a handoff, an URGENT and an answer (`replyTo`) are sent
       * immediately however far past the budget the turn is, because batching
       * one of those would change what it means. See
       * `Supervisor.mergeableSend`.
       */
      max_sends_per_turn?: number;
    };
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
    /**
     * Fraction (0..1) of a turn's cache-read tokens billed to its ledgers.
     * Default 0: reads are free and a turn is billed input + output + cache
     * writes, exactly as before the key existed. Raise it when budgets should
     * stop rewarding cache luck — measured 2026-09-25, five cache-miss turns
     * were 64% of all fresh input while warm turns reading millions billed a
     * fraction of that.
     */
    cache_read_weight?: number;
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
      /**
       * The soonest, in milliseconds, an `ifUnanswered` default may come due: the
       * floor on the `afterMs` a seat names. A shorter one is refused when the seat
       * raises the ask, with this figure in the refusal.
       *
       * A default is only honest if somebody could have objected before it stood.
       * An ask that waits out a gathering window, a busy addressee's current turn and a
       * sweep cannot be answered in five seconds, and a seat that named five (two of
       * three, in the cronlite run) defaulted before its addressee had read the ask and
       * then proceeded, "do not re-ask", on an assumption the real answer contradicted.
       *
       * Absent: derived from this mesh, as the delivery window (`coalesce_ms`, when
       * classes are on) + `scheduling.timeouts.wait_wakeup_ms` + two minutes for the
       * addressee's turn. `0` turns the floor off. It never applies to an ask that
       * names no `afterMs`, whose deadline is the operator's (`ttl_ms`).
       */
      min_default_ms?: number;
      /**
       * Whether an ask that named no contract is held to the one its MESSAGE
       * TYPE implies. Absent or `false` is how every mesh has behaved: the
       * eight contracts are opt-in, and a bare `REQUEST_REVIEW` opens a real
       * debt with no refusal vocabulary, no SLA and no answer shape -- so the
       * ledger records an obligation it has no way to judge.
       *
       * The mapping is not a new table. Every contract already declares the
       * `messageType` it speaks for, and those eight claims cover exactly the
       * eight obliging types, so `contractForMessageType` derives it. A type
       * no contract claims still gets no default.
       *
       * What turning this on actually changes, in order of how much it bites:
       *
       *  1. Refusals become a CLOSED SET. Today any string discharges a
       *     contractless ask; under this key it must be one the contract
       *     admits. That is the point of the key -- "wontfix" and "not now"
       *     and "cant" are the same refusal spelled three ways, and a ledger
       *     that accepts all three can count none of them -- but it is a real
       *     tightening, and it is why this is opt-in.
       *  2. Deadlines narrow, but ONLY on a mesh that set `ttl_ms`. Without a
       *     TTL regime no contract SLA can create a deadline (`computeDueBy`
       *     returns undefined before it ever reads the SLA). With one, an
       *     `info.question` falls to its own 10 minutes instead of the mesh
       *     default, which is the per-type deadline the SLAs exist to give.
       *  3. Answers get judged against the contract's response shape. This
       *     one is FAIL-OPEN by construction: the verdict is recorded on the
       *     discharge and settles the debt either way, so the only effect is
       *     that thin answers stop being invisible.
       *
       * What it deliberately does NOT change: the request payload is not
       * validated. Only the `call` op checks a request against its schema,
       * and routing bare sends through it would reject asks that are legal
       * today -- including ones this repo's own fixtures send. The rule that
       * a contract stamped on the wire means "this ask passed its request
       * schema" therefore stays true, because this never writes a stamp: the
       * default is resolved where the debt is recorded, not on the envelope.
       */
      by_type?: boolean;
    };
    /**
     * One key that expands to a COHERENT set of the keys below it.
     *
     * Every other key in this block is a dial, and the dials interact: a
     * deadline regime without delivery classes still wakes a seat for every
     * message that arrives before the deadline, and delivery classes without
     * a deadline coalesce the wakes for an ask that can then hang forever.
     * An operator who wants "agents that do not interrupt each other" has to
     * know which four keys say that together and which values of them cohere,
     * and the failure mode of getting it half right is not an error — it is a
     * mesh that behaves in a way nobody chose.
     *
     * A style is not a new mechanism. It expands, before validation, into the
     * same raw keys an operator could have written by hand, and ANY key
     * written explicitly beside it wins — so `style: low-contact` with
     * `commitments: { ttl_ms: 0 }` is a low-contact mesh with deadlines off,
     * not a conflict and not an error. That ordering is what keeps the style
     * a starting point rather than a mode: nothing downstream can tell a
     * style-expanded mesh from a hand-written one, and every absent-vs-zero
     * distinction the resolvers below depend on is still decided by those
     * resolvers, on raw input, exactly as before.
     *
     * - "high-contact" (the default, and what every mesh without this key
     *   already is): no deadlines, no delivery classes, the full typed
     *   manifest. Every message wakes its recipient, and an unanswered ask is
     *   chased and then escalated to a human. Right for a small mesh doing
     *   one thing, where a stalled ask is the most expensive event there is.
     *   Written out, it says "I looked at this and kept the old behaviour" —
     *   the same reason `vocabulary: "typed"` is spellable.
     * - "balanced": asks expire after 30 minutes instead of hanging, and
     *   delivery classes are on at their defaults, so routine mail coalesces
     *   into a 60s window and an interrupt is billed. The manifest does not
     *   change. Right for most missions.
     * - "low-contact": additionally prices ATTENTION (a wake is charged
     *   against a real budget line, with congestion making each one dearer as
     *   a mailbox fills), widens coalescing to five minutes, collapses the
     *   manifest onto contracts so an ask arrives pre-validated with a closed
     *   refusal set, and tightens the collaboration box. Right for a long
     *   mission with many seats, where the scarce resource is not answers but
     *   the turns spent producing them.
     */
    style?: "high-contact" | "balanced" | "low-contact";
    /**
     * REMOVED, read by nothing. It chose whether ops parsed out of a prose
     * `mesh-json` block executed ("mixed") or were refused ("typed-only").
     * The prose channel is gone — every op is an MCP `mesh_*` tool call — so
     * there is nothing left for it to choose. Kept in the type and the schema
     * only so a mesh.yaml that still sets it loads with a warning
     * (`warnRemovedTransport`) instead of failing `additionalProperties`.
     */
    transport?: string;
    /**
     * Which comms vocabulary a seat's MCP manifest advertises.
     *
     * - absent, or "typed" (the default): the manifest every mesh has had.
     *   `mesh_send`, `mesh_broadcast` and `mesh_respond` each carry the full
     *   24-name `MessageType` enum, and a seat picks a speech act out of it.
     * - "contracts": the comms manifest collapses to the named asks.
     *   `mesh_contracts` lists what can be asked for, `mesh_call` raises one,
     *   `mesh_reply` answers one, `mesh_discharge` refuses one,
     *   `mesh_withdraw` takes one back, `mesh_announce` says something that
     *   obliges nobody, and `mesh_collab`/`mesh_collab_close` bound a
     *   discussion. None of the eight names a message type, so there is no
     *   vocabulary to memorise and nothing to invent.
     *
     * The type-carrying tools are dropped from the ADVERTISED list only. They
     * stay callable — `callTool` resolves against the unfiltered map — so
     * collapsing the vocabulary can never take a capability away from a seat,
     * and a model that reaches for `mesh_send` still gets it.
     *
     * Every op arrives as a typed tool call; this decides only WHAT that
     * surface offers.
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
     * model by being upgraded. `curule init` writes the block into new meshes;
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
      /**
       * How many unread messages in a RECIPIENT's box add one unit to the
       * price of waking them. Absent means the flat tariff: an interrupt
       * costs the same whether the seat it wakes is idle or forty deep.
       *
       * The flat price asks the wrong question. What a wake costs is not a
       * property of the sender's intent; it is a property of the seat being
       * woken. Pulling an idle seat into a turn costs it a turn it had
       * nothing better to do with. Pulling a seat that is already eight
       * messages behind costs it a context switch ON TOP of a queue it is
       * losing ground on -- and it is precisely the seat every sender is
       * most tempted to interrupt, because it is the one in the middle of
       * everything. A flat tariff prices those two identically and so prices
       * the only thing that matters at zero.
       *
       * Written as `4`, the price is `interrupt_cost_tokens` at depth 0-3,
       * doubled at 4-7, tripled at 8-11, and capped at
       * `MAX_INTERRUPT_SURCHARGE` from there on. Capped, and capped loudly:
       * a sender cannot see inside another seat's box, so an uncapped curve
       * would make the price of a legitimate wake unknowable in advance --
       * and a price nobody can predict is not a price, it is a penalty. The
       * cap is what keeps this a signal the sender can reason about: at
       * worst, waking the busiest seat in the mesh costs a known multiple of
       * waking an idle one.
       *
       * Depth is measured EXCLUDING the message being priced, so a sender
       * never pays a surcharge its own message caused, and the pre-flight
       * quote and the charge that lands afterwards agree.
       *
       * Absent stays absent, like `attention_tokens` above and for the same
       * reason: a mesh must not start charging a different price by being
       * upgraded into the code.
       */
      congestion_every?: number;
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
       * How long the mesh must be quiet — no queued activation and no running
       * turn — before `Scheduler.checkIdle` declares it idle and fires its
       * listeners (which is what starts the watchdog scan that can complete or
       * escalate the goal).
       *
       * It was inert for as long as it existed: the scheduler used to declare
       * the idle moment on the instant the queue and the running map were both
       * empty, so there was no quiet period for this to configure and no
       * debounce to tune. The dwell now exists, and `0` (or below) is the escape
       * hatch back to the old edge-triggered behaviour.
       *
       * Deliberately NOT wired to a load warning like `scheduling.activation.*`
       * is: nothing about the key is malformed, and `tests/helpers.ts` writes it
       * into every fixture.
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
  /** Message types this seat will not be woken for. See WakePolicy.notFor. */
  not_for?: MessageType[];
  mail?: "full" | "claims";
}

export interface RawAgent {
  role: string;
  runtime?: string;
  model?: string;
  /** This seat's context window in tokens; see `AgentDefinition.contextWindow`. */
  context_window?: number;
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
   * `mesh.runtime.context_window`: the window rotation measures against for a
   * model the claude adapter's table cannot place (§1 of
   * NOTES-live-run-20260925-2040.md: a 1M model rotating at the 120k floor).
   * Ranks below a seat's own `context_window` and below a known model.
   */
  defaultContextWindow?: number;
  /**
   * `mesh.runtime.stale_after_ms`: how long a seat's session may sit idle
   * before the adapter rotates it on the theory that its prompt cache died.
   * The adapter's default (10 minutes) fits Anthropic's own cache TTL; a
   * proxied route whose cache outlives that keeps paying for rotations it does
   * not need (2026-09-27: 94% of the prompt was still cached after a 10-minute
   * gap, and every such rotation costs the seat its working context).
   */
  defaultStaleAfterMs?: number;
  /**
   * `mesh.runtime.providers` and the settings that go with them, for the native runtime. Absent when the mesh declares no
   * provider and runs no seat on `native`.
   */
  native?: NativeRuntimeSpec;
  /**
   * `mesh.runtime.isolate_host`: seats run without the launching machine's Claude
   * settings and without an outer session's environment. Absent means off, which is
   * how every mesh has behaved.
   */
  isolateHost?: boolean;
  /**
   * Mesh-wide thinking variant, held for a runtime that reads it. Nothing does
   * today: it was the opencode knob, and it never inherited onto seats that
   * leave `variant` blank. Setting it is surfaced as a config warning.
   */
  defaultVariant?: string;
  startupActivate: string[];
  /**
   * Non-fatal configuration problems (currently: transition gates naming an
   * actor no agent can play). Surfaced by `curule validate` so a mesh that will
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
    /** 0..1 share of cache-read tokens billed per turn. See RawMeshFile.budgets. */
    cacheReadWeight: number;
  };
  bus: {
    /** How an outstanding ask may leave the ledger. See RawMeshFile.bus. */
    commitmentSemantic: "compat" | "strict";
    /**
     * Whether an ask with no contract is held to its type's. See
     * RawMeshFile.bus.commitments.by_type. A plain `false` rather than an
     * absent field: every consumer asks `=== true`, and `false` is byte for
     * byte the behaviour of every mesh written before the key existed.
     */
    contractsByType: boolean;
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
    /**
     * `bus.commitments.min_default_ms`: the floor on an `ifUnanswered.afterMs`.
     * Absent means "derive it from this mesh's own delivery window and sweep",
     * which only the supervisor can do; a number, including 0, is the operator's.
     */
    commitmentDefaultFloorMs?: number;
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
    deliveryClasses?: { coalesceMs: number; interruptCostTokens: number; attentionTokens?: number; congestionEvery?: number };
    /**
     * The style this bus was written as, or ABSENT when none was named. See
     * RawMeshFile.bus.style.
     *
     * Kept even though it decides nothing here: by this point the style has
     * already been expanded into the keys above, and a mesh that wrote those
     * keys by hand is indistinguishable from one that named the style. What
     * this records is that the operator CHOSE, which is a different fact from
     * the values, and the only one a prompt can honestly repeat back to a
     * seat.
     */
    style?: "high-contact" | "balanced" | "low-contact";
  };
  /**
   * Always present, never absent — the one resolved block in this file that
   * does not keep the "absent means no regime" shape, because the regime is ON
   * and an operator who wants the old brief has to say so. See
   * `RawMeshFile.mesh.messages` for why.
   */
  messages: {
    /** `mesh.messages.digest_threshold`, or 10. 0 disables the digest. */
    digestThreshold: number;
    /** `mesh.messages.inform_expiry_ms`, or 90 minutes. 0 disables expiry. */
    informExpiryMs: number;
    /**
     * `mesh.messages.max_sends_per_turn`, or 5. 0 disables the budget.
     *
     * Defaulted ON like the two above, and for the same measured reason: the
     * run this was built against sent 282 messages over 53 turns (5.3 a turn)
     * and buried one mailbox with 42% of them, so a rationing key that has to
     * be discovered before it does anything buys nothing on the next such run.
     */
    maxSendsPerTurn: number;
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
     * How long the mesh must be quiet before `Scheduler.checkIdle` declares it
     * idle, defaulting to 30000. `0` restores the old edge-triggered behaviour
     * (declare on the instant the queue and the running map are both empty).
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

/** One entry of `mesh.runtime.providers`, as written. */
export interface RawProvider {
  kind: "openai-compatible" | "anthropic";
  base_url?: string;
  /** The environment variable the key is read from. A key is never written in mesh.yaml. */
  api_key_env?: string;
  headers?: Record<string, string>;
  auth_header?: "x-api-key" | "bearer";
  max_tokens_field?: "max_tokens" | "max_completion_tokens";
  stream_usage?: boolean;
  effort_field?: string | false;
  default_max_output_tokens?: number;
  context_window?: number;
  cache_ttl_ms?: number;
  idle_timeout_ms?: number;
  max_retries?: number;
}

export interface RawModelSettings {
  context_window?: number;
  max_output_tokens?: number;
  effort?: "low" | "medium" | "high";
  temperature?: number;
}

/** A provider as the native runtime is configured with it. */
export interface NativeProviderSpec {
  kind: "openai-compatible" | "anthropic";
  baseUrl?: string;
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  authHeader?: "x-api-key" | "bearer";
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  streamUsage?: boolean;
  effortField?: string | false;
  defaultMaxOutputTokens?: number;
  contextWindow?: number;
  cacheTtlMs?: number;
  idleTimeoutMs?: number;
  maxRetries?: number;
}

export interface NativeModelSpec {
  contextWindow?: number;
  maxOutputTokens?: number;
  effort?: "low" | "medium" | "high";
  temperature?: number;
}

/** `mesh.runtime.providers` and what goes with it, resolved. Present when the mesh declares providers or runs a seat on `native`. */
export interface NativeRuntimeSpec {
  providers: Record<string, NativeProviderSpec>;
  defaultProvider?: string;
  models: Record<string, NativeModelSpec>;
  designer: "claude" | "native";
  designerModel?: string;
  shellEnv?: "inherit" | "minimal";
  /** Absolute. */
  extraReadRoots: string[];
  maxSteps?: number;
}

/**
 * `mesh.runtime.providers` and the rest of the native runtime's settings, checked and resolved.
 *
 * The checks that would otherwise surface on a seat's first turn, long after the mesh looked healthy, are made here: a
 * provider that cannot be reached without a base URL, a default that names nothing, and every seat on `native` whose model
 * cannot be placed. A key that is not set in the environment is NOT an error here, since a config is read in places the
 * secret is not; the server says so at boot.
 */
function resolveNativeRuntime(
  raw: RawMeshFile,
  dir: string,
  agentIds: string[],
  defaultRuntime: string,
  errors: string[],
  warnings: string[],
): NativeRuntimeSpec | undefined {
  const rt = raw.mesh.runtime;
  const nativeSeats = agentIds.filter((id) => (raw.agents[id].runtime ?? defaultRuntime) === "native");
  const providersRaw = rt?.providers ?? {};
  const names = Object.keys(providersRaw);
  const designer = rt?.designer ?? (defaultRuntime === "native" ? "native" : "claude");
  if (names.length === 0 && nativeSeats.length === 0 && designer !== "native" && !rt?.models && !rt?.native) return undefined;

  const providers: Record<string, NativeProviderSpec> = {};
  for (const [name, p] of Object.entries(providersRaw)) {
    const at = `mesh.runtime.providers.${name}`;
    if (p.kind === "openai-compatible" && !p.base_url) {
      errors.push(`${at}: kind openai-compatible needs base_url (for example https://api.openai.com/v1)`);
    }
    if (p.base_url) {
      let url: URL | undefined;
      try {
        url = new URL(p.base_url);
      } catch {
        errors.push(`${at}.base_url '${p.base_url}' is not a URL`);
      }
      if (url && url.protocol !== "http:" && url.protocol !== "https:") errors.push(`${at}.base_url must be an http or https URL`);
      else if (url && url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname) && p.api_key_env) {
        warnings.push(`${at} sends its API key over plain http to ${url.hostname}; use https unless the network between is yours`);
      }
    }
    if (p.api_key_env === undefined && p.kind === "anthropic") {
      warnings.push(`${at} names no api_key_env, so its requests carry no API key`);
    }
    providers[name] = {
      kind: p.kind,
      ...(p.base_url ? { baseUrl: p.base_url } : {}),
      ...(p.api_key_env ? { apiKeyEnv: p.api_key_env } : {}),
      ...(p.headers ? { headers: p.headers } : {}),
      ...(p.auth_header ? { authHeader: p.auth_header } : {}),
      ...(p.max_tokens_field ? { maxTokensField: p.max_tokens_field } : {}),
      ...(p.stream_usage !== undefined ? { streamUsage: p.stream_usage } : {}),
      ...(p.effort_field !== undefined ? { effortField: p.effort_field } : {}),
      ...(p.default_max_output_tokens ? { defaultMaxOutputTokens: p.default_max_output_tokens } : {}),
      ...(p.context_window ? { contextWindow: p.context_window } : {}),
      ...(p.cache_ttl_ms ? { cacheTtlMs: p.cache_ttl_ms } : {}),
      ...(p.idle_timeout_ms ? { idleTimeoutMs: p.idle_timeout_ms } : {}),
      ...(p.max_retries !== undefined ? { maxRetries: p.max_retries } : {}),
    };
  }
  if (rt?.default_provider && !names.includes(rt.default_provider)) {
    errors.push(`mesh.runtime.default_provider '${rt.default_provider}' names no provider; the providers are ${names.join(", ") || "none"}`);
  }
  const defaults = { provider: rt?.default_provider, model: rt?.model?.trim() || undefined };
  for (const id of nativeSeats) {
    try {
      resolveProviderModel(raw.agents[id].model, `agents.${id}`, names, defaults);
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  if (designer === "native") {
    try {
      resolveProviderModel(rt?.designer_model, "the designer (mesh.runtime.designer)", names, defaults);
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  const models: Record<string, NativeModelSpec> = {};
  for (const [id, m] of Object.entries(rt?.models ?? {})) {
    models[id] = {
      ...(m.context_window ? { contextWindow: m.context_window } : {}),
      ...(m.max_output_tokens ? { maxOutputTokens: m.max_output_tokens } : {}),
      ...(m.effort ? { effort: m.effort } : {}),
      ...(m.temperature !== undefined ? { temperature: m.temperature } : {}),
    };
  }
  return {
    providers,
    ...(rt?.default_provider ? { defaultProvider: rt.default_provider } : {}),
    models,
    designer,
    ...(rt?.designer_model ? { designerModel: rt.designer_model } : {}),
    ...(rt?.native?.shell_env ? { shellEnv: rt.native.shell_env } : {}),
    extraReadRoots: (rt?.native?.extra_read_roots ?? []).map((r) => path.resolve(dir, r)),
    ...(rt?.native?.max_steps ? { maxSteps: rt.native.max_steps } : {}),
  };
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

type RawBus = NonNullable<RawMeshFile["bus"]>;

/**
 * What each `bus.style` expands to, written in the SAME raw shape an operator
 * would have typed.
 *
 * Deliberately raw rather than resolved. Every absent-vs-zero-vs-present
 * distinction in this file is decided by the resolvers below, on raw input,
 * and a style that produced resolved values would be a second path into those
 * decisions — the one place where `deliveryClasses` could become present
 * without `classes: true`, or `commitmentTtl` could exist as `{ defaultMs: 0 }`.
 * Expanding to raw keys means a style cannot reach a state a hand-written
 * mesh.yaml cannot, and `tests/config` can assert exactly that by resolving
 * both and comparing.
 *
 * "high-contact" is `{}` on purpose, and that is the honest encoding: the
 * absence of every key in this block IS the high-contact mesh. Giving it
 * explicit false-y values would be worse than useless, because `classes: false`
 * and silence are the same state and writing one of them would suggest they
 * are not.
 */
const BUS_STYLES: Record<NonNullable<RawBus["style"]>, RawBus> = {
  "high-contact": {},
  balanced: {
    commitments: { ttl_ms: 1_800_000 },
    delivery: { classes: true },
  },
  "low-contact": {
    // Shorter than balanced's, not longer, which looks backwards until you
    // notice what else is on: nobody is nudging this ask, so the deadline is
    // the ONLY thing that ends it. A long deadline on a mesh that does not
    // chase is not patience, it is a debt the ledger carries silently for
    // half an hour. `by_type` is what makes the ending legible — the refusal
    // is drawn from a closed set, so an operator can count why asks ended
    // without reading prose.
    commitments: { ttl_ms: 900_000, by_type: true },
    delivery: {
      classes: true,
      coalesce_ms: 300_000,
      attention_tokens: 200_000,
      congestion_every: 4,
    },
    vocabulary: "contracts",
    collab: { box_ms: 600_000, max_exchanges: 10 },
  },
};

/**
 * Fold `bus.style` into the raw bus block, with anything written explicitly
 * beside it winning.
 *
 * The merge is one level deep into the three nested blocks and no deeper,
 * because that is exactly how deep the schema goes. Per-KEY override inside
 * `delivery` is the point rather than an accident: `style: low-contact` with
 * `delivery: { coalesce_ms: 30000 }` should keep the attention price and the
 * congestion curve and just narrow the window, which a whole-block override
 * would silently discard.
 */
export function applyBusStyle(bus: RawBus | undefined): RawBus | undefined {
  const style = bus?.style;
  if (!style) return bus;
  const preset = BUS_STYLES[style];
  return {
    ...preset,
    ...bus,
    ...(preset.commitments || bus.commitments
      ? { commitments: { ...preset.commitments, ...bus.commitments } }
      : {}),
    ...(preset.delivery || bus.delivery ? { delivery: { ...preset.delivery, ...bus.delivery } } : {}),
    ...(preset.collab || bus.collab ? { collab: { ...preset.collab, ...bus.collab } } : {}),
  };
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
): { coalesceMs: number; interruptCostTokens: number; attentionTokens?: number; congestionEvery?: number } | undefined {
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
  // Absent stays absent, same discipline as `attentionTokens`: the flat
  // tariff is what every mesh that wrote this block already has, and a
  // default here would re-price every existing interrupt. A divisor below 1
  // is not a slower curve, it is a division by zero or a surcharge on an
  // empty box, so it is read as "not configured" rather than clamped -- the
  // operator asked for something incoherent and gets the documented default.
  const congestionEvery =
    delivery.congestion_every !== undefined && delivery.congestion_every >= 1
      ? Math.floor(delivery.congestion_every)
      : undefined;
  return { coalesceMs, interruptCostTokens, attentionTokens, congestionEvery };
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

/**
 * Suggested digest threshold: the point at which a mailbox stops being read
 * one message at a time. Ten is roughly the number of messages a turn can
 * render before the brief's mail section is larger than everything else in it.
 */
export const DEFAULT_DIGEST_THRESHOLD = 10;

/**
 * Suggested inform age: ninety minutes.
 *
 * Chosen against the measured shape of a stalled mission rather than for
 * tidiness. A plain INFORM that nobody has read in ninety minutes is not
 * pending news, it is a restatement -- in the live run this was built for, 145
 * unread messages produced 18 merged patches and no criterion movement, and
 * the informative half of that traffic was three quarters of it. An ask is
 * never expired at any age, so nothing that is waiting on an answer can be
 * aged out of the brief.
 */
export const DEFAULT_INFORM_EXPIRY_MS = 90 * 60_000;

/**
 * The knob's floor, in the style of `mesh.runtime.stale_after_ms`'s 60000.
 *
 * Checked here rather than in the JSON schema so the operator gets a sentence
 * instead of `must match a schema in anyOf`. The schema still refuses the
 * shapes a sentence cannot help with -- a negative, a float, a string -- and
 * this refuses the one that is a unit typo.
 */
export const MIN_INFORM_EXPIRY_MS = 60_000;

/**
 * Suggested per-turn send budget: five messages.
 *
 * Chosen from the evidence, not for roundness. The 2026-09-27 run sent 282
 * messages across 53 turns — 5.3 a turn — and 42% of the day's traffic went to
 * one seat, which is what buried it. Five is that average, so an ordinary turn
 * is untouched and the budget bites on the burst: the seat that answers six
 * colleagues in one turn, which is the shape that produced the pile-up. The
 * mailbox-level keys (`digest_threshold`, `inform_expiry_ms`) already make a
 * full box cheap to READ; this is the only one that stops it filling.
 *
 * A budget below the messages a turn genuinely owes would make the exit queue
 * wait, not the chatter: an ask is never held (`Supervisor.mergeableSend`),
 * and `validate` refuses nothing here, so a mesh that wants a tighter leash
 * writes a smaller number and one that wants none writes 0.
 */
export const DEFAULT_MAX_SENDS_PER_TURN = 5;

/**
 * `mesh.messages`, resolved with all three keys defaulted ON.
 *
 * Absent is not a regime here: a mesh that never writes this block gets the
 * digest, the expiry and the send budget, which is the point. `0` is how an
 * operator restores the pre-digest brief, per key.
 */
export function resolveMessages(
  messages: RawMeshFile["mesh"]["messages"],
): { digestThreshold: number; informExpiryMs: number; maxSendsPerTurn: number } {
  const rawThreshold = messages?.digest_threshold;
  const rawExpiry = messages?.inform_expiry_ms;
  const rawBudget = messages?.max_sends_per_turn;
  const digestThreshold =
    rawThreshold !== undefined && rawThreshold >= 0 ? Math.floor(rawThreshold) : DEFAULT_DIGEST_THRESHOLD;
  const informExpiryMs =
    rawExpiry !== undefined && rawExpiry >= 0 ? Math.floor(rawExpiry) : DEFAULT_INFORM_EXPIRY_MS;
  const maxSendsPerTurn =
    rawBudget !== undefined && rawBudget >= 0 ? Math.floor(rawBudget) : DEFAULT_MAX_SENDS_PER_TURN;
  return { digestThreshold, informExpiryMs, maxSendsPerTurn };
}

/** The sentence an operator gets for a sub-minute `inform_expiry_ms`. Empty when the value is fine. */
export function validateMessages(messages: RawMeshFile["mesh"]["messages"]): string[] {
  const raw = messages?.inform_expiry_ms;
  if (raw === undefined || raw === 0 || raw >= MIN_INFORM_EXPIRY_MS) return [];
  return [
    `mesh.messages.inform_expiry_ms: ${raw} is not an age anyone means — write 0 to disable expiry, ` +
      `or at least ${MIN_INFORM_EXPIRY_MS} (a minute). Anything shorter is seconds where milliseconds belong.`,
  ];
}

function buildResolved(raw: RawMeshFile, dir: string): ResolvedMeshConfig {
  const errors: string[] = [];
  const configWarnings: string[] = [];

  const agentIds = Object.keys(raw.agents);
  if (agentIds.length === 0) errors.push("at least one agent must be defined");
  // The schema has already refused anything that is not a non-negative
  // integer; this is the floor the schema cannot express as a sentence.
  errors.push(...validateMessages(raw.mesh.messages));

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
  const native = resolveNativeRuntime(raw, dir, agentIds, defaultRuntime, errors, configWarnings);
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
      // Not `?? mesh.runtime.context_window`: see AgentDefinition.contextWindow.
      contextWindow: a.context_window,
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
      //
      // `mail` is carried only when declared, for the same reason one level
      // down: its absence already means `"full"`, and an explicit `mail:
      // undefined` is a key a deep-equal would see.
      ...(a.wake
        ? {
            wake: {
              deferNonObliging: a.wake.defer_non_obliging ?? false,
              ...(a.wake.mail !== undefined ? { mail: a.wake.mail } : {}),
              // Carried only when non-empty, for the reason the block above
              // gives: an empty list and an absent one mute the same nothing,
              // and materialising `notFor: []` would change every resolved
              // definition a fixture deep-equals to say it.
              ...(a.wake.not_for?.length ? { notFor: [...a.wake.not_for] } : {}),
            },
          }
        : {}),
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
  // Syntax, not reachability: `|` is new, so a malformed alternative is always
  // a typo rather than a deliberate placeholder, and it is refused here rather
  // than warned about below. Plain tokens keep their existing (warning-level)
  // treatment in `validateTransitionGateActors`.
  errors.push(...validateTransitionGateSyntax(raw.policies?.transitions ?? {}));
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
  for (const w of warnMergeWithoutRepair(Object.values(agents))) {
    configWarnings.push(w);
  }
  for (const w of warnUnacceptableCriteria(
    Object.values(agents),
    raw.mesh.acceptance_criteria ?? null,
    raw.mesh.generate_acceptance_criteria ?? false,
  )) {
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
  for (const w of warnRemovedTransport(raw.bus)) {
    configWarnings.push(w);
  }
  for (const w of warnInertAgentBudgetCaps(Object.values(agents))) {
    configWarnings.push(w);
  }
  for (const w of warnInertInboundContact(Object.values(agents), communication)) {
    configWarnings.push(w);
  }
  for (const w of warnUnreachableMissionCap(Object.values(agents), raw.budgets)) {
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
  for (const w of warnAuthorityStrippingRules(raw.policies?.rules ?? [], Object.values(agents))) {
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
    defaultContextWindow: raw.mesh.runtime?.context_window,
    defaultStaleAfterMs: raw.mesh.runtime?.stale_after_ms,
    ...(native ? { native } : {}),
    ...(raw.mesh.runtime?.isolate_host === true ? { isolateHost: true } : {}),
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
    // Expanded ONCE, here, so that every resolver below reads the same raw
    // block an operator would have written by hand and none of them has to
    // know styles exist.
    bus: ((bus) => ({
      commitmentSemantic: bus?.commitments?.semantic ?? "strict",
      contractsByType: bus?.commitments?.by_type === true,
      // Defaults to "no deadline" on purpose. Expiry closes asks that would
      // otherwise stay open, so turning it on is a behaviour change an
      // operator should choose for a mission, not inherit from an upgrade.
      commitmentTtl: resolveCommitmentTtl(bus?.commitments),
      ...(typeof bus?.commitments?.min_default_ms === "number" && Number.isFinite(bus.commitments.min_default_ms) && bus.commitments.min_default_ms >= 0
        ? { commitmentDefaultFloorMs: bus.commitments.min_default_ms }
        : {}),
      // Absent by default, like `commitmentTtl` and `deliveryClasses`: this
      // one changes the tool list a model is shown, so it is opted into per
      // mesh rather than inherited from an upgrade.
      vocabulary: resolveBusVocabulary(bus?.vocabulary),
      collab: resolveCollabBox(bus?.collab),
      // Absent by default, like `commitmentTtl` and for the same reason: this
      // one re-routes wakes and bills sends, so it is opted into per mesh.
      deliveryClasses: resolveDeliveryClasses(bus?.delivery),
      // Carried verbatim, and absent when no style was named. Nothing in the
      // runtime branches on it to decide BEHAVIOUR — the expansion already
      // did that, into the keys above — but the prompt renderer tells a seat
      // when it is in a mesh that has stopped chasing it, which it cannot
      // infer from a coalescing window.
      ...(raw.bus?.style ? { style: raw.bus.style } : {}),
    }))(applyBusStyle(raw.bus)),
    // Defaulted ON rather than absent-when-unset: see `resolveMessages`.
    messages: resolveMessages(raw.mesh.messages),
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
      cacheReadWeight: Math.min(1, Math.max(0, raw.budgets?.cache_read_weight ?? 0)),
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
      // Post-first-token silence means a frozen stream, not slow thinking.
      //
      // FLAT, and no longer derived from `turn_timeout_ms`. The old derivation
      // (`min(120s, max(60s, timeout/2))`) had the coupling backwards: a mesh
      // that raised its turn timeout because its turns do long work got a
      // TIGHTER silence floor, not a looser one. With `turn_timeout_ms:
      // 1200000` it pinned the floor at its 120s cap, and one live run lost ten
      // turns to it — 45 minutes of generation — every one of them a seat that
      // narrated early and then worked quietly.
      //
      // The old comment's real argument was that half-a-long-timeout pushes
      // detection out to ten minutes, by which point the stall is a human
      // escalation. That argument survives a flat five minutes, which is longer
      // than any quiet stretch a healthy turn showed and far short of ten.
      // Overridable per mesh via turn_silence_ms.
      turnSilenceMs: raw.scheduling?.timeouts?.turn_silence_ms ?? 300000,
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
 * A seat that can land a merge but cannot clean up after one.
 *
 * `git.merge` merges a branch into the product tree. When the merge leaves the
 * tree needing a fix — a stray lockfile, a workspace file that has to be
 * removed and regenerated — the merging seat needs `repository.write` to do it
 * and `test.execute` to confirm the result. Without them it can only describe
 * the problem in the merge commit and move on.
 *
 * That is not hypothetical. In a live run the architect held `git.merge` with
 * `repository.read` only, merged a UI patch carrying its own
 * `pnpm-workspace.yaml` and `pnpm-lock.yaml`, and wrote into the commit message
 * that both had to be removed and the root lockfile regenerated before
 * `pnpm -r typecheck` could be trusted — and that it could not do either. The
 * modified lockfile left the worktree dirty, `git merge` refuses to run over
 * uncommitted changes, and the NEXT merge failed for that reason. One seat
 * without the repair capabilities poisoned the tree for every merge after it.
 *
 * A warning, not an error: a mesh may deliberately separate landing from
 * repairing, and some fixtures do.
 */
export function warnMergeWithoutRepair(agents: AgentDefinition[]): string[] {
  const warnings: string[] = [];
  for (const agent of agents) {
    const caps = agent.capabilities ?? [];
    if (!caps.includes("git.merge")) continue;
    const missing = ["repository.write", "test.execute"].filter((c) => !caps.includes(c));
    if (missing.length === 0) continue;
    const others = agents.filter((a) => a.id !== agent.id && (a.capabilities ?? []).includes("repository.write")).map((a) => a.id);
    warnings.push(
      `agent '${agent.id}' holds 'git.merge' but not ${missing.map((m) => `'${m}'`).join(" or ")} — it can land a patch it cannot repair or verify, and a merge that leaves the worktree dirty blocks every merge after it${others.length > 0 ? ` (a seat that can repair: ${others.join(", ")})` : " and no seat in this mesh can repair one"}`,
    );
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
 * A mesh that cannot finish, or can only finish through one seat.
 *
 * `AUTO_EVIDENCED_CRITERIA` is the complete set of criterion ids the runtime
 * closes by itself. Any other mandatory criterion closes exactly one way: a
 * seat issuing `approve subject:"criterion:<id>"`, which the authority layer
 * gates on `requirements.accept` / `requirements.approve`.
 *
 * Nothing said so at load time, and the omission was expensive. One mesh
 * declared seventeen mandatory criteria, none of them auto-evidenced, and ran
 * for hours: every gate downstream of completion stayed shut, the goal never
 * converged, and the only symptom an operator could see was spend. The
 * completion story is a static property of the config, so it belongs here.
 *
 * Two tiers, because there are two different mistakes:
 *
 *  - **No seat holds either token.** The criteria can never close. A hard
 *    deadlock, and always worth a warning.
 *  - **One seat holds a token and owes more than a handful of ops.** Reachable,
 *    but the whole mission's completion rests on one seat choosing to issue N
 *    explicit ops — and in the measured run that seat issued zero of three.
 *    Worth naming, with the op, so the operator can check that seat's prompt
 *    actually asks for it.
 *
 * Two seats or more is not warned: that is a mesh with redundancy, and warning it
 * would make the check noise. Nor is a single holder owing a small number of ops,
 * which is ordinary design rather than a risk — `MANUAL_LOAD_WARN_ABOVE` is a
 * noise threshold calibrated to the measured failure (seventeen), not a rule
 * derived from anything. It exists because the first version of this check fired
 * on every two-seat mesh in the test suite, and a warning that fires on correct
 * configs is one nobody reads on the config that is actually broken.
 *
 * An absent `acceptance_criteria` list is NOT exempt, and that turned out to be
 * the common case rather than an edge one. A mesh declaring none inherits
 * `DEFAULT_CRITERIA`, whose `requirements-documented` is mandatory and is not
 * auto-evidenced — nothing in the runtime closes it. `examples/greenfield` was
 * shipped in exactly that state with no `requirements.*` holder among its three
 * seats, so returning `[]` on a null list would have hidden the very defect this
 * check was written for.
 *
 * Generated criteria do not exist yet at load time, so there are no ids to name
 * and no count to weigh — but the no-holder tier does not need either. A
 * generated id is a free-form slug, never one of `AUTO_EVIDENCED_CRITERIA`, and
 * a generator that fails or answers nothing falls back to `DEFAULT_CRITERIA`,
 * whose `requirements-documented` needs the same token. So whatever the model
 * writes, a mesh with no `requirements.*` holder cannot finish, and that is
 * said at load. Only the one-holder tier is skipped: its threshold is a count
 * nobody has until the model answers.
 */
/**
 * Above how many manually-accepted mandatory criteria a lone holder is worth a
 * warning. A noise threshold, not a rule — see `warnUnacceptableCriteria`.
 */
export const MANUAL_LOAD_WARN_ABOVE = 3;

export function warnUnacceptableCriteria(
  agents: AgentDefinition[],
  criteria: Array<{ id: string; description: string; mandatory?: boolean }> | null,
  generated = false,
): string[] {
  const holders = agents
    .filter((a) => a.authority.some((t) => t === "*" || t === "requirements.*" || t === "requirements.accept" || t === "requirements.approve"))
    .map((a) => a.id);

  if (generated && (!criteria || criteria.length === 0)) {
    if (holders.length > 0) return [];
    return [
      `the mandatory criteria this mesh generates at mission start can never be satisfied — generated ids are not auto-evidenced by the runtime, and a failed generation falls back to the built-in defaults, whose 'requirements-documented' is not either, so every one closes only via \`approve subject:"criterion:<id>"\`, and no agent holds 'requirements.accept' or 'requirements.approve'. The goal cannot reach completion. Grant one of those tokens to the seat that owns acceptance.`,
    ];
  }
  const effective = criteria && criteria.length > 0 ? criteria : DEFAULT_CRITERIA;
  // `mandatory ?? true` mirrors the resolver at the `goalCriteria` mapping: an
  // omitted `mandatory` means mandatory. Reading it as falsy instead made this
  // check silently miss `examples/greenfield`, whose criteria all omit the key.
  const manual = effective
    .filter((c) => (c.mandatory ?? true) && c.id && !AUTO_EVIDENCED_CRITERIA.includes(c.id))
    .map((c) => c.id!);
  if (manual.length === 0) return [];

  // Long lists are elided: the point is the shape, and a warning nobody reads
  // to the end names nothing.
  const shown = manual.length > 6 ? `${manual.slice(0, 6).join(", ")}, +${manual.length - 6} more` : manual.join(", ");
  const one = manual.length === 1;
  const count = `${manual.length} mandatory ${one ? "criterion" : "criteria"}`;
  const source = criteria && criteria.length > 0 ? "" : " (inherited from the built-in defaults, since this mesh declares none)";

  if (holders.length === 0) {
    return [
      `${count}${source} can never be satisfied (${shown}) — ${one ? "it is" : "they are"} not auto-evidenced by the runtime, so ${one ? "it closes" : "they close"} only via \`approve subject:"criterion:<id>"\`, and no agent holds 'requirements.accept' or 'requirements.approve'. The goal cannot reach completion. Grant one of those tokens to the seat that owns acceptance.`,
    ];
  }
  if (holders.length === 1 && manual.length > MANUAL_LOAD_WARN_ABOVE) {
    return [
      `${count}${source} ${one ? "closes" : "close"} only by explicit op (${shown}) — not auto-evidenced, so each needs \`approve subject:"criterion:<id>"\`, and '${holders[0]}' is the only seat that may issue one. Mission completion rests entirely on that seat: check its role prompt names the criteria and the op, or the mesh will run to budget without ever converging.`,
    ];
  }
  return [];
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
/**
 * Two of the four keys under a seat's `budget:` are resolved and enforced by
 * nothing.
 *
 * `tokens` becomes a real ledger line (`BudgetManager.declare`) and
 * `max_activations` is checked by the policy engine. `wall_clock_minutes` and
 * `max_events` are declared for the MISSION ledger and never for an agent one,
 * so nothing reads `definition.budget.wallClockMinutes` or `.maxEvents` and a
 * seat capped at 30 minutes runs as long as the mission does.
 *
 * Warned rather than enforced, and warned rather than dropped, for the same
 * reasons as `variant`: silently starting to terminate seats on a cap that has
 * never bound would change how every existing mesh runs, and the keys sit on
 * `AgentDefinition`, which is persisted in `agent.registered` events. A cap
 * that does not cap should say so out loud rather than only in the docs.
 */
export function warnInertAgentBudgetCaps(agents: AgentDefinition[]): string[] {
  const paths = agents.flatMap((a) => [
    ...(a.budget?.wallClockMinutes !== undefined ? [`agents.${a.id}.budget.wall_clock_minutes`] : []),
    ...(a.budget?.maxEvents !== undefined ? [`agents.${a.id}.budget.max_events`] : []),
  ]);
  if (paths.length === 0) return [];
  return [
    `${paths.join(", ")} ${paths.length === 1 ? "is" : "are"} set but inert — nothing declares a per-agent wall-clock or event ledger, so these caps never bind. Use budgets.mission.wall_clock_minutes / .max_events, which are enforced, or cap the seat with budget.tokens`,
  ];
}

/**
 * `may_be_contacted_by` reads like an inbound allow-list and cannot deny anything.
 *
 * `communicationAllows` is a chain of `return true` grants ending in a single
 * `return false`, so the key only ever ADDS a route: contact is decided by the
 * SENDER's `may_contact` just as much, and whichever fires first wins. A seat that
 * declares `may_be_contacted_by: [pm]` expecting to hear from pm alone still hears
 * from every seat whose own `may_contact` names it, and nothing said so — the key
 * validates (unknown ids are already an error), the mesh boots, and the intent is
 * silently discarded.
 *
 * Warned only when the list is non-empty AND someone outside it gets through
 * anyway: that is the case where the declaration is actively misleading rather
 * than merely redundant. An empty list is the normal way to write "no extra
 * grants" and says nothing about restriction, so it is not warned.
 *
 * Not enforced, because making it restrictive would silently reroute every
 * existing mesh that declares one.
 */
export function warnInertInboundContact(
  agents: AgentDefinition[],
  communication: Record<string, { mayContact: string[]; mayBeContactedBy: string[] }>,
): string[] {
  const warnings: string[] = [];
  const roleOf = new Map(agents.map((a) => [a.id, a.role]));
  for (const agent of agents) {
    const declared = communication[agent.id]?.mayBeContactedBy ?? [];
    if (declared.length === 0) continue;
    const role = roleOf.get(agent.id);
    const uninvited = agents
      .filter((other) => other.id !== agent.id)
      .filter((other) => !declared.includes(other.id) && !(other.role !== undefined && declared.includes(other.role)))
      .filter((other) => {
        const out = communication[other.id]?.mayContact ?? [];
        return out.includes(agent.id) || (role !== undefined && out.includes(role));
      })
      .map((other) => other.id);
    if (uninvited.length === 0) continue;
    warnings.push(
      `policies.communication.${agent.id}.may_be_contacted_by lists ${declared.join(", ")} but does not restrict anything — it is an additive grant, never a filter, so ${uninvited.join(", ")} may still open a thread with '${agent.id}' via their own may_contact. Remove the sender's may_contact entry if you meant to block it`,
    );
  }
  return warnings;
}

/**
 * A mission token cap that no run can ever reach.
 *
 * Every halt this mesh can take comes from a per-agent ledger: the 8x auto-raise
 * ladder is anchored to each seat's configured limit, and `agent_budget_exhausted`
 * escalates the whole mission. So when `budgets.mission.tokens` exceeds what every
 * seat could spend at its ceiling combined, the mission line is decoration — it
 * reports a fraction of a percent used while a seat is a quarter of the way to
 * halting everything. Measured 2026-09-24: 120,000,000 declared against 12,640,000
 * reachable, so the dashboard read 0.9% at the moment the run died.
 *
 * Compared against the ladder rather than the base limits because the ladder is
 * what actually bounds a seat; with auto-raise off, the base limits are the bound.
 *
 * A cap merely ABOVE the reachable total is a sane backstop and is not warned —
 * that is the ordinary shape, including the test fixtures and every shipped
 * example. Only a cap so far above it that it can never be informative trips this.
 */
export const MISSION_CAP_WARN_MULTIPLE = 5;

export function warnUnreachableMissionCap(
  agents: AgentDefinition[],
  budgets: { mission?: { tokens?: number }; auto_raise?: { enabled?: boolean; max_multiple?: number } } | undefined,
): string[] {
  const missionTokens = budgets?.mission?.tokens;
  if (missionTokens === undefined || missionTokens <= 0) return [];
  const autoRaiseOn = budgets?.auto_raise?.enabled ?? true;
  const multiple = autoRaiseOn ? Math.max(1, budgets?.auto_raise?.max_multiple ?? 8) : 1;
  const base = agents.reduce((sum, a) => sum + (a.budget?.tokens ?? 0), 0);
  if (base <= 0) return [];
  const reachable = base * multiple;
  if (missionTokens <= reachable * MISSION_CAP_WARN_MULTIPLE) return [];
  return [
    `budgets.mission.tokens is ${missionTokens.toLocaleString("en-US")} but no run can reach it — every seat at its ${autoRaiseOn ? `${multiple}x auto-raise ceiling` : "configured limit (auto-raise is off)"} sums to ${reachable.toLocaleString("en-US")}, and a mission halts on the first per-agent exhaustion. The mission bar will read under ${Math.max(1, Math.round((reachable / missionTokens) * 100))}% for the whole run. Lower it to about ${reachable.toLocaleString("en-US")}, or raise the per-seat budgets that actually bind`,
  ];
}

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
 * `bus.transport` chose whether prose-parsed ops executed. There are no prose
 * ops any more — a seat acts only through MCP `mesh_*` tool calls — so the key
 * is read by nothing. Warned rather than rejected, for the same reason as
 * `warnInertActivationKeys`: the bus block is `additionalProperties: false`,
 * and dropping the property would turn every mesh that set it into a load
 * error over a key that no longer changes anything.
 */
export function warnRemovedTransport(bus: RawBus | undefined): string[] {
  if (bus?.transport === undefined) return [];
  return [
    `bus.transport (${JSON.stringify(bus.transport)}) was removed and is ignored — ops are MCP-only: a seat acts through mesh_* tool calls, and fenced ops blocks in prose are never parsed. Remove the key`,
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
 * would turn every config that sets it — including everything `curule init` has
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
 * key is editable in the designer any more, and `curule init` writes neither.
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
 * A `deny.capabilities` rule that also strips an **authority** from a seat that
 * holds one.
 *
 * `evaluateAuthority` denies a *held* authority whenever the matched rule names
 * any capability, because there is no `when.authority` clause for the check to
 * compare against: an authority matches on actor and role alone, so the rule's
 * capability denial is simply applied to it. The denial is deliberate and stays
 * (removing it would widen a permission, not tidy one). What it must not stay is
 * *invisible*.
 *
 * It is invisible today because the two halves live in different files, and
 * because the effect is asymmetric: the op path asks the engine
 * (`recordDecision`, `ratifyDecision`, `reviseGoalDescription`, …) and loses the
 * sign-off, while a sign-off recorded from a **message** goes through
 * `holdsAuthority` in the reducer, which consults no rules and still honours it.
 * An operator who writes `when: { actor_role: tech-lead }, deny: {
 * capabilities: [git.merge] }` gets a lead who cannot merge *and* cannot approve
 * a design — the second, unasked-for, presenting as a mission stalled at the
 * design gate with nothing in the log to explain it.
 *
 * Ported from `matchRule` rather than from intuition, because the clauses that
 * scope an authority check are not the ones a reader expects:
 *   - `when.actor` / `when.actor_role` scope it (an exact id and a role compare);
 *   - `when.to` **does not match at all** — an authority check addresses nobody,
 *     and `matchRule` fails `to` closed, so such a rule is exempt here;
 *   - `when.message_type` / `when.capability` **do not scope it either** — both
 *     compare only when the match carries one, and an authority check carries
 *     neither, so a rule "scoped" to `git.merge` still lands on a held authority
 *     for every seat its actor clause names.
 *
 * A warning, not an error: every config in this repo and every fixture is
 * unaffected (all three shipped `deny.capabilities` rules name seats that declare
 * no authority, so the branch cannot fire), and refusing to boot over a trap that
 * has not sprung would be a cost with no safety behind it — the inverse of the
 * `when.event` case, where removing the clause changed what the rule denied.
 */
export function warnAuthorityStrippingRules(rules: RawPolicyRule[], agents: AgentDefinition[]): string[] {
  const warnings: string[] = [];
  for (const r of rules) {
    const denied = r.deny?.capabilities ?? [];
    if (denied.length === 0) continue;
    const when = (r.when as { actor?: unknown; actor_role?: unknown; to?: unknown } | undefined) ?? {};
    // `to` is the one clause that makes the rule unreachable for an authority
    // check, because that check carries no recipients.
    if (when.to !== undefined) continue;
    // The human seat holds `*` by design and never reaches the check.
    const caught = agents.filter(
      (a) =>
        a.id !== "human" &&
        a.authority.length > 0 &&
        (when.actor === undefined || when.actor === a.id) &&
        (when.actor_role === undefined || when.actor_role === a.role),
    );
    if (caught.length === 0) continue;
    // One warning per rule, naming every seat it catches, for the reason
    // `warnInertRuleContact` aggregates: a rule reaching three authority holders
    // is one mistake to go and fix, and three near-identical lines is how an
    // operator learns to skim the warnings.
    const seats = caught.map((a) => `agents.${a.id} (${a.authority.join(", ")})`).join(", ");
    warnings.push(
      `policy rule '${r.id}' denies ${denied.join(", ")} and also strips authority from ${seats} — an authority check matches on actor and role alone, so those denials land on the op path too (approve, accept, ratify, retire), while a sign-off recorded from a message still honours them. Scope the rule with when.to, or accept the sign-off denial knowingly`,
    );
  }
  return warnings;
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
 * `<actorRole|actorId>.<kind>` (e.g. `tech-lead.approve`, `qa.pass`), or as
 * several such tokens joined by `|` meaning "any ONE of these". If no
 * configured agent can ever produce one of those approvals, the gate is
 * unsatisfiable and every artifact that needs it deadlocks — the mission
 * stalls with no error anywhere. Catch it at load.
 *
 * Each alternative is resolved independently: a requirement that names three
 * seats is unsatisfiable only if all three are unknown, so one reachable
 * alternative is enough.
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
      const alternatives = requirement.split("|").map((part) => part.slice(0, part.lastIndexOf(".")));
      // A requirement where ANY alternative resolves to a known actor can be
      // met, so it is only reported when none do. A malformed entry (empty
      // alternative, no dot) contributes no name and is refused by
      // `validateTransitionGateSyntax` before this runs.
      if (alternatives.some((actor) => actor === "human" || actors.has(actor))) continue;
      if (alternatives.some((actor) => actor !== "")) {
        const named = alternatives.filter((a) => a !== "");
        // Wording is load-bearing for a one-name gate: it is the message
        // operators and fixtures have read since this check existed.
        const who =
          named.length === 1
            ? `no agent or role '${named[0]}' exists`
            : `no agent or role exists for ${named.map((a) => `'${a}'`).join(" or ")}`;
        errors.push(`transition gate '${gate}' requires '${requirement}', but ${who} — the gate can never be satisfied`);
      } else {
        errors.push(`transition gate '${gate}' requirement '${requirement}' must be '<agent-or-role>.<kind>'`);
      }
    }
  }
  return errors;
}

/**
 * Structural validation of a gate requirement that uses `|` alternatives.
 *
 * `"tech-lead.approve|architect.approve"` is one requirement any of the two
 * seats can meet; `"|architect.approve"`, `"tech-lead.approve|"` and `"x.|y.z"`
 * are typos that would silently mean something other than intended — an empty
 * alternative matches nothing and a trailing dot names a kind that is empty.
 * Refused at load, since they can only be mistakes.
 *
 * Plain tokens (no `|`) are left to `validateTransitionGateActors`, which has
 * always reported them as a warning: a gate may legitimately name a role that a
 * larger mesh adds later, and some fixtures assert on a deliberately
 * unsatisfiable gate.
 */
export function validateTransitionGateSyntax(
  transitions: Record<string, { requires?: string[] }>,
): string[] {
  const errors: string[] = [];
  for (const [gate, spec] of Object.entries(transitions)) {
    for (const requirement of spec.requires ?? []) {
      if (!requirement.includes("|")) continue;
      for (const part of requirement.split("|")) {
        const idx = part.lastIndexOf(".");
        if (idx > 0 && idx < part.length - 1) continue;
        errors.push(
          `transition gate '${gate}' requirement '${requirement}' is malformed: each '|'-separated alternative must be '<agent-or-role>.<kind>', but '${part}' is not — write e.g. 'tech-lead.approve|architect.approve'`,
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
  const template = defaultMeshTemplate(meshId, projectId, defaultRuntime);
  // `wx` fails if the file has appeared since the check above: a scaffold never writes over a mesh.yaml, even in a race.
  fs.writeFileSync(target, template, { encoding: "utf8", flag: "wx" });
  materializeRolePrompts(parseMeshSource(template), targetDir);
  return target;
}

/** The mission token budget the default scaffold declares, so a screen can state it without writing the file first. */
export const DEFAULT_SCAFFOLD_MISSION_TOKENS = 2_000_000;

/**
 * A name written into the scaffold: plain when that reads back as the same string, quoted when it would not. The names
 * come from a folder, and a folder may be called `2024` (a number to YAML), `no` (a boolean to some readers) or
 * `acme: payments` (a broken mapping); each used to write a mesh.yaml that failed to load. Ordinary names stay plain.
 */
export function yamlScalar(value: string): string {
  const plain = /^[A-Za-z][A-Za-z0-9 ._-]*$/.test(value) && value === value.trim() && !/^(true|false|yes|no|on|off|null|y|n)$/i.test(value);
  return plain ? value : JSON.stringify(value);
}

/**
 * The text `writeDefaultMeshYaml` writes. A function of its own so that what a caller says about the default team (how
 * many seats, what budget) is read from this text by `describeTemplates` and cannot drift from what the scaffold does.
 */
export function defaultMeshTemplate(meshId: string, projectId: string, defaultRuntime: string): string {
  return `version: 1

project:
  id: ${yamlScalar(projectId)}
  name: ${yamlScalar(meshId)}

mesh:
  id: ${yamlScalar(meshId)}
  name: ${yamlScalar(meshId)}
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
    tokens: ${DEFAULT_SCAFFOLD_MISSION_TOKENS}
    wall_clock_minutes: 240
    max_events: 10000

bus:
  # Which comms vocabulary this mesh advertises to its agents. With
  # "contracts" a seat's tool list is the named asks — mesh_contracts to see
  # them, mesh_call to raise one, mesh_reply to answer one, mesh_discharge to
  # refuse one, mesh_withdraw to take back one you no longer need answered,
  # mesh_announce to say something nobody owes an answer to, and mesh_collab
  # for a bounded discussion — and not one of those tools asks for a message
  # type. Set this to "typed" (or remove the key) for the older
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
    # Hold an ask that named no contract to the one its message type implies.
    # Without this, the eight contracts are decoration a sender may opt into:
    # a bare REQUEST_REVIEW opens a real debt with no refusal vocabulary, no
    # SLA and no answer shape, so the ledger records an obligation it has no
    # way to judge. With it, refusals become a closed set an agent is shown in
    # its own prompt, deadlines follow the type (an info question is not a
    # security review), and a thin answer is marked rather than passing
    # unnoticed — the answer check stays fail-open either way, so nothing is
    # ever held open by it. The request payload is NOT validated; only a
    # contract the sender named is. Set this to false, or remove it, for the
    # older behaviour, which is what meshes written before this key existed
    # keep.
    by_type: true
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
    # How many unread messages in a RECIPIENT's box add one unit to the price
    # of waking them. Without this the tariff is flat: waking an idle seat and
    # waking one that is already eight messages behind cost the same, though
    # the second is the expensive one and the one every sender is most tempted
    # to interrupt. At 4, waking a seat costs the tariff up to 3 unread, twice
    # that at 4-7, and is capped at 4x — a cap, because a sender cannot see
    # inside another mailbox, and a price it cannot predict is a penalty
    # rather than a signal. Remove the key for the flat tariff.
    congestion_every: 4

scheduling:
  mode: event-driven
  concurrency:
    max_active_agents: 4
`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Starting points: what a new project can be made from.
//
// `curule init` and the host's `POST /api/projects` scaffold a project from one of two kinds of template: the default
// team (`writeDefaultMeshYaml`) or an example the install ships under `examples/`. Both live here because the host cannot
// import the CLI (the CLI imports the host), and two copies of "what is a shipped example" would drift.
// ---------------------------------------------------------------------------------------------------------------------

/** What the default team goes by in `describeTemplates` and in `POST /api/projects`. It is not a folder under `examples/`. */
export const DEFAULT_TEMPLATE_ID = "default";

/** The directory that holds `examples/` and `roles/`: the repository root, or `/app` in the image. */
export function findShippedRoot(from: string = __dirname): string | undefined {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "examples")) && fs.existsSync(path.join(dir, "roles"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

/** The shipped examples, by folder name: every directory under `examples/` that holds a `mesh.yaml`. */
export function listExamples(root: string): string[] {
  const dir = path.join(root, "examples");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, "mesh.yaml")))
    .map((e) => e.name)
    .sort();
}

const ROLE_REF = /(\bprompt:\s*)\.\.\/\.\.\/roles\/([A-Za-z0-9_.-]+\.md)\b/g;

/**
 * Copy one example into `targetDir` so that it needs nothing outside it: its `mesh.yaml` with the role prompts it
 * names pointed at a `roles/` beside it, and those files copied there. Refuses a directory that already has a
 * `mesh.yaml`, and an example whose config reaches outside itself in any way this cannot make self-contained.
 *
 * `example` is looked up among the folders that exist, never joined onto a path as given, so whatever a caller passes
 * (a request body, an argument) cannot name a location. A prompt file the folder already holds is kept, not replaced:
 * it is the person's.
 */
export function scaffoldExample(root: string, example: string, targetDir: string): { configPath: string; roles: string[]; kept: string[] } {
  if (!listExamples(root).includes(example)) throw new ConfigError([`no example '${example}' in this install`]);
  const source = path.join(root, "examples", example, "mesh.yaml");
  const target = path.join(targetDir, "mesh.yaml");
  if (fs.existsSync(target)) throw new ConfigError([`${target} already exists`]);
  let text = fs.readFileSync(source, "utf8");
  const roles = new Set<string>();
  text = text.replace(ROLE_REF, (_all, lead: string, file: string) => {
    roles.add(file);
    return `${lead}./roles/${file}`;
  });
  const stray = text.split("\n").filter((line) => /(^|[\s"':])\.\.\//.test(line) && !line.trim().startsWith("#"));
  if (stray.length > 0) {
    throw new ConfigError([`example '${example}' refers outside itself, which a copy cannot carry: ${stray[0]!.trim()}`]);
  }
  for (const file of roles) {
    if (!fs.existsSync(path.join(root, "roles", file))) throw new ConfigError([`example '${example}' names roles/${file}, which this install does not ship`]);
  }
  fs.mkdirSync(path.join(targetDir, "roles"), { recursive: true });
  const kept: string[] = [];
  for (const file of roles) {
    const dest = path.join(targetDir, "roles", file);
    if (fs.existsSync(dest)) {
      kept.push(file);
      continue;
    }
    fs.copyFileSync(path.join(root, "roles", file), dest, fs.constants.COPYFILE_EXCL);
  }
  // The config goes last, and exclusively: if anything above failed there is no half project holding a mesh.yaml.
  fs.writeFileSync(target, text, { encoding: "utf8", flag: "wx" });
  return { configPath: target, roles: [...roles].sort(), kept: kept.sort() };
}

/** What a screen may say about a starting point before it writes anything, read from the template itself. */
export interface TemplateInfo {
  id: string;
  kind: "default" | "example";
  title: string;
  /** The first paragraph of the goal, on one line; null for the default team, whose goal is a placeholder the person writes. */
  goal: string | null;
  seats: number;
  /** The runtime every seat uses, or "mixed". */
  runtime: string;
  /** Some seat runs on something other than the stub runtime, so the host needs a model credential. */
  needsApiKey: boolean;
  /** Prompt files written under `roles/` beside the `mesh.yaml`. */
  rolePrompts: number;
  /** The mission's token budget, when the template declares one. */
  missionTokens: number | null;
  /** The project id the template pins; null when it is derived from the name of the folder it is written to. */
  projectId: string | null;
}

/** The first paragraph of a goal on one line, cut at a word if it is long: a block scalar's first line stops mid-sentence. */
function goalSummary(goal: unknown): string | null {
  const paragraph = String(goal ?? "").trim().split(/\n\s*\n/)[0]!.split("\n").map((l) => l.trim()).filter(Boolean).join(" ");
  if (!paragraph) return null;
  if (paragraph.length <= 160) return paragraph;
  return `${paragraph.slice(0, 157).replace(/\s+\S*$/, "")}...`;
}

function factsOf(id: string, kind: TemplateInfo["kind"], raw: RawMeshFile, rolePrompts: number): TemplateInfo {
  const fallback = raw.mesh.runtime?.default ?? "claude";
  const runtimes = new Set(Object.values(raw.agents ?? {}).map((a) => a.runtime ?? fallback));
  return {
    id,
    kind,
    title: raw.mesh.name ?? raw.mesh.id,
    goal: goalSummary(raw.mesh.goal),
    seats: Object.keys(raw.agents ?? {}).length,
    runtime: runtimes.size === 1 ? [...runtimes][0]! : "mixed",
    needsApiKey: [...runtimes].some((r) => r !== "stub"),
    rolePrompts,
    missionTokens: raw.budgets?.mission?.tokens ?? null,
    projectId: raw.project?.id ?? null,
  };
}

/**
 * The starting points this install offers: the default team, then each shipped example. Facts come from the files, so a
 * new example appears here with the right seat count and the right answer to "does it need an API key" without anyone
 * editing a list. An example that does not parse is not offered.
 */
export function describeTemplates(root: string | undefined): TemplateInfo[] {
  const out: TemplateInfo[] = [];
  // The default team is read from the very text `writeDefaultMeshYaml` writes, with placeholder names.
  const scaffold = parseMeshSource(defaultMeshTemplate("default", "default", "claude"));
  const prompts = Object.values(scaffold.agents).filter((a) => a.prompt).length;
  out.push({ ...factsOf(DEFAULT_TEMPLATE_ID, "default", scaffold, prompts), title: "Default team", goal: null, projectId: null });
  if (!root) return out;
  for (const name of listExamples(root)) {
    try {
      const text = fs.readFileSync(path.join(root, "examples", name, "mesh.yaml"), "utf8");
      const prompts = new Set([...text.matchAll(ROLE_REF)].map((m) => m[2]!));
      out.push(factsOf(name, "example", parseMeshSource(text), prompts.size));
    } catch {
      /* not offered: a template that does not load is not a starting point */
    }
  }
  return out;
}
