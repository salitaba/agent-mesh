import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_DIGEST_THRESHOLD,
  DEFAULT_INFORM_EXPIRY_MS,
  DEFAULT_MAX_SENDS_PER_TURN,
  MIN_INFORM_EXPIRY_MS,
  resolveConfig,
  resolveMessages,
} from "../../packages/config/src/index";

/**
 * `mesh.messages`: the mail digest, the inform expiry and the per-turn send
 * budget.
 *
 * All three are ON by default, which is the one block in the resolver that does
 * not keep the repo's "absent means the behaviour every existing mesh already
 * has" shape — and it is deliberate, because the mission these were built for
 * had 145 unread messages in one seat's box and three concurrent seats, so a
 * knob nobody had heard of would have bought it nothing. `0` is the off switch.
 *
 * The three are one story, read from either end: `max_sends_per_turn` decides
 * how full a box gets, `digest_threshold` decides how much of a full box a turn
 * reads whole, and `inform_expiry_ms` decides what of it a turn stops reading at
 * all.
 */

function mesh(messagesBlock: string | undefined): string {
  return `version: 1
mesh:
  id: cfgtest
  goal: |
    Test.
  workspace: { path: ./workspace }
  runtime: { default: stub }
${messagesBlock === undefined ? "" : `  messages: ${messagesBlock}\n`}agents:
  a: { role: worker }
`;
}

function resolveRaw(text: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-messages-test-"));
  fs.writeFileSync(path.join(dir, "mesh.yaml"), text, "utf8");
  try {
    return resolveConfig(path.join(dir, "mesh.yaml"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("absent mesh.messages applies the conservative defaults — the digest and the expiry are on", () => {
  const cfg = resolveRaw(mesh(undefined));
  assert.deepEqual(cfg.messages, { digestThreshold: 10, informExpiryMs: 5_400_000, maxSendsPerTurn: 5 });
  assert.equal(DEFAULT_DIGEST_THRESHOLD, 10);
  assert.equal(DEFAULT_INFORM_EXPIRY_MS, 90 * 60_000, "90 minutes");
  assert.equal(DEFAULT_MAX_SENDS_PER_TURN, 5, "the measured average sends per turn on the run this was built from");
  assert.ok(
    cfg.messages.digestThreshold > 0 && cfg.messages.informExpiryMs > 0 && cfg.messages.maxSendsPerTurn > 0,
    "all three on by default",
  );
});

test("a configured value wins over the default, per key", () => {
  const cfg = resolveRaw(mesh("{ digest_threshold: 25, inform_expiry_ms: 600000, max_sends_per_turn: 2 }"));
  assert.deepEqual(cfg.messages, { digestThreshold: 25, informExpiryMs: 600_000, maxSendsPerTurn: 2 });

  const one = resolveRaw(mesh("{ digest_threshold: 3 }"));
  assert.equal(one.messages.digestThreshold, 3, "the configured half");
  assert.equal(one.messages.informExpiryMs, DEFAULT_INFORM_EXPIRY_MS, "the other half keeps its default");
  assert.equal(one.messages.maxSendsPerTurn, DEFAULT_MAX_SENDS_PER_TURN, "and so does the third");
});

test("0 is the documented off switch for any of the three keys", () => {
  const cfg = resolveRaw(mesh("{ digest_threshold: 0, inform_expiry_ms: 0, max_sends_per_turn: 0 }"));
  assert.deepEqual(cfg.messages, { digestThreshold: 0, informExpiryMs: 0, maxSendsPerTurn: 0 });
  assert.deepEqual(resolveMessages({ digest_threshold: 0, inform_expiry_ms: 0, max_sends_per_turn: 0 }), {
    digestThreshold: 0,
    informExpiryMs: 0,
    maxSendsPerTurn: 0,
  });
  // 0 is a budget of zero, not a budget of nothing: it is the off switch, and
  // the runtime reads it as "no budget at all" rather than "hold everything".
  assert.equal(resolveMessages({ max_sends_per_turn: 0 }).maxSendsPerTurn, 0);
});

test("a negative or non-integer value is refused at load", () => {
  assert.throws(() => resolveRaw(mesh("{ digest_threshold: -1 }")), "a negative threshold is not a threshold");
  assert.throws(() => resolveRaw(mesh("{ inform_expiry_ms: -1 }")));
  assert.throws(() => resolveRaw(mesh("{ digest_threshold: 2.5 }")), "a mailbox is counted in whole messages");
  assert.throws(() => resolveRaw(mesh("{ inform_expiry_ms: '90m' }")));
  assert.throws(() => resolveRaw(mesh("{ max_sends_per_turn: -1 }")));
  assert.throws(() => resolveRaw(mesh("{ max_sends_per_turn: 1.5 }")), "a budget is counted in whole messages");
});

test("an inform_expiry_ms below a minute is refused with a sentence, not just a schema keyword", () => {
  assert.throws(
    () => resolveRaw(mesh("{ inform_expiry_ms: 3600 }")),
    (e: Error) => {
      assert.ok(e.message.includes("inform_expiry_ms"), e.message);
      assert.ok(e.message.includes("seconds where milliseconds belong"), e.message);
      return true;
    },
    "seconds written as milliseconds — the same typo stale_after_ms is floored against",
  );
  assert.throws(() => resolveRaw(mesh("{ inform_expiry_ms: 10 }")));
  // The floor is a floor, not a ban: a minute exactly is fine.
  assert.equal(resolveRaw(mesh(`{ inform_expiry_ms: ${MIN_INFORM_EXPIRY_MS} }`)).messages.informExpiryMs, 60_000);
});

test("mesh.messages is closed: a key nobody defined is a load failure, not a silent no-op", () => {
  assert.throws(() => resolveRaw(mesh("{ digest_thresholds: 10 }")), "a typo must not read as 'the default applied'");
});

test("resolveMessages is the single answer for all three defaults", () => {
  assert.deepEqual(resolveMessages(undefined), {
    digestThreshold: DEFAULT_DIGEST_THRESHOLD,
    informExpiryMs: DEFAULT_INFORM_EXPIRY_MS,
    maxSendsPerTurn: DEFAULT_MAX_SENDS_PER_TURN,
  });
  assert.deepEqual(resolveMessages({ inform_expiry_ms: 120_000 }), {
    digestThreshold: DEFAULT_DIGEST_THRESHOLD,
    informExpiryMs: 120_000,
    maxSendsPerTurn: DEFAULT_MAX_SENDS_PER_TURN,
  });
});
