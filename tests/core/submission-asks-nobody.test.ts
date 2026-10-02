import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, evidenceContent } from "../helpers";
import { buildAgentContext, renderContextInstructions } from "../../packages/core/src/context";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * Submitting an artifact for review asks nobody and wakes no one; the seat is told so, where it can still ask.
 *
 * The twelfth cronlite run (2026-10-02). The developer finished the test-suite patch and did two things: moved it to
 * READY_FOR_REVIEW (`mesh_artifact_transition`) and announced it (`mesh_announce`, "TEST_SUITE_READY"). Neither is an ask, so
 * nobody was woken. The tech lead's first turn on it came 3 min 2 s later (16:50:24 to 16:53:26), when the unread-mail sweep
 * woke it; in round two the same happened to the sixth version of the implementation (17:14:00 to 17:16:39, 2 min 39 s). The
 * architect's document, asked for with `review.artifact`, was approved 1 min 28 s after the ask.
 *
 * Two lines of the briefing led there. "A DRAFT nobody transitions is never reviewed and never becomes evidence" reads as "a
 * transition gets it reviewed", and under the collapsed vocabulary "hand over" is `mesh_announce`, which "wakes no one". Now the
 * briefing says that submitting asks nobody and names the tool that does, as this seat has it (`mesh_request_review`, or
 * `mesh_call review.artifact` under the contracts vocabulary), and the reply to the submission says it again, naming the seats
 * that can settle the artifact, when the artifact is still READY_FOR_REVIEW afterwards and some other seat could settle it.
 */

const DEV = { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "test.execute", "git.commit"], interests: [] };
const LEAD = { id: "lead", role: "tech-lead", capabilities: ["repository.read", "code.review", "git.merge"], authority: ["implementation.approve"], interests: [] };
const PEER = { id: "peer", role: "tech-lead", capabilities: ["repository.read", "code.review"], authority: ["implementation.approve"], interests: [] };

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

