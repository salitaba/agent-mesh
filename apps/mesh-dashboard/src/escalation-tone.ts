/* ---------------------------------------------------------------------- *
 * Blocking vs. advisory wording for an escalation card.
 *
 * An escalation carrying `advisory: true` is a notice, not a stop. The flag is
 * what holds it out of the live mission verdict (protocol/catalog.ts) and out
 * of the termination check, so the mission runs on whether or not a human ever
 * answers it. Three sites raise one today: the collab watchdog, and the
 * recovery manager's two.
 *
 * Every wording arm in Escalations.tsx was written for the blocking case,
 * which is the common one, and several say so in prose — truthfully there, and
 * falsely on an advisory card, where the operator was being told the mission
 * was paused while nothing was paused at all.
 *
 * The fix is not per-arm. The sentences that are only true of a blocking card
 * live here, the arms build from them, and the swap happens once on the way
 * out. That way the coupling is a shared constant rather than a shape an arm
 * can be reworded out of, and an advisory reason added later inherits honest
 * wording instead of a pause claim nobody remembered to qualify.
 *
 * DOM-free and React-free on purpose: it is the one part of the card that
 * carries a correctness claim, so it lives where tests/dashboard can reach it.
 * ---------------------------------------------------------------------- */

/** True of a card that really does hold the mission. */
export const PAUSED_CLAUSE = "The mission is paused; nothing else will run until you decide.";
/** Its advisory counterpart. */
export const NOTICE_CLAUSE = "Nothing is paused — the mission is still running.";

/** The two ways an arm promises that answering restarts things. */
export const RESUMES_AND_WAKES = "Responding resumes the mission and wakes the affected agents.";
export const RESUMES = "Responding resumes the mission.";
/** What is still true on an advisory card: the wake happens, the resume does
 *  not, because nothing stopped. */
export const WAKES_ONLY = "Responding wakes the affected agents.";

export const ADVISORY_NEXT =
  "Nothing is waiting on you here: answer it if you want to change course, otherwise the mesh carries on without you.";

/** The four strings every card arm produces. Generic below so a caller may
 *  carry extra fields (the budget block) through without this module having to
 *  know about them — importing that type would drag the view in. */
export interface EscalationTone {
  title: string;
  what: string;
  next: string;
  placeholder: string;
}

/**
 * Correct a blocking-voiced card for an advisory escalation.
 *
 * `next` is prefixed rather than replaced: an arm's own guidance is usually the
 * useful part (backend_unreachable explains how to bring a backend back, and
 * that advice is just as good when nothing is blocked). Only its claim about
 * resuming is withdrawn.
 */
export function applyAdvisoryTone<T extends EscalationTone>(base: T, advisory: boolean): T {
  if (!advisory) return base;
  const next = base.next
    .split(RESUMES_AND_WAKES)
    .join(WAKES_ONLY)
    .split(RESUMES)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return {
    ...base,
    what: base.what.split(PAUSED_CLAUSE).join(NOTICE_CLAUSE),
    next: next ? `${ADVISORY_NEXT} ${next}` : ADVISORY_NEXT,
  };
}
