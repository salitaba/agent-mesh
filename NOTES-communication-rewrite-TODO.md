# Communication rewrite — execution checklist

Companion to `NOTES-communication-rewrite.md`. Ordered by stage; risk ascends.
Status legend: `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked/deferred

---

## Stage 0 — see it (additive, no behaviour change) — DONE

> 1312 tests / 1312 pass. Baseline was 1300/1299 + 1 failure in
> `tests/projects/supervision.test.ts:128`, which passed on the re-run: that test
> is flaky on backoff timing, not broken. 12 tests added.

- [x] **0.1** Add `session.rotation_pending` + `session.rotated` to the event catalog
      (`packages/protocol/src/types.ts` `EventType`, `schemas.ts`, `schemas/event.schema.json`)
- [x] **0.2** Wire `onRotate` (`runtime-claude/src/index.ts:133`,`:1156`) through to a kernel
      emit — currently fired into nothing
- [x] **0.3** Consume `LiveSession.mcpStatus` — the mute-seat detector is built and unread;
      emit `agent.mute_suspected` when the MCP bridge did not attach
- [x] **0.4** `ContextManifest` type + emit one per turn from `buildAgentContext`
      (`packages/core/src/context.ts`) so slot admit/drop counts survive in the log
- [x] **0.5** Tests: rotation emits, mute detection emits, manifest round-trips through the log

## Stage 1 — durable delivery (invisible to agents) — DONE

> 1335 tests / 1335 pass (+23). Typecheck clean.
> **Deviation from 1.4 as written — flagged for review.** The checklist said
> "`append()` durable before return". The async write chain it would remove is a
> deliberate, documented decision (`event-store/src/index.ts:137-144`): every emit
> used to pay open+write+close on the event loop and burst load stalled HTTP
> directly. Making every append fsync reintroduces exactly that stall. Took the
> explicit-barrier route the proposal itself named as the fallback: keep the chain
> for throughput, add `flush()` that drains it and fsyncs, to be called before
> anything outside the process is told the event happened. The crash window is
> unchanged for ordinary appends; it is now *closable on demand* instead of only
> bounded by a blind cadence. Scaling the item down is Ali's call to review.

- [x] **1.1** Per-subscriber cursors in `Persistence.watchFile`
      (`packages/persistence/src/index.ts:698-719`) — killed the module-global `watchOffset`
- [x] **1.2** Reset the cursor on `reset()`/truncate so post-reset events are not skipped
- [x] **1.3** `EventStore.subscribe(handler): () => void` on both implementations.
      Dropped the `fromSeq` argument from the checklist signature: a store subscription
      is a *follow*, and replay-from-seq is already `read({ sinceSeq })`. Folding both
      into one call invites the race where history and the live tail overlap or gap.
      Callers that need both read first, then subscribe.
- [x] **1.4** `flush()` durability barrier — see the deviation note above
- [x] **1.5** `MemoryEventStore.append` validates like `JsonlEventStore.append`
- [x] **1.6** Kernel no longer awaits listener fan-out inside `emit` (`dispatch()`);
      listeners are still *started* in order synchronously, so every real (synchronous)
      listener behaves exactly as before
- [x] **1.7** Tests: `tests/event-store/subscribe.test.ts` (16), `tests/core/kernel-dispatch.test.ts` (5)

## Stage 2 — deadlines and refusals (mechanism, not vocabulary) — **DONE**

- [x] **2.1** `dueBy` on `PendingRequest`, defaulted per-role from config
      (`bus.commitments.ttl_ms` / `ttl_ms_by_role`). Stamped by the reducer at open
      time from the DEBTORS' roles, taking the **longest** of them: the question a
      deadline answers is "how long should this kind of work take?", not "how patient
      is the asker?", and a slow reviewer must not be timed out because a fast one was
      also addressed. Defaults to no deadline — expiry is an operator's choice, not
      something a mesh inherits from an upgrade.
- [x] **2.2** `expired` discharge reason + `sweepExpiredCommitments`. Hung on
      `checkStall`'s **wall clock**, not on the event-driven watchdog: a mesh where
      everyone is waiting on an unanswerable ask emits no events at all, which is
      exactly when a deadline has to fire. Runs before every one of `checkStall`'s
      early-return gates, goes through `dischargeCommitment` so it replays, names who
      was late, honours the same open-escalation protection as eviction, and is capped
      at 50 expiries per tick.
- [x] **2.3** `refused` as a first-class settlement carrying the refuser's words.
      It is a **per-debtor** reason (one agent saying no does not close the other
      debtors' obligations) and deliberately **not** UNANSWERED — the asker was told
      "no", which is something it can act on.
- [x] **2.4** Cap-eviction replaced with refusal-to-open (`refused_cap`). Eviction
      dropped the *oldest* ask, i.e. the one most likely genuinely stuck, and did it
      silently; three consumers then drew wrong conclusions (the wait-for graph lost
      edges so a provable deadlock became undetectable, agent context stopped listing
      the debt, and the escalation reconciler auto-closed the operator's card claiming
      the request "was answered or withdrawn"). A full ledger now refuses the new ask
      and says so. `evictOverflowingPendingRequests` survives as a last resort for a
      map that arrived over cap by some other route (an imported snapshot, a lowered
      cap). The refusal bounds the *obligation ledger*, not the bus: the message is
      still delivered.
- [x] **2.5** `bus.commitments.semantic` default flipped `"compat"` → `"strict"`.
      The failure modes are not symmetric: a wrong inference closes an ask nobody
      answered and does it silently, while a missing inference leaves the ask open,
      which is visible (nudges, a ledger row, and now an expiry). Six tests encoded the
      old default and were changed to **opt into `compat` explicitly** — they are the
      tests that are *about* inference, so saying so is an improvement either way.
      `docs/configuration.md` rewritten for both new keys.
- [x] **2.6** `tests/policy/commitment-deadlines.test.ts` — 9 tests: an unanswered ask
      expires; the expiry replays; it names who was late; no TTL means no expiry; a
      slow role's deadline is not cut short by a fast co-debtor; an escalated ask is
      not expired out from under the operator; a refusal settles only the refuser's
      share; the creditor is told and the log says `refused`; a refusal replays as a
      refusal. Cap-refuses-to-open is covered by the rewritten
      `tests/policy/ledger-capacity.test.ts`.

**Three bugs found and fixed while doing this.**

1. *The `discharge` op could not record a refusal.* The notice it sends carries
   `replyTo`, so the reducer closed the ask as `"reply"` the moment the notice was
   logged; the explicit `dischargeCommitment` that followed then found nothing pending
   and silently did nothing. A refusal was indistinguishable from an answer in the
   ledger, and the `declined: true` detail never reached the log at all. Fixed by
   closing first and notifying second (`supervisor.ts`, `case "discharge"`).

2. *A caller's detail could overwrite the canonical discharge reason.* The
   `commitment.discharged` payload spread `detail` **last**, and the reducer reads
   `p.reason` straight out of that payload — so `dischargeCommitment(id, "operator",
   by, { reason })` wrote a free-text sentence where a `DischargeReason` belonged, and
   every `PER_DEBTOR_`/`UNANSWERED_` membership test on it then quietly answered false.
   Two call sites were doing this (the escalation drop, and my own new refusal). Fixed
   by spreading `detail` first so the ledger's own fields always win, and renaming the
   colliding key to `note` so the human text survives.

3. *`Kernel.gates` did not carry `commitmentTtl`.* `Supervisor.projectionConfig()` had
   it, but the **live** state is built by the kernel from its own `gates`, so `dueBy`
   was never stamped on a running mesh — only on a replay. Fixed at the kernel type and
   the server bootstrap. (The test harness also emitted a bare `bus:` key for
   `{ commitments: {} }`, which YAML parses as null and the schema rejects.)

Suite: **1345 / 1345**, 0 fail. Lint on every touched file: 0 errors.

## Stage 3 — continuity records (the scope-(b) payoff)

- [x] **3.1** `ContinuityRecord` / `Belief` / `RejectionNote` types, the
      `continuity.recorded` event, and both schema copies. A belief carries its
      `basis` (artifact URI, commitment id or event id) and a `confidence` of
      `asserted` | `assumed`, because the failure this stage exists to stop is a
      successor inheriting its predecessor's *guess* as settled ground.
- [x] **3.2** `write_continuity` op + the handover turn. The op deliberately has **no
      `openCommitments` field**: what a seat still owes is derived from the commitment
      ledger at write time. A model one turn from losing its transcript is the worst
      available witness to its own obligations, and a record that disagreed with the
      ledger would be worse than no record.
- [x] **3.3** Projection: latest record per seat (`state.continuity`), plus a reducer for
      `session.rotated` — which **had none at all**, so the one moment an agent loses
      its working memory was invisible to every projection. It now projects
      `sessionOrdinal`, which the record is stamped from.
- [x] **3.4** The record is slot 1 of the successor's bundle and renders **above
      `## Mission`**: a seat whose memory was just destroyed reads what it already knew
      before anything it could re-derive. Assumptions render as `ASSUMED (unverified)`,
      rejections as `Already rejected by <who>`.
