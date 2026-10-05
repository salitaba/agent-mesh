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
  ToolCallRecord,
} from "../../protocol/src/index";
import {
  newAgentSessionId,
  InterruptedTurnError,
  BackendUnreachableError,
  RequestTimeoutError,
} from "../../protocol/src/index";

export type StubScript = (input: AgentInput, turnIndex: number, session: AgentSession) => StubTurn | Promise<StubTurn>;

export interface StubTurn {
  text?: string;
  operations?: MeshOp[];
  /** Mark the turn's ops as typed (MCP) rather than structured-output ops. */
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
  toolCalls?: ToolCallRecord[];
  fail?: string;
  crash?: boolean;
  delayMs?: number;
  /**
   * Usage the backend reports when this turn's `delayMs` is aborted by
   * `interrupt` — the real CLI answers a mesh-ordered abort with a `result` frame
   * carrying one, and that figure is the only cost a killed turn ever has.
   *
   * Only meaningful together with `delayMs`, since an immediate turn has nothing
   * to abort. Omitted means the backend did not report, which is the other case
   * worth testing: the turn must then be billed nothing rather than zero.
   */
  interruptUsage?: { input: number; output: number; total: number };

  // ---- hostile modes -------------------------------------------------------
  // Everything below exists so a fixture can be a BAD agent. Each is opt-in per
  // turn and leaves a turn that sets none of them exactly as it was.

  /**
   * Never answer, and IGNORE `interrupt()`, like a backend that has stopped
   * reading its socket. The turn only ends when the supervisor gives up on it
   * (turn timeout + grace, or the silence watchdog's forced settle). Release
   * stragglers at teardown with `StubRuntime.releaseHangs()`.
   */
  hang?: boolean;
  /**
   * Like `hang`, but answer normally after this many ms — still ignoring any
   * interrupt. Models the late answer that arrives after the mesh already
   * settled the turn as failed.
   */
  hangMs?: number;
  /**
   * Fail with the typed error the supervisor classifies on, after `delayMs` if
   * set:
   * - `backend_unreachable` → `BackendUnreachableError` (dead backend, respawn ladder)
   * - `request_timeout`     → `RequestTimeoutError` (slow backend, timeout-retry ladder)
   * - `interrupted`         → `InterruptedTurnError` carrying `interruptUsage`
   * - `generic`             → plain `Error`
   * `crash: true` is the older generic form and also marks the seat UNREACHABLE.
   */
  throwKind?: "backend_unreachable" | "request_timeout" | "interrupted" | "generic";
  /** Message for `throwKind`. */
  throwMessage?: string;
  /**
   * Streaming only (see `StubRuntime.setStreaming`): text deltas emitted as
   * `agent_message_chunk` frames before the turn resolves. They reach
   * `input.onToken`, which is what stamps `phases.firstTokenAt/lastTokenAt`.
   * Omitted in streaming mode means one chunk holding the turn's text (if any).
   */
  tokens?: string[];
  /** Streaming only: pause between token frames, in ms. */
  tokenIntervalMs?: number;
  /**
   * Streaming only: cumulative usage figures emitted as `usage_update` frames
   * after the token frames and before the turn body (delay, hang, failure), so
   * a fixture can put live spend in front of the supervisor while the turn is
   * still running — which is the only time the mid-turn budget check can act.
   */
  liveUsage?: Array<AgentOutput["tokensUsed"]>;
  /**
   * Streaming only: emit this many token frames and then go SILENT — no more
   * frames until `interrupt()`, which then aborts with `InterruptedTurnError`
   * (combine with `hang: true` to also ignore the interrupt). This is the shape
   * the silence watchdog exists for.
   */
  silentAfterTokens?: number;
  /**
   * Streaming only: close the stream after this many frames WITHOUT a
   * `turn_end`, i.e. the transport died mid-turn. `collectAgentOutput` turns
   * that into a thrown error.
   */
  dieAfterFrames?: number;
}

export interface StubOptions {
  scripts: Map<string, StubScript | StubTurn[]>;
  defaultTokens?: number;
  /** Start with `stream()` exposed. Same as calling `setStreaming(true)`. */
  streaming?: boolean;
}

type StubStreamFn = (session: AgentSession, input: AgentInput) => AsyncIterable<AgentEvent>;

/** Fields that only mean something on the streaming path. */
const STREAM_ONLY_FIELDS = ["tokens", "tokenIntervalMs", "liveUsage", "silentAfterTokens", "dieAfterFrames"] as const;

/**
 * What a scripted turn reports when it says nothing about tools: one real
 * (non-`mesh_*`) invocation, i.e. "this agent went and did something". See
 * StubTurn.toolCalls.
 */
