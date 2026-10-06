/**
 * The dialog an operator rejects a delivered result through, and what is asked of them in it.
 *
 * The reason the operator writes becomes a mandatory criterion, and the seats read it as their brief. How it is written decides
 * what QA does with it: the eighteenth cronlite run's reopen described five defects in prose, with an example and the result it
 * must give for each, and QA ran one example per defect and reported all five fixed (the operator's own `0-7` example was not run,
 * and it was the one that was still wrong). The nineteenth run's reopen ended with a numbered list of nineteen commands, each with
 * the output it must print, and QA ran all nineteen, reported what each printed, blocked on the nineteen that failed, and passed
 * the fix on the nineteen that matched: the product went from 68.1% to a perfect score on the oracle. So the dialog asks for the
 * list, in a field that can hold one, and says what the seats do with it.
 */
export interface ReopenDialog {
  title: string;
  body: string[];
  confirmLabel: string;
  require: { kind: "text"; label: string; placeholder: string; multiline: true };
}

export const REOPEN_DIALOG: ReopenDialog = {
  title: "Reopen the mission?",
  body: [
    "Nothing is deleted — every artifact and step is kept, but the mandatory acceptance criteria go back to UNSATISFIED so the run does not instantly close again.",
    "Say what was wrong. Then, for what you want checked, list the checks: each one a command and the output it must print. The QA seat runs every one of them, in order, and reports what each printed; a description alone gets one example of each problem.",
  ],
  confirmLabel: "Reopen and brief the agents",
  require: {
    kind: "text",
    label: "What was wrong with the result, and the checks to run",
    placeholder: 'What was wrong, in a sentence or two.\n\nChecks (optional):\n1. node -e "import(\'./src/index.js\').then(m => console.log(m.parse(\'*,5 * * * *\')))"\n   required output: a schedule, not an error\n2. …',
    multiline: true,
  },
};
