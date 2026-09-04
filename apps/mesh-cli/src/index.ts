import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { resolveConfig, loadMeshFile, ConfigError } from "../../../packages/config/src/index";
import { writeDefaultMeshYaml } from "../../../packages/config/src/index";

function hasOpenCodeCli(): boolean {
  try {
    const r = spawnSync("opencode", ["--version"], { stdio: "ignore", timeout: 10000, shell: process.platform === "win32" });
    return r.status === 0;
  } catch {
    return false;
  }
}
import { SCHEMAS } from "../../../packages/protocol/src/index";
import { JsonlEventStore } from "../../../packages/event-store/src/index";
import { systemClock } from "../../../packages/protocol/src/index";
import { startServer } from "../../mesh-server/src/index";
import { runTui } from "./tui";
import { runBenchmark } from "./bench";

const DEFAULT_BUS = process.env.MESH_BUS_URL ?? "http://127.0.0.1:7420";

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq >= 0) {
        flags[token.slice(2, eq)] = token.slice(eq + 1);
      } else if (i + 1 < rest.length && !rest[i + 1].startsWith("--")) {
        flags[token.slice(2)] = rest[++i];
      } else {
        flags[token.slice(2)] = true;
      }
    } else {
      positional.push(token);
    }
  }
  return { command, positional, flags };
}

async function httpJson(method: string, url: string, body?: unknown): Promise<any> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

function stateDirFor(configPath: string): string {
  try {
    return resolveConfig(configPath).stateDir;
  } catch {
    return path.join(path.dirname(path.resolve(configPath)), "workspace", ".mesh-state");
  }
}

async function tryServer<T>(fn: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback();
  }
}

