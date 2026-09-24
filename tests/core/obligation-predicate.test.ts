import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { applyEvent } from "../../packages/core/src/projections";
import { createInitialState } from "../../packages/core/src/state";
import { obligesRecipients as fromContext } from "../../packages/core/src/context";
import {
  isObligingType,
  MESSAGE_TYPES,
  OBLIGING_MESSAGE_TYPES,
  obligesRecipients,
  REQUEST_TYPES,
} from "../../packages/protocol/src/catalog";
import {
  PROTOCOL_VERSION,
  type InteractionMode,
  type MeshEvent,
  type MeshMessage,
  type MessageType,
} from "../../packages/protocol/src/index";

/**
 * D11: "does this message oblige its recipients?" had three answers.
 *
 *   - `catalog.REQUEST_TYPES`, a hand-written array that omitted CHALLENGE,
 *     enumerated instead of prefix-matching, knew nothing about interaction
 *     modes, had zero runtime consumers, and was re-exported publicly — so it
 *     was the answer a reader was most likely to find and least likely to be
 *     right about.
 *   - `context.obligesRecipients`, which ranks the prompt's mail.
 *   - a pair of consts inside `projections-messaging`'s `message.sent` branch,
 *     a deliberate hand-copy of the second, which decides what actually opens
 *     a commitment.
 *
 * Two of those agreed by hand and the third did not. The failure mode is not
 * a crash: the prompt ranks by one rule while the ledger nudges, escalates
 * and reports by another, and the agent is told its debts in an order that
 * does not match the debts it will be chased for.
 *
 * These tests pin the collapse: one function, one list derived from it, and
 * the ledger provably agreeing with the prompt across every type and mode
 * rather than by inspection.
 */

let seq = 0;
function message(over: Partial<MeshMessage> & { type: MessageType }): MeshMessage {
  seq++;
  return {
    id: over.id ?? `obl-${seq}`,
    protocolVersion: PROTOCOL_VERSION,
    timestamp: `2026-04-01T00:00:${String(seq % 60).padStart(2, "0")}.000Z`,
    goalId: "g-obl",
    from: "architect",
    to: ["dev"],
    threadId: "t-obl",
    artifactRefs: [],
    payload: {},
    priority: "NORMAL",
    ...over,
  } as MeshMessage;
}

function sent(m: MeshMessage): MeshEvent {
  seq++;
  return {
    id: `evt-obl-${seq}`,
    protocolVersion: PROTOCOL_VERSION,
    type: "message.sent",
    timestamp: m.timestamp,
    goalId: m.goalId,
    seq,
    payload: { message: m },
  } as MeshEvent;
}

/* ------------------------------------------------------------------ *
 * One predicate                                                       *
 * ------------------------------------------------------------------ */

test("core does not own a second copy of the predicate", () => {
  // Identity, not equivalence. Two functions that agree today are exactly
  // what D11 was: this assertion fails the moment either core site grows its
  // own answer back, which no behavioural test would catch until the two
  // drifted.
  assert.strictEqual(fromContext, obligesRecipients, "context must re-export the catalog predicate, not reimplement it");
});

test("the exported list is derived from the predicate, not maintained beside it", () => {
  assert.deepEqual(OBLIGING_MESSAGE_TYPES, MESSAGE_TYPES.filter(isObligingType));
  assert.deepEqual(REQUEST_TYPES, OBLIGING_MESSAGE_TYPES, "the deprecated name is a copy of the derived list");
  assert.notStrictEqual(REQUEST_TYPES, OBLIGING_MESSAGE_TYPES, "...a copy, so a caller mutating one cannot reach the other");

  // The two specific gaps the old hand-written array had.
  assert.ok(OBLIGING_MESSAGE_TYPES.includes("CHALLENGE"), "a CHALLENGE puts its recipient under a debt");
  assert.ok(OBLIGING_MESSAGE_TYPES.includes("ESCALATE"), "and so does an escalation, despite the name");

  // Prefix-matching is the point: a REQUEST_* added to the catalogue joins
  // the obliging set without anyone remembering to add it twice.
  assert.ok(isObligingType("REQUEST_SOMETHING_NEW"));
  assert.ok(!isObligingType("INFORM"));
  assert.ok(!isObligingType("RESPONSE"), "a reply discharges a debt, it does not open one");
});

