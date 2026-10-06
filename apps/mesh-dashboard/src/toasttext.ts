/**
 * What a notice in the corner says when something happens on the log. DOM-free, so the wording can be tested.
 *
 * These used to be the event's own fields set in lower case ("escalation opened: budget_exhausted (by explorer)", "budget exceeded:
 * mission:goal-M44MV2BS003f3a104bda"): a code and an internal key where a person needed a sentence. They now say what happened in the
 * words the cards use (`verdictText`), and say what is held: a decision that holds the mission is not the same news as one that holds a
 * seat. A budget running out is not announced twice: the decision it raises already says so.
 */
import { verdictText } from "../../../packages/protocol/src/catalog";
import { holdsOf, type EscalationLike } from "./escalation-card";
import type { View } from "./route";

export type ToastKind = "ok" | "warn" | "bad";

export interface ToastText {
  title: string;
  msg: string;
  kind: ToastKind;
}

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** How a ledger key is said: `mission:goal-1`, `agent:goal-1/developer`, `thread:t-9`. */
export function budgetName(key: unknown): string {
  const k = text(key);
  if (k.startsWith("mission:")) return "The mission's token budget";
  const agent = /^agent:[^/]*\/(.+)$/.exec(k);
  if (agent) return `${agent[1]}'s token budget`;
  if (k.startsWith("thread:")) return "A conversation thread's token budget";
  return "A token budget";
}

/** The notice an event earns, or null when it earns none (most events, and a budget that is announced by its decision). */
export function eventToast(e: { type: string; payload?: unknown }): ToastText | null {
  const p = (e.payload && typeof e.payload === "object" ? e.payload : {}) as Record<string, unknown>;
  switch (e.type) {
    case "goal.completed":
      return { title: "Mission delivered", msg: "Every mandatory check is evidenced.", kind: "ok" };
    // `goal.escalated` arrives with the decision that escalated it, and that decision's notice already says the mission is paused.
    case "goal.escalated":
      return null;
    case "goal.failed": {
      const reason = text(p.reason);
      return { title: "The mission failed", msg: reason ? verdictText(reason).title : "Open the events to see why.", kind: "bad" };
    }
    case "escalation.requested": {
      const esc = (p.escalation && typeof p.escalation === "object" ? p.escalation : {}) as EscalationLike;
      const what = verdictText(text(esc.reason)).title;
      const holds = holdsOf(esc);
      if (holds.scope === "nothing") return { title: "A notice", msg: what, kind: "warn" };
      if (holds.scope === "seat") return { title: "A decision is waiting on you", msg: `${what}. It holds ${holds.seat} only.`, kind: "warn" };
      return { title: "A decision is waiting on you", msg: `${what}. The mission is paused.`, kind: "bad" };
    }
    case "agent.failed": {
      const who = text(p.agentId) || "An agent";
      const err = text(p.error).slice(0, 90);
      return { title: "Agent failed", msg: err ? `${who}: ${err}` : `${who} failed.`, kind: "bad" };
    }
    case "budget.exceeded": {
      const key = text(p.key);
      // The mission's and a seat's budget each raise a decision in the same breath, and the decision says it.
      if (key.startsWith("mission:") || key.startsWith("agent:")) return null;
      return { title: "Token budget used up", msg: `${budgetName(key)} is spent.`, kind: "warn" };
    }
    default:
      return null;
  }
}

/**
 * The page that already shows, first and in full, what an event's notice would say, or null. On that page the notice is not
 * raised, and one already up is taken down when the person arrives there. "A decision is waiting on you" used to stack over the
 * Needs you page itself, on a phone right over the card's "Send answer and resume"; "Mission delivered" repeated the Overview's
 * headline word for word.
 *
 * Only those two. A failed agent's card on Agents shows its last step's error, which need not be the one the event carries, and
 * no page shows a conversation thread's budget.
 */
export function pageShowing(type: string): View | null {
  switch (type) {
    case "escalation.requested":
      return "escalations";
    case "goal.completed":
    case "goal.failed":
      return "overview";
    default:
      return null;
  }
}

/**
 * How long a notice stays up, in ms. Long enough to read and short enough not to sit on the page: a few seconds, a failure a little
 * longer. One with a button (Undo, Redo) stays about twice as long, because noticing it, aiming at it and pressing it takes longer
 * than reading it, and a button that leaves first is worse than none.
 */
export function toastLife(kind: string, actionable: boolean): number {
  if (actionable) return 10_000;
  return kind === "bad" ? 7_600 : 4_800;
}
