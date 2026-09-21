import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize } from "../../packages/observability/src/index";
import { EVENT_TYPES } from "../../packages/protocol/src/index";
import type { EventType, MeshEvent } from "../../packages/protocol/src/index";

/**
 * `summarize` carries the doc comment "Full-coverage human summary for every
 * canonical event type", and nothing enforced it. Sixteen of seventy-nine
 * types had no case and fell through to a default arm that returns `""` for
 * any payload without a `summary` key — which none of the sixteen had.
 *
 * Blank is the worst available failure here. A missing renderer that printed
 * the raw type, or `[no summary]`, would be ugly and obviously wrong; an empty
 * string is read by an operator as "this event carried nothing", and the
 * sixteen included `commitment.discharged` (every expiry and every refusal),
 * `session.rotated` (every discarded transcript) and `plan.gate_rejected`.
 *
 * The coupling is the point: `EVENT_TYPES` is hand-maintained, so a type added
 * there without a case would silently re-open the hole. This test is the
 * sibling of the one in `tests/protocol/event-catalog.test.ts`, which couples
 * `EVENT_TYPES` to the `EventType` union.
 */

/**
 * A payload key no real emitter writes, used to detect the default arm: it is
 * the only branch that echoes `p.summary` back verbatim. A type with its own
 * case either ignores the key or embeds it in a longer line, so exact equality
 * means "fell through".
 */
const SENTINEL = "__summarize_has_no_case_for_this_type__";

function render(type: EventType, payload: Record<string, unknown>): string {
  return summarize({ type, payload } as unknown as MeshEvent);
}

test("summarize: every canonical event type has its own case", () => {
  const uncovered = EVENT_TYPES.filter((t) => render(t, { summary: SENTINEL }) === SENTINEL);
  assert.deepEqual(uncovered, [], "these types fall through to the default arm and render as a blank feed line");
});

test("summarize: no canonical event type can render as a blank line", () => {
  // An empty payload is the worst case a renderer has to survive: the test
  // fixtures in this repo emit real types with stub payloads, and a truncated
  // log can replay one too. Every case must therefore have a floor — a literal,
  // or `shortId`, which returns an em-dash rather than "".
  const blank = EVENT_TYPES.filter((t) => render(t, {}).trim() === "");
  assert.deepEqual(blank, [], "an empty summary reads as 'nothing happened' in the operator feed");
});

/**
 * The lines this branch's work depends on reaching a human. `transcriptTokens`
 * and `transcriptTokensDiscarded` were carried in the event, documented in the
 * protocol and read by nothing — a field with no reader is indistinguishable
 * from one that was never written, and these two are the whole evidence that a
 * rotation was warranted.
 */
test("summarize: a rotation reports the size of the memory it threw away", () => {
  assert.equal(
    render("session.rotated", { agentId: "architect", sessionOrdinal: 3, transcriptTokensDiscarded: 165_129 }),
    "architect → session 3 · 165129 tokens discarded",
  );
  assert.equal(
    render("session.rotation_pending", { agentId: "architect", transcriptTokens: 130_000, thresholdTokens: 120_000, reason: "rotation" }),
    "architect holding 130000/120000 tokens · rotation pending",
  );
});

/**
 * Every caller of `dischargeCommitment` spreads its own `detail` object into
 * this payload and no two agree on what is in it, so the summary may only key
 * on the six fields the ledger writes itself.
 */
test("summarize: a discharged commitment names the ask, the outcome and who closed it", () => {
  assert.equal(
    render("commitment.discharged", { messageId: "msg-0123456789abcdef", reason: "expired", by: "system", from: "pm", to: ["architect"], requestType: "REQUEST" }),
    "msg-0123…cdef expired by system",
  );
  // A per-debtor discharge that leaves others still owing says so, because the
  // ask is not closed and the feed would otherwise imply it was.
  assert.equal(
    render("commitment.discharged", { messageId: "msg-1", reason: "refused", by: "architect", from: "pm", to: ["architect", "qa"], requestType: "REQUEST", partial: true, remaining: ["qa"] }),
    "msg-1 refused by architect · 1 still owing",
  );
});

/** An empty step list is a retraction, not an empty plan. */
test("summarize: withdrawing a plan does not render as zero steps done", () => {
  assert.equal(render("plan.updated", { agentId: "coder", plan: { steps: [], revision: 4 } }), "coder withdrew its plan (r4)");
  assert.equal(
    render("plan.updated", { agentId: "coder", plan: { steps: [{ status: "DONE" }, { status: "PENDING" }], revision: 5 } }),
    "coder 1/2 steps · r5",
  );
});
