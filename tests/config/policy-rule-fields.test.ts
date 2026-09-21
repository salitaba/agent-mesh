import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveConfig } from "../../packages/config/src/index";
import { testConfigYaml } from "../helpers";

const AGENTS = { agents: [{ id: "a", role: "r", interests: [] }], mayContact: { a: [] } };

function resolve(yaml: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-rulefields-"));
  const file = path.join(dir, "mesh.yaml");
  fs.writeFileSync(file, yaml, "utf8");
  try {
    return resolveConfig(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("config: a rule's when.to survives load and reaches the policy engine", () => {
  const cfg = resolve(testConfigYaml({
    ...AGENTS,
    rules: [{ id: "only-a", when: { actor: "a", to: "a" }, deny: { message_types: ["INFORM"] } }],
  }));
  assert.equal(cfg.policyRules.length, 1);
  assert.equal(cfg.policyRules[0]?.when.to, "a", "the clause the policy engine now reads must survive resolution");
});

test("config: deny.contact still loads — dropping the field was not a load change", () => {
  // `policies.rules` items are unconstrained by the JSON schema
  // (`rules: { type: "array" }`), so a key the TypeScript type no longer
  // declares still validates against the schema. This is the test that makes
  // deleting `deny.contact` from `RawPolicyRule` safe to claim: no existing
  // mesh.yaml can start failing to load over it — and it is also why the key
  // needs a warning rather than silence.
  const cfg = resolve(testConfigYaml({
    ...AGENTS,
    rules: [{ id: "no-contact", when: { actor: "a" }, deny: { contact: ["a"] } }],
  }));
  assert.equal(cfg.policyRules.length, 1);
  const warned = cfg.warnings.filter((w) => w.includes("deny.contact"));
  assert.equal(warned.length, 1, `expected one inert deny.contact warning, got ${JSON.stringify(cfg.warnings)}`);
  assert.match(warned[0] ?? "", /'no-contact'/, "the warning must name the rule to go and fix");
  assert.match(warned[0] ?? "", /policies\.communication/, "and must say where contact is actually decided");
});

test("config: a rule that sets no deny.contact draws no warning", () => {
  const cfg = resolve(testConfigYaml({
    ...AGENTS,
    rules: [{ id: "fine", when: { actor: "a" }, deny: { capabilities: ["git.commit"] } }],
  }));
  assert.deepEqual(cfg.warnings.filter((w) => w.includes("deny.contact")), []);
});

test("config: two inert deny.contact rules draw ONE warning naming both", () => {
  // Aggregated on purpose, and the single-offender test above cannot tell the
  // difference — it passes whether the warning is per-config or per-rule. Bury
  // a stale `deny.contact` in a fifty-rule config and the difference is fifty
  // warnings against one: the house style here is one warning per subsystem,
  // listing every offending id (`warnUngrantedApprovalGates` does the same for
  // `requires_approval`). So this pins the count AND the naming, which is what
  // an operator actually needs to go and fix both rules.
  const cfg = resolve(testConfigYaml({
    ...AGENTS,
    rules: [
      { id: "no-contact-one", when: { actor: "a" }, deny: { contact: ["a"] } },
      { id: "no-contact-two", when: { actor: "a" }, deny: { contact: ["a"] } },
    ],
  }));
  const warned = cfg.warnings.filter((w) => w.includes("deny.contact"));
  assert.equal(warned.length, 1, `expected one aggregated warning, got ${JSON.stringify(warned)}`);
  assert.match(warned[0] ?? "", /'no-contact-one'/);
  assert.match(warned[0] ?? "", /'no-contact-two'/, "both offending rules must be named, or the second is never fixed");
});

test("config: a when.to that names no seat is reported, and the three that resolve are not", () => {
  // `when.to` is the clause that scopes a rule to one seat, so a name no seat
  // answers to scopes it to nobody: the veto denies nothing and the message it
  // was written to stop goes through. Checked against the three ways the
  // communication matrix resolves a recipient, because accepting fewer would
  // tell an operator their working rule is broken.
  const warningsFor = (to: string) =>
    resolve(testConfigYaml({
      ...AGENTS,
      rules: [{ id: "scoped", when: { actor: "a", to }, deny: { message_types: ["INFORM"] } }],
    })).warnings.filter((w) => w.includes("when.to"));

  assert.deepEqual(warningsFor("a"), [], "an agent id resolves");
  assert.deepEqual(warningsFor("r"), [], "a role resolves — `may_contact: [r]` reaches this seat, so a rule may name it too");

  const typo = warningsFor("qa");
  assert.equal(typo.length, 1, `expected one warning for an unresolvable recipient, got ${JSON.stringify(typo)}`);
  assert.match(typo[0] ?? "", /'scoped'/, "the warning must name the rule to go and fix");

  // A hierarchical child's base id counts only when the child is configured,
  // which is why this is a warning and not the load error `when.actor` gets.
  const child = resolve(testConfigYaml({
    agents: [{ id: "qa#1", role: "qa", interests: [] }],
    mayContact: { "qa#1": [] },
    rules: [{ id: "scoped-child", when: { actor: "qa#1", to: "qa" }, deny: { message_types: ["INFORM"] } }],
  })).warnings.filter((w) => w.includes("when.to"));
  assert.deepEqual(child, [], "a base id reaches its configured child, so it must not be reported");
});

test("config: an absent when.to draws no warning, and a cleared one does", () => {
  const unscoped = resolve(testConfigYaml({
    ...AGENTS,
    rules: [{ id: "unscoped", when: { actor: "a" }, deny: { message_types: ["INFORM"] } }],
  })).warnings.filter((w) => w.includes("when.to"));
  assert.deepEqual(unscoped, [], "absent is a legitimate unscoped rule, not a mistake");

  const cleared = resolve(testConfigYaml({
    ...AGENTS,
    rules: [{ id: "cleared", when: { actor: "a", to: "" }, deny: { message_types: ["INFORM"] } }],
  })).warnings.filter((w) => w.includes("when.to"));
  assert.equal(cleared.length, 1, "a rule the engine reads as 'nobody' should say so at load");
});

test("config: idle_quiet_period_ms resolves and defaults to 30000", () => {
  // The key is inert — nothing reads it (see the doc comment on
  // `scheduling.idleQuietPeriodMs`) — so what is left to pin is the contract a
  // future consumer would inherit: the resolution and the default. The key is
  // spliced out of the helper's inline `timeouts:` block rather than added as a
  // second block, which YAML would reject as a duplicate key.
  const declared = testConfigYaml(AGENTS);
  const absent = declared.replace("idle_quiet_period_ms: 300, ", "");
  assert.notEqual(absent, declared, "the helper must still write the key this test is about");

  assert.equal(resolve(absent).scheduling.idleQuietPeriodMs, 30000, "an absent key resolves to the default");
  assert.equal(resolve(declared).scheduling.idleQuietPeriodMs, 300);
  assert.equal(
    resolve(declared.replace("idle_quiet_period_ms: 300", "idle_quiet_period_ms: 12345")).scheduling.idleQuietPeriodMs,
    12345,
    "a declared value is carried through, inert or not",
  );
});

const RULE = (extra: Record<string, unknown>, id = "scoped") => ({
  id,
  when: { actor: "a" },
  deny: { message_types: ["INFORM"] },
  ...extra,
});

test("config: a rule token outside the catalog is a load error, not a dead clause", () => {
  // Every one of these is compared by exact string equality against what the
  // mesh produces, so a token outside the catalog matches nothing: the veto
  // vetoes nothing. Errors rather than warnings because no seat can turn up
  // later holding `repository.writ` and no message can arrive with a type the
  // envelope schema would have rejected — there is no runtime-arrival escape
  // hatch, unlike `when.to`/`when.actor_role`.
  const cases: Array<[string, RegExp]> = [
    ["deny.capabilities", /denies unknown capability 'repository\.writ'/],
    ["when.capability", /unknown capability 'repository\.writ' in when\.capability/],
    ["deny.message_types", /denies unknown message type 'INFORMZ'/],
    ["when.message_type", /unknown message type 'INFORMZ' in when\.message_type/],
  ];
  for (const [clause, want] of cases) {
    const rule =
      clause === "deny.capabilities"
        ? RULE({ deny: { capabilities: ["repository.writ"] } })
        : clause === "when.capability"
          ? RULE({ when: { actor: "a", capability: "repository.writ" } })
          : clause === "deny.message_types"
            ? RULE({ deny: { message_types: ["INFORMZ"] } })
            : RULE({ when: { actor: "a", message_type: "INFORMZ" } });
    assert.throws(() => resolve(testConfigYaml({ ...AGENTS, rules: [rule] })), want, `${clause} must be reported`);
  }
});

test("config: a legal capability ALIAS in a rule is normalized, so the deny can actually fire", () => {
  // The engine compares a rule's token against the CANONICAL token a seat holds,
  // and `rules` was the one capability list config never normalized — so
  // `deny.capabilities: [code.write]`, a legal spelling, matched nothing. The
  // rule read as live and was dead. `CAPABILITY_TOKENS`' docstring states the
  // contract: "the aliases below are normalized first".
  const cfg = resolve(testConfigYaml({ ...AGENTS, rules: [RULE({ deny: { capabilities: ["code.write"] } })] }));
  assert.deepEqual(
    cfg.policyRules[0]?.deny?.capabilities,
    ["repository.write"],
    "the engine must be handed the canonical token, or the deny never fires",
  );
  assert.deepEqual(
    cfg.raw.policies?.rules?.[0]?.deny?.capabilities,
    ["code.write"],
    "and `raw` must still say what the operator typed",
  );
});

test("config: a rule scoped to a role no seat has is reported, and the runtime-arriving roles are not", () => {
  // Warned, not errored, for the reason the transition-gate check gives: a mesh
  // may be written for seats a larger mesh adds later, and both delegated
  // workers and the synthesized `human` seat arrive with roles config never saw.
  const warningsFor = (role: string) =>
    resolve(testConfigYaml({
      ...AGENTS,
      rules: [RULE({ when: { actor: "a", actor_role: role } })],
    })).warnings.filter((w) => w.includes("when.actor_role"));

  assert.deepEqual(warningsFor("r"), [], "a declared role is reachable");
  assert.deepEqual(warningsFor("human"), [], "the human seat is synthesized at runtime, so it must not be reported");
  assert.equal(warningsFor("developer").length, 1, "a role nobody plays scopes the rule to nobody");
});

test("config: a rule still carrying when.event is REFUSED, because removing it widens the rule", () => {
  // The only removal in this file that is an error rather than a warning. The
  // clause was never compared — it skipped the rule whenever no message was
  // under evaluation, so its real effect was to switch OFF capability and
  // authority denial. Removing it therefore makes such a rule deny MORE than it
  // did, and an error is the one severity that cannot widen a rule by accident:
  // a config that will not boot cannot silently start refusing work it used to
  // allow. (`requires`, next door, is the opposite case and gets a warning.)
  for (const event of ["artifact.published", ""]) {
    assert.throws(
      () => resolve(testConfigYaml({ ...AGENTS, rules: [RULE({ when: { actor: "a", event } })] })),
      /when\.event, which was removed/,
      `presence must be refused whatever the value: ${JSON.stringify(event)}`,
    );
  }
  // `null` too: the old guard tested truthiness, so `null` meant "no skip" while
  // `""` meant "skip" — two different behaviours, one field, no documentation.
  assert.throws(
    () => resolve(testConfigYaml({ ...AGENTS, rules: [RULE({ when: { actor: "a", event: null } })] })),
    /when\.event, which was removed/,
  );
});

test("config: a rule-level requires is reported as unread, and a rule without one is silent", () => {
  // Inert in both directions — no code reads it, so unlike `when.event` the
  // removal changes no behaviour, and it gets the warning `deny.contact` gets.
  const cfg = resolve(testConfigYaml({
    ...AGENTS,
    rules: [RULE({ requires: { approvals: [{ role: "tech-lead" }], evidence: ["qa.pass"] } })],
  }));
  assert.equal(cfg.policyRules.length, 1, "removing a TS field is not a load change — the rule still loads");
  const warned = cfg.warnings.filter((w) => w.includes("rule-level requires"));
  assert.equal(warned.length, 1, `expected one warning, got ${JSON.stringify(cfg.warnings)}`);
  assert.match(warned[0] ?? "", /'scoped'/, "the warning must name the rule to go and fix");
  assert.match(warned[0] ?? "", /policies\.transitions/, "and must say where gates actually live");

  const clean = resolve(testConfigYaml({ ...AGENTS, rules: [RULE({})] }));
  assert.deepEqual(clean.warnings.filter((w) => w.includes("rule-level requires")), []);
});

test("config: a hand-written rule with no when at all is a config load, not a TypeError", () => {
  // `policies.rules` has no `items` schema, so nothing upstream enforces the
  // required `when` — and the cross-field pass dereferenced `rule.when.actor`
  // directly, so a rule without one crashed resolution with a raw TypeError
  // rather than reporting anything. `matchRule` already tolerates it
  // (`rule.when ?? {}`), so the loader now does too.
  const cfg = resolve(testConfigYaml({
    ...AGENTS,
    rules: [{ id: "no-when", deny: { message_types: ["INFORM"] } }],
  }));
  assert.equal(cfg.policyRules.length, 1, "a rule with no `when` constrains every evaluation, and is carried through");
});
