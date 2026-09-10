# Task 04 — WS4: Bottom bar and action hierarchy

- Run: `plan-20260910-designer-page-ux` · Baseline: `398331d37b4e51cb8a056008b4cb4f214503ad2e`
- Phase: A (P0) · Depends on: task 03 (SourceState) · Phase boundary: this task closes Phase A
- Requirements: REQ-DSG-007 (review pts 8, 18)

## Goal

Give the sticky workbench bar a clear hierarchy: environment/state on the left (WS3), one primary
save action, secondary file actions, and a separated destructive reset. Copy states that saving
writes a file and the mesh must restart to apply it.

## Dependencies

- Task 03 delivers the SourceState props and owns the state zone/`wb-bar-mid`. This task owns the
  ACTION zone only; explicit prop boundary, no shared state mutation.

## Files

- Modify: `apps/mesh-dashboard/src/designer/Designer.tsx` (`wb-bar` action zone `:618-635`;
  `saveLabel` `:462`; subtitle copy `:488-491`; save flow `:429-456`)
- Modify: `apps/mesh-dashboard/src/designer/chrome.tsx` (`ReviewCard` copy/action `:116-133`)
- Modify: `apps/mesh-dashboard/src/designer/designer.css` (`.wb-bar*` `:207-218`)

## Constraints (verbatim, from the plan)

- Save is a file write only; restart-to-apply (`apps/mesh-server/src/index.ts:1136`). Never label
  anything "Apply changes". Primary copy: "Save mesh"/"Save running config"/"Save copy" plus
  "writes mesh.yaml · restart to apply".
- INV-DSG-001: every existing action remains reachable, including ApprovalDrawer (sole call site
  `shell.tsx:299`) — do not orphan it.

## Checklist

- [x] Own the `wb-bar` ACTION zone (`:618-635`) only. Consume SourceState from task 03 as props;
      leave `wb-bar-mid` (state zone) to WS3. No shared state mutation across the boundary.
- [x] One primary button: save with `variant="primary"` (`:634`). Secondary reload/import and the
      template menu stay `small`/ghost; destructive `reset…` (`:633`) is visually separated and
      keeps the existing confirm path `requestReplace("template", TEMPLATES[1].make())`.
- [x] Update `saveLabel` (`:462`) to `"Save mesh"` / `"Save running config"` / `"Save copy"`;
      update the subtitle (`:488-491`) so it never implies hot-apply. No "Apply changes" string.
- [x] Keep a persistent restart-to-apply affordance next to the primary action: "writes mesh.yaml
      · restart to apply". Keep the running/copy radios + copy path input (`:605-611`) and the
      stale-running guard (`:433-436`) with the `ReviewCard` warning (`chrome.tsx:121`).
- [x] `ReviewCard` (`chrome.tsx:116-133`): running = overwrite the running file + restart to
      apply; copy = writes a new file, live mesh untouched. Keep the primary save button and
      cancel behavior; keep save blocked while validation errors exist (`blocked` prop).
- [x] INV-DSG-001: reload running, import, template, reset, save all remain reachable and keep
      their current behavior/targeting; undo semantics (`:354`) unchanged.

## Expected behavior after the task

- The bar reads left-to-right: target/state → primary save → secondary file actions → destructive
  reset (separated). Buttons keep roles/labels and are keyboard reachable.
- Save copy shows `Save copy`; running-target shows `Save running config`; both surface
  restart-to-apply copy.
- Reset still asks for confirmation; no destructive action bypasses an existing confirm.

## Verification

Automated:
- `npm run typecheck`
- `npm run lint`
- `npm run build:ui`

Manual — `npm run dev`:
- [x] Running-target: label `Save running config`; after save the state/diff updates immediately.
- [x] Copy-target: label `Save copy`; result says the runtime is unchanged.
- [x] Restart-to-apply copy visible next to the primary action in both target modes.
- [ ] Reset confirm appears; template/reload/import still work; validation blocks save.
- [ ] Both themes.

Phase boundary (end of Phase A):
`npm run build && node --test dist/tests/integration/bus-api.test.js`.

## Cleanup

- Remove superseded bar CSS; keep `.ms-tpl` menu styles used by the template action.
- No new dependencies; changes only under `apps/mesh-dashboard/src/**`; no formatting-only diffs.
- Kill `npm run dev` processes when done.
