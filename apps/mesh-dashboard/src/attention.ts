/**
 * What there is to tell a person who is not looking at the console, and when.
 *
 * A mission takes minutes to hours and nobody watches it: they start it and go to another tab, another window or another
 * device. Three moments are worth reaching them for. A decision starts to wait, and the mission is paused until they answer, so
 * every minute they do not know is a minute lost. The mission is delivered. The mission stops for a reason that is not theirs
 * (it failed, the host's spend ceiling parked it, its process crashed). A pause they pressed themselves, a project they
 * closed, and a mission that is simply running are not news.
 *
 * Everything here is a decision over plain values and none of it touches the page, so tests/dashboard can pin each one: the
 * one reading of the mission that the tab's icon is drawn from (`attentionOf`), and, further down, when to raise a notification.
 * mission.ts has already decided what state the mission is in; this only asks which of those states is news.
 */
import type { MissionPhase, MissionTone } from "./mission";
import type { FaviconKind } from "./favicon";

/** What there is to tell. `none` is a mission that is running, paused, parked, idle or closed: nothing to tell. */
export type AttentionKind = "none" | "needs-you" | "delivered" | "stopped";

export interface AttentionInput {
  phase: MissionPhase;
  tone: MissionTone;
  /** The status chip's word (mission.ts), for the title of a notice. */
  label: string;
  /** The mission's own sentence for this state (mission.ts), so a notice says what the page says. */
  headline: string;
  /** The decisions that hold the mission or a seat, by id: the ones a person has to answer. A notice that holds nothing is not one. */
  decisionIds: readonly string[];
  /** What each of those is about, phrased, longest-waiting first. */
  decisionTitles: readonly string[];
  /** Why a failed mission stopped, in a sentence, when the log says. */
  reason: string | null;
  goalId: string | null;
  /** When the goal was completed: a mission reopened and delivered again is news again, so a delivery is told apart by its stamp. */
  deliveredAt: string | null;
  /** Null on a server that runs one mesh and has no projects. */
  projectId: string | null;
  projectName: string | null;
}

/** The mission at one moment, as far as telling anyone goes. */
export interface Attention {
  kind: AttentionKind;
  /**
   * What this moment is made of. Two moments of one kind are the same news when their keys are the same: a decision is told by its
   * id, a delivery by the goal and its completion stamp, a stop by the goal (or the project and what happened to it).
   */
  keys: readonly string[];
  label: string;
  headline: string;
  titles: readonly string[];
  reason: string | null;
  /** What a notice's tag is scoped to: one per project, so a newer notice replaces the older one instead of stacking. */
  scope: string;
  project: string | null;
}

/**
 * The mission, read for attention. Null when the mission cannot be read right now (the server is not answering, the project is
 * still starting): that is not "nothing to tell", it is "not known", and the caller keeps the last moment it did know. Reading
 * it as nothing would make the same waiting decision look new when the server comes back.
 */
export function attentionOf(i: AttentionInput): Attention | null {
  if (i.phase === "loading" || i.phase === "offline") return null;
  const base = { label: i.label, headline: i.headline, titles: i.decisionTitles, reason: i.reason, scope: i.projectId ?? "mesh", project: i.projectName };
  const goal = i.goalId ?? "";
  switch (i.phase) {
    case "needs-you":
      // A goal that is ESCALATED with no card to answer is still a mission waiting on a person: it is told by its goal.
      return { ...base, kind: "needs-you", keys: i.decisionIds.length ? [...i.decisionIds].sort() : [`halt:${goal}`] };
    case "done":
      return { ...base, kind: "delivered", keys: [`delivered:${goal}:${i.deliveredAt ?? ""}`] };
    case "failed":
      return { ...base, kind: "stopped", keys: [`failed:${goal}`] };
    case "ceiling":
      return { ...base, kind: "stopped", keys: [`ceiling:${goal}`] };
    case "down":
      // A project that crashed, is locked or cannot open is a stop. One the person closed is not.
      return i.tone === "bad" ? { ...base, kind: "stopped", keys: [`down:${i.projectId ?? ""}:${i.label}`] } : { ...base, kind: "none", keys: [] };
    default:
      return { ...base, kind: "none", keys: [] };
  }
}

/** Which icon the tab wears. A mission that cannot be read right now keeps the plain one: no badge claims what is not known. */
export function faviconFor(a: Attention | null): FaviconKind {
  return !a || a.kind === "none" ? "plain" : a.kind;
}
