# NOTES — `POST /approvals` bypasses the mission halt guard

Handoff from the session that fixed the `review_rounds` stalemate. Start cold from
this file; do not re-derive the diagnosis.

## DONE (this session, uncommitted)

Fixed the `deadlock:review_rounds` stalemate loop.

- `packages/core/src/supervisor.ts` — added **Phase 1b** to
  `reconcileDerivedEscalations` (retires a `review_rounds:*` primary card once its
  artifact reaches a settled status), plus a `reviewRoundsArtifactOf` helper
  mirroring `stuckRequestOf`. Added `isSettledArtifactStatus` to the imports.
- `tests/policy/termination.test.ts` — new test: an *unsettled* artifact keeps its
  card; a settled one does not.
- Verified: `tsc -p tsconfig.json` clean, `node --test "dist/tests/policy/*.test.js"`
  → 171/171 pass.

Why it works: retiring increments `retired`, which triggers the existing un-park at
`supervisor.ts:5334`, and Phase 2 then closes the derived "stalemate" summary via the
invariant *derived card OPEN ⟺ ≥1 supporting primary OPEN*.

Root cause it addressed: the round counter is only reset by an artifact reaching a
settled status (`packages/core/src/projections-artifact.ts:43`). Nothing retired a
primary card whose condition had healed, so answering the card left the count intact
and the next review request re-tripped the watchdog immediately.

## STATE

- Branch `feat/plan-visibility`. Nothing committed this session.
- Also modified before this session (untouched by it): `NOTES-blocking-reasons-survey.md`,
  `packages/policy-engine/src/index.ts`, `packages/scheduler/src/index.ts`, and a
  comment-only hunk in `supervisor.ts`.
- The mesh's live mission still has an open `deadlock:review_rounds` card for
  "Surface Design Spec". That is correct — the artifact is genuinely unsettled, so the
  question is live. Settling it now retires the card automatically.

## NEXT — the task this file is for

**`POST /approvals` never passes the halt guard.**

- `apps/mesh-server/src/index.ts:1254` calls `supervisor.recordDecision` directly.
- Agent ops go through `supervisor.executeOp`, where the halt check lives at
  `packages/core/src/supervisor.ts:4333` (allow-list `MISSION_HALTED_ALLOW_OPS`,
  `packages/core/src/mission-guards.ts:14`).
- `recordDecision` (`supervisor.ts:2129`) checks only for an active goal — no halt,
  no escalation check.
- `resolveActor` (`apps/mesh-server/src/auth.ts:79-88`) accepts any id present in
  `knownAgents` as `by`. So an agent-attributed verdict can land on an ESCALATED
  mission over HTTP.

Two candidate fixes: guard inside `recordDecision`, or make the route go through
`executeOp`. Prefer whichever keeps the human seat's existing total bypass
(`supervisor.ts:4315`) intact — the operator must still be able to decide on a
frozen mission.

## Constraints — read before editing

1. **Do not "fix" this by adding verdict ops to `MISSION_HALTED_ALLOW_OPS`.** It
   would be inert. Halted missions activate no seat at all —
   `tests/policy/mission-freeze.test.ts:57` asserts `activateAgent` refuses to wake
   anyone on a halted goal. The tech-lead escalation claiming "the quality gate is
   frozen" points at the wrong lever; the gate is unreachable because seats don't
   run, not because the op is refused.
2. `tests/policy/mission-freeze.test.ts:45` deliberately asserts `approve` is refused
   while ESCALATED, classified under "ops that move work". `reject`/`veto`/`block`
   are untested. That test encodes a design decision — argue with it, don't delete it.
3. `supervisor.ts:4321-4330` carries a comment recording an unresolved conflict
   between `NOTES-blocking-reasons-survey.md` (wants halted ops to emit an event) and
   `mission-freeze.test.ts` (asserts the rejection count does not move), flagged
   **"do not resolve it by editing either side"**. Leave it alone unless you are
   deliberately taking that decision on.

## Deferred (decided against this session)

- **Escalation-time detection.** When a goal flips to ESCALATED with an artifact in
  `UNDER_REVIEW`, that mission is already stuck; nothing says so until a watchdog
  notices. There is no mission-start preflight — all warnings compute at config
  load/validate/save, and `/health`/`/status` are liveness only. Blocker if it goes in
  `packages/config`: it imports only `protocol`, so it cannot see
  `MISSION_HALTED_ALLOW_OPS` in `core` without inverting an existing import edge.
  Either move that constant to `protocol` (which already owns the op catalog and the
  artifact machine) or write the check at the app layer — precedent at
  `apps/mesh-server/src/index.ts:1707`. Note also that config warnings are a bare
  `string[]` with no severity field (`packages/config/src/index.ts:574`), so a
  "this mission is deadlocked" notice likely needs a richer shape first.
- Duplicating a core constant into `config` as a literal is an established pattern
  (`packages/config/src/index.ts:1082`, for `HUMAN_AGENT_ID`) whose own comment records
  that it then **drifted**. Avoid.
