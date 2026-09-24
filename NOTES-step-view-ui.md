# NOTES — step-view UI polish (handoff)

## Done — uncommitted, branch `feat/plan-visibility`
Redesigned the Outcome ledger row so it stops printing raw output text.
- `apps/mesh-dashboard/src/format.ts` — new `OpFact` / `OpHead` (`{title, detail, facts[]}`).
- `.../drawers.tsx` — `msgSnippet` now returns prose only (dropped the `JSON.stringify`
  fallback that produced the cut-off JSON blobs); new `clip()` appends `…` on truncation
  and collapses whitespace; `opHead` emits per-op facts, with a scalars-only fallback for
  op kinds that have no recipe; `list()` replaced the old local `to()`.
- `.../stepview.tsx` — row is now `number / [title + labelled fact chips] / [prose] / badge`,
  with `title` tooltips on every clipped string; `FX` map carries badge tooltip text.
- `.../observability.tsx` — `LiveOps` renders the facts line when an op has no prose.
- `.../styles.css` — two-line grid (`20px minmax(0,1fr) auto`) + `.sv-op-main/.sv-op-r1/.sv-op-f`.

Verified: `npx tsc --noEmit -p apps/mesh-dashboard/tsconfig.json` and eslint both clean.

## Session 2 — RENDERED AT LAST. Screenshot: `/tmp/05-drawer.png`
The drawer now renders and was driven headlessly. Events + jump-nav + header strip all
look correct. Two findings, one of which blocks verification of the work above.

### FINDING 1 (blocker) — the OpLedger redesign is not exercised by the demo stub
Scanned the 14 richest of 32 turns: **every one has zero `.sv-op` rows** (best was
`{o:0, t:1, e:14}`). The demo stub's turns carry messages/decisions, not ops. So all of
the `OpHead`/`OpFact`/fact-chip work above is still **unrendered** — tsc-clean but never
seen. Do not claim it verified.
- Either find/author a mesh fixture whose turns emit ops, or drive `mesh run` with a
  scripted team that produces an ops block; the stub does not.

### FINDING 2 — FIXED in session 3. Screenshot: `/tmp/fix.png`
On `turn-1684a08cddc7be02` the same drawer says, ~200px apart:
- Reasoning: "The model wrote **no prose** for this turn — only operations."
- Outcome:   "This output isn't an ops block. The model wrote **prose instead of
  operations**, so nothing could be applied."
Both cannot be true. And the Outcome header directly above reads `PRODUCED · 2 messages ·
2 decisions`, with Events showing MESSAGE / REVIEW.REQUESTED / MOVED FORWARD — the turn
plainly *did* produce. The "nothing could be applied" empty-state is being shown for
turns that produced non-op effects.

**Cause:** the drawer asked "did this turn do anything?" twice, from two unrelated
facts. Reasoning read the parsed ops block; Outcome read `t.text`. Neither question is
about `t.text`, and a turn can leave messages/decisions behind without ever writing an
ops block — so on this turn both empty states fired and contradicted each other.

**Fix:** `format.ts` gained `producedCount(OutcomeInput)` — effects summed across every
ledger category — and `outcomeOf` now calls it instead of inlining the same sum, so the
"produced" header and the empty state cannot drift apart. `drawers.tsx` derives
`wroteOps` (ops block written, live or finished) and `leftEffects` (`producedCount > 0`)
once, and both panels read those:
- Reasoning only blames "only operations" for the silence when ops were actually
  written; otherwise "The model left no narration for this turn."
- Outcome gained a third branch ahead of the other two: effects but no ops block now
  reads "No ops block in this output. This turn still produced 2 messages · 2 decisions
  — recorded from the event log below rather than written as operations." The two
  pre-existing branches are unchanged and still correct now that they only see turns
  that genuinely produced nothing.

