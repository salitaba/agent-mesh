/**
 * `curule license`: a customer can see what they are entitled to, install a key and take it away again, and a
 * key that does not verify never reaches the disk.
 *
 * Everything is injected (home, environment, public keys, clock, output), so no test touches the real
 * `~/.curule` or reads the build's key set.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runLicenseCommand, LICENSE_HELP } from "../../apps/mesh-cli/src/license";
import { LICENSE_FILENAME, generateLicenseKeyPair, signLicense, type LicenseClaims } from "../../packages/licensing/src/index";
import { testConfigYaml } from "../helpers";

const keys = generateLicenseKeyPair();
const PUBLIC = { k1: keys.publicKey };
const NOW = new Date("2026-10-01T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const at = (days: number): string => new Date(NOW.getTime() + days * DAY).toISOString();

function licence(plan: LicenseClaims["plan"], over: Partial<LicenseClaims> = {}): string {
  return signLicense({ v: 1, id: "lic_cli", customer: "Acme Robotics", plan, issuedAt: at(-30), expiresAt: at(300), ...over }, "k1", keys.privateKeyPem);
}

interface Run {
  code: number;
  out: string[];
  err: string[];
  home: string;
}

async function run(
  positional: string[],
  opts: { home?: string; env?: NodeJS.ProcessEnv; publicKeys?: Record<string, string>; flags?: Record<string, string | boolean> } = {},
): Promise<Run> {
  const home = opts.home ?? fs.mkdtempSync(path.join(os.tmpdir(), "mesh-license-cli-"));
  const out: string[] = [];
  const err: string[] = [];
  const code = await runLicenseCommand(positional, opts.flags ?? {}, {
    env: opts.env ?? {},
    home,
    publicKeys: opts.publicKeys ?? PUBLIC,
    now: NOW,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, out, err, home };
}

const saved = (home: string): string => path.join(home, LICENSE_FILENAME);

test("status with no licence is Community, says where it looked, and is the default subcommand", async () => {
  const r = await run([]);
  assert.equal(r.code, 0);
  const text = r.out.join("\n");
  assert.match(text, /Plan:\s+Community/);
  assert.match(text, /Source:\s+none/);
  assert.match(text, /Enforcement: warn/);
  assert.match(text, /0 project\(s\) registered/);

  const json = await run(["status"], { flags: { json: true } });
  const parsed = JSON.parse(json.out.join("\n"));
  assert.equal(parsed.plan, "community");
  assert.equal(parsed.status, "community");
  assert.equal(parsed.source, undefined, "no licence, no source");
  assert.equal(parsed.usage.projects, 0);
});

test("install verifies, saves owner-only through a rename, and status then reports the plan and where it came from", async () => {
  const token = licence("team");
  const r = await run(["install", token]);
  assert.equal(r.code, 0, r.err.join("\n"));
  assert.match(r.out.join("\n"), /Team licence for Acme Robotics \(lic_cli\)/);
  assert.match(r.out.join("\n"), /saved to /);
  assert.equal(fs.readFileSync(saved(r.home), "utf8"), `${token}\n`);
  if (process.platform !== "win32") assert.equal(fs.statSync(saved(r.home)).mode & 0o777, 0o600, "the file names a customer");
  assert.deepEqual(fs.readdirSync(r.home).filter((f) => f.endsWith(".tmp")), [], "no half-written file left behind");

  const status = await run(["status"], { home: r.home });
  const text = status.out.join("\n");
  assert.match(text, /Plan:\s+Team licence for Acme Robotics/);
  assert.match(text, new RegExp(`Source:\\s+.*${LICENSE_FILENAME.replace(".", "\\.")}`));
  assert.match(text, /usage-export/, "the features the plan carries are listed");
});

test("a licence that does not verify is refused and never written; a saved one is left as it was", async () => {
  const good = licence("team");
  const first = await run(["install", good]);
  assert.equal(first.code, 0);

  // A middle-of-signature edit: a real change to the signed bytes, not a base64 padding bit.
  const parts = good.split(".");
  const sig = parts[3]!;
  const mid = Math.floor(sig.length / 2);
  parts[3] = `${sig.slice(0, mid)}${sig[mid] === "A" ? "B" : "A"}${sig.slice(mid + 1)}`;
  const tampered = await run(["install", parts.join(".")], { home: first.home });
  assert.equal(tampered.code, 1);
  assert.match(tampered.err.join("\n"), /licence not accepted \(bad-signature\)/);
  assert.equal(fs.readFileSync(saved(first.home), "utf8"), `${good}\n`, "the licence already installed is untouched");

  const other = generateLicenseKeyPair();
  const foreign = signLicense({ v: 1, id: "lic_x", customer: "Mallory", plan: "enterprise", issuedAt: at(-1), expiresAt: at(300) }, "k1", other.privateKeyPem);
  const wrongKey = await run(["install", foreign], { home: first.home });
  assert.equal(wrongKey.code, 1, "a well-formed licence signed with some other key is not this vendor's");
  assert.equal(fs.readFileSync(saved(first.home), "utf8"), `${good}\n`);

  const garbage = await run(["install", "not-a-licence"], { home: first.home });
  assert.equal(garbage.code, 1);
  assert.match(garbage.err.join("\n"), /licence not accepted/);
});

test("a build that ships no keys says so, rather than leaving a customer to wonder what is wrong with their licence", async () => {
  const r = await run(["install", licence("team")], { publicKeys: {} });
  assert.equal(r.code, 1);
  assert.match(r.err.join("\n"), /unknown-key/);
  assert.match(r.err.join("\n"), /ships no licence keys/);
  assert.equal(fs.existsSync(saved(r.home)), false);
});

test("install and verify accept a file path as well as the key, and verify writes nothing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-license-file-"));
  const file = path.join(dir, "acme.key");
  const token = licence("business");
  fs.writeFileSync(file, `\n  ${token}  \n\n`, "utf8");

  const verified = await run(["verify", file]);
  assert.equal(verified.code, 0, verified.err.join("\n"));
  assert.match(verified.out.join("\n"), /Business licence for Acme Robotics/);
  assert.equal(fs.existsSync(saved(verified.home)), false, "verify only checks");

  const installed = await run(["install", file]);
  assert.equal(installed.code, 0);
  assert.equal(fs.readFileSync(saved(installed.home), "utf8"), `${token}\n`, "whitespace around a pasted key is not part of the key");
});

test("an expired licence installs with its grace said, an expiring one with its date; both say so where an operator reads", async () => {
  const expired = await run(["install", licence("team", { issuedAt: at(-400), expiresAt: at(-3) })]);
  assert.equal(expired.code, 0);
  assert.match(expired.out.join("\n"), /warning: Licence lic_cli expired on 2026-09-28/);
  assert.match(expired.out.join("\n"), /in grace until/);

  const soon = await run(["install", licence("team", { expiresAt: at(9) })]);
  assert.equal(soon.code, 0);
  assert.match(soon.out.join("\n"), /warning: Licence lic_cli expires on 2026-10-10 \(9 day\(s\)\)/);

  const gone = await run(["install", licence("team", { issuedAt: at(-500), expiresAt: at(-100) })]);
  assert.equal(gone.code, 0, "an expired licence still verifies; what it entitles is the entitlement layer's to say");
  assert.match(gone.out.join("\n"), /Community|expired/);
});

test("installing while MESH_LICENSE is set says which of the two a server will use", async () => {
  const r = await run(["install", licence("team")], { env: { MESH_LICENSE: licence("business") } });
  assert.equal(r.code, 0);
  assert.match(r.out.join("\n"), /MESH_LICENSE is set in this environment and takes precedence/);
  assert.equal(fs.existsSync(saved(r.home)), true, "it is still saved");

  const status = await run(["status"], { home: r.home, env: { MESH_LICENSE: licence("business") } });
  assert.match(status.out.join("\n"), /Plan:\s+Business/, "the environment wins, as the note said");
  assert.match(status.out.join("\n"), /Source:\s+MESH_LICENSE/);
});

test("remove deletes the saved licence, returns the install to Community, and is quiet when there is nothing to remove", async () => {
  const r = await run(["install", licence("team")]);
  assert.equal(fs.existsSync(saved(r.home)), true);

  const removed = await run(["remove"], { home: r.home });
  assert.equal(removed.code, 0);
  assert.match(removed.out.join("\n"), /removed .*license\.key/);
  assert.equal(fs.existsSync(saved(r.home)), false);

  const status = await run(["status"], { home: r.home });
  assert.match(status.out.join("\n"), /Plan:\s+Community/);

  const again = await run(["remove"], { home: r.home });
  assert.equal(again.code, 0);
  assert.match(again.out.join("\n"), /no saved licence/);
});

test("status against a mesh.yaml counts its seats against the plan and says when they do not fit", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-license-yaml-"));
  fs.mkdirSync(path.join(dir, "roles"), { recursive: true });
  fs.mkdirSync(path.join(dir, "workspace"), { recursive: true });
  const agents = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, role: "developer", interests: [] as string[] }));
  fs.writeFileSync(path.join(dir, "mesh.yaml"), testConfigYaml({ agents, mayContact: {} } as never), "utf8");

  const community = await run(["status", path.join(dir, "mesh.yaml")]);
  assert.equal(community.code, 0, community.err.join("\n"));
  assert.match(community.out.join("\n"), /10 seat\(s\) in .*mesh\.yaml — This mesh has 10 seats; the Community plan allows 8 per mesh/);

  const team = await run(["status", path.join(dir, "mesh.yaml")], { env: { MESH_LICENSE: licence("team") } });
  assert.doesNotMatch(team.out.join("\n"), /This mesh has 10 seats/, "Team allows 12");
  assert.match(team.out.join("\n"), /10 seat\(s\) in .*mesh\.yaml/);

  const json = await run(["status", path.join(dir, "mesh.yaml")], { flags: { json: true } });
  assert.equal(JSON.parse(json.out.join("\n")).usage.seats, 10);
});

test("missing arguments and unknown subcommands are the caller's mistake: exit 2 with the usage", async () => {
  for (const argv of [["install"], ["verify"], ["frobnicate"]]) {
    const r = await run(argv);
    assert.equal(r.code, 2, argv.join(" "));
    assert.match(r.err.join("\n"), /usage:/);
  }
  const help = await run([], { flags: { help: true } });
  assert.equal(help.code, 0);
  assert.equal(help.out.join("\n"), LICENSE_HELP);
});
