# Communication review, measured — quality, async, low contact

Status: REVIEW + PROPOSAL. No code written, nothing staged. Decisions needed are §8.
Supersedes the framing of `NOTES-communication-styles-review.md` (which argued from the
mail path); builds on `NOTES-communication-rewrite.md` (design) and
`NOTES-communication-rewrite-TODO.md` (ledger, stages 0-6 shipped).

Requested: *"review the communication styles and I want best quality communication and async
and low contact styles / think out of the box and if need we can rewrite the communication
format and architect"*

---

## 1. The finding, first

I measured one real mission — `examples/line-follower-sim`, 200 traced turns, 4,353,277 fresh
input tokens, 149,117 output tokens. Three facts, in order of how much they matter:

**1a. 7 turns out of 200 spent 77.5% of the mission's input tokens.**
Top 10 turns = 77.5% of all fresh input. Top 3 = 36.6%. The other 185 turns (92.5% of turns),
together, account for **20.6%**.

```
  agent      fresh_in   out  block  cause
  tech-lead    691420    99   2286  recovery     <- read 691k tokens, wrote 99
  tech-lead    490299   816   2286  message
  architect    413081   262   2286  message
  architect    368369    99   2286  recovery
  developer    362240   259   2286  timer
  pm           349624   803   2286  message
  pm           339019  2656   2286  message
  developer    312940   107   2286  message
```

**1b. The mesh reads 29 tokens for every one it writes** (4,353,277 : 149,117). Its stated
purpose is communication; its measured behaviour is re-reading its own context.

**1c. The mechanism is a cold prompt cache, and the mission's own asynchrony causes it.**
Fresh (`input_tokens`, i.e. *uncached*) input is flat at a median of **5,655** tokens per turn
regardless of conversation length — so caching *does* work normally. But it collapses after a
long gap between a seat's turns:

| gap since that seat last finished | n | median fresh input | max |
|---|---|---|---|
| <2 min | 160 | 5,655 | 691,420 |
| 2-5 min | 17 | 5,787 | 7,053 |
| 5-10 min | 5 | 5,827 | 21,418 |
| **10-30 min** | 6 | **23,615** | 413,081 |
| **>30 min** | 6 | **5,423** (bimodal) | 490,299 |

The transcript is served from cache while a seat is busy and is **re-billed in full** once the
cache has expired — and the mesh expires it on purpose. Coalescing windows (`coalesce_ms` 60s),
timer sweeps (`waitWakeupMs` 60s), `WAITING` states, `accrue` mail, and human-paced missions all
widen the gap between a seat's turns. **Async is a cache-hostile design, and nobody has priced
it.** The 7 whales are what that price looks like.

### 1d. What this does to the previous two rounds of work

Every comms-cost lever shipped so far acts on the 20.6%, not the 77.5%:

- the per-turn briefing block is **10.5%** of mission input (456,029 of 4,353,277 tokens);
- its `Unread mail` section is **2.2%** of the block — measured at 179 chars of a 7,980-char
  prompt on the mission's own turns.

Pricing interrupts, coalescing bursts, collapsing superseded restatements, capping the unread
window at 12, budgeting payload lines to 400 chars — all real improvements to *contact quality*,
all aimed at a cost centre worth a fifth of the bill. The tariff changed how often a seat is
woken; nothing touched what a wake costs when it lands on a cold cache.

### 1e. Why nobody saw it

`turn-tracker.ts` `TurnRecord` records `tokensInput`, `tokensOutput`, `tokens` — and **not
`cacheRead`**, even though `AgentOutput.tokensUsed.cacheRead` exists in the adapter and
`transcriptSize()` is built on it. A cold re-read and a genuinely huge fresh prompt are
indistinguishable in the trace; the whales are invisible by construction. `transcriptSize()` is
computed live for the rotation decision and then thrown away.

**Caveat, stated plainly: this is one mission, n=1**, and it contains 18 `agent.restarted` and 6
`agent.replaced` events — restarts discard the session, so some whales are restart-driven rather
than idle-driven. The concentration is stark enough to be worth acting on, but §8.1 is
"reproduce this on a second mission" before anything large is built on it.

---

## 2. What is already right (do not rebuild these)

The async bones are genuinely good, and the review should say so before proposing changes:

- **Messages are not RPC.** `REQUEST*` opens a pending request, `replyTo` closes it, the asker
  goes to `WAITING` and is woken on the answer. Correct and unusual.
- **A thread has an ending**, read off *why* the last ask left the ledger, with four "gone, not
  answered" reasons that keep a false `RESOLVED` out of the record. This is the strongest piece
  of design in the comms layer.
- **One ask to N agents is N obligations** (`outstanding` per debtor), so a plural ask is not a
  diffuse one. The asymmetric case — an operator answering for a silent agent settles for
  everyone — is deliberate and documented.
- **Prose vs authority** is enforced, not just stated: `control` is runtime-owned, stripped by
  `sanitizeAgentMessageInput`, closed in the schema. The `cacheServed`-in-payload stall is
  recorded as the bug that bought the rule.
- **Contracts fail closed and teach** — unknown name refused with every alternative listed,
  request validated *before any recipient is woken*, refusals closed and rendered on the ask's
  own line, provider routing to exactly one seat.
- **Attention is priced** — `interrupt` charges the sender, `deliver` coalesces, `accrue` never
  wakes, and when the sender cannot afford it the message still ships and only the wake is
  refused. "Nothing is ever suppressed; only the wake is refused" is the right invariant.
- Three free pure-state gates already run before any cost: broadcast interest, delivery class,
  `isRedundantObservation`.

---

## 3. Quality — what "best quality communication" is still missing

**3a. An ask can open a debt with no contract at all.** The decider never looks at the contract
(`catalog.ts:371-374`):

```ts
export function obligesRecipients(m: ObligationEnvelope): boolean {
  if ((m.control?.mode ?? "service") !== "service") return false;
  return isObligingType(m.type);
}
```

`isObligingType` = `type.startsWith("REQUEST") || ESCALATE || CHALLENGE` — and nothing else. A
bare `send` with `type: "REQUEST_REVIEW"` opens a real `pendingRequests` entry with `contract:
undefined`: no request schema, no refusal set, no SLA, and `checkResponse` returns `undefined` so
the fail-open answer check silently does nothing. So the 8 named contracts — the best
communication idea in the repo — are **optional**, and the path that skips them fails open.
`decision.escalate` has `refusals: []` by design; the other 7 obliging types have nothing by
accident.

**3b. Answers need no evidence.** A discharge can be prose and nothing else. The one place this
discipline already exists is `ContinuityRecord`'s `Belief.basis`, which *requires a citation*.
That instinct — a claim carries its evidence — is not generalised to the thing the mesh exists
for, which is answering questions.

