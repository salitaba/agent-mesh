import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { assertWorkspaceCoherent, bootstrapMesh, ownsGitRepo } from "../../apps/mesh-server/src/index";
import { ConfigError, writeDefaultMeshYaml } from "../../packages/config/src/index";

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mesh-ws-coherence-"));
}

/**
 * The operator-facing text of the refusal `fn` must raise. Asserts the type
 * here so each test can match on the sentences, which are the whole point of
 * throwing: a refusal nobody can act on is the stderr warning this replaced.
 */
function refusalText(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ConfigError, `expected a ConfigError, got ${String(err)}`);
    return (err as ConfigError).errors.join("\n");
  }
  assert.fail("expected the incoherent workspace to be refused");
}

/** The layout a healthy git-mode workspace has: `main/` plus `worktrees/`. */
function gitModeLayout(root: string): void {
  fs.mkdirSync(path.join(root, "main"), { recursive: true });
  fs.mkdirSync(path.join(root, "worktrees"), { recursive: true });
  fs.mkdirSync(path.join(root, ".mesh-state"), { recursive: true });
}

test("workspace coherence: the healthy git-mode layout boots", () => {
  const dir = tempDir();
  try {
    gitModeLayout(dir);
    assert.doesNotThrow(() => assertWorkspaceCoherent(dir, true, path.join(dir, ".mesh-state")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace coherence: product files at the root are refused", () => {
  const dir = tempDir();
  try {
    gitModeLayout(dir);
    // Exactly what the scaffolded architect used to write: it holds
    // architecture.write but not repository.write, so it got no worktree and
    // landed here, outside every repository.
    fs.writeFileSync(path.join(dir, "pom.xml"), "<project/>", "utf8");
    fs.mkdirSync(path.join(dir, "core-domain"), { recursive: true });

    const text = refusalText(() => assertWorkspaceCoherent(dir, true, path.join(dir, ".mesh-state")));
    assert.match(text, /pom\.xml/, "the refusal must name the stray file");
    assert.match(text, /core-domain/, "the refusal must name the stray directory");
    assert.match(text, /main/, "the refusal must say where the product belongs");
    assert.match(text, /--no-git|workspace\.git/, "the refusal must offer the no-git exit");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace coherence: a workspace that is its own repo is refused", { skip: !hasGit && "git unavailable" }, () => {
  const dir = tempDir();
  try {
    // How skill-panel broke: it ran with git off, a reset git-init'd the root,
    // then the default flipped to git on. `ensureRepo` then builds a phantom
    // `main/` and commits land in a repo the product was never in.
    execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
    gitModeLayout(dir);

    const text = refusalText(() => assertWorkspaceCoherent(dir, true, path.join(dir, ".mesh-state")));
    assert.match(text, /is itself a git repository/, "the refusal must name the root repo");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace coherence: no-git mode owns the root, so nothing there is stray", { skip: !hasGit && "git unavailable" }, () => {
  const dir = tempDir();
  try {
    // The same directory that is refused above: without git the product lives
    // at the root by design, and a repo there is what `initProductRepo` makes.
    execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
    fs.writeFileSync(path.join(dir, "pom.xml"), "<project/>", "utf8");
    assert.doesNotThrow(() => assertWorkspaceCoherent(dir, false, path.join(dir, ".mesh-state")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace coherence: a relocated state dir is not mistaken for a stray", () => {
  const dir = tempDir();
  try {
    gitModeLayout(dir);
    // `server.state_dir` is configurable; a workspace-relative one must be
    // recognized by whatever name it was given.
    fs.rmSync(path.join(dir, ".mesh-state"), { recursive: true, force: true });
    const stateDir = path.join(dir, "custom-state");
    fs.mkdirSync(stateDir, { recursive: true });
    assert.doesNotThrow(() => assertWorkspaceCoherent(dir, true, stateDir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace coherence: a workspace that does not exist yet is fine", () => {
  const dir = tempDir();
  try {
    const fresh = path.join(dir, "not-created-yet");
    // `ensureRepo` makes the workspace lazily, so a first boot legitimately
    // finds nothing here.
    assert.doesNotThrow(() => assertWorkspaceCoherent(fresh, true, path.join(fresh, ".mesh-state")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The whole failure, reproduced from the top: a brand-new project, nothing
 * hand-edited, no mode flip and no reset. `mesh init` scaffolds one seat — an
 * architect holding `architecture.write` and not `repository.write` — and
 * `startup.activate` wakes it first. It was handed the workspace root, wrote
 * the design there, and nothing could ever cite a revision for it.
 *
 * So the assertion is not "the path looks right" but the thing the mission
 * actually needs: what the scaffolded seat writes can be committed.
 */
test("scaffold: the seat a fresh init activates can commit what it writes", { skip: !hasGit && "git unavailable" }, async () => {
  const dir = tempDir();
  const configPath = writeDefaultMeshYaml(dir, "scaffold-boot", "stub");
  const m = await bootstrapMesh({ configPath, mode: "parked" });
  try {
    assert.equal(m.useGit, true, "the scaffold writes `git: true`; this test is about that branch");
    const root = path.dirname(m.productPath);
    const seat = await m.supervisor.agentWorkspace("architect");
    assert.notEqual(seat, root, "the scaffolded architect must not be handed the workspace root");

    fs.writeFileSync(path.join(seat, "ARCHITECTURE.md"), "# decisions\n", "utf8");
    const commit = await m.supervisor.deps.workspace!.commitWorktree("architect", "docs: architecture", ["ARCHITECTURE.md"]);
    assert.match(commit.commit, /^[0-9a-f]{40}$/, "the seat's output must be reachable by a real revision");

    // And it wrote nowhere else: the root is still a layout the next boot takes.
    assert.doesNotThrow(() => assertWorkspaceCoherent(root, true, path.join(root, ".mesh-state")));
  } finally {
    await m.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("owns git repo: an enclosing repo does not make a directory its own", { skip: !hasGit && "git unavailable" }, () => {
  const outer = tempDir();
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd: outer, stdio: "ignore" });
    const inner = path.join(outer, "workspace");
    fs.mkdirSync(inner, { recursive: true });
    assert.equal(ownsGitRepo(outer), true, "the toplevel owns its repo");
    assert.equal(ownsGitRepo(inner), false, "a nested directory answers for the enclosing repo, and must not count");
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});
