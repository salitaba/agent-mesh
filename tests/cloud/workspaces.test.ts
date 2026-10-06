import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveEntitlements } from "../../packages/licensing/src/index";
import { GatewayAdminError, ProvisionError, ServiceError, accountPageUrl } from "../../packages/cloud/src/index";
import { plane, running, type Plane } from "./support";

const DAY = 86_400_000;
const refusal = async (promise: Promise<unknown>): Promise<ServiceError> => {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof ServiceError, String(err));
    return err;
  }
  throw new Error("it was accepted");
};
/** The call to the gateway that a key's token is good for, or the refusal. */
const worksAtGateway = (p: Plane, token: string): boolean => {
  try {
    p.gatewayCore.authenticate(`Bearer ${token}`);
    return true;
  } catch {
    return false;
  }
};
const specOf = (p: Plane, i = 0) => p.provisioner.ops("create")[i]!.spec!;

test("a workspace is asked for and returns at once as provisioning, and becomes running when its host has answered", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  await p.subscribe(ada.accountId, "team");
  let release!: () => void;
  p.provisioner.hold = new Promise((resolve) => (release = resolve));
  const w = await p.plane.workspaces.create(ada.accountId, "  Main Site ");
  assert.equal(w.status, "provisioning");
  assert.equal(w.name, "Main Site");
  assert.match(w.workspaceId, /^ws_[0-9a-f]{12}$/);
  assert.match(w.slug, /^main-site-[0-9a-f]{6}$/);
  assert.equal(w.plan, "team");
  assert.equal(p.plane.workspaces.inFlight.size, 1);
  assert.equal(p.plane.view(p.log.state.accounts.get(ada.accountId)!).workspaces[0]!.status, "provisioning");
  release();
  await p.plane.workspaces.idle();
  assert.equal(p.plane.workspaces.inFlight.size, 0);
  const now = p.log.state.workspaces.get(w.workspaceId)!;
  assert.equal(now.status, "running");
  assert.match(now.handle!, /^fake-ws_/);
  assert.deepEqual(now.upstream, { host: now.handle, port: 7420 });
  assert.ok(now.gatewayKeyId);
  assert.deepEqual(
    p.store.entries.filter((e) => e.type.startsWith("workspace.")).map((e) => (e.type === "workspace.status" ? `status:${e.status}` : e.type)),
    ["workspace.requested", "status:provisioning", "workspace.provisioned", "status:running"],
  );
});

test("a workspace is given a model key that works at the gateway, a licence for its plan, and a credential for the proxy, none of which is written to the log", async () => {
  const { p, ada, workspaceId } = await running();
  const spec = specOf(p);
  assert.equal(spec.workspaceId, workspaceId);
  assert.equal(spec.accountId, ada.accountId);
  assert.equal(spec.plan, "team");
  assert.deepEqual(spec.limits, { cpus: 1, memoryMb: 2048, pids: 512 });
  assert.deepEqual(spec.env, { CURULE_ACCOUNT_URL: "https://app.example.com/account", CURULE_GATEWAY_MODEL: "balanced" }, "the tier a team uses unless a seat names another: one this plan's key may use, and where the account page is");
  assert.equal(spec.gateway!.baseUrl, "http://gateway.internal:8080/v1");
  assert.equal(spec.operatorToken, p.plane.workspaces.operatorToken(workspaceId));
  const key = p.gatewayCore.authenticate(`Bearer ${spec.gateway!.key}`);
  assert.equal(key.accountId, ada.accountId);
  assert.equal(key.workspaceId, workspaceId);
  assert.deepEqual(key.models, ["fast", "balanced"], "this plan's tiers, and no others");
  const ent = resolveEntitlements({ token: spec.licence, publicKeys: { [p.keys.kid]: p.keys.publicKey }, now: new Date(p.clock.now), enforcement: "enforce" });
  assert.equal(ent.status, "valid");
  assert.equal(ent.plan, "team");
  assert.equal(ent.customer, ada.accountId);
  const log = JSON.stringify(p.store.entries);
  for (const secret of [spec.gateway!.key, spec.operatorToken, spec.licence!]) assert.ok(!log.includes(secret), "a credential is in the log");
});

test("a plan that names no tiers gives its workspaces every tier, and a service with no signing key starts workspaces without a licence", async () => {
  const { p } = await running({ noSigner: true }, "business");
  const spec = specOf(p);
  assert.equal(spec.licence, undefined);
  assert.equal(p.gatewayCore.authenticate(`Bearer ${spec.gateway!.key}`).models, undefined, "a key with no list may use every tier");
  assert.equal(spec.plan, "business");
  assert.deepEqual(spec.env, { CURULE_ACCOUNT_URL: "https://app.example.com/account" }, "the host's own default tier stands: only where the account page is is added");
});

