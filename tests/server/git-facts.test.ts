import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { gitFacts, initProductRepo } from "../../apps/mesh-server/src/index";

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mesh-git-facts-"));
}

test("git facts: a directory with no repo reads as no repo, never as a clean tree", () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, "PRODUCT.txt"), "delivered", "utf8");
    const facts = gitFacts(dir);
    assert.equal(facts.gitRepo, "false", "a bare directory is not a repository");
    assert.notEqual(
      facts.gitClean,
      "true",
      "an empty `git status` must not be reported as a clean tree — that is the gate passing on nothing",
    );
    assert.equal(facts.gitClean, "unknown", "with no repo the cleanliness of the tree is unknown");
    assert.equal(facts.gitBranch, "", "no repo means no branch to name");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("git facts: an enclosing repo is not adopted as the product's own", { skip: !hasGit && "git unavailable" }, () => {
  const outer = tempDir();
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd: outer, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "t@localhost"], { cwd: outer, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "T"], { cwd: outer, stdio: "ignore" });
    fs.writeFileSync(path.join(outer, "OUTER.txt"), "someone else's repo", "utf8");
    execFileSync("git", ["add", "-A"], { cwd: outer, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "outer"], { cwd: outer, stdio: "ignore" });

    // The product workspace merely lives *inside* that checkout.
    const inner = path.join(outer, "workspace");
    fs.mkdirSync(inner, { recursive: true });

    const facts = gitFacts(inner);
    assert.equal(facts.gitRepo, "false", "a nested directory must not claim the ancestor's repository");
    assert.notEqual(facts.gitClean, "true", "the ancestor's cleanliness must not be reported as the product's");
    assert.equal(facts.gitHead, "", "the ancestor's HEAD must not leak into the product facts");
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test("git facts: an initialized product root reports its own real facts", { skip: !hasGit && "git unavailable" }, () => {
  const dir = tempDir();
  try {
    const stateDir = path.join(dir, ".mesh-state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "events.jsonl"), "{}\n", "utf8");

    assert.equal(initProductRepo(dir, stateDir), true, "init must succeed on a writable root");

    const facts = gitFacts(dir);
    assert.equal(facts.gitRepo, "true");
    assert.equal(facts.gitBranch, "main", "the fresh repo sits on the base branch");
    assert.ok(facts.gitHead, "the initial commit gives the repo a HEAD to diff against");
    assert.equal(facts.gitClean, "true", "a just-initialized product root is clean");
    assert.match(facts.gitLog, /initialize workspace/, "the initial commit is visible in the log");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("git facts: the state dir inside the workspace does not make the product dirty", { skip: !hasGit && "git unavailable" }, () => {
  const dir = tempDir();
  try {
    const stateDir = path.join(dir, ".mesh-state");
    initProductRepo(dir, stateDir);
    // The live mission writes its log after the repo exists.
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "events.jsonl"), '{"seq":1}\n', "utf8");

    assert.equal(gitFacts(dir).gitClean, "true", "mesh state is not product work — it must stay ignored");

    fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html>", "utf8");
    assert.equal(gitFacts(dir).gitClean, "false", "real product files must still show the tree as dirty");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
