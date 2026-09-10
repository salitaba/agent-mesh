import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  FileProjectRegistry,
  ProjectError,
  meshHome,
  projectsFilePath,
  readProjectsFile,
  withRegistryLock,
  writeProjectsFile,
  type ProjectRef,
  type ProjectStatus,
  type ProjectSupervisor,
} from "../../packages/projects/src/index";
import { testConfigYaml } from "../helpers";

const AGENTS = { agents: [{ id: "a", role: "r", interests: [] }], mayContact: { a: [] } };

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mesh-projects-"));
}

/** A project folder on disk: `<base>/<folder>/mesh.yaml` with an optional id. */
function makeProject(base: string, folder: string, project?: { id?: string; name?: string }): string {
  const dir = path.join(base, folder);
  fs.mkdirSync(dir, { recursive: true });
  const block = project
    ? `project:\n  id: ${project.id}\n${project.name ? `  name: ${project.name}\n` : ""}`
    : "";
  fs.writeFileSync(path.join(dir, "mesh.yaml"), `${block}${testConfigYaml(AGENTS)}`, "utf8");
  return dir;
}

function registryIn(home: string, supervisor?: ProjectSupervisor): FileProjectRegistry {
  const opts: { home: string; supervisor?: ProjectSupervisor } = { home };
  if (supervisor) opts.supervisor = supervisor;
  return new FileProjectRegistry(opts);
}

test("MESH_HOME overrides the registry location and is read per call", () => {
  const before = process.env.MESH_HOME;
  try {
    delete process.env.MESH_HOME;
    assert.equal(meshHome(), path.join(os.homedir(), ".agent-mesh"));

    const base = tmpRoot();
    process.env.MESH_HOME = base;
    assert.equal(meshHome(), path.resolve(base));
    assert.equal(projectsFilePath(meshHome()), path.join(path.resolve(base), "projects.json"));

    // An explicit env object wins over the ambient one, so a host can hold two.
    assert.equal(meshHome({ MESH_HOME: "/tmp/elsewhere" } as NodeJS.ProcessEnv), "/tmp/elsewhere");
    // Whitespace-only is not an override; that would silently relocate state.
    assert.equal(meshHome({ MESH_HOME: "  " } as NodeJS.ProcessEnv), path.join(os.homedir(), ".agent-mesh"));
  } finally {
    if (before === undefined) delete process.env.MESH_HOME;
    else process.env.MESH_HOME = before;
  }
});

test("a missing registry file is an empty registry, not an error", () => {
  const base = tmpRoot();
  const registry = registryIn(path.join(base, "home"));
  assert.deepEqual(registry.list(), []);
  // Reading must not create the file: `mesh --help` should not write to $HOME.
  assert.equal(fs.existsSync(registry.file), false);
});

test("add registers a project without booting it", async () => {
  const base = tmpRoot();
  const root = makeProject(base, "payments", { id: "payment-api", name: "Payment API" });
  const registry = registryIn(path.join(base, "home"));

  const ref = await registry.add(root);
  assert.equal(ref.id, "payment-api");
  assert.equal(ref.name, "Payment API");
  assert.equal(ref.root, fs.realpathSync(root));
  assert.equal(ref.configPath, path.join(fs.realpathSync(root), "mesh.yaml"));
  assert.ok(ref.addedAt);
  assert.equal(ref.lastOpenedAt, undefined);

  // add() is registration only — step 3 owns spawning.
  assert.equal(registry.get("payment-api")?.status, "closed");
  assert.deepEqual(registry.openIds(), []);

  // And it is durable: a second host sees it.
  assert.deepEqual(
    registryIn(path.join(base, "home")).list().map((r) => r.id),
    ["payment-api"],
  );
});

test("add derives id and name from a mesh.yaml with no project block", async () => {
  const base = tmpRoot();
  const root = makeProject(base, "My Service");
  const registry = registryIn(path.join(base, "home"));
  const ref = await registry.add(root);
  // Derived from the folder name, per the migration path in step 1.
  assert.equal(ref.id, "my-service");
});

