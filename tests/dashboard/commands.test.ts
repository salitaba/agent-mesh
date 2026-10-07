import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import { list, register, unregister, type Command } from "../../apps/mesh-dashboard/src/commands";

/**
 * The palette lists what is registered right now, and a person reads its first row as the answer. The project tab strip registers
 * its scope before the shell registers the global one, so in plain registration order "Go to Projects" came first, ahead of
 * "Go to Overview".
 */
const cmd = (id: string, scope: string): Command => ({ id, label: id, scope, run: () => undefined });
const ids = (): string[] => list().map((c) => c.id);
// The registry is module state: a test that fails halfway must not leave its scopes for the next one.
afterEach(() => { for (const s of ["host", "global", "view", "view-a", "view-b"]) unregister(s); });

test("the shell's commands are listed first, whichever scope registered first", () => {
  register("host", [cmd("go.projects", "host"), cmd("projects.new", "host")]);
  register("global", [cmd("go.overview", "global"), cmd("go.agents", "global")]);
  assert.deepEqual(ids(), ["go.overview", "go.agents", "go.projects", "projects.new"]);
  unregister("host");
  unregister("global");
  assert.deepEqual(ids(), []);
});

test("the other scopes keep the order they first registered in, and re-registering one does not move it", () => {
  register("view-a", [cmd("a.one", "view-a")]);
  register("global", [cmd("g.one", "global")]);
  register("view-b", [cmd("b.one", "view-b")]);
  assert.deepEqual(ids(), ["g.one", "a.one", "b.one"]);
  register("view-a", [cmd("a.one", "view-a"), cmd("a.two", "view-a")]);
  assert.deepEqual(ids(), ["g.one", "a.one", "a.two", "b.one"], "a scope that registers again keeps its place");
});

test("a view that goes away takes its commands with it", () => {
  register("global", [cmd("g.one", "global")]);
  register("view", [cmd("v.one", "view")]);
  unregister("view");
  assert.deepEqual(ids(), ["g.one"]);
});