**3c. The reference bus is documented but unenforced.** *(Fixed — `dc5e38d`, refined later.)*
`docs/protocol.md:196` once said "Messages reference URIs, never paste content — the bus is a
reference bus", as though something enforced it. Nothing does, and now the doc says so: the
passage at `docs/protocol.md:232-243` calls reference-not-paste **"a discipline, not a runtime
rule"**, names `payload` as unconstrained in the schema, and states outright that the rule is
carried by the role prompts, which `docs/architecture.md` classes as layer 1 (prompt awareness).
The two bounds it now names are exact — `note` and `requires[].text`, 2000 characters each (an
earlier draft said `note` was the only one, which was false) — plus the render-time bound that is
the *real* answer to "so what happens when someone does paste?": `renderMailPayload` prints at
most 20 lines of 400 characters and marks the rest omitted. So the payload still rides in full and
still costs a reader nothing beyond one screen. Measured, this was never a cost issue (payloads
average 273 chars ≈ 68 tokens, 3.6% of log bytes); it was the doc promising a rule the runtime does
not have, and the fix was to the doc because **enforcing** it is the design change, not the bug
fix — see §7 row 1.

**3d. `mode` was missing from the documented obligation rule.** *(Fixed — `dc5e38d`.)* The doc at
`docs/protocol.md:77` once said `REQUEST*`/`ESCALATE`/`CHALLENGE` open a pending request, full
stop. The code has always had an unstated second condition — `control.mode === "service"` — so the
*same* REQUEST type obliges nobody under `broadcast` or `collab`. The code was right and the doc
was wrong, in the one place a reader goes to learn what an ask is. It now states both conditions
as two numbered ones and names `obligesRecipients` as the single predicate, with the reason
`broadcast` is excluded (an announcement is not an ask: one entry owed by the whole roster, and
the first reply leaves everyone else owing an answer nobody was tracking).

---

## 4. Async — what is missing

**4a. The recipient owns no wake policy.** Rationing is entirely the sender's: `attention_tokens`
is the sender's wallet, the tariff is charged to the sender, and `interests:` gates only
*broadcasts*. A seat that wants to batch its mail cannot say so. Contrast `accrue`, which already
does exactly this globally — the machinery exists, it is just not per-recipient.

**4b. There is no pull path.** No inbox tool; `mailbox` appeared only as a
read-only status field. 46 MCP tools and not one read mail. An agent that is not woken never
sees its mail — which is a defensible design, but it means the *only* way to learn anything is to
be interrupted, and there is no way for a seat to say "I am heads-down; show me the queue when I
surface". (Both counts are as found; §10 makes it 47 and one.)

**Fixed — but not by a pull path, and the distinction is the whole point (see §10).** A 47th
tool, `mesh_inbox`, shows a seat its own queue. It is a *view*, not a pull: it never emits
`message.delivered`, so the wake path is untouched and a seat that is **not** woken still learns
nothing from it. What it fixes is the narrower defect 4c describes — a woken seat was handed the
top 12 and told nothing about the rest — rather than the one this paragraph describes.

**Then the pull path itself shipped, in the only form that is safe (see §10).** `mesh_inbox` is
the *fetch*; `agents.<id>.wake.mail: "claims"` is the *push*, and it makes a turn render a
one-line claim per message instead of the body — for mail that owes the reader nothing. Mail
that obliges the reader keeps its body in both modes, which is the correction that makes this
safe to build at all: `message.delivered` marks a message answered when the turn ends, so a
recipient handed a bare claim and then marked answered would have been made to answer blind.
Deferred is the *reading of news*, never a question. It is off by default and measured at ~0.2%
of mission input (§1d), so it is a contact-quality lever rather than a cost one.

**4c. A burst loses its own shape.** `Scheduler.gather()` records `count` and **never uses it**.
A burst of 40 messages costs the same wake as a burst of 2, and the woken seat is told nothing
about how much arrived — it sees `selectUnread`'s top 12 with no indication that 28 more are
queued. The single cheapest quality win available: surface the count. **Fixed in two places**
(§10): the gathered wake now carries its count and the queued-mail note names the mailbox depth
(M3), and `mesh_inbox` lets the seat page past the twelve.

**4d. Triage is off by default.** `triageMode` defaults to `"off"` (`config:989`), so
`triage()` returns `ACT` before it reaches either the model or the heuristic. `IGNORE` is a bare
`continue` — the agent is never told an event was dropped, only a counter moves.

> **Correction — this one is not a defect, and the section shrank twice on inspection.** I wrote
> that "the enum has no `model` member, so `TriageModel` is unreachable by configuration". True,
> but it implies a broken switch that is really an *unshipped seam*: `TriageModel` is injected as
> a server option (`apps/mesh-server/src/index.ts:81`, passed to `Scheduler` at `:485`), nothing
> in the repo supplies one, and `triage()` already handles its absence honestly by falling
> through to the heuristic. So the config enum is right to refuse a `"model"` member — adding one
> would advertise a mode the repo cannot provide, which is the very failure this review keeps
> flagging. And the enum *is* enforced (`schemas/mesh.schema.json:596-602`), so my second worry —
> that a typo like `mode: of` would silently *enable* triage — does not hold either; AJV rejects
> it at load.
>
> The remaining half stands but is not obviously wrong: an event dropped by triage tells the
> agent nothing. Telling it would cost exactly the wake triage exists to save, so a silent drop
> with a visible count (`triagedAway`, which the dashboard reads) looks like the intended
> trade-off rather than a gap. Left alone deliberately.

**4e. Dead code in the wake path.** `notifyMailDelivered` has no caller (deleted — §10).
`idleQuietPeriodMs` was resolved and never read (documented as inert) — **now implemented**
(§10): it is the dwell before the scheduler declares an idle moment, which is what makes the
declaration mean "this mesh has been quiet", not "this instant happened to be empty". `MeshMessage.ttl` is
declared and read by nothing (§10). `deny.contact` and `when.to` were documented policy-rule fields
that `matchRule` never read — a config using them validated and silently did nothing; both are
fixed in §10. `matchRule`'s `authority` parameter was declared, passed and never compared; the
parameter is gone (§10), with the one denial it still performs documented in place.

---

## 5. Low contact — the setting exists; the bill does not

The knob is already stated exactly, and the comment is the best short statement of the design in
the repo (`config/src/index.ts:296-301`): *"Nothing is ever suppressed; only the wake is refused
… `0` is a real and useful answer: it is a mesh that never buys an interrupt, where every one
degrades to mail. That is the low-contact setting, stated exactly."*

What is missing is the *other side of the ledger*. The mesh counts wakes
(`CommsCounters.wakesByKind`, `downgradedInterrupts`) but never prices them, so an operator
cannot answer "what did contact cost me?" — and §1 shows why that matters: the cost is
concentrated, so it is invisible in any average.

---

## 6. Proposal

Ordered by measured leverage, not by tidiness.

### M1 — Make a cold turn bounded (addresses 77.5%)

If the cache is cold, the re-read is going to happen anyway, so a long transcript is pure
liability: it buys nothing and costs whatever it grew to. The rotation policy is set at 60% of the
model window (600k on Opus 5/Sonnet 5) — a ratio chosen as if the transcript were cache-warm and
cheap to re-read. `NOTES-token-economy.md` item G already reasons "guessing low costs a cache
prefix and nothing else", and finding 4 records that **rotation is cheap by design** because the
mesh is state-projected and the supervisor refills a fresh session from projections every turn.

