import test from "node:test";
import assert from "node:assert/strict";

import { NOTIFY_KEY, choiceValue, notifyAnswer, notifyEnabled, notifyState, notifyView, parseChoice, type NotifyEnv, type NotifyState } from "../../apps/mesh-dashboard/src/notify";

/**
 * The switch for desktop notifications says what it is and what it is not, where the person decides. These pin the states it can
 * be in, the words of each, and that none of those words promises more than a page in a browser tab can do.
 */

const env = (over: Partial<NotifyEnv> = {}): NotifyEnv => ({ api: true, secure: true, permission: "default", ...over });

test("a browser with no Notification, and a console on a plain http address, cannot; the first reason wins", () => {
  assert.equal(notifyState(env({ api: false }), true).kind, "unavailable");
  assert.equal(notifyState(env({ secure: false }), true).kind, "unavailable");
  const both = notifyState(env({ api: false, secure: false }), false);
  assert.ok(both.kind === "unavailable" && /cannot show notifications from a web page/.test(both.why));
  const http = notifyState(env({ secure: false }), false);
  assert.ok(http.kind === "unavailable" && /secure address \(https, or localhost\).*plain http/.test(http.why));
});

test("a browser that refuses is blocked, whatever was chosen before", () => {
  assert.deepEqual(notifyState(env({ permission: "denied" }), true), { kind: "blocked" });
  assert.deepEqual(notifyState(env({ permission: "denied" }), false), { kind: "blocked" });
});

test("it is on only when it was asked for and the browser allows it", () => {
  assert.deepEqual(notifyState(env({ permission: "granted" }), true), { kind: "on" });
  assert.deepEqual(notifyState(env({ permission: "granted" }), false), { kind: "off" }, "allowed once, not asked for now");
  assert.deepEqual(notifyState(env({ permission: "default" }), true), { kind: "off" }, "a remembered choice the browser no longer backs");
  assert.deepEqual(notifyState(env(), false), { kind: "off" });
});

test("a notification may be raised only in the on state", () => {
  assert.equal(notifyEnabled(env({ permission: "granted" }), true), true);
  for (const [e, chosen] of [[env({ permission: "granted" }), false], [env(), true], [env({ permission: "denied" }), true], [env({ api: false }), true], [env({ secure: false, permission: "granted" }), true]] as const) {
    assert.equal(notifyEnabled(e, chosen), false);
  }
});

test("each state offers the press that fits it, and an unavailable one offers none", () => {
  const press = (s: NotifyState): string | null => notifyView(s).press;
  assert.equal(press({ kind: "off" }), "turn-on");
  assert.equal(press({ kind: "on" }), "turn-off");
  assert.equal(press({ kind: "blocked" }), "explain");
  assert.equal(press({ kind: "unavailable", why: "x" }), null);
  assert.equal(notifyView({ kind: "off" }).label, "Notify me when the mission needs me");
  assert.equal(notifyView({ kind: "on" }).label, "Stop notifying me", "the label says what pressing it does");
});

test("what it is and what it is not is said where the person decides: a short line on the page, the whole of it in the hint", () => {
  for (const kind of ["off", "on"] as const) {
    const v = notifyView({ kind });
    assert.match(v.note, /Works only while this page is open in a browser tab\./);
    assert.ok(v.note.length <= 60, `the line on the page stays one line on a phone (${v.note.length} characters)`);
    assert.match(v.hint, /It works while this page is open in a browser tab\./);
    assert.match(v.hint, /Nothing is sent to anyone else/);
    assert.match(v.hint, /nothing reaches you once the tab is closed/);
    assert.match(v.hint, /when a decision starts to wait for you, when the mission is delivered and when it stops on its own/);
    assert.match(v.hint, /Only the project open in this tab is covered/);
  }
});

test("a blocked browser is told where to change it, and an unavailable one that the tab still says it", () => {
  assert.match(notifyView({ kind: "blocked" }).note, /Allow them for this address in the browser's site settings/);
  const none = notifyView(notifyState(env({ api: false }), false));
  assert.match(none.note, /The tab's icon and title still show when something needs you/);
  assert.equal(none.note, none.hint);
});

test("no word promises more than a page in a browser tab can do", () => {
  const states: NotifyState[] = [{ kind: "off" }, { kind: "on" }, { kind: "blocked" }, notifyState(env({ api: false }), false), notifyState(env({ secure: false }), false)];
  const texts = states.flatMap((s) => {
    const v = notifyView(s);
    return [v.label, v.note, v.hint];
  });
  for (const answer of ["granted", "denied", "default"] as const) for (const press of ["turn-on", "turn-off"] as const) texts.push(notifyAnswer(press, answer).title, notifyAnswer(press, answer).msg);
  for (const t of texts) {
    assert.doesNotMatch(t, /\b(push|e-?mail|sms|text message|phone|everywhere|always|even when|anywhere)\b/i, t);
    assert.doesNotMatch(t, /!/, t);
  }
});

test("pressing it is answered in a sentence that is true of what the browser said", () => {
  assert.deepEqual(notifyAnswer("turn-on", "granted"), {
    title: "Notifications are on",
    msg: "You will get one when a decision starts to wait for you, when the mission is delivered and when it stops on its own, while this page is open in a browser tab. Nothing is sent to anyone else.",
    kind: "ok",
  });
  assert.equal(notifyAnswer("turn-on", "denied").title, "Notifications are blocked");
  assert.match(notifyAnswer("turn-on", "denied").msg, /Allow notifications for this address in its site settings/);
  assert.equal(notifyAnswer("turn-on", "denied").kind, "warn");
  assert.equal(notifyAnswer("turn-on", "default").title, "Notifications are still off", "the prompt was closed without an answer: nothing was turned on");
  assert.equal(notifyAnswer("turn-off", "granted").title, "Notifications are off");
  assert.match(notifyAnswer("turn-off", "granted").msg, /still show when something needs you/);
});

test("the choice is one word per host, and anything else is off", () => {
  assert.equal(NOTIFY_KEY, "curule-notify");
  assert.equal(parseChoice("on"), true);
  for (const raw of [null, undefined, "", "off", "true", "1", "ON", "yes"]) assert.equal(parseChoice(raw), false, String(raw));
  assert.equal(parseChoice(choiceValue(true)), true);
  assert.equal(parseChoice(choiceValue(false)), false);
});
