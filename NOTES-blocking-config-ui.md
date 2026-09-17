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

### Tier 2 — live raises. They exist. Only an escalation can reach them.

**Correction: an earlier draft of this brief called these "unexposed" and ranked
them highest value. Both claims were wrong.** They are already wired, in
`apps/mesh-dashboard/src/views/Escalations.tsx`:

- `POST /budgets/raise` — `doRaise(escId, key, newLimit, needConfirm)` at `:578`,
  posts at `:592`, then answers the escalation at `:597`
- `POST /mission/limits` — `doCapRaise(kind, escId)` at `:620`, posts at `:625`,
  and **also persists to mesh.yaml** via `GET /config` + `/config/save`
  (`:632-639`), so the raise survives a project reopen
- `POST /designer/staged/apply` (`index.ts:1763`) — not re-checked; treat the
  line above as unverified

Every one of them takes an `escId`. So the gap is not "no UI" — it is that a
limit can only be changed **reactively**, once an agent has already stalled and
filed an escalation. There is no way to raise a cap you can see coming.

Real remaining work: lift these controls out of the escalation card so they can
be driven proactively. The POST bodies and the mesh.yaml write-back already
work — this is a re-siting job, not new plumbing.

### Tier 3 — host config. The actual engineering, and a measured trap.

**`host.yaml` has no write path at all.** Only `loadHostConfig` reads it
(`packages/projects/src/host-config.ts:163`); the host's routes
(`apps/mesh-server/src/host.ts:529-657`) are health / events / projects
open-close-restart-delete only. Feasibility, checked against the source:

1. **DONE. The reload itself is easy.** `GET`/`PUT /api/host/config` now exists,
   the closure binding is a `let`, and `saveHostConfig` (new, in
   `packages/projects/src/host-config.ts`) is `host.yaml`'s first write path.
   The PUT enforces before it answers, so a raise is in force by the time the
   operator sees the response. Raising or removing a spend ceiling requires
   `{ confirm: true }`; lowering does not. Original note follows.
   `applyLimits` (`:447`) reads
   `hostConfig.spendCeilingUsd` *at call time*, not at construction. The binding
   is one closure `const` at `host.ts:250` (`startHostServer` loads its own at
   `:902` and passes it down as `deps.hostConfig`). Make `:250` a `let`, add a
   setter, and the next heartbeat tick sees the new number. Plus a new
   `GET`/`PUT /api/host/config` route.

2. **DONE (`8fe8eb5`). `ceilingTripped` was a one-way latch, and Tier 3 is what
   turns that into a bug.** Declared `false` (`:352`), set `true` (`:450`), and there is **no third
   assignment in the codebase** — the fall-through path (`:456-469`) never clears
   it. Today that is harmless: spend is monotonic, so once
   `totals.usd >= ceiling` the `:449` condition stays true on every tick and the
   latch is redundant. **Raising the ceiling is the only thing that can make
   `:449` false again.** So the moment the ceiling is editable you get a host that
   has correctly resumed — projects live, nothing being parked — still reporting
   `ceilingTripped: true` on `/api/projects`, with the Overview strip announcing
   "Parked — the host hit its spend ceiling" over a healthy mesh. Strictly worse
   than today, where the message is at least true. **Any reload path must clear
   the latch**, or derive the flag instead of latching it.

3. **Not every key can hot-reload.** A settings UI has to mark, per key, whether
   the edit is live or needs something else to happen first. One
   undifferentiated "Save" button reproduces the original trap in a new place.
   The labels now live in `HOST_CONFIG_EFFECTS` (`host-config.ts`) and ride the
   `GET` response, so the screen renders them rather than keeping its own copy.

   **Correction to this brief: `project_memory_mb` is `host-restart`, not
   "next project open".** This draft said a change "affects only projects opened
   afterwards", reasoning from it being a child spawn flag. That is the
   intuitive answer and it is wrong: `startHostServer` reads the value once into
   `supervisorOptions.memoryMb` and hands it to the `ChildProcessSupervisor`
   constructor, which spawns from that captured `this.opts` copy
   (`packages/projects/src/supervisor.ts:268`). Saving the key changes the file
   and nothing else until the host restarts. Labelling it "next open" would have
   been the original trap rebuilt with better manners.

