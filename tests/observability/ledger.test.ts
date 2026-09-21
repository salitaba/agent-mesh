import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TOKEN_COST_RATIO,
  buildCacheLedger,
  parseTurnAudit,
  type TurnLedgerRow,
} from "../../packages/observability/src/index";

/**
 * One audit line, shaped exactly like `supervisor.auditTurn` writes it: an ISO
 * prefix, then the record. The record is the production contract this parser
 * reads, so a field rename in the writer must redden these tests rather than
 * silently emptying every ledger in the field.
 */
function line(at: string, rec: Record<string, unknown>): string {
  return `${at} ${JSON.stringify(rec)}`;
}

function record(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    turnId: "turn-1",
    agentId: "backend",
    at: "2026-09-19T13:10:26.000Z",
    activation: { kind: "message", note: "mail" },
    model: "claude-opus-5",
    modelVersion: "claude-opus-5",
    inputDigest: "sha256:aa",
    outputDigest: "sha256:bb",
    ops: [{ op: "mesh_send" }],
    toolCalls: [{ name: "read_artifact" }, { name: "mesh_send" }],
    tokens: { input: 1000, output: 100, total: 1100, cacheRead: 0 },
    instructionsChars: 7980,
    estInputTokens: 1995,
    memoryNotes: 3,
    ...over,
  };
}

test("parses the production audit shape and keeps the fields a reader needs", () => {
  const { rows, damaged } = parseTurnAudit(line("2026-09-19T13:10:26.000Z", record()) + "\n");
  assert.equal(damaged, 0);
  assert.equal(rows.length, 1);
  const r = rows[0]!;
  assert.equal(r.at, "2026-09-19T13:10:26.000Z");
  assert.equal(r.turnId, "turn-1");
  assert.equal(r.agentId, "backend");
  assert.equal(r.kind, "message");
  assert.equal(r.input, 1000);
  assert.equal(r.output, 100);
  assert.equal(r.cacheRead, 0);
  assert.equal(r.instructionsChars, 7980);
  assert.equal(r.ops, 1);
  assert.equal(r.toolCalls, 2);
});

test("a record with no cacheRead is unmeasured, not cold", () => {
  // The §1e failure in one assertion: an older record has no `cacheRead` at all,
  // and counting that absence as "this turn re-read everything uncached" is how
  // a handful of catastrophic re-reads stayed invisible.
  const old = record({ tokens: { input: 5000, output: 50, total: 5050 } });
  const cold = record({ turnId: "turn-2", tokens: { input: 4000, output: 40, total: 4040, cacheRead: 0 } });
  const { rows } = parseTurnAudit(line("2026-09-19T13:00:00.000Z", old) + "\n" + line("2026-09-19T13:05:00.000Z", cold) + "\n");

  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.cacheRead, null);
  assert.equal(rows[1]!.cacheRead, 0);

  const led = buildCacheLedger(rows);
  assert.equal(led.turns, 2);
  assert.equal(led.unmeasured, 1);
  assert.equal(led.coldTurns, 1, "only the turn that reported cacheRead: 0 is cold");
  assert.equal(led.coldFreshShare, 4000 / 9000);
});

test("separates prose, continuations and damage from a turn", () => {
  const text = [
    line("2026-09-19T13:00:00.000Z", record()),
    "2026-09-19T13:00:30.000Z turn turn-a20e for pm: 1/4 ops rejected: unknown recipient",
    "## Goal", // a prose audit line that spans physical lines, as an artifact quote does
    "2026-09-19T13:01:00.000Z { this is not json",
    "2026-09-19T13:02:00.000Z " + JSON.stringify({ turnId: "t", agentId: "a" }),
    line("2026-09-19T13:03:00.000Z", record({ turnId: "turn-2" })),
    "", // the trailing newline every appended file ends with
  ].join("\n");
  const { rows, other, unstamped, damaged } = parseTurnAudit(text);
  assert.equal(rows.length, 2);
  // The audit file carries two shapes under one timestamp prefix; the prose one
  // is normal and must not be reported to an operator as an unreadable line.
  assert.equal(other, 2, "the prose line and the JSON record with no token figures");
  assert.equal(unstamped, 1, "the continuation line of the multi-line prose record");
  assert.equal(damaged, 1, "a stamped record that opens and never closes");
  // Blank lines are not unreadable lines: a trailing newline would otherwise
  // report every file in the field as carrying one bad line.
  assert.equal(parseTurnAudit("\n\n\n").damaged, 0);
  assert.equal(parseTurnAudit("\n\n\n").unstamped, 0);
});

test("a turn that reported only a cache read is still a row", () => {
  const { rows, other } = parseTurnAudit(line("2026-09-19T13:00:00.000Z", record({ tokens: { cacheRead: 700 } })));
  assert.equal(other, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.input, 0);
  assert.equal(rows[0]!.cacheRead, 700);
});

