import test from "node:test";
import assert from "node:assert/strict";

import { crashHeadline, crashReport, describeThrown, isStaleBundle } from "../../apps/mesh-dashboard/src/crash";

/**
 * A view that throws while drawing used to blank the whole console. The boundary keeps the shell; these pin what it says and
 * what the copied report holds, which is the part someone else has to be able to act on.
 */

test("anything that can be thrown is described, and none of it throws again", () => {
  const typeErr = new TypeError("x is undefined");
  assert.deepEqual(describeThrown(typeErr), { name: "TypeError", message: "x is undefined", stack: typeErr.stack });
  assert.equal(describeThrown("plain string").message, "plain string");
  assert.equal(describeThrown({ code: 7 }).message, '{"code":7}');
  assert.equal(describeThrown(undefined).message, "undefined", "JSON.stringify(undefined) is undefined, not text");
  const loop: Record<string, unknown> = {};
  loop.self = loop;
  assert.doesNotThrow(() => describeThrown(loop), "a circular value must not crash the crash screen");
  assert.equal(describeThrown(loop).message, "[object Object]");
});

test("a lazily loaded view whose file is gone from the server is a stale tab, in each browser's wording", () => {
  assert.equal(isStaleBundle(new TypeError("Failed to fetch dynamically imported module: https://x/assets/Graph-ab12.js")), true, "Chrome and Firefox");
  assert.equal(isStaleBundle(new TypeError("error loading dynamically imported module")), true);
  assert.equal(isStaleBundle(new TypeError("Importing a module script failed.")), true, "Safari");
  const chunk = new Error("Loading chunk 7 failed.");
  chunk.name = "ChunkLoadError";
  assert.equal(isStaleBundle(chunk), true, "a webpack-style chunk error");
  assert.equal(isStaleBundle(new TypeError("Cannot read properties of undefined (reading 'map')")), false, "a real fault in a view is not a stale tab");
  assert.equal(isStaleBundle("Loading chunk 3 failed"), true, "a string is read the same way");
});

test("the report names the view, the route and the error, so it can be opened again", () => {
  const err = new RangeError("Invalid time value");
  const text = crashReport({ view: "steps", route: "#/p/payments/steps", error: err, componentStack: "\n    at StepRow\n    at Steps\n", version: "0.9.0" });
  const [head, route, what] = text.split("\n");
  assert.equal(head, "Curule console 0.9.0, view: steps");
  assert.equal(route, "Route: #/p/payments/steps");
  assert.equal(what, "RangeError: Invalid time value");
  assert.match(text, /Component stack:\nat StepRow\n    at Steps$/, "the component stack is trimmed and last");
});

test("the report copes with what a browser does not give it", () => {
  const text = crashReport({ view: "", route: "", error: "boom" });
  assert.equal(text, "Curule console, view: unknown\nRoute: (none)\nError: boom");
});

test("a very long stack is cut, and the cut says how much was left out", () => {
  const err = new Error("deep");
  err.stack = Array.from({ length: 100 }, (_, i) => `at frame${i}`).join("\n");
  const text = crashReport({ view: "graph", route: "#/p/a/graph", error: err });
  assert.match(text, /at frame29\n… 70 more lines/);
  assert.doesNotMatch(text, /frame30/);
});

test("the headline is one line, cut for the screen, never the whole stack", () => {
  assert.equal(crashHeadline(new Error("first line\nsecond line")), "first line");
  const long = crashHeadline(new Error("x".repeat(500)), 50);
  assert.equal(long.length, 50);
  assert.ok(long.endsWith("…"));
  assert.equal(crashHeadline(new Error("")), "");
});
