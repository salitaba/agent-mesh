/**
 * The switch for desktop notifications, as plain decisions: whether this browser can show them, what the control says in each
 * state, and how the choice is kept. The browser's side of it (asking, showing, remembering) is notifyclient.ts; attention.ts
 * decides when one is raised. DOM-free, so tests/dashboard can pin the words, which carry the claim.
 *
 * What is promised is small, and it is said where the person decides. A notification is shown by this page, while it is open in a
 * browser tab: closing the tab ends it, a browser that puts a background tab to sleep (phones do, quickly) cannot show it, and
 * nothing is sent to anyone else. There is no service worker, no push message, no e-mail and no request: that is why it stays true.
 */

export type NotifyPermission = "default" | "granted" | "denied";

/** What the browser says about notifications. */
export interface NotifyEnv {
  /** There is a `Notification` to ask, and a page may construct one. */
  api: boolean;
  /** A browser allows notifications only on a secure address: https, or localhost. */
  secure: boolean;
  permission: NotifyPermission;
}

export type NotifyState =
  /** Not something this browser or this address can do. Says why, and what still tells the person. */
  | { kind: "unavailable"; why: string }
  /** The browser refuses, and only its settings can change that. */
  | { kind: "blocked" }
  /** Possible, and not asked for (or asked for and declined). */
  | { kind: "off" }
  /** Asked for, and the browser allows it. */
  | { kind: "on" };

/** What is still true when notifications are not: the tab says it. */
const ICON_STILL_SAYS = "The tab's icon and title still show when something needs you.";

export function notifyState(env: NotifyEnv, chosen: boolean): NotifyState {
  if (!env.api) return { kind: "unavailable", why: `This browser cannot show notifications from a web page. ${ICON_STILL_SAYS}` };
  if (!env.secure) {
    return { kind: "unavailable", why: `A browser allows notifications only on a secure address (https, or localhost), and this console is open over plain http. ${ICON_STILL_SAYS}` };
  }
  if (env.permission === "denied") return { kind: "blocked" };
  return env.permission === "granted" && chosen ? { kind: "on" } : { kind: "off" };
}

/** Whether a notification may be raised right now: asked for, allowed, and possible. The page's visibility is attention.ts's. */
export const notifyEnabled = (env: NotifyEnv, chosen: boolean): boolean => notifyState(env, chosen).kind === "on";

/** What pressing the control does. `explain` is for a blocked browser: there is nothing to turn on, but there is something to say. */
export type NotifyPress = "turn-on" | "turn-off" | "explain";

export interface NotifyView {
  /** The control's words: what pressing it does. */
  label: string;
  /**
   * One short line beside it on a page: what it is not. It is short on purpose: the person who opens the Needs you page on a phone
   * is there to answer a decision, and the control is not to push the decision off the screen.
   */
  note: string;
  /** The whole of it, for a tooltip, a menu entry and the answer to a press that cannot turn it on. */
  hint: string;
  press: NotifyPress | null;
}

const TURN_ON = "Notify me when the mission needs me";
const WHEN = "when a decision starts to wait for you, when the mission is delivered and when it stops on its own";
/** What it is not, said where the person decides and not in a settings page: the whole of it is in the hint and the answer to a press. */
const WORKS_WHILE_OPEN = "It works while this page is open in a browser tab. Nothing is sent to anyone else, and nothing reaches you once the tab is closed.";

export function notifyView(s: NotifyState): NotifyView {
  switch (s.kind) {
    case "unavailable":
      return { label: TURN_ON, note: s.why, hint: s.why, press: null };
    case "blocked": {
      const blocked = "Your browser is blocking notifications from this address. Allow them for this address in the browser's site settings, then turn this on.";
      return { label: TURN_ON, note: blocked, hint: blocked, press: "explain" };
    }
    case "on":
      return {
        label: "Stop notifying me",
        note: "On. Works only while this page is open in a browser tab.",
        hint: `On: this browser shows a notification ${WHEN}. ${WORKS_WHILE_OPEN} Only the project open in this tab is covered.`,
        press: "turn-off",
      };
    default:
      return {
        label: TURN_ON,
        note: "Works only while this page is open in a browser tab.",
        hint: `A desktop notification ${WHEN}. ${WORKS_WHILE_OPEN} Only the project open in this tab is covered.`,
        press: "turn-on",
      };
  }
}

/** What the person is told after pressing it. `answer` is what the browser said to the request, when there was one. */
export function notifyAnswer(press: NotifyPress, answer: NotifyPermission): { title: string; msg: string; kind: "ok" | "warn" } {
  if (press === "turn-off") return { title: "Notifications are off", msg: `This browser will not call you back. ${ICON_STILL_SAYS}`, kind: "ok" };
  if (answer === "granted") {
    return { title: "Notifications are on", msg: `You will get one ${WHEN}, while this page is open in a browser tab. Nothing is sent to anyone else.`, kind: "ok" };
  }
  if (answer === "denied") {
    return { title: "Notifications are blocked", msg: "Your browser did not allow them. Allow notifications for this address in its site settings, then turn this on.", kind: "warn" };
  }
  return { title: "Notifications are still off", msg: "The browser was not given an answer, so nothing was turned on. Try again when you are ready.", kind: "warn" };
}

/** The choice is kept per host, in the browser's own storage, as one word. Anything else, or nothing, is off. */
export const NOTIFY_KEY = "curule-notify";
export const parseChoice = (raw: string | null | undefined): boolean => raw === "on";
export const choiceValue = (on: boolean): string => (on ? "on" : "off");
