/* The step view's action ledger: what a turn did, and whether the log shows it.

   DOM-free and JSX-free on purpose, like route.ts and tabmodel.ts: the rules
   that decide which actions a turn is credited with, which of them the kernel
   refused and which left an effect are the part of the step view most worth
   pinning with node:test, and a test cannot import a .tsx file. Imports only
   from "./format", which is DOM-free too. */

import { MESSAGE_PLAIN, plainArtifact, plural, type OpFact, type OpHead } from "./format";

/* ---------------------------------------------------------------------- *
 * Vocabulary.
 * ---------------------------------------------------------------------- */

/**
 * Every op tool the mesh MCP bridge advertises, mapped to the canonical op its
 * `toOp` builds (apps/mesh-server/src/mcp.ts). tests/dashboard/ledger.test.ts
 * checks this table against `toOp` itself, so a tool added there and not here
 * fails a test instead of rendering as a raw `mesh_*` row with no effect.
 *
 * `mesh_announce` is the one tool whose op depends on its arguments: it is a
 * `send` when it names recipients and a `broadcast` otherwise — see
 * `canonicalOp`. The entry here is the no-recipient case.
 */
export const OP_TOOLS: Readonly<Record<string, string>> = {
  mesh_send: "send", mesh_broadcast: "broadcast", mesh_announce: "broadcast", mesh_request: "send",
  mesh_respond: "respond", mesh_reply: "respond",
  mesh_collab: "collab", mesh_collab_close: "close_collab",
  mesh_discharge: "discharge", mesh_withdraw: "withdraw",
  mesh_delegate: "delegate", mesh_block: "block", mesh_approve: "approve", mesh_reject: "reject", mesh_veto: "veto",
  mesh_escalate: "escalate",
  mesh_artifact_publish: "publish_artifact", mesh_artifact_read: "read_artifact",
  mesh_artifact_transition: "transition_artifact", mesh_request_review: "request_review",
  mesh_task_claim: "claim_task", mesh_task_complete: "complete_task", mesh_task_create: "create_task",
  mesh_research_request: "request_research",
  mesh_decision_propose: "propose_decision", mesh_decision_ratify: "ratify_decision",
  mesh_lease_acquire: "acquire_lease", mesh_lease_release: "release_lease",
  mesh_commit: "commit", mesh_request_commit: "request_commit", mesh_merge: "merge",
  mesh_wait: "wait", mesh_done: "done", mesh_remember: "remember", mesh_write_continuity: "write_continuity",
  mesh_contracts: "contracts", mesh_call: "call",
  mesh_plan: "plan", mesh_plan_step: "plan_step",
  mesh_spawn_worker: "spawn_worker", mesh_submit_result: "submit_result",
};

/**
 * Names older records carry for ops that have a canonical name now: tool names
 * from before a rename, and the invented spellings the deleted prose parser
 * used to fold (op-aliases.ts). Nothing emits them any more; a turn restored
 * from an old ring still can.
 */
const LEGACY_OP_NAMES: Readonly<Record<string, string>> = {
  mesh_message: "send", message_send: "send", "message.send": "send",
  mesh_publish_artifact: "publish_artifact",
};

/**
 * Read-only mesh tools. They answer the seat and move nothing, and the bridge
 * never turns them into ops (`READ_TOOLS` in mcp.ts), so they are neither in
 * `turn.ops` nor rows of a ledger of what the turn did.
 */
export const READ_TOOLS: ReadonlySet<string> = new Set([
  "mesh_inbox", "mesh_run_status", "mesh_query_events", "mesh_steps", "mesh_failures",
  "mesh_agent_activity", "mesh_run_digest",
]);

/**
 * Ops that DO pass through the kernel, and so appear in `turn.ops`, but only
 * read. They are skipped as rows for the same reason the read tools are.
 */
export const READ_OPS: ReadonlySet<string> = new Set(["read_artifact", "contracts"]);

/**
 * What `mesh_call` can desugar into. The kernel records the desugared op in
 * `turn.ops` while `opTimings` keeps the name it was called by, so every join
 * between the two has to treat `call` as any of these.
 */
export const CALL_DESUGARS: ReadonlySet<string> = new Set(["send", "request_review", "request_research", "escalate"]);

/** A runtime tool name without its MCP server prefix: `mcp__mesh__mesh_send` → `mesh_send`. */
export function bareTool(raw: unknown): string {
  const s = String(raw ?? "");
  return s.startsWith("mcp__") ? s.slice(s.lastIndexOf("__") + 2) : s;
}

/** The canonical op for a tool name, a legacy name, or an op name already canonical. */
export function displayOpName(raw: unknown): string {
  const o = bareTool(raw) || "op";
  return OP_TOOLS[o] ?? LEGACY_OP_NAMES[o] ?? o;
}

/** A recipient list reduced to "did the caller name anyone?" — `namedRecipients` in mcp.ts. */
function named(raw: unknown): string[] {
  const l = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return l.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
}

/** The canonical op a written op object (`{ op: <tool or op name>, ...args }`) became. */
export function canonicalOp(o: any): string {
  const tool = bareTool(o?.op);
  if (tool === "mesh_announce") return named(o?.to).length ? "send" : "broadcast";
  return displayOpName(tool);
}

/** An op tool as opposed to a read tool, a native runtime tool, or noise. */
function isOpTool(name: string): boolean {
  if (READ_TOOLS.has(name)) return false;
  return name in OP_TOOLS || name in LEGACY_OP_NAMES || name.startsWith("mesh_");
}

/* ---------------------------------------------------------------------- *
 * Effects.
 * ---------------------------------------------------------------------- */

/**
 * What the log shows when an op lands. `types` are the events the op emits
 * itself; `fallback` are events it only sometimes produces, or produces
 * alongside something another op could have caused, so they pair only once
 * every primary candidate has been placed. `"none"` is an op with nothing to
 * look for, `"wait"` the parked-state special case, and `"read"` an op that is
 * not a ledger row at all.
 */
export type OpEffect = { types: readonly string[]; fallback?: readonly string[] } | "none" | "wait" | "read";

