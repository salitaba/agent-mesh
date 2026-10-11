import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeMesh } from "../helpers";
import type { TestMesh } from "../helpers";
import { createHttpServer } from "../../apps/mesh-server/src/index";

const KEY = "«redacted:sk-…»";
/** The environment a workspace the host gives models to is started with. */
const MANAGED: Record<string, string> = {
  CURULE_MODEL_KEY: KEY,
  CURULE_MODEL_PROVIDER: "openai-compatible",
  CURULE_MODEL_NAME: "opencode-go/deepseek-v4.1-flash",
  CURULE_MODEL_BASE_URL: "https://ai.alitaba.me/v1",
};

type SaveReply = { valid: boolean; yaml?: string; savedTo?: string | null; warnings?: string[]; saveWarnings?: string[]; errors?: string[] };

/** The env the four managed variables had, so a test can put them back. */
function managedEnv(): { saved: Record<string, string | undefined> } {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(MANAGED)) saved[k] = process.env[k];
  return { saved };
}

function applyManaged(saved: Record<string, string | undefined>, on: boolean): void {
  for (const k of Object.keys(MANAGED)) {
    if (!on) delete process.env[k];
    else if (saved[k] === undefined) process.env[k] = MANAGED[k];
  }
}

async function harness() {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "lead", role: "tech-lead", capabilities: [], interests: [] },
    ],
    mayContact: { dev: ["lead"], lead: [] },
  });
  const server = createHttpServer(m as TestMesh, { dashboardDir: undefined });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    dir: m.dir,
    yamlPath: path.join(m.dir, "mesh.yaml"),
    async save(body: unknown): Promise<{ status: number; json: SaveReply }> {
      const res = await fetch(`${base}/config/save`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, json: (await res.json()) as SaveReply };
    },
    async close() {
      // Not awaited: the mesh keeps a connection to its own server open, so a closed callback would never fire and the
      // test would sit there — a test that never returns is worse than no test.
      server.closeAllConnections?.();
      server.close();
      await m.cleanup();
    },
  };
}

/**
 * The document a designer save makes in a workspace that was running Claude: no seat names a runtime, and the default
 * is claude. That is the shape the managed rewrite exists for.
 */
function claudeDefaulted(original: string): string {
  const out = original.replace(/^[ \t]*runtime: stub\n/gm, "").replace(/^([ \t]*)default: stub$/m, "$1default: claude");
  assert.match(out, /^\s*default: claude$/m, "the fixture names a default runtime to change");
  assert.notEqual(out, original);
  return out;
}

test("a mesh.yaml saved in a workspace the host gives models to keeps the managed wiring, and the save says so", async () => {
  const h = await harness();
  const env = managedEnv();
  applyManaged(env.saved, false);
  try {
    const inherit = claudeDefaulted(fs.readFileSync(h.yamlPath, "utf8"));
    applyManaged(env.saved, true);
    const { status, json } = await h.save({ yaml: inherit, path: h.yamlPath });
    assert.equal(status, 200, JSON.stringify(json.errors ?? json.warnings));
    // What was saved is not what was sent: the runtimes, the model, the designer and the provider block are back.
    assert.match(json.yaml!, /runtime:\s*\n\s*default: native/, "the default runtime is native, so no seat reaches for a credential this workspace has not got");
    assert.match(json.yaml!, /model: curule\/opencode-go\/deepseek-v4\.1-flash/);
    assert.match(json.yaml!, /designer: native/);
    assert.match(json.yaml!, /api_key_env: CURULE_MODEL_KEY/);
    assert.match(json.yaml!, /base_url: https:\/\/ai\.alitaba\.me\/v1/);
    assert.ok(!json.yaml!.includes(KEY), "the key is read from the environment, not written into the file");
    assert.equal(fs.readFileSync(h.yamlPath, "utf8"), json.yaml, "the file on disk is what the client is told it saved");
    // And the operator is told, on the card that clears with the next edit, rather than finding it in the file.
    assert.match((json.saveWarnings ?? []).join("\n"), /runs on the model the host was given/);
    assert.ok(!(json.warnings ?? []).some((w) => /model the host was given/.test(w)), "it is a save-only fact, not a warning about the document");
  } finally {
    applyManaged(env.saved, false);
    await h.close();
  }
});

test("a service that supplies no models saves the document it was given, with nothing to report", async () => {
  const h = await harness();
  const env = managedEnv();
  try {
    const inherit = claudeDefaulted(fs.readFileSync(h.yamlPath, "utf8"));
    applyManaged(env.saved, false);
    const { status, json } = await h.save({ yaml: inherit, path: h.yamlPath });
    assert.equal(status, 200, JSON.stringify(json.errors ?? json.warnings));
    assert.equal(fs.readFileSync(h.yamlPath, "utf8"), json.yaml, "the file is what the client is told it saved");
    assert.deepEqual(json.saveWarnings, [], "there is nothing to rewire and nothing to say");
    assert.match(json.yaml!, /^\s*default: claude$/m, "the operator's own choice is kept as they wrote it");
    assert.ok(!json.yaml!.includes("curule/"), "no provider the operator never named is written in");
  } finally {
    applyManaged(env.saved, false);
    await h.close();
  }
});

test("a workspace that already keeps the wiring is saved again untouched, and the second save says nothing", async () => {
  const h = await harness();
  const env = managedEnv();
  try {
    applyManaged(env.saved, true);
    const first = await h.save({ yaml: claudeDefaulted(fs.readFileSync(h.yamlPath, "utf8")), path: h.yamlPath });
    assert.equal(first.status, 200, JSON.stringify(first.json.errors ?? first.json.warnings));
    assert.match((first.json.saveWarnings ?? []).join("\n"), /runs on the model the host was given/);
    // Save exactly what is now on disk, the way the designer would once the operator has edited the rewired document.
    const second = await h.save({ yaml: fs.readFileSync(h.yamlPath, "utf8"), path: h.yamlPath });
    assert.equal(second.status, 200, JSON.stringify(second.json.errors ?? second.json.warnings));
    assert.deepEqual(second.json.saveWarnings, [], "nothing was rewired, so nothing is claimed to have been");
    assert.equal(fs.readFileSync(h.yamlPath, "utf8"), second.json.yaml);
    assert.match(second.json.yaml!, /model: curule\/opencode-go\/deepseek-v4\.1-flash/, "and the wiring is still there");
  } finally {
    applyManaged(env.saved, false);
    await h.close();
  }
});
