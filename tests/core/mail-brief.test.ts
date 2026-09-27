import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEvent } from "../../packages/core/src/projections";
import {
  admittedMail,
  buildMailDigest,
  isDigestible,
  isPlainInform,
  mailBrief,
  renderMailDigest,
  type MailBriefConfig,
} from "../../packages/core/src/projections-messaging";
import { createInitialState, resolveUnread, type Projections } from "../../packages/core/src/state";
import {
  PROTOCOL_VERSION,
  type MeshEvent,
  type MeshMessage,
  type MessageType,
} from "../../packages/protocol/src/index";

/**
 * The mail brief: what a seat is handed when its mailbox is deeper than it can
 * read.
 *
 * The measured mission: 145 unread messages in tech-lead's box, 43 in qa's, 22
 * in architect's, three seats allowed to run at once, and 18 merged patches
 * with no acceptance criterion closed. Every turn opened by draining a
 * mailbox. These tests pin the two rules that stop that — a digest above a
 * threshold, and an age past which plain news stops being admitted — and the
 * properties that make them safe: nothing is deleted, nothing is marked read,
 * and no message that owes an answer can leave the page at any age.
 *
 * The mailbox is seeded through the real reducer (`applyEvent`), so
 * `resolveUnread` sees exactly what a turn would see.
 */

const GOAL_ID = "goal-mail-brief";
const SEAT = "tech-lead";
const CONFIG: MailBriefConfig = { digestThreshold: 10, informExpiryMs: 90 * 60_000 };

let seq = 0;
// Six other seats. Never the reader itself: the reducer skips the sender's own
// mailbox (`if (target === m.from) continue`), so a seat cannot be drowned by
// its own mail and a fixture that tried would silently build a shorter box.
const SENDERS = ["architect", "qa", "pm", "dev", "explorer", "designer"];

function message(over: Partial<MeshMessage> & { from: string; to: string[]; type: MessageType }): MeshMessage {
  seq++;
  return {
    id: `msg-${seq}`,
    protocolVersion: PROTOCOL_VERSION,
    timestamp: `2026-09-27T10:${String(seq % 60).padStart(2, "0")}:00.000Z`,
    goalId: GOAL_ID,
    threadId: "thr-1",
    artifactRefs: [],
    payload: { status: "ok" },
    priority: "NORMAL",
    ...over,
  };
}

/** A plain INFORM, the only shape that may ever leave the brief unanswered. */
function inform(over: Partial<MeshMessage> = {}, i = 0): MeshMessage {
  return message({
    from: SENDERS[i % SENDERS.length]!,
    to: [SEAT],
    type: "INFORM",
    threadId: `thr-${i % 4}`,
    // A body worth real tokens, so the digest's saving is measured and not
    // asserted: each payload is a sentence a seat would otherwise have read.
    payload: { status: "ok", summary: `progress note ${i}: ${"x".repeat(180)}` },
    ...over,
  });
}

function event(m: MeshMessage): MeshEvent {
  return {
    id: `evt-${m.id}`,
    protocolVersion: PROTOCOL_VERSION,
    type: "message.sent",
    timestamp: m.timestamp,
    goalId: GOAL_ID,
    actorId: m.from,
    payload: { message: m },
  } as MeshEvent;
}

/** The seat's real mailbox, built the way a turn builds it. */
function mailbox(messages: MeshMessage[]): Projections {
  const state = createInitialState();
  state.activeGoalId = GOAL_ID;
  for (const m of messages) applyEvent(state, event(m));
  return state;
}

const tokensOf = (text: string): number => Math.ceil(text.length / 4);

