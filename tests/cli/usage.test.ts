/**
 * `mesh usage`: a table for a person, JSON and CSV for a machine, the same numbers as the server's /usage,
 * and the same plan gate. Event logs are written by hand, so the figures asserted are arithmetic a reader can check.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runUsageCommand, USAGE_HELP } from "../../apps/mesh-cli/src/usage";
import { LicenseLimitError } from "../../apps/mesh-server/src/license";
import { resolveConfig } from "../../packages/config/src/index";
import { generateLicenseKeyPair, signLicense, type LicenseClaims } from "../../packages/licensing/src/index";
import { projectsFilePath, writeProjectsFile, type ProjectRef } from "../../packages/projects/src/index";
import { testConfigYaml } from "../helpers";

const keys = generateLicenseKeyPair();
const PUBLIC = { k1: keys.publicKey };
const NOW = new Date("2026-10-15T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const at = (days: number): string => new Date(NOW.getTime() + days * DAY).toISOString();
const team = (): string => signLicense({ v: 1, id: "lic_usage", customer: "Acme Robotics", plan: "team", issuedAt: at(-30), expiresAt: at(300) }, "k1", keys.privateKeyPem);

interface Turn {
  day: string;
  agent: string;
  model: string;
  input: number;
  output: number;
  cacheWrite?: number;
  cacheRead?: number;
}

/** A mesh dir with a mesh.yaml and an event log holding these turns. */
function mesh(turns: Turn[]): { dir: string; configPath: string; meshId: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-usage-cli-"));
  const configPath = path.join(dir, "mesh.yaml");
  fs.mkdirSync(path.join(dir, "roles"), { recursive: true });
  fs.mkdirSync(path.join(dir, "workspace"), { recursive: true });
  fs.writeFileSync(configPath, testConfigYaml({ agents: [{ id: "a", role: "developer", interests: [] }], mayContact: { a: [] } }), "utf8");
  const resolved = resolveConfig(configPath);
  const logs = path.join(resolved.stateDir, "logs");
  fs.mkdirSync(logs, { recursive: true });
  const lines = turns.map((t, i) =>
    JSON.stringify({
      id: `evt-${i}`,
      type: "budget.consumed",
      timestamp: `${t.day}T10:00:00.000Z`,
      actorId: "system",
      payload: {
        agentId: t.agent,
        model: t.model,
        amount: t.input + t.output + (t.cacheWrite ?? 0),
        key: `agent:g/${t.agent}`,
        input: t.input,
        output: t.output,
        cacheRead: t.cacheRead ?? 0,
      },
    }),
  );
  fs.writeFileSync(path.join(logs, "events.jsonl"), `${lines.join("\n")}\n`, "utf8");
  return { dir, configPath, meshId: resolved.meshId };
}

interface Run {
  code: number;
  out: string[];
  err: string[];
}