- [x] **3.5** `EpisodeId` (`<goalId>#<n>`) via `Goal.episodeOrdinal`, bumped **in the
      `goal.reopened` reducer** so the ordinal is a function of the log — a replay that
      counted reopens some other way could disagree with the mesh that ran. A record
      from an earlier episode is labelled as such in the prompt rather than silently
      inherited: beliefs formed in a round the operator rejected are history.
- [x] **3.6** `reopenGoal` now clears `restartAttempts`, `unreachableStreak`,
      `timeoutRetries` and `continuityAsked` alongside the scheduler's counters.
- [x] **3.7** `tests/core/continuity.test.ts` — 15 tests. Every one was mutation-checked:
      three deliberate breaks (ledger-derived commitments, the activation give-back, the
      prompt render) each turned exactly the intended tests red, and only those.

**The ordering problem this stage is really about.**

A rotation destroys the session at `runtime-claude.ts:1175` and only fires `onRotate` at
`:1204` — so by the time anything learns a rotation happened, the session with something
to say is already gone. Granting the seat an extra turn does not work either: `stream()`
runs *inside* `Supervisor.runTurn`, and two re-entrancy guards (`s.pending`,
`turnInFlight`) correctly refuse a nested turn.

The resolution is that a handover is not an extra turn — it is the turn that was about to
happen, spent differently:

1. The *decision* is hoisted out of the adapter into `AgentRuntime.rotationPending()`, so
   the supervisor can ask "is this seat one turn from losing everything?" **before** the
   turn runs. The adapter answers from the same two numbers it would rotate on, so the two
   cannot disagree.
2. `AgentInput.suppressRotation` holds the adapter off for exactly that one turn. Without
   it the record would be written by the session that no longer knows anything.
3. `HANDOVER_ALLOW_OPS` restricts the turn to `write_continuity` / `read_artifact` /
   `done` / `wait`. The refusal is **out loud**, unlike the mission-over halt: a silent
   no-op reads to a model as the op having worked.
4. The `ActivationReason` the seat was woken for is handed back in `runTurn`'s `finally`,
   after `notifyTurnFinished` — so the scheduler admits it rather than stashing it, and
   the work the seat was actually called for is not dropped on the floor.
5. `continuityAsked` is keyed on **session ordinal, not session id**, because rotation
   reuses the mesh-side session id. A seat that ignores the handover is not asked again
   on the same transcript.

**Two bugs found and fixed while doing this.**

1. *`session.rotated` had no reducer.* The event was emitted and logged, and no projection
   read it. Nothing in the mesh could tell you which transcript a seat was on, or that it
   had lost one.

2. *`reopenGoal` cleared the scheduler's counters but not the supervisor's.* A seat that
   had exhausted `restartAttempts` in the previous episode came back into a reopened
   mission in a state where the scheduler would run it and the supervisor would refuse to
   restart it.

