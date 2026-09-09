# Agent Mesh — session handoff (2026-09-09, reopen-loop session)

## Task C-loop: FIXED (suite 280/280 green — 278 baseline + 2 new)

Symptom: operator reported the mesh "still stuck" after the Task A/B fixes.
It was not stuck — it was LOOPING. Live log (2939 events) held **6
`goal.completed` against 5 `goal.reopened`**, every round re-citing the same
artifacts: `TrackBench-Requirements-v2/1` accepted 4x, the same architecture
approved 6x, `TrackBench-MVP-CodePatch/1` merged 3x. Five rejections, same MVP
back each time.

Root cause: `goal.reopened` reset criteria to UNSATISFIED but KEPT the evidence
trail, and nothing distinguished evidence from the rejected round from evidence
produced in answer to the rejection. Agents re-cited, criteria flipped
EVIDENCED, watchdog completed again within minutes.

Two independent gates, both required:

13. **Identity gate.** New `AcceptanceCriterion.rejectedEvidence?: string[]`
    (`packages/protocol/src/types.ts`). The `goal.reopened` reducer
    (`packages/core/src/projections-goal.ts:88`) snapshots every rejected
    criterion's artifact URIs into it; `markCriterionEvidence`
    (`packages/core/src/supervisor.ts:1346`) refuses those URIs and writes an
    audit line. A NEW version supersedes normally, so a mission can still finish.
14. **Recency gate.** New `Goal.reopenedAt?: string`, stamped by the same
    reducer. `termination.ts:329` now requires each mandatory criterion to hold
    at least one piece of evidence recorded AFTER `reopenedAt` before it will
    emit `complete`.

Gate 14 is not redundant: ref-less evidence (`kind: "approval"`,
`"quality-pass"` — emitted at `supervisor.ts:1515/1542/1549` with no
`artifactRef`) is invisible to gate 13. That is exactly the path that
re-approved `architecture-approved` six times.

Tests: `tests/integration/reopen-loop.test.ts` (2). Both mutation-checked —
each fix reverted alone, confirming only the matching test fails.

RESTART REQUIRED for the running :7430 mission (its process runs the 14:30 build).

### Still open after this session
- Findings 6, 7, 12 (unchanged): zombie `agent.restarted` after
  `sessions.clear()`; orphaned mail on a stopped scheduler; `agent.failed`
  errors reduced to a bare URL (`"http://127.0.0.1:4100"`, 9x in the live log).
- **NEW 15.** `human` agent never leaves lifecycle `STARTING`.
- **NEW 16.** Post-completion ops are hard-rejected with no path forward:
  `merge: artifact is VERIFIED, must be MERGEABLE` (2x) and
  `approve: illegal artifact transition document:READY_FOR_REVIEW -> APPROVED`
  (2x). The artifact state machine has no route out of `VERIFIED` /
  `READY_FOR_REVIEW` on a reopened mission, so the agents that CAN supersede
  are blocked from doing it. Likely the next real blocker now that the loop is
  closed.
- **NEW 17.** `pm` and `architect` burned their final turns writing nothing
  (`⚠ all 1 ops rejected (wait|done|respond: mission is COMPLETED)`) then
  parked WAITING. Turns that can only be rejected should not be scheduled.

---

# Agent Mesh — session handoff (2026-09-09, later session)

## Task B: FIXED (suite 277/277 green — 270 baseline + 7 new)

`reopenGoal()` (`packages/core/src/supervisor.ts`) hardened; findings 8–11 closed.

8. **Explicit activation.** `activateAgent` takes an `opts.explicit` override
   (still defaulting to `kind === "manual"`), and reopen passes `explicit:
   true`. A reopen is an operator action, so it carries operator authority past
   the scheduler's two quiet-refusal gates (stopped scheduler, backoff parking).
9. **Honest `revived`.** The lifecycle is read back from the projection after
   the emit instead of trusting a `.catch()`-swallowed promise. Refused revives
   go to a new `notRevived[]`; the failure is also written to the audit line.
   Every previously-COMPLETED agent lands in exactly one of the two lists.
10. **ESCALATED → reopen.** Accepted by both `reopenGoal` and the
    `goal.reopened` reducer. An escalated mission is halted by its OPEN cards,
    not by a verdict, so reopen answers them (`escalation.responded` — a human
    decided, so NOT `auto_resolved`) and clears stall tracking; otherwise the
    next watchdog tick re-derives `stalemate` and re-escalates within a second.
    Criteria handling differs by design: a COMPLETED/FAILED mission had its
    verdict rejected so mandatory criteria reset, but an ESCALATED one was
    never judged, so accepted work survives unless `criteria` names it.
11. **`resetMissionState()` is called**, before `start()` (clearing the queue
    under a live pump would drop the activations we are about to make).

Also: a reopen that woke nobody now returns a `warning` + `refused[]` instead
of a bare `ok: true`, and `POST /mission/reopen` surfaces all of it in `note`.

