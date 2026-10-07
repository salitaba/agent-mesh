import type { ActivationReason, MeshEvent, ToolCallRecord } from "../../protocol/src/index";

/**
 * Wall-clock marks for the distinct phases of one turn, in epoch ms.
 *
 * A turn's `durationMs` alone cannot answer "where did the time go" — a 40s
 * turn is a very different problem when it is 38s of model latency versus 38s
 * of op execution. These marks make the flight recorder in the dashboard
 * possible without any extra round trips: every field is set at exactly one
 * site in `runTurn`, and any field may be absent (the turn died before it).
 */
export interface TurnPhases {
  /** Turn minted, before context assembly. */
  startedAt: number;
  /** Context bundle rendered, instructions ready — end of prep. */
  contextAt?: number;
  /** Runtime invoked; the clock that matters for TTFT starts here. */
  llmCallAt?: number;
  /** First streamed token observed — time to first token. */
  firstTokenAt?: number;
  /** Most recent streamed token — the stall detector reads this. */
  lastTokenAt?: number;
  /**
   * First sign of life of ANY kind: a streamed token OR a tool frame. An agent
   * that answers by writing files never streams prose, so `firstTokenAt` stays
   * undefined for its whole turn and it reads as "no response" while it is in
   * fact working. This is the superset — liveness belongs on it, not on the
   * token stamps.
   */
  firstActivityAt?: number;
  /** Most recent sign of life of any kind. Always >= `lastTokenAt`. */
  lastActivityAt?: number;
  /** Runtime returned a complete output. */
  llmDoneAt?: number;
  /** First op dispatched to the kernel. */
  opsStartAt?: number;
  /** Op loop finished (or was halted mid-flight). */
  opsDoneAt?: number;
  /** Turn record closed. */
  endedAt?: number;
  /**
   * When the turn will be stopped as things stand. Moves later each time an
   * active turn is extended; never later than `ceilingAt`. Absent until the
   * runtime is called. Not a phase mark — a promise about the future — so
   * readers compare it with now, never with the other stamps.
   */
  deadlineAt?: number;
  /** The hard stop no extension passes (`turn_timeout_ms` x the work-turn multiple). */
  ceilingAt?: number;
}

export type TurnPhaseName = Exclude<keyof TurnPhases, "startedAt" | "deadlineAt" | "ceilingAt">;

/**
 * One tool call as the turn is making it — the live twin of `TurnToolCall`.
 *
 * Kept on the record rather than only streamed, so a page opened (or reloaded)
 * mid-turn sees what the seat already did, and a turn that dies keeps it: the
 * finished-turn `toolCallsDetail` is only written on success.
 */
export interface LiveToolCall {
  /** The runtime's `toolCallId`. */
  id: string;
  name: string;
  /** The one argument a reader looks at: a path, a command line, a pattern. Clipped. */
  target?: string;
  status: "running" | "completed" | "failed";
  startedAt: number;
  endedAt?: number;
  /** The refusal/error text, clipped, when `status` is "failed". */
  error?: string;
}

/** Newest live tool calls a record keeps; older ones are dropped, the count is not. */
export const MAX_LIVE_TOOLS = 60;
/** Distinct files a record lists in `filesTouched`. */
export const MAX_FILES_TOUCHED = 200;
/** Longest `LiveToolCall.target`: a path or a command line, never a payload. */
export const LIVE_TOOL_TARGET_MAX = 160;
/** Longest `LiveToolCall.error`; the runtime already caps it at 300 (`TOOL_ERROR_MAX_CHARS`). */
export const LIVE_TOOL_ERROR_MAX = 300;
/** Advisories a record keeps. Two are sent per turn today; this only bounds a runaway. */
export const MAX_TURN_ADVISORIES = 10;

/**
 * The native tools whose path argument is a file the seat wrote. `Bash` can
 * write files too, but its command line is not a path, so a file written by a
 * shell redirect is not listed — `filesTouched` is a lower bound.
 */
export const FILE_WRITE_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

