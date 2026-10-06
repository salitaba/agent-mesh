/**
 * A first visit makes a project from the dashboard: `GET /api/templates` says what can be made and where it would be
 * written, and `POST /api/projects { template }` makes it.
 *
 * What is held here is what makes that safe to put behind a button: the template is chosen from a closed set and is never
 * a path; the folder is judged by where it really is; a mesh.yaml (or a prompt) that is already there is never replaced;
 * a refusal leaves nothing behind and says why in a sentence the page can show.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { startHostServer, type HostHandle } from "../../apps/mesh-server/src/host";
import { GOAL_MAX, accountUrlOf, createFromTemplate, defaultParent, expandHome, modelAccessFound, projectErrorReason, readGoal, suggestRoot, withGoal } from "../../apps/mesh-server/src/new-project";
import { defaultMeshTemplate, findShippedRoot, describeTemplates, parseMeshSource, resolveConfig } from "../../packages/config/src/index";

const SHIPPED = findShippedRoot(__dirname)!;

function call(base: string, method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: Number(u.port), method, path: p, headers: { "content-type": "application/json", ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        let json: any;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

const ENV_KEYS = ["HOME", "MESH_PROJECTS_ROOT", "MESH_API_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_OAUTH_TOKEN", "CURULE_ACCOUNT_URL", "CURULE_GATEWAY_URL", "CURULE_GATEWAY_KEY", "CURULE_MODEL_PROVIDER", "CURULE_MODEL_NAME", "CURULE_MODEL_KEY"] as const;

interface Layout {
  base: string;
  /** What `~` means to the host in this test, and so where unconfined suggestions go. */
  home: string;
  projects: string;
  outside: string;
  host: HostHandle;
}

async function withHost(
  fn: (l: Layout) => Promise<void>,
  opts: { confined?: boolean; shippedRoot?: string | null; env?: Record<string, string> } = {},
): Promise<void> {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-templates-"));
  const home = path.join(base, "user-home");
  const projects = path.join(base, "projects");
  const outside = path.join(base, "elsewhere");
  for (const d of [home, projects, outside]) fs.mkdirSync(d);
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.HOME = home;
  if (opts.confined) process.env.MESH_PROJECTS_ROOT = projects;
  Object.assign(process.env, opts.env ?? {});
  const hostOptions: Parameters<typeof startHostServer>[0] = { home: path.join(base, "home"), port: 0, dashboardDir: path.join(base, "none") };
  if (opts.shippedRoot !== undefined) hostOptions.shippedRoot = opts.shippedRoot;
  const host = await startHostServer(hostOptions);
  try {
    await fn({ base, home, projects, outside, host });
  } finally {
    await host.close();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(base, { recursive: true, force: true });
  }
}

/** Every file and folder under `dir`, relative and sorted: what a refusal must leave exactly as it was. */
function listing(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true })
    .map(String)
    .sort();
}

const post = (l: Layout, body: unknown) => call(l.host.url, "POST", "/api/projects", body);

test("the welcome is told what can be made: the default team, then each example, each with the folder it would use", { timeout: 30_000 }, async () => {
  await withHost(async (l) => {
    const r = await call(l.host.url, "GET", "/api/templates");
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const ids: string[] = r.json.templates.map((t: { id: string }) => t.id);
    assert.deepEqual(ids, describeTemplates(SHIPPED).map((t) => t.id), "the closed set is the install's own list");
    assert.equal(ids[0], "default");
    assert.ok(ids.includes("demo-stub"));
    const demo = r.json.templates.find((t: { id: string }) => t.id === "demo-stub");
    assert.equal(demo.needsApiKey, false);
    assert.equal(demo.seats, 7);
    assert.equal(r.json.templates[0].needsApiKey, true);
    // Unconfined, new projects are suggested under the user's home, in a folder that does not exist yet.
    assert.equal(r.json.defaultParent, path.join(l.home, "curule-projects"));
    assert.equal(r.json.confined, false);
    assert.equal(demo.suggestedRoot, path.join(l.home, "curule-projects", "demo-stub"));
    assert.equal(fs.existsSync(demo.suggestedRoot), false, "asking what would be written writes nothing");
    assert.equal(fs.existsSync(path.join(l.home, "curule-projects")), false);
  });
});

