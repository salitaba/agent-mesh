# Token-economy review — findings and corrections

Status: ALL SHIPPED AND COMMITTED. A 04a9064 · C 4559f84 · G 8c2bc24 · B 175fea1 · J/K/L 5cbf0cd ·
their tests 7c4dc2a,
plus a267a36 fixing a schema drift that 4559f84 introduced (criteria_model reached the runtime
validator and the config parser but not schemas/mesh.schema.json, so the documented contract and the
enforced one disagreed — and failed on a CLEAN checkout, not just a dirty tree. Regenerated from the
compiled schema, not hand-edited). M closed as NO CODE.
E, H and M returned NEGATIVE results that corrected this document rather than adding work — see
finding 5, item 1, and finding 6. That is the main output of this round.

THE SUITE WAS BRIEFLY RED AND IT WAS NOT US — RESOLVED. 7 failures out of 1248, all from the
uncommitted tri-state GitMode migration that was in the tree at the time (`resolveUseGit` in
config/src/index.ts; git defaulting ON when the key is absent). Proof it was not ours: the five
failing test FILES pass 73/73 at commit 5cbf0cd, where the migration is absent. That migration has
since been finished by its author and the tree is GREEN — 1275/1275, including the 6 tests added in
7c4dc2a. The episode is kept here for the METHOD, which is reusable: J/K/L were committed by
hunk-staging around someone else's WIP (extract hunks by marker, `git apply --cached`, verify the
staged diff contains none of their symbols), and the commit was then compiled in an ISOLATED
WORKTREE to prove it builds without that WIP present. Never stage those files wholesale — types.ts
and apps/mesh-server/src/index.ts each hold BOTH the migration and our changes.

READ THIS FIRST: five claims in the original version of this file were falsified by reading source.
Items 2, 3 and 4's premises, plus two of my own additions under item 1. The recurring error was
reading ONE END of a mechanism — a raise site, a grep over `packages/` only, a constant's comment —
and inferring the other end instead of reading it. Corrections are inline and marked; the reasoning
that produced each error is recorded next to it on purpose.

## Critical premise correction

The mesh calls `@anthropic-ai/claude-agent-sdk`'s `query()` (runtime-claude/src/index.ts:1016-1045),
NOT the Messages API. That much stands. But the follow-on claim — that this leaves no generation-level
cost lever — was wrong; see RESOLVED below.

## RESOLVED — the SDK does expose cost levers

Installed 0.3.270 (`node_modules/@anthropic-ai/claude-agent-sdk/package.json`). `Options` carries,
verified in `sdk.d.ts`:

  thinking?: ThinkingConfig       :1756   adaptive | enabled{budgetTokens} | disabled
  effort?: EffortLevel            :1769   low|medium|high|xhigh|max — DEFAULT IS `high`
  maxThinkingTokens?: number      :1778   @deprecated, use `thinking`
  maxTurns?: number               :1783   caps turns per query
  maxBudgetUsd?: number           :1788   query STOPS, returns error_max_budget_usd
  taskBudget?: {total: number}    :1796   API-side, model paces itself (@alpha)

Why the earlier grep found nothing: it searched `agentSdkTypes.d.ts`, which is a 25-byte re-export
stub (`export * from './sdk.js'`). The declarations are in `sdk.d.ts`, 449KB. Nothing was
bundled-single-line — the file simply did not contain the types. Do not repeat that search.

## NEW — two levers nobody has looked at

