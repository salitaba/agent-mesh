import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runProvidersCommand, PROVIDERS_HELP } from "../../apps/mesh-cli/src/providers";
import { fakeServer, frame, json, sseHead, type FakeServer } from "../llm/fake-server";

/**
 * `curule providers check`: the cheap questions asked before a mission spends money on the expensive ones.
 */

const chunk = (delta: object, finish: string | null = null) => ({ id: "c", model: "m-snapshot", choices: [{ index: 0, delta, finish_reason: finish }] });

/** A provider that lists two models and answers a chat with a tool call, or with text when `calls` is false. */
async function provider(opts: { key?: string; calls?: boolean } = {}): Promise<FakeServer> {
  return fakeServer((req, res) => {
    if (opts.key && req.headers.authorization !== `Bearer ${opts.key}`) return json(res, 401, { error: { message: "Incorrect API key provided" } });
    if (req.url === "/v1/models") return json(res, 200, { data: [{ id: "m-1" }, { id: "m-2" }] });
    sseHead(res);
    if (opts.calls === false) frame(res, chunk({ content: "pong" }));
    else frame(res, chunk({ tool_calls: [{ index: 0, id: "c1", function: { name: "ping", arguments: '{"text":"ok"}' } }] }));
    frame(res, chunk({}, opts.calls === false ? "stop" : "tool_calls"));
    frame(res, { id: "c", model: "m-snapshot", choices: [], usage: { prompt_tokens: 40, completion_tokens: 9 } });
    frame(res, "[DONE]");
    res.end();
  });
}

