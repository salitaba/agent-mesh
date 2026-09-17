# "Why you are stopped" — the ~35-key survey (design pass, no code)

Untracked scratch file. Companion to `NOTES-blocking-config-ui.md` session-log
item 4. **Design pass only — nothing here is implemented.** Written at a session
boundary, against the tree at `a91708c` plus the uncommitted working set.

## How to read this

Rows are anchored on **`ruleId` string literals and symbol names, never line
numbers.** The parent brief's line numbers went stale inside one commit; the
`ruleId` literals (`"max-activations"`, `"goal-halted"`, `"thread-budget"`) are
greppable, stable, and are what the code actually branches on. Grep the literal.

## The headline: this is a routing job, not 35 new banners

The survey's premise was that ~35 keys stop a mesh silently and each needs a
reason surfaced. That is true, but the fix is much smaller than it looks,
because **four surfacing mechanisms already exist and most keys just need
routing to the right one.**

| # | Surface | Fires when | Lives in | Precedent to copy |
|---|---------|-----------|----------|-------------------|
| **S1** | `/config/validate` errors + warnings | config save / boot | `packages/config/src/index.ts` | `warnNoStartupActivation` |
| **S2** | `message.rejected` event (`denied: true`, carries `reason` + `ruleId`) | an op is refused, live | `supervisor.denied()` | already emitted, **never rendered** |
| **S3** | Overview `status-strip` banner | live mesh state | `views/Overview.tsx` | the `ceilingHit` strip |
| **S4** | `verdictText` / `VERDICT_TEXT` | termination / escalation | `packages/protocol/src/catalog.ts` | `Escalations.tsx` synthesized cards |

Two structural facts that fell out of this and drive every row below:

**(a) The policy engine already writes the copy.** Every `DENY`/`DEFER`/
`ESCALATE` it returns carries a human-readable `reason` *and* a `ruleId` —
`` `max_activations 3 reached` ``, `` `thread budget exhausted (12/12)` ``,
`` `transition 'x' requires a,b; missing: b` ``. Nobody has to invent this text.
The work is transport, not authorship.

**(b) `VERDICT_TEXT` has the phrasing but fires at the wrong moment.**
`budget_exhausted`, `agent_budget_exhausted`, `thread_budget_exhausted`,
`max_events_exceeded`, `wall_clock_exceeded`, `stalemate` are all already
phrased for humans — but only in the *post-mortem*. The survey's whole
complaint is that the operator needs that text **while stopped**, not after the
mission dies. Same map, earlier call site. `Escalations.tsx` already calls
`verdictText` proactively for three synthesized cases, so the precedent exists.

## The one line that covers ~15 keys

```
packages/scheduler/src/index.ts   (grep: `decision.decision === "DENY"`)
    if (decision.decision === "DENY" || decision.decision === "DEFER") return false;
```

The policy engine builds a full `{decision, reason, ruleId}`, hands it to the
scheduler, and the scheduler **collapses it to a bare `false`.** Every
activation-level reason in Layer A dies here. It does not call `denied()`, so
unlike the op path there is no `message.rejected` either — the reason is not
merely unrendered, it is destroyed.

Fixing this one site (call `denied()`, or return the decision instead of a
boolean) puts ~15 of the ~35 keys onto S2 at once. **Do this first.** Most rows
in Layer A below are downstream of it and cost nothing extra once it lands.

Two sibling sites that *look* like the same shape:
- `capacityAvailable` — returns bare boolean, swallows all three concurrency keys.
- the `pump` queue scan (grep: `findIndex((q) => !this.isBusy`) — `idx < 0` breaks
  silently, combining busy + capacity + stopped into one invisible no-op.

> **CORRECTED in session 6 — they are NOT the same shape, and "worth doing in
> the same change" was wrong.** The DENY/DEFER collapse sits *inside*
> `requestActivation`, **before** the queue push: a refused agent was never
> queued, so "refused" is the right word and S2 is the right pipe. Both sites
> above are reached from the pump's scan, **after** the push: that agent **is
> queued** and merely has no slot. It resolves on its own when a turn finishes.
>
> Consequences, now implemented:
> - **No event per capacity block.** They clear constantly; one event apiece
>   would bury the log. S3 (live strip) was the correct assignment; S2 is not.
> - **`standingBlocks` cannot see these.** It derives from the event buffer and
>   keys on `message.rejected`, which a queue wait never emits. The strip reads
>   live `status.scheduler.waits` instead.
> - **Layer B got its own reason type** (`QueueWait` in `core/src/ports.ts`),
>   *not* a synthesized `PolicyDecisionResult`: no policy call happens here, and
>   `lastRefusal` is cleared on a successful queue push — which a capacity-
>   waiting agent has already had. Do not widen `PolicyDecisionResult` to fit.

