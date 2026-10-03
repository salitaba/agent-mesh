import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { makeMesh } from "../helpers";
import { gitSkip } from "../support/git";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * A second patch from a branch the first patch's merge already took is not "never committed".
 *
 * In the fourteenth cronlite run the developer committed with its own git (setup, library, CLI, README) and published two
 * patches that recorded no commit. A patch that records none has nothing to scope its merge by, so the tech lead's merge of
 * the library took the whole branch, the CLI with it. The merge of the CLI patch then "moved nothing", and the reply said
 * "the patch records no commit, so its work was never committed: files developer wrote but did not commit are on no
 * branch. developer must `mesh_commit` the patch's files". Neither half was true: the work was committed and on the product
 * branch, and `mesh_commit` refused the developer in turn ("nothing was committed: the worktree had no changes and the
 * branch holds nothing that is not already on the product branch"). The tech lead tried three times, the developer asked it
 * to merge, it declined, and the CLI patch sat MERGEABLE for the rest of the run with `bin/cronlite.js` on main.
 *
 * Against REAL git, because what is asked is what the worktree and the product checkout hold: a patch is in the product when
 * its owner has nothing uncommitted and every file the patch lists is there as published. The refusals that remain say which
 * of those failed, and do not name a commit that would be refused.
 */

const AGENTS = [
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "git.commit"], interests: [] },
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "code.review", "git.merge"], authority: ["implementation.approve"], interests: [] },
];
const COMM = { dev: ["lead"], lead: ["dev"] };
// A second criterion nothing here evidences, so no merge completes the mission and turns every later op into "mission is COMPLETED".
const CRITERIA = [
  { id: "implementation-merged", description: "landed", mandatory: true },
  { id: "docs-written", description: "never evidenced here", mandatory: true },
];

