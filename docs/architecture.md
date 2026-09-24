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
  claude / http /      git worktrees +
  stub / none          immutable versions
      │                         │
      └───────────┬─────────────┘
                  ▼
EVENT LEDGER       packages/event-store + packages/persistence
append-only log → projections → replay → audit → cost → metrics
```

## Layered enforcement (why prompts are not the contract)

1. **Prompt awareness** (`context.ts`) — the agent is told the rules. Not trusted.
2. **Tool/capability enforcement** (`policy-engine`, plus each adapter's own
   tool gate) — an agent without `git.merge` cannot invoke the merge tool.
   Illegal `APPROVE`/`COMMIT`/`DELEGATE`/`BLOCK` are stopped **here**, on the
   op, by `evaluateAuthority`/`evaluateCapability` (`recordDecision`, `opCommit`,
   `opMerge`, `opDelegate`) before any message is sent. Each adapter enforces
   capability in its own idiom: `runtime-claude` installs a `canUseTool`
   permission gate that allows the `mcp__mesh*` tools and read tools, denies
   edit/exec/network without the matching capability, and fails closed on any
   tool it does not map; `runtime-http` and the `stub` runtime have no tool gate
   of their own — their ops are executed by the kernel through that same op path,
   so the same checks apply. Any `mesh_*` call a seat makes, including one from
   an out-of-process agent, arrives at the MCP bridge, where the policy engine
   authenticates it.
   Registered runtimes are `claude`, `stub` and `none` (the human seat's
   placeholder), plus `http` when a URL is configured — see `docs/runtime.md`.
   The OpenCode backend was removed; no registered runtime reads an
   `opencode.json` or writes per-agent `permission` blocks any more.
3. **Mesh policy enforcement** (`policy-engine` via the bus) — the communication
   matrix: who may *initiate* contact with whom (`policies.communication`),
   plus any operator `policies.rules` that deny or escalate. It does **not**
   gate on message type — `evaluateMessage` reads `message.type` only to feed
   optional custom `RawPolicyRules`. A raw `BLOCK` that skips the op path is not
   rejected here either: the reducer refuses to record it and the sender is told
   its objection was delivered as a concern that withholds nothing.
4. **State-transition enforcement** (`core/projections.ts`) — even a rogue event
   cannot force an artifact into an illegal state. The projection reducer throws
   and the kernel refuses to append it. This is the strongest layer.

### Corollary: the kernel never decides on prose

Layers 2–4 are only as strong as the fields they read. `MeshMessage.payload` is
verbatim agent output, so **no routing, delivery, activation or loop decision
may be keyed on it** — otherwise the governed agent writes the rule that
governs it. Runtime-owned control lives in `MeshMessage.control`, which is
stripped from agent input and closed in the schema. See `docs/protocol.md`.

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
budgets are runtime-enforced · security is capability-based · the agent runtime
is an adapter · protocol is vendor-independent · the kernel decides on typed fields,
never on prose · an ask to N agents is N obligations · an ask leaves the ledger
only through a recorded discharge · "gone" is never reported as "answered".

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