test("the limits and the environment a host is given are the operator's", async () => {
  const { p } = await running({ workspaces: { limits: { cpus: 2, memoryMb: 4096, pids: 1024 }, workspaceEnv: { HTTPS_PROXY: "http://egress.internal:3128" } } });
  assert.deepEqual(specOf(p).limits, { cpus: 2, memoryMb: 4096, pids: 1024 });
  assert.deepEqual(specOf(p).env, { HTTPS_PROXY: "http://egress.internal:3128", CURULE_ACCOUNT_URL: "https://app.example.com/account", CURULE_GATEWAY_MODEL: "balanced" });
  const business = await running({ workspaces: { workspaceEnv: { HTTPS_PROXY: "http://egress.internal:3128" } } }, "business");
  assert.deepEqual(specOf(business.p).env, { HTTPS_PROXY: "http://egress.internal:3128", CURULE_ACCOUNT_URL: "https://app.example.com/account" }, "a plan with no tier of its own adds only where the account page is to what the operator gave");
});

test("a workspace's host is told where its account page is, whatever the operator's environment says, and is told again when it is made again", async () => {
  const { p, workspaceId } = await running({ workspaces: { workspaceEnv: { CURULE_ACCOUNT_URL: "https://elsewhere.example/account", HTTPS_PROXY: "http://egress.internal:3128" } } });
  assert.equal(specOf(p).env!.CURULE_ACCOUNT_URL, "https://app.example.com/account", "the service's own address for its app: a console that sends a person to add a key must not be pointed elsewhere by an addition");
  assert.equal(specOf(p).env!.HTTPS_PROXY, "http://egress.internal:3128", "the rest of the operator's additions stand");
  // Making the host again (a plan change, a key) keeps it: the console of a host that lost it would stop saying where the key goes.
  await p.plane.workspaces.reprovision(workspaceId, "business");
  assert.equal(specOf(p, 1).env!.CURULE_ACCOUNT_URL, "https://app.example.com/account");
});

test("the address a host is told its account page is at is under the app, whatever slashes the configured address ends in", () => {
  assert.equal(accountPageUrl("https://app.example.com"), "https://app.example.com/account");
  assert.equal(accountPageUrl("https://app.example.com/"), "https://app.example.com/account", "a slash at the end of the address is not doubled");
  assert.equal(accountPageUrl("http://localhost:7870//"), "http://localhost:7870/account", "a port is kept, and several slashes are one");
});

test("a workspace is for an account that is confirmed, not stopped, and paid up", async () => {
  const p = await plane();
  const none = await refusal(p.plane.workspaces.create("acct_nobody", "Main"));
  assert.deepEqual([none.status, none.code], [403, "not_allowed"]);
  await p.plane.accounts.signup("new@example.com", "correct horse battery staple");
  const unconfirmed = [...p.log.state.accounts.values()][0]!;
  assert.equal((await refusal(p.plane.workspaces.create(unconfirmed.accountId, "Main"))).code, "not_allowed");

  const ada = await p.account("ada@example.com");
  const unpaid = await refusal(p.plane.workspaces.create(ada.accountId, "Main"));
  assert.deepEqual([unpaid.status, unpaid.code, unpaid.message], [402, "no_subscription", "Choose a plan before creating a workspace."]);

  await p.subscribe(ada.accountId);
  await p.plane.billing.apply({ type: "payment.failed", ref: "in_1", accountId: ada.accountId, at: new Date(p.clock.now).toISOString() });
  const late = await refusal(p.plane.workspaces.create(ada.accountId, "Main"));
  assert.deepEqual([late.status, late.code], [402, "payment_overdue"]);
  assert.match(late.message, /The last payment did not go through\. Update your payment details/);

  await p.subscribe(ada.accountId, "team", "inv_2");
  await p.plane.disableAccount(ada.accountId, "abuse");
  assert.equal((await refusal(p.plane.workspaces.create(ada.accountId, "Main"))).code, "not_allowed");
  await p.plane.enableAccount(ada.accountId);
  await p.plane.billing.apply({ type: "subscription.ended", ref: "ended", subscriptionRef: "sub", accountId: ada.accountId, at: new Date(p.clock.now).toISOString() });
  assert.equal((await refusal(p.plane.workspaces.create(ada.accountId, "Main"))).code, "no_subscription", "an ended subscription is no subscription");
  assert.equal(p.provisioner.calls.length, 0);
});

test("a plan that is no longer offered cannot start a workspace, and says to contact the operator", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  await p.log.append({ type: "subscription.changed", accountId: ada.accountId, plan: "legacy", status: "active", reason: "test" });
  const e = await refusal(p.plane.workspaces.create(ada.accountId, "Main"));
  assert.deepEqual([e.status, e.code, e.message], [409, "plan_unknown", "Your plan is no longer offered. Contact the operator."]);
});

