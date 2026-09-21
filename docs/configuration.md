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
    runtime: claude                  # registered: claude | stub | none, plus http when a URL is set
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
    wake:         { defer_non_obliging: false }  # per-seat: never wake me for mail that obliges me nothing
```

- `mode: service` (e.g. explorer) → activates **only** on requests, read-only,
  short context, separate concurrency pool, and its answers are cached by
  `metadata.questionHash`.
- `interests` are dotted patterns; `architecture.*` matches `architecture.approved`
  but not bare `architecture`. Non-wildcard interests must be canonical event types.

### wake

The one wake decision a **recipient** owns. Every other rationing knob in the mesh
belongs to the sender: `bus.delivery.attention_tokens` is the sender's wallet, the
tariff is charged to the sender, and `interests` gates only broadcasts. This block
is the seat's own answer to the same question.

```yaml
agents:
  tech-lead:
    wake: { defer_non_obliging: true }
```

- `defer_non_obliging: true` — mail that **obliges this seat nothing** never wakes
  it. The message is still delivered and sits in the mailbox; the seat reads it on
  its next natural activation. "Nothing is ever suppressed; only the wake is
  refused."
- **Obligation always wins, by construction rather than by exception.** The
  predicate is the same one the debt is opened with (`obligesRecipients`), so a
  message this setting ignores is a message that opened no `pendingRequests` entry.
  An ask — `REQUEST*`/`ESCALATE`/`CHALLENGE` under `mode: service` — always wakes
  the seat that owes it. A mesh where a seat could quietly opt out of its own debts
  would not be a mesh.
- **Operator mail is exempt**, as it is from every other rationing mechanism: a
  human can always wake a seat, including a finished mission's.
- **It does not refund the sender.** An `interrupt` sent to a deferring seat was
  already charged to the sender's attention ledger and stays charged. The setting
  lives in `mesh.yaml`, so it is a public declaration a sender can read before
  spending — the same bargain `may_be_contacted_by` strikes one step harder.
- One step **milder** than `communicationPolicy.mayBeContactedBy`: that refuses the
  *send*, so the message never exists. This refuses only the *wake*.
- It is honoured everywhere mail would otherwise buy a turn — the send path, the
  wait-timer sweep, the post-turn mail retry, and the redundant-observation check
  — because a setting the send path alone honoured would be defeated a tick later
  by the sweep that counts unread mail as pressure. The single deliberate
  exception is the FAILED-agent recovery check: there, mail is one of two reasons
  a failed seat is restarted at all, and letting a wake policy make a seat
  unrecoverable would trade a spurious restart for a lost one.
- Per-agent only: there is deliberately no `mesh.defaults.wake`, because the
  mesh-wide version of this setting is `bus.delivery.classes` and two ways to say
  one thing is how they drift.

### Role prompts share blocks verbatim

The seven files in `roles/` are not independent documents. Two blocks are
**shared verbatim across every role**, and the duplication is a maintenance
hazard rather than a design:

- the `## Answering requests (the mesh tracks what you owe)` block, identical in
  all seven; and
- the opening sentence of `## Close every turn` — *"Act through mesh tools when
  available, else the `mesh-json` ops block — Mesh Context defines the exact
  contract; never communicate outside the mesh."* — which each role then extends
  with its own ending (`wait` vs `done`, and what the one-line summary says).

Changing either means changing all seven, or the roles drift and the prompt
stops describing one mesh. Edit them together; do not restructure the files
mechanically to de-duplicate.

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
    - id: no-qa-chatter
      when: { actor_role: developer, to: qa }      # `to` scopes to a recipient
      deny: { message_types: [INFORM] }
