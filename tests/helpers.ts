import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { bootstrapMesh, type MeshInstance } from "../apps/mesh-server/src/index";
import type { CriteriaGeneratorPort } from "../packages/core/src/ports";
import type { AgentDefinition } from "../packages/protocol/src/index";

export interface AgentSpec {
  id: string;
  role: string;
  /**
   * Inline role prose for this seat. `makeMesh` writes it to
   * `roles/<id>.md` beside the generated `mesh.yaml` and the config names it
   * as `prompt: ./roles/<id>.md`.
   *
   * Text rather than a path because `resolveConfig` rejects a config whose
   * prompt ref points at no file, so the ref and the file have to be produced
   * together. Leave it unset and the seat falls back to the role one-liner
   * `loadRolePrompt` generates.
   */
  prompt?: string;
  capabilities?: string[];
  authority?: string[];
  /** Capability families this seat holds but may not use until an operator unlocks the tool. */
  requiresApproval?: string[];
  interests?: string[];
  mode?: "peer" | "service";
  tokens?: number;
  persistent?: boolean;
  delegation?: { allow: boolean; max_depth: number; max_workers: number; worker_budget_tokens?: number };
  hardActions?: { mode: "off" | "warn" | "enforce"; capabilities?: string[] };
  /**
   * What this seat is willing to be woken for. Absent means "everything".
   *
   * `mail` is the other half of the same question: `deferNonObliging` decides
   * whether an FYI becomes a wake at all, and `mail: "claims"` decides how much
   * of a woken message's CONTENT the prompt carries. They compose, and a mesh
   * that wants low contact sets both.
   */
  wake?: { deferNonObliging?: boolean; mail?: "full" | "claims"; notFor?: string[] };
}

export interface TestMeshOptions {
  agents: AgentSpec[];
  startup?: string[];
  mayContact?: Record<string, string[]>;
  transitions?: Record<string, string[]>;
  rules?: unknown[];
  missionTokens?: number;
  maxEvents?: number;
  wallClockMinutes?: number;
  maxActiveAgents?: number;
  maxTotalAgents?: number;
  /** `null` omits the block entirely, which is what makes generation kick in. */
  criteria?: Array<{ id: string; description: string; mandatory?: boolean }> | null;
  /** Sets `mesh.generate_acceptance_criteria`. */
  generateAcceptanceCriteria?: boolean;
  /** Injected generator; without it the boot path falls back to defaults. */
  criteriaGenerator?: CriteriaGeneratorPort;
  goal?: string;
  uiOnly?: boolean;
  mode?: "parked" | "live";
  triage?: { mode: "off" | "heuristic"; rules?: Array<{ agent: string; event?: string; ignore_if_text_matches?: string[]; act_if_text_matches?: string[] }> };
  threadTokens?: number;
  /** budget auto-raise (default on in prod); tests that need a HARD budget wall turn it off */
  autoRaise?: { enabled?: boolean; factor?: number; maxMultiple?: number };
  waitWakeupMs?: number;
  turnTimeoutMs?: number;
  /** How long the mesh must be quiet before the scheduler declares it idle. */
  idleQuietPeriodMs?: number;
  stallIdleMs?: number;
  stallCooldownMs?: number;
  stallNoopRetryMs?: number;
  bus?: {
    /**
     * A whole coherent bus written as one word. Emitted LITERALLY, like
     * `vocabulary` below and for the same reason: what a fixture has to be
     * able to prove is the EXPANSION, and it cannot if the builder performs
     * it first.
     */
    style?: "high-contact" | "balanced" | "low-contact";
    commitments?: {
      semantic?: "compat" | "strict";
      /** Deadline for an outstanding ask. 0 / unset means asks never expire. */
      ttlMs?: number;
      /** Per-role override of `ttlMs`, keyed by role name. */
      ttlMsByRole?: Record<string, number>;
      /**
       * Let a bare typed ask inherit the contract its message type names.
       *
       * Off in every fixture that does not ask for it, because turning it on
       * turns the refusal list into a CLOSED set: suites that open an ask with
       * no contract and expect no verdict depend on the default staying false.
       */
      byType?: boolean;
    };
    transport?: "mixed" | "typed-only";
    /**
     * Which comms vocabulary the mesh advertises to its seats.
     *
     * `"typed"` is emitted LITERALLY rather than folded away here, even though
     * `resolveBusVocabulary` folds it back to absent: that fold is the thing a
     * fixture has to be able to prove, and it cannot if the builder quietly
     * performs it first.
     */
    vocabulary?: "typed" | "contracts";
    /** Bounds a collab session opens with. Unset means the shipped defaults. */
    collab?: { boxMs?: number; maxExchanges?: number };
    /**
     * Price attention. Omitting the block entirely is not the same as setting
     * `classes: false` -- absent is the behaviour of every mesh that never
     * opted in, and most suites here depend on getting exactly that.
     */
    delivery?: {
      classes?: boolean;
      coalesceMs?: number;
      interruptCostTokens?: number;
      attentionTokens?: number;
      /** Unread messages per surcharge step. Unset means the flat tariff. */
      congestionEvery?: number;
    };
  };
}

