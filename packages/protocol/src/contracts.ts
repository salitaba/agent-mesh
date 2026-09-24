import type { MessageType } from "./types";

/**
 * Contracts: the vocabulary a seat can actually learn.
 *
 * The problem this replaces is measurable. `MESSAGE_TYPES` offers 24 strings
 * and a seat is told to pick one. Of those, PROPOSE, ROLLBACK and WAIT are
 * branched on by nothing at all, MISSION survives only in the bench simulator,
 * and HANDOFF and COMMIT are written by the kernel and never read by identity.
 * Exactly one — DONE — carries a semantic distinction anything acts on, and
 * that is an observability edge label. So a seat guesses among 24 names of
 * which 7 mean something, gets it wrong, and `op-aliases.ts` (60 name aliases,
 * 31 type aliases) exists to catch the guesses. One agent burned 18 turns on
 * `RESULT`.
 *
 * A contract is a NAME FOR A PATH THAT ALREADY WORKS. Every one below
 * desugars onto the request types that genuinely open a commitment
 * (`projections-messaging.ts`: anything `REQUEST*`, plus ESCALATE and
 * CHALLENGE). Nothing here introduces a delivery mechanism, a reducer, or a
 * debt semantic — `mesh.call` is sugar over `send` / `request_review` /
 * `request_research` / `escalate`, and if the catalogue is wrong the failure
 * is a refusal rather than a silently different history.
 *
 * What it buys, concretely:
 *
 * 1. The guessable surface shrinks from 24 type strings to 8 contract names,
 *    each with a request schema that is CHECKED. A malformed ask is refused at
 *    the edge with the field named, instead of arriving as a well-formed
 *    message carrying nonsense.
 * 2. A closed `refusals` set. Stage 2 made "no" a first-class settlement
 *    carrying the refuser's words; until now those words were unconstrained
 *    prose, so no consumer could branch on WHY. A contract states the legitimate
 *    noes up front.
 * 3. Provider resolution. Today every capability table in the repo runs the
 *    other direction — given an artifact or an op, which capability is
 *    required — and the answer to "who do I ask for this?" is a linear scan a
 *    seat has to perform for itself by reading the roster. `provider` inverts
 *    it, which is the part of "X-as-a-Service" that was still missing.
 * 4. `slaMs` gives an ask a deadline drawn from the contract rather than from
 *    the debtor's role, so a cheap question and an expensive review are not
 *    held to the same clock.
 */
export interface Contract {
  /** Stable, dotted, and the only name a seat has to know. */
  name: string;
  version: number;
  /** One line, rendered into the seat's prompt. */
  summary: string;
  /**
   * The op this desugars to. `mesh.call` is sugar: nothing here reaches a
   * path that a typed op could not already reach.
   */
  desugarsTo: "send" | "request_review" | "request_research" | "escalate";
  /** The wire type the desugared message carries. */
  messageType: MessageType;
  /**
   * Capability that marks a seat as able to ANSWER this. Used to resolve a
   * provider when the caller does not name one. Absent means any seat the
   * caller may contact is a legitimate target.
   */
  provider?: string;
  /** JSON Schema for the request body. Validated before anything is sent. */
  request: Record<string, unknown>;
  /**
   * JSON Schema for the ANSWER.
   *
   * Without this a contract is half a contract. The mesh checked the ask
   * (`request`) and the "no" (`refusals`) and never once checked the "yes":
   * discharge is structural -- a reply naming the ask settles it -- so an
   * empty INFORM, a bare acknowledgement, or "sure, will do" closed a
   * commitment exactly as firmly as a real answer. The asker then discovers
   * the hole a turn later and re-asks, which is the expensive shape: every
   * re-ask is a full turn, and the nudge ladder beneath it ends at a human.
   *
   * Checked at DISCHARGE and deliberately FAIL-OPEN: an answer that does not
   * match still settles the ask, and the mismatch is recorded on the ledger
   * (`responseValid: false`) and surfaced in the run report. Failing closed
   * would hold asks open on formatting, feed the nudge ladder, and escalate
   * disagreements about shape to the operator as if they were stalls -- worse
   * than the gap it fixes. A mark is cheap and honest; a block is neither.
   *
   * Absent means "any reply settles this" -- the pre-existing behaviour, kept
   * for asks a peer does not answer at all (see decision.escalate).
   */
  response?: Record<string, unknown>;
  /** The closed set of legitimate "no"s. */
  refusals: string[];
  /** Deadline the resulting commitment opens with. */
  slaMs?: number;
}

const MINUTES = 60_000;

/**
 * Refusals every contract admits. A seat that cannot answer has to say which
 * of these it means, so the asker can tell "I am the wrong seat" (re-route)
 * from "your ask is incomplete" (re-ask) from "I disagree" (escalate) —
 * three situations that free-text refusal made indistinguishable.
 */
const COMMON_REFUSALS = ["not-my-capability", "insufficient-detail", "out-of-scope", "blocked-on-dependency"];