export const DEFAULT_STUB_TOOL_CALLS: ToolCallRecord[] = [
  { name: "stub_work", args: {}, resultDigest: "stub" },
];

export class StubRuntime implements AgentRuntime {
  readonly name = "stub";
  private turnIndex = new Map<string, number>();
  /** Rejectors for in-flight delayed turns, so `interrupt` can actually abort one. */
  private pendingAborts = new Map<string, () => void>();
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
  /**
   * Seats whose backend process is dead. `permanent` survives a restart;
   * otherwise the next `start`/`restoreSession`/`resume` (a respawn) clears it.
   */
  private dead = new Map<string, { permanent: boolean }>();
  /** Resolvers for `hang`/`hangMs` turns, so a test can release them at teardown. */
  private hangs = new Set<() => void>();
  private streaming: boolean;

  constructor(private options: StubOptions) {
    this.streaming = options.streaming === true;
  }

  /**
   * Expose (or hide) `stream()`.
   *
   * Runtime-wide rather than per turn because the supervisor picks
   * `stream` vs `send` by asking whether the METHOD exists
   * (`session.runtime.stream ? ... : send`), before any script runs. Off by
   * default so every existing fixture stays on the `send` path it was written
   * against: `collectAgentOutput` rebuilds `toolCalls` from frames and fires
   * `onToolEvent`, which is observable.
   */
  setStreaming(on: boolean): void {
    this.streaming = on;
  }

  /** `stream` exists only while streaming is on; see `setStreaming`. */
  get stream(): StubStreamFn | undefined {
    return this.streaming ? (session, input) => this.streamTurn(session, input) : undefined;
  }

  /** Let every in-flight `hang`/`hangMs` turn answer now. Call at teardown. */
  releaseHangs(): void {
    for (const release of [...this.hangs]) release();
  }

  /** Notes `advise` accepted, per agent, oldest first. */
  private advice = new Map<string, string[]>();

  /**
   * Accepts a note only while the seat has a turn running, like a real
   * adapter, which has no turn to fold it into otherwise. Recorded rather than
   * delivered: the stub has no model to show it to, so a test asserts on
   * `advisedFor` instead.
   */
  advise(session: AgentSession, text: string): boolean {
    if (this.statuses.get(session.agentId) !== "RUNNING") return false;
    const seen = this.advice.get(session.agentId) ?? [];
    seen.push(text);
    this.advice.set(session.agentId, seen);
    return true;
  }

