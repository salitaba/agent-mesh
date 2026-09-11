import * as readline from "readline";

export interface McpBridgeOptions {
  agent: string;
  bus: string;
  token: string;
  /**
   * Expose only the observability tools. The bus enforces this server-side
   * (it serves a read-only toolset for `?readOnly=1`), so the flag is a
   * capability reduction the caller cannot use to gain access.
   */
  readOnly?: boolean;
}

export async function runStdioMcpBridge(options: McpBridgeOptions): Promise<void> {
  const env = process.env;
  const agent = options.agent || env.MESH_AGENT_ID || "";
  const bus = options.bus || env.MESH_BUS_URL || DEFAULT_BUS;
  const token = options.token || env.MESH_AGENT_TOKEN || "";
  if (!agent || !token) {
    process.stderr.write("mesh mcp: --agent and --token (or MESH_AGENT_ID / MESH_AGENT_TOKEN) are required\n");
    process.exit(2);
  }
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  // Every write is tracked so the loop can flush before resolving: callers
  // (`main` → `mesh.mjs`) exit the process the moment this function returns,
  // and `process.exit` truncates async pipe writes.
  const flushing: Array<Promise<void>> = [];
  // In-flight calls are drained before resolving for the same reason: a client
  // that sends requests and closes stdin must still get its replies.
  const pending = new Set<Promise<void>>();
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let request: Record<string, unknown>;
    try {
      request = JSON.parse(trimmed);
    } catch {
      writeResponse({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    const done = handle(request);
    pending.add(done);
    void done.finally(() => pending.delete(done));
  });
  await new Promise<void>((resolve) => {
    rl.on("close", () => {
      void Promise.all([...pending])
        .then(() => Promise.all(flushing))
        .finally(resolve);
    });
  });

  async function handle(request: Record<string, unknown>): Promise<void> {
    const isNotification = !("id" in request) || request.id === null || request.id === undefined;
    try {
      const url = `${bus}/internal/mcp/${encodeURIComponent(agent)}${options.readOnly ? "?readOnly=1" : ""}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-mesh-token": token },
        body: JSON.stringify(request),
      });
      const json = (await res.json()) as Record<string, unknown>;
      // JSON-RPC notifications must not receive a response
      if (!isNotification) writeResponse(json);
    } catch (err) {
      if (!isNotification) {
        writeResponse({
          jsonrpc: "2.0",
          id: request.id ?? null,
          error: { code: -32000, message: `mesh bus unreachable: ${(err as Error).message}` },
        });
      }
    }
  }

  function writeResponse(payload: unknown): void {
    flushing.push(new Promise((resolve) => process.stdout.write(JSON.stringify(payload) + "\n", () => resolve())));
  }
}

const DEFAULT_BUS = "http://127.0.0.1:7420";
