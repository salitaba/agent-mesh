import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BRIEF_MARKER,
  DEFAULT_FIT_TOKENS,
  clearOldToolTraffic,
  compactConversation,
  estimateConversationTokens,
  resolveContextPolicy,
} from "../../packages/runtime-native/src/index";
import type { ChatMessage } from "../../packages/llm/src/index";

/**
 * The conversation economy: what a seat's context may weigh, and what is dropped when
 * it gets there.
 *
 * The figures this is written against are from a live mission (2026-10-23..11-03):
 * a seat carried 563k tokens because rotation waited for 60% of a 1M window, and 18
 * turns of >=1M billable tokens carried 31% of the mission's spend.
 */

const brief = (n: number): ChatMessage => ({ role: "user", content: `${BRIEF_MARKER}; authoritative over any claim in chat)\n\nturn ${n}\n` + "x".repeat(4000) });
const toolResult = (n: number, chars: number): ChatMessage => ({ role: "tool", toolCallId: `t${n}`, name: "Read", content: "r".repeat(chars) });
const assistantCall = (n: number, args: Record<string, unknown>): ChatMessage => ({
  role: "assistant",
  content: "",
  toolCalls: [{ id: `t${n}`, name: "Write", args }],
});

test("the budget: a 1M window is a capability, not a target", () => {
  const p = resolveContextPolicy(undefined, { tokens: 1_000_000, known: true });
  assert.equal(p.fitTokens, DEFAULT_FIT_TOKENS, "a 1M model rotates at the economy budget, not at 600k");
  assert.equal(p.maxTurnTokens, DEFAULT_FIT_TOKENS * 10, "a turn may spend the budget ten times over, no more");
  assert.equal(p.warnAtRatio, 0.75);
});

test("a small window keeps its 60%, so a 128k model is never over-sized", () => {
  const p = resolveContextPolicy(undefined, { tokens: 128_000, known: true });
  assert.equal(p.fitTokens, 76_800);
});

test("a seat's own max_context_tokens is a budget and wins over the mesh's", () => {
  const p = resolveContextPolicy({ fitTokens: 200_000 }, { tokens: 1_000_000, known: true }, 90_000);
  assert.equal(p.fitTokens, 90_000);
  assert.equal(p.maxTurnTokens, 900_000, "the ceiling follows the seat's budget");
});

test("fit_tokens: 0 means the window's share, max_turn_tokens: 0 means no ceiling, and the rest is clamped to something usable", () => {
  const p = resolveContextPolicy({ fitTokens: 0, keepRecentMessages: 0, elideAboveChars: -4, maxToolResultChars: 0, maxTurnTokens: 0, warnAtRatio: 2 }, { tokens: 1_000_000, known: true });
  assert.equal(p.fitTokens, DEFAULT_FIT_TOKENS);
  assert.equal(p.keepRecentMessages, 8);
  assert.equal(p.elideAboveChars, 2_000);
  assert.equal(p.maxToolResultChars, 60_000);
  assert.equal(p.maxTurnTokens, Infinity, "0 is how a mesh turns the ceiling off");
  assert.equal(p.warnAtRatio, 0.75);
});

test("what a conversation weighs counts the tool-call arguments, which is where a written file lives", () => {
  const messages: ChatMessage[] = [{ role: "user", content: "x".repeat(400) }, assistantCall(1, { path: "a.ts", content: "y".repeat(4000) }), toolResult(1, 400)];
  const weight = estimateConversationTokens(messages);
  const contentOnly = Math.ceil((400 + 400 + (400 + 8 * 3)) / 4);
  assert.ok(weight > contentOnly + 900, `${weight} should include the 4000-character Write body, not just the messages`);
});

test("compaction drops superseded briefs, elides old tool traffic, and keeps the newest brief and the recent tail whole", () => {
  const messages: ChatMessage[] = [];
  for (let t = 0; t < 10; t++) {
    messages.push(brief(t));
    messages.push(assistantCall(t, { path: `f${t}.ts`, content: "c".repeat(5000) }));
    messages.push(toolResult(t, 5000));
    messages.push({ role: "assistant", content: `landed turn ${t}` });
  }
  const before = estimateConversationTokens(messages);
  const policy = resolveContextPolicy({ fitTokens: 50_000 }, { tokens: 1_000_000, known: true });
  const result = compactConversation(messages, policy);

  assert.equal(result.droppedBriefs, 9, "every superseded brief is dropped, wherever it sits");
  assert.ok(result.elidedResults > 0, "old tool results are replaced by a note");
  assert.ok(result.elidedArgs > 0, "old tool-call arguments are replaced by a digest");
  assert.ok(result.estimateAfter < result.estimateBefore, "the conversation got lighter");
  assert.ok(result.estimateAfter < before / 2, `expected at least half the weight gone (${before} -> ${result.estimateAfter})`);

  const briefs = messages.filter((m) => m.role === "user" && m.content.startsWith(BRIEF_MARKER));
  assert.equal(briefs.length, 1, "the newest brief survives");
  assert.match((briefs.at(-1) as { content: string }).content, /turn 9/);

  const tail = messages.slice(-policy.keepRecentMessages);
  assert.ok(tail.some((m) => m.role === "tool" && (m as { content: string }).content.startsWith("r".repeat(100))), "the recent tail is untouched");

  // Structure: every tool message still answers a call that is still in the conversation.
  const callIds = new Set(messages.flatMap((m) => (m.role === "assistant" ? (m.toolCalls ?? []).map((c) => c.id) : [])));
  for (const m of messages) if (m.role === "tool") assert.ok(callIds.has(m.toolCallId), `tool result ${m.toolCallId} has no call`);

  const again = compactConversation(messages, policy);
  assert.equal(again.freedChars, 0, "a second pass is a no-op");
});

