# Curule — Runtime & Runtimes Adapters

## The supervisor pump

`packages/core/supervisor.ts` is deliberately thin: it owns process lifecycle,
scheduling, policy, budgets, termination, recovery, and event persistence — it
never makes architecture or implementation decisions. Each event drives:

```
event → interest match → policy → activation → runTurn → ops → new events
```

A single `runTurn`:

1. reserve agent + thread token budget (`budget.reserved`)
2. `agent.awakened` → `OBSERVING`
3. ensure the runtime session (start or **restore** the persistent session id)
4. build the agent context (§29) — **never** the whole transcript
5. `THINKING` → call the runtime adapter with a turn timeout
6. mark the mail the turn actually read as delivered (`message.delivered`)
7. apply the returned **mesh operations** (each re-checked by policy)
8. consume budget (`budget.consumed`, with model/tool-call audit for replay)
9. derive the end lifecycle (`WAITING` if it has an outstanding request, else
   `IDLE`/`BLOCKED`)

Steps 5 and 6 are in that order deliberately, and both halves matter. Mail is
marked delivered **after** the adapter returns, so a turn that crashes or times
out leaves the mailbox owed rather than emptied — a crash used to consume the
mail it never showed anyone. And it marks the messages the context builder
actually **rendered**, not everything that was queued: the context has a per-turn
unread budget (§29), so a deep backlog is drained over several turns instead of
being marked read in one. Delivered means *rendered and answered*; anything else
stays owed.

Every turn's inputs/outputs/model/tokens are appended to `logs/turn-audit.jsonl`
so the **orchestration** layer is deterministic and replayable even though the LLM
is not (§41).

Despite its extension that file is **not plain JSONL**. It is the supervisor's audit
log, and every line is `<ISO timestamp> <text>`: for a settled turn the text is a
JSON record; for everything else (`boot: released 3 budget hold(s)…`, `turn … for pm:
2/5 ops rejected`, `provider breaker: …`) it is a sentence, which may itself span
physical lines when it quotes a rendered artifact. Read it with `parseTurnAudit`
(`packages/observability`), which is what `curule ledger` does: it counts prose as normal
and reports only a stamped line that opens a JSON record and does not parse as
*damaged*. A reader that `JSON.parse`s every line fails on the first notice. The name is
kept because existing state directories, `curule ledger` and earlier notes already
use it.

### Turn deadlines

`scheduling.timeouts.turn_timeout_ms` is a turn's **budget**, not a kill switch.
The supervisor owns the deadline; the runtime adapter's own timer is only a
backstop past the ceiling (`turn_timeout_ms × 3 + 30 s`).

- A seat holding a claimed task gets the ceiling, `turn_timeout_ms × 3`, from
  the start, or from the moment it claims mid-turn.
- Any other turn that reaches its budget while still producing frames (a token
  or a tool call within `min(turn_silence_ms, turn_timeout_ms)`) is extended by
  that window and checked again, up to the same ceiling. A quiet one is stopped.
- A turn that goes silent — no frame for `turn_silence_ms` and no tool call
  still running — is interrupted by the silence watchdog, whether it ever
  streamed prose or only called tools.

The seat is warned, not just stopped. At the budget, and again shortly before
the ceiling (`ceiling − min(window, 5 min)`), the supervisor calls
`AgentRuntime.advise`. The Claude adapter delivers the note at the next tool
boundary as a PostToolUse/PostToolUseFailure hook `additionalContext`, telling
the seat to commit (`mesh_commit`), publish, and close with `mesh_done`. Seats
that can edit files are also told their budget and to work in committed
increments, in a `## Turn budget` section of every turn's prompt.

When a turn is stopped abnormally (timeout, silence, a live budget stop, a
runtime failure) with uncommitted files in its worktree, the worktree is
snapshotted to `refs/mesh/checkpoints/<agent>/<turnId>` — a commit built from a
temporary index, so the branch, the index and the files are untouched. The next
turn's `## Your previous turn did not finish` note lists the files and the ref.

While a turn runs, its record (`/turns/:id`, and a summary row on `/steps`)
carries `phases.deadlineAt` / `phases.ceilingAt`, `toolCallCount` (calls, not
frames), `liveTools` (the last 60 calls with their target and status),
`filesTouched`, `liveTokens` (from the adapter's cumulative `usage_update`
frames, which also feed the mid-turn budget stop), `advisories`, and, once
stopped, `checkpoint`. All of them survive a failed turn.

### A seat's worktree at the start of its turn

A worktree is a separate checkout, and a merge does not move it. In the second cronlite
run QA's worktree stayed at the commit it was created on while `main` moved twice; QA tested
that, found defects the merged code no longer had, and issued a `quality.block` on them,
twice: about 202k tokens and twelve minutes of a twenty-three minute reopen. Before each turn
(a handover turn excepted) the supervisor asks the workspace to `syncWorktree` the seat's
worktree. A clean one that is behind `main` and holds no commit `main` lacks is
fast-forwarded; files the seat wrote and never added do not stand in the way, and an
untracked file the incoming commit would overwrite is protected, not forced. The prompt then
carries a `## Your worktree` section, outside the tiered bundle like the other notes a
degraded tier must not lose, saying what was done, or exactly why not and how far behind the
seat is, with the way to bring it up to date (`git merge main`) and an instruction to name
the commit it checked. A current worktree, a seat with no worktree of its own (`pm` reads the
product checkout itself) and a sync that throws (one audit line, nothing else) add nothing to
the prompt. A mesh with no git workspace has no worktree to sync.

### What counts as a productive turn

A seat acts through **one** channel: the `mesh_*` MCP tools it calls mid-turn.
Each call runs on the live turn, against the same policy engine as any other op.
There is no prose channel — a fenced `mesh-json` (or any JSON) block in the
reply is text, is never parsed, and runs nothing. A turn is unproductive only
when its tool calls moved nothing.

A seat ends a turn with `mesh_done` (its one-line summary is what the mesh
records) or `mesh_wait` (with the reason it is blocked). A turn that made no
mesh tool calls at all is summarised as *"no mesh tool calls this turn"*.

The history is why this is counted by effects, not by any one call. When prose
ops still existed, judging a turn by its ops block alone scored the most
productive turns of a live run as empty: a seat that published three artifacts,
opened five threads and sent four messages through the tools, then closed
without an ops block, was logged *"no work was produced"* and took a strike.
Because three strikes park a seat, and the recovery path re-woke it, one seat
burned 537,479 tokens — 3.6× its configured budget — with every turn recorded
as having produced nothing.

`turn.discarded` records a turn that genuinely produced nothing, with its token
cost, under one of: `no_ops` (no tool call moved anything), `all_rejected`
(every op refused), `timeout`, `silence`, `budget_blocked`, `failed`. It is a
notice with no reducer — nothing projects from it — so it is safe to read as a
pure cost signal.

### The stall watchdog

A mesh has no main loop: between turns it is projections and an empty queue, and the only
thing that tells "resting" from "wedged" is the watchdog. On a timer (a third of
`stall_idle_ms`, between 100 ms and 30 s) it looks at a mission that is ACTIVE, with nothing
queued or running and the provider breaker not open, and wakes one seat with a note that
begins `stall watchdog: mission active but quiet — …`. Its gates, in the order they are read:

- **quiet**: `stall_idle_ms` (default 180 s) since the last turn ended **and**
  `stall_cooldown_ms` (default 300 s) since the last nudge. Both apply after a turn that
  produced work, whose ripple may still be landing; a turn that changed nothing (zero ops,
  every op refused, or only wait/done/remember) arms a retry after `stall_noop_retry_ms`
  (45 s) that bypasses both. A mesh that wants a tighter loop after productive nudges sets
  the cooldown at or below the idle window. A mission whose only open criteria close by an
  acceptance, with a seat that may accept and a submitted verification report to cite, is quiet
  after **a twelfth** of `stall_idle_ms` instead (15 s of the default 180 s), because nothing but
  that seat's turn is missing: the acceptor is nudged 15 to 45 s after the last turn rather than
  180 to 210 s (the ninth and tenth cronlite runs each sat 3 min 22 s to 3 min 23 s with the proof
  in hand, a quarter of a 13-minute round). The same twelfth applies to a mission whose every
  criterion is evidenced and whose only open item is a task its owner still holds (step 3 below): the
  claimant is nudged 15 to 45 s after the last turn, not 180 to 210 s, and a nudge sent before the last
  criterion was evidenced does not hold that first one back for the cooldown, because it was about another
  state (the thirteenth run's pm, a minute earlier, whose acceptances brought the mission to the finish
  line). A nudge sent after it is held as before, so a claimant that does nothing is not woken in a loop.
  The acceptance has the same rule. The sixteenth run's tech lead was nudged about a patch at 08:59:04.7,
  QA's report went FINAL at 08:59:20 and its turn ended at 08:59:27, and the pm, who could close the last
  two criteria, was nudged at 09:04:04.7: exactly five minutes after the nudge before, which had been
  about something else (the first tick past the 15 s window, 09:00:04.7, would have been four minutes
  sooner; the pm accepted both 16 s after it was woken). The watchdog dates the moment it first saw
  acceptance ready, on every tick and a turn in flight or not, and a nudge sent before that does not hold
  back the first one; a nudge sent after it is held as before.
  Anything else keeps the full window: nothing submitted
  to cite, a criterion the mesh evidences itself still open, only some other document, no seat
  that may accept.
