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
                                     #   + optional context_window: tokens — see "context_window" below.
                                     #   + optional isolate_host: true — see "isolate_host" below.
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

> **A seat's `wall_clock_minutes` and `max_events` are accepted and resolved,
> but nothing enforces them.** Of the four keys under a seat's `budget:`, only
> `tokens` and `max_activations` bind — `tokens` is declared as a real ledger
> line (`BudgetManager.declare`) and `max_activations` is checked by the policy
> engine. The other two are declared for the *mission* ledger and never for an
> agent one, so a seat with `wall_clock_minutes: 30` runs for as long as the
> mission does. Use `budgets.mission.wall_clock_minutes` / `.max_events`, which
> are enforced, and set a per-seat cap with `tokens`.

> **`max_context_tokens` is accepted and resolved, but nothing enforces it yet.**
> No runtime currently truncates or compacts a session on it, at either level —
> setting it changes what the config reports, not how agents run. The other five
> keys are enforced. Note that `delegation.allow` and `max_depth` only take effect
> alongside `max_workers: ≥ 1`; the supervisor denies `spawn_worker` when the
> worker cap is 0.

### context_window

`mesh.runtime.context_window` (and a seat's own `agents.<id>.context_window`) is the
context window, in tokens, that the Claude adapter measures a session against when
it decides to rotate it. Rotation happens at 60% of the window. Resolution order:
the seat's own `context_window`, then the window the adapter knows for the model the
backend reports running, then `mesh.runtime.context_window`, then a 120,000-token
floor. A mesh-wide value never raises a model the adapter knows to be smaller.

Set it when seats run a model the adapter does not know. A proxied
`deepseek-v4.1-flash` is one example: it fell to the 120k floor while having a 1M
window, and each such fallback is logged once. The adapter measures a session's
context as the largest single prompt of its last turn. It reads the usage on
`message_start`, on `message_delta` (the only frame some proxies fill) and on
assistant frames. When no frame reports usage, it estimates the size from the
turn's summed reads and logs "context unmeasurable" once per seat session
(NOTES-live-run-20260925-2040.md §1).

`session.max_context_tokens` is parsed but read by no runtime; it does not
control rotation. Use `context_window`.

### stale_after_ms

`mesh.runtime.stale_after_ms` is how long a seat's session may sit idle before the
adapter rotates it, on the theory that the prompt cache expired in the gap and the
next turn would re-read the whole transcript at full price. The adapter's own
default is 10 minutes, which fits Anthropic's cache TTL.

A route whose cache outlives that pays for rotations it does not need: measured on
a proxied `deepseek-v4.1-flash` on 2026-09-27, 94% of the prompt was still cached
after a 10-minute idle gap, and each rotation discards the seat's working context
and costs it a re-orientation turn. Set an hour (`stale_after_ms: 3600000`) there.
Mesh-wide only; there is no per-seat form. `mesh validate` refuses a value below
a minute (60000), because anything shorter is a seconds-written-as-milliseconds
typo rather than a window anyone means.

### isolate_host

`mesh.runtime.isolate_host: true` runs every Claude seat without what the launching
machine would otherwise lend it. Off by default, because a mesh that works today may
lean on either route below (an operator's proxy hook, an allow rule), and the default
is to say so at boot instead.

There are two routes, and neither is a mesh setting, which is why neither was visible:

1. **Settings.** The SDK loads every filesystem settings source unless told not to, so
   the launching user's `~/.claude/settings.json` (its `hooks`, `permissions`, `env`,
   `model`, effort) applied to every seat as it does to that user's own sessions. A
   hook that reads the user's transcripts, an allow rule that pre-approves what the
   seat's permission gate would refuse, and a `model` override were all silent changes
   to what the mesh ran; the substituted model of an earlier run came from here.
2. **Environment.** A mesh started from inside another Claude Code session inherits
   that session's variables, and they describe the *outer* session: in the cronlite run
   the seat CLIs reported the outer session's id and ran at its effort
   (`CLAUDE_EFFORT=max`, `MAX_THINKING_TOKENS=31999`).

With the key on, the seat is spawned with an empty `settingSources` (the SDK's isolation
mode) and without the launching session's environment: **every variable whose name begins
`CLAUDE`** (`CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_*`) **except the few that say how to reach
the model**, and `MAX_THINKING_TOKENS`. It removes the namespace rather than a list of names
because a session in a container exports dozens (its id and effort, its artifact store, its
messaging token and socket, the file its session-ingress token is read from, its debug switch,
its transport flags) and a seat's shell inherits the CLI's environment; a named list took out
ten of 56 in the second cronlite run and left the rest, tokens included.

What is kept, because it authenticates or routes the CLI, so isolating cannot break a working
login: everything outside the `CLAUDE` namespace (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`ANTHROPIC_BASE_URL`, `AWS_*`, the proxy and CA variables) and, inside it,
`CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_API_KEY_HELPER_TTL_MS`,
`CLAUDE_CODE_USE_BEDROCK`/`_VERTEX`/`_FOUNDRY` with their `CLAUDE_CODE_SKIP_*_AUTH`
companions, `CLAUDE_CODE_CLIENT_CERT`/`_KEY`/`_KEY_PASSPHRASE`,
`CLAUDE_CODE_PROXY_RESOLVES_HOSTS`, `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` and
`CLAUDE_CONFIG_DIR`. Next to these in a container's environment, and **not** kept, are
`CLAUDE_CODE_USE_CCR_V2` and `CLAUDE_CODE_REMOTE*` (how the outer session reports to its
host). A provider flag added after that list was written is removed until it is named, which
fails at login at once, and the operator then leaves `isolate_host` off and starts the mesh
from an environment of their own (`env -i` with the names the seats need), which is how
isolating the seats by hand looked before this key. With the key on, the audit log
(`projection-rejections.log`) records, in full, what was removed and which `CLAUDE*` names
were kept.

The operator's own `extraOptions` (the adapter's escape hatch) still wins over it: an
`env` or `settingSources` passed there is taken as given.

