import { test } from "node:test";
import assert from "node:assert/strict";
import { DESTRUCTIVE_KINDS, type StagedMutation, type StagedProposal } from "../../packages/protocol/src/index";
import {
  CONFIRM_WORD,
  MUTATION_HANDLERS,
  destructiveKindsIn,
  goalDriftWarning,
  isDestructive,
  showsTextProposal,
  splitByTarget,
  summarizeMutation,
  targetOf,
} from "../../apps/mesh-dashboard/src/designer/mutations";

const proposal = (mutations: StagedMutation[]): StagedProposal => ({
  id: "p1",
  createdAt: "2026-01-01T00:00:00.000Z",
  mutations,
  problems: [],
});

/* The Record type already makes a missing kind a compile error; this covers the
 * half the type cannot, that the table's own destructive flags have not drifted
 * from the protocol's list. */
test("the handler table's destructive set matches the protocol's", () => {
  const flagged = Object.entries(MUTATION_HANDLERS)
    .filter(([, h]) => h.destructive)
    .map(([k]) => k)
    .sort();
  assert.deepEqual(flagged, [...DESTRUCTIVE_KINDS].sort());
});

test("every handler has a label and a target", () => {
  for (const [kind, h] of Object.entries(MUTATION_HANDLERS)) {
    assert.ok(h.label.length > 0, `${kind} has no label`);
    assert.ok(h.target === "draft" || h.target === "server", `${kind} has a bogus target`);
  }
});

/* The split the protocol calls non-interchangeable: config.replace is the only
 * client-side kind, and everything else reaches the running mesh. */
test("config.replace is the only draft-targeted kind", () => {
  const draftKinds = Object.entries(MUTATION_HANDLERS)
    .filter(([, h]) => h.target === "draft")
    .map(([k]) => k);
  assert.deepEqual(draftKinds, ["config.replace"]);
});

test("splitByTarget keeps a live-run change out of the draft bucket", () => {
  const muts: StagedMutation[] = [
    { kind: "config.replace", yaml: "mesh:\n  id: beta\n" },
    { kind: "seat.retire", agentId: "reviewer", reason: "seat is idle" },
    { kind: "run.pause" },
  ];
  const { draft, server } = splitByTarget(muts);
  assert.equal(draft.length, 1);
  assert.equal(draft[0].kind, "config.replace");
  assert.deepEqual(server.map((m) => m.kind), ["seat.retire", "run.pause"]);
  for (const m of server) assert.notEqual(targetOf(m), "draft");
});

test("config.replace summarizes as a diff against the current draft", () => {
  const m: StagedMutation = { kind: "config.replace", yaml: "mesh:\n  id: beta\n" };
  const lines = summarizeMutation(m, { model: { mesh: { id: "alpha" } } });
  assert.ok(lines.some((l) => l.includes("alpha") && l.includes("beta")), lines.join(" | "));
});

test("config.replace with no draft says so instead of showing an empty diff", () => {
  const m: StagedMutation = { kind: "config.replace", yaml: "mesh:\n  id: beta\n" };
  const lines = summarizeMutation(m, { model: null });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /no current draft/);
});

/* A malformed proposal must render as a warning, never take the panel down. */
test("unparseable YAML is reported rather than thrown", () => {
  const m: StagedMutation = { kind: "config.replace", yaml: "a: b\n\tc: d\n" };
  let lines: string[] = [];
  assert.doesNotThrow(() => { lines = summarizeMutation(m, { model: { mesh: { id: "alpha" } } }); });
  assert.equal(lines.length > 0, true);
});

test("reason is appended once, uniformly, and only when present", () => {
  const withReason = summarizeMutation({ kind: "run.pause", reason: "budget review" }, { model: null });
  assert.equal(withReason.at(-1), "reason: budget review");
  const without = summarizeMutation({ kind: "run.pause" }, { model: null });
  assert.ok(!without.some((l) => l.startsWith("reason:")));
});

test("summaries name the seat and criterion they act on", () => {
  assert.ok(summarizeMutation({ kind: "seat.retire", agentId: "reviewer", reason: "idle" }, { model: null })[0].includes("reviewer"));
  assert.ok(summarizeMutation({ kind: "criteria.delete", criterionId: "c3", reason: "superseded" }, { model: null })[0].includes("c3"));
  assert.ok(summarizeMutation({ kind: "seat.spawn", agent: { id: "scribe", role: "writer", runtime: "claude" } as never }, { model: null })[0].includes("scribe"));
});

