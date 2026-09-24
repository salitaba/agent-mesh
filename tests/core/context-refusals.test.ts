import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAgentContext, renderContextInstructions } from "../../packages/core/src/context";
import { makeMesh } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * A seat must be able to find out what it was just refused.
 *
 * Both refusal rings were projected for the OPERATOR and read by nobody else:
 * `deniedActions` and `refusedSends` feed the MCP failure digest and the run
 * report, and no context builder touched either. The agent that caused the
 * refusal was handed `{ ok: true }` in the same turn — the op result carries no
 * hint of it — and told nothing on any later turn.
 *
 * Live evidence: one seat hit the identical capability denial twice, a hundred
 * seconds apart, with a byte-identical retry; another hit its own three times.
 * That is not a model failing to learn, it is a model never being told.
 */

const AGENTS = [
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "task.assign"], authority: ["implementation.approve"], interests: [] },
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write"], interests: [] },
  { id: "qa", role: "qa", capabilities: ["repository.read", "test.execute"], interests: [] },
];

// dev may reach lead and nobody else — so a send to qa is refused by policy.
const COMM = { lead: ["dev", "qa"], dev: ["lead"], qa: ["lead"] };

const turnFor = (agentId: string) =>
  ({
    turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`,
    agentId,
    reason: { kind: "manual" as const },
    sentOps: 0,
    publishedOps: 0,
    waitRequested: false,
    escalated: false,
    results: [],
  }) as never;

function mesh() {
  return makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" } as never);
}

const ctxFor = (m: Awaited<ReturnType<typeof makeMesh>>, agentId: string) =>
  buildAgentContext({ config: m.config, kernel: m.kernel } as never, agentId);

test("a capability denial comes back to the seat that caused it", async () => {
  const m = await mesh();
  try {
    const created = await m.supervisor.executeOp(
      "lead",
      { op: "create_task", title: "merge the branch", description: "...", requiredCapabilities: ["git.merge"] } as MeshOp,
      turnFor("lead"),
    );
    assert.equal(created.ok, true, created.reason);

    const claim = await m.supervisor.claimTask("dev", created.taskId!);
    assert.equal(claim.ok, false, "dev does not hold git.merge");

    const refusals = ctxFor(m, "dev").refusedOps ?? [];
    assert.equal(refusals.length, 1, "the denial must reach dev's next turn");
    assert.match(refusals[0] ?? "", /git\.merge/, "and name the capability, which is the actionable part");
    assert.match(refusals[0] ?? "", /DENY/, "and say it was a denial, not a deferral that clears itself");
  } finally {
    await m.cleanup();
  }
});

test("a refused send comes back too, naming the recipient it could not reach", async () => {
  const m = await mesh();
  try {
    const res = await m.supervisor.executeOp(
      "dev",
      { op: "send", to: ["qa"], type: "INFORM", payload: { note: "fyi" } } as MeshOp,
      turnFor("dev"),
    );
    assert.equal(res.ok, false, "dev may not open contact with qa");

    const refusals = ctxFor(m, "dev").refusedOps ?? [];
    assert.ok(refusals.length >= 1, "a refused send is a refusal the sender should see");
    assert.ok(
      refusals.some((r) => /qa/.test(r)),
      "the recipient it could not reach is the whole point of the message",
    );
  } finally {
    await m.cleanup();
  }
});

test("one seat's refusals never leak into another's context", async () => {
  const m = await mesh();
  try {
    const created = await m.supervisor.executeOp(
      "lead",
      { op: "create_task", title: "merge", description: "...", requiredCapabilities: ["git.merge"] } as MeshOp,
      turnFor("lead"),
    );
    await m.supervisor.claimTask("dev", created.taskId!);

    assert.equal((ctxFor(m, "qa").refusedOps ?? []).length, 0, "qa was refused nothing");
    assert.equal((ctxFor(m, "lead").refusedOps ?? []).length, 0, "lead was refused nothing");
    assert.equal((ctxFor(m, "dev").refusedOps ?? []).length, 1, "dev was");
  } finally {
    await m.cleanup();
  }
});

test("the refusal renders into the prompt, above the mail, as an instruction not to retry", async () => {
  const m = await mesh();
  try {
    const created = await m.supervisor.executeOp(
      "lead",
      { op: "create_task", title: "merge", description: "...", requiredCapabilities: ["git.merge"] } as MeshOp,
      turnFor("lead"),
    );
    await m.supervisor.claimTask("dev", created.taskId!);

    const text = renderContextInstructions(ctxFor(m, "dev"));
    assert.match(text, /## Refused last time/, "the section has to actually reach the prompt");
    assert.match(text, /git\.merge/);

    const refusedAt = text.indexOf("## Refused last time");
    const mailAt = text.indexOf("## Unread mail");
    if (mailAt >= 0) {
      assert.ok(refusedAt < mailAt, "a refusal outranks news: it is the thing that would otherwise be repeated");
    }
  } finally {
    await m.cleanup();
  }
});

test("a seat that has been refused nothing gets no section at all", async () => {
  const m = await mesh();
  try {
    const text = renderContextInstructions(ctxFor(m, "qa"));
    assert.ok(!text.includes("## Refused last time"), "an empty section is noise on every turn of a healthy mission");
  } finally {
    await m.cleanup();
  }
});
