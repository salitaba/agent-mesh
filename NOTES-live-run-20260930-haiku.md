# cronlite live run on Haiku — 2026-09-30: what it found, and what was fixed

Status: **FIXED** on branch `claude/exciting-gates-n75s1z` (one commit per finding or theme over `e9a361b`, each
with its own regression test). One live mission, two rounds, one crash; every finding below was either reproduced
with no model or traced to a line. Open items, and the things a fix deliberately does not do, are in §6. A rerun on
the fixed build then found eight more (N1–N8), fixed the same way: §8.

Requested: *"run a real mesh with a real goal with the haiku model and monitor it and find bugs of system and
check quality of output of mesh"*, then *"fix all problems"*; for §8, *"ok now rerun again and check quality and
bugs"*, then *"fix them all"*.

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
