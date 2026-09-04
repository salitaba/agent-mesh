# Agent Mesh — Architecture

## The idea

This is a runtime for **persistent AI organizations**, not a linear agent
pipeline. An agent is a seat in an org:

```
Agent = Role + Persistent Session + Capabilities + Authority
      + Relationships + Memory + Lifecycle + Delegation Policy
```

Workflows are **not predefined**. A goal seeds an initial state; agents wake on
events they care about, act through typed messages and artifacts, and the mesh
converges (or escalates). The runtime, not the prompt, is authoritative.

## Five planes

```
USER / CLI / UI
      │
      ▼
MESH KERNEL            packages/core      (goal, registry, lifecycle, budgets,
                                          termination, deadlock, recovery,
                                          projections, context construction)
      │  collaboration events
      ▼
COLLABORATION BUS      packages/protocol + packages/policy-engine +
                       packages/scheduler  (typed messages, threads, mailboxes,
                                            interests, policy, activation)
      │                         │
      ▼                         ▼
AGENT RUNTIMES         ARTIFACT PLANE
packages/agent-runtime packages/artifact-store
  opencode / http /    git worktrees +
  stub                 immutable versions
      │                         │
      └───────────┬─────────────┘
                  ▼
EVENT LEDGER       packages/event-store + packages/persistence
append-only log → projections → replay → audit → cost → metrics
```

## Layered enforcement (why prompts are not the contract)

1. **Prompt awareness** (`context.ts`) — the agent is told the rules. Not trusted.
2. **Tool/capability enforcement** (`policy-engine`, `agent-runtime` config) —
   an agent without `git.merge` cannot invoke the merge tool. OpenCode adapter
   writes per-agent `permission` blocks and only mounts the mesh MCP server.
3. **Mesh policy enforcement** (`policy-engine` via the bus) — illegal
   `APPROVE`/`COMMIT`/`DELEGATE`/`BLOCK` are rejected before they become events.
4. **State-transition enforcement** (`core/projections.ts`) — even a rogue event
   cannot force an artifact into an illegal state. The projection reducer throws
   and the kernel refuses to append it. This is the strongest layer.

## Event sourcing

Every mutation emits a canonical event (catalog in
`schemas/event.schema.json`). State is a fold over events
(`Kernel.emit` → `applyEvent` → projections). The event log is the source of
truth; projections are cache; `replay()` rebuilds state with zero LLM calls.

## Key invariants (tested in `tests/`)

Agents talk only through the mesh · policy is evaluated before commit ·
transitions need evidence · one writer per artifact · process death ≠ identity
loss · replay is equivalent · activation is event-driven · transcripts are not
auto-shared · human escalation is a protocol event · completion needs evidence ·
budgets are runtime-enforced · security is capability-based · OpenCode is an
adapter · protocol is vendor-independent.

## Single writer & git worktrees

An artifact has exactly one owner at a time. Writing agents each get a
`git worktree` (`artifact-store/GitWorkspace`); the runtime tracks
`WorkspaceLease`s and refuses a second live lease. Reviews propose and approve
across branches; only `git.merge` authority merges to main.

## Delegation & fractal (depth-1)

`DELEGATE`/`REQUEST_EXECUTION` hand work peer-to-peer (v1, depth 0). A parent
with `delegation.max_depth ≥ 1` may spawn ephemeral workers; the parent receives
only the **structured result contract** (`status, summary, artifacts, findings,
risks, recommendation`) — never the worker transcript. Workers are torn down
after submitting.
