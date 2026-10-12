/**
 * Telling the account owner that a run in one of their workspaces is waiting on them.
 *
 * The mesh half — a run that has stopped, or one that closed with a decision nobody answered — is not this file's to
 * test. What is tested here is the control plane's half: that it asks each running workspace's host with the workspace's
 * own credential, mails the account's address once per state, names the project and quotes the card so the mail is
 * actionable without a sign-in, keeps what it told in the control log so a restart does not say it all again, and that a
 * workspace that is down or slow cannot break the tick it is asked from.
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ControlLog, MemoryControlStore, MemoryMailer, RunNotifier, Workspaces, type Mail } from "../../packages/cloud/src/index";
import { fakeHost, type HostBehaviour } from "./edge-support";
import { stack, signedUp } from "./control-stack";
import { catalogue as catalogueOf, FakeProvisioner, running, SECRET } from "./support";
import { PASSWORD, tokenIn } from "./web-support";

const HOUR = 3_600_000;

// ---- a workspace's host, and what it says about its runs ----

/** A host standing for a workspace's mesh host: it lists its projects, and answers one project's status as the test says. */
function meshHost(state: { projects: Array<{ id: string; name: string }>; statuses: Record<string, string | undefined> }): HostBehaviour {
  return (req, res) => {
    res.setHeader("content-type", "application/json");
    const path = (req.url ?? "").split("?")[0]!;
    if (path === "/api/projects") return void res.end(JSON.stringify({ projects: state.projects, spend: { usedMicros: 0 } }));
    const asked = /^\/api\/p\/([^/]+)\/status$/.exec(path);
    const body = asked ? state.statuses[decodeURIComponent(asked[1]!)] : undefined;
    if (body === undefined) {
      // A project that is closed, or one that never existed: the host refuses it, and that is not something to mail about.
      res.statusCode = 409;
      return void res.end(JSON.stringify({ error: "project_not_running" }));
    }
    res.end(body);
  };
}

/** One project's status, as `GET /api/p/<project>/status` carries it: the goal, and the cards an operator still owes. */
function status(goal: { status: string; id?: string }, cards: Array<Record<string, unknown>> = []): string {
  return JSON.stringify({ goal: { id: "goal_1", description: "Ship the refunds", ...goal }, needsOperator: cards, meshId: "m1", mode: "live" });
}

/** A card as the status payload carries it: what a person owes an answer to, in its own words, and how long it has waited. */
function card(id: string, reason: string, ageMs = 0, raisedBy = "dev"): Record<string, unknown> {
  return { id, reason, raisedBy, openedAt: new Date(Date.parse("2026-10-05T12:00:00.000Z") - ageMs).toISOString(), ageMs };
}

/** A port nothing is listening on: a workspace whose host is not there. */
async function sparePort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

interface Rig extends Awaited<ReturnType<typeof running>> {
  host: Awaited<ReturnType<typeof fakeHost>>;
  notifier: RunNotifier;
  /** The one mail this feature sends. Nothing else in these tests sends one of its kind. */
  mails(): Mail[];
  close(): Promise<void>;
}

/**
 * A running workspace whose host is a fake one, and a notifier over the same log, mailer and clock. `everyMs` is 0 by
 * default so that a test decides for itself when a check happens; the interval has a test of its own.
 */
