# cronlite live run on Haiku — 2026-09-30: what it found, and what was fixed

Status: **FIXED** on branch `claude/exciting-gates-n75s1z` (one commit per finding or theme over `e9a361b`, each
with its own regression test). One live mission, two rounds, one crash; every finding below was either reproduced
with no model or traced to a line. Open items, and the things a fix deliberately does not do, are in §6. A rerun on
the fixed build then found eight more (N1–N8), fixed the same way: §8. A fourth run on that build found
five more (F1–F4, M1), also fixed: §9. The standing four-hourly loop's runs follow: §10 (G1–G3, G5, G6),
§11 (H1–H4), §12 (J1, J3, J4), §13 (L1), §14 (L2–L5), §15 (P1–P3) and §16 (Q1–Q4).

Requested: *"run a real mesh with a real goal with the haiku model and monitor it and find bugs of system and
check quality of output of mesh"*, then *"fix all problems"*; for §8, *"ok now rerun again and check quality and
bugs"*, then *"fix them all"*; for §9, *"commit push on main and then rerun and check output quality and bugs"*, then
*"fix all of them"*.

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

---

## 8. The rerun on the fixed build: eight more findings (N1–N8)

Requested: *"ok now rerun again and check quality and bugs"*, then *"fix them all"*. The rerun used the same mission,
SPEC, mesh config, model and launch environment (a clean allowlist) as run 1, on `main` at `5051da6`, which carries
every fix of §0–§7. Session 2026-09-30 11:24–12:26 UTC (all times UTC): 90 turns, 1.51M tokens, every turn on
`claude-haiku-4-5`. One run, so the rates are illustrative.

| When | What | Result |
|---|---|---|
| 11:24 | `mesh run` | five seats start; the banner says `mesh 'cronlite-team'` (B15) |
| 11:35 | **the VM was recycled** (an idle container is reclaimed and every process killed) | mission at 2 of 6 criteria, a turn in flight, 3 budget holds open |
| 11:50 | restart on the same state | the turn closed as `interrupted`, the 3 holds released, 5 seats woken (all 5 sessions rotated: the outage was longer than `stale_after_ms`) |
| 11:58 | goal met, 6/6 | 52 turns, 981k tokens |
| 12:02 | operator reopen naming 2 of 6 criteria, with the oracle's defect report | the 4 untouched criteria kept their verdict |
| 12:04 | `kill -9` of the host mid-turn | the developer CLI and its MCP bridge survived as orphans (ppid 1, stamped `AGENT_MESH_HOST_PID`) |
| 12:04 | restart | orphans gone within 6 s (B23), 6 abandoned holds released, 2 turns closed `interrupted` |
| 12:25 | goal met again, 7/7 | 38 turns, 531k tokens |

**Quality** (the oracle of §2, unchanged): the round-1 product scored 2894/2983 (97%) and the final product
**3049/3049 (100%)**, with its own suite 71/71, the CLI probes 23/23 and the soft message checks 61/76. The round-1
defects were real: `0 0 * * WED` and `0 0 1 JUL *` rejected as "Quartz extensions" (the L/W check was case-sensitive on
month and day names), `0 0 29-31 2 *` rejected as impossible though February 29 exists, `1-2-3` accepted, `*/-1` throwing a plain `RangeError`. The operator's
report was fixed in two cycles (the first did three of four groups). **QA passed the defective round-1 product** ("full
spec compliance, including all edge cases"): its report never exercises `JUL`, `29-31`, `1-2-3` or `*/-1`, which is the
verification theatre of run 1 again, and none of the fixes below addresses it.

**Fixes from §0 that were checked live and held:** B2 (no out-of-band merge: `main`'s reflog is the three mesh merges),
B3, B4 (the architect's `afterMs: 8000` refused; run 1 had two early defaults), B5, B6, B8 (no no-op transitions), B9 for
termination and recovery actors, B11, B12, B13 (`npm ci` on a clean clone), B15, B16, B19, B20, **B21** (nine holds
released over two real crashes, none open at the end), **B22** (the selective reopen completed) and **B23** (live orphans
reaped in 6 s). Partly: B7, B14, B17 and B10, which are N1 and N4 below. Not exercised: B1.

| # | Finding | Now | Where it is pinned |
|---|---|---|---|
| N1 | `mesh_call review.artifact` ignored its own `request.reviewers`, and the default was the first seat the caller may contact: 13 of 24 review requests refused as `review.reviewer-cannot-settle` (all 7 that named reviewers in the request, 6 of the 8 that named nobody) | **fixed** — the call-level `to`, then `request.reviewers`, else the seats that can settle (`settlersOf`, the list the briefing prints); a named reviewer who cannot settle is still refused, with the route | `tests/policy/review-routing.test.ts` |
| N2 | Artifact reads paged mid-token: a CodePatch was cut between `test('…', (` and `) => {`, and the tech-lead **rejected the whole patch as "incomplete"** (the stored body was whole, the digest matched); a rejected artifact cannot be approved again, so it cost a review-merge cycle (~290k tokens) | **fixed** — a page ends at a line (`pageCut`), for the MCP read and the 60k `read_artifact` op alike | `tests/integration/artifact-page-seams.test.ts` |
| N3 | A verifier's worktree stays behind `main` after merges: QA tested its own stale worktree twice and issued two false `quality.block`s (≈ 202k tokens, 12 of the round's 23 minutes) | **fixed** — fast-forwarded before each turn when it can be done without touching the seat's work; otherwise the prompt says how far behind it is and why | `tests/artifact-store/worktree-sync.test.ts`, `tests/core/worktree-sync-turn.test.ts` |
| N4 | The B10 flag never fired: QA approved both its TestReports to FINAL alone, but the PM's `criterion:*` acceptances (each an `approve` record carrying the report's id) counted as independent approvals | **fixed** — a criterion acceptance is not a review of the artifact it cites | `tests/policy/self-approval-visibility.test.ts` |
| N5 | `patch.merged` and `implementation.completed` were attributed to the patch's owner and filed under the owner's live turn, though the tech-lead merged all three patches | **fixed** — the merger's actor and turn, caused by the MERGED transition; the `implementation\|pass` record stays the owner's, so no gate changes | `tests/core/merge-attribution.test.ts` |
| N6 | The landing gate refused `cd "$(pwd)" && git merge main` (QA syncing its own worktree) as an unresolvable directory | **fixed** — `$(pwd)`, `` `pwd` ``, `$PWD` and `${PWD}` are the directory the gate is tracking; in the product checkout that is still the product checkout | `tests/agent-runtime/landing-gate.test.ts` |
| N7 | `isolate_host` removed 10 of 56 `CLAUDE*` variables of the outer session; the rest, its messaging token and session-ingress token file among them, still reached every seat | **fixed** — the whole `CLAUDE` namespace goes except fourteen names that authenticate or route the CLI; the boot warning counts a long list and names credential-looking variables apart; with the key on, the audit log says what was removed | `tests/agent-runtime/host-isolation.test.ts`, `tests/server/host-isolation-boot.test.ts` |
| N8 | QA's BLOCK on `quality` stood for ten minutes of stall nudges to the tech-lead, the pm and the developer, none of whom can lift it; the note named the unmet criteria and never the block, and a held patch was listed as "parked on the merge ladder" | **fixed** — while a criterion is unmet the watchdog wakes the seat that can lift a standing block (the owner for a block on an artifact, else the blocker), names the block and how it is lifted in the note, and no longer lists a held patch as parked. **The idle and cooldown gates are unchanged** (below) | `tests/integration/stall-standing-block.test.ts` |

What each does and why is in `docs/runtime.md` (paging, the turn-start worktree, the landing gate, `isolate_host`, the stall
watchdog), `docs/protocol.md` (review routing, self-approval, the merge mirrors) and `docs/configuration.md`
(`isolate_host`); the commit messages carry the evidence.

### Not fixed, and the honest limits

- **N8's gap was the gates working as configured, so the gates were not changed.** The 4.5 minutes of quiet after the
  developer's nudge (12:12:04–12:16:35) were the documented 180 s idle window plus the 300 s cooldown of a nudge that
  had just bought work; `tests/lifecycle/stall-watch.test.ts` pins that a productive turn still honours the cooldown.
  A first draft of this fix spent the cooldown after a productive nudge and broke that test, correctly: one run is not
  a reason to reverse a deliberate rate limit. With the nudge aimed at the seat that can act, the first one reaches it
  at the idle bound. A mesh that wants a tighter loop sets `stall_cooldown_ms` at or below `stall_idle_ms`.
- **N8 does not make QA re-verify well.** It wakes the seat that can lift the block and tells it how; whether the turn
  then tests the current product is the seat's. N3 is what stops the stale worktree that caused the false block.
- **N5 leaves the `implementation|pass` record attributed to the owner**, a signature the owner never gave (the old
  comment on `opMerge` already called its duplicate that). Moving it to the merger would let a mission-level
  `tech-lead.pass` be met by the tech-lead landing a patch, which changes what the gates mean, so only the event's
  actor and turn moved.
- **N7's keep-list is a list.** A provider flag Claude Code adds later is removed by `isolate_host` until it is named in
  `KEPT_CLAUDE_ENV`, and that fails at login, loudly. Non-`CLAUDE` variables that shape the CLI (`MCP_TOOL_TIMEOUT`,
  `DISABLE_AUTOUPDATER`) are not isolation's business and still reach the seats.
- **N6 is still a text-level gate** (see §6). It now places one more expansion, the current directory; anything else a
  shell computes is still unknown, and `git merge` in an unknown directory is still refused.
- **None of N1–N8 has been re-run on a live mesh.** Each is pinned by a regression test built from the recorded
  sequence and **mutation-checked**: the tests fail with the fix reverted (N1–N4 once each; N5 two ways; N6 six ways; N7
  six ways; N8 nine ways). The live confirmation is the next run.
- Minor, not fixed: adapter notices (the orphan reaper's) land in `projection-rejections.log` and supervisor audit
  lines in `turn-audit.jsonl`, so there are two places to look; and one error message of the product itself read
  `invalid value ""` for a `-1` step (a nit in the product, not in the mesh).
- The VM recycle at 11:35 cost 15 minutes and a rotation of all five sessions, so round 1 is not a clean cost
  comparison with run 1 (582k tokens in 11 minutes). Before the recycle it had already spent 530k tokens on 26 turns
  for 2 of 6 criteria, so the outage does not explain all of the difference. The first crash (VM loss) killed every
  process, so only the second, a real `SIGKILL` of a live host, exercised the reaper.

### Verification

| | tests | pass | fail | cancelled | skipped |
|---|---|---|---|---|---|
| §5 final, before this round | 2807 | 2806 | 0 | 0 | 1 |
| this round, final | 2852 | 2851 | 0 | 0 | 1 |

`npm run typecheck` is clean and `npm run lint` has 0 errors (157 warnings, the baseline). One commit per finding, then
one for the docs and this section; each commit message carries the failing sequence and what its tests pin.

### Worth keeping from this round

- **A regression test built from the recorded sequence, not from the fix.** The N4 flag had a unit test that passed while
  the flag never fired live, because the test stopped at the approval and the real sequence always continues with the PM
  accepting criteria on the artifact.
- **Read the test that pins the behaviour before changing it.** The first N8 draft changed the cooldown and one
  existing test said why that was wrong.
- **The same rule, one predicate, again:** `settlersOf` (briefing, router default, op refusal and MCP `canSettle`),
  `pageCut` (the MCP read and the op) and `standingBlocks` (the stall note, the driver choice, the ladder and the card).

## 9. The fourth run, on the N-fixes build: five more findings (F1–F4, M1)

Requested: *"commit push on main and then rerun and check output quality and bugs"*, then *"fix all of them"*. Main was
fast-forwarded to `50a45ed` (every fix of §0–§8) and the same mission, SPEC, mesh config, model and clean launch
environment were run on it. Session 2026-09-30 14:18–15:08 UTC: 65 turns, 1.03M billed tokens (about $4.7 at list price),
every turn on `claude-haiku-4-5`, 1085 events. One run, so the rates are illustrative.

| When | What | Result |
|---|---|---|
| 14:18 | `mesh run` | five seats start |
| 14:28 | goal met, 6/6 | 10 min 40 s, 28 turns, 501k tokens (run 3's round 1: 34 min, 53 turns, 981k) |
| 14:32 | operator reopen naming 2 criteria, with the oracle's defect report | 3 criteria back to UNSATISFIED (the 2 named, and the `operator-feedback-…` one the reopen mints) |
| 14:33 | `kill -9` of the host, 3 seats mid-turn | 3 seat CLIs orphaned (ppid 1) |
| 14:33 | restart | 8 holds released, 3 turns closed `interrupted`, the reaper stopped the lingering developer seat and its bridge |
| 15:07 | goal met, 7/7 | round 2 took 35 min 47 s, **21 minutes of it one stall (F1)** |

**Quality** (the oracle of §2, written from the SPEC before any output was read): the round-1 product scored 3033/3034
stratified (99.97%) and the final product **3034/3034 (100%)**, with its own suite 54/54, the CLI probes 23/23 and the soft
message checks 70/76. Run 3's round-1 product had four defect groups; this one had only negative steps (`*/-1` accepted,
`0 0 */-1 * *` throwing `RangeError`) and message text. The raw score (69.0%) is one deviation shared by runs 1, 3 and 4:
**700 of the 706 raw failures are `*` as a list item (`*,5`)**, which the SPEC allows ("an item is `*`") and every seat
rejected. The stratified score excludes it, but by the letter of the SPEC it is a real defect that no seat ever tested. The
README heads `0 0 29 2 *` "First day of February in leap years" (it is February 29), and the `*/-1` message still reads
`invalid value ''`. These are product nits, not mesh code, and are not fixed here.

**§8's fixes, checked live and held:** N1 (0 of 7 review requests refused; run 3 had 13 of 24), N2 (QA read a 25k-character
patch in four pages without a seam), N3 (4 worktrees advanced, 2 left alone with their reasons, 0 false blocks; run 3 had
2), N4 (the run report flagged all 3 QA reports "approved only by its own author"), N5 (both merges attributed to the
tech-lead and its turn), N7 (probed with the real CLI: 99 variables against 142, six `CLAUDE*` names left, a real Haiku turn
completed from the full environment). N6 and N8 were not exercised: no seat ran `$(pwd)` and no BLOCK was raised. The
earlier fixes held too: B21 (8 holds released), B23 (reaper notice naming the two processes), B22 (the selective reopen
completed), B2, B3, B4, B5 and B8.

| # | Finding | Now | Where it is pinned |
|---|---|---|---|
| F1 | The watchdog woke a seat that could not close the criterion: 21 minutes, 12 turns and 188k tokens on `operator-feedback-…`, which only the pm can close. The driver was "first seat in config order with mail", the architect, twice; the pm, when woken, had written "awaiting operator acceptance testing" and did not know the act was its own | **fixed** — when every unmet criterion is one the mesh does not evidence from its own events, the seats that may accept come first (oldest activity first, rotated as the block branch is), and the note says the acceptance is theirs to give, how, and which submitted artifacts they could cite; other seats are told who can. A mesh with no acceptor says only the operator can. The criterion a reopen mints now names who accepts it | `tests/integration/stall-acceptor.test.ts` |
| F2 | Role prompts and the briefing named tools `bus.vocabulary: contracts` hides, and said `mesh_send` "still works": 14 of the run's 370 tool calls (seven `mesh_send`, three `mesh_respond`, two `mesh_merge` from a developer without `git.merge`, one `mesh_broadcast`, one `mesh_request_review`, which the pm then waited on); 8 of 434 and 14 of 567 in runs 1 and 3. The server does resolve a hidden name, but Claude Code refuses it before the call leaves the machine | **fixed** — one table (`tool-visibility.ts`) says which tools a seat is shown; the manifest and the briefing both read it, so the briefing names only what the seat has (under both vocabularies, and for `mesh_merge`/`mesh_veto`/`mesh_decision_ratify` by grant), says which it lacks and that a call to one does nothing; three tool descriptions stopped pointing at hidden tools; and the end-of-turn note now says when a seat called a tool it does not have, with what to use | `tests/protocol/tool-visibility.test.ts`, `tests/core/turn-refused-tools.test.ts`, `tests/core/context-comms-vocabulary.test.ts` |
| F3 | A criterion was evidenced by an unreviewed TestReport the pm wrote itself from what QA had said: `recordDecision` refused the DRAFT, the pm submitted it (the owner may) and closed two mandatory criteria | **fixed** — a verification report cited as evidence must be written by a seat qualified in its domain (`unqualifiedAuthor`), else `mandatory-evidence-unqualified-author` with the route: the seat that can verify publishes its own. No rule about who may accept: the pm's own RequirementsDoc still evidences its criterion | `tests/core/criterion-evidence-author.test.ts` |
| F4 | QA verified an unmerged patch by reading its text in four pages and re-typing four files into a worktree that held only the scaffold commit, and the untracked files stopped the N3 fast-forward. The files matched the merged commit byte for byte; nothing recorded that | **fixed** — a CodePatch's line shows its commit and a verifier is told to test that commit, not type in a copy; the runtime stamps a verification report with the tree it was published from (HEAD, dirty files, and whether the tree holds the commit of each patch the turn read), which a seat cannot forge; the run report flags a report whose tree did not hold it | `tests/core/verification-stamp.test.ts`, `tests/core/verification-stamp-git.test.ts`, `tests/artifact-store/worktree-contains.test.ts` |
| M1 | Every handover's `mesh_write_continuity` was audited as a failed tool call (13 of 13 across the recorded runs) beside a `continuity.recorded` event saying it worked: the supervisor ends the turn under the client when the write lands, and the client reports the call it got no result for as rejected | **fixed** — the turn record and audit say completed when the mesh's own op result says the write landed, one call per landed write | `tests/core/handover-audit.test.ts` |

What each does and why is in `docs/runtime.md` (the stall watchdog's acceptor step, *What a seat is told about its tools*,
*Testing a patch*, *A handover's continuity call*), `docs/protocol.md` (*Evidence for a criterion*, and the corrected
paragraph on `bus.vocabulary`) and `docs/configuration.md` (§ vocabulary, which had the premise F2 disproved); the commit
messages carry the evidence.

### Not fixed, and the honest limits

- **F1 wakes the seat and says what to do; it does not make the act happen.** With nothing submitted the note says the proof
  is what is missing and to ask the seat that can produce it, and whether the pm then asks QA, rather than waiting, is the
  pm's. With an auto-evidenced criterion also unmet the acceptor step is skipped on purpose: the work that would evidence it
  is still to do, and waking the pm to accept `implementation-merged` against some artifact would route around the merge gate.
- **F2 cannot stop a seat reaching for a tool it does not have.** `roles/*.md` still quote the typed moves, and the section
  that maps them to contracts is what translates. What changed is that nothing the mesh writes now tells a seat a hidden tool
  works, and a refused call is said on the next turn. The call itself is still lost: the client refuses it before it is sent.
- **F3 covers three types.** A qualified seat's bad report is review's business, not the gate's, and a mesh with no seat that
  could verify lets the only report there can be stand, or it would wedge.
- **F4 refuses nothing.** It records and flags. A verifier that reads the patch with git instead of the artifact read leaves
  no `tested` entry, containment does not prove the tests ran, and dirtiness alone is recorded and not flagged because an
  untracked report or log is the ordinary state of a verifier's tree. In the fourth run the typed-in files were identical to
  the merged commit and the flag would still have fired, correctly: nothing on the record could have said so.
- **M1 settles the handover's continuity call only.** Other calls the mesh ends under the client (the silence watchdog's
  interrupts) are not reconciled; the evidence was 13 of 13 handovers and nothing else.