test("interaction mode gates the type, in the one predicate", () => {
  for (const type of ["REQUEST", "REQUEST_REVIEW", "CHALLENGE", "ESCALATE"] as MessageType[]) {
    assert.equal(obligesRecipients({ type, control: { mode: "service" } }), true, type);
    assert.equal(obligesRecipients({ type, control: { mode: "broadcast" } }), false, `broadcast ${type}`);
    assert.equal(obligesRecipients({ type, control: { mode: "collab" } }), false, `collab ${type}`);
    // Absent mode reads as `service`: that is what every message written
    // before the field existed was, and a replayed log is full of them.
    assert.equal(obligesRecipients({ type }), true, `bare ${type}`);
    assert.equal(obligesRecipients({ type, control: {} }), true, `empty control ${type}`);
  }
});

/* ------------------------------------------------------------------ *
 * ...and the ledger agrees with it                                    *
 * ------------------------------------------------------------------ */

test("what the predicate says obliges is exactly what opens a commitment", () => {
  // The whole grid, through the real reducer. Asserting the two sites agree
  // on a handful of hand-picked types is what let them drift in the first
  // place; this cannot pass while any type or mode is answered differently
  // by the prompt and by the ledger.
  const modes: Array<InteractionMode | undefined> = [undefined, "service", "collab", "broadcast"];
  let obliging = 0;

  for (const type of MESSAGE_TYPES) {
    for (const mode of modes) {
      const state = createInitialState();
      const m = message({ type, ...(mode ? { control: { mode } } : {}) });
      applyEvent(state, sent(m));

      const expected = obligesRecipients(m);
      if (expected) obliging++;
      assert.equal(
        state.pendingRequests.has(m.id),
        expected,
        `${type} in ${mode ?? "(no)"} mode: prompt says ${expected}, ledger says ${state.pendingRequests.has(m.id)}`,
      );
    }
  }

  // Guard against the grid passing vacuously — a predicate stuck on `false`
  // would agree with a ledger that never opens anything.
  assert.equal(obliging, OBLIGING_MESSAGE_TYPES.length * 2, "service and absent-mode, for each obliging type");
});

test("a broadcast REQUEST is delivered but owes nobody an answer", () => {
  const state = createInitialState();
  const m = message({ type: "REQUEST", to: ["dev", "qa"], control: { mode: "broadcast" } });
  applyEvent(state, sent(m));

  // The distinction that matters: the message is not dropped, it just does
  // not create a debt. An announcement to the whole roster that opened one
  // obligation per seat would have every agent chased for an answer to
  // something that was never asked of them individually.
  assert.equal(state.messages.has(m.id), true, "a broadcast is still a real message");
  assert.deepEqual(state.unread.get("dev"), [m.id]);
  assert.deepEqual(state.unread.get("qa"), [m.id]);
  assert.equal(state.pendingRequests.size, 0, "...that obliges nobody");
});

test("the obligation is read off control, never off payload", () => {
  // `payload` is verbatim agent input. A sender able to set its own mode
  // could either dodge every debt it opens or promote its chatter above
  // everyone else's real asks.
  const state = createInitialState();
  const forged = message({ type: "REQUEST", payload: { mode: "broadcast", control: { mode: "broadcast" } } });
  applyEvent(state, sent(forged));

  assert.equal(obligesRecipients(forged), true);
  assert.equal(state.pendingRequests.has(forged.id), true, "a forged mode must not discharge a debt before it is opened");
});

/* ------------------------------------------------------------------ *
 * Import weight                                                       *
 * ------------------------------------------------------------------ */

test("the predicate's new home still imports nothing but types", () => {
  // `run-report.ts`, the CLI and the browser bundle all take a *value* import
  // from the catalog precisely because it drags nothing in behind it. Moving
  // a predicate there is only safe while that stays true, and the cost of
  // breaking it is a schema validator in a browser bundle rather than a test
  // failure anywhere near this file.
  // Measured in a fresh process rather than by clearing this one's module
  // cache, so the answer is about the catalog and not about whatever the
  // rest of the suite happened to load first.
  const target = require.resolve("../../packages/protocol/src/catalog");
  const probe = `require(${JSON.stringify(target)}); console.log(JSON.stringify(Object.keys(require.cache)));`;
  const loaded = JSON.parse(execFileSync(process.execPath, ["-e", probe], { encoding: "utf8" })) as string[];

  assert.deepEqual(
    loaded.filter((k) => /[/\\]node_modules[/\\]/.test(k)),
    [],
    "importing the catalog must not pull AJV \u2014 or anything else \u2014 in behind it",
  );
  assert.deepEqual(loaded, [target], "and must not reach any other module in the repo");
});