```

### rules

A rule is `when` (scope) + `deny`/`escalate` (effect). Every `when` clause
present must hold, so a rule constrains exactly what it names. What `matchRule`
actually reads (`packages/policy-engine/src/index.ts`) — the authority on this,
since a key it does not read validates, boots, and restricts nothing:

| key | read as |
|---|---|
| `when.actor` | the acting agent's id; validated at load against the registry |
| `when.actor_role` | the acting agent's configured role; a role no seat has is reported at load, since the rule then applies to nobody |
| `when.to` | a recipient the message must address — by agent id, by role, or by the base id of a hierarchical child (`qa#1` answers to `qa`). Only a message evaluation has recipients, so a rule carrying `to` never applies to a capability or authority check. A `to` no seat answers to is reported at load, because the rule is then scoped to nobody and denies nothing |
| `when.message_type` | the message type under evaluation; a token outside the catalog is a load error |
| `when.capability` | the capability under evaluation; a token outside the catalog is a load error |
| `deny.capabilities` | capability names to refuse; a token outside the catalog is a load error |
| `deny.message_types` | message types to refuse; a token outside the catalog is a load error |
| `when.event` | **removed** — a rule still carrying it is refused at load. Its value was never compared; it only stopped the rule applying to capability and authority checks, so it silently switched denials *off* |
| `escalate` | escalate instead of deny when the rule matches |

Every clause in that table is checked at load, and the severity is not a taste
call — it follows from whether the name can still turn up at runtime. A name that
**can never come into existence** is an **error**, because the rule can never
fire: `when.actor` against the registry, and `when.capability` /
`deny.capabilities` / `when.message_type` / `deny.message_types` against the
capability and message-type catalogs, both of which are closed. No seat can turn
up later holding `repository.writ`, and no message with a type the envelope
schema rejects ever reaches the policy engine, so a clause naming one is
permanently dead and the mesh refuses to boot.

A name that **can arrive later** is a **warning**, because refusing to boot would
break a working mesh: `when.to` and `when.actor_role` both name seats a
hierarchical child, a delegated worker, or the synthesized `human` seat can
supply after load. A config naming one this process has not seen yet is
legitimate; it is reported so the operator knows the rule scopes to nobody until
that seat exists.

Capability tokens are matched through the alias table, so `code.write` in a rule
is accepted and resolved to `repository.write` before the engine ever compares it
— a rule clause is normalized like every other capability list in the config.
Write either spelling.

An absent `when.to` and a cleared one are not the same rule. Absent means
unscoped: the rule applies mesh-wide, which is what a rule written before `to`
existed depends on. A `to` that is declared and then emptied (`to: ""`, which is
what clearing the field in the designer writes) names a recipient scope the
operator emptied, so it binds **nobody** — and is warned about, since a rule that
denies nothing is worth knowing about. Never treat the empty spelling as absent:
that would respawn a one-seat rule as a mesh-wide one.

Keys that look like they do something and do not. Each is now removed, and the
severity of each removal follows the same rule as above — it turns on whether
removing it changes what gets enforced:

- **`when.event` was removed, and a config still setting it refuses to load.**
  Its value was never compared: the only read was a guard that skipped the rule
  whenever no message was under evaluation, so the clause's real effect was to
  switch **off** capability and authority denial on any rule that also named
  capabilities — and `event: "artifact.published"` behaved exactly like
  `event: "banana"`. Deleting it therefore makes such a rule deny *more* than it
  did, which is why the mesh refuses to boot rather than let that happen quietly.
  Scope the rule with `when.message_type`, or with `when.to` for one recipient.
- **A rule-level `requires` was removed** — `requires.approvals` and
  `requires.evidence` on a rule. Nothing ever read it, so removing it changes no
  behaviour and a config still setting it is warned about at load and boots
  unchanged. Approvals and evidence are gated by `policies.transitions`, which is
  what the abandoned `requires.approvals` became; `MeshMessage.requires` is a
  third key with the same name and is unaffected.
- **There is no `deny.contact`.** Contact is decided in exactly one place,
  `policies.communication` (`may_contact` / `may_be_contacted_by`), and no rule
  ever read this field. A config still setting it is warned about at load and
  otherwise does nothing; remove the recipient from that seat's `may_contact`,
  or express a recipient-scoped veto as `when.to` plus `deny.message_types`.

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