Verified on `turn-1684a08cddc7be02`: the two panels agree, and both agree with the
`PRODUCED · 2 messages · 2 decisions` header. tsc + eslint clean.

### Minor
- Tools row renders `1  OTHER  stub_work  —` — `salientArg` yields nothing for
  `stub_work`, and family falls through to `OTHER`. Cosmetic; stub-specific.

## Environment (left running on purpose)
- mesh console **:7421** (pid 2345606) + its paired vite **:5174** (pid 2345608).
  Mission is now STARTED with 32 turns of state. Reuse these; do not `npm run dev:console`
  again — it will fail on "port 7421 already in use".
- UI is at **http://127.0.0.1:5174/#/steps** (vite serves the uncommitted source, HMR live).
- Orphan vite **:5173** (pid 2304079) from 2026-09-17 — unrelated, safe to kill.
- Headless-Chrome CDP driver written to `/tmp/shot.mjs` (kill/relaunch chrome on :9422).
  Deep link straight to a drawer: `#/steps/step/<turnId>`; rows are `li.st-row[data-turn]`.
  Sections: `#sv-outcome` `#sv-tools` `#sv-events` (`.sv-op` / `.sv-tool` / `.sv-ev`).

## Next
1. ~~Fix FINDING 2~~ — done, session 3. See above.
2. FINDING 1 still open, and still the blocker: get ops-bearing data in front of the
   OpLedger to actually verify Session 1's work. Needs a new fixture (or a scripted
   `mesh run` team that emits an ops block), not a UI edit — worth its own session.
   All 32 demo-stub turns still have zero `.sv-op` rows; nothing in session 3 changed
   that, and the OpHead/OpFact/fact-chip work remains unrendered and unverified.
3. Scope guard: step view only. Do not sweep other dashboard views in the same session.

## Turn ids are server-scoped
`turn-1684a08cddc7be02` is only valid while the current mesh console (:7421) stays up.
If it is restarted the ids regenerate — read a fresh one off `li.st-row[data-turn]`.

## Session 4 — FINDING 1 scoped. NOT implemented. Server NOT restarted.
Spent on scoping only; stopped at the phase boundary (diagnosis done / nothing authored).

### Why the stub can never exercise the ledger
- `drawers.tsx:773` — `const ops = parseOpsBlock(t.text)`. The ledger's ONLY source is the
  turn's prose `text`. Nothing else produces `.sv-op` rows.
- Live `GET :7421/turns` (32 records, keys: agentId attempt durationMs endedAt instructions
  model opTimings ops phases reason startedAt status summary text tokens* toolCalls* turnId):
  - `text` is a one-liner (`"tech-lead idle"`) — no fence, so parseOpsBlock returns null on
    all 32. That is the `{o:0}`.
  - `ops` IS populated on all 32 — but as bare STRINGS (`["done"]`, 80 total), and
    `opTimings` is `[{op,ms,ok}]`. Neither carries op FIELDS, so neither can feed
    OpHead/fact chips even in principle.
