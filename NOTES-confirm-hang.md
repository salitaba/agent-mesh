# Parked project's Continue does nothing — design brief

Untracked scratch file. Delete when the work lands.

## The complaint

On a **parked** project, the parked banner's Continue button is enabled, the
confirm dialog appears, and then nothing: no toast, no spinner, no error. Ever.

## Root cause (verified at runtime, previous session)

`useGoLive` (`apps/mesh-dashboard/src/actions.ts:123`) awaits `confirm(...)`.
The dialog mounted and was then **destroyed with its promise still pending** —
so `goLive` sits on line 123 forever. Nothing throws, which is why the handler's
`catch`/`finally` never run and `setBusy(true)` never happens.

`onResolve` (`store.tsx:637-639`) is the only thing that clears `confirmReq`, and
it always resolves first. So a dialog that vanished *without* resolving means the
component holding the resolver unmounted — not that state changed.

Ruled out: `useDismissable`'s pointerdown listener only records `viaPointer` to
decide focus return; Escape is its sole path to close. It never cancelled this.

## Done

**Provider-unmount now settles a pending confirm** (`store.tsx`, just below the
`confirmReq` state). The existing comment claimed "closing always settles the
await" — true for the *dialog's* unmount, false for the *provider's*. The
resolver is mirrored into a ref and settled as a cancel on teardown.

This converts a permanent hang into a silent no-op. It does **not** make the
button work — it stops the promise leaking while the real cause is fixed.

Verified: `tsc --noEmit -p apps/mesh-dashboard/tsconfig.json` clean; UI rebuilt
(`vite build --config apps/mesh-dashboard/vite.config.mts`) — `dist/` was stale.

## Rejected — do not re-propose

**Truthiness check at `actions.ts:123`.** A previous handoff called `=== null` a
bug. It is not. `ConfirmFn` resolves **`""` on confirm** when the request has no
`require`, and `null` only on cancel — documented at `components.tsx:503-507`,
and the goLive request passes no `require`. A truthiness check would return early
on *every* confirm, turning an intermittent hang into a permanent no-op.
`confirmResume` (`actions.ts:25`) uses the same `!== null` for the same reason.

**Moving `actions.ts:120-123` inside the `try`.** `confirm` is
`new Promise((resolve) => …)` with no reject path, so the only throw it could
catch is `agentsToWake`. Routing that into the existing `catch` would toast
"the server did not answer" for a client-side TypeError.

## The unmount hypothesis was WRONG — do not chase it again

The previous handoff blamed `main.tsx:62/65`: a parked project supposedly
dropping out of `mounted` when `activeId` went briefly `null` across a registry
refresh. Traced and disproved:

- `setActiveId` is called in exactly two places — `projects.tsx:400` (`setActive`)
  and `:426` (bootstrap, guarded by `if (!chosen) return`). **Neither ever sets
  `null`.** Once set it stays set.
- `main.tsx:65` re-adds the active project even when the registry omits it:
  `activeId && !live.includes(activeId) ? [activeId, ...live] : live`. So
  `mounted` always contains `activeId`.
- Order changes in `mounted` do not unmount: `key={id}` makes React match across
  positions.

The unmount-settles-the-promise fix above is still correct as defensive hygiene,
but it was never the cause of "Continue does nothing".

## What the e2e actually proved

`tests/integration/parked-go-live.test.ts` — 3 tests, all passing. Drives the
real Continue flow over HTTP against a real server + supervisor + scheduler.

1. **Parked + a configured startup seat → works.** Goes live and runs a turn in
   ~64ms. `activated: ["dev"]`. So the server path is sound; the backend is not
   the bug.
2. **Parked + empty `startup.activate` → live, idle, forever.** `activated: []`,
   `refused: []`, and the 200 carries `note: "…no startup agents configured"`.
   `mode` still flips to `"live"` because it is derived from
   `scheduler.isRunning()` (`mesh-server/src/index.ts:330-334`) — the banner
   clears and nothing runs. **This is the shape of the complaint.**
3. **Second click is a no-op**, `started: false`, note `"already live"`.

