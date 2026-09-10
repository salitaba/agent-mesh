# Task 09 — WS9: Graph focus mode

- Run: `plan-20260910-designer-page-ux` · Baseline: `398331d37b4e51cb8a056008b4cb4f214503ad2e`
- Phase: D (P3) · Depends on: task 08 (Phase C complete) · Followed by: task 10 (key routing)
- Requirements: REQ-DSG-012 (review pt 21)

## Goal

Add a graph focus mode where the topology takes ≥70% of `#view`, the sidebar collapses via one
shell seam, and the validity verdict stays visible. Region hiding is CSS-only (no unmount) so
panel state — rename dialog, model catalogue, selection — survives.

## Dependencies

- Task 08 complete. Esc handling is finalized in task 10's single dispatch order; this task wires
  the toggle/state, not a second Esc handler.

## Files

- Modify: `apps/mesh-dashboard/src/shell.tsx` (one `focusMode` seam; sidebar collapse; clear on
  view change)
- Modify: `apps/mesh-dashboard/src/designer/Designer.tsx` (focus classes on crew/inspector/out
  regions; keep verdict chip visible)
- Modify: `apps/mesh-dashboard/src/designer/Topology.tsx` (focus-mode toggle in tools `:115-124`)
- Modify: `apps/mesh-dashboard/src/designer/designer.css` (focus-mode classes and ≥70% sizing)

## Constraints (verbatim, from the plan)

- WS9 focus mode: CSS hide, not unmount; verdict chip stays visible; Esc precedence defined once
  in WS10 order palette → focus → drawer/detail → local; clear focus on view change.

## Checklist

- [x] Add ONE `focusMode` boolean owned by shell (context or a UI-state flag in `shell.tsx`) so
      the sidebar can collapse; no second source of truth in Designer/Topology.
- [x] Toggle from the Topology tools (`:115-124`) with a clear pressed state
      (`aria-pressed`).
- [x] Hide Designer-owned crew/inspector/out regions with CSS classes, NOT unmount — remount
      resets rename state and the model catalogue (`CrewPanel.tsx:60-66`,
      `useModelCatalogue`). The graph must take ≥70% of `#view`.
- [x] Keep a verdict chip visible in focus mode (the "is it valid?" answer survives); reuse the
      canonical state source from task 03.
- [x] Do not route focus mode through the global modal drawer stack; sidebar collapse goes through
      the shell seam only.
- [x] Clear focus on view change (Shell does not unmount on view switch); do not leave focus mode
      active when returning to Designer.
- [x] Do not add Esc handling here: task 10 owns the single dispatch order
      (palette → focus → drawer/detail → local); expose the `focusMode` setter so task 10 can
      call it.
- [x] Preserve selection/panel state across enter/exit (no remount, no refetch).

## Expected behavior after the task

- Toggling focus mode collapses the sidebar via the shell seam and hides crew/inspector/output
  regions by CSS while the graph occupies ≥70% of `#view`.
- The verdict chip remains visible; exiting via the toggle restores the exact prior state
  (rename input content, model list, selected agent, wiring mode).
- Switching views while focused clears focus mode.

## Verification

Automated:
- `npm run typecheck`
- `npm run lint`
- `npm run build:ui`

Manual — `npm run dev`:
- [x] Enter focus from Topology; graph ≥70% of the view; verdict chip visible.
- [x] Rename dialog open / model catalogue loaded → enter and exit focus; state preserved, no
      refetch or reset.
- [x] Change view while focused → focus cleared on return.
- [x] Both themes; sidebar collapse does not orphan keyboard focus.

## Cleanup

- Remove any transitional inline styles; keep focus classes in `designer.css`/`styles.css`.
- No new dependencies; changes only under `apps/mesh-dashboard/src/**`; no formatting-only diffs.
- Kill `npm run dev` processes when done.
