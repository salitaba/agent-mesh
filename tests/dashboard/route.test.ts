import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_VIEW,
  formatCursors,
  hashFor,
  needsProjectRedirect,
  parseHash,
  pickActiveProject,
  projectPath,
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

test("projectPath prefixes only when a project is named", () => {
  assert.equal(projectPath("acme", "/status"), "/api/p/acme/status");
  assert.equal(projectPath("my mesh", "/status"), "/api/p/my%20mesh/status");
  assert.equal(projectPath(null, "/api/projects"), "/api/projects");
  assert.equal(projectPath(undefined, "/status"), "/status");
  // Query strings ride along untouched — the child parses them, not us.
  assert.equal(projectPath("acme", "/steps?limit=60"), "/api/p/acme/steps?limit=60");
});
