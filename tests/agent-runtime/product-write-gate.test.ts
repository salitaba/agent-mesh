import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { productWriteDenial } from "../../packages/agent-runtime/src/landing-gate";
import { buildPermissionGate } from "../../packages/runtime-claude/src/index";

/**
 * A seat's file tools may not write into the product checkout.
 *
 * The landing gate kept a seat's SHELL from changing the product branch; the Edit and Write tools were
 * the other door, and its header said so ("the Edit tool ... [is] a different boundary"). The seventh
 * cronlite run's developer, its session resumed after a kill -9, edited `src/index.js` and
 * `test/index.test.js` by the absolute path of the product checkout (thirteen Edit calls, twelve of them
 * landed) instead of its own worktree's. Nothing refused it. The
 * changes were on no branch, `git merge` refused to run over them ("your local changes would be
 * overwritten") six times, and the seats spent nearly eight minutes and two escalation cards asking one
 * another to commit changes that were not theirs.
 *
 * Real directories, because the rule is about where a path RESOLVES: a relative spelling, a path that
 * does not exist yet, a symlink into the product, and a sibling that only shares a prefix with it.
 */

function layout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-pwg-"));
  const main = path.join(root, "main");
  const wt = path.join(root, "worktrees", "developer");
  fs.mkdirSync(path.join(main, "src"), { recursive: true });
  fs.mkdirSync(path.join(wt, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "main2"), { recursive: true });
  fs.writeFileSync(path.join(main, "src", "index.js"), "export {};\n");
  fs.writeFileSync(path.join(wt, "src", "index.js"), "export {};\n");
  return { root, main, wt, scope: { cwd: wt, productPath: main }, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const ctx = () => ({ signal: new AbortController().signal, toolUseID: "t", requestId: "r" });

test("the write that dirtied the product checkout in the live run is refused, and the refusal names the seat's own worktree", () => {
  const { main, wt, scope, done } = layout();
  try {
    const why = productWriteDenial(path.join(main, "src", "index.js"), scope);
    assert.ok(why);
    assert.match(why, /is in the product checkout \(.*main\), which changes only through the `merge` op/);
    assert.match(why, /it makes every later merge fail/);
    assert.ok(why.includes(`Write the file in your own worktree (${wt})`), why);
  } finally {
    done();
  }
});

test("every way of spelling a path into the product checkout is refused", () => {
  const { main, root, scope, done } = layout();
  try {
    const refused = [
      path.join(main, "src", "index.js"), // absolute, exists
      "../../main/src/index.js", // relative to the seat's own directory
      "./../../main/src/index.js",
      path.join(main, "src", "brand-new.js"), // a new file
      path.join(main, "new-dir", "deeper", "file.js"), // parents that do not exist either
      "../../main/new-dir/file.js",
      path.join(root, "worktrees", "..", "main", "src", "index.js"), // dot-dot through a sibling
    ];
    for (const target of refused) assert.ok(productWriteDenial(target, scope), `should be refused: ${target}`);
  } finally {
    done();
  }
});

test("a symlink that leads into the product checkout is the product checkout", () => {
  const { main, wt, scope, done } = layout();
  try {
    fs.symlinkSync(main, path.join(wt, "to-main"));
    assert.ok(productWriteDenial("to-main/src/index.js", scope), "an existing file through the link");
    assert.ok(productWriteDenial("to-main/src/new.js", scope), "a new file through the link");
    assert.ok(productWriteDenial("to-main/new-dir/x.js", scope), "a new directory through the link");
  } finally {
    done();
  }
});

test("everything else is allowed: the seat's own worktree, elsewhere, and a sibling that only shares a prefix", () => {
  const { root, main, wt, scope, done } = layout();
  try {
    for (const target of [
      "src/index.js",
      path.join(wt, "src", "index.js"),
      path.join(wt, "src", "new.js"),
      path.join(wt, "new-dir", "x.js"),
      path.join(root, "elsewhere", "notes.txt"),
      path.join(root, "main2", "x.js"), // `main2` starts with `main`; it is not inside it
      path.join(root, "main-notes.txt"),
      "",
    ]) {
      assert.equal(productWriteDenial(target, scope), null, `should be allowed: ${target || "(empty target)"}`);
    }
    assert.ok(main);
  } finally {
    done();
  }
});

test("a seat whose own directory IS the product checkout writes there: no worktree, no other place to write", () => {
  const { main, done } = layout();
  try {
    assert.equal(productWriteDenial("src/index.js", { cwd: main, productPath: main }), null);
    assert.equal(productWriteDenial(path.join(main, "src", "new.js"), { cwd: main, productPath: main }), null);
  } finally {
    done();
  }
});

test("the permission gate refuses Edit, Write and NotebookEdit into the product checkout, and allows them in the worktree", async () => {
  const { main, wt, scope, done } = layout();
  try {
    const gate = buildPermissionGate(["repository.write", "test.execute", "git.commit"], undefined, scope);
    const inProduct = path.join(main, "src", "index.js");
    const inWorktree = path.join(wt, "src", "index.js");

    for (const [tool, input] of [
      ["Edit", { file_path: inProduct, old_string: "a", new_string: "b" }],
      ["Write", { file_path: inProduct, content: "x" }],
      ["NotebookEdit", { notebook_path: path.join(main, "n.ipynb"), new_source: "x" }],
    ] as const) {
      const res = await gate(tool, { ...input }, ctx());
      assert.equal(res?.behavior, "deny", `${tool} into the product checkout`);
      assert.match(res?.behavior === "deny" ? res.message : "", new RegExp(`^${tool} denied: .*is in the product checkout`));
    }
    for (const [tool, input] of [
      ["Edit", { file_path: inWorktree, old_string: "a", new_string: "b" }],
      ["Write", { file_path: inWorktree, content: "x" }],
    ] as const) {
      assert.equal((await gate(tool, { ...input }, ctx()))?.behavior, "allow", `${tool} in the worktree`);
    }
    // Reading the product checkout is what a seat does to see what is on main.
    assert.equal((await gate("Read", { file_path: inProduct }, ctx()))?.behavior, "allow");
    assert.equal((await gate("Grep", { pattern: "x", path: main }, ctx()))?.behavior, "allow");
    // The shell is the landing gate's, and a write to a path outside the product is untouched.
    assert.equal((await gate("Bash", { command: "npm test" }, ctx()))?.behavior, "allow");
  } finally {
    done();
  }
});

test("without a product path (a mesh with no separate product checkout) the file tools draw no line", async () => {
  const { main, done } = layout();
  try {
    const gate = buildPermissionGate(["repository.write"], undefined, { cwd: main });
    assert.equal((await gate("Edit", { file_path: path.join(main, "src", "index.js"), old_string: "a", new_string: "b" }, ctx()))?.behavior, "allow");
    const none = buildPermissionGate(["repository.write"]);
    assert.equal((await none("Write", { file_path: path.join(main, "x.js"), content: "x" }, ctx()))?.behavior, "allow");
  } finally {
    done();
  }
});

test("a seat that holds no write capability is refused for that reason first, as before", async () => {
  const { main, scope, done } = layout();
  try {
    const gate = buildPermissionGate(["repository.read"], undefined, scope);
    const res = await gate("Edit", { file_path: path.join(main, "src", "index.js"), old_string: "a", new_string: "b" }, ctx());
    assert.equal(res?.behavior, "deny");
    assert.match(res?.behavior === "deny" ? res.message : "", /holds no write capability/);
  } finally {
    done();
  }
});