test("destructiveKindsIn dedupes and ignores safe kinds", () => {
  const muts: StagedMutation[] = [
    { kind: "seat.retire", agentId: "a", reason: "r" },
    { kind: "seat.retire", agentId: "b", reason: "r" },
    { kind: "run.pause" },
  ];
  assert.deepEqual(destructiveKindsIn(muts), ["seat.retire"]);
  assert.deepEqual(destructiveKindsIn([{ kind: "run.pause" }]), []);
  assert.equal(isDestructive({ kind: "mission.reset" }), true);
});

/* Risk 5: the server sends both proposal formats for one release. */
test("the text proposal is hidden exactly when the buffer carries a config.replace", () => {
  assert.equal(showsTextProposal(proposal([{ kind: "config.replace", yaml: "mesh:\n  id: x\n" }])), false);
  assert.equal(showsTextProposal(proposal([{ kind: "run.pause" }])), true);
  assert.equal(showsTextProposal(proposal([])), true);
  assert.equal(showsTextProposal(null), true);
  assert.equal(showsTextProposal(undefined), true);
});

test("the confirm word is a stable literal the card can prompt for", () => {
  assert.equal(typeof CONFIRM_WORD, "string");
  assert.ok(CONFIRM_WORD.length > 0);
});

/* ---------------------------------------------------------- goal drift
 * mesh.yaml seeds the goal once at boot, so a config.replace that rewords it
 * moves the file and the Config view while the running mission keeps what it
 * started with. The card is the only place that gap can be named. */

const MISSION = {
  description: "ship the billing export",
  criteria: [
    { id: "c1", description: "export runs nightly" },
    { id: "c2", description: "totals reconcile" },
  ],
};
const yamlFor = (goal: string, criteria?: string) =>
  `mesh:\n  id: alpha\n  goal: ${goal}\n${criteria ?? ""}`;
const replace = (yaml: string): StagedMutation => ({ kind: "config.replace", yaml });

test("a config.replace that rewords the goal warns that the running mission will not move", () => {
  const w = goalDriftWarning([replace(yamlFor("ship the billing export AND the audit log"))], MISSION);
  assert.ok(w, "expected a warning");
  assert.match(w!, /running mission keeps what it booted with/);
  assert.match(w!, /Reword the goal/);
});

test("no warning when the proposed goal already matches the running mission", () => {
  assert.equal(goalDriftWarning([replace(yamlFor("ship the billing export"))], MISSION), null);
});

test("whitespace and line wrapping alone are not drift", () => {
  assert.equal(goalDriftWarning([replace(yamlFor(">-\n    ship the billing\n    export"))], MISSION), null);
});

test("no live mission to compare against means no warning", () => {
  assert.equal(goalDriftWarning([replace(yamlFor("something else entirely"))], null), null);
});

test("a proposal with no config.replace never warns", () => {
  assert.equal(goalDriftWarning([{ kind: "run.pause" }, { kind: "goal.description", description: "x" }], MISSION), null);
});

test("criteria drift warns even when the goal text is unchanged", () => {
  const yaml = yamlFor("ship the billing export", "  acceptance_criteria:\n    - id: c1\n      description: export runs hourly\n    - id: c2\n      description: totals reconcile\n");
  const w = goalDriftWarning([replace(yaml)], MISSION);
  assert.ok(w, "expected a warning");
  assert.match(w!, /acceptance criteria/);
});

test("a file with no acceptance_criteria is not read as clearing derived ones", () => {
  assert.equal(goalDriftWarning([replace(yamlFor("ship the billing export"))], MISSION), null);
});

test("unparseable YAML is left to the itemized summary rather than double-reported", () => {
  assert.equal(goalDriftWarning([replace("mesh:\n  goal: [unclosed")], MISSION), null);
});

/* boot() mints a goal only when it is NOT resuming, so "just restart it" is
 * wrong for the goal even though it is right for seats and budgets. The warning
 * must not send an operator down that path. */
test("the warning does not offer a restart as the fix — a resumed mesh keeps its goal", () => {
  const w = goalDriftWarning([replace(yamlFor("a different mission entirely"))], MISSION);
  assert.ok(w, "expected a warning");
  assert.match(w!, /resumed mesh keeps its existing goal/);
  assert.doesNotMatch(w!, /the next boot/);
});