const turnFor = (agentId: string) =>
  ({ turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`, agentId, reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] }) as never;
const op = (m: Mesh, actorId: string, o: MeshOp) => m.supervisor.executeOp(actorId, o, turnFor(actorId));

async function mesh(agents: Array<Record<string, unknown>>, vocabulary?: "typed" | "contracts"): Promise<Mesh> {
  const ids = agents.map((a) => a.id as string);
  return makeMesh({
    agents,
    mayContact: Object.fromEntries(ids.map((id) => [id, ids.filter((o) => o !== id)])),
    mode: "parked",
    ...(vocabulary ? { bus: { vocabulary } } : {}),
  } as never);
}

async function draft(m: Mesh, owner: string, name: string, type: string): Promise<string> {
  const created = await m.supervisor.createArtifact({ actorId: owner, name, type: type as never, content: evidenceContent(name) });
  if (!("artifact" in created)) throw new Error(`create failed: ${JSON.stringify(created)}`);
  return created.artifact.id;
}

const submit = (m: Mesh, who: string, id: string) => op(m, who, { op: "transition_artifact", artifactId: id, to: "READY_FOR_REVIEW" } as MeshOp);
const statusOf = (m: Mesh, id: string) => m.kernel.state.artifacts.get(id)?.status;

test("a seat that submits its patch is told nobody has been asked, whom to ask, and with which tool", async () => {
  const m = await mesh([DEV, LEAD]);
  try {
    const id = await draft(m, "dev", "the patch", "CodePatch");
    const res = await submit(m, "dev", id);
    assert.equal(res.ok, true, res.reason);
    assert.equal(res.caveat, true, "accepted with a caveat: the submission stands, and the seat is told");
    assert.equal(statusOf(m, id), "READY_FOR_REVIEW");
    assert.match(res.reason ?? "", /^submitted for review, but nobody has been asked for a verdict, and a submission wakes no one \(an announcement does not either\)/);
    assert.match(res.reason ?? "", /: ask lead with `mesh_request_review` \(artifactId\/reviewers\);/, "the typed vocabulary's tool, and the one seat that can settle it");
    assert.match(res.reason ?? "", /until you do they meet it minutes from now, on their next turn$/);
  } finally {
    await m.cleanup();
  }
});

test("under the contracts vocabulary the tool it names is the one that seat has", async () => {
  const m = await mesh([DEV, LEAD], "contracts");
  try {
    const id = await draft(m, "dev", "the patch", "CodePatch");
    const res = await submit(m, "dev", id);
    assert.match(res.reason ?? "", /: ask lead with `mesh_call` with contract `review\.artifact` \(request: \{ artifactId, reviewers \}\);/);
    assert.doesNotMatch(res.reason ?? "", /mesh_request_review/, "it is not in that seat's tool list, and naming it is how a seat loses a turn");
  } finally {
    await m.cleanup();
  }
});

test("with more than one seat that can settle it, they are named as a list to choose from", async () => {
  const m = await mesh([DEV, LEAD, PEER]);
  try {
    const id = await draft(m, "dev", "the patch", "CodePatch");
    const res = await submit(m, "dev", id);
    assert.match(res.reason ?? "", /: ask one of lead, peer with /);
  } finally {
    await m.cleanup();
  }
});

test("the repair it names works: asked for, the artifact is under review", async () => {
  const m = await mesh([DEV, LEAD]);
  try {
    const id = await draft(m, "dev", "the patch", "CodePatch");
    assert.equal((await submit(m, "dev", id)).caveat, true);
    const asked = await op(m, "dev", { op: "request_review", artifactId: id, reviewers: ["lead"] } as MeshOp);
    assert.equal(asked.ok, true, asked.reason);
    assert.equal(statusOf(m, id), "UNDER_REVIEW");
  } finally {
    await m.cleanup();
  }
});

test("a version whose review was asked for says nothing when it is submitted again, though the submission pulls it back", async () => {
  const m = await mesh([DEV, LEAD]);
  try {
    const id = await draft(m, "dev", "the patch", "CodePatch");
    const asked = await op(m, "dev", { op: "request_review", artifactId: id, reviewers: ["lead"] } as MeshOp);
    assert.equal(asked.ok, true, asked.reason);
    assert.equal(statusOf(m, id), "UNDER_REVIEW");
    // Legal, and what a seat that asks and then submits does: the artifact is READY_FOR_REVIEW again, with the ask still standing.
    const again = await submit(m, "dev", id);
    assert.equal(again.ok, true, again.reason);
    assert.equal(statusOf(m, id), "READY_FOR_REVIEW", "fixture: pulled back");
    assert.doesNotMatch(again.reason ?? "", /nobody has been asked/, "somebody was: the ask for this version stands");
    assert.equal(again.caveat, undefined);
  } finally {
    await m.cleanup();
  }
});

test("a resubmission whose earlier version was asked for is re-asked by the mesh, and says nothing", async () => {
  const m = await mesh([DEV, LEAD]);
  try {
    const id = await draft(m, "dev", "the patch", "CodePatch");
    const asked = await op(m, "dev", { op: "request_review", artifactId: id, reviewers: ["lead"] } as MeshOp);
    assert.equal(asked.ok, true, asked.reason);
    // A new version supersedes the open ask (the reviewers are told to stop), and submitting it re-asks them.
    const next = await m.supervisor.createArtifact({ actorId: "dev", name: "the patch", type: "CodePatch", content: evidenceContent("v2"), asVersionOf: id });
    if (!("artifact" in next)) throw new Error(`version failed: ${JSON.stringify(next)}`);
    const res = await submit(m, "dev", next.artifact.id);
    assert.equal(res.ok, true, res.reason);
    assert.equal(statusOf(m, next.artifact.id), "UNDER_REVIEW", "the carried ask was re-issued, so the artifact is already in review");
    assert.doesNotMatch(res.reason ?? "", /nobody has been asked/);
  } finally {
    await m.cleanup();
  }
});

test("an owner that is the only seat that can settle the artifact has nobody to ask, and is not told to", async () => {
  const m = await mesh([LEAD, { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write"], interests: [] }]);
  try {
    // `lead` owns it and is the only seat with review authority: the carve-out that lets an owner settle its own work.
    const id = await draft(m, "lead", "the lead's patch", "CodePatch");
    const res = await submit(m, "lead", id);
    assert.equal(res.ok, true, res.reason);
    assert.doesNotMatch(res.reason ?? "", /nobody has been asked/);
    assert.equal(res.caveat, undefined);
  } finally {
    await m.cleanup();
  }
});

test("an artifact that is no longer READY_FOR_REVIEW is not told that nobody was asked", async () => {
  const m = await mesh([DEV, LEAD]);
  try {
    const id = await draft(m, "dev", "the patch", "CodePatch");
    const sayable = m.supervisor as unknown as { submissionAskedNobody(actor: string, artifactId: string): string | undefined };
    assert.equal((await submit(m, "dev", id)).caveat, true, "fixture: nobody was asked, so the hint is due");
    assert.ok(sayable.submissionAskedNobody("dev", id), "fixture: and is still due while it is READY_FOR_REVIEW");
    // Whatever moved it on (a verdict that landed with the submission, a gate that was already met) leaves nothing to ask for.
    m.kernel.state.artifacts.get(id)!.status = "APPROVED";
    assert.equal(sayable.submissionAskedNobody("dev", id), undefined);
    assert.equal(sayable.submissionAskedNobody("dev", "art-that-does-not-exist"), undefined);
  } finally {
    await m.cleanup();
  }
});

test("a refused submission and a move to another status carry no hint", async () => {
  const m = await mesh([DEV, LEAD]);
  try {
    const id = await draft(m, "dev", "the patch", "CodePatch");
    // Not the owner: refused as before, with the refusal and nothing else.
    const refused = await submit(m, "lead", id);
    assert.equal(refused.ok, false);
    assert.doesNotMatch(refused.reason ?? "", /nobody has been asked/);
    // Another status entirely.
    const archived = await op(m, "dev", { op: "transition_artifact", artifactId: id, to: "ARCHIVED" } as MeshOp);
    assert.doesNotMatch(archived.reason ?? "", /nobody has been asked/);
  } finally {
    await m.cleanup();
  }
});

test("the briefing says that submitting asks nobody, and names the ask as the seat has it", async () => {
  for (const vocabulary of [undefined, "contracts"] as const) {
    const label = vocabulary ?? "typed";
    const m = await mesh([DEV, LEAD], vocabulary);
    try {
      await draft(m, "dev", "the patch", "CodePatch");
      const text = renderContextInstructions(buildAgentContext({ config: m.config, kernel: m.kernel }, "dev"));
      assert.match(text, /A DRAFT nobody transitions is never reviewed and never becomes evidence\. Submitting asks nobody and wakes no one, though: to get a verdict/, `${label}: the sentence follows the one it corrects`);
      const from = text.indexOf("Submitting asks nobody");
      const sentence = text.slice(from, text.indexOf("An announcement wakes no one either", from));
      assert.match(sentence, /, naming a seat from the list on the artifact's line of those that settle a review of it\. $/, `${label}: pointed at the list the line already prints`);
      if (vocabulary === "contracts") {
        assert.match(sentence, /ask for it as well with `mesh_call` with contract `review\.artifact` \(request: \{ artifactId, reviewers \}\)/);
        assert.doesNotMatch(sentence, /mesh_request_review/, "not in that seat's tool list");
      } else {
        assert.match(sentence, /ask for it as well with `mesh_request_review` \(artifactId\/reviewers\)/);
        assert.doesNotMatch(sentence, /review\.artifact/);
      }
      assert.match(text, /An announcement wakes no one either, so a reviewer who was only told finds the artifact minutes later\./);
    } finally {
      await m.cleanup();
    }
  }
});
