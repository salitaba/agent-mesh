# Communication styles — review, and where "low contact" actually lives

Companion to `NOTES-communication-rewrite.md` (design) and `-TODO.md` (execution).
Scope: agent↔agent communication only. Agent↔human and prose style stay out of scope
by the design doc's §6.

Read as: §1 what exists, §2 verified defects, §3 the argument, §4 the proposal,
§5 order of work, §6 what needs Ali.

---

## 0. Correction to the record, first

`NOTES-communication-rewrite.md` designs six formats. The standing belief that **three**
never shipped is wrong. Verified against source this session:

| format | design § | status |
|---|---|---|
| mode table `service`/`collab`/`broadcast` | §2.1 | **SHIPPED** — uncommitted, `types.ts:313`, `INTERACTION_MODES` |
| `Commitment` as primary object | §2.2 | **NOT BUILT** |
| `Contract` | §2.3 | SHIPPED; `response` restored in 6.1, `answeredWith` at `contracts.ts:119` |
| `control`/`body`/`note` frame | §2.4 | **NOT BUILT** as a frame; `control` landed piecemeal |
| `ContinuityRecord` | §3.2 | SHIPPED (minus `openCommitments`, deliberately) |
| `ContextManifest` | §3.4 | SHIPPED |

So: **two** formats unbuilt, plus the *cost clause* of §2.1 — collab meters exchanges and
wall-clock but is not charged to a token budget line (`-TODO.md:474-479`).

---

## 1. What exists: four vocabularies for a two-bit decision

Communication is expressed through four independent surfaces:

1. `InteractionMode` — 3 values, runtime-owned on `control`, **determines** obligation
   (`types.ts:313-315`). Real semantics.
2. `MessageType` — 24 speech acts, agent-chosen (`types.ts:76-100`).
3. Delivery ops — ~15 (`send`, `broadcast`, `collab`, `respond`, `discharge`, `call`, …).
4. MCP tools — **43** (`mcp.ts:529-581`), of which ~13 are comms.

Plus 8 named contracts (`contracts.ts:135-305`).

The design doc already found that seven of the 24 types "have **zero semantics in any file
in the repo**". The live proof is `op-aliases.ts`: 56 name aliases and 31 type aliases,
existing solely because the vocabulary cannot be learned. `TYPE_ALIASES` collapses thirteen
different words for "here is your answer" — `RESULT, RESPONSE, REPLY, ANSWER, ACK, UPDATE,
STATUS, REPORT, NOTIFY, RESEARCH_REPORT, RESEARCH_RESULT, FINDINGS, reply` — onto `INFORM`.

That file is the system telling us the type vocabulary is noise it has to denoise.

Underneath all four surfaces the decision being expressed is two bits:

- **does this oblige someone?** (`service` yes, `collab`/`broadcast` no)
- **can it be answered?** (`broadcast` no, others yes)

Everything else is rendering.

---

## 2. Verified defects

Each was read in source this session. `[V]` = I verified it directly; `[R]` = reported by a
scoped explorer with file:line and consistent with what I read.

### D1 — An agent cannot close the collab it opened. `[V]` **Highest severity; in the WIP.**

`mesh_collab_close` requires `threadId` (`mcp.ts:537`). Three independent paths were checked
and none supplies it to the opener:

- `summarize()` (`mcp.ts:192-201`) returns `messageId`, `artifactId`, `artifactUri`,
  `taskId`, `escalationId` — never `threadId`. `executeOp` has it; MCP drops it.
- The reducer skips the sender's own mailbox (`projections-messaging.ts:130`,
  `if (target === m.from) continue;`), so the `(thread …)` line rendered in
  `## Unread mail` (`context.ts:720`) reaches every participant *except* the opener.
- `recentOwnActivity` renders `[ts] from → to TYPE payload` with **no thread id**
  (`context.ts:252`), and there is no `## Open threads` section anywhere in
  `renderContextInstructions` (verified against the full list of `lines.push("## …")`).

Consequence: every agent-opened collab runs to its box edge, is swept by
`sweepCollabOverruns`, and raises an operator card. **100% of them.** The tool's own
description — "close it with `mesh_collab_close` as soon as you have what you came for" and
"Closing early costs nothing; letting it run to its edge always raises a card" — is
unfollowable as shipped.

Note the feature is not wholly dead: a *non-opening participant* can close it
(`collab-sessions.test.ts:135`, "a non-opener may close"), because participants do get the
thread id in their mail. But the opener is the seat that knows when the discussion is done.

Fix is one line in `summarize()`, plus — better — an `## Open threads` context section, which
D7 also wants.

### D2 — Deadlines are inert in every default mesh. `[R]`

`writeDefaultMeshYaml` emits no `bus:` block → `resolveCommitmentTtl` returns `undefined`
(`config/src/index.ts:551-560`) → `computeDueBy` returns `undefined` → `overdueCommitments`
always returns `[]` → `sweepExpiredCommitments` is dead code on a default mesh.

This is the *correct* fix to the old unreachable-guard bug, and the decision behind it
("expiry is an operator's choice; a mesh must not inherit deadlines from an upgrade") is
sound. But note what it costs: the design doc called mandatory `dueBy` "**the highest-value
single change in the proposal**", and it now defaults to off.

The backstop that actually runs on a default mesh is: 3 nudges (`MAX_NUDGES`) →
`escalateStuckRequest` → **operator card**.

> The default failure mode of the async protocol is a human interrupt.

That is the precise opposite of low contact, and it is the single most important thing in
this document after D1.

