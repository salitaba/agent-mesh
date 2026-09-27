import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, type AgentSpec, type TestMeshOptions } from "../helpers";
import { extractSummary } from "../../packages/agent-runtime/src/index";
import type { MeshOp } from "../../packages/protocol/src/index";
import type { OpResult, TurnRecord } from "../../packages/core/src/index";

/**
 * An accepted op's `reason` is a caveat only when the op says it is.
 *
 * The turn summary's caveat arm took every `ok: true` result carrying a
 * `reason` and wrote it as "⚠ op: reason" — into the summary, which is the
 * seat's next context, and into `notices`. Most of those reasons are not
 * remarks about how the op went but what it PRODUCED: `propose_decision`'s
 * decision id, a lease id, a commit sha, "merged as <sha>", a spawned worker's
 * id, and the seat's own words echoed back by `discharge`/`withdraw`. So every
 * decision proposal read as a warning, and a seat learns to skim past ⚠.
 *
 * The genuine caveats are the ones the op site marks (`OpResult.caveat`): a
 * review request naming a seat that cannot settle the artifact, a verdict that
 * moved nothing, a criterion that landed ASSERTED, a transition to the status
 * the artifact already has.
 */

const USAGE = { input: 7_000, output: 3_000, total: 10_000 };

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

/** One `actor` turn that makes each op as a mid-turn tool call, then replies `text`. */
async function runTools(
  agents: AgentSpec[],
  mayContact: Record<string, string[]>,
  actor: string,
  steps: Array<(answers: OpResult[]) => MeshOp>,
  text: string,
  extra: Partial<TestMeshOptions> = {},
): Promise<{ m: Mesh; turn: TurnRecord; answers: OpResult[] }> {
  const m = await makeMesh({ ...extra, agents, mayContact });
  for (const a of agents) if (a.id !== actor) stub(m).setScript(a.id, async () => ({ operations: [{ op: "wait" } as MeshOp] }));
  const answers: OpResult[] = [];
  let ran = false;
  stub(m).setScript(actor, async () => {
    if (!ran) {
      ran = true;
      for (const step of steps) answers.push(await m.supervisor.executeToolOp(actor, step(answers)));
    }
    return { text, operations: [], typedOps: true, summary: extractSummary(text), tokensUsed: USAGE };
  });
  await m.supervisor.activateAgent(actor, { kind: "manual" }, { explicit: true });
  await waitFor(`${actor}'s turn to close`, () => m.supervisor.getRecentTurns().some((t) => t.agentId === actor && t.status !== "running"));
  const turn = m.supervisor
    .getRecentTurns()
    .filter((t) => t.agentId === actor && t.status !== "running")
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))[0]!;
  return { m, turn, answers };
}

const DEV: AgentSpec[] = [
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "architecture.write"], interests: [] },
  { id: "pm", role: "pm", interests: [] },
];
const DEV_COMM = { dev: ["pm"], pm: ["dev"] };

const warnings = (turn: TurnRecord): string[] => (turn.notices ?? []).filter((n) => n.startsWith("⚠"));

test("an op's product is not a caveat: a decision id and a lease id draw no ⚠", async () => {
  const { m, turn, answers } = await runTools(
    DEV,
    DEV_COMM,
    "dev",
    [
      () => ({ op: "publish_artifact", name: "patch", type: "CodePatch", content: "a patch, described at length" }),
      (a) => ({ op: "acquire_lease", artifactId: String(a[0]?.artifactId), files: ["src/a.ts"] }),
      (a) => ({ op: "release_lease", artifactId: String(a[0]?.artifactId) }),
      () => ({ op: "propose_decision", topic: "database", decision: { choice: "postgres" } }),
      () => ({ op: "done", summary: "proposed postgres" }),
    ],
    "Proposed a database.",
  );
  try {
    assert.deepEqual(answers.map((a) => [a.op, a.ok]), [["publish_artifact", true], ["acquire_lease", true], ["release_lease", true], ["propose_decision", true], ["done", true]]);
    const [, lease, , decision] = answers;
    assert.ok(lease?.reason && decision?.reason, "both still carry their product — the seat needs it");
    assert.deepEqual(warnings(turn), [], `no warning for a turn that went as planned: ${JSON.stringify(turn.notices)}`);
    assert.ok(!String(turn.summary).includes("⚠"), `the seat's next context carries no warning sign: ${turn.summary}`);
    assert.equal(turn.modelSummary, "proposed postgres");
  } finally {
    await m.cleanup();
  }
});

