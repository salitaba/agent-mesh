# Handoff: add a `claude` agent runtime alongside `opencode`

Status: **items 1-4 implemented and green. Item 5 open, and verified NOT a blocker.**
Written 2026-09-14. Branch at time of writing: `feat/plan-visibility`.

## Session 2 result (2026-09-14)

Built: `packages/runtime-claude/` — `AgentRuntime` over one long-lived streaming
SDK query per agent. Registered at `apps/mesh-server/src/index.ts` next to opencode.
Workspace typechecks clean; `tests/integration/claude-runtime.test.ts` 10/10 pass;
`adapters.test.ts` still 18/18.

Resolved beyond the original plan:

- **Gap 1 (liveness) is closed.** `query()` is lazy — nothing spawns until the
  generator is pulled — so `open()` alone could hand back a session whose first
  turn would die. The CLI's `system`/`init` frame is now the handshake:
  `confirmAlive()` races it against `startupProbeMs` (default 10s). A dead spawn
  makes the pump throw and is caught in ~15ms; a *quiet* backend resolves to
  "assume alive", because whether init precedes the first user message in
  streaming mode was never confirmed. `start()` throws `BackendUnreachableError`
  on a confirmed-dead backend, `restoreSession()` returns null.
- `init.mcp_servers` is recorded on the session (`LiveSession.mcpStatus`) — the
  mute-seat detector the MCP wiring note asks for. Nothing consumes it yet.
- Budget charge is `input + output + cache_creation`, `cache_read` EXCLUDED, read
  only from per-turn `usage`. `total_cost_usd`/`modelUsage` are CUMULATIVE on a
  streaming-input session; billing off them reproduces the opencode runaway.
  Pinned by test.
- Capability gate is a `canUseTool` callback, fails closed on unmapped tools, and
  resolves `CAPABILITY_ALIASES` (`code.write` → `repository.write`, `test.run` →
  `test.execute`). A `git.commit`-only seat gets exec, since opencode's `"ask"`
  has nobody to answer it on a mesh turn.
- `usageToTokens` / `buildPermissionGate` / `toClaudeModelId` are exported as pure
  functions so they unit-test without spawning a CLI.
- `extractSummary` and `shortDigest` gained `export` in `runtime-opencode` rather
  than being forked. That sideways import is a marked seam — lift the op-protocol
  parser into `packages/agent-runtime` when item 4 touches this area.

Still open from the gap list: no `reasoning` token field (2), system prompt snapshots
at first request (4). **Gap 3 is closed** — the SDK does expose model enumeration
(`Query.supportedModels()`, `sdk.d.ts:2763`, returning `ModelInfo{value, resolvedModel?,
displayName}`), so `listModels()` is real data rather than the static list the notes
predicted. It is a control request, so it needs a streaming query: the implementation
opens one with an inbox it never pushes to, which costs no tokens.

## Session 3 result (2026-09-14) — item 4

`DesignerRuntime` is now a port in `packages/protocol/src/types.ts`, next to
`AgentRuntime` and deliberately separate from it: designer turns have no mesh session,
no capability grants and no bus identity, so folding them into `AgentRuntime` would
oblige every agent backend to answer questions it has no business answering.

- `MeshInstance.opencodeRuntime: OpenCodeRuntimeAdapter` → `designerRuntime: DesignerRuntime`.
  The rename is half the fix: the old name described the implementation, not the role.
- Both adapters declare `implements ... DesignerRuntime`, so a signature drift fails in
  the adapter rather than silently at the consumer.
- `OpenCodeRuntimeAdapter` now appears in `apps/mesh-server/src/index.ts` only at `:197`
  where it is constructed. A composition root is allowed to know concrete types; the
  other 700 lines no longer do.
- **The designer runs on Claude** with `MESH_DESIGNER_RUNTIME=claude`. Opt-in on purpose:
  inferring it from a `mesh.runtime.model` of `anthropic/claude-...` would flip the
  designer off a working opencode install on the basis of a statement about agent turns.
- Claude's designer turns use non-streaming input (one-shot, nothing to interrupt) and
  tear the process down in a `finally` — the agent-session path is the only one that
  keeps a CLI parked.

Tests: 34/34 across `designer-chat`, `adapters`, `claude-runtime`.

## Session 3 result — item 5, and why it was the wrong fix