  /** Every note `advise` accepted for this agent, oldest first. */
  advisedFor(agentId: string): string[] {
    return [...(this.advice.get(agentId) ?? [])];
  }

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
    this.respawn(agent.id);
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
    const { turn, idx } = await this.nextTurn(session, input);
    const stray = STREAM_ONLY_FIELDS.filter((k) => turn[k] !== undefined);
    if (stray.length > 0) {
      // Loud rather than ignored: a fixture that scripts tokens on the `send`
      // path would otherwise pass while never touching the path it names.
      throw new Error(`stub turn for ${session.agentId} sets ${stray.join(", ")} but streaming is off — call setStreaming(true)`);
    }
    await this.playTurnBody(session.agentId, turn);
    return this.outputFor(session.agentId, idx, turn);
  }

  /** Resolve the scripted turn, after the death and crash checks every path shares. */
  private async nextTurn(session: AgentSession, input: AgentInput): Promise<{ turn: StubTurn; idx: number }> {
    const agentId = session.agentId;
    if (this.dead.has(agentId)) {
      // The process is gone but nothing noticed between turns (the status was
      // not updated), so the failure surfaces where it does for a real
      // adapter: on the next send, as a dead backend.
      this.statuses.set(agentId, "UNREACHABLE");
      throw new BackendUnreachableError(`stub:${agentId}`, "the stub process was killed by simulateProcessDeath");
    }
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
    return { turn, idx };
  }

  /** Delay, hang and typed failure: everything between "turn started" and "turn answered". */
  private async playTurnBody(agentId: string, turn: StubTurn): Promise<void> {
    if (turn.delayMs) await this.abortableDelay(agentId, turn.delayMs, turn);
    if (turn.hang || turn.hangMs !== undefined) {
      // Deliberately NOT registered in `pendingAborts`: `interrupt()` must not
      // reach this turn. That is the whole mode.
      await new Promise<void>((resolve) => {
        const release = (): void => {
          if (timer) clearTimeout(timer);
          this.hangs.delete(release);
          resolve();
        };
        const timer = turn.hang ? undefined : setTimeout(release, turn.hangMs);
        this.hangs.add(release);
      });
    }
    if (turn.throwKind) {
      this.statuses.set(agentId, "IDLE");
      const msg = turn.throwMessage ?? `stub ${turn.throwKind} for ${agentId}`;
      switch (turn.throwKind) {
        case "backend_unreachable":
          this.statuses.set(agentId, "UNREACHABLE");
          throw new BackendUnreachableError(`stub:${agentId}`, msg);
        case "request_timeout":
          throw new RequestTimeoutError(`stub:${agentId}`, msg, turn.delayMs ?? 0);
        case "interrupted":
          throw new InterruptedTurnError(msg, turn.interruptUsage);
        case "generic":
          throw new Error(msg);
      }
    }
  }

  private abortableDelay(agentId: string, ms: number, turn: StubTurn): Promise<void> {
    // A delayed turn is abortable, so a fixture can model the one case that
    // matters for cost accounting: the mesh orders an interrupt and the backend
    // answers it with real usage. Without this the stub's `interrupt` was a
    // no-op, every timed-out turn reported no tokens, and the billing path for
    // a killed turn could not be exercised by any test at all.
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAborts.delete(agentId);
        resolve();
      }, ms);
      this.pendingAborts.set(agentId, () => {
        clearTimeout(timer);
        this.pendingAborts.delete(agentId);
        this.statuses.set(agentId, "IDLE");
        reject(
          turn.interruptUsage
            ? new InterruptedTurnError(`stub turn for ${agentId} aborted`, turn.interruptUsage)
            : new InterruptedTurnError(`stub turn for ${agentId} aborted`),
        );
      });
    });
  }

  private outputFor(agentId: string, idx: number, turn: StubTurn): AgentOutput {
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

  /**
   * The streaming twin of `send`: token frames, then the same body (delay,
   * hang, typed failure), then one `tool_call`/`tool_call_update` pair per
   * tool call and a `turn_end`. `collectAgentOutput` folds it back into the
   * same `AgentOutput` `send` would have returned.
   */
  private async *streamTurn(session: AgentSession, input: AgentInput): AsyncGenerator<AgentEvent, void> {
    const agentId = session.agentId;
    const { turn, idx } = await this.nextTurn(session, input);
    const out = (): AgentOutput => this.outputFor(agentId, idx, turn);
    const tokens = turn.tokens ?? (turn.text ? [turn.text] : []);
    let frames = 0;
    const cut = (): boolean => turn.dieAfterFrames !== undefined && frames >= turn.dieAfterFrames;
    for (let i = 0; i < tokens.length; i++) {
      if (turn.silentAfterTokens !== undefined && i >= turn.silentAfterTokens) break;
      if (cut()) return;
      if (i > 0 && turn.tokenIntervalMs) await new Promise((r) => setTimeout(r, turn.tokenIntervalMs));
      yield { kind: "agent_message_chunk", delta: tokens[i] };
      frames++;
    }
    for (const tokensUsed of turn.liveUsage ?? []) {
      if (cut()) return;
      yield { kind: "usage_update", tokensUsed };
      frames++;
    }
    if (turn.silentAfterTokens !== undefined) {
      // Silent until interrupted. `hang` makes the interrupt a no-op as well,
      // handled by playTurnBody below; without it the interrupt aborts here.
      if (!turn.hang) {
        await new Promise<void>((_, reject) => {
          this.pendingAborts.set(agentId, () => {
            this.pendingAborts.delete(agentId);
            this.statuses.set(agentId, "IDLE");
            reject(new InterruptedTurnError(`stub turn for ${agentId} aborted while silent`, turn.interruptUsage));
          });
        });
      }
    }
    await this.playTurnBody(agentId, turn);
    const output = out();
    const calls = output.toolCalls ?? [];
    for (let i = 0; i < calls.length; i++) {
      const id = `stub-tc-${idx}-${i}`;
      if (cut()) return;
      yield { kind: "tool_call", toolCallId: id, name: calls[i].name, args: calls[i].args, resultDigest: calls[i].resultDigest };
      frames++;
      if (cut()) return;
      // A scripted call may say it failed, so a fixture can model the refused
      // tool call the Claude gate produces; one that says nothing completed,
      // which is what every fixture written before the field meant.
      yield {
        kind: "tool_call_update",
        toolCallId: id,
        status: calls[i].status ?? "completed",
        resultDigest: calls[i].resultDigest,
        ...(calls[i].error !== undefined ? { error: calls[i].error } : {}),
      };
      frames++;
    }
    if (cut()) return;
    yield {
      kind: "turn_end",
      stopReason: output.error !== undefined ? "error" : "end_turn",
      text: output.text,
      operations: output.operations,
      ...(output.typedOps !== undefined ? { typedOps: output.typedOps } : {}),
      tokensUsed: output.tokensUsed,
      model: output.model,
      modelVersion: output.modelVersion,
      temperature: output.temperature,
      ...(output.summary !== undefined ? { summary: output.summary } : {}),
      ...(output.declaredSummary !== undefined ? { declaredSummary: output.declaredSummary } : {}),
      ...(output.error !== undefined ? { error: output.error } : {}),
    };
  }

  async interrupt(session: AgentSession): Promise<void> {
    // Undelayed stub turns are synchronous and immediate, so there is nothing to
    // abort; a delayed turn (or a stream gone silent) parks a rejector here and
    // answers with `InterruptedTurnError`, carrying `interruptUsage` when the
    // fixture set it. `hang`/`hangMs` turns deliberately never register one.
    this.pendingAborts.get(session.agentId)?.();
  }

  async suspend(session: AgentSession): Promise<void> {
    this.statuses.set(session.agentId, "SUSPENDED");
  }

  async resume(session: AgentSession, _agent: AgentDefinition, _context: RuntimeContext): Promise<AgentSession | null> {
    this.respawn(session.agentId);
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
    this.respawn(agent.id);
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

  /**
   * Kill the seat's backend process between turns.
   *
   * The next `send`/`stream` throws `BackendUnreachableError`, which is what a
   * real adapter raises when its process is gone. This used to write a script
   * under `__dead__<id>`, a key nothing read, so a "dead" seat answered its
   * next turn with a well-formed success.
   *
   * The status is left as it was on purpose: `ensureSession` respawns a seat
   * whose status already reads UNREACHABLE before ever calling `send`, so
   * reporting it would model a death the mesh noticed and routed around, not
   * one it has to recover from. Pass `detected: true` for that case.
   *
   * A respawn (`start`, `restoreSession`, `resume`) brings the process back,
   * unless `permanent` — then every turn fails, which is what drives the
   * restart ladder to its `backend_unreachable` escalation.
   */
  simulateProcessDeath(agentId: string, opts: { permanent?: boolean; detected?: boolean } = {}): void {
    this.dead.set(agentId, { permanent: opts.permanent === true });
    if (opts.detected) this.statuses.set(agentId, "UNREACHABLE");
  }

  /** Is this seat's simulated process currently dead? */
  isDead(agentId: string): boolean {
    return this.dead.has(agentId);
  }

  private respawn(agentId: string): void {
    if (this.dead.get(agentId)?.permanent === false) this.dead.delete(agentId);
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
 * second caller does not have to import the first adapter sideways.
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
 *    `turn_end`.
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
  input: Pick<AgentInput, "onToken" | "onToolEvent" | "onUsage">,
): Promise<AgentOutput> {
  const toolCalls: ToolCallRecord[] = [];
  const byId = new Map<string, ToolCallRecord>();
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
        // Reasoning is not transcript: deliberately not forwarded to onToken.
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
        // The outcome is kept, not just the digest. Dropping it here is what
        // made a refused call indistinguishable from a successful one in every
        // record downstream: the digest is a hash of whatever came back, and a
        // permission denial hashes as readily as a file's contents. `error` is
        // only ever carried on a failure, so a stale one cannot outlive a later
        // "completed" for the same id.
        if (call) {
          call.status = ev.status;
          if (ev.status === "failed" && ev.error !== undefined) call.error = ev.error;
          else delete call.error;
        }
        try {
          input.onToolEvent?.(ev);
        } catch {
          /* observer must never break the turn */
        }
        break;
      }
      case "usage_update":
        // Observability and the live budget check only: the billed figure is
        // still `turn_end.tokensUsed`, so nothing here is folded into the output.
        try {
          input.onUsage?.(ev.tokensUsed);
        } catch {
          /* observer must never break the turn */
        }
        break;
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
    ...(end.usageGuard !== undefined ? { usageGuard: end.usageGuard } : {}),
  };
}

/**
 * The turn's summary when the seat did not declare one through `mesh_done`:
 * the first non-empty line of its reply. Ops arrive only as typed tool calls,
 * so the reply is plain prose and needs no op-block filtering.
 */
export function extractSummary(text: string): string | undefined {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line?.slice(0, 200);
}

export function shortDigest(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `dgx-${(h >>> 0).toString(16)}`;
}

// The rules every runtime enforces on a seat's tools, and the prompt text no backend words differently.
export * from "./tool-gate";
export * from "./landing-gate";
export * from "./prompt";
export * from "./env";
