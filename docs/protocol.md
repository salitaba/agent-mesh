# Curule — Protocol

Protocol version `1.0`, carried on every message and event. The protocol is
runtime- and vendor-independent.

## Message envelope (`schemas/message.schema.json`)

```jsonc
{
  "id": "msg-…",              // unique, prefixed id
  "protocolVersion": "1.0",
  "type": "REQUEST_REVIEW",   // one of the canonical message types
  "timestamp": "…ISO…",
  "goalId": "goal-…",
  "from": "developer",
  "to": ["architect"],        // array; broadcast fans out through the bus
  "threadId": "thread-…",     // thread = goal + artifact + interaction
  "replyTo": "msg-…",         // optional; resolves the pending request
  "causationId": "evt-…",     // optional; links to the event that caused it
  "artifactRefs": [ { "uri": "artifact://CodePatch/pay/2" } ],
  "payload": { "question": "Is this idempotency design acceptable?" },
  "control": { "cacheServed": false },  // RUNTIME-OWNED — see below
  "priority": "NORMAL",
  "requires": [],             // optional structured requirements
  "budgetHint": { "maxTokens": 50000 },
  "provenance": { "source": "agent", "trustLevel": 50 }
}
```

### `payload` is prose; `control` is authority

`payload` is verbatim agent output. The kernel therefore **must not route on
it**: any control decision keyed on a payload field is a decision the governed
agent gets to make for the runtime. `control` is the closed, runtime-owned
counterpart — stripped from every inbound send by
`sanitizeAgentMessageInput`, and closed in the schema so a forged field fails
validation rather than being silently ignored.

This is not hypothetical. `cacheServed` used to live in `payload`, and both the
delivery reducer and the scheduler skipped a message carrying it — so a sender
could attach `payload: { cacheServed: true }` to its own REQUEST and get an ask
that opens a pending request (parking itself in `WAITING`, recording a debt)
while landing in **no mailbox** and waking **nobody**. A guaranteed permanent
stall from one key in free-form JSON.

The same principle governs loop detection: message identity is computed from
the typed envelope (participants, act, artifact refs, task/thread) plus only
those payload fields the runtime itself branches on. Hashing the prose made
`fingerprint_loop` defeatable by rewording — which is the one thing a language
model does reliably and unprompted.

### Private plans

Beside the shared task board, each agent keeps its own ordered checklist for
the single task it has claimed (`plan`, `plan_step`). It is private by design:
the task board is the inter-agent contract, and a second claimable surface
would give two agents two different answers about who owns what.

A `plan.updated` event always carries the **whole** plan, never a delta, so the
reducer is a replace and any replayed prefix of the log is a coherent
checklist. Nothing ever clears a plan when the agent changes task — staleness
is decided at read time by comparing `plan.taskId` against the agent's
`activeTaskId`, which keeps replay and snapshot restore in agreement.

Step ids are resolved in the supervisor (hashed from the step text when the
model omits one), for the same reason every other id is: a reducer must be a
pure function of the log. Hashing also makes a restated identical plan
idempotent, so `plan_step` references from the previous turn keep resolving.

A seat that plans without ids is never told them (`plan` answers ok and nothing
else), so `plan_step` also takes the step's **number**, counted from one, when no
step has that id: a literal id always wins, and a number past the end, zero, a
decimal or a word is refused with the steps listed as `1) <id> — <text>`. All seven
of the fifth run's developer's `plan_step` calls were `"1"` to `"7"`, each refused
with a list of hashes.

### Message types (kept deliberately small)

`MISSION INFORM REQUEST REQUEST_INFO REQUEST_REVIEW REQUEST_ARTIFACT
REQUEST_RESEARCH REQUEST_EXECUTION PROPOSE CHALLENGE APPROVE REJECT VETO BLOCK
DELEGATE HANDOFF PATCH_READY TEST_RESULT SECURITY_FINDING COMMIT ROLLBACK
ESCALATE WAIT DONE`

An ask opens a *pending request*; a reply carrying `replyTo` closes it. This is
what lets an agent go to `WAITING` and be woken on the response, instead of
blocking on a call — messages are **not RPC**.

Which messages are asks is **two conditions, not one**, and the single
predicate that answers it is `obligesRecipients` (`protocol/src/catalog.ts`):

1. the **type** creates a debt — a `REQUEST*` name, `ESCALATE` or `CHALLENGE`
   (prefix-matched, so a new `REQUEST_*` name is obliging without an edit); and
2. `control.mode` is `"service"` (the default when absent).

The same `REQUEST` type therefore obliges **nobody** under `mode: "broadcast"`
or `mode: "collab"`. A broadcast addresses every seat, so an ask would open one
entry owed by the whole roster and the first reply would leave everyone else
owing an answer nobody was tracking — an announcement is not an ask. A collab is
bounded by its own clock rather than by a per-recipient debt. Read off
`control`, never `payload`: a sender able to set its own obligation band could
promote its chatter above everyone else's real asks.

### A thread has an ending

A thread is a conversation: `goal + artifact + interaction`. It is minted
`OPEN`, and it reaches `RESOLVED` or `ESCALATED` — a thread opened by an ask
ends when its **last** ask leaves the ledger, which is the one place in the
runtime that can know the conversation is over.

Which terminal value is read off *why* the ask left. A discharge that settled
the ask resolves the thread; one of the four that mean **gone, not answered**
(`evicted_cap`, `deadlock_break`, `expired`, `refused_cap`) escalates it,
because something went wrong in that conversation and a record that called it
`RESOLVED` would be lying in the same place an operator looks for the truth.

Three things deliberately do **not** end a thread. A thread that never opened a
commitment — a notice, a broadcast, a collab's own discussion — has no ending
to detect. A live collab owns its own ending (`collab.closed` knows whether the
discussion was closed or overran). And a thread that keeps receiving messages
after it is terminal stays terminal: the ending is a fact about the ask, not a
liveness heuristic. A new **ask** in a terminal thread is the exception, and it
revives a `RESOLVED` one, because a follow-up belongs in the thread that raised
it. `ESCALATED` is sticky.

### Contracts: named asks over guessed type strings

24 type strings is a small vocabulary for a human and a large one for a model
choosing under uncertainty. A **contract** is a named ask — `review.artifact`,
`research.question`, `info.question`, `artifact.produce`, `execution.run`,
`work.request`, `decision.challenge`, `decision.escalate` — carrying a JSON
Schema for its request, the refusals it may come back with, the capability a
seat needs to answer it, and an SLA.

`call` raises one; `contracts` lists them with the seats that can currently
answer. Five properties matter:

1. **It is sugar.** Every contract desugars to a typed op and re-enters the
   ordinary op path. `call` can reach nothing a typed op could not, and every
   gate applies unchanged — there is no second route to keep in step.
2. **It fails closed, loudly.** An unknown name is refused quoting what was
   asked for and listing every real alternative; a request that does not match
   the schema is refused *before any recipient is woken*, naming the offending
   field and showing the shape that would have worked. Every unknown field is
   named, once per object (`must NOT have additional properties: 'artifact_type',
   'review_scope'`): Ajv reports one issue per field with the same sentence and
   keeps the name in `params`, and the bare sentence was what seven of the fifth
   run's ten refused calls said, repeated. The refusal teaches,
   which is exactly what silently rewriting a guess cannot do.
