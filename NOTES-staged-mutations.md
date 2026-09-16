# Staged mutations — Phases 1, 2 and 3 COMPLETE (Phase 3 bar the manual end-to-end pass)

Plan: `~/.claude/plans/humble-conjuring-quill.md`. Branch `feat/plan-visibility`.
Full suite green. The header above used to read "Phase 3 not started" while the Phase 3
section below reported it complete; the section was right.

## Done (protocol + core, full suite green 1047/1047)

- `packages/protocol/src/types.ts` — `StagedMutation` union (15 kinds), `StagedProposal`,
  `DESTRUCTIVE_KINDS`, 4 new `EventType` members, `LifecycleState` gains `RETIRED`.
  `run.budget` uses the inline `{ maxEvents?, wallClockMinutes? }` shape: `GoalBudget` exists
  (`types.ts:399`) but requires `tokens`, which `adjustGoalBudget` does not accept.
- `packages/protocol/src/catalog.ts` — `EVENT_TYPES`, `EVENT_SEVERITY`, `LIFECYCLE_STATES`,
  `LIFECYCLE_TRANSITIONS` (`RETIRED` reachable from every state, no outgoing edges).
- `packages/core/src/projections-goal.ts` — `goal.description_revised`, `requirement.revised`,
  `requirement.removed` (last two recompute progress).
- `packages/core/src/projections-agent.ts` — `agent.retired`. NOT in the goal reducer as the plan
  said: it is an agent event and `transitionLifecycle` lives here.
- `packages/core/src/termination.ts` — extracted `criterionSatisfied` + `criteriaWouldComplete`
  from the closure inside `evaluate`, so the removal guard and the completion verdict share ONE
  definition of "satisfied" and cannot drift apart.
- `packages/core/src/supervisor.ts` — `reviseGoalDescription`, `reviseCriterion`,
  `removeCriterion`, `retireAgent` beside `adjustGoalBudget`. All gated through
  `deps.policy.evaluateAuthority`.
- `tests/core/staged-executors.test.ts` — 7 tests.
- Regenerated `schemas/event.schema.json` via `npm run schemas:sync` (the AJV enum is checked in).

## Two things worth knowing before continuing

1. **Authority strings are new and nobody holds them**: `requirements.revise`, `requirements.remove`,
   `agents.retire`. Only `HUMAN_AGENT_ID` passes, because it short-circuits ALLOW
   (`policy-engine/src/index.ts:111`). That is the intended default; granting a role one of these
   is a mesh.yaml decision, not a code one.
2. **`RETIRED` is terminal and the reducer THROWS on an illegal transition**
   (`projections-helpers.ts:379`). An `agent.resumed`/`agent.suspended` aimed at a retired seat
   would be written to the log and then throw on every replay forever. `suspendAgent` /
   `resumeAgent` / `activateAgent` / `runTurn` now refuse before emitting. The completion sweep
   (`supervisor.ts:5244`, IDLE/WAITING only) and the reopen revive (`:3074`, COMPLETED only)
   already exclude it. **Any new lifecycle emit site must be checked against this.**

## Done (server half)

- `apps/mesh-server/src/staging.ts` — `applyStagedMutation` + `applyStagedProposal`. Array order,
  halt on first failure, `{ ok, applied, results }`. No extraction was needed for `mission.reset`:
  `instance.reset()` is already a method on `MeshInstance` (`index.ts:117`); the route body around
  it is only the `confirm:true` gate and the note text.
- `apps/mesh-server/src/index.ts` — `POST /designer/staged/apply` just above the designer chat
  routes. 200 all-applied / 409 refused / 400 malformed. **409, not 400**: a refusal means the
  proposal was well-formed and the mesh said no, which is the guard working.
- `tests/integration/staged-apply.test.ts` — 7 tests over a real `createHttpServer`.
- Curl'd by hand against a throwaway mesh on :7799; all four cases behaved (see commit message).

### Fifth supervisor method, beyond the plan's four

`addCriteria` (`supervisor.ts`, after `removeCriterion`). `criteria.add` is in the union but the
plan's executor list has no mapping for it, and there was no existing add path — `requirements.created`
was only ever emitted from the artifact handler. Without it a staged proposal containing
`criteria.add` fails at apply time, i.e. an editor for the definition of done that can edit and
delete but not add. It reuses `requirements.created` (no new event, no new reducer) and refuses
duplicate ids rather than relying on the reducer's silent dedupe.

