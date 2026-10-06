import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { ServiceError, parseCatalogue } from "../../packages/cloud/src/index";
import { HOSTING_CATALOGUE, running, type Plane } from "./support";

const KEY = "sk-ant-api03-the-customers-own-key-0001";
const ANTHROPIC = { provider: "anthropic" as const, model: "claude-sonnet-4-5", key: KEY };
const refusal = async (promise: Promise<unknown>): Promise<ServiceError> => {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof ServiceError, String(err));
    return err;
  }
  throw new Error("it was accepted");
};
const hosting = () => running({ hostingOnly: true });
const creates = (p: Plane) => p.provisioner.ops("create");

// ---- the plan ----

test("a plan that is hosting only sells no usage: no included usage, no tiers, and no top-ups at all when every plan is like it", () => {
  const c = parseCatalogue(HOSTING_CATALOGUE);
  assert.equal(c.sellsUsage, false);
  const plan = c.plan("hosting")!;
  assert.deepEqual([plan.byok, plan.includedUsageMicros, plan.tiers, plan.priceMinor], [true, 0, undefined, 4_900]);
  assert.deepEqual(c.topups, { optionsMinor: [], minimumMinor: 0, maximumMinor: 0, usageMicrosPerMinor: 0 });
  const mixed = parseCatalogue({ ...HOSTING_CATALOGUE, plans: { ...HOSTING_CATALOGUE.plans, team: { title: "Team", licence_plan: "team", price_minor: 14_900, period: "month", included_usage: 20, workspaces: 1 } }, topups: { options_minor: [1_000], minimum_minor: 500, maximum_minor: 5_000, usage_micros_per_minor: 10_000 } });
  assert.equal(mixed.sellsUsage, true, "one plan that sells usage is enough for the gateway to be needed");
});

test("a plan that is hosting only cannot also promise usage, tiers or top-ups, and every mistake is said at once", () => {
  const plan = HOSTING_CATALOGUE.plans.hosting;
  const refused = (raw: unknown): string => {
    try {
      parseCatalogue(raw);
    } catch (err) {
      return (err as Error).message;
    }
    throw new Error("it was accepted");
  };
  const message = refused({ currency: "USD", plans: { hosting: { ...plan, included_usage: 5, tiers: ["fast"], default_tier: "fast" } } });
  assert.match(message, /plans\.hosting\.included_usage cannot be set on a byok plan/);
  assert.match(message, /plans\.hosting\.tiers cannot be set/);
  assert.match(message, /plans\.hosting\.default_tier cannot be set/);
  assert.match(refused({ currency: "USD", plans: { hosting: { ...plan, byok: "yes" } } }), /plans\.hosting\.byok must be true or false/);
  assert.match(refused({ ...HOSTING_CATALOGUE, topups: { options_minor: [1_000], minimum_minor: 500, maximum_minor: 5_000, usage_micros_per_minor: 1 } }), /topups cannot be set when every plan is byok/);
  assert.equal(parseCatalogue({ currency: "USD", plans: { hosting: { ...plan, included_usage: 0 } } }).plan("hosting")!.includedUsageMicros, 0, "an explicit zero says what is true");
  assert.match(refused({ currency: "USD", plans: { team: { title: "Team", licence_plan: "team", price_minor: 1, period: "month", workspaces: 1 } } }), /topups must be a mapping/, "a plan that does sell usage still needs its top-ups");
});

// ---- starting a workspace ----

test("a workspace of a hosting-only plan makes no gateway key and is started with no gateway, and a customer's key can come after", async () => {
  const { p, workspaceId, workspace } = await hosting();
  const spec = creates(p)[0]!.spec!;
  assert.equal(spec.gateway, undefined, "no gateway address and no virtual key");
  assert.equal(spec.model, undefined, "and no key of the customer's until they set one");
  assert.equal(spec.env, undefined, "no tier: a tier is the gateway's");
  assert.equal(spec.plan, "hosting");
  assert.equal(workspace().gatewayKeyId, undefined);
  assert.equal(workspace().status, "running");
  assert.deepEqual(p.store.entries.filter((e) => e.type === "workspace.provisioned").map((e) => "gatewayKeyId" in e), [false]);
  assert.equal(p.plane.view(p.log.state.accounts.get(workspace().accountId)!).workspaces[0]!.models?.key, null);
  assert.equal(workspaceId, workspace().workspaceId);
});

