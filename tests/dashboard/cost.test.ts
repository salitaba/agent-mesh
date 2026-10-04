import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

import {
  AUTO_RAISE_DEFAULT,
  BAD_AT,
  LIST_PRICED_FAMILIES,
  LIST_PRICES_AS_OF,
  WARN_AT,
  agentList,
  budgetRules,
  budgetTone,
  defaultPriceNote,
  describeBudget,
  fmtUsd,
  idleCopy,
  longDate,
  overSentence,
  pctLabel,
  priceBasis,
  readingAge,
  summarizeCost,
  type BudgetEntry,
  type BudgetsPayload,
} from "../../apps/mesh-dashboard/src/cost";

/**
 * What the Cost page says about money. The payload below is what a finished demo mission returned (seven seats, 29 turns,
 * 51,050 tokens of a 2,000,000 budget); the properties pinned here are the ones a reader takes as fact.
 */

const GOAL = "goal-M445F3YK0006745ab794";
const entry = (key: string, consumed: number, limit: number | null, over: Partial<BudgetEntry> = {}): BudgetEntry => ({ key, limit, limitKind: "tokens", reserved: 0, consumed, exceeded: false, ...over });

const REAL: BudgetsPayload = {
  entries: [
    entry(`mission:${GOAL}`, 51050, 2_000_000),
    entry(`agent:${GOAL}/pm`, 7200, 200_000),
    entry(`agent:${GOAL}/architect`, 9000, 200_000),
    entry(`agent:${GOAL}/tech-lead`, 14400, 200_000),
    entry(`agent:${GOAL}/developer`, 7200, 200_000),
    entry(`agent:${GOAL}/qa`, 9000, 200_000),
    entry(`agent:${GOAL}/security`, 3600, 200_000),
    entry(`agent:${GOAL}/explorer`, 650, 200_000),
    entry(`attention:${GOAL}/tech-lead`, 4000, 200_000),
    entry(`thread:${GOAL}/thread-M445H9W600c4610f7490`, 1800, 100_000),
    entry(`task:${GOAL}/task-M445H9WT007516138d33`, 0, 100_000),
  ],
  cost: {
    perAgent: [
      { agentId: "human", tokens: 0, activations: 0, perTurn: 0 },
      { agentId: "pm", tokens: 7200, activations: 4, perTurn: 1800 },
      { agentId: "architect", tokens: 9000, activations: 5, perTurn: 1800 },
      { agentId: "tech-lead", tokens: 14400, activations: 8, perTurn: 1800 },
      { agentId: "developer", tokens: 7200, activations: 4, perTurn: 1800 },
      { agentId: "qa", tokens: 9000, activations: 5, perTurn: 1800 },
      { agentId: "security", tokens: 3600, activations: 2, perTurn: 1800 },
      { agentId: "explorer", tokens: 650, activations: 1, perTurn: 650 },
    ],
    missionTokens: 51050,
    missionBudget: 2_000_000,
    models: [{ model: "stub-model", tokens: 51050, input: 34000, output: 17050, cacheRead: 0, turns: 29, agents: ["architect", "developer", "explorer", "pm", "qa", "security", "tech-lead"], share: 1, avgPerTurn: 1760 }],
  },
};

test("a budget meter is one colour rule: amber from 80%, red from 95%, red whenever the server says it is spent", () => {
  assert.equal(WARN_AT, 0.8);
  assert.equal(BAD_AT, 0.95);
  assert.equal(budgetTone(0), "ok");
  assert.equal(budgetTone(0.79), "ok");
  assert.equal(budgetTone(0.8), "warn");
  assert.equal(budgetTone(0.949), "warn");
  assert.equal(budgetTone(0.95), "bad");
  assert.equal(budgetTone(1.2), "bad");
  assert.equal(budgetTone(0.1, true), "bad", "exceeded outranks the ratio");
  assert.equal(budgetTone(null), "ok", "no limit is nothing to warn about");
  assert.equal(budgetTone(Number.NaN), "ok");
});