So the same argument now runs the other way: if the transcript is *not* reliably warm, a small
cap costs nothing that is not already being paid, and bounds the worst case from 691k tokens to
the size of the briefing.

- **M1a (cheap, do first): record `cacheRead` per turn.** One field from `tokensUsed.cacheRead`
  into `TurnRecord`. Without it the whales stay unattributable and this whole section stays an
  inference. Purely additive; no schema change (trace-only).
- **M1b: rotate on staleness, not only on size** — a seat whose previous turn ended more than the
  cache TTL ago should be rebuilt before its next turn, because it is paying the rebuild price
  regardless. This is the single highest-value change in this document.
- **M1c: lower the size threshold** (60% → a fixed tens-of-thousands cap), with M1b as the
  principled version and this as the blunt one.

Risk: rotation discards in-session conversational nuance not captured in projections. The
continuity record exists for exactly this, and finding 4's argument says the refill is already
designed for it — but M1b changes behaviour for every seat, so it wants the §8.1 measurement
first. Size: small (M1a ~10 lines; M1b is a predicate in the rotation check plus the turn-gap
bookkeeping).

### M2 — The wake should carry the delta, not the briefing — **WITHDRAWN, see the correction**

> **Correction (this is the review's own error, kept in place).** As first written this section
> claimed ~8% of mission input, by taking the whole 2,286-token briefing block as movable and
> multiplying: 40% of the common turn × 20.6% of the bill. The measurement does not support that.
> The byte-stable parts are `Mission` (0/19 changes), `Relevant policy` (0/19), the preamble
> (0/19), `Your memory` (2/18) and the static `Ops block contract` — and those add up to ~1,970
> chars, **not** the block's ~9,100. The other ~7,100 chars (mail, threads, own recent activity,
> runtime state, artifacts, decisions, criteria, budget) change every turn and cannot leave the
> per-turn message at all. So the movable fraction is ~22% of the block, the saving is ~22% of
> 40% ≈ **~2% of mission input**, and the cost is a stable/volatile split through
> `renderContextInstructions`, `AgentInput`, `fitToSoftCap` and the rotation re-freeze. Against
> that sits the risk the review itself flags below: the briefing is how the mesh *steers* a seat
> every turn, and "best quality communication" is the user's first goal, not cost. **Withdrawn.**
> The evidence survives as a smaller and more honest observation: the stable third of the
> briefing is pure repetition, ~1,970 chars of it, on every one of ~185 common turns.

What follows is the section as originally written, for provenance:

~1,570 chars of every 7,980-char block are byte-identical from turn to turn (measured over one
seat's 20 consecutive turns: `Mission` changed 0/19, `Relevant policy` 0/19, preamble 0/19,
`Your memory` 2/18; `Ops block contract` ~398 chars is static instruction text). The session is
persistent and `systemPrompt` is already a once-per-session channel — but it carries only the role
prose, while mission/policy/memory/ops-contract ride the per-turn user message.

Moving the stable block into the session-level prompt and leaving the per-turn message to carry
only what changed removes the largest *controllable* component of the common turn: the block is
2,286 of the 5,655 median fresh tokens, i.e. **40%**.

- Size: moderate — `renderContextInstructions` needs a stable/volatile split, `AgentInput` a
  second field, `runtime-claude` composes `systemPrompt` from role prose + stable block (and
  re-freezes it on rotation). The `mesh-json` ops contract and the closing-out rules are the
  natural first candidates; mission/policy/memory next.
- Risk: `fitToSoftCap` must budget both halves; the designer path must not move. Also a pure
  correctness question — anything the supervisor expects the model to re-read each turn must stay
  in the volatile half.

### M3 — Use the burst count that is already recorded (quality + contact)

`gather()` counts the burst and throws the count away. Give the wake the shape of the queue:
"N messages in M threads, K of which oblige you" instead of a bare reason line. Cheap — the data
exists. This is the best quality-per-line change available, because it is the difference between
a seat that knows it is behind and a seat that thinks it has one message.

### M4 — Close the obligation's fail-open hole (quality)

Require a contract for the obliging types, or — if that is too strong for existing meshes —
make the absence first-class: record `contract: undefined` as an explicit *unstructured ask* and
say so in the prompt, so the fail-open answer check stops being invisible. §3a. Related: consider
generalising the `Belief.basis` discipline (§3b) so a discharge can carry checkable evidence
rather than prose alone. Both are protocol-shaped and want a deliberate decision, not a patch.

### M5 — Give the recipient a wake policy (low contact, the out-of-the-box one)

Today only the sender's wallet rations, and the only recipient-side control is `interests:`
gating broadcasts. The generalisation: a per-seat `wake:` policy — *defer non-obliging mail to my
next turn* (which `accrue` already proves works, globally), *I read mail once an hour*, *never
wake me for `accrue` regardless of mode*. This moves the mesh from "the sender decides what
my attention costs" to the sender paying and the recipient rationing — which is what the
attention thesis in `docs/configuration.md` actually implies and does not yet implement.

**The larger version, stated honestly because it was proposed before and retracted:** a *read*
path — push the obligation, pull the content (`mesh_read`; a wake that carries a one-line claim
and lets the seat fetch bodies when it decides to work the item). `NOTES-communication-styles-review.md`
§7 records that this idea was invented in a later session and correctly notes it was *not*
supported by evidence at the time. The measurement in §1 is the evidence that was missing: the
cheap turns show that a wake costs ~5,700 fresh tokens of which only 179 chars is mail, so a wake
that carries a claim rather than a briefing is where the remaining common-case cost is. But it is
a protocol change with a real downside — pull means a seat can *choose not to look*, converting
the current failure ("never woken") into a worse one ("woken and ignored") — so it should be
decided on its own merits, not smuggled in as a cost fix. Recommend: M4/M5 first, revisit after
§8.1.

**What was shipped instead, and why it is not this.** The pull path above asks a seat to trade a
wake for a fetch, and pays for it with the "woken and ignored" failure. The shipped `mesh_inbox`
does not make that trade: it changes nothing about *when* a seat wakes, only what a seat that is
**already awake** can see. The defect it closes is the one §4c lists — the turn renders
`selectUnread`'s top 12 and is silent about the remainder — so a seat that is woken with a full
box can now see the whole box and page through it, inside a turn it already bought. No protocol
change, no wake-path change, no new failure mode.

**And then the read path, in the form the evidence actually supports.** `agents.<id>.wake.mail:
"claims"` splits M5's read path at the obligation instead of at a size threshold: `mesh_inbox` is
the fetch half, and a claim line is the push half. It answers the retraction above on the two
points that retraction was about:

- **"A seat can choose not to look"** — it can, but only about mail it owes nothing on. Obliging
  mail is inlined by the renderer in both modes, so the "woken and ignored" failure cannot reach
  a question. What a seat may decline to read is news.
- **"It should not be smuggled in as a cost fix"** — it is not, and §1d is why it cannot be: the
  measured `Unread mail` section is 2.2% of a turn's briefing block (~0.2% of mission input), so
  claim mode saves almost nothing. It is documented as a contact-quality lever, defaults to
  `"full"`, and the default should not move until a mission asks for it.

