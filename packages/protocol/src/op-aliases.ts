import { ARTIFACT_SCOPES, ARTIFACT_TYPES, MESSAGE_TYPES } from "./catalog";
import type { ArtifactScope, ArtifactType, MessageType } from "./types";

/**
 * WHEN THIS FILE CAN BE DELETED — and why it is still here.
 *
 * These tables exist for one reason: the vocabulary they denoise cannot be
 * learned. 56 op-name aliases and 31 type aliases, `TYPE_ALIASES` alone
 * folding thirteen different words for "here is your answer" (RESULT,
 * RESPONSE, REPLY, ANSWER, ACK, …) onto INFORM. The file is the system
 * telling us its own surface is noise.
 *
 * `bus.vocabulary: "contracts"` removes the field those inventions are made
 * in. Under it the advertised manifest carries no `MessageType` enum at all —
 * `mesh_call` names the ASK, `mesh_reply` answers one and `mesh_announce`
 * tells, and none of the three has a `type` to guess wrong. So the tables
 * become unnecessary for a seat on that manifest, which is the payoff Move 1
 * was actually bought for.
 *
 * That is not the same as deletable, and the difference is the whole reason
 * this file survives the move. Three things have to be true first:
 *
 *  1. **Every mesh in the wild runs `vocabulary: "contracts"`.** Only meshes
 *     scaffolded by `mesh init` get it (`writeDefaultMeshYaml`); an existing
 *     `mesh.yaml` resolves to absent and keeps the full typed manifest, by
 *     design. Until that is no longer true, deleting these tables changes the
 *     behaviour of meshes that never opted into anything.
 *  2. **The prose channel is gone, or every mesh is `transport: "typed-only"`.**
 *     These tables translate `mesh-json` blocks, which the manifest never
 *     touches. A `transport: "mixed"` mesh still parses prose ops, and a model
 *     writing prose writes `mesh_send` — because the role prompt taught it the
 *     tool names — no matter what the manifest advertises. Hiding a tool does
 *     not unteach its name.
 *  3. **`aliasStats()` reports zero across a real run.** The counters were
 *     added (Stage 4.5) for exactly this decision. Retiring a safety net on
 *     the strength of a design argument rather than a measurement is how the
 *     vocabulary got this large in the first place.
 *
 * Note that (1) and (2) are independent: a mesh can collapse its vocabulary
 * and still accept prose. `AliasOptions.aliases` already lets the runtime
 * retire the tables per mesh, which is the safe intermediate and what
 * `typed-only` does today — so the ordering is "measure, then flip the flag
 * everywhere, then delete", not "delete".
 */

/**
 * Translate model-invented op names/fields into canonical MeshOps.
 *
 * Role prompts teach the `mesh_*` MCP-tool vocabulary, so models (especially
 * small ones) emit text blocks with `mesh_*` names instead of the bare op
 * names the text parser expects. Without translation every such op dies with
 * "unknown op", the turn lands zero side effects, and the mission stalls
 * silently. Unknown names pass through unchanged so executeOp still rejects
 * them visibly.
 */
const NAME_ALIASES: Record<string, string> = {
  mesh_send: "send",
  mesh_message: "send",
  message_send: "send",
  "message.send": "send",
  mesh_broadcast: "broadcast",
  mesh_collab: "collab",
  open_collab: "collab",
  collaborate: "collab",
  discuss: "collab",
  mesh_collab_close: "close_collab",
  end_collab: "close_collab",
  collab_close: "close_collab",
  mesh_request: "send",
  mesh_respond: "respond",
  mesh_discharge: "discharge",
  decline: "discharge",
  decline_request: "discharge",
  mesh_delegate: "delegate",
  mesh_block: "block",
  mesh_approve: "approve",
  mesh_reject: "reject",
  mesh_veto: "veto",
  mesh_escalate: "escalate",
  mesh_artifact_publish: "publish_artifact",
  mesh_publish_artifact: "publish_artifact",
  mesh_artifact_read: "read_artifact",
  mesh_artifact_transition: "transition_artifact",
  mesh_request_review: "request_review",
  mesh_task_claim: "claim_task",
  mesh_task_complete: "complete_task",
  mesh_task_create: "create_task",
  mesh_research_request: "request_research",
  mesh_decision_propose: "propose_decision",
  mesh_decision_ratify: "ratify_decision",
  mesh_lease_acquire: "acquire_lease",
  mesh_lease_release: "release_lease",
  mesh_commit: "commit",
  mesh_merge: "merge",
  mesh_wait: "wait",
  mesh_done: "done",
  mesh_remember: "remember",
  mesh_write_continuity: "write_continuity",
  handoff: "write_continuity",
  mesh_plan: "plan",
  mesh_plan_step: "plan_step",
  // Coding agents arrive with a house todo tool already in their habits
  // (Claude Code's TodoWrite, Codex's update_plan). Mapping the names they
  // already reach for costs one table entry and saves a rejected turn each.
  todo: "plan",
  todos: "plan",
  todo_write: "plan",
  TodoWrite: "plan",
  update_plan: "plan",
  plan_update: "plan",
  complete_step: "plan_step",
  step_complete: "plan_step",
  todo_update: "plan_step",
  mesh_spawn_worker: "spawn_worker",
  mesh_submit_result: "submit_result",
};

