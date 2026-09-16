# Mesh satisfiability validation — A2/B1/C1 shipped, rest still design

## The reframe

"Every situation a mesh can't work" is not decidable at config load: convergence
depends on the goal text, the models, and runtime behavior. What IS decidable is
**structural unsatisfiability** — the mesh provably cannot perform an action its
own config commits it to. `warnUncoveredCapabilities` (shipped) is one member of
that family. This note enumerates the rest.

Test of membership: *can a static reader prove the mesh will stall, without
knowing anything about the goal or the models?* If no, it does not belong here.

## Validation surface that already exists (do not re-implement)

**Config errors** — `at least one agent`; `project.id` pattern;
`startup.activate` / `policies.communication` (both directions) / `budgets.agent`
/ policy-rule actor all reference-checked against known agents;
`validateInterestExpressions` (event types canonical);
`validateAuthorityTokens`, `validateCapabilityTokens` (unknown tokens, incl.
`hard_actions`).

**Config warnings** — derived `project.id`; `validateTransitionGateActors`;
`warnUnenforceableHardActions`; `warnUncoveredCapabilities` (new).

**Designer-only advisors** (`Designer.tsx` ~line 476, NOT in config, so a CLI or
server boot never sees them): agent wired to nobody; nobody boots; crew budgets
exceed the mission cap; no goal.

**Server** — `validateTransitionGates`, surfaced as proposal `problems`.

## Candidate checks

Grouped; severity is a proposal, see the open decision below.

### A. Op/capability coverage — generalize the shipped check
- **A1 write-without-commit.** DONE.
- **A2 merge gate, no `git.merge` holder.** DONE (`warnUnmergeableGates`).
  Keyed off a transition gate key ending `.merge` (the real vocabulary is
  `patch.merge`), because the artifact state machine demands `git.merge` for
  any transition to MERGED (`policy-engine`, `to === "MERGED"`). — warn
- **A3 nothing can be produced.** No seat holds `repository.write` but the mesh
  declares artifact transition gates. — warn
- **A4 the general form.** For each op named by a gate, require some seat to
  hold `HARD_OP_CAPABILITY[op]`. Subsumes A1-A3. This is the option deferred on
  2026-09-16 in favour of starting narrow; revisit only once the narrow rule has
  had time to prove too quiet.

### B. Boot / liveness
- **B1 nobody boots.** DONE (`warnNoStartupActivation`), as a WARNING.
  Correction to the original framing: it is NOT "nothing ever happens". Boot
  registers every configured agent regardless of `startup.activate`, so
  `stallDriver()`'s last resort ("any live agent at all") eventually nudges
  someone. What is lost is intent, not liveness — the first seat to move is a
  watchdog's guess. That is why it is not an error. — warn

### C. Reachability
- **C1 agent wired to nobody.** DONE (`warnUnreachableAgents`), promoted to
  config and DELETED from `Designer.tsx`. Connectivity is read in both
  directions and from both sides of the policy, so a mesh declaring only
  `may_be_contacted_by` is not falsely accused. — warn
- **C2 unanswerable request.** A `may_contact` B, B cannot contact A. A request
  review/research can be sent and never replied to. Believed unchecked
  anywhere. — warn
- **C3 no escalation path.** Nothing can reach the human seat at the ceiling.
  Needs a read of the escalation ceiling logic first (`index.ts:584` note).

### D. Event reachability
- **D1 dead interest.** An interest is canonical but no configured agent or
  runtime path can ever emit it — the seat never wakes. Canonicality is checked;
  reachability is not. Hardest of the set: the emit surface must be enumerated
  before this can be proven, so it may not be worth it.

### E. Grants that do nothing
- **E1 delegation theatre.** `delegation.allow: true` with `max_workers: 0` or
  `max_depth: 0`. The grant reads as enabled and does nothing. — warn
- **E2 orphan authority.** An authority token no policy rule or gate consumes.
  Noisy; probably info at best.

### F. Budget
- **F1 crew over mission cap.** Designer-only info today. Not strictly
  unsatisfiable (someone just stops early) — keep as info, but move to config so
  CLI/server see it.

