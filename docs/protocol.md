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
  "priority": "NORMAL",
  "requires": [],             // optional structured requirements
  "budgetHint": { "maxTokens": 50000 },
  "provenance": { "source": "agent", "trustLevel": 50 }
}
```

### Message types (kept deliberately small)

`MISSION INFORM REQUEST REQUEST_INFO REQUEST_REVIEW REQUEST_ARTIFACT
REQUEST_RESEARCH REQUEST_EXECUTION PROPOSE CHALLENGE APPROVE REJECT VETO BLOCK
DELEGATE HANDOFF PATCH_READY TEST_RESULT SECURITY_FINDING COMMIT ROLLBACK
ESCALATE WAIT DONE`

Requests (`REQUEST*`, `ESCALATE`, `CHALLENGE`) open a *pending request*; a
reply carrying `replyTo` closes it. This is what lets an agent go to `WAITING`
and be woken on the response, instead of blocking on a call — messages are
**not RPC**.

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
