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
 * one reading of the mission that the tab's icon is drawn from (`attentionOf`), and, further down, when to raise a notification
 * and what it says. mission.ts has already decided what state the mission is in; this only asks which of those states is news.
 */
import type { MissionPhase, MissionTone } from "./mission";
import type { FaviconKind } from "./favicon";
import type { View } from "./route";

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

/* ------------------------------------------------------------------------- */
/* The notification                                                           */
/* ------------------------------------------------------------------------- */

/** What a desktop notification says, and where a click on it goes. */
export interface Notice {
  /**
   * One per project and kind, so a newer notice replaces the older one on screen instead of stacking under it: three decisions that
   * arrive in a minute are one notice that says "3 decisions", not three.
   */
  tag: string;
  title: string;
  body: string;
  /** The page a click goes to: the decision, or the mission's own summary. */
  goTo: View;
  /** A newer decision replaces the standing notice and sounds again; a delivery and a stop are told once. */
  renotify: boolean;
}

const list = (items: readonly string[]): string => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

/** The notice's body leaves out what its title already says: "Delivered. Every mandatory check is evidenced." under "Delivered". */
const withoutLabel = (headline: string, label: string): string => (headline.startsWith(`${label}. `) ? headline.slice(label.length + 2) : headline);

/**
 * What the notice says is what the page says: the mission's own sentence (mission.ts), then, for a decision, what is waiting in
 * the cards' own words. No ids, no codes, no exclamation marks.
 */
function noticeOf(a: Attention): Notice {
  const title = a.project ? `${a.label} · ${a.project}` : a.label;
  const tag = `curule:${a.kind}:${a.scope}`;
  switch (a.kind) {
    case "needs-you": {
      const shown = a.titles.slice(0, 2);
      const more = a.titles.length - shown.length;
      const waiting = shown.length ? ` Waiting: ${list(shown)}${more > 0 ? `, and ${more} more` : ""}.` : "";
      return { tag, title, body: `${a.headline}${waiting}`, goTo: "escalations", renotify: true };
    }
    case "delivered":
      return { tag, title, body: withoutLabel(a.headline, a.label), goTo: "overview", renotify: false };
    default:
      return { tag, title, body: a.reason ?? a.headline, goTo: "overview", renotify: false };
  }
}

/**
 * The notification to raise now, or null. It is raised for the three moments `attentionOf` calls news, once each, and only when
 * all of these hold:
 *
 * - the person has asked for notifications (`enabled`), and the page is hidden: a page in view says it itself, and a notice laid
 *   over a page someone is reading is noise;
 * - the moment is new. The first thing the page ever reads (`previous` is null) is what it opened on, not something that happened;
 *   the same moment seen again is not new (a decision is told once, by its id, however often the status is read); a moment of the
 *   same kind with a new key is (a second decision, a mission delivered again).
 *
 * A pause the person pressed is `none`, so it never notifies. A mission that cannot be read right now (`next` is null) never does.
 */
export function notificationFor(previous: Attention | null, next: Attention | null, hidden: boolean, enabled: boolean): Notice | null {
  if (!enabled || !hidden || !previous || !next || next.kind === "none") return null;
  const fresh = previous.kind === next.kind ? next.keys.filter((k) => !previous.keys.includes(k)) : next.keys;
  return fresh.length ? noticeOf(next) : null;
}

/**
 * One step of watching a mission: what was last known and what is known now, to what is last known from here on and the notice,
 * if any. A moment that cannot be read (the server is not answering, the project is starting) changes nothing, so a decision that
 * was waiting before the server blinked is the same decision when it comes back, and does not notify twice.
 */
export function advance(last: Attention | null, next: Attention | null, hidden: boolean, enabled: boolean): { last: Attention | null; notice: Notice | null } {
  if (next === null) return { last, notice: null };
  return { last: next, notice: notificationFor(last, next, hidden, enabled) };
}
