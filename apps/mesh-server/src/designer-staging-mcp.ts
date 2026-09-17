import type {
  AcceptanceCriterion,
  AgentDefinition,
  AgentMode,
  Authority,
  RuntimeTypeName,
  StagedMutation,
} from "../../../packages/protocol/src/index";
import { DESTRUCTIVE_KINDS } from "../../../packages/protocol/src/index";
import type { Supervisor } from "../../../packages/core/src/index";
import { McpToolset, type McpToolDefinition } from "./mcp";

/**
 * Authoring half of the staged-mutation surface: the tools the dashboard
 * assistant calls to PROPOSE a change, and the turn-scoped buffer those
 * proposals land in until the operator presses Apply.
 *
 * Nothing here executes. Every tool validates and pushes; the Supervisor is
 * read for existence checks only, never mutated. That separation is the whole
 * point of the feature — the refusals that matter (a criterion removal that
 * would complete the goal, a retirement that is terminal) live in
 * `staging.ts`/`Supervisor` and fire at Apply time, in front of a human.
 *
 * Why a server-side buffer at all, when the chat route is otherwise stateless:
 * a tool call and the end of the turn are different HTTP requests, and the
 * mutation has to survive the gap between them. It does NOT have to survive
 * longer than that, which is why the buffer is keyed by turn and swept.
 */

/**
 * How long an un-drained turn may sit in the buffer.
 *
 * Bounded because the drain is not guaranteed to happen: a client that
 * navigates away mid-turn closes the SSE socket, the route's `finally` runs,
 * but a runtime that is wedged may never return at all. 60s is far longer than
 * a designer turn and far shorter than a session.
 */
const TURN_TTL_MS = 60_000;

interface TurnSlot {
  mutations: StagedMutation[];
  /** Refusals worth showing the operator, not just the model. */
  problems: string[];
  at: number;
}

/**
 * Turn-scoped staging buffer.
 *
 * Correlation is by `turnId`, which the server mints and passes to the runtime
 * out of band (a header on the MCP bridge), never by an id the model echoes
 * back: a model that can say which turn it is writing into can say the wrong
 * one, and cross-turn writes are exactly the failure this must not have.
 */
export class DesignerTurnBuffer {
  private turns = new Map<string, TurnSlot>();

  /**
   * Swept on access rather than on an interval: a `setInterval` here would
   * either hold the process open or need `unref`, and there is no work to do
   * between requests anyway.
   */
  private sweep(now: number): void {
    for (const [id, slot] of this.turns) {
      if (now - slot.at > TURN_TTL_MS) this.turns.delete(id);
    }
  }

  open(turnId: string): void {
    const now = Date.now();
    this.sweep(now);
    this.turns.set(turnId, { mutations: [], problems: [], at: now });
  }

  /** True iff this turn is open — i.e. a tool call may write to it. */
  has(turnId: string): boolean {
    this.sweep(Date.now());
    return this.turns.has(turnId);
  }

  push(turnId: string, mutation: StagedMutation): boolean {
    const slot = this.turns.get(turnId);
    if (!slot) return false;
    slot.mutations.push(mutation);
    return true;
  }

  problem(turnId: string, text: string): void {
    this.turns.get(turnId)?.problems.push(text);
  }

  list(turnId: string): StagedMutation[] {
    return this.turns.get(turnId)?.mutations ?? [];
  }

  discard(turnId: string, index: number): StagedMutation | undefined {
    const slot = this.turns.get(turnId);
    if (!slot || index < 0 || index >= slot.mutations.length) return undefined;
    return slot.mutations.splice(index, 1)[0];
  }

  /** Take everything staged for this turn and close it. Idempotent. */
  drain(turnId: string): { mutations: StagedMutation[]; problems: string[] } {
    const slot = this.turns.get(turnId);
    this.turns.delete(turnId);
    return { mutations: slot?.mutations ?? [], problems: slot?.problems ?? [] };
  }