const HELP = `agent-mesh â€” runtime for persistent AI organizations

usage:
  mesh init [dir]                          scaffold mesh.yaml + roles
  mesh validate <mesh.yaml>                schema + cross-field validation
  mesh emit-schemas [dir]                  write canonical JSON schemas
  mesh run <mesh.yaml> [--port n] [--no-tui] [--git]   start the supervisor
  mesh ui <mesh.yaml> [--port n]        parked console: dashboard+designer,
                                         nothing runs on its own; wake buttons
                                         step single turns, ▶ starts the mission
                                         (also: mesh run --ui-only)
  mesh status [--bus url]                  mission/agent/budget overview
  mesh graph [--bus url]                   live collaboration graph
  mesh events [--type t] [--limit n]       event timeline
  mesh agents [--bus url]                  agent table
  mesh inspect <agentId>                   full agent state + memory + mail
  mesh replay <goalId> [--upToSeq n]       deterministic state replay
  mesh pause | resume [goalId]             goal control
  mesh wake <agentId>                      manual activation
  mesh send --to a,b --type INFORM --payload '{}'
  mesh approve --subject s [--artifact id] [--by agentId]
  mesh reject --subject s [--artifact id] [--comment text]
  mesh respond <escalationId> <text>       human escalation response
  mesh artifacts [--bus url]               artifact ledger
  mcp --agent id --bus url --token t       (internal) stdio MCP bridge
  bench [--mesh config.yaml] [--single config.yaml] [--out report.json]
`;

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const bus = String(args.flags.bus ?? DEFAULT_BUS);
  try {
    switch (args.command) {
      case "init": {
        const dir = path.resolve(args.positional[0] ?? ".");
        const runtime = hasOpenCodeCli() ? "opencode" : "stub";
        const file = writeDefaultMeshYaml(dir, path.basename(dir), runtime);
        console.log(`wrote ${file}`);
        if (runtime === "stub") {
          console.log("note: 'opencode' CLI not found on PATH — templated with runtime: stub (runs with zero model calls).");
          console.log("      install OpenCode (https://opencode.ai) and change 'runtime: default' to opencode for real agents.");
        }
        return 0;
      }
      case "emit-schemas": {
        const dir = path.resolve(args.positional[0] ?? "schemas");
        fs.mkdirSync(dir, { recursive: true });
        const names: Record<string, string> = { mesh: "mesh.schema.json", message: "message.schema.json", event: "event.schema.json", artifact: "artifact.schema.json" };
        for (const [key, file] of Object.entries(names)) {
          fs.writeFileSync(path.join(dir, file), JSON.stringify(SCHEMAS[key as keyof typeof SCHEMAS], null, 2) + "\n", "utf8");
        }
        console.log(`schemas written to ${dir}`);
        return 0;
      }
      case "validate": {
        const file = args.positional[0];
        if (!file) throw new Error("usage: mesh validate <mesh.yaml>");
        const raw = loadMeshFile(file);
        const resolved = resolveConfig(file);
        void raw;
        console.log(`OK: ${resolved.agentOrder.length} agents, mesh '${resolved.meshId}', runtime default '${resolved.defaultRuntime}'`);
        console.log(`   interests wired for: ${resolved.agentOrder.filter((a) => resolved.agents[a].interests.length > 0).join(", ")}`);
        console.log(`   transition gates: ${Object.keys(resolved.transitionGates).join(", ") || "(none)"}`);
        return 0;
      }
      case "run":
      case "ui": {
        const uiOnly = args.command === "ui" || Boolean(args.flags["ui-only"]);
        const file = args.positional[0];
        if (!file) throw new Error(`usage: mesh ${args.command} <mesh.yaml>`);
        const preflight = resolveConfig(file);
        const needsOpenCode =
          preflight.defaultRuntime === "opencode" || Object.values(preflight.agents).some((a) => a.runtime === "opencode");
        if (needsOpenCode && !uiOnly && !hasOpenCodeCli()) {
          console.error(
            "error: this mesh uses runtime 'opencode' but the 'opencode' CLI was not found on PATH.\n" +
              "  - install OpenCode:  npm i -g opencode-ai   (https://opencode.ai)\n" +
              "  - or run a model-free version:  npm run mesh -- init <dir>  (falls back to runtime: stub)\n" +
              "  - or edit " + file + " and set mesh.runtime.default: stub\n" +
              "  - or open the panel without running agents:  npm run mesh -- ui " + file,
          );
          return 2;
        }
        const useDemo = !args.flags["no-demo"] && preflight.meshId === "demo-stub";
        // A scripted demo always starts clean (its team is re-attached each
        // boot); a real mesh resumes from its event log unless --fresh.
        const fresh = Boolean(args.flags.fresh) || useDemo;
        if (fresh && !args.flags.resume) {
          fs.rmSync(preflight.stateDir, { recursive: true, force: true });
        }
        const handle = await startServer({
          configPath: file,
          port: args.flags.port ? Number(args.flags.port) : undefined,
          useGit: Boolean(args.flags.git) && !uiOnly,
          uiOnly,
        });
        if (useDemo) {
          try {
            const { attachDemoTeam } = await import("./bench");
            attachDemoTeam(handle.instance);
            console.log(uiOnly
              ? "demo team installed (parked): wake single agents for manual steps, or press ▶ start mission to run the whole flow."
              : "demo team attached: scripted roles will now run the payment flow (QA blocks once — watch conflict handling).");
          } catch (err) {
            console.error(`demo attach failed: ${(err as Error).message}`);
          }
        }
        console.log(
          uiOnly
            ? `mesh panel (UI-only) online at ${handle.url}  — dashboard /designer available; agents are NOT activated`
            : `mesh '${path.basename(file, path.extname(file))}' supervisor online at ${handle.url}`,
        );
        const useTui = process.stdout.isTTY && !args.flags["no-tui"] && !uiOnly;
        if (useTui) {
          await runTui(handle.url, async () => handle.close());
        } else {
          console.log(uiOnly ? `  dashboard: ${handle.url}/    designer: ${handle.url}/designer.html    (Ctrl-C to stop)` : "running headless; Ctrl-C to stop");
          await new Promise<void>((resolve) => {
            const stop = () => {
              resolve();
            };
            process.once("SIGINT", stop);
            process.once("SIGTERM", stop);
            const goalWatch = setInterval(async () => {
              try {
                const { body } = await httpJson("GET", `${handle.url}/status`);
                if (body?.goal && ["COMPLETED", "FAILED", "ESCALATED"].includes(body.goal.status)) {
                  clearInterval(goalWatch);
                  console.log(`\ngoal ${body.goal.status.toLowerCase()} â€” shutting down`);
                  stop();
                }
              } catch {
                /* server may be closing */
              }
            }, 2000);
          });
          await handle.close();
        }
        return 0;
      }
      case "mcp": {
        const { runStdioMcpBridge } = await import("./mcp-stdio");
        await runStdioMcpBridge({
          agent: String(args.flags.agent ?? ""),
          bus: String(args.flags.bus ?? DEFAULT_BUS),
          token: String(args.flags.token ?? ""),
        });
        return 0;
      }
      case "status": {
        const result = await tryServer(
          () => httpJson("GET", `${bus}/status`),
          async () => ({ status: 200, body: await offlineStatus(args) }),
        );
        const st = result.body;
        const bar = (ratio: number) => "â–ˆ".repeat(Math.round(ratio * 20)).padEnd(20, "â–‘");
        console.log(`Goal:      ${st.goal?.description?.split("\n")[0]?.slice(0, 60) ?? "(none)"} [${st.goal?.status ?? "-"}]`);
        console.log(`Progress:  ${bar(st.progress?.ratio ?? 0)} ${Math.round((st.progress?.ratio ?? 0) * 100)}%`);
        const tokens = st.budgets?.find?.((b: any) => b.key.startsWith("mission:"));
        console.log(`Tokens:    ${tokens ? `${tokens.consumed} / ${tokens.limit ?? "?"}` : "-"}   events: ${st.eventCount}`);
        console.log("");
        for (const a of st.agents ?? []) {
          const dot = ["THINKING", "WORKING", "REQUESTING", "AWAKENED", "OBSERVING", "REVIEWING"].includes(a.lifecycle) ? "â—" : "â—‹";
          console.log(`  ${dot} ${a.id.padEnd(14)} ${a.lifecycle.padEnd(11)} mailbox:${String(a.mailbox).padStart(2)}  tokens:${a.tokens}`);
        }
        if (st.openEscalations?.length) {
          console.log("\nOpen escalations:");
          for (const e of st.openEscalations) console.log(`  ! ${e.id} [${e.reason}] by ${e.raisedBy} at ${e.createdAt}`);
        }
        return 0;
      }
      case "graph": {
        const { body } = await httpJson("GET", `${bus}/graph`);
        for (const n of body.nodes) console.log(`  ${n.lifecycle.padEnd(11)} ${n.id.padEnd(14)} (${n.role})  ${n.tokens}t`);
        console.log("");
        for (const e of body.edges) console.log(`  ${e.from.padEnd(12)} --${e.kind}--> ${e.to.padEnd(12)} x${e.count}`);
        return 0;
      }
      case "agents": {
        const { body } = await httpJson("GET", `${bus}/agents`);
        for (const a of body) console.log(`  ${a.id.padEnd(14)} ${a.role.padEnd(16)} ${a.lifecycle.padEnd(11)} ${a.taskId ? `task:${a.taskId}` : ""}`);
        return 0;
      }
      case "inspect": {
        const id = args.positional[0];
        if (!id) throw new Error("usage: mesh inspect <agentId>");
        const { body } = await httpJson("GET", `${bus}/agents/${encodeURIComponent(id)}`);
        if (body.error) {
          console.error(body.error);
          return 1;
        }
        console.log(JSON.stringify(body, null, 2));
        return 0;
      }
      case "events": {
        const limit = args.flags.limit ? Number(args.flags.limit) : 40;
        const type = args.flags.type ? String(args.flags.type) : undefined;
        const result = await tryServer(
          () => httpJson("GET", `${bus}/events?limit=${limit * 4}${type ? `&type=${type}` : ""}`),
          async () => ({ status: 200, body: await offlineEvents(args, limit, type) }),
        );
        const rows = (result.body as any[]).slice(-limit);
        for (const r of rows) {
          console.log(`  ${r.at.replace("T", " ").slice(0, 19)} #${String(r.seq).padStart(5)} ${r.type.padEnd(24)} ${r.actor ?? ""} ${r.summary ?? ""}`);
        }
        return 0;
      }
      case "replay": {
        const goalId = args.positional[0];
        if (!goalId) throw new Error("usage: mesh replay <goalId>");
        const upTo = args.flags.upToSeq ? `&upToSeq=${args.flags.upToSeq}` : "";
        const { body } = await httpJson("GET", `${bus}/goals/${encodeURIComponent(goalId)}/replay${upTo}`);
        if (body.error) {
          console.error(body.error);
          return 1;
        }
        console.log(`replay of ${goalId} through seq ${body.asOfSeq} (${body.eventCount} events, no LLM invoked)`);
        console.log(`goal: ${body.goal?.status ?? "-"}  agents: ${body.agents.length}  artifacts: ${body.artifacts.length}  tasks: ${body.tasks.length}  events: ${body.eventCount}`);
        console.log(`budgets:`);
        for (const b of body.budgets) console.log(`  ${b.key.padEnd(34)} ${b.consumed}/${b.limit ?? "?"} reserved:${b.reserved}${b.exceeded ? "  EXCEEDED" : ""}`);
        return 0;
      }
      case "pause": {
        const goalId = args.positional[0];
        const { body } = await httpJson("POST", `${bus}/goals/${encodeURIComponent(goalId ?? "")}/pause`);
        console.log(JSON.stringify(body));
        return 0;
      }
      case "resume": {
        const goalId = args.positional[0];
        const { body } = await httpJson("POST", `${bus}/goals/${encodeURIComponent(goalId ?? "")}/resume`);
        console.log(JSON.stringify(body));
        return 0;
      }
      case "wake": {
        const id = args.positional[0];
        const { body } = await httpJson("POST", `${bus}/agents/${encodeURIComponent(id)}/wake`);
        console.log(JSON.stringify(body));
        return 0;
      }
      case "send": {
        const to = String(args.flags.to ?? "").split(",").filter(Boolean);
        const type = String(args.flags.type ?? "INFORM");
        const payload = args.flags.payload ? JSON.parse(String(args.flags.payload)) : {};
        const { status, body } = await httpJson("POST", `${bus}/messages`, { to, type, payload, threadId: args.flags.thread });
        console.log(JSON.stringify(body, null, 2));
        return status === 202 ? 0 : 1;
      }
      case "approve":
      case "accept": {
        const { status, body } = await httpJson("POST", `${bus}/approvals`, {
          kind: args.command === "accept" ? "accept" : "approve",
          subject: args.flags.subject ?? "release",
          artifactId: args.flags.artifact,
          by: args.flags.by,
          comment: args.flags.comment,
        });
        console.log(JSON.stringify(body, null, 2));
        return status === 200 ? 0 : 1;
      }
      case "reject": {
        const { status, body } = await httpJson("POST", `${bus}/approvals`, {
          kind: "reject",
          subject: args.flags.subject ?? "release",
          artifactId: args.flags.artifact,
          by: args.flags.by,
          comment: args.flags.comment,
        });
        console.log(JSON.stringify(body, null, 2));
        return status === 200 ? 0 : 1;
      }
      case "respond": {
        const id = args.positional[0];
        const text = args.positional.slice(1).join(" ") || String(args.flags.text ?? "acknowledged");
        const { status, body } = await httpJson("POST", `${bus}/escalations/${encodeURIComponent(id)}/respond`, { response: text });
        console.log(JSON.stringify(body, null, 2));
        return status === 200 ? 0 : 1;
      }
      case "escalations": {
        const { body } = await httpJson("GET", `${bus}/escalations`);
        for (const e of body) console.log(`  ${e.status.padEnd(10)} ${e.id}  [${e.reason}] by ${e.raisedBy}`);
        return 0;
      }
      case "artifacts": {
        const { body } = await httpJson("GET", `${bus}/artifacts`);
        for (const a of body) console.log(`  ${a.id}  ${a.type.padEnd(20)} ${a.name.padEnd(28)} v${a.version} ${a.status.padEnd(16)} owner:${a.owner}`);
        return 0;
      }
      case "budgets": {
        const { body } = await httpJson("GET", `${bus}/budgets`);
        for (const b of body.entries) console.log(`  ${b.key.padEnd(36)} ${String(b.consumed).padStart(8)}/${String(b.limit ?? "?").padStart(8)}${b.exceeded ? "  EXCEEDED" : ""}`);
        return 0;
      }
      case "bench": {
        return runBenchmark(args.flags);
      }
      case "help":
      default: {
        if (args.command !== "help") console.error(`unknown command: ${args.command}\n`);
        console.log(HELP);
        return args.command === "help" ? 0 : 1;
      }
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(String(err.message));
      return 2;
    }
    console.error(`mesh ${args.command}: ${(err as Error).message}`);
    return 1;
  }
}

