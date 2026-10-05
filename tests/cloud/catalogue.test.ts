import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defaultTierOf, loadCatalogue, parseCatalogue } from "../../packages/cloud/src/index";
import { CATALOGUE } from "./support";

const clone = (): any => JSON.parse(JSON.stringify(CATALOGUE));

const problems = (raw: unknown): string => {
  try {
    parseCatalogue(raw, "plans.yaml");
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("the catalogue was accepted");
};

test("a catalogue is read into plans with every field, in the order the operator wrote them, and top-ups with theirs", () => {
  const c = parseCatalogue(CATALOGUE);
  assert.equal(c.currency, "USD");
  assert.deepEqual(
    c.plans().map((p) => p.id),
    ["team", "business", "yearly"],
  );
  assert.deepEqual(c.plan("team"), {
    id: "team",
    title: "Team",
    licencePlan: "team",
    priceMinor: 14_900,
    period: "month",
    includedUsageMicros: 20_000_000,
    workspaces: 1,
    providerPriceId: "price_team",
    tiers: ["fast", "balanced"],
  });
  assert.deepEqual(c.plan("business"), { id: "business", title: "Business", licencePlan: "business", priceMinor: 59_900, period: "month", includedUsageMicros: 100_000_000, workspaces: 3 });
  assert.equal(c.plan("yearly")!.period, "year");
  assert.equal(c.plan("nothing"), undefined);
  assert.deepEqual(c.topups, { optionsMinor: [1_000, 2_500, 10_000], minimumMinor: 500, maximumMinor: 100_000, usageMicrosPerMinor: 10_000 });
});

test("a plan may carry a summary, and may include no usage at all", () => {
  const raw = clone();
  raw.plans.team.summary = "For one team.";
  delete raw.plans.team.included_usage;
  const c = parseCatalogue(raw);
  assert.equal(c.plan("team")!.summary, "For one team.");
  assert.equal(c.plan("team")!.includedUsageMicros, 0);
});

test("included usage is an amount of currency units with up to six decimals, read exactly", () => {
  const read = (value: unknown): number => {
    const raw = clone();
    raw.plans.team.included_usage = value;
    return parseCatalogue(raw).plan("team")!.includedUsageMicros;
  };
  assert.equal(read(20), 20_000_000);
  assert.equal(read(0.5), 500_000);
  assert.equal(read("12.25"), 12_250_000);
  assert.equal(read(" 7 "), 7_000_000);
  assert.equal(read("0.000001"), 1);
  assert.equal(read("1234.567891"), 1_234_567_891);
  for (const bad of ["0.0000001", "-1", "1e3", "twenty", "", 1.2345678, null, true]) {
    assert.match(problems({ ...clone(), plans: { team: { ...clone().plans.team, included_usage: bad } } }), /included_usage must be an amount of currency units with at most six decimals/, String(bad));
  }
});

test("the currency is a three-letter code, which is upper-cased", () => {
  const raw = clone();
  raw.currency = " usd ";
  assert.equal(parseCatalogue(raw).currency, "USD");
  for (const bad of ["US", "USDX", "12$", "", undefined, 840]) {
    const r = clone();
    r.currency = bad;
    assert.match(problems(r), /plans\.yaml: currency must be a three-letter code such as USD/, String(bad));
  }
});

test("something that is not a mapping, or has no plans, is refused in one sentence", () => {
  for (const bad of [null, undefined, "plans", 3, ["plans"]]) assert.match(problems(bad), /^plans\.yaml: expected a mapping with currency, plans and topups$/, String(bad));
  const none = clone();
  none.plans = {};
  assert.match(problems(none), /plans must list at least one plan/);
  const notMap = clone();
  notMap.plans = ["team"];
  assert.match(problems(notMap), /plans must list at least one plan/);
});

test("each fault in a plan is named with the plan it is in, and every fault is reported at once", () => {
  const raw = clone();
  raw.plans = {
    "Bad Id": { ...clone().plans.team },
    broken: { title: " ", licence_plan: "platinum", price_minor: 9.5, period: "week", workspaces: 0, provider_price_id: "", tiers: [] },
    notamap: "yes",
  };
  const text = problems(raw);
  for (const expected of [
    "plans.yaml: plan 'Bad Id': an id is 1 to 32 lower-case letters, digits and hyphens",
    "plans.yaml: plans.broken.title is required",
    "plans.yaml: plans.broken.licence_plan must be one of community, team, business, enterprise (got \"platinum\")",
    "plans.yaml: plans.broken.period must be month or year",
    "plans.yaml: plans.broken.provider_price_id must be text",
    "plans.yaml: plans.broken.tiers must be a non-empty list of tier names",
    "plans.yaml: plans.broken.price_minor must be a whole number from 0 to 100000000 (got 9.5)",
    "plans.yaml: plans.broken.workspaces must be a whole number from 1 to 1000 (got 0)",
    "plans.yaml: plan 'notamap' must be a mapping",
  ]) {
    assert.ok(text.split("\n").includes(expected), `missing: ${expected}\n${text}`);
  }
});

test("plan ids are short lower-case labels, and a price and a workspace count stay inside their ranges", () => {
  const withPlan = (id: string, over: Record<string, unknown> = {}): any => ({ ...clone(), plans: { [id]: { ...clone().plans.team, ...over } } });
  assert.doesNotThrow(() => parseCatalogue(withPlan("a")));
  assert.doesNotThrow(() => parseCatalogue(withPlan("a".repeat(32))));
  assert.doesNotThrow(() => parseCatalogue(withPlan("team-2026")));
  for (const bad of ["a".repeat(33), "-team", "Team", "team_x", "team.x", ""]) assert.match(problems(withPlan(bad)), /an id is 1 to 32 lower-case letters, digits and hyphens/, bad);
  assert.doesNotThrow(() => parseCatalogue(withPlan("p", { price_minor: 0 })));
  assert.doesNotThrow(() => parseCatalogue(withPlan("p", { price_minor: 100_000_000 })));
  for (const bad of [-1, 100_000_001, 1.5, "100", null]) assert.match(problems(withPlan("p", { price_minor: bad })), /price_minor must be a whole number from 0 to 100000000/, String(bad));
  assert.doesNotThrow(() => parseCatalogue(withPlan("p", { workspaces: 1_000 })));
  for (const bad of [0, 1_001, 2.5, "3"]) assert.match(problems(withPlan("p", { workspaces: bad })), /workspaces must be a whole number from 1 to 1000/, String(bad));
});

test("the tiers a plan may use are a non-empty list of names", () => {
  const withTiers = (tiers: unknown): any => ({ ...clone(), plans: { team: { ...clone().plans.team, tiers } } });
  assert.deepEqual(parseCatalogue(withTiers(["best"])).plan("team")!.tiers, ["best"]);
  for (const bad of [[], "fast", [""], ["fast", 3], {}]) assert.match(problems(withTiers(bad)), /tiers must be a non-empty list of tier names/, JSON.stringify(bad));
});

test("top-ups need amounts to offer, bounds that agree, and a rate that buys something", () => {
  const withTopups = (over: Record<string, unknown>): any => ({ ...clone(), topups: { ...clone().topups, ...over } });
  const missing = clone();
  delete missing.topups;
  assert.match(problems(missing), /topups must be a mapping with options, minimum_minor, maximum_minor and usage_per_unit/);
  for (const bad of [[], "1000", [0], [1.5], [1000, "2000"], undefined]) assert.match(problems(withTopups({ options_minor: bad })), /topups\.options_minor must be a list of amounts in minor units/, JSON.stringify(bad));
  assert.match(problems(withTopups({ minimum_minor: 0 })), /topups\.minimum_minor must be a whole number from 1 to 100000000/);
  assert.match(problems(withTopups({ maximum_minor: 0 })), /topups\.maximum_minor must be a whole number from 1 to 1000000000/);
  assert.match(problems(withTopups({ minimum_minor: 600, maximum_minor: 500 })), /topups\.maximum_minor must not be below topups\.minimum_minor/);
  assert.doesNotThrow(() => parseCatalogue(withTopups({ minimum_minor: 500, maximum_minor: 500 })), "a single amount is a range of one");
  for (const bad of [0, 1.5, "10000", undefined]) assert.match(problems(withTopups({ usage_micros_per_minor: bad })), /topups\.usage_micros_per_minor must be a whole number: the model usage, in micro-units of the gateway's currency, that one minor unit of the billing currency buys/, String(bad));
});

test("a catalogue is loaded from a YAML file, and a file that cannot be read or is not YAML says which", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalogue-"));
  try {
    const good = path.join(dir, "plans.yaml");
    fs.writeFileSync(
      good,
      `currency: USD
plans:
  team:
    title: Team
    licence_plan: team
    price_minor: 14900
    period: month
    included_usage: 20
    workspaces: 1
topups:
  options_minor: [1000, 5000]
  minimum_minor: 500
  maximum_minor: 50000
  usage_micros_per_minor: 10000
`,
    );
    const c = loadCatalogue(good);
    assert.equal(c.plan("team")!.includedUsageMicros, 20_000_000);
    assert.deepEqual(c.topups.optionsMinor, [1_000, 5_000]);

    assert.throws(() => loadCatalogue(path.join(dir, "missing.yaml")), /^Error: cannot read the plan catalogue .*missing\.yaml: ENOENT/);
    const broken = path.join(dir, "broken.yaml");
    fs.writeFileSync(broken, "plans: [unclosed");
    assert.throws(() => loadCatalogue(broken), /^Error: the plan catalogue .*broken\.yaml is not valid YAML: /);
    const wrong = path.join(dir, "wrong.yaml");
    fs.writeFileSync(wrong, "currency: USD\n");
    assert.throws(() => loadCatalogue(wrong), (err: Error) => err.message.startsWith(`${wrong}: `) && /plans must list at least one plan/.test(err.message));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the example catalogue that ships is valid and describes two plans and the top-ups beside them", () => {
  const c = loadCatalogue(path.join(__dirname, "..", "..", "..", "examples", "cloud", "plans.yaml"));
  assert.equal(c.currency, "USD");
  assert.deepEqual(
    c.plans().map((p) => [p.id, p.licencePlan, p.priceMinor, p.period, p.includedUsageMicros, p.workspaces]),
    [
      ["team", "team", 14_900, "month", 20_000_000, 1],
      ["business", "business", 59_900, "month", 100_000_000, 3],
    ],
  );
  assert.deepEqual(c.plan("team")!.tiers, ["fast", "balanced"]);
  assert.equal(c.plan("business")!.tiers, undefined);
  assert.deepEqual(c.topups, { optionsMinor: [1_000, 2_500, 10_000], minimumMinor: 500, maximumMinor: 100_000, usageMicrosPerMinor: 10_000 });
  assert.ok(c.plans().every((p) => /REPLACE/.test(p.providerPriceId ?? "")), "the provider's price ids are placeholders for the operator to replace");
});

test("a plan may name the tier its workspaces' teams use unless a seat names another, and it must be one the plan allows", () => {
  const raw = clone();
  raw.plans.team.default_tier = "fast";
  assert.equal(parseCatalogue(raw).plan("team")!.defaultTier, "fast");
  raw.plans.business.default_tier = "best";
  assert.equal(parseCatalogue(raw).plan("business")!.defaultTier, "best", "a plan that lists no tiers allows any, so any name will do");
  raw.plans.team.default_tier = "best";
  assert.match(problems(raw), /plans\.team\.default_tier 'best' is not one of the plan's tiers \(fast, balanced\)/);
  raw.plans.team.default_tier = "";
  assert.match(problems(raw), /plans\.team\.default_tier must be a tier name/);
  raw.plans.team.default_tier = 7;
  assert.match(problems(raw), /plans\.team\.default_tier must be a tier name/);
});

test("the tier a host is told to default to is the plan's own, else balanced when the plan lists it, else the first it lists, else none and the host's own stands", () => {
  const plan = (extra: Record<string, unknown>) => {
    const raw = clone();
    raw.plans.team = { ...raw.plans.team, ...extra };
    return parseCatalogue(raw).plan("team")!;
  };
  assert.equal(defaultTierOf(plan({ tiers: ["fast", "balanced"], default_tier: "fast" })), "fast");
  assert.equal(defaultTierOf(plan({ tiers: ["fast", "balanced"] })), "balanced");
  assert.equal(defaultTierOf(plan({ tiers: ["fast", "best"] })), "fast", "a key that may not use balanced is not told to");
  assert.equal(defaultTierOf(plan({ tiers: ["best"] })), "best");
  const all = clone();
  delete all.plans.team.tiers;
  assert.equal(defaultTierOf(parseCatalogue(all).plan("team")!), undefined);
  all.plans.team.default_tier = "best";
  assert.equal(defaultTierOf(parseCatalogue(all).plan("team")!), "best");
});

test("the example plans file names a default tier its plan allows", () => {
  const c = loadCatalogue(path.join(__dirname, "..", "..", "..", "examples", "cloud", "plans.yaml"));
  assert.equal(c.plan("team")!.defaultTier, "balanced");
  assert.ok(c.plan("team")!.tiers!.includes("balanced"));
});
