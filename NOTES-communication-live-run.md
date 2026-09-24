# Communication failures, observed live — the skill-panel run of 2026-09-23

Status: OBSERVATION. No code written, nothing staged. This documents a single live mission
watched end to end; it proposes nothing beyond §10. Sits alongside
`NOTES-communication-measured-review.md` (which argued from replayed logs and per-turn audits)
and `NOTES-communication-rewrite-TODO.md` (the ledger) — this one is the first record of
watching a mission fail in real time rather than reading it afterwards.

Requested: *"watch the communications happend in skill-mesh and note the problems in
communications"*

Subject: project `skill-panel` (`~/.agent-mesh/projects.json`), goal
`goal-M36FJVNS00489c2c2927` — "Build the operating system for AI-agent skills".

**Observation window: 06:34:54 → 07:06:06**, 31 minutes, ending when the mission halted on
`agent_budget_exhausted`. Every measurement in this document is a snapshot at that halt.
**The mission is not over** — at 07:41:24 the operator answered the escalation with *"raised
budget to 4.8M — continue with smaller steps"* and the goal returned to ACTIVE. Post-resume
behaviour is out of scope here; see §11.

Source: `/home/alitabatabaei/Desktop/code/skill-panel/workspace/.mesh-state/logs/events.jsonl`,
read live as it was written (793 records at the halt), plus that project's `mesh.yaml` and
`roles/*.md`. Code references below were traced against this repo at HEAD; the run itself was
never modified.

---

## 1. The finding, first

**Every layer that failed here failed by returning `{ ok: true }`.**

Denied operations proceeded. Undeliverable mail reported success. Approvals that changed
nothing emitted approval events. Tasks nobody could claim were delegated and acknowledged as
sent. The one subsystem that reliably failed closed was AJV schema validation — which nobody
designed as the authority model.

The agents wrote well. tech-lead's review errata (E1–E8) were sharp and specific; backend's
idle report named three concrete blockers; the architect's five ADRs were substantial. Not one
of the problems below is a writing-quality problem. They are transport, timing, name binding,
and enforcement that doesn't enforce.

The mission produced **19 artifacts and settled 2**.

---

## 2. The headline: instruction arrives after the work it governs is approved

```
06:37:06  architect woken by "startup", goes THINKING
06:38:58  pm sends MISSION + DELEGATE -> architect   (17 criteria, 9 designMustSettle items)
06:40:07  tech-lead sends the review gate -> architect ("this is the bar, not a question")
06:40:43  architect publishes 7 artifacts + requests review   <- has received NOTHING
06:42:47  architect's next turn begins; it now sees the MISSION, DELEGATE and gate
06:43:35  tech-lead APPROVES all 7
06:45:30  architect replies with payload key `againstYourDesignMustSettle`
```

The brief and the acceptance bar were both written to govern an artifact that was authored
without either. The architect's 06:45:30 message is a retrofit — it answers a mission it read
after the deliverable had shipped.

Mechanism (traced):

- MISSION classifies as `deliver` (not obliging per `catalog.ts:310`, but work-moving per
  `catalog.ts:373`), so its wake is **coalesced**, not immediate —
  `scheduler/src/index.ts:422`, default 60s at `:70`.
- `drainGathered` **discards a coalesced wake entirely** if the seat is already queued or
  running — `scheduler/src/index.ts:331-339`. The architect had been THINKING since 06:37:06,
  112 seconds before pm sent the MISSION. The wake was not deferred; it was dropped.
- Mail is snapshotted at turn start (`supervisor.ts:4331`) and drained only after the model
  returns (`supervisor.ts:4561`). Mail arriving mid-turn is invisible to that turn.
- Nothing expires, redelivers or dead-letters it, so it simply waited for the next turn.

Contributing config: `scheduling.concurrency.max_active_agents: 3` against 9 seats, with
`triage.rules: []`. A 3-slot cap means seats are frequently "already queued" — precisely the
condition under which `drainGathered` throws a wake away.

---

## 3. Delivery, measured

`message.delivered` is emitted at **turn end**, after the model call returns, against a mailbox
snapshotted at **turn start**. Time-to-read is therefore measured to turn start, not to the
event.

```
                          first 10 min      full run
delivered / addressed         31%              81%
time-to-read (median)        202s             202s
time-to-read (max)           663s             872s+
```

The cold-start penalty dominates the early number and the mesh does converge — but two
recipients of pm's 06:38:58 broadcast (`qa`, `ux-designer`) were still unread 15 minutes later,
and `ui-designer` read it at +872s.

Why the broadcast mostly vanished (traced):

- **A broadcast wakes only seats whose `interests:` include `message.sent`**
  (`scheduler/src/index.ts:387-390`). No agent in this mesh lists it. pm's 8-way INFORM woke
  *nobody*; every delivery it got was incidental — a seat woken by something else happening to
  drain its box.
- Broadcasts are explicitly excluded from the only timer safety net
  (`scheduler/src/index.ts:1007`).
- `selectUnread` sorts into two bands — obliging (`REQUEST*`/`ESCALATE`/`CHALLENGE`) first,
  everything else second (`context.ts:113-122`). **A broadcast INFORM is band 1 by mode; a
  MISSION is band 1 by type.** Priority sorts only *within* a band, so an URGENT INFORM ranks
  below every ordinary REQUEST, inside a 12-slot window (`MAX_UNREAD`, `context.ts:37`).
- There is **no TTL, no redelivery, no dead-letter**. `sweepExpiredCommitments`
  (`supervisor.ts:7087-7110`) closes the *debt* and wakes the asker; the message stays in the
  box. The only terminal state is the 200-deep cap silently splicing mail out
  (`projections-messaging.ts:589-605`), confessed only in the end-of-run report
  (`run-report.ts:900`).

---

## 4. Enforcement that doesn't enforce

### 4a. The capability check tests the wrong party, 7 times out of 7

```
06:42:47  marketing  request review  DENY  lacks 'review.design'
06:44:27  marketing  request review  DENY  lacks 'review.design'      (identical, +100s)
06:47:57  frontend   claim task      DENY  lacks 'test.execute'
06:54:57  backend    request review  DENY  lacks 'code.review'
06:55:12  backend    request review  DENY  lacks 'code.review'        (identical, +15s)
07:04:48  backend    claim task      DENY  lacks 'test.execute'
07:04:48  backend    request review  DENY  lacks 'code.review'        (identical, third time)
```

`supervisor.ts:5735-5738` tests `actorId` — the seat *asking* — against
`capabilityForReview(artifact.type)`. The intended reviewers (`op.reviewers`) are first touched
six lines later at `:5744`; **no reviewer-side capability check exists on that path.**
`review.design` is the reviewer's token everywhere else in the codebase (`REVIEW_CAPABILITIES`,
`canReviewArtifactType` gating APPROVED/REJECTED, `recordDecision` checking the approver).

The correct sender-side gate exists — `request_review` via `sendMessageCapability`
(`supervisor.ts:6245-6255`), documented at `catalog.ts:804-807` — and is **never called from
production code**. Only a comment and a test reference it.

### 4b. The DENY gates nothing

`:5738` has no `return`. `denied()` emits one `message.rejected` and control falls through to
the artifact transition, the send, and `return { ok: true, messageId }`. The agent is told it
succeeded. Observed at 06:54:57 in a single second:

```
message.rejected     backend "does not hold capability 'code.review'"
artifact.transition  -> READY_FOR_REVIEW   gateSatisfied: true
SENT PATCH_READY     backend -> tech-lead
```

The review gate reports `gateSatisfied: true` on the very artifact whose review request was
just denied.

### 4c. The sender never learns

The denial payload carries an `action` and no `to`, so it lands in `state.deniedActions`
(`projections-messaging.ts:564-582`), read only by the operator digest (`mcp.ts:636`) and
snapshot persistence. `context.ts` reads neither `deniedActions` nor `refusedSends`; the bundle
type has no field for them. There is no in-band path by which an agent can discover its own
refusal — in that turn or any later one.

The identical repeats above are therefore **designed behaviour, not model failures**.

### 4d. What actually does fail closed

```
schema validation      1x  -> BLOCKED   (PATCH_READY dropped: /artifactRefs/0/uri)
communication policy   1x  -> BLOCKED   (then legitimately re-routed in-thread)
capabilities           7x  -> logged, proceeded
```

The dropped `PATCH_READY` was backend's notification that CodePatch v2 existed. It is gone, and
backend will never know. tech-lead heard about v2 anyway — only because backend also fires a
redundant `REQUEST_REVIEW`, the same duplicate-ask habit that caused a duplicate approval
(§5b). One defect masked another.

---

## 5. The approval subsystem

### 5a. Whether an approval takes effect depends on a free-text word

```
approver   subject word      event emitted          artifact ends at
pm         requirements   -> review.approved        FINAL
tech-lead  architecture   -> architecture.approved  READY_FOR_REVIEW   (x9)
pm         requirements   -> review.approved        APPROVED
tech-lead  implementation -> review.approved        APPROVED
```

**tech-lead sits on both sides of the line.** `"implementation"` on backend's CodePatch moved it
to APPROVED. `"architecture"` on nine architecture documents moved nothing — the two
ArchitectureDocuments and five ADRs it approved at 06:43:35 with binding errata E1–E8 are still
`READY_FOR_REVIEW` at mission end.

> **Mechanism corrected — see §9.4.** This paragraph originally said the reducer advances an
> artifact only on `review.approved` and that `architecture.approved` triggers nothing. It has a
> reducer case of its own (`projections-artifact.ts:185-193`); what differs is the *status guard*
> — `review.approved` settles from `UNDER_REVIEW` **or** `READY_FOR_REVIEW`,
> `architecture.approved` only from `UNDER_REVIEW`. And the reason all nine were sitting in
> READY_FOR_REVIEW is upstream of both: they were never submitted for review, because one
> `request_review` op covers one artifact and seven documents were published against a single ask.
> The table above stands; the sentence explaining it did not.

Downstream consequence, live: `backend.md` says *"Do not start feature work before
`architecture.approved`"*. That event fired nine times, so every implementer treated the
architecture as signed off — while the artifacts themselves remained unapproved. **The gate
signal and the artifact state disagree, and the agents follow the signal.**

### 5b. Authority routing bypasses the artifact-type gate

`domainOfSubject` (`projections-helpers.ts:256`) matches the literal subject string against six
domain words **before** the artifact-type switch at `:257-277`. pm typed `subject:
"requirements"`, holds `requirements.approve`, and the check became "does pm hold requirements
authority?" — yes. The ApiSpec's actual gate, `review.design`, was never consulted.

Generalises: **holding any one of the six `<domain>.approve` authorities lets a seat approve any
artifact of any type by naming that domain word.** `op.subject` is free text from the model
(`types.ts:1695`) and nothing cross-checks it against the resolved artifact.

The block I first assumed was the gate is a **widener**: `supervisor.ts:2993` runs only when the
authority check has already *failed*, to let a `review.design` holder stand in for missing
authority. pm's authority check passed, so no capability was ever consulted.

**The same state change is refused one way and granted the other.** Had pm used
`transition_artifact -> APPROVED`, `canReviewArtifactType(pm, ApiSpec)` would have denied it
with `ruleId: "review-authority"` (`policy-engine/src/index.ts:166-173`). Reducers never consult
the policy engine, so the `approve` op walks around it.

Full chain for the run's only cleanly-APPROVED non-code artifact:

```
06:42:47  marketing DENIED request review (wrong side, §4a)
06:42:47  ...denial has no return, so:     -> READY_FOR_REVIEW  gateSatisfied: true
06:42:47  review.requested derives          -> UNDER_REVIEW
06:55:24  pm approve, subject "requirements" -> review.approved
06:55:24  reducer advances, actor=system     -> APPROVED  derived: true
```

The denial in step 1 *created the precondition* for the bypass in step 4.

### 5c. Self-approval is weaker than the prompts claim

Runtime-enforced by three gates, but all three are conditional on "could anyone else have
reviewed this?". For `RequirementsDoc`, `capabilityForReview` has no case and returns null, so
only another live agent with requirements authority counts. pm is the sole such seat, so pm's
self-approval of its own RequirementsDoc at 06:38:58 passed with no denial.

Worse: core and the policy engine keep **two different peer tables** —
`capabilityForReview` (`projections-helpers.ts:234-246`) versus `REVIEW_CAPABILITIES`
(`policy-engine/src/index.ts:445-455`). They disagree on exactly `RequirementsDoc`,
`TestReport` and `ReleasePlan`, making self-approval systematically easier through `approve`
than through `transition_artifact`.

---

## 6. Names that don't bind, and seats that never ran

### 6a. Role prompts address seats that do not exist

| prompt | names | reality |
|---|---|---|
| architect.md | `explorer` | no such seat — so the architect guessed instead of reading the repo |
| pm, backend, frontend, qa, reviewer.md | `reviewer` | no such seat; the actual id is `tech-lead` |
| backend.md, frontend.md | send `PATCH_READY` to `qa` | neither may contact qa |

Only `pm` may contact `qa` (`policies.communication`). The QA handoff is structurally
impossible as written, and it became load-bearing: two artifacts reached APPROVED with the test
seat both dark and unreachable by the approver.

### 6b. Three seats have no role prompt at all

`marketing`, `ux-designer`, `ui-designer` — `prompt: {}`. `architect.md` is 432 characters
against ~3000 for the others and carries no communication contract.

This correlates directly with protocol adherence. `replyTo` is the runtime's only exact
answer signal; the five prompts containing the "Answering requests" section use it, and:

```
agent        prompt file            teaches replyTo   replyTo used / sent
architect    ./roles/architect.md   no                 1 / 13
marketing    (none)                 no                 0 / 5
backend      ./roles/backend.md     yes                (uses it)
frontend     ./roles/frontend.md    yes                2 / 6
tech-lead    ./roles/reviewer.md    yes                1 / 4
```

### 6c. Interest vocabulary doesn't match what the kernel emits

11 of the 16 subscribed event types never fired **in this run**.

> **Overstated — corrected, see §9.5.** This section originally said
> `requirements.created` "never fires" and that publishing a RequirementsDoc emits generic
> `artifact.created` instead. It has two emitters (`supervisor.ts:2625`, `:3678`); it did not
> fire *here*. Of the sixteen subscribed types exactly one — `requirement.blocked` — has no
> emitter anywhere in production code and is therefore genuinely unreachable. The rest are a
> run-shape observation, not a broken vocabulary.

What stands is the consequence: with its declared interests silent, `marketing` was reachable
only through `artifact.created`, a firehose that fires on every artifact any seat publishes. That
is how a seat with no role prompt was pulled into the mission at 06:38:25, and marketing is what
eventually halted it (§8).

`architecture.approved` fired **7 times for one decision** — once per artifact — against 4
subscribers.

`qa` subscribes to `release.candidate`, `implementation.completed`, `patch.merged`. **None ever
fired. qa took 0 turns in 31 minutes**, and its first activation attempt arrived in the same
second as the halt and was refused by it.

### 6d. The contact matrix is one-way in 8 pairs

```
architect  -> backend, frontend, ux-designer, ui-designer   (none may initiate back)
tech-lead  -> marketing, ui-designer
marketing  -> ux-designer
qa         -> tech-lead
```

Default contact is deny-all (`config/src/index.ts:1110-1112`, `:1162-1165`;
`communicationAllows` at `policy-engine/src/index.ts:420-433`), with the human seat,
hierarchical `#` prefixes, and in-thread replies as the only escapes. Every seat's
`may_be_contacted_by` is `[]` — the inbound half of the contract is unconfigured across the
board.

Consequence: the architect can delegate to all four implementers; not one may open a thread
back. The thread the architect opens is the *only* channel home — which matters because its
DELEGATE payloads carry nothing (§6e).

The one `ruleId: communication` denial of the run behaved **correctly**: ux-designer was blocked
from initiating contact with marketing at 06:56:35, then legitimately reached it 9 seconds later
by replying inside marketing's own thread. Blocked, re-routed, as designed — the contrast with
§4b is the point.

### 6e. Message payloads have no schema, and DELEGATE has no content

No shared shape per message type. Senders invent keys: `whatIneed`, `unblocks`, `forPM`,
`forUIUX`, `notAProseClaim`, `againstYourDesignMustSettle`, `hard_requirements`,
`no_new_subsystem`, `backend_commitments`, `errata_addressed`, `next_backend_slice`. camelCase
vs snake_case splits cleanly by sender.

`DELEGATE` is the opposite failure: **all 10 of them carry `{"taskId": "..."}` and nothing
else.** The recipient gets an opaque id and no instruction.

Result — the open-ask backlog collapsed into one shape:

```
open asks: 16 of 32      DELEGATE 14  |  REQUEST_REVIEW 3  |  REQUEST 1
```

REQUEST-shaped asks get answered. DELEGATEs never do. There is nothing in the message to reply
to, and `discharge` — the documented fallback — appears only in the role prompts the architect
doesn't have.

### 6f. `task.requiredCapabilities` is the one place aliases are not applied

`CAPABILITY_ALIASES` (`catalog.ts:886-903`) normalizes agent definitions
(`config/src/index.ts:1098`), policy rules (`:1947-1950`) and runtime tool gating
(`runtime-claude/src/index.ts:531,545`) — but `newTask` stores requirements raw
(`supervisor.ts:5902,5920`), `claimTask` compares them raw (`:3119-3121`), and `delegate` does a
raw `includes` (`:5941`).

So a task written with `test.run` is unclaimable by the holder of `test.execute`, and an
invented token is never validated against `CAPABILITY_TOKENS` at all.

Live effect — the field was guessed, four different ways in 18 minutes:

```
06:38:58  pm         repository.read                              -> anyone
06:44:44  backend    repository.write, test.write                 -> calibrated (claimed)
06:45:30  architect  repository.write, test.execute        x9     -> NOBODY
06:53:50  tech-lead  []                                    x2     -> anyone
06:55:24  pm         repository.write, test.write, shell.execute  -> calibrated
06:56:54  architect  repository.write, test.write, shell.execute  -> calibrated
06:56:54  architect  []                                           -> anyone
```

After aliasing, `repository.write` and `test.execute` are held by **disjoint sets**:

| holds | seats |
|---|---|
| `repository.write` only | backend, frontend, ux-designer, ui-designer |
| `test.execute` only | qa, tech-lead |
| **both** | **nobody** |

All nine architect tasks required both. Both frontend (06:47:57) and backend (07:04:48) bounced
off them. The only implementation progress in the run came from backend writing its own work
order with requirements it could satisfy.

Nothing corrected the architect: frontend's bounce was a `message.rejected` addressed to
frontend, which per §4c reaches nobody. The later calibrated tasks are a fresh guess that
happened to land, not a correction.

### 6g. The same work was created three times

```
06:53:50  tech-lead  "T3.1 ui flows + Playwright e2e over se..."   []
06:55:24  pm         "T3.1 - UI flows + Playwright e2e evide..."   repository.write,test.write,shell.execute
06:56:54  architect  "T3.1 UI implementation + UI test suite"      repository.write,test.write,shell.execute
```

Three seats opened T3.1 within three minutes with two different capability specs. The core
slice is tripled too (backend 06:44:44, architect 06:45:30, tech-lead 06:53:50). `task.created`
fires and four seats subscribe — but seeing a task doesn't stop a seat creating its own version,
and the read latency of §3 means all three T3.1 authors worked from a board that didn't yet show
the other two.

---

## 7. Cause of the halt, and what it cost

At **07:06:06** `termination-manager` raised `escalation.requested` with reason
`agent_budget_exhausted`: marketing at **176899/160000**, its second overrun against a ceiling
already doubled from 80k. `goal.escalated` fired and every activation is now refused with
`mission is escalated — respond to the open escalation first` (`ruleId: goal-halted`).

The turn that halted the mission did nothing. marketing's own memory note:

> ⚠ no mesh ops parsed from output — nothing was sent, published, or requested (model said: *I
> have the approved v2 text. Publishing v3 with A1/A2, correcting the deny-reason record, and
> closing the ux-designer loop.*)

**Unparsed turn output is billed as work.** And it happened to the seat with `prompt: {}` —
no role file, no ops contract — which was pulled into the mission by the `artifact.created`
firehose of §6c.

Budget overruns, all six:

```
06:42:47  marketing    93656/80000    (+17%)
06:47:20  architect   124388/120000   (+3%)
06:55:30  pm          133434/120000   (+11%)
07:04:29  tech-lead   242101/180000   (+34%)
07:04:48  backend     316516/240000   (+32%)
07:06:06  marketing   176899/160000   (+11%)  -> HALT
```

Six overruns, six auto-raises, every seat that ever ran. backend burned 2.6x its original
allocation. **What drains budget is redone work**, and what causes redone work is stale mail:
tech-lead approved backend's CodePatch **twice** (07:03:24 and 07:04:29) because backend's
duplicate `REQUEST_REVIEW` from 06:55:12 — itself caused by §4b firing twice and blocking
neither — arrived 9 minutes stale and was answered separately rather than recognised as done.

### The halt is asymmetric

It blocks activation, not sending. tech-lead, inside a turn begun before the halt, posted two
INFORMs to backend at 07:08:45 while backend's activation was refused in the same second. Those
messages sit in a mailbox with no possible consumer, and per §3 nothing will ever retry them.
The sender got `{ ok: true }`.

---

## 8. Tally at the halt

Snapshot at 07:06:06, not a final state — the mission resumed at 07:41:24.

```
window        06:34:54 -> 07:06:06  (31 min)
messages      76    addressed-pairs 92    delivered 75 (81%)
asks          32    still open      16
threads       45    replyTo set     25/76
artifacts     19 -> 1 FINAL   1 APPROVED   14 READY_FOR_REVIEW   2 UNDER_REVIEW   1 DRAFT
tasks         16    claimed 4     open 12
rejections    13    budget overruns 6    auto-raises 6
turns         tech-lead 7, architect 6, pm 5, backend 5, marketing 4,
              frontend 4, ux-designer 4, ui-designer 2, qa 0
```

Fourteen of nineteen artifacts ended `READY_FOR_REVIEW` — including every architecture document
that had already been explicitly approved.

---

## 9. Corrections made during the watch

Kept visible, per house style, so the correction has something to point at.

1. **"`repository.write` is held by nobody" — WRONG.** I read the raw `mesh.yaml` text rather
   than the resolved roster. `CAPABILITY_ALIASES` normalizes at config load, so
   `api.write`/`data.write`/`ui.write` -> `repository.write`. The deadlock survives in the
   sharper form at §6f: no seat holds both required tokens. Corrected mid-run.

2. **Delivery-lag figures overstated.** I first quoted median 374s / max 872s, measured to the
   `message.delivered` event. That event fires at **turn end**; the mailbox is snapshotted at
   **turn start**. True time-to-read is median 202s. §3 uses the corrected basis. The §2
   conclusion is unaffected — the architect's first sight of the MISSION was 06:42:47, still two
   minutes after it had published.

3. **`architecture.approved` triggers no reducer — WRONG.** It has a case at
   `projections-artifact.ts:185-193`; what differs from `review.approved` is the status guard, not
   the existence of a handler. Found while fixing it, and the fix came out narrower as a result:
   widening the guard to match changes how existing logs project and breaks replay
   (`tests/integration/resume-storm` catches it), so the guard stays and the real repair is
   upstream — one `review.requested` per resolvable artifact ref. §5a points here.

4. **"`requirements.created` never fires" — OVERSTATED.** It has two emitters
   (`supervisor.ts:2625`, `:3678`) and simply did not fire in this run. Checked while fixing
   §6c: of the sixteen subscribed types only `requirement.blocked` has no emitter anywhere and is
   genuinely dead. §6c points here.

5. **"`may_be_contacted_by: []` on every seat" is not a defect.** I listed it as an open
   problem; it is a no-op. `communicationAllows` (`policy-engine/src/index.ts:420-433`) ORs four
   grants — the sender's `may_contact` by id and by config key, the recipient's
   `may_be_contacted_by` by id and by key — plus two role-based forms. So the inbound list is an
   ADDITIONAL grant, and empty means "no extra inbound beyond what senders' own lists already
   give me". `warnUnreachableAgents` (`config/src/index.ts:1663-1683`) agrees: a seat counts as
   wired if its own `may_contact` is non-empty OR anyone else names it. The one-way pairs in §6d
   are the outbound-only design working as written, not a gap.

