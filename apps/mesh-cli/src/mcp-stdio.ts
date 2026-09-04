import * as readline from "readline";

export interface McpBridgeOptions {
  agent: string;
  bus: string;
  token: string;
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
    void handle(request);
  });
  rl.on("close", () => process.exit(0));

  async function handle(request: Record<string, unknown>): Promise<void> {
    const isNotification = !("id" in request) || request.id === null || request.id === undefined;
    try {
      const res = await fetch(`${bus}/internal/mcp/${encodeURIComponent(agent)}`, {
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
    process.stdout.write(JSON.stringify(payload) + "\n");
  }
}

const DEFAULT_BUS = "http://127.0.0.1:7420";