test("add accepts a direct mesh.yaml path as well as a folder", async () => {
  const base = tmpRoot();
  const root = makeProject(base, "direct", { id: "direct" });
  const registry = registryIn(path.join(base, "home"));
  const ref = await registry.add(path.join(root, "mesh.yaml"));
  assert.equal(ref.id, "direct");
  assert.equal(ref.root, fs.realpathSync(root));
});

test("re-adding the same folder is a focus no-op, not a duplicate", async () => {
  const base = tmpRoot();
  const root = makeProject(base, "repeat", { id: "repeat" });
  const registry = registryIn(path.join(base, "home"));

  const first = await registry.add(root);
  const again = await registry.add(root);
  assert.equal(again.id, first.id);
  assert.equal(again.addedAt, first.addedAt, "the original entry is returned, not a fresh one");
  assert.equal(registry.list().length, 1);

  // Reached through a symlink it is still the same folder.
  const link = path.join(base, "repeat-link");
  fs.symlinkSync(root, link, "dir");
  const viaLink = await registry.add(link);
  assert.equal(viaLink.addedAt, first.addedAt);
  assert.equal(registry.list().length, 1, "a symlink must not create a second entry");

  // As is a non-normalized path to it.
  await registry.add(path.join(root, "..", "repeat"));
  assert.equal(registry.list().length, 1);

  assert.equal(registry.findByRoot(link)?.id, "repeat");
});

test("clone collision: a second folder with the same id is rejected, never coexists", async () => {
  const base = tmpRoot();
  const original = makeProject(base, "original", { id: "payment-api" });
  const clone = makeProject(base, "clone", { id: "payment-api" });
  const registry = registryIn(path.join(base, "home"));

  await registry.add(original);
  await assert.rejects(
    () => registry.add(clone),
    (err: unknown) => {
      assert.ok(err instanceof ProjectError);
      assert.equal(err.code, "duplicate_id");
      assert.match(err.message, /payment-api/);
      assert.ok(err.detail?.includes(path.join(fs.realpathSync(clone), "mesh.yaml")), "names the file to edit");
      return true;
    },
  );

  assert.equal(registry.list().length, 1, "two entries with one id means two tabs racing for one lock");
  assert.equal(registry.list()[0].root, fs.realpathSync(original));
  // The rejection must not have half-written anything.
  assert.equal(readProjectsFile(registry.file).length, 1);

  // Renaming the clone resolves it, exactly as the error instructs.
  fs.writeFileSync(
    path.join(clone, "mesh.yaml"),
    `project:\n  id: payment-api-clone\n${testConfigYaml(AGENTS)}`,
    "utf8",
  );
  const renamed = await registry.add(clone);
  assert.equal(renamed.id, "payment-api-clone");
  assert.equal(registry.list().length, 2);
});

test("add rejects paths that are not projects", async () => {
  const base = tmpRoot();
  const registry = registryIn(path.join(base, "home"));

  await assert.rejects(
    () => registry.add(path.join(base, "nope")),
    (err: unknown) => err instanceof ProjectError && err.code === "missing",
  );

  const empty = path.join(base, "empty");
  fs.mkdirSync(empty);
  await assert.rejects(
    () => registry.add(empty),
    (err: unknown) => err instanceof ProjectError && err.code === "missing",
  );

  const broken = path.join(base, "broken");
  fs.mkdirSync(broken);
  fs.writeFileSync(path.join(broken, "mesh.yaml"), "version: 1\nmesh: {}\n", "utf8");
  await assert.rejects(
    () => registry.add(broken),
    (err: unknown) => err instanceof ProjectError && err.code === "invalid_config",
  );
  assert.equal(registry.list().length, 0);
});

