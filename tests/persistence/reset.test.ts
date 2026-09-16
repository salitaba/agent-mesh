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

test("reset: archives and wipes the non-git product workspace", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-reset-product-nogit-"));
  const m = await boot(dir);
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
  const m = await boot(dir);
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
