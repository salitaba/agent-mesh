import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import type { WorktreeState } from "../../packages/core/src/ports";
import { FakeWorkspace, installWorkspace } from "../support/fake-workspace";

/**
 * Telling a seat its work is not in the product.
 *
 * A seat writes files with its own editing tools. They land in its worktree and
 * stay there: only the `commit` op stages anything, and publishing a CodePatch
 * writes the artifact store rather than the repository. Nothing used to say so —
 * the runtime had `fileStates`, which ran exactly the right `git status`, and no
 * caller anywhere. A run measured on 2026-09-24 ended with 1,847 lines of source
 * and tests uncommitted, the patch recorded MERGED, and the product branch still
 * holding its scaffold commit.
 *
 * The warning rides the turn summary into the seat's own memory, which is the
 * channel that already carries "no ops parsed" and "this turn produced no work".
 * These tests pin the three gates that keep it from costing a `git status` on
 * every turn of every seat.
 */

const AGENTS = [
  { id: "dev", role: "developer", capabilities: ["repository.write", "git.commit"], interests: [] },
  { id: "pm", role: "pm", capabilities: ["repository.read"], interests: [] },
];
const COMM = { dev: ["pm"], pm: ["dev"] };

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

/** A workspace that reports whatever state the test wants, and counts probes. */
function fakeWorkspace(state: WorktreeState | null): { readonly probes: string[]; install: (m: Mesh) => void } {
  const ws = new FakeWorkspace({ behaviour: { worktreeState: async () => state } });
  return {
    get probes() {
      return ws.callsTo("worktreeState").map((c) => c.agentId);
    },
    install(m: Mesh) {
      installWorkspace(m, ws);
    },
  };
}

const advisory = (m: Mesh, agentId: string, results: Array<{ ok: boolean; op: string }>) =>
  (
    m.supervisor as unknown as {
      uncommittedWorkAdvisory(a: string, t: { results: Array<{ ok: boolean; op: string }> }): Promise<string | null>;
    }
  ).uncommittedWorkAdvisory(agentId, { results });

test("a seat that wrote files and did not commit is told so, by name", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" });
  const ws = fakeWorkspace({
    agentId: "dev",
    dirty: ["src/core/digest.js", "src/core/canonical.js", "test/digest.test.js"],
    untracked: 3,
    unmergedCommits: [],
  });
  try {
    ws.install(m);
    const note = await advisory(m, "dev", [{ ok: true, op: "publish_artifact" }]);
    assert.ok(note, "a writing seat with a dirty worktree must be warned");
    assert.match(note!, /3 file\(s\)/, "it states how many files are at risk");
    assert.match(note!, /src\/core\/digest\.js/, "and names them, so the seat can act without guessing");
    // The remedy has to be in the sentence: a warning a seat cannot act on is
    // noise, and `commit` needs a lease first.
    assert.match(note!, /commit/, "it names the op that would land the work");
    assert.match(note!, /lease/i, "including the lease the commit op requires");
  } finally {
    await m.cleanup();
  }
});

test("unmerged commits are reported too — committed is not the same as landed", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" });
  const ws = fakeWorkspace({ agentId: "dev", dirty: ["a.js"], untracked: 1, unmergedCommits: ["abc123 feat: x", "def456 fix: y"] });
  try {
    ws.install(m);
    const note = await advisory(m, "dev", []);
    assert.match(note ?? "", /2 commit\(s\)/, "commits sitting on the branch are still outside the product");
    assert.match(note ?? "", /merge/, "and only the merge op moves them");
  } finally {
    await m.cleanup();
  }
});

test("a turn that committed is not warned, and is never probed", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" });
  const ws = fakeWorkspace({ agentId: "dev", dirty: ["a.js"], untracked: 1, unmergedCommits: [] });
  try {
    ws.install(m);
    const note = await advisory(m, "dev", [{ ok: true, op: "commit" }]);
    assert.equal(note, null, "a seat that just committed has already done the thing");
    assert.deepEqual(ws.probes, [], "and the git call is skipped entirely, not merely ignored");
  } finally {
    await m.cleanup();
  }
});

test("a failed commit does not count as having committed", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" });
  const ws = fakeWorkspace({ agentId: "dev", dirty: ["a.js"], untracked: 1, unmergedCommits: [] });
  try {
    ws.install(m);
    const note = await advisory(m, "dev", [{ ok: false, op: "commit" }]);
    assert.ok(note, "a refused commit leaves the work exactly as unlanded as no commit at all");
  } finally {
    await m.cleanup();
  }
});

test("a read-only seat is never probed: it has no worktree to be dirty", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" });
  const ws = fakeWorkspace({ agentId: "pm", dirty: ["somehow.js"], untracked: 1, unmergedCommits: [] });
  try {
    ws.install(m);
    const note = await advisory(m, "pm", []);
    assert.equal(note, null, "a seat without an edit capability works in the product checkout");
    assert.deepEqual(ws.probes, [], "so the probe must not run for it at all");
  } finally {
    await m.cleanup();
  }
});

test("a clean worktree says nothing", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" });
  const ws = fakeWorkspace({ agentId: "dev", dirty: [], untracked: 0, unmergedCommits: [] });
  try {
    ws.install(m);
    assert.equal(await advisory(m, "dev", []), null, "nothing pending, nothing to warn about");
  } finally {
    await m.cleanup();
  }
});

test("a mesh with no git workspace never warns", async () => {
  // The in-memory case, which is most of the suite: there are no worktrees, so a
  // warning about uncommitted files would be meaningless.
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" });
  try {
    assert.equal(await advisory(m, "dev", []), null);
  } finally {
    await m.cleanup();
  }
});