test("mid-turn clearing keeps the last rounds whole and only fires when it is worth the cache invalidation", () => {
  const messages: ChatMessage[] = [{ role: "user", content: "brief" }];
  for (let i = 0; i < 10; i++) {
    messages.push(assistantCall(i, { path: `f${i}.ts`, content: "p".repeat(3000) }));
    messages.push(toolResult(i, 3000));
  }
  const snapshot = JSON.stringify(messages);
  const tooLittle = clearOldToolTraffic(messages, { keepToolUses: 3, minChars: 500, clearAtLeastTokens: 1_000_000 });
  assert.equal(tooLittle.freedChars, 0, "a clear that cannot free enough is not made");
  assert.equal(JSON.stringify(messages), snapshot, "and nothing is mutated");

  const result = clearOldToolTraffic(messages, { keepToolUses: 3, minChars: 500, clearAtLeastTokens: 5_000 });
  assert.equal(result.clearedResults, 7, "seven older results, the last three rounds untouched");
  assert.equal(result.clearedArgs, 7, "and the arguments that wrote those files");
  assert.ok(result.estimateFreedTokens >= 5_000);

  const kept = messages.slice(-6).filter((m) => m.role === "tool") as Array<{ content: string }>;
  assert.equal(kept.length, 3);
  for (const m of kept) assert.equal(m.content.length, 3000, "the rounds being worked from are intact");

  const cleared = messages.filter((m) => m.role === "tool" && m.content.startsWith("[cleared")) as Array<{ content: string }>;
  assert.equal(cleared.length, 7);
  assert.match(cleared[0]!.content, /run it again if you need the result/);
});

test("mid-turn clearing never breaks the conversation", () => {
  const messages: ChatMessage[] = [];
  for (let i = 0; i < 6; i++) {
    messages.push(assistantCall(i, { content: "x".repeat(4000) }));
    messages.push(toolResult(i, 4000));
  }
  clearOldToolTraffic(messages, { keepToolUses: 2, minChars: 500, clearAtLeastTokens: 1 });
  const calls = new Set(messages.flatMap((m) => (m.role === "assistant" ? (m.toolCalls ?? []).map((c) => c.id) : [])));
  for (const m of messages) if (m.role === "tool") assert.ok(calls.has(m.toolCallId), "every result still answers a call");
  for (const m of messages) {
    if (m.role !== "assistant" || !m.toolCalls) continue;
    for (const c of m.toolCalls) assert.equal(typeof c.args, "object");
  }
});

test("when a fresh brief is arriving, every brief goes, including the newest", () => {
  const messages: ChatMessage[] = [brief(0), { role: "assistant", content: "worked" }, brief(1), { role: "assistant", content: "worked again" }];
  const result = compactConversation(messages, resolveContextPolicy({ keepRecentMessages: 2 }, { tokens: 200_000, known: true }), { dropAllBriefs: true });
  assert.equal(result.droppedBriefs, 2);
  assert.equal(messages.filter((m) => m.role === "user" && m.content.startsWith(BRIEF_MARKER)).length, 0, "the caller appends the authoritative one");
});

test("compaction never leaves the conversation starting mid-thought", () => {
  const messages: ChatMessage[] = [assistantCall(0, { path: "a", content: "x".repeat(5000) }), toolResult(0, 5000), brief(1), { role: "assistant", content: "ok" }];
  compactConversation(messages, resolveContextPolicy({ fitTokens: 500, keepRecentMessages: 2 }, { tokens: 1_000, known: true }));
  assert.equal(messages[0]?.role, "user", "a conversation must open with a user turn on every wire");
});

test("compaction keeps the last N messages whole even when one of them is over the elide bar", () => {
  const messages: ChatMessage[] = [brief(0), assistantCall(0, { content: "x".repeat(9000) }), toolResult(0, 9000), { role: "assistant", content: "done" }];
  const policy = resolveContextPolicy({ keepRecentMessages: 2, elideAboveChars: 1000 }, { tokens: 1_000, known: true });
  const result = compactConversation(messages, policy);
  assert.equal((messages[2] as { content: string }).content.length, 9000, "the last two are untouched");
  assert.equal((messages[3] as { content: string }).content.length, 4);
  assert.equal(result.elidedArgs, 1, "the call before them is elided");
});
