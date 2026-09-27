import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkApprovals,
  parseGateAlternatives,
  parseGateRequirements,
  parseGateTokens,
} from "../../packages/core/src/projections";
import { validateTransitionGateActors, validateTransitionGateSyntax, resolveConfig } from "../../packages/config/src/index";
import { validateTransitionGates } from "../../packages/policy-engine/src/index";
import { approvalKey, createInitialState, type Projections } from "../../packages/core/src/state";
import type { Artifact, ApprovalRecord } from "../../packages/protocol/src/index";
import { makeMesh } from "../helpers";

/**
 * A gate requirement may name alternatives: `tech-lead.approve|architect.approve`
 * is ONE requirement any listed seat can meet, so a gate whose single holder is
 * the mesh's bottleneck can name a pool instead of a person. The live
 * skill-panel mission is why: one seat held both the coordination inbox (42% of
 * all messages) and the `patch.approve`/`patch.merge` gates, and every patch
 * queued behind it.
 *
 * Entries in `requires` stay ANDed; only alternatives WITHIN one entry are ORed.
 * Plain tokens must behave exactly as they did, refusal strings included.
 */

let seq = 0;

function approval(over: Partial<ApprovalRecord> & { kind: ApprovalRecord["kind"] }): ApprovalRecord {
  seq++;
  return {
    id: over.id ?? `apr-${seq}`,
    goalId: over.goalId ?? "goal-1",
    subject: over.subject ?? "artifact:art-1",
    actorId: over.actorId ?? "qa",
    actorRole: over.actorRole ?? "",
    evidenceEventId: `evt-${seq}`,
    recordedAt: over.recordedAt ?? `2026-03-01T01:${String(seq % 60).padStart(2, "0")}:00.000Z`,
    ...over,
  } as ApprovalRecord;
}

function seed(state: Projections, rec: ApprovalRecord): void {
  const key = approvalKey(rec.subject, rec.kind);
  const list = state.approvals.get(key) ?? [];
  list.push(rec);
  state.approvals.set(key, list);
}

/** State holding the given records, in the order written. */
function stateWith(...records: ApprovalRecord[]): Projections {
  const state = createInitialState();
  for (const r of records) seed(state, r);
  return state;
}

/* ---------------- parsing ---------------- */

test("a plain token parses to one alternative; a `|` entry to several", () => {
  assert.deepEqual(parseGateTokens(["tech-lead.approve"]), [{ actor: "tech-lead", kind: "approve" }]);
  assert.deepEqual(parseGateTokens(["tech-lead.approve|architect.approve"]), [
    { actor: "tech-lead", kind: "approve" },
    { actor: "architect", kind: "approve" },
  ]);
  assert.deepEqual(parseGateRequirements(["tech-lead.approve|architect.approve", "qa.pass"]), [
    [
      { actor: "tech-lead", kind: "approve" },
      { actor: "architect", kind: "approve" },
    ],
    [{ actor: "qa", kind: "pass" }],
  ]);
});

test("the LAST dot splits, so a dotted actor id survives", () => {
  assert.deepEqual(parseGateAlternatives("mesh.qa.pass"), [{ actor: "mesh.qa", kind: "pass" }]);
});

test("an alternative with no dot is dropped, and a token of nothing but those is skipped", () => {
  // The pre-existing plain-token behaviour: a token that is not
  // `<actor>.<kind>` has always been skipped rather than made unsatisfiable.
  assert.deepEqual(parseGateTokens(["techlead"]), []);
  assert.deepEqual(parseGateAlternatives("techlead.approve|nope"), [{ actor: "techlead", kind: "approve" }]);
  assert.deepEqual(parseGateTokens(["nope|also-nope"]), []);
});

/* ---------------- checkApprovals: the OR within a requirement ---------------- */

const ALT = ["tech-lead.approve|architect.approve"];

test("an alternative gate is satisfied by EITHER seat alone", () => {
  const byLead = stateWith(approval({ kind: "approve", actorId: "tech-lead", subject: "artifact:art-1" }));
  assert.deepEqual(checkApprovals(byLead, ALT), { ok: true, missing: [] });

  const byArchitect = stateWith(approval({ kind: "approve", actorId: "architect", subject: "artifact:art-1" }));
  assert.deepEqual(checkApprovals(byArchitect, ALT), { ok: true, missing: [] });
});

