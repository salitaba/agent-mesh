import { test } from "node:test";
import assert from "node:assert/strict";
import { createMcpToolset } from "../../apps/mesh-server/src/mcp";
import { mintSeatToken } from "../../packages/core/src/seat-token";
import { makeMesh } from "../helpers";
import { openRejections } from "../../packages/core/src/projections";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * A new version of an artifact can be named the way a seat names it: by id, by `artifact://` URI, or
 * by its name.
 *
 * `asVersionOf` took the id and nothing else. The sixth cronlite run's developer, reworking the CLI
 * patch a reviewer had rejected, wrote `asVersionOf: "cronlite CLI implementation"` and then
 * `asVersionOf: "artifact://CodePatch/cronlite CLI implementation/3"`, and was told "unknown artifact"
 * twice, with no word of what it could write instead. It published a NEW patch under a new name
 * ("cronlite CLI implementation v4") and left the rejected one behind: two patches for one deliverable,
 * a dangling REJECTED record, and (since the mission now waits on a rejected patch) a tidy-up owed.
 *
 * The id, the URI and the exact name of the type being published all resolve; a name of another type
 * does not. Ownership is checked after, exactly as for an id. When nothing resolves, the refusal says
 * what to write instead and lists the seat's own artifacts of that type.
 */

const AGENTS = [
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write"], interests: [] },
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "code.review"], authority: ["implementation.approve"], interests: [] },
];
const COMM = { dev: ["lead"], lead: ["dev"] };

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