test("an account may run as many workspaces as its plan allows, a failed or deleted one does not count, and the refusal says how many", async () => {
  const { p, ada, workspaceId } = await running();
  const full = await refusal(p.plane.workspaces.create(ada.accountId, "Second"));
  assert.deepEqual([full.status, full.code, full.message], [403, "workspace_limit", "Your plan allows 1 workspace."]);
  await p.plane.workspaces.destroy(workspaceId, ada.accountId);
  p.provisioner.failNext.push("create");
  const failed = await p.plane.workspaces.create(ada.accountId, "Second");
  await p.plane.workspaces.idle();
  assert.equal(p.log.state.workspaces.get(failed.workspaceId)!.status, "failed");
  const third = await p.plane.workspaces.create(ada.accountId, "Third");
  await p.plane.workspaces.idle();
  assert.equal(p.log.state.workspaces.get(third.workspaceId)!.status, "running", "a deleted workspace and a failed one each left room for the next");

  const q = await running({}, "business", "bob@example.com");
  await q.p.plane.workspaces.create(q.ada.accountId, "Two");
  await q.p.plane.workspaces.create(q.ada.accountId, "Three");
  await q.p.plane.workspaces.idle();
  const over = await refusal(q.p.plane.workspaces.create(q.ada.accountId, "Four"));
  assert.equal(over.message, "Your plan allows 3 workspaces.");
  await q.p.plane.workspaces.suspend(q.workspaceId, "paused");
  assert.equal((await refusal(q.p.plane.workspaces.create(q.ada.accountId, "Four"))).code, "workspace_limit", "a stopped workspace still counts: its data is kept");
});

test("a workspace has a name of one to sixty characters with no control characters, and the name is kept tidy", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  await p.subscribe(ada.accountId, "business");
  for (const bad of ["", "   ", "x".repeat(61), "two\nlines", "tab\there", "bell\x07", "del\x7f", undefined, 5, null]) {
    const e = await refusal(p.plane.workspaces.create(ada.accountId, bad));
    assert.deepEqual([e.status, e.code, e.message], [400, "invalid_name", "Give the workspace a name of 1 to 60 characters."], String(bad));
  }
  const sixty = await p.plane.workspaces.create(ada.accountId, "x".repeat(60));
  assert.equal(sixty.name.length, 60);
  const one = await p.plane.workspaces.create(ada.accountId, " é ");
  assert.equal(one.name, "é");
  await p.plane.workspaces.idle();
});

test("a slug is a label made from the name and a random suffix, and is never one that is taken", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  await p.subscribe(ada.accountId, "business");
  const names: Array<[string, RegExp]> = [
    ["My Great Workspace!", /^my-great-workspace-[0-9a-f]{6}$/],
    ["Ünïcode Café", /^unicode-cafe-[0-9a-f]{6}$/],
    ["日本語", /^workspace-[0-9a-f]{6}$/],
    ["---", /^workspace-[0-9a-f]{6}$/],
    ["a very long name that goes on and on and on", /^a-very-long-name-that-go-[0-9a-f]{6}$/],
    [`${"a".repeat(23)} tail`, /^a{23}-[0-9a-f]{6}$/],
  ];
  const made: string[] = [];
  for (const [name, expected] of names) {
    const w = await p.plane.workspaces.create(ada.accountId, name);
    made.push(w.slug);
    assert.match(w.slug, expected, name);
    assert.ok(w.slug.length <= 31, "a DNS label is at most 63, and this stays well inside it");
    await p.plane.workspaces.idle();
    await p.plane.workspaces.destroy(w.workspaceId, ada.accountId);
  }
  assert.equal(new Set(made).size, made.length);
});

test("a workspace is found by the host it is served on, whatever the case or port, and only while it exists", async () => {
  const { p, workspace, ada } = await running();
  const w = workspace();
  const host = `${w.slug}.ws.example.com`;
  assert.equal(p.plane.workspaces.hostOf(w.slug), host);
  assert.equal(p.plane.workspaces.byHost(host)!.workspaceId, w.workspaceId);
  assert.equal(p.plane.workspaces.byHost(host.toUpperCase())!.workspaceId, w.workspaceId);
  assert.equal(p.plane.workspaces.byHost(`${host}:8443`)!.workspaceId, w.workspaceId);
  for (const other of ["ws.example.com", `${w.slug}.other.example.com`, `nothing-aaaaaa.ws.example.com`, `${w.slug}.ws.example.com.evil.test`, `x.${w.slug}.ws.example.com`, "", `${w.slug}ws.example.com`]) assert.equal(p.plane.workspaces.byHost(other), undefined, other);
  await p.plane.workspaces.destroy(w.workspaceId, ada.accountId);
  assert.equal(p.plane.workspaces.byHost(host), undefined, "a deleted workspace is not served");
});