test("a genuine caveat is still a ⚠ notice: a transition to the status the artifact already has", async () => {
  const { m, turn, answers } = await runTools(
    DEV,
    DEV_COMM,
    "dev",
    [
      () => ({ op: "publish_artifact", name: "Spec", type: "ArchitectureDocument", content: "# Spec\n\nfine." }),
      (a) => ({ op: "transition_artifact", artifactId: String(a[0]?.artifactId), to: "DRAFT" }),
      () => ({ op: "done", summary: "restated the spec's status" }),
    ],
    "Restated.",
  );
  try {
    const restated = answers[1];
    assert.equal(restated?.ok, true, JSON.stringify(restated));
    assert.match(String(restated?.reason), /already DRAFT — nothing to record/);
    const caveat = `⚠ transition_artifact: ${restated?.reason}`;
    assert.deepEqual(warnings(turn), [caveat]);
    assert.ok(String(turn.summary).includes(caveat), `and it rides the summary into the seat's memory: ${turn.summary}`);
  } finally {
    await m.cleanup();
  }
});

test("a genuine caveat is still a ⚠ notice: a review request naming a seat that cannot settle it", async () => {
  const agents: AgentSpec[] = [
    { id: "arch", role: "architect", capabilities: ["repository.read", "repository.write"], authority: ["architecture.approve"], interests: [] },
    { id: "lead", role: "tech-lead", capabilities: ["repository.read", "review.design"], authority: ["quality.approve"], interests: [] },
    { id: "ui", role: "ui-designer", capabilities: ["repository.read", "ui.write"], interests: [] },
  ];
  const { m, turn, answers } = await runTools(
    agents,
    { arch: ["lead", "ui"], lead: ["arch", "ui"], ui: ["arch", "lead"] },
    "arch",
    [
      () => ({ op: "publish_artifact", name: "design-system", type: "ArchitectureDocument", content: "tokens, components, states — at length" }),
      (a) => ({ op: "request_review", artifactId: String(a[0]?.artifactId), reviewers: ["lead", "ui"] }),
      () => ({ op: "done", summary: "asked for review" }),
    ],
    "Asked for review.",
  );
  try {
    const asked = answers[1];
    assert.equal(asked?.ok, true, JSON.stringify(asked));
    assert.deepEqual(warnings(turn), [`⚠ request_review: ${asked?.reason}`]);
    assert.match(warnings(turn)[0] ?? "", /ui cannot deliver a verdict/);
  } finally {
    await m.cleanup();
  }
});

test("a genuine caveat is still a ⚠ notice: a criterion accepted from a turn that checked nothing", async () => {
  const { m, turn, answers } = await runTools(
    [{ id: "po", role: "product-owner", authority: ["requirements.accept"], interests: [] }],
    { po: [] },
    "po",
    [
      () => ({ op: "approve", subject: "criterion:polish", comment: "looks fine" }),
      () => ({ op: "done", summary: "accepted polish" }),
    ],
    "Accepted.",
    { criteria: [{ id: "polish", description: "nice to have", mandatory: false }] },
  );
  try {
    const accepted = answers[0];
    assert.equal(accepted?.ok, true, JSON.stringify(accepted));
    assert.match(String(accepted?.reason), /recorded as ASSERTED, not EVIDENCED/, "the stub turn reported no tool before the claim");
    assert.deepEqual(warnings(turn), [`⚠ approve: ${accepted?.reason}`.slice(0, 400)]);
  } finally {
    await m.cleanup();
  }
});
