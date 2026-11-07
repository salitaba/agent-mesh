/**
 * What a failed read says when no answer arrived.
 *
 * Measured on the delivered demo with the file list, the budgets and the graph refused at the transport (Chromium 1248,
 * 360 and 1,440): each error state's body was "Failed to fetch", the browser naming its own machinery. The same page
 * with no detail at all already said "The mesh server did not answer. It may be restarting." — one fact, two answers,
 * and the one a person got was not a sentence. The browser's sentences are mapped in `errorwords.ts`, and `ErrorState`
 * renders only what that returns, so no caller can put the raw exception back on the page (2026-11-07).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

import { SERVER_SILENT, plainError } from "../../apps/mesh-dashboard/src/errorwords";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");

test("the browser's own failure sentences become the console's one sentence", () => {
  for (const said of [
    "Failed to fetch",
    "TypeError: Failed to fetch",
    "NetworkError when attempting to fetch resource.",
    "Load failed",
    "fetch failed",
    "Network request failed",
    "Connection refused",
  ]) {
    assert.equal(plainError(said), SERVER_SILENT, said);
  }
});

test("an empty detail is the same sentence", () => {
  assert.equal(plainError(undefined), SERVER_SILENT);
  assert.equal(plainError(""), SERVER_SILENT);
  assert.equal(plainError("   "), SERVER_SILENT);
});

test("a fact the server wrote is kept", () => {
  assert.equal(plainError("The server answered 503 instead of the budgets."), "The server answered 503 instead of the budgets.");
  assert.equal(plainError("The request timed out. The server may be busy."), "The request timed out. The server may be busy.");
  assert.equal(plainError("There is no host on this server."), "There is no host on this server.");
  assert.equal(plainError("The upstream failed to fetch the file."), "The upstream failed to fetch the file.", "a server sentence about a fetch is still the server's");
});

test("ErrorState renders the plain sentence, not the raw exception", () => {
  const components = fs.readFileSync(path.join(SRC, "components.tsx"), "utf8");
  assert.match(components, /import \{ plainError \} from "\.\/errorwords"/);
  assert.match(components, /<p className="empty-body">\{plainError\(detail\)\}<\/p>/);
  assert.doesNotMatch(components, /\{detail \?\? "The mesh server did not answer/);
});
