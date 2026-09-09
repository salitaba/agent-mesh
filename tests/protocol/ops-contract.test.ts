import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { renderContextInstructions } from "../../packages/core/src/context";
import type { AgentContextBundle } from "../../packages/protocol/src/index";

/**
 * The ops block in the agent context is the ONLY place an agent learns what
 * moves exist. Anything implemented but missing from it is, from the model's
 * point of view, not part of the system.
 *
 * On a live mission 18 of 30 ops were undocumented — including `approve`, the
 * only op that can satisfy an acceptance criterion. The result: correct work
 * shipped (code merged, tests green) and then the mission stalled forever at
 * 1/5 criteria, because nobody could convert that work into evidence. The PM
 * repeatedly attempted acceptance without the mandatory evidence reference
 * and was rejected 11 times with "criterion acceptance requires evidence" —
 * a shape the prompt never showed it.
 */

function emptyBundle(over: Partial<AgentContextBundle> = {}): AgentContextBundle {
  return {
    rolePrompt: "r",
    mission: "m",
    relevantPolicies: [],
    agentState: { agentId: "a", lifecycle: "IDLE", mailboxDepth: 0, currentArtifactIds: [], tokensConsumed: 0, activations: 0, lastActivityAt: "t" },
    relevantDecisions: [],
    relevantArtifacts: [],
    unreadMail: [],
    recentOwnActivity: [],
    agentMemory: [],
    openThreads: [],
    budgetSnapshot: { agentTokensUsed: 0, agentTokenBudget: 1, missionTokensUsed: 0, missionTokenBudget: 1 },
    outstanding: { awaitingResponse: [], owedByYou: [] },
    goalCriteria: [],
    ...over,
  } as AgentContextBundle;
}

/** Ops the runtime actually implements, read from the protocol source. */
function implementedOps(): Set<string> {
  const src = fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "packages", "protocol", "src", "types.ts"), "utf8");
  return new Set([...src.matchAll(/\bop: "(\w+)"/g)].map((m) => m[1]));
}

/** Only usable when delegation is enabled, so documented conditionally. */
const DELEGATION_OPS = new Set(["spawn_worker", "submit_result"]);

test("ops contract: every implemented op is named in the agent's instructions", () => {
  const text = renderContextInstructions(emptyBundle());
  const missing = [...implementedOps()].filter((op) => !DELEGATION_OPS.has(op) && !text.includes(op)).sort();
  assert.deepEqual(
    missing,
    [],
    `undocumented ops are unusable by agents; missing: ${missing.join(", ")}`,
  );
});

test("ops contract: delegation ops appear exactly when they are usable", () => {
  const off = renderContextInstructions(emptyBundle());
  for (const op of DELEGATION_OPS) {
    assert.ok(
      !off.includes(op),
      `${op} is denied outright with delegation off (v1 default max_depth 0) — advertising it only buys failed turns`,
    );
  }
  const on = renderContextInstructions(emptyBundle({ delegationEnabled: true }));
  for (const op of DELEGATION_OPS) {
    assert.ok(on.includes(op), `${op} must be documented once delegation is actually permitted`);
  }
});

test("ops contract: criterion acceptance is documented with its evidence requirement", () => {
  const text = renderContextInstructions(emptyBundle());
  assert.match(text, /criterion:/, "agents must see the subject shape that satisfies a criterion");
  assert.match(text, /artifactId/, "acceptance without an evidence reference is rejected by the runtime");
  // The failure mode is silent: without this, agents burn turns being rejected
  // and the mission never completes despite the work being done.
  const section = text.slice(text.indexOf("criterion:"));
  assert.match(
    section.slice(0, 600),
    /MANDATORY|required|rejected/i,
    "the prompt must state that evidence is mandatory, not merely available",
  );
});

test("ops contract: artifact review lifecycle is documented", () => {
  const text = renderContextInstructions(emptyBundle());
  assert.match(text, /transition_artifact/, "a DRAFT nobody transitions is never reviewed and never becomes evidence");
  assert.match(text, /READY_FOR_REVIEW/, "agents need the target status by name");
  assert.match(text, /owner/i, "only the owner may transition — otherwise agents burn turns on rejections");
});

test("ops contract: the ops block still shows an exact, parseable example", () => {
  const text = renderContextInstructions(emptyBundle());
  const fence = text.indexOf("```mesh-json");
  assert.ok(fence > 0, "the fenced example is the contract agents copy from");
  const block = text.slice(fence + "```mesh-json".length, text.indexOf("```", fence + 12));
  const parsed = JSON.parse(block.trim()) as Array<{ op: string }>;
  assert.ok(Array.isArray(parsed) && parsed.length > 0, "the documented example must itself be valid JSON");
  for (const op of parsed) assert.ok(implementedOps().has(op.op), `example uses a non-existent op: ${op.op}`);
});
