/**
 * The product's own UI: what the console's panel knows about it, and the three dead ends that knowledge was missing.
 *
 * The panel used to keep one boolean — `running` — where the host distinguishes four states, and it never asked the host
 * anything until someone pressed Start. Both were visible on a phone:
 *
 * 1. A UI started from another tab (or before a reload) read as *not running*: the panel drew the start box, and `GET
 *    /ui` answered `running: false` for a command that was up and had not yet printed its port (`running` is
 *    `port !== null && exitCode === null`). Pressing Start answered "the product's UI is already running" — true, and a
 *    dead end, because Stop was only drawn beside `running`.
 * 2. A refused start called `setLiveAsked(false)`, which stopped the polling for good: the panel went on showing the box
 *    that had just been refused, with the error under it and no way to the UI that was in fact running.
 * 3. A command that exited left a log tail and no sentence: `exitCode: 0` and a command that never named a port looked
 *    exactly like a UI that was up and idle.
 *
 * The fix is to read the phase from what the host says (`command`, `port`, `exitCode`, `stopped`), ask on arrival, and
 * ask again while it matters. The view is React, which the node test build cannot run, so the behaviour lives in a
 * DOM-free controller (`apps/mesh-dashboard/src/productlive.ts`) that these tests drive with a fake client — the same
 * split `playground.ts` uses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import type { ProjectClient } from "../../apps/mesh-dashboard/src/api";
import {
  NO_PORT_AFTER_MS,
  createLiveUi,
  lifetimeText,
  liveSrc,
  phaseOf,
  problemOf,
  type LiveUiAnswer,
  type LiveUiState,
} from "../../apps/mesh-dashboard/src/productlive";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), "utf8");

interface Call { method: string; path: string; body?: unknown }
interface Answer { status?: number; json?: unknown }

/** A client whose every call is recorded and answered by `respond`, so a test can say what the host said. */
function rig(respond: (method: string, path: string, body?: unknown) => Answer): { client: ProjectClient; calls: Call[] } {
  const calls: Call[] = [];
  const api = async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    const a = respond(method, path, body);
    return { status: a.status ?? 200, json: a.json ?? null };
  };
  const client = {
    api,
    post: (path: string, body?: unknown) => api("POST", path, body),
    getText: async () => null,
    postStream: async () => ({ status: 200 }),
  } as unknown as ProjectClient;
  return { client, calls };
}

/** What the host answers for a UI, in the shape `describeLiveUi` really returns (see apps/mesh-server/src/index.ts). */
const answer = (a: Partial<LiveUiAnswer>): LiveUiAnswer => ({
  running: false,
  command: null,
  port: null,
  log: "",
  livePath: null,
  exitCode: null,
  ...a,
});

const gets = (calls: Call[]): Call[] => calls.filter((c) => c.method === "GET" && c.path === "/ui");

/* ------------------------------------------------------------- the phase, read from the host */

test("the host's four states are told apart, and never guessed from one boolean", () => {
  assert.equal(phaseOf(answer({})), "idle", "nothing was ever started");
  // Up and printing, but no address yet: `running` is false here — this is the state the old panel drew as "not started".
  assert.equal(phaseOf(answer({ command: "node bin/skillctl.js ui" })), "starting");
  assert.equal(phaseOf(answer({ command: "node bin/skillctl.js ui", port: 41839, livePath: "/_ui/cap/", running: true })), "live");
  assert.equal(phaseOf(answer({ command: "node bin/skillctl.js ui", exitCode: 0 })), "ended", "it ran and finished");
  assert.equal(phaseOf(answer({ command: "node bin/skillctl.js ui", exitCode: 1 })), "ended");
  assert.equal(phaseOf(answer({ command: "node bin/skillctl.js ui", stopped: true })), "ended", "a stop wins over the exit code the signal left behind");
  assert.equal(phaseOf(answer({ command: "node bin/skillctl.js ui", running: true, port: 41839 })), "live");
});