---

## Layer A — policy-engine (`packages/policy-engine/src/index.ts`)

Reason text **already exists** for every row. Surface = S2 once the scheduler
stops discarding it. Effect: `DEFER` = will retry later, `DENY` = refused now.

| Key | Effect | `ruleId` anchor | Reason today | Surface |
|-----|--------|-----------------|--------------|---------|
| `agents.<id>.budget.max_activations` | DEFER | `max-activations` | full text, discarded | S2 + S3 |
| `budgets.agent.<id>` | DEFER | `budget` | full text, discarded | S2 + S4 (phrased) |
| `budgets.thread.tokens` | DEFER | `thread-budget` | full text, discarded | S2 + S4 (phrased) |
| `agents.<id>.mode: service` | DENY | `service-mode` | full text, discarded | S1 (design-time) |
| goal `PAUSED` | DEFER | `goal-paused` | full text, discarded | S3 (strip exists) |
| goal `ESCALATED`/`COMPLETED`/`FAILED` | DENY | `goal-halted` | full text, discarded | S3 (strip exists) |
| `policies.transitions.<x>.requires` | DEFER | *(gate name in text)* | full text + `missing:` list | **S1 + S2** |
| unresolved `BLOCK` on artifact | DENY | *(in text)* | full text | S2 |
| `policies.communication.*.may_contact` | DENY/REDIRECT/ESCALATE | `communication` | full text | S2 |
| `agents.<id>.capabilities` | DENY | `capabilities` | full text | S2 |
| `agents.<id>.authority` | DENY | `authority` | full text | S2 |
| `policies.rules[].deny.message_types` | DENY | *(rule id)* | full text | S2 |
| `policies.rules[].deny.capabilities` | DENY | *(rule id)* | full text | S2 |
| artifact ownership | DENY | `single-writer` | full text | S2 |
| review authority / verified-actor gates | DENY | `review-authority`, `verified-actor`, `qa-verified-actor`, `sec-verified-actor`, `release-accept-actor` | full text | S2 |

**`policies.transitions.<x>.requires` is the worst one and deserves S1.** An
unsatisfiable gate is a permanent deadlock that looks identical to "still
working". It is also **statically detectable at config time** — the validator
already walks the gates and reports tokens that can never match (grep:
`is not '<actor>.<kind>'` and `no agent has id or role`). That checker exists;
it just needs to be reachable from the settings UI, not only from boot.

---

## Layer B — scheduler (`packages/scheduler/src/index.ts`)

**No reason object exists anywhere in this layer.** Unlike Layer A, the text has
to be *authored*, not transported. This is the expensive layer.

| Key | Effect | Anchor | Reason today | Surface |
|-----|--------|--------|--------------|---------|
| `scheduling.concurrency.max_active_agents` | silent idle | `capacityAvailable` | **none** | S3 |
| `scheduling.concurrency.max_parallel_service_agents` | silent idle | `capacityAvailable` | **none** | S3 |
| `scheduling.concurrency.max_total_agents` | silent idle | `capacityAvailable` | **none** | S3 |
| `scheduling.triage.rules[].ignore_if_text_matches` | event dropped, **no card rendered** | `triage === "IGNORE"` | **none** | S3 |
| `scheduling.triage.mode` | triage off/heuristic | `triageMode === "off"` | **none** | S1 |
| `scheduling.activation.strategy` | agent never activates | `interest+triage` | **none** | S1 + S3 |
| `agents.<id>.interests` | never woken (no match) | interest match | **none** | **S1** |
| circuit-breaker park | non-explicit activations refused | `strikes`, `parkedUntil` | **none** | S3 |
| `stopped` + non-explicit | pump refuses | grep `this.stopped && !req.explicit` | **none** | S3 (strip exists) |
| `scheduling.timeouts.*` (8 keys) | idle / nudge, not block | `timeouts` | **none** | S1 (advisory) |

