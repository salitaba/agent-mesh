import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigError, resolveConfig } from "../../packages/config/src/index";

/**
 * `mesh.runtime.native.context`: the conversation economy, checked at load.
 *
 * Every wrong value here fails silently at run time -- a budget above the window
 * never rotates, a ceiling of 0 removes the guard, a warn_at outside (0,1) never
 * warns -- so each is refused with a sentence naming the key.
 */

function resolve(runtime: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-context-cfg-"));
  fs.writeFileSync(
    path.join(dir, "mesh.yaml"),
    `version: 1
mesh:
  id: cfgtest
  goal: |
    Test.
  workspace: { path: ./workspace }
  runtime:
${runtime}
agents:
  a: { role: worker }
`,
    "utf8",
  );
  try {
    return resolveConfig(path.join(dir, "mesh.yaml"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const errorsOf = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError) return e.errors;
    throw e;
  }
  return [];
};

const NATIVE = `    default: native
    model: openai/model-a
    providers:
      openai: { kind: openai-compatible, base_url: https://api.example.com/v1, api_key_env: OPENAI_KEY }
`;

test("the economy block resolves, and absent means the runtime's defaults", () => {
  const plain = resolve(NATIVE);
  assert.equal(plain.native?.context, undefined);

  const cfg = resolve(`${NATIVE}    context_window: 1000000
    native:
      context:
        fit_tokens: 250000
        keep_recent_messages: 12
        elide_above_chars: 4000
        max_tool_result_chars: 80000
        max_turn_tokens: 3000000
        warn_at: 0.8
`);
  assert.deepEqual(cfg.native?.context, {
    fitTokens: 250_000,
    keepRecentMessages: 12,
    elideAboveChars: 4_000,
    maxToolResultChars: 80_000,
    maxTurnTokens: 3_000_000,
    warnAtRatio: 0.8,
  });
});

test("fit_tokens: 0 is a deliberate 'size it from the window', and is kept as 0", () => {
  const cfg = resolve(`${NATIVE}    native:
      context: { fit_tokens: 0 }
`);
  assert.equal(cfg.native?.context?.fitTokens, 0);
});

test("a budget at or above the window is reported, because it would never rotate in time", () => {
  const cfg = resolve(`${NATIVE}    context_window: 200000
    native:
      context: { fit_tokens: 250000 }
`);
  assert.ok(cfg.warnings.some((w) => w.includes("fit_tokens 250000") && w.includes("context_window 200000")), cfg.warnings.join("\n"));
});

test("values that are not what they claim are refused by name", () => {
  for (const [line, key] of [
    ["fit_tokens: -1", "fit_tokens"],
    ["keep_recent_messages: 1", "keep_recent_messages"],
    ["max_tool_result_chars: 10", "max_tool_result_chars"],
  ] as const) {
    const errors = errorsOf(() =>
      resolve(`${NATIVE}    native:
      context: { ${line} }
`),
    );
    assert.ok(errors.some((e) => e.includes(key)), `${line}: ${errors.join("; ")}`);
  }
  const warn = errorsOf(() =>
    resolve(`${NATIVE}    native:
      context: { warn_at: 1.5 }
`),
  );
  assert.ok(warn.some((e) => e.includes("warn_at")), warn.join("; "));
});

test("the schema refuses an unknown key instead of ignoring a typo", () => {
  const errors = errorsOf(() =>
    resolve(`${NATIVE}    native:
      context: { fit_token: 250000 }
`),
  );
  assert.ok(errors.length > 0, "fit_token (no s) must not be silently dropped");
});

test("mid-turn clearing keys resolve, and 0 is a deliberate 'never clear'", () => {
  const cfg = resolve(`${NATIVE}    native:
      context: { clear_tool_results_at: 0.5, keep_tool_uses: 4, clear_at_least_tokens: 8000 }
`);
  assert.deepEqual(cfg.native?.context, { clearToolResultsAt: 0.5, keepToolUses: 4, clearAtLeastTokens: 8000 });

  const off = resolve(`${NATIVE}    native:
      context: { clear_tool_results_at: 0 }
`);
  assert.equal(off.native?.context?.clearToolResultsAt, 0);

  for (const [line, key] of [
    ["clear_tool_results_at: 1.2", "clear_tool_results_at"],
    ["keep_tool_uses: 0", "keep_tool_uses"],
    ["clear_at_least_tokens: -1", "clear_at_least_tokens"],
  ] as const) {
    const errors = errorsOf(() =>
      resolve(`${NATIVE}    native:
      context: { ${line} }
`),
    );
    assert.ok(errors.some((e) => e.includes(key)), `${line}: ${errors.join("; ")}`);
  }
});