test("open marks the project open, stamps lastOpenedAt, and persists it", async () => {
  const base = tmpRoot();
  const home = path.join(base, "home");
  const root = makeProject(base, "openable", { id: "openable" });
  const registry = registryIn(home);
  await registry.add(root);

  const handle = await registry.open("openable");
  assert.equal(handle.status, "open");
  assert.ok(handle.ref.lastOpenedAt);
  assert.deepEqual(registry.openIds(), ["openable"]);
  assert.equal(registry.get("openable")?.status, "open");

  // lastOpenedAt survives a reload by another host — it drives tab ordering.
  assert.ok(registryIn(home).list()[0].lastOpenedAt);

  // Opening twice returns the same handle rather than launching again.
  const second = await registry.open("openable");
  assert.equal(second.ref.lastOpenedAt, handle.ref.lastOpenedAt);
});

test("open surfaces supervisor endpoint, pid and failure states", async () => {
  const base = tmpRoot();
  const root = makeProject(base, "supervised", { id: "supervised" });
  let status: ProjectStatus = "open";
  const supervisor: ProjectSupervisor = {
    async launch() {
      if (status === "open") return { status, endpoint: { port: 41234, token: "t0k" }, pid: 4242 };
      return { status, error: { reason: "locked", detail: "held by pid 99" } };
    },
    async stop() {},
  };
  const registry = registryIn(path.join(base, "home"), supervisor);
  await registry.add(root);

  const up = await registry.open("supervised");
  assert.equal(up.status, "open");
  assert.deepEqual(up.endpoint, { port: 41234, token: "t0k" });
  assert.equal(up.pid, 4242);

  await registry.close("supervised");
  status = "locked";
  const down = await registry.restart("supervised");
  assert.equal(down.status, "locked");
  assert.equal(down.error?.reason, "locked");
  assert.deepEqual(registry.openIds(), [], "a locked project is not open");
});

test("stale entry: a missing config yields status error with reason missing, entry kept", async () => {
  const base = tmpRoot();
  const home = path.join(base, "home");
  const root = makeProject(base, "vanishing", { id: "vanishing" });
  const registry = registryIn(home);
  await registry.add(root);

  fs.rmSync(root, { recursive: true, force: true });

  const handle = await registry.open("vanishing");
  assert.equal(handle.status, "error");
  assert.equal(handle.error?.reason, "missing");
  assert.match(handle.error?.detail ?? "", /mesh\.yaml/);

  // Kept, so the user can re-point or remove it. Never silently dropped.
  assert.equal(registry.list().length, 1);
  assert.equal(readProjectsFile(registry.file).length, 1);
  assert.deepEqual(registry.openIds(), []);
});

test("stale entry: a config that no longer parses is an error, not a crash", async () => {
  const base = tmpRoot();
  const root = makeProject(base, "rotting", { id: "rotting" });
  const registry = registryIn(path.join(base, "home"));
  await registry.add(root);

  fs.writeFileSync(path.join(root, "mesh.yaml"), "version: 1\nmesh: {}\n", "utf8");
  const handle = await registry.open("rotting");
  assert.equal(handle.status, "error");
  assert.equal(handle.error?.reason, "invalid_config");
  assert.equal(registry.list().length, 1);
});

test("open of an unknown id throws rather than inventing an entry", async () => {
  const base = tmpRoot();
  const registry = registryIn(path.join(base, "home"));
  await assert.rejects(
    () => registry.open("ghost"),
    (err: unknown) => err instanceof ProjectError && err.code === "unknown_project",
  );
  assert.equal(registry.get("ghost"), undefined);
});

test("remove closes first and never deletes user files", async () => {
  const base = tmpRoot();
  const home = path.join(base, "home");
  const root = makeProject(base, "removable", { id: "removable" });
  const stopped: string[] = [];
  const registry = registryIn(home, {
    async launch() {
      return { status: "open" as ProjectStatus };
    },
    async stop(ref: ProjectRef) {
      stopped.push(ref.id);
    },
  });
  await registry.add(root);
  await registry.open("removable");

  await registry.remove("removable");
  assert.deepEqual(stopped, ["removable"], "remove must close the child before dropping the pointer");
  assert.deepEqual(registry.list(), []);
  assert.equal(registry.get("removable"), undefined);
  assert.deepEqual(registry.openIds(), []);
  assert.ok(fs.existsSync(path.join(root, "mesh.yaml")), "the user's files are not ours to delete");

  // Removing twice is not an error.
  await registry.remove("removable");
  // And the folder can be added back afterwards.
  assert.equal((await registry.add(root)).id, "removable");
});

