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
5. ~~Layer B authored copy — `ignore_if_text_matches` counter first.~~
   **Done (session 9)** — diagnosed and shipped in one session; see the step-5
   section at the bottom for both. The rest of Layer B is untouched: the three
   `concurrency.*` keys already have the capacity strip, but `triage.mode`,
   `activation.strategy`, `agents.<id>.interests`, the circuit-breaker park and
   the 8 `timeouts.*` keys do not.
6. Open question raised by that diagnosis, and it may outrank 5: two keys are
   **inert but editable in the Designer** — `scheduling.activation.strategy`
   (zero read sites) and the `TriageModel` branch (zero construction sites).
   A setting that does nothing is worse than a silent drop, because the operator
   believes they fixed something. Same section, last subheading.

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

---

## Step 5, piece 1 — `ignore_if_text_matches` counter (session 9: diagnosed AND shipped)

**Green: 1213/1213 tests, both typechecks `ok`, lint clean on the touched set
apart from the pre-existing `rules-of-hooks` error at `Overview.tsx:241`.**
All six touch points, as scoped in the diagnosis below:

- `scheduler/src/index.ts` — `private triagedAway = 0` in the counter cluster,
  incremented in the IGNORE branch of `handleEvent`, zeroed in
  `resetMissionState`, read by a new `triagedAwayCount()` beside `queueWaits()`.
- `core/src/ports.ts` — `triagedAwayCount?()` on `SchedulerPort`, optional for
  mocks exactly as `queueWaits?()` is.
- `mesh-server/src/index.ts` — `triagedAway` on the `/status` scheduler literal.
- `views/Overview.tsx` — `const triagedAway` beside `capacityWaits`, plus a
  neutral-grey strip placed **below the entire banner chain** (after the
  `All quiet` ternary, before `<Delivered>`), gated on
  `!st.uiOnly && triagedAway > 0`. Outside the chain by construction, not just
  by wording — that was the C5 decision's one structural consequence.
- `tests/scheduler/triage-counter.test.ts` — 4 tests.

**The dead-by-default finding is now a test, not a note.** "reads 0 in a default
config, however many events flow" asserts both that the count stays 0 and that
the very event a rule would have dropped woke the agent instead. If anyone later
flips `triageMode`'s default to `heuristic`, that test fails and names what they
changed. Empirically confirmed, not just grepped.

Neutral grey was deliberate, matching the capacity strip: the operator
configured this filtering on purpose, so `warn` would cry wolf on their own
working config. The strip's job is to stop a filtered event looking like a
broken agent, not to report a fault.

Diagnosis follows, unchanged — it is the design record for the remaining pieces.

## Step 5 diagnosis — `ignore_if_text_matches` (session 9)

### Reachability: DEAD BY DEFAULT — and the opposite shape to session 8

Verified first-hand. The anchor is `packages/scheduler/src/index.ts:224`, a bare
`continue` inside `handleEvent` (`:179`). Two short-circuits sit above the rule
scan in `triage()` (`:265-284`):

- `:266` — `if (this.config.scheduling.triageMode === "off") return "ACT";` and
  the default **is** `"off"` (`packages/config/src/index.ts:610`, `?? "off"`).
  The Designer's new-mesh seed agrees: `designer/model.ts:170` →
  `triage: { mode: "off", rules: [] }`.
- `:277` — returns `"SKIM"` when no rule matches, and `triageRules` defaults to
  `[]` (`config/src/index.ts:611`).

Reaching `:224` therefore needs an operator to do **both**: set
`triage.mode: heuristic` *and* add a rule with a non-empty
`ignore_if_text_matches`. The scheduler documents this itself at `:217-219`
("the default mode is `off` — which returns ACT for everything").

**This is not the session-8 failure and the difference decides the session.**
`{ kind: "fail" }` was dead because **no producer exists**. Here the producer
exists, is fully wired, has a shipping UI authoring path
(`designer/panels/MeshPanel.tsx:206-207`, read directly), and is **live in a
shipped example**: `examples/greenfield/mesh.yaml:79,86` sets `mode: heuristic`
with `ignore_if_text_matches: ["README", "docs/"]`. The other four examples
carry no `triage` key at all. So the branch is two keys from firing and any
operator who started from greenfield is already past both.

Dead by default ≠ dead. Do not cancel step 5 over this — but **gate the render
on `count > 0`**, which makes it free for every default install and exact for
the self-selected operators who can actually be bitten.

### The drop is total

`:224` emits nothing, logs nothing, queues nothing. The whole
`packages/scheduler/src/index.ts` has no logger, no `console.*`, and no kernel
emit — it *cannot* trace anything. Contrast the policy refusal path at `:366`,
which does record (`lastRefusal` / `reportedRefusal`, `:81-88`). Refusals are
traced; triage drops are not. Nearest traceless sibling is
`isRedundantObservation` (`:222`, helper `:247-262`) — hardcoded, no config key,
out of scope here.

### Channel C5 — cumulative + polled, and it is NOT a block

The four shipped channels, plus the new one. Decided explicitly, not by analogy:

| # | Shape | Clears? | Blocks? | Pipe |
|---|-------|---------|---------|------|
| S2 | standing, event-derived, live | on answer | yes | `message.rejected` → `standingBlocks` |
| S3a | self-clearing, polled | within a turn | yes | `queueWaits()` → capacity strip |
| S3b | standing, polled | never | yes | `liveMissionVerdict` → halt banner |
| S4 | standing, event-derived, terminal | never | n/a — over | `terminalMissionVerdict` → COMPLETED/FAILED/PAUSED |
| **C5** | **cumulative, polled** | **never** | **NO** | **counter field → its own conditional strip** |