**Do not add `hasClaudeCli()`.** The item as originally written assumed symmetry with
opencode that does not exist. `pathToClaudeCodeExecutable` is documented "Uses the
built-in executable if not specified" (`sdk.d.ts:1833-1835`), and
`@anthropic-ai/claude-agent-sdk` is a declared dependency (root `package.json:30`,
while opencode is in no dependency list at all). So opencode is an external binary the
user installs; claude rides on a bundled one. A PATH probe for `claude` would fail on a
working install, and a credential probe would wrongly reject OAuth / apiKeyHelper users
— both are the same false-failure class. The reasoning is recorded at
`packages/config/src/index.ts:843` so the asymmetry does not get "fixed" later.

What shipped instead: the live-mode preflight error at `apps/mesh-cli/src/index.ts`
offered only "install opencode" or "degrade to stub". It now also offers
`mesh.runtime.default: claude` as the no-install option, and the non-live warning says
the same. A claude backend that genuinely cannot start still reports it at `start()` as
a labeled `BackendUnreachableError`, which is the right place for it.

Full suite after item 5: **960/960**.

---

**Item 5 background — not a blocker, verified.** `apps/mesh-cli/src/index.ts:282` gates on
`needsOpenCode`, which is computed from the config (`:280-281`) — a mesh whose default
and agents are all `claude` never trips it. What is missing is the *symmetric courtesy*:
no `hasClaudeCli()`, so a claude mesh on a machine without the CLI fails at `start()`
with `BackendUnreachableError` instead of at preflight with install instructions.
Roughly four edits: `hasClaudeCli()` beside `hasOpenCodeCli` (`packages/config/src/index.ts:849`),
a `needsClaude` branch at `apps/mesh-cli/src/index.ts:282`, and leave the
`init` defaults at `:378` / `apps/mesh-server/src/host.ts:585` alone.

This file exists so the next session does not repeat ~79k tokens of discovery.
Everything below is verified against source or docs. Do not re-explore it.

---

## Goal

Let a mesh agent declare `runtime: claude` and be backed by Claude Code, without
removing the existing `opencode` runtime. Both should coexist; `examples/*/mesh.yaml`
must keep working unchanged.

## Decision already made

**Long-lived SDK client per agent.** The adapter holds an in-process streaming
Agent SDK client alive for the agent's lifetime, mirroring today's
one-server-per-agent semantics. Rejected alternative: stateless per-turn
`query()` with `resume` — simpler and crash-resilient, but guts `getStatus`
and makes `interrupt` awkward.

---

## Key structural finding

**There is no `claude serve`.** No local HTTP API, no SSE endpoint, no per-turn
message POST. The entire opencode transport has no analogue and is replaced, not ported:

| opencode transport | file:line |
|---|---|
| spawn `opencode serve --port … --hostname 127.0.0.1` | `packages/runtime-opencode/src/index.ts:690`, spawn at `:704` |
| readiness probe loop until `startupTimeoutMs` | `:734-748`, `GET /global/health` then `GET /session` at `:751-770` |
| blocking `POST /session/{id}/message` (turn completion signal) | `:1083`, body built `:1070-1075`, comment `:1076` |
| SSE `GET /event`, `message.part.delta` frames | `extractSessionPart` `:1460-1479`, taps `:1212` `tapTokenStream`, `:1294` `tapPromptStream` |
| `POST /session/{id}/abort` | `:1349` |
| session create / rehydrate | `POST /session` `:1022-1024`, `GET /session/{id}` `:1044` |

Child stdout/stderr is only tail-buffered for crash forensics (`:721-733`), never parsed.

**Substrate to use instead:** `@anthropic-ai/claude-agent-sdk` (TS). It is a library
you import that drives the Claude Code binary as a child process — no separate server,
no network hop. Docs position subprocess-CLI as the path *for other languages*; this
repo is TypeScript, so the SDK is the intended route. The SDK gives sessions, not a
daemon — the long-lived supervisor is ours to write (that is the decision above).

---

## What already works in our favor

- Interface: `AgentRuntime` — `packages/protocol/src/types.ts:1062`
  (`start/send/interrupt/suspend/resume/stop/getStatus/restoreSession?`)
