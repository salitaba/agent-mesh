import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as http from "node:http";
import { startServer } from "../../apps/mesh-server/src/index";
import { testConfigYaml } from "../helpers";
import { fakeServer, frame, sseHead, type FakeServer, type Seen } from "../llm/fake-server";

/**
 * A whole mission on the provider-neutral runtime: two seats whose model is a scripted OpenAI-compatible server, and a real
 * bus on a real port.
 *
 * Everything between the model and the log is the product's own: the config names a provider and a model, the server builds
 * the native runtime from it, the seats' briefings go over HTTP as chat completions with the seat's tools, the model's tool
 * calls come back, run (files in the workspace, ops on the bus through /internal/mcp), and the mission converges. No model
 * is involved; what is under test is that nothing between a model and the mesh depends on which one it is.
 */

const KEY = "sk-test-native-mission";
const REPORT = `The greeting program is delivered. hello.txt, in the workspace, holds the line "hello, world".
${"It was written by the developer with the Write tool and read back before this report. ".repeat(6)}
Acceptance: the file exists, is not empty, and its content is exactly the greeting the goal asked for.`;

interface ChatRequest {
  model: string;
  messages: Array<{ role: string; content: string | null; tool_calls?: Array<{ id: string; function: { name: string } }> }>;
  tools?: Array<{ function: { name: string } }>;
  stream: boolean;
}

type Call = { name: string; args: Record<string, unknown> };
type Reply = { text?: string; calls?: Call[] };