### D3 — A refused send leaves no trace for anyone but its sender. `[R]`

`case "message.rejected": { break; }` (`projections-messaging.ts:402-404`) — the event is
emitted with `from`, `to`, `type`, `reason` and `ruleId` (`supervisor.ts:1368`), and then
projected nowhere.

**Correction to the first draft of this section.** I originally wrote that a refused send
leaves the sender believing it communicated, and ranked it second in the order of work. That
was wrong. `sendMessage`'s DENY branch returns `{ accepted: false, reason }`, and
`summarize()` copies it out as `error` — so the sender learns of the refusal synchronously,
in the same turn, in its own tool result. The sender is the one party that *is* told.

What is missing is everyone else. Unprojected, a refusal never reaches the run report, the
dashboard, or the operator. A policy quietly denying half the traffic is indistinguishable
from a mesh where nobody has anything to say. That is an observability defect rather than a
correctness one, and it drops from second place to a cheap add-on.

### D4 — `message.delivered` means "put in a prompt", not "read". `[R]`

Emitted before `callRuntimeWithTimeout` (`supervisor.ts:3812-3819`) and never reverted. A
turn that times out or crashes has permanently consumed its mail. Combined with the silent
oldest-first drop at `MAX_UNREAD_PER_AGENT = 200` (`state.ts:396`), there are two paths by
which mail vanishes with no event.

### D5 — Priority orders the queue and not the inbox. `[R]`

`unreadIds.slice(0, maxUnread)` (`context.ts:171-172`) takes the **oldest 12** in arrival
order. `PRIORITY_BY_MESSAGE` (`URGENT: 9 … LOW: 2`) decides when the turn *starts* and has
no effect on what the turn *sees*. An URGENT message queued behind twelve older ones is not
shown this turn, and the backlog drains at 100/turn.

The two halves of the priority system disagree with each other.

### D6 — `mesh_broadcast.type` is an unenumerated free string `[R]`

(`mcp.ts:535`) while `mesh_send.type` carries the full 24-value enum. Only the runtime's
`control.mode` stamp stops a `REQUEST_REVIEW`-typed broadcast conscripting the roster — which
it does correctly (`interaction-modes.test.ts:32`), so this is a belt-and-braces gap, not a
live hole.

### D7 — No tool can continue a thread except `mesh_send`. `[R]`

`mesh_request` silently drops `threadId` and `replyTo` (`mcp.ts:215`) — it can only open new
threads. With D1, an agent's ability to hold a conversation it started depends entirely on
remembering a `threadId` the system never told it.

### D8 — Collab has zero dashboard surface. `[R]`

No `collab` string anywhere under `apps/mesh-dashboard/src`. New events (`collab.opened`,
`collab.closed`), new advisory cards, new budget key `thread:<goal>/<threadId>` — nothing
renders any of it. Given D1, the operator will receive a steady drip of overrun cards with no
screen that explains them.

### D9 — RunReport records no conversation. `[R]`

`buildRunReport` never touches `state.messages`. It reports unanswered asks, thin answers and
collab overruns — all *exception* paths — and nothing about volume, traffic shape, or who
woke whom. You cannot answer "did this mission talk too much?" from the report, which is
exactly the low-contact question. `commitmentStats()` has some of it and is not in the report.

### D10 — Drift worth a broom `[R]`

`RESERVED_PAYLOAD_KEYS` omits `mode` (`types.ts:367`) though `mode` is the third runtime-owned
control field — likely cosmetic since `control` is what's read, but worth confirming there is
no payload fallback for `mode` as there is for `contract`. `contracts.ts:10` claims 49 name
aliases, actual 56. `contracts.test.ts:24` says "41 tool names", actual 43. `MeshMessage.ttl`
is declared, schema'd, and read by nothing.

### D11 — Obligation is defined three times, and the exported one is wrong. `[R]`

Found while narrowing the MCP type fields, and it is the §1 thesis in miniature — a fourth
vocabulary for a question that already had too many.

"Does this message put the recipient in debt?" is answered in three places:

1. `projections-messaging.ts:162` — the predicate that actually governs the ledger:
   `m.type.startsWith("REQUEST") || m.type === "ESCALATE" || m.type === "CHALLENGE"`.
2. `context.ts:82-99` — the same predicate again, term for term, in another package.
3. `catalog.ts:285` — `REQUEST_TYPES`, the *exported* answer, which **omits `CHALLENGE`**.

So the one definition a caller would naturally reach for is the one that is wrong. A
`CHALLENGE` sent through `mesh_request` returns ok and really does open a commitment in
`state.pendingRequests` — verified, not inferred — so constraining that field to
`REQUEST_TYPES` would make a debt-creating ask unrepresentable through the ask tool.

Two things make this worse than ordinary drift. `REQUEST_TYPES` has **zero runtime
consumers**: its only reference outside its own definition is a comment in `context.ts`
warning that it is not the answer. And that comment proves someone already hit this, wrote
down the hazard next to their own copy of the predicate, and moved on rather than fixing the
constant — which is how a codebase ends up with three of something.

**Fix:** export one obliging-types constant from `protocol` and have both predicate sites
consume it, then either correct `REQUEST_TYPES` or delete it. This is Move 1's smallest and
most defensible instance, and it can ship before the rest of Move 1.

### D12 — A successful turn eats the mail it never showed. `[R]`