3. **It routes to one provider.** A contract with a `provider` capability
   resolves against seats that hold it *and* that the caller may contact.
   Broadcasting an ask would open an obligation on every qualified seat for
   work only one of them needs to do.

4. **The refusals bind.** A debtor may discharge an ask with prose alone, which
   is what it always did, or with `refusal: <name>` taken from the set its
   contract declares. A name outside that set is refused at the edge, before any
   event exists, listing the legitimate ones — the same teaching failure as an
   unknown contract name. The asker receives the name as a value beside the
   prose, which is the point of a closed set: "wrong seat" (re-route), "bad ask"
   (re-ask) and "I disagree" (escalate) are three different responses, and free
   text makes them one. The set is rendered on the ask's own line in the
   debtor's prompt, because a closed set nobody can read is not closed.

5. **Nothing requires a contract.** A contract is what `call` raises, not what
   makes an ask an ask. A bare send with `type: "REQUEST_REVIEW"` and no
   contract opens a real pending request — a real debt, a real wake, a real
   entry on the ledger — with **no request schema, no refusal set and no SLA**.
   The response check then has nothing to judge: `checkResponse`
   (`core/src/projections-messaging.ts`) returns `undefined` when the ask
   carries no contract, or a contract with no response schema, and that absence
   is recorded as absence rather than failure. It fails **open and silently** —
   a thin reply to a contractless ask is discharged exactly like a good one,
   and no event records that nothing was verified. Contracts are a stricter
   path a sender opts into, not a gate every ask passes through.

A contract's SLA narrows an existing deadline regime and never creates one; see
`docs/configuration.md`.

Two things a seat needs to use a contract are said where it is reading the
thing, not only in the schema:

- **The request shape is learnable under the name the tool list uses.**
  `mesh_request_review` takes `artifactId`, the seat briefing advertises it as
  `mesh_request_review (artifactId/reviewers)`, and `review.artifact` named the
  same field `artifact`: three seats in the cronlite run took the briefing at its
  word and were refused for a missing property. The contract now accepts either
  (`anyOf` over the two names, `additionalProperties` still closed), and `call`
  reads whichever was given, so the two doors agree.
- **The answer shape is on the ask's own line.** A debtor's mail line for an ask
  under a contract carries `to answer: reply with replyTo=<id> and a payload
  carrying a non-empty one of: <keys>. Any other key is delivered, but does not
  count as the answer.` — the keys are read off the contract's own response
  schema, so the prompt cannot drift from what the discharge check accepts. Five
  replies in that run settled their asks and were reported "carried no answer"
  because each wrote it under a key the contract does not list.

### Who can settle a review

A verdict **settles** an artifact when the seat giving it holds the domain's
`.approve` authority or the type's review capability. The artifact's own owner is
held to one more rule, the one the transition gate's `self-approval` check already
applies: it may settle its own work only when **no peer could**. One predicate
(`mayReviewArtifact`) decides this for three readers, so what a seat is told and
what the mesh then accepts cannot differ:

- `request_review` refuses a named reviewer who could not settle the artifact,
  and lists the ones who could (the owner is not among them unless it is the only
  one).