test("the top bar and this page use the same thresholds", () => {
  // shell.tsx is not DOM-free, so the numbers are compared by reading it: if the bar moves its line, this fails.
  const shell = fs.readFileSync(path.join(path.resolve(__dirname, "..", "..", ".."), "apps", "mesh-dashboard", "src", "shell.tsx"), "utf8");
  // The bar tests the higher line first (`spentRatio >= 0.95 ? bad : spentRatio >= 0.8 ? warn`), so the two numbers come in that order.
  const m = /spentRatio >= ([0-9.]+)[^;]*?spentRatio >= ([0-9.]+)/.exec(shell);
  assert.ok(m, "the top bar's meter rule is where this test expects it");
  assert.equal(Number(m![1]), BAD_AT);
  assert.equal(Number(m![2]), WARN_AT);
});

test("a percentage never rounds a real spend down to nothing or a budget that is not spent up to a hundred", () => {
  assert.equal(pctLabel(0), "0%");
  assert.equal(pctLabel(0.0001), "under 1%");
  assert.equal(pctLabel(0.0255), "3%");
  assert.equal(pctLabel(0.804), "80%");
  assert.equal(pctLabel(0.996), "99%");
  assert.equal(pctLabel(1), "100%");
  assert.equal(pctLabel(1.08), "108%");
  assert.equal(pctLabel(null), "no limit");
});

test("dollars read as an estimate does: cents under $100, whole dollars above, and never a rounded zero", () => {
  assert.equal(fmtUsd(0), "$0.00");
  assert.equal(fmtUsd(0.004), "under $0.01");
  assert.equal(fmtUsd(0.15315), "$0.15");
  assert.equal(fmtUsd(12.5), "$12.50");
  assert.equal(fmtUsd(99.994), "$99.99");
  assert.equal(fmtUsd(1234.5), "$1,235");
  assert.equal(fmtUsd(Number.NaN), "$0.00");
  assert.equal(fmtUsd(-3), "$0.00");
});

test("a finished mission: 51,050 of 2,000,000 tokens, nothing over, seven seats ranked with their shares", () => {
  const s = summarizeCost(REAL);
  assert.equal(s.mission.used, 51050);
  assert.equal(s.mission.limit, 2_000_000);
  assert.equal(s.mission.remaining, 2_000_000 - 51050);
  assert.equal(s.mission.tone, "ok");
  assert.equal(pctLabel(s.mission.ratio), "3%");
  assert.equal(s.agents.length, 7, "the human is not a seat that spends");
  assert.deepEqual(s.agents.map((a) => a.agentId), ["tech-lead", "architect", "qa", "developer", "pm", "security", "explorer"], "most first, equal spends by name");
  assert.equal(s.agents[0]!.bar, 1, "the biggest row fills the bar");
  assert.ok(Math.abs(s.agents.reduce((n, a) => n + a.share, 0) - 1) < 1e-9, "shares add to a whole");
  assert.equal(Math.round(s.agents[0]!.share * 100), 28);
  assert.equal(s.spent, 51050);
  assert.equal(s.turns, 29);
  assert.deepEqual(s.over, []);
});

test("a seat's own budget is read off its own line, by its name", () => {
  const s = summarizeCost(REAL);
  const lead = s.agents.find((a) => a.agentId === "tech-lead")!;
  assert.deepEqual(lead.own && { used: lead.own.used, limit: lead.own.limit, tone: lead.own.tone }, { used: 14400, limit: 200_000, tone: "ok" });
  const noBudget = summarizeCost({ ...REAL, entries: REAL.entries!.filter((e) => !e.key.startsWith("agent:")) });
  assert.ok(noBudget.agents.every((a) => a.own === null), "a seat with no line has no own budget, and the page does not invent one");
});

test("near the mission budget is amber, nearly gone is red, spent is red whatever the numbers say", () => {
  const at = (used: number, limit: number, exceeded = false): ReturnType<typeof summarizeCost> =>
    summarizeCost({ entries: [entry(`mission:${GOAL}`, used, limit, { exceeded })], cost: { missionTokens: used, missionBudget: limit, perAgent: [], models: [] } });
  assert.equal(at(51050, 60000).mission.tone, "warn");
  assert.equal(at(57500, 60000).mission.tone, "bad");
  assert.equal(at(1000, 60000).mission.tone, "ok");
  assert.equal(at(1000, 60000, true).mission.tone, "bad");
  assert.equal(at(61000, 60000).mission.remaining, 0, "nothing left is zero, not negative");
});