Tests: `tests/integration/reopen-hardening.test.ts` (7). Each was
mutation-checked — fixes reverted one at a time, confirming the matching test
fails. Note the finding-9 test must stub `kernel.emit` to reject `agent.resumed`
for one agent: COMPLETED → IDLE otherwise always succeeds, so without the stub
that test passes against the broken code too.

## Task A: FIXED earlier this session (suite 270/270 green)

1. **`mode`/`uiOnly` are now DERIVED** from `scheduler.isRunning()` instead of
   being standalone assignable fields (`apps/mesh-server/src/index.ts`, getters
   on the `MeshInstance` literal; new `Scheduler.isRunning()` at
   `packages/scheduler/src/index.ts:397`). Drift is now impossible: a mesh whose
   scheduler was stopped by `completeMission` reports `parked`, which is what
   the dashboard's parked affordances key off. `park()`/`reset()` no longer
   assign the fields.
2. **`goLive()` asks the scheduler, not the mode flag**
   (`apps/mesh-server/src/index.ts`): the old `self.mode === "live"` check made
   the start/continue button a no-op on exactly the mesh that could not run.
3. **Drawer wake checkbox defaults to `parked || missionOver`**
   (`apps/mesh-dashboard/src/drawers.tsx:36`). Dashboard bundle rebuilt
   (`npm run build:ui`).
4. **Completion drains in-flight turns** — new
   `Supervisor.drainInFlightTurns(30_000)`, awaited at the TOP of
   `completeMission()` (`packages/core/src/supervisor.ts`). Fixes both the bogus
   `agent.failed "http://127.0.0.1:410x"` steps AND finding 5: draining before
   the IDLE/WAITING sweep makes which-agents-freeze-at-COMPLETED deterministic.

**Rejected: waking human mail on a stopped scheduler.** Tried making
`message.sent` from `human` bypass the `if (this.stopped) return` guard in
`Scheduler.handleEvent`. It breaks the parked contract —
`tests/integration/parked-interaction.test.ts` asserts mail while parked queues
and does NOT auto-activate, because parked means the operator steps by hand.
`stopped` cannot distinguish operator-parked from completion-stopped, so the
guard stays as-is and the comment there now records why. The post-completion
case is covered by fix 1 (UI sees `parked`) + fix 3 (wake defaults on).

RESTART REQUIRED for the running :7430 mission to pick any of this up.

## Diagnosis this session (post-completion revive is broken)

Symptom reported: mission reached the goal, operator reopened the mesh to send
feedback, **nothing happened**. Confirmed against the live mission on :7430.

Live evidence at time of diagnosis: `/status` shows `goal.status = COMPLETED`,
`mode = live`, scheduler `pending 0 / running 0`, event log ends at seq 1077,
and **no `goal.reopened` event exists** — the reopen never reached the server
and the feedback message never woke anyone.

### Root cause: scheduler `stopped` and `instance.mode` diverge after completion

`completeMission()` (`packages/core/src/supervisor.ts:3542`) calls `shutdown()`
→ `scheduler.stop()` (`supervisor.ts:490`), which sets `scheduler.stopped =
true`. It never sets `instance.mode = "parked"`. The mesh therefore reports
`live` while nothing can run. Three failures fall out of that one divergence:

1. **Feedback goes nowhere.** `Scheduler.handleEvent`
   (`packages/scheduler/src/index.ts:150`) returns at `if (this.stopped)
   return;` — *before* line 156's deliberate carve-out that lets `message.sent`
   through on a halted goal. That comment ("Direct mail is never silenced by
   goal state") is dead code post-completion. Mail lands in the mailbox, zero
   activation requested.
2. **The escape hatch is off by default.** `POST /messages {wake:true}`
   (`apps/mesh-server/src/index.ts:908`) does work — `activateAgent(kind:
   "manual")` → `explicit:true` → passes the `stopped && !explicit` gate at
   `scheduler/src/index.ts:282`. But the drawer defaults the checkbox to
   `parked` (`apps/mesh-dashboard/src/drawers.tsx:36`), and `parked` is false
   because mode says `live`. Predicate should be `parked || missionOver`.
3. **Start/continue button is dead.** `POST /mission/boot` → `goLive()` returns
   `alreadyLive` when `mode === "live"` (`apps/mesh-server/src/index.ts:246`),
   so it no-ops on a mesh whose scheduler is stopped.

### Secondary findings (same shutdown path)

4. **Completion races in-flight turns.** seq 1053 `goal.completed` fired while
   `architect` (turn-67babf6dd1a8e80a) and `developer` (turn-f3825c689ca382cd)
   were mid-turn; `shutdown()` then killed every runtime session, surfacing as
   seq 1064/1069 `agent.failed error: "http://127.0.0.1:4100"` / `4101`. They
   show in `/steps` as `status: failed`. Watchdog (`supervisor.ts:3332`) has no
   in-flight check before completing.
5. **Which agents freeze at COMPLETED is nondeterministic.** `completeMission`
   marks only agents currently `IDLE`/`WAITING`. Observed: `qa`, `explorer` →
   COMPLETED; `pm`, `architect`, `developer` → IDLE; `tech-lead` → WAITING (it
   transitioned at seq 1061, *after* the sweep). Feedback addressed to `qa` or
   `explorer` is then silently refused — `activateAgent` returns `blocked:
   "agent completed with the mission"` (`supervisor.ts:1030`) and `runTurn`
   early-returns (`supervisor.ts:1943`). No event, no UI signal.
6. **Restarts resurrect sessions after shutdown cleared them.** seq
   1065/1070/1073 `agent.restarted` fire *after* `sessions.clear()`. Zombie
   sessions live under `stopping = true`.
7. **Orphaned mail.** `tech-lead`: `mailbox: 1`, WAITING, 2 open commitments,
   `oldestOpenAgeMs: 2938706` (~49 min). Nothing delivers it while the
   scheduler is stopped.

### Reopen path bugs (would bite even if the button had been clicked)

8. **Parked agents silently excluded.** `reopenGoal` activates via `kind:
   "recovery"`, which maps to `explicit: false` (`supervisor.ts:1035`).
   Circuit-breaker-parked agents are refused at `scheduler/src/index.ts:290`.
   Reopen can activate zero agents and still return `ok: true`.
9. **False `revived` list.** The `agent.resumed` emit is `.catch(() =>
   undefined)` (`supervisor.ts:1872`); illegal transitions are swallowed but the
   agent is still pushed into `revived[]`.
10. **`ESCALATED` has no reopen path.** `reopenGoal` accepts only
    COMPLETED/FAILED (`supervisor.ts:1850`); `resumeGoal` only lifts PAUSED. An
    escalated mission is stuck between them.
11. **Reopen does not clear scheduler mission state** — `strikes`,
    `nudgeCounts`, `deniedCounts` and backoff parking carry over from the run
    that just "finished". `resetMissionState()` (`scheduler/src/index.ts:136`)
    exists but reopen never calls it.
12. **Runtime errors are unusable.** Turn error is the bare string
    `"http://127.0.0.1:4100"` — no status code, no cause.

## Next tasks (fresh sessions, best-first)

A. ~~Fix the revive path~~ — DONE, see top of file. Findings 1–4 closed;
   finding 5 closed as a side effect of the drain.
B. ~~Harden reopen~~ — DONE (findings 8–11 closed). See "Task B" below.
C. **Findings 6, 7, 12 still open**: zombie `agent.restarted` after
   `sessions.clear()`; orphaned mail on a stopped scheduler; runtime errors
   reduced to a bare URL with no status code or cause.
D. Carried over from the previous session: convergence service (deterministic
   "who owes what" nudger replacing the LLM stall watchdog) and meta-session
   digest (`packages/core/src/context.ts` bundle).

## Unblocking the currently running mission

1. `curl -XPOST 127.0.0.1:7430/mission/reopen -H 'Content-Type: application/json' -d '{"reason":"<feedback>"}'`
2. `curl -XPOST 127.0.0.1:7430/messages -H 'Content-Type: application/json' -d '{"to":["tech-lead"],"type":"INFORM","payload":{"note":"..."},"wake":true}'`

Avoid `qa` and `explorer` as recipients until step 1 revives them.

---

# Previous session (2026-09-09, decision-debt cluster)

## Done
1. **artifact-by-name resolution** (kernel) — `resolveArtifactRef` in
   `packages/core/src/supervisor.ts` now falls back to fuzzy name lookup for
   transition/approve/reject/veto/block. Test: `tests/policy/artifact-by-name.test.ts`.
2. **UI UTC clock bug** — `apps/mesh-dashboard/src/components.tsx:50` rendered
   raw `timestamp.slice(11,19)` (UTC); now `toLocaleTimeString` (local tz).
   Built into `apps/mesh-dashboard/dist`. Restart a `console` instance to see it.
3. **Reviewer prompt hardening** — `roles/tech-lead.md`: review turns must end
   with an approve/reject/block op, never a silent read.
4. **Final-answer contract (kernel, the big one)** —
   - Turn-end pin: agent that still OWES an inbound ask (`stillOwes(pr, id)`)
     ends WAITING, not IDLE (`packages/core/src/supervisor.ts`, turn-end tree).
   - `settleReviewAsks`: a verdict op (approve/reject/block on an artifact)
     discharges the per-debtor review asks pointing at that artifact, so an
     answering reviewer returns to IDLE (no false pin).
   - Scheduler already nudges the DEBTOR (not the asker) and escalates after
     MAX_NUDGES — silent reviewers now get nudged + escalated instead of the
     ask dying quietly.
   - Tests: `tests/policy/final-answer.test.ts` (silent → WAITING; verdict →
     IDLE + ask settled). Full suite 267/268 (only env-dependent
     `resume-storm` fails: live log 736 events vs frozen fixture >1000).

## State (live mission :7430, ~736 events)
- Chain fully unblocked after #1: architect created ADR + Architecture v1,
  requested review; tech-lead works the design gate; stall watchdog no longer
  needed for the name loop.
- RESTART REQUIRED to load #4: `npm run mesh -- console examples/line-follower-sim/mesh.yaml --port 7430`.
