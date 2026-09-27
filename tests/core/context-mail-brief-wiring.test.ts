import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAgentContext,
  buildContextManifest,
  handoverBundle,
  renderContextInstructions,
} from "../../packages/core/src/context";
import { makeMesh, type TestMesh } from "../helpers";
import { ManualClock } from "../support/manual-clock";
import type { ContextSlot } from "../../packages/protocol/src/index";

/**
 * `mesh.messages.digest_threshold` and `mesh.messages.inform_expiry_ms` were
 * resolved, validated, documented in `docs/configuration.md` — and inert.
 * `mailBrief` had no caller, so a mesh could set either key and change nothing
 * about any prompt.
 *
 * These tests are that wiring, from the seat's side: what the page prints when
 * a box is deep, what it prints when it is not, and the two switches that turn
 * each rule off. `tests/core/mail-brief.test.ts` covers the projection itself;
 * nothing here restates it.
 *
 * Every fixture runs on a `ManualClock`. The brief reads the KERNEL's clock,
 * and a fixture whose mail is stamped 2026-01-01 cannot be judged fresh against
 * a wall clock — the point of pinning ages here is that the age is the input,
 * not the accident of when the suite ran.
 */

const AGENTS = [
  { id: "architect", role: "architect", capabilities: ["review.design"], interests: [] },
  { id: "pm", role: "pm", capabilities: ["review.design"], interests: [] },
  { id: "qa", role: "qa", capabilities: ["test.execute"], interests: [] },
  { id: "explorer", role: "explorer", capabilities: [], interests: [] },
  { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
];
const MAY_CONTACT = {
  architect: ["dev"],
  pm: ["dev"],
  qa: ["dev"],
  explorer: ["dev"],
  dev: [],
};
/** Four seats, one thread each, so the digest stays a name and not a transcript. */
const SENDERS = ["qa", "architect", "pm", "explorer"];

async function mesh(): Promise<TestMesh> {
  return makeMesh({ agents: AGENTS, mayContact: MAY_CONTACT, mode: "parked", clock: new ManualClock() });
}

/**
 * The knobs, set on a real resolved config.
 *
 * `tests/helpers.ts` writes no `mesh.messages` block, and every mesh without
 * one resolves to the shipped defaults (10 / 90 minutes) — which is exactly
 * the behaviour the first tests below want. Overriding the resolved value is
 * how a fixture asks for the other case.
 */
function withMessages(m: TestMesh, over: { digestThreshold?: number; informExpiryMs?: number }) {
  return { ...m.config, messages: { ...m.config.messages, ...over } };
}

/**
 * The Unread mail section: its heading through to the next section.
 *
 * A deep box prints TWO blocks under this banner — the digest, then the asks
 * that were not collapsed — so "the next `## `" is not the end of it. The scan
 * runs past both and stops at the first heading that is neither.
 */
function mailSection(text: string): string {
  const start = text.indexOf("## Unread mail");
  assert.notEqual(start, -1, "the section must be there at all");
  const next = /\n## (?!Unread mail)/g;
  next.lastIndex = start;
  const end = next.exec(text);
  return end === null ? text.slice(start) : text.slice(start, end.index + 1);
}

/**
 * Ids are minted per run; the baseline comparison is about the LAYOUT, so both
 * sides of it are flattened the same way. Nothing else in the fixture is
 * run-dependent — that is what the manual clock is for.
 */
const normalizeIds = (t: string): string =>
  t.replace(/msg-[A-Za-z0-9]+/g, "msg-X").replace(/thread-[A-Za-z0-9]+/g, "thread-X");

const slotOf = (m: ReturnType<typeof buildContextManifest>, name: ContextSlot) =>
  m.slots.find((s) => s.slot === name)!;
const tokensOf = (value: unknown): number => Math.ceil((JSON.stringify(value) ?? "").length / 4);

/** Fill a box with `n` plain INFORMs, four threads, one sender each. */
async function flood(m: TestMesh, n: number): Promise<string[]> {
  const threads: string[] = [];
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = i % SENDERS.length;
    const first = threads.length < SENDERS.length && i < SENDERS.length;
    const res = await m.supervisor.sendMessage({
      from: SENDERS[t]!,
      to: ["dev"],
      type: "INFORM",
      ...(first ? { newThread: { subject: `thread subject ${t}` } } : { threadId: threads[t]! }),
      payload: { note: `chatter-body ${i}` },
    });
    assert.ok(res.accepted, res.reason);
    ids.push(res.messageId!);
    if (first) threads.push(m.kernel.state.messages.get(res.messageId!)!.threadId);
  }
  return ids;
}