/**
 * Artifact body long enough to evidence a MANDATORY acceptance criterion.
 *
 * Mandatory criteria require a real deliverable (see MIN_EVIDENCE_CONTENT_CHARS
 * in the supervisor), so fixtures that used to publish `"x"` or `"diff"` are now
 * correctly rejected. Tests that only need *an* artifact should keep their short
 * content; use this only where the artifact is cited as evidence.
 */
export function evidenceContent(subject: string): string {
  return [
    `# ${subject}`,
    "",
    `Scope: ${subject} covering the agreed interfaces, constraints and failure modes.`,
    "Decisions: recorded with rationale so a reviewer can check them without asking the author.",
    "Verification: exercised end to end; results and residual risks are listed below.",
    "Residual risk: none blocking; follow-ups tracked as separate tasks in the mesh.",
    "Notes: this fixture body exists to clear the mandatory-evidence floor deliberately,",
    "because a one-word artifact is exactly the stub the evidence gate is meant to reject.",
  ].join("\n");
}

/**
 * The whole `bus:` block, or "" when it would be empty.
 *
 * A bare `bus:` with nothing under it parses as null, and the schema rejects
 * it with `/bus: must be object` -- so passing `{ commitments: {} }` to ask
 * for defaults has to produce no block at all, not an empty one. Every
 * sub-block below therefore contributes to `body` and returns "" when it has
 * nothing to say, and this function decides on the header afterwards.
 *
 * Key order matches `schemas/mesh.schema.json`. It is not load-bearing --
 * YAML mappings are unordered -- but a generated fixture that reads like the
 * file an operator would have written is easier to check by eye.
 */
function busYaml(bus: TestMeshOptions["bus"]): string {
  if (!bus) return "";
  const body =
    (bus.style ? `  style: ${bus.style}\n` : "") +
    busCommitmentsYaml(bus.commitments) +
    (bus.transport ? `  transport: ${bus.transport}\n` : "") +
    busVocabularyYaml(bus.vocabulary) +
    busCollabYaml(bus.collab) +
    busDeliveryYaml(bus.delivery);
  return body ? `bus:\n${body}` : "";
}

/**
 * The `bus.commitments` block, or "" when nothing about it was asked for.
 *
 * Built as a function rather than inline so an omitted key stays OMITTED:
 * writing `ttl_ms: undefined` into the YAML is not the same as leaving it out
 * (the resolver's default only applies to an absent key), and that difference
 * decides whether asks in a fixture can expire at all.
 */