All five bundled `examples/*/mesh.yaml` have a non-empty `startup.activate`, so
a stock example does not reproduce case 2.

## Fixed since

**The toast stopped lying** (`actions.ts`). `started.length === 0` with nothing
blocked used to render a green `"scheduler live"` — technically true, and the
exact toast behind "I clicked Continue and the mesh did not start". Both
zero-started cases now read `"scheduler live, but no agent started"` with tone
`bad`, and the server's `note` says which of the two it was. `already` is
checked first so an idempotent second click stays `ok`.

**Boot refusals are durable** (`mesh-server/src/index.ts`, `Overview.tsx`).
`MeshInstance.lastBoot` records `{ at, activated, refused }` and rides `/status`;
the Overview banner now states the cause instead of offering two guesses. See
NOTES-boot-visibility.md, whose last open gap this closes.

**The `escalate` question is settled — the code was right.** `goal.escalated` is
emitted in exactly one place, `supervisor.ts:5219`, from a **termination
verdict** (`verdict.kind === "escalate"`, actor `termination-manager`). An
agent's `escalate` op files an escalation for the human queue via
`this.escalate(...)` and deliberately does *not* halt the mission — one seat
asking a question must not freeze every other seat. The goal reaches ESCALATED
only when the termination policy judges the mission stuck, and *then*
`supervisor.ts:1662` refuses startup activation. Nothing to fix; the removed
test asserted the wrong thing.

## SOLVED — it was the host spend ceiling, not anything above

Diagnosed against the operator's live mesh (`skill-panel`, host on :7420).
**None of the suspects in this file were it.** What the running server said:

    mode = "parked"   uiOnly = true   startupActivateCount = 2
    lastBoot = { activated: ["pm","architect"], refused: [] }
    host spend = { usd: 53.33, ceilingUsd: 50, ceilingTripped: true,
                   parked: ["skill-panel"] }

The boot **worked** — both seats activated, nothing refused — and the mesh was
parked again seconds later. `applyLimits` (`mesh-server/src/host.ts:447-455`)
parks *every* running project once aggregate spend crosses `spend_ceiling_usd`,
and it re-runs on each child heartbeat. So Continue goes live, activates, and is
re-parked on the next beat, forever. Not a broken button: a budget that ran out.

`lastBoot` (added the same session) is what proved it — by showing a *clean*
boot, it eliminated the entire refused-seats branch below.

**The real defect was in the console.** `HostSpend` was on the wire and typed at
`projects.tsx:44-53`, and **nothing rendered it** — `refreshProjects` read
`json.projects` and dropped `json.spend`. The server knew, named the project, and
told no one. Same shape as every other bug in this file. Now plumbed through
`ProjectsState.hostSpend` and rendered as a `bad` strip that names the numbers
and says Continue will not hold.

Note `DEFAULT_SPEND_CEILING_USD` is **on by default** (`host-config.ts:22-29`)
and `~/.agent-mesh/host.yaml` is optional — so an operator who never wrote that
file still gets a $50 cap they never chose. That is the trap.

## Open

**Refused startup seats are still untested** — but this is now known *not* to be
the reported bug, so it is hygiene, not a lead. `activateAgent` refuses when
there is no goal, or the goal is PAUSED / FAILED / COMPLETED / ESCALATED
(`supervisor.ts:1657-1662`); `lastBoot.refused` carries the reason to the banner
and no test drives that branch. `completeMission()` is private
(`supervisor.ts:5438`), so reaching COMPLETED honestly means evidencing every
mandatory criterion.

**The ceiling strip has no test.** It was verified against the live host by
reading `/api/projects`, and typecheck + build are clean, but nothing in
`tests/` drives `ceilingTripped`. A host-level e2e (two projects, low ceiling,
assert both parked and the flag set) is the missing piece.

**Which case is the operator in?** Now self-answering: the banner names the
cause, and the toast no longer reports success. If it still misbehaves, the thing
to capture is whether the parked banner *clears* — if it does not, the POST never
landed and the problem is back in the UI path, not the server.