const turnFor = (agentId: string) =>
  ({ turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`, agentId, reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] }) as never;
const op = (m: Mesh, as: string, o: Record<string, unknown>) => m.supervisor.executeOp(as, o as unknown as MeshOp, turnFor(as));
const publish = (m: Mesh, as: string, o: Record<string, unknown>) => op(m, as, { op: "publish_artifact", ...o });
const version = (m: Mesh, id: string) => m.kernel.state.artifacts.get(id)?.version;

async function withPatch(name = "cli", type = "CodePatch"): Promise<{ m: Mesh; id: string }> {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" } as never);
  const first = await publish(m, "dev", { name, type, content: `${name}: the first version, at length` });
  assert.equal(first.ok, true, first.reason);
  return { m, id: String((first as { artifactId?: string }).artifactId) };
}

test("the id still works, and is the one every other form resolves to", async () => {
  const { m, id } = await withPatch();
  try {
    const res = await publish(m, "dev", { name: "cli", type: "CodePatch", content: "the second version", asVersionOf: id });
    assert.equal(res.ok, true, res.reason);
    assert.equal((res as { artifactId?: string }).artifactId, id);
    assert.equal(version(m, id), 2);
  } finally {
    await m.cleanup();
  }
});

test("the artifact's name, of the type being published, names its predecessor", async () => {
  const { m, id } = await withPatch("cronlite CLI implementation");
  try {
    const res = await publish(m, "dev", { name: "cronlite CLI implementation", type: "CodePatch", content: "the second version", asVersionOf: "cronlite CLI implementation" });
    assert.equal(res.ok, true, res.reason);
    assert.equal((res as { artifactId?: string }).artifactId, id, "a new version of the same artifact, not a second patch");
    assert.equal(version(m, id), 2);
  } finally {
    await m.cleanup();
  }
});

test("an artifact:// URI names it too: as written, encoded, and with a version that has moved on", async () => {
  const { m, id } = await withPatch("cronlite CLI implementation");
  try {
    const forms = [
      "artifact://CodePatch/cronlite CLI implementation/1",
      "artifact://CodePatch/cronlite%20CLI%20implementation/2",
      "artifact://CodePatch/cronlite%20CLI%20implementation",
      "artifact://CodePatch/cronlite CLI implementation/1",
    ];
    for (const [i, form] of forms.entries()) {
      const res = await publish(m, "dev", { name: "cronlite CLI implementation", type: "CodePatch", content: `version ${i + 2}`, asVersionOf: form });
      assert.equal(res.ok, true, `${form}: ${res.reason}`);
      assert.equal((res as { artifactId?: string }).artifactId, id, form);
    }
    assert.equal(version(m, id), 5);
  } finally {
    await m.cleanup();
  }
});

test("a name that belongs to an artifact of another type resolves to nothing, and the refusal says what to write", async () => {
  const { m, id } = await withPatch("cli");
  try {
    const report = await publish(m, "dev", { name: "report", type: "TestReport", content: "the report" });
    assert.equal(report.ok, true, report.reason);
    const res = await publish(m, "dev", { name: "report", type: "CodePatch", content: "not a version of the report", asVersionOf: "report" });
    assert.equal(res.ok, false, "a TestReport is not a CodePatch's predecessor");
    assert.match(res.reason ?? "", /^unknown artifact report — name the artifact you are versioning by its id \(art-…\), its artifact:\/\/ URI or its exact name; yours of type CodePatch: /);
    assert.ok((res.reason ?? "").includes(`${id} (cli v1, DRAFT)`), res.reason);
    assert.doesNotMatch(res.reason ?? "", /report v1/, "the list is of the type being published");
    const viaUri = await publish(m, "dev", { name: "report", type: "CodePatch", content: "nor by its URI", asVersionOf: "artifact://TestReport/report/1" });
    assert.equal(viaUri.ok, false, "and a URI of another type is not a predecessor either");
    assert.match(viaUri.reason ?? "", /^unknown artifact artifact:\/\/TestReport\/report\/1 — name the artifact you are versioning by its id/);
  } finally {
    await m.cleanup();
  }
});

test("nothing of the type to list: the refusal still says what to write", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" } as never);
  try {
    const res = await publish(m, "dev", { name: "cli", type: "CodePatch", content: "x", asVersionOf: "art-nope" });
    assert.equal(res.ok, false);
    assert.match(res.reason ?? "", /^unknown artifact art-nope — name the artifact you are versioning by its id \(art-…\), its artifact:\/\/ URI or its exact name; you own no CodePatch yet/);
  } finally {
    await m.cleanup();
  }
});

test("naming it by name does not skip the ownership rule: another seat is refused, as with the id", async () => {
  const { m, id } = await withPatch("cli");
  try {
    for (const ref of ["cli", id, "artifact://CodePatch/cli/1"]) {
      const res = await publish(m, "lead", { name: "cli", type: "CodePatch", content: "the lead's rewrite", asVersionOf: ref });
      assert.equal(res.ok, false, ref);
      assert.match(res.reason ?? "", /single-writer: current owner is dev|ownership denied/, ref);
    }
    assert.equal(version(m, id), 1, "nothing was written");
  } finally {
    await m.cleanup();
  }
});

test("edits against a predecessor named by name apply to it", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" } as never);
  try {
    const first = await publish(m, "dev", { name: "cli", type: "CodePatch", content: "alpha beta gamma" });
    const id = String((first as { artifactId?: string }).artifactId);
    const res = await publish(m, "dev", { name: "cli", type: "CodePatch", edits: [{ old: "beta", new: "delta" }], asVersionOf: "cli" });
    assert.equal(res.ok, true, res.reason);
    assert.equal((res as { artifactId?: string }).artifactId, id);
    const body = await m.supervisor.deps.content.read(m.kernel.state.artifacts.get(id)!.contentRef);
    assert.equal(body, "alpha delta gamma");
  } finally {
    await m.cleanup();
  }
});

test("the rework of a rejected patch by name is a new version of THAT patch, which still holds the mission until it lands", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked", criteria: [{ id: "implementation-merged", description: "merged", mandatory: true }] } as never);
  try {
    const first = await publish(m, "dev", { name: "cli", type: "CodePatch", content: "the first version" });
    const id = String((first as { artifactId?: string }).artifactId);
    assert.equal((await m.supervisor.transitionArtifact("dev", id, { to: "READY_FOR_REVIEW" })).ok, true);
    await op(m, "dev", { op: "request_review", artifactId: id, reviewers: ["lead"] });
    assert.equal((await op(m, "lead", { op: "reject", subject: "implementation", artifactId: id, comment: "rework it" })).ok, true);
    assert.equal(m.kernel.state.artifacts.get(id)?.status, "REJECTED");

    const reworked = await publish(m, "dev", { name: "cli", type: "CodePatch", content: "the reworked version", asVersionOf: "cli" });
    assert.equal(reworked.ok, true, reworked.reason);
    assert.equal((reworked as { artifactId?: string }).artifactId, id, "not a second patch: nothing is left REJECTED beside it");
    assert.equal(m.kernel.state.artifacts.get(id)?.status, "DRAFT");
    assert.equal(version(m, id), 2);
    assert.deepEqual(openRejections(m.kernel.state, m.kernel.state.activeGoalId ?? "").map((a) => a.id), [id], "it was rejected, and has not landed");
  } finally {
    await m.cleanup();
  }
});

test("a draft this turn published, republished by name in the same turn, is amended in place, as it is by id", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" } as never);
  try {
    const turn = turnFor("dev");
    const first = await m.supervisor.executeOp("dev", { op: "publish_artifact", name: "cli", type: "CodePatch", content: "first draft" } as unknown as MeshOp, turn);
    const id = String((first as { artifactId?: string }).artifactId);
    const again = await m.supervisor.executeOp("dev", { op: "publish_artifact", name: "cli", type: "CodePatch", content: "corrected draft", asVersionOf: "cli" } as unknown as MeshOp, turn);
    assert.equal(again.ok, true, again.reason);
    assert.equal(version(m, id), 1, "still v1: an unreviewed draft this turn made is rewritten, not versioned");
    assert.match(again.reason ?? "", /amended v1 in place/);
  } finally {
    await m.cleanup();
  }
});

test("the refusal lists only the seat's own artifacts of the type, five at most", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" } as never);
  try {
    const others = await publish(m, "lead", { name: "lead-patch", type: "CodePatch", content: "the lead's own" });
    assert.equal(others.ok, true, others.reason);
    const none = await publish(m, "dev", { name: "x", type: "CodePatch", content: "x", asVersionOf: "nope" });
    assert.match(none.reason ?? "", /you own no CodePatch yet$/, "another seat's patch is not the seat's to version");
    assert.doesNotMatch(none.reason ?? "", /lead-patch/);

    const ids: string[] = [];
    for (let i = 1; i <= 7; i++) {
      const made = await publish(m, "dev", { name: `patch-${i}`, type: "CodePatch", content: `body ${i}` });
      ids.push(String((made as { artifactId?: string }).artifactId));
    }
    const many = await publish(m, "dev", { name: "x", type: "CodePatch", content: "x", asVersionOf: "nope" });
    const listed = ids.filter((id) => (many.reason ?? "").includes(id));
    assert.equal(listed.length, 5, "five are named");
    assert.match(many.reason ?? "", /; …$/, "and the rest are said to exist");
  } finally {
    await m.cleanup();
  }
});

test("createArtifact resolves the predecessor the same way for a caller that is not a seat's op", async () => {
  const { m, id } = await withPatch("cronlite CLI implementation");
  try {
    for (const ref of ["cronlite CLI implementation", "artifact://CodePatch/cronlite CLI implementation/1"]) {
      const res = await m.supervisor.createArtifact({ actorId: "dev", name: "cronlite CLI implementation", type: "CodePatch", content: `via ${ref}`, asVersionOf: ref });
      assert.ok("artifact" in res, `${ref}: ${JSON.stringify(res)}`);
      assert.equal(res.artifact.id, id);
    }
    const none = await m.supervisor.createArtifact({ actorId: "dev", name: "x", type: "CodePatch", content: "x", asVersionOf: "nope" });
    assert.ok("error" in none && /^unknown artifact nope — name the artifact you are versioning by its id/.test(none.error), JSON.stringify(none));
  } finally {
    await m.cleanup();
  }
});

test("the tool says what asVersionOf takes, and to version a rejected patch rather than publish a new name", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" } as never);
  try {
    const mcp = createMcpToolset(m.supervisor);
    const token = mintSeatToken(m.config.meshId, "dev", m.kernel.state.activeGoalId);
    const res = (await mcp.handle("dev", token, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })) as {
      result: { tools: Array<{ name: string; inputSchema: { properties: Record<string, { description?: string }> } }> };
    };
    const publishTool = res.result.tools.find((t) => t.name === "mesh_artifact_publish");
    const text = publishTool?.inputSchema.properties.asVersionOf?.description ?? "";
    assert.match(text, /its id \(art-…\), its artifact:\/\/ URI or its exact name \(you must be its owner\)/);
    assert.match(text, /To rework a patch a reviewer rejected, version IT: a new name leaves the rejected one open beside the copy/);
  } finally {
    await m.cleanup();
  }
});
