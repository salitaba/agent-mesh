/**
 * Where a page of text ends.
 *
 * A seat reads an artifact through a window of characters, and the window ends
 * wherever the character budget runs out. For prose that is a nuisance; for code it
 * is a trap. The CodePatch in the second cronlite run was cut at character 22,800,
 * between `test('parse() day of week values include 0 or 7 for Sunday', (` and
 * `) => {`, and the tech-lead, which read all four pages, rejected the patch as
 * "final test is incomplete. Line ends with `test('…', (` without body". The stored
 * body was whole. A rejected artifact cannot be approved again, so one misread page
 * boundary cost a full review-merge cycle.
 *
 * A page therefore ends at a line boundary whenever there is one in its second half,
 * so a line is never shown in two halves. Only a window with no newline to cut at
 * (minified code, one giant line) is cut hard, and even then never between the two
 * halves of a surrogate pair.
 */

/**
 * How many characters of `text` to show when at most `budget` fit.
 *
 * Returns `text.length` when it all fits. The cut is at most `budget`, at least half
 * of it unless the text has no newline past the midpoint, and at least 1, so a caller
 * that advances by the returned length always makes progress and every character stays
 * reachable by paging.
 */
export function pageCut(text: string, budget: number): number {
  const limit = Math.max(1, Math.floor(budget));
  if (text.length <= limit) return text.length;
  let end = limit;
  // Never strand a high surrogate at the end of a page (the low half would open the next).
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff && end > 1) end -= 1;
  const newline = text.lastIndexOf("\n", end - 1);
  if (newline >= Math.floor(limit / 2)) return newline + 1;
  return end;
}