Without the key, `mesh run` and `mesh serve` say what would leak when a mesh runs any
Claude seat: one line if it was started from inside another session (naming the first six
variables and counting the rest), another when any of them looks like the outer session's own
credentials (a `TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL` or `KEY` word in the name), one if
the user settings file sets `hooks`, `permissions`, `env`, `model`,
`effortLevel`, `apiKeyHelper`, `enabledPlugins` or `alwaysThinkingEnabled`, and then the
key that closes the door. A settings file that only changes the user's terminal (a
theme) is not a leak and is not reported; a mesh with no Claude seat is not warned.

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
    budget:       { tokens: 700000, max_activations: 40 }   # only these two bind; see below
    wake:         { defer_non_obliging: false, mail: full, not_for: [] }  # per-seat: never wake me for mail that obliges me nothing, or for these types by name; and how much of a woken message to show
```

- `mode: service` (e.g. explorer) → activates **only** on requests, read-only,
  short context, separate concurrency pool, and its answers are cached by
  `metadata.questionHash`.
- `interests` are dotted patterns; `architecture.*` matches `architecture.approved`
  but not bare `architecture`. Non-wildcard interests must be canonical event types.
- `interests` also decide **broadcasts**: a `mesh_announce` that names nobody wakes only the seats
  that list `message.sent` (or `message.*`), at every point mail can buy a turn — when it is sent,
  when the wait sweep counts unread mail, and when a turn ends with mail left in the box. The rest
  get it in their mailbox, read it on the next turn they take, and are woken for it once it has
  waited four minutes (`STALE_MAIL_MS`). Nobody in a shipped mesh lists `message.sent`, so in every
  one an announcement is read, not reacted to.
- `authority` tokens are `<domain>.<verb>`. The positive verdict of a seat that tests or scans is a
  **pass** (`quality.pass`, `security.pass`; QA and security hold these and no `.approve` in every
  shipped mesh), given with `mesh_approve` `kind: "pass"`. An approve from a seat whose verdict in
  that domain is a pass is recorded as the pass and says so; a seat holding both keeps the word it
  chose, so a bare approve is still not a pass where it could have given either, and a gate that
  requires `qa.pass` is met only by one. A pass satisfies a gate asking for an approve, never the
  reverse.

### wake

The one wake decision a **recipient** owns. Every other rationing knob in the mesh
belongs to the sender: `bus.delivery.attention_tokens` is the sender's wallet, the
tariff is charged to the sender, and `interests` gates only broadcasts. This block
is the seat's own answer to the same question.

```yaml
agents:
  tech-lead:
    wake: { defer_non_obliging: true, mail: claims }
    # or, narrower: keep being woken by everything except the news it batches
    wake: { not_for: [INFORM, COMMIT] }
```

- `defer_non_obliging: true` — mail that **obliges this seat nothing** never wakes
  it. The message is still delivered and sits in the mailbox; the seat reads it on
  its next natural activation. "Nothing is ever suppressed; only the wake is
  refused."
- `not_for: [INFORM, COMMIT]` — the same refusal, but per **type** instead of
  all-or-nothing. Exact `MessageType` names, validated against the catalogue, so
  a word that is not a message type is a config error rather than a rule that
  silently matches nothing.
  - This is the half `interests` never reached. `interests` gates **broadcasts**
    (`defersMail` and `candidatesFor` consult it, so the retry after a turn agrees
    with the send path); mail addressed to a seat
    by name has always woken it, and until this key existed the seat's only say
    was `defer_non_obliging` — all of its chatter or none of it. That is a choice
    most seats decline to make, and declining it means paying for every FYI.
  - **Exact names, not globs, and deliberately.** `interests` patterns are dotted
    paths (`architecture.*`); message types are flat `UPPER_SNAKE` words, and
    `interestMatches("*", "INFORM")` is `false` against every one of them. A glob
    surface here would have looked like it worked and muted nothing.
  - **Naming a type that cannot be deferred does nothing at all.** The three
    exemptions below are checked *first*, so `not_for: [HANDOFF, REQUEST_REVIEW]`
    names two things that have already left the function. That is what keeps this
    a batching preference rather than an authority boundary.
  - It composes with `defer_non_obliging` by narrowing nothing: the broad switch
    already holds everything this one names.
- `mail: claims` (default `full`) — how much of a woken message's **content** the
  prompt carries. `full` renders the payload; `claims` renders the header line
  alone and marks it `body withheld`, to be filled in from the mailbox with
  `mesh_inbox`. This is the pull path, and it is deliberately narrower than "send
  less mail": the subject, sender, type and thread are still rendered, so a claim
  is a standable-in-for line rather than a pointer into nowhere.
  - **Mail that obliges this seat keeps its body in both modes.** The split falls
    at the obligation, not at a size threshold. `message.delivered` marks a
    message answered once the turn ends — "delivered means rendered AND answered"
    — so a seat handed a bare claim and then marked answered has been made to
    answer blind. What is deferred is the reading of news, never of a question.
  - It composes with `defer_non_obliging` rather than replacing it: that key
    decides whether an FYI buys a turn at all, this one decides what the turn
    shows once it happens. A seat that sets both receives non-obliging mail
    rarely and as a claim.
  - **Off by default, and it should stay that way** unless a mission says
    otherwise. Measured on a real run, the whole `Unread mail` section is 2.2% of
    a turn's briefing block — roughly 0.2% of total mission input — so this is a
    contact-quality lever, not a cost one. Reach for it when a seat is drowning
    in news, not to save tokens.
- **Obligation always wins.** The predicate is the same one the debt is opened
  with (`obligesRecipients`), so a message this setting defers is a message that
  opened no `pendingRequests` entry. An ask — `REQUEST*`/`ESCALATE`/`CHALLENGE`
  under `mode: service` — always wakes the seat that owes it. A mesh where a seat
  could quietly opt out of its own debts would not be a mesh.
- **Work handed to the seat also wins**, which is an exception rather than a
  consequence of the predicate: the eight work-moving types (`MISSION`,
  `DELEGATE`, `HANDOFF`, `PATCH_READY`, `APPROVE`, `REJECT`, `VETO`, `BLOCK`)
  open no debt, yet they still wake a deferring seat. The setting reads as "hold
  my chatter", and a `HANDOFF` is not chatter — it is this seat's next piece of
  work, and deferring it leaves the work with nobody awake to do it. A seat can
  batch what is merely *told* to it and is still woken for what is *handed* to
  it, which is the same line the delivery classes stop at.
- **Operator mail is exempt**, as it is from every other rationing mechanism: a
  human can always wake a seat, including a finished mission's.
- **All three exemptions bind `not_for` too, and are checked before it.** They
  are also read off the *message* rather than its type where the type does not
  finish the sentence: `TEST_RESULT` and `SECURITY_FINDING` are the same word for
  opposite events, so a `FAILED` one hands work back and wakes a seat that muted
  the type, while the `PASSED` beside it is a report and stays muted.
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
- the opening sentence of `## Close every turn` — *"Act ONLY through the
  `mesh_*` tools — Mesh Context lists them; nothing written in your reply text
  is read as an op, and never communicate outside the mesh."* — which each role
  then extends with its own ending (`mesh_wait` vs `mesh_done`, and what the
  one-line summary says).

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