test("close is idempotent for closed and unknown projects", async () => {
  const base = tmpRoot();
  const root = makeProject(base, "quiet", { id: "quiet" });
  const registry = registryIn(path.join(base, "home"));
  await registry.add(root);
  await registry.close("quiet");
  await registry.close("never-existed");
  assert.equal(registry.get("quiet")?.status, "closed");
});

test("handles are copies: mutating a returned ref cannot corrupt the registry", async () => {
  const base = tmpRoot();
  const root = makeProject(base, "immutable", { id: "immutable" });
  const registry = registryIn(path.join(base, "home"));
  await registry.add(root);

  const listed = registry.list();
  listed[0].id = "hacked";
  listed[0].root = "/etc";
  assert.equal(registry.list()[0].id, "immutable");

  const handle = registry.get("immutable");
  if (handle) handle.ref.name = "clobbered";
  assert.notEqual(registry.get("immutable")?.ref.name, "clobbered");
});

test("registry writes are atomic: a reader never sees a partial file", async () => {
  const base = tmpRoot();
  const file = path.join(base, "home", "projects.json");
  const refs: ProjectRef[] = Array.from({ length: 200 }, (_, i) => ({
    id: `p-${i}`,
    name: `Project ${i}`,
    root: `/tmp/p-${i}`,
    configPath: `/tmp/p-${i}/mesh.yaml`,
    addedAt: new Date().toISOString(),
  }));
  writeProjectsFile(file, refs.slice(0, 1));

  let reads = 0;
  const stop = { done: false };
  const reader = (async () => {
    while (!stop.done) {
      // Every observation must be a complete, parseable registry.
      const seen = readProjectsFile(file);
      assert.ok(seen.length === 1 || seen.length === refs.length, `saw ${seen.length} entries mid-write`);
      reads += 1;
      await new Promise((r) => setImmediate(r));
    }
  })();

  for (let i = 0; i < 40; i += 1) {
    writeProjectsFile(file, i % 2 === 0 ? refs : refs.slice(0, 1));
    await new Promise((r) => setImmediate(r));
  }
  stop.done = true;
  await reader;
  assert.ok(reads > 0);
  // No scratch files left behind.
  assert.deepEqual(
    fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith(".tmp")),
    [],
  );
});

test("concurrent adds under the registry lock keep every entry", async () => {
  const base = tmpRoot();
  const home = path.join(base, "home");
  const roots = Array.from({ length: 8 }, (_, i) => makeProject(base, `concurrent-${i}`, { id: `concurrent-${i}` }));

  // Separate instances stand in for separate hosts: each does its own
  // read-modify-write, which is exactly what last-writer-wins would shred.
  const results = await Promise.all(roots.map((root) => registryIn(home).add(root)));
  assert.equal(new Set(results.map((r) => r.id)).size, 8);

  const onDisk = readProjectsFile(projectsFilePath(home));
  assert.equal(onDisk.length, 8, "concurrent hosts must not shred the registry");
  assert.deepEqual(
    onDisk.map((r) => r.id).sort(),
    roots.map((_, i) => `concurrent-${i}`).sort(),
  );
});

