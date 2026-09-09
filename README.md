# Agent Mesh

A standalone runtime for **persistent AI organizations**. Not "many LLMs in a
group chat" — autonomous role-based agents that collaborate through explicit
**authority**, **communication contracts**, **artifacts**, **dynamic
activation**, and an **event-sourced** kernel with runtime-enforced policy.

```
Agent = Role + Persistent Session + Capabilities + Authority
      + Relationships + Memory + Lifecycle + Delegation Policy
```

The workflow is **not** a fixed pipeline. A goal seeds initial state; agents
wake on events they care about, act via typed messages and artifact references,
and the mesh converges — or escalates on conflict, budget exhaustion, or
stalemate.

## Quick start (no model, no keys)

```bash
npm install
npm run build
npm test                         # 85 tests: protocol, policy, scheduler,
                                 # lifecycle, replay, integration, properties,
                                 # simulation, git worktrees, adapters,
                                 # HTTP/MCP, the demo journey, parked/step/live modes
npm run mesh -- run examples/demo-stub/mesh.yaml
# then open http://127.0.0.1:7421/ and watch a whole AI organization
# discover its own workflow — no fixed pipeline, budget events, review
# gates, a QA block with rework, and evidence-based completion.
```

## Product tour (the three journeys)

1. **Watch** — `mesh run` (or `mesh ui` for a parked console): the Overview
   shows progress, tokens, and a guidance banner for every state (parked,
   paused, escalated, asleep, complete). Agents view → click a seat for its
   whole definition, memory, session and mailbox. Graph shows who talks to
   whom and how. Events streams live from the append-only log; click any
   event for its JSON. Artifacts show immutable lineage; Cost shows the
   budget ledger.
2. **Steer** — the console has three tiers: **parked** (nothing self-runs),
   **manual step** (a seat's *wake* button runs exactly one operator turn —
   step the mesh agent by agent), and **live** (▶ *Start mission* flips the
   parked console into full autonomous execution without restarting). Every
   button answers honestly: refusals come back as `409` with the reason
   ("mission is paused — resume it first", …). The human is a seat, not an
   oracle: `✉ message` sends typed messages (highest provenance), `✓ approval`
   records decisions that gates consume, wake/suspend/resume per agent,
   pause/resume the mission, respond-to-escalation resumes work with the
   raiser woken. Or use the CLI (`mesh approve --subject release`,
   `mesh respond <esc> "…"`, …).
3. **Design** — `#/designer` in the dashboard: build agents, capabilities, authority,
   interests, the communication matrix, transition gates and budgets with
   live server-side validation (same engine as `mesh validate`), YAML preview,
   save; then `mesh run <saved path>`. `mesh init` scaffolds a starter (falls
   back to `runtime: stub` when the OpenCode CLI isn't on PATH, and `mesh run`
   preflights the reverse case with guidance instead of crashing).

## Running

All commands go through `npm run mesh -- <command>` (or `node dist/apps/mesh-cli/src/index.js <command>`):

```bash
# full runtime — scheduler active, agents execute, dashboard live:
npm run mesh -- run examples/demo-stub/mesh.yaml
#   first run? this demo auto-attaches a scripted payment-API team (zero model
#   calls): requirements → research → design → review → delegate → implement →
#   QA BLOCK → rework → merge → release gates → evidence-based completion.
#   Watch it live at  http://127.0.0.1:7421/   (dashboard + controls),
#   design at         http://127.0.0.1:7421/#/designer
#   (--no-demo disables the scripted team; agents then simply idle)

# PARKED CONSOLE — dashboard + designer, nothing autonomous (no startup runs,
# no cascades, no tokens), safe to poke at even for opencode configs on a
# machine without the CLI installed:
npm run mesh -- console examples/payment-api/mesh.yaml --port 7430
# (alias: ui; equivalent: npm run mesh -- run <file> --parked)
# parked semantics: startup/interest/timer cascades are all off — nothing runs
# on its own. BUT operator buttons stay live: "wake" runs exactly one manual
# turn (step through the mesh agent by agent), "send + wake after send" delivers
# mail and steps recipients in one action, and the ▶ Start mission button flips
# the console live in place (scheduler on, cascades resume) without restarting.

# design first, run later:
npm run mesh -- init my-mesh                       # auto-detects opencode; falls
                                                   # back to runtime: stub if absent
$EDITOR my-mesh/mesh.yaml                          # or use the designer page
npm run mesh -- validate my-mesh/mesh.yaml
npm run mesh -- run my-mesh/mesh.yaml

# deterministic mesh-vs-single-agent benchmark (token-free):
npm run mesh -- bench

# operate a running mesh from the CLI:
npm run mesh -- status
npm run mesh -- graph
npm run mesh -- events --limit 30
npm run mesh -- agents
npm run mesh -- inspect qa
npm run mesh -- replay <goalId>
npm run mesh -- pause
npm run mesh -- resume
npm run mesh -- approve --subject release
npm run mesh -- send --to architect --type MISSION --payload "{\"note\":\"go\"}"
npm run mesh -- respond <escalationId> "approved, proceed"
```