test("an alternative gate is unsatisfied by neither, and names both alternatives", () => {
  const res = checkApprovals(createInitialState(), ALT);
  assert.equal(res.ok, false);
  assert.deepEqual(res.missing, ["tech-lead.approve|architect.approve"]);
});

test("an alternative gate is satisfied — not double-counted — when both seats act", () => {
  const both = stateWith(
    approval({ kind: "approve", actorId: "tech-lead", subject: "artifact:art-1" }),
    approval({ kind: "approve", actorId: "architect", subject: "artifact:art-1" }),
  );
  assert.deepEqual(checkApprovals(both, ALT), { ok: true, missing: [] });
});

test("two entries stay ANDed when one of them carries alternatives", () => {
  const onlyAlternatives = stateWith(approval({ kind: "approve", actorId: "architect", subject: "artifact:art-1" }));
  const res = checkApprovals(onlyAlternatives, ["tech-lead.approve|architect.approve", "qa.pass"]);
  assert.equal(res.ok, false, "the second entry is a separate requirement, not another alternative");
  assert.deepEqual(res.missing, ["qa.pass"]);

  const both = stateWith(
    approval({ kind: "approve", actorId: "architect", subject: "artifact:art-1" }),
    approval({ kind: "pass", actorId: "qa", subject: "artifact:art-1" }),
  );
  assert.deepEqual(checkApprovals(both, ["tech-lead.approve|architect.approve", "qa.pass"]), { ok: true, missing: [] });
});

test("an alternative matches a ROLE two seats hold, when either acts", () => {
  // The pool case: `reviewer` is a role, not a seat, so the gate follows the
  // mesh as it grows rather than pinning one id.
  const role = ["reviewer.approve|qa.pass"];
  const first = stateWith(approval({ kind: "approve", actorId: "rev-1", actorRole: "reviewer", subject: "artifact:art-1" }));
  assert.deepEqual(checkApprovals(first, role), { ok: true, missing: [] });

  const second = stateWith(approval({ kind: "pass", actorId: "qa-2", actorRole: "qa", subject: "artifact:art-1" }));
  assert.deepEqual(checkApprovals(second, role), { ok: true, missing: [] });

  const third = stateWith(approval({ kind: "approve", actorId: "other", actorRole: "reviewer", subject: "artifact:art-1" }));
  assert.deepEqual(checkApprovals(third, role), { ok: true, missing: [] });
});

test("the kind-compatibility table applies per alternative: approve is met by a pass", () => {
  const st = stateWith(approval({ kind: "pass", actorId: "architect", subject: "artifact:art-1" }));
  assert.deepEqual(checkApprovals(st, ALT), { ok: true, missing: [] });

  // ... and the converse does not hold: a bare `approve` never answers `pass`.
  const bare = stateWith(approval({ kind: "approve", actorId: "architect", subject: "artifact:art-1" }));
  assert.equal(checkApprovals(bare, ["architect.pass|tech-lead.pass"]).ok, false);
});

test("alternatives respect the artifact scoping an entry is checked with", () => {
  const other = stateWith(approval({ kind: "approve", actorId: "architect", artifactId: "art-2" }));
  assert.equal(checkApprovals(other, ALT, "art-1").ok, false);
  assert.equal(checkApprovals(other, ALT).ok, true, "unscoped gates accept a record at any artifact");
});

/* ---------------- block-supersession under alternatives ---------------- */

test("plain tokens: the missing string and the superseded suffix are byte-identical", () => {
  assert.deepEqual(checkApprovals(createInitialState(), ["dev.approve"]).missing, ["dev.approve"]);

  const signedThenBlocked = stateWith(
    approval({ kind: "approve", actorId: "dev", artifactId: "art-1", recordedAt: "2026-03-01T01:00:00.000Z" }),
    approval({ kind: "block", actorId: "dev", artifactId: "art-1", recordedAt: "2026-03-01T02:00:00.000Z" }),
  );
  assert.deepEqual(checkApprovals(signedThenBlocked, ["dev.approve"], "art-1").missing, [
    "dev.approve (superseded by dev.block)",
  ]);

  // A block with nothing signed under it reports the bare token, as before.
  const bareBlock = stateWith(approval({ kind: "block", actorId: "dev", artifactId: "art-1" }));
  assert.deepEqual(checkApprovals(bareBlock, ["dev.approve"], "art-1").missing, ["dev.approve"]);
});