### transitions

Each key is a gate name; `requires` lists the approvals a transition through it
demands, each written `<agent-id-or-role>.<kind>`. **Every entry must hold** —
the list is ANDed.

Join alternatives with `|` when one entry could be met by more than one seat:

```yaml
  patch.merge: { requires: [tech-lead.approve|architect.approve, qa.pass] }
```

This is still one requirement, satisfied by **any one** of the alternatives —
`tech-lead.approve` alone, or `architect.approve` alone. `qa.pass` is a separate
entry and is still required on top of it.

Reach for it when a gate's single holder is a bottleneck. A gate on one seat
queues every artifact through that seat's inbox: on a live mission one seat that
was both the coordination hub and the merge gate received 42% of all messages
and left 145 unread at the peak, while the work behind it stalled. Naming a pool
of seats — by role, so the pool grows with the mesh — turns a queue into
whichever of them is free.

An `approve` is satisfied by a compatible stronger record (`accept`, `merge`,
`pass`), as it always was, and a `block` by one alternative's actor sinks **only
that alternative** — it never cancels the others. Alternatives are resolved
independently; only if none is met does the refusal name them, joined by `|`:
`missing: tech-lead.approve|architect.approve`.

A malformed alternative (`|architect.approve`, `tech-lead.approve|`, `x.|y.z`)
is refused at load.

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
| `deny.capabilities` | capability names to refuse; a token outside the catalog is a load error. It refuses more than capabilities: because an authority check matches on actor and role alone, the same clause also denies a seat's **held** authority whenever the matched rule names any capability. Left as it is deliberately — narrowing it removes a `DENY` — **and now reported at load** when a rule with this clause matches a seat that holds authority, naming the rule, the seat and the authorities it would strip. `when.to` exempts a rule from that report, because an authority check addresses nobody; `when.capability` does not, because an authority check carries no capability either. Recorded in `NOTES-communication-measured-review.md` §7 row 12 |
| `deny.message_types` | message types to refuse; a token outside the catalog is a load error |
| `when.authority` | **does not exist, and never did.** An authority evaluation carries no authority token, so there is nothing for such a clause to compare against; a rule cannot be scoped to one authority (`deployment.approve`). `matchRule`'s doc comment says so at the point a reader would otherwise look for it |
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
`repository.write` (`publish_artifact`), `git.commit` and `git.merge`.
`shell.execute` and `network.request` are legal tokens but are spent through the
coding agent's own tools, so listing only those produces a load-time warning that
the gate will never fire. A capability the agent does not hold is never gated
either: the demand would be one the agent has no legal way to satisfy.

**This is a planning gate, not a permission.** `git.commit` and `git.merge` are
independently enforced as permissions; `repository.write` is **not** enforced on
`publish_artifact`, and that is deliberate — a seat holding only
`repository.read` publishing a `RequirementsDoc` is the shipped configuration in
`examples/payment-api` and `examples/line-follower-sim`. So the mapping above
says "declare a plan step before doing this if `hard_actions` asks you to", not
"you need this token to publish".

Worth stating because the inverse is easy to assume and expensive: in one live
run a read-only `pm` seat concluded from its own capability list that it could
not publish at all, wrote its requirements document into prose instead, and lost
the turn. Inline `content` was available to it throughout.

### a seat that can merge but not repair

`git.merge` lands a branch in the product tree. When the merge leaves the tree
needing a fix — a stray lockfile, a workspace file that has to be removed and
regenerated — repairing it needs `repository.write` and confirming the result
needs `test.execute`. A seat holding `git.merge` without them can only describe
the problem and move on, and because `git merge` refuses to run over uncommitted
changes, the mess it leaves blocks **every later merge**. Declaring that shape
produces a load-time warning naming a seat that could do the repair, if one
exists. It is a warning rather than an error: separating landing from repairing
is a legitimate design.

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

`turn_timeout_ms` is a turn's budget. A turn that holds a task, or is still
producing frames, runs on to a ceiling of three times it, and is warned at the
budget and shortly before the ceiling; see "Turn deadlines" in `runtime.md`.
Size it for a coordination turn, not for the longest build.

