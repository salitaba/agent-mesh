import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { bootstrapMesh, type MeshInstance } from "../apps/mesh-server/src/index";
import type { AgentDefinition } from "../packages/protocol/src/index";

export interface AgentSpec {
  id: string;
  role: string;
  capabilities?: string[];
  authority?: string[];
  interests?: string[];
  mode?: "peer" | "service";
  tokens?: number;
  persistent?: boolean;
  delegation?: { allow: boolean; max_depth: number; max_workers: number; worker_budget_tokens?: number };
}

export interface TestMeshOptions {
  agents: AgentSpec[];
  startup?: string[];
  mayContact?: Record<string, string[]>;
  transitions?: Record<string, string[]>;
  rules?: unknown[];
  missionTokens?: number;
  maxEvents?: number;
  wallClockMinutes?: number;
  maxActiveAgents?: number;
  criteria?: Array<{ id: string; description: string; mandatory?: boolean }>;
  goal?: string;
  uiOnly?: boolean;
  triage?: { mode: "off" | "heuristic"; rules?: Array<{ agent: string; event?: string; ignore_if_text_matches?: string[]; act_if_text_matches?: string[] }> };
  threadTokens?: number;
  waitWakeupMs?: number;
}

export function testConfigYaml(opts: TestMeshOptions): string {
  const agents = opts.agents
    .map((a) => {
      const lines = [`  ${a.id}:`, `    role: ${a.role}`, `    runtime: stub`];
      if (a.mode) lines.push(`    mode: ${a.mode}`);
      if (a.capabilities) lines.push(`    capabilities: [${a.capabilities.join(", ")}]`);
      if (a.authority) lines.push(`    authority: [${a.authority.join(", ")}]`);
      if (a.interests) lines.push(`    interests: [${a.interests.join(", ")}]`);
      if (a.persistent !== false) lines.push(`    session: { persistent: ${a.persistent ?? true} }`);
      if (a.tokens) lines.push(`    budget: { tokens: ${a.tokens} }`);
      if (a.delegation) lines.push(`    delegation: { allow: ${a.delegation.allow}, max_depth: ${a.delegation.max_depth}, max_workers: ${a.delegation.max_workers}${a.delegation.worker_budget_tokens ? `, worker_budget_tokens: ${a.delegation.worker_budget_tokens}` : ""} }`);
      return lines.join("\n");
    })
    .join("\n");
  const comm = Object.entries(opts.mayContact ?? {})
    .map(([k, v]) => `    ${k}: { may_contact: [${v.join(", ")}] }`)
    .join("\n");
  const gates = Object.entries(opts.transitions ?? {})
    .map(([k, v]) => `    ${k}:\n      requires: [${v.join(", ")}]`)
    .join("\n");
  const criteria = (opts.criteria ?? [{ id: "ship", description: "the mission artifact exists", mandatory: true }])
    .map((c) => `    - { id: ${c.id}, description: "${c.description}", mandatory: ${c.mandatory ?? true} }`)
    .join("\n");
  return `version: 1

mesh:
  id: test-${Math.random().toString(36).slice(2, 8)}
  goal: |
    ${opts.goal ?? "Test mission."}
  acceptance_criteria:
${criteria}
  workspace:
    path: ./workspace
  runtime:
    default: stub

startup:
  activate: [${(opts.startup ?? []).join(", ")}]

agents:
${agents}

policies:
  communication:
${comm || "    {}"}
  transitions:
${gates || "    {}"}
${opts.rules?.length ? `  rules: ${JSON.stringify(opts.rules)}` : ""}
  escalation:
    thread: { max_depth: 5 }
    repeated_conflict: { threshold: 3 }
    artifact_review_rounds: { max: 4 }

budgets:
  mission: { tokens: ${opts.missionTokens ?? 10000000}, wall_clock_minutes: ${opts.wallClockMinutes ?? 60}, max_events: ${opts.maxEvents ?? 100000} }
  thread: { tokens: ${opts.threadTokens ?? 1000000} }

scheduling:
  mode: event-driven
  activation: { strategy: interest }
${opts.triage ? `  triage:\n    mode: ${opts.triage.mode}\n    rules: ${JSON.stringify(opts.triage.rules ?? [])}` : ""}
  concurrency: { max_active_agents: ${opts.maxActiveAgents ?? 4} }
  timeouts: { turn_timeout_ms: 15000, wait_wakeup_ms: ${opts.waitWakeupMs ?? 200}, idle_quiet_period_ms: 300 }
`;
}

export async function makeMesh(opts: TestMeshOptions): Promise<MeshInstance & { cleanup(): Promise<void> }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-test-"));
  const configPath = path.join(dir, "mesh.yaml");
  fs.writeFileSync(configPath, testConfigYaml(opts), "utf8");
  const instance = await bootstrapMesh({ configPath, inMemory: true, uiOnly: opts.uiOnly });
  (globalThis as unknown as Record<string, unknown>).__meshDebug = () => {
    const st = instance.kernel.state;
    const agents = [...st.agents.values()].map((r) => `${r.definition.id}:${r.state.lifecycle}(act ${r.state.activations}, unread ${st.unread.get(r.definition.id)?.length ?? 0})`).join("  ");
    const arts = [...st.artifacts.values()].map((a) => `${a.type}/${a.name}@v${a.version}:${a.status}`).join("  ");
    const goal = st.activeGoalId ? st.goals.get(st.activeGoalId) : undefined;
    const crit = goal ? goal.acceptanceCriteria.map((c) => `${c.id}=${c.status}`).join(",") : "";
    const pend = [...st.pendingRequests.values()].map((pr) => `${pr.from}->${pr.to.join("/")}:${pr.type}`).join("  ");
    const esc = [...st.escalations.values()].map((e) => `${e.id}:${e.reason}`).join("  ");
    return `goal ${goal?.status} [${crit}] | ${agents} | artifacts: ${arts} | pending: ${pend} | escalations: ${esc}`;
  };
  return {
    ...instance,
    async cleanup() {
      await instance.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function stub(m: MeshInstance) {
  const s = m.stubRuntimes.get("stub");
  if (!s) throw new Error("stub runtime missing");
  return s;
}

export async function waitFor(what: string, predicate: () => boolean | Promise<boolean>, timeoutMs = 12000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  const dbg = (globalThis as unknown as Record<string, () => string>).__meshDebug;
  throw new Error(`timeout waiting for: ${what}${dbg ? `\n   state: ${dbg()}` : ""}`);
}

export async function collectEvents(m: MeshInstance) {
  return m.store.read();
}

export function eventTypes(events: Array<{ type: string }>): string[] {
  return events.map((e) => e.type);
}

export function firstIndexOf(types: string[], type: string): number {
  return types.indexOf(type);
}

export function goalOf(m: MeshInstance) {
  return m.kernel.state.goals.get(m.kernel.state.activeGoalId ?? "");
}

export type { AgentDefinition };