The reason the earlier form was wrong, stated plainly because it is a trap worth naming: deferring
*rendering* is not the same as deferring *reading* when the drain is keyed on
`renderableMail(bundle.unreadMail).shown` — a recomputation from the bundle, not the prompt string.
Under a uniform claim mode, mail whose body was never shown still gets `message.delivered` when the
turn ends. "Delivered means rendered AND answered" would quietly weaken to "mentioned AND
answered", for a measured 0.2% of input. Splitting at the obligation is what keeps the sentence
true.

---

## 7. Divergences and dead code found

From a sweep of policy, config, roles and docs. Fixing docs is cheap; leaving them is how the
next reader learns the wrong thing.

| # | Divergence | Where |
|---|---|---|
| 1 | ~~"the bus is a reference bus" — never paste content: **unenforced**, prompt-text only~~ **fixed** (§10): the doc now calls it a discipline rather than a rule, names `payload` as unconstrained, and states the render-time bound that actually limits what a pasted body costs | `docs/protocol.md:196` → `232-243` vs `RESERVED_PAYLOAD_KEYS` |
| 2 | ~~Obligation rule omits `control.mode`; a REQUEST under `broadcast` obliges nobody~~ **fixed** (§10): both conditions now stated as two, with `obligesRecipients` named as the single predicate | `docs/protocol.md:77` vs `catalog.ts:372` |
| 3 | ~~"illegal APPROVE/COMMIT/DELEGATE/BLOCK are rejected before they become events" — the *bus* gates on type nowhere; what stops them is layer 2 on the op~~ **fixed** (§10): layer 2 is named as where they stop, and the raw-message case is stated honestly — the message is logged and delivered, and it is the *state effect* that is refused, with the sender told | `docs/architecture.md:50-51` vs `evaluateMessage` |
| 4 | ~~Layer 2 is described as the OpenCode adapter writing `permission` blocks~~ — **that backend was removed**, and layer 2 is now described as `policy-engine` plus each adapter's own tool gate. **Fixed** (§10), together with the same phantom backend in `docs/runtime.md`, `README.md` and `AGENTS.md` | `docs/architecture.md:47-53` |
| 5 | ~~`deny.contact` and `when.to` are documented policy-rule fields; `matchRule` reads neither~~ **both fixed** — `when.to` now binds (§10), `deny.contact` deleted + warned (§10) | `config:399,410` vs `policy-engine:292-309` |
| 6 | `REQUEST_TYPES` is exported and `@deprecated` because it cannot answer "does this oblige?" — **kept on purpose, and closed** (§10): it is a derived copy behind the package index, so deleting it is a public API break for no in-repo gain, and its JSDoc now names the three tests that read it, so the deletion is small but priced | `catalog.ts:376-389` |
| 7 | `vocabulary: "contracts"` is **advertisement only** — `callTool` resolves against the unfiltered map, so nothing is enforced — **closed as documented, not enforced** (§10): the split is deliberate (hiding is an advertisement decision; refusing is `transport: "typed-only"`'s job), and the docs state it in four places. Enforcing it is a capability *narrowing* whose coherent form needs the prompt half too, since the prose channel still teaches the 24-name catalogue under `contracts` | `mcp.ts:98-103`, `docs/protocol.md:167-175` |
| 8 | Dead: ~~`notifyMailDelivered`~~ (removed), ~~`MeshMessage.ttl`~~ (removed, loud — see §10), ~~`idleQuietPeriodMs`~~ **implemented** (§10) as the scheduler's idle dwell — the one "documented, not implemented" item in this sweep that turned out to want a reader rather than deletion | various |
| 9 | ~~**`when.event` is read but never compared** — its only read is `if (w.event && !match.message) continue`, which tests *that a rule has an event clause*, not the event. `when: { event: "artifact.published" }` silently applies to message sends; the value is never validated.~~ **Removed** (§10): the clause and the guard are gone, and a config still setting it is refused at load. The guard was the only thing scoping such a rule to message evaluation, so removing the clause **widens** the rule to capability and authority checks — which is exactly why the refusal is an error and not a warning | `policy-engine:316` |
| 10 | ~~**The rule surface is unvalidated end to end**~~ — **closed** (§10): every clause above is now checked at load, capabilities and message types as errors, `when.actor_role` and `when.to` as warnings. `policies.rules` is still `{ type: "array" }` with no `items`, so AJV still checks nothing inside a rule; the cross-field pass is what carries this, and it is now the whole clause surface rather than two fields. Because the array has no `items`, the *shape* of a rule is still enforced nowhere — the clause checks read defensively and tolerate what they do not recognise, which is what keeps a hand-written mesh loading | `schemas.ts:352`, `config:922-926` |
| 11 | ~~`RawPolicyRule.requires` (`{ approvals?, evidence? }` on a *rule*) is entirely inert~~ **Removed** (§10), with an aggregated load warning rather than an error — it is inert in both directions, so removing it cannot widen anything. Name collision with the live `MeshMessage.requires` goes with it | `config:425-428` vs `policy-engine:492`, `supervisor.ts:1664` |
| 12 | ~~`matchRule`'s `authority` parameter is declared and passed by both callers, never read~~ **Removed, and the denial it obscured is now surfaced** (§10): the parameter is gone and `matchRule`'s doc comment records what the match shape actually compares. There is still no `when.authority` — an authority matches on actor and role alone — and `evaluateAuthority` still denies a **held** authority whenever the matched rule names any `deny.capabilities`. That denial is deliberately left: narrowing it removes a DENY, which is a permission *widening*, so it wants its own decision rather than a cleanup commit. What is no longer left is its **invisibility**: `warnAuthorityStrippingRules` reports at load every rule that would strip an authority from a seat that holds one, a warning rather than an error precisely because it changes no permission | `policy-engine:296,125,143`, `config:warnAuthorityStrippingRules` |

> **Correction.** Row 8 first listed `Scheduler.triagedAway` as "counter only" and dead. It is
> not: `triagedAwayCount()` is read by the status endpoint
> (`apps/mesh-server/src/index.ts:1874`, under the comment about "a different kind of loss") and
> pinned by `tests/scheduler/triage-counter.test.ts`. I had read the producer and stopped —
> the exact "read one end" mistake this repo's notes warn about, made inside the document that
> warns about it.

Two structural notes that are *not* defects but should be known:
- **The communication matrix is keyed on agent identity with role fallback**, deny-by-default,
  with no fallback allow — and the default scaffold writes `communication: {}`, so a fresh mesh
  permits only replies-in-thread and contact with the human. That is the right default; it also
  means every example mesh hand-rolls its own matrix (no example uses `may_be_contacted_by`).
- **The reply loophole is closed correctly** — `isReplyViaParticipants` requires the target to
  have spoken or been addressed, replacing a version where one broadcast enrolled the whole mesh
  into a thread and voided the matrix. Good comment, good fix.

Rows 9-12 come from a follow-up sweep of the rule surface rather than from the measurement, and
each was verified by scanning every reader rather than by grep. They are one defect wearing four
hats, and row 10 is the hat: **nothing validates a rule's internals**, so a clause can be
misspelled, unimplemented, or read-but-not-compared and the mesh will boot happily and enforce
nothing. That is why rows 5 and 9 were able to be dead without anyone noticing, and it is why
fixing row 10 is worth more than any one clause. It also has a human cost: the designer tells the
operator "the server validates on check" (`PolicyPanel.tsx:79`), which is true of the envelope
and false of every rule body.

One caveat on row 10's fix: `when.to` resolves an id **or a role** **or the base id of a
hierarchical child**, so an id-only validation pass would reject a legitimate role-named recipient.
`warnUnreachableRuleRecipients` accepts all three, and is a warning rather than the error
`when.actor` gets precisely because a child seat comes into being at runtime. The same asymmetry
decides the severity of every other clause (§10): a name that **cannot** arrive later is an error, a
name that can is a warning. Roles are the clear case — a mesh is often written for seats a larger
mesh adds — so `when.actor_role` warns; capability and message-type tokens have no such path, so
they error.

One more caveat, on what checking the surface does **not** buy: it makes a dead clause *visible*, it
does not make it *work*. Every clause it reports is one the engine never consulted; reporting them
turns a silent no-op into a load-time message, and the repair — implementing or deleting the clause
— is still a change to what gets enforced, which is why rows 9 and 11 stay reported rather than
fixed.

---

## 8. What needs your decision

> **Answered "fix all", and implemented — see §10 for what shipped and what did not.** One item
> below (1) argued for a sequencing I then did not follow, so it is worth being explicit about
> why: the answer was to fix everything, and M1a (the measurement) and M1b (the fix) landed
> together. That is only defensible because M1b's thresholds are derived from the §1 measurement
> rather than invented, they are option seams that a mesh can override, and the falsification
> path is built in — `TurnRecord.tokensCacheRead` now records the number §1 was reconstructed
> from, so the next real mission either confirms the bound or refutes it from data. If it
> refutes it, `staleAfterMs`/`staleFloorTokens` are two numbers to change, not a design to
> unwind.

1. **Reproduce §1 first.** One more mission with `cacheRead` recorded per turn (M1a). If the
   concentration holds, M1b is the highest-value change in the repo and everything else here is
   secondary. If it does not hold, §1 is a property of this mission's 24 restart/replace events
   and M1 shrinks accordingly. **I would not build M1b before this.**
2. ~~**M2's split point**~~ — withdrawn in §6; there is no split point to choose.
3. **M4's strength** — require a contract for obliging types (clean, breaks meshes that rely on
   bare REQUESTs), or make the absence explicit and visible (safe, slower). **Resolved in §10 the
   second way**: the safe one. Requiring a contract would have refused asks that a mesh has always
   been allowed to send bare, which is a compatibility break to buy a visibility gain the context
   line already delivers.