function serve(res: http.ServerResponse, reply: Reply, promptTokens: number): void {
  sseHead(res);
  const chunk = (delta: object, finish: string | null = null) => ({ id: "c", object: "chat.completion.chunk", model: "m1-snapshot", choices: [{ index: 0, delta, finish_reason: finish }] });
  frame(res, chunk({ role: "assistant", content: "" }));
  if (reply.text) frame(res, chunk({ content: reply.text }));
  (reply.calls ?? []).forEach((c, i) => {
    frame(res, chunk({ tool_calls: [{ index: i, id: `call_${Date.now().toString(36)}_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }] }));
  });
  frame(res, chunk({}, reply.calls?.length ? "tool_calls" : "stop"));
  frame(res, { id: "c", model: "m1-snapshot", choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 40, total_tokens: promptTokens + 40 } });
  frame(res, "[DONE]");
  res.end();
}

/** What each seat says next, from where its own conversation has got to. The model never sees anything but its messages. */
function script(seat: "dev" | "pm", req: ChatRequest): Reply {
  const said = req.messages.filter((m) => m.role === "assistant").length;
  // A model that has called mesh_done and read the answer (including "mission is COMPLETED") has nothing left to say.
  const last = [...req.messages].reverse().find((m) => m.role === "assistant");
  if (last?.tool_calls?.some((c) => c.function.name === "mesh_done")) return { text: "Done." };
  const briefing = req.messages.find((m) => m.role === "user")?.content ?? "";
  if (seat === "dev") {
    const steps: Call[] = [
      { name: "Write", args: { file_path: "hello.txt", content: "hello, world\n" } },
      { name: "Read", args: { file_path: "hello.txt" } },
      { name: "Write", args: { file_path: "report.md", content: REPORT } },
      { name: "mesh_artifact_publish", args: { name: "hello-report", type: "ResearchReport", fromPath: "report.md" } },
      { name: "mesh_request", args: { to: ["pm"], requestType: "REQUEST_REVIEW", subject: "hello is delivered", payload: { note: "hello-report is published; please accept hello-delivered" } } },
    ];
    return said < steps.length ? { text: `step ${said + 1}`, calls: [steps[said]!] } : { calls: [{ name: "mesh_done", args: { summary: "delivered hello.txt and reported it" } }] };
  }
  // The artifact's id is in the briefing the mesh built for the seat, as the tools ask for it.
  const id = /id (art-[A-Za-z0-9]+)/.exec(String(briefing))?.[1];
  if (!id) return { calls: [{ name: "mesh_wait", args: { reason: "nothing to accept yet" } }] };
  const steps: Call[] = [
    { name: "mesh_artifact_read", args: { artifactRef: id } },
    { name: "mesh_approve", args: { subject: "criterion:hello-delivered", artifactId: id, comment: "the report evidences it" } },
  ];
  return said < steps.length ? { calls: [steps[said]!] } : { calls: [{ name: "mesh_done", args: { summary: "accepted hello-delivered" } }] };
}

const seatOf = (req: ChatRequest): "dev" | "pm" => (String(req.messages[0]?.content).includes("You are the PM seat") ? "pm" : "dev");

async function eventually(what: string, cond: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("a mission converges on the native runtime against a provider that is only a wire format", async () => {
  const requests: Array<{ seat: string; req: ChatRequest; headers: Seen["headers"] }> = [];
  const provider: FakeServer = await fakeServer((seen, res) => {
    const req = seen.body as ChatRequest;
    const seat = seatOf(req);
    requests.push({ seat, req, headers: seen.headers });
    if (process.env.NATIVE_E2E_DEBUG && requests.filter((r) => r.seat === seat).length <= 5) {
      console.error(`REQ ${seat} #${requests.filter((r) => r.seat === seat).length}: last message ${JSON.stringify(req.messages.at(-1)).slice(0, 300)}`);
    }
    const reply = script(seat, req);
    serve(res, reply, 800 + 100 * req.messages.length);
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-mission-"));
  const savedKey = process.env.NATIVE_E2E_KEY;
  process.env.NATIVE_E2E_KEY = KEY;
  try {
    fs.mkdirSync(path.join(dir, "roles"));
    fs.writeFileSync(path.join(dir, "roles", "dev.md"), "You are the DEVELOPER seat. Write what the goal asks for, report it to the pm, and finish.");
    fs.writeFileSync(path.join(dir, "roles", "pm.md"), "You are the PM seat. Accept a criterion when a report evidences it.");
    const base = testConfigYaml({
      agents: [
        { id: "dev", role: "developer", prompt: "x", capabilities: ["repository.read", "repository.write"], interests: [] },
        { id: "pm", role: "product-manager", prompt: "x", capabilities: ["repository.read"], authority: ["requirements.accept"], interests: [] },
      ],
      mayContact: { dev: ["pm"], pm: ["dev"] },
      startup: ["dev"],
      criteria: [{ id: "hello-delivered", description: "hello.txt exists and holds the greeting", mandatory: true }],
      goal: "Write hello.txt containing a greeting.",
      turnTimeoutMs: 60_000,
    });
    const yaml = base
      .replace(/runtime: stub/g, "runtime: native")
      .replace(
        "  runtime:\n    default: stub\n",
        `  runtime:\n    default: native\n    model: fake/m1\n    providers:\n      fake: { kind: openai-compatible, base_url: "${provider.url}/v1", api_key_env: NATIVE_E2E_KEY }\n    native: { shell_env: minimal }\n`,
      )
;
    fs.writeFileSync(path.join(dir, "mesh.yaml"), yaml);

    const handle = await startServer({ configPath: path.join(dir, "mesh.yaml"), inMemory: true, port: 0, host: "127.0.0.1", mode: "live" });
    try {
      const { kernel } = handle.instance;
      const goalId = kernel.state.activeGoalId!;
      await eventually("the goal to complete", () => ["COMPLETED", "FAILED", "ESCALATED"].includes(kernel.state.goals.get(goalId)?.status ?? ""), 45_000);
      const goal = kernel.state.goals.get(goalId)!;
      // The goal completes inside the pm's turn; the turns still running are billed when they end.
      const t0 = Date.now();
      await eventually("the seats' turns to end", () => handle.instance.scheduler.running() === 0 && handle.instance.scheduler.pending() === 0, 30_000);
      if (process.env.NATIVE_E2E_DEBUG) console.error(`turns settled ${Date.now() - t0} ms after the goal completed`);
      const events = await handle.instance.store.read();
      const types = events.map((e) => e.type as string);
      if (process.env.NATIVE_E2E_DEBUG) {
        for (const e of events) console.error(`${e.timestamp.slice(11, 23)} ${e.type} ${e.actorId ?? ""} ${JSON.stringify(e.payload).slice(0, 220)}`);
      }
      assert.equal(goal.status, "COMPLETED", `goal ${goal.status}; criteria ${JSON.stringify(goal.acceptanceCriteria.map((c) => [c.id, c.status]))}; failures ${JSON.stringify(events.filter((e) => String(e.type).includes("fail")).slice(0, 3))}`);

      // The work happened where the seat's tools say it did, and the report reached the mesh as an artifact.
      assert.equal(fs.readFileSync(path.join(dir, "workspace", "hello.txt"), "utf8"), "hello, world\n");
      const artifact = [...kernel.state.artifacts.values()].find((a) => a.name === "hello-report");
      assert.ok(artifact, "the developer published its report through the bus");
      assert.equal(artifact.owner, "dev");

      // Nothing in the log says which model it was, and nothing failed.
      assert.ok(!types.includes("agent.failed"), `no seat failed: ${JSON.stringify(events.filter((e) => e.type === "agent.failed"))}`);
      // A turn is billed once per budget (seat, mission, thread); the seat's own record is the one that names the model.
      const billed = (events.filter((e) => e.type === "budget.consumed") as Array<{ payload: { model?: string; modelVersion?: string; amount?: number; input?: number; output?: number } }>).filter((e) => e.payload.model !== undefined);
      assert.ok(billed.length >= 2 && billed.every((e) => (e.payload.amount ?? 0) > 0 && (e.payload.input ?? 0) > 0 && (e.payload.output ?? 0) > 0), "every turn was billed what the provider reported");
      assert.ok(billed.every((e) => e.payload.model === "m1"), `billed under the configured model id: ${billed.map((e) => e.payload.model)}`);
      assert.ok(billed.every((e) => e.payload.modelVersion === "m1-snapshot"), "and the provider's own name for it is kept beside it");

      // What the provider was sent: the key, the seat's tools and no others, and the briefing the mesh built.
      assert.ok(requests.length >= 8);
      assert.ok(requests.every((r) => r.headers.authorization === `Bearer ${KEY}`), "the key named by api_key_env went with every call");
      const toolsOf = (seat: string) => [...new Set(requests.filter((r) => r.seat === seat).flatMap((r) => (r.req.tools ?? []).map((t) => t.function.name)))];
      const dev = toolsOf("dev");
      assert.ok(["Read", "Write", "Edit", "Glob", "Grep", "mesh_send", "mesh_artifact_publish", "mesh_done"].every((n) => dev.includes(n)), `developer tools: ${dev}`);
      assert.ok(!dev.includes("Bash") && !dev.includes("WebFetch"), "a seat is offered only what its capabilities reach");
      const pm = toolsOf("pm");
      assert.ok(!pm.includes("Write") && !pm.includes("Edit") && pm.includes("Read") && pm.includes("mesh_approve"), `pm tools: ${pm}`);
      const first = requests.find((r) => r.seat === "dev")!.req;
      assert.equal(first.model, "m1");
      assert.equal(first.stream, true);
      assert.ok(String(first.messages[0]!.content).includes("You are the DEVELOPER seat."), "the role prompt is the system prompt");
      assert.ok(String(first.messages[1]!.content).includes("Write hello.txt containing a greeting."), "the briefing carries the goal");
    } finally {
      await handle.close();
    }
  } finally {
    if (savedKey === undefined) delete process.env.NATIVE_E2E_KEY;
    else process.env.NATIVE_E2E_KEY = savedKey;
    await provider.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
