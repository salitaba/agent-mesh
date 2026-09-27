import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, collectEvents, type AgentSpec, type TestMeshOptions } from "../helpers";
import { KernelRejectedError } from "../../packages/core/src/kernel";
import type { StubTurn } from "../../packages/agent-runtime/src/index";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * Every way a turn can end, against one ledger rule.
 *
 * `timeout-billing.test.ts` proves the rule for ONE abnormal ending. The rule is
 * not about timeouts, though; it is about the ledger, and it has to hold on every
 * exit a turn has:
 *
 *   - a turn whose token figure is KNOWN lands that figure exactly once on the
 *     agent ledger and exactly once on the mission ledger, and if the turn is
 *     also recorded as `turn.discarded` that record states the same figure;
 *   - a turn whose figure is NOT known bills nothing and says so explicitly: one
 *     `turn.discarded` with no `tokens` key, which is how "unmeasured" is spelled
 *     (an invented 0 reads as "this turn was free");
 *   - either way, no hold outlives the turn — every agent and thread ledger is
 *     back to `reserved: 0`.
 *
 * The mission ledger is the one the budget halt reads (termination.ts), so a
 * turn that skips it is a turn the halt cannot see. Each ending runs on its own
 * mesh so one ending's retry ladder cannot leak into another's ledger; only the
 * FIRST turn of the seat is judged, and every later turn (restarts, the
 * handover's give-back) is scripted to cost exactly zero.
 */

const KNOWN = { input: 900, output: 100, total: 1000 };
const FREE = { input: 0, output: 0, total: 0 };
/** What every turn after the one under test does: nothing, at no cost. */
const AFTER: StubTurn = { operations: [{ op: "wait" } as MeshOp], tokensUsed: FREE };

const DEV: AgentSpec = { id: "dev", role: "developer", capabilities: ["repository.read"], interests: [], tokens: 500_000 };

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

interface Ending {
  name: string;
  /** The token figure the ending carries, or undefined when nothing measured it. */
  known: number | undefined;
  /** Set when the row fails today: the one-line defect it pins. */
  bug?: string;
  agent?: Partial<AgentSpec>;
  mesh?: Partial<TestMeshOptions>;
  streaming?: boolean;
  /** Runs before the turn is triggered (arm a rotation, kill a process, patch the kernel). */
  arm?: (m: Mesh) => void | Promise<void>;
  /** The seat's first turn. */
  first: (m: Mesh) => StubTurn | Promise<StubTurn>;
  /** How the turn is started. Default: a manual activation. */
  trigger?: (m: Mesh) => Promise<void>;
  /**
   * Precondition: the `turn.discarded` reason this ending must produce, or null
   * when the row does not pin one (no discard, or the missing discard IS the
   * defect the row records). Pins that the row reached the path its name claims — a row
   * that silently fell through to the normal path would prove nothing.
   */
  discard: string | null;
  /** Further precondition on the ring record / log. */
  reached?: (ctx: { events: Array<{ type: string; payload: unknown }>; error: string }) => void;
}

const ENDINGS: Ending[] = [
  {
    name: "normal: ops executed",
    discard: null,
    known: 1000,
    first: () => ({ operations: [{ op: "wait" } as MeshOp], tokensUsed: KNOWN }),
  },
  {
    name: "no ops: prose answer with no ops block",
    discard: "no_ops",
    known: 1000,
    first: () => ({ operations: [], text: "I have done the work and told the team.", tokensUsed: KNOWN }),
  },
  {
    name: "all ops rejected",
    discard: "all_rejected",
    known: 1000,
    first: () => ({
      operations: [{ op: "transition_artifact", artifactId: "art-does-not-exist", to: "APPROVED" } as MeshOp],
      text: "moving it along",
      tokensUsed: KNOWN,
    }),
  },
  {
    name: "mid-turn halt: the mission is paused while the model is thinking",
    discard: null,
    reached: ({ events }) => assert.ok(events.some((e) => e.type === "goal.paused"), "precondition: the goal paused mid-turn"),
    known: 1000,
    first: async (m) => {
      await m.supervisor.pauseGoal();
      return { operations: [{ op: "wait" } as MeshOp], tokensUsed: KNOWN };
    },
  },
  {
    name: "plan-gate stop: the first hard op is refused and the loop breaks",
    discard: "all_rejected",
    reached: ({ events }) => assert.ok(events.some((e) => e.type === "plan.gate_rejected"), "precondition: the plan gate refused the op"),
    known: 1000,
    agent: {
      capabilities: ["repository.write"],
      hardActions: { mode: "enforce", capabilities: ["repository.write"] },
    },
    first: () => ({
      operations: [
        { op: "publish_artifact", name: "n", type: "ADR", content: "c" } as MeshOp,
        { op: "wait" } as MeshOp,
      ],
      tokensUsed: KNOWN,
    }),
  },
  {
    name: "timeout: the backend answered the ordered abort with usage",
    discard: "timeout",
    known: 1000,
    mesh: { turnTimeoutMs: 250 },
    first: () => ({ delayMs: 60_000, interruptUsage: KNOWN }),
  },
  {
    name: "timeout: the backend never answered the abort (hang past the turn timeout)",
    discard: "timeout",
    known: undefined,
    mesh: { turnTimeoutMs: 250 },
    first: () => ({ hang: true }),
  },
  {
    name: "silence interrupt: the stream froze and the abort came back with usage",
    discard: "silence",
    known: 1000,
    streaming: true,
    mesh: { turnSilenceMs: 200, stallIdleMs: 300, turnTimeoutMs: 30_000 },
    first: () => ({ tokens: ["one ", "two"], silentAfterTokens: 1, interruptUsage: KNOWN }),
  },
  {
    name: "force-settle: the stream froze and the interrupt was ignored (hang + silence)",
    discard: null,
    reached: ({ error }) => assert.match(error, /turn silence exceeded/, "precondition: the watchdog force-settled it"),
    known: undefined,
    streaming: true,
    mesh: { turnSilenceMs: 200, stallIdleMs: 300, turnTimeoutMs: 30_000 },
    first: () => ({ tokens: ["one ", "two"], silentAfterTokens: 1, hang: true }),
  },
  {
    name: "backend unreachable: the typed dead-backend error",
    discard: "failed",
    known: undefined,
    first: () => ({ throwKind: "backend_unreachable" }),
  },
  {
    name: "process death between turns: the next send finds the process gone",
    discard: "failed",
    reached: ({ error }) => assert.match(error, /simulateProcessDeath/, "precondition: the send found the process dead"),
    known: undefined,
    arm: (m) => stub(m).simulateProcessDeath("dev", { permanent: true }),
    first: () => AFTER,
  },
  {
    name: "process death mid-turn: the stream closes without a turn_end",
    discard: "failed",
    reached: ({ error }) => assert.match(error, /without a turn_end/, "precondition: the transport died mid-turn"),
    known: undefined,
    streaming: true,
    first: () => ({ tokens: ["a", "b", "c"], dieAfterFrames: 1 }),
  },
  {
    name: "output.error: the runtime answered with an error AND a usage figure",
    discard: "failed",
    known: 1000,
    first: () => ({ operations: [], fail: "backend reported an error after generating", tokensUsed: KNOWN }),
  },
  {
    name: "kernel rejection: a reducer refuses an event after the model answered",
    discard: null,
    reached: ({ error }) => assert.match(error, /projection refused message.delivered/, "precondition: the kernel rejection reached runTurn"),
    known: 1000,
    arm: (m) => {
      // Refuse the first `message.delivered`: it is emitted after the runtime
      // answers and before the op loop, outside `executeOp`'s own catch, so a
      // rejection there is the one that reaches runTurn's KernelRejectedError arm.
      const kernel = m.kernel as unknown as { emit: (...a: unknown[]) => Promise<unknown> };
      const real = kernel.emit.bind(kernel);
      let fired = false;
      kernel.emit = async (...a: unknown[]) => {
        if (!fired && a[0] === "message.delivered") {
          fired = true;
          throw new KernelRejectedError("projection refused message.delivered", "message.delivered");
        }
        return real(...a);
      };
    },
    trigger: async (m) => {
      await m.supervisor.humanSend(["dev"], "INFORM", { text: "please pick this up" });
    },
    first: () => ({ operations: [{ op: "wait" } as MeshOp], tokensUsed: KNOWN }),
  },
  {
    name: "rotation: the turn was spent on a handover",
    discard: "rotation_handoff",
    known: 1000,
    arm: (m) => stub(m).armRotation("dev"),
    // Zero ops: only a handover that emitted nothing is classified
    // `rotation_handoff`; one that wrote its record reads as an ordinary turn.
    first: () => ({ operations: [], text: "handing over", tokensUsed: KNOWN }),
  },
];

/** The seat's first turn in the ring, however it ended. */
function firstTurn(m: Mesh) {
  return m.supervisor
    .getRecentTurns(200)
    .filter((t) => t.agentId === "dev")
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))[0];
}

