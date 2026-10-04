import { test } from "node:test";
import assert from "node:assert/strict";
import { BURST_MS, LIMIT, emptyHistory, labels, record, redo, undo, type History, type Snap } from "../../apps/mesh-dashboard/src/designer/history";

const snap = (label: string, n: number): Snap => ({ label, model: { n }, cur: null });
const now = (n: number) => ({ model: { n }, cur: null as string | null });

test("nothing to undo or redo on a fresh history, and the labels say so", () => {
  const h = emptyHistory();
  assert.equal(undo(h, now(0)), null);
  assert.equal(redo(h, now(0)), null);
  assert.deepEqual(labels(h), { undo: null, redo: null });
});

test("steps undo one at a time, newest first, and each can be redone", () => {
  let h: History = emptyHistory();
  h = record(h, snap("Added seat seat-1", 0));
  h = record(h, snap("Added seat seat-2", 1));
  assert.deepEqual(labels(h), { undo: "Added seat seat-2", redo: null });

  const a = undo(h, now(2))!;
  assert.deepEqual(a.restore.model, { n: 1 });
  assert.deepEqual(labels(a.history), { undo: "Added seat seat-1", redo: "Added seat seat-2" });

  const b = undo(a.history, now(1))!;
  assert.deepEqual(b.restore.model, { n: 0 });
  assert.equal(undo(b.history, now(0)), null, "the oldest step is the end");

  const c = redo(b.history, now(0))!;
  assert.deepEqual(c.restore.model, { n: 1 }, "redo puts back what was undone, from the state it left");
  const d = redo(c.history, now(1))!;
  assert.deepEqual(d.restore.model, { n: 2 });
  assert.equal(redo(d.history, now(2)), null);
});

test("a new change after an undo forks the history: the redo that pointed at a future that is gone is dropped", () => {
  let h: History = record(emptyHistory(), snap("A", 0));
  h = undo(h, now(1))!.history;
  assert.equal(labels(h).redo, "A");
  h = record(h, snap("B", 0));
  assert.equal(labels(h).redo, null);
});

test("typing in one field is one step however many keystrokes", () => {
  let h: History = emptyHistory();
  h = record(h, snap("Edited role", 0), { key: "role", at: 1000 });
  h = record(h, snap("Edited role", 1), { key: "role", at: 1300 });
  h = record(h, snap("Edited role", 2), { key: "role", at: 1900 });
  assert.equal(h.past.length, 1);
  assert.deepEqual(h.past[0]!.model, { n: 0 }, "the one step holds the state before the burst began");
});

test("a pause longer than the burst window, or another field, starts a new step", () => {
  let h: History = record(emptyHistory(), snap("Edited role", 0), { key: "role", at: 1000 });
  h = record(h, snap("Edited role", 1), { key: "role", at: 1000 + BURST_MS + 1 });
  assert.equal(h.past.length, 2);
  h = record(h, snap("Edited model", 2), { key: "model", at: 1000 + BURST_MS + 100 });
  assert.equal(h.past.length, 3);
});

test("a step with no key always stands alone, even right after another", () => {
  let h: History = record(emptyHistory(), snap("Added seat", 0), { at: 1000 });
  h = record(h, snap("Added seat", 1), { at: 1001 });
  assert.equal(h.past.length, 2);
});

test("a burst does not merge into a structural step that came before it", () => {
  let h: History = record(emptyHistory(), snap("Added seat", 0), { at: 1000 });
  h = record(h, snap("Edited role", 1), { key: "role", at: 1100 });
  assert.equal(h.past.length, 2);
});

test("the history is capped, dropping the oldest", () => {
  let h: History = emptyHistory();
  for (let i = 0; i < LIMIT + 5; i++) h = record(h, snap(`step ${i}`, i));
  assert.equal(h.past.length, LIMIT);
  assert.equal(h.past[0]!.label, "step 5");
});

test("undo leaves the history it was given untouched", () => {
  const h = record(emptyHistory(), snap("A", 0));
  const before = JSON.stringify(h);
  undo(h, now(1));
  assert.equal(JSON.stringify(h), before);
});