5. `effort` DEFAULTS TO `high` — TRUE, BUT NOT THE LEVER IT LOOKED LIKE (item E, measured).
   "Plausibly larger than items 1-3 combined" was MY GUESS AND IT WAS WRONG. Read out of the
   installed CLI's model catalogue (node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude):
     claude-opus-5  default_effort:"high"  cost index low 0.67 / med 0.76 / HIGH 1.0 / xhigh 1.6 / max 1.7
     claude-sonnet-5                       cost index low 0.47 / med 0.74 / high 1.0 / xhigh 2.41 / max 5.59
     claude-haiku-4-5  capabilities:["context_management"] — NO `effort`, no default_effort at all
   `high` is the MIDDLE of the range, not the top. The mesh is paying the model's own baseline, not a
   deep-reasoning premium. Ceiling on Opus 5 is 33% (to low) / 24% (to medium) of model spend — real,
   but not 60-90%, and it is cost-per-unit-work, so extra turns at lower effort can erase it entirely.
   Sonnet seats are where the lever has teeth (53%/26%).
   The SDK sends nothing when unset (`if(this.options.effort)W.push("--effort",...)` in sdk.mjs) — the
   default is resolved DOWNSTREAM by the CLI binary, from a catalogue the repo does not control and
   that can shift on a CLI upgrade. It also reads the OPERATOR'S ~/.claude/settings.json, so an
   operator with a personal effortLevel silently makes every seat cost more or think less.
   THE REAL FINDING IS DETERMINISM, NOT SAVINGS: pinning `effort: "high"` explicitly changes no
   behaviour on a default machine and removes a variable that makes two operators' runs incomparable.
   Criteria generation CANNOT take this knob — it is on Haiku, which has no effort capability. That
   win was already taken by model routing in 4559f84, which is the bigger lever.
   Not yet done. `extraOptions` (runtime-claude:112) is spread last at :1047, so an A/B needs no code
   change. Thinking tokens ARE reported by the SDK (`usage.output_tokens_details.thinking_tokens`) and
   the adapter DISCARDS them — ClaudeTurnUsage (:193-198) declares 4 fields. Capturing that one field
   is additive and makes this measurable instead of inferred.
   Effort is spawn-time on the seat path, so it routes per SEAT, not per turn — except on models with
   a `per_turn_effort` capability, which Opus 5 does not have.

6. `maxBudgetUsd` — "a per-query USD stop that NEEDS NO NEW ROUTE" was HALF WRONG, and the wrong half
   is the whole point. It does need new work, precisely because the existing route is hostile to it.
   VERDICT (item M): DO NOT WIRE IT. Leave `taskBudget` alone too.

   IT WOULD AMPLIFY SPEND AT THE MOMENT IT BINDS. Traced end to end, both ends read:
   - The reason is surfaced only CONDITIONALLY, and probably not at all in practice. toTurnEnd:812 is
     `result.is_error ? (text || \`claude turn failed: ${result.subtype}\`) : undefined` where
     `text = result.result ?? ""` (:809) — so the subtype appears ONLY when the SDK returns no prose.
     Nothing anywhere branches on `error_max_budget_usd`; it is not a signal, just possible substring.
     The SDK does document it as the outcome of `maxBudgetUsd` (sdk.d.ts, `maxBudgetUsd?: number`).
   - supervisor.ts:3791 `if (output.error) throw new RuntimeFailure(output.error);`, and
     handleAgentFailure classifies with only TWO predicates: `slow = isTimeoutError(error)` (:4164)
     and `unreachable = !slow && isConnectionError(error)` (:4165). Only `slow` has a branch of its
     own (:4173-4192). `unreachable` merely bumps a streak counter (:4195-4197) and falls through to
     the same generic path a budget stop would: `willRestart = attempts <= 3 && persistent` (:4198).
   - EACH RESTART OPENS A NEW query(), SO THE BUDGET RESETS. A cap set to stop spending authorises
     three more full budgets the instant it trips.
   - None of the budget machinery ever learns: no `budget.exceeded`, no projection row, no card, no
     terminal verdict, no dashboard surface. The whole existing `budget_exhausted` vocabulary is
     bypassed, and telemetry records the constructor name `RuntimeFailure`.
   WHAT THE OPERATOR SEES: an agent that restarted three times and then failed — the exact flakiness
   shape — after spending ~4x the cap. That is the 04a9064 / 175fea1 class of bug reintroduced.

   THIS EXACT BUG ALREADY HAPPENED HERE ONCE, and the scar is in the file. supervisor.ts:4160-4163,
   the comment directly above those two predicates:
     "Conflating them is what suspended healthy agents — a 300s fetch cap fired mid-thought, looked
      like a transport error, and burned the restart budget three times over."
   A cap firing mid-turn, being misread as a transport failure, and burning the restart budget three
   times over is a description of what wiring `maxBudgetUsd` into this path would do — written by
   someone who had already paid for it once. The fix then was to give timeouts their own branch. Any
   future attempt at this needs a third predicate and a non-restart disposition, not a knob.
   Making it honest is ~7 touch points and includes a PROTOCOL CHANGE (`stopReason` is
   `"end_turn" | "error"`, types.ts:1272; a third state means schema regeneration — cf. a267a36).

   ALSO WRONG SCOPE. The allowance is per-`query()`, and `query()` is rebuilt by rotate() at 60% of
   the context window — so the budget RESETS ON EVERY ROTATION. It sits below the agent seat, which
   already has a token ledger, and it is narrower and less durable than what exists. The host ceiling
   (175fea1) already enforces USD at the only scope where USD means anything here.
   It also cuts against a deliberate split: the only token->USD math is `priceTokens`, host-side only.
   child.ts:43-44 — "pricing is host-side config, and a child has no business knowing what its
   operator pays." A USD knob fits cleanly in neither host.yaml nor mesh.yaml, which is itself the
   evidence that the scope is wrong.
   `taskBudget` is not a substitute: token-denominated not USD, it PACES rather than stops (so it
   enforces nothing), and it is @alpha behind a beta header.
   NOTE: `extraOptions` already lets an embedder set this TODAY — and they would get the restart
   storm. Production never populates it.

