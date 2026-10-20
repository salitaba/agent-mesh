/**
 * What the console says when the server answers with an error. Measured at 360 px against a stand-in gateway that answered
 * `/status` and `/events` with 502 `{error}`:
 *   - Agents said "No agents in this mesh — The mesh answered, and this project has no agents configured." It had not been
 *     answered: its status poll received an error body, which `refreshStatus` stored as if it were a status.
 *   - Events printed the JavaScript failure itself as the detail: "(e || []) is not iterable". The error object had been handed
 *     to the event loader, which tried to walk it.
 *   - Overview said "The project is starting" for as long as the failure lasted, because no status ever landed.
 * These tests read the source as text so the three answers cannot go back to being guesses, a stack trace, or a wait.
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
