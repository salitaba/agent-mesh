import type { SyntheticEvent } from "react";

/**
 * Gives an element a tooltip with its full text, but only when the text is actually cut off.
 *
 * Rows in the dense lists clip their sentence with an ellipsis, and the sentence is built from nodes (a bold name, a plain tail),
 * so there is no string to put in a `title` up front. Reading `textContent` on the way in costs nothing for a row nobody points
 * at, and a row whose text fits gets no tooltip repeating what is already on screen.
 */
export function titleWhenClipped(e: SyntheticEvent<HTMLElement>): void {
  const el = e.currentTarget;
  if (el.scrollWidth > el.clientWidth + 1) el.title = (el.textContent ?? "").trim();
  else el.removeAttribute("title");
}
