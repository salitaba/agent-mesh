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
