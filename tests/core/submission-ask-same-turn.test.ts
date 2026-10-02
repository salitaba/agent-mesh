import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, evidenceContent } from "../helpers";
import { extractSummary } from "../../packages/agent-runtime/src/index";
import type { MeshOp } from "../../packages/protocol/src/index";
import type { OpResult, TurnRecord } from "../../packages/core/src/index";

/**
 * A submission that is asked for in the same turn is not recorded as one nobody asked for.
 *
 * The reply to `transition_artifact` says, when the artifact is still READY_FOR_REVIEW and no review of that version has been
 * asked for, that submitting asks nobody and wakes no one (R4). That is true at the moment it is said, and the seat reads it
 * there. It was also written into the turn's summary, which is the seat's own memory of the turn and what the dashboard shows
 * as the turn's warnings, as "⚠ transition_artifact: submitted for review, but nobody has been asked". In the thirteenth
 * cronlite run all three turns that carried it (the pm's at 20:47:19, the architect's at 20:47:47, the developer's at
 * 20:50:45) had gone on, in the same turn, to ask: submit, then ask is the order the briefing teaches. The next turn read a
 * warning about an ask it had made.
 *
 * So the reply is unchanged and the turn's record is made when the turn ends: the sentence stays only when the version still
 * has no ask.
 */

const DEV = { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "test.execute", "git.commit"], interests: [] };
const LEAD = { id: "lead", role: "tech-lead", capabilities: ["repository.read", "code.review", "git.merge"], authority: ["implementation.approve"], interests: [] };
const NOBODY = /nobody has been asked/;
const USAGE = { input: 7_000, output: 3_000, total: 10_000 };

/** One dev turn that makes each tool call in order, then replies with `text`; the turn record and every answer come back. */
async function turnThatSubmits(steps: Array<(artifactId: string) => MeshOp>) {
  const m = await makeMesh({ agents: [DEV, LEAD], mayContact: { dev: ["lead"], lead: ["dev"] }, mode: "parked" } as never);
  stub(m).setScript("lead", async () => ({ operations: [{ op: "wait" } as MeshOp] }));
  const created = await m.supervisor.createArtifact({ actorId: "dev", name: "the patch", type: "CodePatch", content: evidenceContent("the patch") });
  if (!("artifact" in created)) throw new Error(`create failed: ${JSON.stringify(created)}`);
  const artifactId = created.artifact.id;
  const answers: OpResult[] = [];
  let ran = false;
  stub(m).setScript("dev", async () => {
    if (!ran) {
      ran = true;
      for (const step of steps) answers.push(await m.supervisor.executeToolOp("dev", step(artifactId)));
    }
    return { text: "Submitted my patch.", operations: [], typedOps: true, summary: extractSummary("Submitted my patch."), tokensUsed: USAGE };
  });
  await m.goLive();
  await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
  await waitFor("dev's turn to close", () => m.supervisor.getRecentTurns().some((t) => t.agentId === "dev" && t.status !== "running"));
  await waitFor("the scheduler to drain", () => !m.supervisor.isTurnInFlight("dev") && m.scheduler.running() === 0 && m.scheduler.pending() === 0);
  const turn: TurnRecord = m.supervisor.getRecentTurns().filter((t) => t.agentId === "dev" && t.status !== "running").sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))[0]!;
  return { m, turn, answers, artifactId };
}

const submit = (id: string): MeshOp => ({ op: "transition_artifact", artifactId: id, to: "READY_FOR_REVIEW" }) as MeshOp;
const ask = (id: string): MeshOp => ({ op: "request_review", artifactId: id, reviewers: ["lead"] }) as MeshOp;
const done = (): MeshOp => ({ op: "done", summary: "submitted" }) as MeshOp;

test("submit, then ask in the same turn: the seat is told at the submission, and the turn's record is clean", async () => {
  const { m, turn, answers } = await turnThatSubmits([submit, ask, done]);
  try {
    assert.equal(answers[0]!.ok, true, answers[0]!.reason);
    assert.match(answers[0]!.reason ?? "", NOBODY, "the reply to the submission still says it, where the seat can act on it");
    assert.equal(answers[1]!.ok, true, `the ask: ${answers[1]!.reason}`);
    assert.doesNotMatch(turn.summary ?? "", NOBODY, "the seat's memory of the turn does not warn of an ask it made");
    assert.equal((turn.notices ?? []).some((n) => NOBODY.test(n)), false, `nor do the turn's notices: ${JSON.stringify(turn.notices)}`);
  } finally {
    await m.cleanup();
  }
});

test("submit and never ask: the turn's record keeps the sentence, because it is still true when the turn ends", async () => {
  const { m, turn, answers } = await turnThatSubmits([submit, done]);
  try {
    assert.match(answers[0]!.reason ?? "", NOBODY);
    assert.match(turn.summary ?? "", NOBODY, "the next turn reads that nobody was asked");
    assert.equal((turn.notices ?? []).some((n) => NOBODY.test(n)), true, `and so does the dashboard: ${JSON.stringify(turn.notices)}`);
  } finally {
    await m.cleanup();
  }
});

test("when the sentence goes, what the reply said besides it stays; when it does not, the reply is whole", async () => {
  const { m, artifactId } = await turnThatSubmits([submit, ask, done]);
  try {
    const caveatReason = (r: Record<string, unknown>): string | undefined => (m.supervisor as unknown as { caveatReason(r: unknown): string | undefined }).caveatReason(r);
    const version = m.kernel.state.artifacts.get(artifactId)!.version;
    const base = { ok: true, op: "transition_artifact", caveat: true };
    // This version has been asked for by now (the turn above did it).
    assert.equal(caveatReason({ ...base, reason: "moved; submitted for review, but nobody has been asked", unaskedSubmission: { artifactId, version, rest: "moved" } }), "moved", "the rest is kept");
    assert.equal(caveatReason({ ...base, reason: "submitted for review, but nobody has been asked", unaskedSubmission: { artifactId, version } }), undefined, "and with nothing else to say there is no line");
    // A version nobody asked about is still told.
    assert.equal(caveatReason({ ...base, reason: "moved; submitted for review, but nobody has been asked", unaskedSubmission: { artifactId, version: version + 1, rest: "moved" } }), "moved; submitted for review, but nobody has been asked");
    // An artifact the mesh does not hold is not known to have been asked about, so the reply stands.
    assert.equal(caveatReason({ ...base, reason: "moved; submitted for review, but nobody has been asked", unaskedSubmission: { artifactId: "art-unknown", version, rest: "moved" } }), "moved; submitted for review, but nobody has been asked");
    // And an ordinary result is untouched.
    assert.equal(caveatReason({ ok: true, op: "send", reason: "SENT, but it did not wake anyone" }), "SENT, but it did not wake anyone");
  } finally {
    await m.cleanup();
  }
});
