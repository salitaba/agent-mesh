import * as fs from "fs";
import * as path from "path";
import { spawn, type ChildProcess } from "child_process";
import {
  newAgentSessionId,
  type AgentDefinition,
  type AgentInput,
  type AgentOutput,
  type AgentRuntime,
  type AgentRuntimeStatus,
  type AgentSession,
  type MeshOp,
  type RuntimeContext,
} from "../../protocol/src/index";

export interface OpenCodeModelRef {
  providerID: string;
  modelID: string;
}

export interface OpenCodeAdapterOptions {
  executable?: string;
  portBase?: number;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  model?: OpenCodeModelRef;
  spawnProcesses?: boolean;
  baseUrl?: string;
  mcpCommand?: string[];
  extraConfig?: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}

interface ProcessHandle {
  proc?: ChildProcess;
  baseUrl: string;
  configDir: string;
  port?: number;
}

export class OpenCodeRuntimeAdapter implements AgentRuntime {
  readonly name = "opencode";
  private processes = new Map<string, ProcessHandle>();
  private sessionIds = new Map<string, string>();
  private statuses = new Map<string, AgentRuntimeStatus>();
  private executable: string;
  private portBase: number;
  private startupTimeoutMs: number;
  private requestTimeoutMs: number;
  private spawnProcesses: boolean;
  private fetch: typeof fetch;
  private static portCursor = 0;

  constructor(private options: OpenCodeAdapterOptions = {}) {
    this.executable = options.executable ?? "opencode";
    this.portBase = options.portBase ?? 4100;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 30000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 600000;
    this.spawnProcesses = options.spawnProcesses ?? !options.baseUrl;
    this.fetch = options.fetchImpl ?? fetch;
  }

  private async request<T>(baseUrl: string, method: string, urlPath: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const res = await this.fetch(`${baseUrl}${urlPath}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`opencode ${method} ${urlPath} -> ${res.status}: ${text.slice(0, 400)}`);
      }
      return (text ? JSON.parse(text) : {}) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private agentConfigDir(agent: AgentDefinition, context: RuntimeContext): string {
    const dir = path.join(context.workspacePath, ".mesh", "agents", agent.id);
    fs.mkdirSync(dir, { recursive: true });
    const promptFile = path.join(dir, "ROLE.md");
    fs.writeFileSync(promptFile, context.rolePromptText, "utf8");
    const mcpCmd =
      this.options.mcpCommand ?? [
        process.execPath,
        path.resolve(__dirname, "..", "..", "..", "..", "apps", "mesh-cli", "bin", "mesh.mjs"),
        "mcp",
        "--agent",
        agent.id,
        "--bus",
        context.busUrl,
        "--token",
        context.agentToken,
      ];
    const config: Record<string, unknown> = {
      $schema: "https://opencode.ai/config.json",
      instructions: [path.join(dir, "ROLE.md")],
      mcp: {
        mesh: {
          type: "local",
          command: mcpCmd,
          enabled: true,
          environment: {
            MESH_BUS_URL: context.busUrl,
            MESH_AGENT_ID: agent.id,
            MESH_AGENT_TOKEN: context.agentToken,
          },
          timeout: 15000,
        },
      },
      permission: this.permissionsFor(agent, context),
      ...this.options.extraConfig,
    };
    if (this.options.model) {
      config.model = `${this.options.model.providerID}/${this.options.model.modelID}`;
    }
    fs.writeFileSync(path.join(dir, "opencode.json"), JSON.stringify(config, null, 2), "utf8");
    fs.writeFileSync(path.join(dir, "MESH_CONTEXT.md"), `Goal: ${context.goalId}\nMesh: ${context.meshId}\nWorkspace: ${context.workspacePath}\n`, "utf8");
    return dir;
  }

  private permissionsFor(agent: AgentDefinition, context: RuntimeContext): Record<string, unknown> {
    const caps = new Set(context.capabilityGrants.length ? context.capabilityGrants : agent.capabilities);
    const can = (c: string) => (caps.has(c) ? "allow" : "deny");
    return {
      edit: can("repository.write"),
      bash: caps.has("shell.execute") || caps.has("test.execute") ? "allow" : caps.has("git.commit") ? "ask" : "deny",
      webfetch: can("network.request"),
      read: "allow",
    };
  }

  private nextPort(): number {
    const base = this.portBase + ((OpenCodeRuntimeAdapter.portCursor++ * 4 + Math.floor(Math.random() * 4)) % 55000);
    return Math.min(65530, Math.max(1024, base));
  }

  private async ensureProcess(agent: AgentDefinition, context: RuntimeContext): Promise<ProcessHandle> {
    const existing = this.processes.get(agent.id);
    if (existing && (!existing.proc || existing.proc.exitCode === null)) {
      if (await this.probe(existing.baseUrl)) return existing;
      await this.killProcess(agent.id, existing);
    }
    const configDir = this.agentConfigDir(agent, context);
    if (!this.spawnProcesses) {
      const baseUrl = this.options.baseUrl ?? `http://127.0.0.1:${this.portBase}`;
      const handle: ProcessHandle = { baseUrl, configDir };
      this.processes.set(agent.id, handle);
      return handle;
    }
    const port = this.nextPort();
    const cwd = fs.existsSync(context.workspacePath) ? context.workspacePath : configDir;
    const args = ["serve", "--port", String(port), "--hostname", "127.0.0.1"];
    const opts = {
      cwd,
      env: {
        ...process.env,
        ...context.env,
        OPENCODE_CONFIG: path.join(configDir, "opencode.json"),
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    };
    const useShell = process.platform === "win32";
    let proc: ChildProcess;
    try {
      proc = spawn(this.executable, args, { ...opts, shell: useShell } as never);
    } catch (err) {
      throw new Error(`failed to launch '${this.executable}': ${(err as Error).message}`);
    }
    let spawnError: Error | null = null;
    proc.on("error", (err: Error) => {
      spawnError = /ENOENT/i.test(err.message)
        ? new Error(
            `OpenCode CLI not found on PATH ('${this.executable}'). Install OpenCode, point the adapter at a running 'opencode serve' via baseUrl, or set runtime: stub in mesh.yaml.`,
          )
        : err;
    });
    const handle: ProcessHandle = { proc, baseUrl: `http://127.0.0.1:${port}`, configDir, port };
    this.processes.set(agent.id, handle);
    proc.on("exit", () => {
      this.statuses.set(agent.id, "UNREACHABLE");
    });
    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (spawnError) {
        this.processes.delete(agent.id);
        throw spawnError;
      }
      if (proc.exitCode !== null) {
        this.processes.delete(agent.id);
        throw new Error(`opencode serve for ${agent.id} exited early (code ${proc.exitCode}); is '${this.executable}' installed?`);
      }
      if (await this.probe(handle.baseUrl)) return handle;
      await new Promise((r) => setTimeout(r, 250));
    }
    await this.killProcess(agent.id, handle);
    throw new Error(`opencode serve for ${agent.id} did not become reachable within ${this.startupTimeoutMs}ms`);
  }