Distinct from D4, and worse. D4 is temporal: `message.delivered` is emitted before the runtime
call, so a *failed* turn loses its mail. D12 is a window mismatch: delivery is marked against
the messages **queued** (up to `MAX_DELIVERED_PER_TURN` = 100) rather than the messages
**rendered**, at `supervisor.ts:3805-3831`, before `fitToSoftCap` rebuilds.

Two consequences:

- Anything past the rendered window is marked delivered and lost unseen. The `partial()`
  advice string — "still queued; they stay unread until a later turn shows them" — is false
  today for any backlog of 100 or fewer. The prompt tells the agent a reassuring thing that
  the code does not do.
- Any degraded rebuild (REDUCED / TIGHT / MINIMAL) meets an already-drained mailbox and
  renders **zero mail, silently**.

The second is the one to care about. Degradation fires when an agent is under load, which is
exactly when its backlog is deepest and its asks matter most; that is the moment the mesh
chooses to throw all of them away without a word. It also retires the usual defence of a small
window — "it will show up next turn" — because for that message there is no next turn.

This is why the inbox work had to *reserve* URGENT a seat rather than trust the window.

### D13 — Threads are opened and never resolved. `[R]`

`close_collab` (`supervisor.ts:4790-4801`) ends the `CollabSession` but leaves
`Thread.status === "OPEN"`. Nothing in core ever writes `RESOLVED`, so the open-thread pool
grows monotonically for the life of a mission and every reader pays for it in context forever.

Renderer-side screening on session status mitigates the symptom. The lifecycle gap is real:
`Thread.status` has a terminal value that no code path can produce.

### D14 — In production, unread mail does not survive a restart. `[R]`

The worst defect in this document, and the only one the test suite is structurally incapable
of seeing.

`exportState` emits 25 of `Projections`' 36 keys and `unread` is not one of them.
`importState` opens with `Object.assign(state, createInitialState())`, resetting the mailbox to
empty, and never writes `state.unread` again. Replay does not save it either: `kernel.ts:250`
reads the tail with `{ sinceSeq: snap.throughSeq }`, and `sinceSeq` is strictly exclusive
(`event-store/src/index.ts:97`). The snapshot is authoritative, not an optimisation, so the
`message.sent` that filled the mailbox sits below the cut and is never re-applied. The only
writer that ever adds to `unread` is that reducer. Nothing reconciles at boot.

**Why no test caught it.** `tests/helpers.ts` boots `inMemory: true`, which leaves
`snapshotProvider` undefined and falls through to a full replay from seq 0. Mail survives in
tests and dies in production. Every mailbox test in the suite runs on the path that cannot
exhibit the bug.

**The asymmetry is what makes it vicious.** `pendingRequests` *is* exported, and so is
`AgentRuntimeState.mailboxDepth`. After a restore the debt outlives the message: the debtor
reads `YOU OWE <from> an answer to <type>` and is nudged by the scheduler indefinitely for a
message body it can no longer read, while its prompt cheerfully reports `mailbox=1` over an
empty inbox. `recoveryCandidates()` selects re-wake targets partly on `unread.length > 0`, so
the wake is lost with the mail — the one agent that needed rousing is the one left asleep.

This is D4 and D12's failure mode promoted to the process level, and it invalidates the
reassurance both of those rest on. "It stays unread until a later turn shows it" assumes there
is a later turn; across a restart there is not, and the obligation ledger keeps billing for it.

A second key is lost the same way and deserves its own line: **`activeLeaseByArtifact`**. It
is not exported and not derived on import, and it *is* the single-writer invariant
(`projections-system.ts:10-18`). After a restore an unreleased lease is invisible, so a second
agent can take an artifact its true holder still owns, while the holder is told it has no
active lease. Unlike the mailbox this one is trivially rebuildable from the exported `leases`.

**The root cause is structural, not clerical.** No test ties `Projections`' key set to what a
snapshot carries, so a field added to state and forgotten in the codec passes the entire suite
in silence. `SnapshotEnvelope.data` (`persistence/src/index.ts:79-92`) should have been that
tie and instead is a stale 12-key copy the kernel casts past. The fix is therefore a parity
guard, not two added lines.

The detail that settles intent: this wave added a bounded counter recording *how much mail the
cap destroyed*, exported it, and pinned it with a test — beside a mailbox that was never
exported at all. Nobody decided the mail was expendable. Nobody was looking.

---

## 3. The argument

**The mesh is asynchronous in its transport and synchronous in its attention.**

Nothing blocks. There is no promise, no reply map, no awaited RPC anywhere — `wait` is a
turn-ender (`supervisor.ts:5024`), not a block. The transport is genuinely, carefully async,
and the design doc's §1 is right that the principles are already documented.

But inbound mail **wakes the recipient** (`scheduler/index.ts:209-238`), and a wake is a
turn, and a turn is a model call against a 9000-token instruction cap. So:

> Every message is an interrupt with a bill attached, and the sender pays none of it.

That asymmetry is the whole problem. Sending costs a sender nothing. Receiving costs the
recipient a full turn. Nothing in the system accounts for the second number, and `budgetHint`
— the one envelope field that gestures at it — is declared and never read.

"Low contact" in the Team Topologies sense the design doc invokes means **fewer
interactions**, not cheaper ones. The rewrite made interaction *typed*, *bounded* and
*declared*. It did not make it *priced* — except for collab, where it did exactly that, and
where the result is the best-behaved communication mode in the system.

That is the gap. Collab is a special case of the right idea, waiting to be generalized.

---

## 4. Proposal — price the wake, not the message

Five moves. 2 and 3 are the ones that do not exist anywhere in the design doc, and are where
I would put the effort.

