import type * as http from "node:http";
import { frame, sseHead } from "../llm/fake-server";

/**
 * The scripted model that the native-runtime missions share: two seats (a developer and a product manager) whose answers
 * depend only on the conversation they are shown, served as OpenAI-compatible chat completions. The model never sees anything
 * but its messages, so a mission that converges on it converges because everything between a model and the mesh works.
 */

export const REPORT = `The greeting program is delivered. hello.txt, in the workspace, holds the line "hello, world".
${"It was written by the developer with the Write tool and read back before this report. ".repeat(6)}
Acceptance: the file exists, is not empty, and its content is exactly the greeting the goal asked for.`;

export interface ChatRequest {
  model: string;
  messages: Array<{ role: string; content: string | null; tool_calls?: Array<{ id: string; function: { name: string } }> }>;
  tools?: Array<{ function: { name: string } }>;
  stream: boolean;
}

export type Call = { name: string; args: Record<string, unknown> };
export type Reply = { text?: string; calls?: Call[] };

export function serve(res: http.ServerResponse, reply: Reply, promptTokens: number): void {
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
export function script(seat: "dev" | "pm", req: ChatRequest): Reply {
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

export const seatOf = (req: ChatRequest): "dev" | "pm" => (String(req.messages[0]?.content).includes("You are the PM seat") ? "pm" : "dev");

/** Poll until `cond` holds. When it does not in time, the error carries `diagnose()`, so a timeout in CI says what state it was left in. */
export async function eventually(what: string, cond: () => boolean | Promise<boolean>, ms = 30_000, diagnose?: () => string | Promise<string>): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${diagnose ? `\n${await diagnose()}` : ""}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