- The seat briefing prints it on the artifact's own line — `a review of it is
  settled by: <seats> (name only these)`, or `no seat here can settle a review
  of it: only the operator can` — so a seat stops rediscovering it from a refusal
  every round. The bundle carries it as `relevantArtifacts[].settlers`; absent
  means no review can be asked of that artifact at all.
- The same line carries the artifact's id (`(CodePatch, id art-…, UNDER_REVIEW)`),
  the name every tool that acts on an artifact asks for (`artifactId`). It used to
  carry the URI alone, and a seat that had to write an id wrote what it had in front
  of it: a message id with `art-` in front, a URI folded into one, an id of its own
  making (11 of the 14 operations the mesh refused in the eighteenth cronlite run).
  The verdict tools' `artifactId` says where to read it.
- On the line of an artifact the seat owns, the verdicts standing on its current version that say it is not
  done (a reject, a veto or a block) are listed with what the reviewer wrote, on one line and cut at 1,500
  characters with the rest counted: `  - tech-lead rejected it: Strong progress, but …`
  (`relevantArtifacts[].verdicts`, from `ApprovalRecord.comment`, which the ledger now keeps). The reason lived
  in the verdict's event and nowhere its owner reads: a rejection woke the developer with "Event matched your
  declared interests: review.rejected" and no reason, and it asked the reviewer why, four times in the
  eighteenth cronlite run, two turns each. A new version drops the verdicts on the old one, and the lines with
  them.
- The owner of an artifact is **woken** when somebody else's verdict moves it: the
  stock developer listens for `review.rejected` but not `review.approved`, so an
  approval used to reach nobody who could act on it (a patch sat approved for
  two and a half minutes while another seat asked a third, four times, to
  "transition it"). The wake names the verdict and the rung the artifact needs
  next. For a patch that rung is a move and not a verdict, and the note says so:
  when the policy lets the owner make it, the note names the call
  (`mesh_artifact_transition` with the artifact id and the rung) and says that no
  other seat's verdict is needed for it; when the policy does not, the note gives
  the policy's reason, and names the seats that may only when the reason is a
  missing capability (a configured gate or a standing block binds every seat
  alike). It used to say "and only you can move it there", which was never so (a
  seat with `test.execute`, `security.review` or `implementation.approve` may take
  the VERIFIED rung) and which the seventeenth cronlite run's developer read as a
  verdict to wait for: it tried two `mesh_approve` passes on its own patch, asked
  for a review of a patch that had just been approved and waited for a QA nobody
  had asked, and the patch took 5 min 50 s to climb where the round before had
  taken 30 s. The wake is skipped when the owner's own interests already wake it
  for that event. A seat that is mid-turn has the wake stashed behind its turn, and the stash holds one
  wake per seat; the note rides along with whichever wake the stash keeps, so mail that
  arrives before or after the verdict neither drops it nor replaces it. It did both: the
  eighteenth cronlite run's developer was mid-turn when its test-suite patch was
  approved, the notice was dropped behind the mail wake, and the patch sat APPROVED, and
  the mission with it, for 2 min 28 s, until the stall watchdog said what the note had.
  The wake is made when the **ruling seat's turn ends**, not at the verdict, and only for an artifact that is still where
  the verdict left it. The seat with the power to rule is usually the one with the power to take the patch on, and in the
  nineteenth cronlite run the tech lead approved the developer's patch and moved it to `VERIFIED`, `MERGEABLE` and
  `MERGED` in the same turn: the developer was woken with "it needs VERIFIED next, and you can move it" 11 seconds before
  that step in one round and half a second before it in the other, and each wake was a turn that asked QA for a verification it
  had already been told to begin. A patch the turn took on has nothing left for its owner, and says nothing to it. A verdict
  given outside a turn (the operator's) has nothing to wait for and wakes the owner at once.

**A submission asks nobody.** Moving an artifact to `READY_FOR_REVIEW` records that its owner is done; it sends no
request and wakes no one, and neither does announcing it (`mesh_announce` obliges nobody and "wakes no one"). A seat
that submits and announces gets its review when the reviewer next takes a turn for some other reason, or when the
unread-mail sweep wakes it. The twelfth cronlite run's developer did exactly that with two patches, and the tech lead's
first turn on each came 3 min 2 s and 2 min 39 s later; the architect's document, asked for with `review.artifact`, was
approved 1 min 28 s after the ask. The briefing's "a DRAFT nobody transitions is never reviewed" had read as "a
transition gets it reviewed". The briefing now says that submitting asks nobody and names the ask as the seat has it
(`mesh_request_review`, or `mesh_call` with contract `review.artifact` under the contracts vocabulary), and the reply to
the submission says it again, naming the seats that can settle the artifact: while the artifact is still
`READY_FOR_REVIEW` afterwards, no review of that version was ever asked for, and some seat other than the owner could settle
it. It is a caveat; the submission stands. A resubmission whose earlier version was asked for is re-asked by the mesh
(`carriedReviewAsks`) and says nothing.

**Who a `review.artifact` call goes to** is decided in this order, each step reading
only what the seat actually wrote: the call-level `to`, then `request.reviewers` (the
field the contract advertises), and only when neither names anyone, the seats that can
settle the artifact (`settlersOf`, the same list the briefing prints) — never "the first
seat the caller may contact". A reviewer the seat named who could not settle it is still
refused, with the route ("tech-lead can"), and is not quietly replaced: the seat named
someone, so the mesh teaches instead of guessing. When the only seat that can settle it is
out of the caller's reach, the refusal says that. When the seat that can settle it is the
caller itself (a tech lead asking QA to "review" a patch that only the tech lead can settle:
the seventh, eighth and ninth cronlite runs), the refusal says "you" instead of naming the
seat back to itself, and says what to do: settle it with `mesh_approve` (or `mesh_reject`),
and ask a seat to test it first with a `work.request` if that is wanted. It does not tell that
seat to name a reviewer or escalate, because there is none to name. The advice is given only where
a verdict can still move the artifact (`verdictAdvances`: it is awaiting one); for a draft, or an
artifact already past review (the ninth run's patch was MERGEABLE when its tech lead asked), the
seat is told what state it is in and that testing is a work request, and is not sent to a verdict
that would move nothing. The router used to read neither half of
this, so in the second cronlite run 13 of 24 review requests were refused as
`review.reviewer-cannot-settle` (all 7 that named reviewers in the request, 6 of the 8 that
named nobody), each refusal naming the seat that could, and the seat asked the same wrong
reviewer again because the name it had given never reached the op.
The seats a refusal names are the briefing's own list (`settlersOf`), the artifact's owner included when no other seat could review
it. The refusal used to filter the owner out on its own and said "no seat in this mesh can" for a test report only its author could
settle (the eleventh run's pm, asking the tech lead to review QA's report: QA's own pass settled it eleven minutes later); the owner
who asks is told "you can" like any other settler, and a peer that could review the artifact keeps the owner off the list.

When the author's own approval is what moved the artifact, it stands — no peer
could have reviewed it — but it is not a second pair of eyes, and is said so: the
op result carries a caveat, and the run report flags the artifact `selfApproved`
(approved only by its owner). A test report its own author approved to FINAL used
to be cited by the PM as independent evidence. An acceptance of a *criterion* that
cites the artifact (`subject: criterion:<id>`) is not a review of it and does not
clear the flag: each such acceptance is an `approve` record carrying the artifact's id,
and counting them hid both of QA's self-approved test reports in the second run, while
the seat had been told the run report would list them.

`bus.vocabulary: "contracts"` — the setting that collapses a seat's manifest to
the named asks — is **advertisement only**. It filters the tool *list* a seat is
offered, but `callTool` resolves a name against the **unfiltered** tool map
(`apps/mesh-server/src/mcp.ts`), so a hidden tool called by name on the wire still
runs, through every gate, unchanged. A reader must not mistake it for enforcement:
collapsing the vocabulary changes what a seat is shown, never what the mesh
accepts, and it cannot take a capability away from a seat. It is equally not a
promise that a seat can reach a hidden tool: a client that checks names against the
list it was given (Claude Code) refuses the call before it is sent, so the briefing
names only what the manifest carries. See `docs/configuration.md`.

Under that vocabulary the briefing lists every contract with the request it takes, as the seat
would write it: `mesh_call work.request` (request: { ask, to?: […], subject? }). The line is
derived from the contract's own request schema (`describeRequestShape` in `contracts.ts`), never
kept beside it: a required property is its bare name, an optional one carries `?`, a list carries
`: […]`, and a choice of names (`review.artifact` takes `artifact` or `artifactId`) is written
`a | b`. The thirteenth cronlite run's pm, architect, QA (twice) and tech lead (twice) each called
`work.request` with `{title, description, to}` or `{task, description}`: the line named the contract
and its summary and nothing of what it takes, and `mesh_contracts`, which says, was never called.
The refusal names the expected schema and every seat recovered, at a round trip each.

### A verdict names the version the seat has seen

`mesh_approve` and `mesh_reject` name an artifact, not a version, so a ruling lands on whatever version is current. Two refusals keep a
ruling from landing on content its author never read, and both record nothing:

- `verdict.stale-version`: the seat cited a version (`artifact://…/1`) and the artifact is now at another. "You cited v1 but the patch is
  now v2."
- `verdict.unread-version`: the seat cited none, and the current version was published after its turn began and the turn has not read
  it. The mesh takes each artifact's version when a turn starts (`TurnState.versionsAtStart`, what the briefing could list) and the
  versions the turn read with `read_artifact`; a version above both is unseen. The refusal says what the version was at the turn's start,
  that it is newer, and which `mesh_artifact_read` to make; the seat reads it and rules in the same turn.

The second exists because of what a rejection does. The eighteenth cronlite run's tech lead had rejected the first versions of the developer's
CLI and test patches ("descriptions, not code"), and rejected them again at 03:34:34 ("still contains descriptions rather than code"), half a
minute after the developer had published a second version of each. It had not read them. Both rejections were recorded against the new versions, the patches were REJECTED with the code the
tech lead then approved, and the mission, every criterion evidenced, could not complete until the developer archived them: 3 min 25 s.

What it leaves alone: a version that existed when the turn began (the seat may have read it in an earlier turn, and a briefing lists
references, not contents), a version the seat published in the turn, a `pass` (the verdict of the seats that run what they test, and an
`approve` from a seat that holds only the pass is one), `veto`, `block`, a verdict on a criterion or on a domain with no artifact, and any
op run outside a turn, which has no baseline.

### Evidence for a criterion