### Move 1 — Collapse the agent-facing vocabulary to contracts

Make contracts the surface and demote `MessageType` to a rendering and telemetry detail. An
agent's comms manifest becomes seven tools:

```
mesh_contracts()                      what can I ask for
mesh_call(contract, request)          the ask
mesh_reply(messageId, response)       the answer
mesh_discharge(messageId, reason)     the refusal
mesh_announce(payload)                the broadcast
mesh_collab(with, topic) / _close     the bounded discussion
```

Zero type strings to memorize. This is §2.3's promise ("a seat's manifest is its own
published contracts plus one generic `mesh.call`") actually delivered — Stage 4 shipped the
contracts but removed nothing, which is why 4.4 measured **−96 tokens/turn** instead of the
hoped 3.9k. `typed-only` hides four tools from the manifest and leaves all 43 resolvable
(`contracts.test.ts:639`).

Be honest about the payoff: the token saving stays small. The real win is that
`op-aliases.ts` becomes unnecessary — an entire failure class retires, not just a line item.

### Move 2 — A delivery class on `control`, and the sender pays for interrupts

Stamp a runtime-owned `delivery` alongside `mode`, derived from mode + priority + whether the
recipient owes the sender anything:

| class | wakes? | default for |
|---|---|---|
| `interrupt` | immediately, own turn | URGENT, and asks against an obligation already owed |
| `deliver` | coalesced — next turn taken for any reason, or after a debounce | `service` asks |
| `accrue` | never wakes; rides the next turn's context | `broadcast`, collab chatter, FYI |

Then **charge the sender's budget line for an `interrupt`**, the way collab overrun raises a
card today. Low contact stops being an instruction in a prompt and becomes a price.

This is less new machinery than it looks. `broadcast` already *is* `accrue` — delivered to the
mailbox, wakes only declared interests (`scheduler:222-226`), excluded from nudge pressure
(`scheduler:720-722`). `cacheServed` already suppresses both delivery and wake. The axis
exists as two special cases; this promotes it.

### Move 3 — Make the inbox a digest, not a queue

`state.ts:435-448` rejects digesting on the grounds that "without a model you cannot compress
meaning, only join and truncate." That is correct about *compression* and wrong about
*structure*. Four things need no model at all:

- **Group by thread.** Twelve messages across three threads is three items, not twelve.
- **Collapse superseded messages.** Two INFORMs from one sender in one thread: render the
  latest, count the rest.
- **Order by obligation, then priority, then recency.** The runtime already knows both
  directions from `pendingRequests`. Mail that answers something you are waiting on, or
  discharges something you owe, outranks an announcement.
- **Let URGENT into the window.** This is D5, and it falls out of the previous point.

Meaning-preserving restructuring, zero model calls, and it directly attacks the "oldest 12"
starvation. `MAX_UNREAD = 12` stops being a guillotine and becomes a budget.

### Move 4 — Close the silent-loss paths (the "quality" pillar)

- Give `message.rejected` a projection so refusals reach the run report and the operator
  (D3). The sender already gets the reason back in its tool result; this is for everyone else.
- Emit `message.delivered` after a successful turn, or compensate it on failure (D4).
- Emit an event when the 200-message cap drops mail (D4).
- Return `threadId` from `summarize()` (D1).

### Move 5 — Report the conversation

A comms section in RunReport: messages sent, **wakes caused per agent**, interrupt count,
accrue/deliver/interrupt ratio, heaviest talker pairs, collab sessions opened vs closed
early. Without this none of the above can be shown to have worked, and `PRODUCT.md`'s
principle 5 is "Measure rather than assume."

### On the two unbuilt formats

- **`Commitment` inversion (§2.2)** — I agree with the withdrawal. Three of its four named
  benefits shipped piecemeal (refusal-as-settlement, one-debtor-per-commitment,
  refuse-at-cap). The fourth is mandatory `dueBy`, which is D2 — a config default, not a
  rewrite.
- **`control`/`body`/`note` frame (§2.4)** — mostly landed. The part still worth having is
  the `note` layer: prose that is *structurally* never parsed. Cheap to add while Move 1 is
  already touching the envelope.

**Recommendation: do not do the big rewrite.** Moves 2 and 3 are not in the design doc, cost
far less than either unbuilt format, and are where low contact actually lives.

---

## 5. Order of work

| # | work | size | why here | state |
|---|---|---|---|---|
| 1 | D1 `threadId` in `summarize()` | one line | a shipped-in-WIP feature is 100% broken | **done** |
| 2 | D3 refused-send projection | small | cheap; refusals are invisible to the operator | **done** — both halves |
| 3 | Move 3 inbox ordering + thread grouping | medium | best quality-per-line; no new concepts | **done** |
| 4 | D2 deadline default | **decision** | needs Ali (§6) | **done** — new meshes only, per Ali |
| 5 | Move 2 delivery classes | large | the real architecture change; own design round | **done** |
| 6 | Move 1 vocabulary collapse | large | largest agent-facing change; gate on Move 2 | **in flight** — ships as a new manifest mode, not a deletion |
| 7 | D8 collab dashboard, D9 comms report | medium | pointless before 1-3 land | D8 **done**; D9 **done** |

### What else landed in the same pass

Found while implementing the above, and fixed:

- **D12** — a turn marked mail delivered *before* calling the runtime, and marked
  the whole queued slice (up to `MAX_DELIVERED_PER_TURN`, 100) rather than the
  window it actually rendered (`MAX_UNREAD`, 12). A crashed turn ate mail it
  never showed anyone, and a deep backlog lost up to 88 messages a turn. The
  drain now runs after the adapter returns and iterates `bundle.unreadMail`:
  *delivered means rendered and answered; everything else stays owed.*
