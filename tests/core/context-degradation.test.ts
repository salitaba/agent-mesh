import { test } from "node:test";
import assert from "node:assert/strict";
import { fitToSoftCap, tierName, CONTEXT_TIER_LADDER } from "../../packages/core/src/supervisor";
import { renderContextInstructions, buildAgentContext } from "../../packages/core/src/context";
import { makeMesh } from "../helpers";
import type { AgentContextBundle } from "../../packages/protocol/src/index";
import type { ContextLimits } from "../../packages/core/src/context";

/**
 * Two things are being pinned here, and they are the same thing seen from
 * opposite ends: the mesh may shrink a turn when it will not fit, and the agent
 * must be able to tell that it happened. A silent shrink is worse than an
 * oversized prompt — the agent reads a truncated list as an exhaustive one and
 * acts on it.
 */

/** Stands in for bundle assembly: bigger tiers render more text, linearly. */
function fakeRebuild(sizeAtTier: Map<ContextLimits, number>) {
  return (tier: ContextLimits) => ({ text: "x".repeat(sizeAtTier.get(tier) ?? 0) });
}
const render = (v: { text: string }) => v.text;

// 3.5 chars/token, so these land either side of a 1000-token cap.
const CAP = 1000;
const OVER = "x".repeat(10_000);

test("a turn already under the cap is never rebuilt", () => {
  let rebuilds = 0;
  const out = fitToSoftCap({
    value: { text: "small" },
    render,
    rebuild: () => {
      rebuilds++;
      return { text: "" };
    },
    cap: CAP,
  });

  assert.equal(rebuilds, 0, "rebuilding a turn that fits burns a state scan for identical bytes");
  assert.equal(out.landed, true);
  assert.equal(out.tier, undefined, "still the full tier");
  assert.equal(out.rendered, "small");
});

test("the ladder stops at the first tier that fits, not the smallest", () => {
  const [reduced, tight, minimal] = CONTEXT_TIER_LADDER;
  const tried: string[] = [];
  const sizes = new Map([
    [reduced, 8_000],  // ~2286 tokens: still over
    [tight, 2_000],    // ~572 tokens: fits
    [minimal, 10],
  ]);
  const out = fitToSoftCap({
    value: { text: OVER },
    render,
    rebuild: (t) => {
      tried.push(tierName(t));
      return fakeRebuild(sizes)(t);
    },
    cap: CAP,
  });

  assert.deepEqual(tried, ["reduced", "tight"], "minimal must not be reached once tight fits");
  assert.equal(tierName(out.tier), "tight");
  assert.equal(out.landed, true);
  assert.ok(out.after < out.before, "a step down that does not shrink the turn is not a step down");
  assert.equal(out.rendered.length, 2_000, "the rendered text must be the one that fit");
});

test("a turn already at a narrow tier never rebuilds wider", () => {
  const [reduced, tight, minimal] = CONTEXT_TIER_LADDER;
  const tried: string[] = [];
  const out = fitToSoftCap({
    value: { text: OVER },
    render,
    // Budget pressure already forced `tight` before the soft cap ran.
    startTier: tight,
    rebuild: (t) => {
      tried.push(tierName(t));
      return fakeRebuild(new Map([[reduced, 5_000], [minimal, 100]]))(t);
    },
    cap: CAP,
  });

  assert.deepEqual(tried, ["minimal"], "reduced is WIDER than tight — walking back up would undo the budget decision");
  assert.equal(tierName(out.tier), "minimal");
  assert.equal(out.landed, true);
});

test("a turn that will not shrink is reported, not truncated", () => {
  const out = fitToSoftCap({
    value: { text: OVER },
    render,
    // Every tier still renders over the cap: a single artifact can be larger
    // than the whole budget, and no item cap can fix that.
    rebuild: () => ({ text: "y".repeat(9_000) }),
    cap: CAP,
  });

  assert.equal(out.landed, false, "the caller must be able to tell this turn went out oversized");
  assert.equal(tierName(out.tier), "minimal", "it bottomed out rather than stopping early");
  // The contract that matters: nothing was cut. Slicing the string would drop
  // the ops contract, which renders last.
  assert.equal(out.rendered.length, 9_000);
  assert.ok(out.after > CAP);
});

/** Minimal bundle; each test fills in only the section it is about. */
function bundle(over: Partial<AgentContextBundle>): AgentContextBundle {
  return {
    rolePrompt: "r",
    mission: "m",
    relevantPolicies: [],
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
    ...over,
  };
}

test("a truncated obligation list says so, in the section it truncated", () => {
  const text = renderContextInstructions(
    bundle({
      outstanding: {
        awaitingResponse: [],
        owedByYou: [{ messageId: "m1", from: "architect", type: "REQUEST", since: "2026-01-01T00:00:00.000Z" }],
      },
      omitted: { outstanding: 6 },
    }),
  );

  const loops = text.slice(text.indexOf("## Open loops"));
  assert.match(loops, /\+6 more open loop/);
  assert.match(loops, /PARTIAL/, "the agent must not read a capped list as a finished checklist");
  // The note has to live with the list. A count parked in a different section
  // is a count the model reads as being about that other section.
  assert.ok(loops.indexOf("+6 more") < loops.indexOf("## Ops block contract"));
});

test("nothing pending renders as an unqualified negative", () => {
  const text = renderContextInstructions(bundle({}));
  assert.match(text, /you owe no answers and are waiting on nobody/);
  assert.doesNotMatch(text, /not shown/, "there was nothing to withhold, so no hedge belongs here");
});

