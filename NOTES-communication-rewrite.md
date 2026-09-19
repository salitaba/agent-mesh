# Communication architecture — review and rewrite proposal

Scope, as agreed: **agent ↔ agent** (envelope, addressing, handoff, blocking) and
**agent ↔ its own future turns** (replay, context assembly, compaction). Agent ↔ human
and prose style are deliberately out of scope. Blast radius: full rewrite proposal with a
staged migration.

---

## 0. Verdict

The mesh's *documentation* already describes an excellent async, low-contact protocol.
"Messages are not RPC" (`docs/protocol.md:77-80`). "The bus is a reference bus"
(`:122-126`). "The architecture therefore avoids coupling agent lifetimes to message
latency" (`agent-mesh-runtime.md:1089-1127`). "Communication becomes: *Here is the
architecture decision*, not *Here are 14,000 tokens explaining the architecture*"
(`:210-218`).

Those are the right principles. The problem is that **almost none of them are enforced by
a type.** They are enforced by prose in role prompts, by naming conventions
(`type.startsWith("REQUEST")`, `#worker-` prefixes), and by heuristics. `op-aliases.ts`
exists because that keeps failing — one agent burned 18 turns on `RESULT` alone.

So this is not a proposal to *make the system more async*. It is a proposal to **move the
existing discipline from prose into the type system**, and to fix the four places where the
mechanism actively contradicts the stated design.

One more finding, discovered while writing this and worth stating on its own:

> `onRotate` is declared at `packages/runtime-claude/src/index.ts:133`, fired at `:1156`,
> and **consumed nowhere.** Session rotation — the single event that destroys an agent's
> entire working memory — never reaches the kernel, the event log, or the operator.

An agent's memory has a cliff, and nothing is told when it goes over.

---

## 1. The four structural faults

### 1.1 Serialization where none is needed

`packages/core/src/kernel.ts:109-121` — one write mutex for the entire mesh. Every emit
from every seat in every goal passes through one chain. Worse, listener fan-out is **serial
and awaited inside `emit`** (`:66-72`), so a slow subscriber backpressures the agent that
emitted the event. This is the most direct contradiction of "avoids coupling agent lifetimes
to message latency" in the codebase.

The lock is not the root cause. `Kernel.state` is `public readonly` and handed by reference
to the scheduler and the policy engine; `rebuild` does `Object.assign(this.state, fresh)`
(`:125`) so the aliasing is deliberate and load-bearing. One shared mutable object is why
one global lock is currently the only safe design.

### 1.2 An envelope that cannot route

`packages/protocol/src/types.ts:358-369` — `MeshEvent` has **no recipient, no topic, no
channel, no turn id**, and zero doc comments across all ten fields. `correlationId` is
undocumented and neither produced nor consumed anywhere in the package; its only constraint
is `{type:"string",maxLength:200}` (`schemas.ts:102`). Routing is resolved by the *reader*
from `AgentDefinition.interests: string[]` (`types.ts:506`, untyped).

`payload` is `T = unknown`, schema `{type:"object"}` (`schemas.ts:103`), and `validateEvent`
never inspects it. Compare `MessageControl`/`cacheServed` (`types.ts:214-247`), which carries
a sixteen-line rationale for an exploit where a sender set `payload:{cacheServed:true}` and
opened a pending request that never landed in a mailbox and never woke anyone — "a silent,
permanent stall from one key in free-form JSON." That produced `sanitizeAgentMessageInput`
and `RESERVED_PAYLOAD_KEYS` (`:249-272`). **`MeshEvent` got none of it.** The hole was
patched on one of the two envelopes.

`PROTOCOL_VERSION = "1.0"` (`types.ts:12`) is exported and never read. With
`additionalProperties:false` and optional-only evolution, a newer writer's event fails
validation on an older reader.

### 1.3 A log that cannot be followed

`packages/event-store/src/index.ts:22-45` — `EventStore` has **no subscription mechanism at
all**. Zero `subscribe`/`notify`/`EventEmitter`. `streamReplay` (`:374-377`) awaits a full
`read()` and then yields from a complete array: replay, not tail-follow.

`append()` mutates the in-memory cache and **returns before the disk write** (`:229-249`),
with fsync every 50 appends (`SYNC_EVERY = 50`, `:152`). A crash loses up to fifty events
that every in-process reader has already been told exist.

The one push path is unsafe for fan-out:

```ts
// packages/persistence/src/index.ts:698-719
static watchFile(file: string, onLine: (event: MeshEvent) => void): fs.FSWatcher { ... }
const watchOffset = new Map<string, number>();   // MODULE SCOPE, keyed by file path
```

