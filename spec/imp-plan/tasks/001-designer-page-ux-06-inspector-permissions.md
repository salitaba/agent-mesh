# Task 06 — WS6: Inspector disclosure and permissions

- Run: `plan-20260910-designer-page-ux` · Baseline: `398331d37b4e51cb8a056008b4cb4f214503ad2e`
- Phase: B (P1) · Depends on: Phase A tasks 01–04 complete
- Requirements: REQ-DSG-006, REQ-DSG-011 (review pts 6, 7, 24)

## Goal

Progressive disclosure for the crew inspector: grouped collapsible sections, permissions grouped
from the canonical `CAPS` list with counts, and the `CREW · N agents` label. No model semantics
change.

## Dependencies

- Phase A (tasks 01–04) complete. Can run in parallel with task 05 (different files). `model.ts`
  already received `sourceState` in task 03 — add grouping beside `CAPS`, do not disturb it.

## Files

- Modify: `apps/mesh-dashboard/src/designer/panels/CrewPanel.tsx` (whole panel, esp. groups
  `:125-245`; `CAN DO (N)` `:152-166`; rename box `:112-121`)
- Modify: `apps/mesh-dashboard/src/designer/model.ts` (`CAPS` `:7`; add capability grouping)
- Modify: `apps/mesh-dashboard/src/designer/CrewRail.tsx` (label `:19`)
- Modify: `apps/mesh-dashboard/src/designer/designer.css` (group/`details` styles near `:159-177`)
- Keep `MeshPanel`/`PolicyPanel` structure; align their labels with the WS7 type tiers (WS7 does
  the token work).

## Checklist

- [x] Reorganize `CrewPanel` into groups: General / Behavior / Permissions / Communication /
      Budget / Advanced (Advanced keeps the existing `<details>` at `:225-245`), collapsible.
- [x] Permissions group is collapsed by default and its summary reads
      `Permissions · N enabled` (replacing `can do (N)` at `:153`). Keep `ChipPick`,
      `CustomChips`, `CommaAdder` behavior exactly (`:154-161`).
- [x] Capability grouping: explicit map for known `CAPS` (`model.ts:7`, including `git.*`,
      `shell.execute`, `network.request`; put `code.review` with Review), prefix fallback →
      "other"; derive group order from `CAPS` so there is ONE source of truth. Unknown/custom
      caps still round-trip.
- [x] `CrewRail` label becomes `CREW · N agents` (`CrewRail.tsx:19`), keeping the
      `aria-label="crew"` aside intact.
- [x] Do not change rename dialog semantics or input ids (task 05's Backspace guard depends on
      these inputs existing); keep `useModelCatalogue` cache behavior (no remount churn).
- [x] Keep labels consistent with WS7's label/value tiers; do not introduce new color tokens.

## Expected behavior after the task

- Crew inspector shows collapsible groups; permissions collapsed with an enabled count.
- Capability chips are grouped from CAPS (git/shell/network present, code.review under Review)
  and adding/removing a capability still mutates the model and triggers validation.
- Crew rail reads `CREW · N agents`.

## Verification

Automated:
- `npm run typecheck`
- `npm run lint`
- `npm run build:ui`

Manual — `npm run dev`:
- [x] Groups collapse/expand; state survives tab switches.
- [x] Permission groups match `CAPS` (incl. `git.*`, `shell.execute`, `network.request`,
      `code.review` under Review); custom capabilities land in the fallback group.
- [x] Add/remove a capability and a custom capability; validator re-runs.
- [x] Both themes; rename/duplicate/delete agent flows still work.

Phase boundary (end of Phase B):
`npm run build && node --test dist/tests/integration/bus-api.test.js`.

## Cleanup

- Remove the old `CAN DO (N)` label and any now-unused styles.
- No new dependencies; changes only under `apps/mesh-dashboard/src/**`; no formatting-only diffs.
- Kill `npm run dev` processes when done.