- **D14** — the snapshot codec never carried `unread`, so in production (where
  tests run `inMemory` and take the full-replay path) every mailbox came back
  empty after a restart. `unread` is now exported and restored, `mailboxDepth`
  is re-derived so old snapshots self-repair, `activeLeaseByArtifact` is derived
  on import, and a key-parity guard fails the build the next time a
  `Projections` key is added without a codec decision.
- **Advisory escalations no longer claim to pause the mission.** The collab
  watchdog and the recovery manager raise cards with `advisory: true` —
  precisely what keeps them out of the mission verdict — and the dashboard
  never read the flag, so an advisory card told the operator "the mission is
  paused until you respond" about a mission that was neither paused nor waiting
  on them. The blocking-only sentences now live in `escalation-tone.ts` and are
  withdrawn once, on the way out of `escPlain`, so a future advisory reason
  inherits honest wording instead of an unqualified pause claim.
- **`collab.opened` / `collab.closed` render as themselves** in the event feed
  instead of falling through to their raw type strings.
- `docs/runtime.md`'s `runTurn` sequence, which D12 put out of order.

Two narrower findings, both recorded rather than fixed:

- **Mailbox depth over-counts dangling ids.** `importState` re-derives
  `mailboxDepth` from the restored box and `supervisor.ts` reports `mailbox:`
  straight from `state.unread.get(id)?.length` — neither resolves the ids
  against `state.messages`. The snapshot can no longer *create* a dangling id,
  but any id dangling for another reason still inflates the number an agent is
  shown. A depth counting only resolvable ids closes it.
- **Snapshot overflow is silent.** `MAX_UNREAD_PER_AGENT` has
  `mailOverflowDropped` to make its loss countable; a snapshot that drops owed
  bodies has no counter. Adding one means a new `Projections` key, which the
  codec-parity guard will (correctly) fail until the codec carries it — so it is
  a coordinated change, not a drive-by.

**D11** (obligation defined in three places) and **D13** (`close_collab` never
writes `RESOLVED`, so no thread is ever resolved) are both in flight, alongside
Move 2 and D9.

The one residual risk from the D14 pass is closed: `exportState` caps `messages`
at `MAX_SNAPSHOT_MESSAGES` (2000), which used to mean a mailbox entry older than
the tail restored as an id with no body. `exportMessages` now partitions by what
is *owed* before it truncates, so owed mail outranks recency **inside** the same
2000 budget rather than being added on top — the cap still bounds snapshot size
by the constant, not by how many agents the mesh has.

One correction worth carrying forward: `selectUnread` now orders by
obligation-then-priority, so the rendered window is **not** the head of the
queue. The box still strictly shrinks every turn, so a backlog costs turns
rather than messages — but "mail drains oldest-first" is no longer true, and
anything written against that assumption is wrong.

### D9 as shipped, and one bug it turned up

`RunReport` gained a top-level `comms` key — deliberately not a field under
`unfinished`, because every fact in it is a property of the channel that leaves
no mark on the work: a run can close every task and still have destroyed twelve
messages. Five fields — `volume` (with the heaviest talking pair), `unread`
(delivered, never shown to anyone), `dropped` (destroyed by the mailbox cap,
which is the only thing distinguishing a flooded seat from a quiet one),
`refused` (grouped policy-first, because policy is the half an operator can
change), and `lostAsks`.

`lostAsks` is the one worth keeping in mind: it is the gap between
`pendingRequests` (open, visible, nudged) and `thinAnswers` (answered badly) —
asks taken off the ledger by `evicted_cap` / `deadlock_break` / `expired` /
`refused_cap`, where **the asker was never told**. Nothing anywhere else in the
report or the dashboard records that those were ever made. `refused` is excluded
on purpose: the debtor said no, and the asker heard an answer.

The text section renders only when there is a finding, so a mission that talked
a lot and lost nothing prints nothing at all. The numbers stay in the JSON either
way.

**The bug it turned up:** the run report rendered `unfinished.pendingRequests`
from `p.to`, the full address list, rather than `outstandingDebtors(p)`. On an
ask addressed to three seats where one had already replied, `LEFT UNFINISHED`
named all three as never having answered. `context.ts:457` and
`supervisor.ts:6227` both already asked it the right way; the report was the last
site that did not — and it is the same over-count the catalog's obligation note
describes, where nudges and stalemate detection pointed at agents who were never
individually asked. Fixed. Output is byte-identical whenever `outstanding` is
absent, and nothing else reads that field.

A second, quieter thing: the section originally hand-copied
`UNANSWERED_DISCHARGE_REASONS` rather than importing it, to respect
`run-report.ts`'s "no value imports" rule. But that rule's stated test is whether
an import drags AJV or the supervisor graph in behind it, and `state.ts` has
**zero** runtime imports — its only two are an `import type` and a type-position
`import(...)`, both fully erased. So the copy bought nothing and risked a silent
under-count in precisely the section that exists to report silent loss. It now
imports the real set, and the rule's comment records the measured test rather
than a blanket prohibition.

### How the remaining wave is partitioned

The six open items do not decompose along the lines the §5 table suggests. They
decompose along **file ownership**, and by that measure they overlap badly. Two
files carry four of the six items each:

- `packages/core/src/supervisor.ts` — D13, `message.rejected`, Move 2, Move 1.
  The hotspot is `sendMessage` (~`:1332-1500`), which Move 2 and the
  `message.rejected` emit sites both sit inside, and which mints the thread D13
  is about. Second hotspot: the `executeOp` cases for `collab` / `close_collab`
  (~`:4778-4842`), which D13, Move 2 and Move 1 all land on.
- `packages/core/src/projections-messaging.ts` — D13, D11, `message.rejected`,
  Move 2. The hotspot is `case "message.sent"` (~`:101-230`): D11 and Move 2
  both rewrite the obligation predicate at `:160-162`.

`packages/protocol/src/types.ts` and `packages/core/src/context.ts` each carry
three; `apps/mesh-server/src/mcp.ts` is effectively owned outright by Move 1.
Only two files in the whole set have a single owner: `run-report.ts` (D9) and
`packages/scheduler/src/index.ts` (Move 2).

So the wave runs as **three exclusive partitions plus one deferral**, cut by file
rather than by item:

1. **Core projection layer** — D11 + the `message.rejected` op/activation half +
   D13. All three live in `projections-messaging.ts` / `context.ts` / `state.ts`,
   so they cannot be parallelised against each other and are better done together
   than raced. D13 ships as an extension of the existing `collab.closed` reducer
   rather than a new `thread.resolved` event, precisely to keep it out of
   `types.ts` and the catalog's event-severity pairing.
2. **Move 2** — `types.ts`, `schemas.ts`, `supervisor.ts`, `scheduler`,
   `budgets.ts`, `config`. It deliberately does *not* touch
   `projections-messaging.ts`: every delivery class still delivers, so the
   mailbox write is unchanged and only the wake and the nudge sweep move.
3. **D9 / Move 5** — `run-report.ts` alone, genuinely independent of both.
4. **Move 1 went last**, and not for the reason the table gives. The stated
   gate was design ("gate on Move 2"); the real gate was that Move 1 needs
   `types.ts`, `schemas.ts`, `config/index.ts` and `supervisor.ts`, all four of
   which Move 2 held. It started the moment Move 2 released them.

   The ordering paid for itself in an unplanned way: Move 2 had to derive a
   delivery class from the same rule the obligation ledger uses, and, not
   owning the catalogue, wrote a *fourth* copy of the obligation predicate at
   `supervisor.ts:201` with a comment saying collapsing it was Move 1's job.
   Move 1 owns both files, so that copy folded into the D11 collapse instead of
   surviving as the thing D11 was about.

Two things worth keeping from the mapping, independent of the wave:

- **`REQUEST_TYPES` has zero runtime consumers, but is publicly re-exported.**
  Every reference in the repo is a comment or a test asserting it is wrong. It is
  dead as code and live as API, which is the combination that makes deletion a
  breaking change and leaving it a trap.
- **`MeshMessage.budgetHint` is declared, schema'd, populated, and read nowhere.**
  (The identically-named field on delegate/create_task *is* read.) Someone already
  reached for a way to price a send and stopped — which is the same thesis Move 2
  is built on, left half-finished in the tree. Move 2 did **not** adopt it, and the
  reason is now recorded rather than implied: it rides inside `input`, is
  agent-written, and is not a reserved key, so a sender could price its own
  interrupt at zero. Pricing had to come from a runtime-stamped field.

### D11, D13 and the second half of D3, as shipped

All three lived in the same three files, so they shipped as one change rather than three.

**D11 — obligation now has one home.** `packages/protocol/src/catalog.ts` gained
`isObligingType`, `OBLIGING_MESSAGE_TYPES` and `obligesRecipients`, and the two hand-written
copies in `context.ts` and `projections-messaging.ts` were replaced by imports of it. The
catalogue is a const table that imports nothing but types, so nothing new is dragged in
behind it; `ObligationEnvelope` is declared structurally for the same reason, so no value
import entered the file. `obligesRecipients` checks the interaction mode **first** — a
`service` exchange obliges nobody regardless of type — and only then the type.

`REQUEST_TYPES` was corrected rather than deleted: it is publicly re-exported from
`packages/protocol/src/index.ts`, so deleting it is an API break on a separate clock. It is
now `@deprecated` and derived (`[...OBLIGING_MESSAGE_TYPES]`, a copy rather than an alias, so
a caller mutating it cannot corrupt the source), which is what made it correct — it had
omitted `CHALLENGE`, which is the whole of D11.

**D13 — threads now close.** `case "collab.closed"` in `projections-messaging.ts` walks the
thread to `RESOLVED` or, on overrun, `ESCALATED`. Overrun writes `ESCALATED` deliberately:
the sweep is already holding an operator card at that moment, and a projection that said
`RESOLVED` would be disagreeing with it.

The `openThreads` filter in `context.ts` — which reads the collab session's status rather
than the thread's — was **kept**, and now has a reason written against it instead of being
redundant belt-and-braces. A snapshot taken before this change restores threads `OPEN` and
sessions `CLOSED`, and tail replay starts strictly above `throughSeq`, so the `collab.closed`
that would repair the thread is never re-applied. The filter is what stops those meshes
carrying phantom open threads forever.

**D3's other half.** `message.rejected` is an overloaded event: `Supervisor.denied` routes op
and activation denials through it alongside send refusals. The send half was already
projected; the op/activation half was projected nowhere, reachable only by folding the raw
event log. It now lands in `Projections.deniedActions`, a ring of **its own** with its own
cap. Two rings rather than one because the blast radii differ — one misconfigured op rule can
deny on every tick, and a shared ring would let that storm evict every record of a message
that never left the building. Keyed on `action` rather than on the `denied: true` flag the
supervisor also stamps, because `action` is the field the record cannot be written without.

