/**
 * `ordane doctor`: a report a customer can paste into a ticket.
 *
 * The property that matters is a negative one, so most of this file looks for what must NOT be in the output:
 * a credential, a licence key, an event's payload, a path, the licensee's name. Everything else is the diagnosis
 * (a bad token, a lock left behind, a config that does not load, a plan the install has outgrown), checked
 * against real files in a temporary home.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { DOCTOR_HELP, DOCTOR_SETTINGS, buildDoctorReport, runDoctorCommand, type DoctorReport } from "../../apps/mesh-cli/src/doctor";
import { findShippedRoot, scaffoldExample, runInitCommand } from "../../apps/mesh-cli/src/init";
import { generateLicenseKeyPair, signLicense, type LicenseClaims } from "../../packages/licensing/src/index";
import { STATE_LOCK_FILENAME } from "../../packages/persistence/src/index";
import { testConfigYaml } from "../helpers";

const SHIPPED = findShippedRoot(__dirname)!;
const NOW = new Date("2026-10-01T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const at = (days: number): string => new Date(NOW.getTime() + days * DAY).toISOString();
const keys = generateLicenseKeyPair();
const PUBLIC = { k1: keys.publicKey };
const licence = (plan: LicenseClaims["plan"], over: Partial<LicenseClaims> = {}): string =>
  signLicense({ v: 1, id: "lic_doc", customer: "Acme Robotics Ltd", plan, issuedAt: at(-30), expiresAt: at(300), ...over }, "k1", keys.privateKeyPem);

const LONG_TOKEN = "t".repeat(24) + "OPERATORTOKEN" + "x".repeat(27);

interface Fixture {
  home: string;
  /** Registers `id` and scaffolds the demo-stub example there; returns its folder. */
  project(id: string, folder?: string): string;
}

function fixture(): Fixture {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-doctor-"));
  const home = path.join(base, "home");
  fs.mkdirSync(home, { recursive: true });
  const entries: unknown[] = [];
  const write = (): void => fs.writeFileSync(path.join(home, "projects.json"), JSON.stringify({ version: 1, projects: entries }), "utf8");
  write();
  return {
    home,
    project(id, folder = `customer-${id}-private-dir`) {
      const root = path.join(base, "projects", folder);
      scaffoldExample(SHIPPED, "demo-stub", root);
      entries.push({ id, name: id, root, configPath: path.join(root, "mesh.yaml"), addedAt: at(-1) });
      write();
      return root;
    },
  };
}

const stateDir = (root: string): string => path.join(root, "workspace", ".mesh-state");

