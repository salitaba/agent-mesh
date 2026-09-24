import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MESSAGE_TYPES,
  OBLIGING_MESSAGE_TYPES,
  WORK_MOVING_MESSAGE_TYPES,
  isObligingType,
  movesWork,
} from "../../packages/protocol/src/index";
import type { MessageType } from "../../packages/protocol/src/index";

/**
 * The classification `movesWork` is enumerated from, written out a second time
 * so that adding a message type fails a test instead of silently accruing.
 *
 * `isObligingType` can afford to be a prefix match; this cannot, and an
 * enumerated list that quietly stops being complete is the failure mode the
 * catalogue warns about two functions above it. The answer is this table: the
 * moment `MESSAGE_TYPES` and this disagree, someone has added a speech act
 * without deciding whether it moves work, and the build says so.
 */
const EXPECTED: Record<MessageType, boolean> = {
  // Custody: after this lands, the recipient owns something it did not own.
  MISSION: true,
  DELEGATE: true,
  HANDOFF: true,
  PATCH_READY: true,
  // Verdicts on work the recipient is parked on.
  APPROVE: true,
  REJECT: true,
  VETO: true,
  BLOCK: true,
  // Asks. These oblige an answer, which is a different axis and already
  // carries its own class; they are not work movement.
  REQUEST: false,
  REQUEST_INFO: false,
  REQUEST_REVIEW: false,
  REQUEST_ARTIFACT: false,
  REQUEST_RESEARCH: false,
  REQUEST_EXECUTION: false,
  CHALLENGE: false,
  ESCALATE: false,
  // Reports on the world. Consequential to read, but they hand over no custody
  // and settle no verdict, and a seat woken for all of them is a seat woken
  // for everything.
  INFORM: false,
  PROPOSE: false,
  TEST_RESULT: false,
  SECURITY_FINDING: false,
  COMMIT: false,
  ROLLBACK: false,
  WAIT: false,
  DONE: false,
};

test("every message type has been deliberately classified", () => {
  const declared = Object.keys(EXPECTED).sort();
  const actual = [...MESSAGE_TYPES].sort();
  assert.deepEqual(
    declared,
    actual,
    "MESSAGE_TYPES and this table disagree: a speech act was added or removed without deciding whether it moves work",
  );
});

test("movesWork agrees with the table, type by type", () => {
  for (const type of MESSAGE_TYPES) {
    assert.equal(movesWork(type), EXPECTED[type], `${type}`);
  }
});

test("WORK_MOVING_MESSAGE_TYPES is the derived list", () => {
  assert.deepEqual(
    [...WORK_MOVING_MESSAGE_TYPES].sort(),
    MESSAGE_TYPES.filter((t) => EXPECTED[t]).sort(),
  );
});

/**
 * The two predicates answer different questions, and the whole point of adding
 * the second is that neither implies the other. If these ever overlap, one of
 * them has drifted into the other's job.
 */
test("moving work and creating a debt are disjoint", () => {
  for (const type of MESSAGE_TYPES) {
    assert.equal(
      movesWork(type) && isObligingType(type),
      false,
      `${type} is classified as both an ask and a transfer`,
    );
  }
  assert.equal(
    OBLIGING_MESSAGE_TYPES.some((t) => WORK_MOVING_MESSAGE_TYPES.includes(t)),
    false,
  );
});

test("an unknown type moves nothing", () => {
  assert.equal(movesWork("NOT_A_TYPE"), false);
  assert.equal(movesWork(""), false);
});