6. **"Nothing retries, penalises, or stops a seat repeating an unproductive turn" — WRONG.**
   §7 said this; it is not true. `supervisor.ts:4840` reports the turn as `"blocked"` rather than
   `"ok"` precisely so it reaches the breaker, and `Scheduler.noteTurnOutcome`
   (`scheduler/src/index.ts:573-582`) strikes on anything but `"ok"` and parks the seat for
   `PARK_MS` at `STRIKE_LIMIT = 3` (`:129-130`). A seat producing unproductive turns does get
   parked. What is true, and is all that is true, is that a SINGLE unproductive turn is billed in
   full — which is correct accounting, since the tokens were genuinely spent. The live mission
   halted because marketing's first such turn crossed a ceiling already raised twice, not because
   the runtime failed to notice.

7. **"`architecture.approved` fires 7x per decision" is not wake amplification.** I listed it as
   an open problem. `requestActivation` dedups per agent: a second request for a seat already in
   the queue collapses to one entry, keeping the higher priority
   (`scheduler/src/index.ts:585-593`), and a request while the seat is busy parks in
   `wakeAfterTurn`, a Map keyed by agentId (`:567-571`). Seven events buy one wake. The seven log
   lines and seven `ops.decisions` increments are arguably correct — seven artifacts were
   approved.

8. **"Nobody answers" was partly a cold-start artifact.** Measured over the first ten minutes it
   was 4 `replyTo` in 32 messages; over the full run it is 25 in 76, and delivery went 31% ->
   81%. The obligation numbers never recovered (§6e), but the framing in my first pass was
   measuring warm-up.

---

## 10. What to fix first

Ordered by ratio of consequence to diff size. Nothing here is staged.

1. **`supervisor.ts:5738` — add the missing `return`.** One line. Makes 7-of-7 failed-open
   denials fail closed, and removes the precondition that made the §5b bypass reachable.
2. **`projections-helpers.ts:256` — stop matching the literal subject string before the
   artifact-type switch**, or cross-check it against the resolved artifact. Closes the
   any-domain-approves-anything hole.
3. **Route `review.approved` for the `architecture` subject**, or make the reducer advance on
   `architecture.approved` too. Nine approvals currently evaporate.
4. **Normalize `task.requiredCapabilities`** through `normalizeCapability` at `newTask`,
   `claimTask` and `delegate`, and validate tokens against `CAPABILITY_TOKENS` at creation.
5. **Feed `deniedActions` / `refusedSends` into `context.ts`** so a seat can see its own
   refusals. Without this, every denial above is unlearnable.
6. **Reconcile the two peer tables** (`capabilityForReview` vs `REVIEW_CAPABILITIES`).

Config-level, for `skill-panel` specifically and not for this repo: give `marketing`,
`ux-designer` and `ui-designer` role prompts; fix `reviewer`/`explorer` to real seat ids; put
`qa` in someone's `may_contact` besides pm; and narrow `marketing`'s `artifact.created`
interest.

---

## 11. What was not measured

- **Only one mission.** Every number here is n=1. The defect *mechanisms* are traced to code and
  are not run-specific; the *rates* (81% delivery, 6 overruns) are one sample.
- **No counterfactual.** Nothing was patched and re-run, so "fix 1 would have prevented the
  halt" is untested reasoning, not a measured claim.
- **Model quality untested.** Whether better-written messages would have routed better is
  unknown; §1 asserts only that the observed failures were not writing failures.
- **Post-resume behaviour not observed.** The operator answered the escalation at 07:41:24
  (budget raised to 4.8M, "continue with smaller steps") and the goal went ACTIVE again; the
  watch had already ended. Open questions this run can no longer answer: whether the mail
  undelivered at the halt (§3) is ever drained after a resume, whether the 14 artifacts stuck at
  READY_FOR_REVIEW (§5a) are ever re-approved under a subject word that takes effect, and
  whether the nine unclaimable tasks (§6f) are reissued or abandoned. A second watch across the
  resume would settle all three.
- **Thread-budget and interrupt-pricing paths** were never exercised by this run and are not
  assessed here.

---

## 12. What was fixed

All of §10, plus Part B and the `skill-panel` config, are implemented and green
(1819 tests pass, 0 lint errors). What each fix actually became, and where it departed from the
plan:

| | fix | site |
|---|---|---|
| A1 | a refused `request_review` leaves no state behind — the send runs first and the artifact moves only once it is accepted | `supervisor.ts` |
| A2 | the requester-side `capabilityForReview` gate is gone; it tested the wrong party and gated nothing | `supervisor.ts` |
| A3 | **changed approach.** See §13.1 — the subject word must win over the artifact | `projections-helpers.ts` |
| A4 | `approvalPath` replaces the hardcoded `APPROVED`; the status guard stays (see §13.2) | `projections-artifact.ts` |
| A5 | one `review.requested` per resolvable artifact ref | `supervisor.ts` |
| A6 | one review table in core, re-exported from policy-engine; four disagreements closed, `RETIRED` reconciled | `projections-helpers.ts`, `policy-engine` |
| A7 | task capabilities normalize at the single funnel, validate against `CAPABILITY_TOKENS`, and `delegate` compares like for like | `supervisor.ts` |
| A8 | a `refusals` context slot above `mail`, in all three degradation tiers | `context.ts`, `types.ts` |
| B1 | an age floor on unread mail — the case the wake gates' own safety argument does not cover | `scheduler` |
| B2 | `drainGathered` re-arms instead of discarding a coalesced wake | `scheduler` |
| B3 | three-band mail order, so a MISSION is not outranked by routine asks | `context.ts` |
| B4 | dropped mail is surfaced to the seat that lost it | `context.ts`, `types.ts` |
| — | **new: `approverMayAdvance`** — recording a verdict and MOVING an artifact are different powers | `projections-helpers.ts` |
| — | **new: DELEGATE carries title, description and required capabilities**, not a bare `{taskId}` | `supervisor.ts` |
| — | **new: an approval that cannot advance its artifact says so** (a caveat, not a refusal — gate signatures depend on signing those statuses) | `supervisor.ts` |
| — | **new: a second open task with the same title is refused**, naming the first | `supervisor.ts` |
| — | **new: `requirement.blocked` emits on reopen**, for criteria the reopen actually withdrew | `supervisor.ts` |

### 12.1 `requirement.blocked` — why reopen, and what is deliberately not announced

It had no emitter anywhere: declared, schema'd, `alert` severity, handled by a reducer, subscribed
to by five shipped configs and by `roles/pm.md` ("never ignore it"). Reopen is the one place the
runtime genuinely knows a criterion has regressed. Only criteria that EXISTED and were not already
UNSATISFIED are announced — a criterion minted from the reopen reason is new work, not work put
back in the way, and announcing it would fire the event on every reopen.

---

## 13. Corrections to fixes made while making them

### 13.1 A3 was the wrong remedy, twice over

The plan said to make the artifact win over the typed subject in `domainOfSubject`. That breaks
the `<role>.approve` gate system outright: QA recording `subject: "quality"` against a CodePatch
is the cross-domain sign-off every transition gate is built on, and resolving that to
`implementation` makes the gate unsatisfiable by the seat it names. The subject names the CAPACITY
the signer acts in, not the domain the artifact belongs to.

The real defect was never the ordering — it was that a capacity claim conferred the power to move
someone else's artifact. That is now screened where the movement happens, by `approverMayAdvance`,
which asks the same question the transition path already asks (`canReviewArtifactType`).

### 13.2 A4's status guard stays asymmetric, on purpose

Widening the `architecture.approved` guard to match `review.approved` changes how existing logs
project: a document approved while merely READY_FOR_REVIEW advances to FINAL, and a real mission
log then replays a later READY_FOR_REVIEW transition that used to be absorbed as a no-op and is
now illegal. `tests/integration/resume-storm` catches it. Replay equality is the property the
event store rests on, so it outranks the inconsistency. `approvalPath` replaces the hardcoded
target; the guard stays.

### 13.3 A defect I introduced, and how it surfaced

Reordering A1 so the send runs before the artifact moves had a consequence I did not foresee.
`sendMessage` runs `deriveSemantic`, which emits `review.requested`, whose reducer walks
DRAFT -> READY_FOR_REVIEW -> UNDER_REVIEW. The op's own `transitionArtifact(READY_FOR_REVIEW)`
then ran on an artifact already at UNDER_REVIEW and pulled it BACKWARDS — a legal transition, so
it happened silently. Every artifact submitted for review landed one step short of reviewable and
every later approval of it was inert.

No existing test caught it; the full suite was green with the bug in place. It surfaced only when
`tests/policy/inert-approval.test.ts` asserted the status after a review request. The fix
transitions only while the artifact is still DRAFT, which is also the only case the reducer cannot
serve (an unresolvable artifact ref).

---

## 14. Second watch: the window §11 left open, and the run after the fixes

§11 said "a second watch across the resume would settle all three." This is that watch. It reads
the **whole** archived log, not the 793 records visible at the halt:

```
/home/alitabatabaei/Desktop/code/skill-panel/.mesh-backups/skill-panel/
  .mesh-state.bak-20260923-111715/logs/events.jsonl      1521 events, 06:34:54 -> 11:17:03 UTC
```

**Timing that decides how to read everything below.** The fixes in §12 were built at **14:21
local**; `dist/packages/core/src/supervisor.js` carries that stamp, `packages/core/src/
supervisor.ts` 14:17. The archived run ended at 08:13 UTC = **11:43 local**, two and a half hours
*before* that build. So §14.2–§14.6 measure the **pre-fix binary**, and none of it is evidence
that a §12 fix failed. §14.7 is the first run on the fixed build.

### 14.1 §11's three questions, settled

| § | question | answer |
|---|---|---|
| Q1 | is mail undelivered at the halt ever drained after a resume? | **No.** 3 messages were pending at 07:06:06; **0** were delivered after the 07:41:24 resume. Pending mail at a halt is never redelivered. |
| Q2 | are the artifacts stuck at READY_FOR_REVIEW ever re-approved? | **No.** 8 artifacts did move after the resume, so nothing was frozen — but the pile never cleared. Final tally: **13 READY_FOR_REVIEW**, 4 APPROVED, 2 UNDER_REVIEW, 1 REJECTED, 1 FINAL. |
| Q3 | are the unclaimable tasks reissued or abandoned? | **Abandoned.** 16 tasks created, 5 claimed, 4 completed, and **zero tasks created after the resume**. Nothing was reissued. |

### 14.2 The mission did not end — it flatlined, and nothing noticed

Between 08:02:50 and 08:13:34 all nine seats failed with the same runtime error:

```
claude turn failed: success — API Error: 402 [402]: This model requires an opencode API key
```

`recovery-manager` raised one `escalation.requested / runtime_failure` per seat — **nine of them**.
Then:

```
08:13:34  escalation.requested   recovery-manager   (ux-designer, the ninth)
   ---- 3 hours, 4 minutes, 0 events ----
11:17:03  agent.replaced x8      human              (the operator's reset)
```

**10 escalations were raised across the run; 1 was answered.** The budget escalation at 07:06:06
got a human reply in 35 minutes. The nine runtime-failure escalations got none, and the mission sat
ACTIVE-but-dead for three hours emitting nothing. No watchdog converted "every seat has failed and
nobody has spoken in an hour" into a louder signal. The halt detector fires on budget; there is no
equivalent for silence.

This is the one failure here that is **not** addressed by §12, because §10 never saw it — the first
watch ended 56 minutes before it started.

### 14.3 Delivery latency across the full run

§3 measured time-to-read at the halt (median 202s). Over the whole run, `message.sent` →
`message.delivered`, n=103:

```
min 25s   median 399s (6.6 min)   p90 2284s (38 min)   max 4584s (76 min)
```

The tail is the problem, not the median: a `DELEGATE` took **63 minutes** to reach frontend, an
`INFORM` **76 minutes** to reach qa. And **23 of 110 sent messages were never delivered to anyone**
— 20 of them sent *before* the 402 cascade, so this is not death-fallout. Casualties include the
run's only `TEST_RESULT` (qa→tech-lead,pm, 07:55:22), four `PATCH_READY`/`REQUEST_REVIEW` from
backend and frontend, and **three `INFORM`s sent by the human operator** (→backend, →qa, →pm).
The operator's own mail is dropped on the same floor as everyone else's.

### 14.4 The delegation storm: eight sends, one second, seven orphans

At **06:45:30**, architect emitted eight `DELEGATE` messages to backend — same second, eight
separate `threadId`s, and each body is exactly this:

```json
{"taskId": "task-M36G69AG008caf12d4c6"}
```

**Seven of the eight were never answered.** §6e already noted DELEGATE carries only `{taskId}`;
what the full log adds is the shape — a task breakdown shipped as N point-to-point messages in one
burst, each opening a thread that then dies. Across the run, **19 of 42 obliging messages (45%)
never drew a reply from the addressee**, and this one burst is 7 of the 19.

Thread depth confirms it. 55 threads: **20 with a single message**, 23 with exactly two, and only
5 with four or more. 78% of threads are one ask and at most one answer.

Related: 26 of 110 message bodies are under 60 characters, and **104 of 110 messages are addressed
to exactly one recipient**. Only one message in the run set `control.mode: broadcast`. The mesh is
not over-broadcasting; it is sending point-to-point notifications with nothing in them.

### 14.5 65 of 110 messages were INFORM

```
INFORM 65   DELEGATE 15   REQUEST_REVIEW 12   REQUEST 11
PATCH_READY 3   TEST_RESULT 1   REQUEST_INFO 1   REJECT 1   MISSION 1
```

59% of all traffic carries no ask and creates no obligation. Against that: 4 `task.completed` and
5 `review.approved` for the whole run.

### 14.6 The capability DENY gates nothing — confirmed across the full window

§4b proved this on 7 denials. The full log has 9 `ruleId: capabilities` denials, and **8 of the 9
are followed within the same second by the artifact moving and the review being requested anyway**:

```
06:54:57  backend  denied 'code.review'  -> artifact.transition, message.sent, artifact.transition
07:56:32  frontend denied 'code.review'  -> artifact.transition x3, review.requested, message.sent x2
08:00:46  backend  denied 'code.review'  -> artifact.transition x3, review.requested, message.sent
```

The two denials at 07:56 and 08:00 are new — they sit in the window the first watch never saw, and
they behave identically. §4c's "the sender never learns" is visible too: **backend re-sent the same
denied review request four times**, marketing twice, with no backoff.

Mechanism, re-confirmed at committed HEAD (`git show HEAD:packages/core/src/supervisor.ts`,
`case "request_review"`): the gate calls `evaluateCapability(actorId, capabilityForReview(a.type))`
— `actorId` is the seat *asking*, and `op.reviewers` is never checked — and the DENY has **no
`return`**, so control falls through to `transitionArtifact(READY_FOR_REVIEW)` and the send. The
capability table is keyed by *artifact* type (`projections-helpers.ts:252-267`: `CodePatch →
code.review`, `ArchitectureDocument → review.design`), which is why backend asking tech-lead to
review a patch needs `code.review` itself. The correct sender-side gate, `sendMessageCapability`
(`supervisor.ts:6448-6459`), is called from no production path — only from
`tests/core/supervisor-pure.test.ts`. §12's A2 deletes the wrong gate in the working tree, with
`tests/policy/inert-approval.test.ts:87-88` as the regression; **that fix is uncommitted and was
not in the binary this run used**.

All 25 rejections, by rule: `capabilities` 9, `goal-halted` 8, schema validation 4,
`communication` 3, `patch.ready.unresolved-artifact` 1.

**The halt is mesh-wide, not per-seat — and §7's asymmetry is measurable.** During the
07:06:06–07:41:24 freeze all **eight** live seats were denied, every one of them with
`action: "activate (message)"` — these are *activation* denials from `evaluateActivation`
(`policy-engine/src/index.ts:278-285`, keyed on `state.activeGoalId`, with no comparison against
the seat that escalated). They are **not** refused messages. Sending stayed open, exactly as §7
says, and the cost of that asymmetry is visible in two lines:

```
07:08:45  INFORM  tech-lead -> backend      (sent during the freeze)
07:08:45  INFORM  tech-lead -> backend      (sent during the freeze)
```

Both were accepted, and **neither was ever delivered** — they are 2 of the 23 in §14.3. Writes are
taken while reads are blocked, so mail posted during a halt lands in a mailbox nobody can be woken
to drain, and it is still there when the run dies. All of this because *marketing*, the seat
holding only `repository.read`, overran an 80k budget: one seat's overspend deafened every other
seat for 35 minutes.

A log-reading hazard worth fixing on its own: these activation denials are written as
**`message.rejected`** events. Read from the log, `message.rejected / ruleId: goal-halted` looks
like eight refused messages; only the `action` field distinguishes "this seat could not be woken"
from "this message was refused." It misled this watch until the payloads were opened.

Budget overrun was universal, not marketing's alone: **every one of the nine seats exceeded its
limit**, detected 17–41% *after* the fact (tech-lead 508,662/360,000; backend 316,516/240,000),
producing 13 `budget.limit_raised` events. Churn: 39 `agent.failed`, 60 `agent.restarted`, 7
`agent.replaced`, 20 `session.rotated`.

**Correction.** An earlier draft of this paragraph called those "13 human `budget.limit_raised`
interventions." That was wrong, and the error is the log's, not only mine — see §16.2. All 13
carry `actorId: "human"`, but 12 have `reason: "auto-raise: …"` and were machine decisions. The
operator did exactly one thing in the whole run: answer the 07:41:24 escalation. There is one
`human.input` event to prove it.

### 14.7 The live run on the fixed build: stalled before first contact

A new mission (`goal-M36ZR7TA003f1c5f0758`) started at **14:48 local**, 27 minutes after the §12
build, on host 7420 / child 41527. As of 14:58 it has produced **25 events and zero messages**:

```
11:18:02Z  pm, architect -> OBSERVING
11:18:03Z  pm, architect -> THINKING
   ---- 10 minutes, nothing ----
turns.jsonl:  architect running,  pm running
```

Both seats have been in `THINKING` with `status=running` since their first turn, the child process
is in `S` (sleeping, low CPU), and `scheduling.turn_timeout_ms` is 1200000 — so nothing will move
until roughly 15:08. The previous run shows the same signature before it died
(`07:19:48 frontend turn timeout after 1200000ms`).

The 402 and this stall both point outside the mesh: the shell has
`ANTHROPIC_MODEL=opencode-go/deepseek-v4.1-flash`, and the Claude adapter inherits it.

**This was written at 14:58 and the run moved at 15:06.** It was not stalled — the model is simply
that slow. pm's first turn took **18m16s**. See §14.10, which supersedes the conclusion above:
§12's fixes did get exercised, and two of them hold.

### 14.8 Config: two of the run's denials were already fixed at 12:49, two were not

`mesh.yaml` was edited at 12:49 local, after the run. Diffing it against
`mesh.yaml.bak-20260923-124908` (what actually ran):

- **fixed** — `test.execute` added to `backend` and `frontend` (kills 2 denials); `qa` added to
  `may_contact` for backend, frontend and tech-lead (kills the frontend→qa denial and ends qa's
  isolation); `explorer` wired to architect and pm.
- **still open** — `marketing` holds only `repository.read` yet asked for `review.design` twice;
  it remains the only seat with no capability matching anything it is prompted to do, and it is
  the seat whose overspend froze the mesh.
- **still open** — `qa` declares `test.run` while the enforced capability name is `test.execute`.
  Nothing rejects the unknown name; qa simply never satisfies a `test.execute` requirement.

### 14.9 What this watch did not measure

- **Still n=1**, and the same mission as §1–§11 — this is a longer read of one run, not a second run.
- **The fixed build is untested.** §14.7 is a stall, not a result. Every §12 fix remains unexercised
  end-to-end.
- **The 3-hour flatline (§14.2) has no traced mechanism.** I measured the silence and the nine
  unanswered escalations from the log; I did not find the code path that should have escalated
  louder, so "there is no silence watchdog" is an inference from absence, not a citation.
- **The 402 and the 14:48 stall are assumed to be the same cause** (the inherited
  `ANTHROPIC_MODEL`). The stall produced no error text, so that link is unproven.

### 14.10 The fixed build, watched live — what held and what didn't

The 14:48 mission (`goal-M36ZR7TA003f1c5f0758`) began emitting at 15:06 local / 11:36 UTC. Watched
live from `logs/events.jsonl` for the first ~3 minutes of traffic: 108 events, 7 messages, 3
deliveries, **0 rejections**, 1 failure. Against the same stretch of the pre-fix run — 25
rejections across the whole run, 9 of them capability denials that gated nothing — nothing has been
refused here at all.

**A §3 claim does not survive contact with the fixed build.** §3 says a broadcast wakes only seats
whose `interests:` include `message.sent`, that no seat declares it, and that pm's 8-way INFORM
therefore "woke nobody." On this build it woke three seats directly:

```
11:36:45  pm INFORM -> backend, frontend, qa, tech-lead, ux-designer, ui-designer, explorer, marketing
          id msg-M370VJS10070906e242a

11:37:08  backend   awakened  reason {kind: "message", messageId: msg-M370VJS10070906e242a, eventType: "message.sent"}
11:37:44  frontend  awakened  reason {kind: "message", messageId: msg-M370VJS10070906e242a, eventType: "message.sent"}
11:38:38  qa        awakened  reason {kind: "message", messageId: msg-M370VJS10070906e242a, eventType: "message.sent"}
```

Same message id in all three wake reasons. frontend then answered it at 11:39:09 (INFORM→pm,
REQUEST_INFO→tech-lead). **qa took a turn inside two minutes** — the seat that took 0 turns in 31
minutes in the pre-fix run (§6c). I predicted the broadcast would strand, on §3's authority, and
the log says otherwise; recorded here because §3's rate claims are now known to be build-specific.

**What still fails: the architect never read its mission and died silently.**

```
11:18:02  architect awakened   reason {kind: "startup", note: "mission started from console"}
11:18:03  architect context.assembled
11:36:31  pm -> architect  MISSION  ("Produce the architecture for the skill-panel core…")
11:38:03  architect agent.failed   turn timeout after 1200000ms
11:38:03  architect agent.restarted
```

Architect was woken at mission launch, **17m28s before the MISSION addressed to it existed**, sealed
its context one second later, then burned the full 20-minute `turn_timeout_ms` and produced
nothing — no artifact, no message. The seat the whole mission is waiting on is the only seat that
failed. This is §2's shape (context sealed before the instruction arrives) with a worse ending than
§2's: in the pre-fix run architect at least published seven artifacts off a stale context; here it
published none.

The ordering defect is not architect-specific — every seat so far assembled context before the
message aimed at it existed:

| seat | context assembled | instruction aimed at it | gap | delivered |
|---|---|---|---|---|
| architect | 11:18:03 | MISSION 11:36:31 | −17m28s | never (timed out) |
| tech-lead | 11:36:19 | REQUEST_REVIEW 11:36:45 | −26s | 11:38:38, next turn |
| backend | 11:37:08 | tech-lead INFORM 11:37:30 | −22s | not yet |

tech-lead's case shows the recovery working as designed — the mail it missed was delivered on its
**next** turn, 1m53s later. Architect had no next turn to be rescued by. **The gap is survivable
only if the seat gets another turn; a timeout on turn 1 makes it permanent.**

Two incidental notes from the live watch:

- **tech-lead reviewed off the artifact firehose, not the review request.** It woke at 11:36:19 on
  `interest_event / artifact.created` and had published a review and two messages by 11:37:30 — 71
  seconds. pm's `REQUEST_REVIEW` for that same artifact (11:36:45) did not reach it until 11:38:38.
  The review happened despite the routing, not because of it (§6c's firehose, doing useful work).
- **Burn rate is on the pre-fix trajectory.** One turn each: tech-lead 57,376, frontend 51,383, pm
  35,199. Against `budgets.agent` (tech-lead 180k, frontend 240k), tech-lead has roughly two turns
  left before it repeats §7. Nothing has been raised yet.

**It is the `startup` turn that is pathological, not the model.** Turn duration, measured from
`agent.awakened` to the turn's first output, splits cleanly by wake kind and by nothing else:

```
11:18:02  pm          wake=startup          18.3 min  produced
11:18:02  architect   wake=startup          20.0 min  FAILED (timeout)
11:36:19  tech-lead   wake=interest_event    1.2 min  produced
11:37:08  backend     wake=message           2.9 min  produced
11:37:44  frontend    wake=message           1.4 min  produced
11:39:24  architect   wake=recovery          3.3 min  produced
11:40:04  tech-lead   wake=recovery          1.0 min  produced
```

Both `startup` turns take 18–20 minutes; all five other turns take 1.0–3.3. Same model, same
mesh, same seats — architect itself went from a 20-minute timeout to a **3.3-minute** turn that
published the ArchitectureDocument, requested review and raised a design question. So this is not
model latency and not a slow network; something about the startup turn costs 6–20× every other
wake.

That matters because `startup.activate: [pm, architect]` puts **both** critical seats into that
turn simultaneously, and `scheduling.turn_timeout_ms` is 1200000 — 20 minutes, i.e. exactly where
the startup turn lands. pm cleared it by 1m44s; architect did not. Every mission on this config
begins with its two most important seats inside the timeout's error bar, and whether the architect
survives its first turn is close to a coin flip.

**An earlier draft of this section said "on this model every seat is one slow turn away from the
architect's outcome." That was wrong** — it generalised from two startup turns before any
non-startup turn had completed. Only the startup turn is at risk; the steady state is minutes.
The remedy is therefore not a bigger timeout but finding what the startup wake does that the
others don't.

### 14.11 Additional limits on §14.10

- **Three minutes of traffic, 7 messages.** "0 rejections" and "qa answered in 2 minutes" are early
  readings, not run rates. The pre-fix run also looked clean for its first three minutes.
- **The broadcast correction is narrow.** It shows three seats woke on a message id; it does not
  establish *why* §3 measured otherwise, and I did not re-read the scheduler to find what changed.
- **Architect's timeout has no traced cause.** It produced no output and no error beyond the
  timeout, so whether it was mid-generation or hung is unknown from the log.

### 14.12 Two reviewers, one artifact, and an approval that evaporated

pm asked **two** seats to review the RequirementsDoc in a single message
(`REQUEST_REVIEW pm -> architect, tech-lead`, 11:36:45). They answered 2m16s apart, and the
second answer vanished:

```
11:39:24  architect  context.assembled        (turn 2 — mailbox snapshot taken here)
11:41:02  tech-lead  review.rejected          art-M370TS7P...
11:41:02  system     artifact.transition  ->  REJECTED
11:41:02  tech-lead  INFORM -> architect      ("I rejected the baseline")
11:43:18  architect  review.approved          art-M370TS7P...  "APPROVE, no objection"
11:43:18  system     artifact.transition  ->  REJECTED          <- unchanged
11:43:37  architect  message.delivered x3     MISSION, REQUEST_REVIEW, tech-lead's 11:37:30 INFORM
```

Architect spent a turn design-reviewing a document that had been rejected two minutes earlier,
emitted a full `review.approved` with a 1,400-character justification, and **the artifact did not
move**. The transition at 11:43:18 re-affirms REJECTED.

Keeping REJECTED is defensible precedence — a second reviewer should not quietly overturn a
rejection. Three things about it are not:

1. **Architect could not have known.** Its mailbox was snapshotted at 11:39:24, 98 seconds before
   the rejection existed. This is §2's ordering defect again, now with a measurable cost: one
   wasted turn on the mission's most expensive seat.
2. **The inert approval still emitted `review.approved`.** Nothing in the event stream marks it as
   having changed nothing — §1's "approvals that changed nothing emitted approval events", intact
   on the fixed build.
3. **Architect learned 3m39s too late.** The three messages delivered to it at 11:43:37 were all
   sent *before* its context was assembled (11:36:31, 11:36:45, 11:37:30). tech-lead's 11:41:02
   INFORM announcing the rejection was not among them. It arrived at **11:46:57**:

   ```
   delivered 11:43:37  <-  sent 11:36:31  MISSION         from=pm
   delivered 11:43:37  <-  sent 11:36:45  REQUEST_REVIEW  from=pm
   delivered 11:43:37  <-  sent 11:37:30  INFORM          from=tech-lead
   delivered 11:46:57  <-  sent 11:41:02  INFORM          from=tech-lead   <- the rejection notice
   ```

   **5m55s from send to delivery**, and architect wrote its inert approval at 11:43:18 — 3m39s
   before the notice that would have stopped it, and 2m16s after the rejection it announced. The
   whole loss is bounded by one number: the gap between when a fact becomes true in the mesh and
   when the seat that needs it is next woken.

The underlying shape: a multi-recipient `REQUEST_REVIEW` creates **independent, uncoordinated
reviews with no mutual visibility and no first-writer-wins signal back to the loser.** Whichever
reviewer answers second does the work twice over — once for nothing, then again to react to a
verdict it will only see a turn later.

### 14.13 Three of five review requests name a reviewer who cannot deliver a verdict

Cross-checking every `REQUEST_REVIEW` in the live run against `REVIEW_CAPABILITIES`
(`projections-helpers.ts:252-267`) and the seat capabilities in `skill-panel/mesh.yaml`:

```
time      requester    artifact type          reviewers asked         can deliver a verdict?
11:36:45  pm           RequirementsDoc        architect, tech-lead    architect OK   tech-lead OK
11:42:51  architect    ArchitectureDocument   tech-lead               tech-lead OK
11:45:10  ux-designer  ArchitectureDocument   tech-lead, ui-designer  tech-lead OK   ui-designer NO
11:45:10  ux-designer  ArchitectureDocument   tech-lead, ui-designer  tech-lead OK   ui-designer NO
11:46:04  ui-designer  ArchitectureDocument   ux-designer, frontend   ux-designer OK  frontend NO
```

`ArchitectureDocument` requires `review.design`. `ui-designer` holds
`repository.read, ui.write, test.write`; `frontend` holds `repository.read, ui.write, test.write,
test.execute, git.commit, shell.execute`. Neither has it, so `canReviewArtifactType` will not let
either move the artifact to APPROVED or REJECTED.

**Nothing rejects these requests.** They are accepted, threads open, and the incapable reviewer is
woken to do work whose verdict cannot bind. Every one of the three pairs a capable reviewer with an
incapable one, so the artifact does still get reviewed — the waste is silent rather than fatal,
which is why it survives. This is §14.12's evaporation with a different cause: there the second
verdict lost a race, here it could never have counted.

**The agents noticed before the mesh did.** At 11:46:17 ui-designer sent pm:

```json
{"ask": "route design-authority review of the normative sections to tech-lead;
          confirm R17 UI-evidence scope",
 "status": "v1 published, in review with ux-designer + frontend"}
```

It published to the reviewers it was able to name, then asked a third party in prose to re-route
the part that needs design authority. That is a seat working around a routing hole it cannot
express structurally — §1's shape exactly: the writing is good, the substrate misroutes.

The fix is not more capability grants. `REQUEST_REVIEW` should refuse, or redirect, a reviewer who
cannot deliver a verdict on that artifact type — the check already exists
(`canReviewArtifactType`), it simply runs at approval time instead of at request time, which is
one turn and one wasted review too late.

### 14.14 Six artifact types have no review capability, and the hole is self-approval

marketing published a **`ResearchReport`** at 11:47:33 and asked pm to review it (11:48:07). Both
seats hold only `repository.read`. That prompted the check below.

`ArtifactType` has **15 members** (`protocol/src/types.ts:118-133`); `REVIEW_CAPABILITIES` has
**9** (`projections-helpers.ts:252-262`). The six with no entry:

```
ResearchReport   Decision   Requirement   TaskSpec   BenchmarkResult   DisagreementRecord
```

`Requirement` is missing while `RequirementsDoc` is present — easy to read past.

**These are not ungated.** `capabilityForReview` returns null for all six, and
`canReviewArtifactType` (`policy-engine/src/index.ts:483-496`) then falls back to an *authority*
gate, not an open door:

```ts
const ok =
  authority.includes(`${subject}.approve`) ||
  authority.includes(`${subject}.*`) ||
  authority.includes("*") ||
  (capability !== null && (def.capabilities ?? []).includes(capability));
```

With `capability === null` the fourth disjunct is dead, so only the authority check can pass.
`reviewSubject` maps `Requirement` → `requirements` and the other five → `architecture` via its
`default:` arm. pm holds `requirements.approve/reject`, so pm **cannot** settle marketing's
ResearchReport — it needs `architecture.approve`. Denial would surface as ruleId
`review-authority` (`index.ts:170-173`).

**The actual hole is one level up, in the self-approval screen.** Two sites short-circuit on the
capability being truthy, and a `null` there reads as "no peer could have reviewed this" — which is
exactly the condition that *permits* self-approval:

```
projections-helpers.ts:411   if (reviewCap && rec.definition.capabilities.includes(reviewCap)) return true;
policy-engine/index.ts:569   same shape
```

`approverMayAdvance` then has `if (!hasPeerReviewerFor(...)) return true;`
(`projections-helpers.ts:389`). So for any of the six types, in a mesh where no seat holds the
matching `<subject>.approve` authority, **the author may settle their own artifact** — not because
anyone decided that, but because a missing table row reads as an absence of qualified reviewers.
The doc comment at `:233-251` describes this precise failure for RequirementsDoc ("A PM approving
its own RequirementsDoc was not a policy decision anyone made; it was a missing row"). That row was
added. These six were not.

**And §5a's free-text word is still live for exactly these six.** `domainOfSubject`
(`projections-helpers.ts:295-333`) has no arm for them and falls through to `return subject` — the
domain word the *caller typed* — while `reviewSubject` resolves them to `architecture`. A seat
writing `subject: "quality"` on a ResearchReport is checked against `quality.approve`; the same
artifact reviewed through the other path is checked against `architecture.approve`. The two tables
disagree on the subject for precisely the capability-less types.

**No test covers any of this.** `canReviewArtifactType`, `REVIEW_CAPABILITIES`,
`capabilityForReview`, `reviewSubject` and `approverMayAdvance` appear nowhere under `tests/`.
Every review/self-approval policy test uses `CodePatch`, which *is* in the table
(`tests/policy/policy.test.ts:159-167`, `tests/integration/transition-gate.test.ts:338`). The one
test that looks like the missing coverage — `tests/core/projections-artifact-approval.test.ts:76-108`,
looping a `PREVIOUSLY_STRANDED` list that contains all six — seeds no agent definitions, so
`approverMayAdvance` exits at `if (!def) return true;` (`:383`) before it ever reaches the gate.
It is a state-machine test wearing authority-test clothing.

**Correction to an earlier reading of this run.** On first seeing marketing→pm I called the
ResearchReport path "an artifact type with no reviewer gate at all." That was wrong — the authority
fallback exists and would refuse pm. The defect is narrower and worse: the null capability is read
as evidence that no peer reviewer exists, which unlocks self-approval instead of blocking it.

### 14.15 At the concurrency cap, an incoming wake kills an in-flight turn

```
11:48:23  backend  awakened (message), context.assembled
11:52:57  backend  agent.failed   "turn interrupted by the mesh before the backend answered"
11:52:57  backend  budget.released x2
11:52:57  pm       budget.reserved, awakened (message), context.assembled
```

backend was 4m34s into a turn when the mesh killed it, and pm was given a slot in the same second.
Reconstructing who held a slot at 11:52:56:

```
  explorer      running since 11:44:42   (8.2 min)
  backend       running since 11:48:23   (4.5 min)   <- evicted
  ui-designer   running since 11:50:32   (2.4 min)
  => 3 concurrent;  scheduling.concurrency.max_active_agents: 3
```

Exactly at the cap. The wake for pm could not be served without taking a slot, so an in-flight
turn was terminated and its generation discarded.

**Confirmed 3 of 3.** The run produced two more evictions, and every one occurred with exactly
three seats holding slots:

```
11:52:57  backend    evicted at 4.6 min   others: explorer 8.2,  ui-designer 2.4   => 3 concurrent
12:10:27  tech-lead  evicted at 4.4 min   others: qa       7.3,  architect   0.4   => 3 concurrent
12:33:57  frontend   evicted at 6.3 min   others: qa       0.6,  architect   0.5   => 3 concurrent
```

The cap is the cause; that much is no longer in doubt. **The selection rule is not longest-running
and not shortest** — the first two evicted the middle-aged turn while an older one survived, the
third evicted the oldest. I did not trace the scheduler, so the rule remains unidentified; what the
log establishes is only that hitting the cap costs an in-flight turn, reliably.

**Updated at 13:16 — 4 of 4.** A fourth eviction landed, also at exactly three concurrent:

```
13:16:27  architect  evicted at 3.4 min                                       => 3 concurrent
```

**Final tally at 13:35 — 5 evictions, 5 at exactly the cap:**

```
  11:52:57  backend      killed at 4.6 min   concurrent=3
  12:10:27  tech-lead    killed at 4.4 min   concurrent=3
  12:33:57  frontend     killed at 6.3 min   concurrent=3
  13:16:27  architect    killed at 3.4 min   concurrent=3
  13:34:57  ux-designer  killed at 3.1 min   concurrent=3
```

Cost in this run: **21.8 minutes of generation discarded to evictions**, on top of architect's
20-minute startup timeout. Seven across the two runs, five verified at the cap (the two pre-fix
ones were not reconstructed). Six of the nine working seats have now lost a turn this way; the rate
is roughly one eviction every 21 minutes of mission time and shows no sign of easing.

The architect case is the costly one: architect sits at its 8x ceiling (§19.10) and is one of the
two seats whose next overrun is a deterministic halt, so tokens it spends on a turn that is then
killed move it toward that halt while producing nothing.

This is the same error string that appeared twice in the pre-fix run (`06:51:24 ux-designer`,
`07:46:54 backend`), which makes three occurrences across two runs on different builds.

§2 already named `max_active_agents: 3` against 9 seats as contributing config, but framed its cost
as **dropped wakes** — `drainGathered` discarding a coalesced wake when the seat is busy. This is
the other face of the same cap: when the mesh *does* decide to serve a wake, it pays for it by
destroying work already in progress. Both failure modes come from the same three slots, and both
are invisible in the message log — backend's 4m34s simply never produced a message.

Cost of the two failures so far this run, both of them slot- or timeout-related rather than
communication defects: architect's 20-minute startup turn and backend's 4m34s — **roughly 25
minutes of generation discarded across 2 of 14 turns.**

### 14.16 The halt reproduced on the fixed build — and an unmetered seat outspent everyone

At **11:53:35**, 17 minutes into productive work, the mission halted the same way the pre-fix run
did:

```
11:53:35  budget.exceeded        pm    {limit: 120000, consumed: 127634}
11:53:35  escalation.requested   termination-manager   agent_budget_exhausted
11:53:35  goal.escalated         human
11:53:35  message.rejected  backend, frontend, tech-lead, ux-designer, architect, qa
          action="activate (message)"   ruleId=goal-halted
```

**Six seats lost the ability to be woken in the same second, for a 6.4% overrun by a seventh.**
This is §14.6's asymmetry exactly, reproduced on the fixed build: the halt denies activation
mesh-wide while sending stays open, so mail written from here lands in boxes nobody can be woken
to drain. The pre-fix run took 35 minutes to clear this; the clock is running again.

**I predicted the wrong seat.** Earlier in this watch I flagged marketing at 92.9% as the imminent
cliff, on the strength of it being the seat that halted the pre-fix run. marketing never crossed —
it finished at 74,345/80,000 (92.9%). pm did, at 127,634/120,000. The prediction was right about
the mechanism and the blast radius and wrong about the seat, which is worth recording: "the seat
that halted last time" is not a useful predictor, because the halt goes to whichever seat is
cheapest to exhaust, and pm's limit (120k) is the second-smallest in the mesh.

**The real discovery is the seat that could not be halted at all:**

```
  explorer     133,711 /      0     <- no budget row exists
  pm           127,634 / 120,000   106.4%   <- halted the mission
  tech-lead    123,666 / 180,000    68.7%
  qa           102,096 / 180,000    56.7%
  ui-designer   92,680 / 150,000    61.8%
  ux-designer   82,322 / 150,000    54.9%
  architect     76,292 / 120,000    63.6%
  marketing     74,345 /  80,000    92.9%
  backend       63,449 / 240,000    26.4%
  frontend      51,383 / 240,000    21.4%
```

`explorer` is declared in `agents:` but has **no row in `budgets.agent`** — the only seat of the
ten without one. It is the **largest consumer in the mesh**, 133,711 tokens, more than the seat
whose overrun halted everything, and nothing can ever stop it: there is no limit to exceed, so no
`budget.exceeded`, no escalation, no cap.

It got this way from the 12:49 config edit. `explorer` is absent from *both* `agents:` and
`budgets.agent` in `mesh.yaml.bak-20260923-124908`; the edit that added the seat and wired it into
architect's and pm's `may_contact` (§14.8) did not add its budget row. A seat was introduced
without a meter, and within one run it became the biggest spender.

Worth stating plainly: the budget system halted the mesh over a 7,634-token overrun by pm while
ignoring 133,711 tokens spent by explorer, because the first had a row in a table and the second
did not. Nothing validates that every declared agent has a budget.

---

## 15. How this was watched — the monitor, and what it gets wrong

§14 was produced by a live tail plus one-shot queries, not by the dashboard or `mesh events`.
This section is the recipe, so the next watch starts from a working filter instead of rebuilding
one.

### 15.1 Where the log actually is

```
<dir of mesh.yaml>/<mesh.workspace.path>/.mesh-state/logs/events.jsonl
```

For skill-panel that is `skill-panel/workspace/.mesh-state/logs/events.jsonl`. **Not**
`skill-panel/.mesh/`, which holds only `child-stderr.log` and `host-child.pid`. Siblings worth
knowing: `turns.jsonl` (in-flight turn status), `turn-audit.jsonl` (per-turn token detail).

A `POST /mission/reset` archives the previous run to:

```
skill-panel/.mesh-backups/skill-panel/.mesh-state.bak-<stamp>/logs/events.jsonl
```

**The `<stamp>` is the session start time, not the backup time.** The run analysed in §14.1–14.6
lives under `.bak-20260923-111715` because the host started at 11:17:15 — the directory was
actually written at 14:47. Sorting backups by name and by mtime give different orders.

### 15.2 The monitor

```
tail -n 0 -F <events.jsonl> 2>/dev/null | jq --unbuffered -r '
  select(.type | startswith("message.") or startswith("escalation.")
      or startswith("review.")  or startswith("decision.")
      or startswith("design.")  or startswith("human.")
      or . == "agent.failed"    or . == "budget.exceeded"
      or . == "agent.replaced"  or . == "goal.escalated")
  | "\(.timestamp[11:19]) \(.type) actor=\(.actorId // "-")
     \(.payload.message.type // "")
     \(.payload.message.from // "")->\((.payload.message.to // []) | join(","))
     \((.payload.reason // .payload.error // .payload.message.payload.ask
        // .payload.message.payload.note // "") | tostring | .[0:140])"'
```

Run with a 30-minute expiry and re-armed on expiry. Notes on the shape:

- `tail -n 0 -F` — `-n 0` starts at the tail rather than replaying the file; `-F` survives the
  rotation a mission reset performs.
- `jq --unbuffered` is **required**. Without it jq buffers and events arrive in clumps minutes
  late, which silently destroys every ordering claim in §14.
- The filter deliberately includes `agent.failed`, `budget.exceeded`, `escalation.*` and
  `goal.escalated`. A comms-only filter would have stayed silent through both failures and the
  halt — and silence is indistinguishable from health. Both of this run's failures
  (architect's timeout, backend's eviction) and the halt arrived on those four clauses.
- `budget.consumed` is **excluded** on purpose — it fires several times per turn and drowns the
  stream. Budgets were polled separately (§15.4).

### 15.3 Five things that produced wrong readings

1. **`ps aux | grep mesh` returned empty while the mesh was running.** The first conclusion of
   this watch — "the mesh is not running" — was false. `rtk` rewrites `grep` and can return
   silently wrong results. Use the pid file instead:
   `cat .mesh/host-child.pid` then `ls -d /proc/<pid>` and `cat /proc/<pid>/cmdline`.
2. **Log timestamps are UTC; the wall clock here is +03:30.** Every log line reads 3.5 hours
   behind. `11:18:02Z` is `14:48:02` local. Mixing the two makes durations nonsense.
3. **`message.delivered` fires at turn END, not on read.** Zero deliveries while turns are
   running means nothing at all. §9 corrected this once already and this watch nearly repeated
   it — the guard is to check `turns.jsonl` for `status=running` before reading anything into an
   absence of deliveries.
4. **Activation denials are logged as `message.rejected`.** A `goal-halted` rejection carries
   `action: "activate (message)"` and means *this seat could not be woken*, not *this message was
   refused*. Read the `action` field before calling anything a refused send; §14.6 was drafted
   wrongly on this and corrected.
5. **jq precedence.** `select(.type=="a" or .type|startswith("b"))` fails with
   `startswith() requires string inputs`. Parenthesise every clause:
   `select((.type=="a") or (.type|test("^b\\.")))`.
6. **`message.delivered` is one event per RECIPIENT, not per message.** A message addressed to
   eight seats emits up to eight. Dividing delivered *events* by sent *messages* gives a delivery
   rate that is wrong by the mean fan-out — it produced a "97%" in §16.5 where the true figure was
   77%. Always dedupe by `payload.messageId`, and state which denominator you mean: unique
   messages delivered (77%) and pair-level delivery (79%) are different numbers.
7. **`budget.consumed` fires twice per turn with the same amount** — once for the `agent:` ledger
   and once for `mission:`, same `amount`, same `turnId`, different `key`. Summing raw doubles
   every figure. Filter on `payload.key` starting with `agent:`. (Deduping by
   `(actorId, correlationId, amount)` happens to give identical results — verified against all ten
   seats — but the key filter is the principled form.)
8. **A ledger's `consumed` in a `budget.exceeded` payload is a snapshot at that instant**, not a
   current total. Comparing it against a running sum shows a positive delta for any seat that has
   spent since, which is not an error. The two seats frozen since their last overrun showed delta
   zero, which is what validated the running sum.

The mission ledger is worth knowing about when reading budget numbers: at 13:01 it stood at
**3,512,102 of 120,000,000 — 2.93%**. `budgets.mission.tokens` will never bind, so per-seat
ceilings are the only brake that exists (§16.1).

### 15.4 The one-shot queries the stream cannot replace

The monitor answers *what just happened*. Every quantitative claim in §14 came from a one-shot
pass over the whole file:

- **Budget standings** — sum `budget.consumed` deduped by `correlationId` (the same amount is
  emitted more than once per turn), then divide by `budgets.agent` from `mesh.yaml`. This is what
  exposed `explorer` at 133,711 against no limit (§14.16).
- **Turn durations by wake kind** — pair each `agent.awakened` with the seat's next
  `agent.failed` / `message.sent` / `artifact.created`. This is the only way to see that
  `startup` turns cost 18–20 min and every other wake costs 1–3.3 (§14.10).
- **Ordering** — compare each seat's `context.assembled` against the timestamp of the message
  addressed to it. The whole of §14.12 is this one comparison.
- **Concurrency** — reconstruct open turn intervals and count how many overlap a given instant,
  against `scheduling.concurrency.max_active_agents`. This is what turned "backend failed" into
  "backend was evicted at the cap" (§14.15).
- **Reviewer capability** — cross the `REQUEST_REVIEW` recipients against `REVIEW_CAPABILITIES`
  and the seat capabilities in `mesh.yaml`. §14.13 is a five-row table from one pass.
- **Undelivered mail** — `comm -23` the sorted `message.sent` ids against the sorted unique
  `message.delivered` ids.

### 15.5 What this monitor still cannot see

- **Message bodies are truncated to 140 chars** in the stream. Anything about content needs a
  follow-up `jq` on the message id.
- **No turn-level token attribution.** `turn-audit.jsonl` has it; this watch never opened it.
- **Nothing about what an agent read.** `context.assembled` records that a context was built, not
  what was in it, so "architect never saw the MISSION" is inferred from timestamps, not observed.
- **The mesh's own views were never used.** `GET /events/stream`, `GET /threads/:id` and
  `mesh inspect <agent>` would each have been better for some of the above, particularly
  per-thread reconstruction. Tailing the JSONL was chosen because it needs no auth and survives
  the server dying — which mattered, since the previous run's server had.

---

## 16. The watch resumed — what the halt cost, and who the log says decided it

The mission halted at 11:53:35 (§14.16) and was ACTIVE again by 11:56:41. This section covers
11:53:35 → 12:17 UTC, during which the log went from 346 to 755 events.

### 16.1 Ten budget raises in twenty minutes, and a 4.3x ceiling inflation

```
11:53:35  pm            120,000 ->   240,000   x2     auto-raise: 127634/120000 exhausted
11:55:42  ui-designer   150,000 ->   300,000   x2     auto-raise: 169860/150000 exhausted
11:56:41  pm            240,000 -> 3,600,000   x15    operator raise from escalation
11:58:30  architect     120,000 ->   240,000   x2     auto-raise: 126850/120000 exhausted
11:59:31  marketing      80,000 ->   160,000   x2     auto-raise:  85435/80000  exhausted
12:03:05  ux-designer   150,000 ->   300,000   x2     auto-raise: 154919/150000 exhausted
12:06:42  marketing     160,000 ->   320,000   x2     auto-raise: 165776/160000 exhausted
12:10:59  qa            180,000 ->   430,672   x2.4   auto-raise: 398672/180000 exhausted
12:11:06  ui-designer   300,000 ->   600,000   x2     auto-raise: 313162/300000 exhausted
12:13:56  tech-lead     180,000 ->   360,000   x2     auto-raise: 184204/180000 exhausted
```

```
configured agent total : 1,460,000
current agent total    : 6,330,672      x4.3
```

Seven of nine seats have been raised, two of them twice. marketing — the seat I wrongly predicted
would halt the mission — was raised twice and is now at 320,000, four times its configured 80,000.
qa's raise is the informative one: it was detected at **398,672 against a 180,000 limit**, a 121%
overrun, so the "ceiling" arithmetic is not catching a seat before it has more than doubled its
allowance. §7's "unparsed turn output billed as work" is the obvious suspect and was not
re-checked here.

**The auto-raise is bounded, which an earlier draft of this section implied it was not.** Each
raise reason names a ceiling of **8x the seat's *configured* limit**, computed from the original
`mesh.yaml` value rather than the current one — marketing's second raise still reads
`ceiling 640000 (8x 80000)` although its previous limit was already 160,000. So a seat can double
at most three times (1x → 2x → 4x → 8x) before the machine stops raising it.

The configured budgets are therefore not limits but the first of four tranches. The real per-seat
limit is 8x what `mesh.yaml` says, and `budgets.mission.tokens` (120,000,000) is too large to
constrain anything, so those per-seat ceilings are the only effective brake.

**The one raise a human made is the one that broke the brake.** pm's operator raise took it to
3,600,000 — 30x its configured 120,000 and **3.75x its own 960,000 ceiling**. The bound constrains
the automatic path and not the manual one. That may well be intended, but it means the safety
property "no seat exceeds 8x its budget" holds only until someone answers an escalation, and the
event that breaks it is indistinguishable in shape from the nine that respect it (§16.2).

### 16.2 Nine machine decisions are recorded as `actorId: "human"`

Every one of those ten events carries `actorId: "human"`. Only one was a human decision.

```json
{"actorId": "human",
 "payload": {"key": "…/pm", "limit": 240000, "previous": 120000,
             "reason": "auto-raise: 127634/120000 exhausted; ceiling 960000 (8x 120000)"}}

{"actorId": "human",
 "payload": {"key": "…/pm", "limit": 3600000, "previous": 240000,
             "reason": "operator raise from escalation"}}
```

The payload keys are `key, limit, limitKind, previous, reason` — **there is no field recording
whether a person decided this.** The only signal is a free-text prefix in `reason`, and the two
cases are otherwise byte-identical in shape.

What the operator actually did is recorded separately and truthfully, in `human.input`:

```
11:56:41  {"action": "escalation_response", "response": "raised budget to 3.6M — continue with smaller steps"}
11:57:07  {"action": "escalation_response", "response": "retry"}
```

**Two actions. The log shows ten.** Any projection, report or metric that counts operator
interventions as `actorId == "human"` overstates them by 5x here, and by 13x in the pre-fix run
(13 raises, 12 of them auto, one `human.input`). This is §5a's disease in the audit layer: whether
a decision was made by a person is encoded in prose rather than in a field, so it cannot be
queried, only parsed. It is also how §14.6 came to claim "13 human interventions" — the log said
`human` thirteen times and I believed it.

### 16.3 An agent opened an escalation to say it was not opening an escalation

At 11:54:58, one minute into the halt, ui-designer raised `escalation.requested` whose `reason`
field is this, in full:

> *"Response to open escalation esc-M371TCXQ… — **this is a response supplying evidence, NOT a new
> escalation.** The disagreement targets RequirementsDoc v1, which has since been superseded by v2
> …; tech-lead's F1–F3/F5 are folded into the architect's Core Architecture v1. The blocker appears
> moot pending tech-lead's re-review of v2."*

There is no channel for *answer an open escalation with evidence* — `escalation.responded` is the
operator's verb. During a halt an agent may only `escalate, send, wait, done, remember,
read_artifact, withdraw`, and sending reaches a mailbox nobody can be woken to drain (§14.6). So
the only way to get a fact in front of the operator was to raise a second escalation and open it
with a denial that it is one.

Two further costs. The `reason` field is a short enum everywhere else in this log
(`agent_budget_exhausted`, `runtime_failure`); here it carries a 380-character argument, because
the schema has nowhere else to put evidence. And it worked, in the sense that the operator answered
it — with `"retry"` at 11:57:07 — so the workaround is now reinforced.

This is the third instance in this run of a seat routing around a missing channel in prose:
ui-designer asking pm to re-route a review it could not address (§14.13), architect retrofitting a
mission it read too late (§2), and this. In each case the agent correctly identified a structural
gap and solved it socially. §1's line holds — the writing is not the problem.

### 16.4 A seat states the §14.13 defect in its own words, and works around it

At 12:17:56 ui-designer published v3 of its design system and sent `REQUEST_REVIEW` to
`ux-designer, frontend` — the same pair as §14.13, one capable reviewer and one who holds no
`review.design`. Alongside it, in a separate INFORM to frontend, it wrote:

> *"I hold no review.design and am not asking you to approve. I am asking you to re-run the same
> method against v3 — you diffed the artifacts and computed the contrast rather than eyeballing
> them, and that is exactly the verification this document wants applied twice."*

The seat has independently worked out the entire capability model: that it cannot approve, that
frontend cannot approve, and that what it needs from frontend is not an approval. It sent
`REQUEST_REVIEW` anyway, because **the protocol has no verb for "re-run your verification and
report."**

That is the defect stated precisely, from inside. `REQUEST_REVIEW` conflates two different asks:

- *rule on this* — an authority act, gated by `canReviewArtifactType`, which moves the artifact;
- *check this* — a peer verification that produces evidence and moves nothing.

`MESSAGE_TYPES` has `REQUEST_INFO`, `REQUEST_RESEARCH` and `REQUEST_EXECUTION`, but the only way
to ask a peer to apply a method to an artifact and report back is the verb that also asks them to
settle it. So a seat that wants the second must send the first and disclaim it in prose — and the
disclaimer travels as a *separate message*, in a separate thread, which the recipient may read on
a different turn than the request it qualifies.

The surrounding content is worth recording against §1. ui-designer's INFORM dispositions eight
findings (B1–B8) with specific remedies — contrast arithmetic (`--sp-unknown-* = --sp-text-2 on
--sp-bg-2, 7.4:1 light`), a named new rule (`§9.16: a required field must exist in the frozen
contract before it can gate anything`), and an explicit list of three items it declines to own
because they belong to the API spec. This is not a seat that misunderstands its role. It is a seat
whose understanding of its role has nowhere to go in the message vocabulary.

Fourth instance in this run of the same shape, after §2, §14.13 and §16.3.

### 16.5 Scoreboard at 12:20 UTC — fixed build vs pre-fix, same project, same mission shape

```
                              pre-fix run        fixed build (43 min in)
messages sent                        110                    72
delivered                             87  (79%)             70  (97%)
message.rejected                      25                     6
  of which real refusals              17                     0
  of which activation denials          8                     6
artifacts created                     31                    13
  settled (FINAL/APPROVED)             2                     1
reviews approved / rejected          5 / 2                 3 / 5
agent.failed                          39                     2
agent.restarted                       60                     2
turn evictions at the cap              2                     2
budget.exceeded                       12                     8
```

**CORRECTION — the delivery row above is wrong, and so was the claim built on it.** I read
`message.delivered` as one-per-message. It is **one per recipient**: a message addressed to eight
seats emits up to eight. Dividing 100 delivered *events* by 103 sent *messages* produced a bogus
97%, which I then compared against the pre-fix 79% — a figure §14.3 had computed correctly, from
unique message ids. Like against like:

```
                                pre-fix run    fixed build
messages sent                          110            109
addressed pairs (sum of |to|)          127            145
message.delivered events               103            115     <- per recipient
unique messages delivered           87 (79%)       84 (77%)
pair-level delivery                     81%            79%
```

**Delivery did not improve. It is 77% against 79% — flat, fractionally worse.** 25 of 109 messages
on this build have never been delivered to anyone. The transport defect §3 describes is intact;
none of §12's fixes targeted it, and nothing in this watch should have suggested otherwise.

What does carry the difference is the other number, and it stands: **zero messages refused for a
policy reason.** All six `message.rejected` entries are the 11:53:35 activation denials from the
halt (§14.6) — not one is a capability denial, a communication-matrix denial, or a schema failure.
The pre-fix run had seventeen real refusals by this point. Enforcement got better; transport did
not.

Reviews are also discriminating rather than rubber-stamping: **5 rejections against 3 approvals**,
where the pre-fix run ran 5 approvals to 2 rejections. tech-lead rejected two artifacts at
12:18:07 alone.

The failure count is the same story from the other side: 39 `agent.failed` and 60
`agent.restarted` before, 2 and 2 now — and **both of this run's failures are infrastructure, not
communication**: architect's 20-minute startup turn (§14.10) and two turn evictions at the
concurrency cap (§14.15 — tech-lead at 12:10:27 joins backend at 11:52:57, making four across the
two runs, so the cap behaviour is not a one-off).

What has not improved is spending. **Eight `budget.exceeded` events, every one auto-raised**
(§16.1), against twelve in a run that lasted four times as long. Per unit of work, this build
overruns faster, because the seats are now actually talking to each other.

### 16.6 The first real refusals of the run — and this gate actually gates

At 12:23:01, 47 minutes in, the fixed build produced its first two policy refusals that are not
halt artefacts:

```json
{"from": "pm", "action": "ratify decision", "subject": "decision-M372RFC50086ba60088e",
 "reason": "agent pm (role pm) lacks authority 'architecture.approve' — held by: architect",
 "ruleId": "authority", "decision": "DENY", "denied": true}
```

**It gated.** Neither decision produced a `decision.ratified` event; the only events naming either
id are the `decision.proposed` pair at 12:10:00 and these two refusals. Searching the whole log for
those ids returns nothing that moved.

This is the direct contrast with §4b. The pre-fix `ruleId: "capabilities"` DENY emitted its
refusal and then fell through to the transition and the send — eight of nine denials were followed
within the same second by the artifact moving anyway (§14.6). `ruleId: "authority"` does not: the
refusal is the end of the operation. Two rules, two outcomes, same log shape — which is why §1's
"every layer that failed here failed by returning `{ ok: true }`" needed the qualifier that
*some* layers fail closed. This is one of them.

**The message is also the best refusal text in either run.** Compare:

```
pre-fix:  "agent backend does not hold capability 'code.review'"
now:      "agent pm (role pm) lacks authority 'architecture.approve' — held by: architect"
```

The second names the role, the missing authority, *and the seat that holds it*. A sender receiving
it knows where to route; a sender receiving the first knows only that it failed. §4c's "the sender
never learns" is partly answered here — not by delivering the denial into context, which still
does not happen, but by making the denial self-explanatory when it is read.

**The routing problem it exposes is real, though.** pm has proposed three decisions this run
(11:58:28, 12:10:00 x2) and **ratified none**, because `architecture.approve` is architect's. pm
can open a decision it has no power to close. Nothing warned it at propose time; the refusal comes
only at ratification, two turns and thirteen minutes later. architect was woken at 12:23:01, so
whether the decisions get ratified by the right seat or simply stall is not yet answered.

### 16.7 A review of a superseded version, 71% wasted, audited by the seat that received it

```
12:02:14  ui-designer  publishes v2
12:14:40  tech-lead    context.assembled          <- mailbox sealed here; v2 is current
12:17:56  ui-designer  publishes v3               <- 3m16s into tech-lead's turn, invisible to it
12:18:07  tech-lead    review.rejected x2         <- 11 seconds after v3 superseded v2
12:23:37  ui-designer  publishes v4
```

tech-lead reviewed **v2** and rejected it eleven seconds after **v3** had replaced it. ui-designer
did the arithmetic itself and reported it back:

> *"v3 was published at 12:17:56 … Your re-confirmation ran at 12:18:07 against v2. So your seven
> items split: five were already closed in v3, two were still open. I have not argued the reject —
> I re-checked it against v3 and published the fix."*

**Five of seven findings were against already-fixed content — 71% of the review wasted**, plus the
turn ui-designer spent dispositioning items that needed no disposition, plus v4. This is §14.12
(architect approving an artifact rejected two minutes earlier) with the roles reversed and a
measured cost instead of a single lost verdict.

The version churn is the visible symptom: **v1 11:45:53, v2 12:02:14, v3 12:17:56, v4 12:23:37 —
four versions in 38 minutes**, at least one of them existing only because a review landed against a
version that no longer existed.

**And ui-designer could not tell tech-lead directly.** Its reply opens:

> *"I hold no review.design and cannot open a thread to [tech-lead]."*

Both halves are true and checkable:

```
ui-designer.may_contact : [pm, ux-designer, frontend]     <- no tech-lead
tech-lead.may_contact   : [... ui-designer ...]           <- one-way
```

The message went out inside `thread-M372ZNQW007497096db9`, which **tech-lead opened at 12:13:56**.
Replies inside an existing thread are always allowed, so ui-designer's only route to the seat
reviewing its work is a thread that seat happened to open first. §6d recorded the matrix as
one-way in 8 pairs; this is what one of those pairs costs in practice — the reviewer can reach the
author, the author can answer only if spoken to, and the correction "you reviewed the wrong
version" depends on the reviewer having initiated contact twenty-three minutes earlier.

Nothing here is a model failure. The seat detected a stale review, quantified it 5-of-7, declined
to argue the verdict, republished, and routed its reply through the only legal channel — while
narrating the two policy walls it was working around. The substrate lost 71% of a review; the agent
recovered it.

### 16.8 The stale-review rate: 2 of 9 verdicts, measured

§16.7 is not an isolated incident. Pairing every `review.approved` / `review.rejected` with the
reviewer's last `context.assembled` before it, and comparing the artifact's version at those two
moments:

```
verdict   reviewer     kind      artifact   v@seal  v@verdict
11:41:02  tech-lead    rejected  54427ed6   1       1          current
11:43:18  architect    approved  54427ed6   1       1          current
11:58:30  architect    approved  54427ed6   2       3          STALE — approved v2, current v3
12:13:56  tech-lead    rejected  cf85241f   1       1          current
12:13:56  tech-lead    rejected  c66f22f4   2       2          current
12:13:56  tech-lead    approved  54427ed6   3       3          current
12:18:07  tech-lead    rejected  cf85241f   1       1          current
12:18:07  tech-lead    rejected  c66f22f4   2       3          STALE — rejected v2, current v3
12:23:39  tech-lead    rejected  1d2a3a36   1       1          current

  2 of 9 verdicts (22%) were delivered against a superseded version
```

The 12:18:07 row is §16.7 (ui-designer's design system, 5 of 7 findings already fixed). The
11:58:30 row is a second instance found only by this sweep: **architect approved v2 of pm's
RequirementsDoc while v3 was already current** — an approval that, like the one at 11:43:18
(§14.12), was written against something that no longer existed.

Both stale verdicts share the shape: the reviewer's context is sealed, the author publishes a new
version during the reviewer's turn, and the verdict lands on the version the reviewer was holding.
Nothing in the pipeline compares the version under review to the current one at the moment the
verdict is recorded, so a stale verdict is indistinguishable from a current one in the event log —
§16.7 was only discoverable because ui-designer did the comparison by hand and said so in prose.

**A one-line guard would catch all of it**: at verdict time, compare the reviewed version against
the artifact's current version and refuse — or at minimum flag — when they differ. The data needed
is already in the projection; `artifact.versioned` carries the version and the verdict carries the
artifact id.

Caveat on the rate: n=9 verdicts in one 50-minute window, and `v@seal` uses the reviewer's most
recent `context.assembled`, which is the correct turn boundary but was not cross-checked against
`turns.jsonl`. Treat it as the order of magnitude, not a measurement.

**Update at 12:32 — the rate fell to 2 of 13 (15%).** Four further verdicts landed, all against
the current version (tech-lead x3 at 12:29:21, ux-designer at 12:32:37, three of them on the
artifact that produced both stale readings). No third stale verdict appeared. The two originals
stand; the denominator grew.

This is worth stating plainly because it cuts against the finding: **the staleness is bursty, not
steady.** Both stale verdicts occurred while ui-designer was publishing a new version every few
minutes (v1 11:45:53 → v4 12:23:37); once that settled, reviewers stopped landing on superseded
versions. So the exposure is a function of how fast the author republishes relative to the
reviewer's turn length, not a constant tax on reviewing. B1 (§17) still closes it, and cheaply —
but the honest version of the claim is "15% and falling, concentrated in a burst" rather than "a
fifth of all reviews are wasted."

### 16.9 Where the next halt comes from — and how the operator raise moved the risk

ui-designer's 12:27:10 raise took it to **1,200,000, which is exactly its 8x ceiling**
(`auto-raise: 623584/600000 exhausted; ceiling 1200000 (8x 150000)`). The machine cannot raise it
again. Its next overrun escalates, and an escalation halts activation mesh-wide (§14.6).

Consumption against each seat's *hard* ceiling, which is the number that now matters:

```
seat           used      limit now     ceiling(8x)   % of ceiling
explorer      155,102       (none)          (none)   UNMETERED
ui-designer   623,584    1,200,000       1,200,000   52%   <- at its ceiling, cannot be raised again
pm            401,172    3,600,000         960,000   42%   <- limit is 3.75x its own ceiling
architect     274,326      480,000         960,000   29%
qa            398,672      430,672       1,440,000   28%
marketing     176,989      320,000         640,000   28%
tech-lead     294,541      360,000       1,440,000   20%
ux-designer   179,476      300,000       1,200,000   15%
backend       147,310      240,000       1,920,000    8%
frontend      127,422      240,000       1,920,000    7%
```

**The operator raise moved the risk rather than reducing it.** pm caused the 11:53:35 halt; a human
looked at pm and granted it 3,600,000, which is 3.75x above the ceiling the auto-raiser would
respect. pm is now the seat *least* able to halt the mission — it would need to burn 3.6M. Every
seat a human did not look at still stops at 8x. So the next halt comes from a seat nobody has
examined, and the examination itself is what determines which seats are exempt.

ui-designer is the nearest wall: highest burn rate in the mesh, four versions of a large document
in 38 minutes, and no auto-raise left. But I predicted marketing would cause the last halt and pm
did (§14.16), so this is a reading of headroom, not a forecast. The honest version: **the halt goes
to whichever seat next exhausts a ceiling, the ceilings differ by 3x across seats for reasons
unrelated to the work, and one seat has no ceiling at all.**

`explorer` remains the outlier that makes the whole table approximate — 155,102 tokens and rising
against no limit, no ceiling and no possible escalation (§14.16).

### 16.10 The unmetered seat is also the unproductive one, and its one task is stuck

`explorer` (§14.16: no row in `budgets.agent`, no ceiling, no possible escalation) has now
consumed **155,102 tokens across two turns and produced nothing at all**:

```
turn 1   11:44:42 -> 11:53:50   9m08s    output: memory.updated
turn 2   12:13:56 -> 12:14:40   0m44s    output: memory.updated
```

No `message.sent`. No `artifact.created`. No `research.completed`. Two `memory.updated` events and
155,102 tokens. It has received three messages (pm's opening INFORM, architect's `REQUEST_RESEARCH`,
architect's INFORM) and answered none of them.

**Its one real task is stuck behind the ordering defect.** At 11:58:30 architect sent it a specific,
well-formed research question:

> *"Locate and inventory the prior corpus at a `.mesh-backups/skill-panel/` path (tech-lead reports
> it holds ADR-0001..0005 — adapter SPI, deterministic resolution, event-sourced history,
> remote/marketplace — plus a TypeScript/Node packages tree)…"*

That message was **delivered at 12:14:40 — the end of explorer's second turn**, whose context was
sealed at 12:13:56. So explorer has never had the request in context, and it has not been woken
since. As of 12:28 the request is 30 minutes old, delivered, unread, and its thread has one message
in it.

Meanwhile `research.completed` has fired three times this run — **twice from marketing, once from
backend**. The seat that exists to do research has completed none; seats that exist to do other
things have completed three. §6c recorded qa taking 0 turns in 31 minutes on the pre-fix build;
qa is now active (§16.5) and explorer has inherited the role of the seat that is present but not
participating.

The three facts compound in an unfortunate direction: the only seat with no budget ceiling is also
the seat producing no output, so the mesh has no mechanism that will ever notice. A metered seat
burning 155,102 tokens for nothing would eventually exceed, auto-raise, exceed again and escalate
to a human. explorer will not. It can consume indefinitely, silently, while its inbox holds an
unanswered obliging message.

### 16.11 A proposed decision obliges nobody

§16.6 left open whether pm's blocked decisions would be ratified by the seat that holds the
authority. At 12:31, they have not been:

```
11:58:28  decision.proposed  by=pm
12:10:00  decision.proposed  by=pm
12:10:00  decision.proposed  by=pm
          (no decision.ratified events at all)
```

This is not for want of architect being awake or informed. architect holds `architecture.approve`,
has taken three turns since (12:17:56, 12:23:01, 12:24:23), and five messages naming those
decisions or ratification have been addressed to it, from tech-lead and pm.

The structural reason is that **`PROPOSE` is not an obliging message type**. `isObligingType`
covers `REQUEST*`, `ESCALATE` and `CHALLENGE` only (`catalog.ts:310`). A proposed decision
therefore creates no commitment, no deadline, no entry in the debt tracker and no guaranteed wake
— it behaves exactly like an INFORM. `sweepExpiredCommitments` has nothing to sweep, because no
commitment was ever recorded.

So the sequence is: pm proposes a decision it cannot ratify (§16.6), the refusal arrives two turns
later at ratification time rather than at propose time, and the seat that *can* ratify is under no
obligation to. Three decisions have now been open for 33, 21 and 21 minutes with no mechanism that
will ever chase them.

**Hedge:** the pre-fix run ratified 2 of 3 proposed decisions, so this is not a build regression —
ratification does happen. This run is 55 minutes old and the decisions may yet be ratified. What
the log establishes is the weaker but still useful claim: **nothing in the mesh will notice if they
are not.** An unratified decision is indistinguishable from a decision nobody has got to yet.

---

## 17. What to fix, from the second watch

§10 ranked the first watch's fixes and §12 records them as implemented. This is the equivalent for
§14 and §16 — everything the wider window and the fixed build turned up. Ranked by observed cost
divided by cost to fix, not by severity alone.

| # | fix | why it ranks here | § |
|---|---|---|---|
| **B1** | **At verdict time, compare the reviewed version against the artifact's current version; refuse or flag when they differ.** | The single cheapest fix on this list and it closes a measured 22% of verdicts. Both values are already in the projection. | §16.8 |
| **B2** | **Add a budget row check: refuse to start a mission where a declared agent has no `budgets.agent` entry.** | `explorer` spent 155,102 tokens with no ceiling and no possible escalation, and became the largest consumer in the mesh while producing nothing. One validation at config load. | §14.16, §16.10 |
| **B3** | **Record who decided a budget raise in a field, not in prose.** | 9 of 10 raises are machine decisions logged as `actorId: "human"`; the operator did 2 things and the log shows 10. Also the only way to spot the raise that broke the 8x ceiling. | §16.1, §16.2 |
| **B4** | **Move `canReviewArtifactType` from approval time to request time.** | 3 of 5 `REQUEST_REVIEW`s named a reviewer who structurally could not deliver a verdict. The check already exists; it just runs one turn and one wasted review too late. | §14.13 |
| **B5** | **Add the six missing `REVIEW_CAPABILITIES` rows** (`ResearchReport`, `Decision`, `Requirement`, `TaskSpec`, `BenchmarkResult`, `DisagreementRecord`). | A null capability is read by `hasPeerReviewerFor` as "no peer could have reviewed this", which *unlocks* self-approval. The doc comment already describes this failure for the row that was added. | §14.14 |
| **B6** | **A silence watchdog: escalate louder when every seat has failed and nothing has been emitted for N minutes.** | The pre-fix run sat dead for 3h04m with nine unanswered `runtime_failure` escalations. The halt detector fires on budget; nothing fires on silence. | §14.2 |
| **B7** | **Refresh, or re-snapshot, mail mid-turn — or bound turn length so the gap cannot grow large.** | The root cause of B1, of architect's evaporated approval, of explorer's stuck research, and of the 5-of-7 wasted review. Ranked below cheaper mitigations only because it is the largest change here, not because it matters less. | §14.12, §16.7, §16.10 |
| **B8** | **A message type for "apply your method and report" that is not `REQUEST_REVIEW`.** | ui-designer needed it four times and sent `REQUEST_REVIEW` plus a prose disclaimer in a separate thread each time. The protocol conflates *rule on this* with *check this*. | §16.4 |
| **B9** | **A way to answer an open escalation with evidence.** | An agent raised a second escalation whose `reason` opens "this is a response … NOT a new escalation", because no other channel reaches the operator during a halt. It worked, so the workaround is now reinforced. | §16.3 |
| **B10** | **Give `PROPOSE` an obligation, or stop routing decisions through it.** | 3 decisions proposed, 0 ratified, across 3 turns of the seat holding the authority and 5 messages naming them. Nothing will ever chase them. | §16.11, §16.6 |
| **B11** | **Do not evict an in-flight turn to serve a wake; queue the wake instead.** | 4 occurrences across 2 runs, ~25 minutes of generation discarded in this run alone. `max_active_agents: 3` against 9-10 seats. | §14.15 |
| **B12** | **Find what makes the `startup` turn cost 6-20x every other wake.** | Both startup turns took 18-20 min against a 20-minute timeout; all other turns took 1.0-3.3. `startup.activate` puts both critical seats through it at once, and architect did not survive. Diagnosis first — the remedy is not obviously a bigger timeout. | §14.10 |

### Config fixes, separate from code

- `explorer` has no `budgets.agent` row (B2 is the code fix; the row is the immediate one).
- `qa` declares `test.run` while the enforced capability name is `test.execute`. Nothing rejects
  the unknown name; qa simply never satisfies a `test.execute` requirement. (§14.8)
- `marketing` holds only `repository.read` yet is prompted to do work requiring `review.design`.
  (§14.8)
- The contact matrix is one-way for `ui-designer -> tech-lead`: the author of an artifact cannot
  initiate contact with the seat reviewing it, and could only send "you reviewed the wrong version"
  because the reviewer had opened a thread 23 minutes earlier. (§16.7, §6d)

### What this list does not contain

No fix here addresses message *content*, because nothing observed in either run was a writing
failure. Across both watches the seats correctly diagnosed stale reviews, missing capabilities,
unreachable recipients and absent protocol verbs — and routed around all of them in prose. §1's
opening claim survives the second watch unchanged.

### 16.12 Fifty-seven minutes, zero tasks, zero patches — and why that may be the gate working

```
seat          turns   sent  artifacts
tech-lead        11     27      0      <- pure review/coordination
pm               10     21      4
architect         9     20      5
ui-designer       9     13      4
ux-designer       4      6      4
backend           5      4      1
qa                4      4      1
marketing         4      3      2
frontend          4      4      0
explorer          2      0      0      <- §16.10

task.* events: 0        patch.* events: 0
```

**No task has been created and no patch produced in 57 minutes.** The pre-fix run had 16 tasks and
2 patches by a comparable point. The mission is entirely inside a design-and-review loop: 17
artifacts, 13 verdicts, 4 approvals against 9 rejections, and the implementation seats nearly idle
— frontend has taken 4 turns, sent 4 messages and produced nothing; backend has one artifact.

The obvious reading is that the mesh is stuck. The likelier reading is the opposite, and it matters
for how §16.5's scoreboard is interpreted.

In the pre-fix run, architect published seven artifacts at 06:40:43 **having received nothing**
(§2), and tech-lead approved all seven at 06:43:35 — approvals that §5a shows moved nothing and
§4b shows were never gated. Tasks appeared within ten minutes because **the review gate did not
work**. Progress was an artefact of enforcement failing open.

On this build the gate rejects. Architecture v1 is REJECTED, and architect told backend at
12:20:16: *"You were right to hold implementation until architecture is approved."* backend's
idleness is a seat correctly declining to build on an unapproved design — the behaviour the gate
exists to produce.

So the two runs are not comparable on throughput. **Pre-fix reached implementation faster because
nothing stopped it; this build has not reached implementation because something did.** Whether the
design loop converges before the budget ceilings do (§16.9) is the open question this watch cannot
yet answer — and it is the question that decides whether working enforcement is affordable at these
turn costs.

What can be said: 9 rejections to 4 approvals is a gate doing work, not a gate rubber-stamping, and
every rejection this watch examined named specific, checkable defects rather than generic refusal.

### 16.13 Four ResearchReports nobody asked the only seat that can settle them

§14.14 predicted trouble for the six artifact types with no `REVIEW_CAPABILITIES` row. Four of
this run's seventeen artifacts are `ResearchReport`, and all four are stuck:

```
ResearchReport -> reviewSubject default -> "architecture" -> requires architecture.approve
holders of architecture.approve in this mesh: [architect]   (exactly one seat)

  102dfd7d  by marketing  UNDER_REVIEW        reviewers asked: [pm]     can settle: NOBODY
  fb66f1f3  by marketing  UNDER_REVIEW        reviewers asked: (none)   can settle: NOBODY
  1d15176a  by backend    READY_FOR_REVIEW    reviewers asked: (none)   can settle: NOBODY
  84919a5c  by frontend   READY_FOR_REVIEW    reviewers asked: (none)   can settle: NOBODY
```

**architect — the only seat in the mesh holding `architecture.approve` — was never asked to review
any of them.** One was routed to pm, which holds `requirements.approve/reject` and cannot settle a
ResearchReport; the other three were published and submitted without naming a reviewer at all.

This is §14.13's defect on the authority path rather than the capability path, and it is worse in
one respect: for `ArchitectureDocument` the seats at least paired a capable reviewer with an
incapable one, so the artifact still moved. Here nobody capable is in the loop, so **24% of the
run's artifacts can only ever leave review through the §14.14 self-approval hole** — the null
`capabilityForReview` making `hasPeerReviewerFor` report that no peer could have reviewed them,
which lets `approverMayAdvance` return true for the author.

None has self-approved yet. The hole is open and unexercised, and the four artifacts are simply
parked. Which is the quieter failure: with no request-time check (B4) and no reviewer named, there
is nothing in the log that marks these as unreviewable — they read as artifacts awaiting review,
indistinguishable from the ones a reviewer will actually get to.

Both `DisagreementRecord`s, the other capability-less type present, were created by `human` at
11:53:35 and 11:54:58 as the conflict records behind the halt and ui-designer's escalation-response
(§16.3). Neither has a transition or a verdict, which for those is probably correct.

### 16.14 Correction: §16.9's halt model is wrong — ceiling proximity does not predict escalation

The second halt fired at 12:37:58 on qa, and it falsifies the model in §16.9.

§16.9 reasoned that the auto-raiser stops at 8x the configured limit, therefore the next halt comes
from whichever seat next exhausts a *ceiling*, and named ui-designer as nearest the wall. What
actually happened:

```
  12:10:59  qa           398,672 / 180,000   +121%   no escalation
  12:27:10  ui-designer  623,584 / 600,000   AT ITS 8x CEILING   no escalation
  12:37:58  qa           460,431 / 430,672   +7%     *** ESCALATED, mesh halted ***
```

- **qa escalated at 32% of its ceiling**, on a 7% overrun.
- **qa's own earlier 121% overrun did not escalate.**
- **ui-designer reached its exact ceiling and did not escalate** — the auto-raise fired to 1,200,000
  and the mission continued.

Across the run there are **13 `budget.exceeded` events and 2 escalations**. Neither overrun
magnitude nor ceiling proximity separates them, and in both escalating cases the auto-raise *also*
fired in the same second — so the escalation is not the auto-raiser giving up.

The one structural difference is that both escalation payloads carry a `disagreementRef`:

```
11:53:35  pm  detail: {key, consumed, limit, disagreementRef -> DisagreementRecord/decision-conflict-162ed489e116b1fe/1}
12:37:58  qa  detail: {key, consumed, limit, disagreementRef -> DisagreementRecord/decision-conflict-ce74ae51982dd887/1}
```

The eleven non-escalating exceeds carry none. But both `DisagreementRecord`s were created by
`human` **in the same second as the escalation that references them** (§16.13), so the record looks
co-created with the escalation rather than a precondition for it — which means it identifies the
escalations without explaining them.

**I cannot determine the trigger from the log**, and the candidate rules all fail: not first
overrun (qa's first did not escalate), not repeat overrun (ui-designer exceeded three times without
escalating), not magnitude, not ceiling. `termination-manager` is the actor; its rule would have to
be read in code, which this watch has not done.

What survives from §16.9 is narrower and still useful: the 8x ceilings exist, they differ across
seats by 3x for reasons unrelated to the work, one seat has no ceiling at all, and the operator
raise put pm 3.75x above its own. **What does not survive is the prediction.** I forecast the halt
would come from ui-designer on ceiling grounds; it came from qa, from a 7% overrun, while
ui-designer sat at its ceiling untouched. That is the second halt prediction this watch has got
wrong in the same way — §14.16 named marketing and pm halted — and both errors came from modelling
a rule I had not read.

### 16.15 The halts are a race, not a rule — and that makes both of them bugs

§16.14 said the escalation trigger was not determinable from the log. It is determinable from the
code, and the answer is that **there is no second condition**. `termination.ts:368-372` is the
entire predicate:

```ts
for (const b of state.budgets.values()) {
  if (b.exceeded && b.key.startsWith(`agent:${goalId}`)) {
    return { kind: "escalate", reason: "agent_budget_exhausted", detail: {...} };
  }
}
```

One latched boolean. No magnitude, no ceiling test, no counter, no clock — which is why none of
the candidates I ruled out from the log appear: they are not there to find.

The latch is set on overrun (`projections-system.ts:152`) and cleared by a raise that covers
current spend (`:160-167`). `supervisor.ts:6952-6962` runs the auto-raise sweep immediately before
the verdict precisely so the latch is not stale — but the sweep snapshots the ledger set and
`await`s a raise per ledger (`:3838`), so it is **not atomic with respect to concurrently running
turns**. An overrun latched inside that window is read by the synchronous `evaluate()` that the
sweep was supposed to clear for.

**The prediction this implies is testable, and the log confirms it 13 out of 13 — by `seq`, not
by timestamp:**

```
11:53:35  pm           b.exceeded(327)  -> e.requested(328) -> g.escalated(330) -> b.limit_raised(332)
12:37:58  qa           b.exceeded(1206) -> e.requested(1207) -> g.escalated(1209) -> b.limit_raised(1211)

11:55:42  ui-designer  b.exceeded(351)  -> b.limit_raised(352)
11:58:30  architect    b.exceeded(422)  -> b.limit_raised(423)
11:59:31  marketing    b.exceeded(450)  -> b.limit_raised(451)
12:03:05  ux-designer  b.exceeded(521)  -> b.limit_raised(522)
12:06:42  marketing    b.exceeded(572)  -> b.limit_raised(573)
12:10:59  qa           b.exceeded(624)  -> b.limit_raised(625)
12:11:06  ui-designer  b.exceeded(639)  -> b.limit_raised(640)
12:13:56  tech-lead    b.exceeded(710)  -> b.limit_raised(711)
12:20:26  architect    b.exceeded(857)  -> b.limit_raised(858)
12:27:10  ui-designer  b.exceeded(991)  -> b.limit_raised(992)
12:33:29  tech-lead    b.exceeded(1127) -> b.limit_raised(1128)
12:39:37  architect    b.exceeded(1231) -> b.limit_raised(1232)
```

Eleven overruns: `exceeded` then `limit_raised`, consecutive sequence numbers, no escalation. Two
overruns: `exceeded`, then the escalation **inserted between the overrun and the raise**. In both
escalating cases the raise that followed *would have cleared the latch* — pm's `next` was 240,000
against 127,634 consumed, qa's 861,344 against 460,431. The verdict simply got there first.

**So both halts are bugs, not policy.** The mesh froze every seat twice, required two human
interventions, and cost the 11:53:35–11:56:41 and 12:37:58–onward windows, because of a race
between two async paths touching one boolean. The same overrun, run again, would more likely have
been auto-raised in silence like the other eleven. Nothing about pm or qa made them the seat that
halted the mission — qa's *larger* overrun at 12:10:59 (+121%) lost the same race and passed
unnoticed.

This also explains why the suite does not catch it: `tests/integration/stall-watchdog.test.ts:201-296`
pins exactly this pair of behaviours — latch clears with auto-raise on, mission halts with it off —
but calls `forceWatchdog()` on a **quiesced** mesh, so no concurrent turn ever latches a ledger
inside the sweep window.

**Corrections this forces to earlier sections.**

- §16.14's conclusion that ceiling proximity does not predict escalation is right about the two
  observed halts and wrong about the mechanism. There *is* a deterministic ceiling path:
  `tryAutoRaise` returns false once `ledger.limit >= ceiling` (`supervisor.ts:3764`), the latch then
  stands, and the next `evaluate()` halts the mission.
- **ui-designer has not yet been refused.** At 12:27:10 its limit was 600,000 against a 1,200,000
  ceiling, so the test was false and the raise *took it to* the ceiling. Its next overrun is a
  **deterministic** halt, not a raced one. §16.9's instinct that ui-designer was the seat to watch
  was right; its stated reason — that ui-designer had already passed the ceiling test — was wrong.
- §16.13's hunch that the `DisagreementRecord` is co-created is confirmed: `createEscalation`
  (`supervisor.ts:3280-3300`) mints one unconditionally, for every escalation, with
  `actorId: HUMAN_AGENT_ID` hardcoded at `:3282`. It is a consequence, never a precondition — and
  it is a third source of the §16.2 "human did this" mislabelling.
- There is **no cooldown or debounce** on escalations. The 41-minute gap between the two was
  coincidence. The only suppressor is one-halt-at-a-time (`termination.ts:355-357`), which covered
  11:53:35–11:56:41 and nothing else.

### 17.1 Addendum — B0, which outranks everything in §17

| # | fix | why it outranks B1 | § |
|---|---|---|---|
| **B0** | **Make the auto-raise sweep atomic with respect to the termination verdict** — or have the verdict re-check `exceeded` after the sweep, or gate `agent_budget_exhausted` on `tryAutoRaise` having actually refused (`ledger.limit >= ceiling`) rather than on the raw latch. | Both mission halts in this run were this race. Each froze all nine seats, required a human intervention, and was avoidable: in both cases the raise that followed would have cleared the latch. It is the only defect observed in either watch that halts the entire mesh, and it does so non-deterministically — the same overrun passes silently eleven times out of thirteen. | §16.15 |

Every other item in §17 costs a wasted review, a stuck artifact, or a mis-attributed log line. B0
costs the mission. It is also the cheapest of the structural fixes, because the intent is already
in the code — `supervisor.ts:6958` places the sweep immediately before the verdict *specifically*
to keep the latch fresh. The sweep is simply not atomic against concurrent turns.

The test gap is worth fixing alongside it: `tests/integration/stall-watchdog.test.ts` pins the
quiesced behaviour on both sides of the `autoRaise` flag but never runs a turn concurrently with
the sweep, which is the only condition under which the bug appears.

**Note on B2.** An unmetered seat (`explorer`, §14.16) takes the *deterministic* escalation path,
not the raced one — `originalLimit` null means `tryAutoRaise` cannot raise, so the latch would
stand. explorer has not overrun because it has no limit to overrun, so it never latches at all.
B2 remains a config-validation fix, but it interacts with B0: adding explorer's budget row makes it
a candidate for both paths.

### 16.16 What the halts cost, and the two seats now on the deterministic path

The second escalation was answered at 12:57:53 ("raised budget to 13M — continue with smaller
steps"). Both halts, measured:

```
  11:53:35 -> 11:56:41   =  3.1 min
  12:37:58 -> 12:57:53   = 19.9 min
  total frozen           = 23.0 min
```

**23 minutes of a roughly 83-minute mission — 28% — spent with every seat frozen**, and per §16.15
neither halt was the budget system working as designed. Both were the sweep/verdict race. The cost
is not only the wall-clock: during a freeze sending stays open while activation does not (§14.6),
so mail written into the window lands in boxes nobody can be woken to drain.

**The operator raises have now exempted two seats from the ceiling entirely:**

```
  qa           13,000,000   ceiling 1,440,000   <- 9.0x above ceiling (operator, 12:57:53)
  pm            3,600,000   ceiling   960,000   <- 3.75x above ceiling (operator, 11:56:41)
  ui-designer   1,200,000   ceiling 1,200,000   <- AT ceiling
  architect       960,000   ceiling   960,000   <- AT ceiling
  tech-lead       720,000   ceiling 1,440,000
  marketing       320,000   ceiling   640,000
  ux-designer     300,000   ceiling 1,200,000
  backend         240,000   ceiling 1,920,000
  frontend        240,000   ceiling 1,920,000
```

§16.9 observed that the manual override moves risk rather than reducing it; two data points now
make the shape clear. **The two seats a human examined are the two that can no longer halt the
mission. The seats nobody examined still stop at 8x** — and two of them have now arrived there.

**A prediction, this time from the traced rule rather than from inference.** `tryAutoRaise` returns
false once `ledger.limit >= ceiling` (`supervisor.ts:3764`); the latch then stands and the next
`evaluate()` escalates. `ui-designer` and `architect` both satisfy that test now. Their next
`budget.exceeded` is a **deterministic** halt — no race required. architect is the likelier of the
two on rate: it has overrun three times already (11:58:30, 12:20:26, 12:39:37).

The caveat that killed the last two forecasts still applies in one direction only: the raced path
(§16.15) can still fire first on any other seat, so this predicts *which halt is unavoidable*, not
*which halt comes next*. I have been wrong twice by modelling a rule I had not read; this one is
read, and it is falsifiable — if architect or ui-designer overruns again and the mission does not
halt, the ceiling rule as traced is wrong.

---

## 18. Corrections made during the second watch

§9 does this for the first watch. Every claim below was written into these notes, found wrong, and
fixed in place. They are collected here because the *pattern* in them is more useful than any one
of them: seven of the nine came from modelling a rule I had not read, or from a denominator I had
not checked.

| # | what I claimed | what is true | cause |
|---|---|---|---|
| 1 | "13 human `budget.limit_raised` interventions" (§14.6) | 12 of 13 were auto-raises; the operator acted once | The log labels all 13 `actorId: "human"`. I believed the field. (§16.2) |
| 2 | "Delivery is 97% against 79%" (§16.5) | 77% against 79% — flat, fractionally worse | `message.delivered` is one event per *recipient*. I divided events by messages. |
| 3 | "22% of verdicts stale" (§16.8) | 15% and falling, concentrated in a burst | n=9 at the time; the denominator grew and no new stale verdict appeared |
| 4 | "The halt goes to whichever seat next exhausts a ceiling" (§16.9) | There is no such rule; both halts were a sweep/verdict race | Inferred a policy from 13 data points instead of reading `termination.ts` (§16.15) |
| 5 | "On this model every seat is one slow turn from architect's outcome" (§14.10) | Only the `startup` turn is slow — 18-20 min vs 1.0-3.3 for every other wake | Generalised from two startup turns before any other turn had completed |
| 6 | marketing would cause the next halt (§14.16); then ui-designer (§16.9) | pm caused the first, qa the second | Same root as #4 — no rule was being predicted, only a race |
| 7 | "`ResearchReport` has no reviewer gate at all" | There is an authority fallback; the defect is that a null capability unlocks *self-approval* | Read the absence of a capability row as the absence of a gate (§14.14) |
| 8 | Eight `goal-halted` entries were refused *messages* (§14.6 draft) | They are activation denials — `action: "activate (message)"` | `message.rejected` is the event type for both; only the `action` field distinguishes them |
| 9 | "ui-designer reached its ceiling and did not escalate" (§16.14) | The raise *took it to* the ceiling; `limit >= ceiling` was false, so it has not yet been refused | Confused arriving at the ceiling with being refused at it |

One further error was caught before it reached the notes: a per-seat activity table built with
`jq … | wc -l`, which counts JSON *lines* rather than events and reported backend at "99 turns,
40 artifacts". `jq -c` fixed it.

**What the pattern says about this kind of watch.** The event log is excellent at *what happened*
and actively misleading about *why*. Four of the nine corrections are cases where the log offered a
plausible causal story — `actorId: "human"`, a `disagreementRef` present on exactly the escalating
events, ceilings that looked like thresholds — and the story was wrong. In each case the fix came
from reading the code, not from more log analysis. §16.15 is the clearest instance: thirteen
observations could not distinguish the two escalations from the eleven silent raises, and one
predicate in `termination.ts` explained all thirteen immediately, then made a falsifiable
prediction about sequence ordering that the log confirmed 13/13.

The working rule this suggests for a third watch: **use the log to find what to explain and the
code to explain it**, and treat any causal claim sourced only from event correlation as a
hypothesis, labelled as one, until a code path backs it.

### 16.17 marketing has now asked pm three times to settle something pm cannot settle

Update to §16.13. The four `ResearchReport`s remain **0 of 4 settled**, and marketing has kept
asking:

```
11:48:07  marketing -> pm   ResearchReport "Positioning & Messaging Baseline v1"
12:06:29  marketing -> pm   ResearchReport "Naming the marketplace surface — propo…"
13:02:48  marketing -> pm   "Approve v2 (art-M371FBAV00ca102dfd7d) as the record of your…"
                             ^ the same artifact as 11:48:07, re-requested 75 minutes later
```

pm holds `requirements.approve/reject`. A `ResearchReport` resolves through `reviewSubject`'s
`default:` arm to `architecture`, so settling one needs `architecture.approve`. **`architect` is
the only seat in the mesh that holds it, and across the entire run architect has never been asked
to review a `ResearchReport`** — all three `REQUEST_REVIEW`s naming architect are for the
`RequirementsDoc`, which it can review.

So the work is routed, repeatedly, to the one seat guaranteed not to be able to move it, past the
one seat that could.

**Nothing refuses any of this.** §4c described a sender that never learns from a denial; here there
is no denial to learn from. The request is accepted, a thread opens, pm is woken, and the artifact
stays where it is. marketing's only feedback is silence, so it re-asks — and re-asking is
indistinguishable, in the log, from ordinary iteration.

marketing has consumed 277,732 tokens across the run (74,345 / 11,090 / 80,341 / 11,213 /
100,743 per turn), three of those turns producing these requests. That is not all spent on the
retry loop, but it is the seat with the smallest configured budget in the mesh (80,000) spending
3.5x it while producing nothing that can be accepted.

This is the strongest argument in the notes for **B4** — moving `canReviewArtifactType` to request
time. A refusal at 11:48:07 naming `architect` as the holder, in the style the authority gate
already produces ("lacks authority 'architecture.approve' — held by: architect", §16.6), would
have redirected the first request and prevented the other two. The mesh already knows how to write
that sentence; it just does not say it on this path.

---

## 19. Half of all turns emit nothing, and the seats know it before the mesh does

§15.5 admitted this watch had never opened `turns.jsonl` or `turn-audit.jsonl`. Opening them
changes the reading of several earlier sections.

### 19.1 The smoking gun is a seat's note to itself

explorer's turn at 13:02:34 carries a handover its previous session wrote, quoted verbatim:

> *"Verified: My R1/R15-R17 ResearchReport was **NEVER published**. Last turn's mesh-json block
> failed to parse (**'no mesh ops parsed from output — nothing was sent, published, or
> requested'**), so the pm INFORM, the architect design-check INFORM, and the artifact all
> silently did nothing. The full report text is now gone with the rotated context. It must be
> rewritten from the findings below and re-published."*

So explorer, the seat §16.10 described as producing nothing across two turns, had in fact produced
**an artifact and two messages**. The mesh could not parse the ops block, discarded all of it
without an event, billed the tokens, and then `session.rotated` destroyed the text. The seat
discovered this by auditing the artifact list and wrote itself a note.

The same handover records why its research task was hopeless anyway:

> *"This seat's tool surface is: Read works; Bash DENIED (no shell.execute/test.execute);
> WebSearch DENIED (no network.request); Write DENIED (no write capability)."*

explorer holds `repository.read` and nothing else, and architect asked it to inventory a
filesystem tree (§16.10).

### 19.2 Measured: 38 of 76 turns emitted no productive op

Cross-referencing every distinct `turnId` in `turns.jsonl` against the events carrying that
`turnId`, counting `message.sent`, `artifact.created/versioned`, `review.*`, `decision.proposed`,
`task.created`, `escalation.requested`, `research.completed` as productive:

```
  distinct turns                          76
  turns emitting NO productive op         38   (50%)
  of those, status == "ok"                12

  tech-lead    6/14      architect    5/10      ui-designer  5/10
  frontend     4/7       pm           4/11      ux-designer  3/6
  explorer     3/3       qa           3/5       backend      3/5
  marketing    2/5
```

**Every seat in the mesh is affected.** explorer is 3 for 3.

### 19.3 Documented parse failures, with what was lost

The continuity notes name the failure explicitly and quote what the model had just said. A sample,
by the seat whose note carries it:

```
tech-lead     "**Verdict on `artifact://RequirementsDoc/Skill Panel — Require…"   <- a review verdict
ux-designer   "Both artifacts published and in review. Notifying the thread,"     <- two publications
pm            "Requirements baseline published and design launched."              <- the mission baseline
frontend      "**Turn summary**"                                                  <- x5 occurrences
explorer      "Write is denied too (read-only seat), so I"
```

Five seats, at least sixteen distinct occurrences across the run. In each the model believed it
had published, sent or ruled; the mesh recorded nothing.

### 19.4 What this reframes

- **§16.12's "frontend is idle" is wrong.** frontend has 4 of 7 turns barren and five parse
  failures on record. It was not declining to work; its work was being discarded.
- **§16.10's "explorer produced nothing" is wrong in cause.** It produced an artifact and two
  messages that the mesh dropped. The section's *facts* stand — 185,555 unmetered tokens, no
  output in the log — but the explanation was mine and it was wrong.
- **§16.8's stale-review burst gains a mechanism.** If a publication fails to parse and is
  republished a turn later, versions churn for reasons invisible in the event log.
- **§1's thesis extends one layer down.** `{ ok: true }` now describes the turn boundary too: 12
  of the 38 barren turns are recorded `status: "ok"`. A turn whose entire output was discarded is
  indistinguishable, in `turns.jsonl`, from one that had nothing to say.
- **This is still not a model failure.** The models produced verdicts, artifacts and messages. The
  harness could not parse the block that carries them. Every seat that noticed wrote itself a note
  and rebuilt the work — which is the fourth distinct kind of prose workaround in this run.

### 19.5 Caveats

- **Barren is not the same as parse-failed.** A turn can legitimately emit nothing — a seat with no
  work, or one that ends in WAITING. 38 is the count of barren turns; the parse failures are the
  ≥16 that say so in a continuity note. The true parse-failure count lies between, and I did not
  separate them.
- The quoted fragments come from `instructions` blobs, which are *next*-turn context. The
  timestamp attached to each is the turn that carried the note, not the turn that failed.
- `turn-audit.jsonl` (1.2 MB) holds per-turn token detail and was still not opened; it may carry an
  authoritative parse-failure flag that would settle 19.5's first caveat exactly.

### 19.6 Closing §19.5's caveat: `ops: []` on 19 turns

`turn-audit.jsonl` is **not** plain JSONL — each line is `<ISO timestamp> {json}`, which is why the
first attempt to parse it failed. Stripping the prefix yields 69 audit rows carrying an `ops` field:
the ops the mesh actually parsed out of that turn's output.

```
  ops: []                                    19 turns   <- nothing parsed at all
  ops: ['write_continuity', 'done']          16 turns   <- bookkeeping only
  ops: ['wait']                               6 turns
  ops: ['done']                               2 turns
  ops: ['publish_artifact','request_review',…] and other productive combinations
```

**19 turns parsed zero ops.** That is the authoritative figure §19.5 said lay somewhere between 16
and 38, and it lands near the bottom of that range: the ≥16 occurrences named in continuity notes
were very nearly all of them. A further 16 turns parsed only `write_continuity` + `done` — real
parsing, but no work — which is why the event-side count of barren turns (38) is roughly the sum of
the two.

So the corrected claim is: **19 of 69 audited turns (28%) had their entire output discarded**, and
35 of 69 (51%) produced no productive op for one reason or another. §19.2's "50% of turns emit
nothing" survives; §19.1's mechanism accounts for the larger half of it.

`ops` should also be the cheapest possible fix hook: the mesh already knows a turn parsed to `[]`
and records it in the audit. Nothing surfaces that as an event, tells the seat, or retries.

### 19.7 An authority token that exists in code and in no config

At 13:09:24 tech-lead was refused twice, with the clearest message in either run:

> *"cannot accept criterion 'discovery' — this needs authority 'requirements.accept' or
> 'requirements.approve', and 'tech-lead' holds neither (agent tech-lead (role tech-lead) lacks
> authority **'requirements.accept' — no agent seat holds it**)"*

The refusal is correct and the wording is exemplary: it names both acceptable authorities, the seat
that lacks them, and volunteers that one of the two is held by nobody. Checking the config:

```
  requirements.accept    -> ** NO SEAT HOLDS IT **
  requirements.approve   -> [pm]
  architecture.approve   -> [architect]
  quality.approve        -> [tech-lead]
  release.approve        -> [qa]

  every authority declared anywhere in mesh.yaml:
    {architecture, implementation, quality, release, requirements} x {approve, reject}
```

`requirements.accept` is not merely unheld — **the token does not appear in the config vocabulary
at all**. The code asks for it, the config has never heard of it, and the mission is saved only by
the `or 'requirements.approve'` fallback that pm satisfies.

This is the second instance of the same class, after `qa` declaring `test.run` against an enforced
`test.execute` (§14.8). **Nothing validates that the capability and authority tokens a config
declares intersect the ones the code enforces**, in either direction: a config token the code never
checks is inert, and a code token no config declares is a latent dead end. Add it to the §17 config
list.

### 19.8 First task of the run, and a §12 fix confirmed live

At 13:09:51 — 93 minutes in — tech-lead created the run's first task and delegated it:

```
13:09:51  task.created   tech-lead
13:09:51  DELEGATE       tech-lead -> backend
          payload: {"taskId": "task-M37661BT00390afa64bb",
                    "title": "SLICE 1 task 1 — pnpm workspace + @skillpanel/adapter-kit SPI + the 11 co…"}
```

**The DELEGATE carries a title.** §6e recorded that all ten DELEGATEs in the pre-fix run carried
only `{"taskId"}` — including the eight-in-one-second storm at §14.4, seven of which were never
answered. §12 lists "DELEGATE carrying title/description/caps" as a fix; this is that fix working
in a live run, and it is the first delegation in either run whose recipient can tell what it is
without a second lookup.

It also ends §16.12's zero-task standoff: tech-lead approved an artifact at 13:09:51 and
immediately cut the first slice of implementation work.

### 19.9 The only seat the schema punishes is the one using the documented field

At 13:10:14 frontend produced the run's **only** schema rejection:

```
message failed protocol validation: /note must NOT have more than 2000 characters
```

The same rule hit tech-lead three times in the pre-fix run (§14.6). What the fixed build makes
visible is the incentive it creates:

```
  messages using the documented 'note' key :  n=14    median 1,917   max 5,180
  messages using invented keys             :  n=120   median 1,978   max 7,862

  the six largest payloads in the run, and whether they used 'note':
    7,862  frontend      no    keys = api_spec_bound, blocking_findings, coverage_gap, required_findings
    6,736  tech-lead     no    keys = C1_children, C2_adr_files_found, C3_also_falsified, not_blocking_others
    6,240  tech-lead     no    keys = adr_0001_and_6A_6, ask_1_gate_hold, ask_2_shipping_order, …
    6,092  pm            no    keys = baseline, hold, re, rulings
    5,741  ui-designer   no    keys = artifact_to_review, ask, dispositions, method
    5,582  ux-designer   no    keys = confirmed, defects, scope_note, verdict
```

**Payloads up to 7,862 characters pass unvalidated, because they are under keys the schema has
never heard of. A 2,001-character `note` is refused.** The schema constrains exactly one field;
120 of 134 messages route around it, not deliberately but because §6e's payload vocabulary is
open — and the fourteen that used the documented key are the only ones that can ever be refused.

§4d observed that AJV validation was "the one subsystem that reliably failed closed — which nobody
designed as the authority model." The sharper version, visible now: it fails closed on a field
almost nobody uses, and the seats that use it are the ones following the documented convention.
The effective rule a seat learns from this mesh is *invent your own key and you will never be
validated*, which is the opposite of what a schema is for.

Note this is not an argument for removing the cap. It is an argument that a payload schema which
covers one optional field, while `additionalProperties` lets everything else through, is worse
than either a real schema or none: it taxes conformance and exempts everything else.

### 19.10 Refinement to §16.16: the operator raise delays the halt, it does not prevent it

State at 13:12, 95 minutes in:

```
  seat          used        limit        % of limit   ceiling(8x)
  explorer      185,555     (none)             —         (none)    unmetered
  marketing     277,732       320,000        87%        640,000
  tech-lead     569,418       720,000        79%      1,440,000
  ux-designer   426,624       600,000        71%      1,200,000
  backend       162,407       240,000        68%      1,920,000
  architect     637,638       960,000        66%        960,000   limit == ceiling
  ui-designer   736,270     1,200,000        61%      1,200,000   limit == ceiling
  frontend      276,918       480,000        58%      1,920,000
  pm            506,476     3,600,000        14%        960,000   limit > ceiling (operator)
  qa            460,431    13,000,000         4%      1,440,000   limit > ceiling (operator)
```

§16.16 said the operator raises made pm and qa the seats *least* able to halt the mission, which
is true on headroom — pm must burn 3.6M, qa 13M. But `tryAutoRaise`'s refusal test is
`ledger.limit >= ceiling` (`supervisor.ts:3764`), and an operator raise satisfies it just as an
exhausted tranche does. **So pm and qa are on the deterministic halt path too.** When either
finally overruns, no auto-raise is possible, the latch stands, and the mission halts — no race
required.

Four of the ten seats now sit at or above their ceilings. The operator intervention did not exempt
pm and qa from the ceiling rule; it moved their trigger point far into the future and guaranteed
that when it arrives it is a certainty rather than a coin flip. Every remaining seat — marketing,
tech-lead, ux-designer, backend, frontend — can still be auto-raised, so their overruns remain
raced (§16.15).

The §16.16 prediction is **still open and untested**: neither architect nor ui-designer has
overrun since reaching its ceiling. They sit at 66% and 61% of a limit that can no longer grow.

Implementation remains one task deep (13:09:51) and zero patches at 95 minutes.

### 17.2 Addendum — fixes from §19, including one that belongs beside B0

§17 was written before `turns.jsonl` and `turn-audit.jsonl` were opened. Three items from §19
belong on the list, and the first outranks everything except B0.

| # | fix | why it ranks here | § |
|---|---|---|---|
| **B0b** | **Surface a turn that parsed to `ops: []`** — emit an event, tell the seat in its next context, and retry or flag rather than discarding silently. | **19 of 69 audited turns had their entire output discarded.** A verdict, two publications and the mission baseline are among the losses on record, and one seat's artifact text was destroyed by `session.rotated` before it could be rebuilt. The mesh already computes the fact and writes it to the audit; nothing acts on it. Tokens are billed either way. | §19.1, §19.6 |
| **B13** | **Validate at config load that every capability and authority token in `mesh.yaml` is one the code enforces, and vice versa.** | Two live instances: `qa` declares `test.run` against an enforced `test.execute` (§14.8), and the code asks for `requirements.accept`, a token no config has ever declared (§19.7). Both fail silently and in opposite directions — an inert declaration and a latent dead end. Pairs naturally with B2's budget-row check as one config-integrity pass. | §14.8, §19.7 |
| **B14** | **Make the message payload schema cover everything or nothing.** | It currently constrains one optional field. 120 of 134 messages used invented keys and were never validated; payloads up to 7,862 characters passed while a 2,001-character `note` was refused. The only seat penalised all run was one using the documented field. | §19.9 |

**Why B0b sits beside B0 rather than below it.** B0 costs the mission twice in 95 minutes through a
race. B0b costs a quarter of all turns, silently, on every build — and unlike B0 it has no
observable signature at all in the event log. The only reason this watch found it is that seats
audit themselves and write what they lost into their own continuity notes (§19.1). A mesh whose
agents were less diligent would lose the same work and leave no trace.

Both are the same failure in different clothes: **the system knows something went wrong and does
not say so.** B0 knows the latch was about to be cleared; B0b knows the ops list was empty.

### 17.3 Scoreboard for §17, at 95 minutes

Of the fixes proposed, these were **observed working** in this run and need no further argument:

- The authority gate fails closed and names the holder (§16.6, §19.7) — the model for what B4's
  request-time check should say.
- `DELEGATE` now carries a title (§19.8), closing §6e's "all ten carried only `{taskId}`".
- The artifact state machine transitions cleanly via `system` (§16.12), with §13.3's backwards-pull
  defect not recurring.
- A2 is confirmed: marketing's `request review` is no longer denied for lacking the reviewer's
  capability (§16.13 preamble).
- Broadcasts wake their recipients (§16.4), against §3's measurement on the old build.

These are real, and they are why the run reached a first task at all. They also make the remaining
list sharper: what is left is almost entirely **things the mesh knows and does not report**.

### 19.11 What the discarded turns cost: 1,191,376 tokens, 28% of all turn spend

`turn-audit.jsonl` carries `tokens.total` per turn, verified equal to the `agent:` ledger's
`budget.consumed` amount on every sampled turn. Grouping all 77 audited turns by what the mesh
parsed out of them:

```
  ops: []            output discarded    n=22   1,191,376 tokens   27.6%
  bookkeeping only   write_continuity/done/wait
                                         n=26     857,285 tokens   19.9%
  productive         everything else     n=29   2,266,507 tokens   52.5%
                                              ---------------------------
  TOTAL                                  n=77   4,315,168 tokens
```

**1,191,376 tokens — 28% of everything the mission has spent — bought output the mesh could not
parse and threw away without a word.** Another 20% produced only a continuity note. Barely half of
the spend reached a productive op.

Per seat, tokens lost to `ops: []`:

```
  tech-lead 233,044   frontend 194,542   ux-designer 179,476   architect 166,166
  explorer  164,164   pm       158,415   ui-designer 49,064    qa        46,505
```

Eight of ten seats. `explorer`'s 164,164 is close to its entire 185,555 lifetime spend, which is
the real explanation for §16.10 — the unmetered seat is not idle, nearly all of its work has been
discarded.

Put against the other costs this watch measured:

```
  discarded turn output                1,191,376 tokens    (§19.11)
  23 minutes of mission frozen by two halts that were a race   (§16.15, §16.16)
  15.3 minutes of generation killed by concurrency evictions   (§14.15)
  20 minutes lost to architect's startup-turn timeout          (§14.10)
```

The token figure dwarfs the rest, and it is the only one with **no signature in the event log at
all**. A reader of `events.jsonl` sees a seat wake, consume budget, and go quiet — identical to a
seat that had nothing to say. This is the argument for B0b in one number.

**Method note**, given three measurement errors earlier in this watch (§18): `tokens` is a dict of
`{input, output, total, cacheRead, thinking}`. Summing its values double-counts, since `total` is
already `input + output`. The figures above use `tokens.total` only, cross-checked against
`budget.consumed` for six turns where both exist — exact match on all six.

### 19.12 Approval by prose: pm has "approved" the same artifact twice and never issued an approve op

marketing's `ResearchReport` (`art-M371FBAV00ca102dfd7d`) is the one it asked pm to review three
times (§16.17). Its full history:

```
11:47:33  marketing   artifact.created, research.completed  -> READY_FOR_REVIEW
11:48:07  marketing   REQUEST_REVIEW -> pm                  -> UNDER_REVIEW (by system)
11:58:28  pm          message.sent, type APPROVE
13:02:25  marketing   artifact.versioned (v2)               -> READY_FOR_REVIEW
13:02:48  marketing   REQUEST_REVIEW -> pm                  -> UNDER_REVIEW (by system)
13:19:03  pm          message.sent, type INFORM
                      payload.verdict = "APPROVED — Positioning & Messaging Baseline v2
                                         stands as the record of my rulings."
```

**The artifact is still UNDER_REVIEW. There is no `review.approved` event for it, ever, and no
rejection of pm — at 13:19 or at any other time.**

pm's ops that turn, from `turn-audit.jsonl`:

```
  13:19:03  ['respond', 'send', 'send', 'send', 'plan', 'remember', 'done']
```

**No `approve` op.** pm wrote a detailed, specific approval — it names §4, §7, §8, §9.3, §9.4,
§10's Q1-Q5 and says "Each is a faithful transcription of what I ruled. No string differs from my
ruling" — and sent it as an INFORM with a `verdict` key. At 11:58:28 it did the same thing as a
message of type `APPROVE`. Neither is an approval operation, so the state machine never heard
about either.

This is §5a's defect at its purest. §5a found that whether an approval took effect depended on a
free-text subject word; here the approval is **entirely prose** — the seat believes it approved,
the recipient is told the work is approved, and nothing in the artifact projection changes. Both
sides can reasonably consider the matter settled while the criterion it serves stays UNMET.

**This corrects my own framing in §16.13 and §16.17.** I wrote that these ResearchReports were
stuck because pm *cannot* settle them — pm holds `requirements.approve`, the type resolves to the
`architecture` subject, and only architect holds `architecture.approve`. That remains true as a
reading of the config, but it is **untested**, because pm never attempted the operation. The
authority gate was never consulted. The artifact is not stuck at a refusal; it is stuck because no
one has ever asked the mesh to move it.

Which makes the failure quieter than I described. §16.17 argued this was the strongest case for
B4 (a request-time capability check). It is still a case for B4 — the routing is wrong — but the
proximate defect is different and needs its own fix:

**B15 — a message whose type or payload asserts a verdict (`APPROVE`, `REJECT`, `verdict:`,
`"APPROVED"`) without an accompanying approve/reject op should be refused, or should emit the op.**
The mesh already distinguishes the two internally; the seats plainly do not, and nothing tells
them. Five ResearchReports now sit unsettled (a fifth, `d25f9bd4`, appeared at 13:16), with at
least two "approvals" delivered in prose against them.

### 19.13 Approval-by-prose measured: 6 of 25, and it is per-seat, not universal

§19.12 found pm asserting a verdict twice with no approve op. Across the run, taking every message
whose type is `APPROVE`/`REJECT` or whose payload carries a `verdict` matching APPROVED/REJECTED
(excluding "CANNOT APPROVE" / "NOT APPROVED", which legitimately have no op), and asking whether
that seat emitted a `review.approved`/`review.rejected` within 90 seconds:

```
  6 of 25 verdict assertions unbacked (24%)

  tech-lead     0/16 unbacked     always issues the op
  architect     1/4
  ux-designer   2/2 unbacked      never issues the op
  pm            3/3 unbacked      never issues the op
```

**This is a per-seat habit, not a mesh-wide defect.** tech-lead is rigorous — sixteen verdicts,
every one backed by a real operation, most citing the artifact URI. pm and ux-designer have never
once issued a verdict op; every "APPROVED" either has sent is prose in a message payload. That
sharpens §19.12: the mesh does not make approval-by-prose *inevitable*, but nothing stops it, and
two of the four seats that issue verdicts do it every time.

The consequence is asymmetric in the worst way. tech-lead's rejections move artifacts to REJECTED
and are visible in the projection; pm's approvals move nothing. So the artifact store accumulates
rejections faithfully and loses approvals — which is a plausible contributor to §16.12's 4-approvals
to-9-rejections ratio and to the five ResearchReports that have never settled (§19.12).

**A second finding fell out of measuring this.** The first attempt joined verdicts to messages by
turn and returned an absurd 25-of-25 unbacked. The cause:

```
  review.approved / review.rejected :  correlationId = null   on all 17 events
  message.sent                      :  correlationId = turn-<id>
```

**Verdict events carry no turn correlation at all.** They cannot be joined to the turn that
produced them, to the messages sent alongside them, or to that turn's token spend. Every other
productive event type in this log carries `correlationId`. This is why §19.13 needs a ±90s time
window instead of an exact join, and it is a real observability gap in its own right: "which turn
approved this, and what else did that turn do" is not answerable from the event log.

**Caveat on the 6/25.** The ±90s window credits a verdict assertion if the seat emitted *any*
review op nearby, not necessarily for the same artifact. It can therefore over-credit — the true
unbacked count is 6 or higher, not lower. Matching on `artifactId` would tighten it, but most
verdict-bearing messages do not carry one, which is §6e again.

### 19.14 The events that record decisions cannot be traced to a turn; the events that record mechanics can

§19.13's failed join was not a one-off. Auditing every event type in this run for whether it
carries `correlationId` or `payload.turnId`:

**Never joinable to a turn — 25 of 41 types:**

```
  review.rejected 12     review.approved 5      decision.proposed 4     task.created 2
  architecture.approved 6                       commitment.discharged 16
  escalation.requested 3  escalation.responded 3  goal.escalated 2  goal.status_changed 2
  budget.limit_raised 18  budget.reserved 141   budget.released 8
  agent.failed 5          agent.restarted 10    agent.created 11   agent.started 10
  memory.updated 109      continuity.recorded 29  session.rotated 26
  thread.created 53       plan.updated 14       deadlock.auto_resolved 6   human.input 3
```

**Partially joinable:**

```
  message.rejected      1/19   ( 5%)   <- refusals are almost never traceable
  artifact.transition  29/61   (48%)
  artifact.created     13/16   (81%)
  message.sent        149/150  (99%)
```

**Always joinable:**

```
  budget.consumed, message.delivered, agent.awakened, context.assembled,
  review.requested, artifact.versioned, design.question, research.completed,
  budget.exceeded, session.rotation_pending
```

The split is not random. **You can trace exactly which turn consumed tokens, assembled context, or
was woken. You cannot trace which turn approved an artifact, rejected one, failed, was refused,
created a task, proposed a decision, raised an escalation, or had its budget raised.** The
mechanical substrate is fully instrumented; the decision record is not.

Every methodological difficulty in this watch traces back to this one table:

- §19.13 needed a ±90s heuristic instead of an exact join, because `review.*` has no turn link.
- §16.15's escalation race had to be resolved by reading `termination.ts` and then confirming via
  `seq` ordering, because `escalation.requested` and `budget.limit_raised` are both unjoinable.
- §14.15's evictions had to be reconstructed from `agent.awakened`/`agent.failed` interval
  arithmetic, because `agent.failed` carries no turn.
- §19.11's discard cost required `turn-audit.jsonl` — a separate file in a different format —
  because nothing in `events.jsonl` links a turn to what it produced.

**B16 — put `correlationId` on every event a turn emits**, starting with `review.approved`,
`review.rejected`, `message.rejected`, `agent.failed`, `task.created` and `budget.limit_raised`.
Five of the six are the events an operator most needs to attribute, and `message.sent` already
proves the plumbing exists and works at 99%.

This also reframes §1. "Every layer that failed here failed by returning `{ ok: true }`" describes
enforcement. The observability equivalent, visible only after auditing the whole log, is: **the
event log faithfully records that something happened and systematically omits which turn did it —
for exactly the events where that question matters.**

---

## 20. Consolidated fix list — supersedes §17, §17.1 and §17.2

Everything from the second watch, in one table, ranked by measured cost. Where a cost is measured
it is given; where it is not, the column says so rather than implying one.

| # | fix | measured cost of not doing it | § |
|---|---|---|---|
| **B0b** | Surface a turn that parsed to `ops: []` — event, next-turn notice, retry or flag | **1,191,376 tokens, 28% of all turn spend.** 22 turns discarded whole, incl. a verdict, two publications and the mission baseline. One artifact's text destroyed by session rotation before it could be rebuilt. No event-log signature at all. | §19.1, §19.6, §19.11 |
| **B0** | Make the auto-raise sweep atomic with the termination verdict | **23 minutes of mission frozen**, two halts, two human interventions. Both avoidable: in each case the raise that followed would have cleared the latch. Non-deterministic — the same overrun passed silently 11 of 13 times. | §16.15, §16.16 |
| **B7** | Refresh or re-snapshot mail mid-turn, or bound turn length | Root cause of B1, of architect's evaporated approval, of a review that was 71% wasted, of explorer's 65-minute-late task. **23% of messages never delivered to anyone** (25 of 109), flat against the pre-fix run's 21%. | §14.12, §16.7, §16.5 |
| **B11** | Queue a wake instead of evicting an in-flight turn | **18.6 minutes of generation discarded**, 4 evictions, all verified at exactly `max_active_agents: 3`. Six across both runs. | §14.15 |
| **B12** | Diagnose why the `startup` turn costs 6–20× every other wake | **20 minutes and one dead seat.** 18–20 min for both startup turns against a 20-min timeout; 1.0–3.3 min for every other wake. `startup.activate` puts both critical seats through it at once. | §14.10 |
| **B15** | Refuse, or auto-emit the op for, a message asserting a verdict without an approve/reject op | **6 of 25 verdicts (24%) never reached the projection.** pm 3/3 and ux-designer 2/2 never issue the op; tech-lead 0/16. Rejections land, approvals vanish — 5 ResearchReports unsettled. | §19.12, §19.13 |
| **B16** | Put `correlationId` on every event a turn emits | **25 of 41 event types are unjoinable to a turn**, including every verdict, refusal, failure, task creation and budget raise. Not a runtime cost — it is why B0b needed a second file, B0 needed the source, and B15 needed a ±90s heuristic. | §19.14 |
| **B1** | Compare reviewed version against current at verdict time | **15% of verdicts landed on a superseded version** (2 of 13), bursty rather than steady. Cheapest fix here; both values already in the projection. | §16.8 |
| **B4** | Move `canReviewArtifactType` to request time | 3 of 5 review requests named a reviewer who could not deliver a verdict; marketing asked pm 3× for something pm cannot settle. Cost not separable from B15. | §14.13, §16.17 |
| **B2** | Refuse a mission where a declared agent has no budget row | `explorer`: 185,555 tokens, no ceiling, no possible escalation — and 164,164 of it discarded (B0b). Third-largest consumer, zero output. | §14.16, §16.10 |
| **B6** | Silence watchdog — escalate when every seat has failed and nothing is emitted | **3h04m dead** with nine unanswered escalations, pre-fix run. Not exercised on this build. | §14.2 |
| **B5** | Add the six missing `REVIEW_CAPABILITIES` rows | A null capability reads as "no peer could have reviewed this" and *unlocks* self-approval. 5 ResearchReports sit in the hole; none has self-approved yet. | §14.14, §16.13 |
| **B3** | Record who decided a budget raise in a field, not prose | 9 of 10 raises are machine decisions logged `actorId: "human"`; the operator acted twice, the log shows ten. Also the only way to spot the raise that broke the 8× ceiling. | §16.2 |
| **B13** | Validate that config and code capability/authority vocabularies intersect | `qa` declares `test.run` against enforced `test.execute`; code asks for `requirements.accept`, which no config declares. Silent in both directions. | §14.8, §19.7 |
| **B14** | Payload schema covers everything or nothing | 120 of 134 messages used invented keys and were never validated. 7,862-char payloads pass; a 2,001-char `note` is refused. The only seat penalised was one following convention. | §19.9 |
| **B8** | A verb for "apply your method and report" distinct from `REQUEST_REVIEW` | ui-designer needed it four times and each time sent `REQUEST_REVIEW` plus a prose disclaimer in a separate thread. | §16.4 |
| **B9** | A channel to answer an open escalation with evidence | An agent raised a second escalation opening "this is a response … NOT a new escalation". It worked, so the workaround is reinforced. | §16.3 |
| **B10** | Give `PROPOSE` an obligation, or stop routing decisions through it | 3 decisions proposed, 0 ratified, across 3 turns of the holding seat and 5 messages naming them. Nothing will chase them. | §16.11 |

### 20.1 The shape of the list

Ten of the eighteen items are the same defect in different places: **the mesh computes the fact
and does not report it.** It knows the ops list was empty (B0b), that the latch was about to clear
(B0), that the reviewed version is stale (B1), that the reviewer cannot deliver a verdict (B4),
that the raise was automatic (B3), that a declared token is unenforced (B13), that a verdict
arrived without an op (B15), and which turn emitted each event (B16). In every case the
information exists at the moment of the failure and is discarded.

That is a more tractable problem than it looks, and it is why the cheap items near the bottom of
this table are worth doing before the expensive ones near the top: most of them are a conditional
and an event, not a redesign.

**Nothing on this list concerns message content.** Across two watches and roughly six hours of
mission time, not one failure was a writing failure — a point §1 made from the first watch and
this one has not contradicted.

### 19.15 An English sentence used as an authority token — §5a's defect at full extension

At 13:25:56 tech-lead tried to approve the fifth `ResearchReport` (`art-…d25f9bd4`) and was
refused:

```
ruleId  = authority
action  = approve frontend v5 verification report (R17 surfaces) — accepted as the v5 verification record
subject = art-M376A65W0050d25f9bd4
reason  = agent tech-lead (role tech-lead) lacks authority
          'frontend v5 verification report (R17 surfaces) — accepted as the v5 verification record.approve'
          — no agent seat holds it
```

**The authority token is a 79-character English sentence with `.approve` appended.** It is checked
against the seat's authority list, found absent, and refused — correctly, and unavoidably, because
no seat will ever hold it.

The mechanism is the one §19.7 traced: `domainOfSubject` has no arm for the six capability-less
artifact types and falls through to `return subject` — the free-text domain word the *caller
typed*. Where a seat types `architecture` or `requirements` the check works, and this run shows
both:

```
  12:23:01  pm         -> authority token 'architecture'   (well-formed, correctly refused)
  13:09:24  tech-lead  -> authority token 'requirements'   (well-formed, correctly refused)
  13:25:56  tech-lead  -> authority token 'frontend v5 verification report (R17 surfaces) — …'
```

Where a seat types a descriptive phrase — which is the natural thing to write in a field called
`subject` — the token becomes the phrase.

**This is the most damaging instance because of who hit it.** tech-lead is the one seat that
always backs its verdicts with a real operation (0/16 unbacked, §19.13). It attempted the correct
op on the correct artifact, and the mesh converted its own prose into an unsatisfiable permission
check. The rigorous seat is punished; the seats that approve in prose (§19.12) never encounter this
at all, because they never call the op.

It also means the fifth ResearchReport joins the other four as unsettleable (§16.13) — but for a
third distinct reason: not wrong reviewer, not missing capability row, but a malformed authority
token generated from the request itself.

**Add to B13/B5:** `domainOfSubject` must not return caller-supplied text as a permission token.
Either resolve the six missing types the way `reviewSubject` does, or refuse a subject that is not
a known domain — a token containing spaces or punctuation is never a valid authority.

### 19.16 The self-approval gate works and gates

Twenty seconds earlier, at 13:25:37, pm attempted `transition -> APPROVED` on its own
`RequirementsDoc` and was refused:

```
ruleId = self-approval
reason = artifact owner cannot approve or reject their own artifact
```

The artifact did not move — it remained APPROVED from tech-lead's 12:29:21 verdict, and pm's
attempt added nothing. **This gate fails closed**, like the authority gate (§16.6) and unlike the
pre-fix capability gate (§4b).

Worth noting against §19.13: pm *does* issue real operations — this was a genuine transition
attempt, not prose. Its 3-of-3 unbacked record there concerns review verdicts specifically, not
every op it calls. The distinction matters for B15: pm is not incapable of using the op layer, it
simply expresses approvals as messages.

### 19.17 The first task was claimed — §6f's dead end is gone, but the reason is unconfirmed

```
13:09:51  task.created  tech-lead   "SLICE 1 task 1 — pnpm workspace + adapter-kit SPI + 11 contract tests"
                                    requiredCapabilities: ["repository.write", "test.execute"]
13:12:45  task.created  frontend    "Frontend: R17 surfaces (blocked on Core Architecture v2)"
                                    requiredCapabilities: ["repository.write","test.write","test.execute"]
13:29:00  task.claimed  backend     task-M37661BT…  (19m09s after creation)
```

§6f recorded the pre-fix dead end: `task.requiredCapabilities` was the one place `CAPABILITY_ALIASES`
was not applied, and after aliasing `repository.write` and `test.execute` were held by **disjoint
sets — nobody held both**, so all nine of architect's tasks were unclaimable.

That is no longer true: backend claimed a task requiring exactly that pair. But note what backend
actually declares:

```
  backend capabilities : repository.read, api.write, data.write, test.write,
                         test.execute, git.commit, shell.execute
  task requires        : repository.write, test.execute
```

**backend does not declare `repository.write` literally.** The claim succeeded anyway, which admits
two explanations and the log cannot distinguish them:

1. `CAPABILITY_ALIASES` is now applied at claim time and `api.write`/`data.write` resolve to
   `repository.write` — the §12 fix working as intended; or
2. `requiredCapabilities` is not checked at claim time at all, in which case the dead end is gone
   because the gate is gone.

The difference matters — under (2) the second task, which additionally requires `test.write`,
would also be claimable by a seat that cannot do it. **Marked unresolved.** Settling it needs the
claim path read in `supervisor.ts`, which this watch has not done, and I am not recording it as a
confirmed fix on the strength of one successful claim.

Two smaller observations from the same pair of events:

- **frontend created a task for its own blocked work**, marked `BLOCKED ON: Core Architecture v2`
  with the reason it is blocked, "so the work is visible and claimable the moment they land". That
  is a seat using the task board as a queue rather than waiting silently — and it is the only
  mechanism in this run by which blocked work has been made visible at all.
- **Claim latency was 19m09s.** The task was created at 13:09:51 and backend, which had been woken
  and had taken turns in between, claimed it at 13:29:00. Consistent with §14.3's delivery tail
  rather than anything new.

### 19.18 §19.17 resolved: the gate exists and aliases resolve — and §14.8 was wrong about `qa`

The claim at 13:29:00 succeeded for explanation (1). Explanation (2) is refuted.

**The gate is present.** `claimTask` (`supervisor.ts:3150-3162`) loops over every required token and
refuses on the first failure:

```ts
3155:  for (const cap of task.requiredCapabilities) {
3156:    const decision = this.deps.policy.evaluateCapability(actorId, cap, ctx);
3157:    if (decision.decision !== "ALLOW") {
3159:      return { ok: false, reason: `missing capability ${cap}: ${decision.reason}` };
```

**Aliases now resolve on both sides.** `CAPABILITY_ALIASES` (`catalog.ts:886-902`) maps
`api.write`, `data.write`, `ui.write`, `code.write`, `docs.write` → `repository.write`, and
`test.run`, `quality.verify` → `test.execute`. The agent roster is normalised at
`config/src/index.ts:1098`; the new half is the task side, `supervisor.ts:6109`, which normalises
`requiredCapabilities` at the single construction point. So the claim compared
`repository.write`/`test.execute` against a roster that already held both.

**The decisive disproof of "the gate is gone"** is a negative test that exists and passes —
`tests/core/task-capability-tokens.test.ts:144-146`, untracked in the working tree:

```ts
144:  const claim = await m.supervisor.claimTask("dev", created.taskId!);
145:  assert.equal(claim.ok, false, "dev does not hold it");
146:  assert.match(claim.reason ?? "", /git\.merge/);
```

§6f is therefore **fixed and its line citations are stale** — `supervisor.ts:5902/5920/:3119-3121/:5941`
were the pre-fix sites; the working tree has moved them and added `unknownTaskCapabilities` screens
that refuse invented tokens at creation (`:5882`) and at delegate (`:6141`).

### 19.19 Correction: §14.8's `qa` finding was wrong

§14.8 listed as "still open" that `qa` declares `test.run` while the enforced capability is
`test.execute`, concluding "qa simply never satisfies a `test.execute` requirement." **That is
wrong.** `test.run` is in `CAPABILITY_ALIASES` and normalises to `test.execute` at roster load, so
qa satisfies such requirements fine. I read a literal mismatch in `mesh.yaml` as a functional one
without checking whether the alias table covered it — the same error as §18's pattern, made once
more.

This narrows **B13**. The vocabulary-mismatch fix still has one real instance —
`requirements.accept`, a token the code asks for that no config declares (§19.7) — and one that is
not a defect at all. B13 should read: *validate that config tokens resolve, through
`CAPABILITY_ALIASES`, to something the code enforces, and that every token the code requires is
reachable from some config.*

**One residual edge worth keeping**, which the alias work does not close:
`evaluateCapability` (`policy-engine/src/index.ts:104-115`) does not normalise its own `capability`
argument — the comparison at `:112` is a raw `includes`. Correctness depends on every caller
pre-normalising. The five current call sites do; a future one passing a model-authored token
straight through would silently deny, and silently is the operative word given §19.14.

### 19.20 The deterministic halt fired exactly as traced — and the absent event is the proof

At 13:42:35, ui-designer overran and the mission halted for the third time:

```
13:42:35  budget.consumed       ui-designer  45,220
13:42:35  budget.exceeded       ui-designer  1,220,025 / 1,200,000   (+1.7%)
13:42:35  escalation.requested  termination-manager
13:42:35  goal.escalated        agent_budget_exhausted
13:42:35  message.rejected      ui-designer  "agent budget exhausted (1220025/1200000)"
13:42:35  message.rejected      tech-lead, marketing, frontend, pm, qa, architect
                                "mission is escalated — respond to the open escalation first"
```

**There is no `budget.limit_raised`.** That absence is the whole finding. In the two previous halts
(§16.15) a raise fired in the same second and would have cleared the latch — the escalation only
won a race. Here `tryAutoRaise` returned false at `supervisor.ts:3764` because
`ledger.limit (1,200,000) >= ceiling (8 × 150,000 = 1,200,000)`, so no raise was even attempted,
the latch stood, and `termination.ts:368-372` escalated on the next evaluate. No race required.

**This is the §16.16 prediction resolving correctly**, and it is the first forecast in this watch
that held. The difference from the two that failed (§14.16 named marketing, pm halted; §16.9 named
ui-designer on the wrong grounds, qa halted) is not luck: those were inferred from event
correlation, this one was derived from the predicate after reading `termination.ts` and
`tryAutoRaise`. §18's rule — *use the log to find what to explain and the code to explain it* —
produced a falsifiable claim, and the falsifier did not arrive.

Note how small the trigger was: **a 1.7% overrun.** qa's 121% overrun at 12:10:59 passed silently
because a raise was still available; ui-designer's 1.7% halted nine seats because one was not.
**The magnitude of an overrun has no relationship to its consequence** — only whether a tranche
remains.

Also new: a seat being refused for its own exhausted budget
(`"agent budget exhausted (1220025/1200000)"`), which is the first time in either run that the
overrunning seat itself received a refusal rather than only the bystanders.

**Architect is next, on the same path** — 896,925 of 960,000 at last measure, 93%, at its ceiling.
tech-lead is at 959,242 of 1,440,000 and still has a tranche, so its next overrun is raced.

### 20.2 Final measured costs, and what they do to §20's ranking

Figures at 13:45, ~2h27m of mission time. These supersede the per-section numbers, several of
which were taken mid-run and have grown:

```
  discarded turn output      1,191,376 tokens   28% of all turn spend   §19.11
  eviction at the cap             28.3 min      6 evictions, 6 at cap   §14.15
  halts                           23.7 min      3 halts, 2 of them a race  §16.15, §19.20
  startup-turn timeout              20 min      1 seat, never recovered §14.10
```

**B11 was ranked on 18.6 minutes and is now at 28.3** — it has overtaken the halts to become the
second-largest measured loss. It also has the worst trajectory of the four: 18.6 → 21.8 → 28.3
within half an hour, six of nine working seats hit, ux-designer twice in nine minutes with the
second costing 6.6 minutes. Unlike the halts it is not self-limiting; it scales with how many seats
are active, and the mesh gets busier as the design loop widens. **B11 should move up, above B7.**

The halts are the opposite case and worth stating precisely now that all three are in: **two of
the three were not the budget system working.** 11:53:35 and 12:37:58 were the sweep/verdict race
(§16.15) — in each, a raise fired in the same second that would have cleared the latch. Only
13:42:35 was a real ceiling stop (§19.20), identifiable by the absence of any `budget.limit_raised`.
So B0's share of the 23.7 minutes is 23.0 of them.

What has *not* changed is the top of the list. 1,191,376 tokens is still larger than everything
else combined in any sensible conversion, and it remains the only one of the four with no
signature in the event log.

### 20.3 §14.10 falsified: wake kind does not predict turn duration — work size does

At 13:48:39 backend hit `turn timeout after 1200000ms`. Its wake was **`kind: "message"`**, not
`startup`:

```
13:28:39  backend  agent.awakened   kind=message (msg-M37661BT002daa2b1396)
13:28:39  backend  context.assembled
13:29:00  backend  task.claimed     task-M37661BT00390afa64bb   (SLICE 1 task 1)
13:33:27  backend  plan.updated
          ---- 15 minutes, nothing ----
13:48:39  backend  agent.failed     turn timeout after 1200000ms
```

§14.10 concluded, from two startup turns at 18–20 min against five other-kind turns at 1.0–3.3 min,
that "**it is the `startup` turn that is pathological, not the model**" and that only startup turns
sit at the timeout boundary. **That is now false.** A message-woken turn took the full 20 minutes
and died.

§14.10 carried its own warning — it recorded that an earlier draft had "generalised from two
startup turns before any non-startup turn had completed." The generalisation that replaced it was
better but still built on n=2 for the slow class, and the third data point breaks it.

**The better predictor is what the turn was asked to do.** The two startup turns carried the full
mission brief (17 criteria, role prompt, acceptance bar). This one claimed and began the largest
single work item in the run — a pnpm workspace, the adapter SPI, and eleven contract test classes,
per the task description tech-lead wrote. The seven fast turns were all review, dispositioning or
coordination. Turn duration tracks work size, and `turn_timeout_ms` of 1,200,000 is simply too
small for a turn that does implementation.

**The cost is the worst single instance in the run.** This was the first and only claimed
implementation task; its first turn produced a `plan.updated` at 13:33:27 and then nothing.
Twenty minutes gone, the task still claimed, no patch, and whatever backend generated in those
fifteen silent minutes discarded — a timeout parses no ops, so this is also a B0b loss that
`turn-audit` will record as `ops: []`.

Timeouts now total **40 minutes across two turns** (architect 11:38:03, backend 13:48:39), and both
killed the seat that the mission was waiting on at that moment. B12 should be restated: not
"diagnose the startup turn" but **"turn_timeout_ms is calibrated for coordination turns and kills
work turns"** — either raise it for seats holding a claimed task, or make the timeout adaptive to
what the turn is doing.

### 20.4 Correction: failed turns produce no audit row and are billed zero

§20.3 asserted that backend's timed-out turn would appear in `turn-audit.jsonl` as `ops: []` and
count toward §19.11's discarded-token total. **Both halves are wrong**, and checking rather than
asserting turned up something better.

```
  turns recorded in turns.jsonl : 120
  rows in turn-audit.jsonl      : 109
  turns with NO audit row       :  11   — 8 failed, 3 still running
  tokens billed on those turns  :   0
```

The audit row is written at turn end, so a turn that fails never writes one. All eight failures —
both timeouts (architect 11:18:02, backend 13:28:39) and all six evictions — are absent from the
audit entirely, not present with an empty `ops` list.

**They are also billed nothing.** Every one shows `budget.released` and no `budget.consumed` for
its `turnId`. So §19.11's 1,191,376 tokens is *not* an undercount: the failed turns cost wall-clock
time and lost work, not ledger tokens. That part is reassuring and the 28% figure stands as
written.

**What it exposes instead is an accounting gap.** backend generated for twenty minutes before its
timeout; architect for twenty before its own. Those tokens were spent at the provider — the model
produced output, it simply never came back in a parseable form before the deadline. The mesh
records the cost as **zero**.

Consequences worth stating:

- **The ledger understates real spend.** Mission consumption reads 5.75M; the true provider figure
  includes two 20-minute generations and six evicted turns totalling 28.3 minutes, none of it
  counted.
- **A seat that repeatedly fails is invisible to the budget system.** It can burn provider tokens
  indefinitely without approaching any ceiling, because failures do not accrue. ux-designer was
  evicted twice in nine minutes at zero recorded cost.
- **It interacts with B11 and B12 badly.** The two mechanisms that destroy the most work — eviction
  and timeout — are the two whose cost the budget system cannot see, so no budget signal will ever
  surface them. They are visible only as `agent.failed`, which (§19.14) carries no turn
  correlation either.

Add **B17 — account for failed turns.** Either bill the reservation on failure or emit the
provider-side usage, so that eviction and timeout cost appear somewhere other than wall-clock.

### 20.5 Correction: `explorer` is NOT unmetered — §14.16's headline claim is wrong

At 14:04:16 explorer produced:

```
budget.exceeded      explorer
budget.limit_raised  auto-raise: 211939/200000 exhausted; ceiling 1600000 (8x 200000)
```

**explorer has a limit of 200,000 and a ceiling of 1,600,000.** §14.16 asserted the opposite, at
length and as a headline finding:

> *"It is the largest consumer in the mesh … and nothing can ever stop it: there is no limit to
> exceed, so no `budget.exceeded`, no escalation, no cap."*
>
> *"the budget system halted the mesh over a 7,634-token overrun by pm while ignoring 133,711
> tokens spent by explorer, because the first had a row in a table and the second did not."*

Both passages are false. The limit exists; it simply does not come from `mesh.yaml`.

**What was right, and still is:** `mesh.yaml`'s `budgets.agent` has rows for nine seats and none
for `explorer` — verified again just now, and there is no `agentDefaults` block in the file either.
The 12:49 config edit did add the seat without adding a budget row (§14.8). explorer was, at the
time §14.16 was written, the third-largest consumer in the mesh.

**What I got wrong:** I inferred from "no row in the config" that there was no limit anywhere, and
built a table that printed `limit 0 / UNMETERED` because my own script defaulted a missing row to
zero. The mesh resolves the limit through a code-level fallback —
`…?? config.budgets.perAgent[id] ?? config.budgets.agentDefaults.tokens` (`supervisor.ts:3841-3845`),
which an earlier subagent report had quoted to me verbatim and which I did not connect to this
claim. The evidence was in my own notes before the error was.

**Consequences for the rest of the document:**

- **§16.10** stands on its facts — explorer produced no messages, no artifacts and no
  `research.completed` across three turns — but its closing paragraph ("the only seat with no
  budget ceiling … the mesh has no mechanism that will ever notice") is void. The mechanism exists
  and has now fired.
- **§19.11** is unaffected: the 164,164 tokens explorer lost to `ops: []` were measured from the
  audit, not from any budget assumption.
- **B2 is materially weakened** and should be rewritten. "Refuse a mission where a declared agent
  has no budget row" is not preventing an unmetered seat, because there are none. The defensible
  version is narrower: *a seat that inherits the default limit does so silently, and the operator
  who wrote nine explicit rows plainly did not choose 200,000 for the tenth seat* — so warn at
  config load rather than refuse. It drops well down the §20 ranking.

This is the ninth correction in this watch and the most consequential, because §14.16 was written
as a discovery and repeated in three later sections. The proximate cause is the one §18 already
named: I modelled a rule from config without reading how the code resolves it.

### 20.6 B14 moves up: the note cap is a message-loss mechanism, not a consistency wart

§19.9 recorded one schema rejection and framed the `/note` 2000-character cap as an incentive
problem. At 14:10:07 ui-designer lost **four messages in a single turn** to it. Final tally:

```
  all schema rejections this run : 5
  of those, /note over 2000      : 5   (100%)
  seats affected                 : frontend (1), ui-designer (4)

  messages using the documented 'note' key :  14   max payload  5,180 chars
  messages using invented keys            : 194   max payload 10,049 chars
```

A **10,049-character** payload passed unvalidated this run because its keys are not in the schema.
The 14 `note` users are 7% of traffic and 100% of the enforcement surface.

**B14 was ranked near the bottom of §20 as a consistency concern. It is a measured message-loss
mechanism** — four messages destroyed in one turn — and belongs above B3, B13 and B10.

The seat it hit is the one that has been most careful all run: ui-designer is the seat that
narrated its own capability limits rather than silently routing around them (§16.4), audited a
stale review and reported it 5-of-7 (§16.7), and republished four times against reviewer feedback.

That completes a pattern this watch has now seen three times, and it is worth stating as a finding
in its own right:

- **tech-lead** backs every verdict with a real op (0/16 unbacked) — and is the seat the malformed
  authority token hit (§19.15).
- **ui-designer** uses the documented payload field — and is the seat the schema refuses (§20.6).
- **pm** approves in prose and never calls the op (3/3 unbacked) — and encounters neither.

**The substrate systematically penalises conformance.** Every enforcement surface in this mesh is
positioned where a careful seat will touch it and a careless one will not: the schema covers only
the documented key, the authority check runs only when an op is actually called, and the capability
gate fires only on the seat that requests a review properly. A seat that invents payload keys,
approves in prose, and never calls a gated op will pass through this system without ever being
refused.

### 20.7 Three of four authority tokens the code asked for do not exist

Every distinct authority token checked this run, against what `mesh.yaml` declares:

```
  asked for (4 distinct)                                            declared?
    architecture.approve                                        x3   YES
    requirements.accept                                         x2   no
    design.approve                                              x1   no
    "frontend v5 verification report (R17 surfaces) — …"+.approve x1   no

  declared vocabulary:
    {architecture, implementation, quality, release, requirements} x {approve, reject}
```

**Only one of the four is satisfiable.** The other three fail in three different ways:

1. **`requirements.accept`** — a token the *code* asks for that no config has ever declared
   (§19.7). A pure vocabulary gap; saved only by an `or requirements.approve` fallback.
2. **the 79-character sentence** — `domainOfSubject` returning a caller's prose subject verbatim
   (§19.15). Obviously broken, and obvious is its only redeeming quality.
3. **`design.approve`** — the same mechanism as (2), but the caller typed the single word `design`,
   so the result *looks like a real permission*.

**(3) is the dangerous one.** An operator debugging "ux-designer lacks authority `design.approve` —
no agent seat holds it" would reasonably add `design.approve` to ux-designer's authority list. That
would appear to fix it, and would in fact enshrine an arbitrary caller-typed word as a permission —
after which the next seat typing `visual`, `ux`, or `layout` hits an identical wall, and the config
accretes one authority per vocabulary choice a model happens to make.

The refusal text is excellent and actively misleading at the same time. *"no agent seat holds it"*
is true and implies the remedy is to make some seat hold it. The actual remedy is that
`domainOfSubject` should never have produced the token.

This strengthens the fix already noted at §19.15: **`domainOfSubject` must not return
caller-supplied text as a permission token** — resolve the six missing artifact types the way
`reviewSubject` does, and refuse an unrecognised subject rather than concatenating it. A token that
is not in the declared vocabulary should be a configuration error at the point it is constructed,
not a permission denial at the point it is checked.

### 20.8 Empty INFORMs are accepted and delivered

In the same two turns where ui-designer lost six messages to the `/note` cap (§20.6), three
messages it *did* send carry **entirely empty payloads**:

```
14:10:07  REQUEST_REVIEW -> frontend, ux-designer   payload {question: "Review … v9"}   OK
14:10:07  INFORM         -> pm                      payload {}      refs: [design-system/9]
14:11:22  INFORM         -> ux-designer             payload {}      refs: [ResearchReport/1, design-system/9]
14:11:22  INFORM         -> ux-designer             payload {}      refs: [ResearchReport/1]
```

Three `INFORM`s with `payload: {}` were accepted, threaded and delivered. The recipient receives an
envelope with an artifact reference and **no content whatsoever** — no note, no verdict, no ask.

Two mechanisms could produce this and the log cannot distinguish them:

1. **Stripping** — the schema refused the oversized `note` and the message was sent anyway with the
   offending field removed, so the sender believes it communicated and the recipient gets nothing.
2. **Separate sends** — the model emitted both fat notes (refused) and distinct empty INFORMs in
   the same turn, and the empties are its own doing.

Distinguishing them needs the op layer, which this watch has not read. **What is not in doubt is
the outcome:** a message carrying no payload at all passed validation, and the schema that refuses
a 2,001-character `note` has nothing to say about a payload with zero fields.

That is the sharpest possible statement of §19.9's asymmetry. The one validated field is checked
for being too *large*; nothing anywhere checks a message for being empty. Combined with §4c — the
sender never sees its own denials — ui-designer has no way to discover either that six messages
were refused or that three arrived hollow.

**B14 restated:** the payload schema should check that a message says something, not merely that
one optional field is short enough. An `INFORM` with `payload: {}` and no `note` is not a
communication, and it is currently indistinguishable in the log from one that is.

### 20.9 Updated figures: eviction is per-wake, and the note cap has spread

**Eviction is one turn killed per pending wake.** At 14:20:27 two seats died in the same second,
and the sequence shows why:

```
  seq2619  architect    agent.failed (interrupted)
  seq2623  pm           budget.reserved, awakened      <- takes the freed slot
  seq2630  ux-designer  agent.failed (interrupted)
  seq2635  ui-designer  budget.reserved                <- takes the second freed slot
```

Two wakes were pending, so two in-flight turns were destroyed back to back. **The cost therefore
compounds with wake arrival rate, and wakes arrive in bursts because turns end in bursts** — the
mechanism is worst exactly when the mesh is busiest.

```
  evictions  9   45.0 min   (architect 3, ux-designer 3, backend 1, tech-lead 1, frontend 1)
  timeouts   2   40.0 min
                 ────────
                 85.0 min of generation destroyed
```

That is roughly **15% of all generation capacity** (≈190 min elapsed × 3 slots), on top of the 28%
of *billed* tokens discarded unparsed (§19.11). The eviction figure rose from 32.6 to 45.0 minutes
in twenty minutes; it is the fastest-growing cost in the run and supersedes §20.2's numbers.

**The note cap has spread beyond one seat.** Final tally:

```
  ui-designer   9
  ux-designer   2
  frontend      1
                --
               12   — every schema rejection in the run is this one rule
```

§20.6 framed this as ui-designer's problem. It is not: it is what happens to any seat whose
substantive output exceeds two thousand characters in the one field the schema validates, and the
seats writing the longest, most specific messages are the ones that hit it. ux-designer joins
having just published a multi-finding design review.

Neither seat can learn from it — §4c means the denials never reach their context — so both will
keep regenerating the same oversized field until the work changes shape on its own.

---

## 21. The relabelled subject: not a bypass here, a bypass at HEAD, and a criterion-accounting hole

### 21.1 What I suspected, and why it was wrong for this run

From 13:37 onward tech-lead's verdicts switched `fallbackSubject` from `architecture` to `quality`,
and artifacts it had repeatedly rejected as `architecture` began reaching APPROVED. tech-lead holds
`quality.approve` and not `architecture.approve`, so this looked like an authority bypass by word
choice. **It is not one, in this run.**

The op path does choose the authority token from caller free text — `recordDecision`
(`supervisor.ts:2910`) calls `domainOfSubject(subject, artifactId)`, and that function
short-circuits on the six domain words *before* consulting the artifact
(`projections-helpers.ts:307`). So `subject: "quality"` really is evaluated as `quality.approve`,
which tech-lead holds.

But the **move** is screened separately in the working tree. `projections-artifact.ts:151` now
guards the transition with `approverMayAdvance`, which re-derives the domain from the **artifact
type** and ignores the caller's word:

```ts
const domain = domainOfSubject(state, artifact.type, artifact.id);   // "architecture"
if (auth.includes(`${domain}.approve`) || …) return true;
const cap = capabilityForReview(artifact.type);                      // "review.design"
return cap !== null && (def.capabilities ?? []).includes(cap);
```

**skill-panel's tech-lead holds `review.design`** (`repository.read, code.review, review.design,
test.execute`). So the artifact moved because of a capability it legitimately has, not because of
the word it typed. My reading of the timeline was wrong, and the near-miss is instructive: the
observable evidence — reject-as-architecture, later approve-as-quality, artifact moves — is
identical under both explanations.

### 21.2 It is a real bypass at committed HEAD

At HEAD the reducer has no screen at all (`git show HEAD:packages/core/src/projections-artifact.ts`,
line 169):

```ts
if (a && (a.status === "UNDER_REVIEW" || a.status === "READY_FOR_REVIEW")) {
```

There, the caller's subject decides both whether the verdict is recorded *and* whether the artifact
moves. A seat holding any one `<domain>.approve` can settle any artifact by labelling the verdict
with that domain. The working tree's `approverMayAdvance` is the fix, it is **uncommitted**, and
the regression test for it — `tests/core/approve-advance-authority.test.ts:76`, "a domain authority
does not let a seat settle an artifact it could never review" — is untracked. Anyone running the
committed tree has the bypass.

### 21.3 The real defect here: approvals that move the artifact but mark no criterion

`recordDecision` emits `architecture.approved` only when `domain === "architecture"`
(`supervisor.ts:3066`). Once tech-lead relabelled to `quality`, that branch stopped firing. The log
shows it exactly:

```
  architecture.approved  events: 12:13:56 x2, 12:33:29, 13:09:24, 13:10:40, 13:20:15,
                                 13:25:32, 13:28:49      — then nothing

  quality-labelled approvals: 14:12:45 x4, 14:30:46 x4, 14:33:53 x3   — 11 approvals, 0 criterion marks
```

Among those eleven are `art-…cf85241f` (Core Architecture), `art-…c66f22f4`, `art-…83018997` and
`art-…41207378` — ArchitectureDocuments whose approval is precisely what the `architecture-approved`
criterion exists to record. **The artifacts are APPROVED and the criterion they satisfy is not
marked**, because a word in the verdict changed.

This is §5a's defect surviving into the fixed build in its most consequential form yet. §5a found
that a free-text subject decided whether an approval *took effect*; here it decides whether the
mission's own acceptance tracking notices that it did. The mission has 17 mandatory criteria and
its progress record is now silently wrong.

### 21.4 Residual exposure in the working tree

- **The op path is unchanged.** `recordDecision` still picks the authority from caller free text
  with no cross-check against the artifact type. Only the move is screened.
- **A refused move returns `{ ok: true }`.** When `approverMayAdvance` says no, the artifact
  silently stays UNDER_REVIEW and the signer is told nothing — the `inertApproval` caveat covers
  "this status cannot advance", not "you may not advance it". §1's pattern, intact.
- **B18** — make `recordDecision` cross-check the caller's subject against the artifact type, and
  emit the criterion event from the artifact rather than from the word. Either reject a subject
  that does not match, or derive the domain and ignore the subject entirely; carrying both and
  trusting the caller's is what produces §21.3.

### 21.5 Criterion state has no event representation at all

Trying to quantify §21.3 — how many of the mission's 17 mandatory criteria are actually marked —
ran into a wall worth recording.

**There is no criterion event type.** The whole of `events.jsonl` contains `goal.created`,
`goal.escalated` and `goal.status_changed`, and nothing else goal- or criterion-shaped. No
`criterion.met`, no `criterion.unmet`, no `requirement.satisfied`. The 17 acceptance criteria that
define whether this mission has succeeded change state only inside a projection.

The closest proxies are the semantic events that feed the marking — `architecture.approved`,
`implementation.completed`, `release.candidate` — which is why §21.3 could be demonstrated at all:
`architecture.approved` stopped firing at 13:28:49 while ArchitectureDocuments kept being approved,
so the criterion cannot have advanced. That inference is sound, but it is an inference from a
proxy, not a reading of criterion state.

The live projection would settle it exactly. `GET /status` on the running mesh returns
`{"error":"missing credentials: provide Authorization: Bearer <token>"}`, and finding a way around
authentication on a running system is not something this watch should do. So §21.3's impact is
established in kind and not in count: **at least four ArchitectureDocument approvals produced no
criterion mark**; how many of the 17 criteria are consequently misreported is not determinable from
the log.

This compounds §19.14. That section found that the events which record *decisions* carry no turn
correlation. This is a step further: **the events which record whether the mission's goals have
been met do not exist.** An operator auditing "which criteria are satisfied, and on what evidence"
has no event trail to read — only a projection they must query live, on a mesh that may have been
reset, with a token they must hold.

For a system whose stated design is "state is event-sourced; every view is a projection", the
acceptance criteria are the one thing whose history is not recoverable from the log.

### 21.6 `task.completed` requires no evidence, and one of the two was emitted on a rotation boundary

Both tasks in this run are now COMPLETED. They are not comparable.

**backend's completion is real.** Its summary names the deliverable and the evidence:

> *"SLICE 1 task 1 is delivered and in review as CodePatch art-M3797H3F00f591ac796d (47 file
> bodies; `pnpm test` exit 0 with 4 test files / 30 tests passing and all eleven contract classes
> green; `pnpm lint` and `pnpm typecheck` exit 0)"*

A `patch.created` and `patch.ready` at 14:03 back it.

**frontend's does not.** Its summary opens *"Rotation turn"* and says, of its own plan:

> *"plan step s3 is satisfied and s4 (scaffold the panel UI shell) is next."*

The task was marked COMPLETED in the same event in which the seat recorded that the next step had
not started. Its output across the whole run is four `ResearchReport`s and **zero `CodePatch`** —
against a task whose own text reads:

> *"EVIDENCE: one CodePatch per file carrying metadata.path, plus the focused UI test run for the
> surfaces in the patch."*

So the task is complete by the board and incomplete by its own acceptance clause.

**Nothing checks.** `task.completed` carries `{taskId, agentId, summary}` — a free-text summary and
no evidence field, no artifact reference, no link to a patch. There is no `requiredArtifacts`
counterpart to `requiredCapabilities`, which the claim path does enforce (§19.18). A seat may
complete a task by saying so.

Two further observations:

- **The completion fired on a session rotation.** `session.rotation_pending` at 14:51:53,
  `continuity.recorded` and `task.completed` together at 14:52:36. Whether the rotation caused the
  completion or merely coincided with it is not determinable from the log, but the seat's own
  summary frames the entire turn as continuity bookkeeping.
- **The task's stated blocker was never lifted.** Its description reads *"Do not start before
  architecture.approved and the gate_normativity lift"* — and `architecture.approved` has not fired
  since 13:28:49 (§21.3). frontend cites a tech-lead message as lifting the hold, which may well be
  true in substance; what is certain is that the machine-readable signal it named as its
  precondition never occurred, and nothing consulted it either way.

**B19 — require evidence on `task.completed`.** The task already declares what would constitute it;
the completion event should have to reference an artifact satisfying that declaration, or say
explicitly that it is completing without one. As it stands the mission's progress record reads
2 of 2 tasks complete, 1 patch produced, and no mechanism has noticed the discrepancy.

**Update at 15:06 — the work landed, fourteen minutes after the completion.** frontend published
`patch.created` "R17 UI package — panel shell, catalog, preview, pre-install gate, and §5.5
assertions 1–6" at 15:06:52, having marked the task COMPLETED at 14:52:36.

This makes the completion **premature rather than false**, and the distinction matters. frontend
was not claiming credit for work it never intended to do; it emitted the completion during a
rotation turn, then carried on and delivered. §21.6's finding survives in a narrower and more
precise form:

**`task.completed` can be emitted before the work exists, and nothing detects the ordering.** The
board recorded a completed task for fourteen minutes during which the deliverable did not exist,
and would have recorded it indefinitely had frontend been evicted (it has been, twice) or timed out
(the last seat to hold a claimed task was, §20.3) in the interval. The event carries no evidence
field, so nothing distinguishes "complete" from "complete, pending the artifact" — which is what
this was.

B19 stands, with its rationale adjusted: the risk is not seats lying about completion, it is that
an event named `completed` is emitted at a moment the seat itself does not regard as completion,
and the board cannot tell the difference.

---

## 22. The outcome: 12.76M tokens, and `workspace/main` holds one README

Everything above measures how the mesh communicated. This section measures what it produced,
because that is the question the rest of the document does not answer.

### 22.1 The product directory

```
workspace/main/README.md                       <- one file
workspace/main/.git/…                          <- 82 git internals
git -C workspace/main log:  a307995 "mesh: initialize workspace"
```

**One commit — the scaffold — and nothing since.** Four hours and twenty minutes of mission time,
**12,761,426 tokens** on the agent ledgers, and the product tree contains a README.

The code exists, but only in per-seat worktrees:

```
  worktrees/backend      490 files      worktrees/frontend      45 files
  worktrees/qa           893 files      worktrees/ui-designer   12 files
  worktrees/architect     10 files      worktrees/ux-designer   12 files
```

**`patch.merged` events: 0.** One CodePatch reached APPROVED — backend's SLICE 1, with `pnpm test`
exit 0, 30 tests passing and all eleven contract classes green. It was never merged. The other
three sit in review:

```
  91ac796d  backend    APPROVED
  12d89fb7  frontend   READY_FOR_REVIEW
  7cf27d3d  frontend   READY_FOR_REVIEW
  c671cd89  frontend   UNDER_REVIEW
```

### 22.2 Where the 12.76M went

```
  mission started      11:17:27
  first task.created   13:09:51    <- 1h52m with no work item in existence
  first patch.created  14:03:05    <- 2h46m with no code
```

The majority of the run predates any implementation. The artifact inventory says what it was doing
instead:

```
  ResearchReport   READY_FOR_REVIEW  12
  ResearchReport   UNDER_REVIEW       2
  ResearchReport   APPROVED           2     <- 14 of 16 never settled
  ArchitectureDocument APPROVED       3  + 1 UNDER_REVIEW
  RequirementsDoc  APPROVED           1     (reached v4)
  ADR / DatabaseSchema APPROVED       1 each
  ApiSpec          REJECTED           1
  TestReport       READY_FOR_REVIEW   2
```

**Fourteen research reports nobody ever settled**, design documents at v4–v9, and a review loop with
no terminator — `policies.escalation.artifact_review_rounds.max: 10` did not bind on anything
observed.

Against that, the measured waste from the rest of this document:

```
  ~3,500,000 tokens (28%)   output the mesh could not parse and discarded silently   §19.11
        85+ min             generation destroyed by the 3-slot cap and two timeouts  §14.15, §20.3
       27.4 min             mission frozen across 5 halts, 2 of them a data race     §16.15, §19.20
          45x               budget over-grant to stop the interruptions              §20.1
```

### 22.3 Three structural causes, none of them the agents

The seats wrote well. backend delivered a real patch with real test evidence; tech-lead's rejections
were specific and correct; ui-designer caught a stale review and quantified it 5-of-7 by hand
(§16.7). §1's claim holds through to the end: **no failure in this run was a writing failure.**
What produced an empty product tree:

1. **Nothing merges.** Approval and merge are separate gates (`policies.transitions.patch.merge`
   requires `tech-lead.approve`) and only the first has ever fired. An APPROVED patch with green
   tests does not become a commit, so `main` stays empty no matter how many patches pass review.
2. **The design loop has no terminator.** Fourteen unsettled ResearchReports and reviewers who
   can issue verdicts faster than authors converge (§16.8's version churn, §21.3's criterion
   desync). Nothing forces a design artifact to a final state.
3. **Nothing is accountable for "is there a product."** There are no criterion events at all
   (§21.5) — the 17 acceptance criteria exist only in a projection, so no part of the system
   observes that `main` holds a README. §21.6's `task.completed` needs no evidence either, so the
   board reads 2 of 2 tasks complete.

**B20 — close the loop from APPROVED to merged**, and make the mission's own criteria observable in
the event log so that "the product tree is empty" is a state something can act on. Of everything in
§20, this is the one whose absence is visible without any instrumentation: four hours, 12.76M
tokens, one README.

---

## §23 — What was fixed, and what the fixes proved wrong

Everything in §17/§20 was implemented across seven waves. Final state: **1,896 tests, 0 failures**,
clean rebuild, lint 0 errors, `schemas already in sync`. What follows is only the part worth keeping:
where doing the work contradicted the analysis that motivated it.

### The two root causes of the empty product tree

Both confirmed, both fixed, and they are independent — fixing either alone still ships nothing.

**1. The merge ladder was invisible, not missing.** Every piece worked: the `merge` op, the
`patch.merge` gate, `mergeWorktree` doing a real `git merge` into `workspace/main`, `patch.merged` on
arrival. Nothing auto-advances `APPROVED → VERIFIED → MERGEABLE`, no watchdog mentioned it, and the
seat's context listed `merge` as one bare line item. So the ladder now surfaces in three places
(`wakeValue`, `stallWakeNote`, `stallDriver` via a new `mergeLadderPending()`) plus the per-turn
context, because the watchdog only fires on a *quiet* mission and this mission was busy for the whole
hour after the approval.

**2. skill-panel's own config and prompts had no path to done.** `roles/reviewer.md` never named
`VERIFIED`, `MERGEABLE`, or the ladder, and omitted two of the four authorities the seat holds. The
handoff now goes to `architect`, the sole `git.merge` holder, whose prompt said "Do not approve or
merge your own work" with no clause telling it to merge anyone else's. `patch.commit` is gone from
`policies.transitions`: as configured it required `tech-lead.approve` **scoped to an artifact that
only exists after a commit** — circular, and satisfiable only by accident.

### Five claims in §14–§22 that were wrong

Recorded because the pattern is the point: each was a rule I had modelled instead of read.

1. **"greenfield will trip the new criteria warning via `spec-understood` being mandatory by default."**
   Right conclusion, wrong mechanism, and the mechanism was the bug. The *resolver* defaults
   `mandatory: c.mandatory ?? true`; my check read `c.mandatory` truthily, so it was **silent on
   greenfield** — the one shipped mesh it was written to catch. Fixed, and pinned by a test.
2. **"The warning should fire whenever exactly one seat can accept."** It fired on every two-seat mesh
   in the suite, including four fixtures whose entire assertion is "validates clean". One criterion
   and one owner is *correct design*. The discriminator is the manual **load**, not the holder count.
3. **`spring-boot` was unsatisfiable too**, and I had not predicted it at all: it declares no criteria,
   so it inherits `DEFAULT_CRITERIA`, whose `requirements-documented` is mandatory and which **nothing
   in the runtime auto-evidences** — only `bench.ts` closes it. Any mesh that declares no criteria has
   this. Both examples now grant the token; `greenfield` also had a `patch.merge` gate with no
   `git.merge` holder, so it could not have landed code either.
4. **"`opMerge`'s transition-before-git is worth fixing but not required."** It was worse than noted.
   `mergeWorktree` *rejects* on a conflict and `executeOp` rethrows anything that is not a
   `KernelRejectedError`, so a conflicted merge escaped as a thrown turn rather than an op result;
   a successful one had its commit sha thrown away by a bare `void`. The non-git arm carries a long
   comment about why exactly this must fail loudly. The git arm, directly above it, did none of it.
5. **"A mesh-ordered interrupt is classified correctly."** Surfacing the salvaged usage exposed that
   `turn.discarded` classified it `"failed"` — the same word a crashed backend gets — because the
   reason was derived from the error *message*, and an interrupt's message mentions neither timeout
   nor silence. This is precisely the confusion `runtime-claude`'s own comment says it raises the
   error type to prevent. Now typed: `InterruptedTurnError` → `"silence"`.

### The replay question, settled empirically

Wave 5 adds rows to tables read *inside* the `review.approved` / `architecture.approved` reducer
cases, so the plan flagged that archived logs might project differently. They do — but only the ones
that were already broken:

| log generation | events | throws before → after | final projection |
|---|---|---|---|
| current (3 logs, incl. the watched run) | 4,538 | 0 → 0 | **identical** |
| Sept 15 archive | 12,619 | 8 → 12 | diverges (APPROVED 14 → 16) |
| Sept 18 archive | 7,672 | 15 → 16 | diverges (APPROVED 74 → 75) |

The divergent logs carry a retired `document` artifact type and **already threw at the same first
event (line 299) before the change** — the added rows only perturb state downstream of a divergence
that predates them. A log written by this code generation replays to the same state under this code
generation, which is the contract event sourcing actually owes.

### Still open

- A failed git merge leaves the CodePatch reading `MERGED`. The transition is on the log before the
  git call, the ladder is strict, and `MERGED` is terminal, so there is no legal move back. The op now
  refuses loudly and evidences nothing, and a test pins the residual status so a future fix must
  update that line rather than discover it.
- Interrupted-turn tokens are **surfaced, not billed**. `consume` on that path is a budget-ledger
  change with its own double-count risk against the success path, and is a separate decision from
  making the spend visible.
- The end-to-end drive on a scratch project was not run. Its three claims are covered by tests
  instead: the ladder and `patch.merged` (`transition-gate`, `mission`), the real `git merge` onto the
  product branch (`workspace.test.ts`, real git), and `opMerge`'s own git arm (`merge-git-arm`, via a
  workspace double — `makeMesh` bootstraps `inMemory: true` and the server only builds a
  `GitWorkspace` when it is not, so no test reaches that arm otherwise).
