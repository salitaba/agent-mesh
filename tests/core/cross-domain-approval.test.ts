import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, goalOf, evidenceContent } from "../helpers";
import { artifactUri } from "../../packages/protocol/src/index";
import type { ArtifactType, MeshOp } from "../../packages/protocol/src/index";

/**
 * An approval signed as `architecture` on an artifact that is not an architecture artifact approves that artifact, and nothing else.
 *
 * The tenth cronlite run (2026-10-02). The architect and the pm each asked the tech lead for a review within sixteen seconds
 * (the ArchitectureDocument, then the RequirementsDoc). The tech lead wrote "Architecture is sound and complete", signed it as
 * `architecture`, and named the RequirementsDoc's id. The verdict moved the RequirementsDoc, which is what a verdict on it does,
 * and then the mesh treated it as the architecture's approval too: `architecture.approved` fired, `architecture-approved` closed
 * with the RequirementsDoc as its evidence, the architect told the others the architecture was approved, the developer was
 * woken for it, and the closing report listed the wrong document. The ArchitectureDocument itself sat UNDER_REVIEW for 2 min 49 s,
 * until the tech lead's next turn approved it. The tech lead had no way to know: the reply said `ok`.
 *
 * Now the derived approval and the criterion follow the artifact (a subject-level sign-off with no artifact still counts),
 * and a verdict signed in one capacity on an artifact of another domain is answered, when a review in the capacity it signed in
 * is still owed to the seat, with the name of that review.
 */

const ARCHITECT = { id: "architect", role: "architect", capabilities: ["repository.read", "architecture.write", "review.design"], authority: ["architecture.approve"], interests: [] };
const PM = { id: "pm", role: "product-manager", capabilities: ["repository.read"], authority: ["requirements.accept"], interests: [] };
const LEAD = {
  id: "tech-lead",
  role: "tech-lead",
  capabilities: ["repository.read", "architecture.read", "code.review", "review.design", "task.assign", "git.merge"],
  authority: ["implementation.approve", "architecture.approve"],
  interests: [],
};
const LEAD2 = { ...LEAD, id: "lead-2" };
const DEV = { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "test.execute", "git.commit"], interests: [] };

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

function mesh(extra: Array<Record<string, unknown>> = []): Promise<Mesh> {
  const agents = [ARCHITECT, PM, LEAD, DEV, ...extra];
  const ids = agents.map((a) => a.id as string);
  return makeMesh({
    agents,
    mayContact: Object.fromEntries(ids.map((id) => [id, ids.filter((o) => o !== id)])),
    criteria: [{ id: "architecture-approved", description: "Architecture approved", mandatory: true }],
    mode: "parked",
  } as never);
}