test("a seat past its own limit stops work and is over; one close to its limit is only amber, because the host raises it", () => {
  const entries = [
    entry(`mission:${GOAL}`, 100_000, 2_000_000),
    entry(`agent:${GOAL}/qa`, 170_000, 200_000),
    entry(`agent:${GOAL}/pm`, 205_000, 200_000, { exceeded: true }),
    entry(`agent:${GOAL}/dev`, 10_000, 200_000),
  ];
  const perAgent = [
    { agentId: "qa", tokens: 170_000, activations: 9, perTurn: 18_000 },
    { agentId: "pm", tokens: 205_000, activations: 9, perTurn: 22_000 },
    { agentId: "dev", tokens: 10_000, activations: 1, perTurn: 10_000 },
  ];
  const s = summarizeCost({ entries, cost: { missionTokens: 385_000, missionBudget: 2_000_000, perAgent, models: [] } });
  assert.deepEqual(s.over.map((o) => o.who), ["pm"], "only the seat that is over is a banner");
  assert.equal(s.agents.find((a) => a.agentId === "qa")!.own!.tone, "warn", "the row says it is nearly used");
  assert.equal(s.agents.find((a) => a.agentId === "pm")!.own!.exceeded, true);
});

test("a thread, a task or an interrupt budget that is spent is routine: it shows in the table but is not an alert", () => {
  const entries = [
    entry(`mission:${GOAL}`, 100_000, 2_000_000),
    entry(`thread:${GOAL}/thread-A1`, 130_000, 100_000, { exceeded: true }),
    entry(`task:${GOAL}/task-B2`, 120_000, 100_000, { exceeded: true }),
    entry(`attention:${GOAL}/qa`, 210_000, 200_000, { exceeded: true }),
    entry("custom:thing", 2, 1, { exceeded: true }),
  ];
  const cost = { missionTokens: 100_000, missionBudget: 2_000_000, perAgent: [], models: [] };
  const s = summarizeCost({ entries, cost });
  assert.deepEqual(s.over, [], "the agents open a new thread; the host asks you only when nothing else can run");
  assert.deepEqual(s.details.filter((d) => d.state === "over").map((d) => d.group).sort(), ["attention", "other", "task", "thread"], "the table still says so");
  const spent = summarizeCost({ entries: [entry(`mission:${GOAL}`, 2_100_000, 2_000_000, { exceeded: true }), ...entries.slice(1)], cost });
  assert.deepEqual(spent.over.map((o) => o.group), ["mission"], "the mission's own budget is the one that stops everything");
});

test("each budget is named by what it limits and counted in its own unit", () => {
  const d = (key: string, kind: string, used: number, limit: number | null): ReturnType<typeof describeBudget> => describeBudget({ key, limitKind: kind, consumed: used, limit, exceeded: false });
  assert.deepEqual([d(`mission:${GOAL}`, "tokens", 51050, 2_000_000).label, d(`mission:${GOAL}`, "tokens", 51050, 2_000_000).unit], ["The whole mission", "tokens"]);
  const w = d(`mission:${GOAL}`, "wallclock_minutes", 12, 60);
  assert.deepEqual([w.unit, w.used, w.limit], ["minutes", "12 min", "60 min"]);
  assert.equal(w.label, "The whole mission (minutes)", "three limits on one mission must not read as three of the same");
  const ev = d(`mission:${GOAL}`, "events", 2400, 10000);
  assert.deepEqual([ev.unit, ev.used, ev.limit], ["events", "2,400", "10,000"]);
  assert.equal(ev.label, "The whole mission (events)");
  const turns = d(`agent:${GOAL}/qa`, "activations", 3, 10);
  assert.deepEqual([turns.unit, turns.used, turns.limit, turns.label, turns.who], ["turns", "3", "10", "qa (turns)", "qa"]);
  assert.equal(d(`agent:${GOAL}/qa`, "tokens", 1, 2).label, "qa");
  assert.equal(d(`agent:${GOAL}/qa`, "tokens", 1, 2).group, "agent");
  assert.equal(d(`attention:${GOAL}/qa`, "tokens", 1, 2).group, "attention");
  assert.equal(d(`thread:${GOAL}/thread-ABC123`, "tokens", 1, 2).label, "thread-ABC123", "two threads are never both 'thread budget'");
  assert.equal(d(`task:${GOAL}/task-XYZ`, "tokens", 1, 2).group, "task");
  assert.equal(d("custom:thing", "tokens", 1, 2).group, "other");
  assert.equal(d("custom:thing", "tokens", 1, 2).label, "custom:thing");
  const none = d(`agent:${GOAL}/qa`, "tokens", 5, null);
  assert.deepEqual([none.limit, none.ratio, none.state], ["no limit", null, "ok"]);
  assert.equal(d(`agent:${GOAL}/qa`, "tokens", 90, 100).state, "near");
  assert.equal(describeBudget({ key: `agent:${GOAL}/qa`, limitKind: "tokens", consumed: 10, limit: 100, exceeded: true }).state, "over");
});

