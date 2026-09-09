import {
  BackendUnreachableError,
  isConnectionError,
  type AgentDefinition,
  type AgentInput,
  type AgentOutput,
  type AgentRuntime,
  type AgentRuntimeStatus,
  type AgentSession,
  type RuntimeContext,
} from "../../protocol/src/index";
import { newAgentSessionId } from "../../protocol/src/index";

export interface HttpRuntimeOptions {
  baseUrl: string;
  headers?: Record<string, string>;
  requestTimeoutMs?: number;
  /**
   * Timeout for control-plane calls (start/session-status/interrupt/
   * suspend/resume/stop). These must fail fast: a hung backend holding a
   * session call open is exactly "server not responding", and while a turn
   * waits on it the scheduler slot stays wedged. Model work (`send`) keeps
   * the long `requestTimeoutMs`.
   */
  controlTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class HttpRuntimeAdapter implements AgentRuntime {
  readonly name = "http";
  private statuses = new Map<string, AgentRuntimeStatus>();
  private fetch: typeof fetch;
  private requestTimeoutMs: number;
  private controlTimeoutMs: number;

  constructor(private options: HttpRuntimeOptions) {
    this.fetch = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 600000;
    this.controlTimeoutMs = options.controlTimeoutMs ?? 15000;
  }

  private async call<T>(method: string, urlPath: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.requestTimeoutMs);
    try {
      let res: Response;
      try {
        res = await this.fetch(`${this.options.baseUrl}${urlPath}`, {
          method,
          headers: { "content-type": "application/json", ...(this.options.headers ?? {}) },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        if (isConnectionError(err)) {
          const cause = err instanceof Error ? err.message : String(err);
          throw new BackendUnreachableError(this.options.baseUrl, cause);
        }
        throw err;
      }
      const text = await res.text();
      if (!res.ok) throw new Error(`http runtime ${method} ${urlPath} -> ${res.status}: ${text.slice(0, 300)}`);
      return (text ? JSON.parse(text) : {}) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async start(agent: AgentDefinition, context: RuntimeContext): Promise<AgentSession> {
    try {
      const created = await this.call<{ sessionId?: string }>("POST", "/sessions", {
        agentId: agent.id,
        role: agent.role,
        capabilities: context.capabilityGrants,
        meshId: context.meshId,
        goalId: context.goalId,
      }, this.controlTimeoutMs);
      return {
        sessionId: created.sessionId ?? newAgentSessionId(),
        agentId: agent.id,
        runtime: this.name,
        createdAt: new Date().toISOString(),
        handle: null,
      };
    } catch {
      return {
        sessionId: newAgentSessionId(),
        agentId: agent.id,
        runtime: this.name,
        createdAt: new Date().toISOString(),
        handle: null,
      };
    }
  }

  async send(session: AgentSession, input: AgentInput): Promise<AgentOutput> {
    this.statuses.set(session.agentId, "RUNNING");
    try {
      const out = await this.call<Partial<AgentOutput>>("POST", `/sessions/${session.sessionId}/turn`, {
        agentId: session.agentId,
        goalId: input.goalId,
        activation: input.activation,
        context: input.context,
        instructions: input.instructions,
      });
      this.statuses.set(session.agentId, "IDLE");
      return {
        text: out.text ?? "",
        operations: out.operations ?? [],
        // A backend that reports typed tool invocations bypasses prose
        // parsing; pass the flag through so typed-only meshes accept them.
        typedOps: out.typedOps ?? ((out.toolCalls?.length ?? 0) > 0),
        tokensUsed: out.tokensUsed ?? { input: 0, output: 0, total: 0 },
        model: out.model,
        modelVersion: out.modelVersion,
        temperature: out.temperature,
        toolCalls: out.toolCalls,
        summary: out.summary,
        turnId: out.turnId,
        error: out.error,
      };
    } catch (err) {
      this.statuses.set(session.agentId, "UNREACHABLE");
      throw err;
    }
  }

  async interrupt(session: AgentSession): Promise<void> {
    await this.call("POST", `/sessions/${session.sessionId}/interrupt`, undefined, this.controlTimeoutMs).catch(() => undefined);
  }

  async suspend(session: AgentSession): Promise<void> {
    await this.call("POST", `/sessions/${session.sessionId}/suspend`, undefined, this.controlTimeoutMs).catch(() => undefined);
    this.statuses.set(session.agentId, "SUSPENDED");
  }

  async resume(session: AgentSession): Promise<void> {
    await this.call("POST", `/sessions/${session.sessionId}/resume`, undefined, this.controlTimeoutMs).catch(() => undefined);
    this.statuses.set(session.agentId, "IDLE");
  }

  async stop(session: AgentSession): Promise<void> {
    await this.call("POST", `/sessions/${session.sessionId}/stop`, undefined, this.controlTimeoutMs).catch(() => undefined);
    this.statuses.set(session.agentId, "STOPPED");
  }

  async getStatus(session: AgentSession): Promise<AgentRuntimeStatus> {
    try {
      const r = await this.call<{ status: AgentRuntimeStatus }>("GET", `/sessions/${session.sessionId}`, undefined, this.controlTimeoutMs);
      return r.status ?? this.statuses.get(session.agentId) ?? "IDLE";
    } catch {
      return "UNREACHABLE";
    }
  }
}