function meshFile(providers: Record<string, string>, extra = ""): { file: string; cleanup(): void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "providers-cmd-"));
  const entries = Object.entries(providers).map(([name, spec]) => `      ${name}: ${spec}`).join("\n");
  fs.writeFileSync(
    path.join(dir, "mesh.yaml"),
    `version: 1
mesh:
  id: t
  goal: |
    Test.
  workspace: { path: ./workspace }
  runtime:
    default: native
    model: ${Object.keys(providers)[0]}/m-1
    providers:
${entries}
${extra}
agents:
  a: { role: worker }
`,
  );
  return { file: path.join(dir, "mesh.yaml"), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function run(args: string[], flags: Record<string, string | boolean>, env: NodeJS.ProcessEnv) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runProvidersCommand(args, flags, { env, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

test("each provider is checked: its key is there, it answers, and it lists its models", async () => {
  const a = await provider({ key: "sk-a" });
  const m = meshFile({ alpha: `{ kind: openai-compatible, base_url: "${a.url}/v1", api_key_env: ALPHA_KEY }` });
  try {
    const r = await run(["check", m.file], {}, { ALPHA_KEY: "sk-a" });
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /^ok {3}alpha \(openai-compatible, 127\.0\.0\.1:\d+\): 2 models listed/m);
    assert.match(r.out, /To prove a model works as a seat does, add --model provider\/model\./);
    assert.ok(!r.out.includes("sk-a"), "a key is never printed");
    assert.equal(a.seen.filter((s) => s.url === "/v1/chat/completions").length, 0, "nothing is spent without --model");
  } finally {
    m.cleanup();
    await a.close();
  }
});

test("a key that is not in the environment, and one the provider refuses, are each named", async () => {
  const a = await provider({ key: "right" });
  const m = meshFile({
    missing: `{ kind: openai-compatible, base_url: "${a.url}/v1", api_key_env: NOT_SET_KEY }`,
    wrong: `{ kind: openai-compatible, base_url: "${a.url}/v1", api_key_env: WRONG_KEY }`,
  });
  try {
    const r = await run(["check", m.file], {}, { WRONG_KEY: "nope" });
    assert.equal(r.code, 1);
    assert.match(r.out, /^FAIL missing \(.*\): NOT_SET_KEY is not set in the environment/m);
    assert.match(r.out, /^FAIL wrong \(.*\): could not list models: API Error: 401 Incorrect API key provided/m);
  } finally {
    m.cleanup();
    await a.close();
  }
});

test("a provider that answers but will not list its models is not called broken: the verdict is left to --model", async () => {
  const a = await fakeServer((req, res) => (req.url === "/v1/models" ? json(res, 404, { error: { message: "not found" } }) : (sseHead(res), frame(res, chunk({ tool_calls: [{ index: 0, id: "c", function: { name: "ping", arguments: '{"text":"ok"}' } }] })), frame(res, chunk({}, "tool_calls")), frame(res, "[DONE]"), res.end())));
  const m = meshFile({ alpha: `{ kind: openai-compatible, base_url: "${a.url}/v1" }` });
  try {
    const plain = await run(["check", m.file], {}, {});
    assert.equal(plain.code, 0);
    assert.match(plain.out, /could not list models: API Error: 404/);
    const probed = await run(["check", m.file], { model: "alpha/m-1" }, {});
    assert.equal(probed.code, 0, probed.out);
    assert.match(probed.out, /ok {2} {5}alpha\/m-1|ok {2}.*m-1: answered in \d+ ms as m-snapshot, called the tool/s);
  } finally {
    m.cleanup();
    await a.close();
  }
});

test("--model makes one small call with a tool, and says what it used and what the provider called the model", async () => {
  const a = await provider();
  const m = meshFile({ alpha: `{ kind: openai-compatible, base_url: "${a.url}/v1" }` });
  try {
    const r = await run(["check", m.file], { model: "alpha/m-1" }, {});
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /m-1: answered in \d+ ms as m-snapshot, called the tool; 40 in, 9 out/);
    const call = a.seen.find((s) => s.url === "/v1/chat/completions")!;
    assert.equal(call.body.model, "m-1");
    assert.equal(call.body.tools[0].function.name, "ping");
    assert.ok(call.body.max_tokens <= 200, "the probe is small");
  } finally {
    m.cleanup();
    await a.close();
  }
});

test("a model that answers in text instead of calling the tool fails the check: it cannot be a seat", async () => {
  const a = await provider({ calls: false });
  const m = meshFile({ alpha: `{ kind: openai-compatible, base_url: "${a.url}/v1" }` });
  try {
    const r = await run(["check", m.file], { model: "alpha/m-1" }, {});
    assert.equal(r.code, 1);
    assert.match(r.out, /did not call the tool \(it said: "pong"\); a model that does not do tool calls cannot be a seat/);
  } finally {
    m.cleanup();
    await a.close();
  }
});

test("--json is the same result as data, and a model that names no provider is refused with the providers there are", async () => {
  const a = await provider();
  const m = meshFile({ alpha: `{ kind: openai-compatible, base_url: "${a.url}/v1" }`, beta: `{ kind: openai-compatible, base_url: "${a.url}/v1" }` });
  try {
    const r = await run(["check", m.file], { json: true, model: "alpha/m-1" }, {});
    const rows = JSON.parse(r.out) as Array<{ provider: string; ok: boolean; models?: number; probe?: { ok: boolean; toolCalls: number; input: number; output: number } }>;
    assert.deepEqual(rows.map((x) => [x.provider, x.ok, x.models]), [["alpha", true, 2], ["beta", true, 2]]);
    assert.deepEqual(rows[0]!.probe && [rows[0]!.probe.ok, rows[0]!.probe.toolCalls, rows[0]!.probe.input, rows[0]!.probe.output], [true, 1, 40, 9]);
    assert.equal(rows[1]!.probe, undefined);
    const bad = await run(["check", m.file], { model: "gamma/x" }, {});
    assert.equal(bad.code, 1);
    // `gamma/x` is not a configured provider, so it is a bare model id, and with two providers and a default that is not set it names none.
    assert.match(bad.err, /--model: model 'gamma\/x' names no provider and there is no default; write it as provider\/model \(providers: alpha, beta\)/);
  } finally {
    m.cleanup();
    await a.close();
  }
});

test("there must be something to check, a file to read, and a subcommand that exists", async () => {
  const r0 = await run([], {}, {});
  assert.equal(r0.code, 1);
  assert.equal(r0.out, PROVIDERS_HELP);
  assert.equal((await run([], { help: true }, {})).code, 0);
  assert.equal((await run(["frobnicate"], {}, {})).code, 1);
  const missing = await run(["check", "/no/such/mesh.yaml"], {}, {});
  assert.equal(missing.code, 1);
  assert.match(missing.err, /does not exist/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "providers-cmd-"));
  try {
    fs.writeFileSync(path.join(dir, "mesh.yaml"), "version: 1\nmesh:\n  id: t\n  goal: |\n    x\n  workspace: { path: ./w }\n  runtime: { default: stub }\nagents:\n  a: { role: worker }\n");
    const none = await run(["check", path.join(dir, "mesh.yaml")], {}, {});
    assert.equal(none.code, 1);
    assert.match(none.err, /declares no providers/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
