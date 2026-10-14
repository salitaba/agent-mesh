import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { makeMesh, waitFor } from "../helpers";

/**
 * The playground: the owner's own terminal for the product a mesh delivered.
 *
 * The seats have always been able to run things (`test.execute`); the person who paid could not. A mesh delivered a CLI
 * whose own `--help` worked the moment someone typed it, and its operator had nowhere to type it — which is the gap
 * these routes close. They run in the product's checkout under the same hygiene as the script runner beside them
 * (`productRunEnv`: every `MESH_*` variable withheld, because the code being run was written by agents), and nothing
 * waits forever: a run is killed on a clock.
 */

test("playground: the product's own entry points are offered, and a command runs in its checkout", async () => {
  const { createHttpServer } = await import("../../apps/mesh-server/src/index");
  const m = await makeMesh({ agents: [{ id: "dev", role: "developer", interests: [] }], mayContact: { dev: [] } });
  const server = createHttpServer(m, { dashboardDir: undefined });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (body: unknown) =>
    fetch(`${base}/playground/exec`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
  // A delivered product, the way one looks: a checkout declaring how it is run. It goes where the server says the
  // product lives rather than where this test guesses — the layout is the server's to decide.
  const before = (await (await fetch(`${base}/playground/commands`)).json()) as { productRoot: string };
  const product = before.productRoot;
  fs.mkdirSync(product, { recursive: true });
  fs.writeFileSync(
    path.join(product, "package.json"),
    JSON.stringify({ name: "skillctl", bin: { skillctl: "bin/skillctl.js" }, scripts: { test: "node --test" } }),
    "utf8",
  );
    const offered = (await (await fetch(`${base}/playground/commands`)).json()) as { commands: Array<{ command: string; label: string; kind: string }> };
    assert.deepEqual(
      offered.commands,
      [
        { command: "node bin/skillctl.js --help", label: "run skillctl", kind: "bin" },
        { command: "npm run test", label: "test", kind: "script" },
      ],
      "the product's own declarations, so the operator does not have to guess a first command",
    );

    assert.equal((await post({ command: "   " })).status, 400, "an empty command is refused");

    const started = await post({ command: "pwd && echo hello from the product" });
    assert.equal(started.status, 201);
    const { runId } = (await started.json()) as { runId: string };
    assert.ok(runId, "the run is asynchronous: the request answers with its id");

    let run: { done: boolean; exitCode: number | null; log: string } = { done: false, exitCode: null, log: "" };
    await waitFor("the run to finish", async () => {
      run = (await (await fetch(`${base}/playground/exec/${runId}`)).json()) as typeof run;
      return run.done;
    }, 10_000);
    assert.equal(run.exitCode, 0, `it ran and succeeded: ${run.log}`);
    assert.match(run.log, /^\$ pwd && echo hello from the product\n/, "the log opens with what was typed, not with the shell that carried it");
    assert.ok(run.log.includes(product), `it ran in the product's own checkout: ${run.log}`);
    assert.match(run.log, /hello from the product/);

    const unknown = (await (await fetch(`${base}/playground/exec/run-nope`)).json()) as { error?: string };
    assert.equal(unknown.error, "unknown run");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await m.cleanup();
  }
});

/**
 * Two dead ends the owner hit on a phone, both from a run that is over as far as the page is concerned.
 *
 * The first is the console's own clock. The page asks for a run to be stopped after a minute, the host signals it, and
 * the run comes back with no exit code at all — which is exactly what a command that ended on a signal looks like. The
 * panel said "Ended by a signal", which is true and useless: nobody signalled it, the console did, on a clock the owner
 * was never told about, and a test suite that needs two minutes was being killed every time.
 *
 * The second is the run the page cannot see. Runs live in the host's memory and there is one at a time, so a reload (or a
 * script started from the Product page) leaves every button answering "a run is already in progress" with nothing to
 * press: no name, no Stop, and only the message. The refusal carries the run now, so the page can offer to end it.
 */