function writeLog(root: string, lines: object[]): void {
  fs.mkdirSync(path.join(stateDir(root), "logs"), { recursive: true });
  fs.writeFileSync(path.join(stateDir(root), "logs", "events.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
}

async function run(f: Fixture, opts: { env?: NodeJS.ProcessEnv; positional?: string[]; flags?: Record<string, string | boolean>; fetch?: typeof fetch; uid?: number | null } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runDoctorCommand(opts.positional ?? [], opts.flags ?? {}, {
    env: opts.env ?? {},
    home: f.home,
    publicKeys: PUBLIC,
    now: NOW,
    uid: opts.uid === undefined ? 10001 : opts.uid,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, text: out.join("\n"), err: err.join("\n") };
}

async function report(f: Fixture, opts: { env?: NodeJS.ProcessEnv; positional?: string[]; flags?: Record<string, string | boolean>; fetch?: typeof fetch } = {}): Promise<DoctorReport> {
  const r = await run(f, { ...opts, flags: { ...(opts.flags ?? {}), json: true } });
  return JSON.parse(r.text) as DoctorReport;
}

test("the report holds no credential, licence key, event payload, path or licensee name, in either format", async () => {
  const f = fixture();
  const root = f.project("hello", "customer-secret-folder");
  writeLog(root, [
    { id: "e1", seq: 1, type: "goal.created", timestamp: at(-2), payload: { goal: "CANARY-GOAL-TEXT" } },
    { id: "e2", seq: 2, type: "message.sent", timestamp: at(-1), payload: { body: "CANARY-PROMPT-TEXT sk-ant-api03-CANARYKEY", token: LONG_TOKEN } },
  ]);
  // A role prompt is the customer's own text, and a broken reference to it ends up in a config error.
  fs.writeFileSync(path.join(root, "roles", "CANARY-ROLE-FILE.md"), "CANARY-ROLE-BODY", "utf8");
  const bad = f.project("broken", "customer-broken-folder");
  fs.appendFileSync(path.join(bad, "mesh.yaml"), "\n  # CANARY-YAML-COMMENT\n    prompt: ./roles/CANARY-MISSING-PROMPT.md\n", "utf8");

  const licenceToken = licence("team");
  const env: NodeJS.ProcessEnv = {
    MESH_API_TOKEN: LONG_TOKEN,
    MESH_LICENSE: licenceToken,
    ANTHROPIC_API_KEY: "sk-ant-api03-REALLYSECRETKEY",
    ANTHROPIC_AUTH_TOKEN: "gateway-secret-bearer",
    ANTHROPIC_BASE_URL: "https://internal-gateway.corp.example/v1",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret-token",
    MESH_ALLOWED_HOSTS: "mesh.internal-corp.example,127.0.0.1",
    MESH_ALLOWED_ORIGINS: "https://mesh.internal-corp.example",
    MESH_INSTANCE_ID: "secret-instance-name",
    MESH_LICENSE_FILE: "/etc/secret-dir/license.key",
    MESH_PROJECTS_ROOT: path.join(f.home, "..", "projects"),
    MESH_SURPRISE_VALUE: "CANARY-ENV-VALUE",
  };
  const forbidden = [
    LONG_TOKEN, licenceToken, licenceToken.split(".")[2]!, "REALLYSECRETKEY", "gateway-secret-bearer", "internal-gateway.corp", "oauth-secret-token",
    "internal-corp.example", "secret-instance-name", "secret-dir", "CANARY", "Acme Robotics", "customer-secret-folder", "customer-broken-folder",
    f.home, os.tmpdir(), os.homedir(),
  ];
  const formats: Array<Record<string, string | boolean>> = [{}, { json: true }];
  for (const flags of formats) {
    const r = await run(f, { env, flags });
    assert.equal(r.err, "");
    for (const needle of forbidden) assert.ok(!r.text.includes(needle), `${JSON.stringify(flags)} output contains ${JSON.stringify(needle)}`);
    // And it is a real report, not an empty one: the things that are allowed are there.
    assert.match(r.text, /hello/);
    assert.match(r.text, /lic_doc/);
    assert.match(r.text, /MESH_SURPRISE_VALUE/, "the name of an unrecognised MESH_ variable is shown, never its value");
  }
  const json = await report(f, { env });
  const hello = json.projects.find((p) => p.id === "hello")!;
  assert.equal(hello.log.lastSeq, 2);
  assert.equal(hello.log.lastEventAt, at(-1));
  assert.ok(hello.log.bytes > 100);
  assert.equal(json.projects.find((p) => p.id === "broken")!.config.valid, false);
});

test("settings are shown by name and state, and a secret is never more than 'set'", async () => {
  const f = fixture();
  const j = await report(f, { env: { MESH_API_TOKEN: LONG_TOKEN, MESH_LICENSE: "AML1.k1.x.y", MESH_ALLOWED_HOSTS: "a.example, b.example", MESH_TRUST_PROXY: "1", MESH_MAX_BODY_BYTES: "lots", MESH_LICENSE_ENFORCEMENT: "ENFORCE" } });
  const state = Object.fromEntries(j.settings.map((s) => [s.name, s.state]));
  assert.match(state.MESH_API_TOKEN!, /^set, meets the 32-character minimum/);
  assert.equal(state.MESH_LICENSE, "set");
  assert.equal(state.MESH_ALLOWED_HOSTS, "set (2 entries)");
  assert.equal(state.MESH_TRUST_PROXY, "set to 1");
  assert.equal(state.MESH_MAX_BODY_BYTES, "set, not a number");
  assert.equal(state.MESH_LICENSE_ENFORCEMENT, "set to enforce");
  assert.equal(state.MESH_COOKIE_SECURE, "not set");
  for (const s of j.settings) assert.ok(!s.state.includes("a.example") && !s.state.includes(LONG_TOKEN), s.name);
});

test("a short, an empty and an insecure-bind token setting each warn, and none fails the run", async () => {
  const f = fixture();
  const short = await run(f, { env: { MESH_API_TOKEN: "hunter2" } });
  assert.equal(short.code, 0);
  assert.match(short.text, /WARN\s+MESH_API_TOKEN is shorter than 32 characters/);
  assert.ok(!short.text.includes("hunter2"));
  const empty = await run(f, { env: { MESH_API_TOKEN: "" } });
  assert.match(empty.text, /WARN\s+MESH_API_TOKEN is set but empty/);
  const insecure = await run(f, { env: { MESH_ALLOW_INSECURE_BIND: "1" } });
  assert.match(insecure.text, /WARN\s+MESH_ALLOW_INSECURE_BIND=1/);
  const good = await run(f, { env: { MESH_API_TOKEN: LONG_TOKEN } });
  assert.doesNotMatch(good.text, /MESH_API_TOKEN is/);
});

test("a project whose mesh.yaml does not load fails the run, says why without a path, and points at the document", async () => {
  const f = fixture();
  const root = f.project("broken");
  fs.writeFileSync(path.join(root, "mesh.yaml"), "mesh: [this is: not valid", "utf8");
  const r = await run(f);
  assert.equal(r.code, 1);
  assert.match(r.text, /FAIL\s+Project broken: mesh\.yaml does not load: /);
  assert.ok(!r.text.includes(root));
  assert.match(r.text, /docs\/configuration\.md/);

  const gone = fixture();
  const folder = gone.project("vanished");
  fs.rmSync(folder, { recursive: true, force: true });
  const g = await run(gone);
  assert.equal(g.code, 1);
  assert.match(g.text, /FAIL\s+Project vanished: its folder is gone/);

  const noYaml = fixture();
  const nf = noYaml.project("empty");
  fs.rmSync(path.join(nf, "mesh.yaml"));
  assert.match((await run(noYaml)).text, /FAIL\s+Project empty: it has no mesh\.yaml/);
});

test("a YAML syntax error is reported by position only: the source line it quotes may be the customer's goal or prompt", async () => {
  const f = fixture();
  const root = f.project("syntax");
  fs.writeFileSync(path.join(root, "mesh.yaml"), 'mesh:\n  id: x\n    goal: "CANARY-GOAL-LINE the secret roadmap"\n  - CANARY-LIST-LINE\n', "utf8");
  const r = await run(f);
  assert.equal(r.code, 1);
  assert.match(r.text, /FAIL\s+Project syntax: mesh\.yaml does not load: not valid YAML \(line \d+, column \d+; `ordane validate` prints the message\)/);
  assert.ok(!r.text.includes("CANARY"), r.text);
});

test("a problem that names a path is reported with the path replaced, and long lists are cut short", async () => {
  const f = fixture();
  const root = f.project("paths");
  const yaml = fs.readFileSync(path.join(root, "mesh.yaml"), "utf8").replace(/prompt: .*pm\.md/, "prompt: /customer-secret-abs/roles/pm.md");
  fs.writeFileSync(path.join(root, "mesh.yaml"), yaml, "utf8");
  const r = await run(f);
  assert.match(r.text, /Project paths: mesh\.yaml does not load: agent 'pm' prompt file not found: <path>/);
  assert.ok(!r.text.includes("customer-secret-abs"));

  // Seven prompts missing at once: the first five, and how many more.
  const many = f.project("many");
  fs.rmSync(path.join(many, "roles"), { recursive: true, force: true });
  const long = await run(f);
  assert.match(long.text, /Project many: mesh\.yaml does not load: (agent '[^']+' prompt file not found: [^;]+; ){5}and 2 more/);
});

test("a damaged registry fails with its error code and no path", async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.home, "projects.json"), "{ not json", "utf8");
  const r = await run(f);
  assert.equal(r.code, 1);
  assert.match(r.text, /FAIL\s+The project registry could not be read \(registry_corrupt\)/);
  assert.ok(!r.text.includes(f.home));
});

test("a lock left by a process that is gone is a warning that says the next start takes it; a live holder is not", async () => {
  const f = fixture();
  const root = f.project("hello");
  fs.mkdirSync(stateDir(root), { recursive: true });
  const lock = path.join(stateDir(root), STATE_LOCK_FILENAME);
  const dead = spawnSync(process.execPath, ["-e", "0"]).pid!;
  const holder = (pid: number, extra: object = {}) => JSON.stringify({ pid, host: "pod-a", projectId: "hello", startedAt: at(-1), token: "t", instance: "release-1", ...extra });
  const env = { MESH_INSTANCE_ID: "release-1" };

  fs.writeFileSync(lock, holder(dead), "utf8");
  const stale = await run(f, { env });
  assert.match(stale.text, /WARN\s+Project hello: a lock is left behind by a process that is gone/);
  assert.match(stale.text, /state lock: left behind/);
  assert.equal(stale.code, 0, "a stale lock is a warning: the next start takes it over");

  fs.writeFileSync(lock, holder(process.ppid), "utf8");
  const live = await run(f, { env });
  assert.doesNotMatch(live.text, /lock is left behind/);
  assert.match(live.text, /state lock: held \(pid \d+ is still running\)/);

  // Another deployment: only a silent heartbeat can say it is gone.
  fs.writeFileSync(lock, holder(process.ppid, { instance: "release-2", heartbeatAt: at(-1) }), "utf8");
  assert.match((await run(f, { env })).text, /left behind \(no heartbeat from instance release-2 for \d+s\)/);
  fs.writeFileSync(lock, holder(process.ppid, { instance: "release-2", heartbeatAt: new Date(NOW.getTime() - 10_000).toISOString() }), "utf8");
  const fresh = await run(f, { env });
  assert.match(fresh.text, /state lock: held \(instance release-2 reported 10s ago/);
  assert.doesNotMatch(fresh.text, /lock is left behind/);

  fs.writeFileSync(lock, "{ torn", "utf8");
  assert.match((await run(f, { env })).text, /WARN\s+Project hello: its state lock is unreadable/);
});

test("plan limits: more seats or projects than the plan allows is a warning, and a larger plan clears it", async () => {
  const f = fixture();
  const root = f.project("big");
  const agents = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, role: "developer", interests: [] as string[] }));
  fs.writeFileSync(path.join(root, "mesh.yaml"), testConfigYaml({ agents, mayContact: {} } as never), "utf8");
  fs.mkdirSync(path.join(root, "roles"), { recursive: true });
  f.project("second");

  const community = await run(f);
  assert.equal(community.code, 0);
  assert.match(community.text, /WARN\s+2 projects are registered; Opening this project would make 2 open; the Community plan allows 1/);
  assert.match(community.text, /WARN\s+Project big: This mesh has 10 seats; the Community plan allows 8 per mesh/);

  const team = await run(f, { env: { MESH_LICENSE: licence("team") } });
  assert.doesNotMatch(team.text, /projects are registered/);
  assert.doesNotMatch(team.text, /This mesh has 10 seats/, "Team allows 12 seats and 5 projects");
  assert.match(team.text, /licence\s+lic_doc: valid, names the team plan, expires 2027-07-28/);
});

