import type { JsonObject, ToolSpec } from "../../llm/src/index";

/**
 * The mesh bus, spoken to directly over HTTP.
 *
 * The bus already serves MCP at `/internal/mcp/<agent>` as plain JSON-RPC, authenticated by a per-seat token: it is what
 * `curule mcp` bridges to a CLI's stdio. A runtime that makes its own tool calls has no use for the stdio hop, so it posts
 * the same requests itself. Nothing about the bus changes: the same toolset, the same gate on every op, the same token.
 */

export class BusError extends Error {
  /** The bus could not be reached, or answered with a server failure: a restart, not a refusal. */
  readonly unreachable: boolean;
  constructor(message: string, unreachable: boolean) {
    super(message);
    this.name = "BusError";
    this.unreachable = unreachable;
  }
}

export interface BusClientOptions {
  busUrl: string;
  agentId: string;
  token: string;
  /** The full URL to post to, when it is not `<busUrl>/internal/mcp/<agentId>` (the designer's staging endpoint carries a query). */
  endpoint?: string;
  /** Headers sent in addition to the token's. */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  /** Waits between attempts to list the tools while the bus is not up yet. Its length is the number of retries. */
  startupDelaysMs?: number[];
  /** Waits between attempts of a call the bus refused to take because it was not listening. */
  connectDelaysMs?: number[];
  requestTimeoutMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** A restarting mesh server takes a few seconds to listen again; this is sized to ride that out, well inside a turn's deadline. */
export const DEFAULT_STARTUP_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000, 15_000];
const DEFAULT_CONNECT_DELAYS_MS = [100, 400, 1_600];

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(Object.assign(new Error("aborted"), { name: "AbortError" }))), { once: true });
  });

const causeCode = (err: unknown): string | undefined => {
  const code = (err as { cause?: { code?: unknown } })?.cause?.code;
  return typeof code === "string" ? code : undefined;
};

export class BusClient {
  private id = 0;
  private readonly doFetch: typeof fetch;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly o: BusClientOptions) {
    this.doFetch = o.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = o.sleep ?? defaultSleep;
  }

  private url(): string {
    return this.o.endpoint ?? `${this.o.busUrl.replace(/\/+$/, "")}/internal/mcp/${encodeURIComponent(this.o.agentId)}`;
  }

  private async rpc(method: string, params: JsonObject, signal?: AbortSignal): Promise<JsonObject> {
    const timeout = AbortSignal.timeout(this.o.requestTimeoutMs ?? 60_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.doFetch(this.url(), {
        method: "POST",
        headers: { "content-type": "application/json", "x-mesh-token": this.o.token, ...this.o.headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
        signal: combined,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      if (timeout.aborted) throw new BusError(`mesh bus did not answer within ${(this.o.requestTimeoutMs ?? 60_000) / 1000}s`, true);
      throw new BusError(`mesh bus unreachable: ${causeCode(err) ?? (err as Error).message}`, true);
    }
    if (res.status >= 500) throw new BusError(`mesh bus answered ${res.status}`, true);
    let body: JsonObject;
    try {
      body = (await res.json()) as JsonObject;
    } catch {
      throw new BusError(`mesh bus answered ${res.status} with something that is not JSON`, res.status >= 500);
    }
    const error = body.error as { message?: unknown } | undefined;
    if (error) throw new BusError(typeof error.message === "string" ? error.message : "mesh bus refused the request", false);
    return (body.result ?? {}) as JsonObject;
  }

  /** The seat's tools, retried while the bus is still coming up. A refusal (a bad token) is final at once. */
  async listTools(signal?: AbortSignal): Promise<ToolSpec[]> {
    const delays = this.o.startupDelaysMs ?? DEFAULT_STARTUP_DELAYS_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await this.rpc("tools/list", {}, signal);
        const tools = Array.isArray(result.tools) ? (result.tools as Array<Record<string, unknown>>) : [];
        return tools
          .filter((t) => typeof t.name === "string")
          .map((t) => ({
            name: t.name as string,
            description: typeof t.description === "string" ? t.description : "",
            inputSchema: (t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : { type: "object", properties: {} }) as JsonObject,
          }));
      } catch (err) {
        if (!(err instanceof BusError) || !err.unreachable || attempt >= delays.length) throw err;
        await this.sleep(delays[attempt]!, signal);
      }
    }
  }

  /**
   * One tool call. Never retried once the bus has taken it, because an op is not idempotent; retried only when the bus was not
   * listening at all (the connection was refused), which means the request was never sent.
   */
  async call(name: string, args: JsonObject, signal?: AbortSignal): Promise<{ text: string; isError: boolean }> {
    const delays = this.o.connectDelaysMs ?? DEFAULT_CONNECT_DELAYS_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await this.rpc("tools/call", { name, arguments: args }, signal);
        const content = Array.isArray(result.content) ? (result.content as Array<{ type?: unknown; text?: unknown }>) : [];
        const text = content.map((c) => (c.type === "text" && typeof c.text === "string" ? c.text : "")).filter((t) => t !== "").join("\n");
        return { text: text || "(no output)", isError: result.isError === true };
      } catch (err) {
        if (err instanceof BusError && err.unreachable && /ECONNREFUSED/.test(err.message) && attempt < delays.length) {
          await this.sleep(delays[attempt]!, signal);
          continue;
        }
        if (err instanceof Error && err.name === "AbortError") throw err;
        return { text: err instanceof BusError ? err.message : `mesh bus error: ${(err as Error).message}`, isError: true };
      }
    }
  }
}