test("arriving at the console finds a UI that is already up, instead of offering to start a second one", async () => {
  const { client, calls } = rig(() => ({
    json: answer({ command: "node bin/skillctl.js ui", port: 41839, running: true, livePath: "/_ui/abc/", log: "listening on http://127.0.0.1:41839/\n" }),
  }));
  const live = createLiveUi();
  assert.equal(live.getState().phase, "idle", "before the host answers, nothing is claimed");
  await live.refresh(client);
  assert.equal(gets(calls).length, 1, "the page asked the host on arrival — the call the old panel never made");
  const s = live.getState();
  assert.equal(s.phase, "live");
  assert.equal(s.port, 41839);
  assert.equal(s.livePath, "/_ui/abc/", "and it can be opened without starting anything");
  live.open("my-mesh");
  assert.equal(live.getState().open, true);
  assert.equal(live.getState().src, "/api/p/my-mesh/_ui/abc/", "through the project's own path, like every other call this console makes");
});

test("a failed poll is not an answer: the UI on screen stays on screen", async () => {
  // Measured against a stand-in host: while the UI was live, `GET /ui` answered 502 `{error}`. The old refresh absorbed
  // the error body as if the host had said "nothing has ever been started"; `phaseOf` read it as idle, which closed the
  // open frame and drew the start box again for a command that was still running. A second Start would be refused with
  // "already running" — the same dead end this controller was written to remove.
  let failing = false;
  const { client } = rig(() => (failing
    ? { status: 502, json: { error: "the project process did not answer" } }
    : { json: answer({ command: "node bin/skillctl.js ui", port: 41839, running: true, livePath: "/_ui/abc/" }) }));
  const live = createLiveUi();
  await live.refresh(client);
  live.open("my-mesh");
  assert.equal(live.getState().phase, "live");
  assert.equal(live.getState().open, true);
  failing = true;
  await live.refresh(client);
  assert.equal(live.getState().phase, "live", "a failed poll changes nothing");
  assert.equal(live.getState().port, 41839);
  assert.equal(live.getState().open, true, "and it does not close the frame the person is using");
  assert.equal(live.getState().src, "/api/p/my-mesh/_ui/abc/");
  // The next good answer is still taken, so the recovery is a beat later and not a reload.
  failing = false;
  await live.refresh(client);
  assert.equal(live.getState().phase, "live");
});

test("a UI that is up but has not named its port says so in words, and keeps its Stop", async () => {
  const { client } = rig(() => ({ json: answer({ command: "node bin/skillctl.js ui", log: "building…\n" }) }));
  const live = createLiveUi({ now: () => 1_000 });
  await live.refresh(client);
  const s = live.getState();
  assert.equal(s.phase, "starting");
  assert.equal(s.waitingSince, 1_000, "the page clocks how long it has been waiting");
  assert.match(problemOf(s, 1_000)!, /Waiting for it to print the address/);
  assert.equal(live.due(), true, "and it keeps asking, because something is happening");
  // Twenty seconds on, the patient sentence is replaced by the honest one: a UI that never prints an address cannot be
  // shown in this frame, and the person is told why rather than watching a spinner for ever.
  assert.match(problemOf(s, 1_000 + NO_PORT_AFTER_MS + 1)!, /127\.0\.0\.1/);
});

test("a command that exits says which code it exited with, and does not read as a UI that is up", async () => {
  const clean = rig(() => ({ json: answer({ command: "node bin/skillctl.js ui", exitCode: 0, log: "done\n" }) }));
  const a = createLiveUi();
  await a.refresh(clean.client);
  assert.equal(a.getState().phase, "ended");
  assert.match(problemOf(a.getState(), 0)!, /exited with code 0/);
  assert.equal(a.due(), false, "a UI that has ended is not polled for ever");

  const broken = rig(() => ({ json: answer({ command: "node bin/skillctl.js ui --serve", exitCode: 2, log: "Error: unknown option --serve\n" }) }));
  const b = createLiveUi();
  await b.refresh(broken.client);
  assert.match(problemOf(b.getState(), 0)!, /exited with code 2/);

  const stopped = rig(() => ({ json: answer({ command: "node bin/skillctl.js ui", stopped: true, exitCode: 0 }) }));
  const c = createLiveUi();
  await c.refresh(stopped.client);
  assert.match(problemOf(c.getState(), 0)!, /stopped/); // and not "exited with code 0", which would blame the product
});

/* ------------------------------------------------------------- starting, and being refused */

