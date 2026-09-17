# Boot visibility — design brief

Untracked scratch file. Delete when the work lands.

## The complaint

Operator ran the mesh, nothing happened, no error anywhere. The UI reported success.

## Root cause (verified this session)

`goLive()` (`apps/mesh-server/src/index.ts:336-353`) does two independent things:

1. `scheduler.start()` — unconditional
2. activates each seat in `config.startupActivate`

Step 1 succeeding says nothing about step 2. If `startupActivate` is empty, or every
seat is refused, the mesh is **live, healthy, and permanently idle**. Nothing in the
system treats that as abnormal.

`activateAgent` returns `{ queued: boolean; blocked?: string }`
(`packages/core/src/supervisor.ts:1655`); refusal reasons at `:1657-1679`, incl.
`"already active, or deferred by budget/policy"`.

## Already fixed (commits bea8211, 43d094d)

- `goLive()` returns `refused: Array<{ agentId, reason }>` next to `activated`
  (mirrors `reopenGoal`'s existing shape, `supervisor.ts:3086`).
- `POST /mission/{boot,start}` returns `activated` + `refused` and a note that no
  longer prints `config.startupActivate` as though those agents had started.
- `useGoLive` (`apps/mesh-dashboard/src/actions.ts:112`) picks toast title/tone from
  the real counts instead of asserting "agents are running" off a 200.

That makes the **transient** report honest. It does not fix the durable one.

## Decision taken

Two separate failures, both in scope. Neither covers the other — which is likely
why this fell through the crack.

**A. Config cannot run** → pre-flight, in the designer, before Run is clickable.
**B. Config could run but was refused at boot** → runtime banner, Overview.

## B — runtime banner (start here; cheaper and better understood)

The structural hole: `Overview.tsx:188-194` has banners for `needYou`, `PAUSED`,
`COMPLETED`, `FAILED`, and a parked strip at `:185`. There is **no `idle` case**.
`halted` (`:156`) does not cover it. So "live and working" and "live and idle"
render identically.

Key finding — the banner does **not** need a server change. Overview already has
everything it needs to derive the state:

- `active` (`:150`) = agents in a `RUNNING` lifecycle
- `runningSteps` (`:154`)
- `sched` (`:153`), `parked` (`:157`)

→ `live && active.length === 0 && runningSteps.length === 0` is the idle condition,
and it stays correct after a page refresh.

What *does* need care: the **reason**. Lifecycles alone can't say "refused by budget."
The `refused` array only exists in the POST response, so it's gone on refresh.
Options, in preference order:

1. Derive the banner client-side (survives refresh), and enrich it with `refused`
   reasons while they're still in memory from this session's boot.
2. Have the server remember the last boot's refusals and expose them on `/status`.
   More robust, more surface area. Only if (1) proves too thin in practice.

Do not drive the banner off the POST response alone — it disappears on refresh, which
is exactly when a stuck operator goes looking.

## A — pre-flight in the designer

**Unread — I did not open the designer this session.** Start by reading
`apps/mesh-dashboard/src/designer/model.ts`.

⚠️ That file had uncommitted changes in the working tree that were not mine.
**Commit or stash before touching it.**

What pre-flight has to catch (all knowable statically, none reach the server):

- `startupActivate` empty → Run cannot do anything
- `startupActivate` naming agents absent from the mesh
- every named agent in a state that cannot be activated

Open question for whoever picks this up: does the designer already have a validation
channel (error list, disabled-Run affordance), or does one need building? That
answer decides whether A is small or large. Find out before estimating.

## Not yet decided

Whether a mesh that goes idle *later* (not at boot) should reuse the same banner.
Probably yes — same operator confusion, same remedy — but it wasn't the reported bug,
so it wasn't designed for.
