import test from "node:test";
import assert from "node:assert/strict";

import { HOST_SECTION, holdsForProject, isHostView, serverKind, showsSection } from "../../apps/mesh-dashboard/src/navmodel";

/**
 * The README's quick start serves one mesh with no registry. The sidebar offered it "Projects" and "Host settings", pages that
 * only a host has, and the host's licence request answered 404 on every load. These pin which server shows which pages.
 */

const facts = (hasRegistry: boolean | null, loaded: boolean, projectCount: number) => ({ hasRegistry, loaded, projectCount });

test("what kind of server this is, from what the registry has said", () => {
  assert.equal(serverKind(null), "single", "no provider at all: one mesh, nothing to ask");
  assert.equal(serverKind(facts(null, false, 0)), "pending");
  assert.equal(serverKind(facts(false, false, 0)), "single", "a registry route that does not exist");
  assert.equal(serverKind(facts(true, true, 2)), "host");
  assert.equal(serverKind(facts(true, true, 0)), "empty-host", "a host that has answered and holds nothing is first run");
  assert.equal(serverKind(facts(true, false, 0)), "host", "a host that has not listed its projects yet is not empty yet");
});

test("a single-mesh server has no Host group, and neither does one that has not said what it is", () => {
  for (const kind of ["single", "pending"] as const) {
    assert.equal(showsSection(kind, HOST_SECTION), false, kind);
    for (const section of ["Mission", "Results", "Team"]) assert.equal(showsSection(kind, section), true, `${kind} ${section}`);
  }
});

test("a host shows every group, and a host with no project shows only its own", () => {
  for (const section of ["Mission", "Results", "Team", HOST_SECTION]) assert.equal(showsSection("host", section), true, section);
  assert.equal(showsSection("empty-host", HOST_SECTION), true);
  for (const section of ["Mission", "Results", "Team"]) assert.equal(showsSection("empty-host", section), false, section);
});

test("the two host-only pages are named, so an address that reaches one on a single mesh can be explained", () => {
  assert.equal(isHostView("projects"), true);
  assert.equal(isHostView("hostsettings"), true);
  for (const v of ["overview", "events", "designer", "cost"]) assert.equal(isHostView(v), false, v);
});

test("a host's view area waits while its project is starting, so no view asks for a mission that is not there and is told 409", () => {
  assert.equal(holdsForProject("host", "overview", { chosen: true, status: "booting" }), true, "the project's process is still starting");
  assert.equal(holdsForProject("host", "events", { chosen: false, status: null }), true, "a beat after the first project is made, before it is the one in front");
  assert.equal(holdsForProject("host", "overview", { chosen: true, status: "open" }), false);
  for (const status of ["closed", "crashed", "locked", "error"]) {
    assert.equal(holdsForProject("host", "overview", { chosen: true, status }), false, `${status}: the page says so itself, in its own words`);
  }
});

test("the host's own pages and a single mesh are never held", () => {
  assert.equal(holdsForProject("host", "projects", { chosen: false, status: "booting" }), false, "the Projects page lists the registry and needs no project");
  assert.equal(holdsForProject("host", "hostsettings", { chosen: true, status: "booting" }), false);
  assert.equal(holdsForProject("single", "overview", { chosen: false, status: null }), false, "one mesh, always there to ask");
  assert.equal(holdsForProject("pending", "overview", { chosen: false, status: null }), false, "the registry's own pending state holds the content already");
  assert.equal(holdsForProject("empty-host", "overview", { chosen: false, status: null }), false, "first run shows the welcome instead");
});
