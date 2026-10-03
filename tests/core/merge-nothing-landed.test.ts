import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { makeMesh } from "../helpers";
import { FakeWorkspace, installWorkspace, untrackedState } from "../support/fake-workspace";
import type { WorktreeState } from "../../packages/core/src/ports";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * The refusals of a merge that moved nothing, and the one case it is not a refusal.
 *
 * Without git (a double that answers `alreadyUpToDate`), so what is pinned is the decision and the words, in every branch of it:
 * the commit it records has an empty diff; it records none and nobody can say what its owner holds; its owner holds
 * uncommitted files; its owner holds nothing and the product has what the patch lists. The same decision against real git is
 * `tests/integration/merge-second-patch-same-branch.test.ts`.
 */

const AGENTS = [
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "git.commit"], interests: [] },
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "code.review", "git.merge"], authority: ["implementation.approve"], interests: [] },
];
const COMM = { dev: ["lead"], lead: ["dev"] };
const CRITERIA = [{ id: "implementation-merged", description: "the patch landed", mandatory: true }];
const EMPTY_DIFF_DIGEST = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const SHA = "c589751c589751c589751c589751c589751c589751";

const turnFor = (agentId: string) =>
  ({ turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`, agentId, reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] }) as never;

const CLEAN: WorktreeState = { agentId: "dev", dirty: [], untracked: 0, unmergedCommits: [] };

/** A patch with `content` and `metadata`, walked to MERGEABLE over a workspace whose merge moved nothing. */
async function mergeable(opts: { content: string; metadata?: Record<string, unknown>; state?: WorktreeState | null; productFiles?: Record<string, string> }) {
  const mainPath = fs.mkdtempSync(path.join(os.tmpdir(), "curule-product-"));
  for (const [file, body] of Object.entries(opts.productFiles ?? {})) {
    fs.mkdirSync(path.dirname(path.join(mainPath, file)), { recursive: true });
    fs.writeFileSync(path.join(mainPath, file), body, "utf8");
  }
  const ws = new FakeWorkspace({ mainPath, behaviour: { merge: "alreadyUpToDate", worktreeState: opts.state ? { dev: opts.state } : {} } });
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked", criteria: CRITERIA } as never);
  installWorkspace(m, ws);
  const created = await m.supervisor.createArtifact({ actorId: "dev", name: "cli", type: "CodePatch", content: opts.content, ...(opts.metadata ? { metadata: opts.metadata } : {}) });
  if (!("artifact" in created)) throw new Error(`create failed: ${JSON.stringify(created)}`);
  const id = created.artifact.id;
  await m.supervisor.transitionArtifact("dev", id, { to: "READY_FOR_REVIEW" });
  await m.supervisor.executeOp("lead", { op: "approve", subject: "implementation", artifactId: id } as MeshOp, turnFor("lead"));
  await m.supervisor.transitionArtifact("lead", id, { to: "VERIFIED" });
  await m.supervisor.transitionArtifact("lead", id, { to: "MERGEABLE" });
  assert.equal(m.kernel.state.artifacts.get(id)?.status, "MERGEABLE", "fixture: staged at the gate");
  const cleanup = async () => {
    await m.cleanup();
    fs.rmSync(mainPath, { recursive: true, force: true });
  };
  return { m, id, cleanup, ws };
}

const merge = (m: Awaited<ReturnType<typeof mergeable>>["m"], id: string) => m.supervisor.executeOp("lead", { op: "merge", artifactId: id } as MeshOp, turnFor("lead"));

test("a recorded commit with an empty diff is refused as it always was, whatever the product holds", async () => {
  const { m, id, cleanup } = await mergeable({
    content: "## File: bin/cli.js\nconsole.log(1);\n",
    metadata: { commit: SHA, diffDigest: EMPTY_DIFF_DIGEST },
    state: CLEAN,
    productFiles: { "bin/cli.js": "console.log(1);\n" },
  });
  try {
    const res = await merge(m, id);
    assert.equal(res.ok, false, "the sha is main's own: being there says nothing about the patch");
    assert.match(String(res.reason), /and the commit it records has an empty diff, so none of this patch's work is on the product branch\. dev must `mesh_commit` the patch's files\./);
    assert.equal(m.kernel.state.artifacts.get(id)?.status, "MERGEABLE");
  } finally {
    await cleanup();
  }
});

test("nobody can say what the owner holds: the refusal stands in its old words", async () => {
  // `worktreeState` answers null, as it does for a seat with no worktree: "the work is committed" was not established.
  const { m, id, cleanup } = await mergeable({ content: "## File: bin/cli.js\nconsole.log(1);\n", productFiles: { "bin/cli.js": "console.log(1);\n" } });
  try {
    const res = await merge(m, id);
    assert.equal(res.ok, false);
    assert.match(String(res.reason), /and the patch records no commit, so its work was never committed: files dev wrote but did not commit are on no branch\. dev must `mesh_commit` the patch's files\./);
    assert.match(String(res.reason), /This version stays MERGEABLE, and implementation-merged stays UNEVIDENCED$/);
  } finally {
    await cleanup();
  }
});

test("uncommitted files in the owner's worktree: named, and committing them is still the remedy (more than five are counted, not all named)", async () => {
  const files = ["a.js", "b.js", "c.js", "d.js", "e.js", "f.js", "g.js"];
  const { m, id, cleanup } = await mergeable({
    content: "## File: bin/cli.js\nconsole.log(1);\n",
    state: untrackedState("dev", files),
    productFiles: { "bin/cli.js": "console.log(1);\n" },
  });
  try {
    const res = await merge(m, id);
    assert.equal(res.ok, false, "even though the file the patch lists is in the product: the owner has work that is on no branch");
    assert.match(String(res.reason), /dev has 7 uncommitted file\(s\) in its worktree \(a\.js, b\.js, c\.js, d\.js, e\.js, \+2 more\): written and never committed, they are on no branch\. dev must `mesh_commit`/);
  } finally {
    await cleanup();
  }
});

test("nothing uncommitted and every listed file in the product as published: the patch is merged, already there", async () => {
  const body = "console.log(1);\nconsole.log(2);\n";
  const { m, id, cleanup } = await mergeable({ content: `## File: bin/cli.js\n${body}`, state: CLEAN, productFiles: { "bin/cli.js": body } });
  try {
    const res = await merge(m, id);
    assert.equal(res.ok, true, res.reason);
    assert.match(String(res.reason), /^already in the product as [0-9a-f]{12} \(landed by an earlier merge: dev's branch holds nothing the product lacks, and the file this patch lists \(bin\/cli\.js\) is there as published\)$/);
    assert.equal(m.kernel.state.artifacts.get(id)?.status, "MERGED");
  } finally {
    await cleanup();
  }
});

test("line endings and trailing blank lines are not a difference; a changed line is", async () => {
  // The file in the product was written with CRLF and a blank line at the end; the patch lists the same lines.
  const crlf = await mergeable({ content: "## File: notes.txt\nline one\nline two\n", state: CLEAN, productFiles: { "notes.txt": "line one\r\nline two\r\n\r\n" } });
  try {
    assert.equal((await merge(crlf.m, crlf.id)).ok, true, "the same lines, written differently");
  } finally {
    await crlf.cleanup();
  }
  const changed = await mergeable({ content: "## File: notes.txt\nline one\nline two\n", state: CLEAN, productFiles: { "notes.txt": "line one\nline 2\n" } });
  try {
    const res = await merge(changed.m, changed.id);
    assert.equal(res.ok, false);
    assert.match(String(res.reason), /yet notes\.txt is in the product but not as the patch lists it\./);
  } finally {
    await changed.cleanup();
  }
});

test("every file the patch lists is looked for, not only the first", async () => {
  const body = "console.log(1);\n";
  const { m, id, cleanup } = await mergeable({
    content: `## File: bin/cli.js\n${body}\n## File: docs/guide.md\nthe guide\n\n## File: src/lib.js\nexport const a = 1;\n`,
    state: CLEAN,
    productFiles: { "bin/cli.js": body, "src/lib.js": "export const a = 2;\n" },
  });
  try {
    const res = await merge(m, id);
    assert.equal(res.ok, false, "the first file is there as published; the second is not, and the third is not as published");
    assert.match(String(res.reason), /yet docs\/guide\.md is not in the product, and src\/lib\.js is in the product but not as the patch lists it\./);
  } finally {
    await cleanup();
  }
});

test("a patch body that cannot be read says nothing about what landed: the refusal stands", async () => {
  const { m, id, cleanup } = await mergeable({ content: "## File: bin/cli.js\nconsole.log(1);\n", state: CLEAN, productFiles: { "bin/cli.js": "console.log(1);\n" } });
  try {
    (m.supervisor.deps as unknown as { content: { read: () => Promise<string> } }).content.read = async () => {
      throw new Error("the artifact store lost the body");
    };
    const res = await merge(m, id);
    assert.equal(res.ok, false);
    assert.match(String(res.reason), /so its work was never committed/);
  } finally {
    await cleanup();
  }
});

test("a path that leaves the product directory is not looked for, and the patch is refused", async () => {
  // A `## File:` heading with `..` in it is not read as a file at all; `metadata.path` is the way in.
  const { m, id, cleanup } = await mergeable({ content: "x\n", metadata: { path: "../outside.js" }, state: CLEAN });
  try {
    const res = await merge(m, id);
    assert.equal(res.ok, false);
    assert.match(String(res.reason), /yet \.\.\/outside\.js is not in the product/);
  } finally {
    await cleanup();
  }
});