test("zero is a figure — a turn that reported no input is a row, not a skipped line", () => {
  // The same absence-vs-falsiness mistake as the unmeasured-vs-cold case, one
  // layer down: `!input` is true for a reported 0, which dropped two of mission
  // A's 307 traced turns from the ledger and made the count disagree with §11a.
  const text = [
    line("2026-09-19T13:00:00.000Z", record({ turnId: "zero", tokens: { input: 0, output: 5, total: 5 } })),
    line("2026-09-19T13:01:00.000Z", record({ turnId: "both", tokens: { input: 0, output: 0, total: 0, cacheRead: 0 } })),
    line("2026-09-19T13:02:00.000Z", record({ turnId: "none", tokens: { output: 9 } })),
  ].join("\n");
  const { rows, other } = parseTurnAudit(text);

  assert.equal(rows.length, 2, "the two turns that reported a number, even a zero");
  assert.equal(other, 1, "only the turn with no token figures at all");
  assert.deepEqual(rows.map((r) => r.turnId), ["zero", "both"]);
  assert.equal(rows[0]!.input, 0);
  assert.equal(rows[0]!.cacheRead, null, "absent cacheRead is still unmeasured, not cold");
  assert.equal(rows[1]!.cacheRead, 0, "a reported zero is cold");
  assert.equal(buildCacheLedger(rows).unmeasured, 1);
});

test("weights the three lines the way a bill would", () => {
  const { rows } = parseTurnAudit(
    line("2026-09-19T13:00:00.000Z", record({ tokens: { input: 1000, output: 1000, total: 1000, cacheRead: 10_000 } })) + "\n",
  );
  const led = buildCacheLedger(rows);
  assert.equal(led.units.freshInput, 1000 * TOKEN_COST_RATIO.fresh);
  assert.equal(led.units.cachedRead, 10_000 * TOKEN_COST_RATIO.cacheRead);
  assert.equal(led.units.output, 1000 * TOKEN_COST_RATIO.output);
  // Output is the largest line here even though it is a tenth of the token count.
  assert.ok(led.units.output > led.units.cachedRead);
});

test("reports concentration over fresh input, not over the cached sum", () => {
  const rows: string[] = [];
  for (let i = 0; i < 10; i++) {
    rows.push(line(`2026-09-19T13:0${i}:00.000Z`, record({ turnId: `t${i}`, tokens: { input: 100, output: 1, total: 100, cacheRead: 999_999 } })));
  }
  rows.push(line("2026-09-19T13:10:00.000Z", record({ turnId: "whale", tokens: { input: 900, output: 1, total: 900, cacheRead: 5 } })));
  const led = buildCacheLedger(parseTurnAudit(rows.join("\n")).rows, 1);
  assert.equal(led.top.length, 1);
  assert.equal(led.top[0]!.turnId, "whale");
  assert.equal(led.topFreshShare, 900 / 1900);
});

test("buckets fresh input by the gap since that seat's own previous turn", () => {
  const text = [
    line("2026-09-19T13:00:00.000Z", record({ turnId: "a", tokens: { input: 100, output: 1, total: 100, cacheRead: 5 } })),
    line("2026-09-19T13:01:00.000Z", record({ turnId: "b", tokens: { input: 200, output: 1, total: 200, cacheRead: 5 } })),
    line("2026-09-19T13:16:00.000Z", record({ turnId: "c", tokens: { input: 300, output: 1, total: 300, cacheRead: 5 } })),
    line("2026-09-19T13:02:00.000Z", record({ turnId: "d", agentId: "frontend", tokens: { input: 400, output: 1, total: 400, cacheRead: 5 } })),
  ].join("\n");
  const led = buildCacheLedger(parseTurnAudit(text).rows);
  const byLabel = new Map(led.gaps.map((g) => [g.label, g]));

  // Frontend's first turn has no predecessor and belongs to no bucket.
  assert.equal(byLabel.get("<2 min")!.turns, 1);
  assert.equal(byLabel.get("<2 min")!.medianFresh, 200);
  const wide = byLabel.get("10-30 min")!;
  assert.equal(wide.turns, 1);
  assert.equal(wide.maxFresh, 300);
  assert.equal(byLabel.has("2-5 min"), false, "buckets with no turns are omitted, not printed as zeros");
});

test("an empty or unmeasured ledger is zeros, never NaN", () => {
  const empty = buildCacheLedger([]);
  assert.equal(empty.turns, 0);
  assert.equal(empty.topFreshShare, 0);
  assert.equal(empty.coldFreshShare, 0);
  assert.deepEqual(empty.units, { freshInput: 0, cachedRead: 0, output: 0 });
  assert.deepEqual(empty.gaps, []);

  const unmeasured = buildCacheLedger(parseTurnAudit(line("2026-09-19T13:00:00.000Z", record({ tokens: { input: 10, output: 1, total: 11 } }))).rows);
  assert.equal(unmeasured.unmeasured, 1);
  assert.equal(unmeasured.coldTurns, 0);
  assert.equal(unmeasured.cacheRead, 0);
});

test("a row built by hand is usable without the parser", () => {
  // The dashboard and any future caller should be able to feed rows it already
  // has; the ledger must not depend on the file it was first written for.
  const row: TurnLedgerRow = {
    at: "2026-09-19T13:00:00.000Z", turnId: "t", agentId: "a", kind: "timer",
    input: 10, output: 2, cacheRead: null, ops: 0, toolCalls: 0,
  };
  const led = buildCacheLedger([row]);
  assert.equal(led.turns, 1);
  assert.equal(led.unmeasured, 1);
  assert.equal(led.units.output, 10);
});
