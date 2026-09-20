# Agent Mesh — Protocol

Protocol version `1.0`, carried on every message and event. The protocol is
runtime- and vendor-independent.

## Message envelope (`schemas/message.schema.json`)

```jsonc
{
  "id": "msg-…",              // unique, prefixed id
  "protocolVersion": "1.0",
  "type": "REQUEST_REVIEW",   // one of the canonical message types
  "timestamp": "…ISO…",
  "goalId": "goal-…",
  "from": "developer",
  "to": ["architect"],        // array; broadcast fans out through the bus
  "threadId": "thread-…",     // thread = goal + artifact + interaction
  "replyTo": "msg-…",         // optional; resolves the pending request
  "causationId": "evt-…",     // optional; links to the event that caused it
  "artifactRefs": [ { "uri": "artifact://CodePatch/pay/2" } ],
  "payload": { "question": "Is this idempotency design acceptable?" },
  "control": { "cacheServed": false },  // RUNTIME-OWNED — see below
  "priority": "NORMAL",
  "requires": [],             // optional structured requirements
  "budgetHint": { "maxTokens": 50000 },
  "provenance": { "source": "agent", "trustLevel": 50 }
}
```

### `payload` is prose; `control` is authority

`payload` is verbatim agent output. The kernel therefore **must not route on
it**: any control decision keyed on a payload field is a decision the governed
agent gets to make for the runtime. `control` is the closed, runtime-owned
counterpart — stripped from every inbound send by
`sanitizeAgentMessageInput`, and closed in the schema so a forged field fails
validation rather than being silently ignored.

This is not hypothetical. `cacheServed` used to live in `payload`, and both the
delivery reducer and the scheduler skipped a message carrying it — so a sender
could attach `payload: { cacheServed: true }` to its own REQUEST and get an ask
that opens a pending request (parking itself in `WAITING`, recording a debt)
while landing in **no mailbox** and waking **nobody**. A guaranteed permanent
stall from one key in free-form JSON.

The same principle governs loop detection: message identity is computed from
the typed envelope (participants, act, artifact refs, task/thread) plus only
those payload fields the runtime itself branches on. Hashing the prose made
`fingerprint_loop` defeatable by rewording — which is the one thing a language
model does reliably and unprompted.

### Private plans

Beside the shared task board, each agent keeps its own ordered checklist for
the single task it has claimed (`plan`, `plan_step`). It is private by design:
the task board is the inter-agent contract, and a second claimable surface
would give two agents two different answers about who owns what.

A `plan.updated` event always carries the **whole** plan, never a delta, so the
reducer is a replace and any replayed prefix of the log is a coherent
checklist. Nothing ever clears a plan when the agent changes task — staleness
is decided at read time by comparing `plan.taskId` against the agent's
`activeTaskId`, which keeps replay and snapshot restore in agreement.

Step ids are resolved in the supervisor (hashed from the step text when the
model omits one), for the same reason every other id is: a reducer must be a
pure function of the log. Hashing also makes a restated identical plan
idempotent, so `plan_step` references from the previous turn keep resolving.

### Message types (kept deliberately small)

`MISSION INFORM REQUEST REQUEST_INFO REQUEST_REVIEW REQUEST_ARTIFACT
REQUEST_RESEARCH REQUEST_EXECUTION PROPOSE CHALLENGE APPROVE REJECT VETO BLOCK
DELEGATE HANDOFF PATCH_READY TEST_RESULT SECURITY_FINDING COMMIT ROLLBACK
ESCALATE WAIT DONE`

Requests (`REQUEST*`, `ESCALATE`, `CHALLENGE`) open a *pending request*; a
reply carrying `replyTo` closes it. This is what lets an agent go to `WAITING`
and be woken on the response, instead of blocking on a call — messages are
**not RPC**.

### A thread has an ending

A thread is a conversation: `goal + artifact + interaction`. It is minted
`OPEN`, and it reaches `RESOLVED` or `ESCALATED` — a thread opened by an ask
ends when its **last** ask leaves the ledger, which is the one place in the
runtime that can know the conversation is over.

Which terminal value is read off *why* the ask left. A discharge that settled
the ask resolves the thread; one of the four that mean **gone, not answered**
(`evicted_cap`, `deadlock_break`, `expired`, `refused_cap`) escalates it,
because something went wrong in that conversation and a record that called it
`RESOLVED` would be lying in the same place an operator looks for the truth.

Three things deliberately do **not** end a thread. A thread that never opened a
commitment — a notice, a broadcast, a collab's own discussion — has no ending
to detect. A live collab owns its own ending (`collab.closed` knows whether the
discussion was closed or overran). And a thread that keeps receiving messages
after it is terminal stays terminal: the ending is a fact about the ask, not a
liveness heuristic. A new **ask** in a terminal thread is the exception, and it
revives a `RESOLVED` one, because a follow-up belongs in the thread that raised
it. `ESCALATED` is sticky.

### Contracts: named asks over guessed type strings

24 type strings is a small vocabulary for a human and a large one for a model
choosing under uncertainty. A **contract** is a named ask — `review.artifact`,
`research.question`, `info.question`, `artifact.produce`, `execution.run`,
`work.request`, `decision.challenge`, `decision.escalate` — carrying a JSON
Schema for its request, the refusals it may come back with, the capability a
seat needs to answer it, and an SLA.