test("the credential the proxy presents is derived from the service's secret and the workspace, so it survives a restart and is stored nowhere", async () => {
  const p = await plane();
  const a = p.plane.workspaces.operatorToken("ws_one");
  assert.equal(a, p.plane.workspaces.operatorToken("ws_one"));
  assert.notEqual(a, p.plane.workspaces.operatorToken("ws_two"));
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  const other = await plane({ workspaces: { secret: "a-different-service-secret-of-at-least-32-chars" } });
  assert.notEqual(a, other.plane.workspaces.operatorToken("ws_one"));
});

test("a service secret that is too short is refused before anything is built on it", async () => {
  await assert.rejects(() => plane({ workspaces: { secret: "short" } }), /the service secret must be at least 32 characters/);
});

// ---- when a start fails ----

test("a host that cannot be created leaves nothing behind: its model key is revoked, and the workspace says it failed", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  await p.subscribe(ada.accountId);
  p.provisioner.failNext.push("create");
  const w = await p.plane.workspaces.create(ada.accountId, "Main");
  await p.plane.workspaces.idle();
  const now = p.log.state.workspaces.get(w.workspaceId)!;
  assert.equal(now.status, "failed");
  assert.equal(now.statusReason, "the workspace could not be started", "what the provisioner said is not shown to the customer");
  assert.equal(worksAtGateway(p, specOf(p).gateway!.key), false, "the key that was made for it is revoked");
  assert.equal(p.provisioner.ops("destroy").length, 0, "there was no host to remove");
});

test("a provisioning error's own words are shown, cut to two hundred characters", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  await p.subscribe(ada.accountId);
  p.provisioner.create = async () => {
    throw new ProvisionError(`docker run failed (125): ${"x".repeat(400)}`);
  };
  const w = await p.plane.workspaces.create(ada.accountId, "Main");
  await p.plane.workspaces.idle();
  const reason = p.log.state.workspaces.get(w.workspaceId)!.statusReason!;
  assert.equal(reason.length, 200);
  assert.ok(reason.startsWith("docker run failed (125): xxx"));
});

test("a host that never becomes ready is removed, its key is revoked, and the workspace says it failed", async () => {
  const p = await plane({
    workspaces: {
      waitReady: async () => {
        throw new ProvisionError("the workspace did not become ready: status 503");
      },
    },
  });
  const ada = await p.account("ada@example.com");
  await p.subscribe(ada.accountId);
  const w = await p.plane.workspaces.create(ada.accountId, "Main");
  await p.plane.workspaces.idle();
  const now = p.log.state.workspaces.get(w.workspaceId)!;
  assert.equal(now.status, "failed");
  assert.equal(now.statusReason, "the workspace did not become ready: status 503");
  assert.deepEqual(p.provisioner.ops("destroy").map((c) => c.handle), [now.handle]);
  assert.equal(p.provisioner.state.has(now.handle!), false);
  assert.equal(worksAtGateway(p, specOf(p).gateway!.key), false);
});

test("a clean-up that itself fails does not hide the failure, and a gateway that is down means no host is made", async () => {
  const p = await plane({
    workspaces: {
      waitReady: async () => {
        throw new Error("no answer");
      },
    },
  });
  const ada = await p.account("ada@example.com");
  await p.subscribe(ada.accountId);
  p.provisioner.failNext.push("destroy");
  const w = await p.plane.workspaces.create(ada.accountId, "Main");
  await p.plane.workspaces.idle();
  assert.equal(p.log.state.workspaces.get(w.workspaceId)!.status, "failed");

  const q = await plane();
  const bob = await q.account("bob@example.com");
  await q.subscribe(bob.accountId);
  q.gateway.createKey = async () => {
    throw new GatewayAdminError(0, "unreachable", "the model gateway could not be reached (connect ECONNREFUSED)");
  };
  const x = await q.plane.workspaces.create(bob.accountId, "Main");
  await q.plane.workspaces.idle();
  assert.equal(q.log.state.workspaces.get(x.workspaceId)!.status, "failed");
  assert.equal(q.provisioner.calls.length, 0, "no host is made without a key for it");
});

// ---- the life of a workspace ----

test("a workspace is stopped by its owner, keeping its data, and stopping it again does nothing", async () => {
  const { p, ada, workspaceId, workspace } = await running();
  await p.plane.workspaces.suspend(workspaceId, "paused by its owner", ada.accountId);
  assert.equal(workspace().status, "suspended");
  assert.equal(workspace().statusReason, "paused by its owner");
  assert.deepEqual(p.provisioner.ops("suspend").map((c) => c.handle), [workspace().handle]);
  await p.plane.workspaces.suspend(workspaceId, "again", ada.accountId);
  assert.equal(p.provisioner.ops("suspend").length, 1);
  assert.equal(workspace().statusReason, "paused by its owner");
  assert.ok(worksAtGateway(p, specOf(p).gateway!.key), "stopping a host does not revoke its key: it has not been deleted");
});