test("an expired licence in grace and a lapsed one are reported by id and date, never by who holds them", async () => {
  const f = fixture();
  const grace = await run(f, { env: { MESH_LICENSE: licence("team", { expiresAt: at(-3) }) } });
  assert.match(grace.text, /WARN\s+Licence lic_doc expired on 2026-09-28\. Team limits stay in force until 2026-10-12/);
  assert.match(grace.text, /grace to 2026-10-12/);
  const lapsed = await run(f, { env: { MESH_LICENSE: licence("team", { issuedAt: at(-400), expiresAt: at(-60) }) } });
  assert.match(lapsed.text, /WARN\s+Licence lic_doc for the licensee expired on /);
  assert.match(lapsed.text, /plan in force\s+community/);
  const wrongKey = await run(f, { env: { MESH_LICENSE: signLicense({ v: 1, id: "lic_x", customer: "Eve", plan: "business", issuedAt: at(-1), expiresAt: at(30) }, "k1", generateLicenseKeyPair().privateKeyPem) } });
  assert.match(wrongKey.text, /WARN\s+Licence not accepted \(bad-signature\)/);
  assert.match(wrongKey.text, /found but not accepted \(ordane license verify says why\)/);
  for (const r of [grace, lapsed, wrongKey]) assert.ok(!r.text.includes("Acme") && !r.text.includes("Eve"), "no licensee name");
});

