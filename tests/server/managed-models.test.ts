/**
 * A host that was told where its models are (the hosted service does this for every workspace): a team made on it runs on
 * those models, with no key from the person, and what it writes names the variable the key is read from and never the key.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { startHostServer, type HostHandle } from "../../apps/mesh-server/src/host";
import { DEFAULT_TIER, managedModels, rewriteForManagedModels, type ManagedModels } from "../../apps/mesh-server/src/managed";
import { findShippedRoot, defaultMeshTemplate, resolveConfig, scaffoldExample } from "../../packages/config/src/index";

const SHIPPED = findShippedRoot(__dirname)!;
const MANAGED: ManagedModels = { baseUrl: "https://gateway.example/v1", keyEnv: "CURULE_GATEWAY_KEY", tier: "balanced" };
const SECRET_KEY = "ck_live_this-is-the-workspaces-secret-key";

// ---- what makes a host managed ----

test("a host is managed when it holds both the gateway's address and a key for it, and what it reads of them is the address and the name of the key's variable", () => {
  assert.deepEqual(managedModels({ CURULE_GATEWAY_URL: "https://gateway.example/v1", CURULE_GATEWAY_KEY: SECRET_KEY }), { baseUrl: "https://gateway.example/v1", keyEnv: "CURULE_GATEWAY_KEY", tier: "balanced" });
  assert.ok(!JSON.stringify(managedModels({ CURULE_GATEWAY_URL: "https://gateway.example/v1", CURULE_GATEWAY_KEY: SECRET_KEY })).includes(SECRET_KEY), "the key is not in what is read");
  assert.equal(managedModels({ CURULE_GATEWAY_URL: "https://gateway.example/v1" }), undefined, "an address with no key");
  assert.equal(managedModels({ CURULE_GATEWAY_KEY: SECRET_KEY }), undefined, "a key with no address");
  assert.equal(managedModels({ CURULE_GATEWAY_URL: "  ", CURULE_GATEWAY_KEY: SECRET_KEY }), undefined);
  assert.equal(managedModels({ CURULE_GATEWAY_URL: "https://gateway.example/v1", CURULE_GATEWAY_KEY: " " }), undefined);
  assert.equal(managedModels({ CURULE_GATEWAY_URL: "gateway.example/v1", CURULE_GATEWAY_KEY: SECRET_KEY }), undefined, "not an address");
  assert.equal(managedModels({ CURULE_GATEWAY_URL: "ftp://gateway.example/v1", CURULE_GATEWAY_KEY: SECRET_KEY }), undefined, "not an http address");
  assert.equal(managedModels({}), undefined);
  assert.equal(managedModels({ CURULE_GATEWAY_URL: " http://gateway.internal:8080/v1/// ", CURULE_GATEWAY_KEY: SECRET_KEY })!.baseUrl, "http://gateway.internal:8080/v1", "trimmed, with no slash at the end");
});

test("the tier a team uses is the one the host is told, when it is a name, and balanced when it is not told or told nonsense", () => {
  const env = { CURULE_GATEWAY_URL: "https://gateway.example/v1", CURULE_GATEWAY_KEY: SECRET_KEY };
  assert.equal(DEFAULT_TIER, "balanced");
  assert.equal(managedModels({ ...env, CURULE_GATEWAY_MODEL: "fast" })!.tier, "fast");
  assert.equal(managedModels({ ...env, CURULE_GATEWAY_MODEL: " best.v2_x-1 " })!.tier, "best.v2_x-1");
  for (const nonsense of ["", "  ", "has space", "a/b", "x".repeat(65), "tier\nname"]) assert.equal(managedModels({ ...env, CURULE_GATEWAY_MODEL: nonsense })!.tier, "balanced", JSON.stringify(nonsense));
});

// ---- a mesh.yaml made to use them ----

test("the default team becomes a team on the gateway: native seats, one provider that names the key's variable, the tier as the model, and every comment kept", () => {
  const before = defaultMeshTemplate("Shop", "shop", "claude");
  const { text, changed } = rewriteForManagedModels(before, MANAGED);
  assert.equal(changed, true);
  assert.ok(!/runtime:\s*claude/.test(text), "no seat is left on the Claude runtime");
  assert.match(text, /runtime:\n    default: native\n    designer: native|default: native/);
  assert.match(text, /model: curule\/balanced/);
  assert.match(text, /curule:\n\s+kind: openai-compatible\n\s+base_url: https:\/\/gateway\.example\/v1\n\s+api_key_env: CURULE_GATEWAY_KEY/);
  assert.match(text, /# Writing agents commit through git worktrees/, "what the person may read in the file is kept");
  assert.ok(!text.includes(SECRET_KEY));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "managed-default-"));
  try {
    fs.writeFileSync(path.join(dir, "mesh.yaml"), text);
    fs.mkdirSync(path.join(dir, "roles"));
    fs.writeFileSync(path.join(dir, "roles", "architect.md"), "# architect\n");
    const config = resolveConfig(path.join(dir, "mesh.yaml"));
    assert.equal(config.defaultRuntime, "native");
    assert.deepEqual(Object.values(config.agents).map((a) => a.runtime), ["native"]);
    assert.deepEqual(config.native!.providers.curule, { kind: "openai-compatible", baseUrl: "https://gateway.example/v1", apiKeyEnv: "CURULE_GATEWAY_KEY" });
    assert.equal(config.native!.designer, "native");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a chosen tier is the model every seat uses unless it names another", () => {
  assert.match(rewriteForManagedModels(defaultMeshTemplate("Shop", "shop", "claude"), { ...MANAGED, tier: "fast" }).text, /model: curule\/fast/);
});

test("every shipped example that runs on Claude becomes a team on the gateway that still loads, and the demo, which needs no model, is left alone", () => {
  for (const example of fs.readdirSync(path.join(SHIPPED, "examples"))) {
    if (!fs.existsSync(path.join(SHIPPED, "examples", example, "mesh.yaml"))) continue;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "managed-example-"));
    try {
      scaffoldExample(SHIPPED, example, dir);
      const file = path.join(dir, "mesh.yaml");
      const original = fs.readFileSync(file, "utf8");
      const { text, changed } = rewriteForManagedModels(original, MANAGED);
      const wasClaude = /runtime:\s*claude/.test(original);
      assert.equal(changed, wasClaude, example);
      if (!changed) {
        assert.equal(text, original, `${example} needs no models and is not touched`);
        continue;
      }
      fs.writeFileSync(file, text);
      const config = resolveConfig(file);
      assert.equal(config.defaultRuntime, "native", example);
      assert.ok(Object.values(config.agents).every((a) => a.runtime === "native"), `${example}: every seat`);
      assert.equal(config.native!.providers.curule!.apiKeyEnv, "CURULE_GATEWAY_KEY");
      assert.ok(!/runtime:\s*claude/.test(text), example);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("a seat's Claude model hint is dropped, since it cannot be placed on another provider, and a seat on another runtime is left where it was", () => {
  const text = `version: 1
project: { id: shop, name: Shop }
mesh:
  id: shop
  name: Shop
  goal: x
  runtime:
    default: stub
agents:
  architect:
    role: architect
    runtime: claude
    model: opus
    prompt: ./a.md
  tester:
    role: qa
    prompt: ./b.md
  planner:
    role: pm
    runtime: claude
    prompt: ./c.md
`;
  const { text: out, changed } = rewriteForManagedModels(text, MANAGED);
  assert.equal(changed, true);
  assert.match(out, /architect:\n    role: architect\n    runtime: native\n    prompt: .\/a\.md/);
  assert.match(out, /planner:\n    role: pm\n    runtime: native/);
  assert.match(out, /default: stub/, "the mesh's own default is not changed when no seat inherits the Claude runtime");
  assert.ok(!/model: opus/.test(out));
  assert.match(out, /tester:\n    role: qa\n    prompt: .\/b\.md/);
});

test("a mesh that names no runtime at all, which is the Claude runtime, is given the gateway", () => {
  const { text, changed } = rewriteForManagedModels(`version: 1\nmesh:\n  id: shop\n  goal: x\nagents:\n  architect:\n    role: architect\n`, MANAGED);
  assert.equal(changed, true);
  assert.match(text, /runtime:\n    default: native/);
  assert.match(text, /model: curule\/balanced/);
});

test("what is not a mesh on Claude is returned as it was: a native mesh, one with no seats, and text that is not YAML", () => {
  for (const text of [
    "version: 1\nmesh:\n  id: shop\n  runtime:\n    default: native\n    model: other/small\n    providers:\n      other: { kind: openai-compatible, base_url: https://x.example/v1 }\nagents:\n  a:\n    role: r\n",
    "version: 1\nmesh:\n  id: shop\n  runtime:\n    default: stub\nagents:\n  a:\n    role: r\n",
    "version: 1\nmesh: {id: shop}\nagents: {}\n",
    "just: [unclosed",
    "- a\n- list\n",
    "",
  ]) {
    assert.deepEqual(rewriteForManagedModels(text, MANAGED), { text, changed: false }, JSON.stringify(text.slice(0, 40)));
  }
});

// ---- a host that offers it ----

const ENV_KEYS = ["HOME", "MESH_PROJECTS_ROOT", "MESH_API_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_OAUTH_TOKEN", "CURULE_GATEWAY_URL", "CURULE_GATEWAY_KEY", "CURULE_GATEWAY_MODEL"] as const;

function call(base: string, method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: Number(u.port), method, path: p, headers: { "content-type": "application/json" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        let json: any;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

async function withHost(env: Record<string, string>, fn: (l: { base: string; projects: string; host: HostHandle }) => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-managed-"));
  const projects = path.join(base, "projects");
  fs.mkdirSync(projects);
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.HOME = path.join(base, "home");
  Object.assign(process.env, env);
  const host = await startHostServer({ home: path.join(base, "state"), port: 0, dashboardDir: path.join(base, "none") });
  try {
    await fn({ base, projects, host });
  } finally {
    await host.close();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(base, { recursive: true, force: true });
  }
}

const MANAGED_ENV = { CURULE_GATEWAY_URL: "https://gateway.example/v1", CURULE_GATEWAY_KEY: SECRET_KEY, CURULE_GATEWAY_MODEL: "fast" };

test("the welcome says the models are supplied, and offers each team that would have used Claude as one on the native runtime", { timeout: 30_000 }, async () => {
  await withHost(MANAGED_ENV, async (l) => {
    const r = await call(l.host.url, "GET", "/api/templates");
    assert.equal(r.json.managed, true);
    const byId = Object.fromEntries(r.json.templates.map((t: { id: string; runtime: string }) => [t.id, t.runtime]));
    assert.equal(byId.default, "native");
    assert.equal(byId["demo-stub"], "stub", "the demo makes no model calls and says so");
    assert.ok(!Object.values(byId).includes("claude"));
    assert.deepEqual(r.json.modelAccess, [], "nothing of a vendor's: what the host has is the gateway");
    assert.ok(!JSON.stringify(r.json).includes(SECRET_KEY), "the key is not in the answer");
  });
  await withHost({}, async (l) => {
    const r = await call(l.host.url, "GET", "/api/templates");
    assert.equal(r.json.managed, false);
    assert.equal(r.json.templates[0].runtime, "claude");
  });
  await withHost({ CURULE_GATEWAY_URL: "https://gateway.example/v1" }, async (l) => {
    assert.equal((await call(l.host.url, "GET", "/api/templates")).json.managed, false, "an address with no key is not a way to a model");
  });
});

test("a team made from the welcome on a managed host runs on the gateway, and the file names the key's variable and not the key", { timeout: 30_000 }, async () => {
  await withHost(MANAGED_ENV, async (l) => {
    const made = await call(l.host.url, "POST", "/api/projects", { template: "default", root: path.join(l.projects, "shop") });
    assert.equal(made.status, 201, JSON.stringify(made.json));
    const file = path.join(l.projects, "shop", "mesh.yaml");
    const text = fs.readFileSync(file, "utf8");
    assert.match(text, /model: curule\/fast/);
    assert.match(text, /api_key_env: CURULE_GATEWAY_KEY/);
    assert.ok(!text.includes(SECRET_KEY));
    const config = resolveConfig(file);
    assert.equal(config.defaultRuntime, "native");
    assert.equal(config.native!.providers.curule!.baseUrl, "https://gateway.example/v1");

    const example = await call(l.host.url, "POST", "/api/projects", { template: "payment-api", root: path.join(l.projects, "payments") });
    assert.equal(example.status, 201, JSON.stringify(example.json));
    const ex = resolveConfig(path.join(l.projects, "payments", "mesh.yaml"));
    assert.ok(Object.values(ex.agents).every((a) => a.runtime === "native"));

    const demo = await call(l.host.url, "POST", "/api/projects", { template: "demo-stub", root: path.join(l.projects, "demo") });
    assert.equal(demo.status, 201, JSON.stringify(demo.json));
    assert.equal(resolveConfig(path.join(l.projects, "demo", "mesh.yaml")).defaultRuntime, "stub");

    const folder = path.join(l.projects, "scaffolded");
    fs.mkdirSync(folder);
    const init = await call(l.host.url, "POST", "/api/projects", { root: folder, init: true });
    assert.equal(init.status, 201, JSON.stringify(init.json));
    assert.equal(init.json.scaffolded, true);
    assert.match(fs.readFileSync(path.join(folder, "mesh.yaml"), "utf8"), /default: native/, "adding a folder with init is the same team");
  });
});

test("on a host that is not managed the same requests write the team on the Claude runtime, as they always did", { timeout: 30_000 }, async () => {
  await withHost({}, async (l) => {
    const made = await call(l.host.url, "POST", "/api/projects", { template: "default", root: path.join(l.projects, "shop") });
    assert.equal(made.status, 201);
    const text = fs.readFileSync(path.join(l.projects, "shop", "mesh.yaml"), "utf8");
    assert.match(text, /runtime: claude/);
    assert.ok(!/curule\/|CURULE_GATEWAY/.test(text));
  });
});
