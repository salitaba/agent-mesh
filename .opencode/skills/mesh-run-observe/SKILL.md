---
name: mesh-run-observe
description: "Use when running a real agent-mesh mission to find out how the runtime actually behaves - observe a live run, digest its event log into a report of denials, stuck artifacts and no-op turns, run a plain opencode baseline on the same goal, compare quality and cost against the mesh, then propose and implement one fix. Triggers on run the mesh, observe a run, mesh vs opencode, baseline or cost comparison, is the mesh worth it, what went wrong in that mission, demo-stub, examples/*/mesh.yaml. Not for writing unit tests or reading a mission that already ran elsewhere."
---

# Run a mesh, observe it, fix one thing

Six phases, in order: **run → observe → baseline → report → ideate → implement one**.
Do not skip ahead. The point is that the fix is chosen from evidence a real run
produced, not from a guess about what the code probably does wrong.

```
- [ ] 1 run      scripts/run-mesh.sh
- [ ] 2 observe  scripts/digest-run.py
- [ ] 3 baseline scripts/run-baseline.sh + scripts/compare-runs.py
- [ ] 4 report   findings table + mesh-vs-solo table
- [ ] 5 ideate   >=5 candidates, incl. 2 that change the model not the code
- [ ] 6 fix      one. verify. stop.
```

## The rule that makes this cheap

**Never read `logs/events.jsonl` or `logs/turns.jsonl` directly.** A demo-stub
run emits ~450 events and turns.jsonl carries the entire prompt of every turn
(276 KB for 33 turns). Reading either burns the session and teaches nothing the
digest does not already print. Same for tailing a live log or polling
`/events/stream` by hand — the run script blocks until the mesh terminates, and
the digest reads what landed. Same for `baseline-events.json` — full tool
outputs, reduced by `compare-runs.py`. If you find yourself wanting a raw line,
grep the one field you need with a `| head -5` cap.

## Phase 1 — run

```bash
.opencode/skills/mesh-run-observe/scripts/run-mesh.sh [config.yaml] [timeout-seconds]
# defaults: examples/demo-stub/mesh.yaml 180
```

Last line is `STATE_DIR=<abs path>`; feed it to phase 2. Also prints
`RUN_STATUS=` (`completed`, `timeout-after-Ns`, `exit-N`, `build-failed`) and
`RUN_LOG=/tmp/mesh-run.log`.

What the script handles so you do not have to:

- builds with `npx tsc -p tsconfig.json` if `dist/` is cold (~30s). Never
  `npm run build` — that also runs vite, which observation never needs.
- picks a free port, so concurrent runs do not collide.
- `--no-tui --fresh`. Fresh wipes prior state so two runs are comparable.
- **the timeout is the only backstop.** There is no `--max-turns` /
  `--timeout` / `--budget` flag on `mesh run`. Headless mode exits on its own
  only when the goal reaches `COMPLETED` / `FAILED` / `ESCALATED`; a stalled
  mission idles forever. `RUN_STATUS=timeout-after-Ns` is itself a finding —
  digest it anyway, a stalled run's log is the most interesting kind.

Configs: `examples/demo-stub` (stub runtime, deterministic, no API key — the
default and the right choice for a fast loop), `payment-api`, `greenfield`,
`spring-boot`, `line-follower-sim`. To exercise a real model, change
`runtime.default` off `stub` to an adapter from `packages/runtime-opencode` or
`packages/runtime-http`; expect nondeterminism and real cost. `mode: "parked"`
in a config runs **zero** turns — useless here.

## Phase 2 — observe

```bash
python3 .opencode/skills/mesh-run-observe/scripts/digest-run.py "$STATE_DIR"
```

~80 lines, deterministic (no timestamps/ids), so `diff` across two runs is
meaningful. Sections, in the order they matter:

| section | what a hit means |
|---|---|
| `outcome` + `criteria NEVER satisfied` | mission verdict vs. what it actually evidenced |
| `denials (message.rejected)` | the policy engine refused an action; carries `ruleId` + `reason`. Richest signal in the file |
| `rejected ops` | supervisor refused an op mid-turn; `all ops rejected` turns are wasted turns |
| `zero tool calls` | agent read/ran/checked nothing, yet may have claimed a criterion — see `ASSERTED` in `packages/protocol/src/types.ts:318` |
| `artifacts not terminal` | stuck work; `gate-blocked xN` names the gate |
| `conflicts, escalations, deadlocks` | `review.rejected`, `requirement.blocked`, `escalation.*`, `deadlock.auto_resolved`, `budget.exceeded` |
| `projection rejections` | an event the projection refused to apply. Almost always a genuine bug, not policy |
| `budget` | tokens per agent; a lopsided total means one role is doing all the work |

`--ids` adds artifact ids (breaks diffing, use only when chasing one artifact).

Flags worth a second run to confirm: any `projection rejected` line, any
`message.rejected`, `outcome: goal.completed` alongside non-terminal artifacts,
and a documented conflict that produced zero `review.rejected`.

## Phase 3 — baseline (one plain opencode session, same goal)

The mesh only earns its overhead if a single opencode agent does worse. Run the
same goal through one headless `opencode run` and let the two runs answer that.

