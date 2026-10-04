import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_VIEW,
  HOST_VIEWS,
  VIEWS,
  formatCursors,
  hashFor,
  isHostView,
  needsProjectRedirect,
  parseHash,
  pickActiveProject,
  projectPath,
  singleStreamUrl,
  streamUrl,
} from "../../apps/mesh-dashboard/src/route";

test("parseHash reads the project segment", () => {
  const r = parseHash("#/p/acme/steps/step/turn-ab12");
  assert.equal(r.projectId, "acme");
  assert.equal(r.view, "steps");
  assert.deepEqual(r.detail, { kind: "step", id: "turn-ab12" });
});

test("parseHash keeps legacy bare links working, flagged for redirect", () => {
  const r = parseHash("#/steps/step/turn-ab12");
  // A pre-projects link is not an error — it just does not name a project yet,
  // which is exactly what the redirect uses to rewrite it onto the active one.
  assert.equal(r.projectId, null);
  assert.equal(r.view, "steps");
  assert.deepEqual(r.detail, { kind: "step", id: "turn-ab12" });
  assert.equal(needsProjectRedirect(r), true);
  assert.equal(needsProjectRedirect(parseHash("#/p/acme/steps")), false);
});

test("parseHash falls back to the default view, never to a blank page", () => {
  assert.equal(parseHash("").view, DEFAULT_VIEW);
  assert.equal(parseHash("#/").view, DEFAULT_VIEW);
  assert.equal(parseHash("#/nonsense").view, DEFAULT_VIEW);
  assert.equal(parseHash("#/p/acme").view, DEFAULT_VIEW);
  assert.equal(parseHash("#/p/acme").projectId, "acme");
  // "p" alone names no project, so it is read as a (bogus) view, not a project.
  assert.equal(parseHash("#/p").projectId, null);
});

test("parseHash survives ids that need escaping, and malformed escapes", () => {
  const r = parseHash("#/p/my%20mesh/steps/agent/a%2Fb");
  assert.equal(r.projectId, "my mesh");
  assert.deepEqual(r.detail, { kind: "agent", id: "a/b" });
  // A stray % must not throw: decodeURIComponent would, and that blanks the app.
  assert.equal(parseHash("#/p/bad%zz/steps").projectId, "bad%zz");
});

test("hashFor round-trips through parseHash", () => {
  for (const detail of [undefined, { kind: "step" as const, id: "turn/1" }]) {
    const h = hashFor("my mesh", "agents", detail);
    const r = parseHash(h);
    assert.equal(r.projectId, "my mesh");
    assert.equal(r.view, "agents");
    assert.deepEqual(r.detail, detail);
  }
});

test("hashFor without a project emits the legacy bare form", () => {
  assert.equal(hashFor(null, "steps"), "#/steps");
  assert.equal(hashFor("acme", "steps"), "#/p/acme/steps");
});

test("pickActiveProject prefers the deep link, then memory, then an open project", () => {
  const known = ["a", "b", "c"];
  assert.equal(pickActiveProject({ fromHash: "b", remembered: "c", open: ["a"], known }), "b");
  assert.equal(pickActiveProject({ remembered: "c", open: ["a"], known }), "c");
  assert.equal(pickActiveProject({ open: ["b"], known }), "b");
  assert.equal(pickActiveProject({ known }), "a");
  assert.equal(pickActiveProject({ known: [] }), null);
});

test("pickActiveProject ignores ids the registry does not know", () => {
  const known = ["a"];
  // A deep link or a remembered id pointing at a removed project must not win,
  // or the console mounts a store for a project that cannot answer.
  assert.equal(pickActiveProject({ fromHash: "gone", known }), "a");
  assert.equal(pickActiveProject({ remembered: "gone", known }), "a");
  assert.equal(pickActiveProject({ fromHash: "gone", remembered: "gone", open: ["gone"], known: [] }), null);
});

test("formatCursors drops cursors that would mean 'replay everything'", () => {
  assert.equal(formatCursors([["a", 120], ["b", 44]]), "a:120,b:44");
  assert.equal(formatCursors([["a", 0], ["b", 44]]), "b:44");
  assert.equal(formatCursors([["a", Number.NaN], ["", 4]]), "");
  assert.equal(formatCursors([["a", 12.7]]), "a:12");
});

test("streamUrl carries the full project set and every cursor", () => {
  assert.equal(streamUrl(["a", "b"], [["a", 120]]), "/api/events/stream?projects=a,b&since=a%3A120");
  // No cursors yet: the server reads that as "from the beginning".
  assert.equal(streamUrl(["a"], []), "/api/events/stream?projects=a");
  // No projects means "all currently open" to the host.
  assert.equal(streamUrl([], []), "/api/events/stream");
  assert.equal(streamUrl(["my mesh"], []), "/api/events/stream?projects=my%20mesh");
});

test("a server with no registry is streamed on its own route, resumed by sinceSeq, never multiplexed", () => {
  assert.equal(singleStreamUrl(0), "/events/stream", "no position: the server starts at the recent end of the log");
  assert.equal(singleStreamUrl(412), "/events/stream?sinceSeq=412");
  assert.equal(singleStreamUrl(12.9), "/events/stream?sinceSeq=12", "a cursor is a whole sequence number");
  assert.equal(singleStreamUrl(-3), "/events/stream", "a negative cursor claims no position");
  assert.equal(singleStreamUrl(Number.NaN), "/events/stream");
  assert.ok(!singleStreamUrl(5).includes("/api/"), "a single-mesh server has no /api/events/stream");
});

test("projectPath prefixes only when a project is named", () => {
  assert.equal(projectPath("acme", "/status"), "/api/p/acme/status");
  assert.equal(projectPath("my mesh", "/status"), "/api/p/my%20mesh/status");
  assert.equal(projectPath(null, "/api/projects"), "/api/projects");
  assert.equal(projectPath(undefined, "/status"), "/status");
  // Query strings ride along untouched — the child parses them, not us.
  assert.equal(projectPath("acme", "/steps?limit=60"), "/api/p/acme/steps?limit=60");
});

test("the Projects page is a host page: its address never names a project, and it is not a legacy link to redirect", () => {
  assert.ok(VIEWS.includes("projects"));
  assert.deepEqual([...HOST_VIEWS], ["projects"]);
  assert.equal(isHostView("projects"), true);
  assert.equal(isHostView("overview"), false);

  const r = parseHash("#/projects");
  assert.equal(r.projectId, null);
  assert.equal(r.view, "projects");
  // Every other bare link names no project because it predates them, and is rewritten onto the active one. This is not one.
  assert.equal(needsProjectRedirect(r), false);
  assert.equal(needsProjectRedirect(parseHash("#/overview")), true);

  // Whichever project is in front, the page is the same address.
  assert.equal(hashFor("acme", "projects"), "#/projects");
  assert.equal(hashFor(null, "projects"), "#/projects");
  assert.equal(hashFor("acme", "projects", { kind: "step", id: "x" }), "#/projects", "a host page has no detail");
  assert.deepEqual(parseHash(hashFor("acme", "projects")), { projectId: null, view: "projects" });
});

test("a host page ignores a detail written after it, and a project link to it still reads as the page", () => {
  assert.deepEqual(parseHash("#/projects/step/turn-1"), { projectId: null, view: "projects" });
  const inProject = parseHash("#/p/acme/projects");
  assert.equal(inProject.view, "projects");
  assert.equal(inProject.projectId, "acme");
  assert.equal(needsProjectRedirect(inProject), false);
});