const turnFor = (agentId: string) =>
  ({ turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`, agentId, reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] }) as never;

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=Seat", "-c", "user.email=seat@example.test", ...args], { cwd, encoding: "utf8" }).trim();

/** What the seat does with its own shell: write a file and commit it. */
function commitFile(worktree: string, file: string, body: string): void {
  fs.mkdirSync(path.dirname(path.join(worktree, file)), { recursive: true });
  fs.writeFileSync(path.join(worktree, file), body, "utf8");
  git(worktree, "add", file);
  git(worktree, "commit", "-q", "-m", `add ${file}`);
}

const LIB = "export const parse = (s) => s.split(' ');\nexport const CronParseError = class extends Error {};\n";
const CLI = "import { parse } from '../src/lib.js';\nconsole.log(parse(process.argv[2]));\n";

/** `files` as a patch's content: one `## File: <path>` section each. */
const sections = (files: Record<string, string>): string => Object.entries(files).map(([f, body]) => `## File: ${f}\n${body}`).join("\n");

/** Publish a patch that records no commit and walk it to MERGEABLE. */
async function mergeable(m: Mesh, name: string, content: string): Promise<string> {
  const created = await m.supervisor.createArtifact({ actorId: "dev", name, type: "CodePatch", content });
  if (!("artifact" in created)) throw new Error(`create failed: ${JSON.stringify(created)}`);
  const id = created.artifact.id;
  await m.supervisor.transitionArtifact("dev", id, { to: "READY_FOR_REVIEW" });
  const ap = await m.supervisor.executeOp("lead", { op: "approve", subject: "implementation", artifactId: id } as MeshOp, turnFor("lead"));
  assert.equal(ap.ok, true, `approve: ${ap.reason ?? ""}`);
  await m.supervisor.transitionArtifact("lead", id, { to: "VERIFIED" });
  await m.supervisor.transitionArtifact("lead", id, { to: "MERGEABLE" });
  assert.equal(m.kernel.state.artifacts.get(id)?.status, "MERGEABLE", `fixture: ${name} is staged at the gate`);
  return id;
}

const merge = (m: Mesh, id: string) => m.supervisor.executeOp("lead", { op: "merge", artifactId: id } as MeshOp, turnFor("lead"));
const head = (m: Mesh): string => git(m.productPath, "rev-parse", "HEAD");

/**
 * The run's shape: two commits on the owner's branch (library, then CLI), a patch for each, and the library merged first,
 * which takes the whole branch. Returns the CLI patch, still MERGEABLE, with its file already in the product.
 */
async function libraryMergedWholeBranch(m: Mesh) {
  const worktree = await m.supervisor.agentWorkspace("dev");
  commitFile(worktree, "src/lib.js", LIB);
  commitFile(worktree, "bin/cli.js", CLI);
  const library = await mergeable(m, "library", sections({ "src/lib.js": LIB }));
  const cli = await mergeable(m, "cli", sections({ "bin/cli.js": CLI }));
  const first = await merge(m, library);
  assert.equal(first.ok, true, `fixture: the library merges: ${first.reason}`);
  assert.ok(fs.existsSync(path.join(m.productPath, "bin/cli.js")), "fixture: a patch that records no commit took the whole branch, the CLI with it");
  return { worktree, library, cli };
}

test("the second patch of a branch the first merge took is recorded as merged, because its files are in the product as published", { skip: gitSkip }, async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked", criteria: CRITERIA, git: true });
  try {
    const { cli } = await libraryMergedWholeBranch(m);
    const before = head(m);
    const res = await merge(m, cli);
    assert.equal(res.ok, true, `refused as never committed: ${res.reason}`);
    assert.match(String(res.reason), /already in the product as [0-9a-f]{12} \(landed by an earlier merge: dev's branch holds nothing the product lacks, and the file this patch lists \(bin\/cli\.js\) is there as published\)/);
    assert.equal(m.kernel.state.artifacts.get(cli)?.status, "MERGED");
    assert.equal(head(m), before, "and nothing moved: it was already there");
    const events = await m.store.read();
    assert.equal(events.filter((e) => e.type === "patch.merged").length, 2, "each patch announces its own landing");
    assert.equal(events.filter((e) => e.type === "implementation.completed").length, 2);
  } finally {
    await m.cleanup();
  }
});

test("every file the patch lists must be there: one that is not in the product keeps the refusal, and the remedy is not a commit", { skip: gitSkip }, async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked", criteria: CRITERIA, git: true });
  try {
    await libraryMergedWholeBranch(m);
    // A patch that describes work nobody wrote: the worktree is as clean as the first patch left it.
    const ghost = await mergeable(m, "docs", sections({ "docs/guide.md": "the guide\n", "bin/cli.js": CLI }));
    const res = await merge(m, ghost);
    assert.equal(res.ok, false, "a patch whose work is not in the product is not recorded as merged");
    const reason = String(res.reason);
    assert.match(reason, /holds nothing uncommitted and its branch holds nothing the product lacks, so `mesh_commit` has nothing to record, yet docs\/guide\.md is not in the product/);
    assert.match(reason, /publish a new version of the patch \(`asVersionOf`\)/, "the way out is a new version, not a commit that would be refused");
    assert.doesNotMatch(reason, /must `mesh_commit` the patch's files/);
    assert.equal(m.kernel.state.artifacts.get(ghost)?.status, "MERGEABLE");
  } finally {
    await m.cleanup();
  }
});

test("a file in the product that is not the one the patch lists is named too", { skip: gitSkip }, async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked", criteria: CRITERIA, git: true });
  try {
    await libraryMergedWholeBranch(m);
    const stale = await mergeable(m, "stale", sections({ "src/lib.js": "export const parse = () => 'a different version';\n" }));
    const res = await merge(m, stale);
    assert.equal(res.ok, false);
    assert.match(String(res.reason), /yet src\/lib\.js is in the product but not as the patch lists it\./);
    assert.equal(m.kernel.state.artifacts.get(stale)?.status, "MERGEABLE");
  } finally {
    await m.cleanup();
  }
});

test("files the owner wrote and never committed: the refusal names them and keeps the commit as the remedy", { skip: gitSkip }, async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked", criteria: CRITERIA, git: true });
  try {
    const { worktree } = await libraryMergedWholeBranch(m);
    fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
    fs.writeFileSync(path.join(worktree, "src/extra.js"), "export const extra = 1;\n", "utf8");
    const unwritten = await mergeable(m, "extra", sections({ "src/extra.js": "export const extra = 1;\n" }));
    const res = await merge(m, unwritten);
    assert.equal(res.ok, false);
    const reason = String(res.reason);
    assert.match(reason, /dev has 1 uncommitted file\(s\) in its worktree \(src\/extra\.js\): written and never committed, they are on no branch\. dev must `mesh_commit` the patch's files\./);
    assert.equal(m.kernel.state.artifacts.get(unwritten)?.status, "MERGEABLE");
    const crit = m.kernel.state.goals.get(m.kernel.state.activeGoalId ?? "")?.acceptanceCriteria.find((c) => c.id === "implementation-merged");
    assert.equal(crit?.evidence.length, 1, "and implementation-merged has only the library's merge behind it");
  } finally {
    await m.cleanup();
  }
});

test("a patch that lists no file cannot be matched to what landed: the owner is told to list it or name its commit", { skip: gitSkip }, async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked", criteria: CRITERIA, git: true });
  try {
    await libraryMergedWholeBranch(m);
    const prose = await mergeable(m, "prose", "the CLI, described in a paragraph and not listed file by file");
    const res = await merge(m, prose);
    assert.equal(res.ok, false);
    assert.match(String(res.reason), /yet the patch lists no file to look for in the product \(a `## File: <path>` section for each, or `metadata\.path`\)/);
    assert.match(String(res.reason), /names the commit it was made in \(`metadata\.commit`\)/);
  } finally {
    await m.cleanup();
  }
});
