# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: a solo developer running a small team of AI agents locally. They seed a mission (`mesh.yaml` or the Designer), watch the dashboard console, step individual agents (`wake`) or go live, and steer as the `human` seat — sending typed messages, recording approvals, raising budgets, and responding to escalations at gates. Secondary, and the one that pays: the engineering lead or platform operator who runs it for several teams (a container or Helm release per tenant), who needs spend limits, an audit trail and a security story they can show a reviewer, and who signs in with one shared operator credential today (no SSO or per-person identity yet). Benchmark evaluators exist but are not a design target.

## Product Purpose

Ordane is a runtime for persistent AI organizations — role-based autonomous agents that collaborate through explicit authority, communication contracts, artifacts, dynamic activation, and an event-sourced kernel with runtime-enforced policy. Workflows are not fixed pipelines: a goal seeds initial state, agents wake on events they care about, act via typed messages and artifact references, and the mesh converges — or escalates on conflict, budget exhaustion, or stalemate. Success is evidence-based completion (gates satisfied, QA passed, budgets honored) with a replayable audit trail, not a finished chat transcript.

## Positioning

The runtime, not the prompt, is authoritative. Four enforcement layers (prompt awareness, per-agent capability/tool permissions, mesh policy on the bus, and a state-transition reducer that refuses illegal appends) mean a neighboring prompt-based multi-agent chat cannot truthfully copy the guarantees: illegal approvals, commits, delegations, and blocks are rejected before they become events, and even a rogue event cannot force an illegal state.

Commercially it is self-hosted software with a platform fee only: the customer's own model account pays for the model (Anthropic's terms do not allow reselling it), nothing phones home, and the free Community plan (one open project, eight agents) needs no licence. What a plan includes lives in `packages/licensing/src/plans.ts` and is exported from there; prose must not restate a number the table owns. The source is public under the Business Source License 1.1 (`LICENSE`): free to read, run and modify, free for production within the Community plan, and a commercial licence beyond it. The licence's grant has to carry the Community limits in its own text, so `tests/build/source-licence.test.ts` holds those numbers equal to the table.

## Operating Context

Local-first Node runtime (`node >= 20`, TypeScript), also shipped as a container image, a Compose file and a Helm chart; one host process supervises a child per open project and serves the dashboard, and anything that is not loopback needs a strong operator token. Operation flows through the CLI (`ordane init|validate|run|console|bench|status|graph|events|agents|approve|…`) and the dashboard console (Overview, Steps, Agents, Needs you, Events, Graph, Files, Cost, Designer) — every screen a projection of the append-only event log, streamed over SSE with resume. Three tiers: parked console (nothing self-runs; wake steps one turn), manual step, and live execution. Real LLM collaboration runs Claude through the Agent SDK (`runtime: claude`; the SDK ships its own executable) on credentials the operator owns (Anthropic, Bedrock, Vertex or Foundry); `runtime: stub` runs with zero model calls and is what the keyless demo uses. Optional real git worktrees (`--git`). Mesh configs (`mesh.yaml`) are validated server-side by the same engine as `ordane validate` and the Designer.

## Capabilities and Constraints

Confirmed: persistent agent seats (role + session + capabilities + authority + interests + budgets; roles include architect, developer, qa, security, tech-lead, pm, explorer) with prompt files under `roles/`; interest-driven wakeups plus triage; `may_contact` communication matrix; transition gates (e.g. release requires approvals); escalation taxonomy (runtime failure, budget exhaustion, stalemate/deadlock, thread limits); mission/thread/agent token budgets, wall-clock and max-events caps; immutable versioned artifacts; deterministic replay from the log; `ordane bench` harness. Also confirmed: offline signed licence keys with plan limits that warn by default and never stop a running mission, usage reports from the event log, a host-wide spend ceiling that prices all four token classes, fail-closed network exposure, and deployment assets checked without a cluster. Technical constraints: Node >= 20; real-model runs need provider credentials; dashboard served by mesh-server over HTTP/SSE; one writer per event log (one pod per instance). Explicitly undecided: no claim about where mesh beats single-agent — the benchmark measures rather than assumes.

## Evidence on Hand

Real: `examples/demo-stub` scripted payment-API journey (requirements → research → design → review → delegate → implement → QA block → rework → merge → release gates), plus `examples/payment-api`, `examples/greenfield`, `examples/line-follower-sim`, `examples/spring-boot`; role definitions in `roles/`; protocol/architecture/runtime/configuration docs in `docs/`; canonical event catalog in `schemas/event.schema.json`. Also real: list prices and plans (`pricing/plans.json`, generated from the plan table) and one measured mission (`pricing/measured-runs.json`: five agents, Haiku 4.5, $5.52, scored 99.6% by an independent oracle), which is one run and is quoted as one run. Absences future work must not fabricate: no testimonials, customers, press, third-party audit, pen test or SOC 2, and no benchmark result beyond that one run.

## Product Principles

1. The runtime enforces; prompts only suggest — never rely on instructions where the kernel can guarantee.
2. The event log is the truth — every view is a projection; anything worth showing must be replayable.
3. The human is a seat, not an oracle — human messages carry the highest provenance and gates consume human decisions.
4. Parked by default, live by choice — nothing self-runs unless the operator asks it to.
5. Measure rather than assume — claims about mesh-vs-single-agent performance go through the bench.