test("what is done to a workspace is done only for its owner, and a workspace that does not exist, or is not in the right state, says so", async () => {
  const { p, workspaceId, workspace } = await running();
  const bob = await p.account("bob@example.com");
  for (const act of [() => p.plane.workspaces.suspend(workspaceId, "x", bob.accountId), () => p.plane.workspaces.resume(workspaceId, bob.accountId), () => p.plane.workspaces.destroy(workspaceId, bob.accountId)]) {
    const e = await refusal(act());
    assert.deepEqual([e.status, e.code, e.message], [404, "not_found", "There is no such workspace."], "another account's workspace is not found");
  }
  assert.equal((await refusal(p.plane.workspaces.suspend("ws_nothing", "x"))).code, "not_found");
  assert.equal(workspace().status, "running");
  const resumeRunning = await p.plane.workspaces.resume(workspaceId);
  assert.equal(resumeRunning, undefined, "starting a running workspace is not an error");
  assert.equal(p.provisioner.ops("resume").length, 0);

  await p.plane.workspaces.destroy(workspaceId);
  p.provisioner.failNext.push("create");
  const ada = [...p.log.state.accounts.values()].find((a) => a.email === "ada@example.com")!;
  const failed = await p.plane.workspaces.create(ada.accountId, "Second");
  await p.plane.workspaces.idle();
  assert.equal(p.log.state.workspaces.get(failed.workspaceId)!.status, "failed");
  const notRunning = await refusal(p.plane.workspaces.suspend(failed.workspaceId, "x"));
  assert.deepEqual([notRunning.status, notRunning.code, notRunning.message], [409, "not_running", "That workspace is not running."]);
  const notStopped = await refusal(p.plane.workspaces.resume(failed.workspaceId));
  assert.deepEqual([notStopped.status, notStopped.code, notStopped.message], [409, "not_suspended", "That workspace is not stopped."]);
});

test("a stopped workspace is started again on the same key, once the account is paid up and not stopped", async () => {
  const { p, ada, workspaceId, workspace } = await running();
  const keyId = workspace().gatewayKeyId;
  await p.plane.workspaces.suspend(workspaceId, "paused", ada.accountId);
  await p.plane.workspaces.resume(workspaceId, ada.accountId);
  assert.equal(workspace().status, "running");
  assert.equal(workspace().statusReason, undefined, "the reason for the stop goes when it starts");
  assert.equal(workspace().gatewayKeyId, keyId, "the same model key");
  assert.equal(p.provisioner.ops("resume").length, 1);

  await p.plane.workspaces.suspend(workspaceId, "paused", ada.accountId);
  await p.plane.billing.apply({ type: "payment.failed", ref: "in_x", accountId: ada.accountId, at: new Date(p.clock.now).toISOString() });
  const late = await refusal(p.plane.workspaces.resume(workspaceId, ada.accountId));
  assert.deepEqual([late.status, late.code, late.message], [402, "payment_overdue", "Payment is needed before this workspace can run."]);
  assert.equal(workspace().status, "suspended");
  await p.subscribe(ada.accountId, "team", "inv_paid");
  assert.equal(workspace().status, "running", "paying starts what the account's standing had stopped");
  await p.plane.workspaces.suspend(workspaceId, "paused", ada.accountId);
  await p.plane.disableAccount(ada.accountId, "abuse");
  assert.equal((await refusal(p.plane.workspaces.resume(workspaceId))).code, "not_allowed");
});

test("deleting a workspace stops its key first, then removes the host and its data, and says who decided", async () => {
  const { p, ada, workspaceId, workspace } = await running();
  const order: string[] = [];
  const revoke = p.gateway.revokeKey.bind(p.gateway);
  p.gateway.revokeKey = async (id, reason) => {
    order.push(`revoke:${reason}`);
    return revoke(id, reason);
  };
  const destroy = p.provisioner.destroy.bind(p.provisioner);
  p.provisioner.destroy = async (handle, options) => {
    order.push("destroy");
    return destroy(handle, options);
  };
  const key = specOf(p).gateway!.key;
  assert.ok(worksAtGateway(p, key));
  await p.plane.workspaces.destroy(workspaceId, ada.accountId);
  assert.deepEqual(order, ["revoke:workspace deleted", "destroy"]);
  assert.equal(worksAtGateway(p, key), false);
  assert.equal(workspace().status, "destroyed");
  assert.equal(workspace().statusReason, "deleted by its owner");
  assert.equal(p.provisioner.ops("destroy")[0]!.options, undefined, "the data goes with it");
  assert.deepEqual(p.plane.workspaces.forAccount(ada.accountId), []);
  assert.equal((await refusal(p.plane.workspaces.destroy(workspaceId, ada.accountId))).code, "not_found", "it is gone");
});

test("a workspace the service removes says so, and one that never got a host has nothing to remove", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  await p.subscribe(ada.accountId);
  p.provisioner.failNext.push("create");
  const w = await p.plane.workspaces.create(ada.accountId, "Main");
  await p.plane.workspaces.idle();
  await p.plane.workspaces.destroy(w.workspaceId);
  assert.equal(p.log.state.workspaces.get(w.workspaceId)!.statusReason, "removed by the service");
  assert.equal(p.provisioner.ops("destroy").length, 0);
});