## Design notes worth keeping

- **`config.replace` is refused server-side on purpose.** It targets the browser's mesh.yaml draft
  and still needs a separate Save; applying one to the running mesh would be an unreviewed config
  change. A client that POSTs it here has mis-routed.
- **Re-validation before every call is not belt-and-braces.** `suspendAgent`/`resumeAgent` return
  `void` and refuse internally, and `registerAgent` is a bare emit with no duplicate check — calling
  either blind would answer 200 over a no-op. Staging happens a turn or more before applying and the
  mesh moves in between (plan Risk 4).
- **Halting matters most for the destructive tail.** A proposal is a sequence someone reasoned
  about; the curl run confirmed a failing `criteria.delete` in position 2 stopped a `mission.reset`
  in position 3 from ever running.

## Phase 2 — staging bridge (COMPLETE)

Turn-scoped buffer + `mesh_stage_*` MCP tools + drain onto the SSE `final` frame.
Suite 1067/1067 = Phase 1's 1054 + 10 in `designer-staging.test.ts` + the 3 below.

- `apps/mesh-server/src/designer-staging-mcp.ts` — the toolset, and `soleOpenTurn()` at `:124`
  with the reasoning for refusing over guessing in the comment above it.
- `apps/mesh-server/src/index.ts:920` — turn id from the `x-mesh-designer-turn` header, falling
  back to the `?turn=` query param.
- `apps/mesh-cli/src/mcp-stdio.ts:18-26` — why the bridge is per-turn for claude and shared for
  opencode, written where the next reader will hit it rather than only here.
- Runtime wiring: `runtime-claude/src/index.ts:963` (`designerStagingMcpServer`, keyed
  `mesh_staging` at `:593`); `runtime-opencode/src/index.ts:602` (third bridge, same key).
- Tests added this session: 2 in `tests/integration/claude-runtime.test.ts` (bridge wired with the
  turn id; no `opts.mcp` → no `mcpServers` key at all), 1 in `tests/integration/adapters.test.ts`
  (the third bridge lands without unlocking `DESIGNER_DENIED_TOOLS`). That last one is plan Risk 3:
  opencode's designer branch is *reached* by `opts.mcp === false`, so a third bridge is a third
  chance to flip that gate and hand the designer a filesystem. Nothing had ever asserted on the
  deny map — `DESIGNER_DENIED_TOOLS` appeared in zero tests before this.

### Four deviations from the plan

1. **stdio bridge, not remote MCP.** The plan assumed an MCP server reachable over HTTP. This repo
   has no remote MCP transport — every bridge is `type: "stdio"` spawning `mesh.mjs mcp`. Both
   runtimes spawn a local bridge and take the bus as `--bus <origin>`; `mcp.url` is consumed only
   for its origin (`runtime-claude/src/index.ts:968`), the path is discarded.

2. **Sole-open-turn resolution, refusing on ambiguity.** Claude's `query()` takes options per call,
   so its bridge is minted per turn and carries `--turn` exactly. Opencode has ONE shared backend
   and one config file, so its bridge cannot carry a turn id at all. The bus resolves the open turn
   itself and REFUSES when more than one is open (`designer-staging-mcp.ts:124`) instead of taking
   the newest — and never lets the model name its own turn, which is the cross-turn write this
   whole design exists to prevent. Two
   concurrent designer turns is a rare state; filing a staged mutation against the wrong one is not
   a recoverable mistake.

3. **`?staging=1` + `--turn` as the correlation scheme.** `--staging` is a bare flag on the bridge;
   the CLI turns it into `staging=1` on the URL (`mcp-stdio.ts:73`) and sends the turn as the
   `x-mesh-designer-turn` header (`:80`). Only the claude bridge ever has a `--turn` to send — the
   opencode entry carries `--staging` and `--bus` and nothing else.