test("playground: a run the clock ended says so, and a refusal names the run that is in the way", async () => {
  const { createHttpServer } = await import("../../apps/mesh-server/src/index");
  const m = await makeMesh({ agents: [{ id: "dev", role: "developer", interests: [] }], mayContact: { dev: [] } });
  const server = createHttpServer(m, { dashboardDir: undefined });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (p: string, body: unknown) =>
    fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    // The product declares a script, so the Product page's own runner has something to be refused.
    const product = ((await (await fetch(`${base}/playground/commands`)).json()) as { productRoot: string }).productRoot;
    fs.mkdirSync(product, { recursive: true });
    fs.writeFileSync(path.join(product, "package.json"), JSON.stringify({ name: "skillctl", scripts: { test: "node --test" } }), "utf8");

    const long = await post("/playground/exec", { command: "sleep 30", timeoutMs: 1_000 });
    assert.equal(long.status, 201);
    const { runId, timeoutMs } = (await long.json()) as { runId: string; timeoutMs: number };
    assert.equal(timeoutMs, 1_000, "the host answers with the clock it will actually use");

    // The refusal while that run is in flight: the owner's next command, and the same answer from the script runner
    // beside it, because one run at a time is the host's rule for both.
    const refused = await post("/playground/exec", { command: "node bin/skillctl.js list" });
    assert.equal(refused.status, 409);
    const said = (await refused.json()) as { error?: string; run?: { id?: string; command?: string; startedAt?: number } };
    assert.equal(said.error, "a run is already in progress", "the sentence it always was");
    assert.equal(said.run?.id, runId, "and the run that is in the way, so the page can name it and stop it");
    assert.equal(said.run?.command, "sleep 30", "with what it is, not just that something is");
    assert.equal(typeof said.run?.startedAt, "number");
    const scriptRefused = (await (await post("/workspace/run", { script: "test" })).json()) as { run?: { id?: string } };
    assert.equal(scriptRefused.run?.id, runId, "the Product page's script runner is refused by the same run, and told so too");

    let run: { done: boolean; exitCode: number | null; timedOut?: boolean; timeoutMs?: number } = { done: false, exitCode: null };
    await waitFor("the clock to end the run", async () => {
      run = (await (await fetch(`${base}/playground/exec/${runId}`)).json()) as typeof run;
      return run.done;
    }, 10_000);
    assert.equal(run.exitCode, null, "a signalled run has no exit code");
    assert.equal(run.timedOut, true, "and the page is told the clock did it, not a person and not the command");
    assert.equal(run.timeoutMs, 1_000, "with the clock it was given, so the sentence can name a number");

    // A command that ends on its own is not marked: only the clock's own runs are.
    const short = await post("/playground/exec", { command: "echo done", timeoutMs: 60_000 });
    const { runId: shortId } = (await short.json()) as { runId: string };
    let done: { done: boolean; timedOut?: boolean; exitCode?: number | null } = { done: false };
    await waitFor("the short run to finish", async () => {
      done = (await (await fetch(`${base}/playground/exec/${shortId}`)).json()) as typeof done;
      return done.done;
    }, 10_000);
    assert.equal(done.exitCode, 0);
    assert.notEqual(done.timedOut, true, "a run nobody stopped is not reported as stopped");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await m.cleanup();
  }
});


/**
 * Stop has to stop the command, not the shell that carried it.
 *
 * `sh -c "<command>"` forks for anything but the simplest command, and `killRun` signalled the leader alone: the command
 * outlived its own run. Found by timing the suite — the file took thirty seconds longer than its tests, because the
 * `sleep` a killed run had started still held the output pipe open. On a phone that is a dev server still holding its
 * port and a test suite still burning CPU, under a chip that says "Stopped".
 */
test("playground: Stop ends the whole command, not only the shell that started it", async () => {
  const { createHttpServer } = await import("../../apps/mesh-server/src/index");
  const m = await makeMesh({ agents: [{ id: "dev", role: "developer", interests: [] }], mayContact: { dev: [] } });
  const server = createHttpServer(m, { dashboardDir: undefined });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (p: string, body: unknown) =>
    fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    const product = ((await (await fetch(`${base}/playground/commands`)).json()) as { productRoot: string }).productRoot;
    fs.mkdirSync(product, { recursive: true });
    const pidFile = path.join(product, "grandchild.pid");
    // A command of the shape a product's own dev server has: a process that starts another one and waits for it.
    const started = await post("/playground/exec", { command: "sh -c 'sleep 60 & echo $! > grandchild.pid; wait'", timeoutMs: 60_000 });
    assert.equal(started.status, 201);
    const { runId } = (await started.json()) as { runId: string };

    await waitFor("the command to start its own child", async () => fs.existsSync(pidFile), 10_000);
    const grandchild = Number(fs.readFileSync(pidFile, "utf8").trim());
    assert.ok(grandchild > 0, "the command recorded the child it started");
    assert.equal(alive(grandchild), true, "which is running, as a command that is still going has one that is");

    assert.equal((await post(`/workspace/run/kill/${runId}`, {})).status, 200, "the run is stopped");
    let run: { done: boolean; exitCode: number | null } = { done: false, exitCode: null };
    await waitFor("the run to end", async () => {
      run = (await (await fetch(`${base}/playground/exec/${runId}`)).json()) as typeof run;
      return run.done;
    }, 10_000);
    assert.equal(run.exitCode, null, "it was signalled rather than finished");
    await waitFor("the child the command started to be gone with it", async () => !alive(grandchild), 10_000);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await m.cleanup();
  }
});

