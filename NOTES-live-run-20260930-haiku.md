# cronlite live run on Haiku — 2026-09-30: what it found, and what was fixed

Status: **FIXED** on branch `claude/exciting-gates-n75s1z` (one commit per finding or theme over `e9a361b`, each
with its own regression test). One live mission, two rounds, one crash; every finding below was either reproduced
with no model or traced to a line. Open items, and the things a fix deliberately does not do, are in §6.

Requested: *"run a real mesh with a real goal with the haiku model and monitor it and find bugs of system and
check quality of output of mesh"*, then *"fix all problems"*.

Subject: a five-seat mesh (`pm`, `architect`, `tech-lead`, `developer`, `qa`) on `claude-haiku-4-5`, building
`cronlite` — a dependency-free Node library and CLI for 5-field cron expressions — from a written SPEC, six
mandatory acceptance criteria, `max_active_agents: 3`, a low-contact bus (`vocabulary: contracts`,
`commitments.ttl_ms 1800000` + `by_type`, `delivery.classes` with `coalesce_ms: 5000`, `attention_tokens 200000`),
seat budgets 250k–800k, mission 3M. **All timestamps are UTC.** The mesh config and workspace lived outside
the repo; everything needed to repeat the run is in §1 and §7.

---

## 0. Disposition

| # | Finding | Now | Where it is pinned |
|---|---|---|---|
| B1 | A task carrying the `implementation.gate` marker can never be claimed: the seat is told it can, `claim_task` then refuses a capability nobody can hold | **fixed** — `claimTask` and the `task.claimed` reducer skip the marker, as the briefing's list already did | `tests/core/coord-completion-gate.test.ts` |
| B2 | A seat with a shell bypasses `git.merge` and the `patch.merge` gate (`cd main && git merge`, `git push -f origin …:main`) | **fixed at the text level** — git in the product checkout may only read; `git push` needs `git.merge`. Filesystem writes are **not** gated (§6) | `tests/agent-runtime/landing-gate.test.ts` |
| B3 | `accrue` mail wakes a seat when the turn it arrived during ends (docs say "never") | **fixed** — `defersMail` covers the post-turn retry, the third site that did not | `tests/core/delivery-classes.test.ts` |
| B4 | `ifUnanswered.afterMs` shorter than the ask can be answered: the default stands as fact | **fixed** — refused below a floor; new key `bus.commitments.min_default_ms` | `tests/policy/default-answer.test.ts` |
| B5 | Seat prompts (`.mesh/agents/*`) committed into the product repo | **fixed** — `.mesh/` in `info/exclude`; `git add -A` then unstage `.mesh` | `tests/artifact-store/runtime-dir-exclude.test.ts` |
| B6 | Run report says "claimed without tool use" of criteria later verified | **fixed** — `every`, not `some` | `tests/core/run-report-criteria.test.ts` |
| B7 | Verification gate ignores reading the artifact (`mesh_artifact_read`), counts a bare `ls` | **fixed** — a read of an artifact counts as checking | `tests/core/verification-gate-live.test.ts`, `tests/policy/termination.test.ts` |
| B8 | 16 of 28 `artifact.transition` events were no-ops, none said `from` | **fixed** — recorded only when the artifact moved, with `from` | `tests/core/transition-audit.test.ts` |
| B9 | `actorId: "human"` on events no human performed | **fixed** — `termination-manager`; `requirement.satisfied` is the seat whose evidence it records | `tests/core/event-actors.test.ts` |
| B10 | An owner may approve its own artifact to FINAL when no peer holds the authority | **visibility only** — policy unchanged; the op result carries a caveat and the run report flags `selfApproved` | `tests/policy/self-approval-visibility.test.ts` |
| B11 | "the server process may have crashed" shown for a normal end-of-mission teardown; `goal_active` unphrased in the run report | **fixed** — deliberate stops drop the hint; stopped/paused/never-started missions are phrased | `tests/core/shutdown-casualty.test.ts`, `tests/core/turn-tracker-live.test.ts`, `tests/core/run-report-stopped.test.ts` |
| B12 | `status.progress` is `null` after a restore (a 6/6 goal reads 0%) | **fixed** — rebuilt from the criteria on import | `tests/core/state.test.ts` |
| B13 | `npm ci` fails on a clean checkout (lockfile names `runtime-opencode`, lacks `runtime-claude`) | **fixed**, and a test keeps the lockfile and the workspaces in step | `tests/build/lockfile-workspaces.test.ts` |
| B14 | Contract shapes are not learnable: `artifactId` vs `artifact`; replies "settled but carried no answer" | **fixed** — both names accepted; the ask's own line says which keys count as the answer | `tests/protocol/contracts.test.ts` |
| B15 | Boot banner says `mesh 'mesh'`; `turn-audit.jsonl` is not JSONL | banner **fixed** (uses the mesh id); the file's format is **documented, not changed** (§6) | — / `docs/runtime.md` |
| B16 | `request_review` accepts the artifact's owner as the settling reviewer | **fixed** — one predicate, `mayReviewArtifact`, shared with the briefing | `tests/policy/verdict-reachability.test.ts` |
| B17 | `review.reviewer-cannot-settle` every round: the briefing never says who can settle | **fixed** — the artifact's own briefing line names them (`settlers`) | `tests/core/context-settlers.test.ts` |
| B18 | Re-versioning a MERGED patch resets it to DRAFT | **by design**, now documented: a new version is unreviewed content | `docs/protocol.md` |
| B19 | The commit step `merge` demands creates a new version and voids the approval | **fixed by guidance, not by changing the versioning** — a caveat at `request_review`, the advisory and the refusal say it, the role prompt orders lease and commit before `PATCH_READY` | `tests/integration/commit-before-review.test.ts` |
| B20 | An approval wakes nobody who can act on it (the owner listens for rejections only) | **fixed** — the owner is woken when somebody else's verdict moves its artifact | `tests/policy/owner-verdict-notice.test.ts` |
| B21 | A crash leaks budget reservations that replay as live | **fixed** — boot releases every open hold (released, not consumed) | `tests/core/crash-reservations.test.ts` |
| B22 | After a *selective* reopen the mission can never complete (7/7 evidenced, goal ACTIVE) | **fixed** — "current round" is per criterion (`withdrawnAt`); the watchdog diagnoses with the same predicate | `tests/integration/reopen-selective.test.ts`, `tests/policy/termination.test.ts` |
| B23 | Seat CLIs survive a host SIGKILL and keep spending | **fixed for what can be fixed** — the next process reaps them (Linux); their spend is stopped, not recovered (§6) | `tests/agent-runtime/orphan-seats.test.ts` |
| env | The SDK loads every filesystem settings source; a mesh started inside another Claude session hands its `CLAUDE_EFFORT`, session id and artifact plumbing to every seat | **warned at boot + a knob**, `mesh.runtime.isolate_host: true`, off by default | `tests/agent-runtime/host-isolation.test.ts`, `tests/server/host-isolation-boot.test.ts` |

