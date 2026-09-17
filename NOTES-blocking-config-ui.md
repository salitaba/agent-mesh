# Make every blocking config editable in the UI — design brief

Untracked scratch file. Delete when the work lands.
Written at a session boundary; nothing here is implemented yet.

## The ask

"I want every blocking config to be configurable in UI."

Prompted by: a `$50` `spend_ceiling_usd` the operator never set (it defaults ON),
stored in `~/.agent-mesh/host.yaml` — a file that did not exist on their machine —
parking their mesh with no explanation, and requiring a host restart to change.
See NOTES-confirm-hang.md for that diagnosis.

## The real finding: ~35 ways to stop, and most are silent

A survey of every config that can halt, park, refuse, or idle a mesh turned up
roughly 35 keys across four layers. The problem is not that they are
unconfigurable. **Most were always editable. They are just invisible when they
bite.** Representative silent ones:

- `agents.<id>.budget.max_activations` — activation DEFERs, agent "silently never
  scheduled" (`packages/policy-engine/src/index.ts:235-236`)
- `scheduling.concurrency.max_active_agents` — queued agents never pumped, silent
  idle (`packages/scheduler/src/index.ts:359`, `:369`)
- `activation.strategy` + `triage.rules.ignore_if_text_matches` — agent never
  activates and **no card is rendered** (`scheduler/src/index.ts:338`)
- `policies.transitions.<x>.requires` — an unsatisfiable gate is a silent deadlock
  (`packages/policy-engine/src/index.ts:183,197`)
- `delegation.allow` / `max_depth` / `max_workers` — **blocking by default**
  (`packages/config/src/index.ts:467-469`); `spawn_worker` refused

So: **an editor is half the feature.** Shipping settings forms without a
"this is why you are stopped" surface reproduces the original bug with extra
steps. Pair every blocking config with a reason surfaced at the moment it blocks.
The `ceilingTripped` banner in `views/Overview.tsx` is the pattern to copy.

## Tiers — do them in this order, they are wildly different sizes

### Tier 1 — per-mesh config. A write path already exists. Reuse it.

`POST /config/save` (+ `/config/validate`) — `apps/mesh-server/src/index.ts:1658`,
write at `:1699`, prior bytes archived to `.mesh-versions/` at `:1696`, returns
`drift` when it overwrote the running config (`:1718`). **This is the Designer's
save and it works as-is.** Covers `budgets.*`, `scheduling.*`, `startup.activate`,
`policies.escalation.*`, `delegation.*`.

Caveat: config is a boot seed, not a mirror (`apps/mesh-server/src/index.ts:1711`),
so these need a **project reopen** to take effect. Say so in the UI; do not imply
they are live.

### Tier 2 — live raises. Already restart-free. Just wire the UI.

- `POST /mission/limits` (`index.ts:1622`) — `max_events`, `wall_clock_minutes`
- `POST /budgets/raise` (`index.ts:1225`) — agent/thread budgets
- `POST /designer/staged/apply` (`index.ts:1763`)

These bypass the file and apply immediately. **Highest value per unit of work in
the whole brief** — the no-restart experience already exists and is unexposed.

### Tier 3 — host config. The actual engineering.

**`host.yaml` has no write path at all.** Only `loadHostConfig` reads it
(`packages/projects/src/host-config.ts:163`); the host's routes
(`apps/mesh-server/src/host.ts:529-657`) are health / events / projects
open-close-restart-delete only. Needs:

1. a new host route (`GET`/`PUT /api/host/config`), and
2. **a reload path** — `hostConfig` is captured in a `const` at `host.ts:902` and
   never re-read, so `applyLimits` (`:447`) closes over the startup value. Writing
   the file without this changes nothing until restart.

Keys: `spend_ceiling_usd`, `max_concurrent_turns`, `default_usd_per_mtok` /
`model_prices`, `project_memory_mb`. Note `model_prices` is blocking *indirectly*
— a mispriced model trips the ceiling early (`host.ts:362` feeds the `:449` check)
and parks everything.

### Out of scope — not configurable without a code change

Hardcoded, constructor-injected only. Do not promise these in a settings UI:

- crash-loop breaker: `CRASH_LOOP_THRESHOLD=3`, `CRASH_LOOP_WINDOW_MS=60000`,
  `HEARTBEAT_TIMEOUT_MS=15000` (`packages/projects/src/supervision.ts:20-21,27`)
- scheduler breaker: `STRIKE_LIMIT=3`, `PARK_MS=30000`
  (`packages/scheduler/src/index.ts:71-72`)

## Constraints that must not be broken

**Validation lives in `packages/config`, not the UI.** `Designer.tsx:467-471`
records that these checks were deliberately moved out of the designer's local
advisors so CLI and server boots see them too. A settings UI must reuse
`/config/validate`. Re-adding local checks would undo that decision.

**Spend caps deserve friction.** A UI that makes raising a ceiling frictionless
makes overspending frictionless. The reporting mesh was `$53.33` in with **every
mandatory acceptance criterion still UNSATISFIED** — the cap was the only thing in
the system that noticed. Raising it should confirm; nothing else here needs to.

**Defaults that are ON are the trap.** `spend_ceiling_usd` (50),
`budgets.mission.tokens` (2000000), `max_active_agents` (4),
`delegation.allow` (false) all bite operators who never chose them and have no
file on disk to look at. A settings UI should show **effective value + whether it
is a default or explicitly set** — that distinction is the whole lesson here.

## Open questions for the operator

- Does "blocking config" mean *stops the mesh* (assumed here) or *requires a
  restart to change*? The tiers above cover both readings, but Tier 3 is only
  worth its cost under the second.
- Per-project or global settings screen? Tier 1/2 are per-mesh; Tier 3 is
  cross-project. They probably cannot share one screen.