- Registry: `StaticRuntimeResolver.register(name, runtime)` —
  `packages/agent-runtime/src/index.ts:163-181`; port in `packages/core/src/ports.ts`;
  injected into `Supervisor` at `apps/mesh-server/src/index.ts:247`
- Three sibling adapters already implement it: `runtime-opencode` (`:389`),
  `packages/runtime-http/src/index.ts:29-30`, `StubRuntime`
  (`packages/agent-runtime/src/index.ts:58`), plus inline `"none"` human seat at
  `apps/mesh-server/src/index.ts:210-225`
- **No type or schema surgery needed.** `RuntimeTypeName = string`
  (`packages/protocol/src/types.ts:14`); `schemas/mesh.schema.json:79-84` and `:179-181`
  declare `runtime` as a plain string with **no enum**.
- **The mesh op protocol survives untouched.** `parseMeshOps` (`:1487`), `OPS_BLOCK`
  regex (`:1443`), `parseYamlishOp` (`:1517`), `extractText` (`:1416`),
  `extractReasoning` (`:1425`), `extractSummary` (`:1568`) all parse reply *text* and
  are transport-independent. Reuse as-is; consider lifting to a shared package.

---

## Work items, in order

### 1. New package `packages/runtime-claude` — DONE
Implement `AgentRuntime` over a per-agent long-lived SDK client.

Mapping:

| `AgentRuntime` | opencode today | Claude via SDK |
|---|---|---|
| `start` | spawn server + probe | construct client; no server to start |
| `send` | blocking HTTP POST | await result message |
| `interrupt` | `POST /abort` | `q.interrupt()` — CONFIRMED, streaming-mode only |
| `suspend`/`resume` | session id retained | `resume` + `sessionId` |
| `restoreSession` | `GET /session/{id}` | `resume` / `listSessions()` |
| `getStatus` | `GET /global/health` | `system`/`init` handshake + pump liveness (gap 1 closed) |

Streaming: `includePartialMessages` is the replacement for the SSE delta tap feeding
`tapTokenStream` / `tapPromptStream`.

### 2. Per-agent config generation — DONE
opencode synthesizes a whole config file per agent at
`packages/runtime-opencode/src/index.ts:543-609` (written as `opencode.json` at `:609`,
`$schema` at `:544`). Three concerns, each needs a Claude equivalent:

- **Role prompt.** `ROLE.md` written to `<workspace>/.mesh/agents/<agentId>/` at
  `:526-527`, referenced via `instructions: [path.join(dir,"ROLE.md")]` at `:545`.
  `MESH_CONTEXT.md` also written at `:611`.
  → SDK `systemPrompt` (CLI: `--system-prompt-file` / `--append-system-prompt-file`).
  Note CLAUDE.md is injected as *conversation* context, not system prompt — they coexist.
- **Capabilities → permissions.** `permissionsFor()` at `:616-634` builds opencode's
  static `permission` block.
  → `permissionMode` + `allowedTools` / `disallowedTools` / `tools`, **plus** a
  `canUseTool` callback. The callback is a programmatic hook and is a *better* fit for
  mesh capabilities than the static block. Prefer it.
  (`--allowedTools` only auto-approves; `--tools` is what actually restricts availability.)
- **MCP mesh wiring — load-bearing.** `:528-540` and `:589-601` wire
  `mesh` → `[process.execPath, apps/mesh-cli/bin/mesh.mjs, "mcp", "--agent", <id>,
  "--bus", <busUrl>, "--token", <token>]`. This is how agents call back into the mesh;
  if it does not survive, agents go mute.
  → SDK `mcpServers` option. Direct map. Under `-p` the CLI waits for pending servers up
  to `MCP_TIMEOUT` (30s) and reports via `mcp_servers` / `mcp_server_errors` in `system/init`.

### 3. Register it — DONE
`apps/mesh-server/src/index.ts:206` — add alongside the existing
`resolver.register("opencode", opencodeAdapter)`.

### 4. Unpick the concrete-class leaks (the real work) — DONE
`apps/mesh-server/src/index.ts` holds the concrete adapter, not the interface:

- `:35` imports `OpenCodeRuntimeAdapter` directly
- `:83`, `:297` expose `opencodeRuntime: OpenCodeRuntimeAdapter` on the instance
- Off-interface calls: `prompt()` `:1454`, `promptStream()` `:1480`,
  `listModels()` `:705` and `:1508`, `setDesignerObserve()` `:1721`, `stopAll()` `:2126`

