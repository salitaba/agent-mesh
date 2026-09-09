import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { bootstrapMesh, createHttpServer, closeHttpServer } from "../../apps/mesh-server/src/index";

/** Plain http helper with pooling disabled: keep-alive client sockets would
 *  otherwise keep the test process alive after teardown (flaky hangs). */
function httpCall(base: string, p: string, opts: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<{ status: number; text: string; ms: number }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request(
      `${base}${p}`,
      { method: opts.method ?? "GET", agent: false, headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : undefined },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8"), ms: Date.now() - started }));
      },
    );
    req.on("error", reject);
    req.setTimeout(opts.timeoutMs ?? 15000, () => req.destroy(new Error(`timeout ${opts.method ?? "GET"} ${p}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

const REPO = path.resolve(__dirname, "..", "..", "..");
const SOURCE_YAML = path.join(REPO, "examples", "line-follower-sim", "mesh.yaml");
const SOURCE_EVENTS = path.join(REPO, "examples", "line-follower-sim", "workspace", ".mesh-state", "logs", "events.jsonl");

function hasFixture(): boolean {
  return fs.existsSync(SOURCE_YAML) && fs.existsSync(SOURCE_EVENTS);
}

/**
 * Replays the real line-follower mission log (parked console) and then fires
 * the exact operator sequence from the incident — Continue (go live) plus
 * set&resume (budget raise + escalation respond) — while hammering /health.
 * The incident froze the server the moment recovery turns started; every
 * health probe must answer promptly and the log must keep growing.
 */
test("resume storm: continue + set&resume on a real mission log stays responsive", async () => {
  if (!hasFixture()) {
    console.log("skip: line-follower fixture not present");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-resume-"));
  const configPath = path.join(dir, "mesh.yaml");
  try {
    const yaml = fs
      .readFileSync(SOURCE_YAML, "utf8")
      .replaceAll("runtime: opencode", "runtime: stub")
      .replaceAll("prompt: ../../roles/", `prompt: ${path.join(REPO, "roles")}/`)
      .replace("path: ./workspace", `path: ${path.join(dir, "workspace")}`);
    fs.writeFileSync(configPath, yaml, "utf8");

    // First boot creates the state layout; then seed the real event log so the
    // second boot replays the exact pre-incident moment (goal ESCALATED).
    const probe = await bootstrapMesh({ configPath, mode: "parked" });
    const stateDir = probe.config.stateDir;
    await probe.close();
    fs.copyFileSync(SOURCE_EVENTS, path.join(stateDir, "logs", "events.jsonl"));

    const m = await bootstrapMesh({ configPath, mode: "parked" });
    try {
      // The seeded log replays `agent.created` events captured from the real
      // (opencode-backed) mission, and the projection restores each agent's
      // recorded definition verbatim — overriding the `runtime: stub` rewrite
      // applied to the YAML above. Every recovery turn below therefore spawned
      // a real `opencode serve` child, and because this workspace is a temp
      // dir deleted in `finally`, its pidfiles vanished with it and the
      // adapter's orphan sweep could never reclaim them. Each suite run leaked
      // ~3 idle 300MB servers; the machine under investigation had 11 alive
      // from previous runs, holding 3.6GB. Force the replayed definitions back
      // onto the stub runtime before anything can be activated.
      for (const rec of m.kernel.state.agents.values()) {
        (rec.definition as { runtime: string }).runtime = "stub";
      }
      const before = m.kernel.state.eventCount;
      assert.ok(before > 1000, `expected the real log, got ${before} events`);
      let openEsc = [...m.kernel.state.escalations.values()].find((e) => e.status === "OPEN");
      if (!openEsc) {
        openEsc = await m.supervisor.escalate({ reason: "test-budget", raisedBy: "qa", detail: { note: "synthetic" } });
      }

      // Slow turns stand in for real model calls (stub delayMs, no tokens burned).
      const stub = m.stubRuntimes.get("stub");
      assert.ok(stub, "stub runtime missing");
      for (const id of m.config.agentOrder) {
        stub.setScript(id, async () => ({ delayMs: 800, operations: [{ op: "done" }] }) as never);
      }

      const server = createHttpServer(m, { dashboardDir: undefined });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const post = async (p: string, body: unknown, timeoutMs = 15000) => {
        const r = await httpCall(base, p, { method: "POST", body, timeoutMs });
        return { status: r.status, json: JSON.parse(r.text) as Record<string, unknown> };
      };
      const health = async (timeoutMs = 3000): Promise<number> => {
        const r = await httpCall(base, "/health", { timeoutMs });
        assert.equal(r.status, 200);
        return r.ms;
      };

      try {
        // The operator sequence: Continue, then set&resume on the escalation.
        // Health probes run alongside with tight timeouts: on a wedged loop
        // the very first probe stalls, so a short window suffices (keeps the
        // shared suite fast).
        const stayResponsive = (async () => {
          let timeouts = 0;
          let slowest = 0;
          for (let i = 0; i < 12; i++) {
            try {
              const ms = await health(3000);
              slowest = Math.max(slowest, ms);
            } catch {
              timeouts++;
            }
            await new Promise((r) => setTimeout(r, 250));
          }
          return { timeouts, slowest };
        })();

        const boot = await post("/mission/start", {});
        assert.equal(boot.status, 200);
        const raise = await post("/budgets/raise", { key: `mission:${m.kernel.state.activeGoalId}`, add: 500000 });
        assert.equal(raise.status, 200, JSON.stringify(raise.json));
        const respond = await post(`/escalations/${encodeURIComponent(openEsc.id)}/respond`, { response: "raised budget — continue" });
        assert.equal(respond.status, 200, JSON.stringify(respond.json));

        const { timeouts, slowest } = await stayResponsive;
        assert.equal(timeouts, 0, `${timeouts}/12 health probes timed out during resume`);
        assert.ok(slowest < 3000, `slowest health probe took ${slowest}ms during resume`);
        assert.ok(m.kernel.state.eventCount > before, "recovery turns must keep emitting events");
      } finally {
        await closeHttpServer(server);
      }
    } finally {
      await m.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // The replayed fixture leaves 8k+ indexed events plus file-backed handles;
  // under node --test the child otherwise lingers on unreleased sockets after
  // teardown. All assertions already ran — exit explicitly (test-only).
  process.exit(0);
});