function busCommitmentsYaml(c: NonNullable<TestMeshOptions["bus"]>["commitments"]): string {
  if (!c) return "";
  const parts: string[] = [];
  if (c.semantic) parts.push(`semantic: ${c.semantic}`);
  if (c.ttlMs !== undefined) parts.push(`ttl_ms: ${c.ttlMs}`);
  if (c.ttlMsByRole !== undefined) parts.push(`ttl_ms_by_role: ${JSON.stringify(c.ttlMsByRole)}`);
  // Written only when asked for. `by_type: false` and an absent key resolve
  // the same way, but a fixture that says nothing about contracts should
  // produce a mesh.yaml that says nothing about them either.
  if (c.byType !== undefined) parts.push(`by_type: ${c.byType}`);
  return parts.length ? `  commitments: { ${parts.join(", ")} }\n` : "";
}

function busCollabYaml(c: NonNullable<TestMeshOptions["bus"]>["collab"]): string {
  if (!c) return "";
  const parts: string[] = [];
  if (c.boxMs !== undefined) parts.push(`box_ms: ${c.boxMs}`);
  if (c.maxExchanges !== undefined) parts.push(`max_exchanges: ${c.maxExchanges}`);
  return parts.length ? `  collab: { ${parts.join(", ")} }\n` : "";
}

/** The `bus.vocabulary` line, or "" when the fixture did not choose one. */
function busVocabularyYaml(v: NonNullable<TestMeshOptions["bus"]>["vocabulary"]): string {
  return v ? `  vocabulary: ${v}\n` : "";
}

/**
 * The `bus.delivery` block, or "" when the fixture wants no delivery regime.
 *
 * `classes` defaults to TRUE when the block is present at all, which is the
 * one place this builder supplies a value the config would not. The reason is
 * `resolveDeliveryClasses`: it returns undefined unless `classes` is truthy,
 * so a block carrying only `coalesce_ms` resolves to no regime and the key
 * that was set is silently discarded. Defaulting it means "I wrote a delivery
 * block" and "I want the regime" cannot come apart by omission, while an
 * explicit `classes: false` still says the other thing.
 *
 * `!== undefined` rather than truthiness on the numbers, because
 * `interrupt_cost_tokens: 0` is a real tariff -- the free-interrupt case --
 * and not a request for the shipped default.
 */
function busDeliveryYaml(d: NonNullable<TestMeshOptions["bus"]>["delivery"]): string {
  if (!d) return "";
  const parts = [`classes: ${d.classes ?? true}`];
  if (d.coalesceMs !== undefined) parts.push(`coalesce_ms: ${d.coalesceMs}`);
  if (d.interruptCostTokens !== undefined) parts.push(`interrupt_cost_tokens: ${d.interruptCostTokens}`);
  // Same rule as the tariff above, and `0` is again the case that matters:
  // `attention_tokens: 0` means "never buy a wake", which is a real policy and
  // the sharpest way for a test to exhaust a cap. Written only when the caller
  // asked for it, because an absent count is what keeps every mesh that
  // predates this key on its own agent line.
  if (d.attentionTokens !== undefined) parts.push(`attention_tokens: ${d.attentionTokens}`);
  // Not `!== undefined` here: the resolver floors this at 1 and treats 0 as
  // absent, so there is no zero case to preserve and writing one would only
  // produce a key the schema then rejects for being below its minimum.
  if (d.congestionEvery !== undefined) parts.push(`congestion_every: ${d.congestionEvery}`);
  return `  delivery: { ${parts.join(", ")} }\n`;
}