/** Observed model invention: event-style type used as a message type. */
const TYPE_ALIASES: Record<string, MessageType> = {
  "design.question": "REQUEST",
  design_question: "REQUEST",
  // Models replying in-thread invent a REPLY type; closest valid intent is an
  // in-thread INFORM, which both delivers the answer and resolves the pending
  // request (the projections clear INFORMs in the ask's thread). Mapping to
  // REQUEST instead minted a NEW pending request on a NEW thread — which is
  // exactly how one answered ask became two open ones and a false stalemate.
  reply: "INFORM",
  // Answering-a-request family. Every one of these was observed in a live run
  // and rejected by schema validation, which silently dropped the answer: the
  // asker stayed parked in WAITING, the timer nudged it, and the responder
  // re-sent the same invalid type on its next wake. One agent burned 18 turns
  // this way on `RESULT` alone. The intent is unambiguous — deliver an answer
  // in an existing thread — so normalise rather than reject.
  RESULT: "INFORM",
  RESPONSE: "INFORM",
  REPLY: "INFORM",
  ANSWER: "INFORM",
  ACK: "INFORM",
  UPDATE: "INFORM",
  STATUS: "INFORM",
  REPORT: "INFORM",
  NOTIFY: "INFORM",
  // Payload/artifact-shaped inventions: the model names the thing it is
  // returning instead of the speech act.
  ResearchReport: "INFORM",
  RESEARCH_REPORT: "INFORM",
  RESEARCH_RESULT: "INFORM",
  FINDINGS: "INFORM",
  // Near-misses on types that DO exist under a different spelling.
  TESTRESULT: "TEST_RESULT",
  TEST_RESULTS: "TEST_RESULT",
  QA_RESULT: "TEST_RESULT",
  REVIEW_REQUEST: "REQUEST_REVIEW",
  REVIEW: "REQUEST_REVIEW",
  RESEARCH_REQUEST: "REQUEST_RESEARCH",
  INFO_REQUEST: "REQUEST_INFO",
  QUESTION: "REQUEST_INFO",
  APPROVAL: "APPROVE",
  APPROVED: "APPROVE",
  REJECTED: "REJECT",
  BLOCKED: "BLOCK",
  COMPLETE: "DONE",
  COMPLETED: "DONE",
  FINISHED: "DONE",
};

const asArray = (v: unknown): string[] | undefined => {
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === "string" && v.length > 0) return [v];
  return undefined;
};

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

/**
 * How often each rewrite below has fired in this process, keyed
 * `op:<invented>-><canonical>` / `type:<invented>-><canonical>`.
 *
 * This table is a debt, not a feature: every entry is a name a model guessed
 * because the vocabulary it was shown did not tell it the real one. Retiring
 * it needs an answer to "is anything still relying on this?", and until now
 * nothing in the mesh could answer that — the rewrite happened silently and
 * the canonical op was indistinguishable from one the model got right. So the
 * table papered over its own justification.
 *
 * Process-lived and unattributed on purpose. Turns run concurrently, so
 * pinning a rewrite to the turn that caused it would need plumbing that could
 * only ever be approximately right; the question this answers ("does anyone
 * still need aliasing, and for which names") is an aggregate question.
 */
const aliasHits = new Map<string, number>();

function recordAlias(kind: "op" | "type", from: string, to: string): void {
  if (from === to) return;
  const key = `${kind}:${from}->${to}`;
  aliasHits.set(key, (aliasHits.get(key) ?? 0) + 1);
}

export interface AliasStats {
  /** Every rewrite this process has performed. */
  total: number;
  /** Per-rewrite counts, descending. Empty means nothing relied on the table. */
  byRewrite: Array<{ rewrite: string; count: number }>;
}