`ignore_if_text_matches` is the single most operator-hostile key in the
codebase: the event is dropped *before* anything is queued, so there is no card,
no queue entry, no log line — the agent simply never reacts and nothing
anywhere says why. It needs a counter at minimum ("N events triaged away").

The 8 `timeouts.*` keys are **idle-shaped, not block-shaped.** They change *how
long* you wait, never *whether* work happens. Recommend S1 advisory copy only —
putting them in a "why you are stopped" banner would cry wolf.

---

## Layer C — config / delegation

Blocks at parse time via defaults, then refuses at the op. Reasons **exist and
are good** at the refusal site (`opSpawnWorker`).

| Key | Effect | Anchor | Reason today | Surface |
|-----|--------|--------|--------------|---------|
| `delegation.allow` (default **false**) | `spawn_worker` refused | `delegation policy forbids worker spawning` | full text, routes through `denied()` | **S2 works today** |
| `delegation.max_depth` (default **0**) | refused | `max delegation depth N reached` | full text, **not** via `denied()` | S2 |
| `delegation.max_workers` (default **0**) | refused | `max concurrent workers (N) reached` | full text, **not** via `denied()` | S2 |
| `delegation.worker_budget_tokens` | worker starved | — | none | S1 |
| `startup.activate` empty | mesh opens idle | `warnNoStartupActivation` | **warning exists, good copy** | S1 ✅ |
| `startup.activate` unknown agent | boot error | grep `references unknown agent` | error exists | S1 ✅ |
| `agents.<id>.requires_approval` | capability gated | `requiresApproval` | — | **S4 — `Gates.tsx` already renders this** ✅ |
| `mesh.defaults.hard_actions.mode: enforce` | ops refused | `effectiveHardActions` | contract text in prompt | S1 |
| `agents.<id>.session.max_context_tokens` | context truncated | — | none | S1 |
| `bus.transport: typed-only` | prose turn → `unproductive` → breaker park | `transport` | **none** | **S1 + S3** |
| `bus.commitments.semantic: strict` | asks never discharge → stall | `semantic` | **none** | S1 |
| `budgets.auto_raise.enabled: false` | every exhaustion escalates | `auto_raise` | escalation carries it | S4 ✅ |
| `budgets.mission.*`, `budgets.task.tokens` | mission halt | — | — | S4 ✅ (phrased) |
| `policies.escalation.*` (3 keys) | escalation caps | — | none | S1 |

`bus.transport: typed-only` is a sleeper. A prose-only turn is reported
`unproductive` to the circuit breaker, so three of them **park the agent** —
an operator sees an agent go quiet with no indication that the cause was a
transport setting rather than the agent's own behaviour. Two layers away from
where it bites.

---

## Layer D — host config

Done in Tier 3, listed for completeness: `spend_ceiling_usd`,
`max_concurrent_turns`, `default_usd_per_mtok`, `model_prices`,
`project_memory_mb`. Surface S3 (the `ceilingHit` strip), already shipped.

## Layer E — hardcoded, not editable, but still "why you are stopped"

**The parent brief lists these as out of scope. That is correct for the
*editor* and wrong for *this* survey** — an operator stopped by a crash-loop
breaker needs to know it, even though they cannot change the number. Surface
them read-only; do not put them in a settings form.

- `CRASH_LOOP_THRESHOLD`, `CRASH_LOOP_WINDOW_MS`, `HEARTBEAT_TIMEOUT_MS`
  (`packages/projects/src/supervision.ts`)
- `STRIKE_LIMIT`, `PARK_MS` (`packages/scheduler/src/index.ts`)
- `MAX_NUDGES` (scheduler, stall watchdog)
- **`MISSION_HALTED_ALLOW_OPS`** (`packages/core/src/mission-guards.ts`) — new,
  see working-set note below.

## Copy register

Derived from the two best examples already in the tree — `warnNoStartupActivation`
and the `ceilingHit` strip. Both do the same four things, in order:

1. **State the condition in the operator's words**, not the code's
   ("Parked — the host hit its spend ceiling", not "ceilingTripped").
2. **Carry the live numbers** ("$53.33 against a ceiling of $50.00", "3/3").
3. **Say what will and will not help** — the ceiling strip explicitly says
   *"Continuing will not hold"*, which is the sentence that stopped it looking
   like a broken button.
