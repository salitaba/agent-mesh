/* What a view says when a read failed before any answer arrived.
 *
 * `fetch` rejects in each browser with its own sentence: "Failed to fetch" (Chromium), "NetworkError when attempting to
 * fetch resource." (Firefox), "Load failed" (Safari), "fetch failed" (Node). Those are the browser naming its own
 * machinery, not the console telling a person what happened, and they ended up as the body of the Files, Cost, Graph,
 * Product and Host settings error states. A read that never reached the server is one fact with one sentence, the
 * same one `ErrorState` already used when it had no detail at all (2026-11-07).
 *
 * Anything else — the server's own words, a timeout, an HTTP status — is kept: it is a fact this module does not own.
 */
export const SERVER_SILENT = "The mesh server did not answer. It may be restarting.";

/** The sentences Chromium, Firefox, Safari and Node use for a request that never got an answer. */
const NO_ANSWER = [
  /^(?:typeerror:\s*)?failed to fetch$/i,
  /^networkerror\b/i,
  /^load failed$/i,
  /^fetch failed$/i,
  /^network request failed$/i,
  /^connection refused$/i,
];

export function plainError(detail?: string | null): string {
  const said = (detail ?? "").trim();
  if (!said) return SERVER_SILENT;
  return NO_ANSWER.some((re) => re.test(said)) ? SERVER_SILENT : said;
}
