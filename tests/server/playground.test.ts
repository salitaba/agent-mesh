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
