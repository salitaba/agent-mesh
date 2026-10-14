/**
 * The Playground page: the commands the product declares, starting one and reading its log, being refused, and
 * how a run ended.
 *
 * The page is React with effects, which the node test build cannot run, so the behaviour lives in a DOM-free
 * controller (`apps/mesh-dashboard/src/playground.ts`) that these tests drive with a fake client — the same
 * split the designer's chat store uses. What the view must *draw* is pinned from its source, as the other
 * .tsx-only promises in this directory are.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import type { ProjectClient } from "../../apps/mesh-dashboard/src/api";
import { createPlayground, isBusy, outcomeOf, parseCommands } from "../../apps/mesh-dashboard/src/playground";
import { VIEWS } from "../../apps/mesh-dashboard/src/route";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), "utf8");

interface Call { method: string; path: string; body?: any }
interface Answer { status?: number; json?: any; timeout?: boolean }

/** A client whose every call is recorded and answered by `respond`, so a test can say what the server said. */
function rig(respond: (method: string, path: string, body?: any) => Answer): { client: ProjectClient; calls: Call[] } {
  const calls: Call[] = [];
  const api = async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    const a = respond(method, path, body);
    return { status: a.status ?? 200, json: a.json ?? null, ...(a.timeout ? { timeout: true } : {}) };
  };
  const client = {
    api,
    post: (path: string, body?: unknown) => api("POST", path, body),
    getText: async () => null,
    postStream: async () => ({ status: 200 }),
  } as unknown as ProjectClient;
  return { client, calls };
}

const starts = (calls: Call[]): Call[] => calls.filter((c) => c.method === "POST" && c.path === "/playground/exec");
const settle = (ms = 5): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/* ------------------------------------------------------------------ the commands */

test("the commands the product declares are offered exactly as the server sent them", async () => {
  const { client } = rig(() => ({
    json: {
      commands: [
        { command: "node bin/skillctl.js --help", label: "run skillctl", kind: "bin" },
        { command: "npm run test", label: "test", kind: "script" },
      ],
    },
  }));
  const pg = createPlayground();
  await pg.loadCommands(client);
  assert.deepEqual(pg.getState().commands, [
    { command: "node bin/skillctl.js --help", label: "run skillctl", kind: "bin" },
    { command: "npm run test", label: "test", kind: "script" },
  ]);
  assert.equal(pg.getState().commandsLoaded, true);
  assert.equal(pg.getState().commandsError, null);
});

test("a product with no entry points offers none, and an answer the page cannot read is an error rather than nothing", async () => {
  const none = rig(() => ({ json: { commands: [] } }));
  const pg = createPlayground();
  await pg.loadCommands(none.client);
  assert.deepEqual(pg.getState().commands, []);
  assert.equal(pg.getState().commandsLoaded, true, "an empty list is an answer");

  const bad = rig(() => ({ json: { surprise: true } }));
  const pg2 = createPlayground();
  await pg2.loadCommands(bad.client);
  assert.equal(pg2.getState().commandsLoaded, false);
  assert.ok(pg2.getState().commandsError, "the page says it could not read the answer");

  const failed = rig(() => ({ status: 500, json: { error: "read package.json: EACCES" } }));
  const pg3 = createPlayground();
  await pg3.loadCommands(failed.client);
  assert.equal(pg3.getState().commandsError, "read package.json: EACCES", "the server's own words");
});

test("the reader keeps what a product declares and drops the rest, never inventing a field", () => {
  assert.equal(parseCommands({ commands: [] })!.length, 0);
  assert.equal(parseCommands({}), null);
  assert.equal(parseCommands(null), null);
  assert.equal(parseCommands("nonsense"), null);
  const kept = parseCommands({ commands: [
    { command: "npm run build" },
    { command: "   " },
    { command: "node x.js", label: "  ", kind: "script" },
    { label: "no command" },
    "not an object",
  ] })!;
  assert.deepEqual(kept, [
    { command: "npm run build", label: "npm run build", kind: "bin" },
    { command: "node x.js", label: "node x.js", kind: "script" },
  ]);
});

/* ------------------------------------------------------------------ running one */

