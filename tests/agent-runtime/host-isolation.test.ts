import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describeHostLeaks, describeIsolation, outerSessionEnvNames, withoutOuterSession } from "../../packages/runtime-claude/src/host-isolation";
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

/**
 * The environment of a Claude Code session running in a container, as measured in the second
 * cronlite run (56 `CLAUDE*` variables; the names here are the ones that matter, values are
 * stand-ins). `isolate_host` took out ten of them: the five names the first run had shown and the
 * artifact plumbing. Everything below the first group still reached every seat.
 */
const SEEN_IN_FIRST_RUN = ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_EFFORT", "MAX_THINKING_TOKENS", "CLAUDE_CODE_ARTIFACT_DB", "CLAUDE_CODE_ARTIFACT_ASSETS"];
const LEFT_BEHIND_BY_THE_LIST = [
  "CLAUDE_CODE_REMOTE_SESSION_ID",
  "CLAUDE_SESSION_INGRESS_TOKEN_FILE",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE",
  "CLAUDE_CODE_DEBUG",
  "CLAUDE_CODE_DIAGNOSTICS_FILE",
  "CLAUDE_CODE_USE_CCR_V2",
  "CLAUDE_CODE_REMOTE",
  "CLAUDE_CODE_REMOTE_HERMETIC_MODE",
  "CLAUDE_CODE_CONTAINER_ID",
  "CLAUDE_CODE_ACCOUNT_UUID",
  "CLAUDE_CODE_USER_EMAIL",
  "CLAUDE_CODE_WORKER_EPOCH",
  "CLAUDE_AUTO_BACKGROUND_TASKS",
  "CLAUDE_ENABLE_STREAM_WATCHDOG",
  "CLAUDE_PID",
];
const CONTAINER: Record<string, string> = Object.fromEntries([...SEEN_IN_FIRST_RUN, ...LEFT_BEHIND_BY_THE_LIST].map((name) => [name, `outer-${name.toLowerCase()}`]));
/** Names that say how to reach the model, and the operator's privacy setting: the family's exceptions. */
const ROUTING = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_API_KEY_HELPER_TTL_MS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
  "CLAUDE_CODE_CLIENT_CERT",
  "CLAUDE_CODE_CLIENT_KEY",
  "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE",
  "CLAUDE_CODE_PROXY_RESOLVES_HOSTS",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "CLAUDE_CONFIG_DIR",
];
const ROUTED: Record<string, string> = Object.fromEntries(ROUTING.map((name) => [name, `routing-${name.toLowerCase()}`]));

test("isolation removes the launching session's whole namespace, not the names the first run happened to show", () => {
  const env = { ...CONTAINER, ...ROUTED, ...KEPT, DISABLE_AUTOUPDATER: "1", MCP_TOOL_TIMEOUT: "60000" };
  const seat = withoutOuterSession(env);
  for (const name of [...SEEN_IN_FIRST_RUN, ...LEFT_BEHIND_BY_THE_LIST]) assert.equal(name in seat, false, `${name} does not reach the seat`);
  assert.deepEqual(
    Object.keys(seat).filter((k) => k.startsWith("CLAUDE")).sort(),
    [...ROUTING, ...Object.keys(KEPT).filter((k) => k.startsWith("CLAUDE"))].filter((k, i, all) => all.indexOf(k) === i).sort(),
    "of the family, only what authenticates or routes the CLI is left",
  );
  // What is outside the namespace is not isolation's business.
  for (const [name, value] of Object.entries({ ...KEPT, DISABLE_AUTOUPDATER: "1", MCP_TOOL_TIMEOUT: "60000" })) assert.equal(seat[name], value, `${name} is untouched`);
  assert.deepEqual(outerSessionEnvNames(env), [...Object.keys(CONTAINER)].sort(), "and the boot detector names exactly what isolation removes");
});

