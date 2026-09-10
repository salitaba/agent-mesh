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
