/**
 * A symlink in the product checkout must not be a way out of it.
 *
 * A seat writes into the checkout, and so can a commit it merges. `stat` and `readFile` follow links,
 * and the containment check used to be lexical, so `ln -s /proc/self/environ x` made
 * `GET /workspace/file?path=x` return the server's own environment (the operator token among it) and a
 * linked directory could be listed. The checks below hold every route that takes a path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { createHttpServer, closeHttpServer } from "../../apps/mesh-server/src/index";
import { makeMesh } from "../helpers";

function get(base: string, p: string): Promise<{ status: number; json: any; body: string }> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    http
      .get({ host: u.hostname, port: Number(u.port), path: p }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          let json: any;
          try {
            json = JSON.parse(body);
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode ?? 0, json, body });
        });
      })
      .on("error", reject);
  });
}

const saved = process.env.MESH_API_TOKEN;

async function withCheckout(fn: (ctx: { base: string; root: string; outside: string }) => Promise<void>): Promise<void> {
  delete process.env.MESH_API_TOKEN;
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-outside-"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "TOP-SECRET-OUTSIDE", "utf8");
  fs.mkdirSync(path.join(outside, "dir"));
  fs.writeFileSync(path.join(outside, "dir", "inner.txt"), "ALSO-OUTSIDE", "utf8");
  const m = await makeMesh({ agents: [{ id: "a", role: "developer", capabilities: ["repository.write"], interests: [] }], mayContact: { a: [] }, mode: "parked" });
  const server = createHttpServer(m, { dashboardDir: undefined });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await fn({ base, root: m.productPath, outside });
  } finally {
    await closeHttpServer(server);
    await m.cleanup();
    fs.rmSync(outside, { recursive: true, force: true });
    if (saved === undefined) delete process.env.MESH_API_TOKEN;
    else process.env.MESH_API_TOKEN = saved;
  }
}

const q = (rel: string): string => encodeURIComponent(rel);

test("a symlink to a file outside the checkout cannot be read through the workspace routes", async () => {
  await withCheckout(async ({ base, root, outside }) => {
    fs.mkdirSync(root, { recursive: true });
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "leak.txt"));
    fs.symlinkSync("/proc/self/environ", path.join(root, "env.txt"));
    for (const rel of ["leak.txt", "env.txt"]) {
      const r = await get(base, `/workspace/file?path=${q(rel)}`);
      assert.equal(r.status, 400, rel);
      assert.doesNotMatch(r.body, /TOP-SECRET-OUTSIDE|PATH=|MESH_/, `${rel} must not return what it points at`);
    }
  });
});

test("a symlinked directory cannot be listed, searched or read through", async () => {
  await withCheckout(async ({ base, root, outside }) => {
    fs.mkdirSync(root, { recursive: true });
    fs.symlinkSync(path.join(outside, "dir"), path.join(root, "linked"));
    assert.equal((await get(base, `/workspace/tree?path=${q("linked")}`)).status, 400, "the listing of the target");
    assert.equal((await get(base, `/workspace/file?path=${q("linked/inner.txt")}`)).status, 400, "a file beneath the link");
    const search = await get(base, `/workspace/search?q=ALSO&path=${q("linked")}`);
    assert.equal(search.status, 400, "a search scoped to the link");
    const wide = await get(base, `/workspace/search?q=ALSO-OUTSIDE`);
    assert.equal(wide.status, 200);
    assert.deepEqual(wide.json.results, [], "a search from the root does not walk into the link either");
  });
});

test("the root listing shows the link as the thing it is, not as the directory it points at", async () => {
  await withCheckout(async ({ base, root, outside }) => {
    fs.mkdirSync(root, { recursive: true });
    fs.symlinkSync(path.join(outside, "dir"), path.join(root, "linked"));
    fs.writeFileSync(path.join(root, "real.txt"), "mine", "utf8");
    const tree = await get(base, `/workspace/tree?path=`);
    assert.equal(tree.status, 200);
    const linked = (tree.json as Array<{ name: string; type: string }>).find((e) => e.name === "linked");
    assert.equal(linked?.type, "file", "a link is never listed as a directory a client would descend into");
    assert.ok((tree.json as Array<{ name: string }>).some((e) => e.name === "real.txt"));
  });
});

test("a symlink that stays inside the checkout is still fine", async () => {
  await withCheckout(async ({ base, root }) => {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "a.txt"), "inside", "utf8");
    fs.symlinkSync("src/a.txt", path.join(root, "alias.txt"));
    const r = await get(base, `/workspace/file?path=${q("alias.txt")}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.content, "inside");
  });
});

test("a path that does not exist is a 404, not an error, and a lexical escape is still refused", async () => {
  await withCheckout(async ({ base, root }) => {
    fs.mkdirSync(root, { recursive: true });
    assert.equal((await get(base, `/workspace/file?path=${q("nope.txt")}`)).status, 404);
    assert.equal((await get(base, `/workspace/file?path=${q("../../etc/passwd")}`)).status, 400);
  });
});

test("the playground and presets routes do not follow a link out either", async () => {
  await withCheckout(async ({ base, root, outside }) => {
    const pg = path.join(root, "apps", "playground");
    fs.mkdirSync(pg, { recursive: true });
    fs.writeFileSync(path.join(pg, "index.html"), "<p>ok</p>", "utf8");
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(pg, "leak.js"));
    fs.mkdirSync(path.join(root, "presets"), { recursive: true });
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "presets", "leak.json"));
    for (const p of ["/playground/leak.js", "/presets/leak.json"]) {
      const r = await get(base, p);
      assert.equal(r.status, 400, p);
      assert.doesNotMatch(r.body, /TOP-SECRET-OUTSIDE/, p);
    }
    assert.equal((await get(base, "/playground/")).status, 200);
  });
});