Two subscribers on one log **share a cursor** — at-most-once delivery to one arbitrary
consumer. The offset is never reset when `reset()` truncates, so every post-reset event is
silently skipped. And the whole file is re-read and re-parsed on every change.

Single global monotonic `seq`, no partitions; `goalId`/`actorId`/`correlationId` are post-hoc
filter predicates, not stream keys. `MemoryEventStore.append` skips `validateEvent` while
`JsonlEventStore.append` enforces it (`:221-227`), so tests and production accept different
event sets.

### 1.4 Obligations are derived state, not the primary object

`MeshMessage` is the durable thing; `PendingRequest` (`packages/core/src/state.ts:81-111`) is
a projection over it. That inversion is the source of the entire stall-bug family. An ask has
`createdAt` and **no deadline**. It leaves the ledger by one of nine `DischargeReason`s
(`:33-57`), two of which mean *gone, not answered*: `deadlock_break` and `evicted_cap` —
and `evictOverflowingPendingRequests` (`:480-502`) discharges silently at the cap.

Default `bus.commitments.semantic: "compat"` (`packages/config/src/index.ts:150-164`) means
discharge can be **inferred by heuristic**. The config's own `"strict"` mode documents the
alternative: "a response without `replyTo` delivers content but discharges nothing." The
existence of `commitmentStats().inferredRatio` as a health signal concedes the point — there
is a metric for *how much of the mesh is running on guesswork*.

Meanwhile the docs record mail landing in a mailbox with nobody woken
(`docs/NOTES-session-handoff.md:141-146`) and orphaned mail for ~49 minutes (`:176-177`).
`docs/protocol.md:120` claims exactly-once; it is exactly-once *append* alongside
at-most-once *activation*.

---

## 2. Target architecture — agent ↔ agent

### 2.1 Interaction mode becomes a typed, priced field

Team Topologies' distinction is the one the product wants and does not encode. Today every
exchange is the same kind of thing and its blocking semantics are inferred from a string
prefix. Make the mode explicit and let it *determine* the semantics:

| mode | obligation | reply | cost |
|---|---|---|---|
| `service` | exactly one per recipient, with a mandatory deadline | typed, against a published contract | default |
| `collab` | none, but **time-boxed at open** and metered | free-form within the box | charged to a budget line; overrun raises a card |
| `broadcast` | none | **cannot be replied to** | wakes only declared interests |

`service` is the default and is X-as-a-Service: a narrow published contract, no ongoing
chatter. `collab` is still available — discovery genuinely needs it — but you cannot enter it
accidentally, and you cannot stay in it quietly. That is the whole "low contact" mechanism:
high-bandwidth interaction remains possible, becomes *declared*, and becomes *expensive*.

### 2.2 The commitment is the primary object

Invert the current design. The durable thing is the obligation; the message is a view of it.

```ts
interface Commitment {
  id: CommitmentId;
  episode: EpisodeId;          // which logical run — see §3.3
  mode: "service" | "collab";
  creditor: SeatId;            // who is owed
  debtor: SeatId;              // who owes — EXACTLY ONE. fan-out is N commitments.
  contract: ContractRef;       // named, versioned, schema'd — see §2.3
  request: unknown;            // validated against contract.request
  note?: string;               // prose. NEVER parsed by the mesh.
  opened: Timestamp;
  dueBy: Timestamp;            // MANDATORY
  escalatesTo?: SeatId;
  state: "open" | "accepted" | "fulfilled" | "refused" | "expired" | "withdrawn" | "void";
  settlement?: Settlement;
}
```

Four changes carry almost all the value:

1. **`dueBy` is mandatory.** Today the *absence* of a reply is not an event — it is discovered
   later by a watchdog, a nudge counter, or a human. With a mandatory deadline, silence
   becomes a scheduled, first-class, typed occurrence. This is the highest-value single change
   in the proposal, and it is what the long-carried "convergence service — deterministic
   who-owes-what nudger replacing the LLM stall watchdog"
   (`docs/NOTES-session-handoff.md:206-208`) has been trying to be. It falls out of the type
   instead of needing a service.

2. **`refused` is a settlement, not a failure.** `NOTES-confirm-hang.md`'s lesson — refusals
   must be durable facts — generalized. A debtor that will not or cannot do the thing settles
   with a reason drawn from the contract's closed `refusals` set, and the creditor is woken
   *with that reason*. Today a refusal is prose in a payload, or silence.

3. **One debtor per commitment, structurally.** Today `to[]` plus `outstanding[]` reconstructs
   this. `docs/protocol.md:82-99` already says "one ask to N agents is N obligations" — make
   the type say it.