async function rig(
  options: { behaviour?: HostBehaviour; upstream?: { host: string; port: number }; everyMs?: number; repeatMs?: number; timeoutMs?: number; mailer?: MemoryMailer } = {},
): Promise<Rig> {
  const host = await fakeHost(options.behaviour);
  const r = await running();
  const mailer = options.mailer ?? r.p.mailer;
  // Where the workspace's host is, written down as the provisioner writes it down, so that replaying the log says the
  // same thing and a restart looks in the same place.
  await r.p.log.append({ type: "workspace.provisioned", workspaceId: r.workspaceId, handle: "host-1", upstream: options.upstream ?? { host: "127.0.0.1", port: host.port } });
  const notifier = new RunNotifier({
    log: r.p.log,
    mailer,
    workspaces: r.p.plane.workspaces,
    appUrl: "https://app.example.com",
    clock: () => new Date(r.p.clock.now),
    everyMs: options.everyMs ?? 0,
    ...(options.repeatMs !== undefined ? { repeatMs: options.repeatMs } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  return { ...r, host, notifier, mails: () => mailer.sent.filter((m) => m.kind === "run-needs-you"), close: () => host.close() };
}

// ---- what a run that needs its owner looks like from outside ----

test("a run that has stopped tells the account's owner, once, naming the project and quoting the card", async () => {
  const r = await rig({
    repeatMs: 12 * HOUR,
    behaviour: meshHost({
      projects: [{ id: "payment-api", name: "Payment API" }],
      statuses: { "payment-api": status({ status: "ESCALATED" }, [card("esc_1", "Which licence should the new SDK ship under?", 38 * HOUR, "ada")]) },
    }),
  });
  try {
    const actions = await r.notifier.check();
    assert.equal(r.mails().length, 1);
    const mail = r.mails()[0]!;
    assert.equal(mail.to, "ada@example.com", "to the account's own address");
    assert.match(mail.subject, /needs you/);
    assert.match(mail.text, /The run in your workspace "Main" has stopped and needs you\./);
    assert.match(mail.text, /Project: Payment API/);
    assert.match(mail.text, /Waiting for an answer for 38 hours\./, "how long it has waited, said the way a person would say it");
    assert.match(mail.text, /Which licence should the new SDK ship under\?/, "the card's own words, so the mail is actionable without signing in");
    assert.match(mail.text, /from ada/);
    assert.match(mail.text, /https:\/\/app\.example\.com\/account/, "and where to answer it");
    assert.deepEqual(actions, [`${r.workspaceId}/payment-api: the owner was told the run is waiting on them`]);

    // It was asked with the workspace's own operator credential, and that credential is nowhere a customer can see.
    const token = r.p.plane.workspaces.operatorToken(r.workspaceId);
    assert.equal(r.host.requests.length, 2, "it listed the projects, then asked about the one");
    assert.ok(r.host.requests.every((q) => q.headers.authorization === `Bearer ${token}`), "every request carried the workspace's own credential");
    assert.ok(!`${mail.subject}${mail.text}${actions.join(" ")}`.includes(token), "and the credential is not in anything that leaves the service");

    // What was told is in the log; that is what stops the next check from telling it again.
    assert.ok(r.p.store.entries.some((e) => e.type === "run.notified" && e.projectId === "payment-api" && e.state.startsWith("ESCALATED|esc_1")));
  } finally {
    await r.close();
  }
});

test("a run that finished with a decision nobody answered is told too: that is the case this exists for", async () => {
  const r = await rig({
    behaviour: meshHost({
      projects: [{ id: "greenfield", name: "Greenfield" }],
      statuses: { greenfield: status({ status: "COMPLETED" }, [card("esc_9", "The release notes still say the old price. Which is right?", HOUR, "writer")]) },
    }),
  });
  try {
    await r.notifier.check();
    assert.equal(r.mails().length, 1, "the goal is over and the decision is not: the owner is told");
    assert.match(r.mails()[0]!.subject, /decisions waiting/);
    assert.match(r.mails()[0]!.text, /has finished, with 1 decision it raised never answered\./);
    assert.match(r.mails()[0]!.text, /The release notes still say the old price\. Which is right\?/);
    assert.match(r.mails()[0]!.text, /The first one, from writer:/, "a run that is over is not itself waiting, so the card is described as the first of its decisions");
  } finally {
    await r.close();
  }
});

test("a run that is getting on with it is not told about, and neither is a project the host refuses", async () => {
  const r = await rig({
    behaviour: meshHost({
      projects: [
        { id: "payment-api", name: "Payment API" },
        { id: "closed-one", name: "An old project" },
      ],
      statuses: { "payment-api": status({ status: "ACTIVE" }), "closed-one": undefined },
    }),
  });
  try {
    assert.deepEqual(await r.notifier.check(), []);
    assert.deepEqual(r.mails(), []);
    assert.equal(r.host.requests.length, 3, "it looked at both projects, and had nothing to say about either");
    assert.equal(r.p.store.entries.filter((e) => e.type === "run.notified").length, 0);
  } finally {
    await r.close();
  }
});

// ---- once, and not again until something changes ----

test("the same state is told once; a state that has changed is told at once; and the window passing says it again", async () => {
  const state = {
    projects: [{ id: "payment-api", name: "Payment API" }],
    statuses: { "payment-api": status({ status: "PAUSED" }, [card("esc_1", "Which licence should the SDK ship under?", 60_000)]) },
  };
  const r = await rig({ behaviour: meshHost(state), repeatMs: 12 * HOUR });
  try {
    await r.notifier.check();
    assert.equal(r.mails().length, 1);
    assert.match(r.mails()[0]!.text, /is paused and needs you/);

    r.p.clock.advance(60_000);
    await r.notifier.check();
    assert.equal(r.mails().length, 1, "the same state is not told twice in a row");
    r.p.clock.advance(11 * HOUR);
    await r.notifier.check();
    assert.equal(r.mails().length, 1, "nor anywhere inside the window the configuration names");

    // A second card is a state the owner has not been told about: at once, window or no window.
    state.statuses["payment-api"] = status({ status: "PAUSED" }, [card("esc_1", "Which licence should the SDK ship under?", 60_000), card("esc_2", "And what does it do about retries?", 30_000)]);
    await r.notifier.check();
    assert.equal(r.mails().length, 2, "a state that changed is told about at once");
    assert.match(r.mails()[1]!.text, /1 more decision is waiting after it\./);

    // The window is measured from when the owner was told, and then it is a reminder and not a repeat.
    r.p.clock.advance(12 * HOUR);
    await r.notifier.check();
    assert.equal(r.mails().length, 3, "and once the window has passed, the same state is said again");
  } finally {
    await r.close();
  }
});

test("workspaces are asked at most as often as the configuration says, whatever the tick does", async () => {
  const r = await rig({
    everyMs: 15 * 60_000,
    behaviour: meshHost({ projects: [{ id: "payment-api", name: "Payment API" }], statuses: { "payment-api": status({ status: "ACTIVE" }) } }),
  });
  try {
    await r.notifier.check();
    const asked = r.host.requests.length;
    r.p.clock.advance(60_000);
    await r.notifier.check();
    assert.equal(r.host.requests.length, asked, "a check that ran a moment ago is not run again, however often the tick calls it");
    r.p.clock.advance(15 * 60_000);
    await r.notifier.check();
    assert.equal(r.host.requests.length, asked + 2, "and once the interval has passed it looks at the workspace again");
  } finally {
    await r.close();
  }
});

// ---- a workspace that is down, slow, or unable to send ----

test("a workspace whose host is not there is skipped, and the check says so without throwing", async () => {
  const r = await rig({ upstream: { host: "127.0.0.1", port: await sparePort() } });
  try {
    assert.deepEqual(await r.notifier.check(), [`${r.workspaceId}: could not be asked what its runs are doing; it is tried again at the next check`]);
    assert.deepEqual(r.mails(), []);
    assert.equal(r.p.store.entries.filter((e) => e.type === "run.notified").length, 0, "and nothing was recorded as told, so the next check tries again");
  } finally {
    await r.close();
  }
});

test("a workspace that does not answer in time is given up on, and the check it is part of is not held", async () => {
  // A host that accepts the connection and never answers: a container that is wedged, or one under a network that eats it.
  const silent = http.createServer(() => undefined);
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", () => resolve()));
  const r = await rig({ upstream: { host: "127.0.0.1", port: (silent.address() as AddressInfo).port }, timeoutMs: 150 });
  try {
    const started = Date.now();
    const actions = await r.notifier.check();
    assert.ok(Date.now() - started < 3_000, "the check did not wait on it");
    assert.deepEqual(actions, [`${r.workspaceId}: could not be asked what its runs are doing; it is tried again at the next check`]);
    assert.deepEqual(r.mails(), []);
  } finally {
    await r.close();
    silent.closeAllConnections();
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  }
});

/** A mailer that refuses everything until a test says otherwise: the mail service being down, from the notifier's side. */
class FlakyMailer extends MemoryMailer {
  refuse = true;
  override async send(mail: Mail): Promise<void> {
    if (this.refuse) throw new Error("the mail service is down");
    return super.send(mail);
  }
}

test("a mail that cannot be sent is said in what the check did, is not recorded as told, and is tried again", async () => {
  const mailer = new FlakyMailer();
  const r = await rig({
    mailer,
    behaviour: meshHost({ projects: [{ id: "payment-api", name: "Payment API" }], statuses: { "payment-api": status({ status: "ESCALATED" }, [card("esc_1", "Which licence?")]) } }),
  });
  try {
    assert.deepEqual(await r.notifier.check(), [`${r.workspaceId}/payment-api: the owner could not be told (the mail service is down); it is tried again at the next check`]);
    assert.equal(r.p.store.entries.filter((e) => e.type === "run.notified").length, 0, "a message that never went out is not remembered as one that did");

    // The mail service comes back, and the next check tells the owner what the last one could not.
    mailer.refuse = false;
    r.p.clock.advance(60_000);
    assert.deepEqual(await r.notifier.check(), [`${r.workspaceId}/payment-api: the owner was told the run is waiting on them`]);
    assert.equal(r.mails().length, 1);
  } finally {
    await r.close();
  }
});

// ---- across a restart ----

test("what the owner was told is kept in the control log, so a restart on the same log does not say it all again", async () => {
  const r = await rig({
    behaviour: meshHost({ projects: [{ id: "payment-api", name: "Payment API" }], statuses: { "payment-api": status({ status: "ESCALATED" }, [card("esc_1", "Which licence?")]) } }),
  });
  try {
    await r.notifier.check();
    assert.equal(r.mails().length, 1);
    const entries = [...r.p.store.entries];
    assert.ok(entries.some((e) => e.type === "run.notified"));

    // The next process: the same entries in a new log, and a notifier over it — a fresh mailer, and no memory of the last run.
    const store = new MemoryControlStore();
    for (const e of entries) await store.append(e);
    const mailer = new MemoryMailer();
    const log = await ControlLog.open(store, () => new Date(r.p.clock.now));
    const workspaces = new Workspaces({ log, catalogue: catalogueOf(), provisioner: new FakeProvisioner(), mailer, secret: SECRET, workspaceDomain: "ws.example.com" });
    const notifier = new RunNotifier({ log, mailer, workspaces, appUrl: "https://app.example.com", clock: () => new Date(r.p.clock.now), repeatMs: 12 * HOUR });
    await notifier.check();
    assert.deepEqual(mailer.sent, [], "the owner is not told the same thing twice by a restart");
    assert.equal(r.host.requests.length, 4, "it looked — the log is what keeps it quiet, not a memory of looking");

    // And the record is a record of when, not a wall: the window is measured from when the owner was told.
    r.p.clock.advance(12 * HOUR);
    await notifier.check();
    assert.equal(mailer.sent.length, 1, "and once the window has passed, it is said again");
  } finally {
    await r.close();
  }
});

// ---- the tick that already checks the workspaces is the tick that tells the owner ----

test("a check of the workspaces tells the owner of a run that is waiting on them, on the same tick", async () => {
  const host = await fakeHost(
    meshHost({ projects: [{ id: "payment-api", name: "Payment API" }], statuses: { "payment-api": status({ status: "ESCALATED" }, [card("esc_1", "Which licence?", 38 * HOUR)]) } }),
  );
  const s = await stack({ change: (raw) => (raw.run_notifications = { every_minutes: 1 }) });
  try {
    s.provisioner.upstream = { host: "127.0.0.1", port: host.port };
    const ada = await signedUp(s);
    const checkout = await ada.post("/api/checkout", { purpose: "subscription", plan: "team" });
    const ref = new URL(checkout.json.url).searchParams.get("ref")!;
    await s.owner({ method: "POST", path: "/owner/payments", json: { accountId: ada.accountId, purpose: "subscription", plan: "team", amountMinor: 14_900, currency: "USD", ref: ref.replace(/^manual_/, "") } });
    assert.equal((await ada.post("/api/workspaces", { name: "Main" })).status, 201);
    await s.running.plane.workspaces.idle();

    // The first look was at startup, when there was nothing to look at; the next one is after the interval the configuration names.
    s.clock.now += 60_000;
    await s.running.reconcile();

    const told = s.outbox().filter((m) => m.kind === "run-needs-you");
    assert.equal(told.length, 1);
    assert.equal(told[0]!.to, "ada@example.com");
    assert.match(told[0]!.text, /Project: Payment API/);
    assert.match(told[0]!.text, /Which licence\?/);
    assert.ok(s.logs.some((l) => l.msg === "a check looked at the runs in workspaces" && String(l.action).includes("the owner was told")));
  } finally {
    await s.close();
    await host.close();
  }
});

test("mail that cannot be sent does not end the check it was made from, and the operator's log says what happened", async () => {
  const mailer = new FlakyMailer();
  const host = await fakeHost(meshHost({ projects: [{ id: "payment-api", name: "Payment API" }], statuses: { "payment-api": status({ status: "ESCALATED" }, [card("esc_1", "Which licence?")]) } }));
  const s = await stack({ change: (raw) => (raw.run_notifications = { every_minutes: 1 }), start: { mailer } });
  try {
    s.provisioner.upstream = { host: "127.0.0.1", port: host.port };
    // An account made the way the API makes one: the confirmation link cannot be read out of the mailer this test replaced.
    mailer.refuse = false;
    await s.running.plane.accounts.signup("ada@example.com", PASSWORD);
    const session = await s.running.plane.accounts.verify(tokenIn(mailer.sent.filter((m) => m.kind === "verify").at(-1)!.text));
    await s.running.plane.billing.apply({ type: "payment.succeeded", ref: "inv_1", purpose: "subscription", accountId: session.account.accountId, plan: "team", amountMinor: 14_900, currency: "USD", at: new Date(s.clock.now).toISOString() });
    await s.running.plane.workspaces.create(session.account.accountId, "Main");
    await s.running.plane.workspaces.idle();

    // The mail service goes down, and the tick still runs to its end.
    mailer.refuse = true;
    s.clock.now += 60_000;
    await s.running.reconcile();

    assert.equal(mailer.sent.filter((m) => m.kind === "run-needs-you").length, 0, "the mail did not go out");
    assert.ok(
      s.logs.some((l) => l.msg === "a check looked at the runs in workspaces" && String(l.action).includes("could not be told")),
      "and the log says so, where the operator can see it and the customer cannot",
    );
    assert.ok(
      s.logs.every((l) => l.level !== "error" || !l.msg.includes("runs that need their owner")),
      "the check itself did not fail: a message that could not be sent is not a broken service",
    );
  } finally {
    await s.close();
    await host.close();
  }
});

test("the host is asked by the name it serves, not by the address the control plane reaches it at", async () => {
  // A workspace's mesh host answers only to the names it serves. Ask its private address — which is how the control
  // plane reaches it, and what its `upstream` records — and it refuses with `421 host not allowed`: measured against
  // the live host, whose allowlist carries exactly one name (`<slug>.<workspace domain>`).
  //
  // This is where the transport matters, and why this module does not use `fetch`: Node's fetch rewrites `Host` from
  // the URL and silently drops an explicit one, so a fetch-based check looks correct here and is refused there, every
  // single time, without ever throwing. `http.request` sends what it is told.
  const denied: string[] = [];
  const r = await rig({
    repeatMs: 12 * HOUR,
    behaviour: (req, res) => {
      const asked = req.headers.host ?? "";
      if (/^\d+\.\d+\.\d+\.\d+(:\d+)?$/.test(asked)) {
        denied.push(asked);
        res.writeHead(421, { "content-type": "application/json" });
        return void res.end(
          JSON.stringify({ error: `host '${asked}' is not one this server answers to. If you reach it by that name on purpose, add it to MESH_ALLOWED_HOSTS.`, code: "host_not_allowed" }),
        );
      }
      meshHost({
        projects: [{ id: "payment-api", name: "Payment API" }],
        statuses: { "payment-api": status({ status: "ESCALATED" }, [card("esc_1", "Which licence should the new SDK ship under?", 38 * HOUR, "ada")]) },
      })(req, res, { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.alloc(0) });
    },
  });

  await r.notifier.check();

  assert.deepEqual(denied, [], "the check asked the host by its address, which that host refuses: the run would never be noticed");
  assert.equal(r.mails().length, 1, "asked by the name it serves, the host answers, and the run reaches the owner");
  const hosts = r.host.requests.map((s) => s.headers.host ?? "");
  assert.ok(
    hosts.length > 0 && hosts.every((h) => !/^\d+\.\d+\.\d+\.\d+/.test(h)),
    `every request carries a name the host serves; it carried ${JSON.stringify(hosts)}`,
  );
  await r.close();
});
