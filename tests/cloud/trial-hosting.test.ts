/**
 * The hosting-only trial: the service as the owner sells it (a customer brings their own model key), on one machine, so that it can be
 * seen and tested. What is under test is what makes that possible with nothing real behind it: plans that sell hosting only and need no
 * gateway, a stand-in model that speaks as a provider does (read here by the adapter a host uses), the address a customer gives the key form,
 * and how a host that is told it reaches the stand-in. `tests/integration/cloud-trial.test.ts` walks a customer through it with a real host.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { main, USAGE, type Io } from "../../apps/cloud-server/src/index";
import {
  STAND_IN_SENTENCE,
  StandInHosts,
  StandInModel,
  TRIAL_HOSTING_PLANS,
  TRIAL_MODEL_ADDRESS,
  TRIAL_PLANS,
  createModelServer,
  describeTrial,
  standInEnvironment,
  startTrial,
  trialPorts,
  type RunningTrial,
  type TrialOptions,
} from "../../apps/cloud-server/src/trial";
import { rerouteFetch } from "../../apps/cloud-server/src/trial-reroute";
import { checkBaseUrl, checkModelKeyInput, parseCatalogue, type ProvisionedWorkspace, type Provisioner, type WorkspaceSpec } from "../../packages/cloud/src/index";
import { OpenAiCompatibleProvider, estimateTokens, type ModelEvent } from "../../packages/llm/src/index";
import { ask, listen } from "./net-support";

const PRELOAD = path.resolve(__dirname, "..", "..", "apps", "cloud-server", "src", "trial-reroute.js");

// ---- the plans ----

test("the hosting-only trial's plans sell hosting and nothing else: no usage, no tier, no top-up, so the control plane needs no gateway for them", () => {
  const catalogue = parseCatalogue(TRIAL_HOSTING_PLANS);
  assert.deepEqual(catalogue.plans().map((p) => [p.id, p.byok, p.includedUsageMicros, p.tiers, p.defaultTier]), [["team", true, 0, undefined, undefined], ["business", true, 0, undefined, undefined]]);
  assert.equal(catalogue.sellsUsage, false, "so a configuration of them has no gateway section");
  assert.deepEqual(catalogue.topups, { optionsMinor: [], minimumMinor: 0, maximumMinor: 0, usageMicrosPerMinor: 0 });
  assert.equal(catalogue.currency, "USD");
  assert.match(TRIAL_HOSTING_PLANS.plans.team.summary, /not an offer/, "and, like the other trial's, they say they are not an offer");
  const usage = parseCatalogue(TRIAL_PLANS);
  assert.deepEqual(
    catalogue.plans().map((p) => [p.id, p.title, p.priceMinor, p.workspaces, p.licencePlan]),
    usage.plans().map((p) => [p.id, p.title, p.priceMinor, p.workspaces, p.licencePlan]),
    "the two trials differ in what is sold and not in what it costs, so a walk through one is a walk through the other",
  );
});

// ---- the stand-in, spoken as a provider ----

async function standInServer() {
  const standIn = new StandInModel();
  const server = await listen(createModelServer(standIn));
  return { standIn, ...server, url: `http://127.0.0.1:${server.port}/v1` };
}
const completion = (over: Record<string, unknown> = {}) => ({ model: "any-model", messages: [{ role: "user", content: "hi" }], ...over });
const post = (port: number, json: unknown, headers: Record<string, string> = {}) => ask(port, { method: "POST", path: "/v1/chat/completions", json, headers });

test("the adapter a host uses for an openai-compatible provider reads the stand-in: a model to list, the sentence a word at a time, the turn ended, and usage from what it was sent", async () => {
  const s = await standInServer();
  try {
    const provider = new OpenAiCompatibleProvider({ baseUrl: s.url, apiKey: "any key at all" });
    assert.deepEqual(await provider.listModels(), ["stand-in-1"]);
    const events: ModelEvent[] = [];
    for await (const e of provider.stream({ model: "claude-sonnet-4-5", system: "You are a seat.", messages: [{ role: "user", content: "Write hello.txt." }] })) events.push(e);
    const words = events.filter((e): e is Extract<ModelEvent, { kind: "text" }> => e.kind === "text");
    assert.ok(words.length > 5, "a word at a time, as a model streams");
    assert.equal(words.map((e) => e.delta).join(""), STAND_IN_SENTENCE);
    const end = events.at(-1)!;
    assert.equal(end.kind, "end");
    if (end.kind !== "end") return;
    assert.deepEqual([end.result.text, end.result.toolCalls, end.result.stopReason, end.result.model], [STAND_IN_SENTENCE, [], "end_turn", "claude-sonnet-4-5"], "the model asked for is the model that answers, as a provider's does");
    assert.equal(end.result.usage.input, estimateTokens(JSON.stringify(["You are a seat.", [{ role: "user", content: "Write hello.txt." }]])), "what it was sent, system apart from the conversation, four characters to a token");
    assert.equal(end.result.usage.output, estimateTokens(STAND_IN_SENTENCE));
    assert.equal(end.result.usage.estimated, undefined, "and it says so itself, so the adapter does not have to guess");
    assert.equal(s.standIn.calls, 1, "the call reached the stand-in model, which counts it");
  } finally {
    await s.close();
  }
});

test("a call that does not stream is answered with one completion, a call that does ends with [DONE], and usage is sent only to a caller that asked for it", async () => {
  const s = await standInServer();
  try {
    const whole = await post(s.port, completion());
    assert.equal(whole.status, 200);
    assert.match(String(whole.headers["content-type"]), /^application\/json/);
    assert.equal(whole.json.object, "chat.completion");
    assert.deepEqual(whole.json.choices, [{ index: 0, message: { role: "assistant", content: STAND_IN_SENTENCE }, finish_reason: "stop" }]);
    assert.equal(whole.json.model, "any-model");
    const prompt = estimateTokens(JSON.stringify(["", [{ role: "user", content: "hi" }]]));
    assert.deepEqual(whole.json.usage, { prompt_tokens: prompt, completion_tokens: estimateTokens(STAND_IN_SENTENCE), total_tokens: prompt + estimateTokens(STAND_IN_SENTENCE) });
    assert.equal((await post(s.port, { messages: [{ role: "user", content: "x" }] })).json.model, "stand-in-1", "a call that names no model is answered by the stand-in's own");

    const streamed = await post(s.port, completion({ stream: true }));
    assert.match(String(streamed.headers["content-type"]), /^text\/event-stream/);
    assert.ok(streamed.body.endsWith("data: [DONE]\n\n"));
    assert.ok(!streamed.body.includes('"usage"'), "a caller that did not ask for usage is not sent it");
    const withUsage = await post(s.port, completion({ stream: true, stream_options: { include_usage: true } }));
    const chunks = withUsage.body.split("\n\n").filter((c) => c.startsWith("data: {")).map((c) => JSON.parse(c.slice(6)));
    assert.deepEqual(chunks.at(-1).choices, [], "usage comes in a chunk of its own, with no choice, as providers send it");
    assert.equal(chunks.at(-1).usage.completion_tokens, estimateTokens(STAND_IN_SENTENCE));
    assert.deepEqual(chunks.at(-2).choices, [{ index: 0, delta: {}, finish_reason: "stop" }]);
    assert.equal(chunks[0].choices[0].delta.role, "assistant");
    assert.equal(chunks.slice(1, -2).map((c) => c.choices[0].delta.content).join(""), STAND_IN_SENTENCE);
  } finally {
    await s.close();
  }
});

test("the stand-in takes any key, or none, and says what is wrong with a request that is not one", async () => {
  const s = await standInServer();
  try {
    for (const headers of [{}, { authorization: "Bearer anything" }, { authorization: "Bearer sk-ant-api03-not-even-this-kind" }, { authorization: "no scheme" }] as Array<Record<string, string>>) assert.equal((await post(s.port, completion(), headers)).status, 200, JSON.stringify(headers));

    const bad = async (body: string | Buffer, path = "/v1/chat/completions") => ask(s.port, { method: "POST", path, headers: { "content-type": "application/json" }, body });
    for (const body of ["not json", "[]", "7", "null", ""]) {
      const r = await bad(body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.deepEqual(r.json.error, { message: "The request body must be a JSON object.", type: "invalid_request_error", param: null, code: null });
    }
    assert.equal((await post(s.port, { model: "m" })).json.error.message, "messages must be a list.");
    assert.equal((await post(s.port, { model: "m", messages: "hi" })).status, 400);

    // A system message is the system, apart from the conversation, as the usage it reports is counted.
    const sys = await post(s.port, completion({ messages: [{ role: "system", content: "Be brief." }, { role: "system", content: "Be kind." }, { role: "user", content: "hi" }] }));
    assert.equal(sys.json.usage.prompt_tokens, estimateTokens(JSON.stringify(["Be brief.\nBe kind.", [{ role: "user", content: "hi" }]])));

    assert.deepEqual([(await ask(s.port, { path: "/v1/chat/completions" })).status, (await ask(s.port, { path: "/v1/chat/completions" })).headers.allow], [405, "POST"]);
    assert.deepEqual([(await ask(s.port, { method: "POST", path: "/v1/models" })).status, (await ask(s.port, { method: "POST", path: "/v1/models" })).headers.allow], [405, "GET"]);
    assert.equal((await ask(s.port, { path: "/v1/models/" })).status, 200, "a trailing slash is the same address");
    const nothing = await ask(s.port, { path: "/v1/embeddings" });
    assert.equal(nothing.status, 404);
    assert.match(nothing.json.error.message, /There is nothing at \/v1\/embeddings\. This stand-in model answers POST \/v1\/chat\/completions and GET \/v1\/models\./);
    assert.equal(s.standIn.calls, 5, "only the calls that were answered are counted: the four with a key or none, and the one with system messages");
  } finally {
    await s.close();
  }
});

test("a request of 16 MiB, which a long conversation can be, is answered, and one byte more is refused and read to its end so the refusal can be sent", async () => {
  const s = await standInServer();
  try {
    const limit = 16 * 1024 * 1024;
    const shell = JSON.stringify(completion({ messages: [{ role: "user", content: "" }] }));
    const pad = (bytes: number): string => JSON.stringify(completion({ messages: [{ role: "user", content: "x".repeat(bytes - Buffer.byteLength(shell)) }] }));
    assert.equal(Buffer.byteLength(pad(limit)), limit);
    assert.equal((await ask(s.port, { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" }, body: pad(limit) })).status, 200);
    const refused = await ask(s.port, { method: "POST", path: "/v1/chat/completions", headers: { "content-type": "application/json" }, body: pad(limit + 1) });
    assert.equal(refused.status, 413);
    assert.match(refused.json.error.message, /larger than the stand-in model takes/);
  } finally {
    await s.close();
  }
});

// ---- the address a customer gives, and how a host reaches the stand-in ----

test("the address the trial gives out is one the control plane takes for a customer's key, and that no one owns", () => {
  assert.equal(checkBaseUrl(TRIAL_MODEL_ADDRESS), TRIAL_MODEL_ADDRESS, "it is a public https address as far as the control plane's own check can tell");
  assert.deepEqual(checkModelKeyInput({ provider: "openai-compatible", model: "stand-in", baseUrl: TRIAL_MODEL_ADDRESS, key: "any-key-12345" }), { provider: "openai-compatible", model: "stand-in", baseUrl: TRIAL_MODEL_ADDRESS, key: "any-key-12345" });
  const host = new URL(TRIAL_MODEL_ADDRESS).hostname;
  assert.match(host, /\.example$/, "`.example` is reserved: it never resolves, so a key sent there by mistake goes nowhere");
});

test("a host of a hosting-only trial is told to preload the reroute, keeping the options it already had, and to send the stand-in's address to the stand-in", () => {
  const env = standInEnvironment("http://127.0.0.1:7830/v1", { NODE_OPTIONS: "--max-old-space-size=512" });
  assert.deepEqual(env, {
    NODE_OPTIONS: `--max-old-space-size=512 --require ${PRELOAD}`,
    CURULE_TRIAL_REROUTE_FROM: "https://stand-in.example/",
    CURULE_TRIAL_REROUTE_TO: "http://127.0.0.1:7830/",
  });
  assert.equal(`${new URL(TRIAL_MODEL_ADDRESS).origin}/`, env.CURULE_TRIAL_REROUTE_FROM, "what the customer is told to give is what is sent on");
  assert.equal(standInEnvironment("http://127.0.0.1:9000/v1", {}).NODE_OPTIONS, `--require ${PRELOAD}`);
  assert.equal(standInEnvironment("http://127.0.0.1:9000/v1", { NODE_OPTIONS: "  " }).NODE_OPTIONS, `--require ${PRELOAD}`);
  assert.equal(standInEnvironment("http://127.0.0.1:9000/v1", {}, "/tmp/a folder/trial-reroute.js").NODE_OPTIONS, '--require "/tmp/a folder/trial-reroute.js"', "NODE_OPTIONS splits on spaces, so a path with one is quoted");
  assert.ok(fs.existsSync(PRELOAD), "the preload is in the build, where the trial looks for it");
});

test("calls to the stand-in's address are sent to its real one, and a call to anything else goes where it was going", async () => {
  const seen: Array<[unknown, unknown]> = [];
  const real = (async (input: unknown, init?: unknown) => {
    seen.push([input, init]);
    return new Response("ok");
  }) as typeof fetch;
  const f = rerouteFetch(real, "https://stand-in.example/", "http://127.0.0.1:7830/");
  await f("https://stand-in.example/v1/chat/completions", { method: "POST", body: "{}" });
  await f(new URL("https://stand-in.example/v1/models?limit=2"));
  await f(new Request("https://stand-in.example/v1/models", { method: "POST", headers: { "x-key": "k" }, body: "{}" }));
  assert.deepEqual(seen[0], ["http://127.0.0.1:7830/v1/chat/completions", { method: "POST", body: "{}" }], "the path, the method and the body go on");
  assert.deepEqual(seen[1], ["http://127.0.0.1:7830/v1/models?limit=2", undefined], "and so does the query");
  const moved = seen[2]![0] as Request;
  assert.deepEqual([moved.url, moved.method, moved.headers.get("x-key")], ["http://127.0.0.1:7830/v1/models", "POST", "k"], "a request that was already made is made again at the new address");

  const untouched = [
    "https://api.openai.com/v1/models",
    "https://openrouter.ai/api/v1/chat/completions",
    "https://stand-in.example.evil.test/v1/models",
    "https://stand-in.example@evil.test/v1/models",
    "https://evil.test/redirect?to=https://stand-in.example/v1/models",
    "https://not-stand-in.example/v1/models",
    "http://stand-in.example/v1/models",
    "https://stand-in.example:8443/v1/models",
  ];
  for (const url of untouched) await f(url);
  assert.deepEqual(
    seen.slice(3).map(([input]) => input),
    untouched,
    "only that one address is answered here: a real provider's address and key, or a look-alike, are not touched",
  );
  const other = new Request("https://api.openai.com/v1/models");
  await f(other);
  assert.equal(seen.at(-1)![0], other, "a request for another address is the same request");
});

const run = (args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string }> =>
  new Promise((resolve) => {
    execFile(process.execPath, args, { env: { ...process.env, ...env }, timeout: 30_000 }, (error, stdout, stderr) => resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}`.trim() }));
  });

test("the preload, in a process of its own: with both addresses it sends the stand-in's to the stand-in, and without them it changes nothing", async () => {
  const s = await standInServer();
  try {
    const script = "fetch('https://stand-in.example/v1/models').then((r) => r.json()).then((j) => console.log(JSON.stringify(j.data.map((m) => m.id))))";
    const env = standInEnvironment(s.url, {});
    const answered = await run(["--require", PRELOAD, "-e", script], { NODE_OPTIONS: "", CURULE_TRIAL_REROUTE_FROM: env.CURULE_TRIAL_REROUTE_FROM!, CURULE_TRIAL_REROUTE_TO: env.CURULE_TRIAL_REROUTE_TO! });
    assert.deepEqual([answered.code, answered.out], [0, '["stand-in-1"]']);
    // The way a host is given it: through NODE_OPTIONS, which every process the host starts inherits.
    const inherited = await run(["-e", script], env);
    assert.deepEqual([inherited.code, inherited.out], [0, '["stand-in-1"]']);

    for (const set of [{}, { CURULE_TRIAL_REROUTE_FROM: "https://stand-in.example/" }, { CURULE_TRIAL_REROUTE_TO: `http://127.0.0.1:${s.port}/` }]) {
      const idle = await run(["--require", PRELOAD, "-e", "console.log(fetch.name)"], { NODE_OPTIONS: "", CURULE_TRIAL_REROUTE_FROM: "", CURULE_TRIAL_REROUTE_TO: "", ...set });
      assert.deepEqual([idle.code, idle.out], [0, "fetch"], `with ${JSON.stringify(set)} the preload leaves fetch as it was`);
    }
  } finally {
    await s.close();
  }
});

test("the hosts of a hosting-only trial are started with what reaches the stand-in, on top of what the control plane gives them, and stop and resume as any host does", async () => {
  const calls: string[] = [];
  const specs: WorkspaceSpec[] = [];
  const inner = {
    kind: "local-process",
    async create(spec: WorkspaceSpec): Promise<ProvisionedWorkspace> {
      specs.push(spec);
      return { handle: "h1", upstream: { host: "127.0.0.1", port: 1 } };
    },
    async suspend(handle: string) { calls.push(`suspend ${handle}`); },
    async resume(handle: string): Promise<ProvisionedWorkspace> { calls.push(`resume ${handle}`); return { handle, upstream: { host: "127.0.0.1", port: 2 } }; },
    async destroy(handle: string, options?: { keepData?: boolean }) { calls.push(`destroy ${handle} ${JSON.stringify(options)}`); },
    async status(handle: string) { calls.push(`status ${handle}`); return "running" as const; },
    async stopAll() { calls.push("stopAll"); },
  } satisfies Provisioner & { stopAll(): Promise<void> };
  const hosts = new StandInHosts(inner, { NODE_OPTIONS: "--require x.js", CURULE_TRIAL_REROUTE_FROM: "https://stand-in.example/" });
  assert.equal(hosts.kind, "local-process");
  const spec = { workspaceId: "ws_1", accountId: "a", slug: "s", plan: "team", operatorToken: "t", limits: { cpus: 1, memoryMb: 1, pids: 1 }, env: { OPERATOR_ADDITION: "kept" }, model: { provider: "openai-compatible" as const, name: "m", baseUrl: TRIAL_MODEL_ADDRESS, key: "k" } };
  assert.deepEqual(await hosts.create(spec), { handle: "h1", upstream: { host: "127.0.0.1", port: 1 } });
  assert.deepEqual(specs[0], { ...spec, env: { OPERATOR_ADDITION: "kept", NODE_OPTIONS: "--require x.js", CURULE_TRIAL_REROUTE_FROM: "https://stand-in.example/" } }, "the spec is the control plane's, with the trial's variables added to its environment");
  assert.equal((spec.env as Record<string, string>).NODE_OPTIONS, undefined, "and the control plane's own spec is not changed");
  await hosts.create({ ...spec, env: undefined } as WorkspaceSpec);
  assert.deepEqual(specs[1]!.env, { NODE_OPTIONS: "--require x.js", CURULE_TRIAL_REROUTE_FROM: "https://stand-in.example/" }, "a spec with no environment gets just the trial's");
  await hosts.suspend("h1");
  assert.deepEqual(await hosts.resume("h1"), { handle: "h1", upstream: { host: "127.0.0.1", port: 2 } });
  await hosts.destroy("h1", { keepData: true });
  assert.equal(await hosts.status("h1"), "running");
  await hosts.stopAll();
  assert.deepEqual(calls, ["suspend h1", "resume h1", 'destroy h1 {"keepData":true}', "status h1", "stopAll"]);
});

// ---- what a person is told ----

function fakeTrial(over: Partial<RunningTrial> = {}): RunningTrial {
  return { appUrl: "http://localhost:7500", ownerUrl: "http://127.0.0.1:7501", ownerToken: "owner-token-abc", payUrl: "http://localhost:7502", dir: "/tmp/curule-trial-x", outboxPath: "/tmp/curule-trial-x/control/outbox.jsonl", notes: [], standIn: new StandInModel(), hostingOnly: true, modelUrl: "http://127.0.0.1:7510/v1", control: undefined as never, stop: async () => undefined, ...over };
}

test("what a hosting-only trial says when it is up: that there is no gateway, where the key is set, what to give the key form, and where the stand-in is", () => {
  assert.deepEqual(describeTrial(fakeTrial(), trialPorts(7500), false), [
    "Curule Cloud, on this machine. A trial: nothing here is real.",
    "",
    "  the app           http://localhost:7500",
    "  a workspace       http://<its name>.localhost:7500 (opened from the account page; a browser finds *.localhost on this machine by itself)",
    "  the plans         hosting only: the customer brings a model key, and there is no balance, usage or top-up",
    "  payment           http://localhost:7502, a page of the trial's own: nothing is charged and no card is asked for",
    "  mail              printed here as it is written, and kept in /tmp/curule-trial-x/control/outbox.jsonl",
    "  models            a stand-in that answers every call with one sentence and uses no tool. There is no gateway: a workspace has no model until its key is",
    "                    set on the account page. Choose OpenAI-compatible, give the address https://stand-in.example/v1, any model name and any key of 8 characters",
    "                    or more. That address is answered on this machine and no call leaves it; a real provider's address and key work too",
    "  the owner's API   http://127.0.0.1:7501, with the token owner-token-abc",
    "  the stand-in      http://127.0.0.1:7510/v1, on this machine only; it takes any key",
    "  everything is in  /tmp/curule-trial-x (removed when the trial stops)",
    "",
    "Open the app, create an account and follow the link that is printed here. Ctrl+C stops it, and the workspaces it started.",
  ]);
  const text = describeTrial(fakeTrial({ notes: ["no licence key"] }), trialPorts(7500), true).join("\n");
  assert.match(text, /\(kept: start the trial on it again and the accounts and workspaces are there\)/);
  assert.match(text, /note: no licence key/);
  assert.doesNotMatch(describeTrial(fakeTrial(), trialPorts(7500), false).join("\n"), /gateway +http|balance and usage are real/, "nothing of the other trial's gateway is said");
});

// ---- a trial that is started on this machine ----

async function freePorts(n: number): Promise<number[]> {
  const servers = await Promise.all(Array.from({ length: n }, () => new Promise<net.Server>((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => resolve(s)); })));
  const ports = servers.map((s) => (s.address() as net.AddressInfo).port);
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  return ports;
}
const trialPortsOn = async () => {
  const [app, owner, pay, gatewayTenant, gatewayAdmin] = await freePorts(5);
  return { app: app!, owner: owner!, pay: pay!, gatewayTenant: gatewayTenant!, gatewayAdmin: gatewayAdmin! };
};
const canListen = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
const tmp = (what: string): string => fs.mkdtempSync(path.join(os.tmpdir(), `trial-${what}-`));
/** A start that must be refused. One that is not is stopped, so that a test that fails does not leave a trial listening. */
async function refuses(options: TrialOptions, said: RegExp): Promise<void> {
  let started: RunningTrial | undefined;
  try {
    started = await startTrial(options);
  } catch (err) {
    assert.match((err as Error).message, said);
    return;
  }
  await started.stop(0);
  assert.fail("the trial started");
}