test("a workspace is not marked deleted when its key could not be revoked, so it is not left running with a live key", async () => {
  const { p, ada, workspaceId, workspace } = await running();
  p.gateway.revokeKey = async () => {
    throw new GatewayAdminError(502, "bad_gateway", "the gateway answered 502");
  };
  await assert.rejects(() => p.plane.workspaces.destroy(workspaceId, ada.accountId), GatewayAdminError);
  assert.equal(workspace().status, "running");
  assert.equal(p.provisioner.ops("destroy").length, 0);
});

test("a workspace is made again on its new plan, with a new key and licence, keeping its data and the old key revoked", async () => {
  const { p, workspaceId, workspace } = await running();
  const oldKey = specOf(p).gateway!.key;
  const oldHandle = workspace().handle!;
  await p.plane.workspaces.reprovision(workspaceId, "business");
  assert.equal(workspace().plan, "business");
  assert.equal(workspace().status, "running");
  assert.notEqual(workspace().handle, oldHandle);
  assert.deepEqual(p.provisioner.ops("destroy").map((c) => [c.handle, c.options]), [[oldHandle, { keepData: true }]]);
  const spec = specOf(p, 1);
  assert.equal(spec.plan, "business");
  assert.equal(resolveEntitlements({ token: spec.licence, publicKeys: { [p.keys.kid]: p.keys.publicKey }, now: new Date(p.clock.now) }).plan, "business");
  assert.equal(worksAtGateway(p, oldKey), false);
  assert.ok(worksAtGateway(p, spec.gateway!.key));
  assert.equal(p.gatewayCore.authenticate(`Bearer ${spec.gateway!.key}`).models, undefined, "business has no tier list");
  assert.equal(workspace().gatewayKeyId, p.gatewayCore.authenticate(`Bearer ${spec.gateway!.key}`).keyId);
});

test("a stopped workspace that is moved to another plan stays stopped, and keeps the reason it was stopped", async () => {
  const { p, ada, workspaceId, workspace } = await running();
  await p.plane.workspaces.suspend(workspaceId, "paused by its owner", ada.accountId);
  const oldHandle = workspace().handle!;
  await p.plane.workspaces.reprovision(workspaceId, "business");
  assert.equal(workspace().status, "suspended");
  assert.equal(workspace().statusReason, "paused by its owner");
  assert.notEqual(workspace().handle, oldHandle);
  assert.deepEqual(p.provisioner.ops("suspend").map((c) => c.handle), [oldHandle, workspace().handle], "the host that was made again is stopped as the old one was");
  assert.equal(p.provisioner.state.get(workspace().handle!), "stopped");
});

test("a workspace that is not running or stopped is not moved to another plan", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  await p.subscribe(ada.accountId);
  p.provisioner.failNext.push("create");
  const w = await p.plane.workspaces.create(ada.accountId, "Main");
  await p.plane.workspaces.idle();
  await p.plane.workspaces.reprovision(w.workspaceId, "business");
  assert.equal(p.log.state.workspaces.get(w.workspaceId)!.plan, "team");
  assert.equal(p.provisioner.ops("create").length, 1);
});

// ---- what the service does on its own ----

test("a start that was in progress when the service stopped is given up on after five minutes, and its key is revoked", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  await p.subscribe(ada.accountId);
  const key = await p.gateway.createKey({ accountId: ada.accountId, workspaceId: "ws_orphan" });
  await p.log.append({ type: "workspace.requested", workspaceId: "ws_orphan", accountId: ada.accountId, name: "Orphan", slug: "orphan-abc123", plan: "team" });
  await p.log.append({ type: "workspace.status", workspaceId: "ws_orphan", status: "provisioning" });
  await p.log.append({ type: "workspace.provisioned", workspaceId: "ws_orphan", handle: "fake-orphan", upstream: { host: "fake-orphan", port: 7420 }, gatewayKeyId: key.keyId });
  p.clock.advance(5 * 60_000);
  assert.deepEqual(await p.plane.workspaces.reconcile(), [], "five minutes is not yet more than five minutes");
  p.clock.advance(1);
  assert.deepEqual(await p.plane.workspaces.reconcile(), ["ws_orphan: failed, it never finished starting"]);
  const w = p.log.state.workspaces.get("ws_orphan")!;
  assert.equal(w.status, "failed");
  assert.equal(w.statusReason, "the service restarted while it was starting");
  assert.equal(worksAtGateway(p, key.token), false);
  assert.deepEqual(p.provisioner.ops("destroy").map((c) => c.handle), ["fake-orphan"]);
  assert.deepEqual(await p.plane.workspaces.reconcile(), [], "and it is done once");
});

