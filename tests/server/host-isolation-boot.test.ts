import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { bootstrapMesh } from "../../apps/mesh-server/src/index";
import { outerSessionEnvNames } from "../../packages/runtime-claude/src/index";
import { testConfigYaml } from "../helpers";

/**
 * The boot log says what the machine will lend every seat.
 *
 * A mesh started from inside another Claude Code session, or by a user whose
 * `~/.claude/settings.json` sets hooks, allow rules, `env` or a model, runs every seat
 * under that inheritance, and none of it is a mesh setting, so none of it was ever
 * visible to the operator. The warning appears only for a mesh that actually runs
 * Claude seats and has not closed the door with `mesh.runtime.isolate_host`.
 */

const AGENTS = { agents: [{ id: "a", role: "r", interests: [] }], mayContact: { a: [] } };

/** Boot a parked mesh over `yaml` with the launching environment set as given; return what it warned. */
async function bootWarnings(yaml: string, env: Record<string, string | undefined>): Promise<string[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-hostiso-"));
  const configPath = path.join(dir, "mesh.yaml");
  fs.writeFileSync(configPath, yaml, "utf8");
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warned.push(args.map(String).join(" "));
  try {
    const mesh = await bootstrapMesh({ configPath, inMemory: true, mode: "parked" });
    await mesh.close();
    return warned;
  } finally {
    console.warn = warn;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The fixture mesh with its seats on the Claude runtime, plus any extra `mesh.runtime` line (YAML, no indent). */
const claudeMesh = (extraRuntimeLine = ""): string =>
  testConfigYaml(AGENTS)
    .replaceAll("runtime: stub", "runtime: claude")
    .replace("default: stub", `default: claude${extraRuntimeLine ? `\n    ${extraRuntimeLine}` : ""}`);

// A config dir with nothing in it, so the only thing that can leak here is the environment under test.
const emptyConfig = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "mesh-hostiso-cfg-"));

// Whatever session THIS suite is running inside, unset: a developer runs these from a Claude Code
// terminal, which is exactly the case being detected, and a session can hold fifty variables of the
// family, more than a warning spells out.
const launchedFromNowhere = (): Record<string, undefined> => Object.fromEntries(outerSessionEnvNames(process.env).map((name) => [name, undefined]));

test("a mesh with Claude seats, started from inside another session, says so at boot and names the knob", async () => {
  const cfg = emptyConfig();
  try {
    const warned = await bootWarnings(claudeMesh(), {
      ...launchedFromNowhere(),
      CLAUDE_CONFIG_DIR: cfg,
      CLAUDE_EFFORT: "max",
      CLAUDE_CODE_SESSION_ID: "11111111-2222-4333-8444-555555555555",
    });
    const leak = warned.find((w) => /another Claude Code session/.test(w));
    assert.ok(leak, `expected a host-isolation warning, got: ${JSON.stringify(warned)}`);
    assert.match(leak, /CLAUDE_CODE_SESSION_ID, CLAUDE_EFFORT/);
    assert.ok(warned.some((w) => /mesh\.runtime\.isolate_host: true/.test(w)), "and the way out");
  } finally {
    fs.rmSync(cfg, { recursive: true, force: true });
  }
});

test("isolate_host closes the door, so there is nothing to warn about", async () => {
  const cfg = emptyConfig();
  try {
    const warned = await bootWarnings(claudeMesh("isolate_host: true"), { CLAUDE_CONFIG_DIR: cfg, CLAUDE_EFFORT: "max" });
    assert.deepEqual(warned.filter((w) => /Claude Code session|isolate_host/.test(w)), []);
  } finally {
    fs.rmSync(cfg, { recursive: true, force: true });
  }
});

test("a mesh that runs no Claude seat has nothing to lend them, so it is not warned", async () => {
  const cfg = emptyConfig();
  try {
    const warned = await bootWarnings(testConfigYaml(AGENTS), { CLAUDE_CONFIG_DIR: cfg, CLAUDE_EFFORT: "max" });
    assert.deepEqual(warned.filter((w) => /Claude Code session|isolate_host/.test(w)), []);
  } finally {
    fs.rmSync(cfg, { recursive: true, force: true });
  }
});

test("a clean launching environment and an empty settings directory boot quietly", async () => {
  const cfg = emptyConfig();
  try {
    const warned = await bootWarnings(claudeMesh(), { CLAUDE_CONFIG_DIR: cfg, ...launchedFromNowhere() });
    assert.deepEqual(warned.filter((w) => /Claude Code session|isolate_host|settings\.json/.test(w)), []);
  } finally {
    fs.rmSync(cfg, { recursive: true, force: true });
  }
});
