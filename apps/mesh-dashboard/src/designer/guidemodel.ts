/* Where a person is in setting up a team, and what each step of the guide says about it. DOM-free, so the order of the steps and the words
 * a person is led by are pinned. The guide is the first thing a new project shows, and "what do I do now?" is the only question it answers. */

import { goalIsPlaceholder } from "../goal";

export type StepKey = "goal" | "seats" | "wires" | "save";

export type StepState = "done" | "now" | "next";

export interface Step {
  key: StepKey;
  state: StepState;
}

export interface Progress {
  steps: Step[];
  /** The one thing to do now: the first step that is not done. Saving is last, and the person's own act, so it is never done here. */
  now: StepKey;
}

/**
 * Which steps are done and which is next. A goal is done when it is written (not the placeholder), the seats when there are two (one is a
 * valid mesh, but a lone seat has nobody to talk to, so the guide's next move for it is the team), the wires when two seats may message
 * each other. Steps are judged on their own, so a team the assistant proposed before the goal was written reads goal "now", seats and
 * wires "done".
 */
export function guideProgress(input: { goal: unknown; seats: number; wires: number }): Progress {
  const done: Record<StepKey, boolean> = {
    goal: !goalIsPlaceholder(input.goal),
    seats: input.seats >= 2,
    wires: input.seats >= 2 && input.wires > 0,
    save: false,
  };
  const order: StepKey[] = ["goal", "seats", "wires", "save"];
  const now = order.find((k) => !done[k]) ?? "save";
  return { steps: order.map((key) => ({ key, state: done[key] ? "done" : key === now ? "now" : "next" })), now };
}

/** The line under "Add the seats that do the work": how many there are, and what to do about it. */
export function seatsText(seats: number): string {
  if (seats >= 2) return `There are ${seats} seats. Give each a role, the tools it may use and what it may decide alone.`;
  const have = seats === 0 ? "There are no seats yet." : "There is one seat.";
  return `${have} Describe the team to the designer and review what it proposes, or add a seat yourself. One seat is a valid mesh, so stop here if that is the team you want.`;
}
