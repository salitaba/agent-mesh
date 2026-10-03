import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { FakeWorkspace, installWorkspace } from "../support/fake-workspace";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * A commit announces what it changed, not what the branch has accumulated.
 *
 * `mesh_commit` classifies the diff of the commit into `dependency.changed`, `authentication.changed` and `authorization.changed`,
 * which wake the seats interested in them (an architect's, in the cronlite mesh). That diff is the cumulative `main...HEAD` diff of the
 * seat's branch, so a file an earlier commit touched is in it again, unchanged, for every commit after: a manifest created once
 * announced a dependency change at every later commit. The fifteenth cronlite run woke its architect at both of the developer's commits
 * (04:52:42 and 04:54:38) for the same `package.json` hunk, 7.1k and 9.6k tokens, and the second began a chain of status mail (the
 * architect's question, the developer's answer, the architect's unrequested review: 47k in all). Runs 8 to 13 and 15 woke the
 * architect once or twice each, for a project that has no dependency at all.
 *
 * With the diff of the version a commit replaces in hand, only the file sections the commit added or changed are read.
 */

const AGENTS = [
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "git.commit"], interests: [] },
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "code.review", "git.merge"], authority: ["implementation.approve"], interests: [] },
];
const COMM = { dev: ["lead"], lead: ["dev"] };

const section = (file: string, ...added: string[]): string => `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${added.length} @@\n${added.map((l) => `+${l}`).join("\n")}\n`;
const PKG = section("package.json", "{", '  "name": "cronlite"', "}");
const PKG_WITH_DEP = section("package.json", "{", '  "name": "cronlite",', '  "dependencies": { "left-pad": "^1.0.0" }', "}");
const SRC = section("src/index.js", "export const parse = () => 1;");
const LOGIN = section("src/session.js", "export const login = () => 1;");

type Mesh = Awaited<ReturnType<typeof makeMesh>>;
const pure = (m: Mesh) => m.supervisor as unknown as { changeEventsFromDiff(diff: string, previous?: string): string[] };

test("a manifest in both diffs, unchanged, is not news; a manifest that changed, or is new, is", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" } as never);
  try {
    const sup = pure(m);
    assert.deepEqual(sup.changeEventsFromDiff(PKG), ["dependency.changed"], "no previous version: everything is new");
    assert.deepEqual(sup.changeEventsFromDiff(PKG + SRC, PKG), [], "the second commit added a source file and left the manifest alone");
    assert.deepEqual(sup.changeEventsFromDiff(PKG_WITH_DEP + SRC, PKG + SRC), ["dependency.changed"], "a manifest whose section changed is announced again");
    assert.deepEqual(sup.changeEventsFromDiff(SRC + PKG, PKG), [], "section order is not a change");
    assert.deepEqual(sup.changeEventsFromDiff(PKG, PKG), [], "a commit that changed nothing announces nothing");
  } finally {
    await m.cleanup();
  }
});

test("each kind is judged on the sections that are new: a login file stays quiet after its own commit", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" } as never);
  try {
    const sup = pure(m);
    assert.deepEqual(sup.changeEventsFromDiff(LOGIN), ["authentication.changed"]);
    assert.deepEqual(sup.changeEventsFromDiff(LOGIN + SRC, LOGIN), [], "the login file did not change in this commit");
    assert.deepEqual(sup.changeEventsFromDiff(LOGIN + PKG, LOGIN), ["dependency.changed"], "the new manifest is announced; the login file is not, again");
  } finally {
    await m.cleanup();
  }
});

test("a previous version that is prose, not a diff, hides nothing", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" } as never);
  try {
    assert.deepEqual(pure(m).changeEventsFromDiff(PKG, "## File: package.json\n{ }\n"), ["dependency.changed"]);
    assert.deepEqual(pure(m).changeEventsFromDiff(PKG, ""), ["dependency.changed"], "nor does an empty one");
    assert.deepEqual(pure(m).changeEventsFromDiff(SRC + PKG, ""), ["dependency.changed"], "every new section is read, not only the first");
  } finally {
    await m.cleanup();
  }
});

test("through mesh_commit: the second commit of a branch does not announce the first one's manifest again", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" } as never);
  try {
    const diffs = [PKG, PKG + SRC, PKG_WITH_DEP + SRC];
    let n = 0;
    installWorkspace(
      m,
      new FakeWorkspace({
        behaviour: { commit: async () => ({ commit: `c${String(++n).padStart(12, "0")}`, diffDigest: `sha256:d${n}`, diff: diffs[n - 1]! }) },
      }),
    );
    const created = await m.supervisor.createArtifact({ actorId: "dev", name: "lib", type: "CodePatch", content: "## File: package.json\n{}\n" });
    if (!("artifact" in created)) throw new Error("create failed");
    const id = created.artifact.id;
    const turn = { turnId: "t-dev", agentId: "dev", reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] } as never;
    const leased = await m.supervisor.executeOp("dev", { op: "acquire_lease", artifactId: id, files: ["package.json"] } as MeshOp, turn);
    assert.equal(leased.ok, true, leased.reason);
    const announced: number[] = [];
    for (let i = 1; i <= 3; i++) {
      const before = (await m.store.read()).filter((e) => e.type === "dependency.changed").length;
      const res = await m.supervisor.executeOp("dev", { op: "commit", artifactId: id, message: `commit ${i}` } as MeshOp, turn);
      assert.equal(res.ok, true, `commit ${i}: ${res.reason}`);
      announced.push((await m.store.read()).filter((e) => e.type === "dependency.changed").length - before);
    }
    assert.deepEqual(announced, [1, 0, 1], "announced by the commit that created the manifest, silent for the one that did not touch it, announced by the one that added a dependency");
  } finally {
    await m.cleanup();
  }
});

test("through mesh_commit: a previous version whose content cannot be read announces as it always did", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" } as never);
  try {
    installWorkspace(m, new FakeWorkspace({ behaviour: { commit: async () => ({ commit: "c00000000001", diffDigest: "sha256:d1", diff: PKG }) } }));
    const created = await m.supervisor.createArtifact({ actorId: "dev", name: "lib", type: "CodePatch", content: "## File: package.json\n{}\n" });
    if (!("artifact" in created)) throw new Error("create failed");
    const id = created.artifact.id;
    const turn = { turnId: "t-dev", agentId: "dev", reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] } as never;
    assert.equal((await m.supervisor.executeOp("dev", { op: "acquire_lease", artifactId: id, files: ["package.json"] } as MeshOp, turn)).ok, true);
    const content = (m.supervisor.deps as unknown as { content: { read: (ref: unknown) => Promise<string> } }).content;
    const read = content.read.bind(content);
    let failed = 0;
    content.read = async (ref: unknown) => {
      failed++;
      throw new Error("the artifact store lost the body");
    };
    const res = await m.supervisor.executeOp("dev", { op: "commit", artifactId: id, message: "first" } as MeshOp, turn);
    content.read = read;
    assert.equal(res.ok, true, res.reason);
    assert.ok(failed > 0, "fixture: the previous version was asked for");
    assert.equal((await m.store.read()).filter((e) => e.type === "dependency.changed").length, 1, "what cannot be compared is announced, not hidden");
  } finally {
    await m.cleanup();
  }
});
