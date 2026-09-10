import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { bootstrapMesh, type MeshInstance } from "../../apps/mesh-server/src/index";
import { testConfigYaml } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * "Every view is a projection" is the load-bearing claim of the whole runtime:
 * state is never mutated in place, so a second process replaying the same
 * append-only log must land on the same mesh. `tests/core/kernel.test.ts`
 * proves `replayFromStore` applies events and honours a snapshot, but it does
 * so on a hand-emitted two-event log with no supervisor, no scheduler and no
 * projections beyond `goals`.
 *
 * These tests boot a real mission, run real turns, and then boot a SECOND
 * instance off the same `events.jsonl`. Anything the runtime keeps only in
 * process memory — a lifecycle flag, a mailbox, an approval, a criterion's
 * evidence — shows up here as a divergence and nowhere else.
 *
 * File mode on purpose: `makeMesh` forces `inMemory: true`, which gives each
 * instance its own `MemoryEventStore` and so cannot express "same log, two
 * boots" at all.
 */

const AGENTS = [
  { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
  { id: "qa", role: "qa", authority: ["quality.approve"], capabilities: ["test.execute"], interests: [] },
];

interface Bed {
  dir: string;
  configPath: string;
  boot(): Promise<MeshInstance>;
  cleanup(): void;
}

function bed(): Bed {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-replay-"));
  const configPath = path.join(dir, "mesh.yaml");
  fs.writeFileSync(
    configPath,
    testConfigYaml({ agents: AGENTS, mayContact: { dev: ["qa"], qa: ["dev"] } }),
    "utf8",
  );
  return {
    dir,
    configPath,
    // Live, not parked: a parked console never runs a turn, so the "mission"
    // would be nothing but boot events and the equality assertion would be
    // vacuous. No agent here declares interests and none is in `startup`, so
    // nothing activates except the explicit activations below — the mission is
    // driven, not autonomous, and cannot race the assertions.
    boot: () => bootstrapMesh({ configPath, mode: "live" }),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * A structural fingerprint of everything a mission is. Comparing whole
 * projection objects directly is useless (Maps, timestamps that legitimately
 * differ per boot, runtime handles), so this names the state that MUST be
 * identical and sorts every collection so ordering noise cannot mask a real
 * difference.
 */
function fingerprint(m: MeshInstance): unknown {
  const st = m.kernel.state;
  const goal = st.activeGoalId ? st.goals.get(st.activeGoalId) : undefined;
  return {
    goal: goal
      ? {
          description: goal.description,
          status: goal.status,
          budget: goal.budget,
          criteria: [...goal.acceptanceCriteria]
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((c) => ({ id: c.id, status: c.status, mandatory: c.mandatory, evidence: c.evidence.length })),
        }
      : null,
    agents: [...st.agents.values()]
      .map((r) => ({
        id: r.definition.id,
        role: r.definition.role,
        lifecycle: r.state.lifecycle,
        activations: r.state.activations,
        unread: st.unread.get(r.definition.id)?.length ?? 0,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    artifacts: [...st.artifacts.values()]
      .map((a) => ({ name: a.name, type: a.type, version: a.version, status: a.status, owner: a.owner }))
      .sort((a, b) => `${a.type}/${a.name}`.localeCompare(`${b.type}/${b.name}`)),
    threads: [...st.threads.values()]
      .map((t) => ({ subject: t.subject, depth: t.depth, status: t.status, messages: t.messageIds.length }))
      .sort((a, b) => a.subject.localeCompare(b.subject)),
    messages: [...st.messages.values()]
      .map((x) => ({ from: x.from, to: [...x.to].sort(), type: x.type }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    tasks: [...st.tasks.values()]
      .map((t) => ({ title: t.title, status: t.status, claimedBy: t.claimedBy ?? null }))
      .sort((a, b) => a.title.localeCompare(b.title)),
    approvals: [...st.approvals.entries()]
      .map(([k, v]) => [k, v.map((r) => ({ actorId: r.actorId, kind: r.kind })).sort((a, b) => a.kind.localeCompare(b.kind))])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    escalations: [...st.escalations.values()]
      .map((e) => ({ reason: e.reason, status: e.status }))
      .sort((a, b) => a.reason.localeCompare(b.reason)),
    eventCount: st.eventCount,
    lastEventSeq: st.lastEventSeq,
  };
}

/**
 * Wait until nothing is in flight. `activateAgent` QUEUES a turn, so
 * fingerprinting straight after it captures a half-run mission (an agent still
 * THINKING, the message not yet sent) and the equality assertion then compares
 * a partial state against a complete one.
 */
async function settle(m: MeshInstance, what: string, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // Quiescence is "the scheduler is empty AND the log stopped growing".
  // Deliberately NOT a lifecycle check: the `human` seat is created STARTING
  // and never leaves it (it has no runtime to idle), so any "all agents are
  // IDLE" predicate waits forever on a mesh that is already finished.
  let lastCount = -1;
  let quiet = 0;
  while (Date.now() < deadline) {
    const idle = m.scheduler.pending() === 0 && m.scheduler.running() === 0;
    const count = m.kernel.state.eventCount;
    quiet = idle && count === lastCount ? quiet + 1 : 0;
    lastCount = count;
    // Three consecutive quiet reads: a finished turn can still be draining
    // follow-up emissions (budget ledgers, derived transitions).
    if (quiet >= 3) return;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error(`timeout waiting for the mesh to settle: ${what}`);
}

/** Runs a small but state-touching mission: artifact, message, task, approval. */
async function driveMission(m: MeshInstance): Promise<void> {
  const s = m.stubRuntimes.get("stub");
  assert.ok(s, "stub runtime missing");
  s.setScript("dev", async () => ({
    text: "publish and hand off",
    operations: [
      { op: "publish_artifact", name: "core-patch", type: "CodePatch", content: "diff --git a/A b/A\n+ work\n" } as MeshOp,
      {
        op: "send",
        type: "PATCH_READY",
        to: ["qa"],
        newThread: { subject: "patch v1" },
        payload: { summary: "please test" },
      } as MeshOp,
      { op: "done" } as MeshOp,
    ],
  }));
  s.setScript("qa", async () => ({
    text: "approve",
    operations: [{ op: "approve", subject: "quality", comment: "tests green" } as MeshOp, { op: "done" } as MeshOp],
  }));

  await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
  await settle(m, "dev turn");
  await m.supervisor.activateAgent("qa", { kind: "manual" }, { explicit: true });
  await settle(m, "qa turn");
  // The watchdog is what settles DERIVED state (criteria, escalations), so the
  // fingerprint must be taken after it has run, not merely after the turns.
  await m.supervisor.forceWatchdog();
}

test("dual boot: a second instance replaying the same log lands on the identical mission state", async () => {
  const b = bed();
  try {
    const first = await b.boot();
    let expected: unknown;
    let logLength = 0;
    try {
      await driveMission(first);
      // Guard the guard: an empty mission would make the equality assertion
      // below pass vacuously.
      assert.ok(first.kernel.state.artifacts.size > 0, "the mission produced an artifact");
      assert.ok(first.kernel.state.messages.size > 0, "the mission produced traffic");
      expected = fingerprint(first);
      logLength = (await first.store.read()).length;
      assert.ok(logLength > 0, "the log is non-empty");
    } finally {
      await first.close();
    }

    // Second boot: same config, same events.jsonl, brand-new process objects.
    const second = await b.boot();
    try {
      assert.equal(
        (await second.store.read()).length,
        logLength,
        "the second boot must replay the existing log, not start a fresh one",
      );
      assert.deepEqual(
        fingerprint(second),
        expected,
        "replaying the same log must reconstruct the same mission",
      );
    } finally {
      await second.close();
    }
  } finally {
    b.cleanup();
  }
});

test("dual boot: snapshot + tail replay reconstructs the same state as the events alone", async () => {
  const b = bed();
  try {
    const first = await b.boot();
    let expected: unknown;
    try {
      await driveMission(first);
      // More events AFTER the mission work, so the restored boot has a real
      // tail to apply on top of whatever snapshot exists rather than landing
      // exactly on a snapshot boundary.
      for (let i = 0; i < 5; i++) {
        await first.supervisor.rememberMemory("dev", `tail-${i}`, `note ${i}`);
      }
      expected = fingerprint(first);
    } finally {
      await first.close();
    }

    const second = await b.boot();
    try {
      // The snapshot (if the interval was reached) is a cache, never a source
      // of truth: the reconstructed state must match the log-derived one
      // either way, which is exactly the invariant a stale snapshot breaks.
      assert.deepEqual(
        fingerprint(second),
        expected,
        "snapshot-assisted replay must agree with the event log",
      );
      assert.equal(
        second.kernel.state.memory.get("dev")?.get("tail-4")?.value,
        "note 4",
        "the post-snapshot tail was applied, not dropped",
      );
    } finally {
      await second.close();
    }
  } finally {
    b.cleanup();
  }
});

test("dual boot: appending after a replay continues the same log without gaps", async () => {
  const b = bed();
  try {
    const first = await b.boot();
    let seqAfterFirst = 0;
    try {
      await driveMission(first);
      seqAfterFirst = first.kernel.state.lastEventSeq;
      assert.ok(seqAfterFirst > 0);
    } finally {
      await first.close();
    }

    const second = await b.boot();
    try {
      assert.equal(
        second.kernel.state.lastEventSeq,
        seqAfterFirst,
        "the replayed kernel resumes at the durable seq",
      );
      // Event sourcing means the next write EXTENDS the log. A boot that reset
      // the sequence would silently overwrite history.
      const appended = await second.kernel.emit("human.input", { action: "post-replay probe" }, { actorId: "human" });
      assert.equal(appended.seq, seqAfterFirst + 1, "the append continues the existing sequence");

      const log = await second.store.read();
      assert.deepEqual(
        log.map((e) => e.seq),
        log.map((_e, i) => i + 1),
        "the log has no gaps and no duplicates after a replay + append",
      );
    } finally {
      await second.close();
    }
  } finally {
    b.cleanup();
  }
});
