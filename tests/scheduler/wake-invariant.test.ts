import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, type AgentSpec, type TestMesh } from "../helpers";
import { ManualClock, settle } from "../support/manual-clock";
import { interestMatches } from "../../packages/config/src/index";
import type { ActivationReason, MeshEvent, MeshOp, PolicyDecisionResult } from "../../packages/protocol/src/index";

/**
 * The scheduler's silent drops, as ONE invariant (NOTES-test-gaps.md §5.1).
 *
 * An event that matches a live seat's declared interest must produce exactly
 * one observable outcome for that seat:
 *
 *   - an ACTIVATION  — a turn started whose reason names this event;
 *   - a QUEUE ENTRY  — the seat holds a place in the scheduler's queue (a new
 *                      one, or one this event was coalesced into);
 *   - a STASH        — the seat is mid-turn and a follow-up wake is held for it
 *                      in `wakeAfterTurn`;
 *   - a DENIAL       — a policy refusal was recorded (`lastActivationRefusal`
 *                      changed, which is what `message.rejected` narrates);
 *   - a DROP COUNTER — a counter the operator can read moved (the per-reason
 *                      tallies of `suppressedWakes`, of which the triage
 *                      IGNORE tally, `triagedAwayCount`, is one).
 *
 * Never nothing. Enumerating the ~27 `continue`s in `handleEvent` and
 * `requestActivation` as separate tests would rot the day one moved; this
 * instead wraps the scheduler's single entry point, computes which (event,
 * seat) pairs were ELIGIBLE from the seats' own declarations — not from the
 * scheduler's registry, which is one of the things under test (§5.2) — and
 * fails listing every pair that left no trace. It is the test that would have
 * caught the live run recorded at 4 interest wakes from 74 eligible events.
 *
 * Eligibility deliberately mirrors the scheduler's OWN top-level gates, so the
 * invariant never demands a wake the design rules out wholesale:
 *   - `message.sent` is excluded: mail is its own path with its own gates
 *     (broadcast interest, delivery classes, `wake`), covered by §5.4 and
 *     `tests/scheduler/wake-not-for.test.ts`;
 *   - nothing counts while the scheduler is stopped, or while the goal is
 *     absent, PAUSED, COMPLETED or FAILED (`handleEvent` returns before any
 *     candidate is considered — operator intent, not a per-seat drop);
 *   - a seat is not a candidate for its own event, and SUSPENDED / COMPLETED /
 *     RETIRED seats and the human seat are not live.
 * Everything past those gates is per-seat, and per-seat is where a wake can
 * vanish.
 */

/** The scheduler state an outcome can be read from. Private fields are cast to, never written. */
interface SchedulerView {
  handleEvent(event: MeshEvent): Promise<void>;
  isRunning(): boolean;
  queueSnapshot(): Array<{ agentId: string; priority: number; reason: ActivationReason }>;
  queueWaits(): Array<{ agentId: string; kind: string }>;
  pending(): number;
  triagedAwayCount(): number;
  suppressedWakes(): Record<string, number>;
  lastActivationRefusal(agentId: string): PolicyDecisionResult | undefined;
  /** Private. Read only by the "internal" surface; see `publicOnly` below. */
  wakeAfterTurn: Map<string, unknown>;
}

type Outcome = "activated" | "queued" | "stashed" | "denied" | "counted";

interface Pair {
  eventId: string;
  eventType: string;
  seat: string;
  outcome?: Outcome;
}

const HALTED = new Set(["PAUSED", "COMPLETED", "FAILED"]);
const NOT_LIVE = new Set(["SUSPENDED", "COMPLETED", "RETIRED"]);

/** Seats that declared an interest in this event and are live enough to be woken for it. */
function eligibleSeats(m: TestMesh, event: MeshEvent): string[] {
  const sched = m.scheduler as unknown as SchedulerView;
  if (!sched.isRunning()) return [];
  if (event.type === "message.sent") return [];
  const st = m.kernel.state;
  const goal = st.activeGoalId ? st.goals.get(st.activeGoalId) : undefined;
  if (!goal || HALTED.has(goal.status)) return [];
  const out: string[] = [];
  for (const rec of st.agents.values()) {
    const id = rec.definition.id;
    if (id === "human" || id === event.actorId) continue;
    if (NOT_LIVE.has(rec.state.lifecycle)) continue;
    if ((rec.definition.interests ?? []).some((p) => interestMatches(p, event.type))) out.push(id);
  }
  return out;
}

