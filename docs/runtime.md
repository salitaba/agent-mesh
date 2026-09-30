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
5. `THINKING` → call the runtime adapter with a turn timeout
6. mark the mail the turn actually read as delivered (`message.delivered`)
7. apply the returned **mesh operations** (each re-checked by policy)
8. consume budget (`budget.consumed`, with model/tool-call audit for replay)
9. derive the end lifecycle (`WAITING` if it has an outstanding request, else
   `IDLE`/`BLOCKED`)

Steps 5 and 6 are in that order deliberately, and both halves matter. Mail is
marked delivered **after** the adapter returns, so a turn that crashes or times
out leaves the mailbox owed rather than emptied — a crash used to consume the
mail it never showed anyone. And it marks the messages the context builder
actually **rendered**, not everything that was queued: the context has a per-turn
unread budget (§29), so a deep backlog is drained over several turns instead of
being marked read in one. Delivered means *rendered and answered*; anything else
stays owed.

Every turn's inputs/outputs/model/tokens are appended to `logs/turn-audit.jsonl`
so the **orchestration** layer is deterministic and replayable even though the LLM
is not (§41).

Despite its extension that file is **not plain JSONL**. It is the supervisor's audit
log, and every line is `<ISO timestamp> <text>`: for a settled turn the text is a
JSON record; for everything else (`boot: released 3 budget hold(s)…`, `turn … for pm:
2/5 ops rejected`, `provider breaker: …`) it is a sentence, which may itself span
physical lines when it quotes a rendered artifact. Read it with `parseTurnAudit`
(`packages/observability`), which is what `mesh ledger` does: it counts prose as normal
and reports only a stamped line that opens a JSON record and does not parse as
*damaged*. A reader that `JSON.parse`s every line fails on the first notice. The name is
kept because existing state directories, `mesh ledger` and earlier notes already
use it.

### Turn deadlines

`scheduling.timeouts.turn_timeout_ms` is a turn's **budget**, not a kill switch.
The supervisor owns the deadline; the runtime adapter's own timer is only a
backstop past the ceiling (`turn_timeout_ms × 3 + 30 s`).

- A seat holding a claimed task gets the ceiling, `turn_timeout_ms × 3`, from
  the start, or from the moment it claims mid-turn.
- Any other turn that reaches its budget while still producing frames (a token
  or a tool call within `min(turn_silence_ms, turn_timeout_ms)`) is extended by
  that window and checked again, up to the same ceiling. A quiet one is stopped.
- A turn that goes silent — no frame for `turn_silence_ms` and no tool call
  still running — is interrupted by the silence watchdog, whether it ever
  streamed prose or only called tools.

The seat is warned, not just stopped. At the budget, and again shortly before
the ceiling (`ceiling − min(window, 5 min)`), the supervisor calls
`AgentRuntime.advise`. The Claude adapter delivers the note at the next tool
boundary as a PostToolUse/PostToolUseFailure hook `additionalContext`, telling
the seat to commit (`mesh_commit`), publish, and close with `mesh_done`. Seats
that can edit files are also told their budget and to work in committed
increments, in a `## Turn budget` section of every turn's prompt.

When a turn is stopped abnormally (timeout, silence, a live budget stop, a
runtime failure) with uncommitted files in its worktree, the worktree is
snapshotted to `refs/mesh/checkpoints/<agent>/<turnId>` — a commit built from a
temporary index, so the branch, the index and the files are untouched. The next
turn's `## Your previous turn did not finish` note lists the files and the ref.

While a turn runs, its record (`/turns/:id`, and a summary row on `/steps`)
carries `phases.deadlineAt` / `phases.ceilingAt`, `toolCallCount` (calls, not
frames), `liveTools` (the last 60 calls with their target and status),
`filesTouched`, `liveTokens` (from the adapter's cumulative `usage_update`
frames, which also feed the mid-turn budget stop), `advisories`, and, once
stopped, `checkpoint`. All of them survive a failed turn.

