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

### Message types (kept deliberately small)

`MISSION INFORM REQUEST REQUEST_INFO REQUEST_REVIEW REQUEST_ARTIFACT
REQUEST_RESEARCH REQUEST_EXECUTION PROPOSE CHALLENGE APPROVE REJECT VETO BLOCK
DELEGATE HANDOFF PATCH_READY TEST_RESULT SECURITY_FINDING COMMIT ROLLBACK
ESCALATE WAIT DONE`

Requests (`REQUEST*`, `ESCALATE`, `CHALLENGE`) open a *pending request*; a
reply carrying `replyTo` closes it. This is what lets an agent go to `WAITING`
and be woken on the response, instead of blocking on a call — messages are
**not RPC**.

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
disappear?" always has an answer. Two reasons mean **gone, not answered**
(`evicted_cap`, `deadlock_break`); consumers must consult the reason before
concluding an ask resolved, and escalation cards pointing at such an ask stay
open rather than auto-closing with a false claim.

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