test("the details come grouped (mission, seats, interrupts, threads, tasks), fullest first within a group", () => {
  const s = summarizeCost(REAL);
  assert.deepEqual(s.details.map((d) => d.group), ["mission", "agent", "agent", "agent", "agent", "agent", "agent", "agent", "attention", "thread", "task"]);
  const seats = s.details.filter((d) => d.group === "agent").map((d) => d.label);
  assert.equal(seats[0], "tech-lead");
  assert.equal(seats[seats.length - 1], "explorer");
});

test("models carry their shares and bars, the in and out split, and the replayed tokens are totalled apart", () => {
  const s = summarizeCost({
    entries: [],
    cost: {
      perAgent: [],
      missionTokens: 0,
      missionBudget: 0,
      models: [
        { model: "small", tokens: 1000, input: 700, output: 300, cacheRead: 5_000_000, turns: 10, agents: ["a"], share: 0.1, avgPerTurn: 100 },
        { model: "big", tokens: 9000, input: 6000, output: 3000, cacheRead: 1_000_000, turns: 30, agents: ["a", "b"], share: 0.9, avgPerTurn: 300 },
      ],
    },
  });
  assert.deepEqual(s.models.map((m) => m.model), ["big", "small"]);
  assert.equal(s.models[0]!.bar, 1);
  assert.ok(Math.abs(s.models[1]!.bar - 1000 / 9000) < 1e-9);
  assert.equal(s.cacheTotal, 6_000_000);
});

test("a payload with parts missing never throws and never invents a number", () => {
  for (const p of [null, undefined, {}, { entries: [] }, { cost: {} }, { entries: null as unknown as BudgetEntry[] }]) {
    const s = summarizeCost(p as BudgetsPayload);
    assert.equal(s.mission.used, 0);
    assert.equal(s.mission.ratio, null, "no limit given: no ratio, so no percentage and no tone");
    assert.equal(s.mission.remaining, null);
    assert.equal(s.mission.tone, "ok");
    assert.deepEqual(s.agents, []);
    assert.deepEqual(s.models, []);
    assert.equal(s.spent, 0);
  }
  const noText = summarizeCost({ cost: { perAgent: [{ agentId: "x", tokens: Number.NaN, activations: 1, perTurn: 0 }], missionTokens: Number.NaN, missionBudget: 10 } });
  assert.equal(noText.mission.used, 0, "NaN is not a spend");
  assert.equal(noText.agents[0]!.tokens, 0);
});

test("the spent budgets are named in a sentence, and never as raw keys or with a seat's name respelled", () => {
  const over = (key: string, kind = "tokens"): ReturnType<typeof describeBudget> => describeBudget({ key, limitKind: kind, consumed: 2, limit: 1, exceeded: true });
  assert.equal(overSentence([over(`mission:${GOAL}`)]), "Used up: the mission budget.");
  assert.equal(overSentence([over(`mission:${GOAL}`, "wallclock_minutes")]), "Used up: the mission's time limit.");
  assert.equal(overSentence([over(`mission:${GOAL}`, "events")]), "Used up: the mission's event limit.");
  assert.equal(overSentence([over(`agent:${GOAL}/qa`, "events")]), "Used up: qa's own budget.", "the unit is not part of a seat's name");
  assert.equal(overSentence([over(`mission:${GOAL}`), over(`agent:${GOAL}/qa`)]), "Used up: the mission budget and qa's own budget.");
  assert.equal(overSentence([over(`agent:${GOAL}/qa`), over(`agent:${GOAL}/pm`), over(`attention:${GOAL}/dev`)]), "Used up: qa's own budget, pm's own budget and dev's budget for waking other agents.", "a seat's id keeps its case");
  const many = ["a", "b", "c", "d", "e", "f"].map((n) => over(`agent:${GOAL}/${n}`));
  assert.match(overSentence(many), /and 2 more\.$/);
  assert.ok(!overSentence([over(`thread:${GOAL}/thread-X1`)]).includes(GOAL), "the goal id is not shown");
  assert.equal(overSentence([over(`thread:${GOAL}/thread-X1`)]), "Used up: the budget of thread-X1.");
});