- So the stub is not "missing ops" — it records them in a shape the ledger was never
  written to read. Fixture gap, not a ledger bug. (Whether the ledger SHOULD also render
  the server's structured ops is a real design question, deliberately left unasked.)

### Restart is unavoidable (confirmed two ways)
- `TurnTracker.load()` runs once at construction during boot (`packages/core/src/supervisor.ts:599`);
  nothing watches turns.jsonl. And `save()` is a full tmp+rename overwrite (`:701-709`), so
  edits made while the server is live get clobbered on the next flush.
- No write route can create a turn. Console POST routes: goals, agents/:id/*, budgets/raise,
  approvals, tool-approvals, messages, mission/{boot,start,park,reopen,reset,limits},
  config/*, designer/*, workspace/run. `POST /messages` injects a MESSAGE, not a turn.
- User confirmed the restart on 2026-09-18. It regenerates every turn id — incl.
  `turn-1684a08cddc7be02`. Read fresh ids off `li.st-row[data-turn]`.

### The fixture recipe (no TS changes needed — pure data)
Cheapest path, found late: skip the stub-script route entirely.
- `apps/mesh-cli/src/index.ts:286-292`: `useDemo = !noDemo && meshId === "demo-stub"`;
  `fresh = opts.fresh || useDemo`; the state dir is wiped only `if (fresh && !opts.allowResume)`,
  and the demo team is attached only `if (useDemo && !opts.allowResume)`.
- Therefore `--allow-resume` suppresses BOTH the wipe and the demo attach, and the server
  boots reading `.mesh-state/logs/turns.jsonl` (currently exactly 32 lines, one TurnRecord
  per line) straight into the tracker.
Steps:
  1. Copy a real line out of `examples/demo-stub/workspace/.mesh-state/logs/turns.jsonl`
     to inherit a valid TurnRecord schema; change only `turnId` and `text`.
  2. Put a fenced block in `text`: ```mesh-json + a JSON ARRAY.
     CAUTION: the SERVER parser (`packages/agent-runtime/src/index.ts:355`) accepts only
     `mesh-json|json` — NOT `mesh-op`, which the dashboard mirror does accept. Using
     ```mesh-op corrupts a JSON payload (the tag is captured into the content).
  3. Exercise: send, publish_artifact, request_review, create_task — plus `request_research`
     (canonical per `packages/protocol/src/types.ts:1002-1034`, but has NO case in `opHead`,
     so it hits the scalars-only default branch at `drawers.tsx:~618`). Field names for the
     four recipes are at `types.ts:747` (send), `:801` (publish_artifact), `:837`
     (request_review), `:897` (create_task).
  4. Restart:  node dist/apps/mesh-cli/src/index.js console examples/demo-stub/mesh.yaml \
                 --port 7421 --allow-resume
     (dist/ is prebuilt JS; no TS rebuild required since the fixture is data only.)
  5. Do NOT start the mission — a turn flush rewrites turns.jsonl and drops the fixture.
  6. Screenshot per the loop in the Environment section; success = non-zero `.sv-op`.
Effects/badges: `matchOpEffects` pairs each op against events of its own type, so fixture
ops will show a "no effect" badge unless the event log carries matching events. Expected;
judge the ROW rendering, not the badge, unless you also fixture the events.

### Next
1. Execute the recipe above. ~10-15 calls cold.
2. Only after a non-zero `.sv-op` screenshot: judge whether OpHead/OpFact rendering is right.
3. Still scope-guarded: step view only.

## Session 5 — FINDING 1 CLOSED. Ledger renders. Screenshots: `/tmp/s4-opsA.png`, `/tmp/s4-opsB.png`
Recipe executed. Two fixture turns appended to `turns.jsonl`; both render 5 `.sv-op` rows.
No TS changed. Mission NOT started.

### Recipe correction — `--allow-resume` is WRONG, the flag is `--resume`
`apps/mesh-cli/src/index.ts:449` → `allowResume: Boolean(args.flags.resume)`. `dist/` agrees.
Booting with `--allow-resume` silently parses to `flags["allow-resume"]`, leaves
`allowResume` false, and therefore BOTH wipes `.mesh-state/` and re-attaches the demo team
(tell: the log line `demo team installed (parked)` and `GET /turns` → `[]`).
It cost one wipe here; the backup saved it. Correct boot:
  node dist/apps/mesh-cli/src/index.js console examples/demo-stub/mesh.yaml --port 7421 --resume
Tell that it worked: NO `demo team installed` line, and `GET /turns | jq length` → 34.
Also: a live console flushes on shutdown, so restoring turns.jsonl while it still runs gets
truncated to 0. Kill the console FIRST, restore second.

### Fixture (gitignored — `.gitignore:10 examples/*/workspace/`, so it never hits `git status`)
- Generator: `/tmp/mkfixture.mjs` (re-runnable; clones the last tech-lead TurnRecord, so schema
  stays valid). Pristine 32-line backup: `/tmp/turns.jsonl.bak`. BOTH ARE IN /tmp — volatile.
  Decide whether these belong in the repo; I did not add repo files on my own.
- `turn-fea7000000000a01` (tech-lead) — ops spelled per `packages/protocol/src/types.ts`.
- `turn-fea7000000000b02` (architect) — ops spelled the alternate way `opHead` also reads.
  The A/B split is the point: it isolates head-vs-schema mismatches. Ids are literal, so
  unlike session 3's they SURVIVE restarts.
- Fence is ```mesh-json + a JSON array, per the server parser. Verified with the dashboard's
  own regex before booting.

### Verdict on the rendering (what the screenshots show)
Works: numbered rows, titles, detail lines, labelled fact chips (TASK/KIND/SIZE/REVIEWERS/
ASSIGNEE), and the `opTimings` bar chart ("where the apply time went"). `request_research`
correctly gets `N/A` rather than a "no effect" badge — `OP_EFFECT_TYPES` has no entry, so
the ledger distinguishes "no effect to find" from "effect missing". That distinction holds up.

### NEW FINDINGS (not fixed — each is a UI edit, deliberately left for its own session)
1. **`opHead` reads field names the protocol does not declare.** Proven by the A/B pair:
   - `send`: head reads `o.artifactId || o.artifact || o.artifactUri` (`drawers.tsx:~560`),
     but `MeshOpSend` (`types.ts:747`) declares `artifactRefs`. Turn A (canonical) shows NO
     artifact chip; turn B (`artifactId`) shows `ARTIFACT ADR·demo`. Chip is dead for
     schema-valid sends.
   - `create_task`: head reads `o.summary ?? o.note`, but `MeshOpCreateTask` (`types.ts:897`)
     declares `description`. Turn A's row 4 has an EMPTY detail line; turn B's (`summary`)
     renders. Same class of bug.
   Worth auditing every `opHead` case against `types.ts` in one pass — these two were found
   by accident, and the lenient `||` chains suggest more.
2. **The outcome block contradicts the ledger directly under it.** Turn A's header reads
   `NO ACTION` / "Nothing was written" / "NEXT Nothing to re-run — the step attempted
   nothing", with five written ops rendered immediately below. `0 of 5 recorded` and
   `0/5 landed` are CORRECT (fixture has no matching events), but "nothing was written" is
   not — five ops were written. The classifier appears to key off landed effects rather than
   written ops, collapsing the intent/effect split the rest of the view is built on.
   Cause NOT diagnosed; symptom only.
3. Cosmetic: the default branch prints the raw op name, so `request_research` renders
   snake_case among sentence-case siblings, and its `QUESTION` chip carries a full sentence
   (chips read as short scalars elsewhere).

### Environment (left running)
- console :7421 booted with `--resume`, 34 turns. Log `/tmp/console4.log`.
- vite :5174 started SEPARATELY (`./node_modules/.bin/vite --config apps/mesh-dashboard/vite.config.mts
  --port 5174 --strictPort`, `MESH_BUS_URL=http://127.0.0.1:7421`). Log `/tmp/vite4.log`.
  NOTE: `node dist/... console` alone does NOT start vite; :7421 serves PREBUILT assets and
  would photograph a dashboard without the uncommitted work. Always shoot :5174.
- Orphan vite :5173 (pid 2304079) still unrelated, still safe to kill.
- DO NOT start the mission: a flush rewrites turns.jsonl and drops the fixture.

### Next
1. Decide where the fixture generator should live (repo vs /tmp) before /tmp is cleared.
2. Fix NEW FINDING 1 — audit all `opHead` cases against `types.ts`, one pass.
3. Then NEW FINDING 2 — the outcome classifier. Diagnose before editing.
4. Scope guard still holds: step view only.