Suite: **1360 / 1360**, 0 fail. Lint on every touched file: 0 errors. Schemas regenerated
from a fresh build and confirmed stable.

## Stage 4 — contracts replace type strings (largest agent-facing change) — DONE

- [x] **4.1** `Contract` type + registry — `packages/protocol/src/contracts.ts`, 8 built-ins
- [x] **4.2** `contracts` discovery op — shipped in the same change as 4.3, as required
- [x] **4.3** `call(contract, request)` op, validated against the contract schema
- [x] **4.4** Manifest shrink under `bus.transport: "typed-only"`
- [x] **4.5** `op-aliases.ts` retired behind typed-only, **and given the telemetry that decision needs**
- [x] **4.6** Tests — `tests/protocol/contracts.test.ts`, 18 of them

**The one invariant the whole stage rests on: `call` is sugar.**

Every exit from `callContract` desugars to an op that already existed and goes
back through `executeOp`. Not "calls the same helpers" — literally re-enters the
same method. That is what makes the claim checkable rather than aspirational:
`call` cannot reach anything a typed op could not, and the halt freeze, the
handover restriction, the plan gate, the capability checks and the
communication policy all apply to it unchanged, with no second implementation
to keep in step. `contracts: every gate a typed op faces still applies to the
call` is the test that fails when that stops being true.

**What contracts are actually for: shrinking the guessable vocabulary.**

A seat is shown 24 message-type strings and 41 tool names and has to guess
which of them means "please review this". It guesses wrong, and `op-aliases.ts`
rewrites the guess — which papers over the miss *and* over the evidence that
the miss keeps happening. 8 named contracts replace the guess with a name, a
request schema checked **before anyone is woken**, and a named list of the
refusals you may get back. An unknown name fails closed quoting what you asked
for and listing every real alternative: the refusal teaches, which is the thing
an alias table structurally cannot do.

**Two design calls worth recording:**

1. *A contract SLA narrows an existing deadline regime; it never creates one.*
   `computeDueBy` returns undefined with no TTL configured regardless of the
   contract. Deadlines drive expiry and expiry discharges debt — a catalogue
   that invented one would silently forgive asks the operator told the mesh to
   keep. A per-role TTL still outranks the contract: the config is the
   authority on how long this mesh's seats get.
2. *The stamp had to reach review and research too.* `request_review` and
   `request_research` build their own payloads, so without an explicit
   provenance field they would have been the only two contracts whose SLA
   silently did not apply — a 6-of-8 asymmetry nobody would have noticed until
   a deadline failed to fire. They now carry `contract` / `contractVersion`,
   which also means the log says which named ask a REQUEST_REVIEW was.

**4.5 turned out to be mostly a measurement problem.** §7 says gate the risky
part of this stage on a signal — and there was no alias telemetry at all, so
the signal §7 asks for did not exist. The rewrite happened silently and a
rewritten op was indistinguishable from one the model got right, so the table
suppressed its own justification. `aliasStats()` now counts every rewrite by
name. It is deliberately process-lived and unattributed: turns run
concurrently, so pinning a rewrite to the turn that caused it needs plumbing
that could only ever be approximately right, and "does anyone still need
aliasing, and for which names" is an aggregate question anyway. Under
typed-only the runtime passes `aliases: false` — which changes no behaviour
(a parsed op is already refused wholesale there) but stops refused turns
inflating the one number the retirement decision depends on.

**4.4 is much smaller than the TODO claimed, and here is the measurement.**
The 41 tool definitions are ~17,330 chars (~4.3k tokens) of manifest. Under
typed-only this drops `mesh_request`, `mesh_request_review`,
`mesh_research_request` and `mesh_escalate` (~1,318 chars / ~329 tokens) and
adds `mesh_call` + `mesh_contracts` (~933 chars / ~233 tokens). **Net: about
−96 tokens per turn.** The TODO's "~3.9k tokens/turn" was the cost of the
*whole* manifest, not the shrinkable part of it, and I should not have carried
that number forward as if contracts would recover it.

