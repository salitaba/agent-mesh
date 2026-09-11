import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { analyzeMeshConfig, ConfigError, parseMeshSource } from "../../../packages/config/src/index";
import {
  ARTIFACT_TYPES,
  AUTHORITY_TOKENS,
  EVENT_TYPES,
  MESSAGE_TYPES,
  SCHEMAS,
  TRUST_SOURCES,
} from "../../../packages/protocol/src/index";
import { REVIEW_CAPABILITIES, validateTransitionGates } from "../../../packages/policy-engine/src/index";

export interface DesignerMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const DESIGNER_MCP_PROTOCOL_VERSION = "2025-06-18";

/** Mirrors the gate kinds the server's `/config/vocabulary` route advertises. */
const GATE_KINDS = ["patch.merge", "patch.commit", "patch.approve", "implementation.completed", "release.accepted"];

/**
 * The context-free designer backend gets exactly these three read-only tools
 * over stdio. They run inside the mesh CLI process and validate with the same
 * `packages/config` + `policy-engine` code the server uses, so the designer
 * needs no bus URL and no agent token — and can never touch the live mission.
 */
export const DESIGNER_MCP_TOOLS: DesignerMcpTool[] = [
  {
    name: "mesh_designer_schema",
    description:
      "Return the canonical JSON schema for a whole mesh.yaml document. Use this instead of guessing field names, required fields, or allowed enum values.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "mesh_designer_vocabulary",
    description:
      "Return the allowed vocabulary for a mesh config: agent roles with prompt files, authority tokens, review capabilities, message/artifact/event types, trust sources, and transition gate kinds.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "mesh_designer_validate",
    description:
      "Validate a whole mesh.yaml document (schema + cross-field rules + transition-gate satisfiability) before proposing it. Pass either a `yaml` string or a `config` object. Returns { valid, errors, warnings, summary }.",
    inputSchema: {
      type: "object",
      properties: {
        yaml: { type: "string", description: "the complete mesh.yaml document as text" },
        config: { type: "object", description: "the complete document as a parsed object (alternative to yaml)" },
        dir: { type: "string", description: "base directory for resolving relative paths; defaults to the current directory" },
      },
      additionalProperties: false,
    },
  },
];

function toolsByName(): Map<string, DesignerMcpTool> {
  return new Map(DESIGNER_MCP_TOOLS.map((t) => [t.name, t]));
}

/** Role names with prompt files in the repo's `roles/` directory (best effort). */
function designerRoles(): string[] {
  try {
    const dir = path.resolve(__dirname, "..", "..", "..", "..", "roles");
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

function vocabulary(): Record<string, unknown> {
  return {
    roles: designerRoles(),
    authorityTokens: AUTHORITY_TOKENS,
    reviewCapabilities: Object.entries(REVIEW_CAPABILITIES).map(([artifactType, capability]) => ({ artifactType, capability })),
    messageTypes: MESSAGE_TYPES,
    artifactTypes: ARTIFACT_TYPES,
    eventTypes: EVENT_TYPES,
    trustSources: TRUST_SOURCES,
    gateKinds: GATE_KINDS,
  };
}

/** Same validation recipe as the designer chat route: schema, cross-field, gates. */
function validateConfig(args: Record<string, any>): Record<string, unknown> {
  let doc: unknown;
  try {
    doc = typeof args.yaml === "string" ? parseMeshSource(args.yaml) : args.config;
  } catch (err) {
    if (err instanceof ConfigError) return { valid: false, errors: err.errors, warnings: [] };
    throw err;
  }
  if (doc === undefined || doc === null || typeof doc !== "object") {
    return { valid: false, errors: ["pass either `yaml` (string) or `config` (object)"], warnings: [] };
  }
  const baseDir = typeof args.dir === "string" && args.dir ? path.resolve(args.dir) : process.cwd();
  try {
    const { resolved } = analyzeMeshConfig(doc, baseDir);
    const errors = validateTransitionGates(resolved.raw.policies?.transitions, resolved.raw.agents).map(
      (issue) => `gate '${issue.gate}' token '${issue.token}': ${issue.reason}`,
    );
    return {
      valid: errors.length === 0,
      errors,
      warnings: resolved.warnings,
      summary: {
        meshId: resolved.meshId,
        agents: resolved.agentOrder,
        gates: Object.keys(resolved.transitionGates),
        missionTokens: resolved.budgets.mission.tokens,
        maxActiveAgents: resolved.scheduling.maxActiveAgents,
      },
    };
  } catch (err) {
    if (err instanceof ConfigError) return { valid: false, errors: err.errors, warnings: [] };
    throw err;
  }
}

async function callTool(name: string, args: Record<string, any>): Promise<unknown> {
  switch (name) {
    case "mesh_designer_schema":
      return SCHEMAS.mesh;
    case "mesh_designer_vocabulary":
      return vocabulary();
    case "mesh_designer_validate":
      return validateConfig(args);
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

export async function handleDesignerMcpRequest(request: Record<string, any>): Promise<unknown> {
  const id = request.id;
  if (typeof request.method !== "string") return { jsonrpc: "2.0", id, error: { code: -32600, message: "invalid request" } };
  switch (request.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: request.params?.protocolVersion ?? DESIGNER_MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "mesh-designer", version: "1.0.0" },
        },
      };
    case "notifications/initialized":
      return { jsonrpc: "2.0", id: id ?? null, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: DESIGNER_MCP_TOOLS } };
    case "tools/call": {
      const name = request.params?.name as string;
      const args = (request.params?.arguments ?? {}) as Record<string, any>;
      if (!toolsByName().has(name)) {
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown tool ${name}` } };
      }
      try {
        const payload = await callTool(name, args);
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError: false } };
      } catch (err) {
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `error: ${(err as Error).message}` }], isError: true } };
      }
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${request.method}` } };
  }
}

/** stdio JSON-RPC loop wired into `opencode serve` as the `mesh_designer` MCP server. */
export async function runStdioDesignerMcp(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  // Every write is tracked so the loop can flush before resolving: callers
  // (`main` → `mesh.mjs`) exit the process the moment this function returns,
  // and `process.exit` truncates async pipe writes.
  const flushing: Array<Promise<void>> = [];
  const write = (payload: unknown): void => {
    flushing.push(new Promise((resolve) => process.stdout.write(JSON.stringify(payload) + "\n", () => resolve())));
  };
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
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    const isNotification = !("id" in request) || request.id === null || request.id === undefined;
    const done = handleDesignerMcpRequest(request)
      .then((res) => {
        if (!isNotification) write(res);
      })
      .catch((err: Error) => {
        if (!isNotification) write({ jsonrpc: "2.0", id: request.id ?? null, error: { code: -32000, message: err.message } });
      });
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
}