test("on a server confined to a projects directory, suggestions are under it", { timeout: 30_000 }, async () => {
  await withHost(async (l) => {
    const r = await call(l.host.url, "GET", "/api/templates");
    assert.equal(r.json.confined, true);
    assert.equal(r.json.defaultParent, fs.realpathSync(l.projects));
    assert.ok(r.json.templates.every((t: { suggestedRoot: string }) => t.suggestedRoot.startsWith(fs.realpathSync(l.projects) + path.sep)));
  }, { confined: true });
});

test("the host says whether a Claude-runtime team could reach a model, by the names of the settings and never their values", { timeout: 30_000 }, async () => {
  await withHost(async (l) => {
    assert.deepEqual((await call(l.host.url, "GET", "/api/templates")).json.modelAccess, []);
  });
  await withHost(async (l) => {
    const r = await call(l.host.url, "GET", "/api/templates");
    assert.deepEqual(r.json.modelAccess, ["ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK"]);
    assert.doesNotMatch(JSON.stringify(r.json), /sk-ant-SECRET/, "never the value");
  }, { env: { ANTHROPIC_API_KEY: "sk-ant-SECRET", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_VERTEX: "0" } });
  assert.deepEqual(modelAccessFound({ ANTHROPIC_API_KEY: "  ", CLAUDE_CODE_USE_FOUNDRY: "TRUE", ANTHROPIC_BASE_URL: "http://gateway" }), ["CLAUDE_CODE_USE_FOUNDRY"], "blank is unset; a base URL alone is not a way in");
});

test("a host the hosted service made says where the account page is, so its console can welcome a customer and send them there; any other host says nothing of the kind", { timeout: 30_000 }, async () => {
  await withHost(async (l) => {
    const r = await call(l.host.url, "GET", "/api/templates");
    assert.equal(r.json.hosted, undefined, "a laptop's host is not a workspace");
    assert.equal("hosted" in r.json, false);
  });
  await withHost(async (l) => {
    const r = await call(l.host.url, "GET", "/api/templates");
    assert.deepEqual(r.json.hosted, { accountUrl: "https://app.curule.example/account" });
    // Being a workspace is a fact of its own: a workspace whose customer has not added a model key yet has none of the model facts.
    assert.equal(r.json.managed, false);
    assert.deepEqual(r.json.modelAccess, []);
  }, { env: { CURULE_ACCOUNT_URL: "https://app.curule.example/account" } });
  await withHost(async (l) => {
    const r = await call(l.host.url, "GET", "/api/templates");
    assert.deepEqual(r.json.hosted, { accountUrl: "https://app.curule.example/account" });
    assert.equal(r.json.managed, true);
    assert.equal(r.json.modelSource, "gateway");
  }, { env: { CURULE_ACCOUNT_URL: "https://app.curule.example/account", CURULE_GATEWAY_URL: "https://gateway.curule.example/v1", CURULE_GATEWAY_KEY: "curule_vk_000000000000_SECRET" } });
});

test("the account page's address is passed on only when it is one a link may safely carry", () => {
  const of = (v: string | undefined) => accountUrlOf(v === undefined ? {} : { CURULE_ACCOUNT_URL: v });
  assert.equal(of("https://app.curule.example/account"), "https://app.curule.example/account");
  assert.equal(of("  http://localhost:7870/account  "), "http://localhost:7870/account", "a trial's address, with the blanks a shell leaves");
  for (const bad of [undefined, "", "   ", "app.curule.example/account", "/account", "javascript:alert(1)", "data:text/html,x", "ftp://app.curule.example/", "file:///etc/passwd", "https://user:secret@app.curule.example/account", "https://:secret@app.curule.example/", "http://", "not a url"]) {
    assert.equal(of(bad), undefined, JSON.stringify(bad));
  }
});

