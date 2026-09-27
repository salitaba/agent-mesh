/**
 * `GET /agents/:id` carries the permissions the seat's runtime actually
 * enforces.
 *
 * The step view used to work these out itself, from a mirror of the deleted
 * OpenCode runtime's rules, and showed "edit: deny" (and red sandbox flags on
 * every Write) for seats whose writes the Claude gate let through. The route
 * now answers from `describeToolPermissions`, the function the gate decides
 * with, and says `null` for a runtime with no local gate rather than guessing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHttpServer, closeHttpServer } from "../../apps/mesh-server/src/index";
import { describeToolPermissions } from "../../packages/runtime-claude/src/index";
import { makeMesh, type TestMesh } from "../helpers";

async function withServer(fn: (base: string, m: TestMesh) => Promise<void>): Promise<void> {
  const m = await makeMesh({
    agents: [
      { id: "architect", role: "architect", interests: [], capabilities: ["architecture.write"], requiresApproval: ["architecture.write"] },
      { id: "reviewer", role: "qa", interests: [] },
    ],
    mayContact: { architect: [], reviewer: [] },
    mode: "parked",
  });
  // makeMesh writes every seat as `runtime: stub`; the Claude branch is what
  // is under test, so pose one seat as a Claude seat the way config would.
  (m.kernel.state.agents.get("architect")!.definition as { runtime: string }).runtime = "claude";
  const server = createHttpServer(m, { dashboardDir: undefined });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await fn(base, m);
  } finally {
    await closeHttpServer(server);
    await m.close?.();
  }
}

test("a Claude seat's detail carries the gate's own verdicts, approval holds included", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/agents/architect`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { permissions: { runtime: string; families: Record<string, { level: string }> } | null };
    assert.ok(body.permissions, "a claude seat has a local gate to describe");
    assert.equal(body.permissions.runtime, "claude");
    assert.deepEqual(body.permissions.families, describeToolPermissions(["architecture.write"], ["architecture.write"]));
    // architecture.write is an edit grant under the Claude gate; the old
    // dashboard mirror only knew repository.write and said "deny".
    assert.equal(body.permissions.families.edit!.level, "approval");
    assert.equal(body.permissions.families.read!.level, "allow");
  });
});

test("a seat on a runtime without a local gate says so instead of guessing", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/agents/reviewer`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { permissions?: unknown };
    assert.ok("permissions" in body, "the field is present, so the dashboard can tell 'none' from an old server");
    assert.equal(body.permissions, null);
  });
});
