import type {
  AgentDefinition,
  AgentEvent,
  AgentEventTurnEnd,
  AgentInput,
  AgentOutput,
  AgentRuntime,
  AgentRuntimeStatus,
  AgentSession,
  MeshOp,
  RuntimeContext,
} from "../../protocol/src/index";
import { newAgentSessionId, aliasTextOp } from "../../protocol/src/index";

export type StubScript = (input: AgentInput, turnIndex: number, session: AgentSession) => StubTurn | Promise<StubTurn>;

export interface StubTurn {
  text?: string;
  operations?: MeshOp[];
  /** Simulate a typed (MCP) turn vs a prose-parsed one. */
  typedOps?: boolean;
  tokensUsed?: { input: number; output: number; total: number };
  summary?: string;
  model?: string;
  modelVersion?: string;
  temperature?: number;
  /**
   * Tool invocations to report for this turn.
   *
   * Omitted means "this agent did real work off-mesh", which is what a
   * scripted fixture almost always models — so the stub reports one synthetic
   * non-`mesh_*` call (see DEFAULT_STUB_TOOL_CALLS). That matters because the
   * verification gate downgrades a criterion claimed by a turn with no
   * verification tool to ASSERTED; without the default, every convergence
   * fixture would silently stop converging for a reason it is not testing.
   *
   * Pass `[]` explicitly to model a turn that checked NOTHING — that is what
   * the gate's own tests do.
   */
  toolCalls?: Array<{ name: string; args: unknown; resultDigest: string }>;
  fail?: string;
  crash?: boolean;
  delayMs?: number;
}

export interface StubOptions {
  scripts: Map<string, StubScript | StubTurn[]>;
  defaultTokens?: number;
}

/**
 * What a scripted turn reports when it says nothing about tools: one real
 * (non-`mesh_*`) invocation, i.e. "this agent went and did something". See
 * StubTurn.toolCalls.
 */
export const DEFAULT_STUB_TOOL_CALLS: Array<{ name: string; args: unknown; resultDigest: string }> = [
  { name: "stub_work", args: {}, resultDigest: "stub" },
];

export class StubRuntime implements AgentRuntime {
  readonly name = "stub";
  private turnIndex = new Map<string, number>();
  private statuses = new Map<string, AgentRuntimeStatus>();
  private sessions = new Map<string, AgentSession>();
  /**
   * The RuntimeContext every `start` received, per agent, oldest first.
   *
   * A real runtime turns this into the model's system prompt — runtime-claude
   * writes `context.rolePromptText` to ROLE.md and passes it as the custom
   * system prompt — so a stub that discards it leaves the whole
   * config-to-seat path untestable: nothing downstream of `start` can tell a
   * configured role prompt from a missing one. Kept as a list rather than
   * last-wins so a restart (resume/recovery) stays visible.
   */
  private startContexts = new Map<string, RuntimeContext[]>();

  constructor(private options: StubOptions) {}

  setScript(agentId: string, script: StubScript | StubTurn[]): void {
    this.options.scripts.set(agentId, script);
  }

  resetTurns(agentId: string): void {
    this.turnIndex.delete(agentId);
  }

  async start(agent: AgentDefinition, context: RuntimeContext): Promise<AgentSession> {
    const seen = this.startContexts.get(agent.id) ?? [];
    seen.push(context);
    this.startContexts.set(agent.id, seen);
    const session: AgentSession = {
      sessionId: newAgentSessionId(),
      agentId: agent.id,
      runtime: this.name,
      createdAt: new Date().toISOString(),
      handle: null,
    };
    this.sessions.set(session.sessionId, session);
    this.statuses.set(agent.id, "IDLE");
    return session;
  }

  /** Every context `start` received for this agent, oldest first. */
  startContextsFor(agentId: string): RuntimeContext[] {
    return [...(this.startContexts.get(agentId) ?? [])];
  }

  /** The context of this agent's most recent `start`, or undefined if never started. */
  lastStartContext(agentId: string): RuntimeContext | undefined {
    const seen = this.startContexts.get(agentId);
    return seen?.[seen.length - 1];
  }

