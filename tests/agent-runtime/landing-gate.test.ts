import { test } from "node:test";
import assert from "node:assert/strict";
import { landingDenial } from "../../packages/agent-runtime/src/landing-gate";
import { buildPermissionGate } from "../../packages/runtime-claude/src/index";
import { makeMesh } from "../helpers";
import { gitSkip } from "../support/git";

/**
 * A seat's shell may not land work on the product branch.
 *
 * `git.merge` is a capability and the `merge` op enforces it, runs the `patch.merge`
 * gate and records `patch.merged`. A seat with test or shell access could run the
 * same `git merge` in the product checkout from Bash, and none of that applied:
 * cronlite, 2026-09-30, the developer (no `git.merge`) ran
 * `cd <workspace>/main && git merge mesh/developer --no-edit`, the product branch
 * moved, and no event said so for another 49 seconds; in the next run it also tried
 * `git push -f origin mesh/developer:main`.
 *
 * What the permission gate can state without a sandbox: git commands that run IN the
 * product checkout may only read it, and `git push` needs `git.merge`. Everything in
 * the seat's own worktree, and everything that is not git, is untouched.
 */

const WS = "/srv/mesh/workspace";
const scope = { cwd: `${WS}/worktrees/developer`, productPath: `${WS}/main` };
const dev = { mayPush: false };
const lead = { mayPush: true };

const denied = (command: string, seat = dev): string => {
  const why = landingDenial(command, scope, seat);
  assert.ok(why, `should be refused: ${command}`);
  return why;
};
const allowed = (command: string, seat = dev): void => {
  assert.equal(landingDenial(command, scope, seat), null, `should be allowed: ${command}`);
};

test("the command that moved the product branch in the live run is refused", () => {
  assert.match(denied(`cd ${WS}/main && git merge mesh/developer --no-edit`), /would change the product checkout/);
});

test("every way of pointing git at the product checkout is the same refusal", () => {
  for (const command of [
    `git -C ${WS}/main merge mesh/developer`,
    "git -C ../../main merge mesh/developer", // relative to the seat's own worktree
    `cd ../../main && git commit -am x`,
    `cd ${WS}/main; git reset --hard mesh/developer`,
    `cd ${WS}/main\ngit checkout -B main mesh/developer`,
    `git --git-dir=${WS}/main/.git --work-tree=${WS}/main merge x`,
    `git --git-dir ${WS}/main/.git merge x`,
    `GIT_DIR=${WS}/main/.git GIT_WORK_TREE=${WS}/main git merge x`,
    `env GIT_DIR=${WS}/main/.git git merge x`,
    `export GIT_WORK_TREE=${WS}/main && git merge x`,
    `cd ${WS} && cd main && git cherry-pick abc123`,
    `bash -c "cd ${WS}/main && git merge x"`,
    `sh -c 'git -C ${WS}/main merge x'`,
    `eval "cd ${WS}/main && git merge x"`,
    `echo done && cd ${WS}/main && git merge x`,
    `git -C ${WS}/main branch -f main mesh/developer`,
    `git -C ${WS}/main tag v1`,
    `git -C ${WS}/main stash`,
    `git -C ${WS}/main/src/deep merge x`, // a subdirectory of the product checkout is the product checkout
  ]) {
    assert.match(denied(command), /product checkout/, command);
  }
});

test("a substitution inside the command is looked into, not trusted", () => {
  assert.match(denied(`echo $(cd ${WS}/main && git merge x)`), /product checkout/);
  assert.match(denied("echo `git -C ../../main merge x`"), /product checkout/);
});

test("a merge whose directory a variable decides is refused, because the next attempt is exactly that", () => {
  assert.match(denied(`cd "$(dirname "$PWD")/main" && git merge mesh/developer`), /cannot tell .* which directory/);
  assert.match(denied(`cd $MAIN && git merge x`), /cannot tell .* which directory/);
  // But only `merge`: the worktree is the usual target of a computed directory, and
  // refusing every such commit would fail ordinary work to catch one move.
  allowed(`cd "$(git rev-parse --show-toplevel)" && git add -A && git commit -m "x"`);
  allowed(`cd $SOMEWHERE && git status`);
});

test("a seat without git.merge may not push, anywhere; one with it may", () => {
  assert.match(denied("git push -f origin mesh/developer:main"), /needs git.merge/);
  assert.match(denied("git push"), /needs git.merge/);
  assert.match(denied("git -C ../other push origin x"), /needs git.merge/);
  allowed("git push origin mesh/developer", lead);
  // A holder of git.merge still does not change the product checkout from a shell:
  // the `merge` op is how it lands work, and it is the one that records it.
  assert.match(denied(`cd ${WS}/main && git merge mesh/developer`, lead), /use the `merge` op/);
  assert.match(denied(`cd ${WS}/main && git merge mesh/developer`, dev), /let the seat that holds git.merge run the `merge` op/);
});