test("a block against ONE alternative does not sink the others", () => {
  const st = stateWith(
    approval({ kind: "approve", actorId: "tech-lead", artifactId: "art-1", recordedAt: "2026-03-01T01:00:00.000Z" }),
    approval({ kind: "block", actorId: "tech-lead", artifactId: "art-1", recordedAt: "2026-03-01T02:00:00.000Z" }),
    approval({ kind: "approve", actorId: "architect", artifactId: "art-1", recordedAt: "2026-03-01T03:00:00.000Z" }),
  );
  assert.deepEqual(
    checkApprovals(st, ALT, "art-1"),
    { ok: true, missing: [] },
    "tech-lead withdrew, but architect's alternative still stands",
  );
});

test("a block against one alternative does not sink the others, in either direction", () => {
  const st = stateWith(
    approval({ kind: "approve", actorId: "tech-lead", artifactId: "art-1", recordedAt: "2026-03-01T01:00:00.000Z" }),
    approval({ kind: "approve", actorId: "architect", artifactId: "art-1", recordedAt: "2026-03-01T02:00:00.000Z" }),
    approval({ kind: "block", actorId: "architect", artifactId: "art-1", recordedAt: "2026-03-01T03:00:00.000Z" }),
  );
  assert.deepEqual(
    checkApprovals(st, ALT, "art-1"),
    { ok: true, missing: [] },
    "architect withdrew, but tech-lead's alternative still stands",
  );
});

test("when no alternative stands, each blocked one says so and the others are named plainly", () => {
  const blockedLead = stateWith(
    approval({ kind: "approve", actorId: "tech-lead", artifactId: "art-1", recordedAt: "2026-03-01T01:00:00.000Z" }),
    approval({ kind: "block", actorId: "tech-lead", artifactId: "art-1", recordedAt: "2026-03-01T02:00:00.000Z" }),
  );
  assert.deepEqual(checkApprovals(blockedLead, ALT, "art-1").missing, [
    "tech-lead.approve (superseded by tech-lead.block)|architect.approve",
  ]);

  const blockedArchitect = stateWith(
    approval({ kind: "approve", actorId: "architect", artifactId: "art-1", recordedAt: "2026-03-01T01:00:00.000Z" }),
    approval({ kind: "block", actorId: "architect", artifactId: "art-1", recordedAt: "2026-03-01T02:00:00.000Z" }),
  );
  assert.deepEqual(checkApprovals(blockedArchitect, ALT, "art-1").missing, [
    "tech-lead.approve|architect.approve (superseded by architect.block)",
  ]);

  // A block by an actor that satisfied nothing anyway blocks only its own
  // alternative — the other is reported as a plain absence, not as blocked.
  const onlyBlock = stateWith(approval({ kind: "block", actorId: "tech-lead", artifactId: "art-1" }));
  assert.deepEqual(checkApprovals(onlyBlock, ALT, "art-1").missing, ["tech-lead.approve|architect.approve"]);
});

/* ---------------- config validation ---------------- */

function meshYaml(agents: string, transitions: string): string {
  return `version: 1
mesh:
  id: alttest
  goal: |
    Test.
  workspace: { path: ./workspace }
  runtime: { default: stub }
policies:
  transitions:
${transitions}
agents:
${agents}
`;
}

const TWO_SEATS = `  lead:
    role: tech-lead
    capabilities: [git.merge]
    authority: [implementation.approve]
  architect:
    role: architect
    capabilities: [review.design]
    authority: [implementation.approve, architecture.approve]
`;

