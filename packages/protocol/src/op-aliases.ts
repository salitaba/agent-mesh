import { ARTIFACT_TYPES, MESSAGE_TYPES } from "./catalog";
import type { ArtifactType, MessageType } from "./types";

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

export function aliasTextOp(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.op !== "string" || o.op.length === 0) return null;
  const out: Record<string, unknown> = { ...o, op: NAME_ALIASES[o.op] ?? o.op };

  // `message.<TYPE>` shorthand: op carries the message type.
  if (typeof o.op === "string" && o.op.startsWith("message.") && out.op === o.op) {
    const t = o.op.slice("message.".length).toUpperCase();
    out.op = "send";
    if (out.type === undefined && (MESSAGE_TYPES as string[]).includes(t)) out.type = t;
  }
  if (typeof out.type === "string") {
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
    if (mapped) out.type = mapped;
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
      // Model-supplied addressing hints have no op fields; keep them as metadata.
      const meta = { ...((o.metadata as Record<string, unknown> | undefined) ?? {}) };
      for (const k of ["uri", "version", "supersedes"]) {
        if (o[k] !== undefined && meta[k] === undefined) meta[k] = o[k];
      }
      if (Object.keys(meta).length > 0) out.metadata = meta;
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
