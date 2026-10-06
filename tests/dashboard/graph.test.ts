import test from "node:test";
import assert from "node:assert/strict";

import {
  KINDS, around, capEdges, edgeKey, edgeText, edgeWidth, flowingKeys, isFlowing, kindOf, kindsPresent, labelPlacement, nodeTone, pairFilter, ringLayout, toggleKind, visibleEdges,
  type EdgeLike,
} from "../../apps/mesh-dashboard/src/graph";
import { eventHaystack, facetOne, facetValues, filterBase, parseFacets, type EventLike } from "../../apps/mesh-dashboard/src/eventmodel";

/**
 * The Graph page's decisions: where the seats sit, which way their labels point, what each kind of line is called, how many lines
 * are drawn, and which of them a recent message has travelled.
 */

const W = 900, H = 480;
const edge = (from: string, to: string, kind = "INFORM", count = 1): EdgeLike => ({ from, to, kind, count });

/* ------------------------------------------------------------------ layout */

test("one seat is in the middle, two face each other, and more share an ellipse that starts at the top", () => {
  assert.deepEqual(ringLayout(0, W, H), []);
  const one = ringLayout(1, W, H);
  assert.equal(one.length, 1);
  assert.deepEqual([one[0]!.x, one[0]!.y], [W / 2, H / 2]);
  const [a, b] = ringLayout(2, W, H);
  assert.equal(a!.y, b!.y, "side by side, not one above the other");
  assert.ok(a!.x < W / 2 && b!.x > W / 2);
  const three = ringLayout(3, W, H);
  assert.ok(Math.abs(three[0]!.x - W / 2) < 1e-9 && three[0]!.y < H / 2, "the first seat is at the top");
});

test("every seat is in the drawing at every roster size, and no two share a place", () => {
  for (let n = 1; n <= 16; n++) {
    const seats = ringLayout(n, W, H);
    assert.equal(seats.length, n);
    const places = new Set(seats.map((s) => `${Math.round(s.x)},${Math.round(s.y)}`));
    assert.equal(places.size, n, `${n} seats`);
    for (const s of seats) assert.ok(s.x > 0 && s.x < W && s.y > 0 && s.y < H, `${n} seats: (${s.x}, ${s.y})`);
  }
});

test("a seat's label points away from the centre, where no line runs", () => {
  for (let n = 1; n <= 16; n++) {
    for (const s of ringLayout(n, W, H)) {
      const spot = labelPlacement(s.angle);
      const out = spot.name.dx * Math.cos(s.angle) + spot.name.dy * Math.sin(s.angle);
      assert.ok(out > 0 || n === 1, `${n} seats, seat at ${Math.round(s.angle * 57.3)} degrees: the name is on the near side`);
      const outState = spot.state.dx * Math.cos(s.angle) + spot.state.dy * Math.sin(s.angle);
      assert.ok(outState > 0 || n === 1, "and so is the state word");
    }
  }
});

test("labels fit inside the drawing, side labels allowing a long name", () => {
  const NAME = 110; // the widest an id is allowed to be before it is clipped
  for (let n = 2; n <= 16; n++) {
    for (const s of ringLayout(n, W, H)) {
      const spot = labelPlacement(s.angle);
      for (const part of [spot.name, spot.state]) {
        const y = s.y + part.dy, x = s.x + part.dx;
        assert.ok(y >= 10 && y <= H - 4, `${n} seats: label at y=${y}`);
        if (spot.anchor === "end") assert.ok(x - NAME >= 0, `${n} seats: left label reaches x=${x - NAME}`);
        if (spot.anchor === "start") assert.ok(x + NAME <= W, `${n} seats: right label reaches x=${x + NAME}`);
      }
    }
  }
});

test("top labels stack up, bottom labels stack down, side labels go out to the side", () => {
  const top = labelPlacement(-Math.PI / 2);
  assert.equal(top.anchor, "middle");
  assert.ok(top.name.dy < 0 && top.state.dy < top.name.dy, "the state word is the outer line");
  const bottom = labelPlacement(Math.PI / 2);
  assert.ok(bottom.name.dy > 0 && bottom.state.dy > bottom.name.dy);
  assert.equal(labelPlacement(0).anchor, "start");
  assert.equal(labelPlacement(Math.PI).anchor, "end");
  assert.ok(labelPlacement(0).name.dx > 0 && labelPlacement(Math.PI).name.dx < 0);
});

/* ------------------------------------------------------------------- lines */

test("every kind has a word, and one the console has never heard of is still a message", () => {
  assert.deepEqual(KINDS.map((k) => k.id), ["REQUEST", "APPROVE", "BLOCK", "ESCALATE", "INFORM", "OTHER"]);
  assert.equal(kindOf("APPROVE").verb, "approved");
  assert.equal(kindOf("SOMETHING_NEW").id, "OTHER");
  assert.equal(kindOf("OTHER").label, "messaged");
});