async function run(
  positional: string[],
  flags: Record<string, string | boolean> = {},
  opts: { home?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runUsageCommand(positional, flags, {
    env: { ...(opts.env ?? {}) },
    home: opts.home ?? fs.mkdtempSync(path.join(os.tmpdir(), "mesh-usage-home-")),
    publicKeys: PUBLIC,
    now: NOW,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, out, err };
}

// Haiku 4.5 at list price: 1,000,000 fresh input ($1.00), 100,000 output ($0.50), 200,000 cache writes
// ($0.25), 5,000,000 cache reads ($0.50) = $2.25. Four token classes, each at its own price.
const HAIKU = "claude-haiku-4-5-20251001";
const TURNS: Turn[] = [
  { day: "2026-10-01", agent: "dev", model: HAIKU, input: 1_000_000, output: 100_000, cacheWrite: 200_000, cacheRead: 5_000_000 },
  { day: "2026-10-02", agent: "dev", model: HAIKU, input: 1_000_000, output: 100_000, cacheWrite: 200_000, cacheRead: 5_000_000 },
  { day: "2026-10-02", agent: "rev", model: "acme-house-model", input: 400, output: 100 },
];

test("the table names its dimensions, prices every token class at list price, and says what a '-' is", async () => {
  const m = mesh(TURNS);
  const r = await run([m.configPath], { by: "day,agent" });
  assert.equal(r.code, 0, r.err.join("\n"));
  const text = r.out.join("\n");
  const lines = text.split("\n");
  assert.match(lines[0]!, /^day\s+agent\s+turns\s+input\s+output\s+cache-write\s+cache-read\s+billed\s+est\. USD$/);
  const row = (day: string, agent: string): string => lines.find((l) => l.startsWith(day) && l.includes(agent))!;
  assert.match(row("2026-10-01", "dev"), /\b1\b\s+1,000,000\s+100,000\s+200,000\s+5,000,000\s+1,300,000\s+\$2\.25$/, "1.00 + 0.50 + 0.25 + 0.50");
  assert.match(row("2026-10-02", "rev"), /\s-$/, "a model with no price is not costed at some default");
  assert.match(text, /^total\b.*\s-$/m, "a total that includes an unpriced row is not a partial figure passed off as the whole");
  assert.match(text, /No price for: acme-house-model\. A row that includes one shows - rather than a partial dollar figure/);
  assert.match(text, /Tokens are exact/);
  assert.match(text, /3 turn\(s\); 3 active seat-day\(s\)/);
});

test("host.yaml prices a model the list does not know, and wins over the list for one it does", async () => {
  const m = mesh(TURNS);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-usage-home-"));
  fs.writeFileSync(
    path.join(home, "host.yaml"),
    `host:\n  model_prices:\n    acme-house-model: 10\n    claude-haiku-4-5: { input_per_mtok: 2, output_per_mtok: 10, cache_write_per_mtok: 2, cache_read_per_mtok: 0.2 }\n`,
    "utf8",
  );
  const r = await run([m.configPath], { json: true, by: "model" }, { home });
  const report = JSON.parse(r.out.join("\n"));
  const byModel = Object.fromEntries(report.rows.map((x: { model: string }) => [x.model, x]));
  assert.equal(byModel["acme-house-model"].costUsd, (400 * 10 + 100 * 10) / 1e6, "a bare number is one rate for the model");
  assert.equal(byModel[HAIKU].costUsd, 2 * (2 + 1 + 0.4 + 1), "host.yaml's Haiku rates, not the list's: (2.00 + 1.00 + 0.40 + 1.00) x 2 days");
  assert.deepEqual(report.unpricedModels, []);
  assert.deepEqual(report.prices.configured.sort(), ["acme-house-model", "claude-haiku-4-5"]);
});

test("--json is the server's /usage answer and --csv its CSV, with no stray blank line at the end", async () => {
  const m = mesh(TURNS);
  const json = await run([m.configPath], { json: true, by: "day" });
  assert.equal(json.code, 0);
  const report = JSON.parse(json.out.join("\n"));
  assert.deepEqual(report.groupBy, ["day"]);
  assert.deepEqual(report.rows.map((x: { day: string }) => x.day), ["2026-10-01", "2026-10-02"]);
  assert.equal(report.totals.turns, 3);
  assert.equal(report.prices.listPricesAsOf, "2026-10-01");
  assert.match(report.note, /Tokens are exact/);

  const csv = await run([m.configPath], { csv: true, by: "day,agent" });
  assert.equal(csv.code, 0);
  const text = csv.out.join("\n");
  const rows = text.split("\n");
  assert.match(rows[0]!, /^day,agent,turns,inputTokens,outputTokens,cacheWriteTokens,cacheReadTokens,billedTokens,thinkingTokens,toolCalls,costUsd$/);
  assert.equal(rows.length, 4, "a header and three (day, agent) rows");
  assert.ok(rows.every((l) => l.length > 0), "no blank line inside or after");
  assert.match(rows[1]!, /^2026-10-01,dev,1,1000000,100000,200000,5000000,1300000,0,0,2\.25$/);
  assert.match(rows[3]!, /,$/, "an unpriced row has an empty cost cell, not 0");
});

test("--since is inclusive and --until exclusive", async () => {
  const m = mesh(TURNS);
  const day2 = await run([m.configPath], { json: true, since: "2026-10-02" });
  assert.equal(JSON.parse(day2.out.join("\n")).totals.turns, 2);
  const day1 = await run([m.configPath], { json: true, until: "2026-10-02" });
  assert.equal(JSON.parse(day1.out.join("\n")).totals.turns, 1);
  const none = await run([m.configPath], { json: true, since: "2026-10-03" });
  assert.equal(JSON.parse(none.out.join("\n")).totals.turns, 0);
});

test("several meshes are separate projects by default, labelled by their mesh id", async () => {
  const one = mesh([TURNS[0]!]);
  const two = mesh([TURNS[1]!]);
  assert.notEqual(one.meshId, two.meshId);
  const r = await run([one.configPath, two.configPath], { json: true });
  const report = JSON.parse(r.out.join("\n"));
  assert.deepEqual(report.groupBy, ["day", "project", "agent"]);
  assert.deepEqual(new Set(report.rows.map((x: { project: string }) => x.project)), new Set([one.meshId, two.meshId]));
  const merged = await run([one.configPath, two.configPath], { json: true, by: "day" });
  assert.equal(JSON.parse(merged.out.join("\n")).totals.turns, 2, "asking for no project column sums across meshes");
});

test("--all reads every registered project, and a project whose config will not load is said, not fatal", async () => {
  const good = mesh([TURNS[0]!]);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-usage-home-"));
  const ref = (id: string, root: string, configPath: string): ProjectRef => ({ id, name: id, root, configPath, addedAt: NOW.toISOString() });
  writeProjectsFile(projectsFilePath(home), [ref("good", good.dir, good.configPath), ref("broken", "/nonexistent", "/nonexistent/mesh.yaml")]);

  const r = await run([], { all: true, json: true, by: "project" }, { home });
  assert.equal(r.code, 0, r.err.join("\n"));
  const report = JSON.parse(r.out.join("\n"));
  assert.deepEqual(report.rows.map((x: { project: string }) => x.project), ["good"]);
  assert.equal(report.skipped[0].project, "broken");

  const table = await run([], { all: true }, { home });
  assert.equal(table.code, 0);
  assert.match(table.err.join("\n"), /skipped project broken/);

  const both = await run([good.configPath], { all: true }, { home });
  assert.equal(both.code, 2, "--all and a path are two answers to which meshes");
});

test("the plan gate: warn notes and answers, enforce refuses Community with the way out, Team and off say nothing", async () => {
  const m = mesh(TURNS);
  const warn = await run([m.configPath], { json: true }, { env: { MESH_LICENSE_ENFORCEMENT: "warn" } });
  assert.equal(warn.code, 0, "warn never refuses");
  assert.match(warn.err.join("\n"), /note: Usage export is not part of the Community plan/);
  assert.match(JSON.parse(warn.out.join("\n")).licenseWarning, /not part of the Community plan/);

  await assert.rejects(
    run([m.configPath], { json: true }, { env: { MESH_LICENSE_ENFORCEMENT: "enforce" } }),
    (e: unknown) => e instanceof LicenseLimitError && /Usage export is not part of the Community plan/.test(e.message),
  );

  const paid = await run([m.configPath], { json: true }, { env: { MESH_LICENSE_ENFORCEMENT: "enforce", MESH_LICENSE: team() } });
  assert.equal(paid.code, 0);
  assert.equal(paid.err.length, 0);
  assert.equal(JSON.parse(paid.out.join("\n")).licenseWarning, undefined);

  const off = await run([m.configPath], { json: true }, { env: { MESH_LICENSE_ENFORCEMENT: "off" } });
  assert.equal(off.code, 0);
  assert.equal(off.err.length, 0, "off checks nothing");
});

test("a malformed request is exit 2 and says what to fix, before the plan is consulted", async () => {
  const m = mesh(TURNS);
  const env = { MESH_LICENSE_ENFORCEMENT: "enforce" };
  const cases: Array<[Record<string, string | boolean>, RegExp]> = [
    [{ by: "planet" }, /'planet' is not a dimension/],
    [{ since: "yesterday" }, /since 'yesterday' is not a date/],
    [{ until: "2026-13-45" }, /until '2026-13-45' is not a date/],
    [{ since: true }, /--since needs a value/],
    [{ by: true }, /--by needs a value/],
    [{ json: true, csv: true }, /pick one/],
  ];
  for (const [flags, message] of cases) {
    const r = await run([m.configPath], flags, { env });
    assert.equal(r.code, 2, JSON.stringify(flags));
    assert.match(r.err.join("\n"), message, JSON.stringify(flags));
  }
  const missing = await run([path.join(m.dir, "nope.yaml")], {}, { env });
  assert.equal(missing.code, 2);
  assert.match(missing.err.join("\n"), /no such file/);
  const none = await run([], {}, { env: { MESH_CONFIG: path.join(m.dir, "also-nope.yaml") } });
  assert.equal(none.code, 2, "no path and no mesh.yaml where it would be");
  const help = await run([], { help: true });
  assert.equal(help.out.join("\n"), USAGE_HELP);
});

test("a mesh with no log yet is an empty report, not an error", async () => {
  const m = mesh([]);
  fs.rmSync(path.join(resolveConfig(m.configPath).stateDir, "logs", "events.jsonl"));
  const r = await run([m.configPath]);
  assert.equal(r.code, 0);
  assert.match(r.out.join("\n"), /^total\b.*\$0\.00$/m);
  assert.match(r.out.join("\n"), /0 turn\(s\)/);
});