  async send(session: AgentSession, input: AgentInput): Promise<AgentOutput> {
    const agentId = session.agentId;
    const idx = this.turnIndex.get(agentId) ?? 0;
    this.turnIndex.set(agentId, idx + 1);
    this.statuses.set(agentId, "RUNNING");
    const script = this.options.scripts.get(agentId);
    let turn: StubTurn;
    if (typeof script === "function") {
      turn = await script(input, idx, session);
    } else if (Array.isArray(script)) {
      turn = script[Math.min(idx, script.length - 1)] ?? { text: "no script", operations: [{ op: "done" }] };
      if (idx >= script.length) turn = { text: "exhausted script", operations: [{ op: "wait" }] };
    } else {
      turn = { text: `stub ${agentId} has no script`, operations: [{ op: "done" }] };
    }
    if (turn.crash) {
      this.statuses.set(agentId, "UNREACHABLE");
      throw new Error(`stub crash for ${agentId} on turn ${idx}`);
    }
    if (turn.delayMs) await new Promise((r) => setTimeout(r, turn.delayMs));
    this.statuses.set(agentId, "IDLE");
    const def = this.options.defaultTokens ?? 1200;
    return {
      text: turn.text ?? "",
      operations: turn.operations ?? [{ op: "done" }],
      typedOps: turn.typedOps,
      tokensUsed: turn.tokensUsed ?? { input: def, output: def / 2, total: def * 1.5 },
      model: turn.model ?? "stub-model",
      modelVersion: turn.modelVersion ?? "1",
      temperature: turn.temperature ?? 0,
      toolCalls: turn.toolCalls ?? DEFAULT_STUB_TOOL_CALLS,
      summary: turn.summary,
      turnId: `stub-turn-${agentId}-${idx}`,
      error: turn.fail,
    };
  }

  async interrupt(): Promise<void> {
    /* stub turns are synchronous and immediate */
  }

  async suspend(session: AgentSession): Promise<void> {
    this.statuses.set(session.agentId, "SUSPENDED");
  }

  async resume(session: AgentSession): Promise<void> {
    this.statuses.set(session.agentId, "IDLE");
  }

  async stop(session: AgentSession): Promise<void> {
    this.statuses.set(session.agentId, "STOPPED");
    this.sessions.delete(session.sessionId);
  }

  async getStatus(session: AgentSession): Promise<AgentRuntimeStatus> {
    return this.statuses.get(session.agentId) ?? "IDLE";
  }

  async restoreSession(agent: AgentDefinition, sessionId: string, _context: RuntimeContext): Promise<AgentSession | null> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    return {
      sessionId,
      agentId: agent.id,
      runtime: this.name,
      createdAt: new Date().toISOString(),
      handle: null,
    };
  }

  simulateProcessDeath(agentId: string): void {
    this.statuses.set(agentId, "UNREACHABLE");
    this.options.scripts.set(`__dead__${agentId}`, []);
  }
}

export class StaticRuntimeResolver implements RuntimeResolverish {
  private runtimes = new Map<string, AgentRuntime>();
  register(name: string, runtime: AgentRuntime): void {
    this.runtimes.set(name, runtime);
  }
  resolve(runtimeName: string): AgentRuntime {
    const r = this.runtimes.get(runtimeName);
    if (!r) {
      const human = this.runtimes.get("none");
      if (runtimeName === "none" && human) return human;
      throw new Error(`no runtime adapter registered for '${runtimeName}'`);
    }
    return r;
  }
}

interface RuntimeResolverish {
  resolve(runtimeName: string): AgentRuntime;
}

export function simpleStubScripts(map: Record<string, StubScript | StubTurn[]>): Map<string, StubScript | StubTurn[]> {
  return new Map(Object.entries(map));
}

export const NO_OP_OUTPUT: AgentOutput = {
  text: "",
  operations: [{ op: "done" }],
  tokensUsed: { input: 0, output: 0, total: 0 },
};

/**
 * Async iterable driven by `push`.
 *
 * Runtime commons rather than adapter-local: the Claude adapter needs one to
 * feed the SDK's streaming input, and every adapter implementing
 * `AgentRuntime.stream` needs one to hand events back. It lives here so the
 * second caller does not have to import the first adapter sideways — the
 * mistake already flagged in packages/runtime-claude/src/index.ts for the mesh
 * op parser.
 */