  close(turnId: string): void {
    this.turns.delete(turnId);
  }

  /**
   * The one open turn, when there is exactly one.
   *
   * Needed because not every runtime can carry a per-turn header: a runtime
   * that keeps ONE designer backend process across turns spawns its MCP
   * bridge once and cannot be told which turn is live. Rather than let the
   * model name its own turn — an id it can get wrong, which is the cross-turn
   * write this design exists to prevent — the server resolves it, and refuses
   * when the answer is ambiguous. Two concurrent designer turns is a rare state
   * (a second browser tab); losing staging in it is much cheaper than writing a
   * mutation into the wrong operator's review card.
   */
  soleOpenTurn(): { turnId?: string; open: number } {
    this.sweep(Date.now());
    const ids = [...this.turns.keys()];
    return { turnId: ids.length === 1 ? ids[0] : undefined, open: ids.length };
  }

  /** Open turn count — for the isolation test and nothing else. */
  get size(): number {
    return this.turns.size;
  }
}

const str = (desc: string) => ({ type: "string", description: desc });
const strArr = (desc: string) => ({ type: "array", items: { type: "string" }, description: desc });
const num = (desc: string) => ({ type: "number", description: desc });
const bool = (desc: string) => ({ type: "boolean", description: desc });

/** `reason` is optional on most kinds and required on the destructive ones. */
const reasonProp = str("why this change is being proposed; shown to the operator");

/**
 * One tool per `StagedMutation` kind, plus two housekeeping tools.
 *
 * Named `mesh_stage_*` so that the verb is visible at the call site: the
 * assistant can read a run with `mesh_run_status` and stage against it with
 * `mesh_stage_*`, and nothing in its toolset both reads and writes.
 */
