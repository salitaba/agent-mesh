# Agent Mesh — Configuration (`mesh.yaml`)

Validated by `packages/config` against `schemas/mesh.schema.json` (Ajv 2020-12)
plus cross-field checks (unknown agents in `startup`/`may_contact`/`budgets`,
missing prompt files, malformed interest patterns). Run `mesh validate
mesh.yaml`.

```yaml
version: 1
mesh:
  id: payment-api-team
  name: Payment API Engineering Team
  goal: |
    Build a production-ready payment API using Spring Boot.
  acceptance_criteria:              # optional; else defaults are used,
    - { id: architecture-approved, description: "…", mandatory: true }   # and PM
    - { id: implementation-merged, description: "…", mandatory: true }   # can add more
  # generate_acceptance_criteria: true # instead of declaring criteria, derive
                                       # them from `goal` (default false). Ignored
                                       # when `acceptance_criteria` is set above.
  workspace: { path: ./workspace }
  runtime:   { default: claude }    # + optional model: provider/model for the whole mesh.
                                     #   `variant` is inert here — see the note under agents.
  defaults:                         # mesh-wide session/delegation defaults every agent inherits
    session:    { persistent: true, max_context_tokens: 120000 }
    delegation: { allow: false, max_depth: 1, max_workers: 2, worker_budget_tokens: 60000 }
startup:
  activate: [pm, architect]         # not every agent — config-selected
```

`mesh.generate_acceptance_criteria` asks the model to derive acceptance criteria
from `mesh.goal` at boot, for missions that declare none. It is off by default
because it puts a model call in the boot path, and a mesh that already declares
its criteria should not start behaving differently because the feature exists.
Declared `acceptance_criteria` always win; generation is only consulted when
they are absent. If the model is unreachable or answers unusably the mission
falls back to the built-in defaults and starts anyway — generation can improve
the criteria a mission runs on, but never prevents one from starting. What it
produces is one model's reading of a single paragraph of prose, and every agent
reads that list on every turn, which is why generated criteria get a review hold
and the other two sources do not.

A mission that boots on **generated** criteria starts held: the goal is paused
with the reason "acceptance criteria were generated from the goal — review them,
then resume the mission to start work", and no agent is woken. Review the list
and resume to begin — `mesh resume`, or the dashboard's unpause button (`r`).
The hold exists because the criteria are the completion gate, so running against
an unreviewed list means every agent works toward a definition of done nobody
agreed to. Declared and built-in-default criteria are never held: the operator
wrote one, the other is fixed and reviewable in the source.

`mesh.defaults.session` / `mesh.defaults.delegation` take the same keys as the
per-agent blocks below and set them once for the whole mesh. Each of the six keys
resolves as **per-agent value → `mesh.defaults` value → built-in fallback**
(`persistent: true`, `allow: false`, `max_depth: 0`, `max_workers: 0`, both token
caps unset). "Inherit" means the key is *absent*, so an agent that explicitly writes
`allow: false` or `max_depth: 0` keeps it even when the mesh default is higher —
`false` and `0` are opt-outs, never "unset". Every field is optional at both levels.

> **`max_context_tokens` is accepted and resolved, but nothing enforces it yet.**
> No runtime currently truncates or compacts a session on it, at either level —
> setting it changes what the config reports, not how agents run. The other five
> keys are enforced. Note that `delegation.allow` and `max_depth` only take effect
> alongside `max_workers: ≥ 1`; the supervisor denies `spawn_worker` when the
> worker cap is 0.

## agents

```yaml
agents:
  developer:
    role: developer
    runtime: claude                  # registered: claude | stub | none
    model: provider/model            # optional; blank = mesh.runtime.model, then backend default
    variant: high                    # inert: opencode's thinking knob, read by no registered runtime,
                                     #   and it does NOT inherit mesh.runtime.variant — setting it warns.
    mode: peer                       # peer | service
    prompt: ./roles/developer.md
    capabilities: [repository.read, repository.write, git.commit, test.execute]
    authority:    []                 # e.g. architecture.approve, quality.block
    interests:    [architecture.approved, review.rejected]   # wake-on-interest
    session:      { persistent: true, max_context_tokens: 120000 }  # omit a key to inherit mesh.defaults.session
    delegation:   { allow: true, max_depth: 1, max_workers: 2, worker_budget_tokens: 60000 }  # ditto mesh.defaults.delegation
    budget:       { tokens: 700000, wall_clock_minutes: 30, max_events: 2000, max_activations: 40 }
```

- `mode: service` (e.g. explorer) → activates **only** on requests, read-only,
  short context, separate concurrency pool, and its answers are cached by
  `metadata.questionHash`.
- `interests` are dotted patterns; `architecture.*` matches `architecture.approved`
  but not bare `architecture`. Non-wildcard interests must be canonical event types.

