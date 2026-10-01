import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { aggregateUsage, aggregateUsageFromLogs, priceFor, usageToCsv, type UsageEventLike } from "../../packages/observability/src/usage";

/**
 * Usage is a projection of the event log: tokens exact, money an estimate that says it is.
 *
 * The fixture is real: 22 events cut from the seventh cronlite run's log (ten per-seat
 * `budget.consumed`, the ten mission-level entries that repeat the same tokens, the goal's
 * creation and completion) plus one line that is not JSON. The expected totals were computed
 * independently of this code, from the raw log, so a reader that double counts the mission-level
 * entries, drops cache writes or trusts a malformed line fails here.
 */

const FIXTURE = path.resolve(__dirname, "..", "..", "..", "tests", "fixtures", "usage-run7.jsonl");
const HAIKU = { "claude-haiku-4-5": { inputPerMtok: 1, outputPerMtok: 5 } };

function fixtureEvents(): UsageEventLike[] {
  return fs
    .readFileSync(FIXTURE, "utf8")
    .split("\n")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as UsageEventLike];
      } catch {
        return [];
      }
    });
}

const consumed = (over: Record<string, unknown>, timestamp = "2026-10-01T10:00:00.000Z"): UsageEventLike => ({
  type: "budget.consumed",
  timestamp,
  payload: { key: "agent:goal-1/dev", agentId: "dev", model: "claude-haiku-4-5-20251001", input: 10, output: 20, cacheRead: 100, amount: 130, ...over },
});

test("the real log's totals: the per-seat entries only, cache writes derived, nothing counted twice", async () => {
  const report = await aggregateUsageFromLogs([{ project: "cronlite", file: FIXTURE }], { groupBy: ["agent"] });
  assert.equal(report.totals.turns, 10, "ten turns; counting the mission-level entries too would make twenty");
  assert.deepEqual(
    {
      input: report.totals.inputTokens,
      output: report.totals.outputTokens,
      cacheWrite: report.totals.cacheWriteTokens,
      cacheRead: report.totals.cacheReadTokens,
      billed: report.totals.billedTokens,
      thinking: report.totals.thinkingTokens,
      tools: report.totals.toolCalls,
    },
    { input: 620, output: 36_785, cacheWrite: 181_636, cacheRead: 2_640_072, billed: 219_041, thinking: 15_865, tools: 77 },
  );
  assert.equal(report.totals.inputTokens + report.totals.outputTokens + report.totals.cacheWriteTokens, report.totals.billedTokens, "billed is input + output + cache writes");

  const byAgent = Object.fromEntries(report.rows.map((r) => [r.agent, r]));
  assert.deepEqual(Object.keys(byAgent), ["architect", "developer", "pm", "qa", "tech-lead"], "rows are sorted by the grouping");
  assert.equal(byAgent.architect!.turns, 5);
  assert.equal(byAgent.architect!.billedTokens, 83_236);
  assert.equal(byAgent.pm!.cacheWriteTokens, 35_928);
  assert.equal(byAgent["tech-lead"]!.cacheReadTokens, 316_289);

  assert.deepEqual(report.summary, { turns: 10, activeSeatDays: 5, missionsCreated: 1, missionsCompleted: 1 });
});

test("cost is an estimate at configured prices, matched by model id prefix", async () => {
  const report = await aggregateUsageFromLogs([{ project: "cronlite", file: FIXTURE }], { groupBy: ["model"], prices: HAIKU });
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0]!.model, "claude-haiku-4-5-20251001");
  // (620*1 + 36785*5 + 181636*1.25 + 2640072*0.1) / 1e6, worked out from the raw log.
  assert.equal(report.totals.costUsd, 0.675597);
  assert.deepEqual(report.unpricedModels, []);
});