Budgets are hierarchical: `mission → agent/task/thread/tool`. Overrun emits
`budget.exceeded` and the termination manager escalates (it does **not** silently
halt). `mesh run` writes `events.jsonl`, snapshots, turn audit, and a projection
rejection log under `server.state_dir`.

A seat whose own ledger is spent past its auto-raise ceiling is **parked**, not
the mission: it takes no turns, its mail and the asks it owes wait, and an
`agent_budget_exhausted` card for that seat goes to the operator while every other
seat keeps working. Raising the seat's budget un-parks and wakes it. The goal
halts only on the mission ledger, or when every live seat is parked. On a seat's
last rung the pre-turn hold is the seat's real per-turn estimate (1.5x its moving
average, uncapped), so a turn it cannot afford is refused at the door.

```yaml
budgets:
  cache_read_weight: 0.1   # default 0
```

`cache_read_weight` (0..1) is the share of a turn's cache-read tokens billed to
its ledgers. At the default 0 a turn is billed input + output + cache writes, and
cache reads are free — which makes budgets bill cache luck: a turn that misses the
cache is charged its whole prompt while a warm one reading millions is charged a
fraction. Every `budget.consumed` on an agent ledger carries `cacheRead` and
`cacheReadRatio` (reads over the whole prompt) either way, and `cacheReadBilled`
when the weight is above 0.

The Claude adapter's usage guard has no key; it is always on. Some backends
drop their cache report partway through a turn. A call that then reports zero
cache, after the same turn's previous call sent a prompt of at least 8,000
tokens, has that prefix billed as `cache_read` rather than `input`
(docs/runtime.md, `runtime-claude`). When it fires, the audit log gets one
`usage re-attributed` line per seat session, and the moved tokens show up in
that seat's `cacheRead`, not its billed total.

## bus: style, commitments, vocabulary & delivery

```yaml
bus:
  style: low-contact      # one word for a coherent bus; expands to the keys below,
                          #   every one of which you may still write yourself
  commitments:
    semantic: compat        # or omit for "strict"
    ttl_ms: 1800000         # 30 min, and what `mesh init` writes; omit (or 0) for no deadline
    ttl_ms_by_role: { security: 7200000 }
    by_type: true           # and what `mesh init` writes; a bare typed ask inherits its
                            #   type's contract (refusals + SLA). Omit to leave it ungoverned.
    min_default_ms: 240000  # the soonest an `ifUnanswered` default may come due; omit and the mesh
                            #   derives it from its own clock (see below); 0 = no floor
  vocabulary: contracts     # and what `mesh init` writes; omit (or "typed") for the full manifest
  delivery:
    classes: true           # omit for "every message wakes its recipients"
    coalesce_ms: 60000      # how long a `deliver` burst gathers before one wake
    interrupt_cost_tokens: 2000   # what one interrupt costs its sender, per seat woken
    attention_tokens: 200000      # what a seat may spend on wakes before they stop
                                  #   being interrupts; 0 = never buy one (low contact)
    congestion_every: 4           # and what `mesh init` writes; +1x to the tariff per 4
                                  #   unread in the recipient's box, capped at 4x. Omit
                                  #   for the flat price at every depth.
```

### style

A whole coherent bus written as one word. `high-contact`, `balanced` or
`low-contact`.

The keys below are individually good and collectively hard. `ttl_ms` decides
whether asks end; `delivery.classes` decides whether they wake anyone;
`attention_tokens` decides whether a wake is priced; `vocabulary` decides what
a seat is even shown. Set three of the four and you get a bus nobody designed —
most commonly one that prices attention and then never charges for it, or one
that stops chasing asks that have no deadline to end at. `style` is the set
that was designed together.

A style is an **expansion into the raw keys**, and nothing else. It is not a
mode, nothing downstream branches on it, and it cannot reach a bus you could
not have typed by hand — `tests/config/bus-style.test.ts` pins a styled mesh
and its hand-written equivalent as the same resolved object. What each one
writes:

| | `high-contact` | `balanced` | `low-contact` |
|---|---|---|---|
| `commitments.ttl_ms` | — | `1800000` | `900000` |
| `commitments.by_type` | — | — | `true` |
| `delivery.classes` | — | `true` | `true` |
| `delivery.coalesce_ms` | — | *(60000 default)* | `300000` |
| `delivery.attention_tokens` | — | — | `200000` |
| `delivery.congestion_every` | — | — | `4` |
| `vocabulary` | — | — | `contracts` |
| `collab.box_ms` / `max_exchanges` | — | — | `600000` / `10` |

- **`high-contact` is `{}`, on purpose.** The absence of every key *is* the
  high-contact mesh: every message wakes its recipients, no ask has a deadline,
  nothing is billed. Writing `classes: false` into the preset would suggest that
  silence and `false` are different states, and they are not. What the word buys
  you is the record that an operator looked at this and chose it.
- **`low-contact`'s deadline is SHORTER than `balanced`'s**, which looks
  backwards until you notice what is off. With `attention_tokens` set, a wake
  can be refused; with a five-minute coalesce window, a `deliver` sits. Nothing
  is chasing these asks, so the deadline is the only thing that ends one. A
  longer deadline there is not patience, it is a debt the ledger carries
  silently.
- **A key you write beside a style wins, per KEY and not per block.** `style:
  low-contact` with `delivery: { coalesce_ms: 30000 }` keeps the attention price
  and the congestion curve and takes your window. A whole-block override would
  have left you a mesh that says low-contact and bills nothing.
- **A style can be contradicted.** `ttl_ms: 0` and `classes: false` are how
  those are spelled off, and they beat the preset that wrote them. A style that
  could not be argued with would be a mode, not a starting point.