test("an operator's privacy setting survives isolation: the image's telemetry opt-out reaches the seats", () => {
  const seat = withoutOuterSession({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_SESSION_ID: "outer", DISABLE_TELEMETRY: "1" });
  assert.deepEqual(seat, { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1" });
  assert.deepEqual(outerSessionEnvNames({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }), [], "and it is not reported as a leak from an outer session");
});

test("a provider flag is the family's exception, and the outer session's transport flag next to it is not", () => {
  const seat = withoutOuterSession({ CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_VERTEX: "1", CLAUDE_CODE_USE_FOUNDRY: "1", CLAUDE_CODE_USE_CCR_V2: "1" });
  assert.deepEqual(Object.keys(seat).sort(), ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_VERTEX"]);
});

test("a name that only begins like the family is still in it, and one that merely contains it is not", () => {
  const seat = withoutOuterSession({ CLAUDE_SOMETHING_NEW: "1", CLAUDEFUTURE: "1", MY_CLAUDE_TOKEN: "x", NOT_CLAUDECODE: "y" });
  assert.deepEqual(seat, { MY_CLAUDE_TOKEN: "x", NOT_CLAUDECODE: "y" }, "a variable added by the next release goes without being named");
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

test("a long list is counted, not spelled out, and the outer session's credentials are named apart", () => {
  const leaks = describeHostLeaks({ env: { ...CONTAINER, PATH: "/usr/bin" }, configDir: configDir(undefined) });
  const removed = outerSessionEnvNames(CONTAINER);
  assert.ok(removed.length > 20, "fixture: a container-sized list");
  assert.equal(leaks.length, 3, "the session line, the credentials line, the knob");
  assert.match(leaks[0]!, new RegExp(`\\(${removed.slice(0, 6).join(", ")} and ${removed.length - 6} more\\)`), "the first six names, then how many more");
  assert.ok(leaks[0]!.length < 450, `one readable line, not ${leaks[0]!.length} characters`);
  assert.doesNotMatch(leaks[0]!, /CLAUDE_PID/, "the tail is counted, not listed");
  assert.match(leaks[1]!, /CLAUDE_CODE_MESSAGING_TOKEN.*CLAUDE_SESSION_INGRESS_TOKEN_FILE|CLAUDE_SESSION_INGRESS_TOKEN_FILE.*CLAUDE_CODE_MESSAGING_TOKEN/);
  assert.match(leaks[1]!, /look like the outer session's own credentials, and every seat's shell can read them/);
  assert.match(leaks[2]!, /mesh\.runtime\.isolate_host: true/);
  // Few names are listed whole, and a session with no token-like name has no credentials line:
  // `MAX_THINKING_TOKENS` is a setting, and a setting is not a secret for containing a word.
  const few = describeHostLeaks({ env: { CLAUDE_EFFORT: "max", CLAUDE_CODE_SESSION_ID: "x", MAX_THINKING_TOKENS: "31999" }, configDir: configDir(undefined) });
  assert.match(few[0]!, /\(CLAUDE_CODE_SESSION_ID, CLAUDE_EFFORT, MAX_THINKING_TOKENS\)/);
  assert.equal(few.length, 2);
});

test("what isolation removed is written down in full, with the names it kept", () => {
  assert.equal(describeIsolation({ PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-test" }), null, "nothing to remove, nothing to say");
  const said = describeIsolation({ ...CONTAINER, CLAUDE_CODE_OAUTH_TOKEN: "t", CLAUDE_CONFIG_DIR: "/cfg", PATH: "/usr/bin" })!;
  const removed = outerSessionEnvNames(CONTAINER);
  assert.match(said, new RegExp(`seats run without ${removed.length} variables of the launching environment`));
  for (const name of removed) assert.ok(said.includes(name), `${name} is named: the list is for finding what a seat that cannot log in lost`);
  assert.match(said, /kept, because they authenticate or route the CLI: CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CONFIG_DIR/);
  assert.match(describeIsolation({ CLAUDE_EFFORT: "max" })!, /without 1 variable of the launching environment \(CLAUDE_EFFORT\)$/);
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

// ------------------------------------------------------ the mesh's own credentials

import { isMeshSecret, withoutMeshSecrets } from "../../packages/runtime-claude/src/orphans";

test("the mesh's own credentials are named by pattern, so a new one is covered without anyone listing it", () => {
  for (const name of ["MESH_API_TOKEN", "MESH_LICENSE", "MESH_LICENSE_KEY", "MESH_AGENT_TOKEN", "MESH_SESSION_SECRET", "MESH_ADMIN_PASSWORD", "MESH_FUTURE_API_TOKEN"]) {
    assert.equal(isMeshSecret(name), true, name);
  }
  for (const name of ["MESH_BUS_URL", "MESH_HOME", "MESH_PORT", "MESH_BIND", "MESH_LICENSE_FILE", "MESH_LICENSE_ENFORCEMENT", "MESH_ALLOWED_HOSTS", "MESH_CHILD_CONFIG", "ANTHROPIC_API_KEY", "GH_TOKEN", "PATH", "MY_MESH_API_TOKEN", "MESHTOKEN"]) {
    assert.equal(isMeshSecret(name), false, `${name} is not the mesh's credential`);
  }
});

test("a seat does not inherit the operator's token or the licence, with or without isolation", () => {
  const saved = { token: process.env.MESH_API_TOKEN, lic: process.env.MESH_LICENSE, key: process.env.ANTHROPIC_API_KEY, url: process.env.MESH_BUS_URL };
  process.env.MESH_API_TOKEN = "operator-or-child-token";
  process.env.MESH_LICENSE = "AML1.k1.payload.sig";
  process.env.ANTHROPIC_API_KEY = "sk-test";
  process.env.MESH_BUS_URL = "http://127.0.0.1:7421";
  try {
    for (const isolate of [false, true]) {
      const env = seatEnv(undefined, 7, { isolate });
      assert.equal("MESH_API_TOKEN" in env, false, `isolate=${isolate}: the operator token stays out of a seat's shell`);
      assert.equal("MESH_LICENSE" in env, false, `isolate=${isolate}: and so does the licence (the variable the product actually reads)`);
      assert.equal(env.ANTHROPIC_API_KEY, "sk-test", "the seat's CLI still reaches the model");
      assert.equal(env.MESH_BUS_URL, "http://127.0.0.1:7421", "a URL is not a credential");
      assert.equal(env[HOST_PID_ENV], "7");
    }
    // The operator's own `env` option is theirs, untouched: it is a deliberate choice.
    const chosen = { MESH_API_TOKEN: "i-meant-it", PATH: "/x" };
    assert.deepEqual(seatEnv(chosen, 7), { ...chosen, [HOST_PID_ENV]: "7" });
  } finally {
    for (const [k, v] of [["MESH_API_TOKEN", saved.token], ["MESH_LICENSE", saved.lic], ["ANTHROPIC_API_KEY", saved.key], ["MESH_BUS_URL", saved.url]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("withoutMeshSecrets keeps everything else, in order, and does not mutate its input", () => {
  const input = { A: "1", MESH_API_TOKEN: "x", B: "2", MESH_X_SECRET: "y", C: undefined };
  const out = withoutMeshSecrets(input);
  assert.deepEqual(out, { A: "1", B: "2", C: undefined });
  assert.equal("MESH_API_TOKEN" in input, true);
});
