/**
 * Deriving acceptance criteria from a mission goal.
 *
 * Every mission's completion gate is computed from its criteria, and every
 * agent reads them on every turn, so a mission that boots with the wrong
 * criteria is a mission that is pointed at the wrong target for its whole
 * life. Before this, the only two sources were the operator's hand-written
 * `acceptance_criteria` and `DEFAULT_CRITERIA` — five fixed SDLC phases that
 * are identical for "build a payment API" and "write a haiku".
 *
 * Generation is therefore best-effort and never load-bearing: every failure
 * path here returns `null`, and the caller falls back to `DEFAULT_CRITERIA`.
 * A model that is unreachable, slow, or answers with prose must not be able
 * to stop a mission from starting.
 */

import type { DesignerPromptOptions } from "../../protocol/src/index";

/** The shape `createGoal` accepts, and what a generator must return. */
export interface GeneratedCriterion {
  id: string;
  description: string;
  mandatory: boolean;
}

/**
 * Ceiling on generated criteria. Criteria render into every agent's prompt on
 * every turn, so this is a per-turn cost multiplied by agents by turns — the
 * most expensive text in the mesh. Eight is generous for a single goal and
 * still bounded.
 */
export const MAX_GENERATED_CRITERIA = 8;

/** Below this, the model has not described the goal — assume it failed. */
const MIN_GENERATED_CRITERIA = 2;

/** Matches the schema's own limit on a hand-written criterion description. */
const MAX_DESCRIPTION_CHARS = 1000;

export const CRITERIA_SYSTEM_PROMPT = `You turn a mission goal into acceptance criteria.

Output ONLY a JSON array. No prose, no explanation, no markdown code fence.
Each element has exactly these keys:
  {"id": "<kebab-case-slug>", "description": "<one sentence>", "mandatory": true}

Rules:
- Produce between 3 and ${MAX_GENERATED_CRITERIA} criteria.
- Each criterion must be checkable against a published artifact or a command's
  output. "The code is high quality" is not checkable. "The test suite passes
  and its report is published as an artifact" is.
- Where the evidence that would satisfy a criterion is not obvious, name it in
  the description.
- Write "mandatory" as a literal true or false on EVERY element. Set it true
  only for criteria without which the goal is not met; prefer fewer mandatory
  criteria, and the mission cannot complete until every mandatory one is
  evidenced. To mark a criterion optional, write false — an omitted "mandatory"
  is read as true, so leaving the key out makes it mandatory.
- Do not invent requirements the goal does not imply. A goal that asks for a
  script does not imply a security review.
- "id" must be unique within the list.`;

/**
 * Pull a criterion list out of whatever the model actually returned.
 *
 * Models fence JSON in markdown, prefix it with "Here are the criteria:", or
 * wrap it in an object with the array under some key. Rather than pick one
 * shape and fail on the others, take the outermost bracketed span and validate
 * every element — anything malformed is dropped, and a list that loses too
 * much to be useful is reported as `null` so the caller falls back.
 */
export function parseGeneratedCriteria(text: string): GeneratedCriterion[] | null {
  if (typeof text !== "string" || !text.trim()) return null;

  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;

  const out: GeneratedCriterion[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const description = typeof rec.description === "string" ? rec.description.trim() : "";
    if (!description) continue;

    const id = slugify(typeof rec.id === "string" && rec.id.trim() ? rec.id : description);
    if (!id || seen.has(id)) continue;
    seen.add(id);

    out.push({
      id,
      description: description.slice(0, MAX_DESCRIPTION_CHARS),
      // Absent means mandatory. A criterion the model did not explicitly mark
      // optional is one it expected the mission to satisfy, and defaulting the
      // other way would silently drop requirements from the completion gate.
      mandatory: rec.mandatory === undefined ? true : rec.mandatory === true,
    });
  }

  return out.length >= MIN_GENERATED_CRITERIA ? out.slice(0, MAX_GENERATED_CRITERIA) : null;
}

/**
 * Ask the model to derive criteria for `goalText`.
 *
 * `prompt` is the one-shot, session-less call the designer already uses — the
 * generator does not need an agent identity, a bus, or a mesh session, and
 * giving it one would put a live seat's context (and cost) behind a boot step.
 *
 * `opts` is the designer's own option bag with `system` narrowed to required,
 * rather than a hand-written `{ system: string }`. The hand-written shape was
 * structurally narrower than what the adapter accepts, which silently sealed
 * off every per-call knob the designer path already supports — `model` among
 * them. Intersecting instead of re-declaring means the next knob arrives here
 * for free, and keeping `system` required preserves the old contract for
 * callers that destructure it.
 *
 * `model` is optional and, when absent, the options bag is byte-identical to
 * what this sent before: the adapter then falls back to the runtime default,
 * so an existing mesh sees no change. Because this is a one-shot — fixed
 * system prompt plus goal text, no conversation — routing it to a small model
 * forfeits no prompt-cache reuse.
 */
export async function generateAcceptanceCriteria(
  goalText: string,
  prompt: (text: string, opts: DesignerPromptOptions & { system: string }) => Promise<string>,
  model?: string,
): Promise<GeneratedCriterion[] | null> {
  const goal = goalText.trim();
  if (!goal) return null;

  const reply = await prompt(goal, {
    system: CRITERIA_SYSTEM_PROMPT,
    ...(model ? { model } : {}),
  });
  return parseGeneratedCriteria(reply);
}

/** kebab-case, bounded, and never empty — falls back to a stable prefix. */
function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return slug || "criterion";
}