  private async probe(baseUrl: string): Promise<boolean> {
    const attempts: Array<[string, AbortSignal]> = [];
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 2000);
    attempts.push(["/global/health", controller.signal]);
    try {
      for (const [path, signal] of attempts) {
        try {
          const res = await this.fetch(`${baseUrl}${path}`, { signal });
          if (res.ok) return true;
        } catch {
          /* try next */
        }
      }
      try {
        const res = await this.fetch(`${baseUrl}/session`, { signal: controller.signal });
        return res.ok;
      } catch {
        return false;
      }
    } finally {
      clearTimeout(t);
    }
  }

  private async killProcess(agentId: string, handle: ProcessHandle): Promise<void> {
    if (handle.proc && handle.proc.exitCode === null) {
      handle.proc.kill();
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => resolve(), 2000);
        handle.proc?.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    this.processes.delete(agentId);
  }

  async start(agent: AgentDefinition, context: RuntimeContext): Promise<AgentSession> {
    const handle = await this.ensureProcess(agent, context);
    const created = await this.request<{ id?: string }>(handle.baseUrl, "POST", "/session", {
      title: `mesh:${context.meshId}:${agent.id}`,
    });
    const sessionId = created.id ?? newAgentSessionId();
    this.sessionIds.set(agent.id, sessionId);
    this.statuses.set(agent.id, "IDLE");
    return {
      sessionId,
      agentId: agent.id,
      runtime: this.name,
      createdAt: new Date().toISOString(),
      handle: { baseUrl: handle.baseUrl },
    };
  }

  async restoreSession(agent: AgentDefinition, sessionId: string, context: RuntimeContext): Promise<AgentSession | null> {
    const handle = await this.ensureProcess(agent, context).catch(() => null);
    if (!handle) return null;
    try {
      const info = await this.request<{ id?: string }>(handle.baseUrl, "GET", `/session/${sessionId}`);
      if (info?.id === sessionId) {
        this.sessionIds.set(agent.id, sessionId);
        return {
          sessionId,
          agentId: agent.id,
          runtime: this.name,
          createdAt: new Date().toISOString(),
          handle: { baseUrl: handle.baseUrl },
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  async send(session: AgentSession, input: AgentInput): Promise<AgentOutput> {
    const baseUrl = (session.handle as { baseUrl: string }).baseUrl;
    this.statuses.set(session.agentId, "RUNNING");
    const body: Record<string, unknown> = {
      parts: [{ type: "text", text: input.instructions }],
      system: input.context.rolePrompt,
    };
    if (this.options.model) body.model = this.options.model;
    let response: OpenCodeMessageResponse;
    try {
      response = await this.request<OpenCodeMessageResponse>(baseUrl, "POST", `/session/${session.sessionId}/message`, body);
    } catch (err) {
      this.statuses.set(session.agentId, "UNREACHABLE");
      throw err;
    }
    this.statuses.set(session.agentId, "IDLE");
    const text = extractText(response);
    const operations = parseMeshOps(text);
    const info = response.info ?? response;
    const tokens = info.tokens ?? { input: 0, output: 0, reasoning: 0 };
    const total = (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.reasoning ?? 0) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0);
    return {
      text,
      operations,
      tokensUsed: { input: tokens.input ?? 0, output: tokens.output ?? 0, total },
      model: info.modelID ?? this.options.model?.modelID,
      modelVersion: info.modelID,
      toolCalls: (response.parts ?? [])
        .filter((p) => p.type === "tool")
        .map((p) => ({ name: String(p.tool ?? "tool"), args: p.state?.input ?? {}, resultDigest: shortDigest(JSON.stringify(p.state?.output ?? "")) })),
      summary: extractSummary(text),
    };
  }

  async interrupt(session: AgentSession): Promise<void> {
    const baseUrl = (session.handle as { baseUrl: string }).baseUrl;
    await this.request(baseUrl, "POST", `/session/${session.sessionId}/abort`).catch(() => undefined);
  }

  async suspend(session: AgentSession): Promise<void> {
    await this.interrupt(session);
    this.statuses.set(session.agentId, "SUSPENDED");
  }

  async resume(session: AgentSession): Promise<void> {
    this.statuses.set(session.agentId, "IDLE");
  }

  async stop(session: AgentSession): Promise<void> {
    const handle = this.processes.get(session.agentId);
    if (handle) await this.killProcess(session.agentId, handle);
    this.statuses.set(session.agentId, "STOPPED");
  }

  async getStatus(session: AgentSession): Promise<AgentRuntimeStatus> {
    const baseUrl = (session.handle as { baseUrl: string }).baseUrl;
    const ok = await this.probe(baseUrl);
    return ok ? (this.statuses.get(session.agentId) ?? "IDLE") : "UNREACHABLE";
  }

  async stopAll(): Promise<void> {
    for (const [agentId, handle] of [...this.processes]) {
      await this.killProcess(agentId, handle);
    }
  }
}

interface OpenCodeTokenUsage {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

interface OpenCodeMessageResponse {
  info?: {
    tokens?: OpenCodeTokenUsage;
    modelID?: string;
  };
  tokens?: OpenCodeTokenUsage;
  modelID?: string;
  parts?: Array<{
    type: string;
    text?: string;
    tool?: string;
    state?: { input?: unknown; output?: unknown };
  }>;
}

export function extractText(response: OpenCodeMessageResponse): string {
  const parts = response.parts ?? (Array.isArray(response) ? (response as unknown as OpenCodeMessageResponse["parts"]) : []);
  return (parts ?? [])
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text!)
    .join("\n");
}

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
  return [];
}

function normalizeOps(parsed: unknown): MeshOp[] | null {
  if (Array.isArray(parsed)) {
    const ops = parsed.filter((x) => x && typeof x === "object" && typeof (x as any).op === "string");
    return ops.length > 0 ? (ops as MeshOp[]) : [];
  }
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.operations)) {
      return obj.operations.filter((x) => x && typeof x === "object" && typeof (x as any).op === "string") as MeshOp[];
    }
    if (typeof obj.op === "string") return [obj as unknown as MeshOp];
  }
  return null;
}

function extractSummary(text: string): string | undefined {
  const line = text.split(/\r?\n/).find((l) => l.trim().length > 0 && !l.trim().startsWith("```"));
  return line?.slice(0, 200);
}

function shortDigest(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `dgx-${(h >>> 0).toString(16)}`;
}