const ask = (m: TestMesh, over: { priority?: "URGENT" | "NORMAL" } = {}) =>
  m.supervisor.sendMessage({
    from: "architect",
    to: ["dev"],
    type: "REQUEST_REVIEW",
    newThread: { subject: "review the retry policy" },
    payload: { question: "does this hold under a partial outage?" },
    ...(over.priority ? { priority: over.priority } : {}),
  });

/* ------------------------------------------------------------------ *
 * The digest, on the page                                           *
 * ------------------------------------------------------------------ */

test("145 INFORMs reach the page as ONE block, and the mail slot costs a fraction of what it stands for", async (t) => {
  const m = await mesh();
  const ids = await flood(m, 145);
  const bundle = buildAgentContext({ config: m.config, kernel: m.kernel }, "dev");

  assert.ok(bundle.mailDigest, "145 readable messages is over the default threshold of 10");
  assert.equal(bundle.mailDigest.count, 145, "one block stands for every one of them");
  // Not deleted from the turn: the drain reads this list, and a message the
  // page never showed must not be marked answered.
  assert.equal(bundle.unreadMail.length, 145, "every message is still handed over");

  const mail = mailSection(renderContextInstructions(bundle));
  assert.match(mail, /145 message\(s\) from 4 sender\(s\)/, "the count and the number of senders are named");
  assert.match(mail, /INFORM ×145/, "so is the type");
  for (const sender of SENDERS) assert.ok(mail.includes(sender), `${sender} is named`);
  assert.equal(bundle.mailDigest.threads.length, SENDERS.length, "four threads, each named");
  for (const thread of bundle.mailDigest.threads) assert.ok(mail.includes(thread.threadId));
  for (const id of ids) assert.ok(mail.includes(`[${id}]`), `${id} is named, so it is one mesh_inbox call away`);
  assert.ok(!mail.includes("chatter-body"), "and no body of it is printed");

  // Measured rather than asserted by feel, and against the mail the digest
  // stands for: `unreadMail` carries all 145, so a slot that reported its own
  // list would report the very bodies the block removed.
  const manifest = buildContextManifest(bundle, {
    agentId: "dev",
    budgetTokens: 100_000,
    usedTokens: 0,
    tier: "full",
    overSoftCap: false,
  });
  const slot = slotOf(manifest, "mail");
  const bodies = tokensOf(bundle.unreadMail);
  t.diagnostic(`mail slot ${slot.tokens} est. tokens vs the ${bundle.unreadMail.length} messages it stands for (${bodies})`);
  assert.ok(slot.tokens < bodies / 5, `the mail slot must cost a fraction of the mail it names: ${slot.tokens} vs ${bodies}`);
  assert.equal(slot.admitted, 1, "the slot admits one thing: the block");

  await m.cleanup();
});

test("an ask is still rendered whole, body and all, in the same turn as a digest", async () => {
  const m = await mesh();
  const ids = await flood(m, 40);
  const asked = await ask(m, { priority: "URGENT" });
  const bundle = buildAgentContext({ config: m.config, kernel: m.kernel }, "dev");

  assert.equal(bundle.mailDigest?.count, 40, "the news is collapsed");
  const mail = mailSection(renderContextInstructions(bundle));

  // The one thing a digest may never swallow: `delivered means rendered AND
  // answered`, so a seat handed a summary of a question answers blind.
  assert.ok(
    mail.includes(`- [${asked.messageId}] architect → dev REQUEST_REVIEW — ANSWER OWED, URGENT`),
    "the ask is a whole message, marked as owed",
  );
  assert.ok(mail.includes("does this hold under a partial outage?"), "with its body");
  assert.ok(mail.includes("review the retry policy"), "and its thread subject");
  assert.ok(mail.includes("contract: none"), "and the line telling the debtor how to decline it");
  for (const id of ids) assert.ok(mail.includes(`[${id}]`), "the news rides the digest beside it");
  assert.ok(!mail.includes("chatter-body"), "and prints no body of its own");

  await m.cleanup();
});

/* ------------------------------------------------------------------ *
 * The switches                                                      *
 * ------------------------------------------------------------------ */

/**
 * Captured from the tree BEFORE the brief was wired — `mailBrief` had no
 * caller, so these are what today's renderer produces byte for byte.
 *
 * - `OVER_THRESHOLD` is 12 plain INFORMs plus one URGENT ask, rendered with
 *   `digest_threshold: 0`. The box is over the threshold, so the switch is
 *   the only reason nothing is collapsed.
 * - `STALE_NEWS` is three plain INFORMs, a three-hour clock advance and an ask,
 *   rendered with `inform_expiry_ms: 0`. One knob later and the three would be
 *   off the page entirely.
 *
 * Ids are the one run-dependent part of either, so both sides of the
 * comparison are flattened through `normalizeIds`.
 */
