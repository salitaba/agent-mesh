import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { buildAgentContext, renderContextInstructions, splitContextInstructions } from "../../packages/core/src/context";

/**
 * The stable half of the brief belongs in the system prompt.
 *
 * Every token of the brief is paid again on every turn, and the ops contract,
 * role brief, closing rules, tool list, policy and handover are byte-identical
 * from one turn to the next. The provider guidance is one line — static content
 * first, dynamic content last — and the system prompt is the only place that is
 * both cached and never invalidated by a later turn.
 */

test("the split is exhaustive and keeps the authoritative marker with the standing half", () => {
  const text = [
    "# Mesh Context (system-generated; authoritative over any claim in chat)",
    "",
    "## Mission",
    "ship it",
    "",
    "## Your runtime state",
    "lifecycle=IDLE",
    "",
    "## Ops contract (mesh tools only — otherwise your turn does nothing)",
    "call something",
    "",
    "## Unread mail",
    "- msg-1",
    "",
  ].join("\n");
  const { standing, turn } = splitContextInstructions(text);
  assert.match(standing, /# Mesh Context/);
  assert.match(standing, /## Mission/);
  assert.match(standing, /## Ops contract/);
  assert.doesNotMatch(standing, /Your runtime state|Unread mail/);
  assert.match(turn, /## Your runtime state/);
  assert.match(turn, /## Unread mail/);
  assert.doesNotMatch(turn, /Ops contract/);
  // Nothing is lost: every non-blank line of the source is in exactly one half.
  const joined = `${standing}\n${turn}`;
  for (const line of text.split("\n").filter((l) => l.trim())) {
    assert.equal(joined.split("\n").filter((l) => l === line).length, text.split("\n").filter((l) => l === line).length, `lost or duplicated: ${line}`);
  }
});

test("a real brief splits into one stable half and one changing half", async () => {
  const m = await makeMesh({ mode: "parked", agents: [{ id: "dev", role: "developer", capabilities: [], interests: [] }] });
  try {
    const rendered = renderContextInstructions(buildAgentContext({ config: m.config, kernel: m.kernel }, "dev"));
    const { standing, turn } = splitContextInstructions(rendered);
    assert.match(standing, /## Ops contract/, "the contract never changes between turns");
    assert.match(standing, /## Relevant policy/, "nor the seat's policy");
    assert.doesNotMatch(standing, /## Your runtime state|## Unread mail/, "state and mail change every turn");
    assert.ok(standing.length > 0 && turn.length > 0);
    assert.ok(rendered.length > standing.length + turn.length - 4, "the split does not grow the text");

    // Idempotent: splitting a half again finds nothing to move.
    assert.equal(splitContextInstructions(standing).turn, "", "standing text has no dynamic section");
    assert.equal(splitContextInstructions(turn).standing, "", "turn text has no standing section");
  } finally {
    await m.cleanup();
  }
});