test("model rows name the first three seats and count the rest", () => {
  assert.equal(agentList(["a", "b"]), "a, b");
  assert.equal(agentList(["a", "b", "c"]), "a, b, c");
  assert.equal(agentList(["a", "b", "c", "d", "e"]), "a, b, c and 2 more");
  assert.equal(agentList([]), "");
});

test("an idle Cost page says nothing was spent, and offers the mission's start only where there is one", () => {
  assert.equal(idleCopy("parked", false).start, true);
  assert.match(idleCopy("parked", false).body, /Start the mission/);
  assert.match(idleCopy("parked", true).body, /Continue it/);
  assert.equal(idleCopy("paused", false).start, true);
  for (const phase of ["running", "quiet", "stalled"]) {
    assert.equal(idleCopy(phase, true).start, false, phase);
    assert.match(idleCopy(phase, true).body, /No agent has finished a turn/);
  }
  assert.equal(idleCopy("done", true).start, false);
});

test("how old a reading is: just now, seconds, minutes", () => {
  assert.equal(readingAge(0), "just now");
  assert.equal(readingAge(3999), "just now");
  assert.equal(readingAge(4000), "4s ago");
  assert.equal(readingAge(59_000), "59s ago");
  assert.equal(readingAge(61_000), "1m ago");
  assert.equal(readingAge(600_000), "10m ago");
  assert.equal(readingAge(Number.NaN), "just now");
});

test("which price the estimate uses for a model follows the host's own order: yours, the list price, then the default rate", () => {
  assert.equal(priceBasis("stub-model", []), "default");
  assert.equal(priceBasis("stub-model", ["stub-model"]), "yours");
  assert.equal(priceBasis("claude-haiku-4-5", []), "list");
  assert.equal(priceBasis("claude-haiku-4-5", ["claude-haiku-4-5"]), "yours", "a price you wrote wins over the list");
  assert.equal(priceBasis("claude-haiku-4-5-20251001", []), "list", "a dated id is the same family");
  assert.equal(priceBasis("anthropic/claude-sonnet-5-5", []), "list", "so is one behind a provider prefix");
  assert.equal(priceBasis("Claude-Opus-5-5", []), "list", "the list is matched without regard to case");
  assert.equal(priceBasis("claude-haiku-4-50", []), "default", "a family matches only at a hyphen");
  assert.equal(priceBasis("claude-haiku-4", []), "default");
  assert.equal(priceBasis("CLAUDE-HAIKU-4-5", ["claude-haiku-4-5"]), "list", "your own entry matches the id exactly, as the host does");
  assert.equal(priceBasis("stub-model", null), "unknown", "when the host's settings could not be read, nothing is claimed");
  assert.equal(priceBasis("claude-haiku-4-5", null), "unknown");
});