```bash
.opencode/skills/mesh-run-observe/scripts/run-baseline.sh [config.yaml] [timeout-seconds]
# defaults: examples/demo-stub/mesh.yaml 600
```

It extracts `mesh.goal` from the config (never retype it), runs one session in a
fresh `mktemp -d` sandbox (so it never sees the mesh's answer), and saves to
`<state_dir>/baseline/`:

| file | what it is |
|---|---|
| `baseline-events.json` | raw `--format json` stream; **never read it directly**, it carries full tool outputs |
| `baseline-export.json` | `opencode export` dump: message-level cost + tokens |
| `baseline-meta.json` | status, session id, sandbox path, wall seconds, model |
| `criteria.json` | `mesh.acceptance_criteria`, for the rubric |
| `baseline-files.txt` | sandbox tree at the end — the deliverable evidence |

`run-mesh.sh` always uses `--fresh` (demo-stub forces it), which deletes the
whole state dir recursively — a later mesh run takes `<state_dir>/baseline` with
it. Re-run this phase after any re-run of phase 1, and compare before re-running.

Then reduce both sides to one table:

```bash
python3 .opencode/skills/mesh-run-observe/scripts/compare-runs.py "$STATE_DIR" "$STATE_DIR/baseline"
```

Cost is only real when the models are real. Rules that keep it honest:

- **Stub mesh runs make zero model calls** — their token counts are synthetic.
  A demo-stub comparison is structural (turns, tool calls, gates), not
  financial. Only `runtime.default: opencode` configs (`greenfield`,
  `payment-api`, `spring-boot`) give a real $ comparison.
- Pin the baseline to the mesh adapter's model with
  `BASELINE_MODEL=provider/model`; if they differ, compare tokens, not dollars.
- Same start state: the sandbox starts empty. If the mission needs input files,
  stage them in a dir and pass `BASELINE_SEED=<dir>`. Never point it at a
  workspace that already holds the mesh's deliverable — that is the answer.
- Judge the baseline rubric from `baseline-files.txt` and the sandbox tree, not
  from the transcript. Mark UNKNOWN when the evidence is not there. A criterion
  the mesh "satisfied" with no tool calls is its own finding, not a baseline win.

## Phase 4 — report

One table. Every row needs evidence from the digest, and a claim about the
runtime, not about the code you have not read yet:

| # | observation | evidence (digest line) | why it matters | confidence |
|---|---|---|---|---|

Then name the **single most suspicious** row. Rank by: silent wrongness >
stalled mission > wasted turns > cosmetic. A mission that reports success while
leaving artifacts unfinished outranks a mission that visibly stalls, because
nothing surfaces it.

Add the mesh-vs-solo table from `compare-runs.py` (billed tokens, cost,
turns/steps, tool calls, wall span, per-criterion rubric). It changes the
ranking: a mesh that burned several times solo's tokens while meeting no more
criteria outranks a cosmetic denial count, and a criterion only the mesh caught
is the strongest argument that its gates earn their keep — provided
`requirement.satisfied` carries tool evidence.

Only now open source, and only for that row. Grep for the event type or the
`ruleId` string; do not read a whole projection file.

## Phase 5 — ideate

At least five candidates, and at least two must change the **model** rather than
patch the symptom. Prompts that force the non-obvious ones:

- The runtime is behaving correctly and the *config or role prompt* is wrong —
  what would that fix look like?
- What invariant, asserted once at the right seam, makes this whole class of
  bug impossible instead of this instance of it?
- The event log already contains the answer and nothing reads it — what
  projection is missing?
- Delete something: which rule/gate/state, removed, makes the failure moot?
- What does the digest *not* record that would have made this obvious in one
  line? (Extending `digest-run.py` is a legitimate fix.)
- Solo opencode met the same criteria for a fraction of the tokens — which mesh
  stage, role, or gate produced no marginal evidence? Delete or demote it.
- The mesh caught something solo missed (or vice versa) — name the exact gate,
  role, or evidence rule responsible; what is the smallest change that keeps
  that catch?

Score each: blast radius, evidence strength, reversibility. Pick one. Say
plainly why the others lose.

## Phase 6 — implement one

**One.** Batching two fixes makes the next run un-attributable.

- State is event-sourced. Append an event; never mutate stored state in place.
- Change `schemas/` and `packages/protocol` types together.
- `npm run typecheck` first — it is far faster than the test script, which
  rebuilds everything.
- Smallest test target, from compiled output, **glob must be quoted** (a bare
  dir path fails `MODULE_NOT_FOUND`):
  ```bash
  npx tsc -p tsconfig.json && node --test "dist/tests/<area>/<file>.test.js"
  ```
  Full suite only at the end. Baseline is 665/665.
- `npm run lint` baseline: 0 errors, 99 pre-existing `no-restricted-imports`
  warnings. That count is not a regression you caused.
- Verify by re-running phases 1-2 and **diffing the two digests**. Re-run phase
  3 only if the fix could change how a plain agent would do; it costs real model
  money. That diff is the proof, not your reading of the patch.

Never `git stash` to test a revert — a wrapper in this environment silently
creates no stash while reporting success. Edit the line back and confirm with
grep.

## Stop here

Phase 6 done + digest diff clean = the task is over. A second fix is a new
session with a fresh digest. Do not roll into "and while I was there".