test("the demo is made in the folder named, registered, self-contained, and reported as scaffolded", { timeout: 30_000 }, async () => {
  await withHost(async (l) => {
    const target = path.join(l.outside, "my-demo");
    const r = await post(l, { template: "demo-stub", root: target });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.scaffolded, true);
    assert.equal(r.json.template, "demo-stub");
    assert.equal(r.json.id, "my-demo", "the folder's name is the project's id");
    assert.equal(r.json.root, fs.realpathSync(target));
    const text = fs.readFileSync(path.join(target, "mesh.yaml"), "utf8");
    assert.doesNotMatch(text, /\.\.\//, "nothing in it reaches outside the folder");
    assert.equal(fs.readdirSync(path.join(target, "roles")).length, 7);
    assert.doesNotThrow(() => resolveConfig(path.join(target, "mesh.yaml")));
    const listed = await call(l.host.url, "GET", "/api/projects");
    assert.deepEqual(listed.json.projects.map((p: { id: string }) => p.id), ["my-demo"]);
  });
});

const PLACEHOLDER_BLOCK = "  goal: |\n    Describe the mission goal here.\n";
const goalOf = (dir: string): string => parseMeshSource(fs.readFileSync(path.join(dir, "mesh.yaml"), "utf8")).mesh.goal;

test("a goal given with the team goes into its mesh.yaml in place of the placeholder, and nothing else in the file changes", { timeout: 30_000 }, async () => {
  await withHost(async (l) => {
    const target = path.join(l.outside, "launch-report");
    const r = await post(l, { template: "default", root: target, goal: "  Write a short, sourced report on how small teams review code.  \n" });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const text = fs.readFileSync(path.join(target, "mesh.yaml"), "utf8");
    assert.equal(goalOf(target), "Write a short, sourced report on how small teams review code.", "trimmed, and exactly what was typed otherwise");
    assert.doesNotMatch(text, /Describe the mission goal here/);
    // The file is the default team's, byte for byte, but for the goal's own lines: comments, seats and budgets are untouched.
    const template = defaultMeshTemplate("launch-report", "launch-report", "claude");
    assert.ok(template.includes(PLACEHOLDER_BLOCK), "the placeholder this test replaces is the one the template writes");
    assert.equal(text, template.replace(PLACEHOLDER_BLOCK, "  goal: |-\n    Write a short, sourced report on how small teams review code.\n"));
    assert.doesNotThrow(() => resolveConfig(path.join(target, "mesh.yaml")));
    assert.ok(fs.existsSync(path.join(target, "roles", "architect.md")), "the team is still the default team");
    // The project the host registered boots from this file, so the mission it mints is for this goal: nothing to save and apply first.
    assert.equal((await call(l.host.url, "GET", "/api/projects")).json.projects[0].id, "launch-report");
  });
});

test("a goal of several lines, with what a person pastes in it, reads back exactly as it was typed", { timeout: 30_000 }, async () => {
  await withHost(async (l) => {
    const typed = "Build a tool that:\r\n- reads a CSV\r\n\r\n  - and checks it: # not a comment\r\n--- not a document marker\r\n\t1. tabbed \"quoted\" 'single' ünïcode 😀";
    const want = "Build a tool that:\n- reads a CSV\n\n  - and checks it: # not a comment\n--- not a document marker\n 1. tabbed \"quoted\" 'single' ünïcode 😀";
    const target = path.join(l.outside, "multi");
    const r = await post(l, { template: "default", root: target, goal: typed });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(goalOf(target), want, "line ends are one kind and a tab is a space; every other character is kept");
    assert.doesNotThrow(() => resolveConfig(path.join(target, "mesh.yaml")));
  });
});

test("no goal, or a blank one, leaves the placeholder for the Designer to ask about, as before", { timeout: 30_000 }, async () => {
  await withHost(async (l) => {
    let n = 0;
    for (const goal of [undefined, null, "", "   \n\t  "]) {
      const target = path.join(l.outside, `none-${n++}`);
      const r = await post(l, { template: "default", root: target, ...(goal === undefined ? {} : { goal }) });
      assert.equal(r.status, 201, JSON.stringify(goal));
      assert.equal(goalOf(target).trim(), "Describe the mission goal here.", JSON.stringify(goal));
      assert.equal(fs.readFileSync(path.join(target, "mesh.yaml"), "utf8"), defaultMeshTemplate(`none-${n - 1}`, `none-${n - 1}`, "claude"), "the file is exactly what a request with no goal has always written");
    }
  });
});