4. **No `evicted_cap`.** At the cap you cannot *open* a new commitment. Backpressure at open
   time is loud and recoverable; eviction at overflow is silent and lossy.

### 2.3 Contracts replace the type-string vocabulary

Seven vocabulary members — `HANDOFF`, `MISSION`, `PROPOSE`, `COMMIT`, `ROLLBACK`, `WAIT`,
`DONE` — have **zero semantics in any file in the repo.** `requires[]`, `budgetHint` and `ttl`
are named and never specified. `ttl` is in the plan's envelope and absent from the shipped
one. This vocabulary cannot be learned, which is why `op-aliases.ts` exists.

Replace it with contracts a seat *publishes*:

```ts
interface Contract {
  name: string;          // "review.artifact"
  version: number;
  provider: RoleId;      // which role answers this
  request: JSONSchema;
  response: JSONSchema;
  refusals: string[];    // the closed set of legitimate "no"s
  slaMs: number;         // default dueBy
}
```

An agent no longer guesses between `REQUEST_REVIEW` and `REVIEW_REQUEST`. It asks what
`tech-lead` publishes and gets a typed list. This is X-as-a-Service made literal, and it also
shrinks the prompt: `NOTES-prompt-audit.md:5-11` found ~3.9k tokens of tool manifest per turn,
four times the role prompt, with ~38 `mesh_*` tools advertised to every seat. Under contracts a
seat's manifest is its own published contracts plus one generic `mesh.call(contract, request)`.

### 2.4 One envelope, and the mesh never derives authority from prose

Fold `MeshMessage` and `MeshEvent` into one frame with three separated layers:

- **`control`** — runtime-owned, closed union, sender cannot write it. The `cacheServed`
  hardening applied to *both* envelopes rather than one.
- **`body`** — discriminated by contract, validated against that contract's schema.
- **`note`** — prose. Never parsed. No op extraction, no discharge inference, no routing.

Today `parseMeshOps` extracts authority from reply *text*. That stays only as a compat path
behind `bus.transport: "mixed"`, and dies at Stage 4.

Add to the frame what routing actually needs and the current event envelope lacks: `episode`,
`partition`, `turn`, `to`, and a `correlationId` with a stated contract (or delete it — today
it is neither documented, produced, nor consumed).

### 2.5 Delivery: partition, subscribe, checkpoint

- **Partition key = `episode`** (one logical run of a goal). Order is guaranteed *within* a
  partition. Nobody needs cross-episode ordering, and demanding it globally is precisely what
  forces the single mutex.
- **`EventStore.subscribe(partition, fromSeq, handler)`** with a **per-subscriber** durable
  cursor. This alone fixes the shared-offset theft and the post-`reset()` blindness in
  `persistence:698-719`.
- **`append` is durable before it returns.** If per-append fsync is too slow, batch behind an
  explicit durability barrier — but never tell a reader an event exists before it survives a
  crash.
- **Emit does not await delivery.** Append, then return. Delivery runs on its own loop. A slow
  subscriber stops being able to backpressure an emitter.

---

## 3. Target architecture — agent ↔ its own future turns

The docs are thin here in a way that is worth naming: scope (a) has real invariants; scope (b)
is three paragraphs and a name. §29 Agent Context Construction
(`agent-mesh-runtime.md:1869-1903`) is **nine slot names and one prohibition** — no ordering,
no budget, no eviction, no definition of "relevant" or "recent", no overflow behaviour. L2
"Agent Memory — persistent summaries" is named twice (`:1795-1804`, `:2574`) and never
designed: no producer, trigger, schema, or consumer. Compaction appears exactly twice in the
whole doc set, both times as an *accident* of backend behaviour that happens to refresh a
stale system prompt. §64 Mission Recovery restores mesh state and says nothing about what the
model sees afterwards.

### 3.1 The two-memory problem

An agent has two memories with different owners and different lifetimes:

| | mesh context bundle | backend transcript |
|---|---|---|
| owner | the mesh | the Claude SDK process |
| built from | projections, every turn | accumulation, never rebuilt |
| bounded by | hard caps + degradation ladder | nothing |
| visible to the kernel | yes | **no** |
| ends by | being rebuilt | **being destroyed** |

`packages/runtime-claude/src/index.ts:674-686` — one long-lived `query()` per seat for its
whole lifetime; each turn pushes one user message and awaits the matching `result` frame. The
per-turn payload is a single opaque string (`:875-879`); `input.context` is never read by the
adapter. The system prompt is set once at session start (`:1238`), not per turn.