export function testConfigYaml(opts: TestMeshOptions): string {
  const agents = opts.agents
    .map((a) => {
      const lines = [`  ${a.id}:`, `    role: ${a.role}`, `    runtime: stub`];
      if (a.prompt !== undefined) lines.push(`    prompt: ./roles/${a.id}.md`);
      if (a.mode) lines.push(`    mode: ${a.mode}`);
      if (a.capabilities) lines.push(`    capabilities: [${a.capabilities.join(", ")}]`);
      if (a.authority) lines.push(`    authority: [${a.authority.join(", ")}]`);
      if (a.requiresApproval) lines.push(`    requires_approval: [${a.requiresApproval.join(", ")}]`);
      if (a.interests) lines.push(`    interests: [${a.interests.join(", ")}]`);
      if (a.persistent !== false) lines.push(`    session: { persistent: ${a.persistent ?? true} }`);
      if (a.tokens) lines.push(`    budget: { tokens: ${a.tokens} }`);
      if (a.hardActions) lines.push(`    hard_actions: { mode: ${a.hardActions.mode}${a.hardActions.capabilities ? `, capabilities: [${a.hardActions.capabilities.join(", ")}]` : ""} }`);
      if (a.wake) lines.push(`    wake: { defer_non_obliging: ${a.wake.deferNonObliging ?? false}${a.wake.mail ? `, mail: ${a.wake.mail}` : ""}${a.wake.notFor ? `, not_for: [${a.wake.notFor.join(", ")}] }` : " }"}`);
      if (a.delegation) lines.push(`    delegation: { allow: ${a.delegation.allow}, max_depth: ${a.delegation.max_depth}, max_workers: ${a.delegation.max_workers}${a.delegation.worker_budget_tokens ? `, worker_budget_tokens: ${a.delegation.worker_budget_tokens}` : ""} }`);
      return lines.join("\n");
    })
    .join("\n");
  const comm = Object.entries(opts.mayContact ?? {})
    .map(([k, v]) => `    ${k}: { may_contact: [${v.join(", ")}] }`)
    .join("\n");
  const gates = Object.entries(opts.transitions ?? {})
    .map(([k, v]) => `    ${k}:\n      requires: [${v.join(", ")}]`)
    .join("\n");
  const declared =
    opts.criteria === null
      ? null
      : opts.criteria ?? [{ id: "ship", description: "the mission artifact exists", mandatory: true }];
  const criteriaBlock = declared
    ? `  acceptance_criteria:\n${declared.map((c) => `    - { id: ${c.id}, description: "${c.description}", mandatory: ${c.mandatory ?? true} }`).join("\n")}\n`
    : "";
  const generateBlock = opts.generateAcceptanceCriteria ? "  generate_acceptance_criteria: true\n" : "";
  return `version: 1

mesh:
  id: test-${Math.random().toString(36).slice(2, 8)}
  goal: |
    ${opts.goal ?? "Test mission."}
${criteriaBlock}${generateBlock}  workspace:
    path: ./workspace
  runtime:
    default: stub

startup:
  activate: [${(opts.startup ?? []).join(", ")}]

agents:
${agents}

policies:
  communication:
${comm || "    {}"}
  transitions:
${gates || "    {}"}
${opts.rules?.length ? `  rules: ${JSON.stringify(opts.rules)}` : ""}
  escalation:
    thread: { max_depth: 5 }
    repeated_conflict: { threshold: 3 }
    artifact_review_rounds: { max: 4 }

budgets:
  mission: { tokens: ${opts.missionTokens ?? 10000000}, wall_clock_minutes: ${opts.wallClockMinutes ?? 60}, max_events: ${opts.maxEvents ?? 100000} }
  thread: { tokens: ${opts.threadTokens ?? 1000000} }
${opts.autoRaise ? `  auto_raise: { enabled: ${opts.autoRaise.enabled ?? true}${opts.autoRaise.factor !== undefined ? `, factor: ${opts.autoRaise.factor}` : ""}${opts.autoRaise.maxMultiple !== undefined ? `, max_multiple: ${opts.autoRaise.maxMultiple}` : ""} }` : ""}

${busYaml(opts.bus)}
scheduling:
  mode: event-driven
${opts.triage ? `  triage:\n    mode: ${opts.triage.mode}\n    rules: ${JSON.stringify(opts.triage.rules ?? [])}` : ""}
  concurrency: { max_active_agents: ${opts.maxActiveAgents ?? 4}${opts.maxTotalAgents !== undefined ? `, max_total_agents: ${opts.maxTotalAgents}` : ""} }
  timeouts: { turn_timeout_ms: ${opts.turnTimeoutMs ?? 15000}, wait_wakeup_ms: ${opts.waitWakeupMs ?? 200}, idle_quiet_period_ms: ${opts.idleQuietPeriodMs ?? 300}, stall_idle_ms: ${opts.stallIdleMs ?? 180000}, stall_cooldown_ms: ${opts.stallCooldownMs ?? 300000}${opts.stallNoopRetryMs !== undefined ? `, stall_noop_retry_ms: ${opts.stallNoopRetryMs}` : ""} }
`;
}

