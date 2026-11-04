# Agent token economy and memory architecture

Research note, 2026-11-03. What the literature and the vendors say about how a long-running
agent should spend tokens and remember things, and how it compares with this runtime. Written
after a live 10-seat mission spent 110.3M billable tokens on 1,327 turns, 31% of it in 18 turns
that carried a 400-570k-token conversation.

## 1. The economics, in one sentence

An API model is stateless: every call re-sends the whole context, so a turn costs
`context size × calls in the turn`, and a mission costs that again for every turn. Everything
below is a way of lowering one of those two factors without lowering what the model knows.

Three multipliers stack on top of it:

| Multiplier | Measured |
|---|---|
| Chat to agent | ~4x tokens per task (Anthropic, multi-agent research system) |
| Chat to multi-agent | ~15x (same source) |
| Chat to multi-agent topology | up to 8x over a simple chain for some topologies (AgentPrune, ICLR 2025) |
| Cache miss vs hit | 1x vs 0.1x list (Anthropic), up to 0.03x (DeepSeek), 90% off on GPT-6 |

Anthropic's own numbers are the clearest calibration: an agent uses about four times a chat's
tokens and a multi-agent system about fifteen times, mostly because the same prompt travels
through more seats. AgentTaxo (ICML 2025 workshop) names the same effect the "communication
tax": duplicated reasoning passed between agents for validation is the largest recoverable
share of a multi-agent bill. AgentPrune reports up to 8x token consumption for star/tree
topologies compared with a chain, without a matching accuracy gain.

## 2. Context rot: the reason a big window is not a budget

Chroma tested 18 frontier models on deliberately simple retrieval and copy tasks and found
every one of them degrade as input length grew, including on tasks they solve perfectly at
short length (Hong, Troynikov, Huber, July 2025). Their practical conclusion is that a model
has an advertised window and an *effective* one; the effective one can be 20-40% of the
advertised figure and depends on the task.

Two results from that work matter for an agent runtime:

- **Focused beats complete.** On LongMemEval-style long conversations, every model answered
  better from a prompt trimmed to the relevant history than from the full transcript, at a
  fraction of the tokens.
- **Distractors compound.** One plausible-but-wrong passage lowered accuracy; four compounded
  it, and the damage grew with input length.

Anthropic's context engineering piece reaches the same place by a different route: find "the
smallest possible set of high-signal tokens" that makes the wanted outcome likely, because
context is a finite resource with diminishing returns.

For this runtime the practical reading is that a 1M window is a capability, not a target. The
200k budget now enforced by `runtime.native.context` is still generous by the literature's
standards, and the case for it is stronger than the cost case: it is where recall stops paying.

## 3. The four operations (and the one that makes them safe)

Oracle's summary of the field is the clearest taxonomy: between an evidence store and the
context window sit four operations,

1. **load eagerly** (system prompt, policy, the current task),
2. **fetch just in time** (a tool call for the file, the artifact, the search result),
3. **compact** (summarise, drop, replace with a handle),
4. **delegate** (hand a focused task to a clean sub-context).

Writing is not a fifth operation: it is the precondition. You can only compact or re-fetch what
was persisted somewhere first. Anthropic's three techniques are the same list from the other
end: compaction, structured note-taking ("agentic memory"), and sub-agents with clean windows.

That is also why a memory system is not a vector database bolted onto a chat: it is the write
path (what gets persisted), the manage path (how it is kept small and true), and the read path
(what gets injected and what is fetched on demand).

## 4. Memory architecture: what is actually being built

The 2026 surveys converge on a five-part taxonomy borrowed from cognitive psychology:

- **sensory** (raw observations, rarely explicit),
- **working** (the current reasoning state),
- **episodic** (what happened, when),
- **semantic** (facts and decisions),
- **procedural** (how to do things: skills, playbooks).

A second axis is the substrate: context-resident (always in the prompt), external store
(retrieved on demand), or parametric (trained in). A third is the control policy: who decides
what to keep, the model or the harness.

Implementations worth knowing:

| System | Core idea | Evidence |
|---|---|---|
| MemGPT / Letta | Agent-managed **memory blocks** always in context (persona, human, state), plus **recall** (searchable conversation history) and **archival** (vector store) reached by tools. Sleep-time agents rewrite memory off the critical path. | Leaderboard for memory read/write; sleep-time compute blog |
| Mem0 | LLM extracts, consolidates and retrieves facts; graph variant for relations. | 92.5 on LoCoMo at ~6,956 tokens/query; >90% token saving vs full context; 91% lower p95 latency |
| Zep / Graphiti | Temporal knowledge graph of entities and facts, with validity intervals | LoCoMo ~75% in third-party runs |
| Honcho | Session-level representations built from dialogue, retrieved per query | 89.9% LoCoMo, Pareto claim across BEAM 100k-10M |
| Full context (baseline) | Send everything | 72.9% on LoCoMo at ~26k tokens and ~10x the latency of Mem0 |

The honest reading of those numbers: full context still wins raw accuracy on a short benchmark
and loses badly on cost and latency; a memory layer trades a few points of accuracy for an
order of magnitude fewer tokens. On benchmarks at production scale (BEAM 1M and 10M), every
system drops, and temporal reasoning and event ordering are the weak categories everywhere.

The pattern that repeats across the good implementations:

- **Always-visible core** for the few facts that must never be retrieved wrong (Letta's
  blocks; this runtime's brief).
- **Searchable episodic store** for everything else (recall memory; this runtime's event log
  and artifacts).
- **A write policy** that is selective: what is worth remembering is decided at write time,
  not by stuffing everything and hoping retrieval finds it.
- **A curator** that runs outside the critical path (Letta's sleep-time agent) to dedupe,
  merge and rewrite.

## 5. Prompt caching: the discount is real, the hit rate is the product

Cache economics are not "90% off". The discount applies only to the cached prefix, the write
carries a premium (1.25x for a 5-minute Anthropic cache), and the realized saving is the hit
rate times the discount. A worked example from the vendor docs: a 700/300 hit/miss mix on a
3k prefix turns a nominal 50% discount into a 26% saving.

What the sources agree on:

- **Stable prefix first, dynamic content last.** OpenAI's own Codex notes that system
  instructions, tool definitions and environment context are kept identical and in the same
  order between requests, and the loop only appends.
- **Caching and context engineering pull in opposite directions.** Any edit to earlier
  messages invalidates every token after it; compaction therefore belongs at a decision point,
  not on every turn. Anthropic's context editing says the same and exposes `clear_at_least` so
  a clear frees enough to be worth the invalidation.
- **Agentic workloads do benefit.** The first systematic evaluation (arXiv 2601.06007, 500+
  DeepResearch sessions across OpenAI, Anthropic and Google) measured 41-80% lower API cost
  and 13-31% better time-to-first-token, and found that "place dynamic content at the end" and
  "exclude dynamic tool results from the cached prefix" beat naive full-context caching.
- **The hit rate leaks in boring ways:** idle gaps beyond the TTL, a timestamp in the system
  prompt, tools listed in a different order, a re-rendered schema.

## 6. What this runtime already does, and where it sits

The changes made this week line up with the literature almost item for item:

| Literature | This runtime |
|---|---|
| Context is a budget, not a window (Chroma) | `fit_tokens` / `session.max_context_tokens`, default `min(60% of window, 200k)` |
| Compaction at the decision point, not every turn (Anthropic, OpenAI) | compaction only at the rotation point, existing transcript appended to meanwhile |
| Drop stale tool results, keep recent ones (Anthropic `clear_tool_uses`, keep last N) | `keep_recent_messages`, `elide_above_chars`, tool-call arguments elided too |
| Structured notes survive rotation (Anthropic memory tool) | handover record, L2 memory notes, L3 decisions, artifact store |
| Sub-agents get clean windows (Anthropic) | seats are long-lived instead; rotation is the clean window, with a handover |
| Cache wants a stable prefix | system prompt stable, brief appended at the end, compaction only when the cache is being invalidated anyway |
| Multi-agent communication tax | agents pass artifact references and message ids, not payloads |

Where it still diverges from the best practice in the sources:

1. **Tool-result clearing is message-count based, not token based.** Anthropic's defaults are
   a 30k input-token trigger, keep the last 3 tool uses, clear at least 5k. This runtime
   elides by message position, and only when the whole conversation hits its budget. A seat
   with one 60k-char tool result in the middle of a turn carries it to the next rotation.
2. **The brief is a full re-render every turn.** The literature's stable-prefix advice argues
   for a fixed "core" block and a small delta (new mail, state changes) rather than re-sending
   8-12k of unchanging history. Today the brief is the dynamic tail, which is cache-correct,
   but its growth is what fills the budget.
3. **There is no retrieval path for the seat's own history.** Recall memory in MemGPT is a
   tool. Here the seat gets the brief and can read artifacts, but cannot search its own past
   turns or the event log. That is the "fetch just in time" operation, and it is the one that
   lets a small brief stay small.
4. **No procedural memory.** L2 notes are semantic/episodic. A seat does not accumulate
   "how this team does X" except in its role prompt. Letta's archival and the survey's
   procedural memory are the missing class.
5. **No curator.** Compaction is deterministic and runs on the critical path at rotation.
   Letta's sleep-time agent is the alternative: rewrite and dedupe memory between turns, off
   the path, so the brief arrives smaller.
6. **No cost telemetry per unit of value.** The ledger records tokens; it does not record
   tokens per accepted criterion, per merged artifact, or per closed thread. The literature's
   multi-agent cost comparisons are only meaningful per outcome.

## 7. Concrete options, ranked by expected effect

1. **Token-triggered tool clearing with `keep` and `clear_at_least`** (Anthropic's shape):
   when a turn's prompt passes, say, 60% of the budget, replace all but the last N tool results
   with handles, and only if that frees at least a few thousand tokens. This catches the
   in-turn growth that rotation cannot, and it is the single largest remaining lever on the
   5.7M-token class of turns.
2. **A memory curator seat** that runs between turns: dedupe L2 notes, merge duplicates into
   one line, rewrite the handover, and drop notes whose basis is superseded. It is the
   sleep-time-compute pattern, and it shrinks the brief without shrinking what the seat knows.
3. **Just-in-time retrieval tools** for the seat: `memory_search` (own notes and team
   decisions), `event_search` (the log), `artifact_search`. Then the brief can carry the ten
   obligations that matter and a pointer, instead of every obligation.
4. **Structured core/delta brief**: a stable core (mission, policy, role) and a delta (new
   mail, changed state) rendered separately. The core can live in the system prompt and be
   cached; the delta stays small.
5. **Cost per outcome**: a usage view that divides tokens by accepted criteria, merged
   patches and closed threads, plus cache-hit ratio per seat. The current ledger can produce
   every ingredient; nothing joins them.
6. **Message-size caps between agents**, with references only above a threshold, to cut the
   communication tax the multi-agent literature measures.

## 8. Postscript: what was built after this note

The four levers below were implemented the same day, in the same pass as the budget:

1. **Token-triggered, in-turn tool clearing** — `clear_tool_results_at` (60% of the budget),
   `keep_tool_uses` (3 rounds) and `clear_at_least_tokens` (5,000), the shape Anthropic's
   context editing uses, applied by the runtime that owns the conversation. The transcript is
   rewritten so a restart resumes what the model was shown.
2. **Just-in-time retrieval** — `mesh_artifact_list` (find an id by name/type/status/owner) and
   `mesh_memory_search` (a seat's own notes, including the ones the brief held back), beside
   the existing `mesh_query_events` and `mesh_artifact_read`.
3. **Procedural memory** — `mesh_remember` takes `kind: "procedure"`; the brief renders those
   under **Your playbook** and admits them before facts and turn exhaust, so a full memory
   budget cannot evict the line that says how the team works.
4. **Tokens per outcome** — `curule economy` divides the bill by accepted criteria, recorded
   reviews, merged patches, completed tasks and published artifacts, with cache-hit ratio,
   spend by seat and the turns that carried the bill. On the mission that motivated this note:
   107.3M billable tokens, 26.8M per accepted criterion, 1.79M per merged patch, 97.2% cache
   hit, and the top 5% of turns carrying 57.9% of the bill.

Still open, and deliberately not built: a sleep-time memory curator and any learned forgetting.
Both need a model call to compress meaning rather than to move bytes, and the cheap deterministic
half — dedupe by key, evict turn exhaust separately, cap the brief by tier — is already in place.

**Second pass, 2026-11-04.** Measuring the mission in invoice terms (cache reads at 0.1x) rather
than billable tokens moved the target: cache reads are 69% of the cost, so context *size* matters
more than fresh-token outliers, and the tooling now reports both. Two later sources settled the
remaining design question. *Cache Engineering for Agents* (arXiv 2610.28577, Oct 2026) shows that
modifying a trajectory prefix invalidates the retained cache and pays a re-prefill, and that
rolling tool-response eviction plus batched edits beats threshold-triggered summarization on both
accuracy and cost. Unity Horizon's cache-pricing analysis works the arithmetic explicitly: a trim
that frees 13k tokens can cost more than it saves for ~14 turns, tool-definition and system-prompt
changes are the expensive ones, and "when the context genuinely has to shrink, open a new
conversation from a summary instead of editing the old one". So the second pass did not blank the
old brief or elide write payloads mid-conversation; it moved the static half of the brief into the
system prompt (paid once, cached, never invalidated), froze the tool manifest per session, and
demoted in-turn clearing to a late overflow valve.

## 9. Sources

- Anthropic, *Effective context engineering for AI agents*, 2025-09-29 — compaction,
  structured note-taking, sub-agents. https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Anthropic, *Managing context on the Claude Developer Platform* (context editing, memory
  tool), 2025-09-29. https://www.anthropic.com/news/context-management
- Anthropic, *Context editing* (trigger/keep/clear_at_least, cache interaction).
  https://platform.claude.com/docs/en/build-with-claude/context-editing
- Anthropic, *How we built our multi-agent research system*, 2025-06-13 — 4x/15x token
  multipliers, lightweight references between agents.
  https://www.anthropic.com/engineering/multi-agent-research-system
- Chroma, *Context Rot: How Increasing Input Tokens Impacts LLM Performance*, July 2025.
  https://research.trychroma.com/context-rot
- Hong, Troynikov, Huber; summarized with the 20-40% effective-context figure in
  DeepLearning.AI's context-engineering course, 2026.
- OpenAI, *Prompt caching* and *Prompt Caching 201* — stable prefix, append-only, Codex
  practice, 90% discount on GPT-6. https://developers.openai.com/api/docs/guides/prompt-caching
- Lumer et al., *Don't Break the Cache: An Evaluation of Prompt Caching for Long-Horizon
  Agentic Tasks*, arXiv 2601.06007 — 41-80% cost reduction, 13-31% TTFT, strategy comparison.
- MemGPT / Letta: memory blocks, recall and archival memory, sleep-time compute.
  https://docs.letta.com/advanced/memory-management · https://www.letta.com/blog/sleep-time-compute
- Chhikara et al., *Mem0: Building Production-Ready AI Agents with Scalable Long-Term
  Memory*, arXiv 2504.19413 — >90% token savings, 91% lower p95 latency.
- Mem0, *The Token-Efficient Memory Algorithm*, 2026 — 92.5 LoCoMo at ~7k tokens/query.
- *A Survey of Agent Memory in the Second Half*, arXiv 2602.06052 (TMLR 2026) — five memory
  types, self-evolving memory.
- *Memory for Autonomous LLM Agents: Mechanisms, Evaluation, and Emerging Frontiers*,
  arXiv 2603.07670 — write-manage-read loop, evaluation shift to multi-session agentic tests.
- Wang et al., *AgentTaxo: Dissecting and Benchmarking Token Distribution of LLM Multi-Agent
  Systems*, ICML 2025 workshop — the communication tax.
- *AgentPrune* (ICLR 2025) — up to 8x token overhead by topology, pruning recovers most.
- Oracle, *What is context engineering?*, 2026-09-28 — load / fetch / compact / delegate.
- Fu et al., *Cache Engineering for Agents*, arXiv 2610.28577 (Oct 2026) — prefix edits invalidate
  retained cache and pay a re-prefill; rolling tool-response drop and batched edits beat
  threshold-triggered summarization (27.7% lower cost, +1.7 accuracy).
- Unity Horizon, *Does trimming an AI agent's context save money?*, 2026-09-14 — worked break-even
  arithmetic for cache invalidation; tool and system-prompt changes invalidate everything; prefer
  a planned rotation from a summary over editing a warm prefix.