## SHIPPED this session

1. UNBOUNDED RE-INVOCATION — the stall path is now capped. supervisor.ts:
   `MAX_STALL_NUDGES = 3` module-local (:202, matching scheduler MAX_NUDGES, deliberately not a knob).
   Three unpersisted fields (~:605-639): delivered-nudge streak, refusal streak (kept separate so
   "driver ignored 3 nudges" never reads as "nothing could be scheduled"), escalate-once latch.
   Gate at ~:5704 raises `stalemate:stall_nudge_cap` and rests.
   DESIGN POINT: the card is the RELEASE as well as the alarm — when it is no longer open the streaks
   clear and that same tick drives the mission again. A latch-only cap would have made "escalated" a
   permanent stop, i.e. the deadlock the old `// NOTE: no nudge cap on this path` comment warned about
   wearing a card. That comment was rewritten, not deleted; its objection was correct and is why the
   cap escalates rather than going quiet.
   Catalog entry added: protocol/src/catalog.ts, `stalemate:stall_nudge_cap` after
   `stalemate:unanswered_request`. One entry covers both flavours; `detail.cause` distinguishes them.
   WORTH KNOWING: no test pinned the unbounded behaviour. The most any existing test drove was 2
   consecutive nudges — "nudge forever" was untested, not asserted. Three new tests now pin the cap.

   STILL UNCAPPED — SURVEYED (item H), AND THE ANSWER IS "LEAVE THEM". No new caps.
   Two of the five entries I wrote here were WRONG. Both are corrected below; the pattern in both
   errors was reading a raise site without reading who consumes the card.
   - scheduler/src/index.ts:708-714 queued-mail nudge — NOT unbounded. Bounded by the drain:
     MAX_DELIVERED_PER_TURN = 100 (turn-tracker.ts:169), applied supervisor.ts:3642. The inbox
     empties; the nudge stops. Missed on the first pass.
   - scheduler/src/index.ts:552-573 wakeAfterTurn requeue — refusal-adjacent, see overlap below.
   - supervisor.ts:1568-1579 partial ask discharge (NOT :1516-1526) — refusal-adjacent, see below.
   - termination.ts:165-177 artifactReviewRoundsMax=5 — FALSIFIED. It does stop rounds. The card is
     raised by `deadlock-detector` (supervisor.ts:5500), which is in STALEMATE_RAISERS
     (termination.ts:303). The stalemate query (:494-504) matches any OPEN non-advisory card from
     those raisers and returns {kind:"escalate", reason:"stalemate"} — the mission FREEZES. I read
     the raise and assumed nothing consumed it. Verified by reading both ends.
   - policy-engine/src/index.ts:235-236 max_activations is NOT "the only hard cap". Two mission
     budgets default without configuration: wall_clock_minutes ?? 240 and max_events ?? 10000
     (config/src/index.ts:628-629). max_activations (:512) is the one with NO default. I had it
     exactly backwards.

   OVERLAP WARNING — do not schedule the three refusal-adjacent paths above. They sit inside the
   uncommitted refusal-reporting work in the tree right now (policy-engine BLOCKED->goal-halted,
   scheduler lastRefusal/reportedRefusal, and the supervisor.ts:~4428 comment that says in as many
   words "those two wants are in conflict"). Settle that shape first; a cap layered on top of a
   refusal contract mid-redesign would encode the half-finished version.