/**
 * Wrap `handleEvent` and classify every eligible pair the moment the scheduler
 * is done with its event. The classification has to happen THEN and not at the
 * end of the test: a queue entry is dispatched and gone within the same tick,
 * and a coalesced wake leaves no record under its own event id afterwards.
 *
 * `publicOnly` restricts the outcome surface to what an operator can actually
 * read (`GET /scheduler` serves `queueSnapshot`, `queueWaits`, `pending` and
 * `triagedAwayCount`; the turn ring and the policy refusal are both served
 * too). A stash lives in a private map that nothing exposes, so under this
 * surface a stashed wake is indistinguishable from a lost one.
 */
function installWakeLedger(m: TestMesh, opts: { publicOnly?: boolean } = {}) {
  const sched = m.scheduler as unknown as SchedulerView;
  const pairs: Pair[] = [];
  let inFlight = 0;
  const original = sched.handleEvent.bind(sched);
  const turnIds = (): Set<string> => new Set(m.supervisor.getRecentTurns(1000).map((t) => t.turnId));
  const dropped = (): number => Object.values(sched.suppressedWakes()).reduce((a, b) => a + b, 0);

  sched.handleEvent = async (event: MeshEvent): Promise<void> => {
    const seats = eligibleSeats(m, event);
    if (seats.length === 0) return original(event);
    inFlight++;
    const turnsBefore = turnIds();
    const refusalBefore = new Map(seats.map((s) => [s, sched.lastActivationRefusal(s)]));
    const droppedBefore = dropped();
    try {
      await original(event);
    } finally {
      const newTurns = m.supervisor.getRecentTurns(1000).filter((t) => !turnsBefore.has(t.turnId));
      const queued = new Set(sched.queueSnapshot().map((q) => q.agentId));
      let counted = dropped() - droppedBefore;
      const unexplained: Pair[] = [];
      for (const seat of seats) {
        const pair: Pair = { eventId: event.id, eventType: event.type, seat };
        if (newTurns.some((t) => t.agentId === seat && t.reason.eventId === event.id)) pair.outcome = "activated";
        else if (queued.has(seat)) pair.outcome = "queued";
        else if (!opts.publicOnly && sched.wakeAfterTurn.has(seat)) pair.outcome = "stashed";
        else if (sched.lastActivationRefusal(seat) !== refusalBefore.get(seat)) pair.outcome = "denied";
        else unexplained.push(pair);
        pairs.push(pair);
      }
      // A drop counter is global, not per seat, so it can only vouch for as
      // many pairs as it moved by — and only for pairs nothing else explains.
      for (const pair of unexplained) {
        if (counted <= 0) break;
        pair.outcome = "counted";
        counted--;
      }
      inFlight--;
    }
  };

  return {
    pairs,
    /** Resolves once every wrapped `handleEvent` has returned. */
    async drained(): Promise<void> {
      await settle(20);
      await waitFor("the scheduler to finish every event it was handed", () => inFlight === 0, 5000);
    },
    missing(): Pair[] {
      return pairs.filter((p) => p.outcome === undefined);
    },
    outcomes(): Set<Outcome> {
      return new Set(pairs.flatMap((p) => (p.outcome ? [p.outcome] : [])));
    },
  };
}

function report(missing: Pair[]): string {
  return (
    `${missing.length} (event, seat) pair(s) matched a declared interest and produced no activation, ` +
    `queue entry, stash, denial or drop counter:\n` +
    missing.map((p) => `  - ${p.eventType} ${p.eventId} → ${p.seat}`).join("\n")
  );
}

/** A turn that stays in flight until the test opens it: the seat is busy for exactly as long as we say. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

const DONE = { operations: [{ op: "done" } as MeshOp] };

/**
 * Five seats and a trigger. `src` declares nothing and is the actor of every
 * scripted event, so it is never its own candidate. Every mesh here runs on a
 * ManualClock that is never advanced: no wait-sweep nudge, stale-mail floor or
 * turn timeout can fire, so every wake observed is one an EVENT caused.
 */
function seats(extra: Partial<Record<string, Partial<AgentSpec>>> = {}): AgentSpec[] {
  const base: AgentSpec[] = [
    { id: "lead", role: "architect", interests: ["dependency.changed", "goal.escalated", "escalation.responded"] },
    { id: "dev", role: "developer", interests: ["dependency.changed", "design.question"] },
    { id: "qa", role: "qa", interests: ["dependency.changed", "goal.progress"] },
    { id: "ops", role: "devops", interests: ["dependency.*"] },
    { id: "src", role: "developer", interests: [] },
  ];
  return base.map((a) => ({ ...a, ...(extra[a.id] ?? {}) }));
}

