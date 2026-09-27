import { test } from "node:test";
import assert from "node:assert/strict";
import { fitToSoftCap, tierName, CONTEXT_TIER_LADDER, estimateTokens } from "../../packages/core/src/supervisor";
import type { ContextLimits } from "../../packages/core/src/context";

/**
 * A degraded tier is filled by token budget, owed requests first.
 *
 * Measured 2026-09-25 (NOTES live-run §17): the `minimal` rung (17 of 52
 * contexts) capped outstanding requests at 1 and artifacts at 1 while ~1.3k of
 * its ~9k token budget went unused — tech-lead saw 1 of the 9 asks it owed. The
 * rung is a floor to fall back to, not a size to stop at.
 */

const [, TIGHT, MINIMAL] = CONTEXT_TIER_LADDER;

/** What each section could show, and each item's rendered size. */
const AVAILABLE: Required<ContextLimits> = {
  maxOutstanding: 9,
  maxUnread: 12,
  maxArtifactRefs: 20,
  maxMemory: 20,
  maxDecisions: 10,
  maxActivity: 15,
  maxRefusals: 5,
};
const ITEM_CHARS = 110;
const BASE_CHARS = 1000;
const CAP = 1000; // tokens: 3500 chars

/**
 * Stands in for bundle assembly with the builder's own clamp: an absent field is
 * the section's full default, and no section can show more than it has.
 */
function build(limits: ContextLimits | undefined): { text: string; limits: ContextLimits | undefined } {
  let items = 0;
  for (const key of Object.keys(AVAILABLE) as Array<keyof ContextLimits>) {
    const want = limits?.[key];
    items += Math.min(AVAILABLE[key], want === undefined ? Infinity : Math.max(1, Math.floor(want)));
  }
  return { text: "x".repeat(BASE_CHARS + items * ITEM_CHARS), limits };
}

test("the floor tier is filled up to the cap, owed requests first", () => {
  const out = fitToSoftCap({ value: build(undefined), render: (v) => v.text, rebuild: (t) => build(t), cap: CAP, fill: true });

  assert.equal(out.landed, true);
  assert.equal(tierName(out.tier), "minimal", "the rung it fell to is still reported as that rung");
  assert.ok(estimateTokens(out.rendered.length) <= CAP, `the cap still holds: ${estimateTokens(out.rendered.length)}`);
  assert.ok((out.limits?.maxOutstanding ?? 0) >= AVAILABLE.maxOutstanding, "every owed request fits, so every one is shown");
  assert.ok((out.limits?.maxUnread ?? 0) > MINIMAL.maxUnread!, "mail is next, and gets what is left");
  assert.equal(out.limits?.maxArtifactRefs, MINIMAL.maxArtifactRefs, "nothing left for the rest: they stay at the floor");
  assert.equal(out.rendered, out.value.text, "the rendered text is the value's");
  // Spent, not left on the table: one more mail item would not have fit.
  assert.ok(estimateTokens(out.rendered.length + ITEM_CHARS) > CAP, "the fill stops only when the next item would not fit");
});

test("fill never widens past the tier budget pressure chose", () => {
  // Budget pressure already chose `tight`; the soft cap walked on to `minimal`.
  const out = fitToSoftCap({ value: build(undefined), render: (v) => v.text, startTier: TIGHT, rebuild: (t) => build(t), cap: CAP, fill: true });
  assert.equal(tierName(out.tier), "minimal");
  // 9 owed and room for them, but budget pressure said `tight`: 3.
  assert.equal(out.limits?.maxOutstanding, TIGHT.maxOutstanding, "the thread ledger's decision is a ceiling, not a suggestion");
  assert.ok((out.limits?.maxUnread ?? Infinity) <= TIGHT.maxUnread!);
  assert.ok(estimateTokens(out.rendered.length) <= CAP);
});

test("a turn under the cap is untouched, fill or no fill", () => {
  let rebuilds = 0;
  const out = fitToSoftCap({
    value: { text: "small" },
    render: (v) => v.text,
    rebuild: () => {
      rebuilds++;
      return { text: "" };
    },
    cap: CAP,
    fill: true,
  });
  assert.equal(rebuilds, 0);
  assert.equal(out.tier, undefined);
  assert.equal(out.limits, undefined, "full context has no limits to report");
});