export const OP_EFFECTS: Readonly<Record<string, OpEffect>> = {
  send: { types: ["message.sent"] },
  broadcast: { types: ["message.sent"] },
  respond: { types: ["message.sent"] },
  request_commit: { types: ["message.sent"] },
  // `block` is a recorded decision whose only event is the message it sends
  // the artifact's owner (`recordDecision`).
  block: { types: ["message.sent"] },
  delegate: { types: ["message.sent", "task.created"] },
  collab: { types: ["collab.opened"] },
  close_collab: { types: ["collab.closed"] },
  discharge: { types: ["commitment.discharged"] },
  withdraw: { types: ["commitment.discharged"] },
  // A criterion subject closes through `requirement.satisfied` rather than a
  // review event, so it is the fallback, not a peer.
  approve: { types: ["review.approved", "architecture.approved"], fallback: ["requirement.satisfied"] },
  reject: { types: ["review.rejected"] },
  veto: { types: ["review.rejected"] },
  escalate: { types: ["escalation.requested"] },
  publish_artifact: { types: ["artifact.created", "artifact.versioned"] },
  // Derived transitions (a review request moving its artifact, an approval
  // advancing one) share the type; `tierOf` sends them to the back.
  transition_artifact: { types: ["artifact.transition"] },
  request_review: { types: ["review.requested"] },
  claim_task: { types: ["task.claimed"] },
  complete_task: { types: ["task.completed"] },
  submit_result: { types: ["task.completed"] },
  create_task: { types: ["task.created"] },
  // A research cache hit answers with a message instead of opening a request.
  request_research: { types: ["research.requested"], fallback: ["message.sent"] },
  propose_decision: { types: ["decision.proposed"] },
  ratify_decision: { types: ["decision.ratified"] },
  acquire_lease: { types: ["lease.acquired"] },
  release_lease: { types: ["lease.released"] },
  commit: { types: ["artifact.versioned"] },
  merge: { types: ["patch.merged"], fallback: ["artifact.transition"] },
  remember: { types: ["memory.updated"] },
  write_continuity: { types: ["continuity.recorded"] },
  plan: { types: ["plan.updated"] },
  plan_step: { types: ["plan.updated"] },
  spawn_worker: { types: ["agent.created"] },
  // Only reached when the kernel's own op list is missing: there the row is
  // named after the tool, and the desugared op is unknown.
  call: { types: ["message.sent", "review.requested", "research.requested", "escalation.requested"] },
  wait: "wait",
  done: "none",
  read_artifact: "read",
  contracts: "read",
};

/** Every event type an op could pair with, primary and fallback, or null when it has none. */
function effectTypes(kind: string): readonly string[] | null {
  const fx = OP_EFFECTS[kind];
  if (!fx || typeof fx === "string") return null;
  return fx.fallback ? [...fx.types, ...fx.fallback] : fx.types;
}

/** 0 for a primary, non-derived candidate; higher sorts later; undefined = not a candidate. */
function tierOf(kind: string, e: any): number | undefined {
  const fx = OP_EFFECTS[kind];
  if (!fx || typeof fx === "string") return undefined;
  // A derived `architecture.approved` echoes the `review.approved` it names, so
  // an approve pairs with the approval first, exactly as a derived transition.
  const derived = (e?.type === "artifact.transition" || e?.type === "architecture.approved") && (e?.payload as any)?.derived === true ? 1 : 0;
  if (fx.types.includes(e?.type)) return derived;
  if (fx.fallback?.includes(e?.type)) return 2 + derived;
  return undefined;
}

/* ---------------------------------------------------------------------- *
 * Rows.
 * ---------------------------------------------------------------------- */

export interface OpRow {
  /**
   * What was written: the captured tool call's arguments plus `op`, the tool
   * name. Just `{ op: <canonical name> }` when no captured call carried the
   * arguments (see `uncaptured`).
   */
  op: any;
  /** The canonical op the kernel executed — what effects are looked up by. */
  kind?: string;
  head: OpHead;
  /** The landed effect, `null` when none was found, `undefined` when the op has none to find. */
  fx: any | null | undefined;
  /** The pairing is a guess: several ops of this kind competed for events,
   *  and nothing in the paired event (or any event) names this op's target. */
  guess?: boolean;
  /**
   * The kernel refused this op. A refused op is never paired with an effect
   * (`fx` is `null`: nothing landed) and never counts as a missing one — it
   * did not go missing, it was turned down, and `reason` says why.
   */
  refusal?: { reason?: string };
  /** No captured tool call carried this op's arguments: the runtime keeps
   *  arguments for a bounded number of a turn's calls, so `op` holds the
   *  name alone. */
  uncaptured?: boolean;
  /**
   * An uncaptured row whose title was read from the event it landed rather
   * than from its own arguments, which nobody kept. Set only where that
   * pairing is not a guess; see `nameUncaptured`.
   */
  namedFromEffect?: boolean;
  /**
   * Argument strings the server cut at storage: dotted paths into `op`
   * ("content", "edits.0.new_string") mapped to the length each string had
   * before it was cut. What `op` holds at those paths is only the stored start.
   */
  clipped?: Readonly<Record<string, number>>;
}

/** Op fields that name what the op acted on, and so can be looked for in the
 *  payload of the event it produced. More keys means fewer ties among
 *  same-kind ops, and a tie is what makes a pairing a guess. */
const OP_TARGET_KEYS = [
  "to", "name", "title", "taskId", "task", "artifactId", "artifact", "artifactUri", "decisionId", "id", "key",
  "topic", "reviewers", "assignedTo", "messageId", "replyTo", "threadId", "subject", "stepId", "with",
  "contract", "asVersionOf", "type", "requestType",
];

function opTargets(o: any): string[] {
  const out = new Set<string>();
  const add = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(add); return; }
    if (typeof v !== "string") return;
    const t = v.trim();
    if (t.length < 2) return;
    out.add(t);
    // URIs: the event may carry only the id at the end.
    const tail = t.split("/").pop();
    if (tail && tail !== t && tail.length >= 2) out.add(tail);
  };
  for (const k of OP_TARGET_KEYS) add(o?.[k]);
  // A plan names nothing but its steps, and every `plan.updated` after it
  // repeats them — which is what lets it out-score the step ticks for the
  // first one instead of being left whichever event they did not take.
  if (Array.isArray(o?.steps)) for (const s of o.steps) add(s?.text);
  return [...out];
}

/**
 * Pair each row with the event it produced, in place.
 *
 * Each row is scored against every event of its own types by how many of its
 * targets (recipient, name, task, artifact, …) the event's payload mentions,
 * and pairs are assigned tier first (primary before fallback, non-derived
 * before derived), then best score, each event used at most once, ties broken
 * by op order then log order. Assigning op by op in order let the first of two
 * sends take the one event that named the second's recipient, so the send
 * that landed was reported as the one that did not. Where only type decided a
 * pairing among several same-kind ops, the row says it is a guess rather than
 * claiming the log confirmed it.
 *
 * Refused rows take no part: the kernel said no, so any event of the right
 * type belongs to some other op, and giving it to the refused one would both
 * mislabel the refusal as landed and steal the effect from the op that made it.
 */
