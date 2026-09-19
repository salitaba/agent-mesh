import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { bootstrapMesh } from "../../apps/mesh-server/src/index";
import { testConfigYaml } from "../helpers";

const hasGit = (() => {
  try {
    require("child_process").execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function boot(dir: string, opts: { useGit?: boolean } = {}): Promise<Awaited<ReturnType<typeof bootstrapMesh>>> {
  const configPath = path.join(dir, "mesh.yaml");
  fs.writeFileSync(
    configPath,
    testConfigYaml({ agents: [{ id: "a", role: "r", interests: [] }], mayContact: { a: [] } }),
    "utf8",
  );
  return bootstrapMesh({ configPath, mode: "parked", useGit: opts.useGit });
}

test("reset: wipes the event log and mints a new goal", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-reset-"));
  const m = await boot(dir);
  try {
    for (let i = 0; i < 5; i++) {
      await m.kernel.emit("human.input", { action: `probe-${i}` }, { actorId: "human" });
    }
    const goalBefore = m.kernel.state.activeGoalId;
    assert.ok(goalBefore, "a goal must exist before reset");
    assert.ok(m.kernel.state.eventCount > 5, "events must have accumulated");

    const report = await m.reset({});

    assert.equal(report.ok, true);
    assert.ok(report.archivedTo, "previous state must be archived, not silently dropped");
    assert.ok(fs.existsSync(report.archivedTo!), "the archive directory must exist on disk");
    // A fresh mission: new goal id, and the old log is gone from the store.
    assert.notEqual(report.goalId, goalBefore, "reset must mint a NEW goal, not resume the old one");
    const remaining = await m.store.read();
    const stale = remaining.filter((e) => (e.payload as { action?: string })?.action?.startsWith("probe-"));
    assert.equal(stale.length, 0, "pre-reset events must not survive in the live log");
    // Always lands parked so nothing starts spending before the operator says so.
    assert.equal(report.mode, "parked");
    assert.equal(m.mode, "parked");
  } finally {
    await m.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reset: the archive still holds the pre-reset events", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-reset-archive-"));
  const m = await boot(dir);
  try {
    await m.kernel.emit("human.input", { action: "keepme" }, { actorId: "human" });
    const report = await m.reset({});
    const archivedLog = path.join(report.archivedTo!, "logs", "events.jsonl");
    assert.ok(fs.existsSync(archivedLog), "archived log must be readable after reset");
    assert.match(fs.readFileSync(archivedLog, "utf8"), /keepme/, "archive must contain the wiped events");
    assert.ok(
      report.archivedTo!.startsWith(path.join(dir, ".mesh-backups")),
      "archive must live outside the agent workspace",
    );
  } finally {
    await m.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reset: deletes the old run's git worktrees", { skip: !hasGit && "git unavailable" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-reset-git-"));
  const m = await boot(dir, { useGit: true });
  try {
    const workspace = m.supervisor.deps.workspace;
    assert.ok(workspace, "git mode must expose a workspace");
    const wt = await workspace.ensureWorktree("a");
    assert.ok(fs.existsSync(wt), "worktree must exist before reset");

    const report = await m.reset({});

    assert.deepEqual(report.worktreesRemoved, ["a"]);
    assert.ok(!fs.existsSync(wt), "worktree must be deleted by reset");
  } finally {
    await m.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reset: archives and wipes the product checkout", { skip: !hasGit && "git unavailable" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-reset-product-"));
  const m = await boot(dir, { useGit: true });
  try {
    const product = m.productPath;
    fs.writeFileSync(path.join(product, "PRODUCT.txt"), "shipped by the old mission", "utf8");

    const report = await m.reset({});

    assert.ok(report.productArchivedTo, "product checkout must be archived, not silently dropped");
    assert.ok(
      report.productArchivedTo!.startsWith(path.join(dir, ".mesh-backups")),
      "product archive must live outside the agent workspace",
    );
    assert.ok(
      fs.existsSync(path.join(report.productArchivedTo!, "PRODUCT.txt")),
      "the archive must contain the old product files",
    );
    assert.ok(!fs.existsSync(path.join(product, "PRODUCT.txt")), "old product must not survive on disk");
    assert.ok(fs.existsSync(path.join(product, "README.md")), "a fresh empty repo must be ready for the next run");
  } finally {
    await m.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reset: leaves the fresh product checkout as its own git repo", { skip: !hasGit && "git unavailable" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-reset-reinit-"));
  const m = await boot(dir, { useGit: true });
  try {
    const product = m.productPath;
    fs.writeFileSync(path.join(product, "PRODUCT.txt"), "shipped by the old mission", "utf8");

    await m.reset({});

    // Fail closed: "no repo at all" is exactly the bug this guards, so an
    // unreadable toplevel has to fail the assertion, never skip past it.
    const toplevel = (() => {
      try {
        return require("child_process")
          .execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: product, stdio: ["ignore", "pipe", "ignore"] })
          .toString()
          .trim();
      } catch {
        return null;
      }
    })();
    assert.ok(toplevel, "reset must re-init the product checkout, not leave a bare directory behind");
    assert.equal(
      fs.realpathSync(toplevel),
      fs.realpathSync(product),
      "the fresh checkout must own its repo, not adopt an ancestor's",
    );
    // An empty repo has no commit to branch from, so the next run's worktrees
    // would fail: the re-init must carry its initial commit on the base branch.
    const head = require("child_process")
      .execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: product })
      .toString()
      .trim();
    assert.equal(head, "main", "the fresh repo must sit on the branch the mission cuts worktrees from");
    assert.ok(!fs.existsSync(path.join(product, "PRODUCT.txt")), "old product must not survive the re-init");

    // The proof that matters to the next mission: a worktree can still be cut.
    const workspace = m.supervisor.deps.workspace;
    assert.ok(workspace, "git mode must expose a workspace");
    const wt = await workspace.ensureWorktree("a");
    assert.ok(fs.existsSync(path.join(wt, ".git")), "a worktree must be cuttable from the re-inited repo");
  } finally {
    await m.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Reset archived `main/` and nothing else, so a stranded product at the
 * workspace root — the layout `agentWorkspace` used to hand every read-only
 * seat — survived reset-to-zero untouched and greeted the next boot. Since
 * that boot now refuses the layout outright, a reset that leaves it behind
 * would turn the corruption into an unstartable project.
 */
test("reset: archives a product stranded at the workspace root", { skip: !hasGit && "git unavailable" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-reset-stray-"));
  let m = await boot(dir, { useGit: true });
  try {
    const root = path.dirname(m.productPath);
    fs.writeFileSync(path.join(root, "pom.xml"), "<project/>", "utf8");
    fs.mkdirSync(path.join(root, "core-domain"), { recursive: true });
    fs.writeFileSync(path.join(root, "core-domain", "Payment.java"), "class Payment {}", "utf8");

    const report = await m.reset({});

    assert.ok(report.strayRootArchivedTo, "stray root files must be archived, not deleted and not left in place");
    assert.ok(
      report.strayRootArchivedTo!.startsWith(path.join(dir, ".mesh-backups")),
      "the archive must land outside the workspace it is clearing",
    );
    assert.ok(fs.existsSync(path.join(report.strayRootArchivedTo!, "pom.xml")), "the archive must hold the stray file");
    assert.ok(
      fs.existsSync(path.join(report.strayRootArchivedTo!, "core-domain", "Payment.java")),
      "the archive must hold stray directories whole",
    );
    assert.ok(!fs.existsSync(path.join(root, "pom.xml")), "reset must return to zero, not preserve the layout");
    assert.ok(!fs.existsSync(path.join(root, "core-domain")));
    assert.ok(fs.existsSync(m.productPath), "the product checkout must still be there for the next mission");

    // The claim that matters: the state reset leaves behind is one the next
    // boot accepts. Asserted by actually booting it, because the refusal is
    // what an operator hits, not a predicate.
    await m.close();
    m = await boot(dir, { useGit: true });
  } finally {
    await m.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reset: a healthy git workspace reports no stray archive", { skip: !hasGit && "git unavailable" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-reset-nostray-"));
  const m = await boot(dir, { useGit: true });
  try {
    // `main/`, `worktrees/` and the state dir are the layout, not strays: an
    // archive here would mean reset was moving the mesh's own directories.
    await m.supervisor.deps.workspace!.ensureWorktree("a");
    const report = await m.reset({});
    assert.equal(report.strayRootArchivedTo, null, "nothing at the root is stray in a healthy git workspace");
  } finally {
    await m.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("boot: defaults to git mode when mesh.workspace.git is absent", { skip: !hasGit && "git unavailable" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-boot-git-default-"));
  // No flag, no config key. This is the case that used to leave
  // `deps.workspace` undefined, refusing every mesh_commit — so no criterion
  // requiring landed code could ever be evidenced.
  const m = await boot(dir);
  try {
    assert.equal(m.useGit, true, "an absent workspace.git must default ON");
    assert.equal(m.productPath, path.join(dir, "workspace", "main"), "git mode owns the workspace/main checkout");
    assert.ok(fs.existsSync(m.productPath), "the product checkout must exist on disk");
  } finally {
    await m.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reset: archives and wipes the non-git product workspace", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-reset-product-nogit-"));
  // Explicit: a bare `boot(dir)` is git mode, because an absent
  // `mesh.workspace.git` means ON. This test is about the other branch.
  const m = await boot(dir, { useGit: false });
  try {
    const root = m.productPath;
    assert.equal(root, path.join(dir, "workspace"), "non-git product root is the configured workspace");
    fs.writeFileSync(path.join(root, "PRODUCT.txt"), "shipped by the old mission", "utf8");
    fs.mkdirSync(path.join(root, "apps", "playground"), { recursive: true });
    fs.writeFileSync(path.join(root, "apps", "playground", "index.html"), "<!doctype html>", "utf8");

    const report = await m.reset({});

    assert.ok(report.productArchivedTo, "the non-git product workspace must be archived, not silently dropped");
    assert.ok(
      report.productArchivedTo!.startsWith(path.join(dir, ".mesh-backups")),
      "product archive must live outside the agent workspace",
    );
    assert.ok(
      fs.existsSync(path.join(report.productArchivedTo!, "PRODUCT.txt")),
      "the archive must contain the old product files",
    );
    assert.ok(
      fs.existsSync(path.join(report.productArchivedTo!, "apps", "playground", "index.html")),
      "the archive must contain the old playground build",
    );
    assert.ok(!fs.existsSync(path.join(root, "PRODUCT.txt")), "old product must not survive on disk");
    assert.ok(!fs.existsSync(path.join(root, "apps")), "old playground must not survive on disk");
    assert.ok(
      !fs.existsSync(path.join(report.productArchivedTo!, ".mesh-state")),
      "the live state dir must not be double-archived into the product archive",
    );
    assert.ok(fs.existsSync(path.join(root, ".mesh-state")), "the state dir must stay in the workspace");
  } finally {
    await m.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reset: git-inits the fresh non-git product workspace", { skip: !hasGit && "git unavailable" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-reset-nogit-init-"));
  const m = await boot(dir, { useGit: false });
  try {
    const root = m.productPath;
    fs.writeFileSync(path.join(root, "PRODUCT.txt"), "shipped by the old mission", "utf8");

    await m.reset({});

    // Fail closed: "no repo at all" is the bug this guards, so an unreadable
    // toplevel must fail the assertion rather than skip past it.
    const toplevel = (() => {
      try {
        return require("child_process")
          .execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, stdio: ["ignore", "pipe", "ignore"] })
          .toString()
          .trim();
      } catch {
        return null;
      }
    })();
    assert.ok(toplevel, "reset must git-init the fresh workspace, not leave a bare directory behind");
    assert.equal(
      fs.realpathSync(toplevel),
      fs.realpathSync(root),
      "the fresh workspace must own its repo, not adopt an enclosing one",
    );
    const head = require("child_process")
      .execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root })
      .toString()
      .trim();
    assert.equal(head, "main", "the fresh repo must carry an initial commit on the base branch");
    assert.ok(!fs.existsSync(path.join(root, "PRODUCT.txt")), "old product must not survive the re-init");
    // The state dir stays in the workspace, so it must be ignored or the
    // product reads dirty from the first turn.
    assert.ok(fs.existsSync(path.join(root, ".mesh-state")), "the state dir must stay in the workspace");
    const status = require("child_process")
      .execFileSync("git", ["status", "--porcelain"], { cwd: root })
      .toString()
      .trim();
    assert.equal(status, "", "the fresh workspace is clean — mesh state must not count as product work");
  } finally {
    await m.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** The `<stamp>` out of a `.bak-<stamp>` archive name. */
function stampOf(archivePath: string | null): string | null {
  if (archivePath === null) return null;
  return /\.bak-(.+)$/.exec(archivePath)?.[1] ?? null;
}

function gitIn(cwd: string, args: string[]): string {
  return require("child_process")
    .execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();
}

test("reset: archives worktree work and bundles the branches before deleting them", { skip: !hasGit && "git unavailable" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-reset-worktrees-"));
  const m = await boot(dir);
  try {
    const workspace = m.supervisor.deps.workspace;
    assert.ok(workspace, "git mode must expose a workspace");
    const wt = await workspace.ensureWorktree("a");
    // Committed: once the branch is deleted this sha is unreachable, and
    // `git gc` is free to collect it. Only the bundle can bring it back.
    const { commit } = await workspace.commitWorktree("a", "agent a: half-finished work");
    assert.ok(commit, "the worktree must have a commit to protect");
    // Uncommitted, and written after the commit so it is genuinely not in the
    // bundle: this file exists nowhere else, and deleting the worktree without
    // copying it first destroys it.
    fs.writeFileSync(path.join(wt, "scrap.txt"), "uncommitted scratch work", "utf8");

    const report = await m.reset({});

    assert.deepEqual(report.worktreesRemoved, ["a"], "the worktrees are still deleted");
    assert.ok(report.worktreesArchivedTo, "the worktrees must be copied aside first");
    assert.ok(
      fs.existsSync(path.join(report.worktreesArchivedTo!, "a", "scrap.txt")),
      "uncommitted worktree work must survive in the archive",
    );

    // The bundle is the only path back to the commit: prove it verifies and
    // that fetching it actually yields that sha.
    assert.ok(report.worktreeBundleTo, "the mesh/* branches must be bundled");
    assert.match(
      gitIn(m.productPath, ["bundle", "verify", report.worktreeBundleTo!]),
      /mesh\/a/,
      "the bundle must carry the mesh branch",
    );
    gitIn(m.productPath, ["fetch", report.worktreeBundleTo!, "refs/heads/*:refs/heads/restored/*"]);
    assert.equal(
      gitIn(m.productPath, ["rev-parse", "refs/heads/restored/mesh/a"]),
      commit,
      "the deleted commit must be recoverable from the bundle",
    );
  } finally {
    await m.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reset: every archive it produces shares one stamp", { skip: !hasGit && "git unavailable" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-reset-stamp-"));
  const m = await boot(dir);
  try {
    const workspace = m.supervisor.deps.workspace;
    assert.ok(workspace, "git mode must expose a workspace");
    await workspace.ensureWorktree("a");
    await workspace.commitWorktree("a", "agent a: work");

    const report = await m.reset({});

    const stamp = stampOf(report.archivedTo);
    assert.ok(stamp, "the state archive must carry a stamp");
    // One reset, one set of backups: a stamp that differs between them makes
    // "restore what was there before this reset" ambiguous.
    assert.equal(stampOf(report.productArchivedTo), stamp, "the product archive must share the stamp");
    assert.equal(stampOf(report.worktreesArchivedTo), stamp, "the worktree archive must share the stamp");
  } finally {
    await m.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reset: archiveWorktrees:false deletes without copying", { skip: !hasGit && "git unavailable" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-reset-noarchive-"));
  const m = await boot(dir);
  try {
    const workspace = m.supervisor.deps.workspace;
    assert.ok(workspace, "git mode must expose a workspace");
    const wt = await workspace.ensureWorktree("a");
    fs.writeFileSync(path.join(wt, "scrap.txt"), "uncommitted scratch work", "utf8");

    const report = await m.reset({ archiveWorktrees: false });

    assert.deepEqual(report.worktreesRemoved, ["a"], "the escape hatch must not disable the deletion");
    assert.equal(report.worktreesArchivedTo, null, "no copy when the caller opted out");
    assert.equal(report.worktreeBundleTo, null, "no bundle when the caller opted out");
    assert.ok(!fs.existsSync(wt), "the worktree is still removed");
  } finally {
    await m.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reset: the mesh keeps working afterwards (same live objects)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-reset-usable-"));
  const m = await boot(dir);
  try {
    const kernelBefore = m.kernel;
    const storeBefore = m.store;
    await m.reset({});
    // Object identity must survive: every HTTP route handler closed over these.
    assert.equal(m.kernel, kernelBefore, "kernel identity must survive a reset");
    assert.equal(m.store, storeBefore, "store identity must survive a reset");
    // And the mesh must still accept new events on the fresh log.
    await m.kernel.emit("human.input", { action: "after-reset" }, { actorId: "human" });
    const after = await m.store.read();
    assert.ok(
      after.some((e) => (e.payload as { action?: string })?.action === "after-reset"),
      "new events must land in the fresh log",
    );
    assert.ok(after.every((e) => (e.seq ?? 0) > 0), "sequence numbering must restart cleanly");
  } finally {
    await m.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
