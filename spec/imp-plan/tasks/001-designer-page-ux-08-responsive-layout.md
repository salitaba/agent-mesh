# Task 08 — WS8: Responsive layout

- Run: `plan-20260910-designer-page-ux` · Baseline: `398331d37b4e51cb8a056008b4cb4f214503ad2e`
- Phase: C (P2) · Depends on: task 07 (visual base) · Phase boundary: this task closes Phase C
- Requirements: REQ-DSG-010 (review pt 23)

## Goal

Make the Designer adapt on the existing breakpoint scale: ≥1240 three zones, 800–1240 crew rail
as a CSS disclosure with a locally scoped inspector drawer, ≤800 the existing sidebar overlay plus
a full-width-cap inspector drawer. No invented thresholds, no global drawer-stack reuse.

## Dependencies

- Task 07 complete (typography/border tokens in place). Tasks 01–06 complete.

## Files

- Modify: `apps/mesh-dashboard/src/designer/designer.css` (`.ms-body` `:44-46`; `.ms-out-grid`
  `:181-182`; small-screen rules `:232-237`)
- Modify: `apps/mesh-dashboard/src/shell.tsx` (breakpoint/overlay work only; `NARROW` `:48`)
- Modify: `apps/mesh-dashboard/src/designer/Designer.tsx` (breakpoint class on the workbench)
- Modify: `apps/mesh-dashboard/src/designer/CrewRail.tsx` (disclosure markup only)
- Modify: `apps/mesh-dashboard/src/styles.css` only if the `.grid.two` 1100 rule (`:197`) needs
  reconciliation; do not change its threshold.

## Constraints (verbatim, from the plan)

- WS8 uses existing breakpoints only (Designer 1240 in `designer.css:46`, shell 800
  `shell.tsx:48`, `.grid.two` 1100 `styles.css:197`); no invented thresholds; do not route
  persistent rails through the global modal drawer stack (`shell.tsx:313-321`); never render
  rails twice.

## Checklist

- [x] Reconcile the old 1240 rule (`designer.css:46`) and define what happens at 800–1240:
      - ≥1240: three zones as today.
      - 800–1240: crew rail becomes a left CSS disclosure (collapsible); inspector becomes a
        right-side drawer VARIANT scoped locally.
      - ≤800: existing sidebar overlay (`shell.tsx:48`, `styles.css:831-841`); inspector drawer
        full-width cap.
- [x] Do NOT reuse the global modal drawer stack (`shell.tsx:313-321`: scrim + focus trap +
      single slot — opening Message would replace a rail). `drawers.tsx` holds contents, not a
      reusable container; do not touch it unless genuinely required.
- [x] Never render rails twice (duplicate input ids/state): one DOM instance per rail, toggled by
      CSS/`hidden`/`inert`, not duplicated per breakpoint.
- [x] Keep all input ids and aria labels reachable in the disclosure states; keyboard users must
      be able to open/close the rail and inspector.
- [x] Preserve `ms-body`/`ms-out` grid behavior above 1240; keep `.grid.two` 1100 behavior
      unchanged.
- [x] Update the `designer.css:232-237` small-screen block to match the new structure; remove the
      now-redundant 1240 collapse rule if fully superseded.

## Expected behavior after the task

- At 1240+ the three-column workbench is unchanged.
- Between 800 and 1240 the crew rail is a collapsible disclosure and the inspector is a local
  drawer variant; nothing overlaps and no rail renders twice.
- At ≤800 the shell sidebar overlays as before and the inspector drawer is width-capped.

## Verification

Automated:
- `npm run typecheck`
- `npm run lint`
- `npm run build:ui`

Manual — `npm run dev`:
- [x] Resize across 1240 and 800: no duplicate rails, no duplicated ids/state; disclosure
      open/close works.
- [x] Inspector drawer variant opens/closes locally; Message drawer still replaces only the
      global panel, never a rail.
- [x] Keyboard-only pass at 900px and 700px widths.
- [x] Both themes.

Phase boundary (end of Phase C):
`npm run build && node --test dist/tests/integration/bus-api.test.js`.

## Cleanup

- Remove superseded collapse rules and dead classes; no duplicate markup left behind.
- No new dependencies; changes only under `apps/mesh-dashboard/src/**`; no formatting-only diffs.
- Kill `npm run dev` processes when done.