/**
 * A product's own UI is a page too.
 *
 * The console only ever looked at `apps/playground/index.html`, so a product that built a real UI somewhere ordinary —
 * `public/`, served by its own command — was invisible: its owner reported "my mesh also have /public/index.html, I
 * can't see it in playground", while the panel said the checkout had none. The console now looks where products actually
 * put pages, names the one it found, and mends the root-absolute references a page written for its own server carries,
 * so it arrives styled instead of inert.
 */
test("playground: a page the product keeps at public/ is found, served, and its absolute references mended", async () => {
  const { createHttpServer } = await import("../../apps/mesh-server/src/index");
  const m = await makeMesh({ agents: [{ id: "dev", role: "developer", interests: [] }], mayContact: { dev: [] } });
  const server = createHttpServer(m, { dashboardDir: undefined });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const get = (p: string) => fetch(`${base}${p}`);
  try {
    const product = ((await (await get("/playground/commands")).json()) as { productRoot: string }).productRoot;
    fs.mkdirSync(path.join(product, "public"), { recursive: true });
    fs.writeFileSync(
      path.join(product, "public", "index.html"),
      [
        "<!doctype html>",
        '<link rel="stylesheet" href="/style.css">',
        '<script src="/app.js"></script>',
        '<script src="/api/not-a-file.js"></script>',
        "<title>the product's own ui</title>",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(path.join(product, "public", "style.css"), "body{color:red}", "utf8");
    fs.writeFileSync(path.join(product, "public", "app.js"), "console.log('the ui')", "utf8");

    const offered = (await (await get("/playground/commands")).json()) as {
      page: { dir: string; file: string } | null;
      alternates: Array<{ file: string }>;
    };
    assert.deepEqual(offered.page, { dir: "public", file: "public/index.html" }, "the panel is told which page it will open");
    assert.deepEqual(offered.alternates, [], "and that this product has no other");

    const page = await get("/playground/");
    assert.equal(page.status, 200, "the console serves it, where it used to answer 404");
    const html = await page.text();
    assert.match(html, /the product's own ui/);
    assert.match(html, /href="\.\/style\.css"/, "a reference to a file beside the page is pointed at the page");
    assert.match(html, /src="\.\/app\.js"/);
    assert.match(html, /src="\/api\/not-a-file\.js"/, "a reference that is not a file here is left exactly as the product wrote it");
    assert.equal((await get("/playground/style.css")).status, 200, "and the file beside it is served");

    const minted = await fetch(`${base}/playground/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: "public" }),
    });
    const session = (await minted.json()) as { path: string; dir: string };
    assert.equal(session.dir, "public");
    assert.ok(session.path.includes("/public/"), `the sandboxed page opens the one asked for: ${session.path}`);
    assert.equal((await fetch(`${base}${session.path}`)).status, 200, "and the capability serves it");

    // A directory the product does not have is not a way to open something else: the answer falls back to the page.
    const asked = await fetch(`${base}/playground/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: "../../etc" }),
    });
    assert.equal(((await asked.json()) as { dir: string }).dir, "public", "a bogus directory is not honoured");
  } finally {
    server.close();
  }
});

test("playground: the page written for the console wins, and the product's own is offered beside it", async () => {
  const { createHttpServer } = await import("../../apps/mesh-server/src/index");
  const m = await makeMesh({ agents: [{ id: "dev", role: "developer", interests: [] }], mayContact: { dev: [] } });
  const server = createHttpServer(m, { dashboardDir: undefined });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const product = ((await (await fetch(`${base}/playground/commands`)).json()) as { productRoot: string }).productRoot;
    for (const [dir, title] of [["apps/playground", "for the console"], ["public", "the product's own"]] as const) {
      fs.mkdirSync(path.join(product, dir), { recursive: true });
      fs.writeFileSync(path.join(product, dir, "index.html"), `<!doctype html><title>${title}</title>`, "utf8");
    }
    const offered = (await (await fetch(`${base}/playground/commands`)).json()) as {
      page: { file: string };
      alternates: Array<{ file: string }>;
    };
    assert.equal(offered.page.file, "apps/playground/index.html", "the page written for this sandbox is the one framed");
    assert.deepEqual(offered.alternates.map((a) => a.file), ["public/index.html"], "the product's own is offered, not hidden");
    assert.match(await (await fetch(`${base}/playground/`)).text(), /for the console/);
  } finally {
    server.close();
  }
});
