import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, collectEvents, type TestMeshOptions } from "../helpers";
import { TerminationManager } from "../../packages/core/src/termination";
import { KernelRejectedError } from "../../packages/core/src/kernel";
import type { StubTurn } from "../../packages/agent-runtime/src/index";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * The mission token cap must see a turn however that turn ended.
 *
 * `TerminationManager` halts a mission on `budget_exhausted` by reading ONE
 * number: the mission ledger's `consumed` (termination.ts). It never looks at a
 * turn, a discard or a ring record. So the halt is exactly as good as the set of
 * turn endings that reach that ledger, and an ending that skips it is spend the
 * cap cannot see — a mission can run past its operator-declared worth on turns
 * that died, and nothing halts it.
 *
 * Each case below runs ONE turn whose measured cost alone exceeds a tight
 * mission cap, then asks the question twice: the pure verdict over the
 * resulting state, and the live mesh (the watchdog must actually escalate the
 * goal with the budget reason). Agent ledgers are roomy and auto-raise is off,
 * so the only wall in play is the mission's.
 */

const CAP = 1500;
const OVER = { input: 1800, output: 200, total: 2000 };
const FREE = { input: 0, output: 0, total: 0 };
const AFTER: StubTurn = { operations: [{ op: "wait" } as MeshOp], tokensUsed: FREE };

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

interface Case {
  name: string;
  bug?: string;
  mesh?: Partial<TestMeshOptions>;
  streaming?: boolean;
  arm?: (m: Mesh) => void;
  trigger?: (m: Mesh) => Promise<void>;
  first: StubTurn;
}

const CASES: Case[] = [
  {
    // The control case: if this one does not halt, the fixture is wrong, not the ledger.
    name: "a normal turn that overspends",
    first: { operations: [{ op: "wait" } as MeshOp], tokensUsed: OVER },
  },
  {
    name: "a timed-out turn whose abort reported usage",
    mesh: { turnTimeoutMs: 250 },
    first: { delayMs: 60_000, interruptUsage: OVER },
  },
  {
    name: "a silence-interrupted turn whose abort reported usage",
    streaming: true,
    mesh: { turnSilenceMs: 200, stallIdleMs: 300, turnTimeoutMs: 30_000 },
    first: { tokens: ["one ", "two"], silentAfterTokens: 1, interruptUsage: OVER },
  },
  {
    name: "a turn the runtime answered with an error and a usage figure",
    first: { operations: [], fail: "backend reported an error after generating", tokensUsed: OVER },
  },
  {
    name: "a turn ended by a kernel rejection after the model answered",
    arm: (m) => {
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
    first: { operations: [{ op: "wait" } as MeshOp], tokensUsed: OVER },
  },
];

async function runCase(c: Case): Promise<void> {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", capabilities: ["repository.read"], interests: [], tokens: 500_000 }],
    startup: [],
    mayContact: { dev: [] },
    missionTokens: CAP,
    autoRaise: { enabled: false },
    ...c.mesh,
  });
  try {
    if (c.streaming) stub(m).setStreaming(true);
    stub(m).setScript("dev", async (_input, idx) => (idx === 0 ? c.first : AFTER));
    c.arm?.(m);
    if (c.trigger) await c.trigger(m);
    else await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the first turn to end", () =>
      m.supervisor.getRecentTurns(50).some((t) => t.agentId === "dev" && t.status !== "running"), 15_000);
    // Past the runTurn `finally`, which is where an abnormal ending bills.
    await waitFor("no turn in flight", () => !m.supervisor.getRecentTurns(50).some((t) => t.status === "running"), 5000);
    await new Promise((r) => setTimeout(r, 150));

    // 1. The live mesh acts on it. The watchdog usually has already — any budget
    // event schedules it — so this only forces the tick it would have taken.
    await m.supervisor.forceWatchdog();
    await waitFor("the goal to escalate on the budget", async () =>
      (await collectEvents(m)).some(
        (e) => e.type === "goal.escalated" && (e.payload as { reason?: string }).reason === "budget_exhausted",
      ), 5000);

    // 2. And the verdict, as a pure function of the ledgers the turn left behind.
    // `evaluate` returns `continue` for a goal that is already ESCALATED, so it is
    // asked about the same state with the goal still ACTIVE: the question is what
    // the ledgers say, not whether the card was already raised.
    const state = m.kernel.state;
    const goalId = state.activeGoalId!;
    const asActive = {
      ...state,
      goals: new Map([...state.goals].map(([id, g]) => [id, id === goalId ? { ...g, status: "ACTIVE" as const } : g])),
    };
    const verdict = new TerminationManager().evaluate({ state: asActive, config: m.config, wallClockMs: 0 });
    assert.equal(verdict.kind, "escalate", `a ${OVER.total}-token turn against a ${CAP}-token mission cap must end the mission's run`);
    assert.equal(verdict.kind === "escalate" ? verdict.reason : undefined, "budget_exhausted", "and for the budget, not some other reason");
  } finally {
    stub(m).releaseHangs();
    await m.cleanup();
  }
}

for (const c of CASES) {
  test(`mission cap sees ${c.name}`, c.bug ? { todo: c.bug } : {}, () => runCase(c));
}