test("a Claude-runtime project with no model credentials warns, an API key or a cloud switch clears it, a subscription sign-in warns differently", async () => {
  const f = fixture();
  const root = path.join(f.home, "..", "projects", "claude-one");
  assert.equal(runInitCommand([root], {}, { repoRoot: SHIPPED, out: () => undefined, err: () => undefined }), 0);
  fs.writeFileSync(path.join(f.home, "projects.json"), JSON.stringify({ version: 1, projects: [{ id: "c", name: "c", root, configPath: path.join(root, "mesh.yaml"), addedAt: at(-1) }] }), "utf8");

  const none = await run(f);
  assert.match(none.text, /WARN\s+A project uses the Claude runtime and none of ANTHROPIC_API_KEY, Bedrock, Vertex or Foundry is set/);
  for (const env of [{ ANTHROPIC_API_KEY: "sk-ant-x" }, { CLAUDE_CODE_USE_BEDROCK: "1" }, { CLAUDE_CODE_USE_VERTEX: "true" }, { CLAUDE_CODE_USE_FOUNDRY: "1" }]) {
    const r = await run(f, { env });
    assert.doesNotMatch(r.text, /uses the Claude runtime and none of/, JSON.stringify(Object.keys(env)));
  }
  assert.match((await run(f, { env: { CLAUDE_CODE_USE_BEDROCK: "0" } })).text, /uses the Claude runtime and none of/, "a switch set to 0 is off");
  const oauth = await run(f, { env: { CLAUDE_CODE_OAUTH_TOKEN: "t" } });
  assert.match(oauth.text, /WARN\s+A Claude subscription sign-in is set/);
  assert.match(oauth.text, /a Claude subscription sign-in/);
});