const CONTACTS = { lead: [], dev: [], qa: [], ops: [], src: [] };

async function emit(m: TestMesh, type: string, payload: Record<string, unknown>): Promise<void> {
  await m.kernel.emit(type as MeshEvent["type"], payload, { actorId: "src" });
}

test("wake invariant: every recorded outcome kind is seen, and every eligible pair has one", async () => {
  // The control: a mesh in which every per-seat path that DOES leave a trace
  // is exercised at once. `dev` takes the one peer slot; `lead` queues behind
  // the ceiling; `ops` is a service seat, which the policy refuses for
  // anything but a request (a recorded DENY); and a triage rule drops the
  // event for `qa`, which the IGNORE tally records. If this ever fails, the
  // ledger is broken or a recorded path went silent.
  const clock = new ManualClock(Date.now());
  const m = await makeMesh({
    agents: seats({ ops: { mode: "service" } }),
    mayContact: CONTACTS,
    startup: [],
    maxActiveAgents: 1,
    clock,
    triage: { mode: "heuristic", rules: [{ agent: "qa", event: "dependency.changed", ignore_if_text_matches: ["README"] }] },
  });
  const held = gate();
  try {
    const s = stub(m);
    s.setScript("dev", async () => {
      await held.wait;
      return DONE;
    });
    for (const id of ["lead", "qa", "ops", "src"]) s.setScript(id, async () => DONE);
    const ledger = installWakeLedger(m);

    await emit(m, "dependency.changed", { files: ["README.md"], summary: "docs bump" });
    await ledger.drained();

    assert.deepEqual(ledger.missing(), [], report(ledger.missing()));
    assert.equal(ledger.pairs.length, 4, "lead, dev, qa and ops all declared the event");
    assert.deepEqual(
      [...ledger.outcomes()].sort(),
      ["activated", "counted", "denied", "queued"],
      "each recorded path was actually taken, so a pass here is not four copies of one path",
    );
  } finally {
    held.open();
    await m.cleanup();
  }
});

test(
  "wake invariant: an interest event for a seat that is mid-turn leaves a trace",
  async () => {
    // `max_active_agents: 1` and one seat held mid-turn: the configuration the
    // live run had (3 slots, 8 seats) at its smallest. The second and third
    // events find `dev` busy; the other seats are already queued behind the
    // ceiling and are coalesced, which counts. Only `dev`'s pairs can vanish.
    const clock = new ManualClock(Date.now());
    const m = await makeMesh({ agents: seats(), mayContact: CONTACTS, startup: [], maxActiveAgents: 1, clock });
    const held = gate();
    try {
      const s = stub(m);
      s.setScript("dev", async () => {
        await held.wait;
        return DONE;
      });
      for (const id of ["lead", "qa", "ops", "src"]) s.setScript(id, async () => DONE);
      const ledger = installWakeLedger(m);

      await emit(m, "dependency.changed", { files: ["package.json"], summary: "lodash 4 → 5" });
      await ledger.drained();
      await emit(m, "design.question", { question: "which lodash API replaces _.pluck?" });
      await ledger.drained();
      await emit(m, "dependency.changed", { files: ["package-lock.json"], summary: "lockfile" });
      await ledger.drained();

      assert.ok(ledger.pairs.length >= 8, `the scenario must actually produce eligible pairs (got ${ledger.pairs.length})`);
      assert.deepEqual(ledger.missing(), [], report(ledger.missing()));
    } finally {
      held.open();
      await m.cleanup();
    }
  },
);