test("a line in words", () => {
  assert.equal(edgeText(edge("pm", "architect", "REQUEST", 3)), "pm asked architect, 3 messages");
  assert.equal(edgeText(edge("pm", "architect", "OTHER", 1)), "pm messaged architect, 1 message");
  assert.equal(edgeKey(edge("a", "b", "BLOCK")), "a|b|BLOCK");
});

test("the legend lists the kinds that are drawn, in its own order, and not the rest", () => {
  const present = kindsPresent([edge("a", "b", "OTHER"), edge("a", "c", "REQUEST"), edge("b", "c", "OTHER"), edge("c", "a", "WEIRD")]);
  assert.deepEqual(present.map((k) => k.id), ["REQUEST", "OTHER"], "an unknown kind folds into 'messaged', once");
  assert.deepEqual(kindsPresent([]), []);
  assert.deepEqual(kindsPresent([edge("a", "b", "WEIRD")]).map((k) => k.id), ["OTHER"], "a kind with no word of its own still gets the 'messaged' entry");
});

test("thicker is more messages, up to a limit", () => {
  assert.ok(edgeWidth(1) < edgeWidth(3));
  assert.equal(edgeWidth(1), 1.4);
  assert.equal(edgeWidth(500), 4);
});

test("the busiest lines are kept, and the ones left off are counted", () => {
  const edges = [edge("a", "b", "INFORM", 1), edge("b", "c", "INFORM", 9), edge("c", "d", "INFORM", 4), edge("d", "a", "INFORM", 4)];
  const r = capEdges(edges, 3);
  assert.deepEqual(r.shown.map((e) => e.count), [9, 4, 4]);
  assert.equal(r.hidden, 1);
  assert.deepEqual(r.shown.map((e) => e.from), ["b", "c", "d"], "a tie keeps a stable order");
  assert.equal(capEdges(edges, 12).hidden, 0);
  assert.equal(capEdges([], 12).shown.length, 0);
  assert.equal(edges[0]!.count, 1, "the input is not reordered");
  const tied = capEdges([edge("d", "a", "INFORM", 4), edge("c", "d", "INFORM", 4)], 2).shown;
  assert.deepEqual(tied.map((e) => e.from), ["c", "d"], "equal counts are ordered by the line's own key, not by arrival, so the drawing does not reshuffle");
});

test("a recent message lights the line from its sender to each recipient, by exact id", () => {
  const flowing = flowingKeys([{ from: "dev", to: ["qa", "pm"] }, { from: "architect", to: ["dev"] }]);
  assert.equal(isFlowing(edge("dev", "qa"), flowing), true);
  assert.equal(isFlowing(edge("dev", "pm"), flowing), true);
  assert.equal(isFlowing(edge("architect", "dev"), flowing), true);
  assert.equal(isFlowing(edge("qa", "dev"), flowing), false, "the other direction did not carry it");
  assert.equal(isFlowing(edge("dev", "qa-lead"), flowing), false, "qa-lead is not qa");
  assert.equal(isFlowing(edge("developer", "qa"), flowing), false, "developer is not dev");
  assert.equal(isFlowing(edge("dev", "architect"), flowing), false);
  const toLead = flowingKeys([{ from: "dev", to: ["qa-lead"] }]);
  assert.equal(isFlowing(edge("dev", "qa"), toLead), false, "a message to qa-lead did not travel the line to qa");
  assert.equal(isFlowing(edge("dev", "qa-lead"), toLead), true);
  assert.equal(flowingKeys([]).size, 0);
});

/* ------------------------------------------------------------------- seats */

test("a seat's ring says what it is doing, for every lifecycle", () => {
  for (const l of ["THINKING", "WORKING", "AWAKENED", "OBSERVING", "REQUESTING", "REVIEWING"]) assert.equal(nodeTone(l), "working", l);
  assert.equal(nodeTone("WAITING"), "waiting");
  assert.equal(nodeTone("FAILED"), "stopped");
  assert.equal(nodeTone("BLOCKED"), "stopped");
  assert.equal(nodeTone("SUSPENDED"), "paused");
  for (const l of ["COMPLETED", "STARTING", "IDLE", "odd"]) assert.equal(nodeTone(l), "idle", l);
  assert.equal(nodeTone("failed"), "stopped", "case does not matter");
});

/* ------------------------------------------------------------ using the page */

