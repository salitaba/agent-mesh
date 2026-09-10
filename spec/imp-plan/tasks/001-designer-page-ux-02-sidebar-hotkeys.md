# Task 02 — WS2: Sidebar clarity and hotkey presentation

- Run: `plan-20260910-designer-page-ux` · Baseline: `398331d37b4e51cb8a056008b4cb4f214503ad2e`
- Phase: A (P0) · Depends on: task 01 (same file, sequential)
- Requirements: REQ-DSG-003 (review pts 3, 11)

## Goal

Keep the Run/Inspect/Build sidebar structure, present the 1..N numbers as keyboard shortcuts
using the existing `<kbd>` chip look, and align vocabulary. No navigation behavior changes.

## Dependencies

- Task 01 must be complete: both touch `apps/mesh-dashboard/src/shell.tsx`.

## Files

- Modify: `apps/mesh-dashboard/src/shell.tsx` (`NAV` `:13-29`, sidebar render `:252-264`)
- Modify: `apps/mesh-dashboard/src/styles.css` (`.tab`/`.kbd` rules `:103-117`; `<kbd>` chip `:824`)
- Do NOT touch: `apps/mesh-dashboard/src/designer/CrewRail.tsx` — its `CREW · N agents` label is
  owned by task 06 per §8; do not edit it here.

## Constraints (verbatim)

- Hotkeys 1..N are `KEY_VIEWS` view shortcuts (`shell.tsx:30`) — restyle only with the existing
  `<kbd>` chip (`styles.css:824`), never remove or renumber; INV-DSG-002.

## Checklist

- [x] Keep `NAV` section headers Run/Inspect/Build (`shell.tsx:13-29`); do not make the sidebar
      sticky (it is a non-scrolling flex column, `styles.css:99` — sticky would be a no-op).
- [x] Restyle `.tab .kbd` numbers to match the existing `<kbd>` look (`styles.css:824`): border,
      bottom border width, radius, mono font, subtle background. Scope selectors to
      `.tab .kbd:not(.esc-kbd)` so the escalations badge (`#esc-badge`, `styles.css:116-117`)
      keeps its red pill and `margin-right` relationship (`:117`).
- [x] Numbers remain `viewKey = KEY_VIEWS.indexOf(v)+1` (`shell.tsx:30`) rendered at `:260`;
      do not remove, renumber, or move them behind hover. Treat them as shortcuts, not steps.
- [x] Help table already lists 1..9 (`shell.tsx:69-74`) — no change needed.
- [x] Vocabulary: nav entry stays "Agents" (`shell.tsx:17`); `CREW · N agents` is task 06's
      `CrewRail.tsx:19` change (cross-reference only).

## Expected behavior after the task

- Sidebar sections and order unchanged; hotkey numbers look like keyboard chips in both themes.
- The escalations badge is visually unchanged and still precedes the hotkey chip.
- Pressing 1..N still switches views; Help still lists the keys.

## Verification

Automated:
- `npm run typecheck`
- `npm run lint`
- `npm run build:ui`

Manual — `npm run dev`:
- [x] Hotkeys 1..N switch views while the command palette is closed (INV-DSG-002); they do not
      fire while typing in inputs/textarea/select (existing guard `shell.tsx:124`).
- [x] Escalations badge renders as a pill when open, hotkey chip next to it is a `<kbd>` chip.
- [x] Both themes; check the `.kbd` contrast against the sidebar in light and dark.

## Cleanup

- Remove the old `.kbd` styling only if fully replaced; keep `#esc-badge` rules.
- No new dependencies; no changes outside `apps/mesh-dashboard/src/**`; no formatting-only diffs.
- Kill `npm run dev` processes when done.
