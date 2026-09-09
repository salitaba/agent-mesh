# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: a solo developer running a small team of AI agents locally. They seed a mission (`mesh.yaml` or the Designer), watch the dashboard console, step individual agents (`wake`) or go live, and steer as the `human` seat — sending typed messages, recording approvals, raising budgets, and responding to escalations at gates. Other audiences (platform operators, benchmark evaluators) exist but are not the primary design target.

## Product Purpose

Agent Mesh is a runtime for persistent AI organizations — role-based autonomous agents that collaborate through explicit authority, communication contracts, artifacts, dynamic activation, and an event-sourced kernel with runtime-enforced policy. Workflows are not fixed pipelines: a goal seeds initial state, agents wake on events they care about, act via typed messages and artifact references, and the mesh converges — or escalates on conflict, budget exhaustion, or stalemate. Success is evidence-based completion (gates satisfied, QA passed, budgets honored) with a replayable audit trail, not a finished chat transcript.

## Positioning

The runtime, not the prompt, is authoritative. Four enforcement layers (prompt awareness, per-agent capability/tool permissions, mesh policy on the bus, and a state-transition reducer that refuses illegal appends) mean a neighboring prompt-based multi-agent chat cannot truthfully copy the guarantees: illegal approvals, commits, delegations, and blocks are rejected before they become events, and even a rogue event cannot force an illegal state.

## Operating Context

Local-first Node runtime (`node >= 20`, TypeScript). Operation flows through the CLI (`mesh init|validate|run|console|bench|status|graph|events|agents|approve|…`) and the dashboard console (Overview, Steps, Agents, Needs you, Events, Graph, Files, Cost, Designer) — every screen a projection of the append-only event log, streamed over SSE with resume. Three tiers: parked console (nothing self-runs; wake steps one turn), manual step, and live execution. Real LLM collaboration needs the OpenCode CLI plus provider keys (`mesh run` preflights with guidance instead of crashing); without it the runtime falls back to `runtime: stub`. Optional real git worktrees (`--git`). Mesh configs (`mesh.yaml`) are validated server-side by the same engine as `mesh validate` and the Designer.

## Capabilities and Constraints

Confirmed: persistent agent seats (role + session + capabilities + authority + interests + budgets; roles include architect, developer, qa, security, tech-lead, pm, explorer) with prompt files under `roles/`; interest-driven wakeups plus triage; `may_contact` communication matrix; transition gates (e.g. release requires approvals); escalation taxonomy (runtime failure, budget exhaustion, stalemate/deadlock, thread limits); mission/thread/agent token budgets, wall-clock and max-events caps; immutable versioned artifacts; deterministic replay from the log; `mesh bench` harness. Technical constraints: Node >= 20; real-model runs require the OpenCode CLI on PATH; dashboard served by mesh-server over HTTP/SSE. Explicitly undecided: no claim about where mesh beats single-agent — the benchmark measures rather than assumes.

## Evidence on Hand

Real: `examples/demo-stub` scripted payment-API journey (requirements → research → design → review → delegate → implement → QA block → rework → merge → release gates), plus `examples/payment-api`, `examples/greenfield`, `examples/line-follower-sim`, `examples/spring-boot`; role definitions in `roles/`; protocol/architecture/runtime/configuration docs in `docs/`; canonical event catalog in `schemas/event.schema.json`. Absences future work must not fabricate: no testimonials, customers, press, pricing, or benchmark results.

## Product Principles

1. The runtime enforces; prompts only suggest — never rely on instructions where the kernel can guarantee.
2. The event log is the truth — every view is a projection; anything worth showing must be replayable.
3. The human is a seat, not an oracle — human messages carry the highest provenance and gates consume human decisions.
4. Parked by default, live by choice — nothing self-runs unless the operator asks it to.
5. Measure rather than assume — claims about mesh-vs-single-agent performance go through the bench.