test("a start refused because one is already running finds the running one instead of dead-ending", async () => {
  // The other tab's UI: the host knows about it, this page does not. The old panel set `liveAsked = false` here, stopped
  // polling, and left the person with an error and a button that would be refused again.
  let running = false;
  const { client, calls } = rig((method, path) => {
    if (method === "POST" && path === "/ui/start") {
      if (running) return { status: 409, json: { error: "the product's UI is already running" } };
      running = true;
      return { status: 201, json: answer({ command: "node bin/skillctl.js ui" }) };
    }
    if (path === "/ui") {
      return {
        json: running
          ? answer({ command: "node bin/skillctl.js ui", port: 41839, running: true, livePath: "/_ui/abc/", log: "listening on http://127.0.0.1:41839/\n" })
          : answer({}),
      };
    }
    return { status: 404, json: { error: "no route" } };
  });

  // A second page that does not know about the first one's UI.
  const other = createLiveUi();
  await other.start(client, "node bin/skillctl.js ui");
  assert.equal(other.getState().phase, "starting", "the command is up; it has not named its port yet");
  await other.refresh(client);
  assert.equal(other.getState().phase, "live");

  // Now a fresh page (a reload), against a host that already has one running: pressing Start is refused, and the refusal
  // is answered by asking the host what it has.
  const reloaded = createLiveUi();
  await reloaded.start(client, "node bin/skillctl.js ui");
  assert.equal(phaseOf(answer({ command: "node bin/skillctl.js ui", port: 41839, running: true, livePath: "/_ui/abc/" })), "live");
  assert.equal(reloaded.getState().phase, "live", "the panel shows the UI that is running rather than the box that was refused");
  assert.equal(reloaded.getState().problem, null, "and there is nothing to explain: it is simply up");
  assert.equal(reloaded.getState().livePath, "/_ui/abc/");
  assert.match(String((calls.at(-1) as Call).path), /\/ui$/, "the refusal was followed by asking the host");
});

test("a refusal with nothing behind it says the host's own words and leaves the box usable", async () => {
  const { client } = rig((method, path) =>
    method === "POST" ? { status: 400, json: { error: "a command is required: the product's own way of starting its UI" } } : { json: answer({}) },
  );
  const live = createLiveUi();
  await live.start(client, "   ");
  assert.match(live.getState().problem!, /Type how this product starts its own UI/, "an empty box is answered here, without a round trip");
  await live.start(client, "node bin/skillctl.js ui --port 0");
  assert.equal(live.getState().problem, "a command is required: the product's own way of starting its UI", "the host's own sentence, not a guess at it");
  assert.equal(live.getState().phase, "idle", "nothing is claimed to be running");
  assert.equal(live.getState().busy, false, "and the button is pressable again");
});

test("the command the owner used is remembered, so starting it again is one press on a phone", async () => {
  const { client } = rig((method, path) =>
    method === "POST" ? { status: 201, json: answer({ command: "node bin/skillctl.js ui" }) } : { json: answer({}) },
  );
  let kept: string | null = null;
  const live = createLiveUi({ readRemembered: () => kept, writeRemembered: (c) => { kept = c; } });
  await live.start(client, "  node bin/skillctl.js ui  ");
  assert.equal(kept, "node bin/skillctl.js ui", "trimmed, and written as the host has it");

  // A fresh page (the next visit) opens with the command already in the box.
  const next = createLiveUi({ readRemembered: () => kept });
  assert.equal(next.getState().command, "node bin/skillctl.js ui");
});

/* ------------------------------------------------------------- the frame, and stopping */

test("the frame is opened on one link and left alone: polling it again must not reload the product under the owner", async () => {
  let n = 0;
  const { client } = rig(() => {
    n++;
    return { json: answer({ command: "node bin/skillctl.js ui", port: 41839, running: true, livePath: `/_ui/cap${n}/` }) };
  });
  const live = createLiveUi();
  await live.refresh(client);
  live.open("p");
  const first = live.getState().src;
  await live.refresh(client);
  assert.equal(live.getState().livePath, "/_ui/cap2/", "the host mints a new capability per poll");
  assert.equal(live.getState().src, first, "and the page in the frame is not pointed at it: that would reload it mid-use");
});