export const STAGING_TOOLS: McpToolDefinition[] = [
  {
    name: "mesh_stage_config_replace",
    description:
      "Stage a complete replacement mesh.yaml for the operator's LOCAL DRAFT. This does not touch the running mesh — the operator still has to Save. Use this instead of pasting a config block when you also stage other changes.",
    inputSchema: { type: "object", required: ["yaml"], properties: { yaml: str("the complete mesh.yaml document as text"), reason: reasonProp }, additionalProperties: false },
  },
  {
    name: "mesh_stage_goal_description",
    description:
      "Stage a rewrite of the mission statement the run's acceptance is measured against. Applies to the LIVE run. Lands as an auditable goal.description_revised event, not a silent field write.",
    inputSchema: { type: "object", required: ["description"], properties: { description: str("the new mission statement, in full"), reason: reasonProp }, additionalProperties: false },
  },
  {
    name: "mesh_stage_criteria_add",
    description:
      "Stage one or more new acceptance criteria on the live goal. Each needs a stable id and a description; `mandatory` defaults to true. Ids must not collide with existing criteria.",
    inputSchema: {
      type: "object",
      required: ["criteria"],
      properties: {
        criteria: {
          type: "array",
          description: "criteria to add",
          items: {
            type: "object",
            required: ["id", "description"],
            properties: { id: str("stable criterion id, e.g. 'tests-pass'"), description: str("what must be true"), mandatory: bool("defaults to true") },
            additionalProperties: false,
          },
        },
        reason: reasonProp,
      },
      additionalProperties: false,
    },
  },
  {
    name: "mesh_stage_criteria_edit",
    description: "Stage an edit to one existing acceptance criterion: its wording, whether it is mandatory, or both. Pass at least one of `description` / `mandatory`.",
    inputSchema: {
      type: "object",
      required: ["criterionId"],
      properties: { criterionId: str("id of the criterion to revise"), description: str("new wording"), mandatory: bool("new mandatory flag"), reason: reasonProp },
      additionalProperties: false,
    },
  },
  {
    name: "mesh_stage_criteria_delete",
    description:
      "Stage the removal of an acceptance criterion. DESTRUCTIVE and `reason` is required: removing a criterion shrinks the denominator completion is measured over and can flip a live run to COMPLETED. The mesh refuses removals that would empty the set or complete the goal — that refusal fires when the operator applies, not here.",
    inputSchema: { type: "object", required: ["criterionId", "reason"], properties: { criterionId: str("id of the criterion to remove"), reason: str("why it should go; required, shown to the operator") }, additionalProperties: false },
  },
  {
    name: "mesh_stage_seat_spawn",
    description:
      "Stage a new agent seat on the live mesh. Give it the least it needs: capabilities for what it must do, interests for the events it must react to. Unset fields inherit sensible defaults (peer mode, persistent session, no delegation, 200000 token budget); `prompt` defaults to the role prompt an existing seat of that role uses, else roles/<role>.md.",
    inputSchema: {
      type: "object",
      required: ["id", "role"],
      properties: {
        id: str("new agent id, unique in this mesh"),
        role: str("role name, e.g. developer / tech-lead / qa"),
        mode: { ...str("peer (default) | service | worker"), enum: ["peer", "service", "worker"] },
        runtime: str("runtime name; defaults to whatever the existing seats use"),
        model: str("provider/model string; blank uses the mesh default"),
        variant: str("inert — no registered runtime reads it; leave blank"),
        prompt: str("role prompt file path"),
        capabilities: strArr("capability tokens this seat may use"),
        authority: strArr("authority tokens this seat holds"),
        interests: strArr("event types that should wake this seat"),
        mayContact: strArr("agent ids this seat may message"),
        mayBeContactedBy: strArr("agent ids that may message this seat"),
        budgetTokens: num("token budget for this seat (default 200000)"),
        reason: reasonProp,
      },
      additionalProperties: false,
    },
  },
  {
    name: "mesh_stage_seat_retire",
    description:
      "Stage the retirement of a seat. DESTRUCTIVE and `reason` is required: retirement is TERMINAL — a retired seat can never be resumed, woken, or revived by a reopen. Use mesh_stage_seat_suspend for anything reversible.",
    inputSchema: { type: "object", required: ["agentId", "reason"], properties: { agentId: str("seat to retire"), reason: str("why; required, shown to the operator") }, additionalProperties: false },
  },
  {
    name: "mesh_stage_seat_suspend",
    description: "Stage a suspend for a seat: it stops being scheduled but keeps its session and can be resumed. The reversible alternative to retirement.",
    inputSchema: { type: "object", required: ["agentId"], properties: { agentId: str("seat to suspend"), reason: reasonProp }, additionalProperties: false },
  },
  {
    name: "mesh_stage_seat_resume",
    description: "Stage a resume for a suspended seat.",
    inputSchema: { type: "object", required: ["agentId"], properties: { agentId: str("seat to resume"), reason: reasonProp }, additionalProperties: false },
  },
  {
    name: "mesh_stage_seat_wake",
    description: "Stage a manual activation: give this seat a turn now, without waiting for one of its interests to fire.",
    inputSchema: { type: "object", required: ["agentId"], properties: { agentId: str("seat to wake"), reason: reasonProp }, additionalProperties: false },
  },
  {
    name: "mesh_stage_run_pause",
    description: "Stage a pause of the whole mission: agents stop being scheduled until it is resumed.",
    inputSchema: { type: "object", properties: { reason: reasonProp }, additionalProperties: false },
  },
  {
    name: "mesh_stage_run_resume",
    description: "Stage a resume of a paused mission.",
    inputSchema: { type: "object", properties: { reason: reasonProp }, additionalProperties: false },
  },
  {
    name: "mesh_stage_run_budget",
    description: "Stage a raise of the mission's caps. Pass maxEvents and/or wallClockMinutes. Use when a run is about to be cut off by a cap rather than by its goal.",
    inputSchema: {
      type: "object",
      properties: { maxEvents: num("new event cap"), wallClockMinutes: num("new wall-clock cap in minutes"), reason: reasonProp },
      additionalProperties: false,
    },
  },
  {
    name: "mesh_stage_run_reopen",
    description:
      "Stage a reopen of a completed mission. DESTRUCTIVE and `reason` is required: it invalidates accepted evidence and sends criteria back to UNSATISFIED. Optionally name the criteria to reopen; omit for all of them.",
    inputSchema: { type: "object", required: ["reason"], properties: { criteria: strArr("criterion ids to reopen; omit for all"), reason: str("why; required, shown to the operator") }, additionalProperties: false },
  },
  {
    name: "mesh_stage_mission_reset",
    description:
      "Stage a full mission reset to zero. DESTRUCTIVE and `reason` is required: it archives all state and parks the mesh. This is the most destructive thing you can propose — prefer anything else.",
    inputSchema: { type: "object", required: ["reason"], properties: { reason: str("why; required, shown to the operator") }, additionalProperties: false },
  },
  {
    name: "mesh_staged_list",
    description: "List what you have staged so far in THIS reply, in apply order. Call it before you write your prose summary so that what you tell the operator matches what they will see.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "mesh_staged_discard",
    description: "Remove one mutation you staged earlier in this reply, by its index from mesh_staged_list. Use this when you staged something and then thought better of it — the operator sees the buffer, not your reasoning.",
    inputSchema: { type: "object", required: ["index"], properties: { index: num("0-based index from mesh_staged_list") }, additionalProperties: false },
  },
];