Keys: `spend_ceiling_usd` (live, latch now fixed), `max_concurrent_turns`
(live, same closure, no latch involved), `default_usd_per_mtok` / `model_prices`
(live), `project_memory_mb` (**host-restart**, see above). `model_prices` is
blocking *indirectly* — a mispriced model trips the ceiling early and parks
everything.

**The shipped banner's copy is now on borrowed time.** It tells the operator to
restart the host (`views/Overview.tsx:222`, which even cites `host.ts:902` by
line). That was right by luck while a restart was the only thing that cleared
the latch. Item 2 is done, so today it is merely unnecessary advice — but the
moment `PUT /api/host/config` lands it becomes actively wrong, and it has to
change in that same commit.

**DONE. A second latch, not in the original survey: `parkedByPolicy`.** Resolved
as a per-entry reason tag: the list is a `Map<id, "ceiling" | "turn-cap">`, and
entries are removed at the project lifecycle routes (open, close, restart,
delete) rather than on any limit check. Two things this brief got wrong, both
found by checking the source before building:

- *Nothing ever un-parks.* `/mission/park` has no counterpart call anywhere in
  the host. So dropping an entry when its own limit lifts would be a fresh lie,
  not a fix — a project parked by the ceiling is still parked after the ceiling
  moves. Only the project's lifecycle ends a policy park.
- *A derived `parked` would over-report.* Children boot parked by default
  (`options.childMode ?? "parked"`) and the child's own mode is just
  `scheduler.isRunning() ? "live" : "parked"`, so a flag derived from the
  heartbeat would mark every freshly-opened project as policy-parked. Deriving
  does not replace the host-side record, it adds a wire field on top of it —
  which is why the protocol change was dropped.

Still open, and small: a child that crashes while parked and is auto-restarted
by the supervision tree keeps its entry, because that path does not pass through
the routes. The fix is to tag each entry with the child's `startedAt` and drop
it when the running child no longer matches. Original note follows.

Declared
`host.ts:351`, pushed at `:421`, read onto the wire at `:385`, and **never
removed** — the same shape as `ceilingTripped`, dormant for the same reason (a
resumed project is re-parked on the next tick while `:449` still holds).
Invisible today because `parked` renders only *inside* the ceiling banner
(`Overview.tsx:222`), so fixing `ceilingTripped` concealed it rather than fixed
it. It cannot be cleared wholesale on the fall-through: the list also holds
projects parked by the **turn cap**, and the `:463-468` loop skips those once
they are idle (`runningTurns === 0`), so a blanket clear would silently drop
still-parked ids. It needs a reason tag per entry, or a `parked` derived from
child state — and deriving means a protocol change, because the heartbeat
carries no mode/parked field (`packages/projects/src/supervisor.ts:60-74`).

**Correction to this brief: `tests/` does already drive the flag.**
`tests/server/host-resources.test.ts:171` asserts `ceilingTripped === true` and
`:177` the parked list, against a real stub child emitting real beats. The gap
was only the *clearing* half, which `8fe8eb5` adds. Anything further here
extends that file; it does not need a new harness.

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

## Settled with the operator

- **"Blocking config" means the union of both readings** — stops the mesh *and*
  requires a restart to change. Three sessions of work.
- **Host config gets its own screen**, not a section in Overview. Tier 1/2 are
  per-mesh; Tier 3 is cross-project, and they cannot share one screen.

## Session log

1. Tier 3 groundwork: `ceilingTripped` un-latched (`8fe8eb5`).
2. `parkedByPolicy` un-latched, `GET`/`PUT /api/host/config`, the reload path,
   and the Overview banner copy that the PUT made wrong.
3. Next: the host settings screen itself, rendering `effects`/`explicit` from
   the GET. Then the ~30-key "why you are stopped" survey (see the top of this
   brief), which is the half that makes an editor worth having.

**Line numbers in this brief go stale fast** — `host.ts` shifted by +5/+13 in a
single commit. Grep for the symbol; do not trust a number here.
