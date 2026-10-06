import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelKeyStore, ServiceError, checkBaseUrl, checkModelKeyInput } from "../../packages/cloud/src/index";
import { SECRET } from "./support";

const KEY = "sk-ant-this-is-a-customers-secret-key-0001";
const dir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "curule-model-keys-"));
const refusal = (run: () => unknown): ServiceError => {
  try {
    run();
  } catch (err) {
    assert.ok(err instanceof ServiceError, String(err));
    return err;
  }
  throw new Error("it was accepted");
};

test("a key is kept sealed in a file only its owner can read, and the file holds neither the key nor anything that opens without the service's secret", async () => {
  const d = dir();
  const file = path.join(d, "keys", "model-keys.json");
  const store = new ModelKeyStore({ file, secret: SECRET });
  await store.set("ws_a", { provider: "anthropic", model: "claude-sonnet-4-5", key: KEY });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  const text = fs.readFileSync(file, "utf8");
  assert.ok(!text.includes(KEY) && !text.includes(Buffer.from(KEY).toString("base64")), "the key is in the file as it is");
  assert.deepEqual(store.read("ws_a"), { provider: "anthropic", model: "claude-sonnet-4-5", key: KEY });
  // A second process with the same secret reads it back; one with another secret cannot open it.
  assert.equal(new ModelKeyStore({ file, secret: SECRET }).read("ws_a")!.key, KEY);
  assert.throws(() => new ModelKeyStore({ file, secret: "another-secret-of-at-least-thirty-two-chars" }).read("ws_a"), (err: Error) => /cannot be opened/.test(err.message) && !err.message.includes(KEY));
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["model-keys.json"], "no temporary file is left");
});

test("an entry belongs to its workspace: moved onto another's id it does not open", async () => {
  const file = path.join(dir(), "k.json");
  const store = new ModelKeyStore({ file, secret: SECRET });
  await store.set("ws_a", { provider: "anthropic", model: "m", key: KEY });
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  data.keys.ws_b = data.keys.ws_a;
  fs.writeFileSync(file, JSON.stringify(data));
  const again = new ModelKeyStore({ file, secret: SECRET });
  assert.equal(again.read("ws_a")!.key, KEY);
  assert.throws(() => again.read("ws_b"), /cannot be opened/);
});

test("a key is replaced and deleted, and a failed write leaves what was there", async () => {
  const d = dir();
  const file = path.join(d, "k.json");
  const store = new ModelKeyStore({ file, secret: SECRET });
  assert.equal(store.has("ws_a"), false);
  assert.equal(await store.remove("ws_a"), false);
  await store.set("ws_a", { provider: "openai-compatible", model: "openai/gpt-4o", baseUrl: "https://openrouter.ai/api/v1", key: KEY });
  await store.set("ws_a", { provider: "openai-compatible", model: "openai/gpt-4o", baseUrl: "https://openrouter.ai/api/v1", key: `${KEY}-NEW` });
  assert.equal(store.read("ws_a")!.key, `${KEY}-NEW`);
  assert.ok(!fs.readFileSync(file, "utf8").includes(KEY));
  // The folder cannot be written into: the old key stays, in memory and on disk.
  fs.chmodSync(d, 0o500);
  try {
    if (process.getuid?.() !== 0) {
      await assert.rejects(store.set("ws_a", { provider: "anthropic", model: "m", key: "a-third-key-that-is-never-kept" }));
      assert.equal(store.read("ws_a")!.key, `${KEY}-NEW`);
    }
  } finally {
    fs.chmodSync(d, 0o700);
  }
  assert.equal(await store.remove("ws_a"), true);
  assert.equal(store.has("ws_a"), false);
  assert.equal(new ModelKeyStore({ file, secret: SECRET }).has("ws_a"), false);
});

