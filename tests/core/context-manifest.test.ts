import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContextManifest } from "../../packages/core/src/context";
import type { AgentContextBundle, ContextManifest, ContextSlot } from "../../packages/protocol/src/index";

/**
 * The manifest is the only durable answer to "why didn't the agent know X?".
 *
 * Sub-turn detail is live-only enrichment and absent from any turn rebuilt
 * purely from the log, so before this record a capped section left no evidence
 * that the dropped items had ever been candidates. The counts below are the
 * part that must be exact — the token figures are estimates by construction and
 * are asserted only for ordering, never for value.
 */

function bundle(over: Partial<AgentContextBundle> = {}): AgentContextBundle {
  return {
    rolePrompt: "role",
    mission: "ship the thing",
    relevantPolicies: ["p1", "p2"],
    agentState: {
      agentId: "developer",
      lifecycle: "THINKING",
      mailboxDepth: 0,
      currentArtifactIds: [],
      tokensConsumed: 0,
      activations: 0,
      lastActivityAt: "",
    },
    relevantDecisions: [],
    relevantArtifacts: [],
    unreadMail: [],
    recentOwnActivity: [],
    agentMemory: [],
    openThreads: [],
    budgetSnapshot: { agentTokensUsed: 0, agentTokenBudget: 0, missionTokensUsed: 0, missionTokenBudget: 0 },
    outstanding: { awaitingResponse: [], owedByYou: [] },
    goalCriteria: [],
    delegationEnabled: false,
    criterionAcceptanceEnabled: false,
    hardActions: { mode: "off", capabilities: [] },
    ...over,
  };
}

const args = {
  agentId: "developer",
  goalId: "goal-1",
  budgetTokens: 20_000,
  usedTokens: 1_234,
  tier: "full" as const,
  overSoftCap: false,
};

const slotOf = (m: ContextManifest, name: ContextSlot) => m.slots.find((s) => s.slot === name)!;

test("every slot in the vocabulary appears, including the empty ones", () => {
  const m = buildContextManifest(bundle(), args);
  const names = m.slots.map((s) => s.slot);
  assert.deepEqual(
    [...names].sort(),
    [
      "artifacts",
      "commitments",
      "continuity",
      "decisions",
      "mail",
      "memory",
      "mission",
      "own_activity",
      "policy",
      "task",
    ],
    "a slot missing from the manifest is indistinguishable from a slot that was empty",
  );
});

test("continuity reports as present-and-empty rather than absent", () => {
  // Stage 3 fills this in. Until then every rotation is an agent starting from
  // nothing, and that should read as a zero in the log, not as silence.
  const s = slotOf(buildContextManifest(bundle(), args), "continuity");
  assert.equal(s.admitted, 0);
  assert.equal(s.dropped, 0);
});

test("admitted counts the items that shipped", () => {
  const m = buildContextManifest(
    bundle({
      unreadMail: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] as AgentContextBundle["unreadMail"],
      relevantPolicies: ["a", "b", "c", "d"],
    }),
    args,
  );
  assert.equal(slotOf(m, "mail").admitted, 3);
  assert.equal(slotOf(m, "policy").admitted, 4);
});

/**
 * The invariant that matters. An agent shown 3 of 9 open obligations will close
 * 3 and report itself finished; the manifest is where that truncation becomes
 * visible after the fact.
 */
test("dropped carries the cap's truncation through to the log", () => {
  const m = buildContextManifest(
    bundle({
      unreadMail: [{ id: "m1" }] as AgentContextBundle["unreadMail"],
      omitted: { unread: 8, decisions: 2, artifacts: 5, activity: 1, outstanding: 6, memory: 3 },
    }),
    args,
  );
  assert.equal(slotOf(m, "mail").dropped, 8);
  assert.equal(slotOf(m, "decisions").dropped, 2);
  assert.equal(slotOf(m, "artifacts").dropped, 5);
  assert.equal(slotOf(m, "own_activity").dropped, 1);
  assert.equal(slotOf(m, "commitments").dropped, 6);
  assert.equal(slotOf(m, "memory").dropped, 3);
});

test("an absent omitted key means nothing was withheld, not unknown", () => {
  const m = buildContextManifest(bundle({ omitted: { unread: 4 } }), args);
  assert.equal(slotOf(m, "mail").dropped, 4);
  assert.equal(slotOf(m, "decisions").dropped, 0);
});

test("commitments merges both directions of the ledger", () => {
  const m = buildContextManifest(
    bundle({
      outstanding: {
        awaitingResponse: [
          { messageId: "a1", to: ["qa"], type: "REQUEST_REVIEW", since: "t" },
          { messageId: "a2", to: ["qa"], type: "REQUEST_REVIEW", since: "t" },
        ],
        owedByYou: [{ messageId: "o1", from: "pm", type: "REQUEST", since: "t" }],
      },
    }),
    args,
  );
  // What it owes and what it is owed are one slot: an agent that forgets either
  // stalls a peer, and the eviction order must treat them as equally load-bearing.
  assert.equal(slotOf(m, "commitments").admitted, 3);
});

test("the degradation rung and the oversize flag survive into the record", () => {
  const m = buildContextManifest(bundle(), { ...args, tier: "minimal", overSoftCap: true });
  assert.equal(m.tier, "minimal");
  assert.equal(m.overSoftCap, true);
  // A turn that goes wrong under `minimal` was starved, not incapable — that
  // distinction is only recoverable if the rung is on the record.
});

test("token estimates are proportional, not authoritative", () => {
  const m = buildContextManifest(
    bundle({ mission: "x".repeat(4000), relevantPolicies: ["short"] }),
    args,
  );
  assert.ok(slotOf(m, "mission").tokens > slotOf(m, "policy").tokens);
  assert.ok(slotOf(m, "mission").tokens > 500);
  // usedTokens comes from the rendered prompt and is NOT the sum of the slots:
  // the renderer interleaves framing prose that belongs to no slot.
  assert.equal(m.usedTokens, 1_234);
});
