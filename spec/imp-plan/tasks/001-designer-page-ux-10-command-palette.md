# Task 10 — WS10: Command palette and key routing

- Run: `plan-20260910-designer-page-ux` · Baseline: `398331d37b4e51cb8a056008b4cb4f214503ad2e`
- Phase: D (P3) · Depends on: tasks 01–09 complete (last task; closes Phase D)
- Requirements: REQ-DSG-013 (review pt 22)

## Goal

Add a ⌘K/Ctrl+K command palette (global navigation + Designer-scoped commands registered only
while Designer is mounted) and centralize key routing so numbers, Esc, and existing shortcuts do
not leak while the palette is open. This is the one new seam (`src/commands.ts`), approved by the
user at checkpoint 2.

## Dependencies

- Task 09 complete (focus mode must exist before the Esc dispatch order can include it). All Esc
  owners exist now: shell drawer/detail (`shell.tsx:132-135`), Designer template menu
  (`Designer.tsx:164`), Topology wire cancel (`Topology.tsx:44`).

## Files

- Create: `apps/mesh-dashboard/src/commands.ts` (small registry: register/unregister/list; no bus)
- Modify: `apps/mesh-dashboard/src/shell.tsx` (key handler `:121-151`; palette host/markup; global
  commands)
- Modify: `apps/mesh-dashboard/src/designer/Designer.tsx` (register scoped commands while mounted;
  consume pending "jump to agent" selection on mount)
- Modify: `apps/mesh-dashboard/src/designer/Topology.tsx` (connect command entry + persistent hint
  `:121`)
- Modify: `apps/mesh-dashboard/src/styles.css` (palette styles; both themes)

## Constraints (verbatim, from the plan)

- WS10 key routing lives in `shell.tsx:121-151` (bubble phase) — palette must be checked first;
  single Esc dispatch order; Designer-scoped commands registered only while Designer is mounted
  via new `apps/mesh-dashboard/src/commands.ts`; palette lists only non-destructive commands and
  must not bypass existing confirms; global commands navigate `KEY_VIEWS`.
- Hotkeys 1..N are `KEY_VIEWS` view shortcuts (`shell.tsx:30`) — restyle only with the existing
  `<kbd>` chip (`styles.css:824`), never remove or renumber; INV-DSG-002.
- Draft storage key `mesh-designer-draft-v2` and payload shape stay backward compatible (adding
  fields allowed, renaming not); INV-DSG-004.
- Key routing dispatch order (single Esc): palette → focus mode → existing drawer/detail stack
  (`shell.tsx:132-135`) → local handlers (template menu `Designer.tsx:164`, wire cancel
  `Topology.tsx:44`); one Esc closes exactly one layer.

## Checklist

- [x] Create `commands.ts`: a minimal registry of `{ id, label, keywords, run, scope }` with
      `register(scope, commands)` / `unregister(scope)` and a `list()` for the palette. No global
      bus, no cross-view hidden state mutation.
- [x] `shell.tsx:121-151` (bubble phase) checks the palette FIRST: while open, `1..9`, `r`, `p`,
      `?`, `/` must not leak through (consume them or use a capture listener that stops
      propagation). With the palette closed, number-key view switching still works
      (INV-DSG-002).
- [x] ⌘K / Ctrl+K opens/closes; palette is keyboard-only, with focus handling and
      `aria-modal`/listbox semantics consistent with existing components.
- [x] Single Esc dispatch order implemented once via a shell key table or `defaultPrevented`
      checks: palette → focus mode → drawer/detail stack → local handlers. One Esc closes one
      layer; do not add duplicate Esc handling for these layers.
- [x] Global commands: navigate views from `KEY_VIEWS` (`shell.tsx:29`), open help, search agent.
- [x] Designer-scoped commands registered only while Designer is mounted, via `commands.ts`:
      add agent (`Designer.tsx:271`), connect agents, run validation (`:62`), open agent (`:243`),
      show errors. When Designer is unmounted they are absent/disabled; no cross-view state
      mutation.
- [x] "Jump to agent" navigates to Designer and passes a pending selection consumed on mount
      (module-level pending id — not a bus, not localStorage).
- [x] Palette lists only non-destructive commands; existing confirms (reset `requestReplace`
      `Designer.tsx:378-387`, `:633`) are never bypassed; no new destructive-confirm rule.
- [x] After "connect agents": close the palette, enter wire mode, and show the persistent hint
      (`Topology.tsx:121`) so the user is not stranded.
- [x] Palette styling works in both themes; no new dependencies.

## Expected behavior after the task

- ⌘K/Ctrl+K toggles a palette; keys are suppressed while open and work normally when closed.
- Designer commands appear only on the Designer view; global commands always navigate.
- One Esc closes one layer in the defined order; focus mode exits before the drawer stack closes.
- "connect agents" lands the user in wire mode with the hint visible.

## Verification

Automated:
- `npm run typecheck`
- `npm run lint`
- `npm run build:ui`

Manual — `npm run dev`:
- [x] ⌘K/Ctrl+K opens/closes; hotkeys 1..N suppressed while open, working when closed
      (INV-DSG-002).
- [x] Designer-scoped commands absent when Designer is unmounted; present on Designer.
- [x] "connect agents" does not strand the user (palette closed, wire mode + hint).
- [x] Single Esc closes one layer: palette → focus mode → drawer/detail → local; no multi-close.
- [x] Existing confirms (reset) still run; palette never bypasses them; both themes.

Phase boundary (end of Phase D):
`npm run build && node --test dist/tests/integration/bus-api.test.js`.

## Cleanup

- Remove any temporary global key listeners; only the shell handler remains authoritative.
- No new dependencies; changes only under `apps/mesh-dashboard/src/**`; no formatting-only diffs.
- Kill `npm run dev` processes when done.