export function aliasStats(): AliasStats {
  const byRewrite = [...aliasHits.entries()]
    .map(([rewrite, count]) => ({ rewrite, count }))
    .sort((a, b) => b.count - a.count || a.rewrite.localeCompare(b.rewrite));
  return { total: byRewrite.reduce((n, e) => n + e.count, 0), byRewrite };
}

export function resetAliasStats(): void {
  aliasHits.clear();
}

export interface AliasOptions {
  /**
   * False retires the invented-name tables: an op name or message type the
   * model made up passes through unchanged, so `executeOp` refuses it by name
   * and the model is told what it should have said. Structural coercion (a
   * `to` string widened to an array, `body` read as `payload`) still applies —
   * that is shape, not vocabulary, and nothing is being guessed at.
   *
   * Defaults to true. `bus.transport: "typed-only"` is the setting this exists
   * for: there, ops are issued as typed tool calls and a parsed op is already
   * refused, so rewriting one buys nothing and hides who still needs it.
   */
  aliases?: boolean;
}

export function aliasTextOp(raw: unknown, opts: AliasOptions = {}): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.op !== "string" || o.op.length === 0) return null;
  const useAliases = opts.aliases !== false;
  const renamed = useAliases ? NAME_ALIASES[o.op] ?? o.op : o.op;
  if (renamed !== o.op) recordAlias("op", o.op, renamed);
  const out: Record<string, unknown> = { ...o, op: renamed };

  // `message.<TYPE>` shorthand: op carries the message type.
  if (useAliases && typeof o.op === "string" && o.op.startsWith("message.") && out.op === o.op) {
    recordAlias("op", o.op, "send");
    const t = o.op.slice("message.".length).toUpperCase();
    out.op = "send";
    if (out.type === undefined && (MESSAGE_TYPES as string[]).includes(t)) out.type = t;
  }
  if (useAliases && typeof out.type === "string") {
    const before = out.type;
    // Match the alias table case-insensitively and ignoring separators, so
    // `RESULT` / `result` / `Research_Report` / `research report` all land on
    // the same entry. Models are inconsistent about casing between turns; a
    // case-sensitive lookup let half the inventions through to the validator,
    // where they were dropped silently.
    const norm = (s: string): string => s.replace(/[\s\-_.]+/g, "").toUpperCase();
    let mapped = TYPE_ALIASES[out.type] ?? TYPE_ALIASES[out.type.toLowerCase()];
    if (!mapped) {
      const want = norm(out.type);
      // An exact (normalised) hit on a REAL type wins over any alias:
      // `test_result` must stay TEST_RESULT, not fall through to INFORM.
      const real = (MESSAGE_TYPES as string[]).find((t) => norm(t) === want);
      if (real) mapped = real as MessageType;
      else {
        const hit = Object.keys(TYPE_ALIASES).find((k) => norm(k) === want);
        if (hit) mapped = TYPE_ALIASES[hit];
      }
    }
    if (mapped) {
      out.type = mapped;
      recordAlias("type", before, mapped);
    }
  }

  switch (out.op) {
    case "send": {
      const to = asArray(o.to);
      if (to) out.to = to;
      if (out.payload === undefined && o.body !== undefined) out.payload = o.body;
      if (out.newThread === undefined && out.threadId === undefined) {
        const subject = str(o.subject);
        if (subject) out.newThread = { subject };
      }
      if (out.type === undefined && typeof o.requestType === "string") {
        const t = o.requestType.toUpperCase();
        if ((MESSAGE_TYPES as string[]).includes(t)) out.type = t;
      }
      break;
    }
    case "publish_artifact": {
      if (out.type === undefined && typeof o.kind === "string") {
        if ((ARTIFACT_TYPES as string[]).includes(o.kind)) out.type = o.kind as ArtifactType;
      }
      // `scope` is advisory — it widens who sees the artifact, it does not
      // decide whether the artifact exists. A model that writes "Mission" or
      // invents "global" should not lose the whole document to a schema error
      // on the one field nobody asked it for, so normalize what is recognizable
      // and drop what is not; the read-time default then applies.
      if (out.scope !== undefined) {
        const s = typeof o.scope === "string" ? o.scope.toLowerCase() : "";
        if ((ARTIFACT_SCOPES as string[]).includes(s)) out.scope = s as ArtifactScope;
        else delete out.scope;
      }
      // Model-supplied addressing hints have no op fields; keep them as metadata.
      const meta = { ...((o.metadata as Record<string, unknown> | undefined) ?? {}) };
      for (const k of ["uri", "version", "supersedes"]) {
        if (o[k] !== undefined && meta[k] === undefined) meta[k] = o[k];
      }
      if (Object.keys(meta).length > 0) out.metadata = meta;
      break;
    }
    case "plan": {
      // Every shape a todo list arrives in: a list under any of three keys,
      // and items that are either bare strings or objects whose text sits
      // under any of four keys. Coercing here rather than rejecting is the
      // difference between the op landing and the turn being wasted.
      const raw = (o.steps ?? o.todos ?? o.items ?? o.plan ?? o.tasks) as unknown;
      if (Array.isArray(raw)) {
        out.steps = raw
          .map((s) => {
            if (typeof s === "string") return { text: s };
            if (!s || typeof s !== "object") return null;
            const e = s as Record<string, unknown>;
            const text = str(e.text) ?? str(e.content) ?? str(e.title) ?? str(e.description) ?? str(e.step);
            if (!text) return null;
            const status = typeof e.status === "string" && /^(done|completed|complete|finished)$/i.test(e.status)
              ? "DONE"
              : "PENDING";
            const caps = asArray(e.capabilities) ?? asArray(e.capability) ?? asArray(e.uses);
            return { id: str(e.id), text, status, ...(caps ? { capabilities: caps } : {}) };
          })
          .filter(Boolean);
      }
      break;
    }
    case "plan_step": {
      const id = str(o.stepId) ?? str(o.id) ?? str(o.step) ?? str(o.stepID);
      if (id) out.stepId = id;
      const s = str(o.status) ?? str(o.state);
      // `plan_step` with no status at all means "I finished this one" — that is
      // what every house todo tool's completion call looks like.
      out.status = s && /^(pending|todo|open|in_progress)$/i.test(s) ? "PENDING" : "DONE";
      break;
    }
    case "request_review": {
      const reviewers = asArray(o.reviewers) ?? asArray(o.to);
      if (reviewers) out.reviewers = reviewers;
      const ref = str(o.artifactId) ?? str(o.artifact) ?? str(o.artifactRef) ?? str(o.uri);
      if (ref) {
        if (ref.includes("://")) out.artifactUri = ref;
        else out.artifactId = ref;
      }
      break;
    }
    case "read_artifact": {
      const ref = str(o.artifactRef) ?? str(o.artifact) ?? str(o.ref) ?? str(o.uri);
      if (ref) out.artifactRef = ref;
      // Models routinely hand back a numeric field as a string; a dropped
      // offset silently restarts the read at 0, which loops a paging agent.
      const rawOffset = o.offset ?? o.from ?? o.start;
      const offset = typeof rawOffset === "number" ? rawOffset : Number(str(rawOffset) ?? NaN);
      if (Number.isFinite(offset) && offset > 0) out.offset = Math.floor(offset);
      break;
    }
    case "transition_artifact":
    case "approve":
    case "reject":
    case "veto":
    case "block":
    case "commit":
    case "merge": {
      const ref = str(o.artifactId) ?? str(o.artifact) ?? str(o.uri);
      if (ref) {
        if (ref.includes("://")) out.artifactUri = ref;
        else out.artifactId = ref;
      }
      break;
    }
    case "propose_decision": {
      if (out.topic === undefined) {
        out.topic = str(o.summary) ?? str(o.id) ?? "decision";
      }
      if (out.decision === undefined || typeof out.decision !== "object") {
        const d: Record<string, unknown> = {};
        if (typeof o.summary === "string") d.summary = o.summary;
        if (typeof o.id === "string") d.id = o.id;
        if (typeof o.artifact === "string") d.artifact = o.artifact;
        if (typeof o.decision !== "undefined") d.value = o.decision;
        out.decision = d;
      }
      if (out.evidence === undefined && typeof o.artifact === "string") {
        out.evidence = [{ uri: o.artifact }];
      } else if (typeof o.evidence === "string") {
        out.evidence = [{ uri: o.evidence }];
      }
      break;
    }
    case "create_task":
    case "claim_task":
    case "complete_task": {
      const tid = str(o.taskId) ?? str(o.task);
      if (tid) out.taskId = tid;
      break;
    }
    case "ratify_decision": {
      const did = str(o.decisionId) ?? str(o.id);
      if (did) out.decisionId = did;
      break;
    }
    case "request_research": {
      const to = asArray(o.to);
      if (to && to.length > 0) out.to = to[0];
      break;
    }
    case "delegate": {
      if (typeof o.to !== "string" && Array.isArray(o.to) && o.to.length > 0) {
        out.to = String(o.to[0]);
      }
      break;
    }
    default:
      break;
  }
  return out;
}
