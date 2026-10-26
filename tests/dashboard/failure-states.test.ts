/**
 * What the console says when the server answers with an error. Measured at 360 px against a stand-in gateway that answered
 * `/status` and `/events` with 502 `{error}`:
 *   - Agents said "No agents in this mesh — The mesh answered, and this project has no agents configured." It had not been
 *     answered: its status poll received an error body, which `refreshStatus` stored as if it were a status.
 *   - Events printed the JavaScript failure itself as the detail: "(e || []) is not iterable". The error object had been handed
 *     to the event loader, which tried to walk it.
 *   - Overview said "The project is starting" for as long as the failure lasted, because no status ever landed.
 *   - Playground's Your product card said "It ships no page" — a claim about the product — from the same failed answer.
 * These tests read the source as text so the answers cannot go back to being guesses, a stack trace, or a wait.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const store = fs.readFileSync(path.join(SRC, "store.tsx"), "utf8");
const agents = fs.readFileSync(path.join(SRC, "views", "Agents.tsx"), "utf8");
const events = fs.readFileSync(path.join(SRC, "views", "Events.tsx"), "utf8");
const overview = fs.readFileSync(path.join(SRC, "views", "Overview.tsx"), "utf8");
const yourProduct = fs.readFileSync(path.join(SRC, "views", "YourProduct.tsx"), "utf8");
const stepsView = fs.readFileSync(path.join(SRC, "views", "Steps.tsx"), "utf8");

test("a failed status poll is not stored as a status", () => {
  assert.match(store, /const \{ json, status: code, timeout \} = await clientRef\.current\.api\("GET", "\/status"\)/, "the poll reads the HTTP status as well as the body");
  assert.match(store, /if \(!json \|\| code >= 400\) \{[\s\S]*?setStatusError\(/, "a failed answer sets the failure and returns before setStatus");
  const guard = store.indexOf("if (!json || code >= 400)");
  const setStatus = store.indexOf("setStatus(json);", guard);
  assert.ok(guard > -1 && setStatus > guard, "setStatus runs only after the guard");
  assert.match(store, /status, statusError, events/, "the provider exposes statusError");
});

test("Agents shows a failed poll, never a roster it did not read", () => {
  assert.match(agents, /const \{ status, statusError, toast/, "the page reads statusError");
  const failed = agents.indexOf("const failed = serverDown");
  const error = agents.indexOf("<ErrorState what=\"the agent list\" detail={failed}", failed);
  assert.ok(failed > -1 && error > failed, "the empty-status branch renders ErrorState with the failure");
  assert.match(agents, /if \(!status\) \{[\s\S]*?statusError[\s\S]*?\}/, "statusError is consulted while status is missing");
});

test("Events refuses an error body instead of throwing on it", () => {
  assert.match(events, /else if \(!Array\.isArray\(json\)\) setLoadErr\(/, "only an array is handed to the event loader");
  assert.match(events, /The server answered \$\{status\} instead of the log\./, "the failure names the answer");
  assert.doesNotMatch(events, /setLoadErr\(e instanceof Error \? e\.message/, "the raw exception is not the reader-facing detail");
});

test("Overview says the status failed rather than staying in 'starting'", () => {
  assert.match(overview, /const \{ status, statusError,/, "the page reads statusError");
  assert.match(overview, /serverDown \|\| \(!status && statusError\)/, "a failed first poll gets the error state");
});

test("a failed page probe is not reported as 'it ships no page'", () => {
  assert.match(yourProduct, /if \(timeout \|\| status >= 400\) \{[\s\S]*?failed: true/, "the probe records a failed answer");
  assert.match(yourProduct, /page\.failed \? \(/, "the card has a failed branch");
  assert.match(yourProduct, /could not ask the server which page this product ships/, "the failure says what happened");
  assert.match(yourProduct, /setProbeAttempt\(\(n\) => n \+ 1\)/, "Try again asks the question again");
});

test("a failed read of the step history is said, whether or not a list is already on screen", () => {
  // Measured at 360, 768 and 1440 with /steps answering 500 before any answer: after six seconds the page still said
  // "Loading turns · Fetching the step history." over five skeleton rows, with no error and no retry. The loader kept a
  // stale list on purpose and had no way to say it had never had one.
  assert.match(store, /setStepsError\(/, "the store can report the first read");
  const guard = store.indexOf("if (stepsAt.current === 0) setStepsError");
  assert.ok(guard > -1, "the FIRST read is a failed page");
  assert.match(store, /else setStepsStale\(/, "a later failure marks the rows it keeps");
  // Measured at 360 with /steps answering 500 after a good read: the page drew the six turns the Overview had primed,
  // under "Live · Updated 2s ago", and said nothing — six turns stood as the mission's history of twenty-eight.
  assert.match(store, /setStepsStale\(null\)/, "a good read clears the mark");
  assert.match(store, /const setSteps = useCallback[\s\S]*?setStepsError\(null\)[\s\S]*?\}, \[\]\);/, "the overview's priming read clears only the first-read error");
  assert.match(store, /code >= 400[\s\S]*?instead of the step history/, "the failure names the answer rather than a raw exception");
  assert.match(store, /stepsLoaded, stepsError, stepsStale, stepFilter/, "the provider exposes it");
  assert.match(stepsView, /const \{[^}]*stepsError/, "Steps reads it");
  const branch = stepsView.indexOf(") : !stepsLoaded ? (");
  const retry = stepsView.indexOf('<ErrorState what="the step history" detail={stepsError}', branch);
  assert.ok(branch > -1 && retry > branch, "the no-list branch draws the ErrorState with a retry");
  assert.match(stepsView, /failed=\{Boolean\(stepsError\)\}/, "the pulse line is told too, so it stops saying 'Loading turns'");
  assert.match(stepsView, /stepsStale && stepsLoaded \? \(\s*<Banner/, "the kept list says what it is");
  assert.match(stepsView, /Showing the \{plural\(visible\.length, "turn"\)\} already loaded/, "and how much of the history it is");
  assert.match(stepsView, /onClick=\{\(\) => \{ setRetrying\(true\); void refreshSteps\(true\); \}\}/, "with the read offered again");
  assert.match(stepsView, /if \(!retrying \|\| stepsStale \|\| !stepsLoaded\) return;\s*\n\s*setRetrying\(false\);\s*\n\s*const row = ledgerRef\.current\?\.querySelector<HTMLElement>\("\.st-row"\)/, "and the answer puts the cursor on the newest turn, not <body>");
});

test("a registry that never answers is a failure with a retry, not the loading placeholder for ever", () => {
  // Measured at 360 with /api/projects answering 503: the console sat on "Loading this page…" indefinitely. `hasRegistry`
  // stayed null, so the shell held every view, and no banner could name the failure because no page had rendered.
  const shell = fs.readFileSync(path.join(SRC, "shell.tsx"), "utf8");
  const nav = fs.readFileSync(path.join(SRC, "navmodel.ts"), "utf8");
  assert.match(nav, /export function registryPhase\(/, "the rule is DOM-free and testable");
  assert.match(shell, /const registry = registryPhase\(/, "the shell reads it");
  assert.match(shell, /registry === "failed" \? \(\s*<RegistryDown page=\{askedPage\} onRetry=\{\(\) => void projectsCtx\?\.refreshProjects\(\)\} \/>/, "a failed first answer draws the error state with a retry");
  const projects = fs.readFileSync(path.join(SRC, "projects.tsx"), "utf8");
  assert.match(projects, /api\("GET", "\/api\/projects", undefined, \{ quiet: true \}\)/, "the page says it in place, so the route-and-code notice is not raised over the heading");
  const down = shell.slice(shell.indexOf("function RegistryDown"));
  assert.match(down, /<PageHeader title=\{page\} \/>/, "the page still has a signpost");
  assert.match(down, /<ErrorState\s+what="the projects list"/, "and the failure names what could not be read");
  assert.match(shell, /registry === "known" && !holdView/, "a failed registry does not poll tool requests against a host that did not answer");
});