## bus: commitments, transport, vocabulary & delivery

```yaml
bus:
  commitments:
    semantic: compat        # or omit for "strict"
    ttl_ms: 1800000         # 30 min, and what `mesh init` writes; omit (or 0) for no deadline
    ttl_ms_by_role: { security: 7200000 }
  transport: typed-only     # or omit for "mixed"
  vocabulary: contracts     # and what `mesh init` writes; omit (or "typed") for the full manifest
  delivery:
    classes: true           # omit for "every message wakes its recipients"
    coalesce_ms: 60000      # how long a `deliver` burst gathers before one wake
    interrupt_cost_tokens: 2000   # what one interrupt costs its sender, per seat woken
    attention_tokens: 200000      # what a seat may spend on wakes before they stop
                                  #   being interrupts; 0 = never buy one (low contact)
```

### commitments.semantic

- `strict` (**default**): inference is off. A response without `replyTo`
  delivers content and wakes the asker but discharges **nothing**; only the
  exact signals close the ask (`replyTo`, `discharge`, operator answer/drop,
  review verdict, supersede, deadlock break, expiry, task completion).
  Exception: the worker-result contract (`REQUEST_EXECUTION` taskId ==
  `HANDOFF` taskId) works in both modes.
- `compat`: the exact signals **plus** inference — a response in the ask's
  thread addressed to the asker, or an artifact-pointer match, closes the ask.

Strict is the default because the two failure modes are not symmetric. A wrong
inference closes an ask nobody answered, and does it silently: the asker's open
loop is marked done, nudging stops, and no event records that a guess was made.
A missing inference leaves the ask open, which is *visible* — the asker is
nudged, the ledger shows the debt, and with a TTL set it expires with a reason.
A missing discharge costs a re-ask; a wrong one costs work nobody noticed was
never done. Set `compat` for a mesh whose agents cannot be relied on to set
`replyTo` and which would rather over-close than stall. Note that `compat` also
loosens the worker contract: any `REQUEST*` matches any taskId-carrying
response, not only the one its `REQUEST_EXECUTION` minted.

### commitments.ttl_ms

How long an ask may go unanswered before the runtime closes it with
`expired`. Omitted or `0` means no deadline, which is how every mesh behaved
before this key existed — expiry is opt-in, not inherited from an upgrade.

`mesh init` writes `ttl_ms: 1800000` (30 minutes) into the `bus.commitments`
block of a freshly scaffolded mesh, so a new mesh has deadlines from its first
run rather than obligations that never close on their own. Without a TTL the
debtor is still nudged and a request that stays stuck still raises an operator
card, but `overdueCommitments` is always empty and the expiry sweep never
fires, so the ask sits on the ledger until someone answers it.

The scaffold is the **only** place that default is applied. The resolver still
reads an absent `bus:` block as "no deadline regime", so a mesh that already
exists keeps exactly the behaviour it has today and cannot acquire deadlines by
being upgraded — the new default is opt-in by new mesh, deliberately, because
turning expiry on under a running mission would start closing asks its operator
never put a clock on. Delete the key from the scaffolded file, or set it to
`0`, to opt back out.

The deadline belongs to the **debtor**, not the asker: an ask addressed to
several agents gets the longest of their roles' TTLs, so a slow role is never
cut off because a fast one was also on the list. `ttl_ms_by_role` overrides
`ttl_ms` per debtor role — a security review and a one-line fact lookup are not
the same kind of wait, and a single global deadline has to be set for the
slowest of them, at which point it stops bounding the fast ones at all.

Expiry is checked on the stall watch's wall clock rather than on event traffic,
because a mesh where everyone is waiting on an unanswerable ask produces no
events at all — precisely when a deadline needs to fire. An expiry is emitted
as `commitment.discharged` (reason `expired`, naming who was late), so it
survives replay, and an ask an **open** escalation points at is never expired
out from under the operator answering it.

### Capacity

