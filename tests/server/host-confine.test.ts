/**
 * A host with a network address must not be a way to walk its filesystem.
 *
 * With `MESH_PROJECTS_ROOT` set (the image and the chart set it), the registry only takes folders under
 * it, `init` only scaffolds under it, the folder picker cannot leave it, and a malformed file's parse
 * error does not carry the file's own lines into the API's answer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { startHostServer, browseDir, type HostHandle } from "../../apps/mesh-server/src/host";
import { insideRoots, projectRoots, realLocation } from "../../apps/mesh-server/src/confine";
import { testConfigYaml } from "../helpers";

const AGENTS = { agents: [{ id: "a", role: "r", interests: [] }], mayContact: { a: [] } };

function call(base: string, method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: Number(u.port), method, path: p, headers: { "content-type": "application/json" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        let json: any;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

const savedRoot = process.env.MESH_PROJECTS_ROOT;
const savedToken = process.env.MESH_API_TOKEN;

interface Layout {
  base: string;
  projects: string;
  outside: string;
  host: HostHandle;
}

async function withHost(fn: (l: Layout) => Promise<void>, confined = true): Promise<void> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-confine-"));
  const projects = path.join(base, "projects");
  const outside = path.join(base, "elsewhere");
  fs.mkdirSync(projects);
  fs.mkdirSync(outside);
  delete process.env.MESH_API_TOKEN;
  if (confined) process.env.MESH_PROJECTS_ROOT = projects;
  else delete process.env.MESH_PROJECTS_ROOT;
  const host = await startHostServer({ home: path.join(base, "home"), port: 0, dashboardDir: path.join(base, "none") });
  try {
    await fn({ base, projects, outside, host });
  } finally {
    await host.close();
    if (savedRoot === undefined) delete process.env.MESH_PROJECTS_ROOT;
    else process.env.MESH_PROJECTS_ROOT = savedRoot;
    if (savedToken === undefined) delete process.env.MESH_API_TOKEN;
    else process.env.MESH_API_TOKEN = savedToken;
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function mesh(dir: string, id: string): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "mesh.yaml"), `project:\n  id: ${id}\n${testConfigYaml(AGENTS)}`, "utf8");
  return dir;
}

test("a folder under the projects directory is registered", { timeout: 30_000 }, async () => {
  await withHost(async ({ projects, host }) => {
    const dir = mesh(path.join(projects, "alpha"), "alpha");
    const r = await call(host.url, "POST", "/api/projects", { root: dir });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.id, "alpha");
  });
});

test("a folder outside it is refused with the setting named, and nothing is registered", { timeout: 30_000 }, async () => {
  await withHost(async ({ outside, host }) => {
    const dir = mesh(path.join(outside, "beta"), "beta");
    const r = await call(host.url, "POST", "/api/projects", { root: dir });
    assert.equal(r.status, 403);
    assert.equal(r.json.code, "outside_projects_root");
    assert.match(r.json.error, /MESH_PROJECTS_ROOT/);
    assert.deepEqual((await call(host.url, "GET", "/api/projects")).json.projects, []);
  });
});

test("a link inside the projects directory that points out of it does not make the target inside", { timeout: 30_000 }, async () => {
  await withHost(async ({ projects, outside, host }) => {
    mesh(path.join(outside, "gamma"), "gamma");
    fs.symlinkSync(path.join(outside, "gamma"), path.join(projects, "gamma-link"));
    const r = await call(host.url, "POST", "/api/projects", { root: path.join(projects, "gamma-link") });
    assert.equal(r.status, 403, "judged by where it really is");
  });
});

test("`..` out of the directory is the same as naming the outside directly", { timeout: 30_000 }, async () => {
  await withHost(async ({ projects, outside, host }) => {
    mesh(path.join(outside, "delta"), "delta");
    const r = await call(host.url, "POST", "/api/projects", { root: `${projects}/../elsewhere/delta` });
    assert.equal(r.status, 403);
  });
});

test("init does not scaffold outside the projects directory, nor leave anything behind", { timeout: 30_000 }, async () => {
  await withHost(async ({ outside, host }) => {
    const target = path.join(outside, "fresh");
    const r = await call(host.url, "POST", "/api/projects", { root: target, init: true });
    assert.equal(r.status, 403);
    assert.equal(fs.existsSync(target), false, "no directory, no mesh.yaml");
  });
});

test("init under the projects directory still scaffolds, including a folder that does not exist yet", { timeout: 30_000 }, async () => {
  await withHost(async ({ projects, host }) => {
    const target = path.join(projects, "new", "deep");
    const r = await call(host.url, "POST", "/api/projects", { root: target, init: true });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.ok(fs.existsSync(path.join(target, "mesh.yaml")));
  });
});

test("a folder that does not exist yet is judged by the real location of what it would hang from", { timeout: 30_000 }, async () => {
  await withHost(async ({ projects, outside, host }) => {
    fs.symlinkSync(outside, path.join(projects, "door"));
    const r = await call(host.url, "POST", "/api/projects", { root: path.join(projects, "door", "never-made"), init: true });
    assert.equal(r.status, 403, "the link is how it would get out");
    assert.equal(fs.existsSync(path.join(outside, "never-made")), false);
  });
});

test("the folder picker starts at the projects directory, cannot leave it, and has no parent at its top", { timeout: 30_000 }, async () => {
  await withHost(async ({ projects, outside, host }) => {
    mesh(path.join(projects, "one"), "one");
    fs.mkdirSync(path.join(projects, "two"));
    const top = await call(host.url, "GET", "/api/browse");
    assert.equal(top.status, 200);
    assert.equal(top.json.path, fs.realpathSync(projects));
    assert.equal(top.json.parent, null, "no 'up' above the projects directory");
    assert.deepEqual(top.json.entries.map((e: { name: string }) => e.name), ["one", "two"]);
    assert.equal(top.json.entries.find((e: { name: string }) => e.name === "one").hasMesh, true);

    const inner = await call(host.url, "GET", `/api/browse?path=${encodeURIComponent(path.join(projects, "one"))}`);
    assert.equal(inner.status, 200);
    assert.equal(inner.json.parent, fs.realpathSync(projects), "up goes as far as the top");

    for (const escape of [outside, "/", "/etc", `${projects}/..`, path.join(projects, "one", "..", "..", "elsewhere")]) {
      const r = await call(host.url, "GET", `/api/browse?path=${encodeURIComponent(escape)}`);
      assert.equal(r.status, 403, escape);
      assert.equal(r.json.code, "outside_projects_root", escape);
    }
  });
});

test("without MESH_PROJECTS_ROOT nothing changes: the laptop default", { timeout: 30_000 }, async () => {
  await withHost(async ({ outside, host }) => {
    const dir = mesh(path.join(outside, "free"), "free");
    assert.equal((await call(host.url, "POST", "/api/projects", { root: dir })).status, 201);
    assert.equal((await call(host.url, "GET", `/api/browse?path=${encodeURIComponent(outside)}`)).status, 200);
  }, false);
});

test("a malformed config's parse error does not echo the file's own lines through the API", { timeout: 30_000 }, async () => {
  await withHost(async ({ projects, host }) => {
    const dir = path.join(projects, "broken");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "mesh.yaml"), "api_key: sk-live-DO-NOT-LEAK: oops\nsecond: [unclosed\n", "utf8");
    const r = await call(host.url, "POST", "/api/projects", { root: dir });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, "invalid_config");
    assert.doesNotMatch(JSON.stringify(r.json), /DO-NOT-LEAK/, "the offending line is not in the answer");
    assert.match(String(r.json.detail), /line \d+, column \d+/, "but where it is, is");
  });
});

test("the helpers: roots are resolved through links, and containment is by path segment, not by prefix", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-confine-unit-"));
  try {
    const real = path.join(base, "real");
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(base, "link"));
    fs.mkdirSync(path.join(base, "real-evil"));
    const roots = projectRoots({ MESH_PROJECTS_ROOT: path.join(base, "link") });
    assert.deepEqual(roots, [fs.realpathSync(real)]);
    assert.equal(insideRoots(path.join(roots[0]!, "x"), roots), true);
    assert.equal(insideRoots(roots[0]!, roots), true);
    assert.equal(insideRoots(path.join(base, "real-evil"), roots), false, "'real-evil' merely begins like 'real'");
    assert.equal(realLocation(path.join(base, "link", "not", "there")), path.join(fs.realpathSync(real), "not", "there"));
    assert.deepEqual(projectRoots({}), []);
    assert.deepEqual(projectRoots({ MESH_PROJECTS_ROOT: `${path.join(base, "a")}${path.delimiter}${path.join(base, "b")}` }).length, 2);
    assert.equal(browseDir(null, [fs.realpathSync(real)]).path, fs.realpathSync(real));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
