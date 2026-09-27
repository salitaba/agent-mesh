import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  warnUnreachableMissionCap,
  MISSION_CAP_WARN_MULTIPLE,
  resolveConfig,
} from "../../packages/config/src/index";
import type { AgentDefinition } from "../../packages/protocol/src/index";

/**
 * A mission token cap no run can approach.
 *
 * Missions halt on the FIRST per-agent exhaustion (`agent_budget_exhausted`), and
 * each seat is bounded by its own 8x auto-raise ladder — so once
 * `budgets.mission.tokens` is far above what every seat could spend combined, the
 * mission line reports a fraction of a percent for the whole run and then the run
 * dies on a ledger the bar never mentioned. Measured 2026-09-24: 120M declared
 * against 12.64M reachable; the dashboard read 0.9% at the moment of the halt.
 *
 * A cap merely above the reachable total is a sane backstop and stays silent —
 * that is the ordinary shape, including every fixture and shipped example.
 */

function seat(id: string, tokens: number): AgentDefinition {
  return { id, role: id, capabilities: [], authority: [], budget: { tokens } } as unknown as AgentDefinition;
}

test("warns when the cap is far above every seat's ceiling combined", () => {
  // 2 x 120k base = 240k; x8 ladder = 1.92M reachable. 120M is ~62x that.
  const out = warnUnreachableMissionCap([seat("pm", 120_000), seat("dev", 120_000)], {
    mission: { tokens: 120_000_000 },
  });
  assert.equal(out.length, 1);
  assert.match(out[0]!, /no run can reach it/);
  assert.match(out[0]!, /1,920,000/, "states the reachable total, which is the number that binds");
  assert.match(out[0]!, /8x auto-raise ceiling/);
});

test("silent at the ordinary shape — a cap above the total is a backstop, not a lie", () => {
  const reachable = 240_000 * 8;
  const out = warnUnreachableMissionCap([seat("pm", 120_000), seat("dev", 120_000)], {
    mission: { tokens: reachable * MISSION_CAP_WARN_MULTIPLE },
  });
  assert.deepEqual(out, [], "exactly at the noise threshold must not fire");
});

test("auto-raise off narrows the reachable total to the base limits", () => {
  const agents = [seat("pm", 120_000), seat("dev", 120_000)];
  // Without the ladder only 240k is reachable, so a cap the ladder would have
  // justified now trips.
  const out = warnUnreachableMissionCap(agents, {
    mission: { tokens: 10_000_000 },
    auto_raise: { enabled: false },
  });
  assert.equal(out.length, 1);
  assert.match(out[0]!, /configured limit \(auto-raise is off\)/);
  assert.match(out[0]!, /240,000/);
});

test("a custom max_multiple is respected", () => {
  const agents = [seat("pm", 120_000), seat("dev", 120_000)];
  assert.deepEqual(
    warnUnreachableMissionCap(agents, { mission: { tokens: 10_000_000 }, auto_raise: { max_multiple: 64 } }),
    [],
    "240k x 64 = 15.36M reachable, so 10M is reachable and silent",
  );
});

test("no mission cap, or no per-seat budgets, says nothing", () => {
  assert.deepEqual(warnUnreachableMissionCap([seat("pm", 120_000)], undefined), []);
  assert.deepEqual(warnUnreachableMissionCap([seat("pm", 120_000)], { mission: {} }), []);
  assert.deepEqual(warnUnreachableMissionCap([], { mission: { tokens: 120_000_000 } }), []);
});

test("every shipped example is silent", () => {
  // process.cwd(), not __dirname: tests run from compiled output under dist/.
  const root = path.resolve(process.cwd(), "examples");
  const examples = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.resolve(root, e.name, "mesh.yaml"))
    .filter((p) => fs.existsSync(p));
  assert.ok(examples.length > 0, "found no examples to check — the glob is wrong, not the meshes");
  for (const file of examples) {
    const resolved = resolveConfig(file);
    assert.equal(
      resolved.warnings.find((w) => w.includes("no run can reach it")),
      undefined,
      `${file} declares a mission cap no run can approach`,
    );
  }
});
