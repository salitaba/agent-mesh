import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { MemoryEventStore, JsonlEventStore, type EventStore } from "../../packages/event-store/src/index";
import type { MeshEvent } from "../../packages/protocol/src/index";

function tmpLog(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mesh-sub-")), "events.jsonl");
}

function evt(n: number): MeshEvent {
  return {
    id: `evt-${n}`,
    type: "message.sent",
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
    payload: { n },
  } as MeshEvent;
}

/** Both implementations, so a fix to one never quietly skips the other. */
const stores: Array<[string, () => { store: EventStore; file?: string }]> = [
  ["MemoryEventStore", () => ({ store: new MemoryEventStore() })],
  [
    "JsonlEventStore",
    () => {
      const file = tmpLog();
      return { store: new JsonlEventStore(file), file };
    },
  ],
];

for (const [name, make] of stores) {
  // The bug this replaces: the only push path — a file watcher since deleted,
  // `EventTailer` — kept its cursor in a map keyed by file path, so two
  // followers of one log advanced the SAME cursor and each event reached
  // exactly one of them.
  test(`${name}: two subscribers each receive every event, not one each`, async () => {
    const { store } = make();
    const a: number[] = [];
    const b: number[] = [];
    store.subscribe!((e) => a.push((e.payload as { n: number }).n));
    store.subscribe!((e) => b.push((e.payload as { n: number }).n));

    for (let n = 1; n <= 4; n++) await store.append(evt(n));

    assert.deepEqual(a, [1, 2, 3, 4], "first subscriber saw the whole log");
    assert.deepEqual(b, [1, 2, 3, 4], "second subscriber saw the whole log too");
    await store.close?.();
  });

  test(`${name}: subscribers see the STORED event, with seq already assigned`, async () => {
    const { store } = make();
    const seen: Array<number | undefined> = [];
    store.subscribe!((e) => seen.push(e.seq));
    await store.append(evt(1));
    await store.append(evt(2));
    assert.deepEqual(seen, [1, 2], "seq is assigned by append, so followers can order by it");
    await store.close?.();
  });

  test(`${name}: unsubscribe stops delivery and leaves other subscribers alone`, async () => {
    const { store } = make();
    const a: number[] = [];
    const b: number[] = [];
    const off = store.subscribe!((e) => a.push((e.payload as { n: number }).n));
    store.subscribe!((e) => b.push((e.payload as { n: number }).n));

    await store.append(evt(1));
    off();
    await store.append(evt(2));

    assert.deepEqual(a, [1], "detached subscriber is silent");
    assert.deepEqual(b, [1, 2], "the survivor is untouched");
    await store.close?.();
  });

  test(`${name}: a throwing subscriber breaks neither the append nor its peers`, async () => {
    const { store } = make();
    const survivor: number[] = [];
    store.subscribe!(() => {
      throw new Error("subscriber blew up");
    });
    store.subscribe!((e) => survivor.push((e.payload as { n: number }).n));

    const stored = await store.append(evt(1));

    assert.equal(stored.seq, 1, "append still resolves normally");
    assert.deepEqual(survivor, [1], "the second subscriber still ran");
    await store.close?.();
  });

  test(`${name}: a duplicate append is not re-delivered`, async () => {
    const { store } = make();
    const seen: number[] = [];
    store.subscribe!((e) => seen.push((e.payload as { n: number }).n));
    await store.append(evt(1));
    await store.append(evt(1));
    assert.deepEqual(seen, [1], "dedup happens before fan-out, so followers do not double-count");
    await store.close?.();
  });

  // The second half of the watcher bug: its cursor was never reset on
  // truncate, so after a mission reset every event up to the old offset was
  // skipped forever. A subscription is attached to the store, not to a byte
  // offset, so a reset cannot desynchronise it.
  test(`${name}: a reset does not detach subscribers or skip post-reset events`, async () => {
    const { store } = make();
    if (!store.reset) return;
    const seen: number[] = [];
    store.subscribe!((e) => seen.push((e.payload as { n: number }).n));

    await store.append(evt(1));
    await store.append(evt(2));
    await store.reset();
    await store.append(evt(3));

    assert.deepEqual(seen, [1, 2, 3], "delivery continues across the reset");
    assert.equal((await store.read()).length, 1, "but the log itself really was emptied");
    await store.close?.();
  });
}

// ------------------------------------------------------------ durability

test("JsonlEventStore.flush: appends are on disk once it resolves", async () => {
  const file = tmpLog();
  const store = new JsonlEventStore(file);
  // Fewer than SYNC_EVERY, so the ambient fsync cadence has NOT fired: this
  // is exactly the window flush() exists to close.
  for (let n = 1; n <= 5; n++) await store.append(evt(n));

  await store.flush();

  const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0);
  assert.equal(lines.length, 5, "every appended event reached the file");
  assert.deepEqual(
    lines.map((l) => (JSON.parse(l) as MeshEvent).id),
    ["evt-1", "evt-2", "evt-3", "evt-4", "evt-5"],
    "and in append order",
  );
  await store.close();
});