test("a goal that is not text, is too long or holds what is not text is refused with a sentence, before anything is written", { timeout: 30_000 }, async () => {
  await withHost(async (l) => {
    const target = path.join(l.outside, "refused");
    const before = listing(l.base);
    const attempts: Array<[unknown, string]> = [
      [42, "bad_goal"], [true, "bad_goal"], [["a goal"], "bad_goal"], [{ text: "a goal" }, "bad_goal"],
      ["x".repeat(GOAL_MAX + 1), "goal_too_long"], [`${"x".repeat(GOAL_MAX)}\n  `.repeat(1) + "y", "goal_too_long"],
      ["a\u0000b", "bad_goal"], ["esc \u001b[31mred", "bad_goal"], ["bell \u0007", "bad_goal"], ["del \u007f", "bad_goal"], ["c1 \u0085 break", "bad_goal"], ["sep \u2028 line", "bad_goal"], ["sep \u2029 para", "bad_goal"],
    ];
    for (const [goal, code] of attempts) {
      const r = await post(l, { template: "default", root: target, goal });
      assert.equal(r.status, 400, JSON.stringify(goal).slice(0, 40));
      assert.equal(r.json.code, code, JSON.stringify(goal).slice(0, 40));
      assert.equal(r.json.error, r.json.reason);
      assert.match(r.json.reason, /^[A-Z].*[.!?]$/, "one sentence a page can show as it is");
    }
    assert.match((await post(l, { template: "default", root: target, goal: "x".repeat(GOAL_MAX + 1) })).json.reason, /2,001 characters.*2,000/);
    assert.equal(fs.existsSync(target), false, "no folder, no mesh.yaml");
    assert.deepEqual(listing(l.base), before, "nothing anywhere changed");
    assert.deepEqual((await call(l.host.url, "GET", "/api/projects")).json.projects, []);
    // The most a goal can be is allowed, and a long one is fine.
    const longest = "y".repeat(GOAL_MAX);
    assert.equal((await post(l, { template: "default", root: path.join(l.outside, "longest"), goal: longest })).status, 201);
    assert.equal(goalOf(path.join(l.outside, "longest")), longest);
  });
});

test("a goal is for the default team: a shipped example has the goal its scripts were written for, and is refused another", { timeout: 30_000 }, async () => {
  await withHost(async (l) => {
    const target = path.join(l.outside, "demo");
    const r = await post(l, { template: "demo-stub", root: target, goal: "Something else entirely." });
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.equal(r.json.code, "goal_not_for_template");
    assert.match(r.json.reason, /comes with a goal of its own/);
    assert.equal(fs.existsSync(target), false, "nothing written");
    // A blank goal says nothing, so it is not a conflict: the demo is made as it always is.
    const ok = await post(l, { template: "demo-stub", root: target, goal: "  " });
    assert.equal(ok.status, 201, JSON.stringify(ok.json));
    assert.equal(goalOf(target).trim(), "Build and ship a small idempotent payment endpoint.", "its own goal, as written");
  });
});

test("on a host that was given its models, the team is made on them and with the goal that was given", { timeout: 30_000 }, async () => {
  await withHost(async (l) => {
    const target = path.join(l.projects, "managed-team");
    const r = await post(l, { template: "default", root: target, goal: "Review the open pull requests and say which are ready." });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const raw = parseMeshSource(fs.readFileSync(path.join(target, "mesh.yaml"), "utf8"));
    assert.equal(raw.mesh.goal, "Review the open pull requests and say which are ready.");
    assert.equal(raw.mesh.runtime?.default, "native", "the managed rewrite and the goal are both in the one file");
  }, { confined: true, env: { CURULE_GATEWAY_URL: "https://gateway.curule.example/v1", CURULE_GATEWAY_KEY: "curule_vk_000000000000_SECRET" } });
});

test("the goal helpers: what is read, what is written, and that a goal set twice is the second", () => {
  assert.deepEqual(readGoal(undefined), { ok: true, goal: null });
  assert.deepEqual(readGoal(null), { ok: true, goal: null });
  assert.deepEqual(readGoal("  hi  "), { ok: true, goal: "hi" });
  assert.deepEqual(readGoal("a\r\nb\rc\td"), { ok: true, goal: "a\nb\nc d" });
  assert.equal(readGoal("x".repeat(GOAL_MAX)).ok, true);
  assert.equal(readGoal("x".repeat(GOAL_MAX + 1)).ok, false);
  const text = defaultMeshTemplate("my-mesh", "my-mesh", "claude");
  const once = withGoal(text, "First.");
  assert.equal(parseMeshSource(withGoal(once, "Second.\nWith a second line.")).mesh.goal, "Second.\nWith a second line.");
  assert.equal(withGoal(text, "Describe the mission goal here."), text.replace(PLACEHOLDER_BLOCK, "  goal: |-\n    Describe the mission goal here.\n"), "only the block's own marker differs");
});