C5 is the first surface in this work that is **not** about being stopped. A
triaged-away event refuses nothing, queues nothing and waits for nothing; the
mesh may be in perfect health. It is **silent loss**, and the count only grows.

Consequences, all load-bearing:
- **No event per drop.** Same reasoning that sent capacity waits to S3 in
  session 6: one event apiece would bury the log. Poll it.
- **Not in the "why you are stopped" banner chain.** A mesh that triaged 40
  events away may not be stopped at all. Putting it there would cry wolf and
  would make the halt banner's "it will not clear on its own" ambiguous.
- **Per-mission, not per-process.** `resetMissionState` (`:167-178`) zeroes
  every counter; the new one goes in there. "40 events triaged away" from three
  missions ago is not actionable, so "cumulative" means *within the mission*.
  Say so in the copy or the number is a riddle.

### Copy — the third item-3 sentence

The register's two existing item-3 sentences are opposites and must stay so.
The counter needs a third position, and there are two axes, not one:

- capacity strip — transient, blocking: *"this normally clears within a turn"*
- halt banner — permanent, blocking: *"it will not clear on its own, and the
  mission stays parked until it is answered"*
- **triage strip — permanent, NOT blocking:** *"nothing is blocked and nothing
  is waiting … they will not be retried"*

Full draft, all four register moves:

> **{n} events triaged away — no agent saw them**
> Nothing is blocked and nothing is waiting: a triage rule matched these events
> and dropped them before anything was queued. They will not be retried, so an
> agent that looks idle may simply never have been told.
> The rules live in **Designer → Mesh panel → Triage**. Changes take effect on
> the next mesh boot, not on this one.

It is the only strip in the set whose first move says *nothing is wrong*. That
is exactly why it must not share the banner chain.

### Remedy verified — the session-6 registry finding was a misleading true negative

`scheduling.*` is absent from `UPDATE_KEYS` and `HOST_CONFIG_EFFECTS` because
**both registries govern `host.yaml` only** (`packages/projects/src/host-config.ts:232`,
`:252`; the `UPDATE_KEYS` gate is `PUT /api/host/config`,
`apps/mesh-server/src/host.ts:627`). Their absence implies nothing about mesh
editability. The real answers:

- **Editable: yes, and a full UI already exists** —
  `designer/panels/MeshPanel.tsx:189` "Triage — the cheap pre-filter before
  waking peers": mode `:191`, per-rule agent `:199`, event `:203`,
  `ignore_if_text_matches` `:206-207`, `act_if_text_matches` `:208`.
  Persisted by `Designer.tsx` → `POST /config/save`
  (`apps/mesh-server/src/index.ts:1663`, write `:1704`).
- **Live: no.** The scheduler holds config as a constructor-assigned field
  (`scheduler/src/index.ts:100`), built once at `apps/mesh-server/src/index.ts:301`.
  Rules are re-read per decision (`:274`) but off a boot object that is never
  replaced. `configDrift` syncs only goal/criteria/seat/run.budget — no
  scheduling kind. So: **next mesh boot, not this one.** This matches the tier
  brief's "config is a boot seed, not a mirror" and it is now confirmed for
  `scheduling.*` specifically, which session 6 could not claim.
- Do **not** point the copy at `views/HostSettings.tsx` — that screen edits
  `host.yaml`.

### Landing site — what one counter field touches

Six places, all identified:
1. field decl beside the other private counters, `scheduler/src/index.ts:65-78`
2. increment at `:224`
3. a getter beside `queueWaits()` (`:452-459`)
4. the optional port decl, `packages/core/src/ports.ts:128` (`queueWaits` is
   optional there — follow that pattern)
5. the `/status` literal, `apps/mesh-server/src/index.ts:1513` —
   `scheduler: { pending, running, queue, waits }`. **Untyped inline object**;
   the `...st` spread (`core/src/supervisor.ts:5861-5878`) has no `scheduler`
   field, and `Overview.tsx:250` reads it as `any`. Adding a field needs no
   protocol change, which is why this is cheap — and why nothing type-checks it.
6. `resetMissionState` (`:167-178`), per the per-mission decision above

### Two NEW dead paths found while answering the above

Both are the session-8 shape — declared, plumbed, exposed, no consumer — and
both are arguably higher-value than the counter because they are **config lies
in the default UI**, not silent losses in an opt-in path:

- **`scheduling.activation.strategy` is inert.** Declared
  (`config/src/index.ts:126`, `:300`), defaulted (`:608`), in the JSON schema
  (`protocol/src/schemas.ts:388`), and **editable in the Designer**
  (`MeshPanel.tsx:121-123`, "events + a router pass"). Grep for `.strategy`
  across `packages` + `apps` finds **zero read sites** — `triage()` keys off
  `triageMode` alone. The only other mutation is a test poke at
  `scheduling.strategy` (`tests/scheduler/scheduler.test.ts:184`), a path that
  may not even match the resolved shape (unconfirmed, and it proves no
  coverage either way). **The survey's own Layer B row for this key is wrong**:
  it cannot cause "agent never activates", because nothing reads it. Correct
  surface is S1 — "this setting currently has no effect" — or delete the key.
- **`TriageModel` has zero construction sites.** Interface at
  `scheduler/src/index.ts:28-29`, optional ctor arg `:104`, consumed `:267-269`,
  threaded from `apps/mesh-server/src/index.ts:56` → `:301`. Nothing anywhere
  constructs one, so the model branch of `triage()` is unreachable and
  `mode: heuristic` always means the rule scan.

Neither was chased further. Recorded so the next session greps construction
sites before believing either.
