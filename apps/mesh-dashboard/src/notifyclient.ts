/**
 * The browser's side of desktop notifications: asking for permission, remembering the choice, showing one, taking it down.
 * What is decided lives in notify.ts (the switch) and attention.ts (when one is raised), which node:test covers; this is the part
 * that needs a `window`.
 *
 * Nothing here sends anything anywhere. A notification is shown by this page, to this browser, while the page is open: no service
 * worker, no push subscription, no request. Failing quietly would leave a switch that does nothing, so a browser that has a
 * `Notification` but will not construct one from a page is recorded as unable, and the control says so.
 */
import { NOTIFY_KEY, choiceValue, notifyEnabled, notifyState, parseChoice, type NotifyEnv, type NotifyPermission, type NotifyPress, type NotifyState } from "./notify";
import type { Notice } from "./attention";
import type { View } from "./route";

const readChoice = (): boolean => {
  try {
    return parseChoice(localStorage.getItem(NOTIFY_KEY));
  } catch {
    // Blocked or private storage: the choice holds for this visit only. It is a convenience, never a precondition.
    return false;
  }
};

let chosen = readChoice();
/** The browser has a Notification but would not construct one from a page (Chrome on Android shows them only from a service worker). */
let unable = false;
const subscribers = new Set<() => void>();
const emit = (): void => subscribers.forEach((f) => f());

function writeChoice(on: boolean): void {
  chosen = on;
  try {
    localStorage.setItem(NOTIFY_KEY, choiceValue(on));
  } catch {
    /* kept for this visit only */
  }
  emit();
}

export function notifyEnv(): NotifyEnv {
  const api = !unable && typeof Notification === "function";
  return { api, secure: window.isSecureContext !== false, permission: api ? (Notification.permission as NotifyPermission) : "denied" };
}

export const notifyStateNow = (): NotifyState => notifyState(notifyEnv(), chosen);
export const notificationsOn = (): boolean => notifyEnabled(notifyEnv(), chosen);
/** A string, so useSyncExternalStore sees a change only when the state is different. */
export const notifySnapshot = (): string => JSON.stringify(notifyStateNow());

export function subscribeNotify(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/** Whether the person can see the page. A hidden page is the only one a notification is for. */
export const pageHidden = (): boolean => document.visibilityState === "hidden";

const raised = new Set<Notification>();

/** The person is looking again: what was raised for them has done its job, and a stale one in the notification centre is clutter. */
function takeDownRaised(): void {
  for (const n of raised) n.close();
  raised.clear();
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    takeDownRaised();
    // The site's permission may have been changed in the browser's own settings while the page was away.
    emit();
  });
  // The choice is per host, so another tab of this console that turns it on or off is heard.
  window.addEventListener("storage", (e) => {
    if (e.key !== NOTIFY_KEY) return;
    chosen = parseChoice(e.newValue);
    emit();
  });
}

/** The browser's answer to the request: a promise in new browsers, a callback in old ones. A prompt closed unanswered is "default". */
function requestPermission(): Promise<NotifyPermission> {
  return new Promise((resolve) => {
    try {
      const result = Notification.requestPermission((p) => resolve(p as NotifyPermission));
      if (result && typeof result.then === "function") result.then((p) => resolve(p as NotifyPermission), () => resolve("default"));
    } catch {
      resolve("default");
    }
  });
}

/**
 * What pressing the control does, and what the browser then says. It is called from the person's click and the request is the
 * first thing it does: a browser shows its permission prompt only for a gesture.
 */
export async function pressNotify(press: NotifyPress): Promise<NotifyPermission> {
  if (press === "turn-off") {
    writeChoice(false);
    return notifyEnv().permission;
  }
  if (press === "explain") return notifyEnv().permission;
  const answer = notifyEnv().permission === "default" ? await requestPermission() : notifyEnv().permission;
  if (answer === "granted") writeChoice(true);
  else emit();
  return answer;
}

/** Shows one, and sends a click on it to the right page of this console. */
export function raiseNotice(n: Notice, open: (view: View) => void): void {
  try {
    const options: NotificationOptions & { renotify?: boolean } = { body: n.body, tag: n.tag };
    if (n.renotify) options.renotify = true;
    const note = new Notification(n.title, options);
    raised.add(note);
    note.onclick = () => {
      window.focus();
      open(n.goTo);
      note.close();
    };
    note.onclose = () => {
      raised.delete(note);
    };
  } catch {
    unable = true;
    writeChoice(false);
  }
}
