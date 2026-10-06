/* Why a person has just been sent to the Designer, and so what it should do with their first moment. DOM-free, so the rule is pinned.
 *
 * Two senders ask for it. The welcome, after it made a team: the next move is whichever step of the guide is next (the goal if there is
 * none, else describing the team). The mission's own "Write the goal first": the goal, whatever the draft says, because the mission it
 * would start still has the placeholder. A request is for one project, is taken once, and goes stale: one nobody took (the view never
 * mounted) must not move someone's cursor a day later. */

export type Arrival = "next-step" | "goal";

/** Long enough for a lazy view to load and the file to be read, short enough that an old request is not still waiting. */
export const ARRIVAL_TTL_MS = 20_000;

let pending: { project: string; want: Arrival; at: number } | null = null;

/** Ask that the Designer of `project` open on `want`. A later request replaces an earlier one. */
export function requestArrival(project: string, want: Arrival, now: number = Date.now()): void {
  pending = { project, want, at: now };
}

/** What was asked for this project, once. Another project's request, and one that has gone stale, are not taken (and a stale one is dropped). */
export function takeArrival(project: string, now: number = Date.now()): Arrival | null {
  const p = pending;
  if (!p) return null;
  if (now - p.at > ARRIVAL_TTL_MS) {
    pending = null;
    return null;
  }
  if (p.project !== project) return null;
  pending = null;
  return p.want;
}
