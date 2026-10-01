# cronlite live run on Haiku — 2026-09-30: what it found, and what was fixed

Status: **FIXED** on branch `claude/exciting-gates-n75s1z` (one commit per finding or theme over `e9a361b`, each
with its own regression test). One live mission, two rounds, one crash; every finding below was either reproduced
with no model or traced to a line. Open items, and the things a fix deliberately does not do, are in §6. A rerun on
the fixed build then found eight more (N1–N8), fixed the same way: §8. A fourth run on that build found
five more (F1–F4, M1), also fixed: §9.

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