The ledger is capacity-bounded, and a full ledger **refuses the new ask**
rather than evicting an old one: the refusal is recorded with reason
`refused_cap` and the asker gets one immediate, visible failure. The message
itself is still delivered — the cap bounds the obligation ledger, not the bus.
- `transport: typed-only`: turns whose ops came from prose parsing are refused
  (visible warning in the turn summary, counts toward the circuit breaker);
  only MCP `mesh_*` tool calls execute. Use when models are strong enough to
  reliably call tools and you want the text-parsing lottery off entirely.

Under `typed-only` two further things change, both about vocabulary rather than
delivery:

- The advertised tool manifest drops the four tools a contract fully covers
  (`mesh_request`, `mesh_request_review`, `mesh_research_request`,
  `mesh_escalate`). This is **advertisement only** — a seat that names a hidden
  tool still gets it, so nothing can be stranded by the filter. `mesh_send`
  stays, because no contract covers answering or the message types the
  catalogue does not name.
- The invented-name tables in `op-aliases.ts` stop firing, so an op name or
  message type a model made up is refused **by name** instead of being quietly
  rewritten into the nearest real one.

### vocabulary

Which comms vocabulary a seat's tool manifest advertises. `contracts` collapses
it to the named asks; omitted (or `typed`) is the manifest every mesh has had.

Under `vocabulary: contracts` the comms manifest is eight tools, and **not one
of them asks for a message type**:

| tool | what it is for |
|---|---|
| `mesh_contracts` | what can I ask for |
| `mesh_call` | the ask |
| `mesh_reply` | the answer |
| `mesh_discharge` | the refusal |
| `mesh_withdraw` | taking the ask back |
| `mesh_announce` | saying something that obliges nobody |
| `mesh_collab` / `mesh_collab_close` | the bounded discussion |

`mesh_withdraw` is the one member that is not a vocabulary act, and it is the
exception in the table for a reason worth knowing: a mesh that does not collapse
its vocabulary gets it too. `mesh_reply` and `mesh_announce` exist *only* to
carry the collapsed surface, so they stay hidden from a manifest that did not
ask for it; `mesh_withdraw` is a capability the mesh was missing at every
vocabulary setting. It closes an ask its own sender raised, releasing every
agent who still owed an answer — the asker's counterpart to `mesh_discharge`,
which is authorized by *owing* the answer rather than by having asked the
question.

`mesh_send`, `mesh_broadcast` and `mesh_respond` leave the advertised list,
along with the four `typed-only` already drops. `mesh_reply` answers with the
message id and the answer itself; `mesh_announce` broadcasts when you omit `to`
and tells named seats when you give it. Both send `INFORM`, which the seat never
writes — what settles an ask is `replyTo`, not the type.

As with `typed-only`, hiding is **advertisement only**: `mesh_send` with a
hand-written type still works for a model that reaches for it, so collapsing the
vocabulary can never take a capability away from a seat or strand a mission.
This is not a convention to trust — it is what the code does: `callTool`
resolves a tool name against the **unfiltered** map, and the hidden tools are
filtered only out of the advertised list
(`apps/mesh-server/src/mcp.ts`). `vocabulary: contracts` changes what a seat is
offered, never what the mesh will accept: a hidden tool called by name still
runs, through every gate, unchanged. `MessageType` is untouched on the wire and
stays what it should always have been — a rendering and telemetry detail.

Be honest about the payoff: the token saving is small (the manifest shrink
measured **−96 tokens/turn** when `typed-only` dropped four tools, and this
drops three more while adding two). The real win is that a seat can no longer
invent `RESULT`, because the manifest offers no field to invent it in — which is
the entire reason `op-aliases.ts` exists (60 name aliases, 31 type aliases,
thirteen words for "here is your answer" folded onto `INFORM`). An alias table
is what you build when a surface cannot be learned; this shrinks the surface.

