/* What the designer assistant says when it has nothing yet, when it cannot answer, and what it calls an answer that proposed nothing.
 * DOM-free, so the wording is pinned against the strings the console and the host really send.
 *
 * A person who asks the designer to describe a team is at the very start, and a raw `{"error":"..."}` or "the reply contained no parseable
 * whole-config block or patch" tells them nothing about what happened or what to do. Every message here says what happened, that nothing in the
 * draft changed, and what to do instead. */

import { KEY_MISSING } from "../firstrun";

/** What the dock shows before anything is said: a question to answer, and two ways to begin. A starter fills the box and sends nothing. */
export const ASSISTANT_ASK = "What should the team look like? Describe it in a sentence, or start from one of these.";

export interface Starter {
  id: string;
  label: string;
  /** What goes in the box. The person reads it, changes it if they like, and sends it. */
  text: string;
}

export const STARTERS: readonly Starter[] = [
  { id: "product", label: "Product team: PM, architect, developers, QA", text: "A product team: a product manager, an architect, two developers and a QA engineer." },
  { id: "small", label: "A small team: one builder and one reviewer", text: "A small team: one builder and one reviewer." },
];

/** What happened to a question the designer could not answer, and what to do. `key` and `credentials` are about models; the rest about the conversation. */
export type TroubleKind = "key" | "credentials" | "busy" | "offline" | "interrupted" | "other";

export interface Trouble {
  kind: TroubleKind;
  /** One or two sentences. Always says the draft was not changed. */
  text: string;
}

const UNCHANGED = "Nothing in your draft was changed.";
const BY_HAND = "You can still build the team yourself: add seats on the canvas or in the list.";

/** The sentence inside a body the console shows raw: `{"error":"x","code":"y"}` is "x". Anything else is itself, shortened. */
export function plainReason(raw: string): string {
  const text = raw.trim();
  if (text.startsWith("{")) {
    try {
      const body: unknown = JSON.parse(text);
      if (body !== null && typeof body === "object") {
        const said = (body as { reason?: unknown; error?: unknown }).reason ?? (body as { error?: unknown }).error;
        if (typeof said === "string" && said.trim() !== "") return said.trim();
      }
    } catch {
      /* cut off at 200 characters, or not JSON: read as text */
    }
  }
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

const sentence = (s: string): string => (/[.!?…]$/.test(s) ? s : `${s}.`);

/** Wording for a model the host could not reach with what it has: a refusal from a provider, a missing key, a login that is not there. */
const NO_MODEL = /api[ _-]?key|authentication|unauthori[sz]ed|credential|log ?in\b|\/login|not configured|no model|permission denied/i;

/**
 * What to tell a person whose question the designer did not answer. `hosted` is the workspace's own account page when this host is one
 * (the key is added there), `keyMissing` that nothing supplies models and no key is set. The raw text is what the console was given.
 */
export function assistantTrouble(raw: string, ctx: { hosted: { accountUrl: string } | null; keyMissing: boolean }): Trouble {
  const said = plainReason(raw);
  if (ctx.keyMissing) return { kind: "key", text: `${KEY_MISSING} The designer thinks with that key too. ${BY_HAND}` };
  if (/designer_busy|already working on \d+ conversations/i.test(raw)) {
    return { kind: "busy", text: `The designer is busy with other conversations. Wait a moment and ask again. ${UNCHANGED}` };
  }
  if (/server is unreachable|did not answer/i.test(raw)) {
    return { kind: "offline", text: `The host did not answer. Check that it is still running, then ask again. ${UNCHANGED}` };
  }
  if (/stream was interrupted/i.test(raw)) {
    return { kind: "interrupted", text: `The answer was cut off before it finished. Ask again. ${UNCHANGED}` };
  }
  if (NO_MODEL.test(said)) {
    return ctx.hosted
      ? { kind: "credentials", text: `The designer could not reach a model with the key this workspace has: ${sentence(said)} Check the key on your account page. ${UNCHANGED} ${BY_HAND}` }
      : {
          kind: "credentials",
          text: `The designer could not reach a model: ${sentence(said)} Set ANTHROPIC_API_KEY, or the settings for Bedrock, Vertex AI or Foundry, in the host's environment, then ask again. ${UNCHANGED} ${BY_HAND}`,
        };
  }
  const why = said === "" ? "The designer could not answer." : `The designer could not answer: ${sentence(said)}`;
  return { kind: "other", text: `${why} ${UNCHANGED} Ask again, or ${BY_HAND.charAt(0).toLowerCase()}${BY_HAND.slice(1)}` };
}

/**
 * A problem the host attached to an answer, as a person reads it. The host's words stay what is sent back to the designer on the next
 * turn (it reads them to fix its answer); this is only what is shown. An answer with no proposal is not a fault, only a fact about the
 * answer: the designer may just have replied in words, so it is a note and not a problem.
 */
export function readProblem(problem: string): { text: string; fault: boolean } {
  if (/no parseable whole-config block or patch/i.test(problem)) return { text: "This answer proposes no change to your draft.", fault: false };
  if (/used a patch, but there is no current draft/i.test(problem)) {
    return { text: "The designer answered with a change it could not apply, because there is no draft to apply it to. Ask again.", fault: true };
  }
  const patch = /^the patch could not be applied: (.*)$/i.exec(problem);
  if (patch) return { text: `The designer's change could not be applied to your draft: ${sentence(patch[1]!.trim())} Ask again.`, fault: true };
  return { text: problem, fault: true };
}
