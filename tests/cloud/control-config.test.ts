import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify } from "yaml";
import { describeControl, loadControlConfig, loadMailConfig, type ControlConfig } from "../../packages/cloud/src/index";
import { generateLicenseKeyPair } from "../../packages/licensing/src/index";
import { ENV, pricedCatalogue, trial, workdir, type Workdir } from "./control-support";

const load = (w: Workdir, env: NodeJS.ProcessEnv = ENV, publicKeys: Record<string, string> = { k1: w.publicKey }): ControlConfig => loadControlConfig(w.file, env, { publicKeys });

/** What loading refuses with. */
function refusal(w: Workdir, env: NodeJS.ProcessEnv = ENV, publicKeys?: Record<string, string>): string {
  try {
    load(w, env, publicKeys);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("it loaded");
}

/** A directory for a test that is removed when the test is over. */
function using<T>(w: Workdir, run: (w: Workdir) => T): T {
  try {
    return run(w);
  } finally {
    w.done();
  }
}

// ---- a configuration that is right ----

test("a valid configuration is read as it was meant: addresses as origins, paths from the file, secrets from the environment, and nothing warned of", () => {
  using(workdir(), (w) => {
    const c = load(w);
    assert.equal(c.appUrl, "https://app.curule.example");
    assert.equal(c.appHost, "app.curule.example");
    assert.deepEqual(c.workspaces, { domain: "curule-ws.example", scheme: "https" });
    assert.equal(c.production, true);
    assert.deepEqual(c.public, { host: "127.0.0.1", port: 0, trustProxyHops: 1 });
    assert.deepEqual(c.owner, { host: "127.0.0.1", port: 0, token: ENV.CONTROL_OWNER_TOKEN });
    assert.equal(c.pagesDir, path.join(w.dir, "pages"));
    assert.equal(c.logPath, path.join(w.dir, "data", "control.jsonl"));
    assert.equal(c.outboxPath, "", "mail is delivered, and not written to a file");
    assert.deepEqual(c.smtp, { host: "smtp.mail.example", port: 587, security: "starttls", user: ENV.SMTP_USER, password: ENV.SMTP_PASSWORD, from: "Curule <no-reply@curule.example>", spoolDir: path.join(w.dir, "data", "mail") });
    assert.equal(c.plansPath, path.join(w.dir, "plans.yaml"));
    assert.deepEqual(c.catalogue.plans().map((p) => p.id), ["team", "business", "yearly"]);
    assert.equal(c.secret, ENV.CONTROL_SECRET);
    assert.deepEqual(c.gateway, { adminUrl: "http://gateway.internal:8081", adminToken: ENV.GATEWAY_ADMIN_TOKEN, tenantUrl: "http://gateway.internal:8080/v1" });
    assert.deepEqual([c.licence?.kid, c.licence?.privateKey], ["k1", w.privateKeyPem]);
    assert.deepEqual(c.provisioner, { kind: "container", engine: "docker", image: "ghcr.io/example/curule:1", network: "curule-workspaces", egressProxy: "http://egress.curule-workspaces:3128/", noProxy: [], limits: { cpus: 1, memoryMb: 2048, pids: 512 } });
    assert.deepEqual(c.billing, { provider: "manual", payUrl: "https://app.curule.example/pay?ref={ref}" });
    assert.equal(c.reconcileMinutes, 15);
    assert.deepEqual(c.warnings, []);
  });
});

test("what is left out takes its default: listeners on the loopback, no proxy hops, a docker engine, resources, and a check every fifteen minutes", () => {
  using(
    workdir((raw) => {
      delete raw.public;
      delete raw.pages;
      delete raw.reconcile_minutes;
      delete raw.provisioner.limits;
      raw.owner = { token_env: "CONTROL_OWNER_TOKEN" };
    }),
    (w) => {
      const c = load(w);
      assert.deepEqual(c.public, { host: "127.0.0.1", port: 7500, trustProxyHops: 0 });
      assert.deepEqual(c.owner, { host: "127.0.0.1", port: 7501, token: ENV.CONTROL_OWNER_TOKEN });
      assert.equal(c.pagesDir, undefined);
      assert.equal(c.reconcileMinutes, 15);
      assert.deepEqual(c.provisioner.limits, { cpus: 1, memoryMb: 2048, pids: 512 });
      assert.deepEqual(c.warnings, ["public.trust_proxy_hops is 0 on a service behind TLS: the caller's address will be the proxy's, and every customer will share one rate limit"]);
    },
  );
});

test("a trial on one machine is http on localhost, with workspaces beside it, local processes, no licence key needed and the port carried into workspace addresses", () => {
  using(
    workdir((raw) => {
      raw.app_url = "http://localhost:7500";
      raw.workspaces = { domain: "localhost" };
      raw.provisioner = { kind: "local", base_dir: "./workspaces", host_command: ["node", "dist/apps/mesh-cli/src/index.js"] };
      delete raw.licence;
      raw.billing = { provider: "manual", pay_url: "http://localhost:7500/pay?ref={ref}" };
    }),
    (w) => {
      const c = load(w);
      assert.deepEqual([c.appHost, c.production, c.workspaces], ["localhost", false, { domain: "localhost", scheme: "http", port: 7500 }]);
      assert.deepEqual(c.provisioner, { kind: "local", baseDir: path.join(w.dir, "workspaces"), hostCommand: ["node", "dist/apps/mesh-cli/src/index.js"], limits: { cpus: 1, memoryMb: 2048, pids: 512 } });
      assert.equal(c.licence, undefined);
      assert.deepEqual(c.warnings, ["no licence key: workspaces run on the Community plan's limits"]);
    },
  );
});

test("an address with its default port is the origin without it, and a trailing slash is no path", () => {
  using(workdir((raw) => (raw.app_url = "https://app.curule.example:443/")), (w) => {
    const c = load(w);
    assert.equal(c.appUrl, "https://app.curule.example");
    assert.equal(c.workspaces.port, undefined);
  });
  using(workdir((raw) => (raw.app_url = "https://App.Curule.Example:8443")), (w) => {
    const c = load(w);
    assert.deepEqual([c.appUrl, c.appHost, c.workspaces.port], ["https://app.curule.example:8443", "app.curule.example", 8443]);
  });
});

test("the example configuration that ships is valid once its key is where it says, the build trusts that key, and the places its pages mark for the operator are decided", () => {
  const keys = generateLicenseKeyPair();
  const root = path.join(__dirname, "..", "..", "..");
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "control-example-"));
  try {
    // The layout the example is written for: it names the product's own pages relative to where it is.
    const here = path.join(dir, "examples", "cloud");
    fs.mkdirSync(path.join(here, "secrets"), { recursive: true });
    for (const f of ["control.yaml", "plans.yaml"]) fs.copyFileSync(path.join(root, "examples", "cloud", f), path.join(here, f));
    const pages = path.join(dir, "apps", "cloud-server", "pages");
    fs.cpSync(path.join(root, "apps", "cloud-server", "pages"), pages, { recursive: true });
    fs.writeFileSync(path.join(here, "secrets", "licence-k1.pem"), keys.privateKeyPem);
    const file = path.join(here, "control.yaml");
    const load = (publicKeys: Record<string, string> = { k1: keys.publicKey }): ControlConfig => loadControlConfig(file, ENV, { publicKeys });

    // As it ships, the pages carry places for the operator, and a production service is not started on them.
    assert.throws(load, /the pages in '[^']*pages' have \d+ places marked TODO\(owner\)/);
    for (const f of ["terms.html", "privacy.html", path.join("assets", "app.js")]) fs.writeFileSync(path.join(pages, f), fs.readFileSync(path.join(pages, f), "utf8").replace(/TODO\(owner\)/g, "decided"));

    const c = load();
    assert.equal(c.appHost, "app.curule.example");
    assert.equal(c.pagesDir, pages, "the pages are the product's own");
    assert.deepEqual(c.warnings, []);
    assert.ok(describeControl(c).length > 8);
    assert.throws(() => load({}), /this build trusts no public key 'k1'/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- what is refused ----

test("every problem is reported at once, each with the file it is in", () => {
  using(
    workdir((raw) => {
      raw.app_url = "ftp://app";
      delete raw.workspaces;
      raw.owner = {};
      delete raw.plans;
      delete raw.secret_env;
      raw.gateway = { admin_url: "nope" };
      raw.provisioner = { kind: "vm" };
      raw.billing = { provider: "barter" };
      raw.reconcile_minutes = 0;
    }),
    (w) => {
      const message = refusal(w);
      const lines = message.split("\n");
      assert.ok(lines.length >= 10, message);
      assert.ok(lines.every((l) => l.startsWith(w.file)), "each line says which file");
      for (const expected of [
        /app_url 'ftp:\/\/app' is not an http or https address/,
        /workspaces must be a mapping with a domain/,
        /owner.token_env must name the environment variable that holds the owner token/,
        /plans is required/,
        /secret_env must name the environment variable that holds the service secret/,
        /gateway.admin_url 'nope' is not an http or https address/,
        /gateway.admin_token_env must name/,
        /gateway.tenant_url is required/,
        /provisioner.kind must be container or local \(got "vm"\)/,
        /billing.provider must be manual or hosted-checkout \(got "barter"\)/,
        /reconcile_minutes must be a whole number from 1 to 1440 \(got 0\)/,
      ]) {
        assert.match(message, expected);
      }
    },
  );
});

test("a file that cannot be read, or is not a mapping, is refused in its own words", () => {
  assert.throws(() => loadControlConfig("/nonexistent/control.yaml", ENV), /cannot read the control-plane configuration \/nonexistent\/control\.yaml/);
  using(workdir(), (w) => {
    fs.writeFileSync(w.file, "- a\n- list\n");
    assert.throws(() => load(w), /expected a mapping with app_url, workspaces, gateway, plans and billing/);
    fs.writeFileSync(w.file, "app_url: [unclosed\n");
    assert.throws(() => load(w), /cannot read the control-plane configuration/);
  });
});

test("an address for the app is an origin, and not a path, a query, credentials or another scheme", () => {
  const cases: Array<[unknown, RegExp]> = [
    [undefined, /app_url is required/],
    ["", /app_url is required/],
    ["app.example.com", /is not an http or https address/],
    ["https://app.example.com/dashboard", /must be an address with no path, query or credentials/],
    ["https://app.example.com/?x=1", /no path, query or credentials/],
    ["https://user:pw@app.example.com", /no path, query or credentials/],
    ["https://app.example.com/#top", /no path, query or credentials/],
  ];
  for (const [value, expected] of cases) {
    using(workdir((raw) => (raw.app_url = value)), (w) => assert.match(refusal(w), expected, String(value)));
  }
});

test("workspaces are served from a domain of their own: not the app's host, not above or below it, and not under its registrable domain", () => {
  const cases: Array<[string, string, RegExp | null]> = [
    ["https://app.curule.example", "curule-ws.example", null],
    ["https://app.curule.example", "app.curule.example", /must not be the app's host/],
    ["https://app.curule.example", "curule.example", /or above it or below it/],
    ["https://curule.example", "ws.curule.example", /or above it or below it/],
    ["https://app.curule.example", "ws.curule.example", /same registrable domain/],
    ["https://app.curule.example", "x.ws.curule.example", /same registrable domain/],
    ["https://curule.example", "run.example", null],
    ["http://localhost:7500", "localhost", null],
    ["http://app.localhost:7500", "ws.localhost", null],
    ["https://app.curule.example", "not a domain", /is not a domain name/],
    ["https://app.curule.example", "-bad.example", /is not a domain name/],
  ];
  for (const [app, domain, expected] of cases) {
    using(
      workdir((raw) => {
        raw.app_url = app;
        raw.workspaces = { domain };
        if (!app.startsWith("https")) {
          raw.provisioner = { kind: "local", base_dir: "./w", host_command: ["node"] };
          delete raw.licence;
          raw.billing = { provider: "manual", pay_url: "http://localhost:7500/pay?ref={ref}" };
        }
      }),
      (w) => {
        if (expected === null) assert.doesNotThrow(() => load(w), `${app} with ${domain}`);
        else assert.match(refusal(w), expected, `${app} with ${domain}`);
      },
    );
  }
});

test("a plan whose provider price id is still the example's placeholder is refused in production and warned of in a trial, and only where hosted checkout uses the id", () => {
  const hosted = (raw: Record<string, any>): void => {
    raw.billing = { provider: "hosted-checkout", api_key_env: "BILLING_API_KEY", webhook_secret_env: "BILLING_WEBHOOK_SECRET" };
  };
  const env = { ...ENV, BILLING_API_KEY: "sk_test_0123456789", BILLING_WEBHOOK_SECRET: "whsec_0123456789" };
  const withIds = (ids: Record<string, string>) => {
    const catalogue = pricedCatalogue();
    for (const [plan, id] of Object.entries(ids)) catalogue.plans[plan].provider_price_id = id;
    return catalogue;
  };
  using(workdir(hosted, withIds({ team: "price_REPLACE_WITH_THE_PROVIDERS_ID", business: "price_1Real" })), (w) => {
    const m = refusal(w, env);
    assert.match(m, /plan 'team' has provider_price_id 'price_REPLACE_WITH_THE_PROVIDERS_ID', which is still the example's placeholder: put the provider's own id for this price there/);
    assert.doesNotMatch(m, /plan 'business'/, "only the plan that still has it");
    assert.doesNotMatch(m, /plan 'yearly'/);
  });
  using(workdir(hosted, withIds({ team: "price_replace_me" })), (w) => assert.match(refusal(w, env), /plan 'team' has provider_price_id 'price_replace_me'/));
  using(workdir(hosted, withIds({})), (w) => assert.doesNotThrow(() => load(w, env)));
  // A trial only warns: it is on one machine and nothing is sold.
  using(
    workdir((raw) => {
      trial(raw);
      hosted(raw);
    }, withIds({ team: "price_REPLACE_WITH_THE_PROVIDERS_ID" })),
    (w) => assert.match(load(w, env).warnings.join("\n"), /plan 'team' has provider_price_id 'price_REPLACE_WITH_THE_PROVIDERS_ID', which is still the example's placeholder/),
  );
  // Manual billing never sends the id anywhere, so what it says does not matter.
  using(workdir(undefined, withIds({ team: "price_REPLACE_WITH_THE_PROVIDERS_ID" })), (w) => assert.equal(load(w).warnings.filter((x) => x.includes("placeholder")).length, 0));
});

test("a workspace domain under the app's registrable domain is refused until the operator writes, in the file, that they know; then it is a warning that says what stands in the way and what does not", () => {
  const same = (change: (raw: Record<string, any>) => void = () => undefined) =>
    workdir((raw) => {
      raw.app_url = "https://app.curule.example";
      raw.workspaces = { domain: "ws.curule.example" };
      change(raw);
    });
  using(same(), (w) => assert.match(refusal(w), /same registrable domain as the app 'app\.curule\.example'.*or, knowing that, write workspaces\.allow_same_site: true/s));
  using(same((raw) => (raw.workspaces.allow_same_site = false)), (w) => assert.match(refusal(w), /same registrable domain/));
  using(same((raw) => (raw.workspaces.allow_same_site = "yes")), (w) => assert.match(refusal(w), /workspaces\.allow_same_site must be true or false/));
  using(same((raw) => (raw.workspaces.allow_same_site = true)), (w) => {
    const c = load(w);
    assert.deepEqual(c.workspaces, { domain: "ws.curule.example", scheme: "https", allowSameSite: true });
    const said = c.warnings.filter((x) => x.includes("allow_same_site"));
    assert.equal(said.length, 1);
    assert.match(said[0]!, /under the same registrable domain as the app 'app\.curule\.example'/);
    assert.match(said[0]!, /can set cookies for all of curule\.example/);
    assert.match(said[0]!, /SameSite cookies do not hold it back/);
    assert.match(said[0]!, /host-only and prefixed __Host-/);
    assert.match(said[0]!, /must name the app's own address as its Origin/);
    assert.ok(describeControl(c).some((l) => l.startsWith("WARNING: workspaces.domain 'ws.curule.example'")), "and it is shown with what the service would run");
  });
  // It excuses only that. The app's own host, or above or below it, is not made safe by it, and a domain of its own needs it for nothing.
  using(workdir((raw) => ((raw.app_url = "https://app.curule.example"), (raw.workspaces = { domain: "app.curule.example", allow_same_site: true }))), (w) => assert.match(refusal(w), /must not be the app's host/));
  using(workdir((raw) => ((raw.app_url = "https://app.curule.example"), (raw.workspaces = { domain: "curule.example", allow_same_site: true }))), (w) => assert.match(refusal(w), /or above it or below it/));
  using(workdir((raw) => (raw.workspaces = { domain: "curule-ws.example", allow_same_site: true })), (w) => {
    const c = load(w);
    assert.equal("allowSameSite" in c.workspaces, false, "no warning and no flag for a domain that did not need it");
    assert.equal(c.warnings.filter((x) => x.includes("allow_same_site")).length, 0);
  });
});

test("a secret is read from the environment variable the file names, and one that is missing or short stops the start without being written in the message", () => {
  const cases: Array<[string, NodeJS.ProcessEnv, RegExp]> = [
    ["CONTROL_SECRET", { ...ENV, CONTROL_SECRET: "short-secret-0123456789" }, /the environment variable CONTROL_SECRET must hold the service secret of at least 32 characters/],
    ["CONTROL_SECRET", { ...ENV, CONTROL_SECRET: undefined }, /the environment variable CONTROL_SECRET must hold the service secret/],
    ["CONTROL_OWNER_TOKEN", { ...ENV, CONTROL_OWNER_TOKEN: "x".repeat(23) }, /CONTROL_OWNER_TOKEN must hold the owner token of at least 24 characters/],
    ["CONTROL_OWNER_TOKEN", { ...ENV, CONTROL_OWNER_TOKEN: "   " }, /CONTROL_OWNER_TOKEN must hold the owner token/],
    ["GATEWAY_ADMIN_TOKEN", { ...ENV, GATEWAY_ADMIN_TOKEN: "y".repeat(23) }, /GATEWAY_ADMIN_TOKEN must hold the gateway's admin token of at least 24 characters/],
  ];
  for (const [name, env, expected] of cases) {
    using(workdir(), (w) => {
      const message = refusal(w, env);
      assert.match(message, expected, name);
      for (const value of Object.values(env)) if (value && value.trim() !== "") assert.ok(!message.includes(value), `${name}: the value is not in the message`);
    });
  }
  using(workdir(), (w) => assert.equal(load(w, { ...ENV, CONTROL_SECRET: "s".repeat(32) }).secret, "s".repeat(32)));
});

test("the public and owner listeners are not one address, and an owner API open to every interface is allowed and warned of", () => {
  using(workdir((raw) => ((raw.public = { host: "127.0.0.1", port: 7500, trust_proxy_hops: 1 }), (raw.owner = { host: "127.0.0.1", port: 7500, token_env: "CONTROL_OWNER_TOKEN" }))), (w) => {
    assert.match(refusal(w), /public and owner must not listen on the same address: the owner API is not for customers/);
  });
  using(workdir((raw) => ((raw.public = { host: "0.0.0.0", port: 7500, trust_proxy_hops: 1 }), (raw.owner = { host: "127.0.0.1", port: 7500, token_env: "CONTROL_OWNER_TOKEN" }))), (w) => {
    assert.doesNotThrow(() => load(w), "the same port on another address is two listeners");
  });
  using(workdir((raw) => (raw.owner = { host: "0.0.0.0", port: 7501, token_env: "CONTROL_OWNER_TOKEN" })), (w) => {
    assert.match(load(w).warnings.join("\n"), /the owner API listens on every interface \(0\.0\.0\.0\)\. It can record payments and stop customers: keep it off any network a customer can reach/);
  });
  using(workdir((raw) => (raw.owner = { host: "::", port: 7501, token_env: "CONTROL_OWNER_TOKEN" })), (w) => assert.equal(load(w).warnings.length, 1));
  using(workdir((raw) => ((raw.public = { host: "", port: 70000, trust_proxy_hops: 9 }), (raw.owner = { host: "x", port: "7501", token_env: "CONTROL_OWNER_TOKEN" }))), (w) => {
    const m = refusal(w);
    assert.match(m, /public.host must be an address/);
    assert.match(m, /public.port must be a whole number from 0 to 65535 \(got 70000\)/);
    assert.match(m, /public.trust_proxy_hops must be a whole number from 0 to 8 \(got 9\)/);
    assert.match(m, /owner.port must be a whole number from 0 to 65535 \(got "7501"\)/);
  });
});

test("the files it names are checked where they can be: the pages are a directory, the plans are a catalogue, and a catalogue's mistakes are the catalogue's", () => {
  using(workdir((raw) => (raw.pages = "./nonesuch")), (w) => assert.match(refusal(w), /pages '.*nonesuch' is not a directory/));
  using(workdir(), (w) => {
    fs.writeFileSync(path.join(w.dir, "plans.yaml"), "currency: USD\nplans: {}\ntopups: {}\n");
    const m = refusal(w);
    assert.match(m, /plans must list at least one plan/);
    assert.ok(m.split("\n").every((l) => l.startsWith(path.join(w.dir, "plans.yaml"))), "the catalogue's own words, with the catalogue's own file name");
  });
  using(workdir((raw) => delete raw.control_log), (w) => assert.match(refusal(w), /control_log is required/));
  using(workdir((raw) => (raw.mail = {})), (w) => assert.match(refusal(w), /mail.outbox is required, or mail.smtp to deliver mail over SMTP/));
});

/** Pages written into a workdir's pages folder, by path. */
function writePages(w: Workdir, files: Record<string, string>): void {
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(w.dir, "pages", name)), { recursive: true });
    fs.writeFileSync(path.join(w.dir, "pages", name), text);
  }
}

test("pages that still carry a place marked for the operator are not ready to take payments: a problem in production, a warning in a trial, and each place is named", () => {
  const todo = (what: string): string => `<p class="todo">TODO(owner): ${what}</p>\n`;
  using(workdir(), (w) => {
    writePages(w, { "terms.html": "<h1>Terms</h1>\n", "assets/app.js": "const CONTACT = 'x';\n" });
    assert.deepEqual(load(w).warnings, [], "pages with nothing marked are fine");
  });
  using(workdir(), (w) => {
    writePages(w, { "terms.html": `<h1>Terms</h1>\n${todo("the entity")}<p>fine</p>\n${todo("refunds")}`, "assets/app.js": "// fine\nconst CONTACT = \"\"; // TODO(owner): contact\n", "assets/data.bin": "TODO(owner) in a file that is not text is not read" });
    const m = refusal(w);
    assert.match(m, /the pages in '[^']*pages' have 3 places marked TODO\(owner\), for the operator to write or confirm \(assets\/app\.js:2, terms\.html:2, terms\.html:4\)\. The terms and the privacy notice are what a person agrees to when they sign up and pay/);
  });
  using(workdir(), (w) => {
    writePages(w, { "a.html": todo("one") });
    assert.match(refusal(w), /have 1 place marked TODO\(owner\), for the operator to write or confirm \(a\.html:1\)\./, "one place is one place");
  });
  using(workdir(), (w) => {
    writePages(w, { "terms.html": Array.from({ length: 6 }, (_v, i) => todo(`item ${i}`)).join("") });
    assert.match(refusal(w), /have 6 places marked TODO\(owner\), for the operator to write or confirm \(terms\.html:1, terms\.html:2, terms\.html:3, terms\.html:4, and 2 more\)\./, "four are named and the rest are counted");
  });
  // On one machine, over http, the pages are a draft and are said to be: it is a warning, shown by the check.
  using(workdir(trial), (w) => {
    writePages(w, { "terms.html": todo("the entity") });
    const c = load(w);
    assert.equal(c.production, false);
    const marked = c.warnings.filter((x) => x.includes("TODO(owner)"));
    assert.equal(marked.length, 1);
    assert.match(marked[0]!, /have 1 place marked TODO\(owner\)/);
    assert.ok(describeControl(c).some((l) => l.startsWith("WARNING: the pages in ") && l.includes("TODO(owner)")));
  });
  // No pages, or no pages directory named, has nothing to mark.
  using(workdir((raw) => delete raw.pages), (w) => assert.deepEqual(load(w).warnings, []));
});

test("the model gateway is named by its admin address and the address workspaces call, which ends in /v1", () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ tenant_url: "http://gateway.internal:8080" }, /gateway.tenant_url 'http:\/\/gateway.internal:8080' must end in \/v1/],
    [{ tenant_url: "http://gateway.internal:8080/v2" }, /must end in \/v1/],
    [{ tenant_url: "gateway" }, /gateway.tenant_url 'gateway' is not an http or https address/],
    [{ admin_url: "" }, /gateway.admin_url is required/],
    [{ admin_token_env: "" }, /gateway.admin_token_env must name the environment variable that holds the gateway's admin token/],
    [{ admin_token_env: "NOT_SET" }, /the environment variable NOT_SET must hold the gateway's admin token of at least 24 characters/],
  ];
  for (const [change, expected] of cases) using(workdir((raw) => Object.assign(raw.gateway, change)), (w) => assert.match(refusal(w), expected, JSON.stringify(change)));
  using(workdir((raw) => Object.assign(raw.gateway, { admin_url: "http://gateway.internal:8081/", tenant_url: "http://gateway.internal:8080/v1/" })), (w) => {
    assert.deepEqual([load(w).gateway.adminUrl, load(w).gateway.tenantUrl], ["http://gateway.internal:8081", "http://gateway.internal:8080/v1"]);
  });
});

// ---- provisioning ----

test("a container provisioner needs an image and a network, takes docker or podman, and says what it does not have: an egress proxy", () => {
  using(workdir((raw) => ((raw.provisioner = { kind: "container" }))), (w) => {
    const m = refusal(w);
    assert.match(m, /provisioner.image is required/);
    assert.match(m, /provisioner.network is required/);
  });
  using(workdir((raw) => Object.assign(raw.provisioner, { engine: "podman", no_proxy: ["gateway.internal", "10.0.0.5"] })), (w) => {
    const p = load(w).provisioner;
    assert.ok(p.kind === "container" && p.engine === "podman");
    assert.deepEqual(p.kind === "container" && p.noProxy, ["gateway.internal", "10.0.0.5"]);
  });
  using(workdir((raw) => Object.assign(raw.provisioner, { engine: "lxc", no_proxy: "x", egress_proxy: "squid" })), (w) => {
    const m = refusal(w);
    assert.match(m, /provisioner.engine must be docker or podman/);
    assert.match(m, /provisioner.no_proxy must be a list of hosts/);
    assert.match(m, /provisioner.egress_proxy 'squid' is not an http or https address/);
  });
  using(workdir((raw) => delete raw.provisioner.egress_proxy), (w) => {
    assert.match(load(w).warnings.join("\n"), /provisioner.egress_proxy is not set: a workspace can reach any address its network allows/);
  });
  using(workdir((raw) => Object.assign(raw.provisioner, { limits: { cpus: 0.01, memory_mb: 64, pids: 8 } })), (w) => {
    const m = refusal(w);
    assert.match(m, /provisioner.limits.cpus must be a number from 0.1 to 64/);
    assert.match(m, /provisioner.limits.memory_mb must be a whole number from 128 to 262144 \(got 64\)/);
    assert.match(m, /provisioner.limits.pids must be a whole number from 32 to 100000 \(got 8\)/);
  });
  using(workdir((raw) => Object.assign(raw.provisioner, { limits: { cpus: 0.5, memory_mb: 512, pids: 64 } })), (w) => assert.deepEqual(load(w).provisioner.limits, { cpus: 0.5, memoryMb: 512, pids: 64 }));
});

test("a container provisioner may be told the network's subnet, so that each workspace is given an address of its own there, and a subnet that cannot be used is refused", () => {
  using(workdir(), (w) => assert.equal("subnet" in load(w).provisioner, false, "without one, a workspace is reached by its container's name"));
  using(workdir((raw) => (raw.provisioner.subnet = "10.213.0.0/24")), (w) => {
    const p = load(w).provisioner;
    assert.ok(p.kind === "container" && p.subnet === "10.213.0.0/24");
    assert.match(describeControl(load(w)).join("\n"), /on the network curule-workspaces \(each at an address of its own in 10\.213\.0\.0\/24\), with 1 CPU/);
  });
  for (const [subnet, why] of [
    ["10.213.0.1/24", /provisioner\.subnet: '10\.213\.0\.1\/24' is not the start of a \/24: did you mean 10\.213\.0\.0\/24\?/],
    ["10.213.0.0/8", /provisioner\.subnet: '10\.213\.0\.0\/8' is not an IPv4 subnet from \/16 to \/29/],
    ["curule-workspaces", /provisioner\.subnet: 'curule-workspaces' is not an IPv4 subnet/],
    [24, /provisioner\.subnet must be the network's subnet, like 10\.213\.0\.0\/24/],
  ] as const) {
    using(workdir((raw) => (raw.provisioner.subnet = subnet)), (w) => assert.match(refusal(w), why, String(subnet)));
  }
  using(workdir((raw) => ((raw.provisioner = { kind: "local", base_dir: "./w", host_command: ["node"], subnet: "10.213.0.0/24" }), (raw.app_url = "http://localhost:7500"), (raw.workspaces = { domain: "localhost" }), delete raw.licence, (raw.billing = { provider: "manual", pay_url: "http://localhost/pay?ref={ref}" }))), (w) => {
    assert.equal("subnet" in load(w).provisioner, false, "a local process has no address on a network: the key means nothing to it, and is not carried");
  });
});

test("the local provisioner is refused in production, at deploy time, and not at the first customer", () => {
  using(workdir((raw) => (raw.provisioner = { kind: "local", base_dir: "./w", host_command: ["node"] })), (w) => {
    assert.match(refusal(w), /provisioner.kind local is for trying the service on one machine: an agent's shell runs as the same user as every other workspace/);
  });
  using(workdir((raw) => ((raw.app_url = "http://localhost:7500"), (raw.workspaces = { domain: "localhost" }), (raw.provisioner = { kind: "local", base_dir: "./w", host_command: [] }), delete raw.licence, (raw.billing = { provider: "manual", pay_url: "http://localhost/pay?ref={ref}" }))), (w) => {
    assert.match(refusal(w), /provisioner.host_command must be the command that starts a host, as a list/);
  });
});

// ---- the licence key ----

test("the licence key must exist, be a private key, and be the one the build trusts, or every workspace would run on the Community plan", () => {
  using(workdir((raw) => delete raw.licence), (w) => assert.match(refusal(w), /licence is required: the key workspace licences are signed with/));
  using(workdir((raw) => (raw.licence = { kid: "k1" })), (w) => assert.match(refusal(w), /licence needs private_key_file or private_key_env/));
  using(workdir((raw) => (raw.licence = { kid: "bad kid!", private_key_file: "./secrets/licence-k1.pem" })), (w) => assert.match(refusal(w), /licence.kid must be 1 to 32 characters of letters, digits, _ and -/));
  using(workdir((raw) => (raw.licence.private_key_file = "./secrets/missing.pem")), (w) => assert.match(refusal(w), /licence.private_key_file cannot be read/));
  using(workdir(), (w) => {
    fs.writeFileSync(path.join(w.dir, "secrets", "licence-k1.pem"), "not a key");
    assert.match(refusal(w), /the licence key is not a private key/);
  });
  using(workdir(), (w) => {
    const m = refusal(w, ENV, {});
    assert.match(m, /the licence key does not verify \(this build trusts no public key 'k1': add it to packages\/licensing\/src\/keys\.ts and rebuild\)/);
    assert.match(m, /Every workspace would read its licence as invalid and run on the Community plan/);
  });
  using(workdir(), (w) => {
    const other = generateLicenseKeyPair();
    assert.match(refusal(w, ENV, { k1: other.publicKey }), /the private key is not the one whose public half this build holds for 'k1'/);
  });
  using(workdir((raw) => (raw.licence = { kid: "k1", private_key_env: "LICENCE_KEY" })), (w) => {
    assert.match(refusal(w, ENV), /the environment variable LICENCE_KEY is not set, so there is no licence key/);
    assert.equal(load(w, { ...ENV, LICENCE_KEY: w.privateKeyPem }).licence?.privateKey, w.privateKeyPem, "a key may come from the environment as well as from a file");
  });
});

test("a licence key the build does not trust is a warning in a trial, where it only means the Community plan, and an error in production", () => {
  using(
    workdir((raw) => {
      raw.app_url = "http://localhost:7500";
      raw.workspaces = { domain: "localhost" };
      raw.provisioner = { kind: "local", base_dir: "./w", host_command: ["node"] };
      raw.billing = { provider: "manual", pay_url: "http://localhost:7500/pay?ref={ref}" };
    }),
    (w) => {
      const c = load(w, ENV, {});
      assert.match(c.warnings.join("\n"), /the licence key does not verify \(this build trusts no public key 'k1'/);
      assert.equal(c.licence?.kid, "k1", "the key is still used: the licences are minted, and the workspace reads them as unknown");
    },
  );
});

// ---- money ----

test("manual billing needs a page to send customers to, with the reference to pay under in it", () => {
  using(workdir((raw) => (raw.billing = { provider: "manual" })), (w) => assert.match(refusal(w), /billing.pay_url is required for manual billing, and must contain \{ref\}/));
  using(workdir((raw) => (raw.billing = { provider: "manual", pay_url: "https://pay.example/instructions" })), (w) => assert.match(refusal(w), /must contain \{ref\}/));
  using(workdir((raw) => (raw.billing = { provider: "manual", pay_url: "not an address {ref}" })), (w) => assert.match(refusal(w), /billing.pay_url 'not an address \{ref\}' is not an address/));
});

test("hosted checkout needs the provider's key and the secret of its messages from the environment, and a price id for every plan it sells", () => {
  const hosted = { provider: "hosted-checkout", api_key_env: "BILLING_API_KEY", webhook_secret_env: "BILLING_WEBHOOK_SECRET" };
  const env = { ...ENV, BILLING_API_KEY: "sk_test_123", BILLING_WEBHOOK_SECRET: "whsec_123456" };
  using(workdir((raw) => (raw.billing = hosted), pricedCatalogue()), (w) => {
    const c = load(w, env);
    assert.deepEqual(c.billing, { provider: "hosted-checkout", apiKey: "sk_test_123", webhookSecret: "whsec_123456" });
    assert.match(refusal(w, ENV), /the environment variable BILLING_API_KEY is not set, so there is no provider's API key/);
    assert.match(refusal(w, { ...env, BILLING_WEBHOOK_SECRET: "short" }), /BILLING_WEBHOOK_SECRET must hold the signing secret of the provider's messages of at least 8 characters/);
  });
  using(workdir((raw) => (raw.billing = hosted)), (w) => {
    const m = refusal(w, env);
    assert.match(m, /plan 'business' has no provider_price_id, which hosted checkout needs to sell it/);
    assert.match(m, /plan 'yearly' has no provider_price_id/);
    assert.ok(!/plan 'team' has no provider_price_id/.test(m));
  });
  using(workdir((raw) => (raw.billing = { ...hosted, base_url: "https://api.provider.example/" }), pricedCatalogue()), (w) => assert.equal((load(w, env).billing as { baseUrl?: string }).baseUrl, "https://api.provider.example/"));
  using(workdir((raw) => (raw.billing = { ...hosted, base_url: "provider" }), pricedCatalogue()), (w) => assert.match(refusal(w, env), /billing.base_url 'provider' is not an http or https address/));
  using(workdir((raw) => delete raw.billing), (w) => assert.match(refusal(w), /billing must be a mapping with a provider: manual or hosted-checkout/));
});

test("the checks on workspaces run at least once a minute and at most once a day", () => {
  for (const [minutes, ok] of [[1, true], [1440, true], [0, false], [1441, false], [1.5, false], ["15", false]] as const) {
    using(workdir((raw) => (raw.reconcile_minutes = minutes)), (w) => {
      if (ok) assert.equal(load(w).reconcileMinutes, minutes);
      else assert.match(refusal(w), /reconcile_minutes must be a whole number from 1 to 1440/);
    });
  }
});

// ---- what is shown ----

test("what the configuration would run is shown for a person to check, and no secret is in it", () => {
  using(workdir(), (w) => {
    const c = load(w);
    const shown = describeControl(c).join("\n");
    assert.match(shown, /the app is at https:\/\/app\.curule\.example; workspaces are at <slug>\.curule-ws\.example over https \(cookies are Secure and HSTS is sent\)/);
    assert.match(shown, /public listener 127\.0\.0\.1:0, trusting 1 proxy hop for the caller's address; pages from /);
    assert.match(shown, /owner API 127\.0\.0\.1:0, behind a token/);
    assert.match(shown, /plans from .*plans\.yaml, sold in USD:/);
    assert.match(shown, /team: Team, \$149\.00 a month, 1 workspace, 20 USD of usage included, limits of the team plan, tiers fast, balanced/);
    assert.match(shown, /business: Business, \$599\.00 a month, 3 workspaces, 100 USD of usage included, limits of the business plan$/m);
    assert.match(shown, /yearly: Team, yearly, \$1,488\.00 a year/);
    assert.match(shown, /top-ups \$10\.00, \$25\.00, \$100\.00 \(any amount from \$5\.00 to \$1,000\.00\)/);
    assert.match(shown, /gateway: admin API at http:\/\/gateway\.internal:8081; workspaces are told to call http:\/\/gateway\.internal:8080\/v1/);
    assert.match(shown, /workspaces run as docker containers of ghcr\.io\/example\/curule:1 on the network curule-workspaces, with 1 CPU, 2048 MB and 512 processes each, going out through egress\.curule-workspaces:3128/);
    assert.match(shown, /workspace licences are signed with key k1/);
    assert.match(shown, /billing is manual: customers are sent to https:\/\/app\.curule\.example\/pay\?ref=<reference>, and the operator records what arrives/);
    assert.match(shown, /the checks on workspaces run every 15 minutes/);
    for (const secret of [ENV.CONTROL_SECRET, ENV.CONTROL_OWNER_TOKEN, ENV.GATEWAY_ADMIN_TOKEN, w.privateKeyPem, w.privateKeyPem.split("\n")[1]!]) assert.ok(!shown.includes(secret), "no secret is shown");
  });
  using(workdir((raw) => ((raw.owner = { host: "0.0.0.0", port: 7501, token_env: "CONTROL_OWNER_TOKEN" }), delete raw.pages, (raw.provisioner.limits = { cpus: 2, memory_mb: 4096, pids: 1024 }), (raw.billing = { provider: "manual", pay_url: "https://app.curule.example/pay?ref={ref}" }))), (w) => {
    const shown = describeControl(load(w)).join("\n");
    assert.match(shown, /no pages, the API only/);
    assert.match(shown, /WARNING: the owner API listens on every interface/);
    assert.match(shown, /with 2 CPU, 4096 MB and 1024 processes each/);
  });
});

test("a configuration with a hosted checkout is described without its key", () => {
  const env = { ...ENV, BILLING_API_KEY: "sk_live_very_secret", BILLING_WEBHOOK_SECRET: "whsec_very_secret" };
  const change = (raw: Record<string, any>): void => {
    raw.billing = { provider: "hosted-checkout", api_key_env: "BILLING_API_KEY", webhook_secret_env: "BILLING_WEBHOOK_SECRET", base_url: "https://api.provider.example" };
    raw.reconcile_minutes = 1;
  };
  using(workdir(change, pricedCatalogue()), (w) => {
    const shown = describeControl(load(w, env)).join("\n");
    assert.match(shown, /billing is by a hosted checkout, with messages verified by signature \(API at https:\/\/api\.provider\.example\/\)/);
    assert.match(shown, /the checks on workspaces run every 1 minute$/m);
    assert.ok(!shown.includes("sk_live_very_secret") && !shown.includes("whsec_very_secret"));
  });
});

// ---- mail ----

const smtp = (over: Record<string, unknown> = {}): ((raw: Record<string, any>) => void) => (raw) => {
  raw.mail = { smtp: { ...raw.mail.smtp, ...over } };
  for (const [k, v] of Object.entries(over)) if (v === undefined) delete raw.mail.smtp[k];
};

test("mail is delivered over SMTP to the server the file names, signed in with an account read from the environment, and waits in a folder beside the control log", () => {
  using(workdir(), (w) => {
    const c = load(w);
    assert.deepEqual(c.smtp, { host: "smtp.mail.example", port: 587, security: "starttls", user: ENV.SMTP_USER, password: ENV.SMTP_PASSWORD, from: "Curule <no-reply@curule.example>", spoolDir: path.join(w.dir, "data", "mail") });
  });
  using(workdir((raw) => (smtp({ hello: "Mail.Curule.Example" })(raw), (raw.mail.spool = "../elsewhere/spool"))), (w) => {
    const c = load(w);
    assert.equal(c.smtp?.spoolDir, path.resolve(w.dir, "..", "elsewhere", "spool"), "a folder named in the file is read from the file's own folder");
    assert.equal(c.smtp?.hello, "mail.curule.example");
  });
});

test("the port and the way a connection is encrypted follow each other when only one is said, and a server that asks for no sign-in needs none", () => {
  const cases: Array<[Record<string, unknown>, [string, number]]> = [
    [{ port: undefined, security: undefined }, ["starttls", 587]],
    [{ port: 465, security: undefined }, ["tls", 465]],
    [{ port: 2525, security: undefined }, ["starttls", 2525]],
    [{ port: undefined, security: "tls" }, ["tls", 465]],
    [{ port: undefined, security: "starttls" }, ["starttls", 587]],
    [{ port: undefined, security: "none", host: "localhost", user_env: undefined, password_env: undefined }, ["none", 25]],
    [{ port: 465, security: "starttls" }, ["starttls", 465]],
  ];
  for (const [over, [security, port]] of cases) {
    using(workdir(smtp(over)), (w) => {
      const c = load(w);
      assert.deepEqual([c.smtp?.security, c.smtp?.port], [security, port], JSON.stringify(over));
    });
  }
  using(workdir(smtp({ user_env: undefined, password_env: undefined })), (w) => {
    const c = load(w);
    assert.ok(c.smtp && !("user" in c.smtp) && !("password" in c.smtp));
  });
});

test("every mistake in the mail settings is reported at once, in words that name the setting, and no password is in them", () => {
  using(
    workdir((raw) => {
      raw.mail = { smtp: { host: "smtp://mail.example:587", port: 70_000, security: "ssl", from: "Curule <no-reply>", hello: "not a name", user_env: "SMTP_USER" } };
    }),
    (w) => {
      const m = refusal(w);
      assert.match(m, /mail\.smtp\.host 'smtp:\/\/mail\.example:587' is not a host name or an address/);
      assert.match(m, /mail\.smtp\.port must be a whole number from 1 to 65535 \(got 70000\)/);
      assert.match(m, /mail\.smtp\.security must be tls, starttls or none \(got "ssl"\)/);
      assert.match(m, /mail\.smtp\.from 'Curule <no-reply>' is not an address/);
      assert.match(m, /mail\.smtp\.hello 'not a name' is not a host name/);
      assert.match(m, /mail\.smtp\.user_env and mail\.smtp\.password_env go together/);
      assert.ok(!m.includes(ENV.SMTP_PASSWORD) && !m.includes(ENV.SMTP_USER));
    },
  );
  using(workdir(smtp({ host: undefined, from: undefined })), (w) => {
    const m = refusal(w);
    assert.match(m, /mail\.smtp\.host is required/);
    assert.match(m, /mail\.smtp\.from is required/);
  });
  using(workdir(smtp({ host: "smtp.mail.example:587" })), (w) => assert.match(refusal(w), /mail\.smtp\.host 'smtp\.mail\.example:587' is not a host name or an address \(the port is mail\.smtp\.port/));
  using(workdir(smtp({ from: "no-reply@curule.example\nBcc: eve@example.net" })), (w) => assert.match(refusal(w), /mail\.smtp\.from 'no-reply@curule\.example Bcc: eve@example\.net' is not an address/));
  using(workdir((raw) => (raw.mail.spool = 12)), (w) => assert.match(refusal(w), /mail\.spool must be a folder/));
  using(workdir((raw) => (raw.mail = { smtp: "smtp.mail.example" })), (w) => assert.match(refusal(w), /mail\.smtp must be a mapping with host and from/));
});

test("the account and password are read from the environment, and a variable that is not set stops the start", () => {
  using(workdir(), (w) => {
    assert.match(refusal(w, { ...ENV, SMTP_USER: undefined }), /the environment variable SMTP_USER is not set, so there is no mail server's user name/);
    assert.match(refusal(w, { ...ENV, SMTP_PASSWORD: "  " }), /the environment variable SMTP_PASSWORD is not set, so there is no mail server's password/);
    assert.match(refusal(w, { ...ENV, SMTP_PASSWORD: "a\nb" }), /must not hold a line break or a NUL/);
    assert.equal(load(w, { ...ENV, SMTP_PASSWORD: "p" }).smtp?.password, "p", "a short password is the provider's to allow");
  });
  using(workdir(smtp({ password_env: undefined })), (w) => assert.match(refusal(w), /user_env and mail\.smtp\.password_env go together/));
  using(workdir(smtp({ user_env: undefined })), (w) => assert.match(refusal(w), /user_env and mail\.smtp\.password_env go together/));
});

test("mail that crosses a network unencrypted is warned of, and one that would carry a password in the clear is refused, unless the server is this machine", () => {
  using(workdir(smtp({ security: "none", user_env: undefined, password_env: undefined })), (w) => {
    assert.match(load(w).warnings.join("\n"), /mail\.smtp\.security is none for 'smtp\.mail\.example': mail, and the links in it that sign a person in, cross the network unencrypted/);
  });
  using(workdir(smtp({ security: "none" })), (w) => assert.match(refusal(w), /mail\.smtp\.security is none and the mail server 'smtp\.mail\.example' is not on this machine: the password would cross the network in the clear\. Use starttls or tls/));
  for (const host of ["localhost", "127.0.0.1", "127.9.8.7", "::1"]) {
    using(workdir(smtp({ security: "none", host })), (w) => {
      const c = load(w);
      assert.equal(c.smtp?.host, host);
      assert.deepEqual(c.warnings, [], `${host} is this machine`);
    });
  }
  for (const host of ["127.example.com", "localhost.example.com", "10.0.0.5"]) {
    using(workdir(smtp({ security: "none", host })), (w) => assert.match(refusal(w), /is not on this machine/, host));
  }
});

test("where mail goes: a file or a server, and one of the two is needed; a file in production is warned of, because it is not sent", () => {
  using(workdir((raw) => (raw.mail = { outbox: "./data/outbox.jsonl" })), (w) => {
    const c = load(w);
    assert.equal(c.outboxPath, path.join(w.dir, "data", "outbox.jsonl"));
    assert.equal(c.smtp, undefined);
    assert.match(c.warnings.join("\n"), /mail is written to .*outbox\.jsonl and is not sent\. A person who signs up gets no confirmation link unless something of yours delivers that file\. Set mail\.smtp to send it/);
  });
  using(workdir((raw) => ((raw.mail = { outbox: "./data/outbox.jsonl" }), trial(raw))), (w) => assert.ok(!load(w).warnings.some((x) => /outbox/.test(x)), "a trial writes mail to a file, and that is what it is for"));
  using(workdir((raw) => (raw.mail = { ...raw.mail, outbox: "./data/outbox.jsonl" })), (w) => {
    const c = load(w);
    assert.equal(c.outboxPath, "");
    assert.match(c.warnings.join("\n"), /mail\.outbox is not used while mail\.smtp is set/);
  });
  using(workdir((raw) => delete raw.mail), (w) => assert.match(refusal(w), /mail\.outbox is required, or mail\.smtp to deliver mail over SMTP/));
  using(workdir((raw) => (raw.mail = { smtp: null, outbox: "./o.jsonl" })), (w) => assert.equal(load(w).smtp, undefined, "an empty smtp is no smtp"));
});

test("the mail that would be sent is shown for a person to check: where, how it is encrypted, as whom, and where it waits, with no password", () => {
  using(workdir(), (w) => {
    const shown = describeControl(load(w)).join("\n");
    assert.match(shown, /mail is delivered over SMTP to smtp\.mail\.example:587 \(upgraded with STARTTLS, signed in\) as Curule <no-reply@curule\.example>, and waits in .*data\/mail until it is taken/);
    assert.ok(!shown.includes(ENV.SMTP_PASSWORD) && !shown.includes(ENV.SMTP_USER));
  });
  using(workdir(smtp({ security: "tls", port: undefined })), (w) => assert.match(describeControl(load(w)).join("\n"), /smtp\.mail\.example:465 \(TLS from the first byte, signed in\)/));
  using(workdir(smtp({ security: "none", port: undefined, host: "localhost", user_env: undefined, password_env: undefined })), (w) => assert.match(describeControl(load(w)).join("\n"), /localhost:25 \(not encrypted\) as /));
  using(workdir((raw) => (raw.mail = { outbox: "./data/outbox.jsonl" })), (w) => assert.match(describeControl(load(w)).join("\n"), /mail is written to .*outbox\.jsonl and not sent/));
});

test("an environment variable that is not named, for the mail account or its password, is said to be needed by its own key", () => {
  using(workdir(smtp({ user_env: 12, password_env: "" })), (w) => {
    const m = refusal(w);
    assert.match(m, /mail\.smtp\.user_env must name the environment variable that holds the mail server's user name/);
    assert.match(m, /mail\.smtp\.password_env must name the environment variable that holds the mail server's password/);
  });
});

test("only the mail part is read for the mail check: it needs no control log, one mistake is enough to refuse it, and a file that is not sent is warned of when the app is served over TLS", () => {
  const minimal = (mail: Record<string, unknown>, extra: Record<string, unknown> = {}): ((raw: Record<string, any>) => void) => (raw) => {
    for (const key of Object.keys(raw)) delete raw[key];
    Object.assign(raw, { mail, ...extra });
  };
  using(workdir(minimal({ smtp: { host: "smtp.mail.example", from: "no-reply@curule.example", user_env: "SMTP_USER", password_env: "SMTP_PASSWORD" } })), (w) => {
    const c = loadMailConfig(w.file, ENV);
    assert.equal(c.smtp?.host, "smtp.mail.example");
    assert.equal(c.smtp?.spoolDir, "", "with no control log there is no default folder to name");
    assert.deepEqual(c.warnings, []);
  });
  using(workdir(minimal({ smtp: { host: "smtp.mail.example", from: "nobody" } })), (w) => {
    assert.throws(() => loadMailConfig(w.file, ENV), (err: Error) => err.message.split("\n").length === 1 && err.message.startsWith(`${w.file}: mail.smtp.from 'nobody' is not an address`));
  });
  for (const [appUrl, warned] of [["https://app.curule.example", true], ["http://localhost:7500", false], [undefined, false]] as const) {
    using(workdir(minimal({ outbox: "./outbox.jsonl" }, appUrl ? { app_url: appUrl } : {})), (w) => {
      const c = loadMailConfig(w.file, ENV);
      assert.equal(c.outboxPath, path.join(w.dir, "outbox.jsonl"));
      assert.equal(c.warnings.some((x) => /is not sent/.test(x)), warned, String(appUrl));
    });
  }
  using(workdir(minimal({})), (w) => assert.throws(() => loadMailConfig(w.file, ENV), /mail\.outbox is required, or mail\.smtp to deliver mail over SMTP/));
});