`mesh init` writes `vocabulary: contracts` into a freshly scaffolded mesh, and
that scaffold is the **only** place the default is applied — exactly like
`commitments.ttl_ms` and `delivery.classes`. The resolver reads an absent key as
"keep the full manifest", so a mesh that already exists advertises the same tool
list it did before, tool for tool, and cannot acquire a different vocabulary by
being upgraded. Set `vocabulary: typed`, or delete the key, to opt back out.

This is independent of `transport`, although operators will usually set both.
`transport` decides *how* an op may arrive (a typed tool call, or ops parsed out
of prose); `vocabulary` decides *what* the typed surface offers. In particular
the `op-aliases.ts` tables are still live under `vocabulary: contracts` with
`transport: mixed`, because hiding a tool does not unteach its name to a model
writing prose.

### delivery.classes

The mesh is asynchronous in its transport and synchronous in its attention.
Nothing blocks — `wait` ends a turn, it does not await anything — but inbound
mail **wakes** its recipients, a wake is a turn, and a turn is a model call. So
the cheapest act in the system (writing a sentence) unilaterally spends the
most expensive resource another seat has, and nothing anywhere records it.
Every message is an interrupt with a bill attached, and the sender pays none of
it.

`classes: true` puts a **delivery class** on the message envelope, which
separates *delivery* (the message lands in the mailbox) from *wake* (the
recipient is activated now, burning a turn). The runtime stamps it; an agent
cannot — the field is stripped from every send and the envelope's property set
is closed, so a forged one fails validation rather than being ignored. The
three classes all deliver, and differ only in what the delivery may cost:

| class | wakes | charged | derived for |
|---|---|---|---|
| `interrupt` | now, as mail always has | yes, per seat woken | an `URGENT`; an answer to an ask the recipient is parked on; a re-ask in the thread of a debt that seat still owes the sender |
| `deliver` | once per `coalesce_ms` burst, or not at all if the seat takes a turn for another reason first | no | asks (`REQUEST*`, `ESCALATE`, `CHALLENGE`) and collab chatter |
| `accrue` | never | no | everything else — announcements, FYI, unsolicited `INFORM` |

**No class is a suppressed delivery.** The reducer puts the message in every
recipient's mailbox before the scheduler ever sees the event, so an unwoken
seat reads it on its next natural activation — exactly as an uninterested seat
already does with a broadcast. Nothing is lost; it is just not paid for twice.
The only thing that suppresses delivery is the research cache, which is a
different mechanism and not a class.

**An absent class is today's behaviour, not a cheap default.** With no
`bus.delivery` block nothing is classed and every message wakes every
recipient, exactly as before this key existed. `mesh init` writes the block
into a freshly scaffolded mesh so a new mesh is priced from its first run; an
existing mesh keeps the behaviour it has and opts in by hand. This mirrors
`commitments.ttl_ms` and for the same reason — re-routing wakes under a running
mission would stop waking agents whose operator expects them to be woken.
Replay honours the class on the envelope rather than the config of the day, so
a run replays as it ran.

**Classes are orthogonal to `control.mode`.** `mode` decides what an exchange
obliges and therefore who is a candidate for a wake at all; the class decides
whether being a candidate is worth a turn right now. Broadcasts are left
deliberately unclassed: the seats a broadcast wakes are the ones an operator
named in an `interests:` list, and a class derived from an envelope must not
overrule a decision taken in config.

`interrupt_cost_tokens` is charged to the **sender's** agent budget line
(`agent:<goal>/<sender>`), once per recipient woken, as an ordinary
`budget.consumed` entry. It is a tariff, not a transfer: the recipient's real
turn is still charged where it is really spent, and the charge stays off the
mission line so that line keeps reporting what the mission actually cost.
Against the 200k default agent line, the 2000 default lets a seat raise a
hundred interrupts before its own budget is what stops it. Set `0` to record
the classes and charge nothing; the class is what the scheduler reads, so
pricing and routing can be adopted separately. A message from the human
operator is never charged — there is no agent line to charge, and an operator's
interrupt is the operator's prerogative.

### attention_tokens