test("git in the seat's own worktree is untouched, merging main into its own branch included", () => {
  allowed("git status");
  allowed("git diff --stat");
  allowed("git log --oneline -5");
  allowed('git commit -m "fix: the parser"');
  allowed("git merge main"); // syncing its OWN branch is ordinary work
  allowed("git rebase main");
  allowed("git checkout -b scratch");
  allowed(`cd ${scope.cwd} && git add -A && git commit -m wip`);
  allowed(`git -C ${scope.cwd} merge main`);
  allowed("git merge-base main HEAD"); // `merge-base` is not `merge`
  allowed("git stash && git pull && git stash pop");
});

// The second cronlite run's developer, told its worktree was behind main, wrote
// `cd "$(pwd)" && git merge main` to bring main into its own branch. The gate read the
// `$(pwd)` as a substitution whose value it could not know, then refused the merge because it
// could not say which directory it ran in: a refusal of ordinary work, for a seat that was
// doing exactly what it had been told.
test("the current directory is the current directory however it is spelled", () => {
  for (const command of [
    'cd "$(pwd)" && git merge main', // the command from the live run
    "cd $(pwd) && git merge main",
    "cd `pwd` && git merge main",
    'cd "$(pwd -P)" && git merge main',
    'cd "$PWD" && git merge main',
    'cd "${PWD}" && git merge main',
    "cd ${PWD} && git merge main", // unquoted braces are a word's, not a block's
    'cd "$PWD/." && git merge main',
    'git -C "$(pwd)" merge main',
    'git -C "$PWD" merge main',
    `bash -c 'cd "$(pwd)" && git merge main'`,
    `cd ${scope.cwd}/sub && cd "$(pwd)" && git merge main`, // and it follows a cd
    `cd ${scope.cwd} && cd "$PWD/.." && cd "$PWD/developer" && git merge main`,
  ]) {
    allowed(command);
  }
});

test("and from the product checkout it is still the product checkout", () => {
  for (const command of [
    `cd ${WS}/main && cd "$(pwd)" && git merge x`,
    `cd ${WS}/main && cd $PWD && git merge x`,
    `cd ${WS}/main && git -C "$(pwd)" merge x`,
    `cd ${WS}/main && git -C "\${PWD}" commit -am x`,
    `cd ${WS}/main/src && cd "$(pwd)" && git reset --hard x`, // a change other than merge was never "unknown": it is refused as itself
    'cd "$PWD/../../main" && git merge x', // walks from the seat's worktree to the product checkout
    'git -C "$(pwd)/../../main" merge x',
    `bash -c 'cd ${WS}/main && cd "$(pwd)" && git merge x'`,
  ]) {
    assert.match(denied(command), /product checkout/, command);
  }
});

test("an expansion that is not the current directory is still for the shell to decide", () => {
  for (const command of [
    'cd "$(dirname "$PWD")/main" && git merge x', // the parent's `main`: where the product checkout is
    'cd "$PWD$MAIN" && git merge x',
    'cd "${PWD:-$MAIN}" && git merge x',
    'cd "$(pwd)/$(echo main)" && git merge x',
    'cd "$PWD"* && git merge x',
    "cd $PWDX && git merge x", // a different variable that starts the same
    "cd $OLDPWD && git merge x",
    `PWD=${WS}/main; cd "$PWD" && git merge x`, // the command reassigned it: what it says is no longer where the shell is
    `cd "$X" && cd "$(pwd)" && git merge x`, // where the shell is was already unknown
  ]) {
    assert.match(denied(command), /cannot tell .* which directory/, command);
  }
});

test("a substitution inside a parameter expansion is still looked into", () => {
  assert.match(denied(`echo \${X:-$(git -C ../../main merge y)}`), /product checkout/);
  assert.match(denied("echo ${X:-`cd ../../main && git merge y`}"), /product checkout/);
});

test("reading the product checkout is fine, from git or anything else", () => {
  allowed(`git -C ${WS}/main log -3`);
  allowed(`git -C ${WS}/main diff mesh/developer`);
  allowed(`cd ${WS}/main && git status && git log --oneline`);
  allowed(`cd ${WS}/main && git branch --list`);
  allowed(`cd ${WS}/main && git tag`);
  allowed(`cd ${WS}/main && git rev-parse HEAD`);
  allowed("ls ../../main && cat ../../main/package.json");
  allowed("npm test && node bin/run.js --check");
  allowed("diff -r ../../main/src src | head");
});