function pairEffects(rows: OpRow[], timeline: any[]): void {
  const waitEv = timeline.find((e: any) => e?.type === "agent.state_changed" && (e.payload as any)?.to === "WAITING");
  const kinds = rows.map((r) => r.kind ?? canonicalOp(r.op));
  const typesOf = rows.map((r, i) => (r.refusal || kinds[i] === "wait" ? null : effectTypes(kinds[i]!)));
  const pairs: { i: number; j: number; tier: number; score: number }[] = [];
  rows.forEach((r, i) => {
    if (!typesOf[i]) return;
    const targets = opTargets(r.op);
    timeline.forEach((e: any, j: number) => {
      const tier = tierOf(kinds[i]!, e);
      if (tier === undefined) return;
      let text = "";
      try { text = JSON.stringify(e.payload ?? {}); } catch { /* unserializable payload scores 0 */ }
      const score = targets.reduce((n, t) => n + (text.includes(t) ? 1 : 0), 0);
      pairs.push({ i, j, tier, score });
    });
  });
  pairs.sort((a, b) => a.tier - b.tier || b.score - a.score || a.i - b.i || a.j - b.j);
  const takenOp = new Map<number, number>();
  const takenEv = new Set<number>();
  for (const p of pairs) {
    if (takenOp.has(p.i) || takenEv.has(p.j)) continue;
    takenOp.set(p.i, p.score);
    takenEv.add(p.j);
    rows[p.i]!.fx = timeline[p.j];
  }
  // Ops competing for the same event types: a zero-score pairing among them
  // (or a miss beside one) was decided by order alone.
  const competes = (i: number, k: number): boolean =>
    Boolean(typesOf[i] && typesOf[k] && typesOf[i]!.some((t) => typesOf[k]!.includes(t)));
  rows.forEach((r, i) => {
    if (r.refusal) { r.fx = null; return; }
    if (kinds[i] === "wait") { r.fx = waitEv ?? null; return; }
    // done and unknown ops produce nothing observable — `undefined` means
    // "not applicable", which the UI renders as a neutral badge rather than
    // as a failure.
    if (!typesOf[i]) { r.fx = undefined; return; }
    const score = takenOp.get(i);
    if (score === undefined) {
      const peers = rows.map((_, k) => k).filter((k) => competes(i, k));
      r.fx = null;
      r.guess = peers.length > 1 && peers.some((k) => takenOp.get(k) === 0);
    } else {
      // Only ops that could have taken THIS event competed for it: a research
      // request paired with the one `research.requested` is no guess merely
      // because its fallback type is one every send also wants.
      const t = r.fx?.type;
      r.guess = score === 0 && rows.some((_, k) => k !== i && Boolean(typesOf[k]?.includes(t)));
    }
  });
}

/**
 * Pair written ops with the events they produced. Kept for callers holding
 * bare op objects; `buildLedger` is the full reading of a turn record.
 */
export function matchOpEffects(ops: any[], timeline: any[], names?: ReadonlyMap<string, string>): OpRow[] {
  const rows: OpRow[] = ops.map((o: any) => {
    const kind = canonicalOp(o);
    return { op: o, kind, head: opHead(o, { names, kind }), fx: undefined };
  });
  pairEffects(rows, timeline);
  return rows;
}

export interface OpTimingLike { op: string; ok: boolean; reason?: string; ms?: number }

/** `a` (an opTimings name) and `b` (an op-list name) describe the same op. */
function sameOp(a: string, b: string): boolean {
  return a === b || displayOpName(a) === b || (a === "call" && CALL_DESUGARS.has(b));
}

/**
 * Attach each op's kernel verdict. `opTimings` is capped (the first 60) while
 * the op list is not, so a clean record lines up by index over the timings'
 * length. A record that does not — two channels merged in a different order,
 * or a legacy ring — falls back to per-name occurrence: the k-th `send` gets
 * the k-th `send` timing, and leftover `call` timings go to the desugared ops
 * nothing else claimed, in order.
 */
function joinTimings(names: string[], timings: OpTimingLike[]): (OpTimingLike | undefined)[] {
  const out: (OpTimingLike | undefined)[] = names.map(() => undefined);
  if (!timings.length) return out;
  const n = Math.min(names.length, timings.length);
  let aligned = true;
  for (let i = 0; i < n; i++) if (!sameOp(timings[i]!.op, names[i]!)) { aligned = false; break; }
  if (aligned) {
    for (let i = 0; i < n; i++) out[i] = timings[i];
    return out;
  }
  const used = new Set<number>();
  names.forEach((name, i) => {
    const j = timings.findIndex((t, k) => !used.has(k) && (t.op === name || displayOpName(t.op) === name));
    if (j >= 0) { used.add(j); out[i] = timings[j]; }
  });
  names.forEach((name, i) => {
    if (out[i] || !CALL_DESUGARS.has(name)) return;
    const j = timings.findIndex((t, k) => !used.has(k) && t.op === "call");
    if (j >= 0) { used.add(j); out[i] = timings[j]; }
  });
  return out;
}

interface CapturedCall { tool: string; args: Record<string, unknown>; canon: string; clipped?: Record<string, number> }

/** The captured tool calls that were ops, in call order. */
function capturedOpCalls(calls: unknown): CapturedCall[] {
  if (!Array.isArray(calls)) return [];
  const out: CapturedCall[] = [];
  for (const c of calls) {
    const tool = bareTool((c as any)?.name);
    if (!isOpTool(tool)) continue;
    const raw = (c as any)?.args;
    const args = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const clipped = clipMap((c as any)?.argsClipped);
    out.push({ tool, args, canon: canonicalOp({ ...args, op: tool }), ...(clipped ? { clipped } : {}) });
  }
  return out;
}

export interface LedgerInput {
  /** `turn.ops`: every executed op by canonical name, in execution order,
   *  refused ones included, uncapped. Absent while a turn is still running. */
  ops?: unknown;
  /** `turn.opTimings`: the kernel's verdict per op, same order, capped. */
  opTimings?: unknown;
  /** `turn.toolCallsDetail`: the first calls of the turn, of any tool — and,
   *  on newer records, mesh op calls past those, up to a larger cap. Each
   *  may carry `argsClipped` (see `clipMap`). */
  toolCalls?: unknown;
  /** The turn's events, in log order. */
  timeline: any[];
}