test("running a command POSTs it, polls the run, and keeps the log the server returned", async () => {
  let polls = 0;
  const { client, calls } = rig((method, path) => {
    if (method === "POST" && path === "/playground/exec") return { status: 201, json: { runId: "run-1", timeoutMs: 60000 } };
    if (method === "GET" && path === "/playground/exec/run-1") {
      polls++;
      return polls < 2
        ? { json: { id: "run-1", done: false, exitCode: null, log: "$ node bin/skillctl.js list\n" } }
        : { json: { id: "run-1", done: true, exitCode: 0, log: "$ node bin/skillctl.js list\nskillctl\trelease notes\n" } };
    }
    return { status: 404, json: { error: "no route" } };
  });
  const pg = createPlayground({ pollMs: 1 });
  await pg.start(client, "  node bin/skillctl.js list  ");
  assert.deepEqual(starts(calls), [{ method: "POST", path: "/playground/exec", body: { command: "node bin/skillctl.js list", timeoutMs: 60000 } }]);

  const run = pg.getState().run!;
  assert.equal(run.id, "run-1");
  assert.equal(run.command, "node bin/skillctl.js list");
  assert.equal(run.done, true, "the poll ran to the end");
  assert.equal(run.exitCode, 0);
  assert.match(run.log, /skillctl\trelease notes/, "the log the server last sent is what is shown");
  assert.equal(polls, 2, "polled until the run said it was done");
  assert.equal(outcomeOf(run), "passed");
  assert.equal(pg.getState().refusal, null);
});

test("a run is followed to its own end even when the first polls know nothing yet", async () => {
  let polls = 0;
  const { client } = rig((method, path) => {
    if (method === "POST") return { status: 201, json: { runId: "r" } };
    if (path === "/playground/exec/r") {
      polls++;
      return polls === 1 ? { json: null } : { json: { id: "r", done: true, exitCode: 3, log: "boom\n" } };
    }
    return { status: 404, json: { error: "no route" } };
  });
  const pg = createPlayground({ pollMs: 1 });
  await pg.start(client, "false");
  assert.equal(pg.getState().run!.exitCode, 3);
  assert.equal(outcomeOf(pg.getState().run!), "failed");
});

test("the exit status is known once the run is done, and a signal's run has none", async () => {
  const passing = rig((method, path) =>
    method === "POST" ? { status: 201, json: { runId: "p" } } : { json: { id: "p", done: true, exitCode: 0, log: "ok\n" } });
  const pg = createPlayground({ pollMs: 1 });
  const before = pg.getState().run;
  assert.equal(before, null);
  await pg.start(passing.client, "node bin/skillctl.js --help");
  const run = pg.getState().run!;
  assert.equal(run.startedAt > 0, true, "the page clocked it, so a duration can be shown");
  assert.equal(typeof run.endedAt, "number", "and when it ended");
  assert.equal(outcomeOf(run), "passed");

  const signalled = rig((method, path) =>
    method === "POST" ? { status: 201, json: { runId: "s" } } : { json: { id: "s", done: true, exitCode: null, log: "partial\n" } });
  const pg2 = createPlayground({ pollMs: 1 });
  await pg2.start(signalled.client, "sleep 30");
  assert.equal(outcomeOf(pg2.getState().run!), "stopped", "no exit code is a signal, not a failure");
});

/* ------------------------------------------------------------------ refusals */

test("a 409 shows the server's own sentence and keeps the output of the run before it", async () => {
  const { client, calls } = rig((method, path, body) => {
    if (method === "POST" && path === "/playground/exec") {
      return body.command === "first"
        ? { status: 201, json: { runId: "one" } }
        : { status: 409, json: { error: "a run is already in progress" } };
    }
    if (path === "/playground/exec/one") return { json: { id: "one", done: true, exitCode: 1, log: "$ first\nthe answer\n" } };
    return { status: 404, json: { error: "no route" } };
  });
  const pg = createPlayground({ pollMs: 1 });
  await pg.start(client, "first");
  const kept = pg.getState().run!;
  assert.equal(kept.log, "$ first\nthe answer\n");

  await pg.start(client, "second");
  assert.equal(pg.getState().refusal, "a run is already in progress", "the server's words, not a guess at them");
  assert.equal(pg.getState().run, kept, "the output that is on screen is left alone");
  assert.equal(pg.getState().run!.log, "$ first\nthe answer\n");
  assert.equal(pg.getState().starting, false);
  assert.equal(starts(calls).length, 2, "the command was sent; the refusal came from the server");
});

