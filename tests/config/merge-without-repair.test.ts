import { test } from "node:test";
import assert from "node:assert/strict";
import { warnMergeWithoutRepair } from "../../packages/config/src/index";
import type { AgentDefinition } from "../../packages/protocol/src/index";

/**
 * A seat that can land a merge but cannot clean up after one.
 *
 * `git.merge` puts a branch into the product tree. When the merge leaves the
 * tree needing a fix, repairing it needs `repository.write` and confirming it
 * needs `test.execute`. A seat with neither can only describe the problem and
 * move on — and a dirty worktree makes `git merge` refuse, so the next merge
 * fails for a reason the previous one caused.
 *
 * Live evidence (2026-09-23): the architect held `git.merge` with
 * `repository.read` only. It merged a UI patch carrying its own
 * `pnpm-workspace.yaml` and `pnpm-lock.yaml`, wrote into the merge commit that
 * both had to be removed and the root lockfile regenerated before `pnpm -r
 * typecheck` could be trusted, and that it could not do either. The modified
 * lockfile left the tree dirty and the next merge failed on it.
 */

function seat(id: string, capabilities: string[]): AgentDefinition {
  return {
    id,
    role: id,
    mode: "peer",
    runtime: "stub",
    prompt: { text: `${id} seat` },
    capabilities,
    authority: [],
    communicationPolicy: { mayContact: [], mayBeContactedBy: [] },
    interests: [],
    sessionPolicy: { persistent: false },
  } as unknown as AgentDefinition;
}

test("a merger with neither repair capability is warned about, and told who can repair", () => {
  const out = warnMergeWithoutRepair([seat("architect", ["repository.read", "git.merge"]), seat("dev", ["repository.write", "test.execute"])]);
  assert.equal(out.length, 1);
  assert.match(out[0]!, /'architect' holds 'git\.merge'/);
  assert.match(out[0]!, /'repository\.write' or 'test\.execute'/);
  assert.match(out[0]!, /a seat that can repair: dev/, "names the seat the operator can hand the repair to");
});

test("a merger that can repair and verify is not warned about", () => {
  assert.deepEqual(warnMergeWithoutRepair([seat("lead", ["git.merge", "repository.write", "test.execute"])]), []);
});

test("a seat with no merge authority is not the subject of this warning", () => {
  assert.deepEqual(warnMergeWithoutRepair([seat("pm", ["repository.read"])]), []);
});

test("partial cover still warns, naming only what is missing", () => {
  const out = warnMergeWithoutRepair([seat("lead", ["git.merge", "repository.write"])]);
  assert.equal(out.length, 1);
  assert.match(out[0]!, /not 'test\.execute'/, "repository.write is held, so only the verify half is missing");
  assert.ok(!out[0]!.includes("'repository.write' or"), "and the held capability is not listed as missing");
});

test("when no seat at all can repair, the warning says so instead of naming nobody", () => {
  const out = warnMergeWithoutRepair([seat("architect", ["repository.read", "git.merge"]), seat("pm", ["repository.read"])]);
  assert.equal(out.length, 1);
  assert.match(out[0]!, /no seat in this mesh can repair one/);
});
