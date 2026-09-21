import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";

/**
 * `when.to` was declared on `RawPolicyRule` and read by nothing, so a rule
 * written to bind one recipient bound every recipient: a recipient-scoped
 * denial silently became a mesh-wide one. These pin both halves — the named
 * recipient is bound, and nobody else is.
 */
function meshWith(rule: unknown) {
  return makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write", "git.commit"], interests: [] },
      { id: "qa", role: "qa", capabilities: ["test.write"], interests: [] },
      { id: "lead", role: "tech-lead", capabilities: ["code.review"], interests: [] },
    ],
    mayContact: { dev: ["qa", "lead"], qa: ["dev"], lead: ["dev"] },
    rules: [rule],
  });
}

const NO_INFORM_TO_QA = {
  id: "no-qa-inform",
  when: { actor: "dev", to: "qa", message_type: "INFORM" },
  deny: { message_types: ["INFORM"] },
};

test("policy: a when.to rule fires for the recipient it names", async () => {
  const m = await meshWith(NO_INFORM_TO_QA);
  const named = await m.supervisor.sendMessage({ from: "dev", to: ["qa"], type: "INFORM", payload: {}, newThread: { subject: "for qa" } });
  assert.equal(named.accepted, false, "the rule names qa, so a message addressed to qa is denied");
  assert.match(named.reason ?? "", /denied by policy rule 'no-qa-inform'/);
  await m.cleanup();
});

test("policy: a when.to rule does not fire for a different recipient", async () => {
  const m = await meshWith(NO_INFORM_TO_QA);
  const other = await m.supervisor.sendMessage({ from: "dev", to: ["lead"], type: "INFORM", payload: {}, newThread: { subject: "for lead" } });
  assert.equal(other.accepted, true, "the rule names qa; a message to lead must not be denied by it");
  await m.cleanup();
});

test("policy: a when.to rule fires when its recipient is one of several", async () => {
  // The rule is a statement about addressing, not about being the ONLY
  // recipient: an address list that reaches qa satisfies it.
  const m = await meshWith(NO_INFORM_TO_QA);
  const both = await m.supervisor.sendMessage({ from: "dev", to: ["qa", "lead"], type: "INFORM", payload: {}, newThread: { subject: "for both" } });
  assert.equal(both.accepted, false, "an address list containing qa satisfies when.to: qa");
  await m.cleanup();
});

test("policy: when.to reaches a seat by its role, the way the matrix does", async () => {
  // The id and the role differ on purpose. The communication matrix resolves a
  // recipient by either (`may_contact: [qa]` reaches the seat that PLAYS qa),
  // so a rule naming `qa` must reach that seat too.
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "verifier", role: "qa", capabilities: ["test.write"], interests: [] },
    ],
    mayContact: { dev: ["verifier"], verifier: ["dev"] },
    rules: [{ id: "no-qa-inform", when: { actor: "dev", to: "qa" }, deny: { message_types: ["INFORM"] } }],
  });
  const byRole = await m.supervisor.sendMessage({ from: "dev", to: ["verifier"], type: "INFORM", payload: {}, newThread: { subject: "x" } });
  assert.equal(byRole.accepted, false, "`when.to: qa` must reach the seat whose role is qa");
  assert.match(byRole.reason ?? "", /denied by policy rule 'no-qa-inform'/);
  await m.cleanup();
});

test("policy: a when.to rule never reaches a capability check", async () => {
  // A capability check addresses nobody, so a rule naming a recipient cannot be
  // satisfied by one. Failing closed here is the point: the rule is a
  // statement about messaging, and matching it wherever there are no
  // recipients to test is what made it apply everywhere.
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write", "git.commit"], interests: [] },
      { id: "qa", role: "qa", capabilities: ["test.write"], interests: [] },
    ],
    mayContact: { dev: ["qa"], qa: ["dev"] },
    rules: [{ id: "recipient-scoped", when: { to: "qa" }, deny: { capabilities: ["git.commit"] } }],
  });
  const ctx = { config: m.config, projections: m.kernel.state };
  const verdict = m.supervisor.deps.policy.evaluateCapability("dev", "git.commit", ctx);
  assert.equal(verdict.decision, "ALLOW", "a recipient-scoped rule must not deny a capability check");
  await m.cleanup();
});

test("policy: a DECLARED but empty when.to binds nobody, where an absent one still binds everyone", async () => {
  // The two cases have to stay apart. `when.to` absent is an unscoped rule and
  // must go on applying mesh-wide — that is what every rule written before `to`
  // existed relies on. A `to` the operator declared and then emptied is not
  // that: they named a recipient scope and cleared it, and reading the empty
  // value as "unscoped" inverted the pair, since a WRONG recipient already
  // bound nobody. Clearing a field in the designer (`Designer.tsx` writes `""`)
  // would respawn a one-seat rule as a mesh-wide one, off-messaging checks
  // included — the exact widening this file exists to close.
  const ctxOf = (m: Awaited<ReturnType<typeof makeMesh>>) => ({ config: m.config, projections: m.kernel.state });

  for (const declared of ["", null]) {
    const label = JSON.stringify(declared);
    const m = await meshWith({
      id: "emptied-to",
      when: { actor: "dev", to: declared },
      deny: { capabilities: ["git.commit"] },
    });
    const verdict = m.supervisor.deps.policy.evaluateCapability("dev", "git.commit", ctxOf(m));
    assert.equal(verdict.decision, "ALLOW", `a when.to of ${label} names no seat, so it must deny nobody — not everybody`);
    const sent = await m.supervisor.sendMessage({ from: "dev", to: ["qa"], type: "INFORM", payload: {}, newThread: { subject: "x" } });
    assert.equal(sent.accepted, true, `a when.to of ${label} must not deny a message addressed elsewhere`);
    await m.cleanup();
  }

  const unscoped = await meshWith({ id: "no-to", when: { actor: "dev" }, deny: { capabilities: ["git.commit"] } });
  assert.equal(
    unscoped.supervisor.deps.policy.evaluateCapability("dev", "git.commit", ctxOf(unscoped)).decision,
    "DENY",
    "an ABSENT when.to is an unscoped rule and must keep applying mesh-wide",
  );
  await unscoped.cleanup();
});
