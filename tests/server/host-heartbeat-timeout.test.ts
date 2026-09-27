/**
 * `heartbeat_timeout_ms` in `host.yaml`, all the way to a killed child.
 *
 * The window is the only protection a project has from being stopped for
 * silence it never had, so the value an operator sets has to be the value the
 * running host uses — and the decision has to be recorded somewhere that
 * outlives the terminal it scrolled past.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CHILD_READY_PREFIX, SUPERVISION_LOG_NAME, type ProjectRef } from "../../packages/projects/src/index";
import { startHostServer, type HostHandle } from "../../apps/mesh-server/src/host";
import { testConfigYaml } from "../helpers";

const AGENTS = { agents: [{ id: "a", role: "r", interests: [] }], mayContact: { a: [] } };

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mesh-host-heartbeat-"));
}

function makeProject(base: string, folder: string, id: string): ProjectRef {
  const dir = path.join(base, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "mesh.yaml"), `project:\n  id: ${id}\n${testConfigYaml(AGENTS)}`, "utf8");
  const root = fs.realpathSync(dir);
  return { id, name: id, root, configPath: path.join(root, "mesh.yaml"), addedAt: new Date().toISOString() };
}

/** Handshakes, then goes quiet: alive, holding its port and its lock, silent. */
function quietChildScript(base: string): string {
  const file = path.join(base, "quiet-child.js");
  fs.writeFileSync(
    file,
    [
      `process.stdout.write(\`${CHILD_READY_PREFIX} \${JSON.stringify({ port: 1, pid: process.pid, projectId: process.env.MESH_CHILD_PROJECT_ID, url: "http://127.0.0.1:1" })}\\n\`);`,
      "process.on('SIGTERM', () => process.exit(0));",
      "setInterval(() => {}, 1000);",
    ].join("\n"),
    "utf8",
  );
  return file;
}

function captureStderr(): { take: () => string; restore: () => void } {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = (chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  return {
    take: () => chunks.splice(0, chunks.length).join(""),
    restore: () => {
      (process.stderr as { write: unknown }).write = original;
    },
  };
}

/** `<home>/host.yaml`, the file the host reads for every cross-project knob. */
function writeHostYaml(base: string, body: string): void {
  const home = path.join(base, "home");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "host.yaml"), body, "utf8");
}

async function startHost(base: string): Promise<HostHandle> {
  return startHostServer({
    home: path.join(base, "home"),
    port: 0,
    childScript: quietChildScript(base),
    readyTimeoutMs: 10_000,
    stopGraceMs: 2_000,
    dashboardDir: path.join(base, "no-dashboard"),
  });
}

async function addAndOpen(host: HostHandle, root: string): Promise<string> {
  const added = await fetch(`${host.url}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ root }),
  });
  const ref = (await added.json()) as { id: string };
  await fetch(`${host.url}/api/projects/${ref.id}/open`, { method: "POST" });
  return ref.id;
}

async function settle(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

test("a window this narrow is honored: the child is stopped and the kill is recorded twice over", { timeout: 60_000 }, async () => {
  const base = tmpRoot();
  const project = makeProject(base, "narrow", "narrow");
  // 300ms against a 2s health poll: two consecutive stale polls is ~4s, and the
  // default 60s window could not produce a kill inside this test at all. So a
  // kill here is the config value and nothing else.
  writeHostYaml(base, "host:\n  heartbeat_timeout_ms: 300\n");
  const host = await startHost(base);
  const stderr = captureStderr();
  try {
    const id = await addAndOpen(host, project.root);
    await settle(6_000);

    const line = stderr.take();
    assert.match(line, new RegExp(`project '${id}' crashed \\(unhealthy\\)`), `expected a health kill, got: ${line}`);
    assert.match(line, /no heartbeat for \d+s/);

    // …and the durable record, in the project's own .mesh/, where it outlives
    // the host process whose terminal it scrolled past.
    const log = path.join(path.dirname(project.configPath), ".mesh", SUPERVISION_LOG_NAME);
    assert.ok(fs.existsSync(log), `expected ${log}`);
    const lines = fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
    assert.ok(lines.length >= 1, "at least the kill decision");
    assert.match(lines[0], new RegExp(`project=${id} reason=unhealthy`));
    assert.match(lines[0], /action=restart-with-backoff/);
  } finally {
    stderr.restore();
    await host.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("with no host.yaml the shipped default stands: the same silence kills nothing", { timeout: 60_000 }, async () => {
  const base = tmpRoot();
  const project = makeProject(base, "wide", "wide");
  const host = await startHost(base);
  const stderr = captureStderr();
  try {
    const id = await addAndOpen(host, project.root);
    // Six times the window the test above uses. Under the old 15s default this
    // was already most of the way to a kill; under the shipped one it is not a
    // reading the watchdog even calls stale.
    await settle(6_000);
    assert.equal(stderr.take().includes(`project '${id}' crashed`), false, "nothing crashed");
    assert.ok(host.supervisor.running(id), "and the child is still the one it started");
    assert.equal(fs.existsSync(path.join(path.dirname(project.configPath), ".mesh", SUPERVISION_LOG_NAME)), false);
  } finally {
    stderr.restore();
    await host.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