### What counts as a productive turn

A seat acts through **one** channel: the `mesh_*` MCP tools it calls mid-turn.
Each call runs on the live turn, against the same policy engine as any other op.
There is no prose channel — a fenced `mesh-json` (or any JSON) block in the
reply is text, is never parsed, and runs nothing. A turn is unproductive only
when its tool calls moved nothing.

A seat ends a turn with `mesh_done` (its one-line summary is what the mesh
records) or `mesh_wait` (with the reason it is blocked). A turn that made no
mesh tool calls at all is summarised as *"no mesh tool calls this turn"*.

The history is why this is counted by effects, not by any one call. When prose
ops still existed, judging a turn by its ops block alone scored the most
productive turns of a live run as empty: a seat that published three artifacts,
opened five threads and sent four messages through the tools, then closed
without an ops block, was logged *"no work was produced"* and took a strike.
Because three strikes park a seat, and the recovery path re-woke it, one seat
burned 537,479 tokens — 3.6× its configured budget — with every turn recorded
as having produced nothing.

`turn.discarded` records a turn that genuinely produced nothing, with its token
cost, under one of: `no_ops` (no tool call moved anything), `all_rejected`
(every op refused), `timeout`, `silence`, `budget_blocked`, `failed`. It is a
notice with no reducer — nothing projects from it — so it is safe to read as a
pure cost signal.

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
to produce typed mesh ops. This is how Claude Code, custom HTTP agents, and
future A2A agents all plug in without touching the domain model.

### `runtime-opencode` — **removed**

There is no OpenCode adapter. The package is gone, and a config naming it fails
to load with `runtime 'opencode' was removed; <keys> still names it` — caught at
load rather than at activation, because an unregistered runtime name otherwise
resolves fine at boot and fails on the first turn, long after the mesh looked
healthy. Use `claude` (no separate install: it rides on the declared
`@anthropic-ai/claude-agent-sdk` dependency) or `stub` (zero model calls).

The transport it used — `opencode serve` on a local port, health-gated on
`GET /global/health` — is therefore not part of any adapter in this repo. What
survives from it is the interface above, which it was the first implementation
of.

Note: *which* bus tools an adapter is handed is a property of the mesh, not of
the adapter. `tools/list` is filtered per seat -- by the agent's capabilities
and by `bus.vocabulary`, which under `contracts` replaces
`mesh_send`/`mesh_broadcast`/`mesh_respond` with the contract verbs
(`mesh_call`, `mesh_reply`, `mesh_announce`, …). The filtering is
advertisement-only: every adapter can still *call* a tool that was not listed,
so a name a model remembers from another mesh keeps working. See `docs/configuration.md` § bus.

### `runtime-claude`
- Claude Code via `@anthropic-ai/claude-agent-sdk`, a declared dependency that
  drives the Claude Code binary as a child process. **There is no `claude serve`**
  — no local HTTP API, no SSE, nothing to health-probe — so there is no port to
  gate on and no process to attach to. The SDK ships its own executable, so
  there is nothing for the user to install and nothing to preflight
- one **long-lived streaming `query()` per agent**, held for the agent's
  lifetime. Streaming input is not a preference: SDK control requests
  (`interrupt()`, `supportedModels()`) are only supported on a streaming query,
  so a per-turn one-shot could not implement `AgentRuntime.interrupt` at all
- each mesh turn is one `SDKUserMessage` pushed into that query's inbox; a
  single pump loop demultiplexes the `SDKMessage` frames back into per-turn
  state (`assistant` → tool calls, `stream_event` → live token deltas,
  `result` → turn settled)
- liveness is the CLI's `system`/`init` frame rather than a health endpoint.
  `query()` is lazy — nothing spawns until the generator is pulled — so `start`
  and `restoreSession` wait for that handshake (`startupProbeMs`, default 10s)
  before reporting success. A backend that fails to spawn surfaces as a labeled
  `BackendUnreachableError`; one that is merely quiet is given the benefit of
  the doubt