/**
 * "The reply carried an answer", as a schema.
 *
 * Generous on shape and strict on emptiness, because the two mistakes are not
 * symmetric. Agents disagree on the field name for an answer -- `answer`,
 * `content`, `summary`, `result` all appear in this repo's own fixtures -- and
 * rejecting a good answer for calling itself the wrong thing would produce a
 * false mark on a real settlement, teaching the operator to ignore the marks.
 * Missing a thin answer merely leaves us where we already were. So: ANY of the
 * listed keys satisfies it, and `additionalProperties` stays open because a
 * reply is not wrong for being richer than the contract asked.
 *
 * `minLength` is what actually bites, and it only bites strings -- a
 * structured answer under one of these keys passes untouched, while
 * `{ answer: "" }` and `{ answer: "   " }` do not. That is the case this
 * exists for: a reply that is well-formed, settles the debt, and says nothing.
 */
function answeredWith(keys: readonly string[]): Record<string, unknown> {
  return {
    type: "object",
    anyOf: keys.map((k) => ({ required: [k] })),
    // `pattern` alongside `minLength` because `minLength` counts whitespace:
    // `{ answer: "   " }` is length 3 and would otherwise pass as an answer.
    // "empty or whitespace-only" is already how this repo judges an artifact's
    // content (`validateArtifact`), and an answer deserves the same bar.
    properties: Object.fromEntries(keys.map((k) => [k, { minLength: 1, pattern: "\\S" }])),
    additionalProperties: true,
    // Named so a failing reply is told what would have satisfied it, rather
    // than being handed an Ajv path it cannot act on.
    description: `answer must carry a non-empty one of: ${keys.join(", ")}`,
  };
}

export const BUILTIN_CONTRACTS: readonly Contract[] = Object.freeze([
  {
    name: "review.artifact",
    version: 1,
    summary: "Ask a qualified peer to review a published artifact.",
    desugarsTo: "request_review",
    messageType: "REQUEST_REVIEW",
    // Deliberately absent: the required capability depends on the artifact's
    // TYPE (`REVIEW_CAPABILITIES`), so it is resolved per call rather than
    // pinned here. Pinning one would be a fourth copy of a table the repo
    // already keeps two diverging copies of.
    request: {
      type: "object",
      properties: {
        artifact: { type: "string", minLength: 1, description: "artifact id or artifact:// URI" },
        reviewers: { type: "array", items: { type: "string" }, description: "omit to let the mesh pick qualified reviewers" },
        note: { type: "string", description: "what you want looked at" },
      },
      required: ["artifact"],
      additionalProperties: false,
    },
    response: answeredWith(["verdict", "decision", "result", "findings", "summary", "review", "content"]),
    refusals: [...COMMON_REFUSALS, "not-ready-for-review", "already-reviewed"],
    slaMs: 30 * MINUTES,
  },
  {
    name: "research.question",
    version: 1,
    summary: "Ask a seat to go find something out and report back.",
    desugarsTo: "request_research",
    messageType: "REQUEST_RESEARCH",
    provider: "repository.read",
    request: {
      type: "object",
      properties: {
        question: { type: "string", minLength: 1 },
        to: { type: "string", description: "omit to let the mesh pick" },
        artifactRefs: { type: "array", items: { type: "object" } },
      },
      required: ["question"],
      additionalProperties: false,
    },
    response: answeredWith(["answer", "findings", "summary", "content", "result", "sources"]),
    refusals: [...COMMON_REFUSALS, "already-answered"],
    slaMs: 20 * MINUTES,
  },
  {
    name: "info.question",
    version: 1,
    summary: "Ask a peer something they already know. No research expected.",
    desugarsTo: "send",
    messageType: "REQUEST_INFO",
    request: {
      type: "object",
      properties: {
        question: { type: "string", minLength: 1 },
        to: { type: "array", items: { type: "string" } },
        subject: { type: "string" },
      },
      required: ["question"],
      additionalProperties: false,
    },
    response: answeredWith(["answer", "content", "summary", "result"]),
    refusals: [...COMMON_REFUSALS, "already-answered"],
    slaMs: 10 * MINUTES,
  },
  {
    name: "artifact.produce",
    version: 1,
    summary: "Ask a seat to produce and publish an artifact.",
    desugarsTo: "send",
    messageType: "REQUEST_ARTIFACT",
    request: {
      type: "object",
      properties: {
        what: { type: "string", minLength: 1, description: "what to produce, and what it is for" },
        artifactType: { type: "string" },
        to: { type: "array", items: { type: "string" } },
        subject: { type: "string" },
      },
      required: ["what"],
      additionalProperties: false,
    },
    response: answeredWith(["artifactId", "artifact", "uri", "artifactRefs", "published", "summary"]),
    refusals: [...COMMON_REFUSALS, "already-exists", "needs-decision-first"],
    slaMs: 45 * MINUTES,
  },
  {
    name: "execution.run",
    version: 1,
    summary: "Ask a seat that holds shell.execute to run something and report the result.",
    desugarsTo: "send",
    messageType: "REQUEST_EXECUTION",
    provider: "shell.execute",
    request: {
      type: "object",
      properties: {
        what: { type: "string", minLength: 1 },
        to: { type: "array", items: { type: "string" } },
        subject: { type: "string" },
      },
      required: ["what"],
      additionalProperties: false,
    },
    response: answeredWith(["result", "output", "exitCode", "summary", "content", "status"]),
    refusals: [...COMMON_REFUSALS, "unsafe-to-run"],
    slaMs: 20 * MINUTES,
  },
  {
    name: "work.request",
    version: 1,
    summary: "A general ask that does not fit a narrower contract. Opens a commitment like any other.",
    desugarsTo: "send",
    messageType: "REQUEST",
    request: {
      type: "object",
      properties: {
        ask: { type: "string", minLength: 1 },
        to: { type: "array", items: { type: "string" } },
        subject: { type: "string" },
      },
      required: ["ask"],
      additionalProperties: false,
    },
    response: answeredWith(["result", "summary", "answer", "content", "done", "artifactId"]),
    refusals: COMMON_REFUSALS,
    slaMs: 30 * MINUTES,
  },
  {
    name: "decision.challenge",
    version: 1,
    summary: "Formally dispute a claim or decision. Opens a commitment on the other seat to answer.",
    desugarsTo: "send",
    messageType: "CHALLENGE",
    request: {
      type: "object",
      properties: {
        claim: { type: "string", minLength: 1, description: "what you are disputing" },
        reason: { type: "string", minLength: 1, description: "why" },
        to: { type: "array", items: { type: "string" } },
      },
      required: ["claim", "reason"],
      additionalProperties: false,
    },
    response: answeredWith(["response", "answer", "verdict", "resolution", "stands", "content"]),
    refusals: [...COMMON_REFUSALS, "withdrawn", "stands-as-written"],
    slaMs: 30 * MINUTES,
  },
  {
    name: "decision.escalate",
    version: 1,
    summary: "Raise a card for the human operator. Use when no seat here can settle it.",
    desugarsTo: "escalate",
    messageType: "ESCALATE",
    request: {
      type: "object",
      properties: {
        reason: { type: "string", minLength: 1 },
        detail: {},
        conflictKey: { type: "string" },
      },
      required: ["reason"],
      additionalProperties: false,
    },
    // No `response` schema, for the same reason there are no refusals: an
    // operator card is not answered by a peer at all. A human settles it
    // through the escalation path, which this ledger does not shape.
    // An operator card is not refused by a peer; it is answered by a human.
    refusals: [],
  },
]);