test("a 400 is the server's sentence too — the page does not decide for itself what an empty command means", async () => {
  const { client } = rig((method, path, body) => {
    if (method === "POST" && path === "/playground/exec") {
      return body.command === "" ? { status: 400, json: { error: "provide a `command`" } } : { status: 201, json: { runId: "z" } };
    }
    if (path === "/playground/exec/z") return { json: { id: "z", done: true, exitCode: 0, log: "hi\n" } };
    return { status: 404, json: { error: "no route" } };
  });
  const pg = createPlayground({ pollMs: 1 });
  await pg.start(client, "   ");
  assert.equal(pg.getState().refusal, "provide a `command`");
  assert.equal(pg.getState().run, null, "nothing ran, so there is nothing to keep");
  await pg.start(client, "node bin/skillctl.js list");
  assert.equal(pg.getState().refusal, null, "a run that starts clears the refusal");
  assert.equal(pg.getState().run!.log, "hi\n");
});

test("an unanswered start is reported without claiming the run began", async () => {
  const { client } = rig(() => ({ timeout: true, status: 0 }));
  const pg = createPlayground();
  await pg.start(client, "node bin/skillctl.js list");
  assert.match(pg.getState().refusal!, /did not answer in time/);
  assert.equal(pg.getState().run, null);
  assert.equal(pg.getState().starting, false);
});

/* ------------------------------------------------------------------ one at a time, and stopping */

test("a double-click while a run is in flight is one run, not two", async () => {
  let release = false;
  const { client, calls } = rig((method, path) => {
    if (method === "POST") return { status: 201, json: { runId: "d" } };
    if (path === "/playground/exec/d") return { json: { id: "d", done: release, exitCode: null, log: "…\n" } };
    return { status: 404, json: { error: "no route" } };
  });
  const pg = createPlayground({ pollMs: 1 });
  const first = pg.start(client, "long one");
  const second = pg.start(client, "long two");
  assert.equal(isBusy(pg.getState()), true, "the page is busy from the first click, before the server answers");
  await settle();
  release = true;
  await Promise.all([first, second]);
  assert.equal(starts(calls).length, 1);
  assert.equal(pg.getState().run!.command, "long one");
});

test("Stop asks the host to kill that run, and a run that ends without an exit code reads as stopped", async () => {
  let killed = false;
  const { client, calls } = rig((method, path) => {
    if (method === "POST" && path === "/playground/exec") return { status: 201, json: { runId: "run-9" } };
    if (path === "/workspace/run/kill/run-9") { killed = true; return { json: { ok: true } }; }
    if (path === "/playground/exec/run-9") return { json: { id: "run-9", done: killed, exitCode: null, log: "still working\n" } };
    return { status: 404, json: { error: "no route" } };
  });
  const pg = createPlayground({ pollMs: 1 });
  const started = pg.start(client, "sleep 30");
  await settle();
  assert.equal(pg.getState().run!.stopped, undefined);
  await pg.stop(client);
  await started;
  assert.deepEqual(calls.find((c) => c.path.startsWith("/workspace/run/kill")), { method: "POST", path: "/workspace/run/kill/run-9", body: undefined });
  assert.equal(killed, true);
  const run = pg.getState().run!;
  assert.equal(run.done, true);
  assert.equal(run.stopped, true);
  assert.equal(run.log, "still working\n", "what it printed before the signal is kept");
  assert.equal(outcomeOf(run), "stopped");
});

test("a kill the host refuses is said, and the run is not marked stopped on a lie", async () => {
  let over = false;
  const { client } = rig((method, path) => {
    if (method === "POST" && path === "/playground/exec") return { status: 201, json: { runId: "k" } };
    if (path === "/workspace/run/kill/k") return { status: 404, json: { error: "run not running" } };
    if (path === "/playground/exec/k") return { json: { id: "k", done: over, exitCode: null, log: "" } };
    return { status: 404, json: { error: "no route" } };
  });
  const pg = createPlayground({ pollMs: 1 });
  const started = pg.start(client, "sleep 30");
  await settle();
  await pg.stop(client);
  assert.equal(pg.getState().run!.stopped, false, "the button goes back to Stop");
  assert.equal(pg.getState().refusal, "run not running");
  assert.equal(pg.getState().run!.done, false, "it is still going: nothing was killed");
  over = true;
  await started;
});

/* ------------------------------------------------------------------ a run the host forgot */