test("each capped section carries its own count", () => {
  const text = renderContextInstructions(
    bundle({
      agentMemory: [{ agentId: "developer", key: "k", value: "v", updatedAt: "2026-01-01T00:00:00.000Z", eventId: "e1" }],
      unreadMail: [
        {
          id: "msg-1",
          from: "architect",
          to: ["developer"],
          type: "REQUEST",
          threadId: "t1",
          priority: "NORMAL",
          payload: { ask: "x" },
          artifactRefs: [],
          timestamp: "2026-01-01T00:00:00.000Z",
          goalId: "g1",
        },
      ],
      recentOwnActivity: ["[t] a → b MSG x"],
      relevantDecisions: [
        {
          id: "d1",
          goalId: "g1",
          topic: "retries",
          decision: { pick: "exponential" },
          status: "RATIFIED",
          createdAt: "2026-01-01T00:00:00.000Z",
          ratifiedAt: "2026-01-01T00:00:00.000Z",
        } as unknown as AgentContextBundle["relevantDecisions"][number],
      ],
      omitted: { unread: 3, decisions: 2, activity: 9, memory: 4 },
    }),
  );

  assert.match(text, /\+3 more unread message/);
  assert.match(text, /\+2 more ratified decision/);
  assert.match(text, /\+9 more event/);
  assert.match(text, /\+4 more note/);
});

test("evicted memory and merely-unshown memory read as different things", () => {
  const note = { agentId: "developer", key: "k", value: "v", updatedAt: "2026-01-01T00:00:00.000Z", eventId: "e1" };
  const text = renderContextInstructions(bundle({ agentMemory: [note], omitted: { memory: 2 }, elidedMemory: 7 }));

  // Two different losses. One is recoverable next turn at a wider tier; the
  // other is gone from state for good, and only the second warrants telling the
  // agent its sense of its own history is wrong.
  assert.match(text, /\+2 more note\(s\) you wrote/);
  assert.match(text, /7 older notes dropped/);
  assert.match(text, /worked longer than this list shows/);

  const evictedOnly = renderContextInstructions(bundle({ agentMemory: [note], elidedMemory: 1 }));
  assert.match(evictedOnly, /1 older note dropped/, "singular, because an off-by-one plural reads as a rounding");
  assert.doesNotMatch(evictedOnly, /not shown/);
});

/**
 * The warning has to survive the case that produces it.
 *
 * `elidedMemory` counts notes gone from state for good, so by construction it is
 * most likely to be non-zero on the exact turn an agent has no notes left to
 * show — the marker is filtered out of `agentMemory` during assembly. Keying the
 * section on `agentMemory.length > 0` therefore hid the warning from the one
 * agent that had lost its history, and told it nothing instead. The test above
 * always passed a note alongside the count, which is why the gap went unseen.
 */
test("an agent whose notes were all evicted is still told, with none left to show", () => {
  const text = renderContextInstructions(bundle({ agentMemory: [], elidedMemory: 4 }));

  assert.match(text, /## Your memory \(L2\)/, "the section has to exist for the warning to live in");
  assert.match(text, /4 older notes dropped/);
  assert.match(text, /worked longer than this list shows/);
});

test("no memory and nothing evicted still renders no memory section", () => {
  // The counterweight to the test above: keeping the section alive for the
  // warning must not make an empty "## Your memory" header a permanent fixture,
  // which is the noise the original guard was right to prevent.
  const text = renderContextInstructions(bundle({ agentMemory: [] }));
  assert.doesNotMatch(text, /## Your memory/);
});

test("a section with nothing withheld gets no note", () => {
  const text = renderContextInstructions(
    bundle({
      agentMemory: [{ agentId: "developer", key: "k", value: "v", updatedAt: "2026-01-01T00:00:00.000Z", eventId: "e1" }],
      // Explicit zeros, the shape a caller produces when it counted and found
      // nothing missing. A `0` that renders as "+0 more" is noise that teaches
      // the model to ignore the notes that matter.
      omitted: { memory: 0, unread: 0 },
    }),
  );
  assert.doesNotMatch(text, /not shown/);
});

/**
 * The counts above are only worth rendering if they are true. Everything so far
 * fed `omitted` in by hand; this drives real state through the real builder, so
 * a miscount in assembly cannot hide behind a correct renderer.
 */
test("the builder counts what it actually withheld, and the prompt reports it", async () => {
  const m = await makeMesh({
    agents: [
      { id: "architect", role: "architect", capabilities: ["review.design"], interests: [] },
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
    ],
    mayContact: { architect: ["dev"], dev: ["architect"] },
    mode: "parked",
  });

  for (let i = 0; i < 5; i++) {
    await m.supervisor.sendMessage({
      from: "architect",
      to: ["dev"],
      type: "REQUEST",
      newThread: { subject: `ask ${i}` },
      payload: { q: `question ${i}` },
    });
  }

  const deps = { config: m.config, kernel: m.kernel };
  const full = buildAgentContext(deps, "dev");
  assert.equal(full.unreadMail.length, 5);
  assert.equal(full.omitted?.unread, undefined, "nothing was withheld, so no count belongs in the bundle");

  const capped = buildAgentContext(deps, "dev", undefined, { maxUnread: 2 });
  assert.equal(capped.unreadMail.length, 2);
  assert.equal(capped.omitted?.unread, 3, "5 waiting, 2 shown");
  assert.match(renderContextInstructions(capped), /\+3 more unread message/);

  // The cap clamps to at least 1, which is what keeps the "nothing is pending"
  // negative honest elsewhere: a non-empty pool can never render as an empty
  // section.
  const floor = buildAgentContext(deps, "dev", undefined, { maxUnread: 0 });
  assert.ok(floor.unreadMail.length >= 1, "a section must never vanish entirely while it has content");
  assert.equal(floor.omitted?.unread, 4);

  await m.cleanup();
});