const STAGING_TOOL_NAMES = new Set(STAGING_TOOLS.map((t) => t.name));

type StageOutcome = { ok: true; detail: string; position: number } | { ok: false; error: string };

/**
 * Deliberately returns only the failure variant rather than `StageOutcome`:
 * both `stage()` and `build()` refuse through it, and they succeed with
 * different shapes.
 */
const bad = (error: string) => ({ ok: false as const, error });

function text(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function strings(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return undefined;
  return v as string[];
}

/**
 * The staging toolset: `mesh_stage_*` plus a read-only view of the live run.
 *
 * Composition rather than inheritance, and read-only rather than the full
 * toolset, because the assistant must be able to look before it proposes — you
 * cannot sensibly stage a retirement without checking whether the seat is idle
 * — while remaining unable to act. `McpToolset({ readOnly: true })` is the same
 * six observability tools the designer already had via `mesh_observe`.
 */
export class DesignerStagingToolset {
  private readonly inner: McpToolset;

  constructor(
    private supervisor: Supervisor,
    private buffer: DesignerTurnBuffer,
  ) {
    this.inner = new McpToolset(supervisor, { readOnly: true });
  }

  /**
   * `turnId` comes from the transport (a header the server set when it started
   * the turn), not from `request`. An unknown or already-drained turn is a hard
   * error rather than a silent no-op: the model needs to find out mid-turn that
   * its proposal did not land, while it can still say so in prose.
   */
  async handle(agentId: string, token: string, turnId: string | undefined, request: Record<string, any>): Promise<unknown> {
    const id = request?.id;
    const method = request?.method;

    if (method === "tools/list") {
      const innerResult = (await this.inner.handle(agentId, token, request)) as { result?: { tools?: McpToolDefinition[] }; error?: unknown };
      if (innerResult?.error) return innerResult;
      const observability = innerResult?.result?.tools ?? [];
      return { jsonrpc: "2.0", id, result: { tools: [...STAGING_TOOLS, ...observability] } };
    }

    if (method === "tools/call" && STAGING_TOOL_NAMES.has(request?.params?.name)) {
      // The read-only toolset verifies the token for every other method; do it
      // here too so staging is not the one unauthenticated door.
      if (!this.inner.verifyToken(agentId, token)) {
        return { jsonrpc: "2.0", id, error: { code: -32001, message: `invalid mesh token for agent '${agentId}'` } };
      }
      const name = request.params.name as string;
      const args = (request.params.arguments ?? {}) as Record<string, any>;
      const outcome = this.stage(turnId, name, args);
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: JSON.stringify(outcome) }], isError: !outcome.ok },
      };
    }

    return this.inner.handle(agentId, token, request);
  }

  private stage(requestedTurn: string | undefined, name: string, args: Record<string, any>): StageOutcome {
    // An explicit header wins. Without one, resolve the single open turn; a
    // bridge shared by two concurrent turns must refuse rather than pick.
    let turnId = requestedTurn;
    if (!turnId) {
      const sole = this.buffer.soleOpenTurn();
      if (sole.open > 1) {
        return bad("more than one designer turn is open right now, so this staging call cannot be attributed to one of them — tell the operator to retry from a single chat.");
      }
      turnId = sole.turnId;
    }
    if (!turnId || !this.buffer.has(turnId)) {
      return bad("this turn is no longer open for staging — say so in your reply rather than pretending the change was made");
    }

    if (name === "mesh_staged_list") {
      const staged = this.buffer.list(turnId);
      return { ok: true, detail: JSON.stringify(staged.map((m, i) => ({ index: i, kind: m.kind }))), position: staged.length };
    }

    if (name === "mesh_staged_discard") {
      const index = typeof args.index === "number" ? args.index : -1;
      const removed = this.buffer.discard(turnId, index);
      if (!removed) return bad(`no staged mutation at index ${index}`);
      return { ok: true, detail: `discarded ${removed.kind} at index ${index}`, position: this.buffer.list(turnId).length };
    }

    const built = this.build(name, args);
    if (!built.ok) return built;

    // The destructive kinds carry a required `reason` in the type, but these
    // arguments came from a model over JSON-RPC, so the compiler guaranteed
    // nothing. Catch it here, where the model can still fix it, rather than
    // letting `staging.ts` refuse it in front of the operator.
    if ((DESTRUCTIVE_KINDS as readonly string[]).includes(built.mutation.kind) && !text((built.mutation as { reason?: unknown }).reason)) {
      return bad(`${built.mutation.kind} is destructive and requires a stated reason`);
    }

    this.buffer.push(turnId, built.mutation);
    return { ok: true, detail: built.detail, position: this.buffer.list(turnId).length - 1 };
  }

  /**
   * Validate one tool call into a `StagedMutation`.
   *
   * Existence checks against live state happen here as well as in `staging.ts`,
   * and that is not redundant: this one exists so the model can correct itself
   * mid-turn, the one at apply time exists because the mesh moves between
   * staging and Apply. Neither can replace the other.
   */
  private build(name: string, args: Record<string, any>): ({ ok: true; mutation: StagedMutation; detail: string }) | { ok: false; error: string } {
    const state = this.supervisor.state;
    const reason = text(args.reason) || undefined;
    const made = (mutation: StagedMutation, detail: string) => ({ ok: true as const, mutation, detail });

    const seat = (agentId: string) => state.agents.get(agentId);
    const criteria = (): AcceptanceCriterion[] => {
      const goalId = state.activeGoalId;
      return (goalId ? state.goals.get(goalId)?.acceptanceCriteria : undefined) ?? [];
    };

    switch (name) {
      case "mesh_stage_config_replace": {
        const yaml = text(args.yaml);
        if (!yaml) return bad("config.replace needs the complete mesh.yaml document as `yaml`");
        return made({ kind: "config.replace", yaml, reason }, "staged a replacement mesh.yaml for the operator's local draft (they still have to Save)");
      }

      case "mesh_stage_goal_description": {
        const description = text(args.description);
        if (!description) return bad("goal.description needs a non-empty `description`");
        return made({ kind: "goal.description", description, reason }, "staged a rewrite of the mission statement");
      }

      case "mesh_stage_criteria_add": {
        const raw = Array.isArray(args.criteria) ? args.criteria : null;
        if (!raw || raw.length === 0) return bad("criteria.add needs a non-empty `criteria` array");
        const existing = new Set(criteria().map((c) => c.id));
        const built: AcceptanceCriterion[] = [];
        for (const entry of raw) {
          const cid = text(entry?.id);
          const description = text(entry?.description);
          if (!cid || !description) return bad("every criterion needs both an `id` and a `description`");
          if (existing.has(cid)) return bad(`criterion '${cid}' already exists — use mesh_stage_criteria_edit to change it`);
          if (built.some((c) => c.id === cid)) return bad(`criterion '${cid}' is listed twice in the same call`);
          built.push({ id: cid, description, mandatory: entry?.mandatory !== false, status: "UNSATISFIED", evidence: [] });
        }
        return made({ kind: "criteria.add", criteria: built, reason }, `staged ${built.length} new criterion(s): ${built.map((c) => c.id).join(", ")}`);
      }

      case "mesh_stage_criteria_edit": {
        const criterionId = text(args.criterionId);
        if (!criterionId) return bad("criteria.edit needs a `criterionId`");
        if (!criteria().some((c) => c.id === criterionId)) {
          return bad(`no criterion '${criterionId}' on the live goal — known ids: ${criteria().map((c) => c.id).join(", ") || "(none)"}`);
        }
        const description = args.description === undefined ? undefined : text(args.description);
        const mandatory = typeof args.mandatory === "boolean" ? args.mandatory : undefined;
        if (!description && mandatory === undefined) return bad("criteria.edit needs at least one of `description` or `mandatory`");
        return made({ kind: "criteria.edit", criterionId, description: description || undefined, mandatory, reason }, `staged an edit to criterion '${criterionId}'`);
      }

      case "mesh_stage_criteria_delete": {
        const criterionId = text(args.criterionId);
        if (!criterionId) return bad("criteria.delete needs a `criterionId`");
        const live = criteria();
        if (!live.some((c) => c.id === criterionId)) {
          return bad(`no criterion '${criterionId}' on the live goal — known ids: ${live.map((c) => c.id).join(", ") || "(none)"}`);
        }
        return made({ kind: "criteria.delete", criterionId, reason: text(args.reason) }, `staged removal of criterion '${criterionId}'`);
      }

      case "mesh_stage_seat_spawn": {
        const agentId = text(args.id);
        const role = text(args.role);
        if (!agentId) return bad("seat.spawn needs an `id`");
        if (!role) return bad("seat.spawn needs a `role`");
        if (seat(agentId)) return bad(`seat '${agentId}' already exists`);

        const capabilities = strings(args.capabilities) ?? [];
        const authority = strings(args.authority) ?? [];
        const interests = strings(args.interests) ?? [];
        const mayContact = strings(args.mayContact) ?? [];
        const mayBeContactedBy = strings(args.mayBeContactedBy) ?? [];
        for (const target of [...mayContact, ...mayBeContactedBy]) {
          if (target !== agentId && !seat(target)) return bad(`communication policy references unknown agent '${target}'`);
        }

        // Defaults mirror the config resolver's (packages/config/src/index.ts,
        // the AgentDefinition it builds per agent) so a staged seat and a seat
        // declared in mesh.yaml behave the same. `hardActions` is left absent
        // on purpose: absent means off, which is the safe default for a seat
        // nobody wrote into the config.
        const peers = [...state.agents.values()].map((a) => a.definition);
        const runtime = (text(args.runtime) || peers[0]?.runtime || "opencode") as RuntimeTypeName;
        const promptFile = text(args.prompt) || peers.find((p) => p.role === role)?.prompt?.file || `roles/${role}.md`;

        const definition: AgentDefinition = {
          id: agentId,
          role,
          mode: (text(args.mode) || "peer") as AgentMode,
          runtime,
          model: text(args.model) || undefined,
          variant: text(args.variant) || undefined,
          prompt: { file: promptFile },
          capabilities,
          authority: authority as Authority[],
          communicationPolicy: { mayContact, mayBeContactedBy },
          interests,
          sessionPolicy: { persistent: true },
          delegationPolicy: { allowDelegation: false, maxDepth: 0, maxWorkers: 0 },
          budget: { tokens: typeof args.budgetTokens === "number" ? args.budgetTokens : 200000 },
        };
        return made({ kind: "seat.spawn", agent: definition, reason }, `staged a new '${role}' seat '${agentId}'`);
      }

      case "mesh_stage_seat_retire":
      case "mesh_stage_seat_suspend":
      case "mesh_stage_seat_resume":
      case "mesh_stage_seat_wake": {
        const agentId = text(args.agentId);
        if (!agentId) return bad("this tool needs an `agentId`");
        const rec = seat(agentId);
        if (!rec) return bad(`unknown agent '${agentId}' — live seats: ${[...state.agents.keys()].join(", ") || "(none)"}`);
        // Retirement is terminal and the reducer THROWS on an illegal
        // transition out of RETIRED, so a staged suspend/resume/wake aimed at a
        // retired seat is not merely a no-op — it is a proposal that must never
        // reach the log.
        if (rec.state.lifecycle === "RETIRED" && name !== "mesh_stage_seat_retire") {
          return bad(`seat '${agentId}' was retired, and retirement is terminal — it cannot be suspended, resumed, or woken`);
        }
        if (name === "mesh_stage_seat_retire") {
          if (rec.state.lifecycle === "RETIRED") return bad(`seat '${agentId}' is already retired`);
          return made({ kind: "seat.retire", agentId, reason: text(args.reason) }, `staged retirement of seat '${agentId}' (terminal)`);
        }
        if (name === "mesh_stage_seat_suspend") {
          if (rec.state.lifecycle === "SUSPENDED") return bad(`seat '${agentId}' is already suspended`);
          return made({ kind: "seat.suspend", agentId, reason }, `staged a suspend for seat '${agentId}'`);
        }
        if (name === "mesh_stage_seat_resume") {
          if (rec.state.lifecycle !== "SUSPENDED") return bad(`seat '${agentId}' is ${rec.state.lifecycle}, not suspended`);
          return made({ kind: "seat.resume", agentId, reason }, `staged a resume for seat '${agentId}'`);
        }
        return made({ kind: "seat.wake", agentId, reason }, `staged a manual wake for seat '${agentId}'`);
      }

      case "mesh_stage_run_pause":
        return made({ kind: "run.pause", reason }, "staged a mission pause");

      case "mesh_stage_run_resume":
        return made({ kind: "run.resume", reason }, "staged a mission resume");

      case "mesh_stage_run_budget": {
        const maxEvents = typeof args.maxEvents === "number" ? args.maxEvents : undefined;
        const wallClockMinutes = typeof args.wallClockMinutes === "number" ? args.wallClockMinutes : undefined;
        if (maxEvents === undefined && wallClockMinutes === undefined) return bad("run.budget needs maxEvents and/or wallClockMinutes");
        return made({ kind: "run.budget", budget: { maxEvents, wallClockMinutes }, reason }, "staged a raise of the mission caps");
      }

      case "mesh_stage_run_reopen": {
        const wanted = strings(args.criteria);
        if (args.criteria !== undefined && wanted === undefined) return bad("`criteria` must be an array of criterion ids");
        if (wanted) {
          const known = new Set(criteria().map((c) => c.id));
          const missing = wanted.filter((c) => !known.has(c));
          if (missing.length) return bad(`unknown criterion id(s): ${missing.join(", ")}`);
        }
        return made({ kind: "run.reopen", criteria: wanted, reason: text(args.reason) }, "staged a mission reopen");
      }

      case "mesh_stage_mission_reset":
        return made({ kind: "mission.reset", reason: text(args.reason) }, "staged a full mission reset (archives all state and parks the mesh)");

      default:
        return bad(`unknown staging tool '${name}'`);
    }
  }
}

export function createDesignerStagingToolset(supervisor: Supervisor, buffer: DesignerTurnBuffer): DesignerStagingToolset {
  return new DesignerStagingToolset(supervisor, buffer);
}