What each of these does, and why, is in `docs/runtime.md`, `docs/protocol.md` and `docs/configuration.md`; the
commit messages carry the evidence.

---

## 1. The run

| Phase | What | Result |
|---|---|---|
| Run 1 | `mesh run` on the mission, five Haiku seats, clean environment | goal met in **11 min**, 36 turns, 582k billed tokens (≈ $2.56) |
| Run 2 | an operator **reopen** with a factual defect report | the fix was right in 4 min; then 20 min of delivery and recording trouble (B19, B20, B22) |
| Crash test | `kill -9` the host mid-turn, restart | the log was intact; two accounting defects (B21, B23) |
| Shutdown | Ctrl-C the host | clean, no orphans |

Whole session: 86 turns, 1.20M billed tokens, ≈ $5.6 at Haiku list prices (an estimate, not a bill: fresh and
cache-write input at 1.25× input, output at $5/M, cache reads at $0.10/M). Cache reads were 32.3M tokens, 27×
the billed figure, because budgets bill at `cache_read_weight: 0`. The model was honoured on every turn (86 of 86
agent-ledger `budget.consumed` events report `claude-haiku-4-5-20251001`).

The seats ran under an environment **allowlist** (HOME, PATH, proxy, CA bundle) because the launching shell was
itself a Claude Code session exporting `CLAUDE_EFFORT=max`, `MAX_THINKING_TOKENS=31999`,
`CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_ARTIFACT_*`, and the adapter passes its whole environment to every seat. The
size of that effect on a run that was *not* scrubbed was never measured.

## 2. Output quality

An oracle was written from `SPEC.md` **before any mesh output was read**: a brute-force reference plus nine test
categories (3,049 checks). It was validated first: it scores a known-good product 100% and caught 3 of 3 planted
bugs (day-of-month/day-of-week AND, a non-strict "after", Sunday = 7 rejected).