test("a UI that goes away takes its frame with it, and Stop is offered while it is starting too", async () => {
  let phase: Partial<LiveUiAnswer> = { command: "node bin/skillctl.js ui", port: 41839, running: true, livePath: "/_ui/cap/" };
  const { client, calls } = rig((method, path) => {
    if (method === "POST" && path === "/ui/stop") {
      phase = { command: "node bin/skillctl.js ui", stopped: true };
      return { json: { stopped: true, state: answer(phase) } };
    }
    return { json: answer(phase) };
  });
  const live = createLiveUi();
  await live.refresh(client);
  live.open("p");
  assert.equal(live.getState().open, true);

  await live.stop(client);
  assert.equal(calls.filter((c) => c.path === "/ui/stop").length, 1);
  assert.equal(live.getState().open, false, "the frame is closed with the UI it was showing");
  assert.equal(live.getState().src, null, "and its link is dropped: a stale capability answers 409");
  assert.equal(live.getState().phase, "ended");
  assert.match(problemOf(live.getState(), 0)!, /stopped/);
});

test("opening before the host has named a port does nothing rather than pointing the frame at nothing", () => {
  const live = createLiveUi();
  live.open("p");
  assert.equal(live.getState().open, false);
  assert.equal(live.getState().src, null);
});

/* ------------------------------------------------------------- polling, and races */

test("the page only asks while it matters", async () => {
  const idle = createLiveUi();
  assert.equal(idle.due(), false, "nothing to watch on an idle host");

  let phase: Partial<LiveUiAnswer> = { command: "node bin/skillctl.js ui" };
  const { client } = rig(() => ({ json: answer(phase) }));
  const live = createLiveUi();
  await live.refresh(client);
  assert.equal(live.due(), true, "starting: something is happening and the port is coming");
  phase = { command: "node bin/skillctl.js ui", port: 1, running: true, livePath: "/_ui/c/" };
  await live.refresh(client);
  assert.equal(live.getState().phase, "live");
  assert.equal(live.due(), true, "live: the UI's dying has to be noticed too");
  phase = { command: "node bin/skillctl.js ui", exitCode: 0 };
  await live.refresh(client);
  assert.equal(live.due(), false, "ended: nothing more will happen until someone asks");
});

test("a poll that was already in flight when Stop was pressed does not put the UI back on screen", async () => {
  // The real race: `GET /ui` asked while the UI was up, answered after the stop. Its answer describes the host as it
  // was, and drawing it would resurrect a UI the person has just ended.
  let answerGet: ((a: Answer) => void) | null = null;
  const calls: Call[] = [];
  const api = async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    if (method === "GET") return new Promise<Answer>((r) => { answerGet = r; }).then((a) => ({ status: 200, json: a.json ?? null }));
    return { status: 200, json: { stopped: true, state: answer({ command: "node bin/skillctl.js ui", stopped: true }) } };
  };
  const client = { api, post: (p: string, b?: unknown) => api("POST", p, b), getText: async () => null, postStream: async () => ({ status: 200 }) } as unknown as ProjectClient;

  const live = createLiveUi();
  const poll = live.refresh(client); // in flight, holding the pre-stop truth
  const stopped = live.stop(client);
  answerGet!({ json: answer({ command: "node bin/skillctl.js ui", port: 41839, running: true, livePath: "/_ui/c/" }) });
  await Promise.all([poll, stopped]);
  assert.equal(live.getState().phase, "ended", "the stop is what the person asked for, and it wins");
  assert.equal(live.getState().open, false);
});

/* ------------------------------------------------------------- copy, and the link */

test("how long the host will keep it is said in minutes, not in a timestamp", () => {
  const at = new Date(1_700_000_000_000 + 25 * 60_000).toISOString();
  assert.equal(lifetimeText(at, 1_700_000_000_000), "The console stops it by itself in about 25 minutes.");
  assert.equal(lifetimeText(new Date(1_700_000_000_000 + 60_000).toISOString(), 1_700_000_000_000), "The console stops it by itself in about 1 minute.");
  assert.match(lifetimeText(at, 1_700_000_000_000 + 26 * 60_000)!, /stopping it now/);
  assert.equal(lifetimeText(undefined, 0), null, "a host that says nothing about a clock gets no sentence invented");
  assert.equal(lifetimeText("not a date", 0), null);
});