test(
  "wake invariant: an interest event arriving while the goal is ESCALATED leaves a trace",
  async () => {
    // Escalation is the moment the mesh is waiting on a human, and every
    // interest event that lands meanwhile is gone for good: the scheduler does
    // not queue it for after the response, and nothing records that it was
    // skipped. The `goal.escalated` wake itself is let through and the policy
    // refuses it with `goal-halted` — which is recorded — so the gap is exactly
    // the OTHER events. Triage is on here as well, to show a counter that does
    // exist is not the one that moves.
    const clock = new ManualClock(Date.now());
    const m = await makeMesh({
      agents: seats(),
      mayContact: CONTACTS,
      startup: [],
      maxActiveAgents: 2,
      clock,
      triage: { mode: "heuristic", rules: [{ agent: "qa", event: "dependency.changed", ignore_if_text_matches: ["README"] }] },
    });
    try {
      const s = stub(m);
      for (const id of ["lead", "dev", "qa", "ops", "src"]) s.setScript(id, async () => DONE);
      const ledger = installWakeLedger(m);

      await emit(m, "goal.escalated", { reason: "operator decision needed on the lodash upgrade" });
      await ledger.drained();
      await emit(m, "dependency.changed", { files: ["package.json"], summary: "lodash 4 → 5" });
      await ledger.drained();
      await emit(m, "design.question", { question: "pin or float?" });
      await ledger.drained();

      assert.equal(m.kernel.state.goals.get(m.kernel.state.activeGoalId ?? "")?.status, "ESCALATED");
      assert.ok(ledger.pairs.length >= 5, `the scenario must actually produce eligible pairs (got ${ledger.pairs.length})`);
      assert.deepEqual(ledger.missing(), [], report(ledger.missing()));
    } finally {
      await m.cleanup();
    }
  },
);

test(
  "wake invariant: an observational event suppressed as redundant leaves a trace",
  async () => {
    // `goal.progress` for a seat with no mail, no task and no owed request:
    // the scheduler decides, reasonably, that the wake would buy nothing. The
    // decision may stand; what the invariant forbids is making it silently —
    // `triagedAway` exists precisely because an unrecorded drop is
    // indistinguishable from a seat that was never subscribed.
    const clock = new ManualClock(Date.now());
    const m = await makeMesh({ agents: seats(), mayContact: CONTACTS, startup: [], maxActiveAgents: 1, clock });
    try {
      const s = stub(m);
      for (const id of ["lead", "dev", "qa", "ops", "src"]) s.setScript(id, async () => DONE);
      const ledger = installWakeLedger(m);

      await emit(m, "goal.progress", { completed: 0, total: 1, ratio: 0 });
      await ledger.drained();
      await emit(m, "goal.progress", { completed: 0, total: 1, ratio: 0 });
      await ledger.drained();

      assert.equal(ledger.pairs.length, 2, "qa declared goal.progress, once per event");
      assert.deepEqual(ledger.missing(), [], report(ledger.missing()));
    } finally {
      await m.cleanup();
    }
  },
);

test(
  "wake invariant: every accepted outcome is readable on the scheduler's public surface",
  async () => {
    // The only outcome the ledger above has to reach into a private field for.
    // `dev` is mid-turn and has mail stashed for after it; an interest event
    // for `dev` is then coalesced into that stash — a real outcome, so the
    // internal ledger passes. Read the way an operator reads the scheduler,
    // the same pair is simply absent: nothing on `GET /scheduler` says `dev`
    // is owed another turn.
    const clock = new ManualClock(Date.now());
    const m = await makeMesh({ agents: seats(), mayContact: { ...CONTACTS, src: ["dev"] }, startup: [], maxActiveAgents: 1, clock });
    const held = gate();
    try {
      const s = stub(m);
      s.setScript("dev", async () => {
        await held.wait;
        return DONE;
      });
      for (const id of ["lead", "qa", "ops", "src"]) s.setScript(id, async () => DONE);
      await m.supervisor.activateAgent("dev", { kind: "manual" });
      await settle(20);
      await m.supervisor.humanSend(["dev"], "INFORM", { note: "mail while you work" });
      await settle(20);
      assert.ok(
        (m.scheduler as unknown as SchedulerView).wakeAfterTurn.has("dev"),
        "precondition: the mail wake is stashed behind dev's running turn",
      );

      const internal = installWakeLedger(m);
      await emit(m, "design.question", { question: "which lodash API replaces _.pluck?" });
      await internal.drained();
      assert.deepEqual(internal.missing(), [], "the pair IS accounted for — by the stash");

      // Same scenario, same event shape, read through the public surface only.
      (m.scheduler as unknown as { handleEvent: unknown }).handleEvent = Object.getPrototypeOf(m.scheduler).handleEvent;
      const publicOnly = installWakeLedger(m, { publicOnly: true });
      await emit(m, "design.question", { question: "and _.where?" });
      await publicOnly.drained();
      assert.deepEqual(publicOnly.missing(), [], report(publicOnly.missing()));
    } finally {
      held.open();
      await m.cleanup();
    }
  },
);