export interface Ledger {
  rows: OpRow[];
  /** Rows whose arguments a captured tool call carried. */
  captured: number;
  /**
   * `ops` when the rows are the kernel's complete op list; `calls` when that
   * list is missing (a running turn, an old record) and the rows are only the
   * captured tool calls — which the runtime truncates.
   */
  source: "ops" | "calls";
  /** id → readable name for artifacts, tasks and plan steps this turn touched. */
  names: ReadonlyMap<string, string>;
}

/**
 * Read a turn record into ledger rows.
 *
 * The rows come from the COMPLETE op list (`turn.ops`) rather than from the
 * captured tool calls: the runtime keeps arguments for only the first few
 * calls of a turn, of any tool, so a turn that read and edited before acting
 * used to show a fraction of its ops and silently drop the rest. Each row is
 * then enriched with the arguments of the k-th captured call of the same op,
 * and marked `uncaptured` when there is none. Returns null when the turn wrote
 * no action at all.
 */
export function buildLedger(input: LedgerInput): Ledger | null {
  const calls = capturedOpCalls(input.toolCalls);
  const timings: OpTimingLike[] = Array.isArray(input.opTimings)
    ? (input.opTimings as any[]).filter((t) => t && typeof t.op === "string" && typeof t.ok === "boolean")
    : [];
  const names = ledgerNames(input.timeline);
  const kernelOps = Array.isArray(input.ops) && (input.ops as unknown[]).every((x) => typeof x === "string")
    ? (input.ops as string[])
    : null;

  let rows: OpRow[];
  if (kernelOps) {
    const verdicts = joinTimings(kernelOps, timings);
    // The call that carried op i is keyed by the name it was CALLED by: a
    // desugared `mesh_call` is `send` in the op list but `call` in both its
    // timing and its tool name.
    const keys = kernelOps.map((n, i) => (verdicts[i]?.op === "call" ? "call" : n));
    const byKey = new Map<string, number[]>();
    calls.forEach((c, j) => byKey.set(c.canon, [...(byKey.get(c.canon) ?? []), j]));
    const seen = new Map<string, number>();
    const callOf: (number | undefined)[] = keys.map((k) => {
      const nth = seen.get(k) ?? 0;
      seen.set(k, nth + 1);
      return byKey.get(k)?.[nth];
    });
    // A `mesh_call` whose timing was capped away still desugared into one of
    // the unclaimed ops; hand the leftover calls to those, in order.
    const claimed = new Set(callOf.filter((j): j is number => j !== undefined));
    const spare = (byKey.get("call") ?? []).filter((j) => !claimed.has(j));
    kernelOps.forEach((n, i) => {
      if (callOf[i] === undefined && CALL_DESUGARS.has(n) && spare.length) callOf[i] = spare.shift();
    });
    rows = [];
    kernelOps.forEach((kind, i) => {
      if (READ_OPS.has(kind)) return;
      const j = callOf[i];
      const c = j === undefined ? undefined : calls[j];
      const v = verdicts[i];
      rows.push({
        op: c ? { ...c.args, op: c.tool } : { op: kind },
        kind,
        head: { title: "", detail: "", facts: [] },
        fx: undefined,
        ...(c ? {} : { uncaptured: true }),
        ...(c?.clipped ? { clipped: c.clipped } : {}),
        ...(v && v.ok === false ? { refusal: { reason: v.reason } } : {}),
      });
    });
  } else {
    const verdicts = joinTimings(calls.map((c) => c.canon), timings);
    rows = [];
    calls.forEach((c, i) => {
      if (READ_OPS.has(c.canon)) return;
      const v = verdicts[i];
      rows.push({
        op: { ...c.args, op: c.tool },
        kind: c.canon,
        head: { title: "", detail: "", facts: [] },
        fx: undefined,
        ...(c.clipped ? { clipped: c.clipped } : {}),
        ...(v && v.ok === false ? { refusal: { reason: v.reason } } : {}),
      });
    });
  }
  if (!rows.length) return null;
  for (const r of rows) r.head = opHead(r.op, { names, kind: r.kind, clipped: r.clipped });
  pairEffects(rows, input.timeline);
  nameUncaptured(rows, names);
  return { rows, captured: rows.filter((r) => !r.uncaptured).length, source: kernelOps ? "ops" : "calls", names };
}

/** Headline figures for a ledger: what could be checked, what was, what was refused. */
export function ledgerTally(rows: readonly OpRow[]): { expected: number; landed: number; refused: number } {
  let expected = 0, landed = 0, refused = 0;
  for (const r of rows) {
    if (r.refusal) { refused++; continue; }
    if (r.fx === undefined) continue;
    expected++;
    if (r.fx) landed++;
  }
  return { expected, landed, refused };
}

/* ---------------------------------------------------------------------- *
 * Uncaptured rows, named from what they landed.
 * ---------------------------------------------------------------------- */

/**
 * The op fields an effect vouches for: what an uncaptured op must have been
 * called with, given the event it produced. Null where the event says nothing
 * about the op's own arguments — a research cache hit's message goes back to
 * the asker, and a block's to the artifact's owner, so neither names what the
 * op was called with.
 */
