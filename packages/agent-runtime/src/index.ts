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
  RotationPendingInfo,
} from "../../protocol/src/index";
import { newAgentSessionId, aliasTextOp, scanJsonObjects, type AliasOptions } from "../../protocol/src/index";

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

  /**
   * Seats whose next turn should be treated as a handover.
   *
   * The stub has no context window, so there is nothing for `rotationPending`
   * to measure — a test arms it directly. Kept as a one-shot per arming rather
   * than a permanent flag so a test can assert the handover happens ONCE:
   * the supervisor's own once-per-transcript guard is the thing under test,
   * and a stub that answered "pending" forever would hide a bug in it.
   */
  private armedRotation = new Map<string, RotationPendingInfo>();

  /** Make the next `rotationPending` for this seat report a full transcript. */
  armRotation(agentId: string, info: RotationPendingInfo = { transcriptTokens: 600_000, thresholdTokens: 600_000 }): void {
    this.armedRotation.set(agentId, info);
  }

  rotationPending(session: AgentSession): RotationPendingInfo | null {
    return this.armedRotation.get(session.agentId) ?? null;
  }

  /** Model the rotation itself: the transcript is gone and the seat is fresh. */
  clearRotation(agentId: string): void {
    this.armedRotation.delete(agentId);
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

  async resume(session: AgentSession, _agent: AgentDefinition, _context: RuntimeContext): Promise<AgentSession | null> {
    this.statuses.set(session.agentId, "IDLE");
    return session;
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
    ...(end.heldTools !== undefined ? { heldTools: end.heldTools } : {}),
  };
}

// ---- mesh op parsing (runtime commons) --------------------------------------
// The mesh op protocol is one contract, so it gets one parser. These lived in
// the opencode adapter until that backend was removed, purely because it was
// written first; they are pure text functions with no backend coupling. Any
// runtime that has to recover ops from prose rather than from typed tool calls
// uses these. The claude runtime takes ops from typed mesh_* MCP tools and
// only falls back here, which is why `typedOps` can be trusted on that path.
// Every ``` marker, opening or closing, with its language tag. Pairing them is
// deliberately NOT done here: which marker closes a block cannot be decided
// left to right, because a payload may contain its own fence. See
// `opsCandidates`.
const FENCE = /```[ \t]*([A-Za-z0-9_+-]*)[ \t]*\r?\n?/g;
const OPS_FENCE_TAGS = new Set(["", "mesh-json", "meshjson", "json", "mesh-op", "meshop"]);
const MAX_FENCES = 16;
const MAX_CANDIDATES = 24;

/**
 * Block bodies worth trying, best first.
 *
 * The old parser used one lazy regex, which took the FIRST later ``` as the
 * close. A `publish_artifact` whose `content` carries a markdown fence
 * therefore truncated mid-JSON-string — and worse, `exec` advanced past that
 * truncated close, so the real closing fence became the NEXT candidate's
 * OPENING fence and the correct body was never generated as a candidate at
 * all. That is why "try every candidate" did not already rescue it. One live
 * run lost an 18,492-char turn, and the mission's requirements brief with it.
 *
 * So: collect every marker, then offer every (open, close) pair, preferring a
 * recognised tag and then the LONGEST span — the outermost close, which is the
 * one a nested fence cannot fake.
 */
function opsCandidates(text: string): string[] {
  const marks: { tag: string; at: number; bodyAt: number }[] = [];
  const re = new RegExp(FENCE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && marks.length < MAX_FENCES) {
    marks.push({ tag: (m[1] ?? "").toLowerCase(), at: m.index, bodyAt: m.index + m[0].length });
  }
  const scored: { body: string; score: number }[] = [];
  for (let i = 0; i < marks.length; i++) {
    const open = marks[i];
    const tagged = OPS_FENCE_TAGS.has(open.tag) ? 1000 : 0;
    for (let j = marks.length - 1; j > i; j--) {
      scored.push({ body: text.slice(open.bodyAt, marks[j].at), score: tagged + (j - i) });
    }
    // A reply cut off mid-block still carries ops; ranked below any closed span.
    scored.push({ body: text.slice(open.bodyAt), score: tagged - 1 });
  }
  scored.sort((a, b) => b.score - a.score);
  const out = scored.slice(0, MAX_CANDIDATES).map((s) => s.body);
  const trimmed = text.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) out.push(trimmed);
  return out;
}