What a seat may spend buying **other seats' attention**, in tokens, before its
interrupts stop being interrupts. It is a separate line from the agent token
line on purpose: over-interrupting should cost a seat its influence, not its
ability to work. Written, the tariff above moves off `agent:<goal>/<sender>` and
onto a line of its own, `attention:<goal>/<agent>`, and becomes a real price —
when that line cannot cover the interrupt the message still ships and still
lands in the mailbox, but it ships as `deliver`, so the **wake** is not bought.
Nothing is ever suppressed; only the wake is refused. A seat reading the refusal
is told why, because an exhausted line and a mis-set `interrupt_cost_tokens`
call for opposite responses.

Absent means no attention line at all, and the tariff keeps landing on the
sender's agent line exactly as it did before the key existed — that is what makes
this strictly additive, including the accidental backstop the agent line
provided (a seat that interrupts a hundred times runs out of its own budget and
stops being activated).

**`0` is a real and useful answer: it is a mesh that never buys an interrupt,
where every one degrades to mail. That is the low-contact setting, stated
exactly.** It is not the same as `interrupt_cost_tokens: 0`, which makes
interrupts *free* and therefore unrationed — a line that can never run out
cannot refuse. Free interrupts are not rationed; cheap-to-own attention is.
`mesh init` writes `200000`, which against the `2000` default is a hundred
interrupts — the same rationing the agent line used to give by accident, now
landing on the wake instead.

`coalesce_ms` is measured from the **first** message of a burst, not the last:
a window that restarted on every arrival would never close under a steady
stream, which is the traffic it exists to price. It is checked on the
wait-wakeup sweep, so a value below `scheduling.timeouts.wait_wakeup_ms` buys
nothing.

`deliver` and `accrue` mail is excluded from that sweep's mail-pressure nudge,
exactly as broadcasts already are, and a seat with an open gathering window is
skipped by the sweep entirely until the window closes. Both for the same
reason: counting the mail, or chasing the ask it carried, would have the timer
undo the class one tick later — the seat correctly not woken by the message,
then woken by the sweep for the same message, at the same cost. The defaults
make that concrete, since the window and the sweep are both 60s.

Nothing else about the sweep changes. The skip is bounded by `coalesce_ms` from
the first message of the burst and every window closes in a real activation, so
an unanswered ask is still nudged and still escalates into a stalemate
escalation, whatever class carried it.

A re-ask counts as a chase only inside the thread of the ask it is chasing. A
different question to a colleague who happens to owe you something is a new
ask, not a chase: without that scoping, one open debt would make every later
ask to that seat an `interrupt`, and in a mesh where seats habitually owe each
other work the expensive class becomes the default — the inversion this key
exists to correct.

### Contracts

A contract is a named ask with a request schema, a set of refusals it may come
back with, and an SLA. Two ops use them:

- `contracts` — list what this mesh knows how to route, each with its request
  shape, its refusals, the capability it needs, and which seats can currently
  answer it (resolved live against capabilities *and* the communication policy,
  so discovery never points a seat at someone it may not contact).
- `call` — raise one. The request is validated against the contract schema
  **before any recipient is woken**, so a malformed ask costs nobody a turn,
  and an unknown contract name is refused with the list of real ones.

`call` is sugar: every contract desugars to a typed op (`send`,
`request_review`, `request_research`, `escalate`) and is re-entered through the
ordinary op path, so it can reach nothing a typed op could not and every gate
applies to it unchanged.

The built-ins are `review.artifact`, `research.question`, `info.question`,
`artifact.produce`, `execution.run`, `work.request`, `decision.challenge` and
`decision.escalate`.

A contract's `slaMs` **narrows an existing deadline regime and never creates
one**: with no `bus.commitments.ttl_ms` configured, a contract ask has no
deadline, because deadlines drive expiry and expiry discharges debt — a
catalogue that invented one would silently forgive asks you told the mesh to
keep. A `ttl_ms_by_role` entry still outranks the contract.