test("145 unread INFORM(s) reach the brief as ONE digest block naming every sender, and no bodies", (t) => {
  const flood = Array.from({ length: 145 }, (_, i) => inform({}, i));
  const state = mailbox(flood);
  const inbox = resolveUnread(state, SEAT);
  assert.equal(inbox.length, 145, "the mailbox is 145 deep before the brief is built");

  const brief = mailBrief(inbox, { config: CONFIG, nowMs: Date.parse("2026-09-27T11:00:00.000Z") });
  assert.ok(brief.digest, "a mailbox over the threshold is digested");
  assert.equal(brief.digest.count, 145);
  assert.equal(brief.summarised.length, 145, "news is what the block stands for");
  assert.deepEqual(brief.pending, [], "and there is nothing left to render body-by-body");

  // Complete, not a sample: every sender and every message id is named.
  assert.deepEqual(
    brief.digest.senders.map((s) => s.from).sort(),
    [...SENDERS].sort(),
    "all six senders are named",
  );
  assert.equal(
    brief.digest.senders.reduce((n, s) => n + s.count, 0),
    145,
    "the sender counts account for every message",
  );
  assert.deepEqual(brief.digest.types, [{ type: "INFORM", count: 145 }]);
  assert.equal(brief.digest.threads.length, 4, "four threads, each named");
  assert.deepEqual(
    new Set(brief.digest.entries.map((e) => e.id)),
    new Set(inbox.map((m) => m.id)),
    "every message id is in the block",
  );

  const block = renderMailDigest(brief.digest);
  const text = block.join("\n");
  for (const sender of SENDERS) assert.ok(text.includes(sender), `${sender} is named in the block`);
  assert.ok(text.includes("[msg-1]"), "an individual message id is readable in the block");
  assert.ok(!text.includes("xxxx"), "no payload body is rendered");
  assert.ok(!text.includes("progress note"), "nothing from a payload reaches the page");

  // 145 messages -> one block, measured rather than asserted by feel.
  const bodies = inbox.map((m) => JSON.stringify(m.payload)).join("\n");
  t.diagnostic(
    `145 messages + bodies = ${tokensOf(bodies)} est. tokens vs one digest block = ${tokensOf(text)} est. tokens`,
  );
  assert.ok(tokensOf(text) < tokensOf(bodies) / 5, "the digest costs a fraction of the bodies it replaces");
});

test("a message the digest names is still in the mailbox, still unread, and still readable on its own", () => {
  const flood = Array.from({ length: 145 }, (_, i) => inform({}, i));
  const state = mailbox(flood);
  const inbox = resolveUnread(state, SEAT);
  const brief = mailBrief(inbox, { config: CONFIG, nowMs: Date.parse("2026-09-27T11:00:00.000Z") });
  const id = brief.digest!.entries[0]!.id;

  // The digest is a VIEW. It marks nothing read, deletes nothing, and the
  // mailbox it was built from is untouched: the seat that wants one body can
  // still pull it by id (mesh_inbox reads this same projection).
  assert.equal(resolveUnread(state, SEAT).length, 145, "no message left the box for being digested");
  const held = state.messages.get(id);
  assert.ok(held, "the named message still resolves");
  assert.ok(held!.payload, "and still carries its body");

  const pulled = mailBrief([held!], {
    config: { ...CONFIG, digestThreshold: 0 },
    nowMs: Date.parse("2026-09-27T11:00:00.000Z"),
  });
  assert.deepEqual(pulled.pending.map((m) => m.id), [id], "it can be handed over on its own");
});