test("with no gateway there is no balance, no usage report and no top-up, and a top-up payment that arrives is set aside for the operator", async () => {
  const { p, ada } = await hosting();
  assert.equal(await p.plane.balance(ada.accountId), null);
  assert.equal((await refusal(p.plane.usage(ada.accountId))).code, "no_usage");
  assert.equal((await refusal(p.plane.startCheckout(ada.accountId, { purpose: "topup", amountMinor: 1_000 }))).code, "no_topups");
  const applied = await p.plane.billing.apply({ type: "payment.succeeded", ref: "pi_topup", purpose: "topup", accountId: ada.accountId, amountMinor: 1_000, currency: "USD", at: new Date(p.clock.now).toISOString() });
  assert.deepEqual([applied.applied, applied.note], [false, "no-usage"]);
  assert.match(p.plane.unmatched()[0]!.note!, /sells no model usage/);
  assert.equal((await p.plane.margin()).usage.calls, 0);
  const sub = await p.plane.billing.apply({ type: "payment.succeeded", ref: "pi_period", purpose: "subscription", accountId: ada.accountId, plan: "hosting", amountMinor: 4_900, currency: "USD", at: new Date(p.clock.now).toISOString() });
  assert.equal(sub.applied, true, "the plan's own payment is applied with no balance to set");
});

// ---- the customer's key ----

test("a key is stored, the host is started again with it, and neither the log nor the view holds it", async () => {
  const { p, ada, workspaceId, workspace } = await hosting();
  await p.plane.workspaces.setModelKey(ada.accountId, workspaceId, ANTHROPIC);
  const made = creates(p);
  assert.equal(made.length, 2, "the host was made again, keeping its data");
  assert.deepEqual(p.provisioner.ops("destroy")[0]!.options, { keepData: true });
  assert.deepEqual(made[1]!.spec!.model, { provider: "anthropic", name: "claude-sonnet-4-5", key: KEY });
  assert.equal(made[1]!.spec!.gateway, undefined);
  assert.equal(workspace().status, "running");
  const everywhere = JSON.stringify([p.store.entries, p.plane.view(p.log.state.accounts.get(ada.accountId)!), workspace()]);
  assert.ok(!everywhere.includes(KEY), "the key is in the log, a view or the projection");
  assert.deepEqual(p.plane.view(p.log.state.accounts.get(ada.accountId)!).workspaces[0]!.models, { source: "own", key: { provider: "anthropic", model: "claude-sonnet-4-5", setAt: new Date(p.clock.now).toISOString() } });
  assert.ok(!fs.readFileSync(p.keysFile, "utf8").includes(KEY));
});

test("a key is replaced and then deleted, and the host is started with the new one and then with none", async () => {
  const { p, ada, workspaceId, workspace } = await hosting();
  await p.plane.workspaces.setModelKey(ada.accountId, workspaceId, ANTHROPIC);
  const next = { provider: "openai-compatible" as const, model: "openai/gpt-4o", baseUrl: "https://openrouter.ai/api/v1", key: "sk-or-v1-the-customers-second-key" };
  await p.plane.workspaces.setModelKey(ada.accountId, workspaceId, next);
  assert.deepEqual(creates(p)[2]!.spec!.model, { provider: "openai-compatible", name: "openai/gpt-4o", baseUrl: "https://openrouter.ai/api/v1", key: next.key });
  assert.ok(!fs.readFileSync(p.keysFile, "utf8").includes(KEY), "the first is gone from the file");
  await p.plane.workspaces.setModelKey(ada.accountId, workspaceId, null);
  assert.equal(creates(p)[3]!.spec!.model, undefined);
  assert.equal(workspace().modelKey, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(p.keysFile, "utf8")).keys, {});
  assert.deepEqual(p.store.entries.filter((e) => e.type.startsWith("workspace.model_key")).map((e) => e.type), ["workspace.model_key_set", "workspace.model_key_set", "workspace.model_key_removed"]);
  assert.ok(!JSON.stringify(p.store.entries).includes(next.key));
  await p.plane.workspaces.setModelKey(ada.accountId, workspaceId, null);
  assert.equal(creates(p).length, 4, "deleting what is not there starts nothing");
});

