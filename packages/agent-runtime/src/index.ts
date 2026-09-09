import type {
  AgentDefinition,
  AgentInput,
  AgentOutput,
  AgentRuntime,
  AgentRuntimeStatus,
  AgentSession,
  MeshOp,
  RuntimeContext,
} from "../../protocol/src/index";
import { newAgentSessionId } from "../../protocol/src/index";

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
  toolCalls?: Array<{ name: string; args: unknown; resultDigest: string }>;
  fail?: string;
  crash?: boolean;
  delayMs?: number;
}

export interface StubOptions {
  scripts: Map<string, StubScript | StubTurn[]>;
  defaultTokens?: number;
}

export class StubRuntime implements AgentRuntime {
  readonly name = "stub";
  private turnIndex = new Map<string, number>();
  private statuses = new Map<string, AgentRuntimeStatus>();
  private sessions = new Map<string, AgentSession>();

  constructor(private options: StubOptions) {}

  setScript(agentId: string, script: StubScript | StubTurn[]): void {
    this.options.scripts.set(agentId, script);
  }

  resetTurns(agentId: string): void {
    this.turnIndex.delete(agentId);
  }

  async start(agent: AgentDefinition, _context: RuntimeContext): Promise<AgentSession> {
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
      toolCalls: turn.toolCalls,
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