test("a file that is not this store's is refused and not replaced, and a short service secret is refused", () => {
  const file = path.join(dir(), "k.json");
  fs.writeFileSync(file, "not json");
  assert.throws(() => new ModelKeyStore({ file, secret: SECRET }), /not valid JSON/);
  assert.equal(fs.readFileSync(file, "utf8"), "not json");
  assert.throws(() => new ModelKeyStore({ file: path.join(dir(), "k.json"), secret: "short" }), /at least 32/);
});

test("what a customer types is checked, and a refusal never repeats the key", () => {
  assert.deepEqual(checkModelKeyInput({ provider: "anthropic", model: " claude-sonnet-4-5 ", key: `  ${KEY}\n` }), { provider: "anthropic", model: "claude-sonnet-4-5", key: KEY });
  assert.deepEqual(checkModelKeyInput({ provider: "openai-compatible", model: "openai/gpt-4o", baseUrl: "https://openrouter.ai/api/v1/", key: KEY }), { provider: "openai-compatible", model: "openai/gpt-4o", baseUrl: "https://openrouter.ai/api/v1", key: KEY });
  const bad: Array<[Record<string, unknown>, string]> = [
    [{ provider: "other", model: "m", key: KEY }, "invalid_provider"],
    [{ model: "m", key: KEY }, "invalid_provider"],
    [{ provider: "anthropic", model: "m", key: "" }, "invalid_key"],
    [{ provider: "anthropic", model: "m", key: "short" }, "invalid_key"],
    [{ provider: "anthropic", model: "m", key: "x".repeat(513) }, "invalid_key"],
    [{ provider: "anthropic", model: "m", key: "has a space inside it" }, "invalid_key"],
    [{ provider: "anthropic", model: "m", key: "line\nbreak-in-the-key" }, "invalid_key"],
    [{ provider: "anthropic", model: "m", key: 12345678901 }, "invalid_key"],
    [{ provider: "anthropic", key: KEY }, "invalid_model"],
    [{ provider: "anthropic", model: "has space", key: KEY }, "invalid_model"],
    [{ provider: "anthropic", model: "m", key: KEY, baseUrl: "https://evil.example/v1" }, "invalid_base_url"],
    [{ provider: "openai-compatible", model: "m", key: KEY }, "invalid_base_url"],
  ];
  for (const [body, code] of bad) {
    const err = refusal(() => checkModelKeyInput(body));
    assert.deepEqual([err.status, err.code], [400, code], JSON.stringify(body).replace(KEY, "KEY"));
    assert.ok(!err.message.includes(KEY));
  }
});

test("an address a key is sent to is https, public, and has no sign-in in it", () => {
  assert.equal(checkBaseUrl("https://api.deepseek.com/v1"), "https://api.deepseek.com/v1");
  assert.equal(checkBaseUrl("https://generativelanguage.googleapis.com/v1beta/openai/"), "https://generativelanguage.googleapis.com/v1beta/openai");
  assert.equal(checkBaseUrl("https://1.1.1.1/v1"), "https://1.1.1.1/v1");
  for (const bad of [
    "http://api.openai.com/v1",
    "ftp://api.openai.com/v1",
    "api.openai.com/v1",
    "",
    undefined,
    "https://user:pw@api.openai.com/v1",
    "https://api.openai.com/v1?key=1",
    "https://api.openai.com/v1#x",
    "https://localhost/v1",
    "https://app.localhost/v1",
    "https://intranet/v1",
    "https://db.internal/v1",
    "https://printer.local/v1",
    "https://127.0.0.1/v1",
    "https://[::1]/v1",
    "https://10.0.0.5/v1",
    "https://192.168.1.1/v1",
    "https://172.16.0.1/v1",
    "https://169.254.169.254/latest",
    "https://100.64.0.1/v1",
    "https://[fd00::1]/v1",
    "https://[::ffff:127.0.0.1]/v1",
    "https://0.0.0.0/v1",
    "https://2130706433/v1",
  ]) {
    assert.equal(refusal(() => checkBaseUrl(bad)).code, "invalid_base_url", String(bad));
  }
});
