/**
 * `curule init`: a first project that runs wherever it is put.
 *
 * The shipped examples point at the repository's `roles/` with `../../roles/...`. Copied anywhere else (a
 * container's data volume, a customer's repository) that finds no prompts and the project will not register.
 * Scaffolding an example must therefore produce something self-contained, for every example we ship.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { findShippedRoot, listExamples, runInitCommand, scaffoldExample } from "../../apps/mesh-cli/src/init";
import { main } from "../../apps/mesh-cli/src/index";
import { ConfigError, resolveConfig } from "../../packages/config/src/index";

const ROOT = findShippedRoot(__dirname)!;
const tmp = (label: string): string => fs.mkdtempSync(path.join(os.tmpdir(), `mesh-init-${label}-`));

function run(positional: string[], flags: Record<string, string | boolean> = {}, repoRoot: string | undefined = ROOT): { code: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const code = runInitCommand(positional, flags, { repoRoot, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
}

test("the shipped examples are found from a build and from the image's layout", () => {
  assert.ok(ROOT, "a directory holding examples/ and roles/ is above the compiled tests");
  const names = listExamples(ROOT);
  assert.ok(names.includes("demo-stub"), names.join(", "));
  assert.deepEqual([...names].sort(), names);
  const listed = run([], { list: true });
  assert.equal(listed.code, 0);
  assert.deepEqual(listed.out, names);
});

test("every shipped example scaffolds into a directory of its own and loads there", () => {
  for (const name of listExamples(ROOT)) {
    const dir = path.join(tmp(name), "project");
    const r = run([dir], { example: name });
    assert.equal(r.code, 0, `${name}: ${r.err.join(" ")}`);
    const text = fs.readFileSync(path.join(dir, "mesh.yaml"), "utf8");
    assert.doesNotMatch(text, /\.\.\/\.\.\/roles/, `${name} still points at the repository's roles/`);
    assert.doesNotMatch(text, /(^|[\s"':])\.\.\//m, `${name} still reaches outside itself`);
    const resolved = resolveConfig(path.join(dir, "mesh.yaml"));
    assert.ok(resolved.agentOrder.length > 0, name);
    for (const id of resolved.agentOrder) {
      const file = resolved.agents[id]!.prompt?.file;
      if (file) assert.ok(path.resolve(dir, file).startsWith(dir) && fs.existsSync(path.resolve(dir, file)), `${name}/${id}: its prompt ${file} is not a file inside the project`);
    }
    assert.ok(r.out.some((l) => l.startsWith("next: curule project add ")), name);
  }
});

test("a scaffolded example keeps its identity and survives being moved", () => {
  const home = tmp("move");
  const first = path.join(home, "first");
  assert.equal(run([first], { example: "demo-stub" }).code, 0);
  assert.match(fs.readFileSync(path.join(first, "mesh.yaml"), "utf8"), /^\s+id: demo-stub$/m, "the scripted demo team attaches by this id");
  assert.ok(fs.readdirSync(path.join(first, "roles")).length >= 5);
  const second = path.join(home, "somewhere", "else");
  fs.mkdirSync(path.dirname(second), { recursive: true });
  fs.renameSync(first, second);
  assert.doesNotThrow(() => resolveConfig(path.join(second, "mesh.yaml")), "no path in it is relative to where it used to be");
});

test("it never writes over a project that is already there", () => {
  const dir = tmp("exists");
  fs.writeFileSync(path.join(dir, "mesh.yaml"), "keep: me\n");
  assert.throws(() => run([dir], { example: "demo-stub" }), (e: unknown) => e instanceof ConfigError && /already exists/.test(e.message));
  assert.throws(() => run([dir]), (e: unknown) => e instanceof ConfigError && /already exists/.test(e.message));
  assert.equal(fs.readFileSync(path.join(dir, "mesh.yaml"), "utf8"), "keep: me\n");
});

test("an example that reaches outside itself, or names a role this install lacks, is refused with the line to blame", () => {
  const root = tmp("fake-root");
  fs.mkdirSync(path.join(root, "roles"), { recursive: true });
  fs.writeFileSync(path.join(root, "roles", "dev.md"), "# dev\n");
  fs.mkdirSync(path.join(root, "examples", "outside"), { recursive: true });
  fs.writeFileSync(path.join(root, "examples", "outside", "mesh.yaml"), "agents:\n  a:\n    prompt: ../../roles/dev.md\nmesh:\n  workspace:\n    path: ../elsewhere\n");
  fs.mkdirSync(path.join(root, "examples", "missing"), { recursive: true });
  fs.writeFileSync(path.join(root, "examples", "missing", "mesh.yaml"), "agents:\n  a:\n    prompt: ../../roles/ghost.md\n");
  assert.throws(() => scaffoldExample(root, "outside", tmp("t1")), (e: unknown) => e instanceof ConfigError && /refers outside itself.*\.\.\/elsewhere/.test(e.message));
  assert.throws(() => scaffoldExample(root, "missing", tmp("t2")), (e: unknown) => e instanceof ConfigError && /roles\/ghost\.md, which this install does not ship/.test(e.message));
});

test("--runtime stub writes a team that runs with no model calls; an unknown runtime is the caller's mistake", () => {
  const dir = path.join(tmp("stub"), "p");
  const r = run([dir], { runtime: "stub" });
  assert.equal(r.code, 0, r.err.join(" "));
  const text = fs.readFileSync(path.join(dir, "mesh.yaml"), "utf8");
  assert.match(text, /^\s+default: stub$/m);
  assert.doesNotMatch(text, /runtime: claude/);
  assert.equal(resolveConfig(path.join(dir, "mesh.yaml")).defaultRuntime, "stub");

  const claude = path.join(tmp("claude"), "p");
  assert.equal(run([claude]).code, 0);
  assert.match(fs.readFileSync(path.join(claude, "mesh.yaml"), "utf8"), /^\s+default: claude$/m, "the default is unchanged");

  for (const [flags, message] of [
    [{ runtime: "gpt" }, /--runtime must be one of claude, stub, not 'gpt'/],
    [{ runtime: true }, /--runtime needs a value/],
    [{ example: true }, /--example needs a value/],
    [{ example: "nope" }, /no example 'nope'\. Available: .*demo-stub/],
    [{ example: "demo-stub", runtime: "stub" }, /not both/],
  ] as Array<[Record<string, string | boolean>, RegExp]>) {
    const bad = run([path.join(tmp("bad"), "p")], flags);
    assert.equal(bad.code, 2, JSON.stringify(flags));
    assert.match(bad.err.join("\n"), message, JSON.stringify(flags));
  }
});

test("through the real argument parser: a value flag takes its value, --list takes none, and a path may come after", async () => {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    const dir = path.join(tmp("argv"), "p");
    assert.equal(await main(["init", "--runtime", "stub", dir]), 0);
    assert.equal(resolveConfig(path.join(dir, "mesh.yaml")).defaultRuntime, "stub");
    assert.equal(await main(["init", "--list", "ignored"]), 0);
    assert.ok(lines.includes("demo-stub"));
    const ex = path.join(tmp("argv2"), "p");
    assert.equal(await main(["init", ex, "--example", "greenfield"]), 0);
    assert.ok(fs.existsSync(path.join(ex, "roles")));
    assert.equal(await main(["init", path.join(tmp("argv3"), "p"), "--example", "nope"]), 2);
    assert.equal(await main(["init", ex]), 2, "an existing project is exit 2, the config error code");
  } finally {
    console.log = log;
  }
});