test("without a folder, the template goes where the welcome said it would, and a second one does not collide with the first", { timeout: 30_000 }, async () => {
  await withHost(async (l) => {
    const offer = (await call(l.host.url, "GET", "/api/templates")).json.templates.find((t: { id: string }) => t.id === "demo-stub");
    const first = await post(l, { template: "demo-stub" });
    assert.equal(first.status, 201, JSON.stringify(first.json));
    assert.equal(first.json.root, offer.suggestedRoot, "the folder it said, not another");
    assert.equal(first.json.id, "demo-stub");
    const next = (await call(l.host.url, "GET", "/api/templates")).json.templates.find((t: { id: string }) => t.id === "demo-stub");
    assert.equal(next.suggestedRoot, path.join(l.home, "curule-projects", "demo-stub-2"), "the next suggestion is free");
    const second = await post(l, { template: "demo-stub" });
    assert.equal(second.status, 201, JSON.stringify(second.json));
    assert.equal(second.json.id, "demo-stub-2", "two projects, two ids");
  });
});

test("the default team is made on the Claude runtime in the folder named, under the folder's name", { timeout: 30_000 }, async () => {
  await withHost(async (l) => {
    const target = path.join(l.outside, "payments");
    const r = await post(l, { template: "default", root: target });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const raw = parseMeshSource(fs.readFileSync(path.join(target, "mesh.yaml"), "utf8"));
    assert.equal(raw.project?.id, "payments");
    assert.equal(raw.mesh.runtime?.default, "claude");
    assert.ok(fs.existsSync(path.join(target, "roles", "architect.md")));
  });
});

test("a template that is not in the set is refused, whatever it looks like, and nothing is written anywhere", { timeout: 30_000 }, async () => {
  await withHost(async (l) => {
    const target = path.join(l.outside, "never");
    const before = [listing(l.base), listing(SHIPPED + "/examples")];
    const attempts: unknown[] = [
      "nope", "../examples/demo-stub", "demo-stub/../greenfield", "demo-stub/..", "/etc/passwd", "..", ".", "", " ", "DEMO-STUB",
      "__proto__", "constructor", "toString", 7, null, true, ["demo-stub"], { id: "demo-stub" }, "demo-stub\u0000",
    ];
    for (const template of attempts) {
      const r = await post(l, { template, root: target });
      assert.equal(r.status, 400, JSON.stringify(template));
      assert.equal(r.json.code, "unknown_template", JSON.stringify(template));
      assert.match(r.json.reason, /does not offer that starting point/);
      assert.equal(r.json.error, r.json.reason);
    }
    assert.equal(fs.existsSync(target), false);
    assert.deepEqual([listing(l.base), listing(SHIPPED + "/examples")], before, "no file or folder anywhere changed");
    assert.deepEqual((await call(l.host.url, "GET", "/api/projects")).json.projects, []);
  });
});

test("an install that ships no examples offers the default team only, and the demo is refused rather than guessed at", { timeout: 30_000 }, async () => {
  await withHost(async (l) => {
    const r = await call(l.host.url, "GET", "/api/templates");
    assert.deepEqual(r.json.templates.map((t: { id: string }) => t.id), ["default"]);
    const target = path.join(l.outside, "demo");
    const refused = await post(l, { template: "demo-stub", root: target });
    assert.equal(refused.status, 400);
    assert.equal(refused.json.code, "unknown_template");
    assert.equal(fs.existsSync(target), false);
  }, { shippedRoot: null });
});