- **worth waking anyone**, decided from state and never by a model: a patch stalled on the
  merge ladder, an unmet mandatory criterion, a rejected patch left open (below), unread mail, an
  open escalation or a claimed task. A mission with none of them rests, and closes itself.
- **the cap**: after three consecutive nudges that bought no work (or three the scheduler
  refused) it raises a `stalemate:stall_nudge_cap` escalation instead of a fourth, and rests
  until that card is answered.

Whom it wakes, the first that applies (seats the mesh parked or suspended are skipped):

1. a seat that can move a patch parked on the merge ladder. A patch under a BLOCK is not
   parked, it is held, and is not listed: the policy refuses its next rung until a new
   version exists, so the nudge would buy a refusal. Two exceptions, both from the fourteenth
   run. When every unmet criterion closes by an acceptance and a report an acceptance could
   cite has been submitted (the state that shortens the idle window, above), nothing waits on
   the parked patch, and **the seat that may accept is woken first**, with its own note
   (`the acceptance is yours to give`) instead of the patch's rungs: QA passed at 00:55:55 with
   the CLI patch MERGEABLE, the first nudge went to the tech lead, who could not move it, and
   the pm, who could close both criteria, was woken 4 min 25 s later by the unread-mail sweep.
   And a seat whose previous nudge bought nothing is skipped here as in every step below, so a
   patch its merger cannot move does not draw every nudge to the cap while the seats that could
   do something else are never woken;
2. **the owner of a rejected patch the mission is waiting on** (`openRejections`; see *A mission does
   not complete over a rejected patch*, below): a CodePatch a reviewer rejected that is REJECTED, or
   reworked to DRAFT and not resubmitted. Only its owner can move it, and nothing else tells them: an
   approval of a rejected patch moves nothing, and a broadcast wakes nobody who did not subscribe to
   one. A patch back in review or on the merge ladder is not the owner's move (reviewers and the
   merger have it), so it is not a reason to wake the owner. A seat whose previous nudge bought nothing
   is skipped here when another seat can be tried. The note says what holds and the owner's two moves:
   `The mission cannot complete while a rejected patch is left open: CodePatch "cli" is REJECTED
   (owner dev): dev reworks it (a new version with asVersionOf, then a review request) or, if it is
   abandoned, moves it to DRAFT and then to ARCHIVED.` With every criterion evidenced it takes the place
   of "reply with a single `done` op and stop — the mission will close itself", which would be false;
3. **the claimant of a task that is all that keeps a finished mission open.** With every mandatory criterion
   evidenced, no rejected patch left open and no escalation open, the one thing the verdict is waiting for is a task
   its owner has not completed (`liveClaims`, in `termination.ts`: CLAIMED, and the owner's `activeTaskId` still
   points at it; a claim its owner has moved on from is residue, to the watchdog as to the verdict). Only the claimant
   can complete it (`mesh_task_complete` for another seat's claim is refused: "task claimed by developer"), and a seat
   that finished its work and is waiting does not hear that it is the last act. In the thirteenth run the pm accepted
   the last two criteria at 20:56:00 and the developer, asleep on its claim, was woken 77 s later by the unread-mail
   sweep; the watchdog's own next nudge was due at 21:00:47 and would have gone to step 6, the architect with an unread
   broadcast. The note says every mandatory criterion is evidenced, names the task (`"Implementation: …" (task-…)`)
   and the tool that closes it, with a summary of what landed; to any other seat it says whose act it is. A seat whose
   previous nudge bought nothing is skipped here when another seat can be tried;
4. **while a mandatory criterion is unmet, the seat that can lift a standing BLOCK.** The two
   holds lift differently. A block *on an artifact* holds it until a new version exists
   (`active-block`), which only its owner can publish and which drops the record; the
   blocker's own later pass releases nothing. A block on a *subject* with no artifact (QA's
   `quality`) sinks that seat's earlier sign-off in every gate that names it until the same
   seat signs off again, so only the blocker can lift it. One hold per seat, subject and
   artifact: blocking again restates it. A pass that names a report is that sign-off: a verdict
   naming an artifact is filed under `artifact:<id>`, and the record keeps the subject it was
   given as `domainSubject`, so QA's pass on `quality` with its test report attached lifts QA's
   own block on `quality`, as the gates already read it. (In the twelfth run it did not: QA
   passed with its report at 17:00:25, the block still read as standing, and this step, which
   comes before the acceptors, woke QA, who had passed and cannot accept, instead of the pm. The
   pm accepted 3 min 11 s later, when the unread-mail timer reached it; in the second round
   5 min 13 s later.) A seat whose previous nudge bought nothing is skipped
   here when another seat can be tried;