3. MODEL TIERING — criteria generation now runs on Haiku.
   config/src/index.ts: `DEFAULT_CRITERIA_MODEL = "claude-haiku-4-5"`, `mesh.criteria_model` knob
   beside `generate_acceptance_criteria`; `|| DEFAULT` not `??` so a blank key falls back rather than
   handing the SDK "". criteria.ts: callback widened, optional `model` forwarded.
   mesh-server/src/index.ts:293 passes `config.criteriaModel`.
   schemas.ts: `criteria_model` added to the mesh block — REQUIRED, because that block is
   `additionalProperties: false` and `loadMeshFile` THROWS on schema failure, so without it any
   mesh.yaml setting the key hard-fails to load.

   MY ORIGINAL PREMISE HERE WAS WRONG. This never went through `modelFor()` (runtime-claude:502-504)
   or the SDK Options `model` at :1044 — those are the AGENT seat path. Criteria generation goes
   through the DESIGNER path, which has honoured `opts.model` all along (`DesignerPromptOptions.model`
   protocol/types.ts:1332, applied runtime-claude:796-798). The model could not get through only
   because the callback was typed `{ system: string }` — structurally narrower than the adapter
   accepts, sealing off every per-call knob. No runtime-claude change was needed.

   TWO TRAPS FOUND WHILE DOING IT:
   - Model ids in this repo are BARE AND UNDATED (`claude-opus-5`, `claude-sonnet-5`); a dated
     suffix is an older convention. `toClaudeModelId`'s docstring (runtime-claude:65) states the rule.
   - `toClaudeModelId` VALIDATES NOTHING. It strips a leading provider segment and returns the rest
     unchanged — it passes `totally-not-a-model` through as happily as a real id. It can never be the
     check on whether a model id exists. Convention and the reference are the only check.

## FALSIFIED — item 2 was wrong

2. spend_ceiling_usd IS NOT DEAD CODE. It is fully wired and enforced, in `apps/`, not `packages/`:
   host.ts:34 imports priceTokens; :390 `usd += priceTokens(...)` in spendOf; :410 ceilingUsd in
   aggregateSpend; :479 trips and calls parkChild. Dashboard UI in HostSettings.tsx.
   The original note searched only `packages/` and concluded from its absence there. Do not repeat
   that inference — this repo puts wiring in `apps/` and mechanism in `packages/`.

   WHAT IS ACTUALLY MISSING: the trip is silent. parkChild (host.ts:429) parks children and raises
   no escalation, so the operator gets `ceilingTripped` + `parked[]` on HostSpend and no card.

   WHY IT IS BLOCKED (verified, not assumed):
   - `/escalations` on the child is RESOLVE-ONLY: GET list, POST :id/respond, :id/answer, :id/drop
     (mesh-server/src/index.ts:1310+). No create verb.
   - Nothing outside packages/core calls `escalate()` — grep across apps/ and packages/ is empty.
   - No IPC fallback: projects/src/supervisor.ts:284 spawns `stdio: ["ignore","pipe","pipe"]` — no
     ipc slot, stdin ignored. Heartbeats are one-way child->host. HTTP is the only way in.
   - The one HTTP path reaching escalate() is `POST /internal/mcp/:agentId`, which needs a core-minted
     per-agent token and would attribute the card to an agent that is not taking a turn. host.ts:876
     deliberately strips exactly that credential: "The operator's credential stops here." Rejected on
     identity-forgery grounds — same class as dee5cf8.

   NOW SHIPPED (item B, commit 175fea1). The decision was taken deliberately: add the create verb,
   but NARROW — `POST /escalations/host-ceiling` names no reason, accepts no prose, and takes only
   the two numbers the card renders. A general `POST /escalations {reason, detail}` is the same
   amount of code and would let anyone holding a child token (or an operator token, which the host
   proxy exchanges for one on every proxied request) mint arbitrary cards into a mission's log,
   indistinguishable from ones the mesh raised about itself. Widening later is a smaller decision
   than narrowing after something depends on the wide version.
   raisedBy `host-limiter`, NOT human — an operator stopping a mission by hand is a different event
   on the timeline, and mis-attributing it is the dee5cf8 class of bug. Non-advisory, checked rather
   than assumed: resumeIfNothingPending (supervisor.ts:5485) ignores only advisory cards, and this
   one genuinely owes the operator a decision. Exported as HOST_LIMITER_RAISER beside the existing
   TERMINATION_RAISER so the dashboard can recognise the raiser.
   THE GUARD IS THE LOAD-BEARING PART, and it needed two levels:
   - Host-side `ceilingEscalated` Set, set ONLY on a 2xx (a child that 500s is retried next beat,
     not recorded as told). Cleared on the UN-TRIP path, not the park lifecycle — a park outlives a
     trip (the host has no resume) but a raised ceiling ends one. Also deleted at four child
     lifecycle sites so a replaced child inherits no mark describing a dead process.
   - Child-side conflictKey carries the CEILING VALUE, not a constant. A constant would dedupe the
     second card against the still-open first one and serve the operator stale numbers — the same
     swallow this route exists to fix, one layer down. Both covered by tests.
   NEGATIVE CONTROL RUN: with the guard bypassed the storm test logs 122 requests; with it, exactly 2.
   Test coverage gap found and filled: `GET /escalations`, `/answer` and `/drop` had NO HTTP-level
   coverage at all — the one test that touches them (resume-storm.test.ts:152) is gated on a
   gitignored fixture and skips on a clean checkout. New tests/server/escalations-routes.test.ts.

   FOR THE RECORD, the original framing below was right about the constraints and wrong about nothing:

   REMAINING WORK IS SMALL BUT IS A DESIGN DECISION, NOT A FIX: a `POST /escalations` route on the
   child (~5 lines; `supervisor` already in scope at that handler; `escalations` is already in
   CHILD_ROUTE_PREFIXES host.ts:68-92, so it becomes host- and operator-reachable with no host
   change). That adds an operator-facing verb for CREATING escalations to a resource that has only
   ever resolved them. Decide that deliberately.
   If it ships: host-side once-guard is mandatory — applyLimits re-runs every heartbeat (2s) across N
   children, so an unguarded call is an escalation storm, a worse cost bug than the one being fixed.
   escalate() dedupes on conflictKey against OPEN cards, which is one layer but not enough.
   Catalog entry needed: `host_spend_ceiling` — deliberately distinct from the four token-denominated
   *_budget_exhausted entries; this is a cross-project USD total enforced by a different process.
   Build note: parkChild is fire-and-forget (res.resume, 2s timeout). If the call needs a real ack
   before setting the guard, model it on proxyToProject, which streams the response.