A mandatory criterion closes by `approve subject:"criterion:<id>"` from a seat holding
`requirements.accept` or `requirements.approve` (`mayAcceptCriteria`), citing an artifact that is
this goal's, substantive, and submitted (not DRAFT or REJECTED). One more rule covers the types
whose whole claim is "someone checked" (`VERIFICATION_ARTIFACT_TYPES`: TestReport, SecurityReport,
BenchmarkResult): the seat that wrote it must be qualified in its domain, holding the domain's
approve authority or the capability that reviews the type (`qualifiedForDomain`). A report written
by a seat that is not (the fourth cronlite run's pm wrote a "Bug-Fix Verification Report" from what
QA had told it, submitted it itself and closed two criteria against it) is refused with
`mandatory-evidence-unqualified-author` and the route: the seat that can verify publishes its own
report and the acceptance cites that. It is a rule about what a verification artifact is worth, not
about who may accept: the pm accepting its own RequirementsDoc is by design. When no other seat
could have verified (no QA seat in the mesh) the only report there can be stands, the carve-out
`approverMayAdvance` makes for the same reason, and the operator's acceptance is its own judgment and
is not held to the rule.

An approval follows the **artifact**, not only the capacity it was signed in. `architecture-approved` closes, and
`architecture.approved` is derived (it wakes the seats that wait for the design), when an approval takes an artifact of the
architecture domain to APPROVED or FINAL, or when a subject-level sign-off names no artifact (the single-agent benchmark).
A verdict signed as `architecture` on a RequirementsDoc is a verdict on that document: it moves it, as any verdict does,
and approves nothing else. The tenth cronlite run's tech lead, asked to review the ArchitectureDocument and the
RequirementsDoc within seconds of each other, signed "Architecture is sound and complete" on the RequirementsDoc's id; the
criterion closed with that document as its evidence, the architect and pm told the others it was approved and the developer
was woken for it, while the ArchitectureDocument sat UNDER_REVIEW for 2 min 49 s. The reply to a verdict signed in one
capacity on an artifact of another domain now names the review in the signed capacity that the seat still owes (a request
addressed to it, awaiting a verdict), with its id, and says to name that id if it is what was meant; a deliberately
cross-domain signature with nothing owed behind it says nothing.

