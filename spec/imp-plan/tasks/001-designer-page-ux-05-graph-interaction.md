# Task 05 — WS5: Graph interaction model

- Run: `plan-20260910-designer-page-ux` · Baseline: `398331d37b4e51cb8a056008b4cb4f214503ad2e`
- Phase: B (P1) · Depends on: Phase A tasks 01–04 complete
- Requirements: REQ-DSG-005 (review pts 4, 5, 20)

## Goal

Make edge deletion explicit and keyboard-safe while keeping direct manipulation, wire mode,
arrange, boot toggles and node inspection. Hover-only destructive deletion is removed.

## Dependencies

- Phase A (tasks 01–04) complete. This task is independent of the shell work and can run in
  parallel with task 06 (different files), but both belong to Phase B.

## Files

- Modify: `apps/mesh-dashboard/src/designer/Topology.tsx` (tools `:115-124`; edges `:138-156`;
  nodes/selection `:158-187`; key handler `:42-51`)
- Modify: `apps/mesh-dashboard/src/designer/designer.css` (edge styles `:133-142`; tool hint
  `:91-94`; selection dimming near `.tnode`/`.tedge` rules)
- Do NOT modify `Designer.tsx` (`toggleWire`/`onCut` wiring `:546-547` stays as-is).

## Constraints (verbatim, from the plan)

- WS5 edge delete: click-select edge keyed by `{src,tgt}` (never array index), explicit Cut action
  plus Delete/Backspace with input/textarea/select/contenteditable guards, keyboard-reachable
  path, aria-selected; remove hover `×`.

## Checklist

- [x] Keep direct manipulation and wire mode; rename the tool to "connect" with a clear on/off
      state (aria-pressed already at `:116`).
- [x] Replace the hover `×` delete (`:149-153`) with edge selection: clicking the hit path
      (`:147`) selects the edge, shows an inline "Cut wire" action and a selection highlight.
      Selection state stays LOCAL to `Topology` (nothing outside needs it) and is keyed by
      `{src,tgt}` — never an index into `links`, which is rebuilt each render
      (`Designer.tsx:236-239`).
- [x] Clear the selection when `wiring` changes or `current` changes.
- [x] Delete/Backspace cuts the selected edge. The key handler (or a dedicated listener) MUST
      ignore `input, textarea, select` and `contenteditable` targets — rename dialog
      (`CrewPanel.tsx:114`), bulk textareas (`:164`, `:186`), copy-path input
      (`Designer.tsx:609`) — so pressing Backspace while typing never cuts a wire.
- [x] Keyboard reachability: expose Cut on a focusable target or via the inspector when an edge
      is selected; put `aria-selected` on the selected edge; do not strand keyboard users.
- [x] Selection focus: when `current` is set (`:167`), highlight incident edges (both directions
      from `links`) and dim unrelated edges/nodes.
- [x] Keep ONE persistent affordance line (drag / inspect / edge-select) replacing the current
      hint (`:121`); tooltips-only would regress discoverability. Keep arrange (`:119`), boot
      (`:177-182`), counts (`:123`), and keyboard node activation (`:170`) unchanged.
- [x] Preserve `role="application"` on the canvas (`:125`) and the existing aria labels
      (`:126`, `:150`, `:169`, `:180`); no modal confirm for cut (undo exists, `Designer.tsx:354`).

## Expected behavior after the task

- Hovering an edge no longer shows a destructive `×`; clicking selects it, Cut/Delete removes it.
- Typing in any text field and pressing Backspace/Delete never cuts a wire.
- A selected node highlights its paths and dims unrelated ones; selected edges are announced
  (`aria-selected`).
- Wire/arrange/boot/Esc and node activation behave exactly as before.

## Verification

Automated:
- `npm run typecheck`
- `npm run lint`
- `npm run build:ui`

Manual — `npm run dev`:
- [x] Select a node: incident edges highlight, unrelated edges/nodes dim.
- [x] Click an edge: Cut action visible, `aria-selected` set; Cut and Delete/Backspace remove it;
      undo restores it.
- [x] Focus the rename input / bulk capability textarea / copy-path input and press Backspace —
      no wire is cut.
- [x] Keyboard-only: tab to the edge/Cut affordance and cut a wire.
- [x] Wire mode, arrange, boot toggle, and Esc cancel still work; input guards intact.

## Cleanup

- Remove `.edel` hover-`×` styles and markup; keep unused-selector count at zero.
- No new dependencies; changes only under `apps/mesh-dashboard/src/**`; no formatting-only diffs.
- Kill `npm run dev` processes when done.