4. **`queryFn` extended to the designer path** (`runtime-claude/src/index.ts:583`), one line, not in
   the plan. Item 1's assertion was otherwise unreachable: `designerStagingMcpServer` is private,
   `extraOptions` merges LAST and so clobbers `mcpServers` rather than capturing it, and nothing in
   `tests/` intercepts the SDK. The seam already existed for session rotation (`:823`) and its own
   doc comment scopes it to "replaces the transport, not the configuration" — exactly this use.
   `prompt()` delegates to `promptStream()`, so one line covers both entry points.

### Two stale comments, left in place deliberately

- `runtime-claude/src/index.ts:678` — `setDesignerObserve`'s comment still reads "designer turns
  here run with no MCP at all". Narrowly still true of that no-op port method (claude takes its bus
  from `opts.mcp`, never from an observe provider), but it now scans as a claim about the runtime.
- This file used to say `DesignerRuntime` needed `mcp?: { url, headers }`. It landed on
  `DesignerPromptOptions` (`packages/protocol/src/types.ts:1145`) instead.

### Still true, and still the whole point

Staging tools only push to the buffer — they never call a Supervisor mutator. Phase 1's refusals
fire at Apply time, in front of the operator.

## Phase 3 — dashboard (COMPLETE except the manual end-to-end pass)

Suite green at 1079/1079 (1067 + 12 new). Dashboard typecheck clean, eslint clean on every
touched file.

### What landed

- **`apps/mesh-dashboard/src/designer/mutations.ts`** (new) — the handler table, typed
  `Record<StagedMutation["kind"], MutationHandler>` so a kind added in the protocol becomes a
  compile error here instead of a mutation that silently renders no card. Also `splitByTarget`,
  `summarizeMutation` (appends `reason` uniformly, so no summarizer repeats that), `labelFor`,
  `targetOf`, `isDestructive`, `destructiveKindsIn`, `CONFIRM_WORD`, `showsTextProposal`.
  Pure and DOM-free on purpose — see the constraint section below.
- **`designer/panels/ChatPanel.tsx`** — one review expander, up to three cards inside it:
  the legacy text proposal, the staged draft card, and the live-run card. `applyStagedDraft`
  parses the `config.replace` YAML to a model *at the card*, so `applyChatProposal`'s
  `next.agents` / `mesh.id` assumptions stay in the one branch that already had them.
  `applyToRun` POSTs `/designer/staged/apply` and renders the server's own
  `results[].detail` sentences, so a Phase 1 refusal is read by the operator verbatim.
- **`designer/chatStore.ts`** — `ChatEntry.proposal?: StagedProposal` added *alongside*
  `proposed?: any`, guarded by `isStagedProposal` because the stream is untrusted shape-wise.
- **`src/commands.ts`** — documented, not retyped. See deviations.
- **`tests/dashboard/mutations.test.ts`** (new, 12 tests).
- **Build config** — `apps/mesh-dashboard/tsconfig.json` gained `baseUrl` + a `@mesh/protocol`
  path; `vite.config.mts` gained the matching `resolve.alias`.

### The constraint that shapes this file

Root `tsconfig.json` excludes `apps/mesh-dashboard/src/**` from the node build, with `route.ts`
and `tabmodel.ts` as named exceptions "precisely so [they] can be covered by node:test". So
anything `tests/dashboard/` touches compiles under `lib: ["ES2022"]` with no DOM. That is why
`mutations.ts` takes a structural `MutationContext { model }` instead of importing `DraftState`
from `storage.ts` — storage is localStorage-backed, and even a type-only import of it drags the
DOM lib into the test build.

`@mesh/protocol` resolves to raw TypeScript (`package.json` main → `./src/index.ts`), so it is
compile-time only. `mutations.ts` may import types from it because `import type` is erased;
`tests/dashboard/mutations.test.ts` takes the runtime `DESTRUCTIVE_KINDS` by relative path
instead, matching `tests/event-store/store.test.ts:7`. This is the same trap the repo's
`no-restricted-imports` warnings describe.

### Five places the plan's Phase 3 anchor map was wrong

1. `ChatPanel` never used `ReviewCard`. `ReviewCard` is the draft-save surface at
   `Designer.tsx:1032`; the chat review is inline markup. "chrome.tsx:168 needs no change"
   was true, but for an unrelated reason.