- capabilities become a `canUseTool` callback rather than a static permission
  block: the same capability set, but an unmapped tool **fails closed** instead
  of falling through whatever the config happened not to mention. Capability
  aliases are resolved, so `code.write` grants edit tools
- token accounting reads the per-turn `usage` only —
  `input + output + cache_creation`, with `cache_read` **excluded**.
  `total_cost_usd` and `modelUsage` are cumulative across a streaming session,
  so billing a turn off them would re-charge the whole conversation every turn
- a **usage guard**, always on, corrects a backend that drops its cache report.
  Behind a translating proxy (2026-09-26), a seat's calls began reporting
  `input_tokens` = the whole prompt and `cache_read_input_tokens` = 0 mid-turn,
  while the proxy logged cache hits on the same calls. 55 such calls billed 6.41M
  phantom tokens in 13 minutes, and the ledger, the live counter and seat
  parking all acted on them. A call is re-attributed when it meets all three
  conditions: both of its cache terms are 0, the prompt the evidence names was at
  least 8,000, and its own prompt is at least that large. That evidenced prompt
  is then billed as `cache_read` and only the remainder as `input`. The evidence
  is the previous call's prompt (`input + cache_read + cache_creation`) when the
  call has one **within its turn**, and — for a turn's **first call** — the
  previous **turn's** final prompt of the same session, which the adapter records
  per session as a measurement and reads back through
  `mesh.runtime.stale_after_ms`: the window that already says how long a session
  may idle before its cache is assumed cold. That window is the only one; a
  prompt measured through the live proxy was still 94% cached upstream after a
  10-minute idle gap (2026-09-27), so a turn boundary is not by itself a cold
  cache. The record belongs to the session, so a rotation — which opens a fresh
  session — starts with none, and so does a session's first turn. A shrunk
  prompt, a call reporting any cache term, and `output` are never touched. The
  adapter applies the move before `usage_update` frames leave it, so the live
  figure, the settled `turn_end` figure and the ledger agree. Rotation sizing is
  unchanged, because the move does not change a prompt's size. To recognise it:
  the audit log carries one `claude runtime: <seat>: usage re-attributed …` line
  per seat session, and the adapter's `turn_end` (and `send` output) carries
  `usageGuard`, which holds `adjustedCalls`, `reattributedTokens`,
  `firstCallAdjustments` (how many of those calls were a turn's first; absent
  when none were) and the `raw` versus `adjusted` totals. A backend that truly
  never caches is under-billed by the guard, and the audit line is how you would
  spot one
- the mesh MCP bridge is wired through the SDK's `mcpServers` option, the same
  `mesh mcp` stdio bridge the other adapters spawn. A bridge that is not
  connected in the `init` frame is read as a **startup race before it is read as
  a mute seat**: the CLI settles that status once, as the query starts, so the
  adapter tears the query down and respawns it — up to 3 times, waiting 1s, 2s
  then 4s (7s in all, against a `turn_silence_ms` window of 300s and a ceiling
  of `turn_timeout_ms × 3`) — and retries the whole turn on the new query: same
  mesh session id, same input, same armed deadlines. A query that was a resume
  is re-resumed, so the seat keeps its transcript; one that was a fresh start
  gets a fresh id, having nothing to lose. If the bridge is still down after the
  budget, the turn fails with exactly the message it always did, and only then
  does `onMuteSuspected` fire — a transient retry is not a mute seat. The
  `turn_end` carries `bridgeRespawns` when any spawn was spent, and the audit
  log carries one `claude runtime: <seat>: the mesh MCP bridge was not up at
  init …` line per seat session, which is what tells a race from a real failure.
  A `pending` bridge — the CLI's non-blocking connect still dialling — is not
  down, and costs no spawn and no delay
