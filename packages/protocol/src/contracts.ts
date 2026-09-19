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
 * which 7 mean something, gets it wrong, and `op-aliases.ts` (49 name aliases,
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
 * The refusal an unknown contract gets. It NAMES THE ALTERNATIVES, which is the
 * whole mitigation for the risk this stage carries: a larger vocabulary is only
 * safe if getting it wrong teaches you the right one in the same breath. An
 * alias table is what you build when the error message does not do this.
 */
export function unknownContractReason(name: unknown): string {
  const got = typeof name === "string" && name.trim() ? name.trim() : "(none given)";
  return `unknown contract ${got}. Available: ${contractNames().join(", ")}. Call the contracts op for their request shapes.`;
}
