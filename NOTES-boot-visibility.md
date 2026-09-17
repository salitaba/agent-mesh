# Boot visibility — design brief

Untracked scratch file. Delete when the work lands.

## The complaint

Operator ran the mesh, nothing happened, no error anywhere. The UI reported success.

## Root cause (verified)

`goLive()` (`apps/mesh-server/src/index.ts:336-353`) does two independent things:

1. `scheduler.start()` — unconditional
2. activates each seat in `config.startupActivate`

Step 1 succeeding says nothing about step 2. If `startupActivate` is empty, or every
seat is refused, the mesh is **live, healthy, and idle**.

`activateAgent` returns `{ queued: boolean; blocked?: string }`
(`packages/core/src/supervisor.ts:1655`); refusal reasons at `:1657-1679`.

## Done

**bea8211** — `goLive()` returns `refused: Array<{ agentId, reason }>` beside
`activated` (mirrors `reopenGoal`, `supervisor.ts:3086`). The boot route stopped
printing `config.startupActivate` as though those agents had started.

**43d094d** — `useGoLive` (`apps/mesh-dashboard/src/actions.ts:112`) picks toast
title/tone from the real counts instead of asserting "agents are running" off a 200.

**B (runtime banner)** — `views/Overview.tsx:196`. The old single grey "All quiet"
required `waiting.length === 0`, so with any agent WAITING the stuck operator got
*no banner at all*; and when it did show, neutral grey read as a routine lull. Now
splits: **warn** when live with nothing queued ("Live, but no agent is working"),
neutral when agents are merely waiting. Also gated on `!parked` so it can't
double up with the parked strip.

## A (pre-flight in the designer) — NOT NEEDED. Already exists.

Investigated and closed. Do not build this.

- `packages/config/src/index.ts:494-496` — hard **error**:
  `startup.activate references unknown agent '<id>'`
- `packages/config/src/index.ts:914-919` `warnNoStartupActivation` — **warning**
- `designer/chrome.tsx:30` — HealthStrip `boots` tile renders `"nobody"` with
  `warn: true`, clickable through to the crew tab

The empty-startup warning is **deliberately non-fatal**; the reasoning is at
`packages/config/src/index.ts:909-913` and still holds: the stall watchdog does
nudge a live seat, so the mission recovers — what it cannot recover is *intent*,
since the first seat to move is a guess rather than the lead the operator meant.
Do not escalate it to an error without addressing that argument.

`Designer.tsx:467-471` records that these checks were deliberately moved out of the
designer's local advisors into `packages/config` so CLI and server boots see them
too. **Re-adding them locally would undo that.**

Structural point: the designer has **no run control**. It saves only
("restart to apply", `Designer.tsx:1152`); `onBoot` in `Topology.tsx:31,280` is a
misnomer for `toggleStartup`. So the designer cannot know about seats the *runtime*
refused — that state does not exist until boot. Runtime refusals are Overview's job,
which is what B covers.

## Open — the one real gap left

The B banner says "usually startup agents that were never configured, or that were
refused at boot". It says *usually* because it is guessing: it derives idleness from
agent lifecycles, and the actual cause is not on `/status`.

- "never configured" **is** durably knowable — the server has
  `config.startupActivate.length`. Putting that count on `/status` would let the
  banner say definitively "no startup agents are configured" and link to the designer,
  closing the loop between the two surfaces.
- "refused at boot" is **not** durably knowable — `refused` exists only in the
  `/mission/start` response and is gone on refresh. Would need the server to remember
  the last boot's refusals.

Do the first before the second; it is much cheaper and covers the commoner case.
Do **not** drive the banner off the POST response alone — it vanishes on refresh,
which is exactly when a stuck operator goes looking.

## Not designed for

Whether a mesh that goes idle *later* (not at boot) should reuse the same banner.
Probably yes — same confusion, same remedy — but it wasn't the reported bug.