4. **M5's scope** — per-seat wake policy alone, or the read path as well (§6 M5). The read path
   was proposed once before without evidence and retracted for that reason; this review supplies
   the evidence but not the justification for the failure-mode change. **Resolved in §10 as the
   first only**: the per-seat policy shipped and the *pull* model did not, because it converts
   "never woken" into "woken and ignored" — a different failure, not obviously a smaller one, and
   not something to ship on the strength of a cost argument. A third option, not on this list,
   is what actually shipped alongside the policy: `mesh_inbox`, a read of the queue by a seat
   that is already awake. It is not the read path — it buys no wake and so changes no failure
   mode — but it does close the "top 12 and silence" gap in §4c, which is the part of this
   question that had a defect behind it rather than a trade-off.

   **Superseded: the read path itself then shipped, and this item is the reason it looks the way
   it does.** Once the safe form was clear — split at the *obligation*, not at a size threshold,
   so obliging mail keeps its body and a seat is never marked answered on a body it was not shown
   — the two objections above stopped applying: the failure-mode change cannot reach a question,
   and the cost argument is not the justification (it is 0.2% of input by §1d, and the key
   defaults to `full`). So `agents.<id>.wake.mail: "claims"` shipped as an opt-in per-seat seam
   whose fetch half is the tool this item describes. The decision record is §6 M5; the shipped
   form is §10.
5. **Whether to keep paying for the mail-path work at all.** §1d is the uncomfortable part: the
   last two rounds optimised a fifth of the bill. That does not make them wrong — contact quality
   is a product goal, not only a cost one — but the next round should be aimed at §1.

---

## 9. Method and provenance

- **Measured**, from real mission data in
  `examples/line-follower-sim/workspace/.mesh-state/logs/`: `events.jsonl` (3,739 events, 218
  `message.sent`, 314 `agent.awakened`) and `turns.jsonl` (200 turns, each carrying the full
  rendered `instructions` string). Section attribution and byte-stability were computed by
  splitting each turn's `instructions` on `## ` headings and diffing per seat across consecutive
  turns. Fresh-vs-cached was resolved by reading `tokensInput` back to `usage.input_tokens`
  (uncached only) — `transcriptSize()` uses `input + cache_read`, the budget's `total` is
  `input + output + cacheWrite`, and `cacheRead` is deliberately excluded from `total`
  (`NOTES-token-economy.md` "Do NOT touch" — untouched here).
- **Falsified during this review, recorded so the errors are not repeated:**
  - *"Payload bloat is the core low-contact problem."* Measured: payloads average 273 chars
    (~68 tokens), p90 437, max 1,061 — 3.6% of log bytes. Discarded.
  - *"A volatile 88-char `Your runtime state` section sits third in the block and busts the
    prompt-cache prefix for everything after it."* Wrong: the block is appended as a single new
    user message, and message-internal ordering cannot affect prefix caching. Reordering sections
    saves nothing. Discarded — and it is now the §1e observability point instead.
  - *"The mission's turns are spaced past the cache TTL, so every turn re-bills the transcript."*
    Half wrong: the median gap is **5.4 seconds** and the median fresh input is flat at ~5,655
    across conversation length, so caching normally works. Only the ~6% of turns after a >10 min
    gap blow up. The corrected version is §1c.
- **Read for this review:** the three existing `NOTES-communication-*` documents and
  `NOTES-token-economy.md` in full; `docs/protocol.md`, `docs/architecture.md`,
  `docs/configuration.md`; `protocol/types.ts`, `protocol/contracts.ts`,
  `protocol/op-aliases.ts`, `protocol/catalog.ts`; `core/context.ts`, `core/supervisor.ts`,
  `core/state.ts`, `core/budgets.ts`, `core/turn-tracker.ts`, `core/projections-messaging.ts`;
  `policy-engine/src/index.ts` (whole); `scheduler/src/index.ts` (whole); `config/src/index.ts`
  (comms blocks); `apps/mesh-server/src/mcp.ts`; `roles/*.md` (all 7).
- Two explorer agents were used for the policy/config/roles/docs and scheduler machinery sweeps;
  their line-numbered inventories are the source for §3-§5, §7 and the constants quoted
  throughout.

---

## 10. What shipped

The answer to §8 was "fix all", so this section records what that turned into — including what it
did *not*, because a status section that only lists successes is the same failure as a schema
that documents a field nobody reads.

**Shipped, verified green** (`npm run typecheck` clean; `eslint` 0 errors on every touched file; full
suite **1634 pass / 0 fail**):