The only bound on transcript growth is `rotate()` (`:1124-1167`), and it is **destructive**: a
fresh `randomUUID()`, not a resume. Ratio 0.6, floor 120_000 (`:202`, `:211`, `:249-255`). The
rejected alternative is recorded at `NOTES-runtime-claude.md:113-118` — stateless per-turn
`query()` with `resume`, "simpler and crash-resilient, but guts `getStatus` and makes
`interrupt` awkward." That trade is defensible. What is not defensible is that the resulting
amnesia is unobserved: `onRotate` fires into nothing.

### 3.2 The continuity record

Make the agent write its own handoff *before* the cliff, and make the cliff an event.

```ts
interface ContinuityRecord {
  seat: SeatId;
  episode: EpisodeId;
  sessionOrdinal: number;                // 1, 2, 3… successive backend sessions for one seat
  writtenAt: Timestamp;
  reason: "rotation" | "restart" | "suspend" | "episode_boundary";

  openCommitments: CommitmentId[];       // DERIVED — the ledger already knows
  workingBeliefs: Belief[];              // AUTHORED — what it concluded, and on what basis
  rejected: RejectionNote[];             // what it tried that did NOT work, and who said no
  nextIntent: string;                    // one sentence: what it was about to do
}

interface Belief {
  claim: string;
  basis: ArtifactRef | CommitmentId | EventId;   // must cite. no free-floating beliefs.
  confidence: "asserted" | "assumed";
}

interface RejectionNote {
  what: ArtifactRef | string;
  rejectedBy: SeatId;
  reason: string;
  episode: EpisodeId;
}
```

Trigger sequence, replacing the silent teardown:

1. Adapter crosses the rotation threshold → emits `session.rotation_pending` as a real kernel
   event.
2. Scheduler grants the seat **one extra turn whose only sanctioned op is `write_continuity`**.
   Bounded and cheap.
3. The record is appended and projected.
4. Adapter rotates.
5. The successor session's first turn receives the record in **slot 1** of its bundle.
6. `session.rotated` carries `{ from, to, sessionOrdinal, continuityRecordId,
   transcriptTokensDiscarded }`.

This is L2 with a producer, a trigger, a schema and a consumer, and it is what the
carried-over "meta-session digest (`packages/core/src/context.ts` bundle)" item has been
gesturing at for two sessions.

### 3.3 Episode stamping — generalizing the reopen-loop fix

The reopen-loop bug is the most instructive thing in the repo's history. A `goal.reopened`
boundary carried the *artifacts* forward but not the *judgment* of them. Agents could not
distinguish "work I already did and got rejected" from "work I did in answer to the
rejection," so they re-cited it and the runtime believed them — an infinite loop rather than a
stall. It was patched with two ad-hoc stamps: `rejectedEvidence[]` (identity-side) and
`reopenedAt` (time-side).

Generalize the move: **every fact that crosses an episode boundary carries the episode it was
judged in.** That is `episode` on `Commitment`, on `RejectionNote`, and on `Belief.basis`.
Then "is this fact from the run that already failed?" is a field lookup rather than a bug
class. It also fixes the adjacent leak — scheduler strikes, nudge counts, denied counts and
backoff parking all currently survive a reopen, so a fresh logical episode inherits stale
per-agent penalty counters.

### 3.4 Context assembly becomes typed, budgeted, and logged

`buildAgentContext` (`packages/core/src/context.ts:135-365`) already has hard caps
(`MAX_UNREAD` 12, `MAX_DECISIONS` 10) and a degradation ladder. In other words, the
implementation invented the policy §29 never specified — and nobody can see it. Sub-turn
detail is live-only and **"absent for turns reconstructed purely from the log"**
(`packages/observability/src/steps.ts:25-29`).

Make it `assemble(seat, episode, budget) → { bundle, manifest }`, and **log the manifest**:

```ts
interface ContextManifest {
  turn: TurnId;
  budgetTokens: number;
  slots: Array<{
    slot: "continuity" | "commitments" | "mission" | "policy" | "task"
        | "decisions" | "artifacts" | "mail" | "own_activity";
    admitted: number;     // items that went in
    dropped: number;      // items that were eligible and did not fit
    tokens: number;
  }>;
  degradedTo?: "normal" | "tight" | "minimal";
}
```

Two properties the system currently cannot have:

- **"Why didn't the agent know X?" becomes answerable** from the log alone.
- **Slot order is a declared priority**, so eviction is principled rather than emergent —
  continuity first, then open commitments, then task; mail and own-activity drop first. And a
  *recorded* drop can be re-offered next turn instead of vanishing.

---

## 4. What this buys, against the brief

