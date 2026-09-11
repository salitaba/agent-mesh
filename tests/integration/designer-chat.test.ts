import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { createHttpServer } from "../../apps/mesh-server/src/index";
import { loadMeshFile } from "../../packages/config/src/index";

type ChatReply = { reply?: string; proposedConfig?: unknown; problems: string[] };

async function chatHarness() {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "lead", role: "tech-lead", capabilities: [], interests: [] },
    ],
    mayContact: { dev: ["lead"], lead: [] },
  });
  const seen: { text: string; system?: string } = { text: "" };
  let replyText = "";
  m.opencodeRuntime.prompt = async (text, opts) => {
    seen.text = text;
    seen.system = opts?.system;
    return replyText;
  };
  m.opencodeRuntime.promptStream = async (text, opts, onDelta) => {
    seen.text = text;
    seen.system = opts?.system;
    onDelta?.({ kind: "thinking", delta: "weighing options " });
    onDelta?.({ kind: "text", delta: "Considering " });
    return { reply: replyText, thinking: "weighing options inside" };
  };
  const server = createHttpServer(m, { dashboardDir: undefined });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const valid = loadMeshFile(m.config.filePath) as unknown as Record<string, unknown>;
  // Pin project.id so analyzeMeshConfig does not add a derived-id warning to
  // otherwise-clean proposals.
  if (!valid.project) valid.project = { id: "test-designer" };
  return {
    valid,
    seen,
    base,
    setReply(reply: string) {
      replyText = reply;
    },
    async chat(body: unknown): Promise<{ status: number; json: ChatReply }> {
      const res = await fetch(`${base}/designer/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as ChatReply };
    },
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      await m.cleanup();
    },
  };
}

function fence(doc: unknown): string {
  return `Here is the crew.\n\n\`\`\`json\n${JSON.stringify(doc, null, 2)}\n\`\`\``;
}

test("designer chat: a valid whole-config proposal validates clean and the draft reaches the model", async () => {
  const h = await chatHarness();
  try {
    h.setReply(fence(h.valid));
    const r = await h.chat({ messages: [{ role: "user", content: "make a mesh" }], currentConfig: h.valid });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.proposedConfig, JSON.parse(JSON.stringify(h.valid)));
    assert.deepEqual(r.json.problems, []);
    assert.match(h.seen.text, /Current draft mesh\.yaml/);
    assert.match(h.seen.text, /make a mesh/);
    assert.ok((h.seen.system ?? "").includes("crew designer"));
    assert.match(h.seen.system ?? "", /How to design a good mesh/i);
    assert.match(h.seen.system ?? "", /Gate every irreversible transition/i);
    assert.match(h.seen.system ?? "", /mesh_designer_validate/);
    assert.match(h.seen.system ?? "", /mesh_run_status/);
    assert.match(h.seen.system ?? "", /observe the live mission/i);
  } finally {
    await h.close();
  }
});

test("designer chat: unsatisfiable gate and schema errors come back as problems, not a 500", async () => {
  const h = await chatHarness();
  try {
    const gated = JSON.parse(JSON.stringify(h.valid)) as Record<string, unknown>;
    gated.policies = {
      ...((gated.policies as Record<string, unknown> | undefined) ?? {}),
      transitions: { "patch.merge": { requires: ["ghost.approve"] } },
    };
    h.setReply(fence(gated));
    const bad = await h.chat({ messages: [{ role: "user", content: "gate it" }], currentConfig: h.valid });
    assert.equal(bad.status, 200);
    assert.ok(bad.json.problems.some((p) => p.includes("ghost")), `expected a gate problem, got: ${bad.json.problems.join(" | ")}`);

    h.setReply(fence({ mesh: { id: "incomplete" } }));
    const malformed = await h.chat({ messages: [{ role: "user", content: "break it" }], currentConfig: h.valid });
    assert.equal(malformed.status, 200);
    assert.ok(malformed.json.problems.length > 0);

    h.setReply("no config block here");
    const none = await h.chat({ messages: [{ role: "user", content: "chat only" }], currentConfig: h.valid });
    assert.equal(none.status, 200);
    assert.equal(none.json.proposedConfig, undefined);
    assert.ok(none.json.problems.some((p) => p.includes("no parseable whole-config")));

    const empty = await h.chat({ messages: [], currentConfig: h.valid });
    assert.equal(empty.status, 400);
  } finally {
    await h.close();
  }
});

test("designer chat stream: thinking and text deltas arrive, then a validated final frame", async () => {
  const h = await chatHarness();
  try {
    h.setReply(fence(h.valid));
    const res = await fetch(`${h.base}/designer/chat/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "make a mesh" }], currentConfig: h.valid }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = await res.text();
    assert.match(text, /"type":"thinking","delta":"weighing options "/);
    assert.match(text, /"type":"text","delta":"Considering "/);
    const finalLine = text.split("\n").find((l) => l.includes('"type":"final"'));
    assert.ok(finalLine, `final frame present in: ${text}`);
    const finalFrame = JSON.parse(finalLine.slice(5).trim()) as { type: string; thinking: string; proposedConfig: unknown; problems: string[] };
    assert.equal(finalFrame.type, "final");
    assert.deepEqual(finalFrame.proposedConfig, JSON.parse(JSON.stringify(h.valid)));
    assert.deepEqual(finalFrame.problems, []);
    assert.equal(finalFrame.thinking, "weighing options inside");
    assert.match(h.seen.text, /make a mesh/);
    assert.ok((h.seen.system ?? "").includes("crew designer"));
  } finally {
    await h.close();
  }
});

test("designer chat: the previous proposal's validation problems are replayed to the model", async () => {
  const h = await chatHarness();
  try {
    h.setReply(fence(h.valid));
    const r = await h.chat({
      messages: [
        { role: "user", content: "make a mesh" },
        {
          role: "assistant",
          content: fence({ mesh: { id: "incomplete" } }),
          problems: ["mesh.goal: must have required property 'goal'", "gate 'patch.merge' token 'ghost.approve': no agent can play it"],
        },
        { role: "user", content: "fix it" },
      ],
      currentConfig: h.valid,
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.problems, []);
    assert.match(h.seen.text, /previous proposal failed validation/i);
    assert.match(h.seen.text, /mesh\.goal: must have required property 'goal'/);
    assert.match(h.seen.text, /ghost\.approve/);
  } finally {
    await h.close();
  }
});

test("designer chat: a JSON Patch reply edits the draft in place and preserves untouched fields", async () => {
  const h = await chatHarness();
  try {
    h.setReply(
      "Tightened the goal.\n\n```json\n" +
        JSON.stringify({ patch: [{ op: "replace", path: "/mesh/goal", value: "patched goal" }], summary: "goal edit" }, null, 2) +
        "\n```",
    );
    const r = await h.chat({ messages: [{ role: "user", content: "tighten the goal" }], currentConfig: h.valid });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.problems, []);
    const patched = r.json.proposedConfig as any;
    assert.equal(patched.mesh.goal, "patched goal");
    assert.deepEqual(patched.agents, (h.valid as any).agents, "untouched agents survive the patch");
    assert.notEqual((h.valid as any).mesh.goal, "patched goal", "the draft passed in is not mutated");
    assert.match(h.seen.system ?? "", /JSON Patch/);
  } finally {
    await h.close();
  }
});

test("designer chat: an unapplicable patch is reported as a problem, not a 500", async () => {
  const h = await chatHarness();
  try {
    h.setReply("```json\n" + JSON.stringify({ patch: [{ op: "replace", path: "/agents/ghost/role", value: "developer" }] }) + "\n```");
    const r = await h.chat({ messages: [{ role: "user", content: "touch a ghost" }], currentConfig: h.valid });
    assert.equal(r.status, 200);
    assert.equal(r.json.proposedConfig, undefined);
    assert.ok(r.json.problems.some((p) => p.includes("patch could not be applied")), `problems: ${r.json.problems.join(" | ")}`);

    const noDraft = await h.chat({ messages: [{ role: "user", content: "patch nothing" }] });
    assert.equal(noDraft.status, 200);
    assert.ok(noDraft.json.problems.some((p) => p.includes("no current draft")), `problems: ${noDraft.json.problems.join(" | ")}`);
  } finally {
    await h.close();
  }
});
