import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { running } from "./support";
import { site } from "./web-support";

const KEY = "sk-ant-api03-the-customers-own-key-0002";
const BODY = { provider: "anthropic", model: "claude-sonnet-4-5", key: KEY };

async function signedIn() {
  const r = await running({ hostingOnly: true });
  const s = site(r.p);
  const path = `/api/workspaces/${r.workspaceId}/model-key`;
  return { ...r, s, path, set: (json: unknown, session = r.ada.sessionToken) => s.call("POST", path, { json, session }), remove: (session = r.ada.sessionToken) => s.call("POST", `${path}/delete`, { session }) };
}

test("a customer stores a key and is told which provider and model it is for, and the key is in no response, header, log line or event", async () => {
  const t = await signedIn();
  const set = await t.set(BODY);
  assert.equal(set.status, 200);
  assert.deepEqual(set.json.workspace.models, { source: "own", key: { provider: "anthropic", model: "claude-sonnet-4-5", setAt: new Date(t.p.clock.now).toISOString() } });
  const seen = [set.body, JSON.stringify(set.headers)];
  for (const [method, path] of [["GET", "/api/me"], ["GET", "/api/session"], ["GET", "/api/plans"]] as const) seen.push((await t.s.call(method, path, { session: t.ada.sessionToken })).body);
  seen.push(JSON.stringify(t.s.logs), JSON.stringify(t.p.store.entries));
  for (const text of seen) assert.ok(!text.includes(KEY), "the key is somewhere it must not be");
  assert.ok(t.s.logs.some((l) => l.msg === "a model key was set" && l.workspaceId === t.workspaceId), "the change itself is logged, as a fact and without the key");
});

test("a refused key says why, never repeats the key, and keeps nothing", async () => {
  const t = await signedIn();
  for (const bad of [{ ...BODY, provider: "other" }, { ...BODY, key: "short" }, { ...BODY, model: "" }, { ...BODY, baseUrl: "https://example.com/v1" }, { provider: "openai-compatible", model: "m", key: KEY, baseUrl: "http://api.example.com/v1" }, { provider: "openai-compatible", model: "m", key: KEY, baseUrl: "https://127.0.0.1/v1" }]) {
    const r = await t.set(bad);
    assert.equal(r.status, 400, JSON.stringify(bad).replace(KEY, "KEY"));
    assert.ok(!r.body.includes(KEY));
  }
  assert.ok(!fs.existsSync(t.p.keysFile));
  assert.equal(t.p.provisioner.ops("create").length, 1);
});

test("a change must be signed in, from the app's own pages, and in JSON", async () => {
  const t = await signedIn();
  assert.equal((await t.s.call("POST", t.path, { json: BODY })).status, 401);
  assert.equal((await t.s.call("POST", t.path, { json: BODY, session: t.ada.sessionToken, origin: "https://evil.example" })).status, 403);
  assert.equal((await t.s.call("POST", t.path, { json: BODY, session: t.ada.sessionToken, origin: null })).status, 403);
  assert.equal((await t.s.call("POST", t.path, { raw: JSON.stringify(BODY), type: "text/plain", session: t.ada.sessionToken })).status, 415);
  assert.equal((await t.s.call("GET", t.path, { session: t.ada.sessionToken })).status, 405, "there is no way to read a key back: the path answers no GET");
  assert.equal((await t.s.call("GET", `${t.path}/key`, { session: t.ada.sessionToken })).status, 404);
  assert.equal(t.p.provisioner.ops("create").length, 1);
});

test("another customer cannot set, replace or delete a key on a workspace that is not theirs, and is told only that it is not found", async () => {
  const t = await signedIn();
  await t.set(BODY);
  const eve = await t.p.account("eve@example.com");
  for (const reply of [await t.set({ ...BODY, key: "sk-ant-eves-own-key-should-not-be-kept" }, eve.sessionToken), await t.remove(eve.sessionToken)]) {
    assert.deepEqual([reply.status, reply.json.error.code], [404, "not_found"]);
  }
  assert.equal(t.p.log.state.workspaces.get(t.workspaceId)!.modelKey!.model, "claude-sonnet-4-5", "the owner's key is as it was");
  assert.ok(!fs.readFileSync(t.p.keysFile, "utf8").includes("eves"));
  assert.equal(t.p.provisioner.ops("create").length, 2, "only the owner's own change started a host");
  assert.equal((await t.s.call("POST", `/api/workspaces/ws_nothing/model-key`, { json: BODY, session: t.ada.sessionToken })).status, 404);
});