### Move 1 as shipped — and why `op-aliases.ts` is still here

It ships as `bus.vocabulary: "contracts"`, a new config key rather than a third
`bus.transport` value: transport governs whether prose ops are parsed, vocabulary governs what
the manifest advertises, and folding them together would have conflated two independent
decisions. Resolved **absent** unless opted in, default only in `writeDefaultMeshYaml` — the
same shape as `commitmentTtl` and `bus.delivery.classes`, now used three times and worth
treating as the house pattern.

Under it the manifest hides `mesh_send`, `mesh_broadcast` and `mesh_respond` alongside the four
already superseded, and adds `mesh_reply` and `mesh_announce`. **Advertisement-only**: every
hidden tool still resolves, so nothing an existing seat knows how to call stops working.

Two calls worth recording. `mesh_announce` takes an optional `to` — the seven-tool sketch had
no way to tell *one* seat something unprompted, and keeping `mesh_send` advertised would have
reintroduced the 24-value enum and defeated the move; one tool spans two ops because it is one
act, saying something that puts nobody on the ledger. And `mesh_reply` hard-codes `INFORM`,
because discharge is decided by `replyTo`, not by the type.

**The honest payoff is still not tokens.** It is that `op-aliases.ts` becomes unnecessary for a
seat on the collapsed manifest — and *unnecessary is not deletable*, which is the part worth
writing down. Three things must be true first, and the full argument now lives at
`packages/protocol/src/op-aliases.ts:5-53`:

1. **Every mesh in the wild runs `vocabulary: "contracts"`.** Only `mesh init` writes it; an
   existing `mesh.yaml` keeps the full typed manifest by design. Deleting the tables before
   then changes the behaviour of meshes that never opted into anything.
2. **The prose channel is gone, or every mesh is `transport: "typed-only"`.** The tables
   translate `mesh-json` blocks, which the manifest never touches. A `mixed` mesh still parses
   prose, and a model writing prose writes `mesh_send` because the *role prompt* taught it that
   name. **Hiding a tool does not unteach it.**
3. **`aliasStats()` reports zero across a real run.** Those counters were added in Stage 4.5
   for exactly this decision. Retiring a safety net on a design argument rather than a
   measurement is how the vocabulary got this large in the first place.

(1) and (2) are independent — a mesh can collapse its vocabulary and still accept prose — so
the ordering is "measure, flip the flag everywhere, then delete", not "delete".

Which left one honest gap, now closed. The prose ops-block contract enumerated all 24
`MESSAGE_TYPES` unconditionally and told every seat to emit a `mesh-json` block. Under
`transport: "typed-only"` the supervisor parses that block and then refuses every op in it
(`supervisor.ts`, the `typedOnlyRefusal` branch) — so the most emphatic section of the prompt
was teaching a turn that cannot land, and the seat paid a full turn to discover it. Both are
now gated on a `typedOpsOnly` flag on the context bundle, derived from `bus.transport`: the
same **never advertise a rule that cannot fire** discipline as `delegationEnabled` and
`criterionAcceptanceEnabled`, one channel over.

The enum is *gated* rather than deleted because its original argument is about **prose
specifically**. That channel has no schema at its edge: an invented type builds a plausible
message that travels, fails validation elsewhere and is dropped silently — 23 of 30 messages in
one live run. Every type-taking tool carries `enum: [...MESSAGE_TYPES]` (`mcp.ts`), so a typed
seat is already holding the same closed set and a wrong value comes back refused *at the call*,
with the field named. Repeating it there is ~40 tokens every turn for something the seat
already had.

What is deliberately **not** gated is the ops catalogue. The fenced-block syntax is
prose-specific; the list of moves is the only place a seat learns a move exists, and that is
true on either channel — gating the whole section would re-run the 18-undocumented-ops failure
at the top of this document. Nor is the typed branch allowed to say "prefix the op names": the
tools are not `mesh_` plus the op (`close_collab` is `mesh_collab_close`, answering a request is
`mesh_reply`), so a seat told to prefix would invent tools that do not exist — the prose failure
mode moved rather than removed. The manifest stays authoritative for names.

That closes precondition (2) for the **contract**, not for the meshes: a `mixed` mesh still
parses prose and still gets the full block, which is the whole point of the gate. Precondition
(3), meanwhile, turns out to be unobservable as written — `aliasStats()` has no production
caller anywhere in the tree, so "reports zero across a real run" cannot currently be measured by
anyone. **Wiring those counters to something that reports is the next piece of work if the alias
tables are ever to go.**

### Move 2 as shipped, and the two refinements the tests forced

`control.delivery` is `interrupt | deliver | accrue`, derived by the supervisor and stamped
before validation so the closed property set covers it; `delivery` joined
`RESERVED_PAYLOAD_KEYS`, so a seat cannot class its own message. Config-gated the D2 way:
absent `bus.delivery.classes` means no regime and today's wake path byte for byte, and the
default exists only in `writeDefaultMeshYaml`.

**Class and mode stay orthogonal, with mode in front.** `mode` answers what the exchange
obliges and therefore who is a candidate for a wake at all; `delivery` answers whether being a
candidate is worth a turn right now. They could have been collapsed — `broadcast` already
behaves like `accrue` — and were not, because a broadcast's narrowing to declared `interests:`
is an operator's decision written in config, and a class derived from an envelope must never
overrule it. The deriver returns `undefined` for broadcasts and they keep their own gate.

