# Task 03 — WS3: Designer header and source-of-truth state

- Run: `plan-20260910-designer-page-ux` · Baseline: `398331d37b4e51cb8a056008b4cb4f214503ad2e`
- Phase: A (P0) · Depends on: tasks 01, 02 complete · Followed by: task 04 (same region)
- Requirements: REQ-DSG-001, REQ-DSG-004 (review pts 1, 9, 17)

## Goal

Rebuild the Designer header around ONE canonical state line, add a pure `sourceState()` selector
driven by existing draft/runtime facts, and retire the duplicated verdict so the running FILE vs
live PROCESS distinction is explicit. No revisions, no server/API changes.

## Dependencies

- Tasks 01–02 (Phase A shell work) landed first.
- Task 04 consumes the SourceState props introduced here (action zone of `wb-bar`); agree the
  prop boundary before writing task 04.

## Files

- Modify: `apps/mesh-dashboard/src/designer/model.ts` (add `sourceState` beside `summarizeDiff` `:163`)
- Modify: `apps/mesh-dashboard/src/designer/Designer.tsx` (`ms-head` `:477-492`; diff memo `:175`;
  `doSave` `:443-456`; load paths `:393`, `:405-418`; restore banner `:506-514`; state zone
  `:612-617`; `saveLabel` `:462`; subtitle `:488-491`)
- Modify: `apps/mesh-dashboard/src/designer/chrome.tsx` (`HealthStrip` `:23-49`; `ReviewCard`
  copy `:116-133`; add the SourceState presentation here if it does not fit inline)
- Modify: `apps/mesh-dashboard/src/designer/designer.css` (`.ms-head` `:8-9`; `.replace-bar`
  `:197-202`)
- Prefer no new files; the plan allows a SourceState render component only if needed.

## Constraints (verbatim, from the plan)

- Save is a file write only; restart-to-apply (`apps/mesh-server/src/index.ts:1136`). Never label
  anything "Apply changes". Primary copy: "Save mesh"/"Save running config"/"Save copy" plus
  "writes mesh.yaml · restart to apply".
- Draft storage key `mesh-designer-draft-v2` and payload shape stay backward compatible (adding
  fields allowed, renaming not); INV-DSG-004.
- WS3 must fix the stale `diff` memo (`Designer.tsx:175` deps `[curJson]` while `doSave` mutates
  `draft.runningRaw` at `:446`) via an explicit running-revision counter BEFORE SourceState ships.

## Checklist

- [x] FIRST, before SourceState: add a `runningRev` state in `Designer` and bump it every time
      `draft.runningRaw` changes — running save (`:446`), running load paths (`:393`, `:409-413`),
      and the initial mode==="running" load (`:112-113`). Add it to the `diff` memo deps (`:175`)
      or compute `diff` without memo; remove the now-unneeded eslint-disable if it becomes stale.
- [x] Add pure `sourceState()` in `model.ts` beside `summarizeDiff` (`:163`): inputs
      `{ dirty, diff, runningRaw, saveMode, restoredAt }`; outputs
      `NEW | MATCHES_RUNNING_FILE | DIFFERS(n) | RESTORED_DRAFT | COPY_SAVED`. Keep `dirty`
      (vs baseline; reset at `:149`, `:375`, `:449`) distinct from differs-from-running. Degrade
      safely when `runningRaw`/storage is unavailable (U2).
- [x] Rebuild `ms-head` (`:477-492`): "Mesh Designer" + workspace line (mesh name/goal/id from
      `m.mesh`) + ONE canonical state line (`N agents · M wires · verdict` from `ids`/`links`/
      `verdictState`).
- [x] Remove/absorb duplicated verdict rendering: header pills (`:480-486`), superseded
      `HealthStrip` tiles (`chrome.tsx:24-46`), and `wb-bar-mid` divergence (`:612-617`) — the
      verdict must stop rendering four times; detail stays in `CheckSection` on demand.
- [x] Copy distinguishes the running FILE from the live PROCESS: running mode shows "matches the
      saved running config — restart the mesh to apply"; copy-mode saves show "saved copy at …
      · runtime unchanged" (never "differences"); no "Apply changes" anywhere (DES-DSG-002).
- [x] Replace the `replace-bar` restored banner (`:506-514`) with the SourceState presentation
      (Keep draft / Discard / replace) reusing `loadRunningClick`, `setRestoredAt`,
      `confirmReplace`; `restoredAt` stays ephemeral with explicit dismiss.
- [x] Preserve INV-DSG-003: save semantics unchanged, stale guard `:433-436`, radio target modes;
      INV-DSG-004: key `mesh-designer-draft-v2` and payload `{ts, model, saveMode, copyPath}`
      (`storage.ts:29-47`) stay readable; INV-DSG-005: validate flow `:62-66` unchanged.
- [x] WS4 owns the `wb-bar` ACTION zone (`:618-635`); leave an explicit prop boundary (state
      zone/`wb-bar-mid` stays WS3) and never mutate WS4-owned state from here.

## Expected behavior after the task

- One canonical header state line; the restore banner and verdict duplication are gone.
- After "Save running config", the diff recomputes immediately (no stale "matches running").
- Copy saves say the runtime is unchanged; running mode says restart to apply.
- Draft restoration still offers Keep/Discard and `restoredAt` dismisses explicitly.

## Verification

Automated:
- `npm run typecheck`
- `npm run lint`
- `npm run build:ui`

Manual — `npm run dev`:
- [x] Restore/discard a stored draft; `restoredAt` banner keeps explicit dismiss semantics.
- [x] Edit → save running; the diff/state line updates immediately after save (the `:175` fix).
- [x] Copy-target save shows "runtime unchanged"; running-target copy shows restart-to-apply.
- [x] Reset confirm still appears; validator still re-checks as you type.
- [x] Both themes.

## Cleanup

- Remove dead `.replace-bar` CSS if the presentation is replaced; no orphaned verdict styles.
- No new dependencies; changes only under `apps/mesh-dashboard/src/**`; no formatting-only diffs.
- Kill `npm run dev` processes when done.