- **None of F1–F4 or M1 has been re-run on a live mesh.** Each is pinned by tests built from the recorded sequence and
  **mutation-checked**: F1 ten ways, F2 twelve, F3 eight, F4 eleven (one mutant survives by construction: the hex guard in
  `containsCommit` is belt and braces, since git itself answers null for every option-like value it was tried with), M1 six.
  The live confirmation is the next run.
- The product nits above (`*` as a list item, the README label, `invalid value ''`) are findings about what the seats
  built; the mesh did not cause them and this round does not address them. The `*` one is the most useful finding of the
  quality pass: three runs in a row built and tested a parser that rejects a form the SPEC allows.

### Verification

| | tests | pass | fail | cancelled | skipped |
|---|---|---|---|---|---|
| §8 final, before this round | 2852 | 2851 | 0 | 0 | 1 |
| this round, final | 2907 | 2906 | 0 | 0 | 1 |

`npm run typecheck` is clean and `npm run lint` has 0 errors (157 warnings, the baseline). One commit per finding
(`1f7d29d`, `0abcf1f`, `27ff134`, `005af2d`, `55b9f65`), then one for the docs and this section.

### Worth keeping from this round

- **Read what the client does, not what the server allows.** "A hidden tool still works" was true of the server and false of
  the client, and it stood in a code comment, three documents, a test and the seat's own briefing for that reason: each copy
  vouched for the others. What ended it was a count of refused calls in the audit.
- **A prompt and a manifest written by two hands drift.** The rule now lives where both can read it, and one test renders
  every seat's whole briefing under both vocabularies and checks each tool it names against that seat's real `tools/list`, so
  a third hand would fail there.
- **N8 was specific about the block and generic about the acceptance.** F1 is the same gap one criterion over: a nudge that
  says "drive the next step" to a seat that cannot take it is a wake that buys a turn and nothing else.
- **A record the runtime writes cannot be forged by the seat it describes.** The worktree stamp drops whatever the seat
  supplied under its key, and that is what lets a reader trust it over the report's prose.
- **The same rule, one predicate, again:** `mayAcceptCriteria` (the briefing and the watchdog), `qualifiedForDomain`
  (verdicts, peer review and report authorship), `toolAdvertised` (the manifest and the prose).

## 10. The fifth run, on the F-fixes build: five more findings (G1–G3, G5, G6)

Requested as a standing loop: *"run a real mesh, monitor it find bugs and check output quality and fix and improve them
every 12 hours"* (a session cron job at 00:43 and 12:43 UTC, seven days at most; cycle 1 was run at once). The same mission,
SPEC, mesh config, model and clean launch environment, on the branch at `e791b15` (every fix of §0–§9). Session
2026-09-30 16:33–17:05 UTC: 66 turns, 1.23M billed tokens (about $5.4 at list price), every turn on `claude-haiku-4-5`,
1170 events. One run, so the rates are illustrative.

| When | What | Result |
|---|---|---|
| 16:33 | `mesh run` | five seats start |
| 16:51 | goal met, 6/6 | 17 min 40 s, 36 turns, 745k billed (run 4's round 1: 10 min 40 s, 28 turns, 501k) |
| 16:57 | operator reopen quoting the oracle's defect report (names in ranges, `5-7`, `*` as a list item) | criteria back to UNSATISFIED |
| 16:58 | `kill -9` of the host, seats mid-turn | |
| 16:58 | restart | 8 holds released, 3 turns closed `interrupted` |
| 17:05 | goal met again | round 2 took 6 min 34 s after the restart; run 4's took 35 min 47 s, 21 of them one stall |

**Quality** (the oracle of §2, written from the SPEC before any output was read): round 1 scored 2959/3004 stratified
(98.5%; 2980/3025 raw): names in ranges and steps rejected as "Quartz syntax" whenever the name contains a `W` or an `L`
(`WED-5`, `jan-JUL/4`), `5-7` read wrongly by `matches`, and `1-2-3` and `1.5` accepted. The reopen quoted those, and the
final product scored **3034/3034 stratified (100%)**, 3047/3049 raw, with its own suite 94/94 and the CLI probes 23/23. The
raw score was 69.0% in runs 1, 3 and 4 because 700 of the 706 failures were `*` as a list item; this run's seats accepted
it after the reopen, and the two raw failures left are `nextRun` on a list that contains `*` beside a weekday. The one
product nit left is a message that reads `impossible schedule (field: day-of-month, value: [object Object])`, a string
interpolation in what the seats built, not mesh code.

**§9's fixes, checked live and held:** F2 (0 of 413 tool calls refused by the client as not in the manifest; run 4 had 14 of
370), M1 (4 of 4 handover continuity calls recorded completed beside 4 `continuity.recorded`), F4 (five verification
reports stamped; the round-1 report that read `CodePatch v3` from a tree that did not hold its commit is flagged
`inHead: false`, and the report on v4 is `inHead: true`: QA tested the commit), N1 (no review request refused), N3 (two
worktrees left alone with their reason, because files QA had typed in would have been overwritten by the fast-forward; the
same reason F4 exists), B21 (8 holds released at boot) and B22 (the selective reopen completed). F1 and F3 were not
exercised: the stall watchdog never fired (the only timer wakes were two stale-mail floors and one ask nudge), and no seat that
cannot verify wrote a report.

