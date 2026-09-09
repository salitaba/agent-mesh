import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { MemoryEventStore, JsonlEventStore, type EventStore } from "../../packages/event-store/src/index";
import type { MeshEvent } from "../../packages/protocol/src/index";

function evt(seqHint: number, extra: Partial<MeshEvent> = {}): MeshEvent {
  return {
    type: "message.sent",
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, seqHint)).toISOString(),
    payload: {},
    ...extra,
    id: extra.id ?? `evt-${seqHint}`,
  } as MeshEvent;
}

async function fill(store: EventStore, n: number): Promise<void> {
  for (let i = 1; i <= n; i++) {
    await store.append(evt(i, i % 10 === 0 ? { correlationId: "turn-x" } : {}));
  }
}

function checkStore(make: () => EventStore, label: string): void {
  test(`${label}: tail returns the newest events in order`, async () => {
    const s = make();
    await fill(s, 100);
    const got = await s.read({ tail: 10 });
    assert.deepEqual(got.map((e) => e.seq), [91, 92, 93, 94, 95, 96, 97, 98, 99, 100]);
  });

  test(`${label}: head limit semantics preserved for catch-up`, async () => {
    const s = make();
    await fill(s, 100);
    const got = await s.read({ sinceSeq: 90, limit: 5 });
    assert.deepEqual(got.map((e) => e.seq), [91, 92, 93, 94, 95]);
  });

  test(`${label}: correlationId query returns only that turn`, async () => {
    const s = make();
    await fill(s, 100);
    const got = await s.read({ correlationId: "turn-x" });
    assert.equal(got.length, 10);
    assert.ok(got.every((e) => e.correlationId === "turn-x"));
    assert.deepEqual(got.map((e) => e.seq), [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  });

  test(`${label}: tail larger than the log returns everything`, async () => {
    const s = make();
    await fill(s, 5);
    assert.equal((await s.read({ tail: 1000 })).length, 5);
  });

  test(`${label}: tail of zero or less returns nothing`, async () => {
    const s = make();
    await fill(s, 10);
    assert.deepEqual(await s.read({ tail: 0 }), []);
  });

  test(`${label}: tail combines with sinceSeq, tail wins over limit`, async () => {
    const s = make();
    await fill(s, 100);
    assert.deepEqual(
      (await s.read({ sinceSeq: 90, tail: 5 })).map((e) => e.seq),
      [96, 97, 98, 99, 100],
    );
    assert.deepEqual(
      (await s.read({ sinceSeq: 0, limit: 5, tail: 3 })).map((e) => e.seq),
      [98, 99, 100],
    );
    assert.deepEqual(
      (await s.read({ correlationId: "turn-x", tail: 4 })).map((e) => e.seq),
      [70, 80, 90, 100],
    );
  });

  test(`${label}: re-append does not double-index the correlation`, async () => {
    const s = make();
    await fill(s, 10);
    await s.append(evt(10, { correlationId: "turn-x" }));
    const got = await s.read({ correlationId: "turn-x" });
    assert.equal(got.length, 1);
    assert.equal((await s.read()).length, 10);
  });
}

checkStore(() => new MemoryEventStore(), "memory");

const sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-store-test-"));
checkStore(() => new JsonlEventStore(path.join(sharedDir, `events-${Math.random().toString(36).slice(2)}.jsonl`)), "jsonl");

test("jsonl: log persists across instances with dedup", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-store-test-"));
  const file = path.join(dir, "events.jsonl");
  const first = new JsonlEventStore(file);
  await fill(first, 100);
  await first.close();
  const reopened = new JsonlEventStore(file);
  assert.equal((await reopened.read()).length, 100);
  // Re-appending the same ids is a no-op.
  await reopened.append(evt(1));
  assert.equal((await reopened.read()).length, 100);
  assert.equal((await reopened.read({ correlationId: "turn-x" })).length, 10);
  await reopened.close();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(sharedDir, { recursive: true, force: true });
});

test("jsonl: concurrent appends stay ordered and durable after close", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-store-test-"));
  const file = path.join(dir, "events.jsonl");
  const s = new JsonlEventStore(file);
  // Fire all appends without awaiting: seq assignment is synchronous, so file
  // order must still match call order even though durability is async.
  await Promise.all(Array.from({ length: 50 }, (_, i) => s.append(evt(i + 1))));
  // Read-your-write is immediate (cache), without waiting for disk.
  assert.equal((await s.read()).length, 50);
  await s.close();
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0);
  assert.equal(lines.length, 50);
  assert.deepEqual(
    lines.map((l) => (JSON.parse(l) as MeshEvent).seq),
    Array.from({ length: 50 }, (_, i) => i + 1),
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