Real LLM collaboration needs the OpenCode CLI (`npm i -g opencode-ai` + provider
keys); `mesh run` preflights this and prints guidance instead of crashing if it
is missing. Add `--git` to give writing agents real git worktrees.

Other helpers: `emit-schemas schemas` (regenerate canonical JSON schemas),
`mesh mcp` (internal stdio↔HTTP bridge spawned by OpenCode).


## Repository layout

```
packages/
  protocol        typed model, canonical event catalog, JSON schemas, ids, clock
  config          mesh.yaml load + schema + cross-field validation, role prompts
  event-store     append-only JSONL event log, replay stream
  persistence     state layout, session registry, snapshots, sqlite index
  core            kernel, projections, lifecycle, budgets, termination, deadlock,
                  context construction, supervisor, delegation, workers
  policy-engine   4-layer enforcement, communication matrix, transition gates
  scheduler       interest registry, activation, mailboxes, concurrency, triage
  agent-runtime   adapter interface + deterministic StubRuntime (tests/sim)
  artifact-store  immutable content store + git worktree manager
  runtime-opencode  OpenCode server adapter (sessions, turns, tokens, restore)
  runtime-http      generic HTTP/custom/remote agent adapter
  observability     graph, goal/artifact/cost views, metrics, SSE hub
apps/
  mesh-cli        mesh init|validate|run|ui|status|graph|events|replay|approve|… + TUI
  mesh-server     bootstrap + HTTP/SSE API + MCP bus + config-designer API + static UI
  mesh-dashboard  live UI + mesh designer (Vite + React + TS SPA in `src/`,
                  built to `dist/` and served by mesh-server on the same port)
schemas/ roles/ examples/ tests/ docs/
```

UI development: `npm run dev` boots a parked demo console plus the dashboard
with hot reload (API at :7421, UI at :5173) — parked never auto-completes,
so the session stays up while you wake agents and drive flows by hand;
`npm run dev:ui` starts only the UI against an already-running mesh.
`npm run build:ui` rebuilds the dashboard bundle (`npm run build` already
includes it).

Hot reload against your own mesh + port (the console port serves the stale
built bundle — open the Vite URL, not the mesh port):

```bash
# terminal 1 — your mesh (stays running; agents keep their state):
npm run mesh -- console examples/line-follower-sim/mesh.yaml --port 7430

# terminal 2 — hot-reloading UI proxied at your mesh:
MESH_BUS_URL=http://127.0.0.1:7430 npm run dev:ui
# open http://127.0.0.1:5173/ — edits under apps/mesh-dashboard/src/ reload live.
```

See `docs/architecture.md`, `docs/protocol.md`, `docs/configuration.md`,
`docs/runtime.md`.

## Positioning

An open runtime for persistent AI organizations, where autonomous role-based
agents collaborate through explicit authority, communication contracts,
artifacts, and dynamic activation. The benchmark (`mesh bench`) is intentionally
honest: the mesh may win on some software workloads and lose on others; the
project measures rather than assumes.