test("the models the host can only price at its default rate are collected, and named in one sentence", () => {
  const row = (model: string, share: number): NonNullable<NonNullable<BudgetsPayload["cost"]>["models"]>[number] => ({ model, tokens: 100, input: 60, output: 40, cacheRead: 0, turns: 1, agents: ["a"], share, avgPerTurn: 100 });
  const mixed: BudgetsPayload = { entries: [], cost: { perAgent: [], models: [row("claude-haiku-4-5", 0.5), row("my-model", 0.25), row("local-llm", 0.25)] } };
  const s = summarizeCost(mixed, ["my-model"]);
  assert.deepEqual(s.models.map((m) => [m.model, m.basis]).sort(), [["claude-haiku-4-5", "list"], ["local-llm", "default"], ["my-model", "yours"]]);
  assert.deepEqual(s.defaulted, ["local-llm"]);
  assert.deepEqual(summarizeCost(mixed, null).defaulted, [], "unread settings: no claim that anything is at the default");
  assert.equal(defaultPriceNote([], 3), null, "every model has a price: nothing to say");
  assert.equal(defaultPriceNote(["local-llm"], 3), "Priced at the default rate of $3 per million tokens, because it has no list price and none of yours: local-llm.");
  assert.equal(defaultPriceNote(["a", "b"], 3), "Priced at the default rate of $3 per million tokens, because they have no list price and none of yours: a and b.");
  assert.equal(defaultPriceNote(["a", "b", "c"], null), "Priced at the default rate, because they have no list price and none of yours: a, b and c.");
  assert.match(defaultPriceNote(["a", "b", "c", "d", "e", "f"], 3)!, /: a, b, c, d and 2 more\.$/);
});

test("a date reads as a date, and anything else is left as it came", () => {
  assert.equal(longDate("2026-10-01"), "1 October 2026");
  assert.equal(longDate("2026-01-31"), "31 January 2026");
  assert.equal(longDate("2026-02-30"), "2 March 2026", "the calendar decides, not a regex");
  assert.equal(longDate("soon"), "soon");
  assert.equal(longDate(""), "");
});

test("the price list the page quotes is the one the host uses: same families, same date", () => {
  // The dashboard may not import the protocol package, so the two lists are compared by reading its source.
  const root = path.resolve(__dirname, "..", "..", "..");
  const src = fs.readFileSync(path.join(root, "packages", "protocol", "src", "pricing.ts"), "utf8");
  const table = /ANTHROPIC_LIST_PRICES[^=]*=\s*\{([\s\S]*?)\n\};/.exec(src);
  assert.ok(table, "the price table is where this test expects it");
  const families = [...table![1]!.matchAll(/"([a-z0-9.-]+)":\s*\{/g)].map((m) => m[1]);
  assert.ok(families.length >= 3, "the table was read");
  assert.deepEqual([...LIST_PRICED_FAMILIES].sort(), families.sort(), "a model added to or dropped from the list must change this page too");
  const asOf = /LIST_PRICES_AS_OF = "(\d{4}-\d{2}-\d{2})"/.exec(src);
  assert.ok(asOf, "the date is where this test expects it");
  assert.equal(LIST_PRICES_AS_OF, asOf![1], "the page must not quote an older price list than the host uses");
});

test("what the page says about auto-raise is what the host does by default", () => {
  const root = path.resolve(__dirname, "..", "..", "..");
  const src = fs.readFileSync(path.join(root, "packages", "config", "src", "index.ts"), "utf8");
  const factor = /auto_raise\?\.factor \?\? ([0-9.]+)/.exec(src);
  const multiple = /auto_raise\?\.max_multiple \?\? ([0-9.]+)/.exec(src);
  const on = /auto_raise\?\.enabled \?\? (true|false)/.exec(src);
  assert.ok(factor && multiple && on, "the defaults are where this test expects them");
  assert.equal(AUTO_RAISE_DEFAULT.factor, Number(factor![1]));
  assert.equal(AUTO_RAISE_DEFAULT.maxMultiple, Number(multiple![1]));
  assert.equal(on![1], "true", "the page says the host raises budgets for you by default");
  assert.equal(AUTO_RAISE_DEFAULT.factor, 2, "the page says 'doubling'");
});

test("the rules for what happens at a limit say the mission budget is never raised, and quote the raise ceiling for the rest", () => {
  const rules = budgetRules();
  assert.deepEqual(rules.map((r) => r.what), ["The mission budget", "An agent's own budget", "A conversation's budget"]);
  assert.match(rules[0]!.rule, /never raised on its own/);
  assert.match(rules[0]!.rule, /Needs you asks/);
  for (const r of rules.slice(1)) {
    assert.match(r.rule, /By default the host raises it for you, doubling it each time, up to 8 times what was set/);
    assert.match(r.rule, /auto_raise/);
  }
  assert.match(rules[2]!.rule, /open a new one/);
});