- **a bound on one `mcp__mesh__*` tool result**, applied where the payload is
  produced rather than where it arrives. Over the 2026-09-27 skill-panel run the
  five read tools (`mesh_artifact_read`, `mesh_inbox`, `mesh_query_events`,
  `mesh_failures`, `mesh_run_status`) returned 3.0M of the 3.1M characters the
  whole `mesh_*` surface produced: p90 20k-40k per call, a 52k worst case, and
  no `mesh_failures` or `mesh_run_status` result under 11k. A result that size is
  not paid once — it stays in the prompt for every later call of the turn
  (~20 measured) and every later turn of the session until a rotation. The mesh's
  own MCP handlers now page their rows under `TOOL_PAGE_CHARS` (8,000 characters)
  and return a continuation: `nextOffset` for the row-per-item reads (inbox,
  events, steps, artifact reads) and a `section` index for the aggregate ones
  (failures, run digest, run status). Measured after the change, on live-sized
  fixtures: inbox 47,462 → 6,737 characters, event query 44,611 → 7,826, artifact
  read 43,701 → 7,834, and every message, event, artifact byte and section row is
  still reachable by paging.
- **Do not try to bound this in the adapter.** A `PostToolUse` *callback* hook in
  a headless (`--print`/stream-json) session cannot rewrite a tool result: the CLI
  harvests exactly `systemMessage`, `worktreePath` and `decision:"block"` from a
  callback's return, dropping `hookSpecificOutput` whole. Command, HTTP and plugin
  hooks do receive `updatedToolOutput`/`updatedMCPToolOutput`; callbacks do not.
  The adapter-side clip written on 2026-09-27 was inert for exactly that reason —
  325 mesh results, none clipped — and was removed. Reinstate it only with a live
  demonstration that the CLI in use honours it.
- **a `## Reading` brief in the system prompt** (`withReadingDiscipline`,
  appended beside the shared output-voice rules and written into `ROLE.md` for
  the same reason those are). Growth in a turn's prompt is spread over its
  calls — measured median +1,285 tokens per call, p90 +5,659, top 5% of calls
  only 30% of the total — so no bound on one result reaches it; how the seat
  reads does. The SDK's `Read` returned 2.79M characters over 114 calls in that
  run, 24,485 per call, each re-sent with every call after it. Five lines:
  `grep -n … | head` to locate, `sed -n 'a,bp'` to read the range, never re-read
  a file you already have, and cite paths rather than pasting contents
- no `reasoning` token field (Claude's usage has none), and the system prompt is
  snapshotted at a session's first request, so mid-run `ROLE.md` edits land only
  after compaction
- **a seat's shell may not land work on the product branch.** `git.merge` is a
  capability: the `merge` op enforces it and the `patch.merge` gate, and records the
  landing (`patch.merged`, the MERGED transition, `implementation-merged`). A seat
  with a shell could run the same `git merge` in the product checkout from Bash and
  none of that applied. In the cronlite run the developer, which held no `git.merge`,
  ran `cd <workspace>/main && git merge mesh/developer` and the product branch moved
  49 s before the tech lead's proper `mesh_merge`, with nothing on the log; in the next
  run it also tried `git push -f origin mesh/developer:main`. For every Bash call of a
  seat in a git mesh the permission gate now reads the command text and refuses the
  half of that boundary it can state without a sandbox: **git commands that run in the
  product checkout may only read it** (status, diff, log, show, …; a `branch`/`tag`
  only as a listing), and **`git push` needs `git.merge`**. It follows `cd`, `git -C`,
  `--git-dir`/`--work-tree`, `GIT_DIR`, `bash -c`, `eval` and `$(…)` (to a depth of 4),
  and splits on unquoted `;` `&` `|` and newlines. A directory the text cannot resolve
  (a variable or a substitution) is refused **only for `git merge`**: the seat's own
  worktree is the common, legitimate target of `cd "$(git rev-parse --show-toplevel)"`,
  and a blanket refusal would fail every such commit to catch the one move this exists
  for, so any other git subcommand run in an unresolved directory is allowed. A git
  command in the seat's **own** worktree is untouched (merging `main` into its own branch
  is ordinary work), and so is everything that is not git. The supervisor hands the
  product checkout's path to the adapter as `RuntimeContext.productPath`; a mesh with no
  git workspace has none, and no gate. **It is a text-level gate**: it stops the move a
  helpful model makes by reflex, not a seat determined to get around it, and
  filesystem writes (`cp`, a redirection, the Edit tool) into the product checkout are
  a different boundary that is **not** drawn here