export class PushQueue<T> {
  private items: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private done = false;

  push(item: T): void {
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    this.done = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T, void> {
    for (;;) {
      const buffered = this.items.shift();
      if (buffered !== undefined) {
        yield buffered;
        continue;
      }
      if (this.done) return;
      const r = await new Promise<IteratorResult<T>>((res) => this.waiters.push(res));
      if (r.done) return;
      yield r.value;
    }
  }
}

/**
 * Fold a turn's event stream into the `AgentOutput` the supervisor still reads.
 *
 * Two jobs, both load-bearing:
 *
 * 1. `toolCalls` is rebuilt from `tool_call` / `tool_call_update` frames. It is
 *    the only field genuinely reconstructed here; everything else rides on
 *    `turn_end`, because prose parsing is still per-backend.
 * 2. Text deltas are forwarded to `input.onToken`. This is NOT optional
 *    bookkeeping: the supervisor force-settles a silent turn based on
 *    `phases.firstTokenAt` / `lastTokenAt`, which are set only as a side effect
 *    of that callback. Drop it and a streaming runtime looks permanently mute,
 *    so every turn gets killed at the silence threshold.
 *
 * A stream that ends without `turn_end` is a transport failure — the backend
 * went away mid-turn — and throws, landing on the supervisor's RuntimeFailure
 * path rather than being mistaken for an empty but successful turn.
 */
export async function collectAgentOutput(
  events: AsyncIterable<AgentEvent>,
  input: Pick<AgentInput, "onToken" | "onToolEvent">,
): Promise<AgentOutput> {
  const toolCalls: Array<{ name: string; args: unknown; resultDigest: string }> = [];
  const byId = new Map<string, { name: string; args: unknown; resultDigest: string }>();
  let end: AgentEventTurnEnd | undefined;

  for await (const ev of events) {
    switch (ev.kind) {
      case "agent_message_chunk":
        try {
          input.onToken?.(ev.delta);
        } catch {
          /* observer must never break the turn */
        }
        break;
      case "agent_thought_chunk":
        // Reasoning is not transcript: deliberately not forwarded to onToken,
        // and deliberately not parsed for ops.
        break;
      case "tool_call": {
        const call = { name: ev.name, args: ev.args, resultDigest: ev.resultDigest ?? "" };
        byId.set(ev.toolCallId, call);
        toolCalls.push(call);
        // Observers run after the fold, never before: a throwing subscriber
        // must not be able to leave `toolCalls` missing a call that happened.
        try {
          input.onToolEvent?.(ev);
        } catch {
          /* observer must never break the turn */
        }
        break;
      }
      case "tool_call_update": {
        const call = byId.get(ev.toolCallId);
        if (call && ev.resultDigest !== undefined) call.resultDigest = ev.resultDigest;
        try {
          input.onToolEvent?.(ev);
        } catch {
          /* observer must never break the turn */
        }
        break;
      }
      case "turn_end":
        end = ev;
        break;
    }
  }

  if (!end) throw new Error("agent stream ended without a turn_end frame");

  return {
    text: end.text,
    operations: end.operations,
    ...(end.typedOps !== undefined ? { typedOps: end.typedOps } : {}),
    tokensUsed: end.tokensUsed,
    ...(end.model !== undefined ? { model: end.model } : {}),
    ...(end.modelVersion !== undefined ? { modelVersion: end.modelVersion } : {}),
    ...(end.temperature !== undefined ? { temperature: end.temperature } : {}),
    toolCalls,
    ...(end.summary !== undefined ? { summary: end.summary } : {}),
    ...(end.declaredSummary !== undefined ? { declaredSummary: end.declaredSummary } : {}),
    ...(end.error !== undefined ? { error: end.error } : {}),
  };
}

// ---- mesh op parsing (runtime commons) --------------------------------------
// The mesh op protocol is one contract, so it gets one parser. These lived in
// the opencode adapter until that backend was removed, purely because it was
// written first; they are pure text functions with no backend coupling. Any
// runtime that has to recover ops from prose rather than from typed tool calls
// uses these. The claude runtime takes ops from typed mesh_* MCP tools and
// only falls back here, which is why `typedOps` can be trusted on that path.
const OPS_BLOCK = /```(?:mesh-json|json)?\s*\n?([\s\S]*?)```/g;

export function parseMeshOps(text: string): MeshOp[] {
  const candidates: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(OPS_BLOCK.source, "g");
  while ((m = re.exec(text)) !== null) candidates.push(m[1]);
  const trimmed = text.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) candidates.push(trimmed);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const ops = normalizeOps(parsed);
      if (ops) return ops;
    } catch {
      continue;
    }
  }
  // Salvage path: small models sometimes emit YAML-ish blocks (```mesh-op
  // with `op:` lines) instead of JSON. Only runs when JSON found nothing.
  for (const candidate of candidates) {
    const op = parseYamlishOp(candidate);
    if (op) return [op];
  }
  return [];
}