4. **Name the remedy and where it lives.**

Copy that fails (3) is worse than no copy: it is what produced the original bug.

---

## Working-set note — one key is mid-change right now

The uncommitted diff (`packages/policy-engine`, `packages/core/mission-guards.ts`,
`packages/protocol/catalog.ts`) **removes the `goal-state` gate** that denied
every non-`ESCALATE` message while `ESCALATED`/`BLOCKED`, and moves halt
enforcement to `MISSION_HALTED_ALLOW_OPS` in `executeOp`.

Consequences for this table, already folded in above:
- `ruleId: "goal-state"` is **going away** — do not build a surface for it.
- Halt now blocks at the **op** layer, not the message layer, so it reaches
  `denied()` → S2. This is an improvement for surfacing.
- `MISSION_HALTED_ALLOW_OPS` is a new Layer E row: talking is allowed while
  halted, publishing and landing are frozen. An operator watching agents chat
  during a halt will reasonably think work is progressing. **Worth a banner.**

Re-verify this section before implementing; it was uncommitted at survey time.

## Not verified — do not rely on without checking

- The 8 `scheduling.timeouts.*` keys were classified from their doc comments in
  `RawMeshConfig`, not by reading their consumers. The idle-vs-block call is a
  judgement from those comments.
- `hard_actions` enforcement: the sites are known (`effectiveHardActions` in
  `projections-helpers`, `context`, `supervisor`) but I did not read the refusal
  text. Copy column is a guess.
- `policies.escalation.*` thresholds: schema read, consumers not traced.
- Inherited from the parent brief and still unchecked: `store.tsx` hash
  rewriting, the `confirm()` promise plumbing, `Escalations.tsx` `doRaise`.

## Open decisions carried forward (both the operator's, unchanged)

1. `model_prices` — `HOST_CONFIG_EFFECTS` says `live`, `UPDATE_KEYS` has no
   entry, PUT rejects it. Wire it in, or drop it from effects. They disagree.
2. `parkedByPolicy` — a child that crashes while parked and is auto-restarted by
   the supervision tree keeps its entry (that path skips the routes). Fix is
   ~3 lines: tag each entry with the child's `startedAt`, drop on mismatch.

## Next session

1. **`scheduler` DENY/DEFER → `denied()`.** One site, unlocks ~15 Layer A keys.
   Everything else is cheaper afterwards. Do not start anywhere else.
2. Render `message.rejected` where `denied: true` — S2 has no consumer at all
   today, so this is the missing half of step 1.
3. ~~`capacityAvailable` + the `pump` scan → reasons (Layer B concurrency).~~
   **Done (session 6)** — see the correction box above.
4. ~~Lift `verdictText` out of termination into the live banner path.~~
   **Done (sessions 7–8)** — halt banner from the open card
   (`liveMissionVerdict`), terminal banners from the event log
   (`terminalMissionVerdict`). See the channel note below.
5. Layer B authored copy — `ignore_if_text_matches` counter first.

## Two verdict channels, and why step 4 needed both (session 8)

A halt reads the open **card**: it can be answered and retired, so the banner
clears with it. A finished mission reads the **event**: the completion path
raises no card at all (`supervisor.ts` emits `goal.completed` and calls
`completeMission()`), and an event that never clears is correct for a state
that never needs to. Same `VERDICT_TEXT` table, two selectors, and
`goal.escalated` is deliberately excluded from the event one — it would give
the halt banner a second, permanent source that answering the card could not
clear.

**Two of the three terminal banners cannot light up today.** Both are wired and
both fall back to their original wording verbatim; neither is a claimed fix:

- `goal.failed` — `{ kind: "fail" }` (`termination.ts`, the union arm) has
  **zero construction sites**, so the emit guarded by `verdict.kind === "fail"`
  is unreachable. `FAILED` may therefore be an unreachable goal status too;
  not chased.
- `goal.paused` — its one emitter sends `reason: "user pause"`, free prose, not
  a `VERDICT_TEXT` key. The guard refuses it, which is right: phrasing it would
  mean *authoring* pause copy, which is step 5's job, not transport.

Same shape as the `backend_unreachable` limit recorded in the session log: the
phrasing exists, the producer does not. Do not "fix" either by loosening a
guard — find the producer, or author the copy in step 5.

Steps 1–2 are one commit and are most of the operator-visible win.
