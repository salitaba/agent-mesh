# Task 01 — WS1: Shell status strip and action hierarchy

- Run: `plan-20260910-designer-page-ux` · Baseline: `398331d37b4e51cb8a056008b4cb4f214503ad2e` (working tree dirty; plan facts cite it)
- Phase: A (P0) · Depends on: none · Followed by: task 02 (same file, sequential)
- Requirements: REQ-DSG-002, REQ-DSG-008 (review pts 2, 10, 12, 13, 19)

## Goal

Restructure the shared shell topbar so it answers "is it running / who is working / what needs
me / what happens when I press the primary button" without mixing telemetry and workspace
controls. The topbar markup lives in `apps/mesh-dashboard/src/shell.tsx:271-301`; stats/state
derivations at `:88-108`. The existing `.status-strip` banner (`styles.css:177-184`) is a
different component — do not touch or rename it.

## Dependencies

- None. WS1 runs first in Phase A; task 02 edits `shell.tsx` after this lands.

## Files

- Modify: `apps/mesh-dashboard/src/shell.tsx` (topbar: `:271-301`; derived state `:88-108`)
- Modify: `apps/mesh-dashboard/src/styles.css` (topbar rules `:150-175`; new `.bar-strip*` classes)
- Modify: `apps/mesh-dashboard/src/designer/chrome.tsx` (`AdvisoryList` copy `:53-68`)
- Do NOT touch: `.status-strip`, `KEY_VIEWS`/`viewKey` (`shell.tsx:29-30`), `ApprovalDrawer`
  (`drawers.tsx:88`, sole call site `shell.tsx:299`), `apps/mesh-server/**`, `packages/**`,
  `schemas/**`, `tests/**`.

## Checklist

- [x] Split the topbar into identity (live dot/label, goal text `#top-goal`, criteria) and a
      compact telemetry strip with categories: system (`goal.status` via `statusWord` `:92-94`),
      agents (`active` `:96`), decisions (`escOpen` `:97`); keep `spent` (`mission` `:95`)
      visually secondary.
- [x] Use namespaced classes (e.g. `.bar-strip`, `.bar-strip-stat`); do NOT touch
      `.status-strip` (`styles.css:177`).
- [x] Geometry: fixed 56px row (`#app` grid, `styles.css:96`), no desktop wrap. Keep the
      `#top-goal` 34vw cap + ellipsis (`:154`) and give action labels a length budget. Define
      the 800–1200 behavior; at ≤800 the existing wrap block (`styles.css:831-841`) still
      applies.
- [x] One canonical needs-you destination: a `Review decisions · N` control that calls
      `setView("escalations")` (same destination as `Overview.tsx:176`), prominent when N>0 and
      muted otherwise. Make the `decisions` telemetry stat reach the same destination.
- [x] Keep `ApprovalDrawer` reachable (INV-DSG-001): keep button `id="btn-approval"` as a
      secondary affordance with distinct "approvals" wording and the existing title; keep
      `openDrawer(<ApprovalDrawer />)` at `shell.tsx:299`. Do not orphan it.
- [x] `AdvisoryList` summary (`chrome.tsx:56-60`): distinguish advisory copy (`N suggestions`)
      from `Decision required` (warn-level), so advisory vs blocking is unambiguous; keep the
      note links and `onGoto` behavior.
- [x] Leave pause/resume/message behavior (`shell.tsx:287-300`) intact; no action becomes
      unreachable.

## Expected behavior after the task

- At desktop width one 56px row shows identity, grouped telemetry, and actions; no wrap
  between 800–1200px.
- `Review decisions · N` and the decisions stat both open the escalations view; `approvals`
  still opens `ApprovalDrawer`; pause/resume/message still work.
- Hotkeys 1..N and every view are unchanged; both themes render (INV-DSG-007).

## Verification

Automated:
- `npm run typecheck`
- `npm run lint`
- `npm run build:ui`

Manual — `npm run dev`:
- [x] All views reachable; hotkeys 1..N switch views when the command palette is closed
      (INV-DSG-002).
- [x] `Review decisions` and the needs-you stat land on the escalations view; ApprovalDrawer
      still opens from the topbar.
- [ ] pause / resume / message work; no wrap at 800px and 1200px widths.
- [x] Toggle theme (`t`) and confirm both themes.

(No integration test here — the Phase A boundary run happens at the end of task 04.)

## Cleanup

- Delete superseded topbar CSS/markup in the same change; leave no dead selectors.
- No new dependencies; diff stays inside `apps/mesh-dashboard/src/**`; no formatting-only diffs
  (no formatter configured).
- Kill `npm run dev` processes when done.
