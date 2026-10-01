import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import { makeMesh } from "../helpers";
import type { WorkspacePort } from "../../packages/core/src/ports";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * A merge says what it did about uncommitted changes in the product checkout, and what a refusal over
 * them means.
 *
 * The seventh cronlite run's developer edited `src/index.js` and `test/index.test.js` in the product
 * checkout by absolute path. `git merge` refused to run ("Your local changes to the following files would
 * be overwritten by merge"), six times; the tech-lead read "your changes" as the developer's, asked the
 * pm to "commit your changes", the pm asked the developer, the developer verified its own worktree was
 * clean, and two escalation cards later the operator reset the checkout by hand. The files were in the
 * PRODUCT checkout, which no seat can clear.
 *
 * `GitWorkspace.setAsideProductChanges` (tests/artifact-store/product-set-aside.test.ts) does the
 * setting aside; this is what the merge op tells the seat about it.
 */

const AGENTS = [
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "test.execute"], interests: [] },
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "code.review", "git.merge"], authority: ["implementation.approve"], interests: [] },
];
const COMM = { dev: ["lead"], lead: ["dev"] };

interface Options {
  aside?: { files: string[]; ref: string } | null | "throws" | "absent";
  mergeError?: string;
}

const turnFor = (agentId: string) =>
  ({ turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`, agentId, reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] }) as never;

async function mergeableMesh(options: Options) {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked", persist: true, criteria: [{ id: "implementation-merged", description: "merged", mandatory: true }] } as never);
  const calls: string[] = [];
  const unused = (name: string) => async (): Promise<never> => {
    throw new Error(`workspace double: ${name} is not part of this fixture`);
  };
  const workspace: WorkspacePort = {
    mainPath: "/srv/mesh/workspace/main",
    ensureRepo: unused("ensureRepo"),
    ensureWorktree: unused("ensureWorktree"),
    commitWorktree: unused("commitWorktree"),
    async mergeWorktree() {
      calls.push("mergeWorktree");
      if (options.mergeError) throw new Error(options.mergeError);
      return { commit: "0123456789abcdef0123456789abcdef01234567" };
    },
    removeWorktree: unused("removeWorktree"),
    async worktreeState() {
      return null;
    },
    ...(options.aside === "absent"
      ? {}
      : {
          async setAsideProductChanges() {
            calls.push("setAsideProductChanges");
            const aside = options.aside;
            if (aside === "throws") throw new Error("git stash create failed");
            return typeof aside === "object" ? aside : null;
          },
        }),
  };
  (m.supervisor as unknown as { deps: { workspace?: WorkspacePort } }).deps.workspace = workspace;

  const op = (as: string, o: Record<string, unknown>) => m.supervisor.executeOp(as, o as unknown as MeshOp, turnFor(as));
  const created = await m.supervisor.createArtifact({ actorId: "dev", name: "fix", type: "CodePatch", content: "the fix, at length" });
  if (!("artifact" in created)) throw new Error("create failed");
  const id = created.artifact.id;
  assert.equal((await m.supervisor.transitionArtifact("dev", id, { to: "READY_FOR_REVIEW" })).ok, true);
  await op("dev", { op: "request_review", artifactId: id, reviewers: ["lead"] });
  assert.equal((await op("lead", { op: "approve", subject: "implementation", artifactId: id })).ok, true);
  assert.equal((await m.supervisor.transitionArtifact("lead", id, { to: "VERIFIED" })).ok, true);
  assert.equal((await m.supervisor.transitionArtifact("lead", id, { to: "MERGEABLE" })).ok, true);
  const auditFile = (m.supervisor as unknown as { deps: { auditFile?: string } }).deps.auditFile!;
  const audit = () => (fs.existsSync(auditFile) ? fs.readFileSync(auditFile, "utf8") : "").split("\n").filter((l) => /^\S+ merge of 'fix': /.test(l));
  return { m, id, calls, audit, merge: () => op("lead", { op: "merge", artifactId: id }), status: () => m.kernel.state.artifacts.get(id)?.status };
}

const NOTE = /the product checkout held uncommitted changes to src\/index\.js, test\/index\.test\.js: written there directly, so on no branch and seen by no reviewer\. They are saved as refs\/mesh\/product-set-aside\/2026-10-01T17-02-47-000Z \(git show refs\/mesh\/product-set-aside\/2026-10-01T17-02-47-000Z:<path>\) and the merge ran on a clean checkout\. Edit and commit in your own worktree, never in the product checkout/;

const ASIDE = { files: ["src/index.js", "test/index.test.js"], ref: "refs/mesh/product-set-aside/2026-10-01T17-02-47-000Z" };

test("what was set aside is said to the merger, in a note on the landing", async () => {
  const f = await mergeableMesh({ aside: ASIDE });
  try {
    const res = await f.merge();
    assert.equal(res.ok, true, res.reason);
    assert.equal(res.caveat, true, "the merge is a data op: an unflagged reason would reach the seat as a bare product, not a warning");
    assert.match(res.reason ?? "", /^merged as 0123456789ab — the product checkout held/);
    assert.match(res.reason ?? "", NOTE);
    assert.equal(f.status(), "MERGED");
    assert.deepEqual(f.calls, ["setAsideProductChanges", "mergeWorktree"], "set aside BEFORE git is asked to merge");
    const audit = f.audit();
    assert.equal(audit.length, 1, "the operator reads it in the audit log too, once");
    assert.match(audit[0]!, NOTE);
  } finally {
    await f.m.cleanup();
  }
});

test("nothing set aside, or a workspace that cannot say: the landing reads as it always did", async () => {
  for (const aside of [null, "absent"] as const) {
    const f = await mergeableMesh({ aside });
    try {
      const res = await f.merge();
      assert.equal(res.ok, true, res.reason);
      assert.equal(res.reason, "merged as 0123456789ab");
      assert.equal(res.caveat, undefined);
      assert.deepEqual(f.audit(), [], "and nothing to audit");
    } finally {
      await f.m.cleanup();
    }
  }
});

test("more than five files are listed five and then an ellipsis", async () => {
  const files = ["a.js", "b.js", "c.js", "d.js", "e.js", "f.js", "g.js"];
  const f = await mergeableMesh({ aside: { files, ref: "refs/mesh/product-set-aside/x" } });
  try {
    const res = await f.merge();
    assert.match(res.reason ?? "", /uncommitted changes to a\.js, b\.js, c\.js, d\.js, e\.js, …: written there directly/);
    assert.doesNotMatch(res.reason ?? "", /f\.js/);
  } finally {
    await f.m.cleanup();
  }
});

test("a set-aside that itself fails does not stop the merge, and says nothing it cannot back", async () => {
  const f = await mergeableMesh({ aside: "throws" });
  try {
    const res = await f.merge();
    assert.equal(res.ok, true, res.reason);
    assert.equal(res.reason, "merged as 0123456789ab");
    assert.deepEqual(f.calls, ["setAsideProductChanges", "mergeWorktree"]);
    const audit = f.audit();
    assert.equal(audit.length, 1);
    assert.match(audit[0]!, /could not set aside uncommitted changes in the product checkout: git stash create failed/, "the operator can see that the clean-up was tried and failed");
  } finally {
    await f.m.cleanup();
  }
});

test("a refusal over files that would be overwritten says they are in the PRODUCT checkout, which no seat can clear", async () => {
  const gitSays =
    "Command failed: git merge --no-ff --no-edit -m land abc\nerror: Your local changes to the following files would be overwritten by merge:\n\tsrc/index.js\n\ttest/index.test.js\nPlease commit your changes or stash them before you merge.\nAborting";
  const f = await mergeableMesh({ aside: null, mergeError: gitSays });
  try {
    const res = await f.merge();
    assert.equal(res.ok, false);
    assert.match(res.reason ?? "", /would be overwritten by merge/, "git's own words are still there");
    assert.match(res.reason ?? "", /those files are in the PRODUCT checkout \(\/srv\/mesh\/workspace\/main\), not in any seat's worktree: something wrote there directly\. No seat can clear it \(the merger has no write tool, and the owner of the files sees a clean worktree of its own\); the operator can: git -C \/srv\/mesh\/workspace\/main status/);
    assert.match(res.reason ?? "", /nothing landed on the product branch, the patch stays MERGEABLE/);
    assert.equal(f.status(), "MERGEABLE");
  } finally {
    await f.m.cleanup();
  }
});

test("the same hint for untracked files in the way, and for a checkout", async () => {
  for (const git of ["error: The following untracked working tree files would be overwritten by merge:\n\tbin/cronlite.js", "error: Your local changes to the following files would be overwritten by checkout:\n\tx.js"]) {
    const f = await mergeableMesh({ aside: null, mergeError: `Command failed: git merge x\n${git}` });
    try {
      assert.match((await f.merge()).reason ?? "", /in the PRODUCT checkout/);
    } finally {
      await f.m.cleanup();
    }
  }
});

test("any other git failure carries no such hint", async () => {
  const f = await mergeableMesh({ aside: null, mergeError: "Command failed: git merge x\nCONFLICT (content): Merge conflict in shared.txt\nAutomatic merge failed" });
  try {
    const res = await f.merge();
    assert.equal(res.ok, false);
    assert.match(res.reason ?? "", /CONFLICT/);
    assert.doesNotMatch(res.reason ?? "", /PRODUCT checkout/);
  } finally {
    await f.m.cleanup();
  }
});

test("when the checkout was cleaned and the merge still failed, the refusal carries both the note and the failure", async () => {
  const f = await mergeableMesh({ aside: ASIDE, mergeError: "Command failed: git merge x\nCONFLICT (content): Merge conflict in shared.txt" });
  try {
    const res = await f.merge();
    assert.equal(res.ok, false);
    assert.match(res.reason ?? "", /CONFLICT/);
    assert.match(res.reason ?? "", NOTE, "the seat is told what was removed from the checkout even though the merge did not land");
  } finally {
    await f.m.cleanup();
  }
});