export async function makeMesh(opts: TestMeshOptions): Promise<MeshInstance & { cleanup(): Promise<void> }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-test-"));
  const configPath = path.join(dir, "mesh.yaml");
  fs.writeFileSync(configPath, testConfigYaml(opts), "utf8");
  // Before bootstrap, not after: resolveConfig refuses a config whose `prompt:`
  // ref names a file that does not exist.
  for (const a of opts.agents) {
    if (a.prompt === undefined) continue;
    const roleFile = path.join(dir, "roles", `${a.id}.md`);
    fs.mkdirSync(path.dirname(roleFile), { recursive: true });
    fs.writeFileSync(roleFile, a.prompt, "utf8");
  }
  const mode = opts.mode ?? (opts.uiOnly ? "parked" : "live");
  const instance = await bootstrapMesh({
    configPath,
    inMemory: true,
    mode,
    uiOnly: mode === "parked",
    ...(opts.criteriaGenerator ? { criteriaGenerator: opts.criteriaGenerator } : {}),
  });
  (globalThis as unknown as Record<string, unknown>).__meshDebug = () => {
    const st = instance.kernel.state;
    const agents = [...st.agents.values()].map((r) => `${r.definition.id}:${r.state.lifecycle}(act ${r.state.activations}, unread ${st.unread.get(r.definition.id)?.length ?? 0})`).join("  ");
    const arts = [...st.artifacts.values()].map((a) => `${a.type}/${a.name}@v${a.version}:${a.status}`).join("  ");
    const goal = st.activeGoalId ? st.goals.get(st.activeGoalId) : undefined;
    const crit = goal ? goal.acceptanceCriteria.map((c) => `${c.id}=${c.status}`).join(",") : "";
    const pend = [...st.pendingRequests.values()].map((pr) => `${pr.from}->${pr.to.join("/")}:${pr.type}`).join("  ");
    const esc = [...st.escalations.values()].map((e) => `${e.id}:${e.reason}`).join("  ");
    return `goal ${goal?.status} [${crit}] | ${agents} | artifacts: ${arts} | pending: ${pend} | escalations: ${esc}`;
  };
  return Object.assign(instance, {
    async cleanup() {
      await instance.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  });
}

export function stub(m: MeshInstance) {
  const s = m.stubRuntimes.get("stub");
  if (!s) throw new Error("stub runtime missing");
  return s;
}

export async function waitFor(what: string, predicate: () => boolean | Promise<boolean>, timeoutMs = 12000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  const dbg = (globalThis as unknown as Record<string, () => string>).__meshDebug;
  throw new Error(`timeout waiting for: ${what}${dbg ? `\n   state: ${dbg()}` : ""}`);
}

export async function collectEvents(m: MeshInstance) {
  return m.store.read();
}

export function eventTypes(events: Array<{ type: string }>): string[] {
  return events.map((e) => e.type);
}

export function firstIndexOf(types: string[], type: string): number {
  return types.indexOf(type);
}

export function goalOf(m: MeshInstance) {
  return m.kernel.state.goals.get(m.kernel.state.activeGoalId ?? "");
}

export type { AgentDefinition };
