/**
 * Each project's last known scheduler mode is durable, not per-process.
 *
 * The host learns a project's mode from the child's own heartbeat and keeps it
 * in memory — which is enough for a restart of the *child* and useless for a
 * restart of the *host*: the new process starts with an empty memory, spawns
 * every child in its own default (`parked` on a host booted without `--live`),
 * and a mission the operator had running sits there until they press Start.
 *
 * So the mode also rides on the project's entry in `projects.json` — the host's
 * existing durable per-project state, written by the existing temp-file-plus-
 * rename writer inside the existing registry lock. These tests are about that
 * layer: what is written, that it is written once per change rather than once
 * per beat, and that a write that fails cannot leave a broken registry behind.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  ChildProcessSupervisor,
  FileProjectRegistry,
  readProjectsFile,
  writeProjectsFile,
  type ProjectRef,
} from "../../packages/projects/src/index";
import { testConfigYaml } from "../helpers";

const AGENTS = { agents: [{ id: "a", role: "r", interests: [] }], mayContact: { a: [] } };

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mesh-mode-persist-"));
}

function makeProject(base: string, folder: string, id: string): string {
  const dir = path.join(base, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "mesh.yaml"), `project:\n  id: ${id}\n${testConfigYaml(AGENTS)}`, "utf8");
  return dir;
}

function refFor(base: string, lastMode?: "parked" | "live"): ProjectRef {
  const ref: ProjectRef = {
    id: "alpha",
    name: "alpha",
    root: base,
    configPath: path.join(base, "mesh.yaml"),
    addedAt: new Date(0).toISOString(),
  };
  if (lastMode) ref.lastMode = lastMode;
  return ref;
}

test("a mode change is reported once, not once per beat", () => {
  const seen: Array<[string, string]> = [];
  const supervisor = new ChildProcessSupervisor({ onModeChange: (id, mode) => seen.push([id, mode]) });

  // The child beats every ~2s. For an hour of a live mission that is ~1800
  // reports of the same fact, and every one of them must not be a disk write.
  supervisor.rememberMode("alpha", "live");
  for (let i = 0; i < 10; i++) supervisor.rememberMode("alpha", "live");
  assert.deepEqual(seen, [["alpha", "live"]], "an unchanged beat is not a change");
  assert.equal(supervisor.modeFor("alpha"), "live", "the memory still follows every beat");

  supervisor.rememberMode("alpha", "parked");
  supervisor.rememberMode("beta", "live");
  assert.deepEqual(
    seen,
    [["alpha", "live"], ["alpha", "parked"], ["beta", "live"]],
    "a change is reported, and so is a different project's",
  );
});

test("the persisted mode round-trips, and an unchanged one is not a write", async () => {
  const base = tmpRoot();
  const root = makeProject(base, "payments", "payment-api");
  const home = path.join(base, "home");
  const file = path.join(home, "projects.json");
  const registry = new FileProjectRegistry({ home });
  try {
    await registry.add(root);
    await registry.setMode("payment-api", "live");
    assert.equal(readProjectsFile(file)[0].lastMode, "live", "the mode reaches disk");
    assert.equal(registry.list()[0].lastMode, "live", "and the registry's own list follows it");

    // A key only a write could remove. If a repeat were a write, this would be
    // gone; the registry rewrites the whole document from its own shape.
    const doc = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    doc.sentinel = "hand-edited";
    fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    await registry.setMode("payment-api", "live");
    assert.equal(
      (JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>).sentinel,
      "hand-edited",
      "the same mode again is not a write",
    );

    await registry.setMode("payment-api", "parked");
    assert.equal(readProjectsFile(file)[0].lastMode, "parked");
    assert.equal(
      (JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>).sentinel,
      undefined,
      "a real change is a write",
    );

    // A removed project is not resurrected by a late write, and its entry goes
    // with it — a re-add must not inherit what the folder used to be doing.
    await registry.remove("payment-api");
    await registry.setMode("payment-api", "live");
    assert.deepEqual(readProjectsFile(file), []);

    // And the mode is what the *next* host process reads, which is the whole
    // point: a fresh registry over the same home knows it was live.
    await registry.add(root);
    await registry.setMode("payment-api", "live");
    assert.equal(new FileProjectRegistry({ home }).list()[0].lastMode, "live", "a second host sees it");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("an unrecognised lastMode is dropped rather than obeyed", () => {
  const base = tmpRoot();
  const file = path.join(base, "projects.json");
  const entry = (id: string, lastMode: unknown): Record<string, unknown> => ({
    id,
    name: id,
    root: base,
    configPath: path.join(base, "mesh.yaml"),
    addedAt: new Date(0).toISOString(),
    lastMode,
  });
  fs.writeFileSync(
    file,
    JSON.stringify({ version: 1, projects: [entry("a", "running"), entry("b", "live"), entry("c", null)] }),
    "utf8",
  );
  const refs = readProjectsFile(file);
  assert.equal(refs[0].lastMode, undefined, "a value that is not a mode is not a mode");
  assert.equal(refs[1].lastMode, "live");
  assert.equal(refs[2].lastMode, undefined);
  fs.rmSync(base, { recursive: true, force: true });
});

/**
 * The failure path of the writer every mode write goes through.
 *
 * `writeProjectsFile` builds the document in a scratch file and renames it over
 * the target, so a host killed mid-write leaves the previous registry intact.
 * An unwritable directory is the closest a test can get to a killed write: the
 * scratch file cannot be created at all.
 */
test("a write that fails leaves the previous registry intact, and no scratch behind", () => {
  const base = tmpRoot();
  const home = path.join(base, "home");
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, "projects.json");
  try {
    writeProjectsFile(file, [refFor(base, "live")]);
    const before = fs.readFileSync(file, "utf8");

    if (process.getuid?.() !== 0) {
      fs.chmodSync(home, 0o500);
      try {
        assert.throws(() => writeProjectsFile(file, [refFor(base, "parked")]), "an unwritable home must throw");
      } finally {
        fs.chmodSync(home, 0o700);
      }
      assert.equal(fs.readFileSync(file, "utf8"), before, "the store is never half-written");
      assert.deepEqual(
        fs.readdirSync(home).filter((f) => f.endsWith(".tmp")),
        [],
        "no scratch file is left behind",
      );
      assert.equal(readProjectsFile(file)[0].lastMode, "live", "and the previous value is still the truth");
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