## Demoted after reading source

4. Rotation at 120k. The original claim that rotation costs double was WRONG — the comment at
   :156-178 explains the mesh is state-projected and the supervisor refills a fresh session from
   projections every turn, so re-derivation cost is already mitigated by design. That comment argues
   rotation is CHEAP, which is an argument for rotating freely, not for rotating early.

   NOW SHIPPED (item G) — the threshold is derived per model, not fixed.
   The 60% ratio is PRESERVED, not replaced: 120k IS 60% of 200k, so the policy never changed, only
   its denominator stopped being hardcoded. runtime-claude/src/index.ts:
   `SESSION_CONTEXT_ROTATE_RATIO = 0.6` (:189) + `SESSION_CONTEXT_ROTATE_TOKENS = 120_000` (:198, now
   the conservative FLOOR, same name so the option docstring still resolves) + `MODEL_CONTEXT_WINDOWS`
   (:212, 9 bare ids) + `rotateAtFor()` (:236). Call site :661.
   Effect: Opus 5 / Sonnet 5 / Fable 5 rotate at 600k instead of 120k. Haiku 4.5 is BIT-IDENTICAL.
   Unknown ids are bit-identical (fall to the floor). 8/8 rotation tests pass, tsc clean.
   Lookup is an EXACT match against a closed table — never `toClaudeModelId`'s return treated as
   valid, which matters because that function validates nothing (see trap below). Deliberately NOT
   clamped up with Math.max: a known small-window model must rotate at its own share, not at a floor
   past its ceiling. Guessing high runs a seat off the end of its window mid-mission; guessing low
   costs a cache prefix and nothing else.

   ✅ RISK RESOLVED (item I) — G IS LIVE, NOT INERT. Was: "if the real CLI's init frame reports a
   model string that is NOT one of the 9 bare ids, every seat silently falls back to 120k". It does
   not, and the installed binary settles it without spending a token:
   - The init frame is emitted as a literal, found in the binary:
     `{type:"system",subtype:"init",cwd:w.cwd,session_id:w.sessionId,tools:...,mcp_servers:...,model:w.model,...}`
     so the reported value is whatever the CLI resolved, verbatim.
   - That resolution is to a CANONICAL, UNDATED id. The catalogue's own field is `id:"claude-sonnet-5"`
     beside `display_name:"Sonnet 5"` — two separate fields, so the frame cannot be reporting a
     display name. Its `context:{window:1e6}` is exactly the 1_000_000 this repo's table carries.
   - The CLI documents the concept in its own schema: `resolvedModel` = "Canonical wire model id this
     row's `value` resolves to (e.g. 'sonnet' → 'claude-sonnet-5')" — bare, undated, and it is the
     RESOLVED form that is carried, so even an alias input arrives as a bare id.
   - `canonicalModel` is likewise described as "Canonical model id used for the pricing lookup
     (e.g. 'claude-opus-4-7')".
   RESIDUAL: only a DATED id (a repo convention this project documents against) or an id newer than
   the table falls to the floor — which is the designed safe direction, not a bug. Static evidence,
   not a live frame; a real mission would still be the gold standard, but the two failure modes it
   was meant to catch are both excluded by source.