2. `commands.ts` is `src/commands.ts`, not `src/designer/commands.ts`.
3. `ChatPanel.tsx` is `designer/panels/ChatPanel.tsx`.
4. The chat diff came from `proposalDiff` (ChatPanel-local, a cache around `summarizeDiff`),
   not from `summarizeDiff` directly. `summarizeDiff` is unchanged — `Designer.tsx:417` also
   uses it. What narrowed is its *role*: it is now the `config.replace` summarizer.
5. `setPendingProposal` is not in `Designer.tsx`; it lives in `src/commands.ts`.

### Three deviations, all deliberate

- **Typed-confirm is scoped to the live-run card**, not to every destructive kind. `config.replace`
  is the only destructive kind targeting the draft, and that path is already gated by the review
  expander, pushed onto the undo stack, and still needs an explicit Save. Confirmed with the
  operator before implementing.
- **`commands.ts` still carries a parsed config model, not a `StagedProposal`.** The plan said to
  retype it, but the Designer's apply path wants a model; making it a `StagedProposal` would push
  YAML parsing *into* Designer and spread the `next.agents` assumptions the NOTES asks to confine.
- **No CSS added.** `ms-chat-review`, `ms-chat-actions`, `diff-list` and `ms-chat-msg` have zero
  rules in `styles.css` today — the panel is already semantic-but-unstyled. The protocol's "must
  keep these visibly distinct" requirement is carried by `verdict warn` / `verdict bad` (which
  *are* styled) plus explicit card headings. Styling the chat panel is its own task.

### Still open

- **Plan §Verification P3's manual end-to-end pass is NOT done.** It needs a live run: tighten a
  criterion and retire an idle seat in one designer turn, confirm TWO distinct cards, apply, then
  verify via `mesh_run_status` and the event log that exactly the staged events landed. Nothing
  automated covers the `/designer/staged/apply` round trip from the browser.
- Plan Risk 5 is **closed in code**: `showsTextProposal` suppresses the text `proposedConfig`
  whenever the staged buffer carries a `config.replace`, and it is covered by a test.

## Follow-up fix — the goal-drift gap (COMPLETE, suite 1087/1087)

**The bug.** `config.replace` + Save rewrites mesh.yaml and the Config view updates, because
`GET /config` re-reads the file on every poll (`apps/mesh-server/src/index.ts:1541-1552`, and the
comment there says so deliberately). But the running goal is seeded exactly ONCE, in
`supervisor.boot` (`packages/core/src/supervisor.ts:763-771`), from `config.goalText` /
`config.goalCriteria`; nothing re-reads it afterwards, and `status()` serves the in-memory goal
(`:5687,5704-5708`). So an operator who reworded the goal through the designer was told it saved —
it did, into the file — while the Overview kept showing the pre-edit mission. Neither half was
wrong on its own, which is why nothing downstream could detect it.

**The fix is a warning, not a reconcile.** Re-seeding a live goal from the file would silently
rewrite a running mission's definition of done, which is the unreviewed config change that
`staging.ts:66-68` already refuses `config.replace` for. The divergence is legitimate; being
unable to SEE it was the defect.

- `apps/mesh-dashboard/src/designer/mutations.ts` — `goalDriftWarning(mutations, mission)` +
  `LiveMission`. Pure, DOM-free like the rest of the module. Parses a staged `config.replace` and
  compares `mesh.goal` / `mesh.acceptance_criteria` against the running mission. Deliberately
  silent on: no live mission, no `config.replace`, unparseable YAML (the itemized summary already
  reports it), and a file with NO `acceptance_criteria` — that is the ordinary shape of a mesh
  whose criteria were derived at boot, not a proposal to clear them.
  `MutationContext` was NOT extended: passing the mission explicitly left every handler signature
  and every existing test untouched.
- `apps/mesh-dashboard/src/designer/panels/ChatPanel.tsx` — renders it in the draft card. Watch the
  name collision: `live` in that file is the STREAMING reply, not the live mesh; the new value is
  `mission`, memoized on `status?.goal` because /status re-polls under every streamed token.
- `apps/mesh-server/src/index.ts:544` — persona. The old line said config and live-run changes "are
  different things" but never that a config goal edit does not move a RUNNING mission, so the
  assistant kept wrapping goal rewordings in `config.replace`. It now names
  `mesh_stage_goal_description` / `mesh_stage_criteria_*` as the live path.