/**
 * Minimal single-op parser for `key: value` blocks. Narrow by design: only
 * fenced content starting an `op:` key qualifies, multi-line values continue
 * until the next `key:` line. Anything JSON-shaped is left alone.
 */
export function parseYamlishOp(content: string): MeshOp | null {
  if (/^\s*[{[]/.test(content)) return null;
  if (!/^\s*op\s*:/m.test(content)) return null;
  const out: Record<string, unknown> = {};
  let cur = "";
  let started = false;
  for (const line of content.split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w.-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) {
      cur = kv[1];
      started = true;
      out[cur] = stripQuotes(kv[2].trim());
    } else if (started && line.trim().length > 0) {
      out[cur] = `${String(out[cur] ?? "").trimEnd()}\n${line.trim()}`.trim();
    }
  }
  if (!started) return null;
  const aliased = aliasTextOp(out);
  if (!aliased || typeof aliased.op !== "string") return null;
  return aliased as unknown as MeshOp;
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

function normalizeOps(parsed: unknown): MeshOp[] | null {
  const aliased = (x: unknown): MeshOp | null => {
    const a = aliasTextOp(x);
    return a && typeof a.op === "string" ? (a as unknown as MeshOp) : null;
  };
  if (Array.isArray(parsed)) {
    const ops = parsed.map(aliased).filter((x): x is MeshOp => x !== null);
    // Empty array parses but means nothing; fall through to salvage paths.
    if (parsed.length === 0) return null;
    return ops;
  }
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.operations)) {
      return obj.operations.map(aliased).filter((x): x is MeshOp => x !== null);
    }
    const single = aliased(parsed);
    if (single) return [single];
  }
  return null;
}

export function extractSummary(text: string): string | undefined {
  // Skip fenced op blocks AND bare JSON op lines: previously the first line
  // of a ```mesh-json array ("[") became the turn summary, which then rode
  // into agent memory as `turn:<id>: [` — the agent "remembered" success
  // while learning nothing about what actually ran.
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    // Closing delimiters were missed by the original guard (it skipped "[" but
    // not "]" or "},"), so a turn whose ops block ended the reply produced the
    // summary "]" — and that rode into agent memory as `turn:<id>: ]`. Agents
    // then carried a memory of having succeeded at something unnameable. Live
    // runs showed 5+ such entries per agent.
    .find((l) => l.length > 0 && !l.startsWith("```") && !/^[[\]{}(),;]+$/.test(l) && !/^\s*[{[]/.test(l));
  return line?.slice(0, 200);
}

export function extractDeclaredSummary(operations: MeshOp[]): string | undefined {
  // The agent's OWN account of the turn, taken from the `done` op it emitted.
  // `extractSummary` guesses this from the first prose line that is not an op
  // block, which drifts with the model's formatting; a declared summary is
  // what the seat meant to say. Absent when no `done` op carried one, which is
  // the signal to fall back to the scrape.
  for (const op of operations) {
    if (op.op !== "done") continue;
    const summary = op.summary;
    if (typeof summary === "string" && summary.trim().length > 0) return summary.trim().slice(0, 200);
  }
  return undefined;
}

export function shortDigest(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `dgx-${(h >>> 0).toString(16)}`;
}