- `low-contact` also selects the prompt variant: seats on such a mesh are told,
  in four lines, that nothing is coming to chase them and what to spend instead
  (see `docs/runtime.md`). That is the one thing about a low-contact mesh a seat
  cannot infer from anything else it is shown.

### commitments.semantic

- `strict` (**default**): inference is off. A response without `replyTo`
  delivers content and wakes the asker but discharges **nothing**; only the
  exact signals close the ask (`replyTo`, `discharge`, the asker's own
  `withdraw`, operator answer/drop, review verdict, supersede, deadlock break,
  expiry, task completion).
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

### commitments.by_type

Lets a **bare typed ask** inherit the contract its message type names. Absent
(the default) it inherits nothing, which is what every mesh that predates this
key has.

The hole it closes: `mesh_call` with a question got a request schema, a closed
refusal set and an SLA; `mesh_send` with `type: REQUEST_INFO` opened exactly
the same debt — the same ledger row, the same nudge ladder, the same
escalation at the end of it — and got none of the three. Two doors to the same
room, one of them with no rules on it, and the typed door is the one the older
role prompts teach.

The mapping is **derived** from each contract's own `messageType`, never
written out, so it cannot drift from the catalogue: `REQUEST_INFO` →
`info.question`, `REQUEST_REVIEW` → `review.artifact`, and so on for all eight.
A type no contract claims inherits **nothing** rather than something close —
"obliging" is a prefix match on `REQUEST*`, so a type added later is obliging
from the moment it exists and must not pick up whichever contract sorts first.

Three limits are deliberate:

- **The request body is not validated.** The ask never passed a schema, so
  nothing claims it did. The refusals and the deadline are real; the shape
  check is not, and the debtor's prompt says so in those words.
- **Nothing is stamped on the wire.** `control.contract` is documented to mean
  *this ask passed its request schema*; writing this default there would make
  every later reader of that field wrong. The contract is resolved in the
  reducer, where the debt is recorded, and rides into replay with the semantic
  and the TTL.
- **An inherited SLA narrows, never creates.** With no `ttl_ms` there is still
  no deadline — the same rule `call` already follows, for the same reason.

What it does change is the **refusal set**, from open to closed: with the key
on, `discharge` refuses a refusal kind the inherited contract does not admit,
and names the ones that would have worked. The debtor is shown the set in its
mail line, because a closed set nobody is shown is a trap rather than a
vocabulary. That change is why the key is opt-in.

### commitments.min_default_ms