test("a run the host no longer knows is not reported as a failure of the command", async () => {
  const { client } = rig((method, path) => {
    if (method === "POST") return { status: 201, json: { runId: "gone" } };
    if (path === "/playground/exec/gone") return { json: { error: "unknown run" } };
    return { status: 404, json: { error: "no route" } };
  });
  const pg = createPlayground({ pollMs: 1 });
  await pg.start(client, "node bin/skillctl.js list");
  const run = pg.getState().run!;
  assert.equal(run.lost, true);
  assert.equal(run.exitCode, null, "no exit status is invented");
  assert.equal(outcomeOf(run), "lost");
  assert.equal(run.log, "", "what it had printed when the host forgot it is still shown as it was");
});

test("Dismiss clears the output, and only once the run is over", async () => {
  const { client } = rig((method, path) =>
    method === "POST" ? { status: 201, json: { runId: "c" } } : { json: { id: "c", done: true, exitCode: 0, log: "done\n" } });
  const pg = createPlayground({ pollMs: 1 });
  await pg.start(client, "node bin/skillctl.js list");
  assert.ok(pg.getState().run);
  pg.clear();
  assert.equal(pg.getState().run, null);
  assert.equal(pg.getState().refusal, null);
});

/* ------------------------------------------------------------------ the view and its registration */

const view = read("views/Playground.tsx");

test("the view draws the product's commands as one button each, running that command", () => {
  assert.match(view, /state\.commands\.map\(/, "a button per command the API offered");
  assert.match(view, /\{c\.label\}/, "the button says the label the server sent");
  assert.match(view, /\{c\.command\}/, "and what it will run");
  assert.match(view, /onClick=\{\(\) => void pg\.start\(client, c\.command\)\}/, "pressing it runs that command");
  assert.match(view, /disabled=\{busy\}/, "no second run while one is in flight");
});

test("the view shows the raw log in monospace, follows its end, and says how the run ended once it has", () => {
  assert.match(view, /className="pg-log"/);
  assert.match(view, /\{log \|\| "No output yet\."\}/, "the log itself, and a line where there is none yet");
  assert.match(view, /el\.scrollTop = el\.scrollHeight/, "the pane follows the end of the output as it grows");
  assert.match(view, /<StatusChip run=\{run\} \/>/);
  for (const part of ["Exit code 0", "Exit code {run.exitCode}", "isLive(run) ? null : <Button", "Stopped"]) {
    assert.ok(view.includes(part), `the output panel says ${part}`);
  }
  assert.match(view, /onClick=\{pg\.clear\}/, "a finished run is dismissed by hand, never cleared on its own");
});

test("the view shows the server's refusal, offers Stop while a run is in flight, and keeps the output under both", () => {
  assert.match(view, /state\.refusal \? \(/);
  assert.match(view, /\{state\.refusal\}/, "the server's own sentence, as it sent it");
  assert.match(view, /role="alert"/);
  assert.match(view, /isLive\(run\) \? \(\s*<Button variant="soft" icon="stop"/, "Stop while a run is in progress");
  assert.match(view, /void pg\.stop\(client\)/);
  // The refusal is drawn above the panel and the panel is only replaced when there is a new run: a refusal never
  // takes the previous output off the screen.
  assert.ok(view.indexOf("pg-refusal") < view.indexOf("pg-out"), "the refusal comes before the output, it does not replace it");
});

test("the view is registered in the console's routing, its sidebar and its view switch", () => {
  assert.ok(VIEWS.includes("playground"), "the route table knows the view");
  const shell = read("shell.tsx");
  assert.match(shell, /view: "playground", icon: "code", label: "Playground"/, "the sidebar and its command palette entry");
  const main = read("main.tsx");
  assert.match(main, /import Playground from "\.\/views\/Playground";/);
  assert.match(main, /case "playground":\s*return <Playground \/>;/, "the view switch draws it");
});

test("the sheet sets type on the ramp and reads only tokens the console sets", () => {
  const css = read("views/playground.css");
  const RAMP = [11, 12, 13, 14, 15, 16, 18, 20, 24, 30];
  for (const m of css.matchAll(/(?:^|[;{\s])(font|font-size)\s*:\s*([^;}{]+)/g)) {
    const px = /(?:^|\s)(\d+(?:\.\d+)?)px(?=$|[\s/])/.exec(m[2]!);
    if (px) assert.ok(RAMP.includes(Number(px[1])), `${m[0]} is on the type ramp`);
  }
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/, "tokens only, so both themes work");
});