## policies

```yaml
policies:
  communication:                       # may_contact restricts INITIATING a thread;
    architect: { may_contact: [developer, tech-lead, explorer, pm] }
    # replies inside an existing thread are ALWAYS allowed (else no one could answer)
  transitions:                         # declarative gates (P5)
    implementation.completed: { requires: [tech-lead.approve, qa.pass] }
    release.accepted:         { requires: [qa.pass, security.pass] }
    patch.merge:              { requires: [tech-lead.approve] }
  escalation:
    thread: { max_depth: 8 }
    repeated_conflict: { threshold: 3 }
    artifact_review_rounds: { max: 5 }
  rules:                               # optional extra deny/escalate rules (§19)
    - id: explorer-read-only
      when: { actor_role: explorer }
      deny: { capabilities: [repository.write, git.commit] }
```

## hard actions (plan-before-acting)

```yaml
mesh:
  defaults:
    hard_actions:
      mode: enforce                  # off (default) | warn | enforce
      capabilities: [repository.write, git.commit, git.merge]
agents:
  explorer:
    hard_actions: { mode: off }      # per-agent override wins over mesh.defaults
```

Each agent keeps a **private** checklist for the one task it has claimed
(`plan` / `plan_step` ops, `plan.updated` events). It is observability, not a
second task board: other agents cannot see or claim its steps.

`mode` decides what happens when the agent attempts an op that spends one of
the listed capabilities without a plan step declaring it:

| mode | effect |
| --- | --- |
| `off` (default) | no gate; `plan` ops still work if the agent emits them |
| `warn` | the op runs, and a `plan.gate_rejected` event records the near-miss |
| `enforce` | the op is rejected and the rest of that turn is abandoned |

`off` everywhere is the default so that existing meshes behave exactly as they
did before this feature existed.

Only capabilities that map to a mesh op can be gated — currently
`repository.write` (publish), `git.commit` and `git.merge`. `shell.execute` and
`network.request` are legal tokens but are spent through the coding agent's own
tools, so listing only those produces a load-time warning that the gate will
never fire. A capability the agent does not hold is never gated either: the
demand would be one the agent has no legal way to satisfy.

## budgets & scheduling

```yaml
budgets:
  mission: { tokens: 2000000, wall_clock_minutes: 240, max_events: 10000 }
  agent:   { architect: 300000, developer: 700000 }
  thread:  { tokens: 50000 }
  task:    { tokens: 100000 }
scheduling:
  mode: event-driven
  activation: { strategy: interest }          # or interest+triage
  triage:
    mode: heuristic                            # cheap pre-filter (§25)
    rules:
      - { agent: qa, event: dependency.changed,
          ignore_if_text_matches: [README], act_if_text_matches: [pom.xml] }
  concurrency: { max_active_agents: 4, max_parallel_service_agents: 2 }
  # max_total_agents caps peers + services combined (default: 4 + 2 = 6).
  # e.g. concurrency: { max_active_agents: 4, max_total_agents: 3 }
  timeouts: { turn_timeout_ms: 600000, wait_wakeup_ms: 60000, lease_ttl_ms: 1800000 }
server: { host: 127.0.0.1, port: 7420, state_dir: ./workspace/.mesh-state, dashboard: true }
```

Budgets are hierarchical: `mission → agent/task/thread/tool`. Overrun emits
`budget.exceeded` and the termination manager escalates (it does **not** silently
halt). `mesh run` writes `events.jsonl`, snapshots, turn audit, and a projection
rejection log under `server.state_dir`.

## bus: commitments & transport

```yaml
bus:
  commitments: { semantic: strict }   # or omit for "compat"
  transport: typed-only                # or omit for "mixed"
```

- `commitments.semantic: compat` (default): an ask leaves the ledger on exact
  signals (`replyTo`, `discharge`, operator answer/drop, review verdict,
  supersede, deadlock break, task completion) **or** inference (a response in
  the ask's thread addressed to the asker, artifact-pointer matches).
- `commitments.semantic: strict`: inference is off. A response without
  `replyTo` delivers content and wakes the asker but discharges **nothing**;
  only the exact signals close the ask. Exception: the worker-result contract
  (`REQUEST_EXECUTION` taskId == `HANDOFF` taskId) works in both modes.
  Strict trades more nudges/re-asks for zero falsely-closed asks. Note strict
  also tightens the worker contract: cross-taskId answers no longer discharge
  (previously any `REQUEST*` matched any taskId-carrying response).
- `transport: typed-only`: turns whose ops came from prose parsing are refused
  (visible warning in the turn summary, counts toward the circuit breaker);
  only MCP `mesh_*` tool calls execute. Use when models are strong enough to
  reliably call tools and you want the text-parsing lottery off entirely.