test("a project outside MESH_PROJECTS_ROOT is flagged, and the root's absence is only noted", async () => {
  const f = fixture();
  f.project("hello");
  assert.match((await run(f)).text, /INFO\s+MESH_PROJECTS_ROOT is not set/);
  const inside = await run(f, { env: { MESH_PROJECTS_ROOT: path.join(f.home, "..", "projects") } });
  assert.doesNotMatch(inside.text, /outside MESH_PROJECTS_ROOT/);
  const outside = await run(f, { env: { MESH_PROJECTS_ROOT: path.join(f.home, "..", "elsewhere") } });
  assert.match(outside.text, /WARN\s+Project hello sits outside MESH_PROJECTS_ROOT/);
});

test("running as root warns; an ordinary user does not", async () => {
  const f = fixture();
  assert.match((await run(f, { uid: 0 })).text, /WARN\s+Running as root/);
  assert.doesNotMatch((await run(f, { uid: 10001 })).text, /Running as root/);
});

test("--host asks the open probes only, sends no credential, and fails the run when the host is down or unwell", async () => {
  const seen: Array<{ url: string; auth: string | undefined }> = [];
  let readyStatus = 200;
  let healthStatus = 200;
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url ?? "", auth: req.headers.authorization as string | undefined });
    const status = req.url === "/healthz" ? healthStatus : req.url === "/readyz" ? readyStatus : 404;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: status === 200 ? "ok" : "no" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  try {
    const f = fixture();
    const env = { MESH_API_TOKEN: LONG_TOKEN };
    const ok = await run(f, { env, flags: { host: url } });
    assert.equal(ok.code, 0);
    assert.match(ok.text, /HOST\n\s+\/healthz 200, \/readyz 200/);
    assert.deepEqual(seen.map((s) => s.url).sort(), ["/healthz", "/readyz"]);
    assert.ok(seen.every((s) => s.auth === undefined), "no Authorization header is sent");
    assert.ok(!ok.text.includes(url), "the host's address is not echoed");

    readyStatus = 503;
    const draining = await run(f, { env, flags: { host: url } });
    assert.equal(draining.code, 0, "draining is a warning");
    assert.match(draining.text, /WARN\s+The host answers \/readyz with 503/);

    healthStatus = 500;
    const sick = await run(f, { env, flags: { host: url } });
    assert.equal(sick.code, 1);
    assert.match(sick.text, /FAIL\s+The host's \/healthz answered 500/);
  } finally {
    await new Promise((r) => server.close(r));
  }
  const f = fixture();
  const down = await run(f, { flags: { host: "http://127.0.0.1:1/" } });
  assert.equal(down.code, 1);
  assert.match(down.text, /FAIL\s+The host you named did not answer/);
});

