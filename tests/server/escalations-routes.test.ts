/**
 * The child mesh server's `/escalations` routes over HTTP.
 *
 * Every other verb on this resource resolves a card that something inside the
 * mesh already raised; `POST /escalations/host-ceiling` is the one that makes
 * one, and it exists for a caller that is not inside the mesh at all — the
 * multi-project host, which parks children when its aggregate dollar ceiling
 * trips and until now did so without leaving a word anywhere the operator of
 * that mission would look.
 *
 * The host-side half (fires once per trip, fires again after a raise) lives in
 * `host-resources.test.ts`. This file is the child's half: what the route
 * accepts, what it refuses, and what the card it mints actually says.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHttpServer, closeHttpServer } from "../../apps/mesh-server/src/index";
import { HOST_LIMITER_RAISER, HOST_SPEND_CEILING_REASON } from "../../packages/protocol/src/index";
import { makeMesh } from "../helpers";

interface Card {
  id: string;
  reason: string;
  raisedBy: string;
  status: string;
  conflictKey?: string;
  detail?: { usd?: number; ceilingUsd?: number };
}

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const m = await makeMesh({
    agents: [{ id: "a", role: "r", interests: [] }],
    mayContact: { a: [] },
    // Parked: this route is about a mission the host has just stopped, and a
    // scheduler running underneath the assertions would only add noise.
    mode: "parked",
  });
  const server = createHttpServer(m, { dashboardDir: undefined });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await fn(base);
  } finally {
    await closeHttpServer(server);
    await m.cleanup();
  }
}

async function raise(base: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${base}/escalations/host-ceiling`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

async function cards(base: string): Promise<Card[]> {
  return (await (await fetch(`${base}/escalations`)).json()) as Card[];
}

test("POST /escalations/host-ceiling raises a card attributed to the host, not to a human", async () => {
  await withServer(async (base) => {
    assert.deepEqual(await cards(base), [], "a fresh mesh has raised nothing");

    const res = await raise(base, { usd: 36.5, ceilingUsd: 5 });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.reason, HOST_SPEND_CEILING_REASON);

    const [card] = await cards(base);
    assert.equal(card.reason, HOST_SPEND_CEILING_REASON);
    // The attribution that matters. No human decided this and no agent did
    // either: a host process hit its own limit and reached in from outside.
    // `human` here would read on the timeline as an operator having stopped
    // the mission by hand, which is a different event entirely.
    assert.equal(card.raisedBy, HOST_LIMITER_RAISER);
    assert.equal(card.status, "OPEN");
    // The numbers the card is for. Without them it says a ceiling was hit and
    // leaves the operator to guess which one and by how much.
    assert.equal(card.detail?.usd, 36.5);
    assert.equal(card.detail?.ceilingUsd, 5);
  });
});

test("the ceiling card dedupes per ceiling: same one folds, a raised one is new news", async () => {
  await withServer(async (base) => {
    const first = await raise(base, { usd: 36, ceilingUsd: 5 });
    // Second line of defence behind the host's own once-guard: the host is not
    // the only thing that can call this, and a retried call must not double
    // the cards.
    const again = await raise(base, { usd: 40, ceilingUsd: 5 });
    assert.equal(again.json.id, first.json.id, "the same ceiling folds into the open card");
    assert.equal((await cards(base)).length, 1);

    // But a ceiling the operator has since raised and then spent through is a
    // genuinely new event. Keying on a constant would have folded this into
    // the card above, leaving the only visible numbers the stale ones — the
    // same silent swallow one layer down from the one this route fixes.
    const raised = await raise(base, { usd: 120, ceilingUsd: 100 });
    assert.notEqual(raised.json.id, first.json.id, "a different ceiling is a different card");
    const open = await cards(base);
    assert.equal(open.length, 2);
    assert.deepEqual(
      open.map((c) => c.detail?.ceilingUsd),
      [5, 100],
    );
  });
});

test("the ceiling route refuses a body it cannot put in front of an operator", async () => {
  await withServer(async (base) => {
    // Nothing here reaches `escalate()`: `ceilingUsd` is hashed into the
    // conflictKey and both numbers are rendered into operator-facing copy, so
    // a card reading "$NaN" would be worse than no card at all.
    for (const body of [{}, { usd: 10 }, { usd: "lots", ceilingUsd: 5 }, { usd: 10, ceilingUsd: -1 }, { usd: 10, ceilingUsd: "5; DROP" }]) {
      const res = await raise(base, body);
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}, got ${res.status}`);
      assert.equal(res.json.ok, false);
    }
    assert.deepEqual(await cards(base), [], "a refused request leaves no card behind");
  });
});