| # | Finding | Now | Where it is pinned |
|---|---|---|---|
| G6 | A wake for mail the seat had already been handed: 17 of the run's 42 mail wakes (190k of 1.23M billed tokens, 15%); 16 of 64 (11%) in run 3 and 9 of 42 (10%) in run 4. Mail that lands mid-turn reaches the follow-up turn by two routes, the stash and the retry `notifyTurnFinished` makes, and that function has two owners; the second ran after the first had started the follow-up turn, found the mail still unread (a turn drains its box when its model call returns) and stashed the wake again, to be replayed for an empty mailbox. Nine of run 5's seventeen ended in `wait`, `done` or nothing | **fixed** — at dequeue, beside `isStaleWake`, a `message` wake is dropped when the seat has no mail left a wake could be for (`wakeableMail`), and counted as `stale_mail`. Not dropped: explicit or operator wakes, wakes that cite no message the mesh holds, wakes whose note carries a runtime notice | `tests/scheduler/stale-mail-wake.test.ts` |
| G5 | A broadcast the seat had not subscribed to was a wake when its turn ended: 16 of the 42 mail wakes were headed by a broadcast INFORM to a seat whose interests did not list `message.sent` (none of the five does). The send path and the wait sweep honoured the gate; the retry asked `defersMail`, which did not know it | **fixed** — the gate lives in `defersMail`, so the send path, the sweep, the retry and the redundant-observation check agree; the floor (`STALE_MAIL_MS`) is still what reads it for a seat that takes no turn | `tests/scheduler/broadcast-retry.test.ts` |
| G1 | QA could not record a pass. It held `quality.pass` (every shipped QA seat does, and no `.approve`), `mesh_approve` had no `kind`, and its approve was refused "lacks authority 'quality.approve' — no agent seat holds it"; the `qa.pass` the gates read and the `quality-verified` evidence a pass lands were never recorded, and the pm closed the criterion by hand. The tech-lead was refused the same way on QA's report | **fixed** — `mesh_approve` takes `kind: "pass"`; an approve from a seat whose verdict in the domain is a pass is recorded as that pass and says so; a seat holding both keeps its word; only an approve is ever read this way; the refusal to a seat with no verdict names what the others hold ("in this domain qa holds quality.block, quality.pass"); the briefing tells the seat which word its verdict is | `tests/core/verdict-pass.test.ts` |
| G2 | "(root) must NOT have additional properties", three times, with no field named: seven of the ten refused `mesh_call`s. Ajv keeps the name in `params` and the formatter never read it | **fixed** — one entry per object listing every unknown field, in every validator (contracts, messages, events, `mesh.yaml`) | `tests/protocol/validation-errors.test.ts` |
| G3 | All seven `plan_step` calls of the developer's seven steps were `"1"` to `"7"`, each refused with a list of hashes; `mesh_plan` tells a seat no ids | **fixed** — a number within the plan's length is the step's place when no step has that id (a literal id wins); a refusal lists `1) <id> — <text>` | `tests/core/plan-step-ordinal.test.ts` |

What each does and why is in `docs/runtime.md` (*When a mail wake is paid for*), `docs/protocol.md` (*A pass is the verdict
of the seats that verify*, the contract refusal, *Private plans*) and `docs/configuration.md` (`interests` and `authority`);
the commit messages carry the evidence.

**The waste the last three runs had in common.** 35 of run 5's 66 turns (53%, 338k billed) changed no durable state: no
artifact, review, task, patch, criterion or transition was attributed to them, and 22 of them were woken by an INFORM. G5 and
G6 are the two ways a wake reached a turn with nothing to read; neither was a wake any single turn could have told was
redundant, and both sat in every run since the first.

### Not fixed, and the honest limits

- **None of G1–G3, G5 or G6 has been re-run on a live mesh.** Each is pinned by tests built from the recorded sequence and
  mutation-checked: G6 eight ways (a ninth, dropping a guard the type checker already requires, cannot be written), G5
  four, G1 nine, G2 five, G3 seven. The live confirmation is the next cycle.
- **G5 changes when a seat hears an announcement.** Run 5's developer started the implementation on the architect's
  broadcast, a minute before `architecture.approved` would have woken it; under the gate it starts on the approval, or when
  the mail has waited four minutes. A mesh that wants announcements as they are made lists `message.sent` in the seat's
  `interests`. Whether that costs wall-clock on this mission is what the next run will show.
- **G6 drops the stale wake; it does not stop `notifyTurnFinished` stashing it.** The second owner re-running the retry is
  what `tests/scheduler/seat-leak.test.ts` and an earlier stall of `examples/demo-stub` made it do on purpose, and the drop
  at dequeue is the part that is safe to add. A wake is dropped only when nothing a wake could be for is left, so a backlog
  that a turn did not finish reading still buys the next turn.
- **G1's pass lands the criterion without naming a report.** A `pass` on `quality` evidences `quality-verified` with
  `kind: "quality-pass"` and no artifact, as it always did on the prose path; what QA tested is in its report, not in the
  evidence. An approve by a pass-only seat is recorded as a pass rather than refused, which is a judgment: a pass satisfies
  whatever an approve would, and the seat is told what its word became.
- **G2 changes text only.** The `Expected:` schema that follows is unchanged and long.
- **G3 does not make `mesh_plan` return the ids.** The number is what a seat reaches for; the ids are still in the briefing
  of its next turn.