## Open decisions (these gate the whole shape)

1. **Severity policy.** RESOLVED, and not as proposed. All three shipped as
   warnings; B1 was NOT promoted to error. The codebase already had a
   consistent, documented stance that overrode the proposal: gate-actor
   problems are "reported, not fatal"; the commit check is a warning because
   "erroring would refuse meshes that boot and finish today". Erroring on B1
   would have hard-failed every config without `startup.activate`. Original
   proposal, kept for the record: Six-plus new warnings on every load will train operators
   to ignore the block — the same blindness that let the commit gap ship. Need a
   rule, not a per-check coin flip. Proposal: *error only when the mesh cannot
   act at all* (A3, B1); *warn when a specific flow stalls* (A1, A2, C1, C2, E1);
   *info for the merely surprising* (F1, E2).
2. **Who owns the checks.** RESOLVED: "wired to nobody" and "nobody boots" are
   deleted from `Designer.tsx` and arrive back through `serverWarnings`, with
   a comment there saying not to re-add them. `tabOfError` routing was checked:
   B1/C1 land on `crew`, A2 on `policy`. F1 and "no goal" stay designer-only.
   Original note: The designer's advisor list deliberately holds only
   "checks the server won't flag". Moving B1/C1/F1 into config means DELETING
   them from `Designer.tsx` in the same change, or every operator sees each twice.
3. **Fixture fallout — smaller than feared.** Actual blast radius was 4 tests,
   all in `designer-chat`, all B1, all one fixture missing `startup.activate`.
   Fixed the fixture (not the check), matching the precedent comment already
   in that file from the A1 change. A 5th failure (`opencode-stream`) was a
   pre-existing parallel-run flake — it passes in isolation and is unrelated.
   Suite: 1174 pass / 0 fail. Original note: One new check broke 4 existing tests.
   A family will break many more, and each break is a judgment call: is the
   fixture wrong (fix it, as with `designer-chat`) or is the check too eager
   (soften it)? This is most of the work, and it cannot be batched blindly.
4. **Order.** A2 + B1 + C1 are cheap and independently valuable. C2 and D1 need
   real research first. Suggest shipping the cheap three, living with them, then
   deciding on A4.

## Anchors

- `packages/config/src/index.ts:376-500` — the validation aggregation block;
  errors -> `ConfigError`, warnings -> `configWarnings` -> `resolved.warnings`.
- `packages/config/src/index.ts:696-870` — the six `validate*`/`warn*` functions.
  Copy their shape: pure, `AgentDefinition[]` in, `string[]` out.
- `apps/mesh-dashboard/src/designer/Designer.tsx:459` — server warnings already
  flow into the designer's live advisors. Anything added at the config layer
  shows up in the designer for free.
- `apps/mesh-dashboard/src/designer/Designer.tsx:470-480` — the designer-only
  advisors and the comment explaining the deliberate split.
- `tests/config/capability-coverage.test.ts` — the pattern for testing these
  through `resolveConfig` rather than by calling the function directly; it
  catches wiring regressions too (mutation-checked).

## Live finding from the shipped checks (2026-09-16)

Resolving all five `examples/*/mesh.yaml` through the new checks: four are
clean, one is not.

- **`examples/greenfield/mesh.yaml` trips A2.** It declares
  `patch.merge: { requires: [architect.approve] }` but no seat holds
  `git.merge`. The approval can be collected and the MERGED transition is
  refused anyway. This is a real defect in a shipped example, found by the
  check on its first run.
- **Not fixed here, because the fix is a product decision**, not a mechanical
  one: either grant `git.merge` to the architect, or drop the gate if
  greenfield is meant to demonstrate a mesh that merges outside itself. Same
  class of call as the skill-panel `git.commit` grant.

That four of five examples are silent is the answer to open decision #1's
worry about warning fatigue: these checks are quiet on correct meshes.

## Still not implemented

A3, A4 (the general `HARD_OP_CAPABILITY` derivation), C2, C3, D1, E1, E2, F1.
A4 remains deliberately deferred. C2 (unanswerable request) is still the one
most likely to find something live — `warnUnreachableAgents` now computes the
edge data it would need.
