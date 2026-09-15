import { test } from "node:test";
import assert from "node:assert/strict";
import { focusTerms, rankByRelevance, isRelevantArtifact } from "../../packages/core/src/context";
import { estimateTokens } from "../../packages/core/src/supervisor";
import { transcriptSize } from "../../packages/runtime-claude/src/index";
import { artifactScope, defaultArtifactScope } from "../../packages/protocol/src/catalog";
import type { Artifact, MeshMessage } from "../../packages/protocol/src/index";

/**
 * Selection used to answer "what happened most recently in this mission?" when
 * the question that matters is "what bears on the task in front of me?".
 *
 * The bar these tests hold the scorer to is deliberately asymmetric. It is
 * allowed to be crude — lexical overlap cannot know that "auth" and "login" are
 * the same subject. It is NOT allowed to lose anything recency would have kept,
 * because that would trade a known-adequate selection for a guess.
 */

const id = (s: string) => s;

test("a list that fits under the cap is returned untouched", () => {
  const items = ["a", "b", "c"];
  assert.deepEqual(rankByRelevance(items, 10, focusTerms("anything"), id), items);
});

test("with nothing to match on, the result is exactly the recency slice", () => {
  const items = ["one", "two", "three", "four", "five", "six"];
  // An empty focus scores everything 0, which is the no-current-task case.
  assert.deepEqual(rankByRelevance(items, 4, focusTerms(""), id), items.slice(0, 4));
});

test("the result is always full when there are enough candidates", () => {
  const items = Array.from({ length: 30 }, (_, i) => `item-${i}`);
  for (const cap of [1, 2, 5, 9, 20]) {
    assert.equal(rankByRelevance(items, cap, focusTerms("nothing matches here"), id).length, cap);
  }
});

test("an old but relevant item is pulled in ahead of newer irrelevant ones", () => {
  // Newest first, as every caller passes them.
  const items = [
    "refactor the build script",
    "update the changelog",
    "bump lockfile versions",
    "tidy up formatting",
    "ratified the payment retry policy for declined cards",
  ];
  const picked = rankByRelevance(items, 3, focusTerms("payment retry on declined cards"), id);

  assert.ok(
    picked.includes("ratified the payment retry policy for declined cards"),
    "the one item about the current task must survive a cap that recency would have spent on noise",
  );
});

test("the newest half of the slots survive regardless of score", () => {
  const items = [
    "newest and totally unrelated",
    "second newest, also unrelated",
    "third, unrelated",
    "old but stuffed with payment retry declined cards payment retry",
    "also old, payment retry declined",
  ];
  const picked = rankByRelevance(items, 4, focusTerms("payment retry declined cards"), id);

  // cap 4 -> ceil(4/2) = 2 reserved slots, taken from the head.
  assert.equal(picked[0], "newest and totally unrelated");
  assert.equal(picked[1], "second newest, also unrelated");
  assert.ok(picked.includes("old but stuffed with payment retry declined cards payment retry"));
});

test("focus terms drop stop words and fragments that would match everything", () => {
  const terms = focusTerms("The service should have retry with a backoff");
  assert.equal(terms.has("the"), false);
  assert.equal(terms.has("with"), false);
  assert.equal(terms.has("should"), false);
  assert.equal(terms.has("a"), false, "one-character tokens carry no signal");
  assert.equal(terms.has("retry"), true);
  assert.equal(terms.has("backoff"), true);
  assert.equal(terms.has("service"), true);
});

/**
 * The estimator only has to be right enough to trip a threshold, but "right
 * enough" still has a direction: it must not UNDER-state tokens, because the
 * same number sizes a budget hold. A hold short of the real prompt is a hold
 * that admitted a turn the ledger could not pay for.
 */
test("token estimates round up and never under-state a real prompt", () => {
  assert.equal(estimateTokens(0), 0);
  assert.equal(estimateTokens(-50), 0, "a negative length is nonsense, not a negative budget");
  assert.ok(estimateTokens(1) >= 1, "any content at all costs at least one token");

  // English prose runs ~4 chars/token; the estimator uses 3.5 on purpose, so it
  // should sit at or above a 4-chars/token reading of the same text.
  const prose = "the quick brown fox jumps over the lazy dog ".repeat(200);
  assert.ok(
    estimateTokens(prose.length) >= Math.ceil(prose.length / 4),
    "the estimate must bias high, since it also sizes the pre-flight hold",
  );
});

/**
 * The transcript, not the new message, was the unbounded quantity. Reading
 * `input` alone hides it completely the moment the prefix caches.
 */
test("transcript size counts the cached prefix, not just the fresh input", () => {
  assert.equal(transcriptSize({ input: 500, output: 100, total: 600, cacheRead: 148_000 }), 148_500);
  assert.equal(transcriptSize({ input: 0, output: 0, total: 0, cacheRead: 0 }), 0);
  assert.equal(transcriptSize(undefined), 0);
});