| Item | Change |
|---|---|
| **M1a** — record the measurement | `TurnRecord.tokensCacheRead` (`core/turn-tracker.ts`), wired from `tokensUsed.cacheRead` at both trace sites in `core/supervisor.ts`. Without it §1's whales stay unattributable. Trace-only, no schema change. |
| **M1b** — bound the cold turn | Staleness-driven rotation in `runtime-claude`: `lastTurnEndedAt` per session, `SESSION_CACHE_STALE_MS` (10 min), `SESSION_STALE_ROTATE_FLOOR_TOKENS` (40k), a `staleRotationDue` latch, and the `staleAfterMs`/`staleFloorTokens` option seams so a mesh can override the numbers. `rotationPending()` reports staleness too, so the supervisor can ask for a continuity record before the handover. |
| **M3** — wake carries the burst, not one message | `drainGathered` annotates a gathered wake with its count ("N messages arrived together, not one"); the queued-mail note names the mailbox depth instead of only that mail exists. Both were counts already computed and discarded. |
| **M4** — the fail-open hole is visible | `core/context.ts` now renders `contract: none — no request schema was named, so any reply that answers this settles it. Discharge it with a reason if you will not.` on an obliging message that carries no contract. |
| **M5** — a seat can refuse the wake it does not need | `wake: { defer_non_obliging: true }` per seat (`types.ts`, `config`, the mesh schema, `docs/configuration.md`). Honoured at **all four** sites where unread mail would otherwise buy a turn: the `message.sent` wake loop, the wait-timer sweep, `notifyTurnFinished`'s retry, and `isRedundantObservation`'s "real work outstanding" check. Factored into one `defersMail` predicate so the sites cannot drift apart. Two exemptions are load-bearing: obligation (`obligesRecipients`, the same predicate the debt opens with) and operator mail — the latter because `hasHumanMail` decides whether post-mission feedback still gets answered. The FAILED-agent recovery check is deliberately **not** filtered, with the reason in code. |
| **§7 row 5** — `when.to` | Implemented in `policy-engine` (was documented, silently ignored); `deny.contact` deleted from `RawPolicyRule` and replaced with a load-time warning, since deleting a TS field is invisible to an operator whose yaml still sets it. |
| **§7 row 8** — dead code | `notifyMailDelivered` deleted from `SchedulerPort` (`core/ports.ts`), its no-op stub (`apps/mesh-server/src/index.ts`), and the scheduler. |
| **`MeshMessage.ttl`** — dead field | Deleted from `types.ts` and the message schema. Nothing ever wrote it and nothing read it; because the schema is `additionalProperties: false`, a config or peer that still sends one now fails to parse rather than being ignored — so this is a loud removal, checked by the schema-drift test. |
| **§7 row 10** — a rule body that names nothing | The whole clause surface is now checked at load. `validateRuleClauseTokens` reports an unknown token in `when.capability`, `deny.capabilities`, `when.message_type` or `deny.message_types`; `warnUnreachableRuleRoles` reports a `when.actor_role` no seat plays (exempting the synthesized `human` seat); `validateRemovedRuleClauses` reports any `when.event` as an error. Errors for capabilities and message types, warnings for roles and recipients only — see below. `docs/configuration.md` now carries the severity rule and the alias behaviour; the file had described validation for exactly two clauses while three more were shipping unnoticed. |
| **Capability aliases inside a rule are now normalized** | `policyRules` was the one capability list in the config that bypassed `normalizeCapability`, so `deny.capabilities: [code.write]` — a legal, documented spelling — was compared against the canonical token a seat actually holds and matched nothing. The rule read as live and was dead. Now normalized at resolve time, with `resolved.raw` still carrying the operator's spelling. Proven at the engine, not just at resolve: `tests/policy/policy.test.ts` denies `repository.write` from a rule written `code.write` and asserts the reason names the canonical token — which is the string the engine actually compared. This is a deliberate behaviour change: previously-dead alias rules become live, which is what `CAPABILITY_TOKENS`' docstring already promised ("the aliases below are normalized first"). No config in the repo spells a rule clause in an alias, so nothing in-tree changes behaviour. |
| **§7 row 4** — doc drift from the removed adapter | `docs/runtime.md` still documented `runtime-opencode` as a live backend with its port, health gate and config injection, in the very file `docs/architecture.md` now points readers to. Replaced with a *removed* note that quotes the load error and names the replacements. Same sweep caught `README.md` claiming `mesh init` "auto-detects opencode" (both callers pass `"claude"` explicitly, so the code was right and the README was stale) and listing the deleted package in its layout, plus the same phantom entry in `AGENTS.md`. |
| **`when.event`** — dead clause, removed | Deleted from `RawPolicyRule`; a config still setting it is now a **load error**, not a warning. Its value was never compared: the only read was a guard in `matchRule` that skipped the rule whenever no message was under evaluation, so `event: "artifact.published"` and `event: "banana"` were the same rule and both meant "do not apply to capability or authority checks". It is the stranded half of the abandoned transition-rule design (`agent-mesh-runtime.md` §19, now bannered historical) whose `when.to` named an artifact *status* — a meaning later repurposed to a message recipient. Deleting the guard is what makes the removal real; the load error is what makes it safe (see below). |
| **Rule-level `requires`** — dead clause, removed with a warning | `RawPolicyRule.requires` is gone too. Approvals and evidence are gated by `policies.transitions`; nothing read the rule-level copy, so a config still carrying one gets an aggregated load *warning* naming each rule. Warning and not error because removing it cannot widen anything — refusing to boot would be a cost with no safety behind it, which is the exact inverse of the `when.event` case. |
| **A rule written with no `when` at all** | The load-time actor check read `if (rule.when.actor && …)` unguarded, so a hand-written rule with no `when` block threw a raw `TypeError` out of config load instead of producing a diagnostic. `matchRule` had always tolerated the absence (`rule.when ?? {}`), which made the validator — not the engine — the odd one out. Pinned by a test that loads such a rule. |
| **`mesh_inbox`** — a seat can see its own queue | A 47th MCP tool, read-only (`READ_TOOLS`), scoped to the caller and token-verified like every other. It renders the whole of `resolveUnread`, paged, with `total`/`truncated`/`nextOffset`, the thread subject resolved, and `answerOwed` computed from `obligesRecipients` — the same predicate the debt opens with. It deliberately **does not** emit `message.delivered`: a view is not a receipt, and `delivered` means rendered *and* answered, so a tool that drained would mark read what no prompt ever showed. The load-bearing assertion in `tests/integration/mcp-inbox.test.ts` is that both `readableMailDepth` and the projection's `unread` list are unchanged after the call, and the test runs `mode: "parked"` so a live scheduler cannot answer the mail underneath the assertions. |
| **`Designer.renameAgent` left stale rule references** | Renaming a seat rewrote every other place its id appeared except `policies.rules[].when.actor` and `.to`, so the designer produced a config that then **failed to load** — the actor-coverage check above refuses a rule naming a seat that does not exist. The rename now carries the rule clauses with it, which is what lets that check ship without turning the designer into a way to brick a mesh. |
| **§8.4 — the pull path, as an opt-in per-seat seam** | `wake: { mail: "full" \| "claims" }` (`types.ts` → `WakePolicy` and `AgentContextBundle.wakeMail`, `config`, `protocol/schemas.ts` + `schemas/mesh.schema.json`, `docs/configuration.md`, `core/context.ts`, and the `mesh_inbox` doc comment that described itself as *not* this). Under `claims` a message renders as its header line plus a `body withheld` mark, and `mesh_inbox` returns the body. **The split is at the obligation, not at a size threshold**: `obligesRecipients` keeps a body inline in both modes, because the drain keys `message.delivered` on `renderableMail(...).shown` — a recomputation from the bundle, not the prompt string — so a uniform claim mode would have quietly weakened "delivered means rendered AND answered" to "mentioned AND answered". Off by default: §1d measures the whole `Unread mail` section at 2.2% of a turn's briefing block (~0.2% of mission input), so this is a contact-quality lever, not a cost one, and the default should not move until a mission asks. The fetch line is rendered once per section, and only when something actually was withheld — a seat with nothing to fetch is not taught to reach for a tool. |
| **§7 row 12** — `matchRule`'s dead `authority` parameter | Removed from the inline match type and from both call sites, with a doc comment recording what the match shape does compare (actor, role, recipient, message type, capability) and why there is deliberately no `authority` clause. `docs/configuration.md` gains a `when.authority` row: **does not exist, and never did.** The one denial the parameter's presence obscured is left in place and now documented at the call site: `evaluateAuthority` still denies a **held** authority whenever the matched rule names any `deny.capabilities`, which is a permission *narrowing*, so undoing it is a widening that wants its own decision. |
| **§7 row 8** — `idleQuietPeriodMs`, which turned out to want a reader | `Scheduler.checkIdle` now arms a `setTimeout` for `scheduling.idle_quiet_period_ms` before declaring the idle moment, re-arming on any work and cancelling on stop/reset. The old edge-trigger fired on *any* instant the queue happened to be empty, which on a live mission is a moment, not a state — and the declaration is what the supervisor reads as "this mesh has gone quiet". `0` remains the escape hatch and declares idle in the pump with no timer, because `wait_wakeup_ms` (60s in prod) is far longer than a short quiet window and a sweep-based dwell would never fire. The three tests in `tests/scheduler/scheduler.test.ts` pin the dwell, the abandonment on work, and the zero-timer path. |

