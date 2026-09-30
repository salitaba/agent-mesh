import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { buildAgentContext, renderContextInstructions } from "../../packages/core/src/context";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * The seat briefing says who can settle a review of each artifact.
 *
 * `review.reviewer-cannot-settle` was the most repeated refusal of the cronlite runs
 * (six in the first, four more in the first patch of the second): seats kept naming a
 * reviewer whose verdict could never count, the owner of the artifact among them. The
 * refusal is good, it names who can, but it arrives after a turn spent on the wrong
 * name, and the fact it states was never in the briefing for the next one. It is now on
 * the line of each artifact a review can still be asked of, computed by the predicate
 * `request_review` itself applies, so the list and the refusal cannot disagree.
 */

const AGENTS = [
  { id: "arch", role: "architect", capabilities: ["repository.read", "repository.write"], authority: ["architecture.approve"], interests: [] },
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "review.design"], authority: ["quality.approve"], interests: [] },
  { id: "ui", role: "ui-designer", capabilities: ["repository.read", "ui.write"], interests: [] },
];
const COMM = { arch: ["lead", "ui"], lead: ["arch", "ui"], ui: ["arch", "lead"] };

const turnFor = (agentId: string) =>
  ({ turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`, agentId, reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] }) as never;

type Mesh = Awaited<ReturnType<typeof makeMesh>>;
const op = (m: Mesh, actor: string, o: MeshOp) => m.supervisor.executeOp(actor, o, turnFor(actor));

/** The artifact line, as the named seat reads it. */
function artifactLine(m: Mesh, seat: string, name: string): string {
  const text = renderContextInstructions(buildAgentContext({ config: m.config, kernel: m.kernel }, seat));
  const line = text.split("\n").find((l) => l.startsWith("- artifact://") && l.includes(`/${name}/`));
  assert.ok(line, `${seat}'s briefing lists ${name}`);
  return line;
}

async function publish(m: Mesh, actor: string, name: string, type: string): Promise<string> {
  const created = await m.supervisor.createArtifact({ actorId: actor, name, type: type as never, content: "tokens, components, states — at length, with the reasoning behind each" });
  if (!("artifact" in created)) throw new Error("create failed");
  return created.artifact.id;
}

test("the line names who can settle a review: the peer with authority, not the owner, not the seat with neither", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" });
  try {
    await publish(m, "arch", "design", "ArchitectureDocument");
    // pm-like routing seat: the one that used to pick "architect" for the architect's own document.
    const line = artifactLine(m, "ui", "design");
    assert.match(line, /a review of it is settled by: lead \(name only these\)/);
    assert.doesNotMatch(line, /settled by:[^—]*\barch\b/, "the owner cannot settle its own work while a peer can");
    assert.doesNotMatch(line, /settled by:[^—]*\bui\b/, "and a seat with no authority over the domain cannot settle it at all");
  } finally {
    await m.cleanup();
  }
});

test("what the line lists is exactly what request_review accepts", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" });
  try {
    const id = await publish(m, "arch", "design", "ArchitectureDocument");
    for (const seat of ["arch", "ui"]) {
      const refused = await op(m, "lead", { op: "request_review", artifactId: id, reviewers: [seat] } as MeshOp);
      assert.equal(refused.ok, false, `${seat} is not on the list, so the ask is refused`);
    }
    const accepted = await op(m, "arch", { op: "request_review", artifactId: id, reviewers: ["lead"] } as MeshOp);
    assert.equal(accepted.ok, true, accepted.reason ?? "");
  } finally {
    await m.cleanup();
  }
});

test("the owner IS listed when no peer could review its work (the single-agent case)", async () => {
  const m = await makeMesh({ agents: [AGENTS[0]!, AGENTS[2]!], mayContact: { arch: ["ui"], ui: ["arch"] }, mode: "parked" });
  try {
    await publish(m, "arch", "design", "ArchitectureDocument");
    assert.match(artifactLine(m, "ui", "design"), /settled by: arch \(name only these\)/);
  } finally {
    await m.cleanup();
  }
});

test("a settled artifact carries no such line: no review can be asked of it any more", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" });
  try {
    const id = await publish(m, "arch", "design", "ArchitectureDocument");
    assert.equal((await op(m, "arch", { op: "request_review", artifactId: id, reviewers: ["lead"] } as MeshOp)).ok, true);
    assert.match(artifactLine(m, "ui", "design"), /settled by: lead/, "while it is under review the line is there");
    assert.equal((await op(m, "lead", { op: "approve", subject: "quality", artifactId: id } as MeshOp)).ok, true);
    assert.doesNotMatch(artifactLine(m, "ui", "design"), /settled by|no seat here can settle/);
  } finally {
    await m.cleanup();
  }
});
