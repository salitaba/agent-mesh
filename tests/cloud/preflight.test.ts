import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { stringify } from "yaml";
import { USAGE, main, type Io } from "../../apps/cloud-server/src/index";
import { describePreflight, preflight, type Finding, type PreflightDeps } from "../../apps/cloud-server/src/preflight";
import type { CommandRunner } from "../../packages/cloud/src/index";
import { ENV, pricedCatalogue, trial, workdir, type Workdir } from "./control-support";
import { FakeSmtp, type FakeOptions } from "./smtp-support";

// ---- a world to look at: a gateway, an engine, a name server and a network, each saying what the test tells it to ----

interface World {
  /** The gateway's answer to its health check: a status and a body, or an error for a gateway that is not there. */
  gateway?: { status: number; body?: unknown } | Error;
  /** What the engine says to `version`, `image inspect` and `network inspect`. */
  engine?: Partial<Record<"version" | "image" | "network", { code: number; stdout?: string; stderr?: string } | Error>>;
  /** Names that resolve, and to what. */
  dns?: Record<string, string[]>;
  /** `host:port` that cannot be connected to, and why. */
  noConnect?: Record<string, string>;
  /** `host:port` that cannot be listened on, and why. */
  noListen?: Record<string, string>;
}

const HEALTHY = { ok: true, writable: true, currency: "USD", priceVersion: "2026-10", tiers: ["fast", "balanced"] };

function world(w: World = {}): PreflightDeps & { asked: { fetches: Array<{ url: string; authorization: string | null }>; engine: string[][]; connects: string[]; listens: string[] } } {
  const asked = { fetches: [] as Array<{ url: string; authorization: string | null }>, engine: [] as string[][], connects: [] as string[], listens: [] as string[] };
  const gateway = w.gateway ?? { status: 200, body: HEALTHY };
  const answer = (key: "version" | "image" | "network", fallback: { code: number; stdout: string }): { code: number; stdout: string; stderr: string } => {
    const set: { code: number; stdout?: string; stderr?: string } | Error = w.engine?.[key] ?? fallback;
    if (set instanceof Error) throw set;
    return { code: set.code, stdout: set.stdout ?? "", stderr: set.stderr ?? "" };
  };
  const runner: CommandRunner = {
    async run(command, args) {
      asked.engine.push([command, ...args]);
      if (args[0] === "version") return answer("version", { code: 0, stdout: "27.3.1\n" });
      if (args[0] === "image") return answer("image", { code: 0, stdout: "sha256:abc\n" });
      if (args[0] === "network") return answer("network", { code: 0, stdout: "true\n" });
      throw new Error(`unexpected engine call: ${args.join(" ")}`);
    },
  };
  return {
    asked,
    runner,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      asked.fetches.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
      if (gateway instanceof Error) throw gateway;
      return new Response(typeof gateway.body === "string" ? gateway.body : JSON.stringify(gateway.body ?? {}), { status: gateway.status });
    }) as typeof fetch,
    lookup: async (host) => {
      const found = w.dns?.[host];
      if (!found) throw new Error(`getaddrinfo ENOTFOUND ${host}`);
      return found;
    },
    connect: async (host, port) => {
      asked.connects.push(`${host}:${port}`);
      const why = w.noConnect?.[`${host}:${port}`];
      if (why) throw new Error(why);
    },
    listen: async (host, port) => {
      asked.listens.push(`${host}:${port}`);
      const why = w.noListen?.[`${host}:${port}`];
      if (why) throw new Error(why);
    },
  };
}

/**
 * A configuration for the world above, as a deployment is: served over TLS under names that are not this machine's, with a
 * licence key the build is told to trust, containers on an internal network behind an egress proxy, and mail over SMTP.
 */
const deployed = (raw: Record<string, any>): void => {
  raw.workspaces = { domain: "curule-ws.example" };
  raw.provisioner = { kind: "container", image: "ghcr.io/example/curule:1", network: "curule-workspaces", egress_proxy: "http://egress.curule-workspaces:3128" };
  raw.public = { host: "127.0.0.1", port: 7500, trust_proxy_hops: 1 };
  raw.owner = { host: "127.0.0.1", port: 7501, token_env: "CONTROL_OWNER_TOKEN" };
  raw.mail = { smtp: { host: "smtp.mail.example", from: "no-reply@curule.example", user_env: "SMTP_USER", password_env: "SMTP_PASSWORD" } };
};