/** Poll without throwing: some endings (a hung call) never go quiet, and that is part of what is asserted. */
async function quietWithin(m: Mesh, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const running = m.supervisor.getRecentTurns(200).some((t) => t.status === "running");
    if (!running && m.scheduler.running() === 0 && m.scheduler.pending() === 0) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  // The `finally` of runTurn emits after the ring is updated.
  await new Promise((r) => setTimeout(r, 150));
}

async function runEnding(row: Ending): Promise<void> {
  const m = await makeMesh({
    agents: [{ ...DEV, ...row.agent }],
    startup: [],
    mayContact: { dev: [] },
    // A hard wall, as in timeout-billing: auto-raise would absorb an overrun.
    autoRaise: { enabled: false },
    ...row.mesh,
  });
  try {
    if (row.streaming) stub(m).setStreaming(true);
    stub(m).setScript("dev", async (_input, idx) => (idx === 0 ? row.first(m) : AFTER));
    await row.arm?.(m);
    if (row.trigger) await row.trigger(m);
    else await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });

    await waitFor("the first turn to end", () => {
      const t = firstTurn(m);
      return t !== undefined && t.status !== "running";
    }, 15_000);
    await quietWithin(m, 4000);

    const turnId = firstTurn(m)!.turnId;
    const events = await collectEvents(m);
    const consumed = (prefix: string) =>
      events
        .filter((e) => e.type === "budget.consumed")
        .map((e) => e.payload as Record<string, unknown>)
        .filter((p) => String(p.key ?? "").startsWith(prefix) && p.turnId === turnId)
        .map((p) => Number(p.amount));
    const discards = events
      .filter((e) => e.type === "turn.discarded")
      .map((e) => e.payload as Record<string, unknown>)
      .filter((p) => p.turnId === turnId);

    const rec = firstTurn(m)!;
    // Preconditions first, so a row that missed its path fails as a setup error
    // rather than as a ledger verdict it never earned.
    row.reached?.({ events, error: String(rec.error ?? "") });
    if (row.discard !== null) {
      assert.equal(discards[0]?.reason, row.discard, "precondition: the ending took the path this row names");
    }

    if (row.known !== undefined) {
      assert.deepEqual(consumed("agent:"), [row.known], "a measured turn lands on the seat's ledger exactly once");
      assert.deepEqual(consumed("mission:"), [row.known], "and on the mission ledger exactly once — the one the budget halt reads");
      assert.ok(discards.length <= 1, "a turn is discarded at most once");
      if (discards.length === 1) {
        assert.equal(discards[0]!.tokens, row.known, "a discard record states the figure it billed, not a different one");
      }
    } else {
      assert.deepEqual(consumed("agent:"), [], "an unmeasured turn bills nothing to the seat");
      assert.deepEqual(consumed("mission:"), [], "or to the mission");
      assert.equal(discards.length, 1, "but it is recorded: exactly one turn.discarded names it");
      assert.ok(!("tokens" in discards[0]!), "with no token figure — absent is how unmeasured is spelled, never 0");
    }
    for (const b of m.kernel.state.budgets.values()) {
      assert.equal(b.reserved, 0, `no hold outlives the turn (${b.key} still reserves ${b.reserved})`);
    }
  } finally {
    stub(m).releaseHangs();
    await m.cleanup();
  }
}

for (const row of ENDINGS) {
  test(`turn ending → ledger: ${row.name}`, row.bug ? { todo: row.bug } : {}, () => runEnding(row));
}