function opFromEffect(kind: string, fx: any): { o: Record<string, unknown>; facts?: OpFact[] } | null {
  const p = (fx?.payload ?? {}) as Record<string, any>;
  const obj = (v: unknown): Record<string, any> | null => (v && typeof v === "object" ? (v as Record<string, any>) : null);
  switch (fx?.type) {
    case "artifact.created":
    case "artifact.versioned": {
      const a = obj(p.artifact);
      if ((kind !== "publish_artifact" && kind !== "commit") || !a) return null;
      return {
        o: { name: a.name, type: a.type, artifactId: a.id },
        facts: typeof a.version === "number" ? [fact("version", `v${a.version}`)] : [],
      };
    }
    case "message.sent": {
      const m = obj(p.message);
      if (!m || !["send", "broadcast", "respond", "delegate"].includes(kind)) return null;
      return { o: { to: m.to, type: m.type, payload: m.payload } };
    }
    case "task.created": {
      const t = obj(p.task);
      if (!t) return null;
      if (kind === "delegate") return { o: { title: t.title, to: t.assignedTo } };
      return kind === "create_task" ? { o: { title: t.title, assignedTo: t.assignedTo, description: t.description } } : null;
    }
    case "task.claimed":
    case "task.completed":
      return kind === "claim_task" || kind === "complete_task" ? { o: { taskId: p.taskId, summary: p.summary } } : null;
    case "memory.updated":
      return kind === "remember" ? { o: { key: obj(p.note)?.key, value: obj(p.note)?.value } } : null;
    case "review.requested":
      return kind === "request_review" ? { o: { artifactId: p.artifactId, reviewers: p.reviewers } } : null;
    case "research.requested":
      return kind === "request_research" ? { o: { question: p.question } } : null;
    case "decision.proposed":
      return kind === "propose_decision" ? { o: { topic: obj(p.decision)?.topic, decision: obj(p.decision)?.decision } } : null;
    case "escalation.requested":
      return kind === "escalate" ? { o: { reason: obj(p.escalation)?.reason } } : null;
    case "collab.opened":
      return kind === "collab" ? { o: { topic: obj(p.session)?.topic, with: obj(p.session)?.participants } } : null;
    case "commitment.discharged":
      return kind === "discharge" || kind === "withdraw" ? { o: { messageId: p.messageId, reason: p.reason } } : null;
    case "review.approved":
    case "review.rejected":
    case "architecture.approved":
      return ["approve", "reject", "veto"].includes(kind) ? { o: { subject: p.subject, artifactId: p.artifactId, comment: p.comment } } : null;
    case "artifact.transition":
      return kind === "transition_artifact" ? { o: { artifactId: p.artifactId, to: p.to } } : null;
    case "patch.merged":
      return kind === "merge" ? { o: { artifactId: p.artifactId } } : null;
    case "plan.updated":
      return kind === "plan" ? { o: { steps: obj(p.plan)?.steps } } : null;
    default:
      return null;
  }
}

/**
 * Give uncaptured rows the best title the log supports, in place.
 *
 * An uncaptured row knows only its op's name, so four uncaptured publishes
 * all read "Published an artifact". Where the row's pairing is NOT a guess,
 * the event it landed names what it acted on — the artifact and version, the
 * recipient, the task — and the row is titled from that. A guessed pairing is
 * left generic: naming it from the event would name another op's artifact as
 * often as its own. Those rows instead say how many unnamed ones of their kind
 * there are, so four identical titles read as one group, not as a stutter.
 */
function nameUncaptured(rows: OpRow[], names: ReadonlyMap<string, string>): void {
  const unnamed = new Map<string, OpRow[]>();
  for (const r of rows) {
    if (!r.uncaptured) continue;
    const kind = r.kind ?? canonicalOp(r.op);
    const from = !r.refusal && r.fx && !r.guess ? opFromEffect(kind, r.fx) : null;
    if (from) {
      const h = opHead({ ...from.o, op: kind }, { names, kind });
      // Only if the event actually added something to the generic title.
      if (h.title !== r.head.title || h.detail || h.facts.length) {
        r.head = { ...h, facts: [...h.facts, ...(from.facts ?? [])] };
        r.namedFromEffect = true;
        continue;
      }
    }
    unnamed.set(kind, [...(unnamed.get(kind) ?? []), r]);
  }
  for (const group of unnamed.values()) {
    if (group.length < 2) continue;
    for (const r of group) r.head = { ...r.head, note: `one of ${group.length} unnamed` };
  }
}

/* ---------------------------------------------------------------------- *
 * Arguments cut at storage.
 * ---------------------------------------------------------------------- */

/**
 * A tool call's `argsClipped` map, or undefined when it is absent or not the
 * expected shape. The server bounds what it stores of each call: every string
 * inside `args` longer than its cap is cut to the cap, and this maps the
 * string's dotted path ("content", "edits.0.new_string") to the length it had
 * before. Records from before the cap have no map, and nothing was cut.
 */