test("the registry lock serializes mutations and is reclaimed if abandoned", async () => {
  const base = tmpRoot();
  const file = path.join(base, "home", "projects.json");
  const order: string[] = [];
  await Promise.all([
    withRegistryLock(file, async () => {
      order.push("a:start");
      await new Promise((r) => setTimeout(r, 20));
      order.push("a:end");
    }),
    withRegistryLock(file, async () => {
      order.push("b:start");
      order.push("b:end");
    }),
  ]);
  // Interleaving would put b:start between a:start and a:end.
  assert.ok(
    order.join(",") === "a:start,a:end,b:start,b:end" || order.join(",") === "b:start,b:end,a:start,a:end",
    `mutations interleaved: ${order.join(",")}`,
  );

  // The lock is released even when the body throws — a failed add must not
  // wedge the registry for the rest of the session.
  await assert.rejects(() => withRegistryLock(file, () => Promise.reject(new Error("boom"))), /boom/);
  assert.equal(fs.existsSync(`${file}.lock`), false);
  assert.equal(await withRegistryLock(file, () => "recovered"), "recovered");
});

test("a stale lock from a killed host is reclaimed rather than wedging forever", async () => {
  const base = tmpRoot();
  const file = path.join(base, "home", "projects.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lockFile = `${file}.lock`;
  fs.writeFileSync(lockFile, "999999", "utf8");
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockFile, old, old);

  assert.equal(await withRegistryLock(file, () => "took it"), "took it");
});

test("registry file: junk entries are dropped but a broken file is loud", () => {
  const base = tmpRoot();
  const file = path.join(base, "home", "projects.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });

  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      projects: [
        { id: "good", name: "Good", root: "/tmp/good", configPath: "/tmp/good/mesh.yaml", addedAt: "2024-01-01T00:00:00.000Z" },
        { id: "no-root" },
        null,
        "nonsense",
        { id: "good", root: "/tmp/other", configPath: "/tmp/other/mesh.yaml", addedAt: "2024-01-01T00:00:00.000Z" },
        { id: "minimal", root: "/tmp/minimal", configPath: "/tmp/minimal/mesh.yaml" },
      ],
    }),
    "utf8",
  );
  const refs = readProjectsFile(file);
  assert.deepEqual(refs.map((r) => r.id), ["good", "minimal"], "one bad line must not cost every project");
  assert.equal(refs[1].name, "minimal", "a missing name falls back to the id");
  assert.ok(refs[1].addedAt, "a missing addedAt is filled rather than left undefined");

  // Structural damage is not silently an empty registry: that looks like data loss.
  fs.writeFileSync(file, "{ not json", "utf8");
  assert.throws(
    () => readProjectsFile(file),
    (err: unknown) => err instanceof ProjectError && err.code === "registry_corrupt",
  );

  fs.writeFileSync(file, JSON.stringify({ version: 1 }), "utf8");
  assert.throws(
    () => readProjectsFile(file),
    (err: unknown) => err instanceof ProjectError && err.code === "registry_corrupt",
  );

  // A file from a newer agent-mesh must not be downgraded by writing over it.
  fs.writeFileSync(file, JSON.stringify({ version: 99, projects: [] }), "utf8");
  assert.throws(
    () => readProjectsFile(file),
    (err: unknown) => err instanceof ProjectError && err.code === "registry_corrupt",
  );

  // An empty file is an empty registry, not corruption: that is a fresh install
  // interrupted between create and write.
  fs.writeFileSync(file, "", "utf8");
  assert.deepEqual(readProjectsFile(file), []);
});

test("the persisted registry keeps the documented shape", async () => {
  const base = tmpRoot();
  const home = path.join(base, "home");
  const root = makeProject(base, "shaped", { id: "shaped", name: "Shaped" });
  await registryIn(home).add(root);

  const raw = JSON.parse(fs.readFileSync(projectsFilePath(home), "utf8"));
  assert.equal(raw.version, 1);
  assert.equal(raw.projects.length, 1);
  assert.deepEqual(
    Object.keys(raw.projects[0]).sort(),
    ["addedAt", "configPath", "id", "name", "root"],
  );
  // Pointer list only: no mesh state ever lives in the registry.
  const text = fs.readFileSync(projectsFilePath(home), "utf8");
  for (const forbidden of ["events", "agents", "goal", "snapshot"]) {
    assert.ok(!text.includes(`"${forbidden}"`), `registry must not carry ${forbidden}`);
  }
});
