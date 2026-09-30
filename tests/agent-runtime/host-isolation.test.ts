import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describeHostLeaks, outerSessionEnvNames, withoutOuterSession } from "../../packages/runtime-claude/src/host-isolation";
import { HOST_PID_ENV, seatEnv } from "../../packages/runtime-claude/src/orphans";
import { ClaudeRuntimeAdapter, type ClaudeAdapterOptions } from "../../packages/runtime-claude/src/index";
import { resolveConfig } from "../../packages/config/src/index";
import type { AgentDefinition, RuntimeContext } from "../../packages/protocol/src/index";

/**
 * What a seat's CLI inherits from the machine that launched the mesh.
 *
 * The SDK loads every filesystem settings source unless told not to, so the launching
 * user's hooks, allow rules, `env`, model and effort applied to every seat (the silent
 * model substitution of an earlier run came from here); and a mesh started from inside
 * another Claude Code session inherited that session's variables, so the seat CLIs
 * reported the OUTER session's id and ran at its effort (`CLAUDE_EFFORT=max`,
 * `MAX_THINKING_TOKENS=31999`). `mesh.runtime.isolate_host: true` closes both; the
 * boot log says when something would leak.
 */

const OUTER = {
  CLAUDECODE: "1",
  CLAUDE_CODE_SESSION_ID: "11111111-2222-4333-8444-555555555555",
  CLAUDE_CODE_ENTRYPOINT: "cli",
  CLAUDE_EFFORT: "max",
  MAX_THINKING_TOKENS: "31999",
  CLAUDE_CODE_ARTIFACT_STORE: "/tmp/outer",
};
const KEPT = {
  PATH: "/usr/bin",
  HOME: "/root",
  ANTHROPIC_API_KEY: "sk-test",
  ANTHROPIC_BASE_URL: "https://proxy.example.test",
  CLAUDE_CODE_OAUTH_TOKEN: "oauth-test",
  CLAUDE_CODE_USE_BEDROCK: "1",
  HTTPS_PROXY: "http://proxy:3128",
  SSL_CERT_FILE: "/etc/ssl/ca.pem",
};

test("only the launching session's variables are taken out; credentials, routing and proxies stay", () => {
  const env = { ...OUTER, ...KEPT, UNSET: undefined };
  assert.deepEqual(outerSessionEnvNames(env), Object.keys(OUTER).sort());
  assert.deepEqual(withoutOuterSession(env), { ...KEPT, UNSET: undefined }, "scrubbing is for session leakage, not a way to break auth");
  assert.deepEqual(outerSessionEnvNames(KEPT), []);
});