export interface OpsParseDiagnostic {
  /** True when ops were recovered entry-by-entry after the block as a whole failed. */
  salvaged: boolean;
  /** Entries that could not be read at all, and why. */
  dropped: { index: number; reason: string }[];
}

export interface OpsParseResult {
  ops: MeshOp[];
  diagnostic: OpsParseDiagnostic;
}

/**
 * Parse ops from prose, reporting what could not be read.
 *
 * `parseMeshOps` returns a bare array and therefore cannot distinguish "the
 * model emitted no block" from "the block was malformed" — a distinction the
 * turn summary needs, because one is a contract miss and the other is a bug.
 */
export function parseMeshOpsDetailed(text: string, opts: AliasOptions = {}): OpsParseResult {
  const candidates = opsCandidates(text);
  const clean: OpsParseDiagnostic = { salvaged: false, dropped: [] };

  // 1. The block parses whole — the common case, and the only one that was
  //    ever supported.
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const ops = normalizeOps(parsed, opts);
    // An array whose entries all fail aliasing normalizes to `[]`, which used
    // to be truthy here and short-circuited every remaining candidate AND both
    // salvage paths below. Length is the question, not existence.
    if (ops && ops.length > 0) return { ops, diagnostic: clean };
  }

  // 2. Entry-by-entry salvage. `JSON.parse` on the whole array is
  //    all-or-nothing: in one live run a brace error in the fourth op
  //    destroyed a well-formed `transition_artifact` in the first, and with it
  //    the fix for a deadlock three seats were waiting on. Take the candidate
  //    that yields the most ops, not merely the first that yields any — a
  //    truncated span can produce one valid op while the right span produces
  //    all of them.
  let best: { ops: MeshOp[]; dropped: { index: number; reason: string }[] } | null = null;
  for (const candidate of candidates) {
    const { objects, dropped } = scanJsonObjects(candidate);
    if (objects.length === 0) continue;
    const ops: MeshOp[] = [];
    const bad = [...dropped];
    objects.forEach((obj, i) => {
      const aliased = aliasTextOp(obj, opts);
      if (aliased && typeof aliased.op === "string") ops.push(aliased as unknown as MeshOp);
      else bad.push({ index: i, reason: "no recognisable `op` field" });
    });
    if (ops.length > 0 && (best === null || ops.length > best.ops.length)) best = { ops, dropped: bad };
  }
  if (best) return { ops: best.ops, diagnostic: { salvaged: true, dropped: best.dropped } };

  // 3. Salvage path: small models sometimes emit YAML-ish blocks (```mesh-op
  // with `op:` lines) instead of JSON. Only runs when JSON found nothing.
  for (const candidate of candidates) {
    const op = parseYamlishOp(candidate, opts);
    if (op) return { ops: [op], diagnostic: clean };
  }
  return { ops: [], diagnostic: clean };
}

export function parseMeshOps(text: string, opts: AliasOptions = {}): MeshOp[] {
  return parseMeshOpsDetailed(text, opts).ops;
}

/**
 * Minimal single-op parser for `key: value` blocks. Narrow by design: only
 * fenced content starting an `op:` key qualifies, multi-line values continue
 * until the next `key:` line. Anything JSON-shaped is left alone.
 */
export function parseYamlishOp(content: string, opts: AliasOptions = {}): MeshOp | null {
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
  const aliased = aliasTextOp(out, opts);
  if (!aliased || typeof aliased.op !== "string") return null;
  return aliased as unknown as MeshOp;
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

function normalizeOps(parsed: unknown, opts: AliasOptions = {}): MeshOp[] | null {
  const aliased = (x: unknown): MeshOp | null => {
    const a = aliasTextOp(x, opts);
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