/**
 * Artifact scope.
 *
 * Relevance used to be a hardcoded list of four type names inside the context
 * builder. That made two true statements unstateable: "this CodePatch is the
 * one the whole mission is about" and "this ADR is scratch work nobody else
 * needs". It also had no notion of an ending — a mission document stayed in
 * every agent's context after it was archived, which is worse than absent,
 * because a superseded architecture reads exactly like a current one and is
 * usually the longer, more confident-sounding document.
 */

function artifactFixture(over: Partial<Artifact>): Artifact {
  return {
    id: "art-1",
    name: "design",
    type: "ArchitectureDocument",
    goalId: "g1",
    owner: "architect",
    version: 1,
    status: "DRAFT",
    contentRef: "content/art-1/v1",
    digest: "sha256:abc",
    metadata: {},
    provenance: { source: "agent", trustLevel: 50 },
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: "architect",
    ...over,
  };
}

/** Only `artifactRefs` is read; the rest of a message is noise to this predicate. */
function mailReferencing(uri: string): MeshMessage[] {
  return [{ artifactRefs: [{ uri }] }] as unknown as MeshMessage[];
}

test("a type's default scope is the behaviour the old hardcoded list had", () => {
  for (const t of ["ArchitectureDocument", "RequirementsDoc", "ADR", "ApiSpec"] as const) {
    assert.equal(defaultArtifactScope(t), "mission", `${t} was mission-wide before and must stay so`);
  }
  for (const t of ["CodePatch", "TestReport", "BenchmarkResult"] as const) {
    assert.equal(defaultArtifactScope(t), "work");
  }
});

test("an artifact logged before scope existed reads as its type default", () => {
  // Replay determinism: projections are a pure function of the log, so an event
  // with no `scope` has to keep producing the state it always produced.
  assert.equal(artifactScope({ type: "ADR" }), "mission");
  assert.equal(artifactScope({ type: "CodePatch" }), "work");
});

test("an explicit scope wins over the type default in both directions", () => {
  assert.equal(artifactScope({ type: "CodePatch", scope: "mission" }), "mission");
  assert.equal(artifactScope({ type: "ADR", scope: "work" }), "work");
});

test("a live mission document is shown to an agent that neither owns nor was sent it", () => {
  // The property the hardcoded list existed to guarantee, and the reason this
  // change had to preserve it: a pm owning requirements.accept otherwise works
  // from memory while the DRAFT it was never handed sits in the store.
  const a = artifactFixture({ status: "DRAFT" });
  assert.equal(isRelevantArtifact(a, "pm", []), true);
});

test("an archived mission document drops out of everyone else's context", () => {
  const a = artifactFixture({ status: "ARCHIVED" });
  assert.equal(isRelevantArtifact(a, "pm", []), false);
});

test("a rejected mission document drops out too", () => {
  const a = artifactFixture({ status: "REJECTED" });
  assert.equal(isRelevantArtifact(a, "pm", []), false);
});

test("the author still sees their own archived document", () => {
  // "Retired" is a statement about other agents' attention, not a redaction.
  const a = artifactFixture({ status: "ARCHIVED" });
  assert.equal(isRelevantArtifact(a, "architect", []), true);
});

test("an archived document someone just mailed you is still shown", () => {
  const a = artifactFixture({ status: "ARCHIVED" });
  const unread = mailReferencing("artifact://ArchitectureDocument/design/v1");
  assert.equal(
    isRelevantArtifact(a, "pm", unread),
    true,
    "hiding it here would leave the agent reading about a document it cannot see",
  );
});

test("a work artifact promoted to mission scope becomes visible mesh-wide", () => {
  // Unstateable before this change: the type list had no entry for "the patch
  // this whole mission is about".
  const a = artifactFixture({ type: "CodePatch", name: "the-patch", scope: "mission", status: "DRAFT" });
  assert.equal(isRelevantArtifact(a, "reviewer", []), true);
});

test("a mission-typed artifact demoted to work scope stops crowding every context", () => {
  // The other half: a scratch ADR an architect is thinking out loud in.
  const a = artifactFixture({ type: "ADR", scope: "work", status: "DRAFT" });
  assert.equal(isRelevantArtifact(a, "pm", []), false);
  assert.equal(isRelevantArtifact(a, "architect", []), true, "its author still holds it");
});

test("anything awaiting a verdict is shown regardless of scope", () => {
  // A review nobody is shown is a review that does not happen.
  for (const status of ["READY_FOR_REVIEW", "UNDER_REVIEW"] as const) {
    const a = artifactFixture({ type: "CodePatch", scope: "work", status });
    assert.equal(isRelevantArtifact(a, "reviewer", []), true, status);
  }
});