## Do NOT touch

usageToTokens (runtime-claude:139-160) excludes cache_read from `total` deliberately. Comment at
:139-148 records that charging off cumulative SDK fields caused a runaway that "exhausted 60k thread
budgets and looked like the mesh stopped for no reason". Leave it.

## Next

E DONE (negative result — effort is a 24-33% lever, not a 60-90% one; see finding 5).
G DONE (rotation derived per model; risk since RESOLVED — see item I below).
H DONE (negative result — NO new caps; two of my own claims falsified).
I DONE (negative result on the risk — G is live; see the resolved block above).
J K L DONE — SHIPPED AS ONE COMMIT, 5cbf0cd. Seat effort pinned, designer effort pinned, reasoning
   tokens reported. J's load-bearing claim held up: the CLI really does gate effort per model rather
   than reject an unsupported one, corroborated twice from the installed binary — the per-model row
   carries `supportsEffort`/`supportedEffortLevels` computed by the CLI itself, and the hook-side doc
   says the level is reported "after any silent downgrade for the selected model" and is "absent for
   ... models without effort support". So no second copy of the capability table is needed here.

Nothing left on this list. Superseded detail kept below for the record:

I. VERIFY G IS NOT INERT. Run one real mission and read the init frame's `model` string. If it is not
   a bare id, G bought nothing and the fallback needs to be `configuredModel`. Cheapest high-value
   check on this list — everything G won is contingent on it.
J. Pin `effort: "high"` explicitly on the seat path (finding 5). Near-zero risk, no behaviour change
   on a default machine, closes the operator-settings hole. Determinism, not savings — say so.
K. Capture `output_tokens_details.thinking_tokens` into ClaudeTurnUsage. Purely additive, does not
   touch the deliberate cache_read exclusion. Without it, effort work stays guesswork.
L. `effort: "medium"` for the designer chat ONLY (a human checks every turn). Note the seam: the
   designer and criteria share one Options literal, so it belongs on DesignerPromptOptions
   (protocol/types.ts:1328-1343), which the criteria.ts:120-125 comment already anticipates.
M. maxBudgetUsd (finding 6) — EXAMINED, ANSWER IS NO. Its premise ("reaches a cost cap without a new
   route") was false: the existing route restarts it three times with a fresh budget each time, so
   wiring it raises spend at the moment it binds. See finding 6 above. No code change.

RETRACTED (was: "Noted, not scheduled — `TriageModel` is never constructed, triage always falls
through to a text heuristic; the obvious home for the next Haiku one-shot"). Both halves fail, and
it should never have been written down:
- The heuristic claim is FALSE. `scheduler/src/index.ts:282` returns `"ACT"` on
  `triageMode === "off"` BEFORE the `triageModel` check at :283, and the default is `"off"`
  (`config/src/index.ts:679`). By default triage reaches neither the model nor the heuristic.
- Nothing can select it anyway: the enum is `"off" | "heuristic"` (`config/src/index.ts:365`).
  There is no `"model"` member, so a constructed `TriageModel` would still be unreachable.
- ALREADY SETTLED, BY US, IN SESSION 10: NOTES-blocking-reasons-survey.md:535-539 and :562 —
  "`TriageModel` — NOT dead in the same sense. Leave it." Surfacing it as a new lead was a
  regression against our own written verdict, from relaying an item-E aside without checking either
  the source or these notes. Same failure mode as the five in READ THIS FIRST: one end read, the
  other inferred.
