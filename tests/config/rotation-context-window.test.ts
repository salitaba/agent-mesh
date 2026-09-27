import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfig } from "../../packages/config/src/index";

/**
 * `context_window`: the window rotation is measured against, for a model the
 * adapter's table cannot place (NOTES-live-run-20260925-2040.md §1: every seat
 * ran `deepseek-v4.1-flash`, a 1M model, and rotated at the 120k floor sized
 * for a 200k one; `rotateAtContextTokens` was an option nothing passed).
 *
 * Mesh-wide next to `mesh.runtime.model`, whose window it describes, and per
 * seat next to `model:`. The per-seat value is NOT folded into the mesh one at
 * load: the adapter ranks them around its own table (seat > known model > mesh
 * default), so a 200k seat under a 1M mesh default is never over-sized.
 */

function mesh(runtime: string, agent: string): string {
  return `version: 1
mesh:
  id: cfgtest
  goal: |
    Test.
  workspace: { path: ./workspace }
  runtime: { default: stub${runtime} }
agents:
  a: { role: worker${agent} }
  b: { role: worker }
`;
}

function resolveRaw(text: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-ctxwin-test-"));
  fs.writeFileSync(path.join(dir, "mesh.yaml"), text, "utf8");
  try {
    return resolveConfig(path.join(dir, "mesh.yaml"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("mesh.runtime.context_window and a seat's context_window both resolve", () => {
  const cfg = resolveRaw(mesh(", context_window: 1000000", ", context_window: 200000"));
  assert.equal(cfg.defaultContextWindow, 1_000_000);
  assert.equal(cfg.agents.a.contextWindow, 200_000);
  assert.equal(cfg.agents.b.contextWindow, undefined, "not folded: the adapter ranks the mesh default below a known model");
});

test("absent everywhere means the adapter's own table and floor, as before", () => {
  const cfg = resolveRaw(mesh("", ""));
  assert.equal(cfg.defaultContextWindow, undefined);
  assert.equal(cfg.agents.a.contextWindow, undefined);
});

test("a context_window that is not a positive token count is refused at load", () => {
  assert.throws(() => resolveRaw(mesh(", context_window: 1m", "")));
  assert.throws(() => resolveRaw(mesh("", ", context_window: 0")));
  assert.throws(() => resolveRaw(mesh("", ", context_window: 999")), "a window in thousands is a typo, not a model");
});

/**
 * `stale_after_ms`: how long a seat's session may sit idle before the adapter
 * rotates it, believing the prompt cache died in the gap. The adapter's own
 * default of 10 minutes fits Anthropic's TTL; a proxied route whose cache
 * survives longer (94% still cached after 10+ minutes, measured 2026-09-27)
 * keeps paying for rotations it does not need. Absent stays absent, so the
 * adapter's default keeps applying rather than being frozen into a config file.
 */
test("mesh.runtime.stale_after_ms resolves, and absent leaves the adapter's default alone", () => {
  const cfg = resolveRaw(mesh(", stale_after_ms: 3600000", ""));
  assert.equal(cfg.defaultStaleAfterMs, 3_600_000);
  assert.equal(resolveRaw(mesh("", "")).defaultStaleAfterMs, undefined);
});

test("a stale_after_ms that is not a plausible duration is refused at load", () => {
  assert.throws(() => resolveRaw(mesh(", stale_after_ms: 10", "")), "ten milliseconds is not an idle window");
  assert.throws(() => resolveRaw(mesh(", stale_after_ms: 3600", "")), "seconds where milliseconds belong");
  assert.throws(() => resolveRaw(mesh(", stale_after_ms: 1h", "")));
});