const BASELINE_OVER_THRESHOLD = `## Unread mail (what you owe an answer to first, then by priority, grouped into conversations, restatements collapsed)
### thread thread-X — review the retry policy
- [msg-X] architect → dev REQUEST_REVIEW — ANSWER OWED, URGENT
  {"question":"does this hold under a partial outage?"}
  contract: none — no request schema was named, so any reply that answers this settles it. Discharge it with a reason if you will not.
### thread thread-X — fyi 0
- [msg-X] qa → dev INFORM
  {"note":"nothing-to-do-here 0"}
### thread thread-X — fyi 1
- [msg-X] qa → dev INFORM
  {"note":"nothing-to-do-here 1"}
### thread thread-X — fyi 2
- [msg-X] qa → dev INFORM
  {"note":"nothing-to-do-here 2"}
### thread thread-X — fyi 3
- [msg-X] qa → dev INFORM
  {"note":"nothing-to-do-here 3"}
### thread thread-X — fyi 4
- [msg-X] qa → dev INFORM
  {"note":"nothing-to-do-here 4"}
### thread thread-X — fyi 5
- [msg-X] qa → dev INFORM
  {"note":"nothing-to-do-here 5"}
### thread thread-X — fyi 6
- [msg-X] qa → dev INFORM
  {"note":"nothing-to-do-here 6"}
### thread thread-X — fyi 7
- [msg-X] qa → dev INFORM
  {"note":"nothing-to-do-here 7"}
### thread thread-X — fyi 8
- [msg-X] qa → dev INFORM
  {"note":"nothing-to-do-here 8"}
### thread thread-X — fyi 9
- [msg-X] qa → dev INFORM
  {"note":"nothing-to-do-here 9"}
### thread thread-X — fyi 10
- [msg-X] qa → dev INFORM
  {"note":"nothing-to-do-here 10"}
- (+1 more unread message(s) not shown — still queued; they stay unread until a later turn shows them)

`;

const BASELINE_STALE_NEWS = `## Unread mail (what you owe an answer to first, then by priority, grouped into conversations, restatements collapsed)
### thread thread-X — review the retry policy
- [msg-X] architect → dev REQUEST_REVIEW — ANSWER OWED
  {"question":"does this hold under a partial outage?"}
  contract: none — no request schema was named, so any reply that answers this settles it. Discharge it with a reason if you will not.
### thread thread-X — aged 0
- [msg-X] qa → dev INFORM
  {"note":"ancient-body 0"}
### thread thread-X — aged 1
- [msg-X] qa → dev INFORM
  {"note":"ancient-body 1"}
### thread thread-X — aged 2
- [msg-X] qa → dev INFORM
  {"note":"ancient-body 2"}

`;

test("digest_threshold: 0 restores the pre-wiring rendering byte for byte, over the threshold", async () => {
  const m = await mesh();
  for (let i = 0; i < 12; i++) {
    await m.supervisor.sendMessage({
      from: "qa",
      to: ["dev"],
      type: "INFORM",
      newThread: { subject: `fyi ${i}` },
      payload: { note: `nothing-to-do-here ${i}` },
    });
  }
  await ask(m, { priority: "URGENT" });
  // The box is over the threshold: nothing else silences the digest.
  const config = withMessages(m, { digestThreshold: 0, informExpiryMs: 90 * 60_000 });
  const bundle = buildAgentContext({ config, kernel: m.kernel }, "dev");
  assert.equal(bundle.mailDigest, undefined, "the off switch is off");
  assert.equal(bundle.expiredMailIds, undefined, "and nothing expired, so nothing else moved");

  const text = normalizeIds(mailSection(renderContextInstructions(bundle)));
  assert.equal(text, BASELINE_OVER_THRESHOLD);
  await m.cleanup();
});

test("inform_expiry_ms: 0 restores the pre-wiring rendering byte for byte, for aged news", async () => {
  const m = await mesh();
  for (let i = 0; i < 3; i++) {
    await m.supervisor.sendMessage({
      from: "qa",
      to: ["dev"],
      type: "INFORM",
      newThread: { subject: `aged ${i}` },
      payload: { note: `ancient-body ${i}` },
    });
  }
  // Three hours later: well past the 90-minute default, so the switch is the
  // only reason these three are still on the page.
  (m.kernel.clock as ManualClock).advance(3 * 60 * 60_000);
  await ask(m);
  const config = withMessages(m, { digestThreshold: 10, informExpiryMs: 0 });
  const bundle = buildAgentContext({ config, kernel: m.kernel }, "dev");
  assert.equal(bundle.expiredMailIds, undefined, "the off switch is off");
  assert.equal(bundle.mailDigest, undefined, "and four messages is nowhere near the threshold");

  const text = normalizeIds(mailSection(renderContextInstructions(bundle)));
  assert.equal(text, BASELINE_STALE_NEWS);
  await m.cleanup();
});