test("the frame's link is the project's path to the capability, and ends on the page", () => {
  assert.equal(liveSrc("p", "/_ui/cap/"), "/api/p/p/_ui/cap/");
  assert.equal(liveSrc("p", "_ui/cap"), "/api/p/p/_ui/cap/", "a link without its trailing slash still resolves beside the page");
  assert.equal(liveSrc(null, "/_ui/cap/"), "/_ui/cap/", "no project (a single-project host) is not a broken path");
  assert.equal(liveSrc("a b", "/_ui/cap/"), "/api/p/a%20b/_ui/cap/");
});

/* ------------------------------------------------------------- what the view must draw */

// The card lives in its own file so both the Product page and the Playground can open the product without either
// holding a second copy of the machinery. Its pins read that file; Product.tsx is pinned to the one thing it does.
const view = read("views/YourProduct.tsx");

test("the view asks the host on arrival and keeps asking while it matters, instead of waiting for a press", () => {
  assert.match(view, /createLiveUi\(/, "the view is a shell over the controller the tests above drive");
  assert.match(view, /void live\.refresh\(client\)/, "on arrival, before anything is pressed");
  assert.match(view, /live\.due\(\)/, "and on a timer only while there is something to watch");
  assert.match(view, /useEffect\(\(\) => \{\s*if \(!live\.due\(\)\) return;/, "the timer is the controller's decision, not a boolean of its own");
});

test("the view offers Stop wherever the UI is up or coming up, and the frame is closed with it", () => {
  assert.match(view, /live\.stop\(client\)/);
  assert.match(view, /problemOf\(state,/, "the controller's sentence is what the person reads, not one written beside it");
  assert.match(view, /live\.open\(projectId\)/, "opening goes through the controller, which captures the link once");
  assert.doesNotMatch(view, /setLiveSrc\(/, "the view no longer holds a second copy of the frame's link");
});

test("the Product page and the Playground both open the product through the one card, and neither re-implements it", () => {
  const product = read("views/Product.tsx");
  assert.match(product, /import \{ YourProduct \} from "\.\/YourProduct";/);
  assert.match(product, /<YourProduct client=\{client\} projectId=\{projectId\} refreshKey=\{builtCheck\} \/>/, "after a build, the page it ships is looked for again");
  assert.doesNotMatch(product, /createLiveUi\(|liveWorth|setLiveSrc\(/, "the live UI is not held twice on one page");
  assert.match(read("views/Playground.tsx"), /<YourProduct client=\{client\} projectId=\{projectId\} \/>/);
});

test("the sheet sets type on the ramp, sizes the frame for a phone, and reads only tokens", () => {
  // Comments are stripped: the palette sweep (tests/build/console-palette.test.ts) does the same, and a comment is free
  // to name the value a token holds.
  const css = read("views/product.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const RAMP = [11, 12, 13, 14, 15, 16, 18, 20, 24, 30];
  for (const m of css.matchAll(/(?:^|[;{\s])(font|font-size)\s*:\s*([^;}{]+)/g)) {
    const px = /(?:^|\s)(\d+(?:\.\d+)?)px(?=$|[\s/])/.exec(m[2]!);
    if (px) assert.ok(RAMP.includes(Number(px[1])), `${m[0]} is on the type ramp`);
  }
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/, "tokens only, so both themes work");
});

/** The states the view is allowed to say nothing about: `live` is self-evident, and `idle` with a command typed is a box. */
test("every phase that needs words has them", () => {
  const base: LiveUiState = createLiveUi().getState();
  assert.equal(problemOf({ ...base, phase: "live" }, 0), null);
  assert.equal(problemOf({ ...base, phase: "idle", command: "node bin/skillctl.js ui" }, 0), null);
  assert.ok(problemOf({ ...base, phase: "idle", command: "" }, 0));
  assert.ok(problemOf({ ...base, phase: "starting", waitingSince: 0 }, 0));
  assert.ok(problemOf({ ...base, phase: "ended", exitCode: 1 }, 0));
});