A verdict or an acceptance that names an artifact the mesh does not hold (an id typed from memory: twelve across runs 7 to 11; the
eleventh run's pm cited `art-M3YBS5TT…` in three acceptances in five seconds when the report was `art-M3YBNR4X…`) is refused,
and the refusal names the route. For an acceptance it lists what the briefing lists, the submitted artifacts that could evidence
the criterion (`citableEvidence`, three at most), or says that nothing submitted can yet (a draft cannot) and to ask the seat that
wrote the report to submit it. For a verdict it names the reviews the seat still owes (the requests on its desk whose artifact
awaits a verdict) and, when there are none, the artifacts the mission holds (below). One helper, `reviewsOwedBy`, reads those asks
for this refusal and for the cross-domain note above, so what a seat is told it owes cannot differ between them.

The same list ends the refusal of every op that names an artifact by an id the mesh does not hold (`transition_artifact`,
`request_review`, `read_artifact`, `acquire_lease`, `commit`, `merge`, `request_commit`): `unknown artifact art-M3ZN0TAJ… —
artifacts in this mission, newest first: art-M3ZN0BTK… CodePatch "cronlite: Fix three critical defects" v1 (DRAFT); …`, five at
most, each with its id, type, name, version and status, and a count of the rest. In the fourteenth cronlite run the tech lead's
ten refused ops in one turn were one id, copied wrong, tried again; the hint it had ("mesh_inbox and mesh_query_events show
both") costs a call and a page and was not taken. A mission with no artifact yet says so.

The seat that accepts is shown what it may cite. While a mandatory criterion that needs an acceptance is open,
the briefing of a seat holding the gate lists the submitted artifacts an acceptance would take (the list the stall
watchdog offers, `citableEvidence`) with `relevantArtifacts[].citable: true`, even though a work-scoped report is
otherwise shown to its owner, to whoever is mailed it and while it awaits a verdict only. A draft, a rejected
artifact, what the operator rejected at a reopen and a report written by a seat that cannot verify are not offered,
because an acceptance would refuse each. And a `pass` on a draft verification report that the passing seat owns
submits it first (see *What counts as satisfied* in `docs/runtime.md`), so the report a verdict is about is in
the store as submitted work, citable at once. A pass that names a patch (or nothing) submits the newest such report the seat has
written for the mission, of the type that settles the pass's domain, and says so.

### A pass is the verdict of the seats that verify

`quality.pass` and `security.pass` are what the seats that test and scan hold, and what a `qa.pass` /
`security.pass` transition gate and the `quality-verified` / `security-verified` criteria read: a
`pass` on the `quality` or `security` domain lands that criterion's evidence. `mesh_approve` takes
`kind: "pass"` to give one. A seat that holds `<domain>.pass` and no `<domain>.approve` (nor a
wildcard; `givesPassForApprove`) and asks to *approve* the domain is giving the only positive
verdict its authority allows, so `recordDecision` records it as that pass and the op result says so
("recorded as your quality.pass: that is the verdict your authority gives in this domain…"); the
alternative was a refusal for an authority nobody holds, which is what the fifth run's QA got after
testing the merged product, and the pass was never recorded. Only an approve is read this way (a
reject, veto or block from the same seat is refused, never inverted), and a seat holding both keeps
the word it chose. A pass satisfies whatever an approve would; the reverse never holds. The briefing
tells such a seat the word (`passOnlyDomains`), and a refusal to a seat with no verdict in the domain
names what the others hold there ("no agent seat holds it; in this domain qa holds quality.block,
quality.pass").

### One ask to N agents is N obligations

A pending request tracks its `outstanding` debtors individually. A reply
settles **only the replying agent's** obligation; the ask stays open, owed by
whoever is still silent, and closes when the last debtor answers. Partial
settlements are recorded as `partial` discharges naming who remains.

Without this a plural debtor is a diffuse debtor: ask dev + qa + security to
review, and dev's "looks fine" closed the ask for all three — recorded under
discharge reason `reply`, the runtime's most confident, explicitly
non-inferred outcome, while two review obligations vanished with no nudge and
no stalemate. With `broadcast` (which addresses every agent) one reply could
discharge an obligation owed by the whole team.

One deliberate asymmetry: a discharger who was **never** a debtor — the human
operator answering for an unresponsive agent, or the runtime superseding a
review — is resolving the *ask* rather than paying one debt, and settles it for
everyone at once.

### Asks leave the ledger exactly one way

Every exit is a recorded discharge with a reason, so "how did this ask
disappear?" always has an answer. Four reasons mean **gone, not answered**
(`evicted_cap`, `deadlock_break`, `expired`, `refused_cap`); consumers must
consult the reason before concluding an ask resolved, and escalation cards
pointing at such an ask stay open rather than auto-closing with a false claim.

`withdrawn_by_sender` is deliberately *not* one of those four, and the
distinction is the whole point of it. The asker closed its own ask before
anyone answered, which is a real decision by a party to the ask, so the record
is a settlement rather than a loss: the debtors are released and told, and the
escalation card that the stuck ask raised auto-closes instead of keeping a
human's queue open over a question nobody wants answered. It is the asker's
counterpart to `refused` — authorized by having *asked* the question, exactly
where `refused` is authorized by *owing* the answer — and it is the one exit
whose purpose is to remove an interrupt rather than manufacture one.

### An ask that can answer itself

The ledger's asks all assume the answer is worth waiting for, and most are.
Some are not: a developer that will use Postgres unless the architect objects
has an ask whose *whole content* is the objection it does not expect. Raised
plainly, that ask costs the architect a turn to say "yes, fine", and costs it
three more turns of nudging if it does not.

`ifUnanswered` lets the asker price that in advance. It goes on any op that
opens a commitment — `send`, `request`, `call`, `research_request`,
`request_review` — and carries `assume` (the value the asker will proceed with)
and optionally `afterMs` (how long it will wait first):

```json
{ "op": "call", "contract": "decision.challenge",
  "ifUnanswered": { "assume": "postgres", "afterMs": 900000 } }
```

What it changes, on all three sides of the ask:

- **The debtor is told, in its own prompt, that silence is a legal move.** The
  ask's line reads *"if you say nothing: the asker proceeds as `"postgres"`.
  That is a legitimate ending here and you will not be nudged for it — answer
  only if that would be WRONG."* This line is the feature. Everything else the
  prompt says to a debtor is about how to spend a turn, and silence has always
  read as "still working"; unshown, `ifUnanswered` would spend the debtor's
  attention on exactly the asks the asker had already said it could do without.
- **The ask is never chased.** It skips the nudge ladder entirely, so it cannot
  reach `MAX_NUDGES` and cannot raise a `stalemate:unanswered_request` card.
- **At the deadline it discharges `defaulted`**, carrying the assumed value and
  the debtors who never answered, and the **asker** is woken with it — not a
  human. The asker gets its own commitment handed back and proceeds; nobody's
  operator queue grows a card over a question that was already settled.

`defaulted` is a **settlement**, not a loss. It is deliberately not among the
four reasons that mean *gone, not answered*, so a thread whose last ask
defaulted reaches `RESOLVED`: nothing went wrong in that conversation. It is the
third exit authorized by a party to the ask rather than by the runtime running
out of options — `refused` is authorized by *owing* the answer,
`withdrawn_by_sender` by having *asked* the question, and `defaulted` by having
said in advance what the answer would be taken to be.

**It needs a clock, and says so.** `afterMs` draws a deadline on a mesh that has
none; on a mesh with `bus.commitments.ttl_ms` it may be omitted and the mesh's
own deadline is used. With neither, the op is **refused at the edge** naming
both ways to fix it, rather than opening an ask that would wait forever under a
promise to end. `assume` is likewise required: an `ifUnanswered` with no value to
proceed with describes no ending.

**It needs a clock that is long enough, and says so.** An `afterMs` below the
floor (`bus.commitments.min_default_ms`; absent, derived from the mesh's own
`coalesce_ms`, wait-wakeup sweep and one answering turn) is refused too, naming the
smallest value that would be accepted. A default that can come due before its
addressee could possibly have been woken and answered is not a default, it is an
assumption stated as fact: in the cronlite run two seats each passed `afterMs:
5000` on a mesh whose delivery window was also 5 s, two of three asks ended
`defaulted`, and one of them told its asker to proceed on an assumption that
was false and not to re-ask.

## Event envelope (`schemas/event.schema.json`)

```jsonc
{ "id": "evt-…", "seq": 1039, "protocolVersion": "1.0",
  "type": "message.sent", "timestamp": "…", "goalId": "goal-1",
  "actorId": "developer", "causationId": "evt-…", "payload": { … } }
```

The canonical event catalog (add a type → update the catalog, the reducer, and
the projections) spans goal/agent/message/artifact/task/review/patch/
architecture/release/research/decision/escalation/human/lease/memory/budget
lifecycle. Events are append-only and **deduplicated by id** (exactly-once).

### Whose event it is: `actorId`

`actorId` is who **did** the thing, and `"human"` means a person: the operator
answering a card, reopening a mission, sending a message. The runtime's own acts
carry the runtime's name, so a reader of the log can tell an operator's verdict
from a watchdog's:

| `actorId` | what it stamps |
| --- | --- |
| a seat id | the seat's own ops, and its tool calls' effects |
| `human` | operator actions only: `reopenGoal`, `escalation.responded`, operator-sent mail |
| `termination-manager` | verdicts the watchdog reaches on its own: `goal.completed`, `goal.escalated`, `goal.failed`, and the sweep that retires seats when the mission ends |
| `recovery-manager` | restarts, revivals, the boot sweep that releases abandoned budget holds, provider-breaker cards |
| `system` | derived bookkeeping with no acting seat, such as `artifact.transition` with `derived: true`, or a `requirement.satisfied` with no `evidence.by` |

A `requirement.satisfied` is attributed to the seat whose evidence it records
(`evidence.by`), falling back to `system`, never to the operator: in the cronlite
run all twelve events stamped `human` were ones nobody had performed (eleven
`requirement.satisfied`, which seats had claimed, and the `goal.completed` the
watchdog reached), so the audit trail could not say whether an operator had ended
the mission.

### `artifact.transition` with `derived: true`

An approval or a version moves an artifact inside its reducer, and the supervisor
then records the move so a reader of the stream sees it. The record is written
**only when the artifact moved**, and says from where: `{ artifactId, from, to,
derived: true, gateSatisfied }`. Before, 16 of a run's 28 such events were
no-ops (`FINAL (derived)` on an artifact already FINAL), carried no `from`, and
their `gateSatisfied`, asked of a transition that did not happen, read `false` for
no reason a reader could use. `from` is absent only where the emitting site could
not know the prior status (older events, and the sites that never read it).

A version published **over a MERGED artifact** restarts the ladder at `DRAFT`.
That is deliberate, not a walk-back: a new version is new content that has not
been reviewed, and `derived: true, from: MERGED, to: DRAFT` is the honest record
of it. Git is unaffected — the merged commit stays on the product branch — and the
new version walks the ladder up to a merge of its own.

### `turn.discarded`: why a turn's work did not reach the mesh

One event per turn that ended without its work landing, `{ agentId, turnId,
reason, tokens?, partial?, detail? }`. `tokens` is present only when the backend measured
the turn — absent means unmeasured, never zero — and that figure is billed.
`partial: true` says the figure is a floor and not a final count: the stopped call
reported no usage of its own (the backend was torn down under it, the stream's
transport died, or the supervisor settled a call the runtime never answered), so it is
what the turn's stream had reached when it stopped, and the turn spent at least that.
It is billed like any other figure, once.

| `reason` | meaning |
| --- | --- |
| `no_ops` / `all_rejected` | the turn answered, but did nothing / every op was refused |
| `rotation_handoff` | the turn was spent writing the session handover |
| `budget_blocked` | the turn's budget hold was refused; it never reached the model |
| `timeout` | the turn deadline expired |
| `silence` | the silence watchdog stopped a stream that went quiet |
| `budget` | the budget watch stopped the turn: its live spend passed what the seat had left on the last budget rung |
| `failed` | the backend failed, or the kernel refused the turn after the model answered |
| `interrupted` | the operator stopped the turn (`POST /agents/:id/interrupt`, or `POST /agents/:id/suspend` on a seat mid-turn), or the server process ended before the turn did (written by the **next boot**, with no `tokens`: what the dead turn spent was recorded nowhere) |

A mid-turn budget stop is `budget`, with `turn budget exceeded: N live against M
left` in `detail`. It carries its own reason since 2026-09-27: the watch's abort
comes back as the runtime's own (a `silence`-shaped interrupt, or a bare failure
when the supervisor had to settle the call itself), so before that the only trace
of what had really happened was the detail prose. The label did not change what
happens to the seat — it is still a failure, and still walks the same restart
ladder — only what the log and the seat's own note call it.

`interrupted` is the one abnormal ending that is **not** a failure. Its `detail`
reads `stopped by the operator[: <reason>][ (seat suspended)]`. There is no
`agent.failed`, no `agent.restarted` and no recovery wake, and no crash or
slow-turn counter moves. The seat returns to `IDLE` (an `agent.state_changed`
carrying the `turnId`), keeping its claimed task and its unread mail; with
`suspend: true` it is then `agent.suspended` and takes no turn until
`POST /agents/:id/resume`. Without it the seat is ordinary `IDLE`, so the
scheduler may wake it again for mail still waiting. Files the turn wrote are left
in place (and snapshotted like any stopped turn's), and the seat's next turn is
told the operator stopped it. The route takes an optional body `{ "reason"?:
string, "suspend"?: boolean }` and answers `200 { turnId, settled, endedAs,
lifecycle }`, `409` when the seat has no running turn, `404` for an unknown seat
and `400` for a malformed body. A turn already past its model call when the stop
arrives finishes normally, and `endedAs` says so. `POST /agents/:id/suspend` on a
seat mid-turn takes this path with `suspend: true` and names the turn it stopped
(`stoppedTurnId`); on an idle seat it suspends as before.

## Artifact URIs & versions (`schemas/artifact.schema.json`)

`artifact://{Type}/{name}/{version}`. Artifact versions are immutable; a change
produces `design-v2 → design-v3` with `parent` lineage. Digests are `sha256:…`.

Messages reference URIs rather than pasting content, but **"the bus is a
reference bus" is a discipline, not a runtime rule.** Nothing rejects or strips
a pasted body: `payload` is an unconstrained object in
`schemas/message.schema.json`, so a whole file can ride in it and validate. The
only payload policing is `RESERVED_PAYLOAD_KEYS` (`mode`, `delivery`,
`cacheServed`, `contract`, `contractVersion`, `downgraded` — control fields
deleted on input by `sanitizeAgentMessageInput`), and the only bounds on free
prose in a message are `note` and `requires[].text`, both 2000 characters. What
a pasted body costs a *reader* is bounded separately, at render time:
`renderMailPayload` prints at most 20 lines of 400 characters and marks the
remainder omitted. The rule itself is carried by the role prompts, which
`docs/architecture.md` classes as layer 1 (prompt awareness) — a rule the agent
is told, not one the runtime enforces.

### Publishing a body: three ways, one of them expensive

`publish_artifact` takes exactly one of `content`, `fromPath` or `edits`, and
the choice is the largest cost decision in a turn. `content` is typed by the
model and billed at the output rate — five times fresh input — so a document
moved that way is paid for at the most expensive rate the mesh has. Measured on
one real mission: 44 inline publishes carried 1,178,479 characters, about 17% of
everything written, and most of it was already a file on disk or a previous
version being retyped to change a paragraph.

- `fromPath` — a path inside the seat's own workspace (`agentWorkspace`,
  the same directory its Write/Edit tools land in). The runtime reads the file,
  so the body never passes through the model. Resolved on the real path and
  refused if it escapes that root, so `../` and a symlink out are the same
  refusal.
- `edits` — `[{old, new}]` against the version named by `asVersionOf`. Same
  contract as the Edit tool: each `old` must appear exactly once, and if any
  one fails, nothing is written. An artifact version is immutable and gets
  cited as evidence, so a half-applied revision is worse than a refused one.
- `asVersionOf` — the artifact this publish is a new version of (required with `edits`): its id, its
  `artifact://Type/name[/version]` URI, or its exact name as an artifact of the type being published. It
  took the id alone. The sixth cronlite run's developer, reworking the CLI patch a reviewer had rejected,
  wrote the name and then the URI, was refused "unknown artifact" twice with no word of what to write,
  and published a new patch under a new name: two patches for one deliverable, and the rejected one left
  behind (the mission now waits on it, below). A URI or name of another type resolves to nothing (a
  version keeps its predecessor's identity, so the type has to agree), ownership is checked after, as for
  an id, and a refusal says what to write and lists the seat's own artifacts of that type.
- `content` — inline, for a document that was never a file. Capped at 48,000
  characters, below the 60,000 a single `read_artifact` returns, so anything
  publishable in one call is readable in one call. Over the cap the publish is
  **refused and the refusal names the other two fields** — never truncated, since
  a truncated artifact still digests, versions and satisfies gates.

Note which seats can actually choose. `fromPath` reads from the seat's own
worktree, and a worktree is only granted to holders of an edit capability
(`repository.write`, `architecture.write`, `test.write`). A seat with
`repository.read` alone — which is the shipped shape for `pm` — has no worktree
and therefore **no** `fromPath`, so the cheap route is closed to exactly the
seats whose job is publishing documents. For them `content` is the only body, and
the cost note above is advice they cannot act on.

A payload containing its own markdown code fence is safe: ops arrive only as
MCP `mesh_*` tool calls, whose arguments are structured JSON, so a document
carrying a fenced diagram is just a string. (When ops were still parsed out of a
prose `mesh-json` block, such a fence ended the block early and the whole turn
was discarded; that channel is gone.)

This is the one place the reference-bus discipline became a runtime rule rather
than prompt advice — and note what it corrects: telling agents "never paste into
messages, publish an artifact instead" moved the paste out of the cheapest
channel (mail, which is ~0.2% of input) and into the most expensive one.

## Typed state machines

- **code**: `DRAFT → READY_FOR_REVIEW → UNDER_REVIEW → APPROVED → VERIFIED →
  MERGEABLE → MERGED` (with `REJECTED → DRAFT` and `ARCHIVED`)
- **release**: `PROPOSED → IMPLEMENTED → QA_VERIFIED → SECURITY_VERIFIED →
  ACCEPTED`
- **document**: `DRAFT → READY_FOR_REVIEW → UNDER_REVIEW → APPROVED/FINAL`

Transitions are gated by approvals/evidence recorded in the event stream.

`MERGED` is terminal — the code machine has no edge out of it — so it is only
recorded **after** the change is actually on the product branch. `merge` runs the
git merge (or, without a workspace, materializes the patch's files) first and
transitions only on success; a failure leaves the artifact `MERGEABLE`, which is
both true and retryable once the conflict is fixed. The order used to be
reversed, and because `MERGED` on a `CodePatch` also mirrors `patch.merged` and
`implementation.completed`, a failed merge announced finished work that no
commit contained.

A `merge` asked of a patch that is not `MERGEABLE` is refused with where the patch stands and whose move is
next, after the sentence it always began with (`artifact is APPROVED, must be MERGEABLE`). An `APPROVED` patch has two
rungs left, `VERIFIED` and `MERGEABLE`, and nothing climbs them by itself; the refusal names them, says "You can" when
the asking seat's own `mesh_artifact_transition` would be allowed (it holds `implementation.approve`, or a test or
security capability for the first rung), and otherwise names the owner or a seat that may verify. A `VERIFIED` patch has
one rung left; a `DRAFT` says its owner submits it, a patch in review says a reviewer rules first, a `REJECTED` one says
its owner reworks it with `asVersionOf`, and a `MERGED` one says so. The twelfth cronlite run's tech-lead met the bare
sentence three times (16:54:03, 16:55:43 and 16:59:05), each in the turn in which it had approved the patch, and the sixth
and seventh runs met it too. In that run's second round the same seat approved a patch, moved it to `VERIFIED` and
`MERGEABLE` and merged it in under six seconds, so the move was open to it all along.

The two mirror events are attributed to the seat that **ran the merge**, filed under
that seat's turn and caused by the MERGED transition, not to the patch's owner. They
used to carry the owner: in the second cronlite run the tech-lead merged every patch,
yet each `patch.merged` read "developer merged it" while the developer was idle, and
the kernel, which correlates an emit to its actor's live turn, credited the developer's
turn with two effects it did not produce (the turn-effect count is what tells a
productive turn from a no-op one). What stays with the owner is the record
`implementation.completed` reduces to, an `implementation|pass` approval: a gate that
names a seat is met by a record that seat is the actor of, so attributing it to the
merger would let merging stand in for the merger's own sign-off. The payload carries the
owner's id for that reason, and every gate reads as before.

A `CodePatch`'s `metadata.commit` is what the merge hands git, so it must name a
commit: a hex sha of 7–40 characters, or a branch/ref name that passes a
conservative `git check-ref-format` (no whitespace or control characters, none of
`~ ^ : ? * [ \ ( ) ; ,`, no `..`, `@{` or `//`, no leading `-` or `/`, no
trailing `/`, `.` or `.lock`). A publish or version that supplies anything else
is refused with `metadata.commit must be a git commit sha or branch name (got
"<value>" — …)`; omitting it is fine, and the `commit` op records the real sha
for you. With a git workspace the value must also resolve to a commit in the
product repository (`git rev-parse --verify <value>^{commit}`); an in-memory mesh
checks syntax only. A patch recorded before this rule with an invalid value is
refused at the transition to `MERGEABLE` with the same sentence, and a merge that
still meets a missing commit quotes the value whole.

**Commit before you ask for review.** `merge` lands the commit a patch *records*
and refuses a patch that records none, and `commit` (`mesh_commit`) records it as a
**new version**, which starts over at `DRAFT` (reviewers approved the content that
was published, not whatever the worktree held later, so the bump is right). A
developer that published a patch, walked it to `MERGEABLE`, and only then was told
to commit lost the approval and owed a second full review of identical work; in the
cronlite run it then reported `MERGED` to the PM when nothing had landed. So the
warning comes where it can still be acted on: `request_review` on a `CodePatch` that
records no commit, whose owner holds uncommitted work and could commit it, carries a
**caveat** naming the cost (a caveat, not a refusal: a seat may commit through its own
shell and let `merge` take the branch); the end-of-turn uncommitted-work advisory says
to commit *before* asking for review; the merge refusal states the real consequence
instead of "then merge again"; and the developer role prompt puts lease and commit
ahead of `PATCH_READY`. A seat's shell may commit freely in its **own** worktree and
may not change the product checkout, nor may its file tools write there; what is found
uncommitted in the product checkout is set aside, saved, before a merge (`docs/runtime.md`,
`runtime-claude`).

**A patch that records no commit takes its owner's whole branch, and says so.** With no commit to
scope it by, `merge` lands everything on the owner's branch, and the reply names what came in
(`<owner>'s branch went in whole: this patch records no commit (…), so the merge had nothing to scope
it by, and N commit(s) came in with it: …`); for a patch that records a commit, the commits left on the
branch are said to stay there, which is the only case where "were NOT part of this artifact" is true. A
second patch from that branch then finds nothing to move, and the merge asks what its two causes
differ in. The owner holds nothing uncommitted and every file the patch lists (`## File: <path>`
sections, or `metadata.path`) is in the product as published, line endings and trailing blank lines
aside: the work landed with the first merge, and the patch is recorded `MERGED` (`already in the product
as <sha> (landed by an earlier merge: …)`). Otherwise the refusal says which part failed, and never sends
the owner to `mesh_commit` when `mesh_commit` would refuse: uncommitted files are named and committing
them is the remedy; a listed file that is missing from the product or differs, or a patch that lists no
file, is answered with a new version of the patch (`asVersionOf`) that lists what the product holds, or
names the commit it was made in (`metadata.commit`). When nothing can be said of the owner's worktree the
refusal is the old one. In the fourteenth cronlite run the developer committed with its own git and
published two patches that recorded no commit; the first merge took the CLI with the library, was told
the CLI was "not part of this artifact", and the tech lead then tried to merge the CLI three times, was told
to `mesh_commit` work that was committed, and left the patch `MERGEABLE` for the rest of the run with its
file on `main`.

A task that carries the `implementation.gate` marker (what the `implementation.completed`
gate keys on) is claimable like any other: the marker is a tag the completion gate reads,
not a capability a seat could hold, and the claim check skips it exactly as the seat
briefing's list of claimable tasks already did. It used to be refused as a missing
capability no seat could ever be granted, so the task stayed open and the gate was never
consulted.

**A completion the gate refuses names who can lift it, and a new version says which verdicts it dropped.** The gate a task
carrying `implementation.gate` meets (`implementation.completed` requires `tech-lead.approve` and `qa.pass` in the sixteenth
cronlite run's mesh) reads the verdicts that stand on the log, and a new version of an artifact drops every verdict recorded on the
old one: a verdict is about content, and a version is new content. QA published a new version of its own report at 08:57:20, two and
a half minutes after it had passed the first, so its `qa.pass` was gone, and nothing said so. A criterion's evidence outlives the verdict
that produced it, so all six criteria were evidenced at 09:04:22 and the mission still could not close: the developer's
`mesh_task_complete` was refused in three turns with "missing: qa.pass", which names a token and not who can give it or how. It was
nudged five times, asked QA once, was told "qa.pass verdict recorded" by a QA that had recorded nothing, and raised an escalation
that read "Appears to be system state synchronization issue". QA recorded its pass seven seconds after the operator's one message
naming the call, and the goal completed at 09:18:06, 13 minutes 44 seconds after the last criterion. The refusal now says who holds each
missing requirement (a gate names an actor by seat id or by role, so every seat that matches is named, an alternative nobody
holds says so, and the operator is never the holder) and the call that records it, that the claimant cannot give it for them,
and that a verdict on an earlier version does not stand. The reply to a publish of a new version names the verdicts it dropped,
and tells the publisher to record its own again, with the call (`mesh_approve { kind, artifactId }`). The `commit` gate's refusal
is unchanged.

**The verdict that brings the mission to the finish line says what holds it open.** When every mandatory criterion is evidenced and
the only thing left is a task its owner still holds, the watchdog tells the seat it wakes (*The stall watchdog*, `runtime.md`). The
sixteenth cronlite run's pm gave the acceptance that brought the mission there at 09:04:22 and was told nothing: it broadcast
MISSION_COMPLETE four seconds later ("Ready for production"), and the unread broadcast woke three seats at 09:08:34, 4 min 8 s on,
for turns that did nothing (7.1k, 8.9k and 10.8k tokens). The reply to a verdict that does this now carries the same note, once: to
the seat that holds the claim ("a task you still hold … finish it with `mesh_task_complete`"), to any other seat whose act it was
("claimed by dev … Only the claimant can complete it"), after whatever caveat the verdict already carried. A verdict given once the
mission is already there, a refused one and one that leaves a criterion open say nothing of it.

A task is claimed only by a seat that holds **every** capability it lists, so a list no seat
can satisfy is a task that stays `OPEN` for good: no op withdraws a task. `create_task` with
`assignedTo` therefore makes the check `delegate` always made, and both say the same thing
(`dev lacks required capabilities test.write (held by: qa). A task is claimed only by a seat that
holds every capability it lists, so this one would sit open, and no seat holds all of …: take
test.write out of requiredCapabilities if the claimant does not need it`, or, when a seat does
hold them all, `give it to lead, who holds all of them`). It reads the list after normalizing it,
counts the `implementation.gate` marker as the tag it is (`delegate` used to refuse it as a
capability the target lacked), and leaves an assignee that is the operator or not a seat to the
send that follows. A task with no assignee that no seat could claim is filed, with a caveat naming
the seats closest to it (three at most, fewest missing first); one nobody holds a single
capability of says so. A refused **claim** names who holds the capability and that nothing waives
it (`ask pm, who filed it, for a task without test.write`), and says so only when the seat truly
lacks the capability, not when a policy rule denied it. The seventh cronlite run's pm filed three
implementation tasks for the developer listing `test.write`, which only qa holds; `delegate`
would have refused, `create_task` did not, the developer's claim was refused, a 23k-token turn
went on asking the tech-lead (whose "claim the tasks and proceed" could not work), and all three
tasks were still `OPEN` when the mission completed. `mesh_task_create` now says what
`requiredCapabilities` means: what the seat that claims the task must hold, all of it.

**Completing a task says the work is done, and `mesh_done` completes it too.** `mesh_task_complete` takes a summary and the
evidence the seat chooses to cite, and nothing checks that the work exists; it cannot be undone, and no tool releases a claim.
`mesh_done`, which every role prompt tells a seat to end its turn with, completes the task its seat holds with the turn's summary
(never in a handover), and it was described as "Finish your current activation turn": no seat could know. 23 of the 46 task
completions of the eighth to the fifteenth cronlite runs were made that way, 19 of them in a turn that had also called `mesh_wait`.
QA's were the worst: in each of the eight runs it claimed its verification task on its first turn and the task was COMPLETED by
the end of it, with a summary that says it is waiting ("Implementation not yet available — standing by to test once code appears
in repository", the fifteenth: claimed 04:48:37, completed 04:48:56, five minutes before the first line was merged). The board
said "QA verification: done" for the rest of the run, and QA's real completion was refused ("task is COMPLETED"). `mesh_done` and
`mesh_task_complete` now say that completing is DONE and not an acknowledgement, and what to do instead (leave the task claimed,
`mesh_wait`, end the turn without `mesh_done`); `mesh_task_claim` says to claim what you can start now; and `roles/qa.md` has a
section on the verification task: claim it only with something to verify, otherwise answer the delegate with when QA will start
and wait (`patch.ready` and `implementation.completed` wake it).

**Wording did not hold, so a `done` that only ends a turn completes nothing.** The sixteenth run (QA's first turn, 08:47:56, with
the sentences above in the tool descriptions and the role prompt) claimed its task, called `mesh_wait`, called `mesh_done`, and
the task was COMPLETED 21 seconds after the claim: "Implementation not yet available - developer is working on it. Standing by".
It was the ninth run in a row, the eighth to the sixteenth. In the thirteen runs before it (the third to the fifteenth), 31 tasks
were completed by `mesh_done`, 25 of them in a turn that also waited. Counting what each turn had landed (the events the kernel
correlates to it: an artifact created or versioned, a commit, a merge, a review requested, a verdict, a task, a decision), 15 of
the 31 were in a turn that waited **and made nothing** while the mission still had an unmet mandatory criterion: 13 were QA's
first turn ("standing by"), one a tech lead's whose merge had been refused (its summary says "CLI patch merge blocked"), one a
developer's closing turn that moved a patch's state and had nothing else to show. The 10 that waited and **did** make something
(a design published, a patch committed and sent to review) were work finished and awaiting its review, and the other 6 did not
wait. So a `mesh_done` in a turn that called `mesh_wait` and landed none of those no longer completes the task its seat holds
while a mandatory criterion is still unmet: the reply says "task … stays claimed by you" and what would complete it, the audit log
records it, and the task stays CLAIMED. The seat's next `mesh_done` or `mesh_task_complete` completes it as before; so does a
`done` in a turn that did not wait, or that made something; and once every mandatory criterion is evidenced nothing is left to wait
for, so a `done` closes the claim as it always did (that is the turn the finish-line nudge asks for). The cost is that a task which
a seat completes only by a `done` in a turn that waited stays claimed until its next turn, or until the finish line, where the
watchdog wakes the claimant once.

`REJECTED` has one edge out, to `DRAFT`, and it is the owner's: a reviewer's later approval of a
rejected patch records a signature and moves nothing, and says so with the route ("only its owner (dev)
can move it, so ask dev to rework it"; it used to say "move it to review first", which the reviewer
cannot). `ARCHIVED` is reached from `DRAFT` and
`READY_FOR_REVIEW` only, so withdrawing a rejected patch is two moves (REJECTED → DRAFT → ARCHIVED). A
mission whose goal asks for `implementation-merged` does not complete while a CodePatch that was rejected
is neither `MERGED` nor `ARCHIVED` (`openRejections`; *A mission does not complete over a rejected patch*
in `docs/runtime.md`). The merge still evidences the criterion; the goal waits for the patch, and the
merger, the owner (through the stall watchdog) and the stall-cap card are told which one.

A verdict outside a reviewable status records a signature and moves nothing —
approving a `DRAFT` artifact, or rejecting one already `MERGED`. That is
intentional: a `<role>.approve` gate token is a signature, and seats legitimately
sign artifacts sitting where no approval can advance them. What the op result now
carries is a caveat saying so, with a route (`move it to review first`; `already
MERGED — open a revert or publish a new version`), because the silent version let
a reviewer believe it had rejected shipped code. The route is named only where it exists: a `DRAFT`
has a move to review, a `FINAL` report, an `APPROVED` patch and a `ReleasePlan` do not, and a seat that
passed a `FINAL` report again to close a criterion was told to make it.

## Trust / provenance classes

`HUMAN > SYSTEM > MESH_DECISION > TOOL > AGENT > REPOSITORY > EXTERNAL`. A
repository `README` that says "ignore previous instructions" carries `repository`
provenance and never acquires `system` authority.

## MCP as an integration boundary, not the protocol

Agents reach the mesh ONLY through MCP `mesh_*` tools (transport) — there is no
prose ops channel — but the domain model is the typed message/event protocol
above:

```
Agent → MCP tool → Mesh API → Policy Engine → Event Store → Scheduler
```

Every `mesh_*` tool is authenticated by a per-agent token and runs through the
same policy engine as an in-runtime turn.
