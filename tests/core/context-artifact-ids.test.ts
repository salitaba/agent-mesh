import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { buildAgentContext, renderContextInstructions } from "../../packages/core/src/context";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * The seat briefing names each artifact by the id the tools ask for.
 *
 * It listed the URI, the type and the status, and no id. A tool that acts on an artifact (a verdict, a transition, a review
 * request, a merge) takes `artifactId`, so the seat wrote what it had in front of it: in the eighteenth cronlite run 11 of the 14
 * operations the mesh refused named an artifact by an id the seat had made up (a message id with `art-` in front of it, a URI
 * folded into an id, a real id with the wrong tail, ids that match nothing). Each landed only after the refusal had listed the
 * real ones, and the phantom approval the refusal exists to stop was one slip from being recorded.
 */

const AGENTS = [
  { id: "arch", role: "architect", capabilities: ["repository.read", "repository.write"], authority: ["architecture.approve"], interests: [] },
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "review.design"], authority: ["architecture.approve"], interests: [] },
];
const COMM = { arch: ["lead"], lead: ["arch"] };

const turnFor = (agentId: string) =>
  ({ turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`, agentId, reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] }) as never;

type Mesh = Awaited<ReturnType<typeof makeMesh>>;
const op = (m: Mesh, actor: string, o: MeshOp) => m.supervisor.executeOp(actor, o, turnFor(actor));

const briefing = (m: Mesh, seat: string): string => renderContextInstructions(buildAgentContext({ config: m.config, kernel: m.kernel }, seat));
const artifactLine = (m: Mesh, seat: string, name: string): string => {
  const line = briefing(m, seat).split("\n").find((l) => l.startsWith("- artifact://") && l.includes(`/${name}/`));
  assert.ok(line, `${seat}'s briefing lists ${name}`);
  return line;
};

async function publish(m: Mesh, actor: string, name: string, type: string): Promise<string> {
  const created = await m.supervisor.createArtifact({ actorId: actor, name, type: type as never, content: "the design, at length, with every section filled in" });
  if (!("artifact" in created)) throw new Error("create failed");
  return created.artifact.id;
}

test("every artifact line carries its own id, and no other artifact's", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" });
  try {
    const one = await publish(m, "arch", "core-arch", "ArchitectureDocument");
    const two = await publish(m, "arch", "api-arch", "ArchitectureDocument");
    assert.notEqual(one, two);
    const a = artifactLine(m, "lead", "core-arch");
    const b = artifactLine(m, "lead", "api-arch");
    assert.match(a, new RegExp(`\\(ArchitectureDocument, id ${one}, `), "the id sits on the line, labelled as one");
    assert.match(b, new RegExp(`\\(ArchitectureDocument, id ${two}, `));
    assert.ok(!a.includes(two) && !b.includes(one), "each line names its own artifact only");
  } finally {
    await m.cleanup();
  }
});

test("the id a seat reads on its line is the one a verdict takes", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" });
  try {
    const id = await publish(m, "arch", "core-arch", "ArchitectureDocument");
    const asked = await op(m, "arch", { op: "request_review", artifactId: id, reviewers: ["lead"] } as MeshOp);
    assert.equal(asked.ok, true, String(asked.reason));
    // What the seat does now: read the id off its own briefing and put it in the verdict.
    const onTheLine = /\bid (art-[A-Za-z0-9]+)/.exec(artifactLine(m, "lead", "core-arch"))?.[1];
    assert.equal(onTheLine, id);
    const res = await op(m, "lead", { op: "approve", subject: "architecture", artifactId: onTheLine, comment: "reviewed" } as MeshOp);
    assert.equal(res.ok, true, String(res.reason));
    // And what it did before the line carried one: an id made of the message's own, which names nothing.
    const [message] = [...m.kernel.state.messages.values()].filter((x) => x.type === "REQUEST_REVIEW");
    assert.ok(message, "the review ask is a message in the mailbox, with an id of its own");
    const made = `art-${message!.id.replace(/^msg-/, "")}`;
    const refused = await op(m, "lead", { op: "approve", subject: "architecture", artifactId: made, comment: "reviewed" } as MeshOp);
    assert.equal(refused.ok, false);
    assert.match(String(refused.reason), /unknown artifact/);
  } finally {
    await m.cleanup();
  }
});