test("another customer's workspace is not found, and a plan that supplies its models has no key of yours to keep", async () => {
  const { p, workspaceId } = await hosting();
  const eve = await p.account("eve@example.com");
  const err = await refusal(p.plane.workspaces.setModelKey(eve.accountId, workspaceId, ANTHROPIC));
  assert.deepEqual([err.status, err.code], [404, "not_found"]);
  assert.equal(p.plane.workspaces.forAccount(eve.accountId).length, 0);
  assert.equal(creates(p).length, 1, "nothing was started");
  assert.ok(!fs.existsSync(p.keysFile), "nothing was kept");
  const supplied = await running();
  assert.equal((await refusal(supplied.p.plane.workspaces.setModelKey(supplied.ada.accountId, supplied.workspaceId, ANTHROPIC))).code, "not_byok");
});

test("a workspace that is still starting takes no key yet, and deleting a workspace deletes its key", async () => {
  const p = await (await import("./support")).plane({ hostingOnly: true });
  const ada = await p.account("ada@example.com");
  await p.subscribe(ada.accountId, "hosting");
  let release!: () => void;
  p.provisioner.hold = new Promise((resolve) => (release = resolve));
  const w = await p.plane.workspaces.create(ada.accountId, "Main");
  assert.equal((await refusal(p.plane.workspaces.setModelKey(ada.accountId, w.workspaceId, ANTHROPIC))).code, "not_ready");
  release();
  await p.plane.workspaces.idle();
  await p.plane.workspaces.setModelKey(ada.accountId, w.workspaceId, ANTHROPIC);
  assert.ok(fs.readFileSync(p.keysFile, "utf8").includes(w.workspaceId));
  await p.plane.workspaces.destroy(w.workspaceId, ada.accountId);
  assert.deepEqual(JSON.parse(fs.readFileSync(p.keysFile, "utf8")).keys, {});
});

test("a workspace the service restarts keeps the customer's key, and is started with it again", async () => {
  const { p, ada, workspaceId, workspace } = await hosting();
  await p.plane.workspaces.setModelKey(ada.accountId, workspaceId, ANTHROPIC);
  await p.plane.workspaces.suspend(workspaceId, "paused", ada.accountId);
  await p.plane.workspaces.setModelKey(ada.accountId, workspaceId, { ...ANTHROPIC, model: "claude-haiku-4-5" });
  assert.equal(workspace().status, "suspended", "a stopped workspace stays stopped");
  assert.equal(creates(p).at(-1)!.spec!.model!.name, "claude-haiku-4-5");
});

test("a workspace moved from a plan that supplies models to one that is hosting only is started with no gateway key, and the old one is revoked", async () => {
  const { p, ada, workspaceId, workspace } = await running({}, "team");
  const first = creates(p)[0]!.spec!.gateway!.key;
  p.plane.o.catalogue.plans();
  // The catalogue is the operator's file: for this test a hosting-only plan is added beside the others.
  const mixed = parseCatalogue({ ...{ currency: "USD", plans: { team: { title: "Team", licence_plan: "team", price_minor: 14_900, period: "month", included_usage: 20, workspaces: 1, tiers: ["fast", "balanced"] }, hosting: HOSTING_CATALOGUE.plans.hosting } }, topups: { options_minor: [1_000], minimum_minor: 500, maximum_minor: 5_000, usage_micros_per_minor: 10_000 } });
  Object.assign(p.plane.workspaces["o"], { catalogue: mixed });
  await p.plane.workspaces.reprovision(workspaceId, "hosting");
  assert.equal(creates(p)[1]!.spec!.gateway, undefined);
  assert.equal(workspace().gatewayKeyId, undefined);
  assert.throws(() => p.gatewayCore.authenticate(`Bearer ${first}`), "the gateway key it had works no more");
  void ada;
});