| Product | Raw | Stratified\* | Own tests |
|---|---|---|---|
| v1 (run 1) | 1551/2257 = 68.7% | **3028/3034 = 99.8%** | 39/39 |
| v2 (after the operator's report) | **3049/3049 = 100%** | **3034/3034 = 100%** | 53/53 |

\*The raw score is dominated by one thing: v1 rejected `*` as a list item (`*,5`), which the spec allows and the
oracle's generator over-produces. Stratified = no `*` list items.

- **The scheduling logic was excellent**: `nextRun`/`nextRuns`/`matches` had 0 mismatches against the reference over
  about 2,900 comparisons, including the subtle cases (the OR day rule, Sunday as 7, leap day, strictly-after,
  impossible dates). The CLI passed 23/23.
- **The real v1 defect was parser leniency**: 6 of 42 spec-mandated rejections were accepted (`1.5`, `0x10`, `+5`,
  `1-2-3`, `15W`, `5#2`). The cause is visible in the source: `parseInt(x, 10)` plus an `isNaN` guard at every call
  site. Error-message text named the field in about half the cases; v2 is 74/76.
- **The rework was the best thing the mesh did.** Given a customer-style report, the developer fixed all three
  defect groups, added 14 regression tests and broke nothing.
- **QA's report was real but shallow, and overclaimed.** Eight CLI probes, an import check, one day-rule check and
  the developer's own suite, then about 60 checkmarks and "no blockers / fully meets spec" while 6 mandated
  rejections failed. It was not fabricated (the quoted message is in the source), but "error messages name the field
  and value" was false.
- **README**: accurate and well organized, with two verifiable errors (`0 0 13 * 5` called "noon" — it is midnight —
  and `nextRun` typed `Date | null` though no path returns null).

## 3. What worked (so the list above is read in proportion)

- The **verification gate** did real work: 9 of 19 criterion acceptances landed `ASSERTED` (a turn with no tool
  call) and did not count; the false "merged" claim in run 2 was caught this way.
- **Independent QA caught the false claim**: when the developer reported "MERGED" for code that was not on `main`,
  QA's own test run reported `DEFECTS_FOUND` and issued a `BLOCK`.
- Policy refusals were correct and *instructive* (`merge.requires-merge-op`, `self-approval`,
  `mandatory-evidence-not-submitted`, `review.reviewer-cannot-settle` naming who can).
- **Crash recovery of the log**: after `kill -9` mid-turn there were 0 duplicate sequence numbers, 0 gaps, 0 corrupt
  lines; sessions restored; only seats with open work were woken; no duplicate startup kickoff.
- The stall watchdog's circuit breaker (3 nudges, then escalate) bounded each idle cycle to about 29k tokens.
- The end-of-run report independently flagged `Implement cronlite library and CLI — never picked up`.
- Earlier notes' bugs that did **not** recur: no `turn.discarded reason=no_ops`, and a bare `transition → MERGED` was
  refused.

Cost of the chatter over the session: **60 of 86 turns (70%, 569k tokens, 47% of spend) changed no durable state**;
33 turns (346k) were woken by an `INFORM`. That is an upper bound on waste, not an exact figure. B3 (accrue wakes,
8.6% of spend by itself) and B20 (the owner woken on the verdict) are the two fixes that touch it directly.

## 4. The fixes, by theme

**Recording and attribution** (B6, B8, B9, B10, B12, B15): the log and the run report now say what happened.
Transitions appear only when something moved, and say from where; runtime acts carry `termination-manager`,
`recovery-manager` or `system`, never `human`; an artifact approved only by its author is flagged; a criterion that
was later verified is not reported as unverified; a restored mesh reports its progress.

**The work path** (B1, B2, B16, B17, B19, B20): a gate-marked task can be claimed; a seat's shell cannot land work on
`main`; the artifact's owner is never offered as the reviewer who settles it, and every seat is told on the artifact's
own line who can; commit comes before review and the cost of the other order is said where it can still be avoided;
the owner hears when someone else's verdict moves its work.

**Completion** (B7, B22): reading the evidence counts as checking it; a selective reopen withdraws the criteria it
names and no others, so the mission can finish. `criterionSatisfied` is the one predicate behind the termination
verdict, the criterion-removal guard and the watchdog's diagnosis.

**Crashes** (B11, B21, B23): boot releases the holds a dead turn left and records the turn as `interrupted` with no
spend figure; seat CLIs a dead mesh left running are reaped before any new seat starts; a deliberate shutdown is no
longer reported as a crash.

**The bus** (B3, B4, B14): `accrue` wakes nobody, including at the end of the turn it arrived during; an
`ifUnanswered` whose deadline could never be answered is refused; the contract shape matches the tool list, and the
answer shape is on the ask.

**The environment** (env, B13): the boot log says what the launching machine lends every seat and names the key that
closes the door; `npm ci` works.

## 5. Verification

| | tests | pass | fail | cancelled | skipped |
|---|---|---|---|---|---|
| baseline, before any change | 2706 | 2679 | 0 | **26** | 1 |
| after the first batch of fixes | 2724 | 2723 | 0 | 0 | 1 |
| final (this branch) | 2807 | 2806 | 0 | 0 | 1 |

The 26 cancelled tests at baseline were a real bug, not noise: timers that an awaited promise depended on were
`unref`'d, so Node cancelled the test ("Promise resolution is still pending"). They are gone now, with the `unref`s.
The one skip is the pre-existing "resume storm" test. `npm run typecheck` is clean and `npm run lint` has 0 errors
(the 157 `no-restricted-imports` warnings are the baseline).

The load-bearing tests were **mutation-checked** (B3, B11, B21, B22 and the `goal_active` phrasing): with the fix
reverted they fail, with it they pass. That is also how a test that asserted nothing was found: the B11 race test
passed with its fix reverted until it asserted `stopping === false`. Two other sets had first drafts that measured the
wrong thing (the reopen tests expected a verdict the mission had already reached by itself; the delivery-class tests
counted turn ends rather than `agent.awakened` events) and were rewritten before they were trusted.

## 6. Not fixed, by design, and the honest limits

- **B2 is a text-level gate.** It reads the command a seat is about to run. It stops the move a helpful model makes by
  reflex, not a seat determined to get around it, and **filesystem writes into the product checkout (`cp`, a
  redirection, the Edit tool) are a different boundary that is not drawn**. A directory the text cannot resolve is
  refused only for `git merge`; another subcommand run there is allowed, because the seat's own worktree is the
  common legitimate target of `cd "$(git rev-parse --show-toplevel)"`. A real fix is a sandbox, not more parsing.
- **B10 is visibility, not policy.** An owner may still approve its own artifact when no peer holds the authority,
  because refusing there would deadlock a one-seat mesh and change benchmarks. It is now said where the seat, the
  PM and the operator will read it.
- **B18 is by design.** A new version of a merged patch is new, unreviewed content, so the ladder restarts. If an
  operator wants "merged, but with a follow-up" to be a first-class state, that is a product decision.
- **B19 is fixed by telling, not by keeping the approval across the version bump.** The bump is right (reviewers
  approved the content that was published). A seat that still commits after approval loses it, knowingly.
- **B23: the spend of an orphaned turn is never recorded.** The reaper stops the process; it cannot recover what was
  already spent. It is **Linux only** (`/proc/<pid>/environ`); elsewhere it does nothing. A pid reused by an
  unrelated process reads as a live host and is left alone: a leak persists, nothing innocent dies.
- **The reaper is tested with a fake `/proc` and with a real stamped fixture process on the real `/proc`**, not yet
  against a real `claude` CLI orphaned by a real SIGKILL of a real mesh. The reproduction of the leak was live; the
  fix has not been re-run live.
- **B4's floor is a heuristic.** Default = `coalesce_ms` + the wait-wakeup sweep + two minutes for one answering
  turn. It removes the defaults that could never be answered; it cannot know the addressee's *current* turn, which
  is unbounded. `bus.commitments.min_default_ms` overrides it, and `0` turns it off.
- **`isolate_host` is opt-in.** A mesh that works today may lean on an operator's proxy hook or an allow rule, and
  silently dropping them would break it. The unmeasured half: how much of the run's behaviour came from the outer
  session's `CLAUDE_EFFORT=max` and 32k thinking budget was not measured, because the experiment was scrubbed.
- **`turn-audit.jsonl` is not JSONL** (each line is `<ISO timestamp> <text>`, where the text is a JSON turn record or a
  prose notice). Renaming it would break existing state directories, `mesh ledger` and earlier notes, and its reader
  already handles both shapes, so the docs now say what it is (`docs/runtime.md`).
- **`mesh run --no-tui` exits when the mission completes**, by design, so `mesh status` afterwards finds no server.
- **Not tested, and not claimed:** the mesh on any model but Haiku; a mesh with more than five seats; the dashboard;
  anything about the quality of output on a mission other than this one. One mission, two rounds, one crash, one
  seed: treat the rates (waste %, rejection counts) as illustrative. The defects with model-free repros (B1, B19) and
  code-level causes (B2, B3, B21, B22) do not depend on that.
- The oracle tests a spec that was written for this run; a few choices (`*` allowed as a list item, `fri-sun`
  rejected as reversed) are the author's. Its "soft" message checks are heuristic.

## 7. Worth keeping from how this was done

- **Write the oracle before reading the output**, and validate it on a known-good product and on planted bugs first.
  A raw score of 68.7% and a stratified one of 99.8% said opposite things about the same product until the one
  thing that separated them was understood.
- **Launch a live mesh from a clean environment** (`env -i` with an allowlist: HOME, PATH, proxy and CA variables,
  `NODE_OPTIONS`), or set `mesh.runtime.isolate_host: true`. Otherwise the experiment is the launcher's session, not
  the mesh.
- **Treat "the background job finished" as "the launching shell finished"**: poll the log for the real end.
- **Mutation-check a regression test** by reverting its fix. One in this batch passed with the fix reverted on its
  first draft, which is the only way to learn a test is asserting nothing.
- **Give a rule one predicate.** Three of these bugs (B16/B17, B22, B7) were the same rule written twice and drifting;
  the fixes made each a single exported function (`mayReviewArtifact`, `criterionSatisfied`, `countsAsChecking`).