test("a pattern that only appears inside a quoted string is not a command", () => {
  allowed(`echo "cd ${WS}/main && git merge x is not allowed"`);
  allowed(`git commit -m "docs: never run 'git merge' in ../../main"`);
  allowed(`grep -rn "git push" docs/`);
  allowed(`printf '%s\\n' 'git -C ../../main merge x' > notes.txt`);
});

test("a seat whose own directory is the product checkout may read it but not change it", () => {
  const inProduct = { cwd: `${WS}/main`, productPath: `${WS}/main` };
  assert.equal(landingDenial("git status", inProduct, dev), null);
  assert.equal(landingDenial("git diff HEAD~1", inProduct, dev), null);
  assert.match(String(landingDenial("git commit -am x", inProduct, dev)), /product checkout/);
  assert.match(String(landingDenial("git merge mesh/developer", inProduct, lead)), /product checkout/);
});

const ctx = () => ({ signal: new AbortController().signal }) as never;
type Gate = ReturnType<typeof buildPermissionGate>;
const verdict = async (gate: Gate, tool: string, input: Record<string, unknown>) => (await gate(tool, input, ctx()))?.behavior;
const bash = (gate: Gate, command: string) => verdict(gate, "Bash", { command });

test("the permission gate applies it to Bash, for a seat that can otherwise run anything", async () => {
  const gate = buildPermissionGate(["repository.write", "test.execute", "git.commit"], undefined, scope);

  const refused = await gate("Bash", { command: `cd ${WS}/main && git merge mesh/developer --no-edit` }, ctx());
  assert.equal(refused?.behavior, "deny");
  assert.match(refused?.behavior === "deny" ? refused.message : "", /^Bash denied: `git merge` would change the product checkout/);
  assert.equal(await bash(gate, "git push -f origin mesh/developer:main"), "deny");

  assert.equal(await bash(gate, "npm test"), "allow");
  assert.equal(await bash(gate, 'git commit -m "feat: x"'), "allow");
  assert.equal(await bash(gate, "git merge main"), "allow");
  assert.equal(await bash(gate, 'cd "$(pwd)" && git merge main'), "allow", "the seat's own branch, spelled the way the live run spelled it");
  assert.equal(await bash(gate, `git -C ${WS}/main log -1`), "allow");

  // Only Bash is a shell: the other tools are not read as commands.
  assert.equal(await verdict(gate, "Read", { file_path: `${WS}/main/README.md` }), "allow");
});

test("a seat holding git.merge may push from the gate; one without it may not", async () => {
  const withMerge = buildPermissionGate(["test.execute", "git.merge"], undefined, scope);
  const without = buildPermissionGate(["test.execute"], undefined, scope);
  assert.equal(await bash(withMerge, "git push origin main"), "allow");
  assert.equal(await bash(without, "git push origin main"), "deny");
  // Neither may merge in the product checkout from Bash.
  assert.equal(await bash(withMerge, `cd ${WS}/main && git merge x`), "deny");
});

test("with no separate product checkout (a non-git mesh) the gate draws no line", async () => {
  const gate = buildPermissionGate(["test.execute", "git.commit"], undefined, { cwd: WS });
  assert.equal(await bash(gate, "git merge x && git push"), "allow", "the seat's directory IS the product there, and there is no merge op to route through");
});

test("the supervisor tells each seat's runtime where the product checkout is, in git mode only", { skip: gitSkip }, async () => {
  const agents = [{ id: "dev", role: "developer", capabilities: ["repository.write", "test.execute"], interests: [] }];
  type WithContext = { buildRuntimeContext(id: string): Promise<{ productPath?: string; workspacePath: string }> };
  const git = await makeMesh({ agents, mayContact: {}, mode: "parked", git: true });
  try {
    const ctx = await (git.supervisor as unknown as WithContext).buildRuntimeContext("dev");
    assert.equal(ctx.productPath, git.productPath, "the seat's runtime is told which directory work reaches only through the merge op");
    assert.notEqual(ctx.workspacePath, ctx.productPath, "and the seat itself works in a worktree of its own");
  } finally {
    await git.cleanup();
  }
  const plain = await makeMesh({ agents, mayContact: {}, mode: "parked" });
  try {
    const ctx = await (plain.supervisor as unknown as WithContext).buildRuntimeContext("dev");
    assert.equal(ctx.productPath, undefined, "a mesh with no git workspace has no separate product checkout to protect");
  } finally {
    await plain.cleanup();
  }
});
