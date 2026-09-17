import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * The triage drop counter.
 *
 * `handleEvent`'s IGNORE branch is a bare `continue` — no card, no queue entry,
 * no event, no log line — so the count is the only trace these events leave.
 * Both halves of its contract are pinned here, and the second half matters as
 * much as the first: the branch is unreachable unless an operator sets BOTH
 * `triage.mode: heuristic` AND a non-empty `ignore_if_text_matches`, so a
 * default mesh must report 0 and keep the strip invisible.
 */

const triagedAway = (m: { scheduler: unknown }): number =>
  (m.scheduler as { triagedAwayCount(): number }).triagedAwayCount();

const twoAgents = {
  agents: [
    { id: "qa", role: "qa", interests: ["dependency.changed"] },
    { id: "trigger", role: "dev", interests: [] },
  ],
  mayContact: { qa: [], trigger: [] },
};

test("triage counter: counts every event a rule drops, and never resolves", async () => {
  const m = await makeMesh({
    ...twoAgents,
    triage: {
      mode: "heuristic",
      rules: [{ agent: "qa", event: "dependency.changed", ignore_if_text_matches: ["README"] }],
    },
  });
  const s = stub(m);
  s.setScript("qa", async () => ({ operations: [{ op: "done" } as MeshOp] }));
  assert.equal(triagedAway(m), 0, "nothing dropped before any event arrives");

  await m.kernel.emit("dependency.changed", { files: ["README.md"], summary: "docs bump" }, { actorId: "trigger" });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(triagedAway(m), 1);

  await m.kernel.emit("dependency.changed", { files: ["README.adoc"], summary: "docs again" }, { actorId: "trigger" });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(triagedAway(m), 2, "the tally accumulates — a dropped event is gone, not deferred");
  assert.equal(m.kernel.state.agents.get("qa")?.state.activations, 0, "and no agent ever woke for either");
  await m.cleanup();
});

test("triage counter: reads 0 in a default config, however many events flow", async () => {
  // No `triage` block at all, which is the shipped default: `triageMode`
  // resolves to "off" and `triage()` returns ACT before any rule is consulted.
  const m = await makeMesh({ ...twoAgents });
  const s = stub(m);
  s.setScript("qa", async () => ({ operations: [{ op: "done" } as MeshOp] }));

  await m.kernel.emit("dependency.changed", { files: ["README.md"], summary: "docs bump" }, { actorId: "trigger" });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(triagedAway(m), 0, "mode 'off' cannot drop, so the strip stays invisible by default");
  assert.equal(
    m.kernel.state.agents.get("qa")?.state.activations,
    1,
    "the very event a rule would have dropped woke the agent instead",
  );
  await m.cleanup();
});

test("triage counter: a SKIM is not a drop", async () => {
  // Rule targets a different event type, so no rule matches this agent/event
  // pair and `triage()` returns SKIM — which still activates, at priority 3.
  const m = await makeMesh({
    ...twoAgents,
    triage: {
      mode: "heuristic",
      rules: [{ agent: "qa", event: "artifact.published", ignore_if_text_matches: ["README"] }],
    },
  });
  const s = stub(m);
  s.setScript("qa", async () => ({ operations: [{ op: "done" } as MeshOp] }));

  await m.kernel.emit("dependency.changed", { files: ["README.md"], summary: "docs bump" }, { actorId: "trigger" });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(triagedAway(m), 0, "only IGNORE is a loss; SKIM is a demotion");
  assert.equal(m.kernel.state.agents.get("qa")?.state.activations, 1, "the SKIM still woke the agent");
  await m.cleanup();
});

test("triage counter: a mission reset clears the tally", async () => {
  const m = await makeMesh({
    ...twoAgents,
    triage: {
      mode: "heuristic",
      rules: [{ agent: "qa", event: "dependency.changed", ignore_if_text_matches: ["README"] }],
    },
  });
  const s = stub(m);
  s.setScript("qa", async () => ({ operations: [{ op: "done" } as MeshOp] }));

  await m.kernel.emit("dependency.changed", { files: ["README.md"], summary: "docs bump" }, { actorId: "trigger" });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(triagedAway(m), 1);

  (m.scheduler as unknown as { resetMissionState(): void }).resetMissionState();
  assert.equal(triagedAway(m), 0, "per-mission, like every other counter resetMissionState zeroes");
  await m.cleanup();
});