/** The same, served over http for a trial: no licence key to prove, and one warning for that. */
const trialDeployed = (raw: Record<string, any>): void => {
  deployed(raw);
  trial(raw);
  raw.app_url = "http://app.curule.example";
  raw.workspaces = { domain: "curule-ws.example" };
  raw.provisioner = { kind: "container", image: "ghcr.io/example/curule:1", network: "curule-workspaces", egress_proxy: "http://egress.curule-workspaces:3128" };
};

const KNOWN = { "app.curule.example": ["203.0.113.10"], "preflight-check.curule-ws.example": ["203.0.113.10"] };

const using = async <T>(w: Workdir, run: (w: Workdir) => Promise<T>): Promise<T> => {
  try {
    return await run(w);
  } finally {
    w.done();
  }
};

const said = (findings: Finding[], level: Finding["level"]): string[] => findings.filter((f) => f.level === level).map((f) => f.text);
const hasProblem = (findings: Finding[], pattern: RegExp): boolean => said(findings, "problem").some((t) => pattern.test(t));
const hasWarning = (findings: Finding[], pattern: RegExp): boolean => said(findings, "warning").some((t) => pattern.test(t));
const hasOk = (findings: Finding[], pattern: RegExp): boolean => said(findings, "ok").some((t) => pattern.test(t));

const run = (w: Workdir, deps: PreflightDeps, mailTo?: string, env: NodeJS.ProcessEnv = ENV) => preflight(w.file, env, { ...(mailTo !== undefined ? { mailTo } : {}), publicKeys: { k1: w.publicKey } }, deps);

// ---- a deployment that is right ----

