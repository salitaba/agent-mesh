/**
 * The goal of a mission, as far as the console can tell a written one from the scaffold's. DOM-free and import-free (see route.ts), so
 * the welcome, the Designer, the top bar and the Start dialog all read one answer instead of each keeping its own copy of the
 * placeholder's text.
 *
 * A new project starts with a placeholder goal unless the person gave one with the team (the host writes it into mesh.yaml before the
 * project first starts). A mission started on the placeholder spends on work nobody described, so the console asks for the goal first.
 */

/** What `curule init` and the Triad template write as a goal. A mesh that still says this has no goal yet, and the Designer says so. */
export const GOAL_PLACEHOLDER = "Describe the mission goal here.";

/** The longest goal the schema accepts (`mesh.goal.maxLength`), and the longest the host will write for a new team. */
export const GOAL_MAX = 2000;

/** True for an empty goal and for the scaffold's own placeholder. */
export const goalIsPlaceholder = (goal: unknown): boolean => {
  const g = typeof goal === "string" ? goal.trim() : "";
  return g === "" || g === GOAL_PLACEHOLDER;
};

/**
 * Whether a mission's goal is one a person wrote. A goal the console has no text for (a status that is still loading) is not a reason
 * to nag, so only text that is blank or the placeholder says no.
 */
export const goalIsSet = (goal: unknown): boolean => typeof goal !== "string" || !goalIsPlaceholder(goal);

/**
 * Whether Start is not offered because the goal is not written: a mission that has never run, on a goal nobody wrote. One that has run keeps
 * what it has (Continue is not Start), and a status with no goal text says nothing either way.
 */
export const startNeedsGoal = (f: { goalWritten?: boolean; hasHistory: boolean }): boolean => f.goalWritten === false && !f.hasHistory;

/** The goal a person is typing for a new team: whether it may be sent, and what is wrong when it is too long. Blank is not wrong, just not ready. */
export function goalDraft(text: string): { ready: boolean; problem: string | null; count: number } {
  const count = text.trim().length;
  if (count > GOAL_MAX) {
    return { ready: false, count, problem: `The goal is ${count.toLocaleString("en-US")} characters, and the most a goal can be is ${GOAL_MAX.toLocaleString("en-US")}. Shorten it.` };
  }
  return { ready: count > 0, problem: null, count };
}

/** A generic way to begin a goal: what it delivers, and a way to tell it is done. Each is a complete sentence the person goes on from. */
export interface GoalExample {
  id: string;
  /** The chip's label. */
  label: string;
  text: string;
}

export const GOAL_EXAMPLES: readonly GoalExample[] = [
  { id: "tool", label: "A small tool, with tests", text: "Build a small tool and write tests that show it works. Explain how to run it." },
  { id: "report", label: "A written report, with sources", text: "Write a short report and list the sources it relies on." },
  { id: "review", label: "A review of a code base", text: "Review a code base and write up the problems you find, most serious first." },
];

/**
 * The text after an example is picked. An empty field, or one that holds only an example's sentence from an earlier pick, takes the new
 * one in its place; anything the person wrote is kept and the example goes on a line under it, because losing what was typed to a
 * chip would be the worst thing a suggestion could do.
 */
export function withExample(current: string, example: GoalExample): string {
  const now = current.trim();
  if (now === "" || GOAL_EXAMPLES.some((e) => e.text === now)) return example.text;
  return `${current.trimEnd()}\n${example.text}`;
}