test("a start that is still going is left alone, however long it takes", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  await p.subscribe(ada.accountId);
  p.provisioner.hold = new Promise(() => undefined);
  const w = await p.plane.workspaces.create(ada.accountId, "Main");
  p.clock.advance(DAY);
  assert.deepEqual(await p.plane.workspaces.reconcile(), []);
  assert.equal(p.log.state.workspaces.get(w.workspaceId)!.status, "provisioning");
});

test("a period that ended with no payment recorded makes the subscription past due after three days, and the options can change that", async () => {
  const { p, ada } = await running();
  const end = Date.parse(p.log.state.accounts.get(ada.accountId)!.subscription!.periodEnd!);
  assert.equal(new Date(end).toISOString(), "2026-11-05T12:00:00.000Z");
  p.clock.set("2026-11-08T12:00:00.000Z");
  assert.deepEqual(await p.plane.workspaces.reconcile(), []);
  p.clock.advance(1);
  assert.deepEqual(await p.plane.workspaces.reconcile(), [`${ada.accountId}: past due, no payment recorded for the period that ended`]);
  const sub = p.log.state.accounts.get(ada.accountId)!.subscription!;
  assert.equal(sub.status, "past_due");
  assert.equal(sub.pastDueSince, "2026-11-08T12:00:00.001Z");
  assert.deepEqual(await p.plane.workspaces.reconcile(), [], "past due is not recorded twice");

  const q = await running({ workspaces: { periodGraceDays: 10 } });
  q.p.clock.set("2026-11-15T12:00:00.000Z");
  assert.deepEqual(await q.p.plane.workspaces.reconcile(), []);
});

test("an account that has been past due for more than the grace period has its running workspaces stopped, and one that has not is left running", async () => {
  const { p, ada, workspace } = await running();
  await p.plane.billing.apply({ type: "payment.failed", ref: "in_1", accountId: ada.accountId, at: new Date(p.clock.now).toISOString() });
  p.clock.advance(3 * DAY);
  assert.deepEqual(await p.plane.workspaces.reconcile(), [], "three days to the millisecond is still the grace period");
  assert.equal(workspace().status, "running");
  p.clock.advance(1);
  assert.deepEqual(await p.plane.workspaces.reconcile(), [`${workspace().workspaceId}: stopped, payment is overdue`]);
  assert.equal(workspace().status, "suspended");
  assert.equal(workspace().statusReason, "payment is overdue");
  assert.deepEqual(await p.plane.workspaces.reconcile(), [], "stopped once");

  const q = await running({ workspaces: { graceDays: 7 } });
  await q.p.plane.billing.apply({ type: "payment.failed", ref: "in_1", accountId: q.ada.accountId, at: new Date(q.p.clock.now).toISOString() });
  q.p.clock.advance(5 * DAY);
  assert.deepEqual(await q.p.plane.workspaces.reconcile(), []);
});

test("an account whose subscription ended has its workspaces stopped, and after the retention period they are deleted", async () => {
  const { p, ada, workspace, workspaceId } = await running();
  await p.plane.billing.apply({ type: "subscription.ended", ref: "ended", subscriptionRef: "sub_1", accountId: ada.accountId, at: new Date(p.clock.now).toISOString() });
  assert.equal(workspace().status, "suspended", "stopped when the subscription ended");
  p.clock.advance(30 * DAY);
  assert.deepEqual(await p.plane.workspaces.reconcile(), [], "thirty days to the millisecond is still inside the retention period");
  assert.equal(workspace().status, "suspended");
  p.clock.advance(1);
  assert.deepEqual(await p.plane.workspaces.reconcile(), [`${workspaceId}: deleted, the retention period after the subscription ended is over`]);
  assert.equal(workspace().status, "destroyed");
  assert.equal(workspace().statusReason, "removed by the service");
  assert.equal(p.provisioner.ops("destroy").length, 1);

  const q = await running({ workspaces: { retentionDays: 90 } });
  await q.p.plane.billing.apply({ type: "subscription.ended", ref: "ended", subscriptionRef: "sub_1", accountId: q.ada.accountId, at: new Date(q.p.clock.now).toISOString() });
  q.p.clock.advance(60 * DAY);
  assert.deepEqual(await q.p.plane.workspaces.reconcile(), []);
});

