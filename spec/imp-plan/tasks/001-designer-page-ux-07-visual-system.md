# Task 07 — WS7: Visual system — borders and typography

- Run: `plan-20260910-designer-page-ux` · Baseline: `398331d37b4e51cb8a056008b4cb4f214503ad2e`
- Phase: C (P2) · Depends on: Phase A tasks 01–04 and Phase B tasks 05–06 complete
- Requirements: REQ-DSG-009 (review pts 14, 15)

## Goal

Flatten nested-container borders using light-safe token levels and introduce concrete typography
tokens, replacing all inline `fontSize` sites in the touched Designer files. This is the visual
base task; task 08 (responsive) builds on it.

## Dependencies

- All previous tasks complete. WS7 restyles `styles.css`/`designer.css`, which tasks 01–06 also
  touched; land those first to avoid conflicting hunks.

## Files

- Modify: `apps/mesh-dashboard/src/styles.css` (`:root` tokens `:2-54`; light overrides `:55-78`;
  keep `.card` `:199` unchanged)
- Modify: `apps/mesh-dashboard/src/designer/designer.css` (named boxes `.save-review` `:193`,
  `.save-done` `:195`, `.ms-trule` `:169`, `.gate-card` `:170`, `.rename-box` `:177`)
- Modify: `apps/mesh-dashboard/src/designer/Designer.tsx` (inline fontSizes `:610`, `:615`, `:616`)
- Modify: `apps/mesh-dashboard/src/designer/chrome.tsx` (inline fontSizes `:120`, `:124`, `:126`, `:187`)
- Modify: `apps/mesh-dashboard/src/designer/panels/CrewPanel.tsx` (inline fontSizes `:115`, `:194`, `:222`)
- Modify: `apps/mesh-dashboard/src/designer/panels/PolicyPanel.tsx` (inline fontSizes `:43`, `:72`, `:76`, `:93`;
  WS7 owns these per plan §7 even though the §8 summary map lists only the other panels)

## Constraints (verbatim, from the plan)

- No new dependencies; both themes still render; no changes outside
  `apps/mesh-dashboard/src/**` (plus these spec task files).

## Checklist

- [x] Flatten nesting only in the named `designer.css` boxes above; use the light-safe levels
      `--panel-2`/`--sunken` (`styles.css:75`) plus spacing for grouping. Keep `--line` hairlines
      where levels collapse. Do NOT change the shared `.card` definition (`styles.css:199`) — it
      stays for top-level regions and is used app-wide.
- [x] Add named typography tokens in `:root` and use them: page title (18/600), section (12/600
      caps), label (11/600), value (13/400), metadata (11/400 muted). No typography tokens exist
      today; names are final in implementation but must be tokens, not literals.
- [x] Replace ALL inline `fontSize` sites in the touched files listed above with the new tokens;
      remove now-unused inline styles. After the change, a grep for `fontSize` in the touched
      files should return only intentional cases (target: zero in those files).
- [x] Gate both themes: light nested fills are `#ffffff` today (`styles.css:56`, `:74`) — verify
      level cues still read without relying on borders alone.
- [x] Do not restyle `.status-strip`, drawer internals, or unrelated views.

## Expected behavior after the task

- Nested boxes show a clear hierarchy through background levels/spacing rather than stacked
  borders, in both themes.
- Typography follows named tiers; no inline font sizes remain in the touched files.
- Layout/behavior unchanged; no markup semantics change.

## Verification

Automated:
- `npm run typecheck`
- `npm run lint`
- `npm run build:ui`

Manual — `npm run dev`:
- [x] Light and dark theme pass over the Designer page and shared shell.
- [x] Nested boxes (`.save-review`, `.save-done`, `.ms-trule`, `.gate-card`, `.rename-box`) have
      visible level cues, not border-on-border. (`.save-done` verified by rule inspection only —
      not rendered during the check; it keeps `.card`'s hairline + ok-tinted fill.)
- [x] No inline `fontSize` remains in the listed files (grep as a spot check).
- [x] No visual regression in unrelated views (Overview, Cost, Steps).

## Cleanup

- Delete dead inline style objects and any superseded border rules.
- No new dependencies; no formatting-only diffs; kill `npm run dev` processes when done.
