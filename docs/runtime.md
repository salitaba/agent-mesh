# Agent Mesh — Runtime & Runtimes Adapters

## The supervisor pump

`packages/core/supervisor.ts` is deliberately thin: it owns process lifecycle,
scheduling, policy, budgets, termination, recovery, and event persistence — it
never makes architecture or implementation decisions. Each event drives:

```
event → interest match → policy → activation → runTurn → ops → new events
```

A single `runTurn`:

1. reserve agent + thread token budget (`budget.reserved`)
2. `agent.awakened` → `OBSERVING`
3. ensure the runtime session (start or **restore** the persistent session id)
4. build the agent context (§29) — **never** the whole transcript
5. deliver queued mail (`message.delivered`)
6. `THINKING` → call the runtime adapter with a turn timeout
7. apply the returned **mesh operations** (each re-checked by policy)
8. consume budget (`budget.consumed`, with model/tool-call audit for replay)
9. derive the end lifecycle (`WAITING` if it has an outstanding request, else
   `IDLE`/`BLOCKED`)

Every turn's inputs/outputs/model/tokens are appended to `turn-audit.jsonl` so
the **orchestration** layer is deterministic and replayable even though the LLM
is not (§41).

## Runtime adapter interface

```ts
interface AgentRuntime {
  start(agent, ctx): Promise<AgentSession>
  send(session, input): Promise<AgentOutput>   // AgentOutput.operations: MeshOp[]
  interrupt(s) suspend(s) resume(s) stop(s) getStatus(s)
  restoreSession?(agent, sessionId, ctx)       // persistent session across crash
}
```

`AgentOutput.operations` is the vendor-neutral contract: an adapter only needs
to produce typed mesh ops. This is how OpenCode, Claude Code, Codex, custom HTTP
agents, and future A2A agents all plug in without touching the domain model.

### `runtime-opencode`
- writes a per-agent OpenCode config (`opencode.json`) under the agent workspace
  with: `instructions` pointing at the role prompt (absolute path), the **mesh
  MCP server** (`type: "local"`, spawned via `mesh mcp`, bus URL/agent id/token
  passed through `environment`), and a `permission` block derived from the
  agent's capabilities (`edit`/`bash`/`webfetch`/`read`)
- spawns `opencode serve --port … --hostname 127.0.0.1` with the agent's
  workspace as `cwd` and the per-agent file injected via `OPENCODE_CONFIG`
  (documented custom-config path); health-gates on `GET /global/health`
- creates a session per agent (`POST /session`), sends each activation as
  `POST /session/:id/message` with `{parts, system, model}`, aborts via
  `POST /session/:id/abort`, restores by `GET /session/:id`
- parses `mesh-json` op blocks from the assistant text into `MeshOp[]`; token
  accounting reads `info.tokens.{input,output,reasoning,cache}` from the
  assistant message
- reports `UNREACHABLE` on process death (the recovery manager then restarts with
  `restoreSession`)

Note: OpenCode registers MCP tools with the server name as a prefix, so the bus
tools surface to the model as `mesh_mesh_send`, `mesh_mesh_approve`, … (server
`mesh`). Agents are told to look for `mesh_*`.

### `runtime-http`
- generic custom/remote agents over `POST /sessions`, `/turn`, `/interrupt`, …
- used to attach Claude/Codex/A2A behind an HTTP shim

### `agent-runtime` `StubRuntime`
- deterministic scripted agents; powers the unit/integration tests, the
  simulation engine, and the token-free `mesh bench` comparison

## Recovery & replacement

A crash emits `agent.failed`; the logical identity, session pointer, active task
and artifacts survive. On restart the runtime re-activates the agent with a
`recovery` reason and rebuilds context from the projections (never from lost
process memory). After N failed restarts the mesh escalates `runtime_failure`.
A worker instance can be replaced (new `runtime session`) while the organizational
role, authority, task, artifacts and threads are inherited (§50–51).

## Termination & deadlock

Termination manager (§33): success (all mandatory criteria evidenced), budget,
wall-clock, `max_events`, stalemate and runtime failure → `COMPLETED`/`ESCALATED`
/`FAILED`. Deadlock detector (§34): thread-depth, repeated-conflict fingerprint,
and review-round overflow generate a `DisagreementRecord` artifact (positions,
evidence, attempts) and raise a human `ESCALATE`.

## State & persistence

Local v1: `events.jsonl` (canonical, append-only) + JSON snapshots + filesystem
artifacts + git worktrees, with an optional `node:sqlite` event index. The
architecture keeps no authoritative state in process memory, so the same kernel
can later run against PostgreSQL + object storage + a distributed bus without
changing the protocol.

## CLI / server / dashboard

- `mesh run mesh.yaml` boots the supervisor, starts the HTTP/SSE server and (on a
  TTY) the TUI. `mesh ui mesh.yaml` (or `run --ui-only`) serves the same
  dashboard/API with the scheduler **parked**: no startup, interest or timer
  cascades run on their own. Operator actions still work — a manual *wake* runs
  exactly one turn (step the mesh agent by agent), messages queue into mailboxes,
  and `POST /mission/start` (the ▶ button) flips the console live in place.
  `mesh status|graph|events|agents|inspect|replay|pause|resume|approve|reject|respond|artifacts|budgets|escalations`
  talk to `/api`.
- `mesh init` detects whether the `opencode` CLI is on PATH and templates
  `runtime: default: stub` when it is not; `mesh run` preflights opencode-based
  configs and prints guidance instead of crashing.
- `mesh emit-schemas` regenerates `schemas/*.json` from the code (single source).
- `mesh bench` runs the mesh-vs-single comparison across the A–F corpus.
- `mesh mcp` is the internal stdio↔HTTP bridge spawned by OpenCode.
- The dashboard (`apps/mesh-dashboard`) renders five views from the same event
  projections: mesh graph, goal progress, artifact timeline, cost, live event
  stream (SSE) — the UI holds no separate state.