test("an ask is NEVER summarised, however deep the box — only news is", (t) => {
  const flood = Array.from({ length: 40 }, (_, i) => inform({}, i));
  const now = Date.parse("2026-09-27T11:00:00.000Z");
  const asks = [
    message({ from: "pm", to: [SEAT], type: "REQUEST_REVIEW" }),
    message({ from: "qa", to: [SEAT], type: "ESCALATE" }),
    message({ from: "qa", to: [SEAT], type: "TEST_RESULT", payload: { result: "FAILED" } }),
    message({ from: "pm", to: [SEAT], type: "HANDOFF" }),
    inform({ priority: "URGENT" }),
  ];
  const state = mailbox([...flood, ...asks]);
  const inbox = resolveUnread(state, SEAT);
  const brief = mailBrief(inbox, { config: CONFIG, nowMs: now });

  // The trigger is the whole readable mailbox, so the block appears...
  assert.ok(brief.digest, "45 messages is over the threshold");
  assert.equal(brief.digest.count, 40, "and the block stands for the 40 pieces of news");

  // ...and every one of the five things that is not news is still rendered
  // whole, because "delivered means rendered AND answered": a seat handed a
  // summary of an ask it owes has been made to answer blind.
  assert.deepEqual(
    new Set(brief.pending.map((m) => m.id)),
    new Set(asks.map((m) => m.id)),
    "asks, work movements, adverse verdicts and URGENT mail are never digested",
  );
  for (const m of brief.pending) assert.equal(isDigestible(m), false, `${m.type} is not news`);
  assert.deepEqual(
    new Set(brief.digest.entries.map((e) => e.id)),
    new Set(flood.map((m) => m.id)),
    "the block names only the news",
  );
  t.diagnostic(`45 messages (40 news + 5 acts) -> ${brief.digest.count} digested, ${brief.pending.length} kept whole`);
});

test("a deep box of nothing but asks produces no digest at all", () => {
  const asks = Array.from({ length: 20 }, (_, i) =>
    message({ from: SENDERS[i % SENDERS.length]!, to: [SEAT], type: "REQUEST_REVIEW" }),
  );
  const brief = mailBrief(asks, { config: CONFIG, nowMs: Date.parse("2026-09-27T11:00:00.000Z") });
  assert.equal(brief.digest, undefined, "there is no news to collapse");
  assert.equal(brief.pending.length, 20, "so the box renders exactly as it always did");
});

test("the digest is off below the threshold and when the knob is 0", () => {
  const atThreshold = Array.from({ length: 10 }, (_, i) => inform({}, i));
  const above = Array.from({ length: 11 }, (_, i) => inform({}, i));
  const now = Date.parse("2026-09-27T11:00:00.000Z");

  const ten = mailBrief(atThreshold, { config: CONFIG, nowMs: now });
  assert.equal(ten.digest, undefined, "exactly the threshold still renders one message at a time");
  assert.equal(ten.pending.length, 10);

  const eleven = mailBrief(above, { config: CONFIG, nowMs: now });
  assert.ok(eleven.digest, "one over the threshold is digested");

  const off = mailBrief(above, { config: { ...CONFIG, digestThreshold: 0 }, nowMs: now });
  assert.equal(off.digest, undefined, "digest_threshold: 0 is the off switch");
  assert.equal(off.pending.length, 11);
});

test("a plain INFORM older than the age is not admitted; everything that expects an answer is", () => {
  const now = Date.parse("2026-09-27T12:00:00.000Z");
  const old = "2026-09-27T09:00:00.000Z"; // three hours — well past 90 minutes

  const plain = inform({ timestamp: old });
  const fresh = inform({ timestamp: "2026-09-27T11:59:00.000Z" });
  const split = admittedMail([plain, fresh], now, CONFIG.informExpiryMs);
  assert.deepEqual(split.expired.map((m) => m.id), [plain.id], "stale news leaves the brief");
  assert.deepEqual(split.admitted.map((m) => m.id), [fresh.id], "fresh news stays");

  // Why each of these is distinguishable, in the order `isPlainInform` tests
  // them. None of them is a plain INFORM, and every one of them is admitted at
  // any age.
  const asks: Array<{ why: string; m: MeshMessage }> = [
    {
      why: "obligesRecipients: an ask opens a pendingRequest, so muting it leaves a debt nobody was shown",
      m: message({ from: "pm", to: [SEAT], type: "REQUEST_REVIEW", timestamp: old }),
    },
    {
      why: "obligesRecipients: an ESCALATE is an ask with a human on the other end",
      m: message({ from: "qa", to: [SEAT], type: "ESCALATE", timestamp: old }),
    },
    {
      why: "movesWorkMessage: a HANDOFF is this seat's next piece of work, not news about it",
      m: message({ from: "pm", to: [SEAT], type: "HANDOFF", timestamp: old }),
    },
    {
      why: "movesWorkMessage: a FAILED verdict is work, and a PASSED one is a sign-off",
      m: message({ from: "qa", to: [SEAT], type: "TEST_RESULT", timestamp: old }),
    },
    {
      why: "replyTo: an answer settles a commitment, and the ledger still counts it",
      m: inform({ timestamp: old, replyTo: "msg-original" }),
    },
    {
      why: "URGENT: the one class of news the brief reserves a seat for",
      m: inform({ timestamp: old, priority: "URGENT" }),
    },
    {
      why: "note: the sender's own prose is unique content, not a restatement",
      m: inform({ timestamp: old, note: "read this one" }),
    },
    {
      why: "artifactRefs: a pointer to an artifact is something someone needs",
      m: inform({ timestamp: old, artifactRefs: [{ uri: "artifact://a/1", type: "Document" } as never] }),
    },
    {
      why: "ifUnanswered: the ask carries a default and therefore an instruction",
      m: inform({ timestamp: old, control: { ifUnanswered: { assume: "proceed" } } as never }),
    },
  ];
  for (const { why, m } of asks) {
    assert.equal(isPlainInform(m), false, why);
    assert.deepEqual(admittedMail([m], now, CONFIG.informExpiryMs).admitted.map((x) => x.id), [m.id], why);
  }

  // And the control: a plain INFORM of the same age is expired, so the test
  // above is not passing because nothing expires at all.
  assert.equal(isPlainInform(inform({ timestamp: old })), true);
});