test("a key is replaced and deleted through the API, and what the customer sees follows", async () => {
  const t = await signedIn();
  await t.set(BODY);
  const replaced = await t.set({ provider: "openai-compatible", model: "openai/gpt-4o", baseUrl: "https://openrouter.ai/api/v1", key: "sk-or-v1-the-second-key" });
  assert.deepEqual(replaced.json.workspace.models.key.baseUrl, "https://openrouter.ai/api/v1");
  const gone = await t.remove();
  assert.equal(gone.status, 200);
  assert.deepEqual(gone.json.workspace.models, { source: "own", key: null });
  assert.equal((await t.remove()).status, 200, "deleting what is not there is not an error");
  assert.ok(!JSON.stringify([gone.body, t.s.logs]).includes("sk-or-v1"));
});

test("changes are rate limited per session and per account, because each one starts the host again", async () => {
  const t = await signedIn();
  for (let i = 0; i < 10; i++) assert.equal((await t.set({ ...BODY, key: `${KEY}-${i}` })).status, 200, `change ${i + 1}`);
  const over = await t.set(BODY);
  assert.deepEqual([over.status, over.json.error.code], [429, "rate_limited"]);
  assert.ok(over.headers["retry-after"]);
  assert.ok(!over.body.includes(KEY));
  assert.equal(t.p.provisioner.ops("create").length, 11);
  assert.equal((await t.remove()).status, 429, "deleting counts too");
  // A new session is not a new allowance: the account has its own, larger limit, which two sessions' worth reaches.
  const signIn = async (): Promise<string> => {
    const reply = await t.s.call("POST", "/api/login", { json: { email: "ada@example.com", password: "correct horse battery staple" }, origin: null });
    return /=([^;]+);/.exec(String(reply.headers["set-cookie"]))![1]!;
  };
  const tries = async (session: string): Promise<number> => {
    let accepted = 0;
    for (let i = 0; i < 12; i++) if ((await t.set({ ...BODY, key: `${KEY}-${session.slice(0, 4)}-${i}` }, session)).status === 200) accepted++;
    return accepted;
  };
  assert.equal(await tries(await signIn()), 10, "a second session has its own ten (a refused change is not counted against the account)");
  const third = await t.set(BODY, await signIn());
  assert.deepEqual([third.status, third.json.error.code], [429, "rate_limited"], "and the account's twenty are then used up, for a third session as well");
});

test("a plan that supplies the models has no key to set, and the plans list says which plans bring their own and offers no top-up when none sells usage", async () => {
  const supplied = await running();
  const s = site(supplied.p);
  const r = await s.call("POST", `/api/workspaces/${supplied.workspaceId}/model-key`, { json: BODY, session: supplied.ada.sessionToken });
  assert.deepEqual([r.status, r.json.error.code], [409, "not_byok"]);
  assert.equal(supplied.p.plane.view(supplied.p.log.state.accounts.get(supplied.ada.accountId)!).workspaces[0]!.models, undefined);
  const plans = await s.call("GET", "/api/plans");
  assert.ok(plans.json.topups && plans.json.plans.every((p: { byok?: true }) => p.byok === undefined));
  const t = await signedIn();
  const hosting = await t.s.call("GET", "/api/plans");
  assert.equal(hosting.json.topups, null);
  assert.deepEqual(hosting.json.plans.map((p: { id: string; byok?: boolean }) => [p.id, p.byok]), [["hosting", true]]);
  const me = await t.s.call("GET", "/api/me", { session: t.ada.sessionToken });
  assert.equal(me.json.balance, null, "no balance is kept");
  const usage = await t.s.call("GET", "/api/usage", { session: t.ada.sessionToken });
  assert.deepEqual([usage.status, usage.json.error.code], [404, "no_usage"]);
  assert.match(usage.json.error.message, /you pay your model provider directly/);
});