/* ------------------------------------------------------------------ *
 * Nothing else moves                                                 *
 * ------------------------------------------------------------------ */

test("a below-threshold mailbox is rendered exactly as it always was", async () => {
  const m = await mesh();
  const fresh = await m.supervisor.sendMessage({
    from: "qa",
    to: ["dev"],
    type: "INFORM",
    newThread: { subject: "freeze window" },
    payload: { heads_up: "the freeze starts friday" },
  });
  const asked = await ask(m);
  const bundle = buildAgentContext({ config: m.config, kernel: m.kernel }, "dev");

  assert.equal(bundle.mailDigest, undefined, "three messages is under the threshold");
  assert.equal(bundle.expiredMailIds, undefined, "and nothing is old enough to expire");
  assert.deepEqual(
    bundle.unreadMail.map((x) => x.id).sort(),
    [fresh.messageId!, asked.messageId!].sort(),
    "the box is handed over whole, with nothing added and nothing held back",
  );
  assert.equal(bundle.omitted?.unread, undefined, "and nothing was withheld");

  const mail = mailSection(renderContextInstructions(bundle));
  assert.ok(mail.includes("the freeze starts friday"), "both bodies are printed verbatim");
  assert.ok(mail.includes("does this hold under a partial outage?"));
  assert.ok(!/digest/i.test(mail), "and no digest block was invented for it");

  await m.cleanup();
});

/* ------------------------------------------------------------------ *
 * What the page says about the mail it did not show                 *
 * ------------------------------------------------------------------ */

test("expired news is held back by count, and says where it went", async () => {
  const m = await mesh();
  const aged: string[] = [];
  for (let i = 0; i < 3; i++) {
    const res = await m.supervisor.sendMessage({
      from: "qa",
      to: ["dev"],
      type: "INFORM",
      newThread: { subject: `aged ${i}` },
      payload: { note: `ancient-body ${i}` },
    });
    aged.push(res.messageId!);
  }
  (m.kernel.clock as ManualClock).advance(3 * 60 * 60_000);
  const asked = await ask(m);
  const bundle = buildAgentContext({ config: m.config, kernel: m.kernel }, "dev");

  assert.equal(bundle.mailDigest, undefined, "three is not a deep box");
  assert.equal(bundle.expiredMailIds?.length, 3, "the three aged INFORMs are held back");
  // Held back is not lost, and it is not silent either: the drain reads this
  // list, and without the line below a seat whose mail aged out would see a
  // section that simply no longer mentioned it.
  for (const id of aged) assert.ok(bundle.unreadMail.some((x) => x.id === id), `${id} is still handed over`);

  const mail = mailSection(renderContextInstructions(bundle));
  assert.ok(mail.includes("does this hold under a partial outage?"), "the ask still renders whole");
  assert.match(mail, /3 stale message\(s\) are not shown/);
  assert.match(mail, /still in your mailbox and still unread/);
  assert.match(mail, /mesh_inbox/);
  assert.ok(!mail.includes("ancient-body"), "the stale bodies are not printed");
  assert.ok(!mail.includes(`[${aged[0]}]`), "and they are not named as mail either — they are off the page");
  assert.equal(bundle.omitted?.unread, undefined, "counted as shown, because the line above says so out loud");

  await m.cleanup();
});

test("a handover turn is handed no mail, and no block claiming to stand for it", async () => {
  const m = await mesh();
  await flood(m, 20);
  const full = buildAgentContext({ config: m.config, kernel: m.kernel }, "dev");
  assert.ok(full.mailDigest, "the box is deep enough to digest");

  const { handoverBundle } = await import("../../packages/core/src/context");
  const handover = handoverBundle(full);
  assert.equal(handover.unreadMail.length, 0);
  assert.equal(handover.mailDigest, undefined, "a digest of mail this turn was never handed");
  assert.equal(handover.expiredMailIds, undefined);
  assert.ok(
    !/## Unread mail/.test(renderContextInstructions(handover)),
    "and nothing renders a mail section for it",
  );

  await m.cleanup();
});