`call` raises one; `contracts` lists them with the seats that can currently
answer. Three properties matter:

1. **It is sugar.** Every contract desugars to a typed op and re-enters the
   ordinary op path. `call` can reach nothing a typed op could not, and every
   gate applies unchanged — there is no second route to keep in step.
2. **It fails closed, loudly.** An unknown name is refused quoting what was
   asked for and listing every real alternative; a request that does not match
   the schema is refused *before any recipient is woken*, naming the offending
   field and showing the shape that would have worked. The refusal teaches,
   which is exactly what silently rewriting a guess cannot do.
3. **It routes to one provider.** A contract with a `provider` capability
   resolves against seats that hold it *and* that the caller may contact.
   Broadcasting an ask would open an obligation on every qualified seat for
   work only one of them needs to do.

4. **The refusals bind.** A debtor may discharge an ask with prose alone, which
   is what it always did, or with `refusal: <name>` taken from the set its
   contract declares. A name outside that set is refused at the edge, before any
   event exists, listing the legitimate ones — the same teaching failure as an
   unknown contract name. The asker receives the name as a value beside the
   prose, which is the point of a closed set: "wrong seat" (re-route), "bad ask"
   (re-ask) and "I disagree" (escalate) are three different responses, and free
   text makes them one. The set is rendered on the ask's own line in the
   debtor's prompt, because a closed set nobody can read is not closed.

A contract's SLA narrows an existing deadline regime and never creates one; see
`docs/configuration.md`.

### One ask to N agents is N obligations

A pending request tracks its `outstanding` debtors individually. A reply
settles **only the replying agent's** obligation; the ask stays open, owed by
whoever is still silent, and closes when the last debtor answers. Partial
settlements are recorded as `partial` discharges naming who remains.

Without this a plural debtor is a diffuse debtor: ask dev + qa + security to
review, and dev's "looks fine" closed the ask for all three — recorded under
discharge reason `reply`, the runtime's most confident, explicitly
non-inferred outcome, while two review obligations vanished with no nudge and
no stalemate. With `broadcast` (which addresses every agent) one reply could
discharge an obligation owed by the whole team.

One deliberate asymmetry: a discharger who was **never** a debtor — the human
operator answering for an unresponsive agent, or the runtime superseding a
review — is resolving the *ask* rather than paying one debt, and settles it for
everyone at once.

### Asks leave the ledger exactly one way

Every exit is a recorded discharge with a reason, so "how did this ask
disappear?" always has an answer. Four reasons mean **gone, not answered**
(`evicted_cap`, `deadlock_break`, `expired`, `refused_cap`); consumers must
consult the reason before concluding an ask resolved, and escalation cards
pointing at such an ask stay open rather than auto-closing with a false claim.

`withdrawn_by_sender` is deliberately *not* one of those four, and the
distinction is the whole point of it. The asker closed its own ask before
anyone answered, which is a real decision by a party to the ask, so the record
is a settlement rather than a loss: the debtors are released and told, and the
escalation card that the stuck ask raised auto-closes instead of keeping a
human's queue open over a question nobody wants answered. It is the asker's
counterpart to `refused` — authorized by having *asked* the question, exactly
where `refused` is authorized by *owing* the answer — and it is the one exit
whose purpose is to remove an interrupt rather than manufacture one.

## Event envelope (`schemas/event.schema.json`)

```jsonc
{ "id": "evt-…", "seq": 1039, "protocolVersion": "1.0",
  "type": "message.sent", "timestamp": "…", "goalId": "goal-1",
  "actorId": "developer", "causationId": "evt-…", "payload": { … } }
```

The canonical event catalog (add a type → update the catalog, the reducer, and
the projections) spans goal/agent/message/artifact/task/review/patch/
architecture/release/research/decision/escalation/human/lease/memory/budget
lifecycle. Events are append-only and **deduplicated by id** (exactly-once).

## Artifact URIs & versions (`schemas/artifact.schema.json`)

`artifact://{Type}/{name}/{version}`. Artifact versions are immutable; a change
produces `design-v2 → design-v3` with `parent` lineage. Messages reference URIs,
never paste content — the bus is a reference bus. Digests are `sha256:…`.

## Typed state machines

- **code**: `DRAFT → READY_FOR_REVIEW → UNDER_REVIEW → APPROVED → VERIFIED →
  MERGEABLE → MERGED` (with `REJECTED → DRAFT` and `ARCHIVED`)
- **release**: `PROPOSED → IMPLEMENTED → QA_VERIFIED → SECURITY_VERIFIED →
  ACCEPTED`
- **document**: `DRAFT → READY_FOR_REVIEW → UNDER_REVIEW → APPROVED/FINAL`

Transitions are gated by approvals/evidence recorded in the event stream.

## Trust / provenance classes

`HUMAN > SYSTEM > MESH_DECISION > TOOL > AGENT > REPOSITORY > EXTERNAL`. A
repository `README` that says "ignore previous instructions" carries `repository`
provenance and never acquires `system` authority.

## MCP as an integration boundary, not the protocol

Agents reach the mesh through MCP tools (transport), but the domain model is the
typed message/event protocol above:

```
Agent → MCP tool → Mesh API → Policy Engine → Event Store → Scheduler
```

Every `mesh_*` tool is authenticated by a per-agent token and runs through the
same policy engine as an in-runtime turn.