export function clipMap(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

export interface StorageClip {
  /** Dotted path into the arguments. */
  path: string;
  /** Length of the string before the server cut it. */
  original: number;
  /** Length of what was stored — the most any "show all" can show. */
  stored: number | undefined;
}

/** The value at a dotted path ("edits.0.new_string"), or undefined. */
export function valueAt(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const k of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/**
 * The argument strings that were cut at storage, in path order, each with
 * its original and stored length. `under` keeps only paths at or below one
 * key, for a view that shows that key on its own.
 */
export function storageClips(args: unknown, clipped: unknown, under?: string): StorageClip[] {
  const m = clipMap(clipped);
  if (!m) return [];
  return Object.entries(m)
    .filter(([p]) => under === undefined || p === under || p.startsWith(`${under}.`))
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([path, original]) => {
      const v = valueAt(args, path);
      return { path, original, stored: typeof v === "string" ? v.length : undefined };
    });
}

/* ---------------------------------------------------------------------- *
 * What the turn produced, from its own events.
 * ---------------------------------------------------------------------- */

export interface ProducedCounts { messages: number; artifacts: number; tasks: number; decisions: number }

/**
 * The server's step buckets (`buildTurnSteps` in packages/observability),
 * applied to one turn's own timeline. The step view used to take these from
 * the Steps list entry, which is zero-filled for a turn reconstructed without
 * its effects — so a turn that published eight artifacts, fed the one refusal
 * it also had, read "Refused". The drawer has the events; it counts them.
 * Undefined when there is no timeline to count, which is not the same as zero.
 */
export function producedFromTimeline(timeline: readonly any[]): ProducedCounts | undefined {
  if (!timeline.length) return undefined;
  const o: ProducedCounts = { messages: 0, artifacts: 0, tasks: 0, decisions: 0 };
  for (const e of timeline) {
    switch (e?.type) {
      case "message.sent": o.messages++; break;
      case "artifact.created": case "artifact.versioned": o.artifacts++; break;
      case "task.created": case "task.claimed": case "task.completed": o.tasks++; break;
      case "decision.proposed": case "review.approved": case "review.rejected":
      case "requirement.satisfied":
        o.decisions++; break;
      // Counted only when it IS the approval. Since 2026-09-26 every approval is
      // a `review.approved`, and `architecture.approved` rides beside it marked
      // `derived` — counting both scored one approval as two decisions.
      case "architecture.approved":
        if ((e.payload as any)?.derived !== true) o.decisions++;
        break;
      // A `derived` transition is the supervisor mirroring a move the reducer
      // already made (a review request moving its artifact to UNDER_REVIEW).
      // The server stopped counting it; counting it here gave an architect who
      // requested four reviews "8 decisions" with no decision to show for them.
      case "artifact.transition":
        if ((e.payload as any)?.derived !== true) o.decisions++;
        break;
      default: break;
    }
  }
  return o;
}

/* ---------------------------------------------------------------------- *
 * Kernel notices vs the model's own words.
 * ---------------------------------------------------------------------- */

const MODEL_SAID = " — model said: ";
const NOTICE_SEP = " — ⚠ ";
/** Kernel sentences that open a summary without a ⚠ (see `endSummary` in supervisor.ts). */
const KERNEL_OPENERS = [/^continuity written for the session handover\b/, /^\d+ mesh effects? landed this turn\b/];

const unwarn = (s: string): string => s.replace(/^⚠\s*/, "").trim();

/**
 * A record's own notices (`TurnRecord.notices`), as the step drawer's Reasoning list shows them. The list draws its own warning
 * mark, so the kernel's leading "⚠" is dropped from each, as `splitSummary` drops it from the notices it splits out of an older
 * record's summary: the notices that came as a list read "▲ ⚠ turn only done", the mark twice.
 */
export function recordNotices(notices: unknown): string[] {
  return Array.isArray(notices) ? notices.filter((n): n is string => typeof n === "string").map(unwarn).filter(Boolean) : [];
}

/**
 * Split a turn summary into what the kernel said and what the model said.
 *
 * The summary is one string the supervisor assembles: kernel verdicts ("⚠ 1 of
 * 23 ops were REJECTED…"), then ` — model said: ` and the model's own summary,
 * then caveats, each appended as ` — ⚠ …`. Rendered whole it read as the
 * model's narration and was labelled "not verified", which is exactly wrong
 * for the half that the kernel verified. Only those two markers split it: the
 * model's text uses bare " — " freely, so that one is never a boundary.
 * Records that carry `notices`/`modelSummary` separately do not need this.
 */
export function splitSummary(summary: string): { notices: string[]; model: string } {
  const [head = "", ...tail] = summary.split(NOTICE_SEP);
  const notices: string[] = [];
  let model = "";
  const said = head.indexOf(MODEL_SAID);
  // The other shape the supervisor writes: "<kernel sentence> (model said: …)".
  const paren = said < 0 ? /^([\s\S]*?) \(model said: ([\s\S]*)\)$/.exec(head) : null;
  if (said >= 0) {
    notices.push(head.slice(0, said));
    model = head.slice(said + MODEL_SAID.length);
  } else if (paren) {
    notices.push(paren[1]!);
    model = paren[2]!;
  } else if (head.trimStart().startsWith("⚠") || KERNEL_OPENERS.some((re) => re.test(head.trim()))) {
    notices.push(head);
  } else {
    model = head;
  }
  notices.push(...tail);
  return { notices: notices.map(unwarn).filter(Boolean), model: model.trim() };
}

/* ---------------------------------------------------------------------- *
 * Titles.
 * ---------------------------------------------------------------------- */

/** One line, with an ellipsis that admits it was cut. The bare `slice` this
 *  replaces produced text indistinguishable from a complete value. */
export function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/**
 * The prose a payload carries, if it carries any.
 *
 * Deliberately returns "" when no known prose key is present. The old version
 * fell back to `JSON.stringify(payload)`, so any payload made of identifiers
 * rendered as a cut-off JSON blob on the ledger row.
 */
export function msgSnippet(payload: unknown, max = 140): string {
  if (payload === null || payload === undefined) return "";
  if (typeof payload === "string") return clip(payload, max);
  if (typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    for (const k of ["question", "summary", "note", "reason", "text", "response", "answer", "verdict", "comment", "message", "body", "content", "description", "rationale"]) {
      if (typeof p[k] === "string" && (p[k] as string).length > 0) return clip(p[k] as string, max);
    }
  }
  return "";
}

/** A recipient/assignee field: arrays read as a comma list. */
const list = (v: unknown): string => (Array.isArray(v) ? v.join(", ") : String(v ?? ""));

const fact = (k: string, v: unknown, max = 60): OpFact => ({ k, v: clip(list(v), max) });

/** "REQUEST_INFO" → "Request info". Titles have one case: sentence case. */
export function sentenceCase(s: string): string {
  const t = s.replace(/^mesh_/, "").replace(/[_.]+/g, " ").trim().toLowerCase();
  return t ? t[0]!.toUpperCase() + t.slice(1) : t;
}

const upFirst = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** A message type the way the console names it everywhere else. */
export function msgKind(type: string): string {
  return MESSAGE_PLAIN[type] ?? sentenceCase(type).toLowerCase();
}

/** "art-M3D54QXS006eca2e1488" → "art-…2e1488": enough to tell two apart, short enough for a title. */
export function shortId(id: string): string {
  const m = /^([a-z]+)-([A-Za-z0-9]{10,})$/.exec(id);
  if (m) return `${m[1]}-…${m[2]!.slice(-6)}`;
  return clip(id, 28);
}

function decode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** Artifact name from `artifact://<Type>/<Name>/<version>`, or null for anything else. */
export function nameFromUri(u: string): string | null {
  const m = /^artifact:\/\/[^/]+\/([^/]+)/.exec(u);
  return m ? decode(m[1]!) : null;
}

/**
 * id → readable name, for artifacts, tasks and plan steps this turn's own
 * events mention. An op names its artifact by id; the ledger names it the way
 * the reader knows it. Only the turn's own events are searched — this is a
 * label, not a lookup service — and anything missing falls back to a short id.
 */
export function ledgerNames(timeline: readonly any[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of timeline) {
    const p = (e?.payload ?? {}) as Record<string, any>;
    if (typeof p.artifact?.id === "string" && typeof p.artifact?.name === "string") m.set(p.artifact.id, p.artifact.name);
    if (typeof p.artifactId === "string" && !m.has(p.artifactId)) {
      const ref = typeof p.artifactRef === "string" ? p.artifactRef : p.artifactRef?.uri;
      const n = typeof ref === "string" ? nameFromUri(ref) : null;
      if (n) m.set(p.artifactId, n);
    }
    if (typeof p.task?.id === "string" && typeof p.task?.title === "string") m.set(p.task.id, p.task.title);
    if (e?.type === "plan.updated" && Array.isArray(p.plan?.steps)) {
      for (const s of p.plan.steps) if (typeof s?.id === "string" && typeof s?.text === "string") m.set(s.id, s.text);
    }
  }
  return m;
}

export interface HeadContext {
  names?: ReadonlyMap<string, string>;
  /** The op the kernel recorded, when known — a desugared `mesh_call` is `send` here. */
  kind?: string;
  /** The captured call's `argsClipped`: lengths are read from it, not from the stored strings. */
  clipped?: Readonly<Record<string, number>>;
}

/**
 * One written op, split into what it did, which parameters identify it, and
 * what it said. `detail` is prose only — parameters live in `facts` so the
 * ledger can label them instead of printing a JSON blob.
 *
 * Every title is a sentence-case phrase in the console's own words: no raw op
 * name, no `mesh_` tool name, no SCREAMING message type. Field names follow
 * the tool schemas in mcp.ts and the MeshOp* interfaces in protocol/types.ts;
 * the older spellings some records carry (`artifactId` on a send, `summary` on
 * a task) are still read where they used to be.
 */
export function opHead(o: any, ctx: HeadContext = {}): OpHead {
  const names = ctx.names ?? new Map<string, string>();
  const tool = bareTool(o?.op);
  const op = tool === "mesh_call" ? "call" : ctx.kind ?? canonicalOp(o);
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const art = (ref: unknown): string => {
    const r = typeof ref === "object" && ref !== null ? (ref as any).uri ?? (ref as any).id : ref;
    const s = str(r);
    if (!s) return "";
    return clip(nameFromUri(s) ?? names.get(s) ?? names.get(s.split("/").pop() ?? "") ?? shortId(s), 70);
  };
  const idLabel = (v: unknown): string => {
    const s = str(v);
    return s ? clip(names.get(s) ?? shortId(s), 70) : "";
  };
  const artifactOf = (): string => art(o?.artifactId || o?.artifact || o?.artifactUri || o?.artifactRef);
  const artFacts = (): OpFact[] => {
    const refs = [
      ...(Array.isArray(o?.artifactRefs) ? o.artifactRefs : []),
      ...(Array.isArray(o?.newThread?.artifactRefs) ? o.newThread.artifactRefs : []),
    ];
    const labels = [...new Set([...refs.map(art), artifactOf()].filter(Boolean))];
    return labels.length ? [fact(labels.length > 1 ? "artifacts" : "artifact", labels)] : [];
  };
  // A decision's subject is a domain ("requirements"), a criterion, or an
  // artifact written as `artifact:<id>`.
  const subjectOf = (): string => {
    const s = str(o?.subject);
    if (s.startsWith("criterion:")) return `criterion ${s.slice("criterion:".length)}`;
    if (s.startsWith("artifact:")) return art(s.slice("artifact:".length));
    return s;
  };
  const verb = (v: string, what: string): string => (what ? `${v} ${what}` : v);

  switch (op) {
    case "send":
    case "broadcast": {
      // Recipients are already the title; the second line is the message's
      // own prose, and anything it points at becomes a chip — otherwise a
      // message whose payload is pure references showed a title and nothing.
      const type = str(o?.type) || str(o?.requestType)
        || (tool === "mesh_request" ? "REQUEST" : tool === "mesh_announce" ? "INFORM" : "");
      const to = op === "broadcast" ? "everyone" : list(named(o?.to));
      const label = upFirst(type ? msgKind(type) : "message");
      const thread = str(o?.subject) || str(o?.newThread?.subject);
      return {
        title: to ? `${label} → ${to}` : `${label} sent`,
        detail: msgSnippet(o?.payload ?? o?.body) || msgSnippet(o?.note),
        facts: [
          ...artFacts(),
          ...(o?.taskId ? [fact("task", idLabel(o.taskId))] : []),
          ...(thread ? [fact("thread", thread)] : []),
        ],
      };
    }
    case "respond": {
      const type = str(o?.type);
      // A reply's own arguments name the message, not its sender; `to` is
      // only there when the row was read back from the message it sent.
      const to = list(named(o?.to));
      return {
        title: `${type && type !== "INFORM" ? `Replied: ${msgKind(type)}` : "Replied"}${to ? ` → ${to}` : ""}`,
        detail: msgSnippet(o?.response ?? o?.payload),
        facts: [...(o?.messageId ? [fact("to", shortId(str(o.messageId)))] : []), ...artFacts()],
      };
    }
    case "collab":
      return {
        title: str(o?.topic) ? `Opened a discussion: ${clip(str(o.topic), 80)}` : "Opened a discussion",
        detail: msgSnippet(o?.payload),
        facts: named(o?.with).length ? [fact("with", named(o.with))] : [],
      };
    case "close_collab":
      return { title: "Closed a discussion", detail: msgSnippet(o?.outcome), facts: o?.threadId ? [fact("thread", shortId(str(o.threadId)))] : [] };
    case "discharge":
      return {
        title: "Declined an ask",
        detail: msgSnippet(o?.reason),
        facts: [...(o?.messageId ? [fact("ask", shortId(str(o.messageId)))] : []), ...(str(o?.refusal) ? [fact("refusal", o.refusal)] : [])],
      };
    case "withdraw":
      return { title: "Withdrew its own ask", detail: msgSnippet(o?.reason), facts: o?.messageId ? [fact("ask", shortId(str(o.messageId)))] : [] };
    case "delegate":
      return {
        title: `Delegated${str(o?.to) ? ` to ${list(o.to)}` : ""}${str(o?.title) ? `: ${clip(str(o.title), 70)}` : ""}`,
        detail: msgSnippet(o?.description ?? o?.summary ?? o?.note),
        facts: artFacts(),
      };
    case "block":
      return { title: verb("Blocked", subjectOf()), detail: msgSnippet(o?.reason), facts: artFacts() };
    case "approve":
    case "reject":
    case "veto": {
      const v = op === "approve" ? "Approved" : op === "reject" ? "Rejected" : "Vetoed";
      const subj = subjectOf();
      const a = artifactOf();
      return {
        title: verb(v, subj),
        detail: msgSnippet(o?.comment),
        facts: a && a !== subj ? [fact("artifact", a)] : [],
      };
    }
    case "escalate":
      return {
        title: str(o?.reason) ? `Escalated: ${clip(str(o.reason), 90)}` : "Escalated to a human",
        detail: msgSnippet(o?.detail),
        facts: [],
      };
    case "publish_artifact": {
      // The stored content may be only its first few thousand characters;
      // the size is what the seat actually published.
      const len = ctx.clipped?.content ?? (typeof o?.content === "string" ? o.content.length : 0);
      const kind = str(o?.type) || str(o?.kind);
      const edits = Array.isArray(o?.edits) ? o.edits.length : 0;
      return {
        title: str(o?.name) ? `Published ${str(o.name)}` : "Published an artifact",
        detail: "",
        facts: [
          ...(kind ? [fact("kind", kind)] : []),
          ...(str(o?.fromPath) ? [fact("from", o.fromPath)] : []),
          ...(len ? [fact("size", plural(len, "char"))] : []),
          ...(edits ? [fact("edits", String(edits))] : []),
          ...(o?.asVersionOf ? [fact("version of", art(o.asVersionOf))] : []),
        ],
      };
    }
    case "read_artifact":
      return { title: art(o?.artifactRef) ? `Read ${art(o.artifactRef)}` : "Read an artifact", detail: "", facts: [] };
    case "transition_artifact": {
      const to = str(o?.to);
      const a = artifactOf();
      return {
        title: `Moved ${a || "an artifact"}${to ? ` → ${plainArtifact(to)}` : ""}`,
        detail: msgSnippet(o?.evidence),
        facts: [],
      };
    }
    case "request_review": {
      const reviewers = o?.reviewers ?? o?.to;
      return {
        title: artifactOf() ? `Review requested: ${artifactOf()}` : "Review requested",
        detail: msgSnippet(o?.note ?? o?.comment),
        facts: named(reviewers).length ? [fact("reviewers", named(reviewers))] : [],
      };
    }
    case "claim_task":
    case "complete_task": {
      const t = idLabel(o?.taskId ?? o?.task);
      return {
        title: `${op === "claim_task" ? "Claimed" : "Completed"} ${t || "a task"}`,
        detail: msgSnippet(o?.summary),
        facts: Array.isArray(o?.artifacts) && o.artifacts.length ? [fact("evidence", o.artifacts.map(art))] : [],
      };
    }
    case "create_task":
      return {
        title: str(o?.title) ? `Created task: ${clip(str(o.title), 90)}` : "Created a task",
        // `description` is the declared field; `summary`/`note` are what older
        // records wrote.
        detail: msgSnippet(o?.description ?? o?.summary ?? o?.note),
        facts: o?.assignedTo ? [fact("assignee", o.assignedTo)] : [],
      };
    case "request_research":
      return {
        title: named(o?.to).length ? `Research requested → ${list(named(o.to))}` : "Research requested",
        detail: msgSnippet(o?.question),
        facts: artFacts(),
      };
    case "propose_decision":
      return {
        title: str(o?.topic) ? `Proposed: ${clip(str(o.topic), 90)}` : "Proposed a decision",
        detail: msgSnippet(o?.decision) || msgSnippet(o?.summary),
        facts: [],
      };
    case "ratify_decision":
      return { title: verb("Ratified decision", idLabel(o?.decisionId ?? o?.id)), detail: "", facts: [] };
    case "acquire_lease":
    case "release_lease": {
      const files = Array.isArray(o?.files) ? o.files : [];
      return {
        title: `${op === "acquire_lease" ? "Locked" : "Unlocked"} ${artifactOf() || "an artifact"}`,
        detail: "",
        facts: files.length ? [fact("files", files)] : [],
      };
    }
    case "commit": {
      const files = Array.isArray(o?.files) ? o.files : [];
      return {
        title: verb("Committed", artifactOf()),
        detail: msgSnippet(o?.message),
        facts: files.length ? [fact("files", files)] : [],
      };
    }
    case "request_commit":
      return { title: artifactOf() ? `Commit requested: ${artifactOf()}` : "Commit requested", detail: msgSnippet(o?.comment), facts: [] };
    case "merge":
      return { title: verb("Merged", artifactOf()), detail: msgSnippet(o?.comment), facts: [] };
    case "wait":
      return { title: "Waiting", detail: msgSnippet(o?.reason), facts: [] };
    case "done":
      return { title: "Done", detail: msgSnippet(o?.summary), facts: [] };
    case "remember":
      return {
        title: str(o?.key) ? `Remembered ${clip(str(o.key), 40)}` : "Remembered a note",
        detail: typeof o?.value === "string" ? msgSnippet(o.value) : "",
        facts: o?.value !== undefined && typeof o.value !== "string" ? [fact("value", JSON.stringify(o.value))] : [],
      };
    case "write_continuity": {
      const beliefs = Array.isArray(o?.beliefs) ? o.beliefs.length : 0;
      return {
        title: "Handed over to its next session",
        detail: msgSnippet(o?.nextIntent),
        facts: beliefs ? [fact("beliefs", String(beliefs))] : [],
      };
    }
    case "contracts":
      return { title: "Listed the contracts it can raise", detail: "", facts: [] };
    case "call": {
      const contract = str(o?.contract);
      const to = list(named(o?.to));
      return {
        title: `${contract ? `Called ${contract}` : "Called a contract"}${to ? ` → ${to}` : ""}`,
        detail: msgSnippet(o?.request),
        facts: [],
      };
    }
    case "plan": {
      const n = Array.isArray(o?.steps) ? o.steps.length : 0;
      return {
        title: n ? `Planned ${n} step${n === 1 ? "" : "s"}` : "Updated its plan",
        detail: n ? msgSnippet(o.steps[0]?.text) : "",
        facts: o?.taskId ? [fact("task", idLabel(o.taskId))] : [],
      };
    }
    case "plan_step": {
      const reopened = str(o?.status) === "PENDING";
      const id = str(o?.stepId);
      const text = id ? names.get(id) : undefined;
      return {
        title: reopened ? "Reopened a plan step" : "Finished a plan step",
        detail: text ? msgSnippet(text) : "",
        facts: id && !text ? [fact("step", id)] : [],
      };
    }
    case "spawn_worker":
      return {
        title: str(o?.title) ? `Spawned a worker: ${clip(str(o.title), 80)}` : "Spawned a worker",
        detail: msgSnippet(o?.taskSpec),
        facts: named(o?.capabilities).length ? [fact("needs", named(o.capabilities))] : [],
      };
    case "submit_result": {
      const status = str(o?.result?.status);
      return {
        title: status ? `Submitted its result: ${status.toLowerCase()}` : "Submitted its result",
        detail: msgSnippet(o?.result?.summary),
        facts: [],
      };
    }
    default: {
      // No recipe for this op kind. Show the scalars it actually carries
      // rather than stringifying the whole op; nested objects and the full
      // payload are still under Raw and in the inspector.
      const facts = Object.entries((o ?? {}) as Record<string, unknown>)
        .filter(([k, v]) => k !== "op" && typeof v !== "object" && v !== null && v !== undefined && v !== "")
        .slice(0, 3)
        .map(([k, v]) => fact(k, v));
      return { title: sentenceCase(op) || "Action", detail: "", facts };
    }
  }
}