**Pricing.** `interrupt_cost_tokens` (default 2000) is charged through the existing budget
ledger as an ordinary `budget.consumed` entry — no new ledger, no new projection key. Per
recipient woken, because a flat per-message price would make the wide blast the cheap one. On
the **sender's agent line only**: the mission line is the record of what the mission actually
spent, and a tariff there would make that number a fiction. The human seat is never charged.
`interrupt_cost_tokens: 0` gives routing without billing.

`budgetHint` — the one envelope field that already gestured at the cost of a send — was
deliberately **not** used. It arrives inside `input`, is agent-written, and is not a reserved
key, so a sender could price its own interrupt at zero. That closes the standalone finding
from the partition notes: the field stays declared and read by nothing on the message
envelope, and now there is a recorded reason rather than an oversight.

Two things the tests forced, both worth remembering because both inverted the move's own goal:

1. **The chase rule had to be thread-scoped.** The first version classed any obliging message
   as `interrupt` when the recipient already owed the sender *anything*. A burst test caught
   it: three unrelated questions to one busy colleague classed one `deliver` and two
   `interrupt`. In a mesh where seats habitually owe each other work, that makes the expensive
   class the default and inverts exactly the pricing this move exists to fix. A chase must now
   be in the thread of the debt it chases; a different question is a new ask.
2. **A seat with an open gathering window is skipped by the wait-sweep entirely.** Filtering
   the unread list was not enough — an obliging message also opens a `pendingRequest`, and the
   pending half of the sweep is deliberately untouched, so the seat was correctly not woken by
   the message and then woken one tick later to chase the very ask it was holding. `deliver`
   bought nothing whenever the nudge cadence was shorter than the window, which is 60s against
   60s in the shipped defaults.

One deliberate departure from Move 2's table above: **collab chatter is `deliver`, not
`accrue`.** An accrued collab is a discussion nobody is ever woken to continue, so every
session would run to its box edge and raise an overrun card — D1's failure reached by another
route.

### A restored mailbox could point at mail the snapshot had dropped

Found while negative-controlling the guard above. `importState` screened mailbox ids by
*type* — the comment against it even names the failure ("an id that is not a string resolves
to no message, so it would sit in the box inflating the depth") — but never checked the id
against `messages`. And the codec itself manufactures that case: `exportMessages` caps the
history at `MAX_SNAPSHOT_MESSAGES` and partitions owed-first, but `keptOwed` is itself a
`slice(-cap)`, so with enough seats at `MAX_UNREAD_PER_AGENT` the owed mail alone overruns the
budget and some is dropped with its ids still in the box.

The cost is not the lost message — that is already gone — it is that `mailboxDepth` then lies,
and the scheduler wakes on box length. A box of nothing but danglers buys a turn that renders
zero messages: the exact "wake nobody needed" this whole wave is about, arriving through the
restore path.

Now screened against `messages`, and the drop is **counted** into `mailOverflowDropped` rather
than absorbed, because this is the same event that counter already exists for: mail ceased to
exist and nobody was told. That made the snapshot's own `mailOverflowDropped` loader additive
— it runs after the unread screen, and assigning would have erased what the screen just
counted.

One existing test failed on this and was right to: `tests/core/messaging-silent-loss.test.ts`
stuffed a box with 212 ids that had never been messages, so the screen counted all 212. The
fixture was the unrealistic part, not the screen; it now puts real messages behind the ids.

### The parity guard was weaker than it read

Adding `deniedActions` to the snapshot codec turned up a bug in the test that exists to catch
exactly that class of bug. `tests/core/snapshot-codec-parity.test.ts` ended with a guard over
"the keys whose loss has been paid for at least once" — and it read

```ts
const exported = Object.keys(exportState(createInitialState()));
```

an **empty** state, checked for key *presence*. So `unread: []` hard-wired into `exportState`
passes it. That is D14 itself — the bug the file was written for — arriving by the one route
the guard against it could not see, and it is worse than an omission because the snapshot
still looks well-formed and the mesh still boots.

The guard now builds a state where all eight tracked keys hold something, filled through
`applyEvent` rather than by reaching into the state (a hand-built fixture proves the codec can
carry *a* shape; only the reducers prove it carries the shape the mesh produces), asserts
each is non-empty as an explicit precondition — without it, a reducer that quietly stopped
populating a key would turn the test green by emptying both sides — and then asserts the
counts survive the round trip. Counts rather than deep equality because the eight keys are
Maps, arrays and one counter map, and "arrived empty" is what a count states exactly.

Negative-controlled by emptying each of the eight in turn in the compiled codec: all eight go
red. Under the old guard, **none** of the eight did.


---

## 6. Needs Ali

Three handbacks are already open and unratified in `-TODO.md` — 1.4's durability
scale-down, Stage 5's withdrawal, and the two unbuilt formats marked withdrawn-by-inference
rather than by decision. This review adds a fourth:

**What should a default mesh do with an unanswered ask?** ~~Today: no deadline, 3 nudges,
then a human card (D2).~~ **Answered — (b).** `bus.commitments.ttl_ms: 1800000` ships in
`writeDefaultMeshYaml` only, so new meshes get a 30-minute default and existing ones stay
exactly as they were. The same pattern was then reused for Move 2's `bus.delivery.classes`
and is the shape any future default of this kind should take: the resolved config field stays
*absent* rather than zeroed when the operator has not opted in, which keeps the supervisor's
presence test reachable instead of silently always-true.