| **§7 rows 1, 2, 3** — doc/code divergences | All three were already repaired in `dc5e38d` (which rewrote exactly those passages) and this pass is the record catching up: rows 1-3 struck here, §3c and §3d rewritten to describe the current text rather than quote the deleted sentences, and the stale line numbers (`protocol.md:196`, `protocol.md:77`, `architecture.md:50-51`) replaced with the passages that now carry the argument. One genuine defect remained and is fixed: `docs/protocol.md` claimed `note`'s 2000-character bound was "the only bound on free prose anywhere in the envelope", and `requires[].text` is a second one — the paragraph now names both, and names the render-time bound (`renderMailPayload`: 20 lines of 400 characters, remainder marked omitted) that is the real answer to what a pasted body costs a reader. |
| **§7 row 6** — `REQUEST_TYPES` | Closed without a code change, which is the honest end state: it is a derived copy (`[...OBLIGING_MESSAGE_TYPES]`) behind a public re-export, so deleting it is an API break for no in-repo gain, and correcting it in place is how the two lists would drift apart again. The JSDoc's one gap was that "zero runtime consumers" read as "free to delete" while three tests pin it as a copy, so it now names them (`tests/core/obligation-predicate.test.ts`, `tests/core/context-inbox-order.test.ts`, `tests/protocol/mcp-comms-surface.test.ts`). |
| **§7 row 12, residue** — the denial nobody could see | `evaluateAuthority` still denies a **held** authority whenever the matched rule names any `deny.capabilities`; that stays, because removing it *widens* a permission. What is new is `warnAuthorityStrippingRules` (`config/src/index.ts`), a load warning that names the rule, the seat and the authorities it would strip. A warning and not an error, on the house severity rule: it changes no permission in either direction, whereas refusing to boot over a trap that has not sprung is a cost with no safety behind it — the exact inverse of `when.event`. It is ported from `matchRule`'s shape rather than reasoned about, and the three tests pin the two counter-intuitive halves: `when.to` **exempts** a rule (an authority check addresses nobody, so `to` fails closed) while `when.capability` does **not** (an authority check carries no capability to compare, so the clause fails open). Unreachable in every config shipped here — all three real `deny.capabilities` rules name seats that declare no authority — so the negative control is that the shipped shape stays silent. |
| **§8.4, the other half of the seam** | `tests/integration/wake-claims.test.ts` asserts on `input.instructions` — the string a live turn actually hands the runtime — rather than on a hand-built bundle, because the unit tests beside them prove the *renderer* and not the *seam*, which is the failure this repo keeps finding: a key that loads, resolves, validates, documents and reaches nothing. Three tests: a claims seat is handed the claim and not the body, an unconfigured seat on the identical fixture is handed the body (the control that makes the first one mean something), and an ask on a claims seat keeps its body and its `contract: none` line. The negative control is aimed at the seam, not the renderer: with the compiled builder patched to ignore the configured key, exactly the first test reddens. |

**Not shipped, and why:**

- **Enforcing `bus.vocabulary` at call time — deliberately not shipped (§7 row 7).** The row's
  divergence is closed by documentation, which was already true of the code (`mcp.ts:101-106`) and
  is now true of `docs/protocol.md`, `docs/configuration.md` and `docs/runtime.md`: `"contracts"`
  is an **advertisement** decision, and refusal is `transport: "typed-only"`'s job, not this key's.
  Enforcing it would be a capability *narrowing* — for every mesh `mesh init` scaffolds, since
  `writeDefaultMeshYaml` writes `vocabulary: contracts` — and it cannot be done coherently in one
  place: `mesh_call`, `mesh_reply` and `mesh_announce` **desugar into** the ops a gate would ban, so
  the unit is the tool name and not the op (all three would break otherwise); the human seat shares
  one `McpToolset` and would need exempting; and the prose channel still teaches the 24-name
  catalogue under `contracts`, because that branch is gated on `transport`, not on vocabulary — so
  a tool-layer refusal alone would punish the tool and reward the bypass. Two coupled changes (a
  bundle flag plus the prompt branch, then the refusal) and a permission decision that is the
  operator's to make. Recorded here so it is a decision rather than an oversight.

- **M2 — withdrawn.** The correction in §6 is the reason. I over-claimed ~8% of mission input by
  treating the whole briefing block as movable; the genuinely stable part is ~1,970 chars of it,
  so the honest figure is ~2%, bought with a stable/volatile split through four layers and a real
  risk to the briefing's steering role. Not worth it. Dropped rather than deferred.
- **M1c — not needed.** It was the blunt alternative to M1b; shipping both would be two bounds on
  one failure.
- **The read path as an unconditional default — deliberately not shipped.** The pull model on its
  own converts "never woken" into "woken and ignored", which is a different failure and not
  obviously better, and §1d removes the cost argument that would have justified it: mail is 0.2%
  of mission input. So it shipped as an opt-in seam that cannot reach a question (see the
  `§8.4` row above) rather than as a default. `mesh_inbox` remains the half that buys no wake and
  so changes no failure mode; a seat that is *not* woken still learns nothing from either.
