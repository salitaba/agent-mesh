import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { makeMesh, stub, waitFor } from "../helpers";
import { gitSkip } from "../support/git";
import type { GitWorkspace } from "../../packages/artifact-store/src/index";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * A seat's turn begins on the product branch it is about to be asked about.
 *
 * In the second cronlite run QA's worktree stayed at the commit it was created on while
 * `main` moved twice. QA tested that worktree, found defects the merged code no longer
 * had, and blocked the mission on them, twice. At the start of each turn the supervisor now
 * fast-forwards a worktree that can be advanced without touching the seat's own work, and
 * puts a `## Your worktree` section in the prompt: what was done, or exactly why not and how
 * far behind the seat is. Outside the tiered bundle, like the other notes a degraded tier must
 * not be the one to lose.
 */

const AGENTS = [
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "git.commit"], interests: [] },
  { id: "qa", role: "qa", capabilities: ["repository.read", "repository.write", "test.execute"], interests: [] },
  { id: "pm", role: "pm", capabilities: ["repository.read"], interests: [] },
];
const COMM = { dev: ["qa", "pm"], qa: ["dev", "pm"], pm: ["dev", "qa"] };
const CRITERIA = [
  { id: "landed", description: "landed" },
  { id: "never", description: "never evidenced here, so no merge completes the mission" },
];

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

/** dev writes `file`, commits it and lands it on the product branch: the merge QA's worktree has not seen. */
async function land(m: Mesh, file: string, body: string): Promise<void> {
  const ws = m.supervisor.deps.workspace as GitWorkspace;
  const dev = await ws.ensureWorktree("dev");
  fs.writeFileSync(path.join(dev, file), body, "utf8");
  const c = await ws.commitWorktree("dev", `dev: ${file}`);
  await ws.mergeWorktree(`art-${file}`, "dev", `merge ${file}`, c.commit);
}

/** Run one turn of `agentId` and return the prompt it was handed. */
async function turnPrompt(m: Mesh, agentId: string): Promise<string> {
  const seen: string[] = [];
  stub(m).setScript(agentId, async (input) => {
    seen.push(input.instructions);
    return { operations: [{ op: "wait" } as MeshOp] };
  });
  await m.supervisor.activateAgent(agentId, { kind: "manual" }, { explicit: true });
  await waitFor(`${agentId}'s turn`, () => seen.length > 0, 15_000);
  return seen[0]!;
}

test("a behind worktree is advanced before the turn, and the prompt says so", { skip: gitSkip }, async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "live", criteria: CRITERIA, git: true });
  try {
    const ws = m.supervisor.deps.workspace as GitWorkspace;
    const qa = await ws.ensureWorktree("qa");
    await land(m, "lib.js", "module.exports = 'fixed';\n");
    assert.equal(fs.existsSync(path.join(qa, "lib.js")), false, "fixture: qa's worktree is behind the merge");

    const prompt = await turnPrompt(m, "qa");

    assert.equal(fs.readFileSync(path.join(qa, "lib.js"), "utf8"), "module.exports = 'fixed';\n", "what QA runs is what was merged");
    assert.match(prompt, /## Your worktree\nYour worktree was \d+ commits? behind main and has been brought up to date/);
    assert.match(prompt, new RegExp(`main is at ${git(qa, "rev-parse", "--short=12", "main")}`));
    // Outside the tiered bundle: after the bundle's own sections, before the turn clock and the reason.
    assert.ok(prompt.indexOf("## Your worktree") > prompt.indexOf("Mission"), "it follows the briefing");
    assert.ok(prompt.indexOf("## Your worktree") < prompt.indexOf("## Why you were woken"));
  } finally {
    await m.cleanup();
  }
});

test("a worktree that cannot be advanced is left alone, and the prompt says how far behind it is and why", { skip: gitSkip }, async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "live", criteria: CRITERIA, git: true });
  try {
    const ws = m.supervisor.deps.workspace as GitWorkspace;
    const qa = await ws.ensureWorktree("qa");
    // A tracked file, edited and not committed: the one thing a fast-forward must not sit on.
    fs.writeFileSync(path.join(qa, "README.md"), "# qa's own edit\n", "utf8");
    await land(m, "lib.js", "module.exports = 1;\n");

    const prompt = await turnPrompt(m, "qa");

    assert.equal(fs.existsSync(path.join(qa, "lib.js")), false, "nothing was moved under the seat");
    assert.equal(fs.readFileSync(path.join(qa, "README.md"), "utf8"), "# qa's own edit\n");
    assert.match(prompt, /## Your worktree\nYour worktree is \d+ commits? behind main \(main is at [0-9a-f]{12}\) and could not be brought up to date: it has uncommitted changes to tracked files\./);
    assert.match(prompt, /OLDER than what has been merged/);
    assert.match(prompt, /`git merge main`/, "and the way to bring it up to date is in the note");
    assert.match(prompt, /name the commit you checked/);
  } finally {
    await m.cleanup();
  }
});

test("a current worktree adds nothing to the prompt, and neither does a seat that has no worktree of its own", { skip: gitSkip }, async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "live", criteria: CRITERIA, git: true });
  try {
    const ws = m.supervisor.deps.workspace as GitWorkspace;
    await ws.ensureWorktree("qa");
    // Nothing has been merged: qa is exactly on the product branch.
    assert.doesNotMatch(await turnPrompt(m, "qa"), /## Your worktree/);

    // pm reads the product checkout itself, which is always current.
    await land(m, "lib.js", "module.exports = 1;\n");
    assert.doesNotMatch(await turnPrompt(m, "pm"), /## Your worktree/);
  } finally {
    await m.cleanup();
  }
});

test("a sync that throws costs the seat a line in the audit log and nothing else", { skip: gitSkip }, async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "live", criteria: CRITERIA, git: true });
  try {
    const ws = m.supervisor.deps.workspace as GitWorkspace;
    await ws.ensureWorktree("qa");
    (ws as { syncWorktree: GitWorkspace["syncWorktree"] }).syncWorktree = async () => {
      throw new Error("git is having a day");
    };
    const prompt = await turnPrompt(m, "qa");
    assert.doesNotMatch(prompt, /## Your worktree/, "the turn ran, with no note");
  } finally {
    await m.cleanup();
  }
});
