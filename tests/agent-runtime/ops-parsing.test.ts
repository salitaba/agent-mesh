import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMeshOps, parseMeshOpsDetailed } from "../../packages/agent-runtime/src/index";

/**
 * The ops parser, and the two bugs that cost a live run its mission brief.
 *
 * A turn's ops arrive as a fenced ```mesh-json block. The old parser found the
 * block with one lazy regex, so the FIRST later ``` closed it — and the ops
 * contract tells seats to publish documents with `content` inline, so any
 * document containing a markdown fence truncated its own ops block
 * mid-JSON-string. The damage compounded: `exec` advanced past that truncated
 * close, so the real closing fence became the next candidate's OPENING fence
 * and the correct body was never offered as a candidate at all.
 *
 * On 2026-09-23 that lost pm's first turn — 47,825 tokens, a RequirementsDoc
 * carrying all 17 criterion ids, the MISSION delegation to the architect, and
 * `done`. Re-parsed at the last fence the same bytes yield
 * ['publish_artifact','send','done']. The mesh then ran for eleven hours
 * without a requirements baseline.
 *
 * The second bug is independent: `JSON.parse` on the whole array is
 * all-or-nothing, so a brace error in one op destroys every valid op beside
 * it. In the same run that killed a well-formed `transition_artifact` — the op
 * that would have released an artifact three seats were blocked on — because a
 * later `send` in the same array had one brace too many.
 */

/** A document body that contains its own code fence — the shape that broke it. */
const DOC_WITH_FENCE = [
  "# Requirements",
  "",
  "**Central abstraction:**",
  "",
  "```",
  "Skill -> Identity -> Versions -> Sources -> Resolution -> Lifecycle",
  "```",
  "",
  "The filesystem is an implementation detail.",
].join("\n");

function publishBlock(content: string): string {
  return [
    "No write capability in this seat — publishing the document inline instead.",
    "",
    "```mesh-json",
    JSON.stringify(
      [
        { op: "publish_artifact", name: "Requirements v1", type: "RequirementsDoc", content },
        { op: "send", type: "MISSION", to: ["architect"], payload: { ask: "design against these" } },
        { op: "done", summary: "published + delegated" },
      ],
      null,
      1,
    ),
    "```",
  ].join("\n");
}

test("a payload containing its own code fence does not truncate the ops block", () => {
  const ops = parseMeshOps(publishBlock(DOC_WITH_FENCE));
  assert.deepEqual(
    ops.map((o) => o.op),
    ["publish_artifact", "send", "done"],
    "the fence inside `content` must not be mistaken for the block's close",
  );
  const published = ops[0] as { content?: string };
  assert.ok(published.content?.includes("Skill -> Identity"), "the document body survives intact");
  assert.ok(published.content?.includes("```"), "including its own fence");
});

test("a fence-free payload still parses, so the common path is unchanged", () => {
  const ops = parseMeshOps(publishBlock("# Requirements\n\nPlain prose, no fences."));
  assert.deepEqual(ops.map((o) => o.op), ["publish_artifact", "send", "done"]);
});

test("one malformed op does not destroy the others", () => {
  // `}}}` closes one brace too many — exactly the shape that killed a live turn.
  const text = [
    "```mesh-json",
    '[{"op":"transition_artifact","artifactId":"art-1","to":"READY_FOR_REVIEW"},',
    ' {"op":"send","type":"INFORM","to":["pm"],"payload":{"note":{"a":"b"}}}},',
    ' {"op":"wait","reason":"awaiting review"}]',
    "```",
  ].join("\n");
  const { ops, diagnostic } = parseMeshOpsDetailed(text);
  const names = ops.map((o) => o.op);
  assert.ok(names.includes("transition_artifact"), "the valid first op survives its neighbour");
  assert.ok(names.includes("wait"), "and so does the valid last one");
  assert.equal(diagnostic.salvaged, true, "the turn is marked as recovered, not clean");
});

test("an array whose entries are all unrecognisable falls through to the salvage paths", () => {
  // Used to short-circuit: normalizeOps returned [], which was truthy.
  const text = ['```json', '["not", "ops", "at", "all"]', "```", "", "```mesh-json", '[{"op":"done"}]', "```"].join("\n");
  assert.deepEqual(parseMeshOps(text).map((o) => o.op), ["done"]);
});

test("multiple fenced blocks: the one carrying ops wins", () => {
  const text = [
    "Here is the shape I settled on:",
    "```ts",
    "type Skill = { id: string };",
    "```",
    "and the ops:",
    "```mesh-json",
    '[{"op":"publish_artifact","name":"ADR-1","type":"ADR","content":"body"},{"op":"done"}]',
    "```",
  ].join("\n");
  assert.deepEqual(parseMeshOps(text).map((o) => o.op), ["publish_artifact", "done"]);
});

test("a block cut off mid-reply still yields the ops that completed", () => {
  const text = ["```mesh-json", '[{"op":"done","summary":"finished"},', ' {"op":"send","type":"INF'].join("\n");
  assert.deepEqual(parseMeshOps(text).map((o) => o.op), ["done"]);
});

test("prose with no ops block is still no ops", () => {
  assert.deepEqual(parseMeshOps("I reviewed the patch and it looks fine to me."), []);
  assert.equal(parseMeshOpsDetailed("nothing structured here").diagnostic.salvaged, false);
});

test("a clean parse reports no salvage and no drops", () => {
  const { ops, diagnostic } = parseMeshOpsDetailed('```mesh-json\n[{"op":"done"}]\n```');
  assert.equal(ops.length, 1);
  assert.deepEqual(diagnostic, { salvaged: false, dropped: [] });
});