- **G4 (from the run's findings, not done):** a verification report records whether its tree held the patch's commit, and
  nothing records that the files a seat typed in matched it byte for byte. Left as §9 left it: F4 flags, it does not judge.

### Verification

| | tests | pass | fail | cancelled | skipped |
|---|---|---|---|---|---|
| §9 final, before this round | 2907 | 2906 | 0 | 0 | 1 |
| this round, final | 2939 | 2938 | 0 | 0 | 1 |

`npm run typecheck` is clean and `npm run lint` has 0 errors (157 warnings, the baseline). One commit per finding
(`51a6ed6`, `64e12b8`, `ec7ac2c`, `4983aba`, `1a58738`), then one for the docs and this section.

### Worth keeping from this round

- **Count each wake against the turn that had already read its mail.** A tenth to a seventh of every run's tokens went on
  wakes that each looked justified on their own. What showed them was joining the wake to the `message.delivered` of the
  same message, which no single turn's record does.
- **Two routes to one outcome need one of them idempotent.** The test that pins "mail buys a follow-up turn" says it
  survives losing either route, and that is exactly why a route that fired twice went unnoticed: the outcome was right
  every time, and the count was not.
- **A rule stated at three sites and applied at two is worse than one stated at one.** `defersMail`'s comment named itself as
  the place the sites agree, and its neighbour in the sweep spelled out why the broadcast gate mattered there; the retry
  still did not ask it. The fix was to put the gate in the function every site already reads.
- **A refusal can be true of the token and useless to the seat.** "No agent seat holds `quality.approve`" was right while
  `qa` held the verdict the domain actually has. Name what the others hold.
- **Identical sentences hide the field.** Ajv reports once per field and keeps the name in `params`; a formatter that reads
  only `message` prints the same line three times.

## 11. The sixth run, on the G-fixes build: four more findings (H1–H4)

The second cycle of the standing loop, now every four hours (*"run it every 4 hours"*; *"in every loop you should push
to main"*): a durable routine, 00:43, 04:43, … UTC. The same mission, SPEC, mesh config, model and clean launch
environment, on the branch at `a3ed822` (every fix of §0–§10). Session 2026-10-01 12:45–13:19 UTC: 53 turns, 1.06M billed
tokens (about $5.0 at list price), every turn on `claude-haiku-4-5`, 1061 events. One run, so the rates are illustrative.

| When | What | Result |
|---|---|---|
| 12:45 | `mesh run` | five seats start |
| 13:00 | goal met, 6/6 | 14 min 28 s, 35 turns, 688k billed (run 5's round 1: 17 min 40 s, 36 turns, 745k) |
| 13:06 | operator reopen quoting the oracle's defect report (no CLI on `main`; `sun` rejected; `1-2-3` accepted; the day rule wrong when a day field covers its range or holds a `*` item) | criteria back to UNSATISFIED |
| 13:07 | `kill -9` of the host, three seats mid-turn | |
| 13:07 | restart | 3 turns closed `interrupted`, 6 reservation holds released, the six orphan processes (three seats, three bridges) gone |
| 13:19 | goal met again | 13 min 06 s after the reopen, 11 min 50 s after the restart; round 2: 18 turns, 374k billed |

**Quality** (the oracle of §2, written from the SPEC before any output was read): round 1 scored 2796/2934 stratified
(95.3%; 2795/2952 raw, 94.7%), and the failures were the ones the reopen quoted: **`main` had no CLI** (`bin/cronlite.js` was
never merged, so the CLI category scored 0/1), `sun` rejected as a day name, `1-2-3` accepted as a range, and the
day-of-month/day-of-week rule applied wrongly when a day field covers its whole range. The final product scored
**3034/3034 stratified (100%)**, 3049/3049 raw, with its own suite 39/39 and the CLI probes 23/23 (9/9 soft). The raw score
no longer carries the `*`-as-a-list-item loss that held runs 1, 3 and 4 to 69.0%: these seats accepted it from round 1.

**§10's fixes, checked live and held** (each was pinned by tests only until now):

| Fix | Live |
|---|---|
| G5, G6 | 22 mail wakes in the whole run, 2 for mail the seat had already been handed (9%, 28k of 1.06M billed tokens, 3%), none headed by a broadcast. Run 5: 17 of 42, 190k of 1.23M (15%), 16 broadcast-headed |
| G1 | QA recorded its pass with `mesh_approve` in both rounds and `quality-verified` was evidenced `quality-pass/by=qa` both times; in run 5 the pm closed it by hand |
| G2 | 5 contract-shape refusals in 416 tool calls (run 5: 10 in 413), each naming the field: `(root) must NOT have additional properties: 'task', 'description', 'capability_required'` |
| G3 | 22 `plan_step` calls by number (`"1"` … `"8"`), all accepted; run 5's seven were all refused |
| F1 | the watchdog fired twice and both nudges bought work within 30 s: the tech-lead was told which patch was parked MERGEABLE (merged 22 s later), and the pm that the acceptance of the two contract criteria was its own (given within 10 s) |
| F2, M1, F4, N3 | 0 of 416 tool calls refused by the client as not in the manifest; 3 handover continuity calls recorded completed beside 3 `continuity.recorded`; three verification reports stamped, the final one with the head of the CLI commit; two worktrees left alone with their reason (QA's would have had untracked files overwritten, the developer's holds two commits `main` lacks) |
| B21, B22, B23 | the kill -9 recovery above, and the selective reopen completed |

| # | Finding | Now | Where it is pinned |
|---|---|---|---|
| H1 | **A mission completed with a rejected patch unmerged, and `main` had no CLI.** The developer submitted the library and the CLI as two patches. The tech-lead rejected the CLI twice (it repeated the approved library's `src/index.js` and `package.json`), merged the library at 12:57:27 (`implementation-merged` closed on it), and approved the CLI patch 13 s later: an approval of a REJECTED patch records a signature and moves nothing (REJECTED goes to DRAFT only, and that edge is its owner's), and the caveat it was given said "move it to review first", which the tech-lead cannot do. The developer was never woken, the broadcast that said so woke nobody, the pm accepted `cli-contract-met` on a QA report that began "CLI Commit: cd6615a (pending merge)", and the goal completed at 12:59:59 | **fixed** — the termination verdict does not complete a mission over a CodePatch that was rejected and has neither merged nor been archived (when `implementation-merged` is mandatory); the merger is told in its op result; the stall watchdog wakes the patch's owner (or says what the patch waits on) instead of "the mission will close itself", and the stall-cap card names it; the caveat on an approve of a REJECTED patch names the owner and the route, where it said "move it to review first" | `tests/core/open-rejections.test.ts`, `tests/integration/stall-open-rejection.test.ts` |
| H2 | The briefing told a seat that cannot merge to ask "the seat that holds `git.merge`", without a name. The developer asked the architect twice and the pm asked it once; the architect declined both in so many words, and the tech-lead, which held the capability, was the one nobody asked. The patch sat MERGEABLE for 4 min 39 s and landed when the watchdog woke the tech-lead | **fixed** — `AgentContextBundle.mergers` lists the other seats that hold the capability, and the briefing names them ("ask lead once the patch is MERGEABLE, not a seat that cannot merge"); with no holder it says the operator lands it | `tests/core/briefing-merger.test.ts` |
| H3 | `mesh_announce` read as delivery ("every seat hears it", "costs no one a turn"). It reaches mailboxes and wakes no one (a broadcast wakes only seats that list `message.sent`, a directed INFORM wakes nobody), and seats announced what one seat had to act on | **fixed** — the tool descriptions (and `mesh_broadcast`'s), the `Common tools` line and the contracts paragraph say it wakes no one and that what a seat must act on is a `mesh_call` | `tests/core/announce-wording.test.ts` |
| H4 | **A refused rework left a dangling REJECTED patch and a duplicate.** `asVersionOf` took the artifact's id and nothing else. Reworking the CLI patch, the developer wrote its name and then its `artifact://` URI, was refused "unknown artifact" both times with no word of what to write, and published a new patch under a new name ("cronlite CLI implementation v4"): two patches for one deliverable, the rejected one left behind, and (with H1) a tidy-up owed | **fixed** — a predecessor is named by id, `artifact://Type/name[/version]` URI or exact name of the type being published; another type resolves to nothing; ownership is checked after; a refusal says what to write and lists the seat's own artifacts of the type; the tool description says to version a rejected patch rather than publish a new name | `tests/core/publish-version-ref.test.ts` |

What each does and why is in `docs/runtime.md` (*A mission does not complete over a rejected patch*, *The stall watchdog*,
*What a seat is told about its tools*, *When a mail wake is paid for*), `docs/protocol.md` (*Publishing a body*, *Typed state machines*) and
`docs/configuration.md` (`mesh_announce`); the commit messages carry the evidence.

**What the first version of H1 got wrong, and what caught it.** The fix was first written as a rule on the evidence: a merge
that left another patch of the goal outstanding would not evidence `implementation-merged`, and the criterion would close at
the merge or archiving that left none. Replaying the second round against it showed two things the tests built from the
first round could not. The round ended with a patch parked MERGEABLE whose merge the mesh had refused as "nothing landed"
(its work had gone in with another patch), so a rule on every patch in flight would have held a finished mission open and
ended in a card for the operator. And giving the evidence back when a patch was archived meant choosing a merge to cite,
where the only merges in reach included the round the operator had rejected: an archive before any new merge would have
re-evidenced the criterion from the old round's patch. The rule moved to the completion verdict, where the claimed-task and
open-escalation conditions already live, and narrowed to what the incident was: a patch a reviewer rejected. The evidence is
untouched, nothing has to be given back, and a patch that was never rejected holds nothing. Its first tests then passed for
the wrong reason: the supervisor completes the goal itself as soon as the verdict says so, and `evaluate` answers `continue`
for a goal that is already COMPLETED, so they asserted the goal's status.

### Not fixed, and the honest limits

- **H1 costs a tidy-up in one case.** A patch its owner abandoned without archiving (this run's round 2 left the old CLI
  patch REJECTED when the CLI was resubmitted under a new name, which H4 was the cause of) holds the mission until the owner
  moves it to DRAFT and then to ARCHIVED, which the watchdog's note says. In this run that would have added a stall-idle
  window (3 minutes by default) and one developer turn to round 2. Whether the work of such a patch is already on `main` is a
  git question the rule does not ask.
- **H1 reads "was rejected" from the artifact's history.** After a snapshot restore the history is the current record alone,
  so a reworked patch reads as never rejected and the guard does not apply to it. It fails open.
- **A MERGEABLE patch that cannot land has no short exit.** The code machine reaches ARCHIVED from DRAFT and READY_FOR_REVIEW
  only; a patch approved and parked MERGEABLE whose merge is refused as "nothing landed" has to go back through review to be
  withdrawn. Round 2 ended with one. It no longer holds a mission (H1 does not list it), but nothing closes it.
- **A `mesh_call` still guesses field names.** G2 names the field it refused; the five refusals this run were a seat writing
  `description` where the contract says `ask`, `task`/`description` where it says `what`, `artifactUri` where it says
  `artifact`. A "did you mean" for the one-missing-one-unknown case would save the retry.
- **The final TestReport was approved by its own author** (QA's pass, recorded as the verdict its authority gives, settled the
  report because no other seat in this mesh reviews test reports). The run report flags it, as designed; it is a property of the
  five-seat mesh, not of the fix.
- **One run.** The live confirmation of H1–H3 is the next cycle's.

### Verification

| | tests | pass | fail | cancelled | skipped |
|---|---|---|---|---|---|
| §10 final, before this round | 2939 | 2938 | 0 | 0 | 1 |
| this round, final | 2976 | 2975 | 0 | 0 | 1 |

`npm run typecheck` is clean and `npm run lint` has 0 errors (157 warnings, the baseline). Mutation checks: 44 mutants (H1 22, H2 7, H3 5, H4 10), all killed;
three survived their first tests (the unmet-criteria branch of the watchdog note, the direct-caller path of `createArtifact`
and the tool description) and each got a test that kills it. One commit per finding (`eba8cc1`, `74c6ab1`, `68e9226`, `ede86e0`), then one for the docs and
this section.

### Worth keeping from this round

- **Replay the evidence against the fix before building it.** The first H1 passed its own tests and would have regressed the
  run it came from. Walking the second round's artifacts through the rule, by hand, found two failures that no unit test of
  the first round's shape could have.
- **Put a completion rule where completion is decided.** Withholding an evidence record needed a way to give it back, and a
  way to choose what to cite when it did. A condition on the verdict is evaluated every time and has nothing to undo.
- **A test that asserts the verdict can pass on a goal that has already completed.** `evaluate` answers `continue` for a
  COMPLETED goal. The first tests of the gate passed for the wrong reason until they asserted the goal's status.
- **A refusal that names a route the actor cannot take is worse than none.** "Move it to review first" was told to a reviewer
  who could not; the owner was the only seat that could, and the sentence did not name it.
- **Name the seat.** "The seat that holds `git.merge`" is a description a model reads as a rank. Three requests went to three
  seats that could only decline.
- **A refusal that names no route sends a seat round it.** "Unknown artifact cronlite CLI implementation" made the developer
  publish a second patch, and the second patch left the first dangling; two refusals and a new name are how one deliverable
  became two. The id was never the problem, the refusal was.


## 12. The seventh run, on the H-fixes build: three more findings (J1, J3, J4)

The third cycle of the standing loop (every four hours, *"in every loop you should push to main"*): the routine fired at
16:43 UTC. The same mission, SPEC, mesh config, model and clean launch environment, on the branch at `e3bb0c0` (every fix of
§0–§11). Session 2026-10-01 16:45–17:16 UTC: 80 turns, 1.17M billed tokens (about $5.5 at list price), every turn on
`claude-haiku-4-5`, 1391 events. One run, so the rates are illustrative.

| When | What | Result |
|---|---|---|
| 16:45 | `mesh run` | five seats start |
| 16:55 | goal met, 6/6 | 9 min 53 s, 20 turns, 416k billed (run 6's round 1: 14 min 28 s, 35 turns, 688k) |
| 16:57 | operator reopen quoting the oracle's defect report (five defects: names inside ranges and lists, `5-7`, a whole-week day-of-week, possible schedules rejected as impossible, invalid numbers accepted) | criteria back to UNSATISFIED |
| 16:58 | `kill -9` of the host, three seats mid-turn (tech-lead, developer, qa) | six processes left (three seats, three bridges), none at the next check |
| 16:58 | restart | 3 turns discarded, the seats resumed |
| 17:02–17:10 | six `merge` refusals, "your local changes would be overwritten" | the product checkout held a seat's edits (J1); **the operator reset it at 17:10:42, the one intervention of the run** |
| 17:11 | the patch lands, 27 s after the reset | |
| 17:15 | goal met again | 18 min 33 s after the reopen, 17 min 14 s after the restart, 7 min 51 s of it the deadlock; round 2: 60 turns, 756k billed |

**Quality** (the oracle of §2, written from the SPEC before any output was read): round 1 scored 2853/2959 stratified (96.4%;
1452/2221 raw, 65.4%), and the failures were the five defects the reopen quoted. The final product scored **3022/3034 stratified
(99.6%)**, 1550/2257 raw (68.7%), with its own suite 63/63 and the CLI probes 23/23 (9/9 soft). Two things the number hides:

- **The final product still fails 12 stratified checks, one defect, and one of the inputs the reopen quoted verbatim.** A day-of-week
  written as a range or list that covers the whole week (`0-7`, `SUN-4,4,FRI-6/1`) beside a restricted day-of-month is treated as
  `*`, so the OR rule is skipped: `* * 16-25,6 12-dec,5-11 0-7` after 2027-05-01 returns 2027-05-06 where the reopen said
  2027-05-01T00:01 (round 1 returned 05-02). The fix the seats made covers the other two inputs the reopen gave for that
  defect (`0 0 * * 0-7`, and the Monday `matches`); QA's report ran those two, called the defect FIXED and its verdict PASSED,
  and did not run the third.
- **`*` as a list item is rejected again** (`*,5` → `Field: minute, Value: "*", Reason: Invalid value`; the SPEC says an item is
  `*`, a value, a range or a step). That is the raw score: run 6 accepted it from round 1 and runs 1, 3 and 4 did not. The reopen
  did not name it and nothing in the mesh found it.

**§11's fixes, checked live** (each was pinned by tests only until now):

| Fix | Live |
|---|---|
| G5, G6 | 42 mail wakes in the whole run, 1 for mail the seat had already been handed (2%, 13k of 1.17M billed tokens, 1%), none headed by a broadcast. Run 6: 22 wakes, 2 handed (9%, 3%) |
| G1 | QA recorded its pass with `mesh_approve` in both rounds; `quality-verified` was evidenced `quality-pass/by=qa` both times |
| F2, M1, F4 | 1 of 435 tool calls refused by the client (an architect's `bash`); 6 handover continuity calls recorded completed beside 6 `continuity.recorded`; both verification reports stamped with the head they were run against |
| B21, B22, B23 | the kill -9 recovery above, and the selective reopen completed |
| H1, H2, H4 | **not exercised**: no patch was rejected, the first patch was approved and merged by the tech-lead in one turn (16:52:25 to 16:52:28), nobody published a new version with `asVersionOf` |
| H3 | 22 `mesh_announce` calls (12 to everyone); one run cannot say whether the wording changed what seats announce |

| # | Finding | Now | Where it is pinned |
|---|---|---|---|
| J1 | **A seat's edit in the product checkout stopped every merge for 7 min 51 s.** After the kill -9 the developer's resumed session edited `src/index.js` and `test/index.test.js` by the absolute path of the product checkout (13 `Edit` calls, 12 landed) instead of its own worktree's, committed the same fixes there, and got the patch approved. `git merge` then refused to run over the uncommitted changes, six times (17:02:51 to 17:10:15). The tech-lead read git's "your local changes" as the developer's and asked the pm to commit; the pm asked the developer; the developer checked its own worktree and found it clean; four asks were declined as not the asked seat's capability; two escalation cards later the operator reset the checkout by hand. The merger has no write tool and the owner of the files sees a clean worktree of its own, so no seat could have cleared it | **fixed** in three layers: `Edit`, `Write` and `NotebookEdit` are refused when the target resolves inside the product checkout (relative spellings, `..`, a file or directory that does not exist yet, a symlink into it), with the route in the refusal; `merge` sets aside what is uncommitted there before asking git (`git stash create` pinned as `refs/mesh/product-set-aside/<time>`, then `reset --hard`; untracked files left alone), lands the reviewed commit on a clean checkout and tells the merger which files and where they are saved; a merge that still fails over files "that would be overwritten" says they are in the product checkout, that no seat can clear them, and what the operator can do | `tests/agent-runtime/product-write-gate.test.ts`, `tests/artifact-store/product-set-aside.test.ts`, `tests/core/merge-set-aside.test.ts`, `tests/integration/dirty-product-checkout.test.ts` |
| J3 | **Three implementation tasks nobody could claim.** After five `create_task` calls refused for capability names it had invented (the refusal lists the real ones), the pm filed three tasks for the developer listing `repository.write`, `git.commit`, `test.write`, `test.execute`. The developer holds all but `test.write`; only qa does; no seat holds it beside `repository.write`. `delegate` would have refused it ("dev lacks required capabilities …"), `create_task` with `assignedTo` made no such check. The developer's claim was refused (16:47:49), a 23k-token turn went on asking the tech-lead, whose "you can proceed … claim the tasks" could not work (nothing waives a requirement; the tech-lead's three `create_task` calls for the same work were refused as duplicates), the developer worked off the ledger, and all three tasks were still OPEN when the mission completed. No op withdraws a task | **fixed** — `create_task` with `assignedTo` makes the check `delegate` makes, one check with one wording that names who holds the missing capability and the way out; it also stops counting the `implementation.gate` marker as a capability (`delegate` refused it); an unassigned task no seat can claim is filed with a caveat naming the closest seats; a refused claim names the holders and says nothing waives it; `mesh_task_create` says what `requiredCapabilities` means | `tests/core/task-claim-gap.test.ts` |
| J4 | **A seat's stray `/tmp/package.json` broke 30 of this repository's own tests and hung the run for 24 minutes.** The developer's shell staged its product's `package.json` (`"type": "module"`) in `/tmp` at 16:52:34. Node reads every `.js` under `/tmp` through it, so the CommonJS stub children that four host and CLI test files write under `os.tmpdir()` died on their first `require`. One of them, the shutdown test, had no `try/finally`: its assertion threw before `host.close()`, the host's server stayed up, and that file's process never ended | **fixed** — the stubs are written as `.cjs` through one helper, the shutdown test closes the host in `finally`; with the stray file restored all four files pass, and with the stubs broken the old way the file now fails in 17 s where it hung | `tests/support/stub-script.test.ts` |

What each does and why is in `docs/runtime.md` (*a seat's shell may not land work on the product branch*, with the file-tool rule
and the set-aside beside it) and `docs/protocol.md` (*Typed state machines*, the task-capability paragraph); the commit messages
carry the evidence.

**A finding looked at and left alone (J2).** Two phantom artifact ids in 153 ops: the tech-lead's `art-M3W5SBH30077694ffdee` (the
id of the message that asked it, `msg-M3W5SBH30077694ffdee`, with `art-` for `msg-`) and the pm's `art-M3W78DT700d4a2f3dc77`
(invented; the report was `art-M3W779YJ00ebfecc0a20`). Both were refused and recorded nothing, as designed since the phantom
approval of 2026-09-25. Both seats recovered in the same turn with no extra read: the tech-lead approved with the
`artifact://` URI it had already read, five seconds later; the pm read the report by URI. A refusal that listed the artifacts in
review would have saved nothing measurable, so it was not built. What the second one led to was elsewhere: QA's report was still
a DRAFT, so the pm's acceptance was refused as such and waited a QA turn (about a minute and a half).

### Not fixed, and the honest limits

- **J1's gate draws one line.** A shell write (`cp`, a redirection) into the product checkout is still not refused. The set-aside
  is what makes that survivable: the next merge saves it and lands on a clean checkout. It does not make it right, and an
  untracked file that collides with a landing is hinted at, not cleaned.
- **A seat's shell is not confined to its worktree.** The developer staged `package.json` and a patch body in `/tmp`, QA a report
  (`mesh_artifact_publish` refused its `fromPath` as outside the workspace, and it wrote the report again inside it): three files in
  this run and two more in earlier ones, one of which poisoned a directory every process on the machine shares. J4 makes this repository's tests immune; it does
  nothing for the next program that runs a `.js` file under `/tmp`. A per-seat temp directory would not catch a literal `/tmp/…`
  in a heredoc, and a sandbox is a design of its own.
- **Tasks already filed stay filed.** J3 stops the unclaimable one being created; nothing withdraws one that is, and a `task.completed`
  is still prose (QA completed its task at 16:48:09 with "implementation not yet available … waiting", before any verification).
- **A MERGED patch cannot be versioned**, so a rework of merged work is a new patch ("Defect Fixes (5 critical issues)"), as in
  the last run.
- **Round 1 closed the two contract criteria on the merged CodePatch, not on a test run QA reported** (QA's report, created
  16:54:09, was still a DRAFT). The criteria say "shown by a test run QA reports"; the evidence rules check that an artifact is
  substantive and submitted, not what it is evidence of. Round 2's refusal of a DRAFT report did push the pm to the report.
- **Two RequirementsDocs for one deliverable**, the pm's and the architect's; the tech-lead reviewed the architect's and the
  criterion was accepted on the pm's.
- **66% of turns changed no durable state** (53 of 80), 48% of billed tokens, much of it the J1 deadlock's chatter; round 1 alone was
  45% of turns and 24% of tokens.
- **One operator intervention**, at 17:10:42, and the mission would have run on into the stall caps without it.
- **One run.** H1, H2 and H4 are still to be confirmed live.

### Verification

| | tests | pass | fail | cancelled | skipped |
|---|---|---|---|---|---|
| §11 final, before this round | 2976 | 2975 | 0 | 0 | 1 |
| after J1 (the 24-minute run: 30 failures, all from the stray `/tmp/package.json`, found by it) | 3003 | 2972 | 30 | 0 | 1 |
| this round, final (a full build and run: 3 min 38 s) | 3024 | 3023 | 0 | 0 | 1 |

`npm run typecheck` is clean and `npm run lint` has 0 errors (157 warnings, the baseline). Mutation checks: J1 33 mutants
(the gate 11, the set-aside 8, the merge note and hint 14), all killed; the one that did not compile was redone as a form that does;
five more (an empty-target guard, the order of a new path's segments, the root of the directory walk and two guards whose
absence leaves the same behaviour) were judged equivalent and not run. J3 28 mutants (the check 15, the wiring 4, the caveats 4, the claim route 4, the tool text 1), 27 killed; the survivor is the operator filter in the claim route's holders, which the synthesized human seat (it holds only `override`) never reaches. J4: the helper's test is killed by reverting
`.cjs`, and the hang by the before/after run above. Gaps found by reading before the mutants ran (J1's audit lines and a staged
rename; J3's aliases, a capability written twice, the order and cap of the closest seats, the stale-pin combination and a rule-denied claim) got tests first. One commit per finding (`dd4e08d` J1, `030b91c` J4, `adeb9a3` J3), then one for the
docs and this section.

### Worth keeping from this round

- **Read the first error before forming a theory.** Thirty failures in a run that had just touched the merge path read as a
  regression of J1. The first line of the first failure said `/tmp/package.json contains "type": "module"`; the file was dated
  16:52, the run's own minute.
- **A test that starts a server closes it in `finally`.** A failing test that cannot end is worth more than a hundred failing ones:
  the run did not report for 24 minutes.
- **Two ops that make the same promise make the same check.** `delegate` refused a task its target could not claim and
  `create_task` filed it; neither said so, and the board kept three tasks nobody could take.
- **Say what a requirement is, in the place a model fills it in.** The pm wrote `test.write` the way it would write a tag for the
  work. The tool description said "capabilities"; it now says what the claimant must hold, all of it.
- **Save before you discard.** The set-aside is a `git stash create` pinned under a ref before the `reset --hard`; if it cannot be
  saved, nothing is removed.
- **Look at what the seat did next before building a fix for a refusal.** Both phantom ids were recovered inside the turn, with
  what the seat already held, so the candidate list stayed unbuilt.
- **An unconfined shell is a shared machine.** A `package.json` is the one file a developer seat writes for a living, and
  `/tmp` is the one directory where it changes what other programs are.

## 13. The eighth run, on the sell-readiness build: one more finding (L1)

The fourth cycle of the standing loop (every four hours, *"in every loop you should push to main"*): the routine fired at 00:43
UTC on 2026-10-02. The same mission, SPEC, mesh config, model and clean launch environment, on the branch at `c8beb64` (every fix
of §0–§12, and the sell-readiness work on top of them: the fail-closed network defaults, seat environments without the operator's
secrets, the licence and usage layer, `mesh doctor`). Session 00:48–01:21 UTC: 49 turns, 861k billed tokens (about $3.76 at list
price), every turn on `claude-haiku-4-5`, 863 events. One run, so the rates are illustrative. The host ran on loopback with no
token, which is the default, so the listen policy and the sign-in were not exercised: only that the default still works and that
every seat reached the mesh through its bridge.

| When | What | Result |
|---|---|---|
| 00:48 | `mesh run` | five seats start |
| 01:03 | goal met, 6/6 | 15 min 26 s, 26 turns, 474k billed (run 7's round 1: 9 min 53 s, 20 turns, 416k) |
| 01:07 | operator reopen quoting the oracle's four defects and naming four criteria | `implementation-merged`, `quality-verified`, `library-contract-met`, `cli-contract-met` back to UNSATISFIED |
| 01:08 | `kill -9` of the host as the developer and QA were being woken | no seat or bridge process existed yet, so none was left behind |
| 01:09 | restart, 26 s later | both open turns closed as interrupted, the seats resumed on their sessions, no wait for the dead host's lock |
| 01:20 | goal met again | 13 min 13 s after the reopen, 11 min 47 s after the restart; round 2: 23 turns, 388k billed |

**Quality** (the oracle of §2, written from the SPEC before any output was read): round 1 scored 2859/3010 raw (95.0%) and
2896/2992 stratified (96.8%), and its failures fell into the four defects the reopen quoted (names inside ranges, steps and lists rejected as
extensions; a day-of-week that covers the whole week treated as `*`; possible schedules rejected as impossible; a negative step
escaping as `RangeError` after seconds). The final product scored **3049/3049 raw (100%) and 3034/3034 stratified (100%)**, its own suite
61/61, the CLI probes 23/23 (9/9 soft). That is 100% of a mission that was told its defects, on one run: a measurement, not a rate.
25 of 49 turns (51%, 31% of billed tokens) changed no durable state (run 7: 66% and 48%).

**Earlier fixes, checked live** (each was pinned by tests only until now):

| Fix | Live |
|---|---|
| G1 | QA gave its pass through `mesh_approve` three times: 00:56:01 (EVIDENCED, 12 tool calls), 01:15:19 (**ASSERTED**, 0 tool calls), 01:20:57 (EVIDENCED, 2). The second is L1 |
| M1 | four session rotations: pm and QA (128k tokens each) through a handover turn, each `mesh_write_continuity` recorded `completed` beside its `continuity.recorded`; the developer (92k) and tech lead (83k) on a cold prompt cache, rotated directly, as designed (`handover: false`) |
| B21 | both interrupted turns closed with "abandoned by server restart: the process ended before the turn did, so its spend was never recorded"; 0 `agent.failed` |
| B22 | the selective reopen of four criteria completed |
| S1–S5 | 238 `mesh_*` calls from five seats through their signed bridges; 33 were refused or failed, none for authentication: the mesh's own refusals (contract shape, DRAFT evidence, an already completed task) and three `mesh_done` calls made after the host had stopped ("mesh bus unreachable") |
| B23, J1, J3, H1, H2 | **not exercised**: no process to reap at the kill (the seats were being woken, nothing had been spawned), no seat wrote into the product checkout, no unclaimable task, no patch rejected |

| # | Finding | Now | Where it is pinned |
|---|---|---|---|
| L1 | **A pass that closed nothing answered `ok`, and the repair for it was refused advice.** QA tested the fix, published its defect report and gave `mesh_approve kind:"pass"` on it (01:15:19) from a turn that had run its tests in the one before. The turn invoked no verification tool, so the verdict landed `ASSERTED`, which counts for nothing, and the reply said nothing of it (an acceptance was told of `ASSERTED`; a pass was not, and neither was told when its artifact was the one the operator had rejected). QA reported the verdict recorded. The tech lead, seeing `quality-verified` still open (it was the last criterion; the other six closed by 01:17:29), asked QA to move the report back to review (it was FINAL: `illegal artifact transition document:FINAL -> READY_FOR_REVIEW`) and then to pass the **round-one** report, and QA did, at the round-one commit: 45 tests at `a775df9`, not the 61 at `3e9617a`. The mission completed at 01:20:57 on that verdict, 5 min 38 s after the first pass, 3 min 28 s of it with nothing else open. Three more things sit in the same call: a pass named no artifact, so the reopen gate (which compares artifact URIs) could not see it and a seat could pass the very patch the operator rejected; a pass of a settled report again, which is the repair, was answered "a second signature … changes nothing"; and "move it to review first" was said of artifacts that have no such move (a FINAL report, an approved patch, a ReleasePlan) | **fixed** — a pass or an acceptance that lands `ASSERTED`, or is refused as the rejected artifact, says so on the call, in the words of the act ("in the turn that gives the pass", "give the pass on that"; "accepts it", "cite that"); a pass names the artifact it was about when that is submitted work (not a draft or a rejected one: the workflow gate refuses those as evidence, and a draft report passed by the seat that wrote it was 3 of the 7 real passes in runs 6 to 8); a repeat pass that closes the criterion is not told it changes nothing; the route to review is named only where the transition table has one (`canEnterReview`) | `tests/core/pass-evidence.test.ts` (12), `tests/policy/inert-approval.test.ts`, `tests/core/verdict-pass.test.ts` |

What it does and why is in `docs/runtime.md` (*The seat is told when its verdict did not close the criterion*) and `docs/protocol.md`
(the inert-verdict paragraph); the commit message carries the evidence.

### Not fixed, and the honest limits

- **A pass records which artifact, not which commit it was run against.** The stale round-one report could still be passed on purpose:
  F4 stamps a verification report with the head it was tested at, and nothing compares that with the head the mission is judged
  on. L1 removes what led QA there (it is told on the spot that its first pass did not count); it does not stop a deliberate one.
- **The identity gate is blind to a draft.** A pass on a draft names no artifact (above), so a draft passed again after a reopen is
  caught only by the recency rule: the pass has to be recorded after the reopen, not by what it was about.
- **QA's report was a DRAFT again when the pm tried to accept against it** (01:02:10, two refusals; 67 s until QA submitted it).
  The refusals named the route and were followed. The same pattern as §12's last item. The briefing already says that "a DRAFT
  nobody transitions is never reviewed and never becomes evidence", and QA left its report there until asked; more words to the
  same seat are not a fix, and this round did not change it.
- **15 of 29 `mesh_call`s were refused (52%; runs 5 to 7: 42%, 35%, 33%)**, 6 of them recovered by a later call on the same contract in
  the turn. Nine were the shape of a contract's request (`what` for `ask`, `description` for `what`; each refusal names the field),
  two an `ifUnanswered` shorter than the floor (the refusal states the floor), two were `execution.run` with no seat that holds
  `shell.execute` to serve it (`no seat you may contact holds shell.execute`; the contract is listed with no provider), one a
  review request whose named reviewer could not settle it, and one a call the model sent as unparseable JSON. Not changed: one run
  and the refusals say why; `execution.run` was refused three times in run 7 too.
- **Six `mesh_task_complete` calls on tasks already completed**, by three seats (the same limit as §12: a task's completion is prose).
- **One run.** B23, J1, J3, H1 and H2 are still to be confirmed live.

### Verification

| | tests | pass | fail | cancelled | skipped |
|---|---|---|---|---|---|
| §12 final, before the sell-readiness work | 3024 | 3023 | 0 | 0 | 1 |
| head `c8beb64`, before this round | 3353 | 3351 | 0 | 0 | 2 |
| this round, final (the test run: 3 min 13 s) | 3365 | 3363 | 0 | 0 | 2 |

`npm run typecheck` is clean and `npm run lint` has 0 errors (185 warnings, one rule, the baseline). Mutation checks on the new
tests, each reverted: the pass names no artifact (2 tests fail), the pass says nothing of its criterion (6), the repeat note kept
when the repeat closed the criterion (1), the route to review always offered (2 in the new file; the ReleasePlan case had nothing
pinning it and now has an assertion in `inert-approval.test.ts` that kills it), a draft is named (1, and 2 in `supervisor-turn`),
the acceptance silent on a rejected artifact (1), a pass told to "cite" (2). The first version of the change named drafts too; two
existing tests failed for exactly that reason, and the frozen logs of runs 6 to 8 said why it was wrong before any code
was rewritten.

### Worth keeping from this round

- **A tool that downgrades a claim must say so in the same reply.** `ok: true` over a silent `ASSERTED` is how a seat reports a
  criterion done and the next seat asks for the work again; the repair the seat needed was one more call it was never told to make.
- **Survey the logs before choosing a rule.** The gate for drafts looked like a free addition until seven real passes showed three
  of them were on drafts. A rule that would have refused the commonest case was found in a minute, by reading, and not by a run.
- **A note that says a call did nothing must not go to a call that did something.** The repeat pass that closes a criterion was
  told it changes nothing, and told to move a FINAL report to a state it cannot reach.
- **Read the last criterion's history, not just the verdict.** The mission's record says `quality-verified` was evidenced by QA's
  pass; only the commit in the pass's own comment says what it was evidence of.


## 14. The ninth run, on the L1 build: four more findings (L2–L5) and a racy test

The fifth cycle of the standing loop (every four hours): the routine fired at 04:44 UTC on 2026-10-02. The same mission, SPEC, mesh
config, model and clean launch environment, on the branch at `c29127b` (every fix of §0–§13, L1 included). Session 04:46–05:15 UTC:
50 turns, 836k billed tokens (about $3.67 at list price), every turn on `claude-haiku-4-5`, 912 events. One run, so the rates are
illustrative. The host ran on loopback with no token, so the listen policy and the sign-in were not exercised (as in §13).

| When | What | Result |
|---|---|---|
| 04:46 | `mesh run` | five seats start |
| 05:00 | goal met, 6/6 | 13 min 26 s, 34 turns, 548k billed (run 8's round 1: 15 min 26 s, 26 turns, 474k) |
| 05:05 | operator reopen quoting the oracle's four defects and naming four criteria | `implementation-merged`, `quality-verified`, `library-contract-met`, `cli-contract-met` back to UNSATISFIED |
| 05:06 | `kill -9` of the host with the developer, QA and tech lead mid-turn | five seat processes orphaned (parent 1); none was left when the host came back 20 s later |
| 05:06 | restart | the three open turns closed as interrupted, none of their spend counted, 0 `agent.failed` |
| 05:15 | goal met again | 10 min 14 s after the reopen, 8 min 54 s after the restart; round 2: 16 turns, 288k billed |

**Quality** (the oracle of §2, written from the SPEC before any output was read): round 1 scored 2859/3010 raw (95.0%) and
2896/2992 stratified (96.8%), the same totals as run 8's first round, from the same three defects of semantics (names inside ranges,
steps and lists rejected as extensions; a day-of-week that covers the whole week treated as `*`; possible schedules rejected as
impossible) and a fourth of the same weight (a range with a second dash, `1-2-3`, accepted; run 8's was a negative step escaping as
`RangeError`). The final product scored **3049/3049 raw (100%) and 3034/3034 stratified (100%)**, its own suite 48/48 (31/31 in round
1), the CLI probes 23/23 (9/9 soft). That is 100% of a mission that was told its defects, on one run: a measurement, not a rate.
28 of 50 turns (56%, 36% of billed tokens) changed no durable state (run 8: 51% and 31%).

**Earlier fixes, checked live** (each was pinned by tests only until now):

| Fix | Live |
|---|---|
| L1 | 13 criterion records; 2 landed `ASSERTED` (the pm's acceptances at 04:59:10 and 04:59:12, from a turn that ran no verification tool) and both carried the note; none was silent. Both of QA's passes were on a draft report, so neither named an artifact (L2) |
| G1 | QA gave its pass through `mesh_approve` twice (04:55:11, 18 tool calls; 05:11:06, 4), both `EVIDENCED` |
| B21 | the three open turns closed with "abandoned by server restart: the process ended before the turn did, so its spend was never recorded" |
| B22 | the selective reopen of four criteria completed |
| M1 | four session rotations (`session.rotated`), none failed |
| S6 | `mesh usage mesh.yaml --by agent` equals the analysis tool's per-seat figures to the token (50 turns, 835.8k billed) |
| S1–S5 | 241 `mesh_*` calls from five seats through their signed bridges; 36 were refused or failed, none for authentication: the mesh's own refusals, and one `mesh_done` made after the host had stopped ("mesh bus unreachable") |
| B23, J1, J3, H1, H2 | **not exercised**: the five orphans of the kill had exited by themselves within 20 s, so the reaper had nothing to do; no seat wrote into the product checkout, no unclaimable task, no patch rejected |

| # | Finding | Now | Where it is pinned |
|---|---|---|---|
| L2 | **A seat that passed the report it had just written left it a draft, and nobody else could see or cite it.** QA tested the merged product, published its test report and gave `mesh_approve kind:"pass"` on it in one turn (04:55:11). The report was a DRAFT, so the pass could not settle it, and the reply said "move it to review first if you meant to approve the work", which QA, whose business was the product, did not do. A DRAFT is shown to nobody but its owner (a test report is work-scoped) and an acceptance refuses it as evidence. Round 2 did it again (05:11:06: the mission sat idle for 3 min 23 s with three criteria open). From QA's pass to the goal took 5 min 4 s in round 1 and 4 min 22 s in round 2, 9 of the run's 29 minutes, most of it waiting on a report nobody could see or cite. Five of the nine passes in runs 6 to 9 were given on a draft, every one on the report QA itself had just written | **fixed** — a `pass` on a DRAFT `TestReport`, `SecurityReport` or `BenchmarkResult` that the giver owns moves it to review first, as the owner's own transition under the same gates and only after every refusal a pass can meet; the pass then settles it and names it. A pass on somebody else's draft submits nothing, and neither does one on a draft of any other type | `tests/core/own-report-pass.test.ts` (7), `tests/core/pass-evidence.test.ts` |
| L3 | **The seat that can accept a criterion was never shown the report it would cite.** A work-scoped artifact is in a briefing for its owner, for whoever is mailed it and while it awaits a verdict. So from the moment QA's pass settled the report it was in nobody's briefing but QA's: none of the pm's three turns nor the architect's three before 04:59:03 mentions it. Those six turns (76k tokens, 14% of the round) went on asking each other for a test report: the architect asked the pm twice ("test reports are QA's", twice), the pm then asked QA for one QA had published three minutes before. Runs 7 and 8 did the same (92 s and 284 s after the report was published) | **fixed** — the briefing of a seat that may accept criteria lists the artifacts an acceptance could cite while a mandatory criterion that needs an acceptance is open (three at most) and says on the line that it may. It is the list the stall watchdog already offered, now one helper (`citableEvidence`) so the two cannot differ: no draft, nothing the operator rejected at the reopen, no report written by a seat that cannot verify | `tests/core/acceptor-evidence.test.ts` (7) |
| L4 | **The closing report understated the run's spend by its last turn.** `mesh run` composed its report the moment the goal changed, while the turn that changed it (the pm's last acceptance) was still running and its spend not yet booked: run 8's report said 839k tokens and 48 turns where the ledger had 861.3k and 49; run 9's said 534k and 33 after round 1 against 548.0k and 34, and 817k and 49 at the end against 835.8k and 50 (2.2% to 2.6% short, every time). The ledger and `mesh usage` agree with each other to the token; the report is the figure a customer reads first | **fixed** — the report is composed after the shutdown, which joins the completion and so drains the turns still running (bounded), with one line printed at once saying what the wait is for; it is printed whether or not the shutdown went cleanly, and an interrupted run still reports first | `tests/cli/run-end.test.ts` (3) |
| L5 | **A review request refused because the requester is the only seat that can settle the artifact named the requester.** The tech lead asked QA to "review" the developer's patch in runs 7, 8 and 9. Only the tech lead can settle a patch, so the ask was refused with "tech-lead can" or, in run 9 (04:53:15), "no seat you may contact can deliver a verdict on this CodePatch — tech-lead can, but you may not contact them. Name a reviewer with `reviewers` if one is reachable, or escalate." What it wanted was the patch tested, a work request; it found that by itself 14 s later, so this is a wording fix and its cost here was small. The patch was also already MERGEABLE, which any advice to "settle" it would have had to survive | **fixed** — the seat is named as "you" and told what to do: "settle it yourself with `mesh_approve` (or `mesh_reject`), and ask a seat to test it first with a `work.request` if you need that", and no longer told to name a reviewer or escalate. The advice is given only where a verdict can still move the artifact (`verdictAdvances`); for a draft or an artifact already past review (the run's MERGEABLE patch) the seat is told what state it is in and that testing is a work request. A seat that cannot settle gets the old text, unchanged | `tests/policy/review-routing.test.ts` (5 new) |
| T1 | **A test of the project's own log failed now and then in the full suite.** `git mission e2e` compared the file with the store by reading the file and then, a moment later, the store, while dev's last turn (woken by the lead's final INFORM) was appending six events in a burst: `178 !== 184`. It failed in this cycle's full run, and an alternating run of this build and the one before it failed the older one too (with another test loop beside it), so it is a race the suite met, not one of this cycle's commits | **fixed** — the store is read first, then flushed, then the file read; the file must hold everything the store held at that moment, nothing the store lacks, and the same ids in the same order (a flush drains the queue as of the call, and the store's cache is updated before the file is written). 40 runs in a row pass | `tests/integration/git-mission-e2e.test.ts` |

What each does and why is in `docs/runtime.md` (the briefing paragraph of *The stall watchdog*, *A pass submits the verification report
its giver wrote*, the `mesh run` bullet) and `docs/protocol.md` (*Evidence for a criterion*, *Who a `review.artifact` call goes to*); the
commit messages carry the evidence.

### Not fixed, and the honest limits

- **The pm's `mesh_approve kind:"pass"` on a criterion subject was refused** (once, 40 s until the acceptance it meant): "agent pm …
  lacks authority 'requirements.pass' — no agent seat holds it". A criterion is accepted with `approve`, and the refusal does not say
  so. The same family as L5 (a refusal true and no help); one occurrence in nine runs, so it is recorded here and not changed.
- **Phantom artifact ids** (the J2 pattern: an id the seat typed from memory that is not in the store): five across runs 7 to 9,
  recovered in 4 to 10 s. The refusal says "unknown artifact" and how to name one.
- **Tool markup leaked into an `artifactId`** (the pm's acceptance at 05:15:20 and 05:15:22: the id read `art-…</artifactId>
  <parameter name="comment">…`): first in seven runs, two refusals, recovered in 3 s. A model slip; not changed.
- **`execution.run` is refused when no seat holds `shell.execute`** (as in §13): the contract is advertised with no provider.
- **QA's task was completed before its work was done in both rounds**, and the developer moves its own patch through VERIFIED and
  MERGEABLE. Both are prose in a role prompt, not something the mesh enforces.
- **QA's round-1 pass covered a product the oracle then scored 95%.** The report was 31 of 31 on the seats' own tests; four defects of
  the SPEC's corners were in the product, as they were in run 8's. The mesh's verification is weaker than the oracle's, which is the
  reason the loop has one.
- **56% of turns changed no durable state (36% of billed tokens)**; 7 of the 28 were woken by an INFORM. Reducing it is a tuning of who
  is woken, which one run cannot support.
- **One run.** B23, J1, J3, H1 and H2 are still to be confirmed live, and a clean launch on a network address (S1, S3) has not been
  run with real seats.

### Verification

| | tests | pass | fail | cancelled | skipped |
|---|---|---|---|---|---|
| head `c29127b`, before this round | 3365 | 3363 | 0 | 0 | 2 |
| this round, first full run (before L5's status check and T1) | 3386 | 3383 | 1 (T1) | 0 | 2 |
| this round, final (the test run: 3 min 26 s) | 3387 | 3385 | 0 | 0 | 2 |

The run between those two failed one test of its own making: `every compiled file in dist still has a source`, because an instrumented
copy of the e2e test used to find T1's six events had been left in `dist/`. It was removed and the suite rerun green; the check did
what it is for.

`npm run typecheck` is clean and `npm run lint` has 0 errors (185 warnings, one rule, the baseline). Mutation checks on the new
tests, each reverted: L2 (the pass submits nothing: 3 tests fail; another seat's draft submitted: 1, which survived until the test
asserted that no refusal is left on the record, since the transition gate refuses a non-owner anyway; any kind of draft submitted: 1;
submitted even when the pass is refused: 1), L3 (shown to any seat: 1; offered with nothing left to accept: 2; only what the ranking
chose: 2; the line does not say it: 1; a criterion the mesh evidences itself counted as needing an acceptance: 1, which survived
until the test kept `quality-verified` open while the report was visible), L4 (report before the shutdown: 2; a failed shutdown loses
the report: 1; the wait is silent: 3), L5 (the "you" substitution dropped: 3; the clause dropped on the named path: 3; the router's
early return dropped: 2; taken for every requester: 2; the clause appended for every requester: 1, which survived until the test
pinned the whole old sentence and not its start; the advice given whatever the artifact's state: 1; never given: 3), T1 (the file
never receives the budget lines: fails; the file receives an event twice: fails).

### Worth keeping from this round

- **Ask what a seat can see, not what exists.** The report was published, passed and in the store; it was in nobody's briefing but its
  author's. Six turns of messages asking for it were the symptom, and "tell QA to submit sooner" would have been a sentence in a prompt.
  The fix was visibility (L3) and removing the step the mesh could take itself (L2).
- **A figure read against an invoice must be composed after the last charge.** The ledger was right all along; the report was early.
- **A refusal that names the asker teaches nothing.** "tech-lead can", said to the tech lead, is true and no help.
- **Advice has a precondition too.** The first version of L5 told a seat to settle a patch that was already MERGEABLE, and its own tests
  passed because they used a draft: a fixture in the wrong state for the advice it pinned. The refusal in the log said what state the
  artifact was in; the fixtures did not. The change was caught by reading the real refusal's neighbouring events, not by a run.
- **A test that reads the same log twice is a test of the clock.** The file and the store were compared a moment apart while the mesh
  kept writing. Read one, flush, read the other, and the order is the proof.
- **Count from the logs before writing the number in a commit.** The drafts were counted three times, 4 of 8 and 3 of 7 from memory of
  what had been looked at and 5 of 9 from the turn records; only the last is in the commit.


## 15. The tenth run, on the L-fixes build: three more findings (P1–P3)

The sixth cycle of the standing loop: the routine fired at 08:43 UTC on 2026-10-02. The same mission, SPEC, mesh config, model and
clean launch environment, on `main` at `9f80740` (every fix of §0–§14, L1 to L5 included; the branch and `main` were the same
commit). Session 08:45–09:14 UTC: 41 turns, 869k billed tokens (about $3.60 at list price), every turn on
`claude-haiku-4-5`, 779 events. One run, so the rates are illustrative. The host ran on loopback with no token, as in §13 and §14.

| When | What | Result |
|---|---|---|
| 08:45 | `mesh run` | five seats start |
| 08:59 | goal met, 6/6 | 13 min 23 s, 22 turns, 445k billed (run 9's round 1: 13 min 26 s, 34 turns, 548k) |
| 09:02 | operator reopen quoting the oracle's five defects and naming four criteria | those four and the `operator-feedback-…` criterion the reopen mints are UNSATISFIED |
| 09:03 | `kill -9` of the host a minute later, with the architect, developer and tech lead mid-turn | three seat processes orphaned (parent 1); none was left when the host came back 36 s later |
| 09:04 | restart | the three open turns closed as interrupted, 0 `agent.failed`, three seats rotated their sessions |
| 09:13 | goal met again | 10 min 45 s after the reopen, 9 min 9 s after the restart; round 2: 19 turns, 424k billed |

**Quality** (the oracle of §2, written from the SPEC before any output was read): round 1 scored 1525/2251 raw (67.7%) and 2904/2980
stratified (97.4%): the `*`-as-a-list-item loss that held runs 1, 3, 4 and 7 to about 69% raw (§10 to §12) was back, with nearly all
of the failures. A `*` (or `*/n`) used as an item of a list (`*,5`, `*/9,*`) was rejected, which is 690 of the 726 failing cases (the
stratified form leaves star lists out; the product's own suite was 59/59). The others: names in ranges, steps and lists rejected as Quartz
extensions (21 cases), a day-of-week range ending in 7 (`5-7`) rejected as reversed (5), `0-7` for the day of week not matching
every day, alone and with a restricted day of month (9), and a range with a second dash accepted (1). The final product scored
**3049/3049 raw (100%) and 3034/3034 stratified (100%)**, its own suite 78/78, the CLI probes 23/23 (9/9 soft). That is 100% of a
mission that was told its defects, on one run: a measurement, not a rate. 16 of 41 turns (39%, 25% of billed tokens) changed no
durable state (run 9: 56% and 36%).

**Earlier fixes, checked live** (each was pinned by tests only until now):

| Fix | Live |
|---|---|
| L1 | 14 criterion records; 3 landed `ASSERTED` (the pm's acceptances at 09:12:11, :14 and :17, from a turn with no verification tool call) and all three carried the note; none was silent (P3) |
| L2 | 4 passes, none on a draft. QA's first pass of round 1 named the merged patch; its three later passes (08:55:28, 09:11:43, 09:12:34) were each on a report it had just written, and each submitted it: DRAFT to READY_FOR_REVIEW with the comment "submitted with qa's own quality pass", then FINAL, within the second, and named it. 35 s from creating the first report to its being citable, where the ninth run's took 3 min or more |
| L3 | 9 of the pm's 11 briefings carried the "submitted: you may accept …" lines; on its first turn after a report was final the pm cited it within 18 s (08:58:57 to 08:59:15). No seat asked for a report after one was submitted (the ninth run: three asks) |
| L4 | the closing report said 445k and 22 turns after round 1 and 869k and 41 turns at the end; the analysis tool, the host's heartbeat and `mesh usage` (S6) say the same to the token (869,336) |
| B21, B22, M1 | the three open turns closed with "abandoned by server restart: the process ended before the turn did, so its spend was never recorded"; the selective reopen completed; five session rotations, one with a handover (the pm's, continuity written) |
| S1–S5 | 213 `mesh_*` calls from five seats through their signed bridges; 20 were refused or failed, none for authentication: the mesh's own refusals, and the last calls of two turns made after the host had stopped ("mesh bus unreachable") |
| L5, B23, J1, J3, H1, H2 | **not exercised**: no review was refused; the three orphans of the kill had exited by themselves within 36 s; no seat wrote into the product checkout, no unclaimable task, no patch rejected |

| # | Finding | Now | Where it is pinned |
|---|---|---|---|
| P1 | **An approval signed as `architecture` on a RequirementsDoc closed `architecture-approved` and told everyone the architecture was approved.** The architect and the pm each asked the tech lead for a review within sixteen seconds (the ArchitectureDocument at 08:48:48, the RequirementsDoc at 08:49:04; the pm's own request named the requirements document's id with a note about "Architecture design"). At 08:49:16 the tech lead signed `architecture`, wrote "Architecture is sound and complete" and named the RequirementsDoc. The verdict moved the RequirementsDoc, as it should, and the mesh then derived `architecture.approved` and marked the criterion with the RequirementsDoc as evidence: the architect told the others the architecture was approved (08:49:32), the pm broadcast it, the developer was woken for it. The ArchitectureDocument sat UNDER_REVIEW until the tech lead's next turn approved it, 2 min 49 s later (08:52:05), and the closing report still listed the RequirementsDoc as the evidence of "Architecture approved by architect and tech-lead". The reply to the slip said `ok` | **fixed** — the derived approval and the criterion follow the artifact: they fire for an artifact of the architecture domain (or a subject-level sign-off that names none), not for whatever a seat signed in that capacity. The signature itself stands and moves the artifact it named. And the reply to a verdict signed in one capacity on an artifact of another domain names the review in the signed capacity that the seat still owes (a request addressed to it, awaiting a verdict), with its id; a cross-domain signature with nothing owed behind it says nothing | `tests/core/cross-domain-approval.test.ts` (7) |
| P2 | **The seat that had to accept was woken three minutes late.** QA published its report, passed it and told the pm (an INFORM, the `accrue` class); `goal.progress` is observational and wakes nobody. The stall watchdog's idle window was the only wake there was: the pm was nudged 3 min 22 s after QA's last event (08:55:35, nudged 08:58:57), a quarter of the round (the ninth run's second round: 3 min 23 s) — and accepted both criteria within 18 s of waking | **fixed** — when every criterion still open closes only by an acceptance, a seat that may accept exists and a verification report it could cite is submitted, the watchdog waits a twelfth of the idle window (15 s of 180 s) instead of all of it: the acceptor is nudged 15 to 45 s after the last turn. Everything else keeps the full window | `tests/lifecycle/acceptance-grace.test.ts` (5) |
| P3 | **The pm accepted without reading, and was told only after the turn.** Round 2: three acceptances at 09:12:11–17 from a turn whose only calls were the `mesh_approve`s and `mesh_done` ("Mission complete: Accepted final 3 criteria"), all `ASSERTED`, the mission waiting; the watchdog woke the pm 34 s after that turn, it read the report and accepted again, and the goal was met at 09:13:41, 84 s and two turns later (one a session handover). The ninth run's pm did it with two criteria. Round 1's pm read first and had no `ASSERTED`: it reads or it does not, and the reply that says why arrives after the turn's ops have run | **fixed** — under the artifact list in the briefing of a seat shown something to cite, once: "Read what you cite in the same turn (`mesh_artifact_read`): an acceptance from a turn that read or ran nothing is recorded ASSERTED and does not count."; and a bullet in `roles/pm.md`. A seat shown nothing to cite is not told | `tests/core/acceptor-evidence.test.ts` (8; one new) |

What each does and why is in `docs/protocol.md` (*Evidence for a criterion*) and `docs/runtime.md` (the quiet gate of *The stall
watchdog*, the briefing paragraph); the commit messages carry the evidence.

### Not fixed, and the honest limits

- **Phantom artifact ids** (the J2 pattern: an id the seat typed from memory that is not in the store): three more, the architect's
  twice (08:52:33, :36) and the tech lead's once (09:10:57), each recovered within 4 s; eight across runs 7 to 10. Naming the review
  the seat owes in that refusal would make it actionable (P1 now has the lookup); it costs about ten seconds a run, so it is
  recorded and not changed.
- **Contract-shape refusals** (an extra property: `criterion`, `domains`, `artifactUri`; `work.request` without `ask`): four, each
  recovered by the next call (the refusal names the field and gives the shape).
- **QA's task was completed before its work was done** (08:48:38, blocked on an unmerged implementation): the fourth run running.
  Prose in a role prompt, not enforced.
- **QA's first pass of round 1 named the merged patch, not a report**, so `quality-verified`, which reads "backed by a test report",
  lists the patch as its evidence; the pass on the report followed 31 s later and was skipped as already settled. The pass is real
  and the criterion text is looser than the evidence rule.
- **The developer committed `PATCH.txt` (15 KB, a transcription of its own patch) into the product root** in round 2 (`6168172`);
  the tech lead approved and merged it, the suite and the oracle are unaffected. Nothing in the mesh knows what belongs in a product
  tree.
- **The pm's review request named one document and described another** (08:48:46), which is what the tech lead acted on in P1.
  The mesh cannot know which a seat meant; P1 makes the consequence visible instead.
- **A `DesignSpec`, `ADR` or `DatabaseSchema` approved as `architecture` still evidences the criterion** (they are
  architecture-domain types; `markTypeKeyedCriteria` lists only `ArchitectureDocument` and `ApiSpec`, and a DesignSpec signed as
  `quality` evidences nothing, per `coord-design-spec.test.ts`). Unchanged: the same artifact answers to the word it was signed under.
- **One run.** L5 (no review was refused), B23, J1, J3, H1 and H2 are still to be confirmed live, and a clean launch on a network
  address (S1, S3) has not been run with real seats.

### Verification

| | tests | pass | fail | cancelled | skipped |
|---|---|---|---|---|---|
| head `9f80740`, before this round | 3387 | 3385 | 0 | 0 | 2 |
| this round, final (the test run: 3 min 34 s) | 3400 | 3398 | 0 | 0 | 2 |

`npm run typecheck` is clean and `npm run lint` has 0 errors (185 warnings, one rule, the baseline). Mutation checks on the new
tests, each reverted: P1 (the artifact's domain ignored: 2 tests fail; no note: 1; the note for same-domain approvals: 1; owed reviews
of any domain named: 1; reviews owed by others named: 1), P2 (the grace never applied: 1; ready without a report: 2; the mesh's own
criteria ignored: 1; no acceptor required: 1), P3 (never rendered: 2; rendered for every seat that has artifacts: 1). The 44 test files
that exercise the watchdog and the 32 that render a briefing were run on their own first.

### Worth keeping from this round

- **Evidence is half of a wake.** L3 put the report in the pm's briefing; the briefing still opened three minutes after the report,
  because nothing woke the pm. A fix to what a seat sees is not a fix to when it looks.
- **The word a seat types is not the artifact it means.** A capacity word picked which criterion a verdict closed; the criterion is a
  statement about the artifact, and the code's own comment said so. Two requests on one desk and one wrong id were enough.
- **A note that arrives after the turn cannot teach the turn.** L1's sentence was right and late: the pm's ops had already run. The
  same sentence belongs where the decision is made.
- **Build elsewhere while a mesh runs.** `dist/` stays untouched until the run ends (a rebuilt bridge under live seats is its own
  experiment); the fixes were compiled into a scratch output directory (`tsc --outDir dist-dev`) and tested there meanwhile.

## 16. The eleventh run, on the P-fixes build: four more findings (Q1–Q4)

The seventh cycle of the standing loop: the routine fired at 12:43 UTC on 2026-10-02. The same mission, SPEC, mesh config, model and
clean launch environment, on `main` at `8ebceab`: every fix of §0–§15 plus the change of the source licence to the Business Source
License 1.1 (the licence layer added nothing to the run: five seats, one project, no limit reported). Session 12:45–13:13 UTC: 43 turns,
855k billed tokens (about $3.74 at list price), every turn on `claude-haiku-4-5`, 840 events. One run, so the rates are illustrative.
The host ran on loopback with no token, as in §13 to §15.

| When | What | Result |
|---|---|---|
| 12:45 | `mesh run` | five seats start |
| 12:56 | goal met, 6/6 | 10 min 29 s, 25 turns, 509k billed (run 10's round 1: 13 min 23 s, 22 turns, 445k) |
| 13:02 | operator reopen quoting two defects and naming four criteria | those four and the `operator-feedback-…` criterion the reopen mints are UNSATISFIED |
| 13:03 | `kill -9` of the host 61 s later, with the developer and QA mid-turn | two seat processes orphaned (parent 1); none was left when the host came back 15 s later |
| 13:03 | restart | the two open turns closed as interrupted, 0 `agent.failed`, six budget reservations released, three seats woken for recovery and their sessions rotated |
| 13:13 | goal met again | 10 min 33 s after the reopen, 9 min 17 s after the restart; round 2: 18 turns, 346k billed |

**Quality** (the oracle of §2, written from the SPEC before any output was read): round 1 scored 2971/3049 raw (97.4%) and 3030/3034
stratified (99.9%): 95% in runs 8 and 9, 98.5% in run 5 (the oracle grew between runs, so the denominators differ). The `*`-as-a-list-item parse defect that held runs 1, 3, 4, 7 and 10 to about 68%
raw (§10 to §15) did not occur: `*,5` and `*/9,*` parse. Two other defects did. A day field that is a list containing `*` (`*,3`, `5-6,*`)
was treated as if it were exactly `*`, so the either-field day rule was not applied (73 failing cases); and `nextRun` threw "could not
find next run" for a schedule that can fire, but not for two years or more (`* * 29-31 2 *` after February 2030: 5 cases, and `0 0 29 2 *`
after March 2096 needs eight years, across 2100). The product's own suite was 44/44 and the CLI probes 23/23. The final product scored
**3049/3049 raw (100%) and 3034/3034 stratified (100%)**, its own suite 53/53, the CLI probes 23/23 (9/9 soft). That is 100% of a
mission that was told its defects, on one run: a measurement, not a rate. 23 of 43 turns (53.5%, 34% of billed tokens) changed no durable
state (run 10: 39% and 25%), 13 of 25 in round 1; eight of the 23 were woken by an INFORM (165k billed).

**Earlier fixes, checked live**:

| Fix | Live |
|---|---|
| P1 | held, and the slip it covers happened again: at 12:47:42 the tech lead signed as `architecture` on the RequirementsDoc, was told ("you signed as architecture, but RequirementsDoc … is a requirements artifact … Still waiting for your verdict: …"), and approved the ArchitectureDocument at 12:48:32, in the same turn (run 10: it sat UNDER_REVIEW 2 min 49 s). 0 derived approvals on a non-architecture artifact (run 10: 2) |
| P2 | **not exercised**: the grace needs a quiet mission with a submitted report to cite, and the report was a draft (round 1) or a turn was running (round 2). The pm's wake at 12:54:05, 28 s after the last turn, was the watchdog's no-op fast retry (below) |
| P3 | the hint was in 9 of the pm's 12 briefings (the three without had nothing citable). Two acceptances at 12:55:58–12:56:00 came from a turn that had read nothing and landed `ASSERTED`; the pm was told in the reply, read the report and accepted again within the same turn, 9 s later, `EVIDENCED` (run 10: 84 s and two more turns). The other six were `EVIDENCED`. The briefing's sentence did not stop the first unread acceptance; the reply did the teaching |
| L1, L2, L3 | 2 `ASSERTED` records, both told, none silent. 2 passes, none on a draft: the second (13:10:19) was on QA's own report and submitted it ("submitted with qa's own quality pass"); the first named the patch (Q1). 9 of the pm's 12 briefings listed what it could cite; one ask for a report after one was submitted (13:11:00, below) |
| L4 | the closing report said 509k and 25 turns after round 1 and 855k and 43 turns at the end; the analysis tool (855.2k) and `mesh usage` (855,194) agree to the token. `mesh usage` carried the note that the usage export is not part of the Community plan, as designed (warn mode, nothing refused) |
| B21, B22, M1 | the two open turns closed with "abandoned by server restart: the process ended before the turn did, so its spend was never recorded", six reservations released, the selective reopen completed, and `rejectedEvidence` refused the round-one report twice at 13:10:16 ("`library-contract-met` stays open: … is what the operator rejected when it reopened the mission"), each told to the pm. Five session rotations: three at the restart (80–95k tokens of transcript, under the 120k threshold), then QA's and the pm's by size |
| S1–S5 | 248 `mesh_*` calls from five seats through their signed bridges; 34 were refused or failed (14%), none for authentication: the mesh's own refusals (12 by policy, below) and contract-shape errors |
| L5, B23, J1, J3, H1, H2 | **not exercised**: neither of the two `review.reviewer-cannot-settle` refusals was the case L5's wording is for (the requester is itself the only settler); the two orphans of the kill had exited by themselves within 15 s; no seat wrote into the product checkout, no unclaimable task, no patch rejected |

| # | Finding | Now | Where it is pinned |
|---|---|---|---|
| Q1 | **A pass that named the patch left QA's own test report a draft.** QA wrote the report at 12:52:56 and passed the merged patch at 12:53:01; L2 submits the report a pass *names*, so the report stayed a DRAFT, shown to nobody and refused as evidence. The pm was nudged with nothing to cite (12:54:05), asked QA for the report's id, was refused twice for citing the draft (12:55:03, :04), asked QA to submit it and waited 35 s for QA's next turn; the goal closed at 12:56:09: **3 min 13 s of a 10 min 29 s round**, four turns and four messages that only moved one artifact from DRAFT to READY_FOR_REVIEW | a pass that names a patch (or nothing) also submits the giver's newest unsubmitted verification report of the pass's domain, for this mission, and says so | `tests/core/own-report-pass.test.ts` (16 tests, 9 new) |
| Q2 | **A verdict or an acceptance that named an artifact the mesh does not hold was told only that it was unknown.** The tech lead's `art-M3YBHXSZ` (13:07:11) and the pm's `art-M3YBS5TT003baedc135d` (the report was `art-M3YBNR4X00335635a833`), typed from memory into a request to QA and then into three acceptances in five seconds (13:12:48, :50, :53). Twelve across runs 7 to 11, each recovered by a later read, none told where the artifact was | the refusal names the route: for an acceptance the submitted artifacts it could cite (or that nothing submitted can yet, and to ask the owner of the report to submit it), for a verdict the reviews the seat owes. One helper shared with P1's note | `tests/core/unknown-artifact-route.test.ts` (7 tests) |
| Q3 | **A read of an artifact did not say where it stood.** `mesh_artifact_read` returned the text and nothing about the artifact's state, and a draft is the one status that changes what a reader may do with it. Round one's pm cited a draft it could have known was a draft; round two's asked QA, 41 s after QA's report was FINAL, to move it to review | the read carries `status`, `version` and `owner` on every page | `tests/integration/artifact-read-status.test.ts` (2 tests) |
| Q4 | **A refused review request said "no seat in this mesh can" for a report only its author could settle.** The pm asked the tech lead to review QA's report (12:55:54); QA holds the review capability and nobody else does, and QA's own pass settled it at 13:10:19. The refusal's own filter dropped the owner, beside `settlersOf`, which keeps it when no peer could review | the refusal reads `settlersOf`: it names "qa can", says "you can" to the owner that asks, and keeps the owner off the list when a peer could review | `tests/policy/review-routing.test.ts` (14 tests, 3 new) |

What each does and why is in `docs/runtime.md` (*What counts as satisfied*, the briefing paragraph) and `docs/protocol.md` (*Evidence for a
criterion*, the review-routing passage); the commit messages carry the evidence. Q3's first account was wrong and was corrected before it
was committed: the pm's one read of the new report came three seconds *before* QA submitted it, and its two later reads were pages of the
old round-one report, so a status field would not have changed round two's chase. It removes the learn-it-from-a-refusal loop of round
one for a seat that reads before it cites, which the acceptor's briefing now asks it to do, and that is what the commit says.

### Not fixed, and the honest limits

- **QA informed the pm before it passed.** Round two: QA's "verification complete" INFORM (13:10:13, with the report's URI as evidence)
  woke the pm six seconds before QA submitted and passed the report (13:10:19). The pm worked from a draft, asked QA to move it to review
  (13:11:00; the report was FINAL) and waited for QA's turn: 2 min 49 s from the pass to the pm's last acceptance. The order of a seat's
  ops is its own; Q1 and Q3 make the draft less costly, and nothing makes a wake wait for the sender's turn to finish.
- **The no-op fast retry fires after any no-op turn.** `stall_noop_retry_ms` (45 s) is armed by every turn that changed nothing, an
  observer's included, and bypasses the idle window: the tech lead's no-op turn (ended 12:53:20) put the nudge at 12:54:05, on a mission
  whose every seat was idle, 28 s after the last turn rather than 180 s. Here it was useful (the report was a draft that nothing else would
  have surfaced for another two minutes) and it woke the acceptor with nothing to cite. By design; recorded.
- **QA's task was completed before its work was done** (12:48:41 and 13:04:40, each right after planning, before any code existed to test):
  the fifth run running. Prose in a role prompt, not enforced.
- **The pm's session rotated three seconds before QA's pass** (129k tokens, over the 120k threshold), after a continuity write in its
  previous turn. The pm that then misread the report's state had lost its transcript; the rotation did what it is for.
- **Contract-shape and floor refusals**: `artifact.produce` with an extra property (`artifact_type`), and `ifUnanswered.afterMs` of 5000,
  15000 and 30000 under the mesh's floor (B4), each recovered by the next call, which the refusal's text made possible.
- **One occurrence of the Q4 refusal in the runs kept, no cost** (the pm went on to accept). Fixed because the comment on
  `mayReviewArtifact` promises one definition of who can settle and this was a second.
- **One run.** P2's grace, L5's wording, B23, J1, J3, H1 and H2 are still to be confirmed live, and a clean launch on a network address
  (S1, S3) has not been run with real seats.

### Verification

| | tests | pass | fail | cancelled | skipped |
|---|---|---|---|---|---|
| head `8ebceab`, before this round | 3404 | 3402 | 0 | 0 | 2 |
| this round, final (the test run: 3 min 34 s) | 3425 | 3423 | 0 | 0 | 2 |

`npm run typecheck` is clean and `npm run lint` has 0 errors (185 warnings, one rule, the baseline). Mutation checks on the new tests,
each reverted: Q1 (extension disabled: 6 tests fail; domain filter dropped: 1; owner check dropped: 1; newest-only dropped: 1; reply
note dropped: 3; runs even when the pass names a report: 1; submitted reports as candidates: 1; goal not checked: 1, after a first
version of the tests let that one survive), Q2 (acceptance route removed: 3; "nothing citable" always: 2; owed list removed: 3; asks of
every seat: 2; no cap: 1; settled reviews named: 1; domain filter dropped: 1, in P1's tests), Q3 (status removed: 2; version removed: 2;
owner removed: 1; status only on a read that fits one page: 1, after an equivalent first mutant that survived and was replaced), Q4
(the owner filtered out again: 2; the owner always counted: 6; nobody named: 8). The review-routing, cross-domain, paging, result-bound
and verdict-ledger suites that read the changed refusals and results were run on their own first.

The first full run of the finished tree failed one test, and it was Q1's doing: P2's "with nothing submitted to cite there is no early
nudge: a draft report is not proof" (`tests/lifecycle/acceptance-grace.test.ts`) published QA's draft and then passed the criterion
naming nothing, which now submits that draft, so the grace nudge fired. The code was right and the fixture had stopped describing
what its title says; the case now writes the draft *after* the pass, asserts it is still a draft, and still fails when `citableEvidence`
counts a draft as proof (checked by removing the exclusion). None of the suites run on their own beforehand was that one.

The next full run failed a different test, `tests/server/commercial.test.ts` "a single mesh prices /usage from the same host.yaml",
with the model's row missing, and ten reruns of its file passed. It was a race in the test and not in this round's code: the event
store makes an append visible in memory at once and writes the file after it, `/usage` reads the file, and the two cases that appended
and then asked for usage did not wait for the write. Delaying the queued write by 40 ms made both cases fail every time (2 of 13);
with `flush()` awaited they pass under the same delay. The server was left as it is (the lag is the write queue's, milliseconds, and
a day's aggregate does not need the last event). It is the second test caught racing the store's write queue by the full suite (§14's
T1 was the first).

### Worth keeping from this round

- **A rule keyed on the artifact a seat names misses the act next to it.** L2 submitted the report a pass names; the seat passed the
  patch and wrote the report beside it. The intent (my verification is done, here is the evidence) is what the rule has to follow.
- **A rule that does more on an existing act changes what old fixtures mean.** Q1 made a pass submit the draft beside it; a test built
  to show that a draft is not proof built exactly that pair. Grep the tests for the *act* (here a `pass` through `recordDecision`: five
  files), not only for the feature's name, before the full run, and treat a failing fixture as a question about the fixture first.
- **A flake you cannot reproduce by rerunning is a race you have not widened yet.** Ten isolated reruns of the `/usage` case passed; a
  40 ms delay in the event file's write failed it every time and named the cause. Delay the thing you suspect instead of rerunning.
- **A read returns content, and the one fact about an artifact that content cannot say is its state.** Everything else a seat needs to
  know about what it is about to cite is in the document; whether it can be cited is not.
- **Check the story before it goes in a commit.** The first draft of Q3's message said the pm "read the report three times". Its tool
  calls say once, three seconds early, and twice on the old report. The message and the test's header were rewritten before the commit.
- **Two definitions of one list, found because a message contradicted a later event.** "No seat in this mesh can" was followed, eleven
  minutes on, by a seat settling the artifact. Read refusals against the events that follow them.
- **The cheapest repair in a refusal is the list the briefing already prints.** Q2 added no lookup: `citableEvidence` and the owed asks
  were already computed for the seat's briefing, and the refusal had never been told to use them.
