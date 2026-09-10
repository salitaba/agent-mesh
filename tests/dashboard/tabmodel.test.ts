import test from "node:test";
import assert from "node:assert/strict";

import {
  RETAIN_ACTIVE,
  RETAIN_BACKGROUND,
  formatRss,
  moveTab,
  nextActive,
  orderTabs,
  reorderTabs,
  retainCap,
  tabStatus,
  trimRetained,
} from "../../apps/mesh-dashboard/src/tabmodel";

test("tabStatus separates running from parked", () => {
  assert.equal(tabStatus({ id: "a", status: "open" }).tone, "running");
  // Parked is per-mission state the registry cannot see, so it is passed in.
  assert.equal(tabStatus({ id: "a", status: "open" }, true).tone, "parked");
  assert.equal(tabStatus({ id: "a", status: "open" }, true).restartable, false);
});

test("tabStatus offers a restart for every state an operator can act on", () => {
  for (const status of ["crashed", "locked", "error"]) {
    assert.equal(tabStatus({ id: "a", status }).restartable, true, status);
  }
  for (const status of ["open", "booting", "closed"]) {
    assert.equal(tabStatus({ id: "a", status }).restartable, false, status);
  }
});

test("a crashed tab explains why, and whether anything will retry", () => {
  const auto = tabStatus({ id: "a", status: "crashed", restartInMs: 4200, error: { reason: "exit 1" } });
  assert.match(auto.hint, /exit 1/);
  assert.match(auto.hint, /Retrying in 4s/);

  // A tripped breaker means nothing is coming: saying "retrying" there would
  // be a lie the operator waits on.
  const tripped = tabStatus({ id: "a", status: "crashed", tripped: true, restartInMs: 4200, error: { reason: "exit 1" }, health: { rss: 1, lastHeartbeat: "", restarts: 5 } });
  assert.doesNotMatch(tripped.hint, /Retrying in/);
  assert.match(tripped.hint, /Restarted 5×/);
  assert.match(tripped.hint, /by hand/);
});

test("an unknown status degrades instead of throwing", () => {
  assert.equal(tabStatus({ id: "a", status: "wat" }).tone, "unknown");
});

test("formatRss says nothing rather than a fake zero", () => {
  assert.equal(formatRss(undefined), "");
  assert.equal(formatRss(0), "");
  assert.equal(formatRss(Number.NaN), "");
  assert.equal(formatRss(400 * 1024), "<1 MB");
  assert.equal(formatRss(220 * 1024 * 1024), "220 MB");
  assert.equal(formatRss(2 * 1024 * 1024 * 1024), "2.0 GB");
});

test("background projects retain far less than the active one", () => {
  assert.equal(retainCap(false), RETAIN_ACTIVE);
  assert.equal(retainCap(true), RETAIN_BACKGROUND);
  assert.ok(RETAIN_BACKGROUND < RETAIN_ACTIVE);
});

test("trimRetained keeps the newest and does not churn identity under the cap", () => {
  const list = [1, 2, 3, 4, 5];
  // Same reference under the cap: a new array every ingest would re-render
  // every consumer for no change.
  assert.equal(trimRetained(list, 5), list);
  assert.equal(trimRetained(list, 9), list);
  assert.deepEqual(trimRetained(list, 2), [4, 5]);
});

test("orderTabs honours the remembered order and tolerates it being stale", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(orderTabs(items, ["c", "a", "b"]).map((x) => x.id), ["c", "a", "b"]);
  // Unknown ids append in arrival order; a remembered id that is gone leaves
  // no hole.
  assert.deepEqual(orderTabs(items, ["c", "gone"]).map((x) => x.id), ["c", "a", "b"]);
  assert.deepEqual(orderTabs(items, []).map((x) => x.id), ["a", "b", "c"]);
});

test("reorderTabs drops the dragged tab where it was dropped", () => {
  const order = ["a", "b", "c", "d"];
  assert.deepEqual(reorderTabs(order, "a", "c"), ["b", "c", "a", "d"]);
  assert.deepEqual(reorderTabs(order, "d", "b"), ["a", "d", "b", "c"]);
  // No-ops stay no-ops instead of reshuffling.
  assert.deepEqual(reorderTabs(order, "a", "a"), order);
  assert.deepEqual(reorderTabs(order, "a", "zz"), order);
  assert.deepEqual(reorderTabs(order, "zz", "a"), order);
});

test("moveTab is the keyboard equivalent and clamps at the ends", () => {
  const order = ["a", "b", "c"];
  assert.deepEqual(moveTab(order, "b", -1), ["b", "a", "c"]);
  assert.deepEqual(moveTab(order, "b", 1), ["a", "c", "b"]);
  assert.deepEqual(moveTab(order, "a", -1), order);
  assert.deepEqual(moveTab(order, "c", 1), order);
  assert.deepEqual(moveTab(order, "zz", 1), order);
});

test("closing a tab moves focus only when the closed tab was the active one", () => {
  const ids = ["a", "b", "c"];
  assert.equal(nextActive(ids, "b", "b"), "c");
  assert.equal(nextActive(ids, "c", "c"), "b");
  // Something else shutting down must not yank the operator's view.
  assert.equal(nextActive(ids, "a", "c"), "c");
  assert.equal(nextActive(["a"], "a", "a"), null);
});