test("JsonlEventStore.flush: the handle survives, so appends continue afterwards", async () => {
  const file = tmpLog();
  const store = new JsonlEventStore(file);
  await store.append(evt(1));
  await store.flush();
  await store.append(evt(2));
  await store.flush();

  const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0);
  assert.equal(lines.length, 2, "flush is a barrier, not a close");
  await store.close();
});

test("JsonlEventStore.flush: a queued write failure surfaces instead of being swallowed", async () => {
  const file = tmpLog();
  const store = new JsonlEventStore(file);
  await store.append(evt(1));
  // Force the queued write to fail the way a full disk or revoked handle would.
  const broken = store as unknown as { writeChain: Promise<void>; writeError: unknown };
  broken.writeChain = broken.writeChain.then(() => {
    broken.writeError = new Error("disk went away");
  });

  await assert.rejects(() => store.flush(), /disk went away/, "flush is where a caller learns the truth");
  await store.close();
});

test("MemoryEventStore.flush exists and is a no-op, so callers need no special case", async () => {
  const store = new MemoryEventStore();
  await store.append(evt(1));
  await store.flush();
  assert.equal((await store.read()).length, 1);
});

/**
 * The barrier now sits on every mutating HTTP response rather than at a
 * handful of hand-picked call sites, which is only affordable if a flush with
 * nothing pending costs nothing. The read-only MCP tool calls share that path
 * and append nothing at all; an unconditional fsync there would have put the
 * per-emit syscall cost back exactly where it was removed from.
 */
test("JsonlEventStore.flush: a store with nothing pending does no work at all", async () => {
  const file = tmpLog();
  const store = new JsonlEventStore(file);
  const inner = store as unknown as { handle: unknown };

  await store.flush();
  assert.equal(inner.handle, null, "a barrier on a clean store must not even open the log");
  await store.close();
});

test("JsonlEventStore.flush: a second barrier with no append between is free", async () => {
  const file = tmpLog();
  const store = new JsonlEventStore(file);
  await store.append(evt(1));
  await store.flush();

  const inner = store as unknown as { handle: { sync(): Promise<void> } };
  const realSync = inner.handle.sync.bind(inner.handle);
  let syncs = 0;
  inner.handle.sync = async (): Promise<void> => {
    syncs++;
    await realSync();
  };

  await store.flush();
  await store.flush();
  assert.equal(syncs, 0, "nothing was appended, so there is nothing to make durable");

  await store.append(evt(2));
  await store.flush();
  assert.equal(syncs, 1, "and a real append re-arms it");
  await store.close();
});

test("JsonlEventStore.flush: a poisoned queue keeps failing, it does not report durable once", async () => {
  const file = tmpLog();
  const store = new JsonlEventStore(file);
  await store.append(evt(1));
  const broken = store as unknown as { writeChain: Promise<void>; writeError: unknown };
  broken.writeChain = broken.writeChain.then(() => {
    broken.writeError = new Error("disk went away");
  });

  await assert.rejects(() => store.flush(), /disk went away/);
  // The dangerous shape would be a flush that clears its own pending flag on
  // the way out of a throw: the next receipt would be told the log is durable
  // by a store that has never written the line.
  await assert.rejects(() => store.flush(), /disk went away/, "the failure is sticky until someone deals with it");
  await store.close();
});

// --------------------------------------------------- validation parity

test("MemoryEventStore validates like JsonlEventStore, so tests and production agree", async () => {
  const store = new MemoryEventStore();
  const bogus = { ...evt(1), type: "totally.invented" } as unknown as MeshEvent;
  await assert.rejects(
    () => store.append(bogus),
    /Event rejected by canonical schema \(totally.invented\)/,
    "an event type missing from the canonical schema must fail in memory too — " +
      "otherwise it passes every in-memory test and throws on the first real emit",
  );
  assert.equal((await store.read()).length, 0, "and nothing was indexed");
});

test("both stores reject the same event", async () => {
  const file = tmpLog();
  const jsonl = new JsonlEventStore(file);
  const mem = new MemoryEventStore();
  const bogus = { ...evt(1), type: "totally.invented" } as unknown as MeshEvent;
  const memErr = await mem.append(bogus).then(() => null, (e: Error) => e.message);
  const jsonlErr = await jsonl.append(bogus).then(() => null, (e: Error) => e.message);
  assert.equal(memErr, jsonlErr, "identical rejection, not merely both non-null");
  await jsonl.close();
});