Those four are the only ones a contract *fully* covers. `mesh_send` stays: no
contract covers answering, or the 17 message types the catalogue does not name,
and a manifest that omitted it would force exactly the guessing this stage
exists to end. Getting anywhere near 3.9k would mean contracts for artifacts,
tasks, leases and decisions too — that is a different and much larger change
than "contracts for asks", and inventing it here would be scope I was not
asked for. The real win of this stage is the failure mode, not the token count:
the contract catalogue is pay-per-use (fetched by `contracts`, not resident in
every manifest), and an unknown name now fails closed with the alternatives
instead of being silently rewritten.

Hiding is also advertisement-only — `callTool` resolves against the unfiltered
map — so this is a prompt decision, not a capability change, and no seat can be
stranded by it. There is a test for that too.

**A mutation caught a bad test, which is the point of running them.** Removing
the one-provider narrowing (`targets = [resolved[0]]` → `targets = resolved`)
did **not** turn the routing test red: it used `research.question`, and
`MeshOpRequestResearch.to` is a single `AgentId`, so that path cannot broadcast
whatever routing does. The test was passing for a reason that had nothing to do
with what it claimed. Rewritten against `info.question`, which sends to an
array — and it now fails under that mutation, and additionally asserts total
debtor count, not just recipient count.

Mutations run, each turning exactly the intended test red and only that one:
stripping the alternatives from the unknown-contract refusal; disabling request
validation; broadcasting the ask (after the fix above); removing the typed-only
manifest filter; dropping the op-alias counter. All five restored and
byte-compared against backups.

Documented in `docs/protocol.md` (what a contract is, and the three properties
that make it safe: sugar, fails-closed-loudly, routes to one provider) and
`docs/configuration.md` (the two ops, the built-in list, the SLA narrowing
rule, and what else `typed-only` now changes).

Suite: **1378 / 1378**, 0 fail — exactly +18 from the 1360 baseline. Lint on
all 14 touched files: 0 errors (46 pre-existing cross-package-import warnings).
Schemas regenerated: "already in sync", md5 unchanged.

## Stage 5 — partition the log, drop the global mutex — MEASURED, DELIBERATELY NOT BUILT

- [x] **5.0** Answer this stage's own gate: *"only worth doing once concurrency is
      demonstrably the bottleneck."* Measured. It is not, by ~4 orders of magnitude.
- [x] **5.1** ~~Break `Kernel.state` aliasing~~ — **withdrawn.** The aliasing is not an
      accident to be broken; it is load-bearing by design.
- [x] **5.2** ~~`EpisodeId` as partition key on the frame~~ — **withdrawn.** Unsafe as specified.
- [x] **5.3** ~~Per-partition write lock~~ — **withdrawn.** Nothing to win.
- [x] **5.4** Tests — redirected to the one real defect the investigation surfaced:
      `tests/core/kernel-seq-watermark.test.ts` (3 tests, both mutations caught).

### The measurement

Benchmarked against the real `Kernel` + `JsonlEventStore` on this machine:

| what | cost |
|---|---|
| per `emit` through the full chain | **~8.4 µs** (2000 emits in 17 ms) |
| of which `store.append` | 35% |
| of which `applyEvent` + bookkeeping | **65% — synchronous CPU** |
| `append` latency | p50 5 µs, p90 7 µs, p98 16 µs, max 1.35 ms |
| appends over 500 µs | **1 in 1000** |
| implied chain capacity | **~119,000 events/sec** |

The decisive number is the 65%. That fraction is synchronous CPU on a single-threaded
event loop: removing a lock from around work that never yields buys exactly nothing.
And the load this mesh actually generates is LLM-bound — an agent turn takes seconds and
emits a handful of events, so the real rate is single-digit events/sec. The chain runs at
roughly **0.01% utilisation**. There is no bottleneck here to relieve.

### What partitioning would have cost

