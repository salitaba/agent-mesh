# Prompt audit — findings (feat/plan-visibility)

Per-turn prompt is runtime-blind + tool-blind.

## Finding 1 — prompt says "NO mesh_ prefix" while 42 mesh_* tools are exposed
- `packages/core/src/context.ts:641` tells the model "NO mesh_ prefix" for its own
  actions, but the tool slot for every seat includes all 42 `mesh_*` MCP tools
  (~3.9k tokens — 4x the size of the role prompt itself).
- `buildTools()` in `apps/mesh-server/src/mcp.ts:454` takes no `agentId`, so every
  seat sees tools it cannot call: `mesh_merge`, `mesh_veto`, `mesh_submit_result`,
  plus 6 operator-persona read tools that a non-operator seat has no use for.

## Finding 2 — no tool-exposure gating on the context bundle
- `AgentContextBundle` (`packages/protocol/src/types.ts:1167`) has no field that
  says which tool capability tier a seat is in.
- There's an existing precedent for this kind of conditional prompt content:
  `delegationEnabled` at `packages/core/src/context.ts:690` gates a prompt block
  on a boolean field. The tool-exposure gate should follow that same shape.

### Plan for 1+2 (one change, land together)
1. Add a tool-exposure field to `AgentContextBundle` (protocol/types.ts:1167).
2. Gate the ops/mesh_* prompt block on it in context.ts, following the
   `delegationEnabled` precedent (context.ts:690).
3. Give `buildTools()` (mcp.ts:454) an `agentId` parameter and filter the
   returned tool list by that seat's capability (drop mesh_merge/veto/
   submit_result and the 6 operator read tools for non-operator seats).

## Finding 3 — READ_TOOLS included in every agent toolset (revised on implementation)
- Turned out not to apply as stated. There are two unrelated `READ_TOOLS`
  constants: `apps/mesh-server/src/mcp.ts:29` (the 6 observability MCP tools)
  and `packages/runtime-claude/src/index.ts:52` (`Read`/`Glob`/`Grep`/
  `TodoWrite`, an auto-approve allowlist in a `canUseTool` permission
  callback — not a toolset membership list).
- `bus-api.test.ts` ("mcp bus: read-only observability tools answer run
  questions") explicitly asserts that a plain working agent's default
  toolset includes all 6 observability tools — they're meant for any agent
  checking run status, not just external observers. Dropping them broke
  that test on first attempt; reverted. No safe token-savings opportunity
  here after all — closing this finding as not applicable.

## Finding 4 — duplicated prompt text per turn (DONE)
- The replyTo/discharge paragraph appeared **3 times** per turn: once per
  owed-loop bullet (`context.ts` — restated the mechanism inline) plus twice
  in the "## Answering" section (the canonical explanation). Trimmed the
  per-loop bullet to just the fact (who/what/since); the mechanism is still
  explained once, every turn, under "## Answering".
- `OUTPUT_VOICE_RULES` appeared **2 times** per turn: once via
  `withOutputVoice()` in the system prompt (both `runtime-claude` and
  `runtime-opencode` call it — confirmed by grep) and once again pushed
  into the per-turn context text by `renderContextInstructions`. Removed the
  per-turn copy; the system-prompt copy is sent with every turn regardless,
  so nothing is lost.
- Updated `tests/core/context-degradation.test.ts`'s ordering-anchor
  assertion, which pointed at the now-removed "## How to act" header, to
  anchor on "## Ops block contract" instead (the next real section).

## Findings 1–2 (DONE)
- Added `TOOL_REQUIREMENT` in `apps/mesh-server/src/mcp.ts`: a per-tool-name
  predicate over the agent's `AgentDefinition` (capabilities/authority/mode),
  covering the 4 tools whose own descriptions already name a requirement:
  `mesh_merge` (needs `git.merge` capability), `mesh_veto` (needs an
  authority token ending `.veto`, or `*`), `mesh_decision_ratify` (needs
  `architecture.approve` or `*`), `mesh_submit_result` (needs `mode ===
  "service"`, i.e. a spawned worker — confirmed via `supervisor.ts:4221`).
- Added `McpToolset.toolsFor(agentId)`, used by the `tools/list` handler
  (`mcp.ts` — `handle()`'s `tools/list` case), filtering the full (non
  read-only) toolset by that agent's actual definition. The read-only
  toolset (served to observers) is unaffected — it already only ever
  contained the 6 observability tools.
- No AgentContextBundle field or context.ts prompt-text gating was needed:
  the "NO mesh_ prefix" line documents the *op-block* naming convention
  (bare op names like `send`, not MCP tool names) and was never actually
  wrong — the real cost was the MCP tool *listing* itself, which is now
  fixed at the source (`tools/list` response), so the model simply no
  longer sees tools it can't use, without any prompt-text change needed.
- Authorization is unchanged: `executeOp` already gated every op the same
  way before this change; `toolsFor` only trims what's advertised.

## Status
- Diagnosis: DONE.
- Implementation: DONE. Full suite green (1017/1017) after: `npm run
  typecheck`, `tsc -p tsconfig.json`, `node --test "dist/tests/**/*.test.js"`.
- Files touched: `apps/mesh-server/src/mcp.ts`, `packages/core/src/context.ts`,
  `tests/core/context-degradation.test.ts`.
