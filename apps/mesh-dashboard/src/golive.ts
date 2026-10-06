/**
 * What the Start dialog says, and what the notice says after Start (or Continue) is pressed. DOM-free, so the wording can be tested.
 *
 * A 200 means the scheduler started, not that anyone is working, so the notice is read off the counts the route reports and never
 * asserted: "agents are running" over a mission whose every startup seat was refused is the toast that was behind "I clicked
 * Continue and the mesh did not start". When nobody started, the server's `note` says whether the seats were blocked or never
 * configured, so the title does not have to.
 */

/** Why Start is not offered, as the dialog that says so: what is wrong, what the button does, and nothing about starting. */
export interface StartBlock {
  kind: "goal";
  title: string;
  body: string[];
  confirmLabel: string;
  cancelLabel: string;
}

const NOT_NOW = "Not now";

/**
 * Whether pressing Start should say something else first, and what. Anything else starts as it always has, with the question that names
 * the agents and the cost.
 */
export function startBlock(input: { needsGoal: boolean }): StartBlock | null {
  if (input.needsGoal) {
    return {
      kind: "goal",
      title: "Write the goal first",
      body: [
        "The goal is still the placeholder. Every agent reads the goal on every turn, so a mission started now would work towards a goal that says nothing.",
        "Write what the team should deliver in the Designer, then start the mission.",
      ],
      confirmLabel: "Write the goal",
      cancelLabel: NOT_NOW,
    };
  }
  return null;
}

export interface GoLiveReply {
  started?: unknown;
  activated?: unknown;
  refused?: unknown;
  note?: unknown;
  error?: unknown;
}

export interface GoLiveNotice {
  title: string;
  msg: string;
  kind: "ok" | "warn" | "bad";
}

const says = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const listOf = (items: string[]): string => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

export function goLiveNotice(http: number, json: GoLiveReply | null | undefined): GoLiveNotice {
  const note = says(json?.note);
  if (http !== 200) return { title: "Could not start the mission", msg: says(json?.error) || note || "The server refused the request.", kind: "bad" };
  if (json?.started === false) return { title: "Already running", msg: note || "The scheduler was already on.", kind: "ok" };
  const started = Array.isArray(json?.activated) ? json.activated.filter((s): s is string => typeof s === "string") : [];
  const blocked = Array.isArray(json?.refused) ? json.refused.length : 0;
  if (started.length === 0) {
    return {
      title: "The scheduler is on, but no agent started",
      msg: note || "No seat is set to start on its own, or each was refused. Wake an agent from Agents.",
      kind: "bad",
    };
  }
  if (blocked > 0) return { title: `Running, with ${blocked} agent${blocked > 1 ? "s" : ""} blocked`, msg: note, kind: "warn" };
  return { title: "Agents are running", msg: `${listOf(started)} ${started.length === 1 ? "is" : "are"} starting.`, kind: "ok" };
}