test("pressing a kind in the legend hides its lines and pressing it again shows them, without changing what was hidden before", () => {
  const none = new Set<string>();
  const one = toggleKind(none, "OTHER");
  assert.deepEqual([...one], ["OTHER"]);
  assert.deepEqual([...toggleKind(one, "REQUEST")].sort(), ["OTHER", "REQUEST"]);
  assert.deepEqual([...toggleKind(one, "OTHER")], [], "pressed again, shown again");
  assert.equal(none.size, 0, "the set it was given is not changed: React state is replaced, not edited");
  assert.equal(one.size, 1);
});

test("hiding a kind leaves the lines of the others, and the cap is applied after, so the next busiest take the place", () => {
  const edges = [
    edge("a", "b", "OTHER", 9), edge("b", "c", "OTHER", 8), edge("c", "d", "OTHER", 7),
    edge("a", "c", "REQUEST", 3), edge("b", "d", "APPROVE", 2), edge("d", "a", "BLOCK", 1),
  ];
  const all = visibleEdges(edges, new Set(), 3);
  assert.deepEqual(all.shown.map((e) => e.kind), ["OTHER", "OTHER", "OTHER"]);
  assert.deepEqual([all.hidden, all.off], [3, 0]);
  const withoutMessaged = visibleEdges(edges, new Set(["OTHER"]), 3);
  assert.deepEqual(withoutMessaged.shown.map((e) => e.kind), ["REQUEST", "APPROVE", "BLOCK"], "no gap where the hidden lines were");
  assert.deepEqual([withoutMessaged.hidden, withoutMessaged.off], [0, 3], "three left off by the key, none by the cap");
  const nothing = visibleEdges(edges, new Set(KINDS.map((k) => k.id)), 12);
  assert.deepEqual([nothing.shown.length, nothing.off], [0, 6]);
  assert.equal(visibleEdges([edge("a", "b", "WEIRD", 1)], new Set(["OTHER"]), 12).shown.length, 0, "a kind the console has no word for is hidden with 'messaged'");
});

test("pointing at a seat picks out the lines that run to or from it and the seats on their other ends", () => {
  const edges = [edge("pm", "architect", "REQUEST"), edge("architect", "pm", "INFORM"), edge("qa", "developer", "BLOCK"), edge("pm", "qa", "OTHER"), edge("developer", "tech-lead", "INFORM")];
  const near = around(edges, "pm");
  assert.deepEqual([...near.lines].sort(), ["architect|pm|INFORM", "pm|architect|REQUEST", "pm|qa|OTHER"]);
  assert.deepEqual([...near.seats].sort(), ["architect", "pm", "qa"]);
  assert.ok(!near.lines.has("qa|developer|BLOCK"), "a line between two other seats is context");
  const lonely = around(edges, "explorer");
  assert.deepEqual([lonely.lines.size, [...lonely.seats]], [0, ["explorer"]], "a seat nobody talks to still picks itself out");
  const exact = around([edge("dev", "qa"), edge("developer", "qa")], "dev");
  assert.deepEqual([...exact.lines], ["dev|qa|INFORM"], "dev is not developer");
});

test("a line's messages are opened in Events with the page's own filters: that seat's messages, mentioning the other", () => {
  const f = pairFilter("pm", "architect");
  assert.equal(f.search, "architect");
  const facets = parseFacets(f.filter);
  assert.equal(facetOne(facets, "actor"), "pm");
  assert.deepEqual(facetValues(facets, "grp"), ["message"]);
  assert.equal(pairFilter("a", "b").filter, "grp:message,actor:a");
});

test("those filters find the messages from one seat to another and not the others", () => {
  const sent = (seq: number, from: string, to: string[]): EventLike => ({
    seq, id: `evt-${seq}`, type: "message.sent", actorId: from, timestamp: "2026-10-06T10:00:00Z", payload: { message: { from, to, type: "REQUEST_REVIEW", payload: { question: "please review" } } },
  });
  const events = [
    sent(1, "pm", ["architect"]),
    sent(2, "pm", ["qa"]),
    sent(3, "architect", ["pm"]),
    sent(4, "pm", ["qa", "architect"]),
    { seq: 5, id: "evt-5", type: "artifact.created", actorId: "pm", timestamp: "2026-10-06T10:00:00Z", payload: { artifact: { name: "architecture notes" } } },
    sent(6, "developer", ["architect"]),
  ];
  const f = pairFilter("pm", "architect");
  const facets = parseFacets(f.filter);
  const hay = events.map((e) => eventHaystack(e));
  const found = filterBase(events, hay, { search: f.search.toLowerCase(), groups: new Set(facetValues(facets, "grp")), actor: facetOne(facets, "actor"), thread: null });
  assert.deepEqual(found.map((e) => e.seq).sort(), [1, 4], "pm's messages that name architect, including one sent to several; not pm to qa, not architect to pm, not a file");
});