The soonest an [`ifUnanswered`](#ifunanswered-an-ask-that-can-answer-itself) default may
come due, in milliseconds: an op whose `afterMs` is shorter is **refused at the edge**,
naming the floor, instead of opening an ask whose default would stand before anyone
could have objected to it.

The hole it closes: the schema only required `afterMs > 0`, and two seats in the cronlite
run (2026-09-30) each chose 5 seconds. The addressee was mid-turn and `coalesce_ms` was
also 5 seconds, so the answer path could not possibly fire before the default did. Two of
the run's three commitments ended `defaulted`; one seat was told to proceed on its
assumption and not to re-ask, the assumption was false (it assumed an empty repository,
and a `SPEC.md` existed), and the real answer arrived a minute and a half later and cost
a further wake. `defaulted` is a *settlement*, so nothing downstream marked any of it as a
loss.

Absent, the floor is derived from this mesh's own clock: `bus.delivery.coalesce_ms` (0
when there is no delivery block) + `scheduling.timeouts.wait_wakeup_ms` + a 2-minute
allowance for one answering turn (the cronlite seats' turns took 30 to 120 seconds). With
`delivery.classes` and both windows at their 60-second defaults that is 4 minutes; with no
delivery block, 3. An explicit value wins and `0` turns the floor off. The floor does
**not** count the addressee's *current* turn, which is unbounded; it removes the defaults
that could never have been answered, not every one that might not be.

It governs `afterMs` only. An `ifUnanswered` with no `afterMs` uses the mesh's
`commitments.ttl_ms`, which is the operator's own deadline and is not second-guessed
here.

### Capacity

The ledger is capacity-bounded, and a full ledger **refuses the new ask**
rather than evicting an old one: the refusal is recorded with reason
`refused_cap` and the asker gets one immediate, visible failure. The message
itself is still delivered — the cap bounds the obligation ledger, not the bus.
- `transport` was **removed**. It chose whether ops parsed out of a prose
  `mesh-json` block executed (`mixed`) or were refused (`typed-only`); there is
  no prose channel any more — every op is an MCP `mesh_*` tool call, and a
  fenced ops block in a reply is never parsed. A mesh.yaml that still sets the
  key loads, with the warning `bus.transport (...) was removed and is ignored`.
  Delete the key.

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
| `mesh_announce` | saying something that obliges nobody, and wakes nobody (what a seat must act on is a `mesh_call`) |
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
along with the four tools a contract fully covers (`mesh_request`,
`mesh_request_review`, `mesh_research_request`, `mesh_escalate`). `mesh_reply` answers with the
message id and the answer itself; `mesh_announce` broadcasts when you omit `to`
and tells named seats when you give it. Both send `INFORM`, which the seat never
writes — what settles an ask is `replyTo`, not the type.

Hiding is **advertisement only on the server**: `callTool` resolves a tool name
against the **unfiltered** map, and the hidden tools are filtered only out of the
advertised list (`apps/mesh-server/src/mcp.ts`), so a caller that names one on
the wire (the operator's HTTP API, a client that does not check) still gets it,
through every gate, unchanged. `MessageType` is untouched on the wire and stays
what it should always have been — a rendering and telemetry detail.

What that does **not** mean is that a seat can call a hidden tool. A client that
checks a name against the `tools/list` it was handed refuses any other before the
call leaves the machine, and Claude Code is one: it answers "No such tool
available" and nothing is sent. This page used to say a hidden `mesh_send` "still
works for a model that reaches for it", the briefing said the same to the seat, and
across three live runs seats made 8, 14 and 14 such calls (of 434, 567 and 370), each a turn's worth of
intent that never reached the mesh. So the briefing now names only tools the seat's
manifest carries (`hiddenToolsFor`, in `packages/protocol/src/tool-visibility.ts`,
is the list both read), says plainly which it does not have and that a call to one
does nothing, and the end-of-turn note says so when a seat calls one anyway. The
asks no narrower contract names go to `work.request`; saying something nobody has to
answer is `mesh_announce`. See `docs/runtime.md` § What a seat is told about its
tools.

Be honest about the payoff: the token saving is small (the manifest shrink
measured **−96 tokens/turn** for dropping the four contract-covered tools, and
this drops three more while adding two). The real win is that a seat can no longer
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
| `deliver` | once per `coalesce_ms` burst, or not at all if the seat takes a turn for another reason first | no | asks (`REQUEST*`, `ESCALATE`, `CHALLENGE`), collab chatter, and the eight work-moving types (`MISSION`, `DELEGATE`, `HANDOFF`, `PATCH_READY`, `APPROVE`, `REJECT`, `VETO`, `BLOCK`) |
| `accrue` | never — not even when the turn it arrived during ends | no | everything else — announcements, FYI, unsolicited `INFORM` |

Work-moving mail is `deliver` and not `accrue` because it is not news: a
`HANDOFF` is the recipient's next piece of work, and a class that never woke
anybody would leave it sitting with no one awake to do it. It is not
`interrupt` either — there is no debt to chase and nobody is parked on a
specific answer, so coalescing a burst of handoffs into one turn is right.

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

### congestion_every

One step of surcharge on `interrupt_cost_tokens` per N messages already unread
in the recipient's box, capped at **4x**. Absent (the default) is the flat
tariff at every depth, which is what every mesh that wrote a `delivery` block
already has.

The flat price asks the wrong question. It charges the same to wake a seat with
an empty box and a seat with nineteen unread, and those are not the same
purchase: the first buys a turn that starts on the sender's problem, the second
buys a turn that starts by reading nineteen other people's. Congestion pricing
prices the queue the sender is joining, so the seat everyone is already
interrupting is the expensive one to interrupt — which is the signal, and the
cheap alternative (ordinary mail, read on the turn they were going to take
anyway) is always available.

The **cap is load-bearing**. A sender cannot see inside another seat's mailbox,
and a box holds up to 200 messages, so an uncapped curve would reach 200x. A
price nobody can predict is not a price, it is a penalty. The seat's prompt
quotes the divisor, the cap and the alternative, so the bill can be computed
before the send rather than discovered after it.

The first message in a box is not a surcharge — someone has to be first, and
charging for it would raise every wake above the flat tariff, which is a rename
rather than a signal. A value below 1 is read as "not configured" rather than
clamped: it is a division by zero or a surcharge on an empty box, so the
operator asked for something incoherent and gets the documented default.

The quote and the bill are computed by one function and neither counts the
message being sent. The pre-flight check runs before the reducer files it and
the charge runs after; counting the box naively makes them differ by one, and
at a tier boundary that quotes one price and bills another for a surcharge the
sender's own message caused.

### One wake per recipient per turn

Not configurable, and not a tariff: **the second interrupt to the same seat in
the same turn is free.** The scheduler does not enqueue a second turn for a
seat that is already queued, so three URGENT messages to one colleague in one
burst bought one turn and used to be billed three times. Charging for a turn
nobody gets was never a policy.

It is per **sender**: two seats waking the same colleague both pay, because a
digest keyed on the recipient would let the second sender ride the first's wake
for free, which prices a public good and rewards piling on. The refusal path
agrees with the bill — an exhausted attention line does not refuse a wake that
costs nothing — and the ledger clears at the top of each turn, because whoever
a seat woke last turn has long since taken it.

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

### ifUnanswered: an ask that can answer itself

Any op that opens a commitment — `send`, `request`, `call`, `research_request`,
`request_review` — may carry `ifUnanswered: { assume, afterMs }`: what the asker
will do if nobody answers.

```json
{ "op": "call", "contract": "decision.challenge",
  "ifUnanswered": { "assume": "postgres", "afterMs": 900000 } }
```

An ask carrying one is **never nudged and never escalates as a stalemate**; the
debtor's prompt says in so many words that silence is a legitimate ending here;
and at the deadline the ask discharges `defaulted`, carrying the assumed value,
waking the **asker** rather than raising a card for a human. It is a settlement,
not a loss — the thread resolves. See `docs/protocol.md` for the full semantics.

It is the one thing in the bus that makes an ask *cheaper for the recipient*,
which is why it is worth reaching for on any mesh and not only a low-contact
one. `afterMs` supplies a deadline on a mesh with no `commitments.ttl_ms`; with
neither, the op is refused rather than left to wait forever. An `afterMs` shorter
than the mesh can get an answer back (`commitments.min_default_ms`) is refused too,
naming the floor: a default that comes due before anyone could object is not a
default, it is an assumption nobody had the chance to correct.

## messages: the digest, the inform expiry and the send budget

```yaml
mesh:
  messages:
    digest_threshold: 10      # default
    inform_expiry_ms: 5400000 # default — 90 minutes
    max_sends_per_turn: 5     # default
```

Three keys, all **on by default**, which makes this the one block in `mesh.yaml`
that does not keep the repo's "absent means the behaviour every existing mesh
already has" shape. That is deliberate. The mission these exist for had 145
unread messages in the tech lead's box, 43 in qa's and 22 in the architect's,
with `scheduling.concurrency.max_active_agents: 3` letting three seats run at
once — and 18 code patches merged while not one acceptance criterion moved,
because every seat's turn opened by draining a mailbox. The runtime's interest
registry is nearly inert (4 wakes from 74 eligible events), so **mail, not
interests, is what wakes a seat**, and a knob nobody has heard of would have
bought that mission nothing. Set any key to `0` to get the old behaviour back.

They are one story read from either end: `max_sends_per_turn` decides how full a
box gets, `digest_threshold` decides how much of a full box a turn reads whole,
and `inform_expiry_ms` decides what of it a turn stops reading at all.

None of the three changes how many seats may run at once. That is an operator
decision (`scheduling.concurrency`), and this block is not a way around it.

### digest_threshold

Above this many readable messages, the turn's brief collapses the **news** in it
into **one digest block**. The block names the count, the sender tallies, the
type tallies, the thread ids and their subjects, and **every message id**,
grouped by thread and sender. No payload, note or artifact ref is printed for
them.

"News" is everything that owes no answer and moves no work. **Asks, work
movements and `URGENT` mail are never collapsed** — a `REQUEST_*`, an
`ESCALATE`, a `HANDOFF`, a `FAILED` verdict, a `MISSION` — and are rendered
body-by-body exactly as before, because `message.delivered` means "rendered AND
answered" and a seat handed a summary of an ask it owes has been made to answer
blind. A mailbox of nothing but asks therefore produces no digest at all,
however deep it is.

Nothing is deleted and nothing is marked read by the digest: every message it
names is still in the mailbox, still owed, and can still be pulled individually
with `mesh_inbox` while the turn runs. `message.delivered` keeps its meaning and
its timing — it fires at turn end, for the mail the turn was handed, exactly as
before. Measured on a fixture of 145 INFORMs with 180-character bodies, the one
block is ~571 estimated tokens against ~8,238 for the bodies it replaces.

Exactly `digest_threshold` messages still renders normally; the block appears
one message later.

### inform_expiry_ms

A plain `INFORM` older than this is no longer admitted to the brief. It is still
in the **event log** and still in the **mailbox** — it simply stops spending
brief tokens on a turn that has newer things to read, which is what a stalled
mission's mail section mostly consisted of.

"Plain INFORM" is a narrow, closed test, and the narrowness is the design:

- **Asks never expire, at any age.** `REQUEST_*`, `ESCALATE`, `CHALLENGE`,
  `PROPOSE` and anything else that opens a `pendingRequests` entry is admitted
  forever, because the seat that owes the answer is the only one who can close
  it. The test is the runtime's single obligation predicate, read off the
  `control` envelope — never off agent-written payload.
- **Work movement never expires.** A `MISSION`, `DELEGATE`, `HANDOFF` or
  `FAILED` verdict is this seat's next piece of work; an expiry would be work
  nobody was ever handed.
- **An answer never expires.** A message with `replyTo` settles a commitment,
  and the ledger counts the settlement whether or not the page showed it.
- **`URGENT` never expires**, nor does anything carrying a `note`, an
  `artifactRefs` entry or an `ifUnanswered` default — each is unique content
  rather than a restatement.

An expired INFORM is still **accounted for by the turn**, so it is marked
delivered at turn end like any other mail. That is not an accounting trick: an
INFORM that is neither shown nor delivered stays unread forever, which both
keeps buying `STALE_MAIL` wakes for it and — at the 200-message box cap —
starts evicting fresh mail as `mailOverflowDropped`.

The loader refuses an `inform_expiry_ms` below a minute (60000), with a
sentence rather than a schema keyword: anything shorter is seconds written where
milliseconds belong, the same typo `mesh.runtime.stale_after_ms` is floored
against. `mesh.messages` is closed (`additionalProperties: false`), so a
misspelled key is a load error rather than a silent default.

> **Wiring.** The brief is assembled in `packages/core/src/context.ts`, which
> calls `mailBrief` (`packages/core/src/projections-messaging.ts`) and renders
> its digest as a sub-heading of the unread-mail section, with the
> obligations still rendering body by body below it. `brief.expired` feeds the
> turn-end drain in the same call, so an expired INFORM is still delivered —
> see the section above.

### max_sends_per_turn

How many messages **one seat's turn** may send before the rest of its
FYI-class chatter is held back and delivered as **one digest** when the turn
ends. `0` disables the budget.

The other two keys make a full box cheap to read. This one is the only thing
here that stops it filling: the mailbox cost of the 2026-09-27 run was 282
messages in a day landing in eight boxes, 119 of them at one seat, ~100 never
read. Its default of 5 is that run's own average (282 messages / 53 turns), so
an ordinary turn is untouched and the budget bites on the burst — the seat
answering six colleagues in one turn, which is the shape that produced the
pile-up.

What is **never** held, however far past the budget the turn is:

- **An ask** (`REQUEST_*`, `ESCALATE`, `CHALLENGE`). It goes out as itself, with
  its own thread, contract, deadline and `pendingRequests` entry, and the
  semantic events it derives (`review.requested`, task binding, criterion
  evidence) fire exactly as before. Batching one into a digest would deliver the
  news of a question without the question.
- **A work movement** — `MISSION`, `DELEGATE`, `HANDOFF`, `PATCH_READY`, a
  verdict, a `FAILED` result. A digest cannot hand over custody of work.
- **An answer** (anything with `replyTo`). `replyTo` is what discharges the ask
  it answers; folded into a digest, a debt would stay open that was settled in
  prose.
- **`URGENT` mail**, and anything addressed to the human operator. The sender
  ranked the first above everything else; the second is outside the mesh's
  attention economy, and a notice to the operator buried in a digest aimed at
  seats is the one message it was never told about.

Held chatter is **not refused and not dropped**. At turn end the seat's held
messages become one `INFORM` addressed to the union of their recipients, whose
`payload.entries` carries **each held message whole** — type, recipients,
thread, priority, artifact refs, requirements, note and payload — in send order. It opens no commitment, and on
a mesh with `bus.delivery` it classes `accrue`, so a batch of FYIs cannot buy a
wake per line through the back door. The flush runs from the turn's `finally`,
so a turn that timed out mid-flight still ships what it had written; if the
digest itself is refused by a communication rule, the entries are replayed
individually rather than lost.

The seat is told on the send that crosses the line: the op returns `ok: true`
with no `messageId`, `merged: true`, and a sentence naming the key — so a model
does not read the missing id as a failed send and write it again. That caveat
also rides the turn summary.

**Item 2 of the same redesign — pooling a review ask across several valid
recipients — is not implemented, and cannot be expressed in this model.** The
envelope addresses a list of seats and opens **one obligation per recipient**
(`pendingRequests.outstanding`), and the ledger is explicit that one debtor
answering settles only that debtor's debt. There is no first-responder
semantics anywhere to reuse: the pooled *gate* (`"tech-lead.approve|architect.approve"`
in `policies.transitions`) decides whose approval may ADVANCE an artifact, which
is a different question from who owes an answer. Making an ask answerable by any
of N seats would mean adding a distribution mode to the obligation predicate and
the discharge rules (`packages/protocol/src/catalog.ts`,
`packages/core/src/projections-messaging.ts`) — a change to what a debt IS, not
a config key.

## host.yaml — the multi-project host

Everything above lives in a project's `mesh.yaml`, and describes one mission.
`mesh host` supervises many of them and keeps its own settings in
`<home>/host.yaml` (default `~/.agent-mesh/host.yaml`), beside `projects.json`:
each knob here is **cross-project**, and a value declared by one project would
be one of N conflicting ones. The file is optional — absent, unreadable or
malformed all resolve to the defaults below — and every key may sit inside a
`host:` block or at the top level.

```yaml
host:
  project_memory_mb: 512        # per-child --max-old-space-size
  max_concurrent_turns: null    # null = unlimited
  spend_ceiling_usd: 50         # aggregate across open projects; null disables
  heartbeat_timeout_ms: 60000   # silence before a child is treated as wedged
  default_usd_per_mtok: 3       # fallback price for a model with no entry
  model_prices:                 # USD per million tokens
    anthropic/claude-sonnet-4: { input_per_mtok: 3, output_per_mtok: 15 }
    # Cache prices are optional. Left out, a cache write is priced at 1.25x the
    # input rate and a cache read at 0.1x (Anthropic's standard multipliers).
    # Set them when a model's real rates differ.
    anthropic/claude-opus-5-5: { input_per_mtok: 4, output_per_mtok: 20, cache_read_per_mtok: 0.2 }
```

**What the spend ceiling counts.** The provider bills four classes of token:
fresh input, output, cache writes and cache reads. A mission with persistent
sessions replays its whole transcript every turn, and almost all of its tokens
are cache reads — in the measured five-seat run, 2.64M of 2.86M. The ceiling
prices **all four** (`input_per_mtok`, `output_per_mtok`, `cache_write_per_mtok`,
`cache_read_per_mtok`), so the figure it compares against `spend_ceiling_usd` is
the one on the invoice. Pricing only fresh input and output understated that
run by about five times, and a ceiling that undercounts trips late.

This is deliberately different from a project's **token** budget
(`budgets.mission_tokens`), which does not count cache reads: counting a replayed
history again on every turn would make that budget grow without bound. The token
budget limits work done; the USD ceiling limits money spent. A model with no
entry is priced at `default_usd_per_mtok` for every class, with the standard
cache multipliers. A cache price that is not a non-negative number is ignored
with a warning, and the model stays priced.

The figure is an estimate from list prices, not an invoice: committed-use
discounts, regional pricing and batch rates are not modelled. The usage report
(`mesh usage`) uses the same prices and says so on its face.

`heartbeat_timeout_ms` is how long a child may go **silent** before the
supervision watchdog stops it and restarts it with backoff. The child beats
every 2s and the reading must be stale on **two consecutive polls**, so a single
late poll is never a kill — but the window is what decides whether a busy
host's unread pipe looks like a wedged child. It is 60s by default because the
two errors are not symmetric: a false positive kills a working project mid-turn
and costs its in-flight work, while a slow true positive leaves a wedged tab
stale for another minute, and a wedged child spends nothing. Raise it (or set a
very large value to make a silent child effectively unkillable) on a host whose
child does long synchronous work; `null` is refused with a warning rather than
read as "off". It is **not** editable from the Host settings screen and takes
effect when the host starts, like every other value the supervision tree
captures at construction.

Every supervision decision — a crash, a health kill, a breaker trip — is
appended as one line to `<project>/.mesh/host-supervision.log`: timestamp,
project id, reason, the measured silence in ms, the restart count, and the
action (`restart-with-backoff` with `retryInMs`, or `breaker-tripped`). The
host prints the same decision on its own stderr. The kill path used to leave no
durable trace at all, which is how a mission stopped as "unhealthy" while it
was demonstrably working went undiagnosed.

Each project's entry in `<home>/projects.json` also carries a `lastMode`
(`live` or `parked`): the scheduler mode its child last reported on a beat,
written only when it changes. It is there so a **host** restart restores what
each project was doing — a child restart never needed it, since the supervisor
remembers the mode in memory for as long as it lives. When a project is opened,
the mode to spawn it with is decided in this order: what this host heard from
its child, then `lastMode`, then the host's own default (`parked`, or `live`
under `mesh host --live`). `lastMode` outranks `--live` on purpose: `--live`
answers "this project's mode is unknown", and the same field records a park the
aggregate ceiling imposed — a host that overrode it would spend straight back
through the ceiling. Resume a parked project with `POST /mission/start`.