export function findContract(name: string): Contract | undefined {
  if (typeof name !== "string") return undefined;
  const wanted = name.trim().toLowerCase();
  return BUILTIN_CONTRACTS.find((c) => c.name === wanted);
}

export function contractNames(): string[] {
  return BUILTIN_CONTRACTS.map((c) => c.name);
}

/**
 * The contract that governs a message type when the sender named none.
 *
 * DERIVED from the catalogue's own `messageType` fields, never enumerated. A
 * hand-written table here would be a second place to state a mapping the
 * contracts already carry, and the two would drift the first time a contract
 * changed the type it speaks for -- the failure mode `OBLIGING_MESSAGE_TYPES`
 * and `WORK_MOVING_MESSAGE_TYPES` are both built to avoid.
 *
 * Returns undefined for every type no contract claims, which is the honest
 * answer and the one that keeps this safe: `isObligingType` is a PREFIX match
 * (`startsWith("REQUEST")`), so a `REQUEST_*` type added later is obliging
 * from the moment it exists and has no contract until someone writes one.
 * That case gets no default rather than a wrong one.
 *
 * Nothing here decides whether the default is USED. This only answers "which
 * contract speaks for this type"; `bus.contracts_by_type` decides whether an
 * ask that named none is held to it. See `contractOf` in
 * `packages/core/src/projections-messaging.ts`.
 */
const CONTRACT_BY_MESSAGE_TYPE: ReadonlyMap<string, Contract> = (() => {
  const byType = new Map<string, Contract>();
  for (const c of BUILTIN_CONTRACTS) {
    // First wins, deliberately. Two contracts claiming one type is a
    // catalogue bug, not a precedence question -- `tests/protocol/
    // contracts.test.ts` asserts the claim is unique so this branch stays
    // unreachable rather than silently picking a winner.
    if (!byType.has(c.messageType)) byType.set(c.messageType, c);
  }
  return byType;
})();

export function contractForMessageType(type: string): Contract | undefined {
  if (typeof type !== "string") return undefined;
  return CONTRACT_BY_MESSAGE_TYPE.get(type);
}

/**
 * The refusal an unknown contract gets. It NAMES THE ALTERNATIVES, which is the
 * whole mitigation for the risk this stage carries: a larger vocabulary is only
 * safe if getting it wrong teaches you the right one in the same breath. An
 * alias table is what you build when the error message does not do this.
 */
export function unknownContractReason(name: unknown): string {
  const got = typeof name === "string" && name.trim() ? name.trim() : "(none given)";
  return `unknown contract ${got}. Available: ${contractNames().join(", ")}. Call the contracts op for their request shapes.`;
}