test("a deployment that is right is all ok, with what each check found, and the gateway is asked with the admin token", async () => {
  await using(workdir(deployed), async (w) => {
    const deps = world({ dns: KNOWN });
    const findings = await run(w, deps);
    assert.deepEqual(said(findings, "problem"), []);
    assert.deepEqual(said(findings, "warning"), [], "nothing to read");
    for (const pattern of [
      /^the configuration is valid \(production: served over TLS\)$/,
      /^the control log can be written: .*data \(it is made at the first start, in /,
      /^the mail spool can be written: /,
      /^the model gateway at http:\/\/gateway\.internal:8081 answered, accepts the admin token, and can write its ledger$/,
      /^every tier a plan names is one the gateway has \(fast, balanced\)$/,
      /^the address workspaces call for models, gateway\.internal:8080, accepts a connection from here$/,
      /^docker answered \(server 27\.3\.1\)$/,
      /^the image ghcr\.io\/example\/curule:1 is here$/,
      /^the network curule-workspaces is internal: a workspace on it has no route out of its own$/,
      /^the egress proxy egress\.curule-workspaces:3128 accepts a connection from here$/,
      /^app\.curule\.example resolves, to 203\.0\.113\.10$/,
      /^a name under curule-ws\.example resolves \(preflight-check\.curule-ws\.example is 203\.0\.113\.10\): the wildcard record is there$/,
      /^the public listener can listen on 127\.0\.0\.1:7500$/,
      /^the owner listener can listen on 127\.0\.0\.1:7501$/,
      /^mail goes over SMTP to smtp\.mail\.example:587; give --mail-to <address> to send a message through it and prove it$/,
      /^payments are by invoice or transfer: customers are sent to /,
      /^workspace licences are signed with key k1, and this build trusts it$/,
    ]) {
      assert.ok(hasOk(findings, pattern), `${pattern}\n${JSON.stringify(said(findings, "ok"), null, 1)}`);
    }
    assert.deepEqual(deps.asked.fetches, [{ url: "http://gateway.internal:8081/admin/health", authorization: `Bearer ${ENV.GATEWAY_ADMIN_TOKEN}` }]);
    assert.deepEqual(deps.asked.engine, [
      ["docker", "version", "--format", "{{.Server.Version}}"],
      ["docker", "image", "inspect", "--format", "{{.Id}}", "ghcr.io/example/curule:1"],
      ["docker", "network", "inspect", "--format", "{{.Internal}}", "curule-workspaces"],
    ]);
    const { lines, problems, warnings } = describePreflight(findings);
    assert.deepEqual([problems, warnings], [0, 0]);
    assert.ok(lines.every((l) => l.startsWith("ok       ") || l.startsWith("warning  ") || l.startsWith("PROBLEM  ")));
    for (const secret of [ENV.GATEWAY_ADMIN_TOKEN, ENV.CONTROL_SECRET, ENV.SMTP_PASSWORD]) assert.ok(!lines.join("\n").includes(secret), "no secret is shown");
  });
});

test("a configuration that is not valid is said so, line by line, and nothing else is looked at", async () => {
  await using(workdir((raw) => ((raw.app_url = "ftp://nope"), delete raw.plans)), async (w) => {
    const deps = world();
    const findings = await run(w, deps);
    assert.ok(findings.length >= 3);
    assert.ok(findings.every((f) => f.level === "problem"));
    assert.match(findings[0]!.text, /app_url/);
    assert.equal(findings.at(-1)!.text, "the configuration is not valid, so nothing else was looked at");
    assert.deepEqual([deps.asked.fetches, deps.asked.engine, deps.asked.connects], [[], [], []], "nothing was asked of anything");
  });
});

test("what the configuration itself warns of is carried into the list, as warnings", async () => {
  await using(workdir((raw) => (deployed(raw), (raw.owner = { host: "0.0.0.0", port: 7501, token_env: "CONTROL_OWNER_TOKEN" }))), async (w) => {
    const findings = await run(w, world({ dns: KNOWN }));
    assert.ok(hasWarning(findings, /the owner API listens on every interface/));
  });
});

// ---- the folders ----

test("a folder the service writes in, and one it cannot, are told apart by making a file there, and the file is not left", async () => {
  await using(workdir(deployed), async (w) => {
    fs.mkdirSync(path.join(w.dir, "data"), { recursive: true });
    const found = await run(w, world({ dns: KNOWN }));
    assert.ok(hasOk(found, /^the control log can be written: .*data$/), "a folder that is there is not said to be made later");
    assert.deepEqual(fs.readdirSync(path.join(w.dir, "data")), [], "the file made to try was removed");
  });
  await using(
    workdir((raw) => {
      deployed(raw);
      raw.control_log = "./blocked/control.jsonl";
      raw.mail.spool = "./blocked/mail";
    }),
    async (w) => {
      fs.writeFileSync(path.join(w.dir, "blocked"), "a file where a folder is needed");
      const findings = await run(w, world({ dns: KNOWN }));
      assert.ok(hasProblem(findings, /^the control log cannot be written: .*blocked refuses a new file \(ENOTDIR\), and the service needs .*blocked$/));
      assert.ok(hasProblem(findings, /^the mail spool cannot be written: /));
    },
  );
});

test("a trial's own folders are looked at too: the workspaces' folder, and the outbox where there is no mail server", async () => {
  await using(
    workdir((raw) => {
      trial(raw);
      raw.mail = { outbox: "./data/outbox.jsonl" };
    }),
    async (w) => {
      const findings = await run(w, world());
      assert.ok(hasOk(findings, /^the mail outbox can be written: /));
      assert.ok(hasOk(findings, /^the workspaces' folder can be written: /));
      assert.ok(hasWarning(findings, /^workspaces run as child processes of this one: that is for a trial/));
      assert.ok(hasWarning(findings, /^mail is written to .*outbox\.jsonl and not sent/));
    },
  );
});

// ---- the model gateway ----

test("a gateway that is not there is a problem that says where it looked", async () => {
  await using(workdir(deployed), async (w) => {
    const findings = await run(w, world({ dns: KNOWN, gateway: new Error("connect ECONNREFUSED 10.0.0.9:8081") }));
    assert.ok(hasProblem(findings, /^the model gateway's admin API at http:\/\/gateway\.internal:8081 could not be reached \(connect ECONNREFUSED 10\.0\.0\.9:8081\): no workspace can be given a key until it can$/));
    assert.ok(!hasOk(findings, /model gateway/));
  });
});

test("a gateway that refuses the admin token says so, and which setting names the token", async () => {
  await using(workdir(deployed), async (w) => {
    for (const status of [401, 403]) {
      const findings = await run(w, world({ dns: KNOWN, gateway: { status, body: { error: "no" } } }));
      assert.ok(hasProblem(findings, new RegExp(`refuses the admin token \\(it answered ${status}\\): the token in the environment variable named by gateway\\.admin_token_env is not the one the gateway was started with`)), String(status));
    }
  });
});

test("a gateway that answers something else, or says it is not well, or cannot write its ledger, is a problem in its own words", async () => {
  await using(workdir(deployed), async (w) => {
    const notFound = await run(w, world({ dns: KNOWN, gateway: { status: 404 } }));
    assert.ok(hasProblem(notFound, /answered 404 to its health check: this is not the gateway's admin API, or it is an older one/));
    const broken = await run(w, world({ dns: KNOWN, gateway: { status: 500 } }));
    assert.ok(hasProblem(broken, /answered 500 to its health check: it is not well/));
    const down = await run(w, world({ dns: KNOWN, gateway: { status: 200, body: { ...HEALTHY, ok: false, writable: false } } }));
    assert.ok(hasProblem(down, /says it is not well: it cannot write its ledger, and so cannot let a call through/));
    const odd = await run(w, world({ dns: KNOWN, gateway: { status: 200, body: "this is not json" } }));
    assert.ok(hasProblem(odd, /says it is not well$/));
  });
});

test("a tier a plan promises that the gateway does not have is a problem that names the plan, the tier and what the gateway has", async () => {
  await using(workdir(deployed), async (w) => {
    const findings = await run(w, world({ dns: KNOWN, gateway: { status: 200, body: { ...HEALTHY, tiers: ["fast"] } } }));
    assert.deepEqual(said(findings, "problem"), ["the plan 'team' lets a workspace use the tier 'balanced', and the gateway has no such tier (it has: fast): a workspace on that plan could not be given a key"]);
    assert.ok(!hasOk(findings, /every tier a plan names/));
    const none = await run(w, world({ dns: KNOWN, gateway: { status: 200, body: { ...HEALTHY, tiers: [] } } }));
    assert.equal(said(none, "problem").length, 2);
    assert.ok(hasProblem(none, /it has: none\)/));
  });
});

test("a gateway that keeps its ledger in another currency than the plans are sold in is a warning, and one in the same currency is not", async () => {
  await using(workdir(deployed), async (w) => {
    const findings = await run(w, world({ dns: KNOWN, gateway: { status: 200, body: { ...HEALTHY, currency: "EUR" } } }));
    assert.deepEqual(said(findings, "warning"), ["the gateway keeps its ledger in EUR and the plans are sold in USD: the usage a plan includes is granted in the gateway's currency, and the two are not converted"]);
  });
});

test("the address workspaces call for models that does not accept a connection from here is a warning, with the reason, and not a problem", async () => {
  await using(workdir(deployed), async (w) => {
    const findings = await run(w, world({ dns: KNOWN, noConnect: { "gateway.internal:8080": "getaddrinfo ENOTFOUND gateway.internal" } }));
    assert.deepEqual(said(findings, "problem"), []);
    assert.ok(hasWarning(findings, /^gateway\.internal:8080, the address workspaces call for models, did not accept a connection from here \(getaddrinfo ENOTFOUND gateway\.internal\): a workspace reaches it from its own network/));
  });
  await using(workdir((raw) => (deployed(raw), (raw.gateway.tenant_url = "https://models.curule.example/v1"))), async (w) => {
    const deps = world({ dns: KNOWN });
    await run(w, deps);
    assert.ok(deps.asked.connects.includes("models.curule.example:443"), "an https address with no port is 443");
  });
  await using(workdir((raw) => (deployed(raw), (raw.gateway.tenant_url = "http://models.curule.example/v1"))), async (w) => {
    const deps = world({ dns: KNOWN });
    await run(w, deps);
    assert.ok(deps.asked.connects.includes("models.curule.example:80"), "an http address with no port is 80");
  });
});

// ---- the container engine and its network ----

test("an engine that cannot be run is a problem, with what it said, and nothing more is asked of it", async () => {
  await using(workdir(deployed), async (w) => {
    const deps = world({ dns: KNOWN, engine: { version: { code: 1, stderr: "permission denied while trying to connect to the Docker daemon socket" } } });
    const findings = await run(w, deps);
    assert.ok(hasProblem(findings, /^docker could not be run \(permission denied while trying to connect to the Docker daemon socket\): the control plane starts a workspace by running it, as the user it runs as$/));
    assert.equal(deps.asked.engine.length, 1);
    const missing = await run(w, world({ dns: KNOWN, engine: { version: new Error("spawn docker ENOENT") } }));
    assert.ok(hasProblem(missing, /^docker could not be run: the control plane starts a workspace/));
  });
  await using(workdir((raw) => (deployed(raw), (raw.provisioner.engine = "podman"))), async (w) => {
    const deps = world({ dns: KNOWN });
    await run(w, deps);
    assert.ok(deps.asked.engine.every((c) => c[0] === "podman"), "the engine the configuration names is the one that is asked");
  });
});

test("an image that is not here is a warning, because it is pulled; a network that is not there, or is not internal, is a problem", async () => {
  await using(workdir(deployed), async (w) => {
    const noImage = await run(w, world({ dns: KNOWN, engine: { image: { code: 1, stderr: "No such image" } } }));
    assert.deepEqual(said(noImage, "problem"), []);
    assert.ok(hasWarning(noImage, /^the image ghcr\.io\/example\/curule:1 is not here: it is pulled when the first workspace starts, which makes that start slow, and fails if the registry wants a sign-in$/));
    const noNetwork = await run(w, world({ dns: KNOWN, engine: { network: { code: 1, stderr: "Error: No such network: curule-workspaces" } } }));
    assert.deepEqual(said(noNetwork, "problem"), ["the network curule-workspaces does not exist: make it with `docker network create --internal curule-workspaces`, and put the egress proxy and the gateway on it"]);
    const open = await run(w, world({ dns: KNOWN, engine: { network: { code: 0, stdout: "false\n" } } }));
    assert.deepEqual(said(open, "problem"), ["the network curule-workspaces is not internal: a workspace on it can reach any address this machine can, which is the one thing the network is there to prevent. Make it with `--internal`"]);
    assert.ok(!hasOk(open, /is internal/));
  });
});

test("an egress proxy that does not accept a connection from here is a warning, a deployment with none is a warning, and a proxy address with no port is its scheme's", async () => {
  await using(workdir(deployed), async (w) => {
    const down = await run(w, world({ dns: KNOWN, noConnect: { "egress.curule-workspaces:3128": "getaddrinfo ENOTFOUND egress.curule-workspaces" } }));
    assert.deepEqual(said(down, "problem"), []);
    assert.ok(hasWarning(down, /^the egress proxy egress\.curule-workspaces:3128 did not accept a connection from here \(getaddrinfo ENOTFOUND egress\.curule-workspaces\): a workspace reaches it on the network curule-workspaces, so this is only a problem if this machine is on that network$/));
  });
  await using(workdir((raw) => (deployed(raw), (raw.provisioner.egress_proxy = "https://proxy.curule.example"))), async (w) => {
    const deps = world({ dns: KNOWN });
    await run(w, deps);
    assert.ok(deps.asked.connects.includes("proxy.curule.example:443"));
  });
  await using(workdir((raw) => (deployed(raw), delete raw.provisioner.egress_proxy)), async (w) => {
    const findings = await run(w, world({ dns: KNOWN }));
    assert.ok(hasWarning(findings, /^no egress proxy: a workspace can reach any address its network allows$/));
  });
});

// ---- the names, the listeners and the mail ----

test("a name that does not resolve is a warning that says which record is missing, and a name of this machine needs none", async () => {
  await using(workdir(deployed), async (w) => {
    const none = await run(w, world({}));
    assert.deepEqual(said(none, "problem"), []);
    assert.ok(hasWarning(none, /^app\.curule\.example does not resolve \(getaddrinfo ENOTFOUND app\.curule\.example\): customers cannot reach the app until it does$/));
    assert.ok(hasWarning(none, /^preflight-check\.curule-ws\.example does not resolve \(getaddrinfo ENOTFOUND preflight-check\.curule-ws\.example\): a workspace is served at <name>\.curule-ws\.example, so that domain needs a wildcard record and a wildcard certificate$/));
  });
  await using(workdir((raw) => (deployed(raw), (raw.app_url = "http://localhost:7500"), (raw.workspaces = { domain: "localhost" }))), async (w) => {
    const findings = await run(w, world());
    assert.ok(hasOk(findings, /^the app is at localhost, a name of this machine: it needs no record$/));
    assert.ok(hasOk(findings, /^workspaces are served at <name>\.localhost, which this machine resolves by itself$/));
  });
});

test("a listener that cannot be had is a warning with the reason, since the service may be running there already; a port of 0 is not tried", async () => {
  await using(workdir(deployed), async (w) => {
    const findings = await run(w, world({ dns: KNOWN, noListen: { "127.0.0.1:7500": "listen EADDRINUSE: address already in use 127.0.0.1:7500" } }));
    assert.deepEqual(said(findings, "problem"), []);
    assert.ok(hasWarning(findings, /^the public listener could not listen on 127\.0\.0\.1:7500 \(listen EADDRINUSE: address already in use 127\.0\.0\.1:7500\): fine if the service is already running there, and a problem if something else is$/));
    assert.ok(hasOk(findings, /^the owner listener can listen on 127\.0\.0\.1:7501$/));
  });
  await using(workdir((raw) => (deployed(raw), (raw.public = { host: "127.0.0.1", port: 0 }), (raw.owner = { host: "127.0.0.1", port: 0, token_env: "CONTROL_OWNER_TOKEN" }))), async (w) => {
    const deps = world({ dns: KNOWN });
    await run(w, deps);
    assert.deepEqual(deps.asked.listens, []);
  });
});

test("mail is proved by sending a message when there is an address to send it to, and what the server said is the answer", async () => {
  const server: FakeOptions = { features: ["AUTH PLAIN"], credentials: { user: ENV.SMTP_USER, password: ENV.SMTP_PASSWORD } };
  const smtp = await FakeSmtp.start(server);
  const toIt = (raw: Record<string, any>): void => {
    deployed(raw);
    raw.mail = { smtp: { host: "127.0.0.1", port: smtp.port, security: "none", user_env: "SMTP_USER", password_env: "SMTP_PASSWORD", from: "Curule <no-reply@curule.example>" } };
  };
  try {
    await using(workdir(toIt), async (w) => {
      const sent = await run(w, world({ dns: KNOWN }), "ada@example.com");
      assert.ok(hasOk(sent, new RegExp(`^127\\.0\\.0\\.1:${smtp.port} accepted a message for ada@example\\.com: look for it in the inbox, and in the spam folder$`)));
      assert.equal(smtp.accepted.length, 1);
      assert.equal(smtp.accepted[0]!.user, ENV.SMTP_USER);
      const refused = await run(w, world({ dns: KNOWN }), "not an address");
      assert.ok(hasProblem(refused, /^'not an address' is not an address mail can be sent to/));
      const wrong = await run(w, world({ dns: KNOWN }), "ada@example.com", { ...ENV, SMTP_PASSWORD: "not the password" });
      assert.ok(hasProblem(wrong, /did not take a message for ada@example\.com: the server answered 535 5\.7\.8 credentials rejected \(to the sign-in\)$/));
      assert.equal(smtp.accepted.length, 1, "nothing more was sent");
    });
  } finally {
    await smtp.stop();
  }
});

test("a message that is not asked for is not sent", async () => {
  const smtp = await FakeSmtp.start({});
  try {
    await using(
      workdir((raw) => {
        deployed(raw);
        raw.mail = { smtp: { host: "127.0.0.1", port: smtp.port, security: "none", from: "no-reply@curule.example" } };
      }),
      async (w) => {
        await run(w, world({ dns: KNOWN }));
        assert.equal(smtp.transcripts.length, 0, "the mail server was not spoken to");
      },
    );
  } finally {
    await smtp.stop();
  }
});

test("how payments are taken is said, with the address a provider is to send its messages to", async () => {
  await using(
    workdir((raw) => {
      deployed(raw);
      raw.billing = { provider: "hosted-checkout", api_key_env: "BILLING_API_KEY", webhook_secret_env: "BILLING_WEBHOOK_SECRET" };
      raw.plans = "./priced.yaml";
    }),
    async (w) => {
      fs.writeFileSync(path.join(w.dir, "priced.yaml"), stringify(pricedCatalogue()));
      const findings = await run(w, world({ dns: KNOWN }), undefined, { ...ENV, BILLING_API_KEY: "sk_test_x", BILLING_WEBHOOK_SECRET: "whsec_xxxxxxxx" });
      assert.deepEqual(said(findings, "problem"), []);
      assert.ok(hasOk(findings, /^payments are by a hosted checkout: the provider is to send its messages to https:\/\/app\.curule\.example\/webhooks\/billing, and the signing secret it gives for them is the one in the environment variable that billing\.webhook_secret_env names$/));
      assert.ok(!said(findings, "ok").join("\n").includes("whsec_xxxxxxxx"));
    },
  );
});

test("workspace licences: a key the build trusts is said to be, and a configuration without one carries its own warning", async () => {
  await using(workdir(trialDeployed), async (w) => {
    const findings = await run(w, world({ dns: KNOWN }));
    assert.deepEqual(said(findings, "warning"), ["no licence key: workspaces run on the Community plan's limits"]);
    assert.ok(!hasOk(findings, /workspace licences are signed/));
  });
  await using(workdir(deployed), async (w) => {
    // Without being told which keys to trust, the build's own are used: and a key made for a test is not one of them.
    const findings = await preflight(w.file, ENV, {}, world({ dns: KNOWN }));
    assert.ok(findings.some((f) => f.level === "problem" && /the licence key does not verify \(this build trusts no public key 'k1'/.test(f.text)));
  });
});

// ---- the command ----

function io(): Io & { stdout: string[]; stderr: string[]; signals: EventEmitter } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (l) => void stdout.push(l), err: (l) => void stderr.push(l), signals: new EventEmitter() };
}

test("the usage names the preflight", () => {
  assert.match(USAGE, /preflight --config <control\.yaml> \[--mail-to <address>\]\s+look at what the configuration points at/);
});

test("the command prints each finding, ends with how many problems and warnings there were, and exits 1 only when there is a problem", async () => {
  await using(workdir(trialDeployed), async (w) => {
    const good = io();
    assert.equal(await main(["preflight", "--config", w.file], ENV, good, undefined, undefined, undefined, world({ dns: KNOWN })), 0);
    assert.equal(good.stderr.length, 0);
    assert.equal(good.stdout.at(-1), "preflight found no problem and 1 warning to read", "the key that is not there is the one warning");
    assert.ok(good.stdout.some((l) => l.startsWith("ok       the model gateway")));
    assert.ok(good.stdout.some((l) => l.startsWith("warning  no licence key: workspaces run on the Community plan's limits")));

    const bad = io();
    assert.equal(await main(["preflight", `--config=${w.file}`], ENV, bad, undefined, undefined, undefined, world({ dns: KNOWN, gateway: { status: 401 }, engine: { network: { code: 0, stdout: "false" } } })), 1);
    assert.equal(bad.stdout.at(-1), "preflight found 2 problems and 1 warning: the service would fail a customer");
    assert.equal(bad.stdout.filter((l) => l.startsWith("PROBLEM  ")).length, 2);

    const one = io();
    assert.equal(await main(["preflight", "--config", w.file], ENV, one, undefined, undefined, undefined, world({ dns: KNOWN, gateway: { status: 401 } })), 1);
    assert.equal(one.stdout.at(-1), "preflight found 1 problem and 1 warning: the service would fail a customer");

    const quiet = io();
    assert.equal(
      await main(["preflight", "--config", w.file], ENV, quiet, undefined, undefined, undefined, world({ dns: KNOWN })),
      0,
    );
    assert.doesNotMatch(quiet.stdout.join("\n"), /\n\n/);
  });
});

test("a command line that cannot be run says why and shows the usage", async () => {
  for (const [args, message] of [
    [["preflight"], "--config is required"],
    [["preflight", "--config", "x.yaml", "--frobnicate"], "unknown option '--frobnicate'"],
    [["preflight", "--config", "x.yaml", "--mail-to"], "--mail-to needs an address"],
    [["preflight", "--config", "x.yaml", "--mail-to="], "--mail-to needs an address"],
  ] as const) {
    const out = io();
    assert.equal(await main([...args], ENV, out), 1, args.join(" "));
    assert.equal(out.stderr.join("\n"), `curule-cloud preflight: ${message}\n${USAGE}`);
    assert.deepEqual(out.stdout, []);
  }
  const missing = io();
  assert.equal(await main(["preflight", "--config", "/nonexistent/control.yaml"], ENV, missing, undefined, undefined, undefined, world()), 1);
  assert.match(missing.stdout[0]!, /^PROBLEM  cannot read the control-plane configuration/);
  assert.equal(missing.stdout.at(-1), "preflight found 2 problems and 0 warnings: the service would fail a customer");
});
