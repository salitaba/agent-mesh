import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { JsonlEventStore } from "../../packages/event-store/src/index";
import type { MeshEvent } from "../../packages/protocol/src/index";

function tmpLog(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-torn-"));
  return { dir, file: path.join(dir, "events.jsonl") };
}

function evt(i: number): MeshEvent {
  return {
    id: `evt-${i}`,
    seq: i,
    protocolVersion: "1.0",
    type: "human.input",
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    actorId: "human",
    payload: { action: `probe-${i}` },
  } as MeshEvent;
}

function seed(file: string, count: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = [];
  for (let i = 1; i <= count; i++) lines.push(JSON.stringify(evt(i)));
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
}

test("torn line: replay keeps every whole event and drops the truncated tail", async () => {
  const { dir, file } = tmpLog();
  try {
    seed(file, 3);
    // A SIGKILL mid-append: the last line has no terminator and is half JSON.
    fs.appendFileSync(file, '{"id":"evt-4","seq":4,"type":"hum', "utf8");

    const store = new JsonlEventStore(file);
    const events = await store.read();
    assert.equal(events.length, 3, "the three complete events must survive");
    assert.deepEqual(events.map((e) => e.id), ["evt-1", "evt-2", "evt-3"]);
    assert.equal(await store.lastSeq(), 3, "seq must not count the torn line");

    const integrity = store.integrity();
    assert.ok(integrity.truncatedTailBytes > 0, "the repair must be reported, not silent");
    assert.equal(integrity.corruptLines, 0);
    await store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("torn line: the tail is truncated on disk so the next append is not welded onto it", async () => {
  const { dir, file } = tmpLog();
  try {
    seed(file, 2);
    fs.appendFileSync(file, '{"id":"evt-3","seq":3,"typ', "utf8");

    const store = new JsonlEventStore(file);
    await store.read(); // triggers load + repair
    await store.append({
      id: "evt-9",
      protocolVersion: "1.0",
      type: "human.input",
      timestamp: new Date(Date.UTC(2026, 0, 2)).toISOString(),
      actorId: "human",
      payload: { action: "after-crash" },
    } as MeshEvent);
    await store.close();

    // The decisive assertion: without truncation, append mode concatenates
    // onto the torn line and the NEW event is lost too.
    const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line), `every line on disk must parse: ${line}`);
    }
    const reopened = new JsonlEventStore(file);
    const ids = (await reopened.read()).map((e) => e.id);
    assert.deepEqual(ids, ["evt-1", "evt-2", "evt-9"]);
    await reopened.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("torn line: a complete but unterminated final line is kept", async () => {
  const { dir, file } = tmpLog();
  try {
    seed(file, 2);
    // Whole JSON, newline never flushed. This is valid data — discarding it
    // would lose a real event on every crash between write and fsync.
    fs.appendFileSync(file, JSON.stringify(evt(3)), "utf8");

    const store = new JsonlEventStore(file);
    const ids = (await store.read()).map((e) => e.id);
    assert.deepEqual(ids, ["evt-1", "evt-2", "evt-3"]);
    assert.equal(store.integrity().truncatedTailBytes, 0, "nothing was torn");
    await store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("torn line: garbage in the middle is skipped and counted, not truncated", async () => {
  const { dir, file } = tmpLog();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      [JSON.stringify(evt(1)), "{not json at all", JSON.stringify(evt(3))].join("\n") + "\n",
      "utf8",
    );
    const store = new JsonlEventStore(file);
    const ids = (await store.read()).map((e) => e.id);
    // Mid-log corruption must not take the events AFTER it down with it.
    assert.deepEqual(ids, ["evt-1", "evt-3"]);
    const integrity = store.integrity();
    assert.equal(integrity.corruptLines, 1);
    assert.equal(integrity.truncatedTailBytes, 0, "mid-log garbage is not an interrupted write");
    await store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("torn line: a clean log reports no repairs", async () => {
  const { dir, file } = tmpLog();
  try {
    seed(file, 4);
    const store = new JsonlEventStore(file);
    assert.equal((await store.read()).length, 4);
    assert.deepEqual(store.integrity(), { truncatedTailBytes: 0, corruptLines: 0 });
    await store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("torn line: an empty and a nonexistent log both replay as empty", async () => {
  const { dir, file } = tmpLog();
  try {
    const fresh = new JsonlEventStore(file);
    assert.equal((await fresh.read()).length, 0);
    assert.deepEqual(fresh.integrity(), { truncatedTailBytes: 0, corruptLines: 0 });
    await fresh.close();

    const again = new JsonlEventStore(file);
    assert.equal((await again.read()).length, 0);
    await again.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
