import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDefinition, AgentEvent, AgentInput, RuntimeContext } from "../../packages/protocol/src/index";
import { abortError, type LlmProvider, type ModelEvent, type ModelRequest, type ModelUsage, type StopReason } from "../../packages/llm/src/index";
import { NativeRuntime, type NativeRuntimeOptions } from "../../packages/runtime-native/src/index";
import { fakeServer, json, type FakeServer } from "../llm/fake-server";

/** One scripted model answer. */
export interface Reply {
  text?: string | string[];
  reasoning?: string;
  tools?: Array<{ name: string; args?: Record<string, unknown>; id?: string; invalid?: string }>;
  stop?: StopReason;
  usage?: Partial<ModelUsage>;
  /** The model name the provider reports. */
  model?: string;
  /** Throw instead of answering. */
  fail?: Error;
  /** Never finish: wait until the call is aborted. */
  hang?: boolean;
  /** Runs when the call starts, before anything is yielded. */
  before?: () => void | Promise<void>;
}

/** A provider that answers from a script and keeps what it was asked, as it was when it was asked. */
export class ScriptedProvider implements LlmProvider {
  readonly kind: string;
  readonly endpoint = "scripted";
  requests: ModelRequest[] = [];
  private n = 0;

  constructor(
    private readonly script: Array<Reply | ((req: ModelRequest, call: number) => Reply)>,
    kind = "openai-compatible",
    private readonly models: string[] = ["m-1"],
  ) {
    this.kind = kind;
  }

  async listModels(): Promise<string[]> {
    return this.models;
  }

  /** Start the script over, as if no call had been made. */
  reset(): void {
    this.n = 0;
    this.requests = [];
  }

  async *stream(req: ModelRequest): AsyncGenerator<ModelEvent, void> {
    // The loop extends the conversation after this call, so the request is copied as it stands.
    const { signal, ...rest } = req;
    this.requests.push(structuredClone(rest) as ModelRequest);
    const step = this.script[Math.min(this.n, this.script.length - 1)];
    const call = this.n++;
    const reply = typeof step === "function" ? step(req, call) : (step ?? {});
    await reply.before?.();
    if (reply.fail) throw reply.fail;
    if (reply.hang) {
      await new Promise<void>((_, reject) => {
        if (signal?.aborted) return reject(abortError());
        signal?.addEventListener("abort", () => reject(abortError()), { once: true });
      });
    }
    const deltas = reply.text === undefined ? [] : Array.isArray(reply.text) ? reply.text : [reply.text];
    if (reply.reasoning) yield { kind: "reasoning", delta: reply.reasoning };
    for (const d of deltas) yield { kind: "text", delta: d };
    const toolCalls = (reply.tools ?? []).map((t, i) => ({
      id: t.id ?? `call_${call}_${i}`,
      name: t.name,
      args: t.invalid !== undefined ? {} : (t.args ?? {}),
      ...(t.invalid !== undefined ? { invalidArgs: t.invalid } : {}),
    }));
    for (const c of toolCalls) yield { kind: "tool_call", call: c };
    yield {
      kind: "end",
      result: {
        text: deltas.join(""),
        toolCalls,
        stopReason: reply.stop ?? (toolCalls.length > 0 ? "tool_use" : "end_turn"),
        usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, ...reply.usage },
        model: reply.model ?? "m-1-snapshot",
      },
    };
  }
}

export const BUS_TOOLS = [
  { name: "mesh_send", description: "Send a message", inputSchema: { type: "object", properties: { to: { type: "array", items: { type: "string" } }, note: { type: "string" } } } },
  { name: "mesh_done", description: "End the turn", inputSchema: { type: "object", properties: {} } },
  { name: "mesh_artifact_read", description: "Read an artifact", inputSchema: { type: "object", properties: { artifactRef: { type: "string" } } } },
];

export interface FakeBus {
  server: FakeServer;
  /** Every tools/call the bus took. */
  calls: Array<{ name: string; args: Record<string, unknown>; token: string | string[] | undefined; url: string }>;
  close(): Promise<void>;
}

/** The bus as the runtime meets it: JSON-RPC at /internal/mcp/<agent>. `answer` decides what a call returns. */
export async function fakeBus(answer: (name: string, args: Record<string, unknown>) => { text: string; isError?: boolean } = () => ({ text: '{"ok":true}' })): Promise<FakeBus> {
  const calls: FakeBus["calls"] = [];
  const server = await fakeServer((req, res) => {
    const { id, method, params } = req.body;
    if (method === "tools/list") return json(res, 200, { jsonrpc: "2.0", id, result: { tools: BUS_TOOLS } });
    if (method === "tools/call") {
      calls.push({ name: params.name, args: params.arguments, token: req.headers["x-mesh-token"], url: req.url });
      const r = answer(params.name, params.arguments);
      return json(res, 200, { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: r.text }], isError: r.isError === true } });
    }
    return json(res, 200, { jsonrpc: "2.0", id, result: {} });
  });
  return { server, calls, close: () => server.close() };
}

export function agent(extra: Partial<AgentDefinition> & { id?: string } = {}): AgentDefinition {
  return {
    id: "dev",
    role: "developer",
    mode: "peer",
    runtime: "native",
    model: "scripted/m-1",
    capabilities: ["repository.read"],
    authority: [],
    interests: [],
    ...extra,
  } as unknown as AgentDefinition;
}

export interface Rig {
  base: string;
  workspace: string;
  product: string;
  cleanup(): void;
}

export function rig(): Rig {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "native-rt-")));
  const workspace = path.join(base, "ws");
  const product = path.join(base, "main");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(product, { recursive: true });
  return { base, workspace, product, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

export function context(r: Rig, bus: FakeBus, extra: Partial<RuntimeContext> = {}): RuntimeContext {
  return {
    goalId: "goal-1",
    meshId: "mesh-1",
    workspacePath: r.workspace,
    busUrl: bus.server.url,
    agentToken: "seat-token",
    rolePromptText: "You are the developer.",
    capabilityGrants: [],
    productPath: r.product,
    env: { MESH_AGENT_ID: "dev" },
    ...extra,
  };
}

export const turnInput = (instructions = "Do the work.", extra: Partial<AgentInput> = {}): AgentInput =>
  ({ agentId: "dev", goalId: "goal-1", activation: { kind: "manual" }, context: {} as never, instructions, ...extra }) as AgentInput;

export function runtimeFor(provider: LlmProvider, extra: Partial<NativeRuntimeOptions> = {}, name = "scripted"): NativeRuntime {
  return new NativeRuntime({
    providers: { [name]: { kind: "openai-compatible", baseUrl: "http://unused.invalid/v1" } },
    createProvider: () => provider,
    bus: { sleep: async () => undefined, startupDelaysMs: [1, 1], connectDelaysMs: [1] },
    ...extra,
  });
}

export async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

export const turnEnd = (events: AgentEvent[]) => {
  const e = events.find((x): x is Extract<AgentEvent, { kind: "turn_end" }> => x.kind === "turn_end");
  if (!e) throw new Error("no turn_end frame");
  return e;
};

/** A promise whose resolution the test controls. */
export function gate(): { wait: Promise<void>; open(): void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}