test("a folder that already holds a mesh.yaml is refused, untouched, and not quietly registered", { timeout: 30_000 }, async () => {
  await withHost(async (l) => {
    const target = path.join(l.outside, "mine");
    fs.mkdirSync(path.join(target, "roles"), { recursive: true });
    fs.writeFileSync(path.join(target, "mesh.yaml"), "keep: me\n");
    fs.writeFileSync(path.join(target, "roles", "pm.md"), "mine\n");
    const before = listing(target);
    for (const template of ["demo-stub", "default"]) {
      const r = await post(l, { template, root: target });
      assert.equal(r.status, 409, template);
      assert.equal(r.json.code, "exists");
      assert.match(r.json.reason, /already holds a mesh\.yaml, so nothing was written/);
      assert.match(r.json.reason, /Add an existing folder/, "and says what to do instead");
    }
    assert.equal(fs.readFileSync(path.join(target, "mesh.yaml"), "utf8"), "keep: me\n");
    assert.equal(fs.readFileSync(path.join(target, "roles", "pm.md"), "utf8"), "mine\n");
    assert.deepEqual(listing(target), before);
    assert.deepEqual((await call(l.host.url, "GET", "/api/projects")).json.projects, [], "refused means not registered");
  });
});

test("a prompt the folder already has is kept when the demo is written beside it", { timeout: 30_000 }, async () => {
  await withHost(async (l) => {
    const target = path.join(l.outside, "has-roles");
    fs.mkdirSync(path.join(target, "roles"), { recursive: true });
    fs.writeFileSync(path.join(target, "roles", "qa.md"), "my qa\n");
    const r = await post(l, { template: "demo-stub", root: target });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(fs.readFileSync(path.join(target, "roles", "qa.md"), "utf8"), "my qa\n");
  });
});

test("the project id is checked before anything is written: a clash leaves no files behind", { timeout: 30_000 }, async () => {
  await withHost(async (l) => {
    const first = path.join(l.outside, "one", "team");
    assert.equal((await post(l, { template: "demo-stub", root: first })).status, 201);
    const second = path.join(l.outside, "two", "team");
    const r = await post(l, { template: "default", root: second });
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.equal(r.json.code, "duplicate_id");
    assert.match(r.json.reason, /"team" is already on this host/);
    assert.equal(fs.existsSync(second), false, "no folder, no mesh.yaml");
  });
});

test("a folder is named by its full path: `~` is the host user's home, anything else relative is refused", { timeout: 30_000 }, async () => {
  await withHost(async (l) => {
    // A name of its own under the working directory, so a stray earlier run cannot make this pass or fail, and cleaned up
    // either way: if the guard were ever lost, this is where the host would write.
    const stray = `mesh-relative-${process.pid}-${Date.now().toString(36)}`;
    try {
      const refused = await post(l, { template: "demo-stub", root: `${stray}/demo` });
      assert.equal(refused.status, 400);
      assert.equal(refused.json.code, "relative_path");
      assert.match(refused.json.reason, /full path/);
      assert.equal(fs.existsSync(path.join(process.cwd(), stray)), false, "not made under the host's working directory");
    } finally {
      fs.rmSync(path.join(process.cwd(), stray), { recursive: true, force: true });
    }

    const viaTilde = await post(l, { template: "demo-stub", root: "~/work/demo" });
    assert.equal(viaTilde.status, 201, JSON.stringify(viaTilde.json));
    assert.ok(fs.existsSync(path.join(l.home, "work", "demo", "mesh.yaml")));

    const notText = await post(l, { template: "demo-stub", root: 42 });
    assert.equal(notText.status, 400);
    assert.equal(notText.json.code, "bad_root");
  });
  assert.equal(expandHome("~", { HOME: "/h" }), "/h");
  assert.equal(expandHome("~/a/b", { HOME: "/h" }), path.join("/h", "a", "b"));
  assert.equal(expandHome("~other/a", { HOME: "/h" }), "~other/a", "another user's home is not guessed at");
  assert.equal(expandHome("/abs", { HOME: "/h" }), "/abs");
});

