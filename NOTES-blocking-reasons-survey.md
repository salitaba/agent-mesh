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

## Working-set note — RE-VERIFIED, and it was wrong in one place

The diff has landed (`dbb598f`, "enforce a halt at the op guard, not the message
gate"): it **removed the `goal-state` gate** that denied every non-`ESCALATE`
message while `ESCALATED`/`BLOCKED`, and moved halt enforcement to
`MISSION_HALTED_ALLOW_OPS` in `executeOp`.

What held on re-verification:
- `ruleId: "goal-state"` is gone from live code — do not build a surface for it.
  It was **replaced, not deleted**: `goal-halted` (`policy-engine/src/index.ts`,
  in `evaluateActivation`) is the ruleId a halt carries now.
- Halt does block at the **op** layer (`supervisor.ts`, top of `executeOp`).

What did **not** hold — the claim this section told you to re-verify:
- "so it reaches `denied()` → S2. This is an improvement for surfacing" is
  **false**. The guard returns a bare `OpResult` — `{ ok, op, reason }`, no
  event emitted — and `OpResult` has no `ruleId` field, so a halt denial cannot
  structurally carry one. Moving the gate out of the message layer *lost* the
  surface rather than gaining it. **A halted op is S4 (silent), not S2.**

**The obvious fix is blocked by a deliberate decision — do not just apply it.**
Calling `denied()` from the op guard typechecks and reads correctly, but
`tests/policy/mission-freeze.test.ts:40-48` asserts the `message.rejected`
count **does not move** while frozen ("guard must refuse before the policy
layer emits rejections", "with no rejection event spam"). Three blocked ops
produce three events and it fails. So the silence is intentional: the guard is
on the hot path for the MCP bus, where a client can hammer refused ops and each
one would emit. Surfacing this needs a **dedupe**, not an emit — the shape
already in the scheduler (`lastRefusal` / `reportedRefusal`, one event per
agent per distinct refusal) is the precedent. Attempted and reverted; the
conflict is now recorded in a comment at the guard.

Why the allowlist is narrower in practice than it reads:
- `MISSION_HALTED_ALLOW_OPS` permits `escalate`/`send`/`wait`/`done`/`remember`/
  `read_artifact`. But `evaluateActivation` denies or defers **every** activation
  while halted, and `runTurn` breaks its op loop before the first op on a
  mid-turn halt. So on the prose/turn path no halted agent executes any op at
  all — the allowlist only takes effect on the **MCP bus**, which calls
  `executeOp` directly and never passes the activation guard.
- So "an operator watching agents chat during a halt" is reachable only for
  MCP-driven seats. The dashboard's "Mission is paused. Nothing is running."
  is accurate for turn-driven missions; **do not "fix" it** on the strength of
  the allowlist alone. Check how the mesh in question drives its agents first.
- `BLOCKED` was missing from `evaluateActivation`'s halted statuses (it is a
  real `GoalStatus`), so a BLOCKED mission let activations through to pay for a
  model call that then died at `runTurn`'s break with only an audit line. Added.

## Not verified — do not rely on without checking

- The 8 `scheduling.timeouts.*` keys were classified from their doc comments in
  `RawMeshConfig`, not by reading their consumers. The idle-vs-block call is a
  judgement from those comments.
- `hard_actions` enforcement: the sites are known (`effectiveHardActions` in
  `projections-helpers`, `context`, `supervisor`) but I did not read the refusal
  text. Copy column is a guess.
- `policies.escalation.*` thresholds: schema read, consumers not traced.
- Inherited from the parent brief and still unchecked: `store.tsx` hash
  rewriting, the `confirm()` promise plumbing.
- ~~`Escalations.tsx` `doRaise`~~ — **struck (session 11).** This row was stale,
  not the file. `NOTES-blocking-config-ui.md:56-72` already verified the raise
  path in session 2 (`doRaise(:578)` → `/budgets/raise` `:592`; `doCapRaise(:620)`
  → `/mission/limits` `:625`), and session 11 confirmed both still exist and are
  wired into all three card variants (`:694`, `:700`, `:709`). The file was
  carried as pending for seven sessions on the strength of this row alone. Do
  not re-add it; the config-ui note is the record.

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
6. ~~Open question: two keys are **inert but editable in the Designer** —
   `scheduling.activation.strategy` and the `TriageModel` branch.~~
   **Decided (session 10) — see the step-6 section at the bottom.** They are two
   different things: `strategy` is a real operator-facing lie and gets
   deprecate-plus-remove-the-affordance; `TriageModel` is an embedder extension
   seam and is left alone. **Decided AND shipped (session 10)** — all nine
   implementation items done, 1217/1217. See the step-6 "Shipped" subsection.
8. ~~**`scheduling.activation.max_activation_delay_ms` is inert too** — same
   block, same grade 3, also editable in the Designer, zero readers.~~
   **Done (session 10, second change)** — `<Num>` deleted, warning widened to
   `warnInertActivationKeys`, resolved field removed, designer stops seeding the
   block. `scheduling.activation` now has no readers at all. See the second
   "Shipped" subsection.
7. Merge `resolved.warnings` into the `/config/validate` response. Verified in
   session 10: the route never forwards them, so five config warnings have no UI
   at all, though the Designer already renders whatever it is sent. Own session —
   it changes what every existing mesh displays.

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

---

## Step 6 — `activation.strategy` is inert: the decision (session 10, diagnosis only)

Session 10 answered the open decision from session 9's last subheading and then
**stopped at the phase boundary — nothing implemented.** The decision below is
the deliverable; the implementation list is mechanical and pre-verified.

### The two "inert keys" are NOT the same thing — split them

- **`scheduling.activation.strategy` — CONFIRMED-DEAD, and an operator-facing
  lie (grade 3).** Zero read sites, verified exhaustively across
  `packages/ apps/ tests/ schemas/ scripts/ spec/ docs/ roles/`. The resolver
  *flattens* raw `scheduling.activation.strategy` → resolved
  `config.scheduling.strategy` (`config/src/index.ts:608`); the resolved field
  has zero reads too. Legal values `"interest" | "interest+triage"`, default
  `"interest"`. `triage()` (`scheduler/src/index.ts:281-291`) keys off
  `scheduling.triageMode` alone.
- **`TriageModel` — NOT dead in the same sense. Leave it.** It has real read
  sites (`scheduler/src/index.ts:283`, `:285`) and a clean pass-through:
  `BootstrapOptions.triageModel` (`mesh-server/src/index.ts:56`) → the only
  `new Scheduler(` in the repo (`:301`). Nothing in-repo constructs one, so the
  branch never runs *here* — but it is a **programmatic extension seam for
  embedders, invisible in the operator's UI.** No false affordance, nothing to
  warn about, nothing to delete. Grade 1 by the ladder, and intentional.
  Do not "fix" it. Stop carrying it as an open question.

### Verdict: `triage.mode` is the real switch. Deprecate `strategy` — do not wire it, do not delete it from the schema.

All three options in the session-10 brief are wrong as stated. Why:

- **Do NOT wire it.** Four of five shipped examples pin `strategy: interest`
  (`spring-boot:128`, `line-follower-sim:209`, `demo-stub:111`,
  `payment-api:264`); only `greenfield:77` has `interest+triage`. Wiring would
  mean any of those four that later adds triage rules gets them **silently
  ignored** — two switches for one behaviour, strictly worse than today.
- **Do NOT delete it from the schema.** The activation block is
  `additionalProperties: false` (`protocol/src/schemas.ts:384-392`,
  `schemas/mesh.schema.json:520`). Deleting the property turns all five
  examples, and **every config `mesh init` has ever written**, into a hard
  validation failure.
- **Warn — but strip the key from everything we generate first**, or the tool
  scolds the operator for its own output. `mesh init` writes
  `activation:\n    strategy: interest` today (`config/src/index.ts:1149`).

So: **accept-and-warn (deprecation), plus remove the affordance.** The grade-3
lie is fixed by deleting the Designer select, not by the warning — once the
select is gone the key cannot be set from the UI at all. The warning then serves
only hand-written YAML, whose authors are CLI/boot users who *do* see boot
warnings. That is why BOOT-ONLY (below) is sufficient here.

### S1 is boot-only — VERIFIED, and the survey's hope was wrong

`/config/validate` (`mesh-server/src/index.ts:1666`) builds its `warnings` array
from scratch at `:1678` and only ever fills it from `validateTransitionGates`
(`:1683-1685`) and missing prompt files on save (`:1715`).
**`resolved.warnings` is never merged in.** The Designer *does* render what it is
sent — `result.json.warnings` → `{level:"warn"}` advice (`Designer.tsx:458-462`)
→ `HealthStrip` (`:907`) + `AdvisoryList` (`:913`), reachable in the normal
designer tab — so the UI half already exists; the server simply does not forward.
`doSave` (`:789-828`) ignores `json.warnings` entirely. Boot prints:
`mesh-cli/src/index.ts:285` (boot preflight), `:422` (`mesh validate`).

**Stale comment, now provably false:** `Designer.tsx:469-471` claims the
"nobody boots" warning "arrive[s] back through `serverWarnings` above". It does
not. Fix or delete that comment when you touch this.

**Separate change, large payoff, NOT this one:** merging `resolved.warnings`
into the `/config/validate` response would light up **five** config warnings in
the existing HealthStrip for the first time (`warnNoStartupActivation`,
`warnInertVariant`, `warnUngrantedApprovalGates`,
`warnUnenforceableHardActions`, + the new one). Deliberately deferred: it
changes what every existing mesh shows in the designer, which is an operator's
noise-budget call, not a refactor. Own session.

### Precedent — S1 already has this exact genre, three times

Sessions 5–9 all used runtime surfaces and never touched S1; S1 turns out to be
the best-precedented of the six channels for *this* shape:
- `warnInertVariant` (`config/src/index.ts:980-982`) — **the model to copy**:
  "…is set but inert — 'variant' was the o‍pencode runtime's thinking knob, that
  backend was removed, and no registered runtime reads the field. Remove the
  key, or leave it for a runtime that consumes it"
- `warnUngrantedApprovalGates` (`:1003-1005`), `warnUnenforceableHardActions`
  (`:836-842`) — same register, both "this gates nothing".
- A warning is a **bare `string`** — no `level`/`path`/`code`. Carrier is
  `ResolvedMeshConfig.warnings: string[]` (`:269`), collected into local
  `configWarnings` (`:524-547`), assigned at `:573`.

### Copy — the FOURTH item-3 sentence, and a different genre

The triple is now a quartet. The first three are runtime states; this one is a
statement about the config itself, and it is **the first whose remedy is "change
a different key", not "raise a limit"**:

> `scheduling.activation.strategy` is set to `"interest+triage"` but inert — no
> code reads it, and whether the router pass runs is decided by
> `scheduling.triage.mode` alone (currently `"off"`). Remove the key; set
> `triage.mode: heuristic` if you want the router pass.

Carries both live values (register item 2), says what will and will not help
(item 3), names the remedy and that it lives elsewhere (item 4).

### Implementation list — all sites verified, in order

1. `config/src/index.ts:1149` — drop `activation:\n    strategy: interest` from
   the `mesh init` template. **Do this first**; everything else assumes new
   configs are clean.
2. `designer/panels/MeshPanel.tsx:121-123` — delete the "how agents wake up"
   Field/Select. **This is the grade-3 fix.**
3. `designer/model.ts:140` and `:170` — `activation ||= { strategy: "interest" }`
   → `activation ||= {}`. **Keep the `activation` object**: it also carries
   `max_activation_delay_ms`, whose read sites are NOT yet verified.
4. New `warnInertStrategy` beside `warnInertVariant` (~`:980`), registered in the
   `configWarnings` cluster (`:524-547`). Fire **only when explicitly set**
   (`raw.scheduling?.activation?.strategy !== undefined`), never on the default.
5. Delete the resolved field — type `:300`, resolver write `:608`. Zero reads.
6. `tests/scheduler/scheduler.test.ts:184` — delete the poke. It sets
   `config.scheduling.strategy = "interest+triage"` **expecting triage to turn
   on**; it passes only because its own `triage:` YAML sets the mode. Misaimed,
   delete-safe, and it will fail typecheck once step 5 lands.
7. Strip the key from the five examples (`greenfield:77`, `spring-boot:128`,
   `line-follower-sim:209`, `demo-stub:111`, `payment-api:264`) and the inert
   fixtures (`mesh-cli/src/bench.ts:193,245,1044`, `tests/helpers.ts:154`), so
   nothing we ship warns. Behaviourally a no-op — the key has no readers.
8. Test the warning: fires when set, silent on a default/absent config.
9. **KEEP** the raw type (`:126`) and both JSON schemas — see the
   `additionalProperties` argument above.

### Still open / unchanged by this session

- `MISSION_HALTED_ALLOW_OPS` — still the small well-scoped alternative.
- Layer B remainder: `triage.mode` surface, `agents.<id>.interests`, the
  circuit-breaker park, the 8 `timeouts.*`.
- `max_activation_delay_ms` read sites — unverified, and step 3 depends on not
  assuming. Cheap to check next time.

### Shipped (session 10) — the decision above, implemented

All nine items done. 1217/1217 (1213 + 4 new), both typechecks `ok`, 0 lint
errors in the touched set.

- `mesh init` no longer writes the key (`config/src/index.ts`).
- Designer select **deleted** (`MeshPanel.tsx`), replaced by a comment saying
  why. This was the grade-3 fix: the key can no longer be set from the UI.
- `model.ts` seeds `activation ||= {}` (both sites); the object stays because
  the panel still edits `max_activation_delay_ms` under it.
- `warnInertStrategy` added beside `warnInertVariant`, registered in the
  `configWarnings` cluster. Fires **only when explicitly set**.
- Resolved `scheduling.strategy` field deleted — type and resolver write.
- The misaimed poke at `tests/scheduler/scheduler.test.ts:184` deleted;
  that file still passes 15/15, confirming it always ran off its own `triage:`
  YAML block and never off the field it set.
- Key stripped from all five examples and the four inert fixtures, so nothing
  we ship warns about itself.
- `tests/config/inert-strategy.test.ts` — 4 tests. The load-bearing one is
  "a config that omits the key is silent": it is what stops `mesh init` output
  from warning, which is the failure mode that ruled out warn-only in the first
  place. A fourth pins that resolved config exposes no `strategy`, so no future
  consumer can start branching on it and bring the two-switch problem back.

**Deliberate omission:** the raw type (`:126`) and both JSON schemas keep the
property. Removing them is the `additionalProperties: false` hard failure.

### NEW FINDING — `max_activation_delay_ms` is inert too, and also in the UI

Found while checking the one dependency this section flagged as unverified.
**Same defect, same config block, same grade 3.** Resolved at
`config/src/index.ts:609` → `maxActivationDelayMs` (resolved type `:301`), in
the JSON schema (`protocol/src/schemas.ts:389`), and **editable in the Designer**
at `MeshPanel.tsx:183-185` (`<Num label="max activation delay (ms)">`). Grep for
`maxActivationDelayMs` across `packages apps tests`: the declaration, the
resolver write, and nothing else. **Zero readers.**

Left out of session 10 on purpose: deleting that `<Num>` is a visible UI change
that was not in the approved scope. It is now the cheapest known job in this
survey — the decision is already made (it is the same decision), the precedent
is the function just shipped, and `warnInertStrategy` could become
`warnInertActivationKeys` covering both. **Do this next.**

So `scheduling.activation` contained *two* inert operator-facing keys and now
contains one. Worth asking whether the block should exist at all: if the delay
key goes the same way, `activation` holds nothing that is read, and the Designer
has no reason to seed it — which would simplify `model.ts` back down.

### Shipped (session 10, second change) — `max_activation_delay_ms`, and the block is now wholly inert

Done immediately after the above, on an explicit re-grant. 1220/1220, both
typechecks `ok`, 0 lint errors in the touched set.

- `<Num label="max activation delay (ms)">` **deleted** from `MeshPanel.tsx`,
  replaced by a comment. Second grade-3 affordance gone.
- `warnInertStrategy` widened to **`warnInertActivationKeys(activation,
  triageMode)`**, returning **one sentence per key** — deliberately not merged,
  because the remedies differ (see copy note below).
- Resolved `maxActivationDelayMs` deleted — type and resolver write. Zero
  readers, verified by grep across `packages apps tests`.
- **The designer no longer seeds `scheduling.activation` at all** (`model.ts`,
  both sites). This answers the question left open above: with neither key
  readable or editable, seeding the block would write an empty `activation: {}`
  into every saved mesh.yaml for nobody.
- `tests/config/inert-strategy.test.ts` → **`inert-activation.test.ts`** (git mv,
  the subject is the block now), 4 tests → 7.

**Nothing to strip from examples or fixtures:** `max_activation_delay_ms` was
set in no YAML anywhere — only the declaration and the resolver. Smaller job
than `strategy` for that reason.

**KEPT, same argument as before:** the raw type (`:126`) and both JSON schemas
still carry both properties. `additionalProperties: false` makes removal a hard
validation failure for any config that sets them.

### Copy — the FIFTH item-3 sentence, and the first with no substitute to offer

The register now has five, and this one splits the "config-time" genre in two:

> `scheduling.activation.max_activation_delay_ms` is set to `250` but inert — no
> code reads it, so activations always fire immediately and no other key delays
> them. Remove it

`strategy`'s remedy is **"use this other key"**; this one is **"there is nothing
to use"**, because the behaviour was never implemented. A merged warning would
have had to drop one of those, which is why the function emits two sentences.
`inert-activation.test.ts` pins the distinction both ways — the delay warning
asserts `doesNotMatch(/triage\.mode/)`, so a future edit cannot quietly offer a
substitute that does not exist.

### `scheduling.activation` — now empty of readers entirely

Both keys it ever held are inert. The block survives only as accepted-and-warned
legacy surface. If a future change is willing to take the schema break, the
whole block can go; until then nothing should be *added* to it, and nothing
reads it.

### Item 7 — forwarding `resolved.warnings` to `/config/validate`: SHIPPED

Session 10 third phase. Diagnosed, then stopped once before editing because the
scope estimate the decision rested on was wrong; both blockers below were then
answered and the change shipped. **Read the resolution at the end of this
section** — one blocker turned out to be a real pre-existing bug.

**The change itself is one line.** `analyzeMeshConfig` already runs in the
handler and `resolved` is in scope: `apps/mesh-server/src/index.ts:1676`. The
warnings array is built empty at `:1678`; seeding it
(`const warnings: string[] = [...resolved.warnings]`) is the whole fix. It
covers **both** `/config/validate` and `/config/save` — one handler serves both
(`:1666`). Response shape already carries `warnings` (`:1741`), and the Designer
already renders whatever arrives: `Designer.tsx:458-462` → `HealthStrip`
(`:907`) + `AdvisoryList` (`:913`). **No UI work is needed at all.**

**BLOCKER 1 — the noise is nine warning kinds, not four.** `configWarnings` has
ten push sites: `config/src/index.ts:398` and the cluster at `:523-547`
(gate actors, unenforceable hard_actions, uncovered capabilities, unmergeable
gates, no-startup-activation, unreachable agents, inert variant, ungranted
approval gates, + `warnInertActivationKeys`). Every mesh that trips any of them
starts showing them in the designer. The operator approved this on a stated
count of four; re-confirm before shipping, and consider whether a subset should
forward first.

**BLOCKER 2 — possible duplicate and/or false gate warnings.** The server
already pushes its own gate check into the same array (`validateTransitionGates`,
`:1683-1685`, imported from outside `packages/config`). The config cluster runs a
**different** function, `validateTransitionGateActors`
(`config/src/index.ts:1059`). Forwarding runs both into one list.
`Designer.tsx:463-468` says client-side gate satisfiability was deliberately
removed because it produced false "no agent can decide that" warnings on every
correctly-wired mesh, and that "the server owns this check". So:
- Do the two functions overlap? Double-reporting is the mild case.
- Does `validateTransitionGateActors` have the false-positive behaviour that
  comment describes? If so, forwarding reintroduces the bug the comment prevents,
  and that source must be excluded or fixed first.
**Read both function bodies before touching the route.** This is the real work
of the job; the forward is trivial.

**Related, smaller, and NOT blocked:** `doSave` (`Designer.tsx:789-828`) reads
`json.savedTo`/`archived`/`drift` and **ignores `json.warnings`** entirely; the
failure toast uses `json.errors` only (`:819`). Save never calls `setResult`, so
the HealthStrip keeps showing the last *validate* result — an operator who saves
without validating sees no warnings at all. Once the forward lands, save returns
them too, so this becomes worth wiring.

**Stale comment to fix when this ships:** `Designer.tsx:469-471` claims the
"wired to nobody" and "nobody boots" warnings "arrive back through
`serverWarnings` above". They do not, today. Shipping the forward makes the
claim true; until then it is false and misleading.

#### Resolution — both blockers answered

**Blocker 1 (noise) — accepted as-is, nine kinds.** No filtering by noise. Every
one of them describes a real defect in the operator's own config, and the
designer already had the surface to show them (`HealthStrip` + `AdvisoryList`);
they were being computed and thrown away. Suppressing true warnings to keep a
list short is the bug this whole survey exists to fix.

**Blocker 2 (gate overlap) — was a real bug, not just duplication.** The two
checkers are not the same function:

| | `validateTransitionGates` (policy-engine:428) | `validateTransitionGateActors` (config:1059) |
|---|---|---|
| malformed token | yes | yes — **duplicate** |
| actor is no agent id/role | yes | yes — **duplicate** |
| named agent can *record* the approval (`canReviewArtifactType`) | yes | no — cannot see it |
| **human seat exempt** | **yes** (`:443`) | **no — FALSE POSITIVE** |

The config variant had drifted: it has no human-seat exemption, so every
`human.approve` gate was reported as "the gate can never be satisfied". That is
a supported pattern — `tests/integration/human.test.ts:53` is named "human:
direct approvals satisfy gates; humans are a mesh seat not an external oracle".
So the check was telling operators a working mesh was deadlocked, at boot and
in the CLI, before any of this forwarding existed.

Fixed in two places:
1. **`config/src/index.ts:1059`** — exempt `"human"`, matching policy-engine.
   Literal, not core's `HUMAN_AGENT_ID` (`core/src/supervisor.ts:140`): config
   imports only protocol, and protocol already hardcodes the same string.
2. **`mesh-server/src/index.ts:1678`** — forward `resolved.warnings`, filtering
   out `transition gate '…'` because the policy-engine check runs into the same
   array ten lines below and is strictly stronger. One defect, one line.

**The prefix coupling is the fragile part** and is deliberately locked by a test
("gate-actor warnings keep the prefix the server dedups on",
`tests/config/mesh-satisfiability.test.ts`). Reword either config gate message
without updating the server filter and the duplicate comes back silently.

Tests: 4 in `mesh-satisfiability.test.ts` (human seat silent; human + unknown
reports only the unknown; unknown still reported, so the exemption is one string
and not a hole; prefix lock) and 2 assertions in `bus-api.test.ts` (a ghost gate
appears exactly once; the inert-activation warning — which has no server-side
equivalent — actually arrives). 1224/1224, typecheck ok, 0 lint errors.

`Designer.tsx:469` previously claimed config warnings "arrive back through
`serverWarnings`". That claim was false when written; this change makes it true,
and the comment now names the seam and the one exclusion.

~~**Still open, deliberately not done here:** `doSave`
(`Designer.tsx:789-828`) reads `savedTo`/`archived`/`drift` and still ignores
`json.warnings`, and never calls `setResult` — so an operator who saves without
validating sees no warnings at all, even though the save response now carries
them. Same "computed then dropped" shape as the bug just fixed, one layer up.
Small, self-contained, and the obvious next item.~~

**Superseded (session 11) — see "Item 7b" below.** The *mechanics* above were
right and the *consequence* was wrong: the Designer validates on a 550 ms
debounce after every edit, so the strip is already showing that family by the
time anyone reaches for Save. And "call `setResult` in `doSave`" — the fix this
paragraph implies — is the session-8 trap, not the fix.

---

### Item 7b — the save path's warnings: SHIPPED (session 11)

The brief for this session carried two errors, both checked against source
before editing. Recording them because the second is the kind that survives into
the next brief:

1. **Premise.** "An operator who edits and saves without clicking validate sees
   no warnings at all" is **false**. `touch()` (`Designer.tsx:241-253`) fires
   `void validate()` on a 550 ms debounce (`SAVE_DELAY_MS`, `:33`) after every
   mutation, and load validates unconditionally (`:312`). Save does not mutate
   the draft, so `result` almost always already holds a 200 for the same bytes.
   The strip was not empty; only one warning kind was ever missing.
2. **Line number.** The save-only push is at `mesh-server/src/index.ts:1727`,
   not `:1715` (that is the version-stamp loop).

**What was actually missing: one warning kind.**

```
apps/mesh-server/src/index.ts:1727 (was)
  warnings.push(`agent '${id}' prompt file not found (relative to ${dir}): ${p}`);
```

The only push inside `if (parts[1] === "save")`, and **unreproducible by
construction**: `baseDir = … : config.dir` (`:1675`) and the Designer posts no
`dir`, so `/config/validate` resolves prompt refs against `config.dir` while save
resolves them against `dirname(target)`. Different directory — the two routes
cannot agree about the same ref, no matter when they run.

**Decision: SEPARATE. REPLACE and MERGE are both the session-8 trap.**

Applying the channel table (`:396-402`): save-time warnings are **S1 in origin**
but fire on a *write*, so they are a new shape — standing and **write-scoped**.
The disqualifier is not the block (they block nothing) but the *clear*:

| | Shape | Clears? | Blocks? |
|---|---|---|---|
| S1 | polled, draft-scoped | on next validate | design-time |
| S3b | standing, polled | never | yes |
| S4 | standing, event-derived, terminal | never | n/a — over |
| **save-only** | **standing, write-scoped** | **on next edit — *wrongly*** | no |

`setResult(...)` in `doSave` would put a claim about `dirname(target)` into a
channel whose refresher re-runs against `config.dir` on the next keystroke. It
would delete the warning **whether or not the operator fixed the ref** — a false
clear, strictly worse than today's silence. Session 8's rule verbatim (*"do not
give a channel a second source that answering the card could not clear"*,
`:289-296`); same argument as C5's first consequence (`:411-413`).

**Also rejected as redundant:** forwarding the config-time family on save.
`warnings` at `:1690` is `resolved.warnings` minus the gate-actor prefix —
byte-identical to what the debounced validate of the same content already
returned, because both take `baseDir = config.dir`. Merging it re-renders nine
warnings the strip is already showing, next to a "saved" toast — and silently
redefines the strip from *"your draft validates"* to *"your last save said
something"*. Those are different claims; this is the two-verdict trap.

**Shipped.**

- `mesh-server/src/index.ts` — new `saveWarnings: string[]`, sibling to
  `warnings`, in the response beside it. The `:1727` push goes to **both**, so
  `warnings` stays a complete account of the response and `saveWarnings` ⊆
  `warnings`. `/config/validate` returns `[]`.
- `Designer.tsx` — `savedInfo` carries `warnings`; `doSave` reads **only**
  `json.saveWarnings`, with a comment saying why `json.warnings` is deliberately
  unread here so nobody "fixes" it back to `setResult`.
- `chrome.tsx` — `SavedCard` renders them, with the register's third move (the
  one this card owed): *"Re-saving will not fix it — the path is resolved against
  the directory this save wrote into, not against your unsent draft."* Without
  that sentence a warning beside a green "Saved" reads as a flaky save. Cleared
  by the next edit or save — `touch()` already nulls `savedInfo`.
- `tests/integration/bus-api.test.ts` — clean save asserts `saveWarnings` is
  `[]` and `warnings` is still populated; then the discrimination case, an
  **absolute** prompt ref, which `materializeRolePrompts` skips
  (`packages/config/src/index.ts:720`) so the file is still absent when the loop
  runs. Asserts it appears in `saveWarnings`, is a subset of `warnings`, and
  **cannot be reproduced by `/config/validate`** — the property the split exists
  for, asserted rather than assumed.

**Why not a client-side prefix filter.** The only client-side way to find the
subset is matching `agent '` / `prompt file not found` — the same fragile
message-prefix coupling the session-10 resolution deliberately locked with a
test (`:826-829`). Adding a field is cheap; that anti-pattern is not.

**Gate overlap untouched.** `:1690`'s filter and the `transition gate '` prefix
are unchanged, so `tests/config/mesh-satisfiability.test.ts` stays green and
load-bearing. No route warning was reworded.

1224/1224, both typechecks ok, 0 lint errors in the touched set.