async function offlineStatus(args: Args): Promise<unknown> {
  const file = args.positional[0] ?? process.env.MESH_CONFIG ?? "mesh.yaml";
  const dir = stateDirFor(fs.existsSync(file) ? file : "mesh.yaml");
  const store = new JsonlEventStore(path.join(dir, "logs", "events.jsonl"));
  const events = await store.read();
  const goal = [...events].reverse().find((e) => e.type === "goal.created");
  const agentStates = new Map<string, string>();
  const tokens = new Map<string, number>();
  for (const e of events) {
    if (e.type === "agent.state_changed") agentStates.set((e.payload as any).agentId, (e.payload as any).to);
    if (e.type === "agent.created") agentStates.set((e.payload as any).agent.id, "IDLE");
    if (e.type === "budget.consumed" && (e.payload as any).agentId) {
      tokens.set((e.payload as any).agentId, (tokens.get((e.payload as any).agentId) ?? 0) + ((e.payload as any).amount ?? 0));
    }
  }
  return {
    goal: goal ? (goal.payload as any).goal : undefined,
    agents: [...agentStates.entries()].map(([id, lifecycle]) => ({ id, role: id, lifecycle, mailbox: 0, tokens: tokens.get(id) ?? 0 })),
    eventCount: events.length,
    progress: null,
    openEscalations: [],
  };
}

async function offlineEvents(args: Args, limit: number, type?: string): Promise<unknown[]> {
  const file = args.positional[0] ?? process.env.MESH_CONFIG ?? "mesh.yaml";
  const dir = stateDirFor(fs.existsSync(file) ? file : "mesh.yaml");
  const store = new JsonlEventStore(path.join(dir, "logs", "events.jsonl"));
  const events = await store.read({ types: type ? ([type] as never) : undefined, limit: limit * 4 });
  const { eventTimeline } = await import("../../../packages/observability/src/index");
  return eventTimeline(events, limit);
}

void systemClock;

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