test("inform_expiry_ms: 0 disables expiry entirely", () => {
  const now = Date.parse("2026-09-27T12:00:00.000Z");
  const ancient = inform({ timestamp: "2026-09-20T00:00:00.000Z" });
  const off = admittedMail([ancient], now, 0);
  assert.deepEqual(off.expired, []);
  assert.deepEqual(off.admitted.map((m) => m.id), [ancient.id]);

  const brief = mailBrief([ancient], { config: { ...CONFIG, informExpiryMs: 0 }, nowMs: now });
  assert.deepEqual(brief.expired, []);
  assert.deepEqual(brief.pending.map((m) => m.id), [ancient.id]);
});

test("an expired INFORM is named for the drain, never digested, so the box cannot pin", () => {
  const now = Date.parse("2026-09-27T12:00:00.000Z");
  const stale = inform({ timestamp: "2026-09-27T09:00:00.000Z" });
  const fresh = inform({ timestamp: "2026-09-27T11:59:00.000Z" });
  const brief = mailBrief([stale, fresh], { config: CONFIG, nowMs: now });

  assert.deepEqual(brief.expired.map((m) => m.id), [stale.id]);
  assert.deepEqual(brief.pending.map((m) => m.id), [fresh.id], "not rendered");
  assert.deepEqual(brief.summarised, [], "and not summarised either: it is off the page entirely");

  // The caller must hand `expired` to the turn-end drain alongside what it
  // rendered. An expired INFORM that is never delivered stays unread forever,
  // which keeps buying STALE_MAIL_MS wakes for it and — at the 200-message box
  // cap — starts evicting fresh mail as `mailOverflowDropped`.
  const drained = [...brief.summarised, ...brief.pending, ...brief.expired];
  assert.deepEqual(drained.map((m) => m.id).sort(), [stale.id, fresh.id].sort());
});

test("the digest is a pure function of the mailbox: same input, same block", () => {
  const flood = Array.from({ length: 12 }, (_, i) => inform({}, i));
  const subjects = new Map<string, string | undefined>([["thr-0", "auth design"]]);
  const a = buildMailDigest(flood, subjects);
  const b = buildMailDigest([...flood], subjects);
  assert.deepEqual(a, b);
  assert.equal(a.threads.find((th) => th.threadId === "thr-0")?.subject, "auth design");
  assert.equal(a.threads[0]!.count >= a.threads[a.threads.length - 1]!.count, true, "heaviest thread first");
  assert.ok(renderMailDigest(a).join("\n").includes("auth design"), "the thread subject is named, not just its id");
});