function clipText(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** `p` relative to `root` when it lies under it; otherwise `p` as given. */
export function relativeToRoot(p: string, root?: string): string {
  if (!root) return p;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

/**
 * The one argument of a tool call a reader of a live turn looks at, clipped.
 *
 * A native tool is named by its target: the file it writes, the command it runs,
 * the pattern it searches. A mesh tool's name already says the op, so its target
 * is what the op acts on — the artifact, task or message id, the name it
 * publishes, who it writes to. Pure and never throws: it runs on the tool-frame
 * path, where a malformed argument must not cost the turn its liveness stamp.
 */
export function liveToolTarget(name: string, args: unknown, root?: string): string | undefined {
  try {
    if (typeof args === "string") return args.trim() ? clipText(args.trim(), LIVE_TOOL_TARGET_MAX) : undefined;
    if (!args || typeof args !== "object") return undefined;
    const a = args as Record<string, unknown>;
    const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    if (isMeshToolCall(name)) {
      const id = str(a.artifactId) ?? str(a.taskId) ?? str(a.messageId) ?? str(a.decisionId) ?? str(a.threadId) ?? str(a.stepId);
      const label = str(a.name) ?? str(a.title) ?? str(a.subject) ?? str(a.topic) ?? str(a.contract);
      const to = Array.isArray(a.to) ? a.to.filter((x): x is string => typeof x === "string").join(",") : str(a.to);
      const type = str(a.type);
      const dest = to ? `${type ? `${type} ` : ""}→ ${to}` : undefined;
      const parts = [id, label, dest].filter((x): x is string => Boolean(x));
      const text = parts.length > 0 ? parts.join(" · ") : (str(a.summary) ?? str(a.reason));
      return text ? clipText(text.replace(/\s+/g, " "), LIVE_TOOL_TARGET_MAX) : undefined;
    }
    const bare = String(name ?? "").replace(/^mcp__.+?__/, "");
    // A search is named by what it looks for; its `path` is only where.
    const searched = bare === "Grep" || bare === "Glob" ? str(a.pattern) : undefined;
    const filePath = searched === undefined ? (str(a.file_path) ?? str(a.notebook_path) ?? str(a.path)) : undefined;
    if (filePath) return clipText(relativeToRoot(filePath, root), LIVE_TOOL_TARGET_MAX);
    const v = searched ?? str(a.command) ?? str(a.pattern) ?? str(a.url) ?? str(a.query);
    return v ? clipText(v.replace(/\s+/g, " "), LIVE_TOOL_TARGET_MAX) : undefined;
  } catch {
    return undefined;
  }
}

/** The file a Write/Edit/MultiEdit/NotebookEdit call writes, relative to `root` when under it. */
export function fileWritten(name: string, args: unknown, root?: string): string | undefined {
  if (!FILE_WRITE_TOOLS.has(String(name ?? "").replace(/^mcp__.+?__/, ""))) return undefined;
  if (!args || typeof args !== "object") return undefined;
  const a = args as Record<string, unknown>;
  const p = typeof a.file_path === "string" && a.file_path ? a.file_path : typeof a.notebook_path === "string" && a.notebook_path ? a.notebook_path : undefined;
  return p ? relativeToRoot(p, root) : undefined;
}

/** A note put in front of the seat mid-turn through `AgentRuntime.advise`. */
export interface TurnAdvisory {
  at: number;
  text: string;
  /** False when the runtime could not queue it (no `advise`, or no turn in flight). */
  delivered: boolean;
}

/** The snapshot of a seat's uncommitted worktree taken when its turn was stopped. */
export interface TurnCheckpoint {
  /** e.g. `refs/mesh/checkpoints/backend/turn-e78f…` */
  ref: string;
  commit: string;
  /** Worktree-relative paths the snapshot captured (dirty + untracked), capped. */
  files: string[];
}

/** Max stack frames kept per turn — enough to locate, small enough to ship. */
export const MAX_ERROR_FRAMES = 12;
export const MAX_ERROR_CHARS = 2000;
/** Cap on recorded op timings: a runaway turn must not grow memory. */
export const MAX_OP_TIMINGS = 60;
/** Cap on an ACCEPTED op's `reason` in a timing entry; a refusal's is kept whole. */
export const OP_TIMING_NOTE_MAX_CHARS = 200;

/**
 * Ops whose successful `reason` is the payload they read, not a remark about
 * how they went: `read_artifact` answers with the document itself (up to
 * `ARTIFACT_READ_MAX_CHARS`), and `contracts` with the catalogue.
 *
 * `OpResult.reason` is overloaded — a refusal's cause on failure, a caveat on
 * success, and for these two the result body — and every reader that took it
 * as the second meaning carried the third along. A read landed in the turn
 * summary as "⚠ read_artifact: # <the artifact>", which is also the seat's own
 * next context, and in the op timings shipped on every /steps response (which
 * at limit=60 had reached 1.2 MB). Named once here so the summary's caveat list
 * and the timing ring exclude the same set.
 */
export const READ_RESULT_OPS: ReadonlySet<string> = new Set(["read_artifact", "contracts"]);

/**
 * Longest string kept anywhere inside a recorded tool call's `args`.
 *
 * A `Write` carries the whole file it wrote and an `Edit` both halves of every
 * replacement, and the trace kept them verbatim: one 43.9k-char `Write` was seen
 * live, persisted in the turn ring and served whole by `/turns/:id`. 4000 keeps
 * every command line, path, query and message body a reader looks at, and cuts
 * only the payloads the workspace already holds.
 */
export const TOOL_ARG_STRING_MAX = 4000;
/** Non-mesh tool calls a turn record keeps, in execution order. */
export const MAX_TRACE_TOOLCALLS = 30;
/**
 * Mesh tool calls a turn record keeps, counted apart from {@link MAX_TRACE_TOOLCALLS}.
 *
 * One shared cap of 30 dropped the calls that matter most: a seat reads and
 * greps first and acts on the mesh last, so on a 54-call turn the ledger lost
 * the arguments of its last 10 ops -- the sends and publishes the turn was for.
 * Ops are what the ledger reconstructs a turn from, so they get their own,
 * larger allowance; with {@link TOOL_ARG_STRING_MAX} bounding each call, 120
 * of them cost a bounded amount.
 */
export const MAX_TRACE_MESH_TOOLCALLS = 120;

/**
 * One tool call as the turn trace keeps it: the runtime's record, with every
 * string in `args` clipped to {@link TOOL_ARG_STRING_MAX}.
 */
export interface TurnToolCall extends ToolCallRecord {
  /**
   * The ORIGINAL length of each string in `args` that was clipped, keyed by its
   * dotted path (`"content"`, `"edits.0.new_string"`; array items by index, and
   * `""` when `args` is itself a string). Absent when nothing was clipped, so a
   * reader can tell a whole argument from the first 4000 characters of one.
   */
  argsClipped?: Record<string, number>;
  /**
   * This call's 0-based position among ALL of the turn's tool calls. The
   * record skips calls past the caps, so a row's place in `toolCallsDetail`
   * is not its place in the turn; this is. Absent on records written before it.
   */
  index?: number;
}

/**
 * Is this one of the mesh's own bus tools, however the client spelled it?
 *
 * The MCP bridge names its tools `mesh_*`, and Claude reports an MCP tool as
 * `mcp__<server>__<tool>` -- so the bus tools arrive as `mcp__mesh__mesh_send`,
 * and a bare `startsWith("mesh_")` matched none of them. That made every mesh
 * call count as a VERIFICATION tool at the criterion gate. The server prefix is
 * stripped rather than matched as `mcp__mesh__`, because the server name is the
 * client's configuration, not the mesh's.
 */
export function isMeshToolCall(name: string): boolean {
  return String(name ?? "").replace(/^mcp__.+?__/, "").startsWith("mesh_");
}

/**
 * The mesh tools that READ the thing a claim rests on. Reading an artifact's
 * content is checking it, however the read was made, so the verification gate
 * counts these although every other mesh tool is the act of claiming, not the act
 * of checking. Matched the way `isMeshToolCall` matches: the client's server prefix
 * is stripped.
 *
 * Until this existed a tech lead that read a whole artifact twice through
 * `mesh_artifact_read` and then approved it was "unverified" (`toolCalls: 0`), and
 * the PM had to spend a second round on a bare `ls` before its acceptance counted:
 * every criterion in the cronlite run was accepted twice, a blind round and a
 * token-cheap one, five extra rounds for nothing either one proved.
 */
export function isEvidenceRead(name: string): boolean {
  return String(name ?? "").replace(/^mcp__.+?__/, "") === "mesh_artifact_read";
}

/**
 * Clip every string inside a tool call's arguments to {@link TOOL_ARG_STRING_MAX}.
 *
 * Pure, and it never throws: it runs while a turn record is being written, and
 * a trace must not be able to fail the turn it describes. Structure is kept
 * exactly -- only over-long strings change -- so a reader still sees which keys
 * the call passed.
 */
export function boundToolArgs(args: unknown): { args: unknown; argsClipped?: Record<string, number> } {
  const clipped: Record<string, number> = {};
  const seen = new WeakSet<object>();
  const walk = (v: unknown, at: string): unknown => {
    if (typeof v === "string") {
      if (v.length <= TOOL_ARG_STRING_MAX) return v;
      clipped[at] = v.length;
      return v.slice(0, TOOL_ARG_STRING_MAX);
    }
    if (v === null || typeof v !== "object") return v;
    // Arguments arrive as parsed JSON, which cannot cycle; anything else that
    // reaches here must still not hang the turn.
    if (seen.has(v)) return "[circular]";
    seen.add(v);
    const child = (k: string | number): string => (at === "" ? String(k) : `${at}.${k}`);
    if (Array.isArray(v)) return v.map((x, i) => walk(x, child(i)));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = walk(x, child(k));
    return out;
  };
  try {
    const bounded = walk(args, "");
    return Object.keys(clipped).length > 0 ? { args: bounded, argsClipped: clipped } : { args: bounded };
  } catch {
    return { args: "[unrecordable arguments]" };
  }
}

/**
 * The tool calls a turn record keeps: in execution order, up to
 * {@link MAX_TRACE_TOOLCALLS} non-mesh calls PLUS up to
 * {@link MAX_TRACE_MESH_TOOLCALLS} mesh calls, each with bounded `args`.
 *
 * `TurnRecord.toolCalls` stays the uncapped count, so `toolCalls >
 * toolCallsDetail.length` is how a reader knows calls were left out.
 */
export function traceToolCalls(calls: readonly ToolCallRecord[] | undefined): TurnToolCall[] {
  const kept: TurnToolCall[] = [];
  let mesh = 0;
  let other = 0;
  for (const [index, call] of (calls ?? []).entries()) {
    if (isMeshToolCall(call.name)) {
      if (mesh >= MAX_TRACE_MESH_TOOLCALLS) continue;
      mesh++;
    } else {
      if (other >= MAX_TRACE_TOOLCALLS) continue;
      other++;
    }
    const { args, argsClipped } = boundToolArgs(call.args);
    kept.push({ ...call, args, ...(argsClipped ? { argsClipped } : {}), index });
  }
  return kept;
}

/**
 * What the client writes against a tool call whose result it never delivered because the turn
 * was ended under it. It is the same sentence it uses when a person refuses a call, so the text
 * alone says nothing about who ended the turn, and is only read together with what the mesh
 * itself recorded.
 */
const CLIENT_ENDED_CALL = /The user doesn't want to proceed with this tool use/;

/**
 * A handover turn's continuity call, as the turn record should say it went.
 *
 * `write_continuity` is the whole of a handover turn, and once it lands the supervisor ends the
 * turn (`endTurn`) to save the model calls that would follow: each would re-send the outgoing
 * session's whole transcript. The client then reports the call, whose result it never delivered,
 * as rejected, so every handover was recorded as a turn whose one tool call FAILED: 13 of 13
 * across the recorded runs, each beside a `continuity.recorded` event saying it worked. The audit
 * said the opposite of the log, and anyone counting failed mesh calls counted those.
 *
 * The op result is the mesh's own: a `write_continuity` that came back ok landed. So a call the
 * client reports as ended-under-it is set to completed, one per landed write and no more, and only
 * when the client's text says that is what happened to it. A continuity call that failed for any
 * other reason (its arguments were refused) keeps its error, and so does one with no landed write
 * behind it.
 */
export function settleContinuityCalls(
  calls: readonly ToolCallRecord[] | undefined,
  results: ReadonlyArray<{ op: string; ok: boolean }>,
): ToolCallRecord[] | undefined {
  if (!calls) return undefined;
  let landed = results.filter((r) => r.op === "write_continuity" && r.ok).length;
  if (landed === 0) return calls as ToolCallRecord[];
  return calls.map((call) => {
    if (landed === 0 || call.status !== "failed" || !call.error || !CLIENT_ENDED_CALL.test(call.error)) return call;
    if (!/(^|__)mesh_write_continuity$/.test(call.name)) return call;
    landed--;
    const { error: _ended, ...rest } = call;
    return { ...rest, status: "completed" as const };
  });
}

/**
 * Ops whose successful `reason` is DATA — an id, a sha, or the seat's own words
 * echoed back — rather than a caveat about how the op went. A superset of
 * {@link READ_RESULT_OPS}, and only the turn summary's caveat list reads it: the
 * timing ring keeps these reasons (short, and useful there), clipped as usual.
 *
 * Each of these used to surface as "⚠ <op>: <reason>" in the seat's next context
 * and the operator's notices — "⚠ propose_decision: dec-…", "⚠ commit: 4f1c…",
 * "⚠ merge: merged as …" — a warning sign on an op that did exactly what it was
 * asked, and in the one turn of the 2026-09-25 run that committed 4,082 lines,
 * part of the reason nothing in its summary said so (NOTES live-run §18).
 */
export const DATA_RESULT_OPS: ReadonlySet<string> = new Set([
  ...READ_RESULT_OPS,
  // the decision id
  "propose_decision",
  // the lease id
  "acquire_lease",
  "release_lease",
  // the commit sha
  "commit",
  // "merged as <sha>" / "materialized …"
  "merge",
  // the worker id
  "spawn_worker",
  // the seat's own reason, echoed back
  "discharge",
  "withdraw",
]);

export interface OpTiming {
  /**
   * The mesh op that ran (`MeshOp.op`, e.g. `send`). Ops arrive only as typed
   * `mesh_*` tool calls now, so this is the op the call resolved to — not text
   * the agent wrote, and not the MCP tool's own name.
   */
  op: string;
  /** Wall time this single op spent inside the kernel, ms. */
  ms: number;
  /** Whether the kernel accepted it. */
  ok: boolean;
  /**
   * The op result's `reason`, bounded by {@link boundOpTiming}: on a refusal,
   * the refusal, whole — it is the one line an operator needs; on success, the
   * caveat the kernel attached, clipped to {@link OP_TIMING_NOTE_MAX_CHARS};
   * absent for a successful {@link READ_RESULT_OPS} op, whose `reason` is the
   * payload it read.
   */
  reason?: string;
}

/**
 * Bound one op timing before it enters the ring, which ships on every /steps
 * and /turns response and is persisted with the turn.
 *
 * Applied in `noteOp` rather than at the call sites, so no caller — there are
 * two in the supervisor, one per op channel — can put a document into the ring
 * by forgetting to. Pure and exported so the rule can be asserted on its own.
 */
export function boundOpTiming(t: OpTiming): OpTiming {
  if (t.reason === undefined || !t.ok) return t;
  const { reason, ...rest } = t;
  if (READ_RESULT_OPS.has(t.op)) return rest;
  return reason.length > OP_TIMING_NOTE_MAX_CHARS ? { ...rest, reason: `${reason.slice(0, OP_TIMING_NOTE_MAX_CHARS - 1)}…` } : t;
}

export interface TurnError {
  /** Constructor name: RuntimeFailure, BackendUnreachableError, TypeError… */
  kind: string;
  message: string;
  /** Trimmed stack frames, innermost first. Absent when the throw had none. */
  frames?: string[];
  /** `cause` chain, flattened outward — where a wrapped error really began. */
  causes?: Array<{ kind: string; message: string }>;
  /** Which phase the turn died in, when known. */
  phase?: TurnPhaseName | "prep";
}

/**
 * Fallback token budget for a delegated worker whose mesh declares none.
 *
 * Exported because it was an inline literal that appeared in no config surface:
 * `mesh.yaml` could declare `delegation.worker_budget_tokens`, and if it did not,
 * a worker silently received this number on a ledger of its own that is charged
 * to neither its parent nor any declared seat — and then climbed the same 8x
 * auto-raise ladder to 8x this. Measured 2026-09-24: two workers reached 196,027
 * tokens between them against ledgers no config line mentioned.
 */
export const DEFAULT_WORKER_BUDGET_TOKENS = 50_000;

/**
 * The token ceiling a spawned worker gets.
 *
 * Precedence is requested → configured → fallback, then clamped to the parent's
 * own ceiling. The clamp is the point: a worker's ledger is separate from its
 * parent's, so without it `spawn_worker { budgetTokens }` would be a way to mint
 * budget the delegating seat does not have, and delegating would be strictly
 * cheaper than doing the work. An unmetered parent (`undefined`) clamps nothing.
 */
export function workerBudgetFor(
  requested: number | undefined,
  configured: number | undefined,
  parentCeiling: number | undefined,
): number {
  const wanted = requested ?? configured ?? DEFAULT_WORKER_BUDGET_TOKENS;
  const sane = Number.isFinite(wanted) && wanted > 0 ? Math.floor(wanted) : DEFAULT_WORKER_BUDGET_TOKENS;
  return parentCeiling === undefined ? sane : Math.min(sane, parentCeiling);
}

/**
 * Discard reasons that mean the turn RAN and died, so the seat needs telling.
 *
 * `budget_blocked` never reached the model, and `no_ops` / `all_rejected` /
 * `rotation_handoff` return normally and have already written their own turn
 * note from `endSummary`. These are the endings that throw, and a throw escapes
 * upstream of that write — which is why they needed a second one.
 *
 * `interrupted` (an operator stop) is not a failure, but it throws out of the
 * turn the same way, and the seat needs telling just as much: it was stopped
 * mid-thought and will otherwise open its next turn as if nothing happened.
 *
 * `budget` is the supervisor's own classification of a turn the budget watch
 * stopped (`budgetStops`, set when the interrupt is ordered). It threw like the
 * rest — the runtime's abort, or the forced settle after it — and before it was
 * named here the seat was told its stream had gone quiet, which is a different
 * fault with a different remedy.
 */
export const ABNORMAL_TURN_ENDINGS: ReadonlySet<string> = new Set([
  "timeout",
  "silence",
  "failed",
  "interrupted",
  "budget",
]);

/**
 * What one turn landed on the mesh, counted from the events correlated to it.
 *
 * The runtime's account, not the model's. The one turn of the 2026-09-25 run that
 * committed 4,082 lines and 80 tests was summarised to the operator as "Turn
 * complete. What happened: — ⚠ read_artifact: … ⚠ 3 files NOT committed" —
 * every word about it was a caveat, and nothing said what had landed (NOTES
 * live-run §18). The same tally is what a successor of a turn that did NOT
 * finish needs to hear first: its claim and its messages were durable while the
 * advisory it was handed said nothing of them (§3).
 *
 * Counts, plus a few ids a reader can act on. Live-only: built by a per-turn
 * subscription and dropped when the turn settles.
 */
export interface TurnEffectTally {
  /** `artifact.created`. */
  published: number;
  /** `artifact.versioned` that is not a commit. */
  versioned: number;
  /** `artifact.versioned` carrying `metadata.commit` — what the `commit` op records. */
  commits: number;
  /** A non-derived `artifact.transition` to MERGED — what `opMerge` records. */
  merges: number;
  /** `message.sent`. */
  messages: number;
  /** `review.requested`, which rides on a REQUEST_REVIEW already counted in `messages`. */
  reviewRequests: number;
  /** Verdicts, one per seat per artifact per direction (see `noteTurnEffect`). */
  verdicts: number;
  tasksCreated: number;
  tasksClaimed: number;
  tasksCompleted: number;
  decisions: number;
  escalations: number;
  /** Tasks claimed, by id. Bounded by {@link MAX_TALLY_NAMES}. */
  claimedTaskIds: string[];
  /** Artifacts published or versioned, by name. Bounded by {@link MAX_TALLY_NAMES}. */
  artifactNames: string[];
  /** Verdict identities already counted; see `noteTurnEffect`. */
  verdictKeys: string[];
}

/** Names kept per list in a {@link TurnEffectTally}: enough to act on, small enough to render. */
export const MAX_TALLY_NAMES = 5;

/**
 * Did the turn MAKE anything: an artifact, a commit, a merge, a request for review, a verdict, a task or a decision?
 *
 * What a seat says (a message), what it holds (a claim) and what it raises (an escalation) are not in it, and neither is a
 * plan or a note: a turn that only talked has made nothing. Read by `done`, which must know whether a seat that said it was
 * waiting has anything to show for the task it holds.
 */
export function turnMadeSomething(t: TurnEffectTally): boolean {
  return t.published + t.versioned + t.commits + t.merges + t.reviewRequests + t.verdicts + t.tasksCreated + t.decisions > 0;
}

export function newTurnEffectTally(): TurnEffectTally {
  return {
    published: 0,
    versioned: 0,
    commits: 0,
    merges: 0,
    messages: 0,
    reviewRequests: 0,
    verdicts: 0,
    tasksCreated: 0,
    tasksClaimed: 0,
    tasksCompleted: 0,
    decisions: 0,
    escalations: 0,
    claimedTaskIds: [],
    artifactNames: [],
    verdictKeys: [],
  };
}

function pushBounded(list: string[], value: unknown): void {
  if (typeof value !== "string" || !value || list.includes(value) || list.length >= MAX_TALLY_NAMES) return;
  list.push(value);
}

/**
 * Count one event into a turn's tally. The caller decides correlation; this
 * decides what the event IS. Events it does not name are ignored, so passing it
 * everything correlated to a turn is safe.
 *
 * Verdicts are keyed by seat, artifact and direction rather than counted per
 * event: an architecture-domain approval is written as `architecture.approved`
 * today, and a ledger that also writes `review.approved` for the same act (NOTES
 * live-run §10) must not make one approval read as two.
 */
export function noteTurnEffect(tally: TurnEffectTally, event: Pick<MeshEvent, "type" | "payload" | "actorId">): void {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case "artifact.created": {
      tally.published++;
      pushBounded(tally.artifactNames, (p.artifact as { name?: unknown } | undefined)?.name);
      return;
    }
    case "artifact.versioned": {
      const artifact = p.artifact as { name?: unknown; metadata?: { commit?: unknown } } | undefined;
      if (typeof artifact?.metadata?.commit === "string" && artifact.metadata.commit) tally.commits++;
      else tally.versioned++;
      pushBounded(tally.artifactNames, artifact?.name);
      return;
    }
    case "artifact.transition":
      if (p.to === "MERGED" && p.derived !== true) tally.merges++;
      return;
    case "message.sent":
      tally.messages++;
      return;
    case "review.requested":
      tally.reviewRequests++;
      return;
    case "review.approved":
    case "review.rejected":
    case "architecture.approved": {
      const key = `${String(p.actorId ?? event.actorId ?? "")}:${String(p.artifactId ?? p.subject ?? "")}:${event.type === "review.rejected" ? "reject" : "approve"}`;
      if (tally.verdictKeys.includes(key)) return;
      tally.verdictKeys.push(key);
      tally.verdicts++;
      return;
    }
    case "task.created":
      tally.tasksCreated++;
      return;
    case "task.claimed":
      // `agentId: null` is a RELEASE (the recovery path writes one), not a claim.
      if (typeof p.agentId !== "string" || !p.agentId) return;
      tally.tasksClaimed++;
      pushBounded(tally.claimedTaskIds, p.taskId);
      return;
    case "task.completed":
      tally.tasksCompleted++;
      return;
    case "decision.proposed":
      tally.decisions++;
      return;
    case "escalation.requested":
      tally.escalations++;
      return;
    default:
      return;
  }
}

/**
 * The tally as one comma-separated clause, or undefined when nothing landed.
 * No prefix: the turn summary and the unfinished-turn note frame it differently.
 */
export function summarizeTurnEffects(tally: TurnEffectTally): string | undefined {
  const n = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;
  const parts: string[] = [];
  if (tally.published > 0) parts.push(`${n(tally.published, "artifact")} published`);
  if (tally.versioned > 0) parts.push(n(tally.versioned, "new artifact version"));
  if (tally.commits > 0) parts.push(n(tally.commits, "commit"));
  if (tally.merges > 0) parts.push(n(tally.merges, "merge"));
  if (tally.messages > 0) {
    parts.push(`${n(tally.messages, "message")} sent${tally.reviewRequests > 0 ? ` (${n(tally.reviewRequests, "review request")})` : ""}`);
  }
  if (tally.verdicts > 0) parts.push(n(tally.verdicts, "verdict"));
  if (tally.tasksCreated > 0) parts.push(`${n(tally.tasksCreated, "task")} created`);
  if (tally.tasksClaimed > 0) {
    parts.push(`${n(tally.tasksClaimed, "task")} claimed${tally.claimedTaskIds.length > 0 ? ` (${tally.claimedTaskIds.join(", ")})` : ""}`);
  }
  if (tally.tasksCompleted > 0) parts.push(`${n(tally.tasksCompleted, "task")} completed`);
  if (tally.decisions > 0) parts.push(`${n(tally.decisions, "decision")} proposed`);
  if (tally.escalations > 0) parts.push(`${n(tally.escalations, "escalation")} raised`);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

/**
 * What the runtime could establish about a turn that did not finish, for
 * {@link abnormalTurnNote}. Every field is a fact read at the moment of the stop.
 */
export interface UnfinishedTurnFacts {
  /** What the turn landed before it stopped, from its correlated events. */
  landed: TurnEffectTally;
  /**
   * Files left in the seat's worktree and never committed, runtime-owned paths
   * excluded. Absent when the seat has no worktree or git could not answer —
   * which is unknown, not clean.
   */
  uncommitted?: { files: string[]; untracked: number };
  /** Whether the seat may commit at all; the note prescribes `commit` only to a seat that can issue it. */
  canCommit?: boolean;
  /** The task the seat still holds. The slow-turn path does not release it. */
  heldTask?: { id: string; title?: string };
  /** The snapshot of `uncommitted` taken at the stop (`WorkspacePort.checkpointWorktree`). */
  checkpoint?: { ref: string; commit: string };
  /**
   * What the turn asked Write/Edit to write (`TurnRecord.filesTouched`). Read
   * only when `uncommitted` is unknown: a worktree listing, when there is one,
   * is the truth about what is on disk; this is what the seat meant to put there.
   */
  filesTouched?: string[];
}

/**
 * What a seat needs to read about its own turn that never finished.
 *
 * Built from facts, not a template. The template this replaces told a seat three
 * things that were false for the turn it was written for (NOTES live-run
 * 2026-09-25 §3): backend's timed-out turn had claimed its task 80 s in and left
 * 21 untracked files (~5.6k lines) in its worktree, and it was told neither; it
 * was told to read fewer files (it had been writing them); and it was told to
 * "close with an ops block", a channel that no longer exists — a turn ends with
 * `mesh_done` or `mesh_wait`.
 *
 * The instruction not to simply retry stays, and stays load-bearing: a seat told
 * only "your turn failed" retries the identical approach (2026-09-24: 302,667
 * tokens on one 20-minute timeout, and its successor re-entered the same turn).
 * What changes is the remedy, which now depends on what survived.
 *
 * `facts` is optional so a caller that cannot establish them says so rather than
 * implying nothing landed. Pure and exported so the wording can be asserted
 * without booting a mesh.
 */
export function abnormalTurnNote(
  discard: { reason: string; detail?: string; tokens?: number; partial?: boolean },
  durationMs: number,
  facts?: UnfinishedTurnFacts,
): string {
  // `interrupted` covers two stops that must not be confused in the seat's
  // note: the operator's (`interruptTurn`) and the mesh's own shutdown, which
  // the supervisor closes the same way (`closeShutdownStoppedTurn`) and names in
  // `detail`. Telling a seat "the operator stopped you" after a restart would
  // send it looking for an instruction that was never given.
  const byShutdown = discard.reason === "interrupted" && (discard.detail ?? "").startsWith("stopped by the mesh shutting down");
  const byOperator = discard.reason === "interrupted" && !byShutdown;
  // A budget stop is `budget` since 2026-09-27 — the supervisor knows its own
  // watch ordered the interrupt, so the wording comes off the classification
  // rather than out of the detail prose. The detail test stays as a fallback
  // for logs written before that, where the same stop is classified `silence`
  // (or `failed` when the forced settle fired) and its words are the only trace
  // of the cause.
  const byBudget = discard.reason === "budget";
  const how = byShutdown
    ? "was stopped when the mesh shut down — nothing you did caused it, and your saved work is intact"
    : byOperator
    ? "was stopped by the operator"
    : byBudget || discard.detail?.startsWith("turn budget exceeded")
      ? "was stopped when its live spend passed what your budget had left"
      : discard.reason === "timeout"
        ? "was stopped on the turn timeout"
        : discard.reason === "silence"
          ? "was interrupted after its output stream went silent"
          : "was lost to a backend failure";
  // Absent tokens mean UNMEASURED, never zero — the same convention
  // `turn.discarded` carries. An invented 0 would read to the seat as "that
  // attempt was free", which is the opposite of true.
  // A figure the stream had reached when the stop came is a lower bound, and is said so.
  const spend = discard.tokens !== undefined ? ` having spent ${discard.partial ? "at least " : ""}${discard.tokens} tokens` : " (spend unmeasured)";
  const lines: string[] = [`⚠ your previous turn did not finish — it ${how} after ${Math.round(durationMs / 1000)}s${spend}.`];
  // The seat must not read a stop as a rollback: nothing the turn did was
  // undone, and a seat that believes otherwise rewrites the files it already has.
  if (byOperator) {
    lines.push("It was not a failure, and the stop undid nothing: files it already wrote are still on disk, and mesh tool calls it completed are durable.");
  }
  let anythingSurvived = true;
  if (!facts) {
    // Unknown is not "nothing". Mesh tool calls commit immediately, so a stopped
    // turn's claims, publishes and messages are durable while its reasoning is
    // gone; a note that implied otherwise invites the seat to redo held work.
    lines.push("Its reasoning is lost, but any mesh tool calls it completed are ALREADY DURABLE — read the log for your own effects before redoing anything.");
  } else {
    const landed = summarizeTurnEffects(facts.landed);
    const files = facts.uncommitted?.files ?? [];
    // Native file writes are not in the log, so "read the log for your own
    // effects" could never find them: a live backend turn wrote 37 files in 94
    // tool calls, was killed at the timeout, and its successor was pointed at a
    // log holding none of them. With no worktree listing to read, what the turn
    // asked to write is the next best account.
    const touched = facts.uncommitted ? [] : (facts.filesTouched ?? []);
    anythingSurvived = landed !== undefined || files.length > 0 || touched.length > 0;
    const list = (names: string[]): string =>
      names.slice(0, MAX_TALLY_NAMES).join(", ") + (names.length > MAX_TALLY_NAMES ? `, +${names.length - MAX_TALLY_NAMES} more` : "");
    if (landed) lines.push(`Already durable, do not redo it: ${landed}.`);
    if (files.length > 0) {
      lines.push(
        `${files.length} file(s) it wrote are still in your worktree, NOT committed (${facts.uncommitted!.untracked} untracked): ${list(files)} — ` +
          `they were not lost, so build on them rather than writing them again` +
          (facts.canCommit ? "; commit them (take a write lease, then `commit`) before you go further." : ".") +
          (facts.checkpoint ? ` A snapshot of them is kept at \`${facts.checkpoint.ref}\` (commit ${facts.checkpoint.commit.slice(0, 12)}), so a reset cannot lose them.` : ""),
      );
    } else if (touched.length > 0) {
      lines.push(
        `It wrote or edited ${touched.length} file(s): ${list(touched)} — check what is on disk and continue from them rather than writing them again.`,
      );
    }
    if (!anythingSurvived) lines.push(`Nothing it did reached the mesh${facts.uncommitted ? " or your worktree" : ""}.`);
    if (facts.heldTask) {
      lines.push(`You still hold task ${facts.heldTask.id}${facts.heldTask.title ? ` ("${facts.heldTask.title}")` : ""} — the stop did not release it.`);
    }
    lines.push("Its reasoning is lost.");
  }
  if (byOperator) {
    // Not "make this turn SMALLER": the operator stopped it, which says nothing
    // about its size. What the operator wants next is theirs to say.
    lines.push(
      "If the operator sent you instructions, follow them first. Otherwise do not simply restart the same approach: " +
        `${anythingSurvived && facts ? "continue from what survived" : "decide the next step before you take it"}, ` +
        "and end the turn with `mesh_done` (or `mesh_wait`) so it records why it stopped" +
        (discard.detail ? ` — recorded as: ${discard.detail}` : "") +
        ".",
    );
    return lines.join(" ");
  }
  lines.push(
    `DO NOT simply retry the same approach: ${anythingSurvived && facts ? "continue from what survived and land one piece before starting the next" : "make this turn SMALLER — one step at a time"}, ` +
      "and end the turn with `mesh_done` (or `mesh_wait`) so it records why it stopped" +
      (discard.detail ? ` — the runtime reported: ${discard.detail}` : "") +
      ".",
  );
  return lines.join(" ");
}

/**
 * Normalize anything throwable into a bounded, serializable shape.
 *
 * Deliberately defensive: this runs on the failure path, where the thrown
 * value may be a string, a frozen object, or an error whose getters throw.
 * It must never throw itself or the original failure is lost.
 */
export function describeError(err: unknown, phase?: TurnError["phase"]): TurnError {
  try {
    if (!(err instanceof Error)) {
      return { kind: typeof err, message: String(err).slice(0, MAX_ERROR_CHARS), phase };
    }
    const frames = typeof err.stack === "string"
      ? err.stack
          .split("\n")
          .slice(1)
          .map((l) => l.trim())
          .filter((l) => l.startsWith("at "))
          .slice(0, MAX_ERROR_FRAMES)
      : undefined;
    const causes: Array<{ kind: string; message: string }> = [];
    let cur: unknown = (err as { cause?: unknown }).cause;
    // Bounded walk: a self-referential cause chain must not hang the process.
    for (let i = 0; i < 4 && cur; i++) {
      const c = cur as Error;
      causes.push({
        kind: c?.constructor?.name ?? typeof cur,
        message: String((c as Error)?.message ?? cur).slice(0, 300),
      });
      cur = (cur as { cause?: unknown })?.cause;
    }
    return {
      kind: err.constructor?.name ?? "Error",
      message: String(err.message ?? "").slice(0, MAX_ERROR_CHARS),
      ...(frames && frames.length ? { frames } : {}),
      ...(causes.length ? { causes } : {}),
      phase,
    };
  } catch {
    return { kind: "Error", message: "unprintable error", phase };
  }
}

export interface TurnRecord {
  turnId: string;
  agentId: string;
  reason: ActivationReason;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  status: "running" | "ok" | "waiting" | "blocked" | "failed";
  tokens?: number;
  tokensInput?: number;
  tokensOutput?: number;
  /**
   * Replayed prompt prefix the backend reported for this turn. Unbilled, but
   * it is the only measurement of how big a transcript the seat is carrying.
   *
   * Read it against `tokensInput`: a healthy turn on a persistent session is a
   * small fresh `tokensInput` beside a large `tokensCacheRead`, because the
   * transcript was served from cache. A turn whose `tokensInput` is as large as
   * its history is a COLD turn — the prefix was re-sent and billed at full
   * price. Without this field those two cases are the same number here, which
   * is how a handful of catastrophic cold re-reads stayed invisible while
   * every average looked healthy.
   *
   * Cache writes need no field of their own: `total` is
   * `input + output + cacheWrite`, so a write is `tokens - tokensInput -
   * tokensOutput` and stays derivable.
   */
  tokensCacheRead?: number;
  /**
   * The part of `tokensOutput` the backend spent thinking rather than saying.
   *
   * Billed identically to any other output token — which is the most expensive
   * rate the mesh pays — and until this field existed it was billed invisibly:
   * `tokensOutput` said a turn wrote 26k tokens, and nothing said whether that
   * was a long artifact or a long deliberation. Those two want opposite fixes,
   * so collapsing them made the output column unactionable.
   *
   * Absent means UNMEASURED, not zero. Not every backend reports the split, and
   * a gateway that omits the detail must not be read as a model that did no
   * thinking — the same discipline `tokensCacheRead` keeps, where a missing
   * value is unknown rather than cold. Readers: check `=== undefined` before
   * arithmetic, never `?? 0`.
   */
  tokensThinking?: number;
  model?: string;
  ops?: string[];
  toolCalls?: number;
  /**
   * The turn's tool calls, capped. `status`/`error` say whether each call
   * worked — a permission-gate refusal is `failed` with the refusal as `error`.
   * Both are absent on records written before they existed and on a call whose
   * result never arrived: read absence as unknown, not as success.
   *
   * Execution order, up to 30 non-mesh calls plus up to 120 mesh calls (see
   * `traceToolCalls`); records written before that kept the first 30 of any
   * kind. Strings in `args` are clipped, and `argsClipped` says which.
   */
  toolCallsDetail?: TurnToolCall[];
  summary?: string;
  /**
   * The kernel's and supervisor's own remarks on this turn, one per string, in
   * the order they appear in `summary`: the opening verdict (all rejected, no
   * ops, only planned …), each accepted-with-caveat op, the uncommitted-work
   * advisory, a model substitution, or the note on a turn that never finished.
   *
   * `summary` is the SEAT's view — one string, because it becomes the seat's
   * next context verbatim, and it must stay byte-identical. This is the same
   * content for a reader that has to tell the mesh's voice from the model's:
   * parsing `summary` for that means splitting on " — ", which the model's own
   * text is free to contain. An empty array means the turn drew no remark;
   * absent means the record predates the field.
   */
  notices?: string[];
  /**
   * What the model said the turn was, on its own — the declared `mesh_done`
   * summary, else the first line of its reply, capped at 500. `summary` embeds
   * this inside a notice ("… — model said: …") whenever the mesh had something
   * to add, so this is the only place the seat's words survive unmixed. Absent
   * when the model said nothing, and on older records.
   */
  modelSummary?: string;
  /** Full LLM output text (the token stream). Truncated server-side. */
  text?: string;
  /** What the agent was asked to do — visible while still THINKING. Truncated. */
  instructions?: string;
  error?: string;
  /**
   * Structured failure detail. A bare `error` string tells you a turn broke
   * but not where, so every crash meant re-running the mission with debug
   * env vars set. Truncated and frame-limited: this is a trace to orient
   * from, not a full core dump.
   */
  errorDetail?: TurnError;
  /** Phase wall-clock marks — see TurnPhases. */
  phases?: TurnPhases;
  /**
   * Per-op execution timing, in execution order. The ops leg is a single bar
   * on the phase rail; when that bar is the slow one this says which op made
   * it slow, which "ops: 4.2s" cannot.
   */
  opTimings?: OpTiming[];
  /** 1 for a first try; >1 when the scheduler re-activated after a timeout. */
  attempt?: number;
  /** Characters streamed so far — throughput without re-measuring `text`. */
  streamChars?: number;
  /** Number of `onToken` deltas seen — distinguishes chunky from smooth. */
  streamFrames?: number;
  /**
   * Tool frames seen this turn. A file-writing agent produces these and no
   * prose, so this is the only throughput number its turn ever has.
   *
   * FRAMES, not calls: a call's start and its result are both frames, so this
   * is about twice `toolCallCount`. Label it as calls and every count doubles.
   */
  toolFrames?: number;
  /** Tool calls announced so far this turn (one per `tool_call` frame). */
  toolCallCount?: number;
  /** Most recent tool calls, oldest first, capped at `MAX_LIVE_TOOLS`. Kept when the turn fails. */
  liveTools?: LiveToolCall[];
  /**
   * Files the turn wrote or edited, first-seen order, from the path argument of
   * Write/Edit/MultiEdit/NotebookEdit calls. Capped at `MAX_FILES_TOUCHED`.
   * What the seat ASKED to write, not a diff: a failed Edit is still listed.
   */
  filesTouched?: string[];
  /**
   * Tokens spent so far, from the runtime's cumulative `usage_update` frames, in
   * the unit the turn is billed in: `total` (cache reads excluded) plus cache
   * reads at `budgets.cache_read_weight` — 0 by default, so plain `total`. The
   * same figure the mid-turn budget interrupt compares with the seat's headroom.
   * Absent when the runtime reports none — unknown, not zero. Superseded by
   * `tokens` once the turn ends; kept on a failed turn, where it may be the only
   * figure the turn has.
   */
  liveTokens?: number;
  /** Notes sent to the seat while the turn ran (deadline warnings), in order. */
  advisories?: TurnAdvisory[];
  /** Set when a stopped turn's uncommitted worktree was snapshotted. */
  checkpoint?: TurnCheckpoint;
}

export const RECENT_TURNS_MAX = 200;
/** Debounce between durable ring snapshots: mutations arrive on the token path. */
export const TURN_PERSIST_DEBOUNCE_MS = 1200;
export const MAX_DELIVERED_PER_TURN = 100;
/** Live token buffer cap per turn: polling fallback stays cheap. */
export const MAX_LIVE_TEXT_CHARS = 20000;

/**
 * Durable sidecar for the in-memory ring (a JSONL file in practice).
 *
 * The ring is the ONLY home of per-turn rich data (`phases`, `opTimings`,
 * `text`, `errorDetail`, …) — the event log reconstructs turn shape but never
 * these fields, so a restart wiped every trace of what a turn actually did.
 * Persistence restores the ring at construction; the tracker re-snapshots
 * debounced after every mutation and on explicit `flush()`.
 */
export interface TurnTrackerPersist {
  /** Prior records to restore at construction. Must not throw. */
  load(): TurnRecord[];
  /** Full-ring snapshot, called debounced after mutations and on flush(). */
  save(records: TurnRecord[]): void;
}

/**
 * Turns actually running in THIS process, by id.
 *
 * Boot finalization (see `finalizeRestartInterruptedTurns`) may only close rows
 * a DEAD process left open, and a row's own `status: "running"` cannot tell the
 * two apart — so the process keeps its own answer. Module-level because two
 * trackers in one process share the file they persist to, and a turn can only
 * be running in one of them. Bounded by construction: an id is dropped as soon
 * as its turn settles, so this holds only the turns in flight.
 */
const LIVE_TURN_IDS = new Set<string>();

/**
 * TurnTracker owns the bounded in-memory ring of recent turns.
 * Extracted from Supervisor so turn observability has a single owner
 * with an enforced cap (no unbounded growth).
 */
export class TurnTracker {
  private recent: TurnRecord[] = [];
  private persistTimer?: NodeJS.Timeout;
  /**
   * Tool calls announced and not yet finished, per running turn. Live-only: a
   * turn restored from disk is not running, so there is nothing to wait on.
   */
  private openToolCalls = new Map<string, Set<string>>();
  /**
   * True while prior records are being restored. A row read back from the file
   * is by definition not running in this process, so the restore must not
   * register it as such (see `LIVE_TURN_IDS`).
   */
  private restoring = true;

  constructor(private readonly persist?: TurnTrackerPersist) {
    if (!persist) {
      this.restoring = false;
      return;
    }
    // Restore newest-first: `push` caps the ring, so the most recent
    // `RECENT_TURNS_MAX` records survive and stale ones fall off.
    for (const rec of this.loadPrior()) this.push(rec);
    this.restoring = false;
    // After the whole ring is back and before any live turn can exist: the
    // constructor has not returned, so nothing has had a chance to push a
    // running turn, and everything `recent` holds came off the disk.
    this.finalizeRestartInterruptedTurns();
  }

  /**
   * Close the turns a previous process left `running`.
   *
   * A row is written `running` before the runtime is called and rewritten with
   * a terminal status when the turn ends; a process that dies mid-turn writes
   * neither, so the row sits on disk as `running` until it falls off the ring.
   * `/status.recentTurns`, `/turns`, `/steps` and the agent-detail route all
   * read that row (live wins over the log's own account in `mergeTurnSteps`), so
   * a seat killed by a restart kept reading as WORKING long after its successor
   * had finished — measured 2026-09-27: qa's `turn-c6c9e58e` still `running` 40
   * minutes after the child restarted under it, and the same shape was a day old
   * on disk. That is the one reading an operator watching a live mesh acts on,
   * and it was wrong in both directions.
   *
   * The kernel's account is closed by `Supervisor.closeAbandonedTurns`; this is
   * the record's. Neither subsumes the other — a lifecycle moved to IDLE does
   * not make an in-memory row read as finished.
   *
   * `blocked`, not `failed`, for the reason an operator stop is recorded
   * `blocked` (see `runTurn`'s catch): `status: "failed"` is what the failure
   * digests (`mesh failures`) and the console's "crashed" badge count, and a
   * turn the mesh restarted under is not a code failure. `blocked` is already
   * in the union, so every reader and the dashboard render it as an ended turn
   * that wants a human — no new value, and no reader had to learn one.
   *
   * The end time is the turn's own last recorded mark, never NOW: this runs at
   * boot, so claiming the boot instant would report a turn killed 49s in as
   * having worked for the 40 minutes the process was down. With no mark at all
   * the turn ends where it started — a duration of 0, which is a lower bound,
   * rather than an invented working period.
   *
   * Idempotent by construction: only rows still `running` are touched, and a
   * row finalized by an earlier boot is already terminal. One rewrite for the
   * whole boot (`flush`, not one save per row), and none when the file holds
   * nothing stale.
   */
  private finalizeRestartInterruptedTurns(): void {
    const now = Date.now();
    let changed = false;
    for (const rec of this.recent) {
      if (rec.status !== "running") continue;
      // Running in this process — the file row is a live turn's own, not a
      // corpse. Unreachable on a boot load (the restore above registers
      // nothing), and the whole reason this check exists.
      if (LIVE_TURN_IDS.has(rec.turnId)) continue;
      const started = Date.parse(rec.startedAt);
      const startedMs = Number.isFinite(started) ? started : now;
      const f = rec.phases;
      // The latest sign of life of ANY kind, then the narrower marks, then the
      // start. `deadlineAt`/`ceilingAt` are deliberately absent: they are
      // promises about the future, not marks of the past.
      const lastMark = Math.max(
        f?.lastActivityAt ?? 0,
        f?.lastTokenAt ?? 0,
        f?.opsDoneAt ?? 0,
        f?.llmDoneAt ?? 0,
        startedMs,
      );
      const reason = "turn abandoned by server restart — the mesh restarted before it ended";
      rec.endedAt = new Date(lastMark).toISOString();
      rec.durationMs = Math.max(0, lastMark - startedMs);
      rec.status = "blocked";
      rec.error = lastMark > startedMs ? `${reason} (last activity ${Math.round((lastMark - startedMs) / 1000)}s in)` : reason;
      // The convention every other closed-out turn keeps: `error` for the one
      // line a reader shows, `errorDetail` for its typed shape. No `phase`: the
      // turn died between marks, and guessing one would be a claim we lack.
      rec.errorDetail = { kind: "ServerRestart", message: reason };
      // Close the flight recorder's last leg the same way `finish` does, so a
      // rail drawn from the marks ends where the row does.
      rec.phases = { ...f, startedAt: f?.startedAt ?? startedMs, endedAt: lastMark };
      changed = true;
    }
    if (changed) this.flush();
  }

  private loadPrior(): TurnRecord[] {
    try {
      return (this.persist?.load() ?? [])
        .filter((r) => r && typeof r.turnId === "string" && typeof r.agentId === "string")
        .sort((a, b) => (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0));
    } catch {
      return [];
    }
  }

  push(rec: TurnRecord): void {
    const i = this.recent.findIndex((t) => t.turnId === rec.turnId);
    let merged: TurnRecord;
    if (i >= 0) {
      // Phase marks accumulate: a later push that omits `phases` (the common
      // case — most pushes only carry status/text) must never erase the marks
      // recorded so far, or the flight recorder loses its earlier legs.
      const phases = rec.phases ? { ...this.recent[i].phases, ...rec.phases } : this.recent[i].phases;
      merged = { ...this.recent[i], ...rec, ...(phases ? { phases } : {}) };
      this.recent[i] = merged;
    } else {
      this.recent.unshift(rec);
      if (this.recent.length > RECENT_TURNS_MAX) this.recent.length = RECENT_TURNS_MAX;
      merged = rec;
    }
    // What is running in THIS process, kept true on every write — see
    // `LIVE_TURN_IDS`. A restored row is not: the loop in the constructor is
    // reading a file, not starting a turn.
    if (!this.restoring) this.noteLive(merged);
    this.schedulePersist();
  }

  /** Record, from a record's effective status, whether its turn is running in this process. */
  private noteLive(rec: TurnRecord): void {
    if (rec.status === "running") LIVE_TURN_IDS.add(rec.turnId);
    else LIVE_TURN_IDS.delete(rec.turnId);
  }

  /** Record one executed op's latency on a running turn. Bounded in count and in size (see `boundOpTiming`). */
  noteOp(turnId: string, t: OpTiming): void {
    const cur = this.recent.find((x) => x.turnId === turnId);
    if (!cur) return;
    if (!cur.opTimings) cur.opTimings = [];
    if (cur.opTimings.length >= MAX_OP_TIMINGS) return;
    cur.opTimings.push(boundOpTiming(t));
    this.schedulePersist();
  }

  /**
   * Stamp one phase mark on a running turn. Idempotent for the "first"
   * marks (firstTokenAt is never overwritten) so a re-entrant token callback
   * cannot move the TTFT baseline. No-op for unknown turns.
   */
  mark(turnId: string, phase: TurnPhaseName, at = Date.now()): void {
    const cur = this.recent.find((t) => t.turnId === turnId);
    if (!cur) return;
    if (!cur.phases) cur.phases = { startedAt: Date.parse(cur.startedAt) || at };
    if (phase === "firstTokenAt" && cur.phases.firstTokenAt !== undefined) return;
    if (phase === "firstActivityAt" && cur.phases.firstActivityAt !== undefined) return;
    if (phase === "opsStartAt" && cur.phases.opsStartAt !== undefined) return;
    cur.phases[phase] = at;
    this.schedulePersist();
  }

  finish(turnId: string, agentId: string, patch: Partial<TurnRecord>, nowIso: string): void {
    this.openToolCalls.delete(turnId);
    const cur = this.recent.find((t) => t.turnId === turnId);
    const endedAt = patch.endedAt ?? nowIso;
    const startedAt = cur?.startedAt ?? endedAt;
    let durationMs = patch.durationMs;
    if (durationMs === undefined) {
      try {
        durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
      } catch {
        durationMs = 0;
      }
    }
    const base: TurnRecord = cur ?? {
      turnId,
      agentId,
      reason: { kind: "recovery", note: "reconstructed after eviction" },
      startedAt,
      status: "running",
    };
    this.push({ ...base, ...patch, endedAt, durationMs });
    this.mark(turnId, "endedAt", Date.parse(endedAt) || Date.now());
  }

  /**
   * Append a live token delta to a running turn's text buffer (streaming
   * fallback for polling clients). Capped — drops the oldest overflow so a
   * runaway stream can't grow memory. No-op for unknown/finished turns.
   */
  appendText(turnId: string, delta: string, at = Date.now()): void {
    if (!delta) return;
    const cur = this.recent.find((t) => t.turnId === turnId);
    if (!cur || cur.status !== "running") return;
    const next = (cur.text ?? "") + delta;
    cur.text = next.length > MAX_LIVE_TEXT_CHARS ? next.slice(next.length - MAX_LIVE_TEXT_CHARS) : next;
    // Counters are uncapped on purpose: `text` is a trailing window, so its
    // length under-reports a long stream. Throughput and stall detection need
    // the true totals.
    cur.streamChars = (cur.streamChars ?? 0) + delta.length;
    cur.streamFrames = (cur.streamFrames ?? 0) + 1;
    if (!cur.phases) cur.phases = { startedAt: Date.parse(cur.startedAt) || at };
    if (cur.phases.firstTokenAt === undefined) cur.phases.firstTokenAt = at;
    cur.phases.lastTokenAt = at;
    // Tokens are a kind of activity, so the activity stamps stay a true
    // superset: a consumer reading only those never has to also check tokens.
    if (cur.phases.firstActivityAt === undefined) cur.phases.firstActivityAt = at;
    cur.phases.lastActivityAt = at;
    this.schedulePersist();
  }

  /**
   * Record one tool frame on a running turn. Deliberately separate from the
   * token stamps: tool work proves the agent is alive, but it is not output,
   * and folding it into `lastTokenAt` would tell the silence watchdog a turn
   * had started streaming when it had not.
   *
   * With `name`/`args` (a `tool_call`) or `status`/`error` (its update) it also
   * keeps the live account of what the turn is doing: `toolCallCount`, the
   * `liveTools` ring and `filesTouched`. A turn that writes files streams no
   * prose, so before these a 17-minute, 94-call, 37-file turn showed the
   * dashboard nothing but a frame counter — and when it was killed, nothing on
   * its record said which files it had written (the finished-turn trace is only
   * built from an `AgentOutput`, which a killed turn never returns). `root` is
   * the seat's workspace, stripped from the paths it wrote.
   */
  noteToolFrame(
    turnId: string,
    call?: { id?: string; closed?: boolean; name?: string; args?: unknown; status?: "completed" | "failed"; error?: string; root?: string },
    at = Date.now(),
  ): void {
    const cur = this.recent.find((t) => t.turnId === turnId);
    if (!cur || cur.status !== "running") return;
    cur.toolFrames = (cur.toolFrames ?? 0) + 1;
    if (!cur.phases) cur.phases = { startedAt: Date.parse(cur.startedAt) || at };
    if (cur.phases.firstActivityAt === undefined) cur.phases.firstActivityAt = at;
    cur.phases.lastActivityAt = at;
    try {
      this.noteLiveTool(cur, call, at);
    } catch {
      /* the live account is observability: it must never cost the turn its liveness stamp */
    }
    // Which calls are still running, so the silence watchdog can tell a turn
    // waiting on a tool from a turn whose stream has frozen. Stamping activity
    // alone is not enough: liveness is stamped when a call STARTS and when it
    // ENDS, so a single tool that runs longer than the silence floor still looks
    // silent for its whole duration — which is exactly the shape that killed ten
    // turns in one live run.
    //
    // Not persisted: `openToolCalls` is live-only state about a turn in flight,
    // and a turn restored from disk is by definition no longer running.
    if (call?.id) {
      if (!this.openToolCalls.has(turnId)) this.openToolCalls.set(turnId, new Set());
      const open = this.openToolCalls.get(turnId)!;
      if (call.closed) open.delete(call.id);
      else open.add(call.id);
      if (open.size === 0) this.openToolCalls.delete(turnId);
    }
    this.schedulePersist();
  }

  /**
   * The `toolCallCount` / `liveTools` / `filesTouched` half of `noteToolFrame`.
   * An opening frame is one that is not `closed`; a frame with no call at all
   * (older callers) is activity only and counts nothing.
   */
  private noteLiveTool(
    cur: TurnRecord,
    call: { id?: string; closed?: boolean; name?: string; args?: unknown; status?: "completed" | "failed"; error?: string; root?: string } | undefined,
    at: number,
  ): void {
    if (!call) return;
    const ring = cur.liveTools ?? (cur.liveTools = []);
    if (call.closed) {
      if (!call.id) return;
      // Newest first: ids are unique within a turn, and the call being closed
      // is almost always one of the last few announced.
      for (let i = ring.length - 1; i >= 0; i--) {
        const t = ring[i]!;
        if (t.id !== call.id) continue;
        t.status = call.status === "failed" ? "failed" : "completed";
        t.endedAt = at;
        if (t.status === "failed" && typeof call.error === "string" && call.error) t.error = clipText(call.error, LIVE_TOOL_ERROR_MAX);
        break;
      }
      return;
    }
    // A backend may announce the same call again to refine it: that is one
    // call, not two, so it updates the entry rather than counting twice.
    const again = call.id ? ring.find((t) => t.id === call.id) : undefined;
    const name = String(call.name ?? again?.name ?? "tool");
    const target = liveToolTarget(name, call.args, call.root);
    if (again) {
      again.name = name;
      if (target !== undefined) again.target = target;
    } else {
      cur.toolCallCount = (cur.toolCallCount ?? 0) + 1;
      ring.push({ id: call.id ?? `call-${cur.toolCallCount}`, name, ...(target !== undefined ? { target } : {}), status: "running", startedAt: at });
      if (ring.length > MAX_LIVE_TOOLS) ring.splice(0, ring.length - MAX_LIVE_TOOLS);
    }
    const file = fileWritten(name, call.args, call.root);
    if (file) {
      const files = cur.filesTouched ?? (cur.filesTouched = []);
      if (files.length < MAX_FILES_TOUCHED && !files.includes(file)) files.push(file);
    }
  }

  /**
   * The running turn's spend so far, in the unit its `tokens` will be billed in.
   * Cumulative, so a later figure replaces an earlier one; a non-finite or
   * negative figure is ignored rather than recorded as a guess.
   */
  noteUsage(turnId: string, tokens: number): void {
    const cur = this.recent.find((t) => t.turnId === turnId);
    if (!cur || cur.status !== "running" || !Number.isFinite(tokens) || tokens < 0) return;
    cur.liveTokens = tokens;
    this.schedulePersist();
  }

  /** Record a note sent to the seat mid-turn, delivered or not. Only on a running turn. */
  noteAdvisory(turnId: string, adv: TurnAdvisory): void {
    const cur = this.recent.find((t) => t.turnId === turnId);
    if (!cur || cur.status !== "running") return;
    const list = cur.advisories ?? (cur.advisories = []);
    if (list.length >= MAX_TURN_ADVISORIES) return;
    list.push({ at: adv.at, text: adv.text, delivered: adv.delivered });
    this.schedulePersist();
  }

  /**
   * Record the snapshot of a stopped turn's worktree. Not gated on `running`:
   * the snapshot is taken while the turn is being failed, and whether the
   * record has been closed yet is an accident of ordering.
   */
  setCheckpoint(turnId: string, cp: TurnCheckpoint): void {
    const cur = this.recent.find((t) => t.turnId === turnId);
    if (!cur) return;
    cur.checkpoint = { ref: cp.ref, commit: cp.commit, files: cp.files.slice(0, MAX_FILES_TOUCHED) };
    this.schedulePersist();
  }

  /** When the running turn will be stopped as things stand, and the hard stop past which it cannot be extended. */
  setDeadline(turnId: string, deadlineAt: number, ceilingAt?: number): void {
    const cur = this.recent.find((t) => t.turnId === turnId);
    if (!cur || cur.status !== "running" || !Number.isFinite(deadlineAt)) return;
    if (!cur.phases) cur.phases = { startedAt: Date.parse(cur.startedAt) || deadlineAt };
    cur.phases.deadlineAt = ceilingAt !== undefined && Number.isFinite(ceilingAt) ? Math.min(deadlineAt, ceilingAt) : deadlineAt;
    if (ceilingAt !== undefined && Number.isFinite(ceilingAt)) cur.phases.ceilingAt = ceilingAt;
    this.schedulePersist();
  }

  /** Is this turn waiting on a tool call it announced and has not seen finish? */
  hasOpenToolCall(turnId: string): boolean {
    return (this.openToolCalls.get(turnId)?.size ?? 0) > 0;
  }

  /** Forget a finished turn's open-call set; called from `finish`. */
  clearOpenToolCalls(turnId: string): void {
    this.openToolCalls.delete(turnId);
  }

  list(limit = 60): TurnRecord[] {
    return this.recent.slice(0, limit);
  }
  get(turnId: string): TurnRecord | undefined {
    return this.recent.find((t) => t.turnId === turnId);
  }

  /** Debounced persistence: mutations arrive on the token path (per delta). */
  private schedulePersist(): void {
    if (!this.persist || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.flush();
    }, TURN_PERSIST_DEBOUNCE_MS);
  }

  /** Force an immediate durable snapshot (turn end / shutdown). Best-effort. */
  flush(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    if (!this.persist) return;
    try {
      this.persist.save(this.recent.slice());
    } catch {
      /* persistence must never break a turn */
    }
  }

  /** Wipe the ring (fresh mission); the next debounced snapshot lands empty. */
  clear(): void {
    for (const rec of this.recent) LIVE_TURN_IDS.delete(rec.turnId);
    this.recent.length = 0;
    this.schedulePersist();
  }
}
