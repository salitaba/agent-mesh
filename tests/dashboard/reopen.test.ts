import test from "node:test";
import assert from "node:assert/strict";

import { REOPEN_DIALOG } from "../../apps/mesh-dashboard/src/reopen";

/**
 * The dialog an operator rejects a result through asks for the checks, in a field that can hold them.
 *
 * The eighteenth cronlite run's reopen described five defects in prose and QA ran one example of each; the nineteenth's ended with
 * a numbered list of nineteen commands and the output each must print, and QA ran all nineteen and the product scored 100% on the
 * oracle (68.1% before the reopen). The dialog used to be a one-line input headed "What was wrong with the result?", which cannot
 * hold a list and does not say a list is worth writing.
 */

test("the reason is asked for in a field of several lines", () => {
  assert.equal(REOPEN_DIALOG.require.kind, "text");
  assert.equal(REOPEN_DIALOG.require.multiline, true, "a list of checks does not fit on one line");
});

test("the dialog says to list the checks, what a check is, and what QA does with the list", () => {
  const body = REOPEN_DIALOG.body.join("\n");
  assert.match(body, /list the checks: each one a command and the output it must print/);
  assert.match(body, /The QA seat runs every one of them, in order, and reports what each printed/);
  assert.match(body, /a description alone gets one example of each problem/);
  assert.match(REOPEN_DIALOG.require.label, /checks to run/);
});

test("the placeholder shows the shape of one check, a command and its required output", () => {
  const p = REOPEN_DIALOG.require.placeholder;
  assert.match(p, /^What was wrong, in a sentence or two\./);
  assert.match(p, /\n1\. node -e /);
  assert.match(p, /\n {3}required output: /);
});

test("what the dialog always said is still there: nothing is deleted, and the button says what happens", () => {
  assert.match(REOPEN_DIALOG.body[0]!, /Nothing is deleted/);
  assert.match(REOPEN_DIALOG.body[0]!, /UNSATISFIED/);
  assert.equal(REOPEN_DIALOG.title, "Reopen the mission?");
  assert.equal(REOPEN_DIALOG.confirmLabel, "Reopen and brief the agents");
});
