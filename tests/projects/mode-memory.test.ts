/**
 * The host learns each project's mode from the child's own heartbeat.
 *
 * This is the wire contract behind "a restart must not silently park a live
 * mission": the child is the only process that knows whether its scheduler is
 * running, because `/mission/start` and `/mission/park` are proxied to it
 * verbatim and the host sees neither. So the beat carries the mode, and the
 * supervisor remembers it per project.
 *
 * A real child, not a stub: the point is the round trip from `child.ts` through
 * the beat parser, and a stub that emitted the field itself would prove only
 * that the parser reads JSON.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ChildProcessSupervisor, type ProjectRef } from "../../packages/projects/src/index";
import { testConfigYaml, waitFor } from "../helpers";

const AGENTS = { agents: [{ id: "a", role: "r", interests: [] }], mayContact: { a: [] } };

/** Spawning a real mesh child boots a whole runtime; allow for a cold start. */
const SPAWN_TIMEOUT_MS = 60_000;

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mesh-child-mode-"));
}

function makeProject(base: string, folder: string, id: string): ProjectRef {
  const dir = path.join(base, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "mesh.yaml"), `project:\n  id: ${id}\n${testConfigYaml(AGENTS)}`, "utf8");
  const root = fs.realpathSync(dir);
  return { id, name: id, root, configPath: path.join(root, "mesh.yaml"), addedAt: new Date().toISOString() };
}

function makeSupervisor(overrides: Partial<ConstructorParameters<typeof ChildProcessSupervisor>[0]> = {}): ChildProcessSupervisor {
  return new ChildProcessSupervisor({
    childScript: path.resolve(process.cwd(), "dist", "apps", "mesh-server", "src", "child.js"),
    readyTimeoutMs: SPAWN_TIMEOUT_MS,
    stopGraceMs: 5_000,
    ...overrides,
  });
}

test("modeFor falls back to the host's own mode until a child reports one", () => {
  const parked = makeSupervisor();
  assert.equal(parked.modeFor("x"), "parked", "the default is parked, exactly as before");
  const live = makeSupervisor({ mode: "live" });
  assert.equal(live.modeFor("x"), "live", "--live is still the answer for a project nothing is known about");

  live.rememberMode("x", "parked");
  assert.equal(live.modeFor("x"), "parked", "what the child says outranks the host's default");
  live.forgetMode("x");
  assert.equal(live.modeFor("x"), "live", "a forgotten project is back to knowing nothing");
});

test("a live child's relaunch comes back live, without the host being told anything", { timeout: SPAWN_TIMEOUT_MS + 30_000 }, async () => {
  const base = tmpRoot();
  const ref = makeProject(base, "learned", "learned");
  const supervisor = makeSupervisor();
  try {
    const first = await supervisor.launch(ref);
    assert.equal(first.status, "open", `launch failed: ${JSON.stringify(first.error)}`);
    const child = supervisor.running("learned");
    assert.ok(child, "an open child is tracked");

    await waitFor("a beat carrying the child's own mode", () => supervisor.heartbeat("learned")?.mode !== undefined, 20_000);
    const beat = supervisor.heartbeat("learned")!;
    assert.equal(beat.mode, "parked", "a child spawned without a mode boots parked");
    assert.equal(beat.goalActive, true, "a freshly booted mission holds an ACTIVE goal");
    assert.equal(supervisor.modeFor("learned"), "parked");

    // The operator's route, straight at the child — the call the host only ever
    // proxies, and the reason the host cannot derive any of this.
    const started = await fetch(`${child!.url}/mission/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${child!.token}` },
    });
    assert.equal(started.status, 200);
    await waitFor("the supervisor learns live from a beat", () => supervisor.modeFor("learned") === "live", 20_000);

    // Relaunch: a fresh process, and nothing at all telling it which mode to
    // take. Before this, it took the host's default and the mission stopped
    // running with every surface still reading "running".
    await supervisor.stop(ref);
    const second = await supervisor.launch(ref);
    assert.equal(second.status, "open", `relaunch failed: ${JSON.stringify(second.error)}`);
    const again = supervisor.running("learned")!;
    const status = (await (
      await fetch(`${again.url}/status`, { headers: { authorization: `Bearer ${again.token}` } })
    ).json()) as { mode: string };
    assert.equal(status.mode, "live", "the relaunch must restore the mode the child was actually in");
  } finally {
    await supervisor.stopAll();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