test("a mesh.yaml named on the command line is inspected like a registered project, under a neutral name", async () => {
  const f = fixture();
  const root = path.join(f.home, "..", "standalone-private-name");
  scaffoldExample(SHIPPED, "demo-stub", root);
  const j = await report(f, { positional: [path.join(root, "mesh.yaml")] });
  assert.equal(j.projects.length, 1);
  assert.equal(j.projects[0]!.id, "mesh.yaml #1");
  assert.equal(j.projects[0]!.config.valid, true);
  assert.equal(j.projects[0]!.config.seats, 7);
  assert.deepEqual(j.projects[0]!.config.runtimes, ["stub"]);
  assert.ok(!JSON.stringify(j).includes("standalone-private-name"));
});

test("how it is asked for: help, a --host with no value, and a file that is not there are the caller's mistake", async () => {
  const f = fixture();
  const help = await run(f, { flags: { help: true } });
  assert.equal(help.code, 0);
  assert.equal(help.text, DOCTOR_HELP);
  const noValue = await run(f, { flags: { host: true } });
  assert.equal(noValue.code, 2);
  assert.match(noValue.err, /--host needs a URL/);
  const missing = await run(f, { positional: [path.join(f.home, "nope.yaml")] });
  assert.equal(missing.code, 2);
  assert.match(missing.err, /no such file/);
  assert.ok(!missing.err.includes("undefined"));
});

test("an install with nothing registered and nothing set reports cleanly", async () => {
  const f = fixture();
  const j = await buildDoctorReport([], {}, { env: {}, home: f.home, publicKeys: PUBLIC, now: NOW, uid: 10001 });
  assert.equal(j.schema, 1);
  assert.deepEqual(j.projects, []);
  assert.equal(j.licence.plan, "community");
  assert.equal(j.licence.registeredProjects, 0);
  assert.deepEqual(j.modelAccess, []);
  assert.ok(j.findings.every((x) => x.level === "info"), JSON.stringify(j.findings));
  // A home that does not exist yet is a first run, not an error.
  const first = await buildDoctorReport([], {}, { env: {}, home: path.join(f.home, "not-yet"), publicKeys: PUBLIC, now: NOW, uid: 10001 });
  assert.equal(first.install.homeExists, false);
  assert.ok(first.findings.every((x) => x.level !== "fail"));
});

test("the settings it knows are the ones docs/operations.md documents", () => {
  const doc = fs.readFileSync(path.join(__dirname, "..", "..", "..", "docs", "operations.md"), "utf8");
  const documented = new Set<string>();
  for (const line of doc.split("\n")) {
    const m = /^\|\s*`(MESH_[A-Z_]+)`\s*\|/.exec(line);
    if (m) documented.add(m[1]!);
  }
  const known = new Set(DOCTOR_SETTINGS.map((s) => s.name).filter((n) => n.startsWith("MESH_")));
  assert.ok(documented.size >= 15, "found the settings tables");
  assert.deepEqual([...documented].filter((n) => !known.has(n)).sort(), [], "documented but not reported by ordane doctor");
  assert.deepEqual([...known].filter((n) => !documented.has(n)).sort(), [], "reported by ordane doctor but not documented");
});

test("wired into the command line: `ordane doctor --json` prints a report and `--help` the usage", () => {
  const cli = path.join(__dirname, "..", "..", "apps", "mesh-cli", "src", "index.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-doctor-cli-"));
  const env = { PATH: process.env.PATH ?? "", MESH_HOME: home, MESH_API_TOKEN: LONG_TOKEN };
  const json = spawnSync(process.execPath, [cli, "doctor", "--json"], { env, encoding: "utf8" });
  assert.equal(json.status, 0, json.stderr);
  const parsed = JSON.parse(json.stdout) as DoctorReport;
  assert.equal(parsed.schema, 1);
  assert.ok(!json.stdout.includes(LONG_TOKEN));
  const help = spawnSync(process.execPath, [cli, "doctor", "--help"], { env, encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /ordane doctor \[mesh\.yaml \.\.\.\] \[--json\] \[--host <url>\]/);
  const top = spawnSync(process.execPath, [cli, "nonsense"], { env, encoding: "utf8" });
  assert.match(top.stdout + top.stderr, /ordane doctor/, "listed in the command summary");
});