**Async.** Silence acquires a type (`expired`). Emit stops awaiting delivery. Subscribers stop
sharing cursors. Rotation stops being invisible. The mesh's three worst failure modes —
stalled ask, orphaned mail, silent amnesia — all become events that a deterministic loop can
act on without an LLM watchdog.

**Low contact.** `service` is the default and carries a narrow published contract; `collab`
is possible but declared, time-boxed and metered. Prose stops being load-bearing: the mesh
never derives authority from text, so an agent's wording cannot change what the system does.

**Quality.** Vocabulary becomes discoverable instead of memorized, which retires the
`op-aliases.ts` failure class. Refusals become durable facts. Beliefs must cite a basis.
Facts crossing an episode boundary carry their judgment with them.

---

## 5. Staged migration

Each stage is independently shippable and useful alone. Risk ascends; agent-facing churn is
deferred as late as possible.

**Stage 0 — see it. (no behaviour change)**
Emit `session.rotated` and `session.rotation_pending`. Consume `LiveSession.mcpStatus` — the
mute-seat detector is already built and nothing reads it, on a path flagged "if it does not
survive, agents go mute." Log the context manifest. Purely additive; no kill criterion.

**Stage 1 — durable delivery. (invisible to agents)**
Per-subscriber cursors in `watchFile`. `append` durable before return. `subscribe` on
`EventStore`. `MemoryEventStore` validates like `JsonlEventStore`.
*Kill criterion:* if per-append fsync costs too much, batch behind an explicit durability
barrier — do not revert to blind `SYNC_EVERY`.

**Stage 2 — deadlines and refusals. (mechanism, not vocabulary)**
Mandatory `dueBy` with a per-role default. The `expired` settlement and its timer. `refused`
as a first-class settlement. Flip `bus.commitments.semantic` from `"compat"` to `"strict"` —
the knob already exists, so this is a default change, not new code. Replace cap-eviction with
refusal-to-open.
*Kill criterion:* watch `inferredRatio`. If it will not go to zero, the vocabulary is wrong
rather than the semantics — which is the signal to pull Stage 4 forward.

**Stage 3 — continuity records. (the scope-(b) payoff)**
Schema, the `write_continuity` turn, slot-1 injection, episode stamping. Independent of
Stages 1–2; could ship first if scope (b) is the priority.

**Stage 4 — contracts replace type strings. (largest agent-facing change)**
Behind `bus.transport: "typed-only"` — also an existing knob. `op-aliases.ts` becomes
deletable. Ship the `mesh.contracts(role)` discovery tool *in the same change*, or this
reproduces the alias problem in a new vocabulary.

**Stage 5 — partition the log, drop the global mutex. (highest risk, lowest urgency)**
~~Requires breaking the `Kernel.state` aliasing first, which is the real work.~~
**Answered by measurement — not built.** The chain costs ~8.4 µs/emit and is 65% synchronous
CPU, giving ~119,000 events/sec against a real load of single-digit events/sec: ~0.01%
utilisation, so there is no bottleneck to relieve. Partitioning would also break the global
monotonic `seq` the kernel depends on for the snapshot cut and every downstream cursor —
including a **silent** drop via `INSERT OR IGNORE` on a `seq INTEGER PRIMARY KEY` index. And
the premise above was backwards: the `Kernel.state` aliasing is load-bearing by design (the
scheduler captures it by reference), not an accident to be broken. Full evidence, the
five breakages, and the conditions for revisiting are in the TODO's Stage 5 section.

---

## 6. Deliberately not doing

- **Agent ↔ human**, and prose style. Out of scope by your answer.
- **A general conversation firewall.** `agent-mesh-runtime.md:1518-1543` already ruled this
  out for v1 and the reasoning holds: police objectively-observable predicates, not content.
- **Anything on the explicitly-closed list** in the handoff docs: waking human mail on a
  stopped scheduler, `hasClaudeCli()` preflight, the `actions.ts:123` truthiness check,
  re-adding boot advisors locally, making `escalate` halt the mission.
- **Switching to stateless per-turn `query()` with `resume`.** It was considered and rejected
  for real reasons (`NOTES-runtime-claude.md:113-118`). The continuity record gets most of the
  benefit without giving up `getStatus` and `interrupt`.

## 7. The risk in this proposal

Stage 4 is the one I would push back on my own design for. The system has hard evidence that
agents fail at vocabulary — `op-aliases.ts` exists, and one agent burned 18 turns on `RESULT`.
Contracts are a *larger* vocabulary surface, and if discovery is not shipped simultaneously,
Stage 4 makes that failure mode worse rather than better. Stages 0–3 carry most of the value
and none of that risk; treat Stage 4 as gated on the Stage 2 `inferredRatio` signal rather
than as automatic.
