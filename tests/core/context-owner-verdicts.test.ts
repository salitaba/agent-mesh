import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { buildAgentContext, renderContextInstructions } from "../../packages/core/src/context";
import { Kernel } from "../../packages/core/src/kernel";
import { projectionConfigFor } from "../../packages/core/src/projections";
import { MemoryEventStore } from "../../packages/event-store/src/index";
import { FixedClock, type MeshEvent, type MeshOp } from "../../packages/protocol/src/index";

/**
 * The owner of an artifact reads why its reviewer ruled it not done.
 *
 * A rejection's reason is the one thing its owner has to act on, and it lived in the `review.rejected` event and nowhere the owner
 * reads. The owner was woken for the event ("Event matched your declared interests: review.rejected"), shown no reason, and asked the
 * reviewer for it: the eighteenth cronlite run's developer did so four times, a round trip of two turns each (a REQUEST_INFO and its
 * answer, about 24k tokens and a minute), because the reviewer's own message with the reason, when it sent one, arrived after the
 * turn's briefing was built. The verdict's comment is now kept with its record, and the artifact's line in its owner's briefing
 * carries it for as long as the verdict stands on the current version.
 */

const AGENTS = [
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write"], interests: [] },
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "code.review"], authority: ["implementation.approve"], interests: [] },
];
const COMM = { dev: ["lead"], lead: ["dev"] };

const turnFor = (agentId: string) =>
  ({ turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`, agentId, reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] }) as never;

type Mesh = Awaited<ReturnType<typeof makeMesh>>;
const op = (m: Mesh, actor: string, o: MeshOp) => m.supervisor.executeOp(actor, o, turnFor(actor));
const briefing = (m: Mesh, seat: string): string => renderContextInstructions(buildAgentContext({ config: m.config, kernel: m.kernel }, seat));
const lineOf = (text: string, name: string): string[] => {
  const all = text.split("\n");
  const at = all.findIndex((l) => l.startsWith("- artifact://") && l.includes(`/${name}/`));
  assert.ok(at >= 0, `the briefing lists ${name}`);
  const out = [all[at]!];
  for (let i = at + 1; all[i]?.startsWith("  - "); i++) out.push(all[i]!);
  return out;
};

async function underReview(): Promise<{ m: Mesh; id: string }> {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" } as never);
  const created = await m.supervisor.createArtifact({ actorId: "dev", name: "cli-patch", type: "CodePatch", content: "the CLI, as code, at length" });
  if (!("artifact" in created)) throw new Error("create failed");
  const id = created.artifact.id;
  await m.supervisor.transitionArtifact("dev", id, { to: "READY_FOR_REVIEW" });
  const asked = await op(m, "dev", { op: "request_review", artifactId: id, reviewers: ["lead"] } as MeshOp);
  assert.equal(asked.ok, true, String(asked.reason));
  return { m, id };
}

test("the owner's line carries what the reviewer wrote when it rejected, and the reviewer's own briefing does not repeat it", async () => {
  const { m, id } = await underReview();
  try {
    const res = await op(m, "lead", { op: "reject", subject: "implementation", artifactId: id, comment: "Strong progress, but day-of-week ranges to 7 are wrong:\n5-0 is accepted as 5-7." } as MeshOp);
    assert.equal(res.ok, true, String(res.reason));
    const [line, ...verdicts] = lineOf(briefing(m, "dev"), "cli-patch");
    assert.match(line!, /\(CodePatch, id art-[A-Za-z0-9]+, REJECTED\)/);
    assert.deepEqual(verdicts, ["  - lead rejected it: Strong progress, but day-of-week ranges to 7 are wrong: 5-0 is accepted as 5-7."], "on one line, as the reviewer wrote it");
    assert.deepEqual(lineOf(briefing(m, "lead"), "cli-patch").length, 1, "only the owner is told what its own reviewer said");
  } finally {
    await m.cleanup();
  }
});

test("an approval, and a rejection with no reason, add nothing", async () => {
  const { m, id } = await underReview();
  try {
    const rejected = await op(m, "lead", { op: "reject", subject: "implementation", artifactId: id } as MeshOp);
    assert.equal(rejected.ok, true, String(rejected.reason));
    assert.equal(lineOf(briefing(m, "dev"), "cli-patch").length, 1, "nothing was said, so nothing is repeated");
  } finally {
    await m.cleanup();
  }
  const second = await underReview();
  try {
    const approved = await op(second.m, "lead", { op: "approve", subject: "implementation", artifactId: second.id, comment: "good" } as MeshOp);
    assert.equal(approved.ok, true, String(approved.reason));
    assert.equal(lineOf(briefing(second.m, "dev"), "cli-patch").length, 1, "an approval is not a reason to act");
  } finally {
    await second.m.cleanup();
  }
});

test("a new version drops the verdicts on the old one, and with them the line", async () => {
  const { m, id } = await underReview();
  try {
    await op(m, "lead", { op: "reject", subject: "implementation", artifactId: id, comment: "descriptions, not code" } as MeshOp);
    assert.equal(lineOf(briefing(m, "dev"), "cli-patch").length, 2);
    const v2 = await m.supervisor.createArtifact({ actorId: "dev", name: "cli-patch", type: "CodePatch", content: "the CLI itself, as code", asVersionOf: id });
    if (!("artifact" in v2)) throw new Error("versioning failed");
    assert.equal(lineOf(briefing(m, "dev"), "cli-patch").length, 1, "what the reviewer said about v1 is not said about v2");
  } finally {
    await m.cleanup();
  }
});

test("a long reason is cut, and says how much", async () => {
  const { m, id } = await underReview();
  try {
    await op(m, "lead", { op: "reject", subject: "implementation", artifactId: id, comment: `${"x".repeat(1500)}${"y".repeat(300)}` } as MeshOp);
    const [, verdict] = lineOf(briefing(m, "dev"), "cli-patch");
    assert.ok(verdict!.includes("x".repeat(1500)) && !verdict!.includes("y"), "the first 1500 characters, and nothing after them");
    assert.match(verdict!, /… 300 more character\(s\) omitted$/);
  } finally {
    await m.cleanup();
  }
});

test("the comment is part of the ledger, so a replayed log tells the owner the same", async () => {
  const { m, id } = await underReview();
  try {
    await op(m, "lead", { op: "reject", subject: "implementation", artifactId: id, comment: "descriptions, not code" } as MeshOp);
    const fresh = new Kernel(new MemoryEventStore(), new FixedClock(), undefined, projectionConfigFor(m.config));
    await fresh.rebuild((await m.store.read()) as MeshEvent[]);
    const record = [...fresh.state.approvals.values()].flat().find((r) => r.artifactId === id && r.kind === "reject");
    assert.equal(record?.comment, "descriptions, not code");
    const text = renderContextInstructions(buildAgentContext({ config: m.config, kernel: fresh }, "dev"));
    assert.deepEqual(lineOf(text, "cli-patch").slice(1), ["  - lead rejected it: descriptions, not code"]);
  } finally {
    await m.cleanup();
  }
});