test("seatEnv scrubs an inherited session only when isolating, and never the operator's own env", () => {
  const saved = { ...process.env };
  Object.assign(process.env, OUTER, { ANTHROPIC_API_KEY: "sk-test" });
  try {
    // Not isolating: everything is inherited, exactly as before, plus the stamp.
    const plain = seatEnv(undefined, 7);
    assert.equal(plain.CLAUDE_EFFORT, "max");
    assert.equal(plain[HOST_PID_ENV], "7");

    // Isolating, with nothing passed: the process environment, minus the launching session.
    const isolated = seatEnv(undefined, 7, { isolate: true });
    for (const name of Object.keys(OUTER)) assert.equal(name in isolated, false, `${name} is gone`);
    assert.equal(isolated.ANTHROPIC_API_KEY, "sk-test");
    assert.equal(isolated.PATH, process.env.PATH);
    assert.equal(isolated[HOST_PID_ENV], "7");

    // A base the operator passed on purpose (`extraOptions.env` reaches here as `base`) is theirs, untouched.
    const chosen = { CLAUDE_EFFORT: "low", PATH: "/x" };
    assert.deepEqual(seatEnv(chosen, 7, { isolate: true }), { ...chosen, [HOST_PID_ENV]: "7" });
  } finally {
    for (const name of Object.keys(OUTER)) delete process.env[name];
    if (saved.ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved.ANTHROPIC_API_KEY;
    for (const name of Object.keys(OUTER)) if (saved[name] !== undefined) process.env[name] = saved[name];
  }
});

function configDir(settings: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-hostcfg-"));
  if (settings !== undefined) fs.writeFileSync(path.join(dir, "settings.json"), typeof settings === "string" ? settings : JSON.stringify(settings), "utf8");
  return dir;
}

test("the boot detector names what would leak, and the knob that closes it", () => {
  const dir = configDir({ hooks: { PreToolUse: [{ hooks: [] }] }, permissions: { allow: ["Bash(*)"] }, model: "opus", theme: "dark" });
  try {
    const leaks = describeHostLeaks({ env: { ...OUTER, PATH: "/usr/bin" }, configDir: dir });
    assert.equal(leaks.length, 3);
    assert.match(leaks[0]!, /started from inside another Claude Code session.*CLAUDE_CODE_ARTIFACT_STORE.*CLAUDE_EFFORT/);
    assert.match(leaks[1]!, /settings\.json, and it sets hooks, permissions, model: each applies to every seat/);
    assert.doesNotMatch(leaks[1]!, /theme/, "a setting that only changes the user's terminal is not a leak");
    assert.match(leaks[2]!, /mesh\.runtime\.isolate_host: true/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a machine with nothing to lend says nothing", () => {
  const empty = configDir(undefined);
  const inert = configDir({ theme: "dark", env: {}, permissions: {}, hooks: {} });
  const broken = configDir("{ not json");
  try {
    assert.deepEqual(describeHostLeaks({ env: { PATH: "/usr/bin" }, configDir: empty }), [], "no settings file, no outer session");
    assert.deepEqual(describeHostLeaks({ env: { PATH: "/usr/bin" }, configDir: inert }), [], "empty objects change nothing");
    assert.deepEqual(describeHostLeaks({ env: { PATH: "/usr/bin" }, configDir: broken }), [], "an unreadable file is nothing to inherit");
  } finally {
    for (const d of [empty, inert, broken]) fs.rmSync(d, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ the adapter

const devDef: AgentDefinition = {
  id: "developer",
  role: "developer",
  mode: "peer",
  runtime: "claude",
  prompt: { text: "you build things" },
  capabilities: ["repository.write"],
  authority: [],
  communicationPolicy: { mayContact: [], mayBeContactedBy: [] },
  interests: [],
  sessionPolicy: { persistent: true },
  delegationPolicy: { allowDelegation: false, maxDepth: 0, maxWorkers: 0 },
  budget: {},
};
const ctx = (dir: string): RuntimeContext => ({
  goalId: "goal-1",
  meshId: "test",
  workspacePath: dir,
  busUrl: "http://127.0.0.1:1",
  agentToken: "test:developer:abcd",
  rolePromptText: "you build things",
  capabilityGrants: devDef.capabilities,
  env: {},
});

function recordingQuery(seen: Array<Record<string, unknown>>): ClaudeAdapterOptions["queryFn"] {
  return (({ prompt, options }: { prompt: unknown; options: Record<string, unknown> }) => {
    seen.push(options);
    const gen = (async function* () {
      yield { type: "system", subtype: "init", session_id: String(options.sessionId ?? options.resume), model: "claude-test", mcp_servers: [{ name: "mesh", status: "connected" }] };
      for await (const _ of prompt as AsyncIterable<unknown>) void _;
    })();
    return Object.assign(gen, {
      interrupt: async () => undefined,
      setPermissionMode: async () => undefined,
      setModel: async () => undefined,
      supportedModels: async () => [],
      supportedCommands: async () => [],
      mcpServerStatus: async () => ({}),
    });
  }) as unknown as ClaudeAdapterOptions["queryFn"];
}

async function spawnOptions(opts: Partial<ClaudeAdapterOptions>): Promise<Record<string, unknown>> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-iso-"));
  const seen: Array<Record<string, unknown>> = [];
  const rt = new ClaudeRuntimeAdapter({ queryFn: recordingQuery(seen), ...opts });
  try {
    const s = await rt.start(devDef, ctx(dir));
    await rt.stop(s);
    return seen[0]!;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("isolate_host: the seat is spawned with no filesystem settings and without the outer session's environment", async () => {
  const before = { ...process.env };
  Object.assign(process.env, OUTER);
  try {
    const isolated = await spawnOptions({ isolateHost: true });
    assert.deepEqual(isolated.settingSources, [], "an empty list is the SDK's isolation mode");
    const env = isolated.env as Record<string, string | undefined>;
    for (const name of Object.keys(OUTER)) assert.equal(env[name], undefined, `${name} does not reach the seat`);
    assert.equal(env.PATH, process.env.PATH, "everything else the CLI needs still does");
    assert.equal(env[HOST_PID_ENV], String(process.pid));

    // Off (the default): exactly what every mesh has always run with.
    const inherited = await spawnOptions({});
    assert.equal("settingSources" in inherited, false);
    assert.equal((inherited.env as Record<string, string | undefined>).CLAUDE_EFFORT, "max");
  } finally {
    for (const name of Object.keys(OUTER)) delete process.env[name];
    Object.assign(process.env, Object.fromEntries(Object.entries(before).filter(([k]) => k in OUTER)));
  }
});

test("isolate_host yields to the operator's own extraOptions, like every other default here", async () => {
  const opts = await spawnOptions({ isolateHost: true, extraOptions: { settingSources: ["user"] } });
  assert.deepEqual(opts.settingSources, ["user"], "the escape hatch can load settings on purpose");
});

// ------------------------------------------------------------------ the config key

function resolveYaml(runtime: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-isocfg-"));
  fs.writeFileSync(
    path.join(dir, "mesh.yaml"),
    `version: 1\nmesh:\n  id: isotest\n  goal: |\n    Test.\n  workspace: { path: ./workspace }\n  runtime: { default: stub${runtime} }\nagents:\n  a: { role: worker }\n`,
    "utf8",
  );
  try {
    return resolveConfig(path.join(dir, "mesh.yaml"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("mesh.runtime.isolate_host resolves; absent and false leave it off; a non-boolean is refused", () => {
  assert.equal(resolveYaml(", isolate_host: true").isolateHost, true);
  assert.equal(resolveYaml("").isolateHost, undefined);
  assert.equal(resolveYaml(", isolate_host: false").isolateHost, undefined);
  assert.throws(() => resolveYaml(", isolate_host: yes please"));
});