5. **when every unmet mandatory criterion is one the mesh does not evidence from its own
   events, a seat that may accept it.** A criterion outside `AUTO_EVIDENCED_CRITERIA` (and any
   the operator's reopen mints, `operator-feedback-…`) closes by `approve subject:"criterion:<id>"`
   from a seat holding `requirements.accept` or `requirements.approve`, and by nothing else. The
   acceptors come oldest activity first, and one whose nudge just bought nothing gives the next to
   another seat. With any auto-evidenced criterion also unmet this step is skipped: the work that
   would evidence it is still to do, and who may accept is not yet the question;
6. a seat with unread mail or a claimed task (the first in config order);
7. the WAITING or BLOCKED seat with the oldest activity;
8. the startup seats, then any live seat.

The note says what holds, since when, who can lift it and how (for a block on a subject:
re-verify the *current* product, bring the worktree up to `main` first, then pass the subject
or block again and say what is still wrong), ahead of the generic "drive the next step". The
same sentence is on the stall-cap card as `standingBlocks`, and the stalled mission's reason
reads `N mandatory criteria unmet (held by qa's BLOCK on quality)`. A mission whose criteria
are all evidenced is left alone whatever a block record says.

In the second cronlite run QA's block stood for ten minutes of nudges to the tech-lead, the
pm and the developer, none of whom could lift it; the driver was "whoever has mail", which
returned the first seat in config order that had any, and a block that targets the operator
puts mail in nobody's box.

To an acceptor the note says the acceptance is its own to give and how (`mesh_approve` with
`subject: "criterion:<id>"` and the artifact that proves it), and lists up to three submitted
artifacts it could cite: verification reports first, never a draft, never one the operator already
rejected for that criterion, never a report `recordDecision` would refuse (see *Evidence for a
criterion*, in `docs/protocol.md`). With nothing submitted it says the proof is what is missing and
to ask the seat that can produce it. To any other seat it names who can accept and says to put the
proof in front of them. A mesh in which no seat holds the gate says only the operator can close
what is left. The stall-cap card carries the same facts as `awaitingAcceptance`, and the criterion a
reopen mints says who accepts it, where it used to say only "published and accepted".

The list is not only the watchdog's to offer. A seat that may accept criteria finds the same artifacts in its
**briefing**, for as long as a mandatory criterion that needs an acceptance is open, each marked "submitted: you may
accept a criterion that is still open against it" (`relevantArtifacts[].citable`). A test report is work-scoped, and a
briefing shows a work-scoped artifact to its owner, to whoever is mailed it and while it awaits a verdict, so once QA's
pass had settled the report nobody else's briefing carried it. In the ninth cronlite run the pm and the architect spent six
turns and four minutes asking for a report that sat submitted in the store (each ask declined: "test reports are QA's"), and
round two idled for three minutes with three criteria open that only the pm could close. A criterion the mesh evidences itself
(`AUTO_EVIDENCED_CRITERIA`) needs no acceptance and offers nothing; what the operator rejected at a reopen is not offered
again. Under the list the briefing says, once, that what a seat cites has to be read in the same turn
(`mesh_artifact_read`): an acceptance from a turn that read or ran nothing is recorded `ASSERTED` and does not count. The pm
in the ninth and tenth runs accepted without reading, was told only afterwards (the reply of the call), ended its turn, and
needed a second wake to read the report and accept again (84 s and two turns in the tenth run's second round); the pm's role
prompt says the same. The read says what it read: `mesh_artifact_read` returns the artifact's `status`, `version` and `owner` beside `canSettle`, on
every page, so a seat that reads a report in order to cite it learns that it is still a DRAFT, and whom to ask to submit it, from
the read and not from a refusal.

The fourth cronlite run's second round sat on one such criterion for 21 minutes, 12 turns and 188k
tokens: the nudges went to the architect (twice), which asked the developer for a status and set
off a chain of turns that never reached the pm, the only seat whose act it needed. The pm, once
woken, had written "awaiting operator acceptance testing": it did not know the act was its own.

### A mission does not complete over a rejected patch

The termination verdict completes a mission when every mandatory criterion is evidenced, no
escalation is open and no claimed task has its owner on it. It also waits for a patch a reviewer
rejected: when `implementation-merged` is among the goal's mandatory criteria, no CodePatch of the
goal may be REJECTED, nor have been rejected and not yet reached MERGED or ARCHIVED (`openRejections`,
in `projections-helpers.ts`; the verdict, the watchdog and the merge note all read that one function).
A rejected patch that its owner reworks and resubmits is still listed until it lands, because
"resubmitted and unmerged" is the same hole one step later.

The sixth cronlite run's developer put the library and the CLI forward as two patches. The tech-lead
rejected the CLI twice (the patch repeated the approved library's `src/index.js` and `package.json`),
merged the library, and `implementation-merged` closed on that merge. A minute later it approved the
CLI patch, which moved nothing: REJECTED has one edge out, to DRAFT, and it is the owner's. Nothing woke
the developer (the broadcast that said so woke nobody). The pm then accepted `cli-contract-met` on a QA
report whose first lines read "CLI Commit: cd6615a (pending merge)", and the mission completed with no
`bin/cronlite.js` on the product branch.

What it does: the merge still evidences `implementation-merged` (an earlier design withheld the evidence
until nothing was outstanding; it needed a way to give it back, and after a reopen a later archiving
could have re-evidenced from a merge of the round the operator had rejected); the goal simply does not
complete, `opMerge` tells the merger in a note on its result ("the mission cannot complete yet, because
CodePatch "cli" is REJECTED (owner dev): …"), the watchdog wakes the patch's owner (above), and the
stall-cap card carries the same sentence as `openRejections`. The mission completes when the patch has
merged, or its owner has withdrawn it: REJECTED goes to DRAFT and then to ARCHIVED, and the sentence a
seat is told names both moves because the machine allows no direct edge.

What it does not hold: a patch that was never rejected, in whatever state. The same run's second round
ended with a patch parked MERGEABLE whose work had gone in with another one, and whose merge was
refused as "nothing landed"; a gate on every patch in flight would have turned a clean finish into a
card for the operator. The cost of the rule that remains is one tidy-up: a patch its owner abandoned
without archiving (that round's old CLI patch, left REJECTED when the CLI was resubmitted under a new
name) holds the mission until the owner closes it, which the note says how to do. Whether a patch was
rejected is read from its history; after a snapshot restore the history is the current record alone, so
a reworked patch reads as one that was never rejected and the guard does not apply to it. A guard like
this one fails open.

### What a seat is told about its tools

A seat is told to call only the tools its manifest carries, because a client that checks a name
against the `tools/list` it was given refuses any other before the call leaves the machine
("No such tool available"), and Claude Code is one. `toolAdvertised`
(`packages/protocol/src/tool-visibility.ts`) is the one statement of which tools a seat is shown:
the MCP manifest filters through it and the briefing leaves out of its prose whatever
`hiddenToolsFor` says the manifest leaves out (`AgentContextBundle.hiddenTools`, per seat). Under
`bus.vocabulary: contracts` that is `mesh_send`, `mesh_respond`, `mesh_broadcast`, `mesh_request`,
`mesh_request_review`, `mesh_research_request` and `mesh_escalate`; in any vocabulary it is also
`mesh_merge` for a seat without `git.merge`, `mesh_veto` without a veto authority and
`mesh_decision_ratify` without `architecture.approve`. A seat without `git.merge` is told who merges
instead of being told to call `mesh_merge`, and the briefing says in one line which tools it does not
have and that a call to one fails at once and reaches nothing.

"Who" is a name. The line used to say "a seat that holds `git.merge`", and the sixth run's developer
read it as "someone senior": it asked the architect to merge its MERGEABLE patch twice, the pm asked the
architect a third time, and the architect declined in so many words ("I lack git.merge capability")
while the tech-lead, which held it, was the one nobody asked; the patch landed 3 min 38 s after the
first ask. `buildAgentContext` now lists the other seats that hold the capability
(`AgentContextBundle.mergers`, only for a seat that cannot merge itself): "being merged by lead, which
holds `git.merge` — you do not, and have no merge tool: ask lead once the patch is MERGEABLE, not a seat
that cannot merge", "lead or release, which hold …: ask one of them", and in a mesh where no seat holds
it, that the operator lands a MERGEABLE patch and a peer asked to can only decline.

The refusal never reaches the mesh, so no op result records it. The end-of-turn note does: "not in
your tool list, so these calls never reached the mesh and did nothing: `mesh_send` x2 (use
`mesh_call` to ask, `mesh_reply` to answer, `mesh_announce` to tell)", in the turn's notices and in
the seat's memory of the turn. It is not counted against the circuit breaker; the seat was failed by
its briefing first. 14 of the fourth run's 370 tool calls were such calls (seven `mesh_send`, three
`mesh_respond`, two `mesh_merge` from a developer who cannot merge, one `mesh_broadcast`, one
`mesh_request_review`, which the pm then waited on); runs 1 and 3 had 8 of 434 and 14 of 567.

### Testing a patch

A CodePatch is a recorded commit: `metadata.commit`, shown on its line in the briefing as
`commit <sha>`. A seat that can review a verification report (`test.write`, `security.review`) is
told to test that commit, with `git merge --ff-only <sha>` in its own worktree (or
`git checkout --detach <sha>`), and not to re-type files from the patch text. A transcription is
not the commit, and the untracked files it leaves stop the turn-start fast-forward of the worktree.

The mesh records what it can. A verification report (TestReport, SecurityReport, BenchmarkResult)
published by a seat carries `metadata.worktree`, written by the runtime and never by the seat
(whatever the seat supplies under that key is dropped): the worktree's HEAD, how many files were
dirty and untracked, and for each CodePatch the publishing turn read that records a commit, whether
the worktree holds that commit (`git merge-base --is-ancestor`, `WorkspacePort.containsCommit`).
The run report marks a delivered report whose tree did not hold the commit of the patch it read:
"it tested a copy of the patch, not the recorded commit". Dirtiness alone is recorded and not
flagged; an untracked report or test log is the ordinary state of a verifier's tree.

The commit the report itself names (`metadata.commit`) is checked the same way and stamped as
`claimed`, because a verifier is handed the commit by its briefing and never has to read the patch, so
`tested` is empty for exactly the seat the rule is about. When the tree does not hold it, the reply to
the publish says so while the seat can still act on it: *the report names commit `7fa5fa27a36c`, but its
worktree is at `f2d8bc9c45f7` and does not hold that commit, so what it describes is `f2d8bc9c45f7`, not
`7fa5fa27a36c`. Check the commit out … run the tests again and publish a new version; or, if
`f2d8bc9c45f7` is what you tested, name that commit.* The report is published either way and nothing is
refused (the seat may have tested what it says by other means, and git cannot place every value a seat
writes: no answer is recorded for one it cannot). The run report adds "names commit …, but was written
from a worktree at … that does not hold it" unless it has already said the same of that commit's patch.

The twelfth cronlite run's QA is the case: it named `7fa5fa27` (243 of 243 pass), ran the tests in a
worktree at the scaffold's commit `f2d8bc9` (233 of 243 fail), published the report, blocked `quality` on
it three seconds later, and the tech lead rejected a good patch; the developer re-versioned the same tree
twice (the commit merged at 16:59:40 holds exactly the files of `7fa5fa27`), after the patch had stood
MERGEABLE at 16:56:34.

What the verifier tests is in its prompt (`roles/qa.md`, *What to test, and what the report says*), because nothing in
the mesh can know a contract's cases: derive them from the contract and not from the developer's tests or the examples it prints;
test an enumeration member by member in every spelling the contract allows, a form in every place it is allowed and combined with
the others, and every rejection with a near-miss that must be accepted; and write what was *run* (the command and its output),
listing what was not under NOT TESTED and what only the developer's suite covers as theirs. The fifteenth cronlite run's QA ran
the developer's 51 tests, eleven CLI commands and eight library checks and listed every behaviour of the contract as verified,
among them case-insensitive names, tried with `JAN` and `MON`; the library refused `JUL` and `WED` as Quartz syntax, the defect of
the runs of sections 8, 9, 14, 17, 19 and 20 of the notes, each of which QA had passed. Whether the section changes what QA runs is
for the next live run to show.

### A handover's continuity call

A handover turn exists to write one record. When `write_continuity` lands the supervisor ends the
turn under the client, to save the model calls that would follow, and the client then reports the
call it never got a result for as rejected. The turn record and the turn audit say the call
completed when the mesh's own op result says it landed (`settleContinuityCalls`), one call per
landed write; before, all 13 handovers in the recorded runs were audited as failed beside the
`continuity.recorded` event that said otherwise.

What the handover spent is booked from the stream when the abort's own frame says nothing. The CLI
answers an abort with a `result` frame whose usage can read zero for a call that was billed in full:
six of the eleven handovers of the ninth to fifteenth cronlite runs booked 0 tokens, the developer's of
the fifteenth for a call that wrote 14,826 and read 139,638 tokens of cache. The adapter takes the figure
the frames carried (`abortedUsage`) when the abort's reads zero, for a handover, an interrupted turn and
a timed-out one alike; a frame that reports anything is the figure, and a turn no frame measured stays
unmeasured rather than free.

### A commit announces what it changed

`mesh_commit` classifies the diff of the commit into `dependency.changed` (a manifest: `package.json`, `pom.xml`,
`build.gradle`, `requirements.txt`, `go.mod`, `Cargo.toml`), `authentication.changed` and `authorization.changed`, and the
seats whose `interests` name them are woken. The diff the workspace returns is the cumulative `main...HEAD` diff of the seat's
branch, so a file an earlier commit touched is in it again, unchanged, for every commit after it; read whole, a manifest created
once announced a dependency change at every later commit. The fifteenth cronlite run woke its architect at both of the developer's
commits for the same `package.json` hunk (7.1k and 9.6k tokens, and the second began a chain of status mail of 47k), and runs 8 to
13 woke it once or twice each for a project that has no dependency. The commit now reads only the file sections the version it
replaces did not already have: a section that is the same in both diffs is not news, one that changed (a dependency added to the
manifest) or is new is, and a previous version that cannot be read (or is prose, not a diff) hides nothing. What the classification
looks for inside a section is unchanged, and so is its crudeness, with one exception: a `package.json` that the diff creates and that
names no dependency (`dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies`, `bundleDependencies`,
`bundledDependencies`, `overrides` or `workspaces`, an empty one counting as none) is not a dependency change. A created file is whole
in its section, so it can be read; the seventeenth cronlite run's architect was woken once more for exactly such a manifest (7.2k
tokens, and nothing came of it), as it had been in runs 8 to 13 and 15. A changed manifest (its section is a few hunks of a file it does
not show), text that is not JSON, any other manifest kind and a dependency-free manifest's other readings (`authentication.changed`,
`authorization.changed`) are classified as before.

### When a mail wake is paid for

Mail buys a turn three ways: the wake the send path makes when it arrives (stashed behind the
running turn when the seat is busy), the retry `notifyTurnFinished` makes when a turn ends with mail
still unread, and the stale-mail floor (`STALE_MAIL_MS`, 240 s) for mail nothing else woke the seat
for. Two rules keep them from charging for the same thing twice.

**A broadcast the seat did not subscribe to is not a reason to run, at any of them.** An
announcement obliges nobody, so the send path wakes only the seats whose `interests` match
`message.sent`. The wait sweep left broadcasts out of its count, but the retry asked `defersMail`,
which knew a message's delivery class and the seat's own `wake` policy and not this gate, so a
broadcast that landed in a busy seat's box was a wake when its turn ended. The gate now lives in
`defersMail` (below the escapes that cannot be overridden: an ask the seat owes, operator mail, work
moved to the seat), which the send path, the sweep, the retry and the redundant-observation check
all read. The announcement is still delivered, is read on the next turn the seat takes, and is what
the floor wakes it for when it takes none. A seat that wants announcements as they are made lists
`message.sent` (or `message.*`) in its `interests`. The fifth run's seats announce with
`mesh_announce` (a broadcast when it names nobody), and 16 of its 42 mail wakes were headed by one.

The words a seat reads say it. `mesh_announce` was "say something that obliges nobody to answer; omit
`to` and every seat hears it", and the briefing added that it "costs no one a turn"; both read as
delivery. The sixth run's seats announced what one seat had to act on (a rejected patch, a blocker) to
the whole mesh, and the one seat that could act was not woken. The tool description, the `Common tools`
line and the contracts paragraph (and `mesh_broadcast`'s, on a typed mesh) now say that an announcement
wakes no one, that a seat reads it the next time it takes a turn, and that what a seat must ACT on is a
`mesh_call` (or a targeted ask), which does wake it.

**A wake is for mail the seat has not been handed.** Mail that lands mid-turn reaches the follow-up
turn by two routes, the stash and the retry, and `notifyTurnFinished` has two owners (the
supervisor's `finally`, then the pump's); the second ran after the first had started the follow-up
turn, found the mail still unread (a turn drains its box when its model call returns) and stashed
the wake again, to be replayed after the turn had read the mail: a third turn, for an empty
mailbox. At dequeue, beside `isStaleWake` for an ask that has closed, a `message` wake is dropped
when the seat has no mail left that a wake could be for (`wakeableMail`: unread, less what the seat's
own `wake` policy and the gate above defer), and counted as `stale_mail` in `suppressedWakes`
(`GET /scheduler`). Not dropped: an explicit or operator wake, a `message` wake that cites no
message the mesh holds (the supervisor starting a worker on a task), and one whose note is more than
the scheduler's own (a merged runtime notice is news the mailbox does not hold). Comparing each mail
wake with the turn that had already been handed its message, the recorded runs had 16 of 64 (run 3),
9 of 42 (run 4) and 17 of 42 (run 5): 160k of 1.51M, 98k of 1.03M and 190k of 1.23M billed tokens,
and nine of run 5's seventeen ended in `wait`, `done` or nothing.

**A wake is for a mission that is still running.** After the end a seat may only read and remember
(`MISSION_OVER_ALLOW_OPS`), so a turn started then buys a context window to be refused its `done`
("mission is COMPLETED"). `notifyTurnFinished` already refuses to requeue an agent's deferred mail after
the end; the queue itself did not: a wake that was waiting for a slot when the mission ended ran when one
freed. At dequeue, beside the two drops above, a wake is dropped when the mission is COMPLETED or FAILED
and it is not an operator's (`isMissionOverWake`), and counted as `mission_over` in `suppressedWakes`.
Not dropped: an explicit or operator wake, `manual`, `recovery` (what a reopen starts) and a `message`
wake for the operator's own mail. The mail stays in the box. In the thirteenth run the developer's INFORM
to the architect (21:11:38) waited behind `max_active_agents: 3`; the pm's last turn freed a slot at
21:12:14, eight seconds after the goal completed, and the architect's turn cost 9,795 tokens and was
discarded as `no_ops`.

## Runtime adapter interface

```ts
interface AgentRuntime {
  start(agent, ctx): Promise<AgentSession>
  send(session, input): Promise<AgentOutput>   // AgentOutput.operations: MeshOp[]
  interrupt(s) suspend(s) resume(s) stop(s) getStatus(s)
  restoreSession?(agent, sessionId, ctx)       // persistent session across crash
}
```

`AgentOutput.operations` is the vendor-neutral contract: an adapter only needs
to produce typed mesh ops. This is how Claude Code, custom HTTP agents, and
future A2A agents all plug in without touching the domain model.

### `runtime-opencode` — **removed**

There is no OpenCode adapter. The package is gone, and a config naming it fails
to load with `runtime 'opencode' was removed; <keys> still names it` — caught at
load rather than at activation, because an unregistered runtime name otherwise
resolves fine at boot and fails on the first turn, long after the mesh looked
healthy. Use `claude` (no separate install: it rides on the declared
`@anthropic-ai/claude-agent-sdk` dependency) or `stub` (zero model calls).

The transport it used — `opencode serve` on a local port, health-gated on
`GET /global/health` — is therefore not part of any adapter in this repo. What
survives from it is the interface above, which it was the first implementation
of.

Note: *which* bus tools an adapter is handed is a property of the mesh, not of
the adapter. `tools/list` is filtered per seat -- by the agent's capabilities
and by `bus.vocabulary`, which under `contracts` replaces
`mesh_send`/`mesh_broadcast`/`mesh_respond` with the contract verbs
(`mesh_call`, `mesh_reply`, `mesh_announce`, …). The filtering is
advertisement-only on the SERVER: `callTool` resolves a name against the unfiltered map, so a caller
that names a hidden tool on the wire still gets it. A client that checks a name against the list it
was handed never gets that far, and Claude Code refuses the call on the spot, so for a Claude seat a
hidden tool is not there. See *What a seat is told about its tools* below and `docs/configuration.md`
§ bus.

### `runtime-claude`
- Claude Code via `@anthropic-ai/claude-agent-sdk`, a declared dependency that
  drives the Claude Code binary as a child process. **There is no `claude serve`**
  — no local HTTP API, no SSE, nothing to health-probe — so there is no port to
  gate on and no process to attach to. The SDK ships its own executable, so
  there is nothing for the user to install and nothing to preflight
- one **long-lived streaming `query()` per agent**, held for the agent's
  lifetime. Streaming input is not a preference: SDK control requests
  (`interrupt()`, `supportedModels()`) are only supported on a streaming query,
  so a per-turn one-shot could not implement `AgentRuntime.interrupt` at all
- each mesh turn is one `SDKUserMessage` pushed into that query's inbox; a
  single pump loop demultiplexes the `SDKMessage` frames back into per-turn
  state (`assistant` → tool calls, `stream_event` → live token deltas,
  `result` → turn settled)
- liveness is the CLI's `system`/`init` frame rather than a health endpoint.
  `query()` is lazy — nothing spawns until the generator is pulled — so `start`
  and `restoreSession` wait for that handshake (`startupProbeMs`, default 10s)
  before reporting success. A backend that fails to spawn surfaces as a labeled
  `BackendUnreachableError`; one that is merely quiet is given the benefit of
  the doubt
- capabilities become a `canUseTool` callback rather than a static permission
  block: the same capability set, but an unmapped tool **fails closed** instead
  of falling through whatever the config happened not to mention. Capability
  aliases are resolved, so `code.write` grants edit tools
- token accounting reads the per-turn `usage` only —
  `input + output + cache_creation`, with `cache_read` **excluded**.
  `total_cost_usd` and `modelUsage` are cumulative across a streaming session,
  so billing a turn off them would re-charge the whole conversation every turn
- a **usage guard**, always on, corrects a backend that drops its cache report.
  Behind a translating proxy (2026-09-26), a seat's calls began reporting
  `input_tokens` = the whole prompt and `cache_read_input_tokens` = 0 mid-turn,
  while the proxy logged cache hits on the same calls. 55 such calls billed 6.41M
  phantom tokens in 13 minutes, and the ledger, the live counter and seat
  parking all acted on them. A call is re-attributed when it meets all three
  conditions: both of its cache terms are 0, the prompt the evidence names was at
  least 8,000, and its own prompt is at least that large. That evidenced prompt
  is then billed as `cache_read` and only the remainder as `input`. The evidence
  is the previous call's prompt (`input + cache_read + cache_creation`) when the
  call has one **within its turn**, and — for a turn's **first call** — the
  previous **turn's** final prompt of the same session, which the adapter records
  per session as a measurement and reads back through
  `mesh.runtime.stale_after_ms`: the window that already says how long a session
  may idle before its cache is assumed cold. That window is the only one; a
  prompt measured through the live proxy was still 94% cached upstream after a
  10-minute idle gap (2026-09-27), so a turn boundary is not by itself a cold
  cache. The record belongs to the session, so a rotation — which opens a fresh
  session — starts with none, and so does a session's first turn. A shrunk
  prompt, a call reporting any cache term, and `output` are never touched. The
  adapter applies the move before `usage_update` frames leave it, so the live
  figure, the settled `turn_end` figure and the ledger agree. Rotation sizing is
  unchanged, because the move does not change a prompt's size. To recognise it:
  the audit log carries one `claude runtime: <seat>: usage re-attributed …` line
  per seat session, and the adapter's `turn_end` (and `send` output) carries
  `usageGuard`, which holds `adjustedCalls`, `reattributedTokens`,
  `firstCallAdjustments` (how many of those calls were a turn's first; absent
  when none were) and the `raw` versus `adjusted` totals. A backend that truly
  never caches is under-billed by the guard, and the audit line is how you would
  spot one
- the mesh MCP bridge is wired through the SDK's `mcpServers` option, the same
  `curule mcp` stdio bridge the other adapters spawn. A bridge that is not
  connected in the `init` frame is read as a **startup race before it is read as
  a mute seat**: the CLI settles that status once, as the query starts, so the
  adapter tears the query down and respawns it — up to 3 times, waiting 1s, 2s
  then 4s (7s in all, against a `turn_silence_ms` window of 300s and a ceiling
  of `turn_timeout_ms × 3`) — and retries the whole turn on the new query: same
  mesh session id, same input, same armed deadlines. A query that was a resume
  is re-resumed, so the seat keeps its transcript; one that was a fresh start
  gets a fresh id, having nothing to lose. If the bridge is still down after the
  budget, the turn fails with exactly the message it always did, and only then
  does `onMuteSuspected` fire — a transient retry is not a mute seat. The
  `turn_end` carries `bridgeRespawns` when any spawn was spent, and the audit
  log carries one `claude runtime: <seat>: the mesh MCP bridge was not up at
  init …` line per seat session, which is what tells a race from a real failure.
  A `pending` bridge — the CLI's non-blocking connect still dialling — is not
  down, and costs no spawn and no delay
- **an end-of-turn reminder for a seat that stops without calling the mesh**
  (`endOfTurnHooks`, a `Stop` hook). A turn that ends with no `mcp__mesh__*` call
  reported nothing to anyone, whatever it did: text outside a mesh call goes
  nowhere, and the supervisor discards the turn as `no_ops`. The hook blocks that
  stop **once**, with `NO_MESH_CALL_REMINDER` as the reason, and the model carries
  on in the same turn and session (same cache; the turn's usage is the sum of both
  rounds). It is a hook for the reason `advise` is one: a message pushed after the
  stop is a second user turn to the CLI, answered with a second `result` frame,
  and the pump settles the mesh turn on the first. The reminder says what the seat
  could not know — that the mesh is running and its tools work — and names the tool
  that reports each kind of result. Why it exists: in the seventeenth cronlite run
  a `kill -9` of the host left the CLI's record `failedMcpServers` (`mesh bus
  unreachable: fetch failed`) in two seat transcripts, QA's and the developer's,
  written at the second the host died; the ten other seat transcripts carried
  none. After the restart both seats resumed with it and neither made a mesh call:
  QA did a full verification with its own tools (41.5k tokens; by its own count a
  regression file with 39 of 44 subtests failing) and ended on "Awaiting mesh
  recovery … The mesh bus is currently unavailable (`fetch failed`)", having
  called nothing; the developer did the same for three turns (151k tokens), typing
  "Now I'll call the mesh operations:" and the calls themselves as prose, and its
  first mesh effect came 10 min 52 s after the reopen, from the fresh session a
  rotation gave it. The tools were not gone: a resumed copy of such a
  transcript, given a live server, called them. Scope: only tools of the `mesh`
  server count (not another server's, not a bare `mesh_done` from a seat's own
  shell); once per turn (`endReminded`, and the CLI's own `stop_hook_active`, so a
  stop another hook already continued is never blocked again by ours); and never
  for a turn the mesh is itself ending — interrupted (a deadline's abort is one) or
  closed through `endTurn`. An operator's own `Stop` hooks run beside it. Checked
  with the real CLI and a stand-in `mesh` server that has the real tool names: a
  fresh seat session told to "reply OK, call no tool" made no mesh call without
  the hook (2 of 2) and called mesh tools with it (2 of 2), for about 2k more
  tokens. That instruction was chosen to be the opposite of the reminder, so it
  shows the block works and is obeyed, not how often a real stuck seat complies.
  The role prompts end every
  seat's turn with `mesh_done` or `mesh_wait`, and the seventeenth run's first
  round (23 turns) had none that ended without a mesh op, so a healthy run pays
  nothing for it
- **a bound on one `mcp__mesh__*` tool result**, applied where the payload is
  produced rather than where it arrives. Over the 2026-09-27 skill-panel run the
  five read tools (`mesh_artifact_read`, `mesh_inbox`, `mesh_query_events`,
  `mesh_failures`, `mesh_run_status`) returned 3.0M of the 3.1M characters the
  whole `mesh_*` surface produced: p90 20k-40k per call, a 52k worst case, and
  no `mesh_failures` or `mesh_run_status` result under 11k. A result that size is
  not paid once — it stays in the prompt for every later call of the turn
  (~20 measured) and every later turn of the session until a rotation. The mesh's
  own MCP handlers now page their rows under `TOOL_PAGE_CHARS` (8,000 characters)
  and return a continuation: `nextOffset` for the row-per-item reads (inbox,
  events, steps, artifact reads) and a `section` index for the aggregate ones
  (failures, run digest, run status). Measured after the change, on live-sized
  fixtures: inbox 47,462 → 6,737 characters, event query 44,611 → 7,826, artifact
  read 43,701 → 7,834, and every message, event, artifact byte and section row is
  still reachable by paging. A page of an **artifact** ends at a line, not at the
  character budget: at the last newline in its second half, else hard at the budget
  (never between the two halves of a surrogate pair), and `nextOffset` is always where
  the shown text ended. The second cronlite run's CodePatch was cut at character 22,800,
  between `test('…', (` and `) => {`; the tech-lead read all four pages and rejected the
  patch as "final test is incomplete" although its stored body was whole (the digest
  matched), and a rejected artifact cannot be approved again, so one misread seam cost a
  review-merge cycle (about 290k tokens over the stretch that followed). The `read_artifact`
  op, which pages at 60,000 characters, cuts the same way.
- **Do not try to bound this in the adapter.** A `PostToolUse` *callback* hook in
  a headless (`--print`/stream-json) session cannot rewrite a tool result: the CLI
  harvests exactly `systemMessage`, `worktreePath` and `decision:"block"` from a
  callback's return, dropping `hookSpecificOutput` whole. Command, HTTP and plugin
  hooks do receive `updatedToolOutput`/`updatedMCPToolOutput`; callbacks do not.
  The adapter-side clip written on 2026-09-27 was inert for exactly that reason —
  325 mesh results, none clipped — and was removed. Reinstate it only with a live
  demonstration that the CLI in use honours it.
- **a `## Reading` brief in the system prompt** (`withReadingDiscipline`,
  appended beside the shared output-voice rules and written into `ROLE.md` for
  the same reason those are). Growth in a turn's prompt is spread over its
  calls — measured median +1,285 tokens per call, p90 +5,659, top 5% of calls
  only 30% of the total — so no bound on one result reaches it; how the seat
  reads does. The SDK's `Read` returned 2.79M characters over 114 calls in that
  run, 24,485 per call, each re-sent with every call after it. Five lines:
  `grep -n … | head` to locate, `sed -n 'a,bp'` to read the range, never re-read
  a file you already have, and cite paths rather than pasting contents
- no `reasoning` token field (Claude's usage has none), and the system prompt is
  snapshotted at a session's first request, so mid-run `ROLE.md` edits land only
  after compaction
- **a seat's shell may not land work on the product branch.** `git.merge` is a
  capability: the `merge` op enforces it and the `patch.merge` gate, and records the
  landing (`patch.merged`, the MERGED transition, `implementation-merged`). A seat
  with a shell could run the same `git merge` in the product checkout from Bash and
  none of that applied. In the cronlite run the developer, which held no `git.merge`,
  ran `cd <workspace>/main && git merge mesh/developer` and the product branch moved
  49 s before the tech lead's proper `mesh_merge`, with nothing on the log; in the next
  run it also tried `git push -f origin mesh/developer:main`. For every Bash call of a
  seat in a git mesh the permission gate now reads the command text and refuses the
  half of that boundary it can state without a sandbox: **git commands that run in the
  product checkout may only read it** (status, diff, log, show, …; a `branch`/`tag`
  only as a listing), and **`git push` needs `git.merge`**. It follows `cd`, `git -C`,
  `--git-dir`/`--work-tree`, `GIT_DIR`, `bash -c`, `eval` and `$(…)` (to a depth of 4),
  and splits on unquoted `;` `&` `|` and newlines. A directory the text cannot resolve
  (a variable or a substitution) is refused **only for `git merge`**: the seat's own
  worktree is the common, legitimate target of `cd "$(git rev-parse --show-toplevel)"`,
  and a blanket refusal would fail every such commit to catch the one move this exists
  for, so any other git subcommand run in an unresolved directory is allowed. The one
  expansion it can place is the directory it is already tracking: `$(pwd)`, `` `pwd` ``,
  `$PWD` and `${PWD}`, alone or opening a path (`$PWD/..`), resolve against it, so
  `cd "$(pwd)" && git merge main` in the seat's own worktree is the ordinary work it is
  (the second cronlite run's developer, told its worktree was behind, wrote exactly that
  and was refused). The same spelling in the product checkout is the product checkout, so
  a `git reset --hard` after `cd "$(pwd)"` there is refused as itself. `$PWD` is unknown
  once the command has assigned it, and any other expansion (another variable,
  `$(dirname …)`, a glob) stays unknown. A git
  command in the seat's **own** worktree is untouched (merging `main` into its own branch
  is ordinary work), and so is everything that is not git. The supervisor hands the
  product checkout's path to the adapter as `RuntimeContext.productPath`; a mesh with no
  git workspace has none, and no gate. **It is a text-level gate**: it stops the move a
  helpful model makes by reflex, not a seat determined to get around it, and shell
  writes (`cp`, a redirection) into the product checkout are a different boundary that
  is **not** drawn here (the file tools' is, next). Nor is a seat's shell confined to its
  worktree at all: the seventh run's developer staged its product's `package.json` in
  `/tmp/package.json`, and QA a report in `/tmp/test-report.md`, from Bash. A stray
  `package.json` there changes how Node reads every `.js` file under `/tmp` (this one said
  `"type": "module"`, and it is how thirty of this repository's own tests failed: they now
  write their stub children as `.cjs`)
- **the file tools may not write into the product checkout either, and what lands there
  anyway is set aside before a merge.** The seventh cronlite run's developer, its
  session resumed after a `kill -9`, edited `src/index.js` and `test/index.test.js` by
  the absolute path of the product checkout (thirteen `Edit` calls, twelve of them
  landed) instead of its own worktree's, then committed the same fixes in its worktree
  and got the patch approved. The product checkout held changes on no branch, `git merge`
  refused to run over them ("Your local changes to the following files would be
  overwritten by merge") and failed six times, and the seats spent nearly eight minutes and two
  escalation cards asking one another to commit changes that were not theirs: the merger
  has no write tool, the owner saw a clean worktree of its own, and the operator reset
  the checkout by hand. Now `Edit`, `Write` and `NotebookEdit` are refused when the
  target resolves inside the product checkout (a relative spelling, `..`, a file or
  directory that does not exist yet, and a symlink into it are all resolved first), and
  the refusal carries the route: write it in your own worktree, commit it there, let the
  merge land it. A seat whose own directory *is* the product checkout (a mesh without
  worktrees) is not held to it. The `merge` op does not rely on that gate being
  watertight: before it asks git to merge it **sets aside** whatever tracked files are
  uncommitted in the product checkout (`git stash create`, pinned as
  `refs/mesh/product-set-aside/<time>`, then `reset --hard`; untracked files are left
  alone), lands the reviewed commit on a clean checkout, and tells the merger what it
  found as a caveat on the landing (which files, the ref, `git show <ref>:<path>` to read
  them back) and in the audit log. Nothing is removed that was not saved first, and a
  set-aside that cannot be made does not stop the merge. A merge that still fails over
  files "that would be overwritten" says the files are in the *product* checkout and not
  in any seat's worktree, that no seat can clear them, and that the operator can
  (`git -C <main> status`): git's own "your local changes" had sent the seats to the
  wrong place
- **seats a dead mesh left running are stopped, not resumed alongside.** Each seat is a
  long-lived `claude` child holding a streaming session. SIGKILL or an OOM kill takes the
  mesh process and leaves the child, reparented to init and still mid-turn, still
  calling the API, its spend recorded nowhere (measured: still going 56 s after the
  kill), while the restarted mesh resumes the **same** session id, so two CLIs can
  write one transcript. The adapter stamps every seat it spawns with the pid of its
  host (`CURULE_HOST_PID`, inherited by whatever the seat started; seats started before
  the product was renamed carry `AGENT_MESH_HOST_PID`, which is still read and never
  written). Before the
  first seat of a new process starts, the adapter scans `/proc/<pid>/environ` of the
  processes it may read, and sends SIGTERM, then SIGKILL after a 2 s grace, to those
  whose stamp names a host that no longer exists, reporting the ones it stopped (and
  any it could not) as an `orphan_seats_reaped` adapter notice. **Linux only**: there is
  no cheap, reliable way to read another process's environment elsewhere, so elsewhere
  it does nothing. A pid that has since been reused by an unrelated process reads as a
  live host and is left alone, which fails safe: a leak persists, nothing innocent
  dies. The spend of an orphaned turn is stopped, not recovered
- **what the launching machine lends a seat.** The SDK loads every filesystem settings
  source unless told not to, and a mesh started from inside another Claude Code
  session inherits that session's environment, so a seat ran under the launching
  user's hooks, allow rules, `env` and model, and its CLI reported the outer session's
  id and effort. `mesh.runtime.isolate_host: true` spawns seats with
  `settingSources: []` and without the launching session's variables: every one that
  begins `CLAUDE` except the few that authenticate or route the CLI, and
  `MAX_THINKING_TOKENS` (credentials, routing and proxy variables are kept). It removes
  the namespace rather than a list of names because a container's Claude Code session
  exports dozens of them, among them its messaging token, its session-ingress token file
  and its debug switch, and a seat's shell inherits the CLI's environment; the named list
  it replaced took out ten of 56. Without the key, the boot log says what would leak
  (naming the first few and counting the rest, with the credential-looking ones apart) and
  names the key; with it, the audit log records what was removed. See
  `docs/configuration.md` § `isolate_host`

### `runtime-http`
- generic custom/remote agents over `POST /sessions`, `/turn`, `/interrupt`, …
- used to attach Codex/A2A, or any agent, behind an HTTP shim (Claude Code no
  longer needs one — see `runtime-claude` above)

### `agent-runtime` `StubRuntime`
- deterministic scripted agents; powers the unit/integration tests, the
  simulation engine, and the token-free `curule bench` comparison

## Recovery & replacement

A crash emits `agent.failed`; the logical identity, session pointer, active task
and artifacts survive. On restart the runtime re-activates the agent with a
`recovery` reason and rebuilds context from the projections (never from lost
process memory). After N failed restarts the mesh escalates `runtime_failure`.
A worker instance can be replaced (new `runtime session`) while the organizational
role, authority, task, artifacts and threads are inherited (§50–51).

### A process killed mid-turn

SIGKILL, an OOM kill or a lost machine ends a mesh between writes the log expects to
come in pairs. Boot cleans up what a pair left open, event-sourced so replay
reproduces it, and idempotent so a later boot finds nothing to do:

- **The turn is closed and counted.** A turn the log shows as begun and never ended is
  closed with an `agent.state_changed` to `IDLE` (note `turn abandoned by server
  restart`) **and** a `turn.discarded` with reason `interrupted` and no `tokens`: what
  the dead turn spent was recorded nowhere, and absent means unmeasured, never zero. A
  view of discards or spend used to hold a turn that began and never ended.
- **Its budget holds are released** (boot step 8b'). A turn takes its holds (seat,
  mission, thread) before it calls the model and gives them back, consumed or released,
  in the `finally` that ends it. A process that dies between the two leaves a
  `budget.reserved` the projection replays as live forever: after a SIGKILL mid-turn the
  tech lead's ledger read `reserved: 17094`, and so did the thread's and the mission's,
  with no turn running, and each crash left one more turn's estimate of headroom
  unspendable until the mission was reset. Every hold still open at boot belongs to a
  turn the old process never finished (nothing is running yet), so each is released as a
  `budget.released` from `recovery-manager` with the reason `abandoned: the process that
  held it ended before settling it`. **Released, not consumed**, because a figure
  invented here would be billed as fact. The audit log gets one `boot: released N
  budget hold(s)…` line.
- **The seat CLIs it left behind are stopped** before any new seat starts (`runtime-claude`,
  above).

A *deliberate* stop is not reported as a crash. When the mission ends (or an operator
shuts the mesh down) the in-flight turns are stopped by the mesh itself, and their
`turn.discarded` detail reads `stopped by the mesh shutting down[ after the mission
ended] (…)`, without the `the server process may have crashed — check that it is still
running` hint the runtime appends to a genuine backend loss: on a normal end of mission
that hint sent the operator looking for a failure that never happened. The seat's
memory note says the same. Completion waits for the in-flight turns to settle (up to 30 s)
before it retires the seats and stops the scheduler, so the teardown does not race its own
agents.

### Provider outages: the mission-wide breaker

A turn the model *provider* refuses is not the seat's failure, and does not walk
the seat's ladder. `classifyProviderOutage` (`protocol/src/errors.ts`) reads the
failure the runtime surfaced: an `API Error` segment from the model client (the
Claude adapter carries the CLI's line verbatim) whose status is 429, 402,
401/403 or 5xx — or, with no status, says `overloaded`, `usage limit`, or
`Connection error` (the proxy is down) — plus the HTTP runtime's own status line
and provider error types such as `rate_limit_error`. Our own timeouts and
aborts, a `BackendUnreachableError` (a seat's own process or endpoint), a 4xx the
seat's request caused, and any model or tool text that merely mentions a status
stay seat failures.

An outage turn is discarded and billed as usual, but the seat goes back to IDLE:
no crash strike, no released task, no discharged asks, no SUSPENDED park, no
per-seat card. Its retry is queued seconds later, and the failure is reported
to the scheduler as `noteTurnOutcome(seat, "outage")`, which feeds the
mission-wide half of the scheduler's circuit breaker (never the seat's strikes):

- **Trip**: `PROVIDER_TRIP_FAILURES` (3) outage failures from any seats within
  `PROVIDER_TRIP_WINDOW_MS` (2 min) open it. While open, activations still
  queue — nothing is lost — but the pump dispatches none of them (queue wait
  kind `provider`); explicit operator wakes still run. One advisory
  `provider_unavailable` card (conflict key `provider:<goal>`) names the verbatim
  error, the refused turns and seats, and the next attempt.
- **Half-open**: after the backoff (`providerBackoffMs`: 5, 10, 20, 40, then 60
  min) exactly one queued turn is admitted as the probe; the supervisor wakes a
  seat if none is queued. A probe that ends without a verdict (budget refusal,
  timeout, a seat's own crash) passes the slot to the next queued turn.
- **Close / re-open**: the probe's model answer closes the breaker, the card is
  retired with `escalation.auto_resolved`, and the held queue drains. Another
  outage re-opens it with the backoff doubled, and the card is restated in place
  (`escalation.requested` with its own id) with the new next attempt.
- **Operator**: answering the card probes immediately (`probeProviderNow`).

Every transition writes one `provider breaker:` audit line. The breaker never
starts a stopped scheduler: a parked mission's probe waits for the operator
like every other non-explicit wake. Seats already parked the old way are still
revived by an escalation answer (`reviveTerminalSuspended`).

## Termination & deadlock

Termination manager (§33): success (all mandatory criteria evidenced), budget,
wall-clock, `max_events`, stalemate and runtime failure → `COMPLETED`/`ESCALATED`
/`FAILED`. Deadlock detector (§34): thread-depth, repeated-conflict fingerprint,
and review-round overflow generate a `DisagreementRecord` artifact (positions,
evidence, attempts) and raise a human `ESCALATE`. The manager's own verdicts are
attributed to `termination-manager`, not to the operator (`docs/protocol.md` § `actorId`).
A run report read off a mesh that was stopped mid-mission (goal still `ACTIVE`, no
termination reason in the log) says so — `Stopped before the goal was met` — rather than
that the build has no phrasing for `goal_active`.

### What counts as satisfied, and what a reopen withdraws

`criterionSatisfied` is the one definition, shared by the termination verdict, the
criterion-removal guard and the watchdog's diagnosis of why a mission is stuck, so they
cannot disagree: a criterion is satisfied when it is `WAIVED`, or `EVIDENCED` **and**
its evidence belongs to the round it has to be satisfied in.

`ASSERTED` is not `EVIDENCED`. A criterion a seat claims from a turn that **checked**
nothing stays `ASSERTED`, and an unproven mission stays open. What counts as checking is
deliberately narrow: a completed tool call that touches the world outside the mesh (a
shell, a file read, a test runner), or the one `mesh_*` tool that reads an artifact's
content (`mesh_artifact_read`). Every other `mesh_*` call is how a turn *acts* (send,
publish, approve, merge), and counting those would make the gate self-satisfying: "I
approved it, therefore it is verified". A failed call, such as a permission-gate denial,
ran nothing and does not count. Reading the artifact used to count for nothing, so a
tech lead that read a whole artifact twice before approving it produced a criterion
accepted blind and then accepted *again* after a token-cheap `ls` — five extra PM rounds
in the cronlite run.

**The seat is told when its verdict did not close the criterion.** The gate used to say nothing to the
seat it downgraded. A `mesh_approve` `pass` (the verdict that evidences `quality-verified` and
`security-verified`) from a turn that checked nothing was recorded `ASSERTED` and answered `ok`; an
acceptance told the seat of `ASSERTED` but not of a refusal. Both now carry a `note` on the call:
`recorded as ASSERTED, not EVIDENCED … in the turn that gives the pass`, and, for an artifact the
operator rejected when it reopened the mission, `'<criterion>' stays open: <uri> is what the operator
rejected … publish a new version (asVersionOf) or a new artifact that answers the rejection, and give
the pass on that` (an acceptance is told to cite). A repeat pass from a turn that did check is the
repair, so it is not told that a second signature "changes nothing", and a settled report is not told to
"move it to review first" when it has no such move. In the eighth cronlite run a QA seat's unchecked pass
left `quality-verified` open with no word of it; the tech lead asked for a second pass on the round-one
report instead, and the mission completed five and a half minutes later on a verdict about the product as
it stood before the fix.

A pass also names the artifact it was about, when that artifact is submitted work, so the reopen gate
below (which compares artifact URIs) can refuse the same artifact twice: it was blind to a verdict that
carried none.

**A pass submits the verification report its giver wrote.** Passing the report one has just published is the commonest
pass there is, and a draft is shown to nobody but its owner, is refused as evidence and cannot be settled by a verdict, so
the pass used to leave the report where nobody could see or cite it: five of the nine passes in runs 6 to 9 were given on
a draft, each on the test report QA had just written, and the ninth run's pm and architect spent six turns asking for one
that existed. A `pass` on a DRAFT `TestReport`, `SecurityReport` or `BenchmarkResult` that the giver owns now moves it to
review first, as the owner's own transition under the same gates and only after every refusal a pass can meet, so a refused
pass leaves the report as it was; the pass then settles it and names it as above. A pass on a draft somebody else wrote
submits nothing (when its work is put forward is the owner's to say) and names none; a draft of any other type is left
alone. A draft passed again after a reopen is not caught by identity, and still has to be recorded after the reopen.

**The pass need not name the report.** The eleventh cronlite run's QA wrote its test report (a DRAFT) and passed the merged *patch*
five seconds later, so the rule above did not apply and the report stayed a draft. The pm, nudged with nothing to cite, asked QA for
the report's id, was refused twice for citing the draft, asked QA to submit it and waited for QA's next turn: 3 min 13 s of a
10 min 29 s round. A `pass` that names a patch, or nothing, now submits the newest verification report the giver has written for
this mission and not submitted, of the type that settles the pass's domain (a `TestReport` or `BenchmarkResult` for `quality`, a
`SecurityReport` for `security`), and the reply says it did. Only the giver's own (its owner decides when its work is put forward),
only the newest (an older draft is an attempt the seat abandoned), only this mission's, and only after every refusal a pass can
meet. A pass that names a report keeps the rule above for that report and submits no other; a report published *after* the pass is
not caught, because the pass is the trigger.

**A reopen names what it rejects.** `POST /mission/reopen { reason, criteria? }` sends
the named criteria (every mandatory one when `criteria` is omitted after a verdict) back
to `UNSATISFIED` and stamps each with `withdrawnAt`: the round they must now be satisfied
in starts there, and evidence recorded before it belongs to the attempt the operator
rejected and no longer counts (otherwise a reopen is answered by re-approving the same
artifact and the mission re-completes within a tick: one live mission ran six completes
and five reopens that way). A criterion the reopen did **not** name keeps its verdict and
its evidence — there is no `withdrawnAt` on it, so nothing newer is demanded. The
predicate used to compare every criterion's evidence against the goal-wide `reopenedAt`
(`Goal.reopenedAt` is still stamped, as *when*), so a mission reopened on three of seven
criteria could never complete: all seven `EVIDENCED`, goal `ACTIVE`, nothing left for
anyone to do (cronlite 2026-09-30). An `ESCALATED` mission was halted by an open card and
never judged, so reopening it withdraws only the criteria it names (none, when it names
none) and answers the cards. A state snapshot written before `withdrawnAt` existed is
migrated on import: a criterion of a reopened goal that is still `UNSATISFIED` or
`ASSERTED` is stamped with the goal's `reopenedAt`.

## State & persistence

Local v1: `events.jsonl` (canonical, append-only) + JSON snapshots + filesystem
artifacts + git worktrees, with an optional `node:sqlite` event index. The
architecture keeps no authoritative state in process memory, so the same kernel
can later run against PostgreSQL + object storage + a distributed bus without
changing the protocol.

The seat prompts the Claude adapter writes (`.mesh/agents/<seat>/ROLE.md`,
`MESH_CONTEXT.md`) live inside the working tree, so the product repository's
`.git/info/exclude` names `.mesh/` (appended once; an adopted repository's own
`.gitignore` is never rewritten), and the commit path stages with `git add -A` and then
unstages `.mesh`. Before that, a seat's `git add -A` committed the seat prompts to `main`
and the delivered tree shipped them.

`curule status` reads the mission's progress from the criteria themselves: progress is a
projection of the acceptance criteria, so a restored state rebuilds it on import instead
of reporting `null` (0%) on a completed 6/6 goal until the next criterion moved.

With no server to ask, `curule status` replays `logs/events.jsonl` through the projections the server keeps, with the function behind
`GET /status` (`missionStatus` in `packages/core/src/status.ts`), so a mission that finished reads `[COMPLETED]` at 100% with its tokens,
a reopened one `[ACTIVE]` again, and a seat's tokens are what `curule usage` bills (a turn's spend is booked on the seat's ledger and on
the mission's, and counted once). A line of the log the projections refuse is skipped and named on stderr; the figures may then be off by
what it carried. Before this the command read the goal as `goal.created` first wrote it, and printed `[ACTIVE]` at 0% with no tokens
line for a mission that was over, and about 2.4 times the tokens a seat had spent.

The live `GET /status` adds `runtimes`: the runtimes the seats run on, sorted and without repeats (`["claude"]`, `["stub"]`). The console
words its "Start the mission?" confirmation by it. Starting warns that agents "spend tokens" unless every runtime listed is `stub`, which
makes no model call (the shipped demo); a server that does not send the field is read as spending.

## CLI / server / dashboard

- `curule run mesh.yaml` boots the supervisor live (scheduler on, startup agents
  fire), starts the HTTP/SSE server and (on a
  TTY) the TUI. `curule serve`/`up` is live + dashboard without the TUI.
  `curule console mesh.yaml` (alias `ui`; or `run --parked`) serves the same
  dashboard/API with the scheduler **parked**: no startup, interest or timer
  cascades run on their own. Operator actions still work — a manual *wake* runs
  exactly one turn (step the mesh agent by agent), `POST /messages` with
  `wake:true` (the dashboard's "wake after send" checkbox, on by default while
  parked) sends mail and steps recipients in one action, and
  `POST /mission/start` (the ▶ button, idempotent) flips the console live in
  place. `POST /mission/park` parks it again.
  `curule status|graph|events|agents|inspect|replay|pause|resume|approve|reject|respond|artifacts|budgets|escalations`
  talk to `/api`.
- A `curule run` that reaches a verdict (completed, failed or escalated) prints its report **after** the turns still running
  have settled, and says so on a line of its own first ("letting the turns still running finish, then the report"). The
  verdict used to be reported the moment the goal changed, while the turn that changed it (the pm's last acceptance, as a
  rule) was still running, so the `SPEND` line was short by that turn in every run: 2.2% to 2.6% against the ledger and
  `curule usage`, which agree with each other to the token. The report is printed whether or not the shutdown went cleanly,
  and an interrupted run (Ctrl-C) still reports first, because whoever pressed it is waiting.
- `curule host` supervises one child per registered project. Each child's mode is
  remembered **per project**, taken from the mode that child reports on its
  heartbeat — the host only ever proxies `/mission/start` and `/mission/park`,
  so the child is the only process that knows which mode it is in. Opening or
  restarting a project re-spawns its child in that remembered mode, which is
  what stops an operator restart from silently parking a live mission; a project
  nothing is known about still launches in the host's own default (`--live`, or
  parked). A park the host itself applied — the aggregate spend ceiling or the
  turn cap — is remembered the same way, so a restart does not walk back over
  the limit that parked it.
  A child parked while its goal is ACTIVE is the one state that reads as a
  running mission and runs nothing: `/status` carries `parkedNotice` (rendered
  as a banner with a **Start** button by the console), `POST /goals/:id/resume`
  returns it as `notice` on an otherwise normal 200, and the host prints the
  same sentence on its own stderr when it sees that state on a heartbeat.
- The host also watches liveness: a child silent past `heartbeat_timeout_ms`
  (`host.yaml`, 60s) on two consecutive polls is stopped and restarted with
  backoff. The window is wide because the cost is asymmetric — killing a working
  project costs its in-flight turns, killing a wedged one late costs nothing but
  a stale tab. Every such decision, and every crash and breaker trip, is
  appended as one line to `<project>/.mesh/host-supervision.log` and printed on
  the host's stderr, so a kill that used to be visible only in a rotated child
  log is durably recorded.
  The line also carries the child's **own** verdict on its event loop:
  `eventLoopLagMaxMs=` is the worst lag the child measured since it started,
  taken from the last beat it managed to send. Silence alone cannot separate a
  loop blocked by synchronous work — which comes back on its own, and whose
  in-flight turns are exactly what killing it destroys, as happened on
  2026-09-28 — from a process wedged for good, and those two want opposite
  responses. The field is **absent**, never zero, when no beat carried one: "it
  never told us" and "its loop was fine" are different facts. What it cannot
  show is a block that began *after* the last beat, so it is read together with
  `silenceMs`, never alone. The child samples its own lag on a 1s timer and
  reports it on the 2s beat; the same numbers are on `GET /health` as
  `eventLoopLagMs` / `eventLoopLagMaxMs`.
- `curule init` templates `runtime: default: claude`. There is no PATH probe for
  it and there should not be: its executable ships with the SDK, so a check
  would fail on a working install. `curule run` needs no backend preflight to
  print guidance about.
- `curule emit-schemas` regenerates `schemas/*.json` from the code (single source).
- `curule bench` runs the mesh-vs-single comparison across the A–F corpus.
- `curule mcp` is the internal stdio↔HTTP bridge, spawned by the Claude adapter
  (`runtime-claude` registers it as the `mesh` MCP server) to reach `/api`.
- The dashboard (`apps/mesh-dashboard`) renders five views from the same event
  projections: mesh graph, goal progress, artifact timeline, cost, live event
  stream (SSE) — the UI holds no separate state.