- `tests/dashboard/mutations.test.ts` — 9 tests, including the whitespace/block-scalar case (a
  rewrapped goal is not drift).

**"Just restart it" is the wrong advice for the goal, and only for the goal.** `boot()` mints a
goal only when it is NOT resuming (`supervisor.ts:754`), so a resumed mesh keeps its existing goal
and reads past the file — a restart does not dependably apply a goal edit. Seats and budgets are
the opposite: boot reconciles agents from the file on every boot (`:795-812`, `agent.replaced` when
a definition differs) and re-declares budgets (`:814-818`). That asymmetry is why the warning names
the live-run kinds instead of telling the operator to restart, and why the generic
"restart the mesh to apply" line in `chrome.tsx:181` is true of seats and budgets but not of this.

**The chat draft cards never carried that generic line at all.** The Designer's ReviewCard says
"the live mesh keeps working; restart the mesh to apply"; the chat cards said only "Draft change —
local, still needs Save", so a config change made through chat read as though Save were the whole
story. Both chat draft cards now carry the same standing note. The goal/criteria warning sits on
top of it for the case where restarting is not the fallback either.

---

## Follow-up 2 — the warning was not the fix: Save now offers to sync

The warning above tells an operator that a config goal edit will not move the running mission. It
does not move it. Operator verdict: *"still mesh config is not sync with overview page"* — correct,
and the reason is that nothing in the product could close the gap without hand-editing the mission
through chat. A Save onto the running config now hands back the proposal that closes it, and the
Designer offers it in one reviewed click.

Chosen shape (operator's call): **offer to apply after Save**, scoped to **everything with a live
counterpart** — goal, criteria, seats and the mission budget.

- `apps/mesh-server/src/config-drift.ts` — NEW. `configDrift(resolved, instance): StagedProposal`.
  Pure description, no mutation. Server-side because `seat.spawn` needs a fully resolved
  `AgentDefinition`; building one in the browser would fork `buildResolved`'s defaults.
- `apps/mesh-server/src/index.ts` — `POST /config/save` returns `drift` in its 200, but **only when
  the save landed on the running config** (`path.resolve(config.filePath) === target`); a copy-save
  writes a file that is nobody's running config. A throw from the comparison is swallowed: the
  bytes are already on disk, and a failed comparison must not turn a successful save into an error.
- `apps/mesh-dashboard/src/designer/chrome.tsx` — `SyncCard`, presentational like the rest of the
  file. Reuses `summarizeMutation` / `destructiveKindsIn` / `CONFIRM_WORD`, so the sync offer reads
  in the same language as the chat's proposals and takes the same typed confirm.
- `apps/mesh-dashboard/src/designer/Designer.tsx` — `drift` state, and `applySync` posting to
  `POST /designer/staged/apply`. **No new route and no new authority**: every Supervisor refusal,
  destructive-reason check and halt-on-first-failure comes from the path that already had them,
  and the card prints the server's own sentences rather than an HTTP code.
- `tests/server/config-drift.test.ts` — 11 tests against a really-booted mesh rather than a stubbed
  state, because the module's whole job is comparing the file to what boot made of it.

**What the sync deliberately cannot do**, surfaced as `problems` next to what it can (a partial
sync must never read as a complete one):
- a live seat whose definition changed — no staged kind replaces one; `agent.replaced` is boot's,
  and has no mutation counterpart. Restart applies these.
- a seat that was RETIRED. Terminal.
- the mission token budget — `adjustGoalBudget` accepts only `maxEvents` / `wallClockMinutes`.
- a file with no `acceptance_criteria` while the mission has live ones — reported, never acted on.
  An absent section is the ordinary shape of derived criteria, not a request to clear them.

`SavedCard` drops its "Restart the mesh to run it" line while a sync is offered: the SyncCard owns
the sentence there, and a restart is exactly what will not move a resumed mesh's goal.

**Still unverified end to end.** Everything above is typechecked, linted and covered by tests
(full suite 1099/1099), but no one has driven the real flow in a browser: Save onto a running
config, read the offer, apply, watch the Overview change. That pass needs a live mesh and is out of
reach from the dev environment these changes were written in.