test("a running workspace whose host has stopped is started again, and one that cannot be started is said and tried at the next check", async () => {
  const { p, workspace, workspaceId } = await running();
  const handle = workspace().handle!;
  p.provisioner.state.set(handle, "stopped");
  assert.deepEqual(await p.plane.workspaces.reconcile(), [`${workspaceId}: started again, its host had stopped`]);
  assert.equal(p.provisioner.state.get(handle), "running");
  assert.equal(workspace().status, "running");
  assert.equal(p.provisioner.ops("resume").length, 1);
  assert.equal(p.store.entries.filter((e) => e.type === "workspace.provisioned").length, 2, "where it is now is recorded, because it may not be where it was");
  assert.deepEqual(await p.plane.workspaces.reconcile(), [], "a host that is running is left alone");

  p.provisioner.state.set(handle, "stopped");
  p.provisioner.failNext.push("resume");
  assert.deepEqual(await p.plane.workspaces.reconcile(), [`${workspaceId}: its host had stopped and could not be started (the resume failed); it is tried again at the next check`]);
  assert.equal(workspace().status, "running", "a workspace is not given up on for one failed start");
  assert.deepEqual(await p.plane.workspaces.reconcile(), [`${workspaceId}: started again, its host had stopped`]);

  // A host that does not become ready is the same.
  const q = await running();
  Object.assign((q.p.plane.workspaces as unknown as { o: object }).o, { waitReady: async () => { throw new Error("no answer yet"); } });
  q.p.provisioner.state.set(q.workspace().handle!, "stopped");
  assert.deepEqual(await q.p.plane.workspaces.reconcile(), [`${q.workspaceId}: its host had stopped and could not be started (no answer yet); it is tried again at the next check`]);

  // A workspace that was stopped on purpose is not started: only what the log calls running is looked at.
  const r = await running();
  await r.p.plane.workspaces.suspend(r.workspaceId, "paused by its owner");
  assert.deepEqual(await r.p.plane.workspaces.reconcile(), []);
  assert.equal(r.p.provisioner.ops("resume").length, 0);
});

test("a running workspace whose host has disappeared is marked failed, and one whose host cannot be asked about is left alone", async () => {
  const { p, workspace, workspaceId } = await running();
  p.provisioner.state.delete(workspace().handle!);
  assert.deepEqual(await p.plane.workspaces.reconcile(), [`${workspaceId}: failed, the host disappeared`]);
  assert.equal(workspace().status, "failed");
  assert.equal(workspace().statusReason, "the host disappeared");

  const q = await running();
  q.p.provisioner.status = async () => {
    throw new Error("the engine does not answer");
  };
  assert.deepEqual(await q.p.plane.workspaces.reconcile(), []);
  assert.equal(q.workspace().status, "running");
});

test("waiting for the starts that are in progress waits for all of them", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  await p.subscribe(ada.accountId, "business");
  let release!: () => void;
  p.provisioner.hold = new Promise((resolve) => (release = resolve));
  await p.plane.workspaces.create(ada.accountId, "One");
  await p.plane.workspaces.create(ada.accountId, "Two");
  assert.equal(p.plane.workspaces.inFlight.size, 2);
  let finished = false;
  const idle = p.plane.workspaces.idle().then(() => (finished = true));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(finished, false);
  release();
  await idle;
  assert.deepEqual(
    p.plane.workspaces.forAccount(ada.accountId).map((w) => w.status),
    ["running", "running"],
  );
});

test("a workspace that cannot be stopped or deleted is said so and tried again, and does not stop the others from being stopped", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  await p.subscribe(ada.accountId, "business");
  const first = await p.plane.workspaces.create(ada.accountId, "One");
  const second = await p.plane.workspaces.create(ada.accountId, "Two");
  await p.plane.workspaces.idle();
  await p.plane.billing.apply({ type: "payment.failed", ref: "in_f", accountId: ada.accountId, at: new Date(p.clock.now).toISOString() });
  p.clock.advance(3 * DAY + 1);
  p.provisioner.failNext.push("suspend");
  const actions = await p.plane.workspaces.reconcile();
  assert.equal(actions.length, 2);
  assert.match(actions[0]!, new RegExp(`^${first.workspaceId}: could not be stopped \\(the suspend failed\\), payment is overdue; it is tried again at the next check$`));
  assert.equal(actions[1], `${second.workspaceId}: stopped, payment is overdue`);
  assert.equal(p.log.state.workspaces.get(first.workspaceId)!.status, "running");
  assert.equal(p.log.state.workspaces.get(second.workspaceId)!.status, "suspended");
  assert.deepEqual(await p.plane.workspaces.reconcile(), [`${first.workspaceId}: stopped, payment is overdue`], "and the next check stops it");

  await p.plane.billing.apply({ type: "subscription.ended", ref: "ended", subscriptionRef: "sub", accountId: ada.accountId, at: new Date(p.clock.now).toISOString() });
  p.clock.advance(30 * DAY + 1);
  p.provisioner.failNext.push("destroy");
  const later = await p.plane.workspaces.reconcile();
  assert.equal(later.length, 2);
  assert.match(later[0]!, /could not be deleted \(the destroy failed\), the retention period after the subscription ended is over; it is tried again at the next check$/);
  assert.match(later[1]!, /: deleted, the retention period after the subscription ended is over$/);
  assert.equal(p.log.state.workspaces.get(first.workspaceId)!.status, "suspended", "the one that could not be deleted is still there");
  const again = await p.plane.workspaces.reconcile();
  assert.equal(again.length, 1);
  assert.match(again[0]!, /: deleted, the retention period/);
});