Two explorers mapped `kernel.ts` and the store/persistence layer first. Partitioning by
`EpisodeId` breaks the single global monotonic `seq` that the kernel depends on in four
places — and `seq` is load-bearing well beyond the kernel:

1. **Silent index data-loss.** `persistence/src/index.ts:143` declares `seq INTEGER PRIMARY
   KEY` and `:158-159` inserts with `INSERT OR IGNORE`. Colliding seqs from independent
   per-partition counters are **dropped with no error**, leaving the JSONL log correct and
   the queryable index quietly short. Divergence with no signal is the worst failure shape
   available.
2. **The snapshot cut.** `kernel.ts:238` replays the tail with `read({ sinceSeq: throughSeq })`.
   That is a cut on a *total* order. An event with a low seq written after the snapshot sits
   in neither the snapshot nor the tail — dropped from every future replay, permanently.
3. **Cursors everywhere downstream**: SSE `Last-Event-ID` catch-up (`mesh-server/src/index.ts:1731`),
   the host resubscribe (`host.ts:280,315`), the MCP poll cursor (`mcp.ts:349,366`), and
   time-travel `upToSeq` (`supervisor.ts:3526`).
4. **`EpisodeId` is not on the event.** `MeshEvent` has no `episode` field; the id is derived
   (`episodeOf`, `types.ts:516`). Worse, the ordinal is bumped *by the reducer* on
   `goal.reopened` — and `applyEvent` runs **before** the append. So stamping the partition key
   is off-by-one-episode at exactly `goal.created` and `goal.reopened`: the two events that
   define episodes. The partition key is ill-defined precisely where it matters.
5. **The aliasing is deliberate.** `Kernel.state` is `readonly`, reset in place via
   `Object.assign` (`kernel.ts:163`) *because* the scheduler captures it by reference at
   construction (`mesh-server/src/index.ts:486`), as do the supervisor, budgets, context
   assembly and the HTTP handlers. "Breaking the aliasing" means rewriting every holder to
   re-dereference. 5.1 called this "the real work" and had the reason backwards.

So: a large, high-risk rewrite, whose headline failure mode is silent, to relieve a lock
running at 0.01% utilisation. I am not building it. **Scaling scope down is normally the
user's call, not mine — flagging it here rather than burying it.**

### What I built instead

The investigation did surface one genuine latent defect, and it is exactly the invariant
partitioning would have violated:

**`lastEventSeq` was not monotonic.** Two independent writers — `kernel.ts:141` after append,
and the reducer at `projections.ts:82` — both did last-writer-wins with no `Math.max`. This
is the value a snapshot publishes as `throughSeq`, i.e. the cut in (2) above. A watermark
that can regress silently strands every event between the high mark and the lower one that
replaced it. Both writers are now `Math.max`, with the reasoning in comments at both sites.

Honest severity: **latent, not live.** Under today's single global chain, seqs arrive strictly
increasing, so the guard is a no-op at runtime. It is worth having because it is free, and
because it converts an assumption that lived only in the ordering of the write chain into an
invariant the code states outright.

Also examined and **rejected as not a bug**: both stores do `++this.seq` before validating
(`event-store/src/index.ts:112/119` and `:291/292`), so a rejected event burns a sequence
number. That leaves a *gap*, and nothing in the codebase requires seq to be gap-free — only
monotonic and unique. Reporting it as a defect would have inflated the finding.

### When to revisit

Revisit partitioning only if all three hold: sustained emit rate exceeds ~10,000 events/sec;
profiling shows `applyEvent` (the 65%) has been moved off the critical path; and the sqlite
index has a composite key so colliding seqs cannot be silently dropped. Until then this stage
is answered, not deferred.

---

## Ground rules for this run

- Baseline before any edit: typecheck clean, test result recorded. Red tests that were
  already red are not mine to fix.
- Ali's uncommitted WIP (27 modified + 5 untracked at session start) is never stashed.
  Stage work is additive where possible.
- Each stage ends green (typecheck + tests) before the next begins.