test("a confined server makes projects only under its projects directory, and a refusal writes nothing", { timeout: 30_000 }, async () => {
  await withHost(async (l) => {
    const ok = await post(l, { template: "demo-stub", root: path.join(l.projects, "inside") });
    assert.equal(ok.status, 201, JSON.stringify(ok.json));

    const before = listing(l.outside);
    const out = await post(l, { template: "demo-stub", root: path.join(l.outside, "demo") });
    assert.equal(out.status, 403);
    assert.equal(out.json.code, "outside_projects_root");
    assert.match(out.json.reason, /MESH_PROJECTS_ROOT/);
    assert.deepEqual(listing(l.outside), before);

    fs.symlinkSync(l.outside, path.join(l.projects, "door"));
    const viaLink = await post(l, { template: "default", root: path.join(l.projects, "door", "never-made") });
    assert.equal(viaLink.status, 403, "judged by where it really is");
    assert.equal(fs.existsSync(path.join(l.outside, "never-made")), false);

    const dotdot = await post(l, { template: "default", root: `${l.projects}/../elsewhere/up` });
    assert.equal(dotdot.status, 403);
    assert.equal(fs.existsSync(path.join(l.outside, "up")), false);

    // The folder picker is refused outside it too, with the same sentence.
    const browse = await call(l.host.url, "GET", `/api/browse?path=${encodeURIComponent(l.outside)}`);
    assert.equal(browse.status, 403);
    assert.equal(browse.json.code, "outside_projects_root");
    assert.equal(browse.json.reason, out.json.reason, "one sentence for every route that judges a folder");

    // No folder named: the suggestion is under the projects directory, so it is allowed.
    const suggested = await post(l, { template: "demo-stub" });
    assert.equal(suggested.status, 201, JSON.stringify(suggested.json));
    assert.ok(suggested.json.root.startsWith(fs.realpathSync(l.projects) + path.sep));
  }, { confined: true });
});

test("a path that is a file, or a folder this host cannot write to, is a sentence, not a stack trace", { timeout: 30_000 }, async () => {
  await withHost(async (l) => {
    const file = path.join(l.outside, "plain-file");
    fs.writeFileSync(file, "x");
    const onFile = await post(l, { template: "default", root: path.join(file, "inside") });
    assert.equal(onFile.status, 500);
    assert.equal(onFile.json.code, "cannot_write");
    assert.match(onFile.json.reason, /part of that path is a file, not a folder/);
    assert.equal(onFile.json.error, onFile.json.reason);
    assert.equal(fs.readFileSync(file, "utf8"), "x");
  });
});

test("the older ways of adding a folder still work, and their refusals now carry a reason", { timeout: 30_000 }, async () => {
  await withHost(async (l) => {
    const noRoot = await post(l, {});
    assert.equal(noRoot.status, 400);
    assert.equal(noRoot.json.code, "no_root");
    assert.equal(noRoot.json.reason, "Give the folder to add.");

    const empty = path.join(l.outside, "empty");
    fs.mkdirSync(empty);
    const missing = await post(l, { root: empty });
    assert.equal(missing.status, 400);
    assert.equal(missing.json.code, "missing", "the dashboard offers to create one on this code");
    assert.match(missing.json.reason, /^No mesh\.yaml in /);
    assert.equal(fs.existsSync(path.join(empty, "mesh.yaml")), false, "a plain add never writes");

    const init = await post(l, { root: empty, init: true });
    assert.equal(init.status, 201, JSON.stringify(init.json));
    assert.equal(init.json.scaffolded, true);

    const viaTilde = await post(l, { root: "~/nowhere-yet", init: true });
    assert.equal(viaTilde.status, 201, JSON.stringify(viaTilde.json));
    assert.ok(fs.existsSync(path.join(l.home, "nowhere-yet", "mesh.yaml")), "~ means home for the older add too");
  });
  await withHost(async (l) => {
    const out = await post(l, { root: path.join(l.outside, "x") });
    assert.equal(out.status, 403);
    assert.equal(out.json.code, "outside_projects_root");
    assert.match(out.json.reason, /Choose a folder there/);
  }, { confined: true });
});