`prompt()` / `promptStream()` are one-shot designer prompts (no mesh session) and map
fine to a bare `query()`. The rest need a home — either widen `AgentRuntime` with an
optional capability interface, or give the designer its own explicit runtime handle.

### 5. Binary-name preflight is hardcoded in two places — NOT STARTED
- `packages/config/src/index.ts:851` — `spawnSync("opencode", ["--version"])` (`hasOpenCodeCli`)
- `apps/mesh-cli/src/index.ts:281`, `:285-287`, `:293`, `:378`; also `apps/mesh-server/src/host.ts:585`

Also: default runtime string is `"opencode"` at `packages/config/src/index.ts:387` and
`:861`; dashboard default at `apps/mesh-dashboard/src/designer/model.ts:170`. Leave these
defaulting to opencode unless the user asks to flip them.

---

## Gaps being accepted (flag to user before/while building)

1. **`getStatus` loses its meaning**, and with it the `BackendUnreachableError` (`:501`)
   vs `RequestTimeoutError` (`:490`) classification — that split exists because there is
   a server process to find dead. Process death currently sets `UNREACHABLE` via
   `proc.on("exit")` at `:727`. Needs a new liveness story built on the SDK client.
2. **No `reasoning` token field.** We read `info.tokens{input,output,reasoning,cache{read,write}}`
   (`OpenCodeMessageResponse`, `:1401-1414`). Claude's result message gives
   `usage.{input_tokens,output_tokens,cache_creation_input_tokens,cache_read_input_tokens}`,
   `total_cost_usd`, `modelUsage`, `num_turns`, `duration_api_ms`, `terminal_reason`,
   `permission_denials`. No reasoning line. Also **`usage` excludes subagents while
   `total_cost_usd` includes them** — matters if mesh agents spawn their own.
   Costs are client-side estimates, not billing.
3. **`listModels()`** currently spawns `opencode models --verbose`
   (`packages/runtime-opencode/src/index.ts:837`). No confirmed Claude equivalent.
   Likely becomes a static list.
4. **System prompt is snapshotted at the session's first request.** Later
   `append`-style changes only land after compaction or a new session. If anything
   mutates `ROLE.md` mid-run today and expects pickup, behavior changes.

## Unconfirmed — verify before relying on

- TS SDK `interrupt()` exact method name/behavior (the TS reference page was truncated
  during research; Python is `ClaudeSDKClient.interrupt()`, streaming mode only).
  `system/init.capabilities` exposes `interrupt_receipt_v1` / `interrupt_cancel_queued_v1`
  for feature detection.
- Exact stream-json line shape from the CLI (documented for the SDK; CLI stated to use
  the same protocol, but that was inferred rather than read directly). Moot if we use
  the SDK, which is the plan.

## Not relevant, do not chase

- `/.opencode/package.json` pins `@opencode-ai/plugin@1.18.30` with
  `skills/mesh-run-observe/` — a local plugin dir, separate from the runtime path.
- Root `package.json` has no opencode dependency. No `.env` samples exist.
- Non-agent spawns: `packages/projects/src/supervisor.ts:269` (child mesh hosts),
  `packages/artifact-store/src/index.ts:78` (git).
- ~~Docs/YAML mentioning opencode are cosmetic until the runtime lands.~~ **DONE**
  — the runtime landed, so they were updated. `docs/runtime.md` gained a
  `runtime-claude` section and lost the claim that Claude attaches "behind an HTTP
  shim"; `README.md` no longer says real LLM collaboration requires the OpenCode
  CLI; `docs/configuration.md`, `docs/architecture.md` and `AGENTS.md` list the new
  runtime.

  Left alone deliberately: `docs/configuration.md:19` and `:50` (`variant` really
  is opencode-specific), `README.md:96` (`mesh init` behaviour is unchanged), the
  "Solo Builder" template at `apps/mesh-dashboard/src/designer/model.ts:170`, and
  `examples/*/mesh.yaml`. `PRODUCT.md` turned out to contain no opencode mentions
  at all.

  No dashboard or schema change was needed: the designer's runtime field is a
  free-text input with a placeholder rather than a dropdown, and
  `schemas/mesh.schema.json` has no runtime enum (its three enums are all `mode`).