- **seats a dead mesh left running are stopped, not resumed alongside.** Each seat is a
  long-lived `claude` child holding a streaming session. SIGKILL or an OOM kill takes the
  mesh process and leaves the child, reparented to init and still mid-turn, still
  calling the API, its spend recorded nowhere (measured: still going 56 s after the
  kill), while the restarted mesh resumes the **same** session id, so two CLIs can
  write one transcript. The adapter stamps every seat it spawns with the pid of its
  host (`AGENT_MESH_HOST_PID`, inherited by whatever the seat started). Before the
  first seat of a new process starts, the adapter scans `/proc/<pid>/environ` of the
  processes it may read, and sends SIGTERM, then SIGKILL after a 2 s grace, to those
  whose stamp names a host that no longer exists, reporting the ones it stopped (and
  any it could not) as an `orphan_seats_reaped` adapter notice. **Linux only**: there is
  no cheap, reliable way to read another process's environment elsewhere, so elsewhere
  it does nothing. A pid that has since been reused by an unrelated process reads as a
  live host and is left alone, which fails safe: a leak persists, nothing innocent
  dies. The spend of an orphaned turn is stopped, not recovered
- **what the launching machine lends a seat.** The SDK loads every filesystem settings
  source unless told not to, and a mesh started from inside another Claude Code
  session inherits that session's environment, so a seat ran under the launching
  user's hooks, allow rules, `env` and model, and its CLI reported the outer session's
  id and effort. `mesh.runtime.isolate_host: true` spawns seats with
  `settingSources: []` and without the outer session's variables (credentials, routing
  and proxy variables are kept); without it, the boot log says what would leak and
  names the key. See `docs/configuration.md` § `isolate_host`

### `runtime-http`
- generic custom/remote agents over `POST /sessions`, `/turn`, `/interrupt`, …
- used to attach Codex/A2A, or any agent, behind an HTTP shim (Claude Code no
  longer needs one — see `runtime-claude` above)

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

### A process killed mid-turn

SIGKILL, an OOM kill or a lost machine ends a mesh between writes the log expects to
come in pairs. Boot cleans up what a pair left open, event-sourced so replay
reproduces it, and idempotent so a later boot finds nothing to do:

- **The turn is closed and counted.** A turn the log shows as begun and never ended is
  closed with an `agent.state_changed` to `IDLE` (note `turn abandoned by server
  restart`) **and** a `turn.discarded` with reason `interrupted` and no `tokens`: what
  the dead turn spent was recorded nowhere, and absent means unmeasured, never zero. A
  view of discards or spend used to hold a turn that began and never ended.
- **Its budget holds are released** (boot step 8b'). A turn takes its holds (seat,
  mission, thread) before it calls the model and gives them back, consumed or released,
  in the `finally` that ends it. A process that dies between the two leaves a
  `budget.reserved` the projection replays as live forever: after a SIGKILL mid-turn the
  tech lead's ledger read `reserved: 17094`, and so did the thread's and the mission's,
  with no turn running, and each crash left one more turn's estimate of headroom
  unspendable until the mission was reset. Every hold still open at boot belongs to a
  turn the old process never finished (nothing is running yet), so each is released as a
  `budget.released` from `recovery-manager` with the reason `abandoned: the process that
  held it ended before settling it`. **Released, not consumed**, because a figure
  invented here would be billed as fact. The audit log gets one `boot: released N
  budget hold(s)…` line.