test("the picker tells a folder that is not there from a file from one it cannot read, in the words the dashboard looks for", { timeout: 30_000 }, async () => {
  // The dashboard reads these codes out of the error text to say "does not exist yet" or "that is a file": hold them to the
  // real server, not to a copy of what it was thought to say.
  await withHost(async (l) => {
    const missing = await call(l.host.url, "GET", `/api/browse?path=${encodeURIComponent(path.join(l.outside, "not-yet"))}`);
    assert.equal(missing.status, 200);
    assert.match(missing.json.error, /ENOENT/);
    const file = path.join(l.outside, "a-file");
    fs.writeFileSync(file, "x");
    const onFile = await call(l.host.url, "GET", `/api/browse?path=${encodeURIComponent(file)}`);
    assert.match(onFile.json.error, /ENOTDIR/);
    const folder = await call(l.host.url, "GET", `/api/browse?path=${encodeURIComponent(l.outside)}`);
    assert.equal(folder.json.error, undefined);
    assert.equal(folder.json.hasMesh, false);
    fs.mkdirSync(path.join(l.outside, "has-mesh"));
    fs.writeFileSync(path.join(l.outside, "has-mesh", "mesh.yaml"), "x");
    assert.equal((await call(l.host.url, "GET", `/api/browse?path=${encodeURIComponent(path.join(l.outside, "has-mesh"))}`)).json.hasMesh, true);
    // `~` means the same here as where a folder is added.
    assert.equal((await call(l.host.url, "GET", `/api/browse?path=${encodeURIComponent("~")}`)).json.path, l.home);
    const sub = path.join(l.home, "work");
    fs.mkdirSync(sub);
    assert.equal((await call(l.host.url, "GET", `/api/browse?path=${encodeURIComponent("~/work")}`)).json.path, sub);
  });
});

test("the routes are behind the operator token like every other /api route", { timeout: 30_000 }, async () => {
  await withHost(async (l) => {
    const token = "t".repeat(40);
    assert.equal((await call(l.host.url, "GET", "/api/templates")).status, 401);
    assert.equal((await call(l.host.url, "POST", "/api/projects", { template: "demo-stub", root: path.join(l.outside, "d") })).status, 401);
    assert.equal(fs.existsSync(path.join(l.outside, "d")), false);
    assert.equal((await call(l.host.url, "GET", "/api/templates", undefined, { authorization: `Bearer ${token}` })).status, 200);
  }, { env: { MESH_API_TOKEN: "t".repeat(40) } });
});

test("the helpers: suggestions skip what exists and what is registered; reasons read as sentences", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-templates-unit-"));
  try {
    const env = { HOME: base } as NodeJS.ProcessEnv;
    const demo = describeTemplates(SHIPPED).find((t) => t.id === "demo-stub")!;
    const dflt = describeTemplates(SHIPPED)[0]!;
    assert.equal(defaultParent(env), path.join(base, "curule-projects"));
    assert.equal(suggestRoot(demo, new Set(), env), path.join(base, "curule-projects", "demo-stub"));
    assert.equal(suggestRoot(dflt, new Set(), env), path.join(base, "curule-projects", "my-mesh"));
    fs.mkdirSync(path.join(base, "curule-projects", "demo-stub"), { recursive: true });
    assert.equal(suggestRoot(demo, new Set(), env), path.join(base, "curule-projects", "demo-stub-2"), "the folder exists");
    assert.equal(suggestRoot(demo, new Set(["demo-stub-2"]), env), path.join(base, "curule-projects", "demo-stub-3"), "the id is registered");
    assert.equal(projectErrorReason("no mesh.yaml in /x"), "No mesh.yaml in /x.");
    assert.equal(projectErrorReason("clash", "Rename it. Then retry"), "Clash. Rename it. Then retry.");
    assert.equal(projectErrorReason("done.", ""), "Done.");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("createFromTemplate needs only a registry that lists and adds, so it is tested without a host", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-templates-direct-"));
  try {
    const added: string[] = [];
    const registry = {
      list: () => [],
      add: async (root: string) => {
        added.push(root);
        return { id: path.basename(root), name: "x", root, configPath: path.join(root, "mesh.yaml"), addedAt: "now" };
      },
    };
    const env = { HOME: base } as NodeJS.ProcessEnv;
    const made = await createFromTemplate({ template: "demo-stub", root: undefined }, { registry, shippedRoot: SHIPPED, env });
    assert.equal(made.ok, true);
    assert.deepEqual(added, [path.join(base, "curule-projects", "demo-stub")]);
    const none = await createFromTemplate({ template: "demo-stub", root: path.join(base, "x") }, { registry, shippedRoot: undefined, env });
    assert.equal(none.ok, false);
    assert.equal(added.length, 1, "refused means never registered");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
