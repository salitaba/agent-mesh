/**
 * What a confirmation says about cost. DOM-free, so the wording can be tested.
 *
 * "Agents run and spend tokens" is true for a real runtime and false for the stub one, which is the shipped demo: it makes no
 * model call. The first dialog a visitor meets on the first thing they try must not warn them off a bill that cannot come.
 * The server reports the runtimes the seats run on; a server that predates the field, or says nothing, is read as spending,
 * which is the claim that is safe to be wrong about.
 */

export interface SpendFacts {
  runtimes?: unknown;
  agents?: Array<{ id: string; lifecycle: string }>;
}

/** Whether any seat can spend tokens: false only when every runtime named is the stub. */
export function spendsTokens(status: SpendFacts | null | undefined): boolean {
  const runtimes = status?.runtimes;
  if (!Array.isArray(runtimes) || runtimes.length === 0) return true;
  return runtimes.some((r) => r !== "stub");
}

/** The seats a start or a resume would wake, as many as a sentence can name. */
export function agentsToWake(status: SpendFacts | null | undefined): string[] {
  return (status?.agents ?? [])
    .filter((a) => a.id !== "human" && ["WAITING", "SUSPENDED", "IDLE"].includes(a.lifecycle))
    .map((a) => a.id)
    .slice(0, 4);
}

/** What the "Start the mission?" dialog tells the person: who wakes, and whether that costs anything. */
export function startConfirmBody(status: SpendFacts | null | undefined): string[] {
  const names = agentsToWake(status);
  const body = [
    spendsTokens(status)
      ? "Agents run and spend tokens until you park the mission again."
      : "This is a scripted team. It makes no model calls and spends nothing, and it runs until it finishes or you park the mission.",
  ];
  if (names.length) body.unshift(`${names.join(", ")} will be woken.`);
  return body;
}

/** What resuming a paused mission says, or null when nothing is asleep and there is nothing to ask. */
export function resumeConfirmBody(status: SpendFacts | null | undefined): string[] | null {
  const names = agentsToWake(status);
  if (!names.length) return null;
  return [spendsTokens(status) ? `This wakes ${names.join(", ")} and resumes spend against the mission budget.` : `This wakes ${names.join(", ")}. It is a scripted team, so nothing is spent.`];
}