function load(transitions: string, agents = TWO_SEATS) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-alt-test-"));
  fs.writeFileSync(path.join(dir, "mesh.yaml"), meshYaml(agents, transitions), "utf8");
  try {
    return resolveConfig(path.join(dir, "mesh.yaml"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const bad of ["|architect.approve", "tech-lead.approve|", "x.|y.z"]) {
  test(`a malformed alternative is refused at load: '${bad}'`, () => {
    // Quoted: a leading `|` is also a YAML block-scalar indicator, so the raw
    // text only reaches the loader at all when it is quoted. The validator
    // still has to name it, since a config may be built in code (the Designer
    // echoes a model, not text).
    assert.throws(
      () => load(`    patch.merge: { requires: ["${bad}"] }`),
      (err: Error) => {
        assert.match(err.message, /is malformed/);
        assert.ok(err.message.includes(bad), `the refusal names the token an operator has to fix: ${err.message}`);
        return true;
      },
    );
  });
}

test("a valid alternative passes validation", () => {
  assert.doesNotThrow(() => load(`    patch.merge: { requires: [tech-lead.approve|architect.approve, qa.pass] }`));
});

test("validateTransitionGateSyntax reports the token, not the alternative alone", () => {
  const errors = validateTransitionGateSyntax({ "patch.merge": { requires: ["ghost.approve|tech-lead.approve|"] } });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /'ghost\.approve\|tech-lead\.approve\|'/);
  assert.deepEqual(validateTransitionGateSyntax({ "patch.merge": { requires: ["a.b|c.d"] } }), []);
  assert.deepEqual(validateTransitionGateSyntax({ "patch.merge": { requires: ["a.b"] } }), [], "plain tokens are untouched");
});

test("an unreachable alternative is not reported when another in the pool resolves", () => {
  // `ghost` names nobody, but the pool can be met by tech-lead, so the gate is
  // not a deadlock and must not be flagged as one.
  assert.deepEqual(
    validateTransitionGateActors(
      [{ id: "lead", role: "tech-lead" }] as never,
      { "patch.merge": { requires: ["ghost.approve|tech-lead.approve"] } },
    ),
    [],
  );
});

test("an alternative pool where NO name resolves is still reported", () => {
  const errors = validateTransitionGateActors(
    [{ id: "lead", role: "tech-lead" }] as never,
    { "patch.merge": { requires: ["ghost.approve|phantom.approve"] } },
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /can never be satisfied/);
});

test("the policy-engine satisfiability check treats the pool as one requirement", () => {
  const agents = { qa: { role: "qa", authority: [], capabilities: ["test.execute"] } };
  // `ghost.approve` alone would be flagged; in a pool with a reachable
  // `qa.pass` the gate can still be met, so it must not be.
  assert.deepEqual(validateTransitionGates({ "patch.merge": { requires: ["ghost.approve|qa.pass"] } }, agents), []);
  assert.equal(validateTransitionGates({ "patch.merge": { requires: ["ghost.approve"] } }, agents).length, 1);
});

/* ---------------- through the policy engine, not just the helper ---------------- */

test("isSatisfied and evaluateTransition name the alternatives in their refusal", async () => {
  // The helper is one code path, but the message an operator actually reads is
  // built by the two callers that matter: `isSatisfied` (release evidence) and
  // `evaluateTransition` (the gate on a state change).
  const m = await makeMesh({
    agents: [
      { id: "lead", role: "tech-lead", capabilities: ["repository.write"], authority: ["release.accept"], interests: [] },
      { id: "architect", role: "architect", capabilities: ["review.design"], interests: [] },
    ],
    mayContact: { lead: ["architect"], architect: ["lead"] },
    transitions: { "release.accepted": ["qa.pass|security.pass"] },
  });
  try {
    const ctx = { config: m.config, projections: m.kernel.state };
    assert.deepEqual(m.supervisor.deps.policy.isSatisfied("release.accepted", ctx).missing, ["qa.pass|security.pass"]);

    const plan = {
      id: "rel-1",
      name: "release plan",
      type: "ReleasePlan",
      goalId: "goal-1",
      owner: "lead",
      version: 1,
      status: "IMPLEMENTED",
    } as unknown as Artifact;
    const verdict = m.supervisor.deps.policy.evaluateTransition(plan, "ACCEPTED", "lead", ctx);
    assert.equal(verdict.decision, "DENY");
    assert.match(verdict.reason ?? "", /missing: qa\.pass\|security\.pass/, verdict.reason);
  } finally {
    await m.cleanup();
  }
});
