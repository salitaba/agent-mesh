import test from "node:test";
import assert from "node:assert/strict";

import { HOST_SECTION, isHostView, serverKind, showsSection } from "../../apps/mesh-dashboard/src/navmodel";

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