- **`idleQuietPeriodMs` — implemented, closing the last "documented, not implemented" item in
  §7 row 8.** The fix went where the entry said it belonged (`Scheduler.checkIdle`); the doc
  comments in `config/src/index.ts` now describe a listener rather than an inert key. It is still
  *not* warned at load, because `tests/helpers.ts` writes it into every fixture in the repo.
- **§7 row 11** — removed, with the aggregated load warning described above. **Row 12** — the
  parameter is gone; the denial it obscured is documented and left, because narrowing it is a
  permission widening (see the row above).

**Why row 10's new checks split between errors and warnings.** Not taste — it follows from whether
a name can still turn up at runtime. A capability or a message type outside its catalog has no such
path: no seat can arrive holding `repository.writ`, and a message with a type the envelope schema
rejects never reaches the engine. A dead clause there is *permanently* dead, so it is a load error,
matching `when.actor` and `validateCapabilityTokens`. A role or a recipient **can** arrive later —
delegated workers, hierarchical children, the synthesized `human` seat — so an unresolvable one is a
warning, matching `validateTransitionGateActors` (config:947-949), whose own comment gives exactly
this reason. Getting the split backwards in either direction is a real cost: erroring on roles would
break configs written for a larger mesh, and warning on capabilities would leave the dead clause
above alive in every config that has one.

**Why `when.event` is the case that inverts that rule, and why it is still an error.** By the
principle above, a clause that widens what gets enforced is the one place a *warning* looks safer —
warn, and the operator keeps a working mesh. But a warning here is precisely what leaves the
widening alive: the operator sees a line in a log, the config still loads, and the rule now denies
capability and authority checks it never used to. An **error** is the only severity that cannot
widen a rule by accident, because an unbootable config enforces nothing at all. That is the whole
argument, and it is the inverse of the `requires` case next to it: removing `requires` changes
nothing downstream, so refusing to boot there would be pure cost. Two clauses, two directions, and
the severity tracks whether the removal changes what the engine does — which is the same question
row 10's split asks, just asked about the *deletion* rather than the clause.

**Found by verification, and fixed.** The `when.to` work above went to a verifier agent with no
stake in it, which refuted two of its claims and turned both into changes rather than footnotes:

- **A falsy `when.to` re-widened the rule mesh-wide.** The guard was `if (w.to && …)`, so a
  *declared but empty* `to` (`""`, or `null` from JSON) was read as *absent* and the rule went back
  to matching everything — off-messaging capability and authority checks included. That inverted the
  pair: a **wrong** recipient bound nobody, while an **empty** one bound everyone. Reachable, not
  theoretical: `Designer.tsx` writes `""` into `when` fields when an operator clears them. Now the
  test is "declared", and both spellings bind nobody. Pinned by a test in
  `tests/policy/when-to.test.ts`, negative-controlled by restoring the truthiness guard in the
  compiled engine (exactly the one new test goes red; the five pre-existing ones stay green).
- **The `deny.contact` warning is aggregated, not per-rule** — one warning per config naming every
  offending rule, which is the house style next door in `warnUngrantedApprovalGates`. The code was
  right and my test was blind: with a single offending rule it passes either way. The test now
  carries two offenders and pins the count *and* the naming.

**One error of mine worth recording.** The `wake` schema block was first written into
`mesh.defaults` — the exact place its own comment said it must not go, since a default there would
look mesh-wide while only each seat's copy is ever read. The schema-drift test caught it on the next
full run, and the fix moved it to the per-agent schema and added `tests/config/wake-policy.test.ts`,
which now pins that `mesh.defaults.wake` is refused at load rather than silently ignored. The
published `schemas/*.schema.json` were regenerated in the same pass; the diff is only the two
intended changes (`+wake`, `−ttl`), with no unrelated drift.

**Verification discipline applied to M1b and M5.** M1b: the four new tests in
`tests/integration/session-rotation.test.ts` were negative-controlled by patching the *compiled*
`dist/.../runtime-claude/src/index.js` to make `markStaleRotationDue` return false — three tests go
red and the floor-guard test correctly stays green. M5: patching the compiled `defersMail` to return
false makes exactly the one deferral test go red, while the obligation test stays green, which is
the signature that says the predicate — and not something incidental — is what the test measures.
Both compiled files were restored byte-for-byte and re-run green. Row 10's new code got the same
treatment: reverting `normalizeRuleCapabilities` to the raw pass-through in the compiled config
makes exactly the two alias tests go red — the resolve-level one and the engine-level one — with the
other twenty-three green, and removing the `validateRuleClauseTokens` push makes exactly the
catalog-token test go red. That pair is the strongest evidence in this document that the fix does
what it claims: the engine test asserts a live `DENY` verdict, so before the fix it was asserting
against a rule that could not fire. The `when.event` removal got the same treatment in two halves —
restoring the deleted guard in the compiled `policy-engine` makes the guard test go red, and
reverting `validateRemovedRuleClauses` to a no-op makes the refusal test go red — and `mesh_inbox`
got it too: making the compiled `inboxView` emit `message.delivered` for the page it returns makes
exactly the drain assertion go red while the rest of the inbox test stays green, which is the
signature that the tool's read-only-ness, and not something incidental, is what the test measures.
Every one of those compiled files was restored byte-for-byte (**sha256 checked, not eyeballed**)
and re-run green. The thresholds are derived from
the §1 measurement rather than invented, and M1a means the next real mission can falsify them from
data.

**The three items after that commit got the same treatment, and one of them found a flake.**
`wake.mail` in two halves: forcing `claimsOnly` to `false` in the compiled `core/context.ts` makes
exactly the two claims tests go red — the FYI-withheld one and the ask-in-full one — while the
"do not teach a seat to fetch" test correctly stays green, and dropping the `mail` thread-through
in the compiled `config` makes exactly the resolve test go red. Both files restored byte-for-byte
and re-run green. The `idleQuietPeriodMs` dwell was controlled the same way (restoring the
edge-triggered `checkIdle` makes the two dwell tests red and the zero-window test green).

The one that was *not* mine: adding these tests made
`tests/core/context-inbox-order.test.ts`'s open-threads cap test fail about one run in eight, so
before touching it I built HEAD in an isolated `git worktree` and ran it 15 times there —
**2 failures at HEAD, 2 with my changes**, so the flake predates the work. The mechanism is worth
recording because it is a fixture defect, not a production one: `Thread.createdAt` is
`clock.iso()` (millisecond resolution) and the id is not a tie-breaker either — `monotonicId`'s
counter only advances when two ids land on the same `hrtime` residue, so ids minted in one
millisecond differ only in their random suffix. Nine sends in a tight loop therefore share a
`createdAt`, the descending sort is a no-op on them, and the cap keeps whichever six the Map
yields first — while the test asserts "the newest survives the cap". Real threads are seconds
apart; only the fixture could collide. Fixed in the fixture (a real millisecond between sends) so
the property the test asserts is one it establishes, and re-run 12 times clean.

