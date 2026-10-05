# Curule packages

Each directory in `packages/` is a TypeScript source package of the mesh runtime.
They are compiled by the root `tsconfig.json` (single build graph) and import each
other via relative paths:

| package | responsibility |
| --- | --- |
| `protocol` | typed domain model, canonical event catalog, JSON schemas, ids, clock, validation |
| `config` | `mesh.yaml` loading, schema + cross-field validation, role prompt resolution |
| `event-store` | append-only JSONL event log, replay streams |
| `persistence` | state directory layout, session registry, snapshots, optional SQLite event index |
| `core` | kernel, projections (layer-4 enforcement), budgets, lifecycle, termination, deadlock detection, context construction, supervisor |
| `policy-engine` | layers 2–3 enforcement: capabilities, authority, communication matrix, transition gates, activation gating |
| `scheduler` | event-driven activation: interest registry, mailboxes, priorities, concurrency, timeouts, triage |
| `agent-runtime` | runtime adapter interface + deterministic `StubRuntime` (simulation/tests) |
| `artifact-store` | immutable content store + git worktree management |
| `llm` | the model port: OpenAI-compatible and Anthropic Messages adapters, no vendor types |
| `runtime-native` | provider-neutral runtime: the agent loop, the seat's tools, conversations on disk |
| `ai-gateway` | the hosted service's model gateway: virtual keys, a price table, an append-only ledger, tiers with failover |
| `runtime-claude` | Claude Code adapter through the Agent SDK (long-lived streaming query, sessions, tokens, restore) |
| `runtime-http` | generic HTTP agent adapter for custom/remote agents |
| `observability` | projections → views: mesh graph, goal view, artifact timeline, cost, metrics, usage report, SSE hub |
| `projects` | multi-project registry (`~/.curule/projects.json`) |
| `licensing` | offline Ed25519 licence keys, the plan table and its entitlements, the pricing export |