const turnFor = (agentId: string) =>
  ({ turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`, agentId, reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] }) as never;

/** Published, submitted, and asked of `reviewer`: what a seat does before it waits. */
async function asked(m: Mesh, owner: string, name: string, type: ArtifactType, reviewer: string): Promise<string> {
  const created = await m.supervisor.createArtifact({ actorId: owner, name, type, content: evidenceContent(name) });
  if (!("artifact" in created)) throw new Error(`create failed: ${JSON.stringify(created)}`);
  const id = created.artifact.id;
  const moved = await m.supervisor.transitionArtifact(owner, id, { to: "READY_FOR_REVIEW" });
  assert.equal(moved.ok, true, String(moved.reason));
  const ask = await m.supervisor.executeOp(owner, { op: "request_review", artifactId: id, reviewers: [reviewer] } as MeshOp, turnFor(owner));
  assert.equal(ask.ok, true, String(ask.reason));
  return id;
}

const criterion = (m: Mesh) => goalOf(m)!.acceptanceCriteria.find((c) => c.id === "architecture-approved")!;
const derived = async (m: Mesh) => (await m.store.read({ types: ["architecture.approved"] })).filter((e) => (e.payload as { derived?: boolean }).derived === true);
const statusOf = (m: Mesh, id: string) => m.kernel.state.artifacts.get(id)?.status;

test("the run-10 slip: an architecture approval that names the RequirementsDoc approves it, not the architecture, and says which review is still open", async () => {
  const m = await mesh();
  try {
    const arch = await asked(m, "architect", "Architecture", "ArchitectureDocument", "tech-lead");
    const reqs = await asked(m, "pm", "Requirements", "RequirementsDoc", "tech-lead");

    const res = await m.supervisor.recordDecision("tech-lead", "approve", "architecture", reqs, "Architecture is sound and complete");
    assert.equal(res.ok, true, res.reason);
    assert.equal(statusOf(m, reqs), "APPROVED", "the verdict is on the document it named, and moves it");
    assert.equal(criterion(m).status, "UNSATISFIED", "but it is not the architecture's approval");
    assert.equal((await derived(m)).length, 0, "and nobody is told the architecture was approved");
    assert.equal(statusOf(m, arch), "UNDER_REVIEW", "the architecture still waits");

    assert.match(res.reason ?? "", /you signed as architecture, but RequirementsDoc "Requirements" is a requirements artifact/);
    assert.ok((res.reason ?? "").includes(`ArchitectureDocument "Architecture" (${arch})`), "the open review is named, with its id");
    assert.match(res.reason ?? "", /Name its id if that is what you meant/);

    // The repair the note points at: the same seat, the right id.
    const right = await m.supervisor.recordDecision("tech-lead", "approve", "architecture", arch, "Architecture is sound and complete");
    assert.equal(right.ok, true, right.reason);
    assert.equal(right.reason, undefined, "nothing to add: it is the architecture");
    assert.equal(statusOf(m, arch), "APPROVED");
    assert.equal(criterion(m).status, "EVIDENCED");
    assert.equal(criterion(m).evidence.at(-1)?.artifactRef?.uri, artifactUri("ArchitectureDocument", "Architecture", 1), "and the evidence is the architecture, not the requirements");
    const events = await derived(m);
    assert.equal(events.length, 1, "one architecture.approved, for the architecture");
    assert.equal((events[0]!.payload as { artifactId?: string }).artifactId, arch);
  } finally {
    await m.cleanup();
  }
});

test("an approval of the architecture itself is unchanged: the criterion closes, the event fires once, nothing is added to the reply", async () => {
  const m = await mesh();
  try {
    const arch = await asked(m, "architect", "Architecture", "ArchitectureDocument", "tech-lead");
    await asked(m, "pm", "Requirements", "RequirementsDoc", "tech-lead");
    const res = await m.supervisor.recordDecision("tech-lead", "approve", "architecture", arch, "sound");
    assert.equal(res.ok, true, res.reason);
    assert.equal(res.reason, undefined, "a review owed in another domain is not what this verdict is about");
    assert.equal(criterion(m).status, "EVIDENCED");
    assert.equal((await derived(m)).length, 1);
  } finally {
    await m.cleanup();
  }
});

test("a subject-level architecture sign-off with no artifact still closes the criterion (the single-agent benchmark's route)", async () => {
  const m = await mesh();
  try {
    const res = await m.supervisor.recordDecision("tech-lead", "approve", "architecture", undefined, "design reviewed in the thread");
    assert.equal(res.ok, true, res.reason);
    assert.equal(criterion(m).status, "EVIDENCED");
    assert.equal(criterion(m).evidence.at(-1)?.artifactRef, undefined);
    assert.equal((await derived(m)).length, 1);
  } finally {
    await m.cleanup();
  }
});

test("a signature in another capacity with nothing owed behind it says nothing, and still closes nothing", async () => {
  const m = await mesh();
  try {
    const reqs = await asked(m, "pm", "Requirements", "RequirementsDoc", "tech-lead");
    const res = await m.supervisor.recordDecision("tech-lead", "approve", "architecture", reqs, "fine");
    assert.equal(res.ok, true, res.reason);
    assert.equal(res.reason, undefined, "no architecture review is waiting, so there is nothing to point at");
    assert.equal(statusOf(m, reqs), "APPROVED");
    assert.equal(criterion(m).status, "UNSATISFIED");
    assert.equal((await derived(m)).length, 0);
  } finally {
    await m.cleanup();
  }
});

test("only a review in the capacity signed in is named: a patch owed in another domain is not", async () => {
  const m = await mesh();
  try {
    const reqs = await asked(m, "pm", "Requirements", "RequirementsDoc", "tech-lead");
    await asked(m, "dev", "Implementation", "CodePatch", "tech-lead");
    const res = await m.supervisor.recordDecision("tech-lead", "approve", "architecture", reqs, "fine");
    assert.equal(res.ok, true, res.reason);
    assert.equal(res.reason, undefined, "the patch is an implementation review, and this was signed as architecture");
  } finally {
    await m.cleanup();
  }
});

test("a review that is somebody else's to give is not named to this seat", async () => {
  const m = await mesh([LEAD2]);
  try {
    await asked(m, "architect", "Architecture", "ArchitectureDocument", "lead-2");
    const reqs = await asked(m, "pm", "Requirements", "RequirementsDoc", "tech-lead");
    const res = await m.supervisor.recordDecision("tech-lead", "approve", "architecture", reqs, "fine");
    assert.equal(res.ok, true, res.reason);
    assert.equal(res.reason, undefined, "the architecture review is lead-2's, not tech-lead's");
  } finally {
    await m.cleanup();
  }
});

test("approving one architecture document while another waits is not a slip", async () => {
  const m = await mesh();
  try {
    const first = await asked(m, "architect", "Architecture", "ArchitectureDocument", "tech-lead");
    await asked(m, "architect", "API", "ApiSpec", "tech-lead");
    const res = await m.supervisor.recordDecision("tech-lead", "approve", "architecture", first, "sound");
    assert.equal(res.ok, true, res.reason);
    assert.equal(res.reason, undefined, "same domain as the verdict: reviewing them one at a time is the normal order");
    assert.equal(criterion(m).status, "EVIDENCED");
  } finally {
    await m.cleanup();
  }
});