- **The seat CLIs it left behind are stopped** before any new seat starts (`runtime-claude`,
  above).

A *deliberate* stop is not reported as a crash. When the mission ends (or an operator
shuts the mesh down) the in-flight turns are stopped by the mesh itself, and their
`turn.discarded` detail reads `stopped by the mesh shutting down[ after the mission
ended] (…)`, without the `the server process may have crashed — check that it is still
running` hint the runtime appends to a genuine backend loss: on a normal end of mission
that hint sent the operator looking for a failure that never happened. The seat's
memory note says the same. Completion waits for the in-flight turns to settle (up to 30 s)
before it retires the seats and stops the scheduler, so the teardown does not race its own
agents.

### Provider outages: the mission-wide breaker

A turn the model *provider* refuses is not the seat's failure, and does not walk
the seat's ladder. `classifyProviderOutage` (`protocol/src/errors.ts`) reads the
failure the runtime surfaced: an `API Error` segment from the model client (the
Claude adapter carries the CLI's line verbatim) whose status is 429, 402,
401/403 or 5xx — or, with no status, says `overloaded`, `usage limit`, or
`Connection error` (the proxy is down) — plus the HTTP runtime's own status line
and provider error types such as `rate_limit_error`. Our own timeouts and
aborts, a `BackendUnreachableError` (a seat's own process or endpoint), a 4xx the
seat's request caused, and any model or tool text that merely mentions a status
stay seat failures.

An outage turn is discarded and billed as usual, but the seat goes back to IDLE:
no crash strike, no released task, no discharged asks, no SUSPENDED park, no
per-seat card. Its retry is queued seconds later, and the failure is reported
to the scheduler as `noteTurnOutcome(seat, "outage")`, which feeds the
mission-wide half of the scheduler's circuit breaker (never the seat's strikes):

- **Trip**: `PROVIDER_TRIP_FAILURES` (3) outage failures from any seats within
  `PROVIDER_TRIP_WINDOW_MS` (2 min) open it. While open, activations still
  queue — nothing is lost — but the pump dispatches none of them (queue wait
  kind `provider`); explicit operator wakes still run. One advisory
  `provider_unavailable` card (conflict key `provider:<goal>`) names the verbatim
  error, the refused turns and seats, and the next attempt.
- **Half-open**: after the backoff (`providerBackoffMs`: 5, 10, 20, 40, then 60
  min) exactly one queued turn is admitted as the probe; the supervisor wakes a
  seat if none is queued. A probe that ends without a verdict (budget refusal,
  timeout, a seat's own crash) passes the slot to the next queued turn.
- **Close / re-open**: the probe's model answer closes the breaker, the card is
  retired with `escalation.auto_resolved`, and the held queue drains. Another
  outage re-opens it with the backoff doubled, and the card is restated in place
  (`escalation.requested` with its own id) with the new next attempt.
- **Operator**: answering the card probes immediately (`probeProviderNow`).

Every transition writes one `provider breaker:` audit line. The breaker never
starts a stopped scheduler: a parked mission's probe waits for the operator
like every other non-explicit wake. Seats already parked the old way are still
revived by an escalation answer (`reviveTerminalSuspended`).

## Termination & deadlock

Termination manager (§33): success (all mandatory criteria evidenced), budget,
wall-clock, `max_events`, stalemate and runtime failure → `COMPLETED`/`ESCALATED`
/`FAILED`. Deadlock detector (§34): thread-depth, repeated-conflict fingerprint,
and review-round overflow generate a `DisagreementRecord` artifact (positions,
evidence, attempts) and raise a human `ESCALATE`. The manager's own verdicts are
attributed to `termination-manager`, not to the operator (`docs/protocol.md` § `actorId`).
A run report read off a mesh that was stopped mid-mission (goal still `ACTIVE`, no
termination reason in the log) says so — `Stopped before the goal was met` — rather than
that the build has no phrasing for `goal_active`.

### What counts as satisfied, and what a reopen withdraws

`criterionSatisfied` is the one definition, shared by the termination verdict, the
criterion-removal guard and the watchdog's diagnosis of why a mission is stuck, so they
cannot disagree: a criterion is satisfied when it is `WAIVED`, or `EVIDENCED` **and**
its evidence belongs to the round it has to be satisfied in.

`ASSERTED` is not `EVIDENCED`. A criterion a seat claims from a turn that **checked**
nothing stays `ASSERTED`, and an unproven mission stays open. What counts as checking is
deliberately narrow: a completed tool call that touches the world outside the mesh (a
shell, a file read, a test runner), or the one `mesh_*` tool that reads an artifact's
content (`mesh_artifact_read`). Every other `mesh_*` call is how a turn *acts* (send,
publish, approve, merge), and counting those would make the gate self-satisfying: "I
approved it, therefore it is verified". A failed call, such as a permission-gate denial,
ran nothing and does not count. Reading the artifact used to count for nothing, so a
tech lead that read a whole artifact twice before approving it produced a criterion
accepted blind and then accepted *again* after a token-cheap `ls` — five extra PM rounds
in the cronlite run.

**A reopen names what it rejects.** `POST /mission/reopen { reason, criteria? }` sends
the named criteria (every mandatory one when `criteria` is omitted after a verdict) back
to `UNSATISFIED` and stamps each with `withdrawnAt`: the round they must now be satisfied
in starts there, and evidence recorded before it belongs to the attempt the operator
rejected and no longer counts (otherwise a reopen is answered by re-approving the same
artifact and the mission re-completes within a tick: one live mission ran six completes
and five reopens that way). A criterion the reopen did **not** name keeps its verdict and
its evidence — there is no `withdrawnAt` on it, so nothing newer is demanded. The
predicate used to compare every criterion's evidence against the goal-wide `reopenedAt`
(`Goal.reopenedAt` is still stamped, as *when*), so a mission reopened on three of seven
criteria could never complete: all seven `EVIDENCED`, goal `ACTIVE`, nothing left for
anyone to do (cronlite 2026-09-30). An `ESCALATED` mission was halted by an open card and
never judged, so reopening it withdraws only the criteria it names (none, when it names
none) and answers the cards. A state snapshot written before `withdrawnAt` existed is
migrated on import: a criterion of a reopened goal that is still `UNSATISFIED` or
`ASSERTED` is stamped with the goal's `reopenedAt`.

## State & persistence

Local v1: `events.jsonl` (canonical, append-only) + JSON snapshots + filesystem
artifacts + git worktrees, with an optional `node:sqlite` event index. The
architecture keeps no authoritative state in process memory, so the same kernel
can later run against PostgreSQL + object storage + a distributed bus without
changing the protocol.

The seat prompts the Claude adapter writes (`.mesh/agents/<seat>/ROLE.md`,
`MESH_CONTEXT.md`) live inside the working tree, so the product repository's
`.git/info/exclude` names `.mesh/` (appended once; an adopted repository's own
`.gitignore` is never rewritten), and the commit path stages with `git add -A` and then
unstages `.mesh`. Before that, a seat's `git add -A` committed the seat prompts to `main`
and the delivered tree shipped them.

`mesh status` reads the mission's progress from the criteria themselves: progress is a
projection of the acceptance criteria, so a restored state rebuilds it on import instead
of reporting `null` (0%) on a completed 6/6 goal until the next criterion moved.

## CLI / server / dashboard

- `mesh run mesh.yaml` boots the supervisor live (scheduler on, startup agents
  fire), starts the HTTP/SSE server and (on a
  TTY) the TUI. `mesh serve`/`up` is live + dashboard without the TUI.
  `mesh console mesh.yaml` (alias `ui`; or `run --parked`) serves the same
  dashboard/API with the scheduler **parked**: no startup, interest or timer
  cascades run on their own. Operator actions still work — a manual *wake* runs
  exactly one turn (step the mesh agent by agent), `POST /messages` with
  `wake:true` (the dashboard's "wake after send" checkbox, on by default while
  parked) sends mail and steps recipients in one action, and
  `POST /mission/start` (the ▶ button, idempotent) flips the console live in
  place. `POST /mission/park` parks it again.
  `mesh status|graph|events|agents|inspect|replay|pause|resume|approve|reject|respond|artifacts|budgets|escalations`
  talk to `/api`.
- `mesh host` supervises one child per registered project. Each child's mode is
  remembered **per project**, taken from the mode that child reports on its
  heartbeat — the host only ever proxies `/mission/start` and `/mission/park`,
  so the child is the only process that knows which mode it is in. Opening or
  restarting a project re-spawns its child in that remembered mode, which is
  what stops an operator restart from silently parking a live mission; a project
  nothing is known about still launches in the host's own default (`--live`, or
  parked). A park the host itself applied — the aggregate spend ceiling or the
  turn cap — is remembered the same way, so a restart does not walk back over
  the limit that parked it.
  A child parked while its goal is ACTIVE is the one state that reads as a
  running mission and runs nothing: `/status` carries `parkedNotice` (rendered
  as a banner with a **Start** button by the console), `POST /goals/:id/resume`
  returns it as `notice` on an otherwise normal 200, and the host prints the
  same sentence on its own stderr when it sees that state on a heartbeat.
- The host also watches liveness: a child silent past `heartbeat_timeout_ms`
  (`host.yaml`, 60s) on two consecutive polls is stopped and restarted with
  backoff. The window is wide because the cost is asymmetric — killing a working
  project costs its in-flight turns, killing a wedged one late costs nothing but
  a stale tab. Every such decision, and every crash and breaker trip, is
  appended as one line to `<project>/.mesh/host-supervision.log` and printed on
  the host's stderr, so a kill that used to be visible only in a rotated child
  log is durably recorded.
  The line also carries the child's **own** verdict on its event loop:
  `eventLoopLagMaxMs=` is the worst lag the child measured since it started,
  taken from the last beat it managed to send. Silence alone cannot separate a
  loop blocked by synchronous work — which comes back on its own, and whose
  in-flight turns are exactly what killing it destroys, as happened on
  2026-09-28 — from a process wedged for good, and those two want opposite
  responses. The field is **absent**, never zero, when no beat carried one: "it
  never told us" and "its loop was fine" are different facts. What it cannot
  show is a block that began *after* the last beat, so it is read together with
  `silenceMs`, never alone. The child samples its own lag on a 1s timer and
  reports it on the 2s beat; the same numbers are on `GET /health` as
  `eventLoopLagMs` / `eventLoopLagMaxMs`.
- `mesh init` templates `runtime: default: claude`. There is no PATH probe for
  it and there should not be: its executable ships with the SDK, so a check
  would fail on a working install. `mesh run` needs no backend preflight to
  print guidance about.
- `mesh emit-schemas` regenerates `schemas/*.json` from the code (single source).
- `mesh bench` runs the mesh-vs-single comparison across the A–F corpus.
- `mesh mcp` is the internal stdio↔HTTP bridge, spawned by the Claude adapter
  (`runtime-claude` registers it as the `mesh` MCP server) to reach `/api`.
- The dashboard (`apps/mesh-dashboard`) renders five views from the same event
  projections: mesh graph, goal progress, artifact timeline, cost, live event
  stream (SSE) — the UI holds no separate state.
