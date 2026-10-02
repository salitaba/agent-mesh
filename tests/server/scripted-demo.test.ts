/**
 * The shipped demo, and only the shipped demo, starts clean and runs a scripted team.
 *
 * The scripted team is what lets a first-time user see the whole flow with no model and no key: under `ordane run`
 * since the beginning, and, now, under a host, where a project of the same name used to boot seven idle seats and
 * do nothing. What it must never do is the other half of the same convention: wipe the state of a real project
 * that happens to carry the example's id.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { isScriptedDemo, startCleanIfScriptedDemo, SCRIPTED_DEMO_MESH_ID } from "../../apps/mesh-server/src/demo";
import { startHostServer } from "../../apps/mesh-server/src/host";
import { findShippedRoot, scaffoldExample } from "../../apps/mesh-cli/src/init";
import { resolveConfig } from "../../packages/config/src/index";

const ROOT = findShippedRoot(__dirname)!;
const tmp = (label: string): string => fs.mkdtempSync(path.join(os.tmpdir(), `mesh-demo-${label}-`));

function demoProject(): { dir: string; configPath: string } {
  const dir = tmp("project");
  scaffoldExample(ROOT, "demo-stub", dir);
  return { dir, configPath: path.join(dir, "mesh.yaml") };
}

test("only the example's id on the stub runtime throughout is the scripted demo", () => {
  const demo = resolveConfig(demoProject().configPath);
  assert.equal(demo.meshId, SCRIPTED_DEMO_MESH_ID);
  assert.equal(isScriptedDemo(demo), true);

  // Same id, but one seat has moved to a real runtime: this is somebody's project.
  const real = demoProject();
  fs.writeFileSync(real.configPath, fs.readFileSync(real.configPath, "utf8").replace(/runtime: stub/, "runtime: claude"));
  assert.equal(isScriptedDemo(resolveConfig(real.configPath)), false, "one real seat is enough");

  // Same team, another name.
  const renamed = demoProject();
  fs.writeFileSync(renamed.configPath, fs.readFileSync(renamed.configPath, "utf8").replace(/^(\s+)id: demo-stub$/m, "$1id: my-team"));
  assert.equal(isScriptedDemo(resolveConfig(renamed.configPath)), false);
});

test("starting clean wipes the demo's state and nobody else's", () => {
  const demo = demoProject();
  const demoCfg = resolveConfig(demo.configPath);
  fs.mkdirSync(path.join(demoCfg.stateDir, "logs"), { recursive: true });
  fs.writeFileSync(path.join(demoCfg.stateDir, "logs", "events.jsonl"), '{"id":"old"}\n');
  assert.equal(startCleanIfScriptedDemo(demoCfg), true);
  assert.equal(fs.existsSync(demoCfg.stateDir), false, "the demo begins from nothing, as under ordane run");

  const real = demoProject();
  fs.writeFileSync(real.configPath, fs.readFileSync(real.configPath, "utf8").replace(/runtime: stub/g, "runtime: claude").replace(/default: stub/, "default: claude"));
  const realCfg = resolveConfig(real.configPath);
  fs.mkdirSync(path.join(realCfg.stateDir, "logs"), { recursive: true });
  const log = path.join(realCfg.stateDir, "logs", "events.jsonl");
  fs.writeFileSync(log, '{"id":"customer-data"}\n');
  assert.equal(realCfg.meshId, SCRIPTED_DEMO_MESH_ID, "it keeps the example's id");
  assert.equal(startCleanIfScriptedDemo(realCfg), false);
  assert.equal(fs.readFileSync(log, "utf8"), '{"id":"customer-data"}\n', "a real project's log survives a restart whatever it is called");
});

function get(url: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
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
      })
      .on("error", reject);
  });
}

test("under a host, the scaffolded demo converges with no model and no key", { timeout: 150_000 }, async () => {
  delete process.env.MESH_API_TOKEN;
  const home = tmp("home");
  const demo = demoProject();
  const host = await startHostServer({ home, port: 0, gitMode: "off", childMode: "live" });
  try {
    const post = async (p: string): Promise<any> => {
      const res = await fetch(host.url + p, { method: "POST", headers: { "content-type": "application/json" }, body: p === "/api/projects" ? JSON.stringify({ root: demo.dir }) : "{}" });
      return res.json();
    };
    const added = await post("/api/projects");
    assert.ok(added.id, JSON.stringify(added));
    const opened = await post(`/api/projects/${added.id}/open`);
    assert.equal(opened.status, "open", JSON.stringify(opened));

    let goalStatus = "";
    let lastCriteria = "";
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const s = await get(`${host.url}/api/p/${added.id}/status`);
      goalStatus = s.json?.goal?.status ?? "";
      lastCriteria = JSON.stringify((s.json?.goal?.acceptanceCriteria ?? []).map((c: { id: string; status: string }) => [c.id, c.status]));
      if (goalStatus === "COMPLETED") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.equal(goalStatus, "COMPLETED", `the scripted team did not finish the mission: ${lastCriteria}`);
    const metrics = await get(`${host.url}/api/p/${added.id}/metrics`);
    assert.ok(metrics.json.metrics.messages > 0, "the seats talked to each other");
    assert.ok(metrics.json.metrics.artifacts > 0, "and produced artifacts");
  } finally {
    await host.close();
  }
});