test("a model with no price is reported unpriced and its cost is null, never a default", async () => {
  const none = await aggregateUsageFromLogs([{ project: "p", file: FIXTURE }], { groupBy: ["day"] });
  assert.equal(none.totals.costUsd, null);
  assert.equal(none.rows[0]!.costUsd, null);
  assert.deepEqual(none.unpricedModels, ["claude-haiku-4-5-20251001"]);
  assert.match(none.note, /costUsd is an estimate .* null where a model has no price; the model provider's invoice is the authoritative bill/);

  const wrong = await aggregateUsageFromLogs([{ project: "p", file: FIXTURE }], { prices: { "claude-opus-5": { inputPerMtok: 5, outputPerMtok: 25 } } });
  assert.equal(wrong.totals.costUsd, null, "a price for some other model prices nothing here");
});

test("an unpriced model makes only its own rows null, and the report's total null", () => {
  const report = aggregateUsage(
    [consumed({}), consumed({ model: "some-future-model", agentId: "qa", key: "agent:goal-1/qa" })],
    { groupBy: ["model"], prices: HAIKU },
  );
  const byModel = Object.fromEntries(report.rows.map((r) => [r.model, r.costUsd]));
  assert.notEqual(byModel["claude-haiku-4-5-20251001"], null);
  assert.equal(byModel["some-future-model"], null);
  assert.equal(report.totals.costUsd, null, "a total that silently left a model out would under-report");
  assert.deepEqual(report.unpricedModels, ["some-future-model"]);
});

test("price lookup: exact id, provider prefix stripped, then the longest key the model starts with", () => {
  const prices = {
    "claude-haiku": { inputPerMtok: 9, outputPerMtok: 9 },
    "claude-haiku-4-5": { inputPerMtok: 1, outputPerMtok: 5 },
    "anthropic/claude-sonnet-4-5": { inputPerMtok: 3, outputPerMtok: 15 },
    "Claude-Opus-5": { inputPerMtok: 5, outputPerMtok: 25 },
  };
  assert.equal(priceFor("claude-haiku-4-5-20251001", prices)?.outputPerMtok, 5, "the longer prefix wins over the shorter");
  assert.equal(priceFor("claude-haiku-3", prices)?.outputPerMtok, 9);
  assert.equal(priceFor("anthropic/claude-haiku-4-5", prices)?.outputPerMtok, 5, "a provider prefix on the model is ignored");
  assert.equal(priceFor("claude-sonnet-4-5-20250929", prices)?.outputPerMtok, 15, "and on the key");
  assert.equal(priceFor("CLAUDE-OPUS-5-xyz", prices)?.inputPerMtok, 5, "case does not matter");
  assert.equal(priceFor("gpt-x", prices), undefined);
  assert.equal(priceFor("claude-haiku-4-5", undefined), undefined);
});

test("cache prices default to the published ratios and can be set explicitly", () => {
  const events = [consumed({ input: 1_000_000, output: 0, cacheRead: 1_000_000, amount: 2_000_000 })]; // 1M input, 1M cache write, 1M cache read
  const defaults = aggregateUsage(events, { prices: { "claude-haiku-4-5": { inputPerMtok: 1, outputPerMtok: 5 } } });
  assert.equal(defaults.totals.costUsd, 1 + 1.25 + 0.1);
  const explicit = aggregateUsage(events, { prices: { "claude-haiku-4-5": { inputPerMtok: 1, outputPerMtok: 5, cacheWritePerMtok: 2, cacheReadPerMtok: 0.5 } } });
  assert.equal(explicit.totals.costUsd, 1 + 2 + 0.5);
});

test("a period is [since, until): inclusive of the start, exclusive of the end", () => {
  const events = [
    consumed({}, "2026-10-01T00:00:00.000Z"),
    consumed({}, "2026-10-01T23:59:59.999Z"),
    consumed({}, "2026-10-02T00:00:00.000Z"),
    consumed({}, "2026-09-30T23:59:59.999Z"),
    { type: "goal.created", timestamp: "2026-10-01T05:00:00Z", payload: {} },
    { type: "goal.completed", timestamp: "2026-10-02T05:00:00Z", payload: {} },
  ];
  const report = aggregateUsage(events, { since: "2026-10-01", until: "2026-10-02", groupBy: ["day"] });
  assert.equal(report.totals.turns, 2);
  assert.deepEqual(report.rows.map((r) => r.day), ["2026-10-01"]);
  assert.deepEqual(report.summary, { turns: 2, activeSeatDays: 1, missionsCreated: 1, missionsCompleted: 0 }, "goal events are bounded by the period too");
  assert.equal(report.since, "2026-10-01");
  assert.equal(report.until, "2026-10-02");
  assert.throws(() => aggregateUsage([], { since: "last tuesday" }), /since 'last tuesday' is not a date/);
  assert.throws(() => aggregateUsage([], { until: "soon" }), /until 'soon' is not a date/);
});

test("grouping by several dimensions, and by project across logs", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-usage-"));
  try {
    const second = path.join(dir, "second.jsonl");
    fs.copyFileSync(FIXTURE, second);
    const both = await aggregateUsageFromLogs(
      [
        { project: "alpha", file: FIXTURE },
        { project: "beta", file: second },
        { project: "gamma", file: path.join(dir, "missing.jsonl") },
      ],
      { groupBy: ["project", "agent"] },
    );
    assert.equal(both.totals.turns, 20);
    assert.equal(both.rows.length, 10, "two projects times five seats; a log that does not exist adds nothing");
    assert.deepEqual(both.rows.slice(0, 2).map((r) => [r.project, r.agent]), [["alpha", "architect"], ["alpha", "developer"]]);
    assert.equal(both.summary.activeSeatDays, 10, "a seat-day is per project");
    assert.equal(both.summary.missionsCreated, 2);

    const byDayModel = await aggregateUsageFromLogs([{ project: "alpha", file: FIXTURE }], { groupBy: ["day", "model", "day"] });
    assert.deepEqual(byDayModel.groupBy, ["day", "model"], "a repeated dimension is grouped once");
    assert.equal(byDayModel.rows.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the file reader and the in-memory path agree, and neither trusts malformed input", async () => {
  const fromFile = await aggregateUsageFromLogs([{ project: "p", file: FIXTURE }], { groupBy: ["agent"], prices: HAIKU });
  const inMemory = aggregateUsage(fixtureEvents(), { groupBy: ["agent"], prices: HAIKU, project: "p" });
  assert.deepEqual(inMemory, fromFile);

  const hostile = aggregateUsage(
    [
      consumed({ input: -5, output: Number.NaN, cacheRead: "lots", amount: 50 }),
      consumed({ amount: 10, input: 100, output: 100 }), // billed below input+output: cache writes cannot go negative
      { type: "budget.consumed", timestamp: "not a date", payload: { key: "agent:g/x", model: "m", amount: 5 } },
      { type: "budget.consumed", timestamp: "2026-10-01T00:00:00Z", payload: null },
      { type: "budget.consumed", timestamp: "2026-10-01T00:00:00Z", payload: { key: "mission:g", amount: 99 } },
      { type: "budget.consumed", timestamp: "2026-10-01T00:00:00Z", payload: { key: "agent:g/x", amount: 99 } },
    ],
    { groupBy: ["day"] },
  );
  assert.equal(hostile.totals.turns, 2, "only the two well-formed per-seat entries count");
  assert.equal(hostile.totals.inputTokens, 100, "a negative or non-numeric count is zero");
  assert.equal(hostile.totals.cacheWriteTokens, 50, "billed 50 with no input or output is 50 written; billed 10 under 200 is 0");
  assert.equal(hostile.totals.cacheReadTokens, 100);
});

test("CSV: grouped dimensions first, measures after, nulls empty, cells quoted when they must be", () => {
  const report = aggregateUsage(
    [
      consumed({ agentId: 'qa, "senior"', key: 'agent:g/qa, "senior"', model: "claude-haiku-4-5-20251001" }),
      consumed({ agentId: "dev", model: "unpriced-model" }),
    ],
    { groupBy: ["agent"], prices: HAIKU },
  );
  const csv = usageToCsv(report);
  const lines = csv.trimEnd().split("\n");
  assert.equal(lines[0], "agent,turns,inputTokens,outputTokens,cacheWriteTokens,cacheReadTokens,billedTokens,thinkingTokens,toolCalls,costUsd");
  assert.equal(lines[1], "dev,1,10,20,100,100,130,0,0,", "an unpriced row's cost is an empty cell, not 0");
  // (10*1 + 20*5 + 100*1.25 + 100*0.1) / 1e6 = 0.000245
  assert.equal(lines[2], '"qa, ""senior""",1,10,20,100,100,130,0,0,0.000245', "the seat name with a comma and quotes is one quoted cell");
  assert.ok(csv.endsWith("\n"));
  assert.equal(usageToCsv(aggregateUsage([], { groupBy: ["day", "model"] })), "day,model,turns,inputTokens,outputTokens,cacheWriteTokens,cacheReadTokens,billedTokens,thinkingTokens,toolCalls,costUsd\n");
});

test("no events is an empty, well-formed report", () => {
  const report = aggregateUsage([], {});
  assert.deepEqual(report.rows, []);
  assert.deepEqual(report.groupBy, ["day"]);
  assert.equal(report.totals.turns, 0);
  assert.equal(report.totals.costUsd, 0, "nothing was used, and nothing is unpriced");
  assert.deepEqual(report.unpricedModels, []);
});