test("a hosting-only trial sells hosting only, has no gateway, and answers as a stand-in model on the gateway's port, which is gone when it stops", async () => {
  const dir = tmp("hosting");
  const ports = await trialPortsOn();
  const trial = await startTrial({ dir, ports, hostingOnly: true, reconcileMs: 600_000 });
  try {
    assert.equal(trial.hostingOnly, true);
    assert.deepEqual([trial.gateway, trial.gatewayUrl], [undefined, undefined], "no gateway is run, and none is named");
    assert.equal(trial.modelUrl, `http://127.0.0.1:${ports.gatewayTenant}/v1`, "the stand-in is where the gateway's workspace port would be");

    const plans = await ask(ports.app, { host: `localhost:${ports.app}`, path: "/api/plans" });
    assert.equal(plans.status, 200);
    assert.equal(plans.json.topups, null, "no credit is on offer");
    assert.deepEqual(plans.json.plans.map((p: { id: string; byok?: boolean; includedUsageMicros: number; tiers?: string[] }) => [p.id, p.byok, p.includedUsageMicros, p.tiers]), [["team", true, 0, undefined], ["business", true, 0, undefined]]);

    assert.equal(fs.existsSync(path.join(dir, "gateway")), false, "there is no gateway folder: nothing of a ledger or a price table");
    const control = parseYaml(fs.readFileSync(path.join(dir, "control", "control.yaml"), "utf8")) as Record<string, unknown>;
    assert.equal("gateway" in control, false, "the control plane is configured as the owner's is: no gateway section");
    assert.deepEqual(parseYaml(fs.readFileSync(path.join(dir, "control", "plans.yaml"), "utf8")), TRIAL_HOSTING_PLANS);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "trial.json"), "utf8")).hostingOnly, true, "the folder remembers which kind of trial it is for");
    assert.ok(trial.notes.every((n) => !/gateway/.test(n)), "and the configuration has no word about a gateway that nothing uses");

    const asked = await ask(ports.gatewayTenant, { method: "POST", path: "/v1/chat/completions", json: completion({ stream: true }) });
    assert.equal(asked.status, 200);
    assert.equal(trial.standIn.calls, 1, "a call reaches the trial's stand-in model");
  } finally {
    await trial.stop(0);
  }
  assert.equal(await canListen(ports.gatewayTenant), true, "the stand-in is gone with the trial");
  assert.equal(await canListen(ports.pay), true);
  assert.equal(await canListen(ports.app), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a workspace of a hosting-only trial is made with the environment that reaches the stand-in, and one of the other trial is not", async () => {
  // A host that does nothing but answer its health check, which is all the control plane waits for.
  const quick = [process.execPath, "-e", "require('node:http').createServer((_q, r) => r.end('ok')).listen(Number(process.env.MESH_PORT), '127.0.0.1')"];
  const made = async (hostingOnly: boolean): Promise<Record<string, string>> => {
    const dir = tmp(hostingOnly ? "env-hosting" : "env-usage");
    const ports = await trialPortsOn();
    const trial = await startTrial({ dir, ports, hostingOnly, hostCommand: quick, reconcileMs: 600_000 });
    try {
      const app = (method: string, at: string, json?: unknown, cookie = "") => ask(ports.app, { host: `localhost:${ports.app}`, method, path: at, ...(json !== undefined ? { json } : {}), headers: { ...(method !== "GET" ? { origin: trial.appUrl } : {}), ...(cookie ? { cookie } : {}) } });
      const email = "ada@example.com";
      assert.equal((await app("POST", "/api/signup", { email, password: "correct horse battery staple" })).status, 202);
      const mails = (): Array<{ to: string; kind: string; text: string }> => fs.readFileSync(trial.outboxPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const link = /https?:\/\/\S+/.exec(mails().find((m) => m.to === email && m.kind === "verify")!.text)![0];
      const verified = await app("POST", "/api/verify", { token: new URL(link).searchParams.get("token")! });
      const cookie = String(verified.headers["set-cookie"]![0]).split(";")[0]!;
      const checkout = await app("POST", "/api/checkout", { purpose: "subscription", plan: "team" }, cookie);
      const url = new URL(checkout.json.url as string);
      const pressed = await ask(ports.pay, { method: "POST", path: "/pay", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `ref=${encodeURIComponent(url.searchParams.get("ref")!)}` });
      assert.equal(pressed.status, 303);
      const workspace = await app("POST", "/api/workspaces", { name: "Research" }, cookie);
      assert.equal(workspace.status, 201, workspace.body);
      const file = path.join(dir, "workspaces", workspace.json.workspace.workspaceId, ".provision", "env.json");
      for (let i = 0; i < 400 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 10));
      // The workspace is waited for until it runs: a trial stopped while its host is still being waited for is waited on for a minute.
      for (let i = 0; i < 1000; i++) {
        const me = await app("GET", "/api/me", undefined, cookie);
        if (me.json.account.workspaces[0].status === "running") break;
        await new Promise((r) => setTimeout(r, 20));
      }
      return (JSON.parse(fs.readFileSync(file, "utf8")) as { env: Record<string, string> }).env;
    } finally {
      await trial.stop(0);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  const hosting = await made(true);
  const kept = (process.env.NODE_OPTIONS ?? "").trim();
  assert.equal(hosting.NODE_OPTIONS, `${kept === "" ? "" : `${kept} `}--require ${PRELOAD}`, "the preload is added to the options the trial itself was given");
  assert.equal(hosting.CURULE_TRIAL_REROUTE_FROM, "https://stand-in.example/");
  assert.match(hosting.CURULE_TRIAL_REROUTE_TO!, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal(hosting.CURULE_GATEWAY_URL, undefined, "and no gateway: a workspace of a plan that sells hosting is given none");
  assert.ok(hosting.MESH_API_TOKEN && hosting.MESH_HOME, "what makes the workspace itself is still there");
  const usage = await made(false);
  assert.deepEqual(Object.keys(usage).filter((k) => /^CURULE_TRIAL_|^NODE_OPTIONS$/.test(k)), [], "a workspace of the other trial is not told about a stand-in it has no use for");
  assert.match(usage.CURULE_GATEWAY_URL!, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
});

test("a folder that is kept belongs to one kind of trial, and a start of the other kind on it is refused, saying how to go on", async () => {
  const dir = tmp("kinds");
  try {
    const hosting = await startTrial({ dir, ports: await trialPortsOn(), hostingOnly: true });
    const secret = hosting.ownerToken;
    await hosting.stop(0);
    await refuses({ dir, ports: await trialPortsOn() }, /was made by a trial that sells hosting only: start it with --hosting-only, or use another folder/);
    const again = await startTrial({ dir, ports: await trialPortsOn(), hostingOnly: true });
    assert.equal(again.ownerToken, secret, "the same kind finds what it made");
    await again.stop(0);

    const other = tmp("kinds-usage");
    try {
      const usage = await startTrial({ dir: other, ports: await trialPortsOn() });
      await usage.stop(0);
      assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(other, "trial.json"), "utf8"))).sort(), ["gatewayAdminToken", "ownerToken", "secret"], "a trial that sells usage writes what it always wrote");
      await refuses({ dir: other, ports: await trialPortsOn(), hostingOnly: true }, /was made by a trial that sells model usage: start it without --hosting-only, or use another folder/);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a hosting-only trial whose stand-in cannot have its port says so, and leaves nothing listening", async () => {
  const ports = await trialPortsOn();
  const taken = net.createServer();
  await new Promise<void>((resolve) => taken.listen(ports.gatewayTenant, "127.0.0.1", resolve));
  const dir = tmp("model-taken");
  try {
    await refuses({ dir, ports, hostingOnly: true }, /EADDRINUSE/);
    for (const port of [ports.app, ports.owner, ports.pay]) assert.equal(await canListen(port), true, `${port} is free`);
    // A start in which the control plane cannot be configured gives the stand-in's port back too.
    const bad = tmp("model-bad-pages");
    try {
      const free = await trialPortsOn();
      await refuses({ dir: bad, ports: free, hostingOnly: true, pagesDir: path.join(bad, "not-a-folder") }, /is not a directory/);
      assert.equal(await canListen(free.gatewayTenant), true, "the stand-in is not left running by a trial that did not start");
    } finally {
      fs.rmSync(bad, { recursive: true, force: true });
    }
  } finally {
    await new Promise<void>((resolve) => taken.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the command ----

function io(): Io & { stdout: string[]; stderr: string[]; signals: EventEmitter } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (l) => void stdout.push(l), err: (l) => void stderr.push(l), signals: new EventEmitter() };
}
const unused = (async () => {
  throw new Error("this test starts nothing else");
}) as never;

test("the usage names --hosting-only, and the trial command passes it on only when it is given", async () => {
  assert.match(USAGE, /trial \[--port <n>\] \[--dir <folder>\] \[--hosting-only\]\s+the whole service on this machine, with nothing real behind it/);
  assert.match(USAGE, /--hosting-only sells hosting and no model usage, and the customer brings a model key/);
  const seen: Array<Record<string, unknown>> = [];
  for (const args of [["--hosting-only"], ["--port", "9100", "--hosting-only", "--dir", "/tmp/k"], ["--port=9100"], []]) {
    const out = io();
    const code = main(["trial", ...args], {}, out, unused, unused, (async (options: Record<string, unknown>) => {
      seen.push(options);
      return options.hostingOnly === true ? fakeTrial() : fakeTrial({ hostingOnly: false, gatewayUrl: "http://127.0.0.1:7510" });
    }) as never);
    for (let i = 0; i < 500 && out.signals.listenerCount("SIGTERM") === 0; i++) await new Promise((r) => setTimeout(r, 10));
    out.signals.emit("SIGINT");
    assert.equal(await code, 0, args.join(" "));
    assert.match(out.stdout.join("\n"), args.includes("--hosting-only") ? /the stand-in +http:\/\/127\.0\.0\.1:7510\/v1/ : /the gateway/, args.join(" "));
  }
  assert.deepEqual(seen.map((o) => [o.hostingOnly, (o.ports as { app: number }).app, o.dir]), [[true, 7500, undefined], [true, 9100, "/tmp/k"], [undefined, 9100, undefined], [undefined, 7500, undefined]]);
});
