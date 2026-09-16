# Capability-coverage validation — handoff

## State

- **Done, uncommitted:** the inert-approval fix.
  `packages/core/src/projections-artifact.ts` (`approvalPath` now reads the machine
  table for the *current* status instead of a hardcoded `APPROVABLE_TYPES` whitelist)
  and a new `tests/core/projections-artifact-approval.test.ts` (19 tests).
  Full suite 1155/1155. Mutation-checked: reinstating the whitelist fails 13.
- **Diagnosed, not fixed:** a mesh can boot clean and deadlock the first time a
  commit gate is reached, because no seat holds `git.commit`. Hit live: two binding
  one-commit gates unsatisfiable (`task-M2N2BZ720078fed68cf4`,
  `task-M2N22A0G0068bed871a4`).

## Done (2026-09-16, uncommitted)

`warnUncoveredCapabilities` in `packages/config/src/index.ts` (next to
`warnUnenforceableHardActions`), wired into `configWarnings` alongside it.

**Rule chosen (question 2, narrow):** some seat holds `repository.write` and no
seat holds `git.commit` -> one warning naming every writing seat. Silent on a
read-only mesh. **Severity (q3):** warning, precedent `shell.execute`.
**Location (q1):** config layer only -- the designer already funnels
`resolved.warnings` through the server into its live advisors
(`Designer.tsx:459`), so composing feedback came for free with no second
implementation to drift. **Human seat (q4): no.** The human is synthesized at
runtime with `capabilities: ["override"]` (`supervisor.ts:1111`) and never
declared in config, so it can never be the intended commit holder.

Tests: `tests/config/capability-coverage.test.ts`, 8 tests. Suite 1163/1163.
Mutation-checked: unwiring the call site fails 4 of 8.

Also fixed: the `designer-chat` harness fixture granted `repository.write` and
no `git.commit`, so four "validates clean" tests failed -- the check working as
intended on a fixture that modeled an unsatisfiable mesh. The lead seat now
holds `git.commit`, matching every shipped template.

## Follow-ups this surfaced (not done)

- `CAPABILITY_ALIASES` still has no alias to `git.commit` though
  `repository.merge -> git.merge` exists. Unchanged, still a plausible gap.
- Designer `CAPS` (`designer/model.ts:7`) has 15 entries vs 16 in
  `CAPABILITY_TOKENS` -- it is missing `request_review`. Real drift, unrelated
  to this work.
- Widening the rule (gates / `HARD_OP_CAPABILITY` derivation) is still open if
  the narrow rule proves too quiet.

## Why the current checks miss it


`validateCapabilityTokens` (`packages/config/src/index.ts:745`) proves every declared
token EXISTS. Nothing proves the capabilities the mission will REQUIRE are held by
anyone. Same class as the approval bug just fixed: validates fine, stalls at runtime.
`validateAuthorityTokens` (same file, mirrored) has the identical blind spot.

## Anchors (already paid for — don't rediscover)

- `packages/config/src/index.ts:745-767` — `validateCapabilityTokens`, returns
  `string[]` of ERRORS. Copy this shape for a coverage check.
- `packages/protocol/src/catalog.ts:533` — `HARD_OP_CAPABILITY`:
  `publish_artifact→repository.write`, `commit→git.commit`, `merge→git.merge`.
  This is the enforceable op→capability table; the natural source of "required".
- `packages/protocol/src/catalog.ts:485` — `CAPABILITY_TOKENS` (17 tokens).
- `packages/protocol/src/catalog.ts:568` — `CAPABILITY_ALIASES`. Note: NOTHING
  aliases to `git.commit`, though `repository.merge→git.merge` exists. Possible
  gap in its own right.
- `packages/protocol/src/catalog.ts:516` — `DEFAULT_HARD_CAPABILITIES`; note
  `shell.execute`/`network.request` have no `HARD_OP_CAPABILITY` entry and config
  load already warns about that. Precedent for a warn-not-error severity.
- `apps/mesh-dashboard/src/designer/model.ts:7` — `CAPS`, the designer's own list
  (duplicates `CAPABILITY_TOKENS`; check whether it drifts).
- `apps/mesh-dashboard/src/designer/model.ts:174,190,216` and
  `apps/mesh-cli/src/bench.ts:141` — shipped developer templates, all of which DO
  grant `git.commit`. The live mesh deviated from these.
- `apps/mesh-server/src/config-drift.ts:110` — a live seat's definition CANNOT be
  changed mid-mission; only `seat.spawn` applies live. Constrains any "fix it for
  the running mesh" affordance the designer might offer.

## Open design questions (decide before implementing)

1. **Where does the check live?**
   - `packages/config` — covers CLI + server + designer save, one implementation.
   - `apps/mesh-dashboard/src/designer` — live feedback while composing, but is a
     second implementation that can drift from the config one (see `CAPS` above).
   - Both, with the designer calling the shared config-layer function.
2. **What counts as "required"?** A mesh that never commits should not be forced to
   grant `git.commit`. Candidate rules, roughly increasing precision:
   - any seat holds `repository.write` but no seat holds `git.commit` → warn
     ("this mesh can write but can never land");
   - derive from acceptance criteria / task gates that name a commit;
   - derive from `HARD_OP_CAPABILITY` over ops the mesh's agents can actually emit.
3. **Severity.** Error (refuse boot) vs warning (boot, surface in designer)?
   Erroring would refuse meshes that are deliberately read-only.
4. **Does it belong on the human seat?** PM holds only `repository.read`; the human
   seat may be the intended commit holder in some designs.

## Don't re-derive

- `git.commit` is a genuine token; an invented one is already a hard error. The live
  failure was an omission, not a typo.
- Unknown-capability validation is errors, not warnings, and aliases normalize first.
