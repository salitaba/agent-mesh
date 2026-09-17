import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { makeMesh, type TestMeshOptions } from "../helpers";
import { createHttpServer } from "../../apps/mesh-server/src/index";

/**
 * `/tool-approvals` is the only way an operator clears a seat the approval gate
 * is holding, so the shapes it answers with are load-bearing rather than
 * cosmetic: an operator surface branches on `ok`, and 400-vs-404 is what tells
 * "you left a field out" apart from "you named a seat that does not exist".
 *
 * The supervisor methods underneath are covered through the gate in
 * tests/integration/claude-runtime.test.ts; what is only reachable here is the
 * route's own validation, its status codes, and the audit trail it writes.
 */

type Seat = { agentId: string; requiresApproval: string[]; granted: string[] };

async function harness(opts: TestMeshOptions) {
  const m = await makeMesh(opts);
  const server = createHttpServer(m, { dashboardDir: undefined });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const post = async (body: unknown) => {
    const res = await fetch(`${base}/tool-approvals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return {
      status: res.status,
      json: (await res.json()) as { ok: boolean; reason?: string; agentId?: string; tool?: string; granted?: boolean },
    };
  };

  const list = async () => {
    const res = await fetch(`${base}/tool-approvals`);
    return { status: res.status, json: (await res.json()) as { seats: Seat[] } };
  };

  const seat = async (id: string) => (await list()).json.seats.find((s) => s.agentId === id);

  return {
    m,
    post,
    list,
    seat,
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      await m.cleanup();
    },
  };
}

const gatedDev: TestMeshOptions = {
  agents: [
    { id: "dev", role: "developer", capabilities: ["repository.write"], requiresApproval: ["repository.write"], interests: [] },
  ],
  mayContact: { dev: [] },
};

test("tool approvals: POST refuses a request missing either field", async () => {
  const h = await harness(gatedDev);
  try {
    for (const body of [{}, { agentId: "dev" }, { tool: "Edit" }]) {
      const r = await h.post(body);
      assert.equal(r.status, 400);
      assert.equal(r.json.ok, false);
      assert.match(r.json.reason ?? "", /provide `agentId` and `tool`/);
    }
    // Whitespace is trimmed before the emptiness check, so a field that looks
    // present but names nothing is refused rather than recorded as a grant on
    // a seat called "   ".
    assert.equal((await h.post({ agentId: "   ", tool: "Edit" })).status, 400);
    assert.equal((await h.post({ agentId: "dev", tool: "  " })).status, 400);
  } finally {
    await h.close();
  }
});

test("tool approvals: an unknown seat is 404, not a grant nothing will consume", async () => {
  const h = await harness(gatedDev);
  try {
    const r = await h.post({ agentId: "nope", tool: "Edit" });
    assert.equal(r.status, 404);
    assert.equal(r.json.ok, false);
    assert.match(r.json.reason ?? "", /unknown agent 'nope'/);
    // And the miss left no residue behind it.
    const seats = (await h.list()).json.seats;
    assert.equal(seats.some((s) => s.agentId === "nope"), false);
    assert.deepEqual((await h.seat("dev"))?.granted, []);
  } finally {
    await h.close();
  }
});

test("tool approvals: a grant round-trips through GET and revokes cleanly", async () => {
  const h = await harness(gatedDev);
  try {
    const granted = await h.post({ agentId: "dev", tool: "Edit" });
    assert.equal(granted.status, 200);
    assert.deepEqual(granted.json, { ok: true, agentId: "dev", tool: "Edit", granted: true });

    const dev = await h.seat("dev");
    assert.deepEqual(dev?.requiresApproval, ["repository.write"]);
    assert.deepEqual(dev?.granted, ["Edit"]);

    // Grants accumulate per tool rather than replacing one another: an operator
    // clearing two held calls should not have the first one silently dropped.
    assert.equal((await h.post({ agentId: "dev", tool: "Write" })).status, 200);
    assert.deepEqual((await h.seat("dev"))?.granted.slice().sort(), ["Edit", "Write"]);

    const revoked = await h.post({ agentId: "dev", tool: "Edit", revoke: true });
    assert.equal(revoked.status, 200);
    assert.deepEqual(revoked.json, { ok: true, agentId: "dev", tool: "Edit", granted: false });
    assert.deepEqual((await h.seat("dev"))?.granted, ["Write"]);

    // Revoking what is no longer granted is a 404 and says so precisely, so an
    // operator can tell a stale tab apart from a typo.
    const again = await h.post({ agentId: "dev", tool: "Edit", revoke: true });
    assert.equal(again.status, 404);
    assert.match(again.json.reason ?? "", /no grant for 'Edit' on 'dev'/);
  } finally {
    await h.close();
  }
});

test("tool approvals: `revoke` is honoured only when literally true", async () => {
  const h = await harness(gatedDev);
  try {
    await h.post({ agentId: "dev", tool: "Edit" });
    // The route reads `b.revoke === true`, so a truthy-but-not-true value is a
    // grant. Pinned because a form or a query string sending "true" as a string
    // would otherwise revoke by accident.
    const r = await h.post({ agentId: "dev", tool: "Edit", revoke: "true" });
    assert.equal(r.status, 200);
    assert.equal(r.json.granted, true);
    assert.deepEqual((await h.seat("dev"))?.granted, ["Edit"]);
  } finally {
    await h.close();
  }
});

test("tool approvals: GET lists gated seats only", async () => {
  const h = await harness({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write"], requiresApproval: ["repository.write"], interests: [] },
      { id: "reviewer", role: "reviewer", capabilities: ["repository.write"], interests: [] },
    ],
    mayContact: { dev: ["reviewer"], reviewer: ["dev"] },
  });
  try {
    const seats = (await h.list()).json.seats;
    assert.deepEqual(seats.map((s) => s.agentId), ["dev"]);

    // An ungated seat is a known agent, so the grant is accepted — but it has
    // nothing to unlock and never surfaces in the listing. Recorded here as the
    // behaviour it is: the route validates existence, not gatedness.
    const r = await h.post({ agentId: "reviewer", tool: "Edit" });
    assert.equal(r.status, 200);
    assert.equal(r.json.granted, true);
    assert.deepEqual((await h.list()).json.seats.map((s) => s.agentId), ["dev"]);
  } finally {
    await h.close();
  }
});

test("tool approvals: every decision lands in the auth audit log", async () => {
  const h = await harness(gatedDev);
  try {
    await h.post({ agentId: "dev", tool: "Edit" });
    await h.post({ agentId: "dev", tool: "Edit", revoke: true });
    // A refused call must not be audited as a decision: the log is what an
    // operator reads back to answer "who unlocked this", and a 404 unlocked
    // nothing.
    await h.post({ agentId: "nope", tool: "Edit" });

    const log = fs.readFileSync(`${h.m.config.stateDir}/logs/auth-audit.log`, "utf8");
    const lines = log.split("\n").filter((l) => l.includes("tool-approval"));
    assert.equal(lines.length, 2);
    assert.match(lines[0], /tool-approval grant agent=dev tool=Edit/);
    assert.match(lines[1], /tool-approval revoke agent=dev tool=Edit/);
  } finally {
    await h.close();
  }
});
