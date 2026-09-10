# AGENTS.md

Runtime for persistent AI organizations: role-based agents collaborating through explicit
authority, communication contracts, artifacts, and an event-sourced kernel with
runtime-enforced policy.

## Stack

- TypeScript (ES2022), Node >= 20
- npm workspaces (`packages/*`, `apps/*`)
- Build: `tsc` for packages/apps, Vite 8 for the dashboard SPA
- Tests: Node built-in runner (`node:test` + `node:assert/strict`)

## Commands

```bash
npm run build         # tsc -p tsconfig.json && npm run build:ui
npm run build:ui      # vite build --config apps/mesh-dashboard/vite.config.mts
npm run typecheck     # tsc --noEmit (root) + dashboard tsconfig
npm run lint          # eslint packages apps tests
npm test              # build, then node --test "dist/tests/**/*.test.js"
npm run test:only     # node --test "dist/tests/**/*.test.js" (no rebuild)
npm run mesh -- <cmd> # node dist/apps/mesh-cli/src/index.js
npm run dev           # mesh console (port 7421) + vite dev, concurrently
npm run dev:ui        # vite dev only
npm run clean         # rm -rf dist
```

Single test (tests run from compiled output, so build first):

```bash
npm run build && node --test dist/tests/policy/<file>.test.js
```

There is no `format` script and no Prettier config. Do not add formatting-only diffs.

## Layout

```
apps/
  mesh-cli/          CLI entrypoint + TUI
  mesh-server/       HTTP/SSE API, MCP bridge, static serving
  mesh-dashboard/    React 19 + Vite SPA (designer + live console)
packages/
  protocol/          typed model, event catalog, JSON schemas, ids, clock
  config/            mesh.yaml load + validation + role prompts
  event-store/       append-only JSONL event log, replay stream
  persistence/       state layout, snapshots, sqlite index
  core/              kernel, projections, lifecycle, budgets, supervisor
  policy-engine/     4-layer enforcement, communication matrix, gates
  scheduler/         interest registry, activation, mailboxes, triage
  agent-runtime/     adapter interface + StubRuntime
  artifact-store/    immutable content store + git worktree manager
  runtime-opencode/  OpenCode server adapter
  runtime-http/      generic HTTP agent adapter
  observability/     graph, views, metrics, SSE hub
  projects/          multi-project registry (~/.agent-mesh/projects.json)
tests/               mirrors packages/ layout
roles/               role prompt files
schemas/             canonical JSON schemas (event, message, artifact, mesh)
examples/            demo configs (demo-stub, payment-api, greenfield, ...)
docs/                architecture, configuration, protocol, runtime
dist/                compiled output (gitignored)
```

## Conventions

- Import workspace code via `@mesh/*` path aliases (root `tsconfig.json` `paths`).
  ESLint `no-restricted-imports` warns on deep relative imports like
  `../../protocol/src/...`.
- Each package re-exports through a barrel `src/index.ts` (`export *`).
- Workspace packages expose `./src/index.ts` directly; no per-package `dist`.
- Strict TS: `strict: true`, `noImplicitOverride: true`,
  `noUncheckedIndexedAccess: false`, `forceConsistentCasingInFileNames: true`.
- Naming: kebab-case dirs, PascalCase types/React components, camelCase
  functions/values, UPPER_SNAKE constants.
- State is event-sourced: append-only JSONL log, every view is a projection.
  No ORM. Do not mutate stored state in place — append an event.
- Schema validation with AJV + ajv-formats for messages, events, configs.
  Change `schemas/` and the `protocol` types together.
- Tests mirror the package they cover (`tests/scheduler/`, `tests/policy/`, ...).

## Working notes

- After editing packages, run `npm run typecheck` before `npm test`; the test
  script rebuilds everything and is slower.
- New package: add it to `packages/`, wire the `@mesh/*` alias in root
  `tsconfig.json` `paths`, and export from its `src/index.ts`.
- Dashboard code is typechecked by a separate tsconfig at
  `apps/mesh-dashboard/tsconfig.json`.
